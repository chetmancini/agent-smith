import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import type { AgentRunner } from "../src/lib/agent-runner";
import { createEvent } from "../src/lib/events";
import type { ImprovementLoopReport } from "../src/lib/loop";
import { resolvePaths } from "../src/lib/paths";
import { appendEvent } from "../src/lib/store";

function createIo() {
  let stdout = "";
  let stderr = "";

  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      readStdin: async () => "",
    },
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

function seedSession(sessionId: string): void {
  const paths = resolvePaths(process.env);
  appendEvent(
    paths,
    createEvent({
      eventType: "session_start",
      tool: "codex",
      sessionId,
      metadata: { cwd: "/tmp/agent-smith" },
    }),
  );
  appendEvent(
    paths,
    createEvent({
      eventType: "permission_denied",
      tool: "codex",
      sessionId,
      metadata: { cwd: "/tmp/agent-smith", command: "rm -rf build" },
    }),
  );
  appendEvent(
    paths,
    createEvent({
      eventType: "session_stop",
      tool: "codex",
      sessionId,
      metadata: {
        cwd: "/tmp/agent-smith",
        stop_reason: "end_turn",
        duration_seconds: 9,
      },
    }),
  );
}

function runGit(repoRoot: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", "-C", repoRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString() || proc.stdout.toString());
  }
}

async function runLoopCli(repoRoot: string, runAgent: AgentRunner, iterations = 3): Promise<ImprovementLoopReport> {
  const { io, getStdout } = createIo();
  const exitCode = await runCli(
    ["loop", "--tool", "codex", "--iterations", String(iterations), "--format", "json"],
    io,
    {
      loop: {
        env: process.env,
        repoRoot,
        runAgent,
      },
    },
  );

  expect(exitCode).toBe(0);
  return JSON.parse(getStdout()) as ImprovementLoopReport;
}

describe("loop", () => {
  let sandbox: string;
  let metricsDir: string;
  let home: string;
  let repoRoot: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "agent-smith-loop-"));
    metricsDir = join(sandbox, "metrics");
    home = join(sandbox, "home");
    repoRoot = join(sandbox, "repo");
    mkdirSync(metricsDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });

    process.env.METRICS_DIR = metricsDir;
    process.env.HOME = home;
    process.env.AGENT_SMITH_TOOL = "codex";

    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');

    const schemaDir = join(home, ".config", "agent-smith", "schemas");
    mkdirSync(schemaDir, { recursive: true });
    writeFileSync(
      join(schemaDir, "codex-config.schema.json"),
      JSON.stringify({
        type: "object",
        properties: {
          model: { type: "string" },
          permissions: { type: "object" },
        },
      }),
    );
    writeFileSync(
      join(schemaDir, "codex-config.schema.metadata.json"),
      JSON.stringify({
        tool: "codex",
        schema_url: "https://developers.openai.com/codex/config-schema.json",
        schema_path: join(schemaDir, "codex-config.schema.json"),
        fetched_at: "2026-04-20T00:00:00.000Z",
      }),
    );

    writeFileSync(join(repoRoot, "AGENTS.md"), "# Agent instructions\n");
    writeFileSync(join(repoRoot, "README.md"), "# Agent Smith\n");

    runGit(repoRoot, ["init"]);
    runGit(repoRoot, ["config", "user.email", "agent-smith@example.com"]);
    runGit(repoRoot, ["config", "user.name", "Agent Smith"]);
    runGit(repoRoot, ["add", "AGENTS.md", "README.md"]);
    runGit(repoRoot, ["commit", "-m", "initial"]);

    seedSession("loop-1");
    seedSession("loop-2");
  });

  afterEach(() => {
    delete process.env.METRICS_DIR;
    delete process.env.HOME;
    delete process.env.AGENT_SMITH_TOOL;
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("loop applies safe recommendations and feeds prior iteration context back into analysis", async () => {
    let analysisCalls = 0;
    const payload = await runLoopCli(repoRoot, ({ prompt }) => {
      if (prompt.includes("You are Agent Smith's reasoning engine.")) {
        analysisCalls += 1;
        if (analysisCalls === 1) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary: "Prompt wording should be tightened before structural changes.",
              recommendations: [
                {
                  id: "tighten-request-contract",
                  title: "Tighten the request contract",
                  priority: "high",
                  category: "prompt",
                  rationale: "Permission denials suggest requests are underspecified.",
                  evidence: ["permission denials are present"],
                  actions: [
                    {
                      type: "prompt_change",
                      description: "Clarify the opening operator guidance.",
                      targetFiles: [join(repoRoot, "AGENTS.md")],
                      safeToAutoApply: true,
                    },
                  ],
                },
              ],
            }),
            stderr: "",
          };
        }

        expect(prompt).toContain("tighten-request-contract");
        expect(prompt).toContain("updated AGENTS guidance");
        if (analysisCalls === 2) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary: "The next safe improvement is to refresh the README workflow copy.",
              recommendations: [
                {
                  id: "refresh-readme-workflow",
                  title: "Refresh README workflow copy",
                  priority: "medium",
                  category: "workflow",
                  rationale: "The guidance should reflect the tighter operator contract.",
                  evidence: ["the prompt contract was already tightened"],
                  actions: [
                    {
                      type: "workflow_change",
                      description: "Document the loop command in README.",
                      targetFiles: [join(repoRoot, "README.md")],
                      safeToAutoApply: true,
                    },
                  ],
                },
              ],
            }),
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "Only completed recommendations remain.",
            recommendations: [
              {
                id: "refresh-readme-workflow",
                title: "Refresh README workflow copy",
                priority: "medium",
                category: "workflow",
                rationale: "This was already resolved and should be filtered.",
                evidence: ["already applied"],
                actions: [
                  {
                    type: "workflow_change",
                    description: "No-op",
                    targetFiles: [join(repoRoot, "README.md")],
                    safeToAutoApply: true,
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      }

      if (prompt.includes("You are applying one Agent Smith improvement recommendation")) {
        if (prompt.includes("tighten-request-contract")) {
          writeFileSync(
            join(repoRoot, "AGENTS.md"),
            "# Agent instructions\n\nStart with scope, target command, and validation.\n",
          );
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary: "updated AGENTS guidance",
              changedFiles: ["AGENTS.md"],
              validation: [
                {
                  command: 'rg -n "target command" AGENTS.md',
                  outcome: "passed",
                  details: "found",
                },
              ],
              followUps: [],
            }),
            stderr: "",
          };
        }

        writeFileSync(
          join(repoRoot, "README.md"),
          "# Agent Smith\n\nUse `agent-smith loop --tool codex` for iterative tuning.\n",
        );
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "updated README workflow copy",
            changedFiles: ["README.md"],
            validation: [
              {
                command: 'rg -n "agent-smith loop" README.md',
                outcome: "passed",
              },
            ],
            followUps: [],
          }),
          stderr: "",
        };
      }

      if (prompt.includes("You are evaluating whether a just-applied Agent Smith improvement")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "The targeted file change matches the recommendation.",
            outcome: "resolved",
            rationale: "The requested wording was applied in the intended file.",
            continueLoop: true,
            nextFocus: "Move to the next safe recommendation.",
          }),
          stderr: "",
        };
      }

      return {
        exitCode: 1,
        stdout: "",
        stderr: "unexpected prompt",
      };
    });

    expect(payload.stopReason).toBe("no_auto_applicable_recommendations");
    expect(payload.completedRecommendationIds).toEqual(["tighten-request-contract", "refresh-readme-workflow"]);
    expect(payload.iterations.map((iteration) => iteration.recommendationId)).toEqual([
      "tighten-request-contract",
      "refresh-readme-workflow",
    ]);
    expect(readFileSync(join(repoRoot, "AGENTS.md"), "utf8")).toContain("target command");
    expect(readFileSync(join(repoRoot, "README.md"), "utf8")).toContain("agent-smith loop");
  });

  test("loop stops immediately when evaluation reports a blocked recommendation", async () => {
    const payload = await runLoopCli(repoRoot, ({ prompt }) => {
      if (prompt.includes("You are Agent Smith's reasoning engine.")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "The repository-level guidance conflicts with the current hook behavior.",
            recommendations: [
              {
                id: "clarify-hook-boundary",
                title: "Clarify hook boundary",
                priority: "high",
                category: "workflow",
                rationale: "The current instructions need a coordinated hook change.",
                evidence: ["session hooks and docs disagree"],
                actions: [
                  {
                    type: "workflow_change",
                    description: "Document the intended hook boundary in AGENTS.md.",
                    targetFiles: [join(repoRoot, "AGENTS.md")],
                    safeToAutoApply: true,
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      }

      if (prompt.includes("You are applying one Agent Smith improvement recommendation")) {
        writeFileSync(join(repoRoot, "AGENTS.md"), "# Agent instructions\n\nHooks require repo-owner signoff.\n");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "Documented the hook boundary.",
            changedFiles: ["AGENTS.md"],
            validation: [],
            followUps: ["Confirm the boundary with the owning team."],
          }),
          stderr: "",
        };
      }

      if (prompt.includes("You are evaluating whether a just-applied Agent Smith improvement")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "The change documents the issue but cannot resolve the underlying hook conflict.",
            outcome: "blocked",
            rationale: "This needs a coordinated code change outside the current safe scope.",
            continueLoop: false,
            nextFocus: "Escalate to the hook owner.",
          }),
          stderr: "",
        };
      }

      return {
        exitCode: 1,
        stdout: "",
        stderr: "unexpected prompt",
      };
    });

    expect(payload.stopReason).toBe("blocked");
    expect(payload.completedRecommendationIds).toEqual([]);
    expect(payload.blockedRecommendationIds).toEqual(["clarify-hook-boundary"]);
    expect(payload.iterations).toHaveLength(1);
    expect(payload.iterations[0]?.evaluation.outcome).toBe("blocked");
  });

  test("loop stops before evaluation when an apply step reports no effective changes", async () => {
    let evaluationCalled = false;

    const payload = await runLoopCli(repoRoot, ({ prompt }) => {
      if (prompt.includes("You are Agent Smith's reasoning engine.")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "The README should mention the validation command.",
            recommendations: [
              {
                id: "mention-validation-command",
                title: "Mention the validation command",
                priority: "medium",
                category: "workflow",
                rationale: "Operators should know what to run after a config edit.",
                evidence: ["README omits validation guidance"],
                actions: [
                  {
                    type: "workflow_change",
                    description: "Document the validation command in README.",
                    targetFiles: [join(repoRoot, "README.md")],
                    safeToAutoApply: true,
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      }

      if (prompt.includes("You are applying one Agent Smith improvement recommendation")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "No changes were necessary after inspecting the file.",
            changedFiles: [],
            validation: [],
            followUps: ["Double-check whether the recommendation is stale."],
          }),
          stderr: "",
        };
      }

      if (prompt.includes("You are evaluating whether a just-applied Agent Smith improvement")) {
        evaluationCalled = true;
      }

      return {
        exitCode: 1,
        stdout: "",
        stderr: "unexpected prompt",
      };
    });

    expect(payload.stopReason).toBe("no_changes_applied");
    expect(payload.iterations).toEqual([]);
    expect(evaluationCalled).toBe(false);
  });

  test("loop preserves failed validation entries and ignores malformed ones", async () => {
    const payload = await runLoopCli(repoRoot, ({ prompt }) => {
      if (prompt.includes("You are Agent Smith's reasoning engine.")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "The README should document the loop validation command.",
            recommendations: [
              {
                id: "document-loop-validation",
                title: "Document loop validation",
                priority: "medium",
                category: "workflow",
                rationale: "The workflow is missing the validation command.",
                evidence: ["README lacks a validation example"],
                actions: [
                  {
                    type: "workflow_change",
                    description: "Add the validation command to README.",
                    targetFiles: [join(repoRoot, "README.md")],
                    safeToAutoApply: true,
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      }

      if (prompt.includes("You are applying one Agent Smith improvement recommendation")) {
        writeFileSync(
          join(repoRoot, "README.md"),
          "# Agent Smith\n\nValidate loop changes with `rtk bun test agent-smith-app/tests/loop.test.ts`.\n",
        );
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "Added the loop validation command to README.",
            changedFiles: ["README.md"],
            validation: [
              {
                command: "rtk bun test agent-smith-app/tests/loop.test.ts",
                outcome: "failed",
                details: "1 failing assertion",
              },
              {
                command: 42,
                outcome: "passed",
              },
              {
                command: "rtk bun test",
                outcome: "broken",
              },
              "not-an-object",
            ],
            followUps: ["Fix the failing assertion before relying on the loop output."],
          }),
          stderr: "",
        };
      }

      if (prompt.includes("You are evaluating whether a just-applied Agent Smith improvement")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "The documentation change landed, but the focused test still fails.",
            outcome: "resolved",
            rationale: "The target file was updated even though the validation command reported a failure.",
            continueLoop: false,
            nextFocus: "Triage the failing loop test separately.",
          }),
          stderr: "",
        };
      }

      return {
        exitCode: 1,
        stdout: "",
        stderr: "unexpected prompt",
      };
    });

    expect(payload.stopReason).toBe("completed");
    expect(payload.iterations).toHaveLength(1);
    expect(payload.iterations[0]?.apply.validation).toEqual([
      {
        command: "rtk bun test agent-smith-app/tests/loop.test.ts",
        outcome: "failed",
        details: "1 failing assertion",
      },
    ]);
  });

  test("loop can stop with a partial evaluation when the next step is manual", async () => {
    let analysisCalls = 0;

    const payload = await runLoopCli(repoRoot, ({ prompt }) => {
      if (prompt.includes("You are Agent Smith's reasoning engine.")) {
        analysisCalls += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "The README should explain when to stop the loop.",
            recommendations: [
              {
                id: "document-manual-stop",
                title: "Document manual stop guidance",
                priority: "medium",
                category: "workflow",
                rationale: "Operators need a clear handoff rule for partial fixes.",
                evidence: ["README lacks a manual stop note"],
                actions: [
                  {
                    type: "workflow_change",
                    description: "Add a manual stop note to README.",
                    targetFiles: [join(repoRoot, "README.md")],
                    safeToAutoApply: true,
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      }

      if (prompt.includes("You are applying one Agent Smith improvement recommendation")) {
        writeFileSync(
          join(repoRoot, "README.md"),
          "# Agent Smith\n\nStop the loop and hand off once the remaining work needs a human decision.\n",
        );
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "Added manual stop guidance to README.",
            changedFiles: ["README.md"],
            validation: [],
            followUps: ["Have an operator confirm the wording."],
          }),
          stderr: "",
        };
      }

      if (prompt.includes("You are evaluating whether a just-applied Agent Smith improvement")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "The doc now explains the handoff, but the broader workflow still needs manual review.",
            outcome: "partial",
            rationale:
              "The immediate wording landed, but the remaining resolution is outside the safe auto-apply scope.",
            continueLoop: false,
            nextFocus: "Ask the maintainer to review the remaining workflow.",
          }),
          stderr: "",
        };
      }

      return {
        exitCode: 1,
        stdout: "",
        stderr: "unexpected prompt",
      };
    });

    expect(analysisCalls).toBe(1);
    expect(payload.stopReason).toBe("completed");
    expect(payload.completedRecommendationIds).toEqual([]);
    expect(payload.iterations).toHaveLength(1);
    expect(payload.iterations[0]?.evaluation.outcome).toBe("partial");
    expect(payload.iterations[0]?.evaluation.continueLoop).toBe(false);
  });

  test("loop stalls after the same recommendation fails twice", async () => {
    let analysisCalls = 0;
    let applyCalls = 0;

    const payload = await runLoopCli(repoRoot, ({ prompt }) => {
      if (prompt.includes("You are Agent Smith's reasoning engine.")) {
        analysisCalls += 1;
        if (analysisCalls === 2) {
          expect(prompt).toContain("evaluation=partial");
          expect(prompt).toContain("attempted README clarification");
        }

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "The README wording still needs refinement.",
            recommendations: [
              {
                id: "tighten-readme-loop-guidance",
                title: "Tighten README loop guidance",
                priority: "medium",
                category: "workflow",
                rationale: "The guidance remains vague after the first pass.",
                evidence: ["README wording is still vague"],
                actions: [
                  {
                    type: "workflow_change",
                    description: "Clarify the README loop guidance.",
                    targetFiles: [join(repoRoot, "README.md")],
                    safeToAutoApply: true,
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      }

      if (prompt.includes("You are applying one Agent Smith improvement recommendation")) {
        applyCalls += 1;
        if (applyCalls === 1) {
          writeFileSync(join(repoRoot, "README.md"), "# Agent Smith\n\nFirst attempt at README clarification.\n");
        } else {
          writeFileSync(
            join(repoRoot, "README.md"),
            "# Agent Smith\n\nFirst attempt at README clarification.\nSecond attempt at README clarification.\n",
          );
        }

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "attempted README clarification",
            changedFiles: ["README.md"],
            validation: [],
            followUps: ["The loop wording may still be ambiguous."],
          }),
          stderr: "",
        };
      }

      if (prompt.includes("You are evaluating whether a just-applied Agent Smith improvement")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "The wording changed, but the recommendation is still not resolved.",
            outcome: "partial",
            rationale: "The edits did not fully address the underlying ambiguity.",
            continueLoop: true,
            nextFocus: "Try one more targeted clarification.",
          }),
          stderr: "",
        };
      }

      return {
        exitCode: 1,
        stdout: "",
        stderr: "unexpected prompt",
      };
    });

    expect(payload.stopReason).toBe("stalled");
    expect(payload.completedRecommendationIds).toEqual([]);
    expect(payload.blockedRecommendationIds).toEqual([]);
    expect(payload.iterations).toHaveLength(2);
    expect(payload.iterations.map((iteration) => iteration.recommendationId)).toEqual([
      "tighten-readme-loop-guidance",
      "tighten-readme-loop-guidance",
    ]);
  });
});
