import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
      metadata: {
        cwd: "/tmp/agent-smith",
        stop_reason: "end_turn",
        duration_seconds: 9,
      },
    }),
  );
}

function runGit(repoRoot: string, args: string[]): void {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ) as NodeJS.ProcessEnv;
  const proc = Bun.spawnSync(["git", "-C", repoRoot, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString() || proc.stdout.toString());
  }
}

function readHistoryRow() {
  const paths = resolvePaths(process.env);
  const db = new Database(paths.dbFile, { readonly: true });
  try {
    return db
      .query(
        `
          SELECT recommendation_id, total_attempts, resolved_count, blocked_count, stalled_count, regression_count, last_state, last_summary
          FROM recommendation_history
          LIMIT 1
        `,
      )
      .get() as {
      recommendation_id: string;
      total_attempts: number;
      resolved_count: number;
      blocked_count: number;
      stalled_count: number;
      regression_count: number;
      last_state: string;
      last_summary: string | null;
    } | null;
  } finally {
    db.close();
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

    const exitCode = await runCli(["loop", "--tool", "codex", "--iterations", "3", "--format", "json"], io, {
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
        },
      },
    });

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

  test("loop persists resolved outcomes and tracks regressions across runs", async () => {
    const { io: firstIo } = createIo();

    const firstExit = await runCli(["loop", "--tool", "codex", "--iterations", "1", "--format", "json"], firstIo, {
      loop: {
        env: process.env,
        repoRoot,
        runAgent: ({ prompt }) => {
          if (prompt.includes("You are Agent Smith's reasoning engine.")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                summary: "Tighten the operator contract first.",
                recommendations: [
                  {
                    id: "tighten-request-contract",
                    title: "Tighten the request contract",
                    priority: "high",
                    category: "prompt",
                    rationale: "Permission denials suggest the initial prompt is weak.",
                    evidence: ["permission denials are present"],
                    actions: [
                      {
                        type: "prompt_change",
                        description: "Strengthen AGENTS guidance.",
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
            writeFileSync(join(repoRoot, "AGENTS.md"), "# Agent instructions\n\nState scope before execution.\n");
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                summary: "updated AGENTS guidance",
                changedFiles: ["AGENTS.md"],
                validation: [],
                followUps: [],
              }),
              stderr: "",
            };
          }

          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary: "The file now matches the recommendation.",
              outcome: "resolved",
              rationale: "The requested text was added.",
              continueLoop: false,
              nextFocus: "",
            }),
            stderr: "",
          };
        },
      },
    });

    expect(firstExit).toBe(0);

    let secondAnalysisCalls = 0;
    const { io: secondIo, getStdout: getSecondStdout } = createIo();
    const secondExit = await runCli(["loop", "--tool", "codex", "--iterations", "1", "--format", "json"], secondIo, {
      loop: {
        env: process.env,
        repoRoot,
        runAgent: ({ prompt }) => {
          if (prompt.includes("You are Agent Smith's reasoning engine.")) {
            secondAnalysisCalls += 1;
            expect(prompt).toContain("Historical recommendation outcomes from prior loop runs");
            expect(prompt).toContain("[resolved] tighten-request-contract: The file now matches the recommendation.");
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                summary: "The earlier fix regressed and needs to be restored.",
                recommendations: [
                  {
                    id: "tighten-request-contract",
                    title: "Tighten the request contract",
                    priority: "high",
                    category: "prompt",
                    rationale: "The previously resolved prompt issue returned.",
                    evidence: ["the guidance regressed"],
                    actions: [
                      {
                        type: "prompt_change",
                        description: "Restore the stronger AGENTS guidance.",
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
            writeFileSync(join(repoRoot, "AGENTS.md"), "# Agent instructions\n\nState scope before execution.\n");
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                summary: "restored AGENTS guidance",
                changedFiles: ["AGENTS.md"],
                validation: [],
                followUps: [],
              }),
              stderr: "",
            };
          }

          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary: "The regression was re-resolved.",
              outcome: "resolved",
              rationale: "The guidance is back in place.",
              continueLoop: false,
              nextFocus: "",
            }),
            stderr: "",
          };
        },
      },
    });

    expect(secondExit).toBe(0);
    expect(secondAnalysisCalls).toBe(1);

    const secondPayload = JSON.parse(getSecondStdout()) as {
      stopReason: string;
      iterations: Array<{ recommendationId: string }>;
    };
    expect(secondPayload.stopReason).toBe("completed");
    expect(secondPayload.iterations.map((iteration) => iteration.recommendationId)).toEqual([
      "tighten-request-contract",
    ]);

    const history = readHistoryRow();
    expect(history).not.toBeNull();
    expect(history?.recommendation_id).toBe("tighten-request-contract");
    expect(history?.total_attempts).toBe(2);
    expect(history?.resolved_count).toBe(2);
    expect(history?.regression_count).toBe(1);
    expect(history?.last_state).toBe("resolved");
    expect(history?.last_summary).toBe("The regression was re-resolved.");
  });

  test("loop skips recommendations that already stalled on a prior run", async () => {
    const { io: firstIo, getStdout: getFirstStdout } = createIo();
    let firstAnalysisCalls = 0;

    const firstExit = await runCli(["loop", "--tool", "codex", "--iterations", "3", "--format", "json"], firstIo, {
      loop: {
        env: process.env,
        repoRoot,
        runAgent: ({ prompt }) => {
          if (prompt.includes("You are Agent Smith's reasoning engine.")) {
            firstAnalysisCalls += 1;
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                summary: "README workflow guidance needs cleanup.",
                recommendations: [
                  {
                    id: "refresh-readme-workflow",
                    title: "Refresh README workflow copy",
                    priority: "medium",
                    category: "workflow",
                    rationale: "The workflow description is stale.",
                    evidence: ["README guidance is incomplete"],
                    actions: [
                      {
                        type: "workflow_change",
                        description: "Refresh the README workflow section.",
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
            writeFileSync(join(repoRoot, "README.md"), `# Agent Smith\n\nAttempt ${firstAnalysisCalls}\n`);
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                summary: `updated README attempt ${firstAnalysisCalls}`,
                changedFiles: ["README.md"],
                validation: [],
                followUps: [],
              }),
              stderr: "",
            };
          }

          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary: "The edits did not address the workflow gap.",
              outcome: "partial",
              rationale: "The README still lacks the required workflow detail.",
              continueLoop: true,
              nextFocus: "Try one more focused README update.",
            }),
            stderr: "",
          };
        },
      },
    });

    expect(firstExit).toBe(0);
    const firstPayload = JSON.parse(getFirstStdout()) as { stopReason: string };
    expect(firstPayload.stopReason).toBe("stalled");

    const { io: secondIo, getStdout: getSecondStdout } = createIo();
    let secondAnalysisCalls = 0;
    const secondExit = await runCli(["loop", "--tool", "codex", "--iterations", "1", "--format", "json"], secondIo, {
      loop: {
        env: process.env,
        repoRoot,
        runAgent: ({ prompt }) => {
          if (prompt.includes("You are Agent Smith's reasoning engine.")) {
            secondAnalysisCalls += 1;
            expect(prompt).toContain("[stalled] refresh-readme-workflow: The edits did not address the workflow gap.");
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                summary: "The same README recommendation still appears in the analysis.",
                recommendations: [
                  {
                    id: "refresh-readme-workflow",
                    title: "Refresh README workflow copy",
                    priority: "medium",
                    category: "workflow",
                    rationale: "The workflow copy is still stale.",
                    evidence: ["README guidance is incomplete"],
                    actions: [
                      {
                        type: "workflow_change",
                        description: "Refresh the README workflow section.",
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
            exitCode: 1,
            stdout: "",
            stderr: "should not reach apply/evaluate for stalled history",
          };
        },
      },
    });

    expect(secondExit).toBe(0);
    expect(secondAnalysisCalls).toBe(1);

    const secondPayload = JSON.parse(getSecondStdout()) as {
      stopReason: string;
      iterations: Array<{ recommendationId: string }>;
    };
    expect(secondPayload.stopReason).toBe("no_auto_applicable_recommendations");
    expect(secondPayload.iterations).toEqual([]);

    const history = readHistoryRow();
    expect(history?.recommendation_id).toBe("refresh-readme-workflow");
    expect(history?.stalled_count).toBe(1);
    expect(history?.last_state).toBe("stalled");
    expect(history?.total_attempts).toBe(2);
  });
});
