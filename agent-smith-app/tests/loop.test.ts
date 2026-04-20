import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { createEvent } from "../src/lib/events";
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
      metadata: { cwd: "/tmp/agent-smith", stop_reason: "end_turn", duration_seconds: 9 },
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
    const { io, getStdout } = createIo();

    const exitCode = await runCli(
      ["loop", "--tool", "codex", "--iterations", "3", "--format", "json"],
      io,
      {
        loop: {
          env: process.env,
          repoRoot,
          runAgent: ({ prompt }) => {
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
                      { command: "rg -n \"target command\" AGENTS.md", outcome: "passed", details: "found" },
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
                  validation: [{ command: "rg -n \"agent-smith loop\" README.md", outcome: "passed" }],
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
          },
        },
      },
    );

    expect(exitCode).toBe(0);

    const payload = JSON.parse(getStdout()) as {
      stopReason: string;
      completedRecommendationIds: string[];
      iterations: Array<{ recommendationId: string }>;
    };

    expect(payload.stopReason).toBe("no_auto_applicable_recommendations");
    expect(payload.completedRecommendationIds).toEqual(["tighten-request-contract", "refresh-readme-workflow"]);
    expect(payload.iterations.map((iteration) => iteration.recommendationId)).toEqual([
      "tighten-request-contract",
      "refresh-readme-workflow",
    ]);
    expect(readFileSync(join(repoRoot, "AGENTS.md"), "utf8")).toContain("target command");
    expect(readFileSync(join(repoRoot, "README.md"), "utf8")).toContain("agent-smith loop");
  });
});
