import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { AgentRunner } from "./agent-runner";
import { repoRootFromHere } from "./agent-hosts";
import { createEvent } from "./events";
import { generateImprovementReport, type ImprovementReport, renderImprovementReport } from "./recommendations";
import { ensureMetricsLayout, resolvePaths, type AgentSmithPaths } from "./paths";
import { type AgentSmithReport, generateReport, renderTextReport } from "./report";
import { rollupEvents } from "./rollup";
import { appendEvent } from "./store";
import { createTerminalTheme } from "./terminal-theme";
import { type ImprovementLoopReport, renderLoopReport, runImprovementLoop } from "./loop";
import { runWatchTui } from "./watch-tui";

export interface FullLoopDemoOptions {
  demoDir?: string;
  delayMs?: number;
  watch?: boolean;
  autoExitMs?: number;
}

export interface FullLoopDemoArtifacts {
  initialReport: string;
  improveReport: string;
  loopReport: string;
  finalReport: string;
  summary: string;
}

export interface FullLoopDemoResult {
  demoDir: string;
  homeDir: string;
  repoRoot: string;
  metricsDir: string;
  initialReport: AgentSmithReport;
  improvementReport: ImprovementReport;
  loopReport: ImprovementLoopReport;
  finalReport: AgentSmithReport;
  changedFiles: string[];
  artifacts: FullLoopDemoArtifacts;
}

interface DemoSandbox {
  demoDir: string;
  homeDir: string;
  repoRoot: string;
  paths: AgentSmithPaths;
  env: NodeJS.ProcessEnv;
}

const theme = createTerminalTheme({ color: false });

function runGit(repoRoot: string, args: string[], env: NodeJS.ProcessEnv): void {
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
  const proc = Bun.spawnSync(["git", "-C", repoRoot, ...args], {
    env: gitEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString() || proc.stdout.toString() || `git ${args.join(" ")} failed`);
  }
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createDemoSandbox(inputDir?: string): DemoSandbox {
  const demoDir = resolve(inputDir ?? join(repoRootFromHere(), ".context", "full-loop-demo"));
  const repoRoot = join(demoDir, "demo-repo");
  const homeDir = join(demoDir, "home");
  const metricsDir = join(demoDir, "metrics");

  rmSync(demoDir, { recursive: true, force: true });
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const env = {
    ...process.env,
    HOME: homeDir,
    METRICS_DIR: metricsDir,
    AGENT_SMITH_TOOL: "codex",
  };
  const paths = resolvePaths(env);
  ensureMetricsLayout(paths);

  writeFile(
    join(homeDir, ".codex", "config.toml"),
    ['model = "gpt-5"', 'approval_policy = "on-request"', 'sandbox_mode = "workspace-write"', ""].join("\n"),
  );

  const schemaDir = join(homeDir, ".config", "agent-smith", "schemas");
  mkdirSync(schemaDir, { recursive: true });
  writeFile(
    join(schemaDir, "codex-config.schema.json"),
    `${JSON.stringify(
      {
        type: "object",
        properties: {
          model: { type: "string", description: "Primary model selection." },
          approval_policy: { type: "string", description: "Approval mode for command execution." },
          sandbox_mode: { type: "string", description: "Filesystem sandbox mode." },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFile(
    join(schemaDir, "codex-config.schema.metadata.json"),
    `${JSON.stringify(
      {
        tool: "codex",
        schema_url: "https://developers.openai.com/codex/config-schema.json",
        schema_path: join(schemaDir, "codex-config.schema.json"),
        fetched_at: "2026-04-21T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );

  writeFile(
    join(repoRoot, "AGENTS.md"),
    ["# Demo Agent Instructions", "", "- Start fast.", "- Help if asked.", ""].join("\n"),
  );
  writeFile(
    join(repoRoot, "README.md"),
    [
      "# Demo Repo",
      "",
      "This sandbox simulates an operator repo with a loose handoff and no documented full-loop workflow yet.",
      "",
    ].join("\n"),
  );

  runGit(repoRoot, ["init"], env);
  runGit(repoRoot, ["config", "user.email", "demo@agent-smith.local"], env);
  runGit(repoRoot, ["config", "user.name", "Agent Smith Demo"], env);
  runGit(repoRoot, ["add", "AGENTS.md", "README.md"], env);
  runGit(repoRoot, ["commit", "-m", "seed demo sandbox"], env);

  return {
    demoDir,
    homeDir,
    repoRoot,
    paths,
    env,
  };
}

function appendDemoEvent(
  paths: AgentSmithPaths,
  input: {
    eventType: string;
    tool: string;
    sessionId: string;
    metadata?: Record<string, unknown>;
  },
  repoRoot: string,
): void {
  appendEvent(
    paths,
    createEvent({
      eventType: input.eventType,
      tool: input.tool,
      sessionId: input.sessionId,
      metadata: {
        cwd: repoRoot,
        ...input.metadata,
      },
    }),
  );
}

function createDemoAgentRunner(sandbox: DemoSandbox): AgentRunner {
  return ({ prompt, repoRoot }) => {
    if (prompt.includes("You are Agent Smith's reasoning engine.")) {
      appendDemoEvent(
        sandbox.paths,
        {
          eventType: "demo_note",
          tool: "demo",
          sessionId: "demo-analysis",
          metadata: {
            prompt_snippet: "analysis -> two safe recommendations queued",
          },
        },
        sandbox.repoRoot,
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          summary:
            "Permission denials and repeated clarifications show the opening operator contract is underspecified, and the repo should advertise the full-loop workflow explicitly.",
          recommendations: [
            {
              id: "tighten-request-contract",
              title: "Tighten the opening operator contract",
              priority: "high",
              category: "prompt",
              rationale: "The current AGENTS guidance does not force scope, target command, or validation upfront.",
              evidence: [
                "permission denials are present",
                "clarifying questions are present",
                "test failure loops are present",
              ],
              actions: [
                {
                  type: "prompt_change",
                  description: "Require scope, target command, and validation in AGENTS.md.",
                  targetFiles: [join(repoRoot, "AGENTS.md")],
                  safeToAutoApply: true,
                },
              ],
            },
            {
              id: "document-full-loop-demo",
              title: "Document the full-loop demo workflow",
              priority: "medium",
              category: "workflow",
              rationale: "The README should show operators how signals, watch, report, and loop fit together.",
              evidence: ["the README lacks a full-loop demo entry point"],
              actions: [
                {
                  type: "workflow_change",
                  description: "Add the full-loop demo invocation to README.md.",
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
        writeFile(
          join(repoRoot, "AGENTS.md"),
          [
            "# Demo Agent Instructions",
            "",
            "- Start with scope, target command, and the validation plan.",
            "- Keep changes inside the repo root and stay narrow.",
            "- Report what changed and what still needs approval.",
            "",
          ].join("\n"),
        );
        appendDemoEvent(
          sandbox.paths,
          {
            eventType: "demo_note",
            tool: "demo",
            sessionId: "demo-apply",
            metadata: {
              prompt_snippet: "apply -> AGENTS.md now requires scope + validation",
            },
          },
          sandbox.repoRoot,
        );
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            summary: "updated AGENTS guidance with scope, target command, and validation",
            changedFiles: ["AGENTS.md"],
            validation: [
              {
                command: 'rg -n "scope, target command, and the validation plan" AGENTS.md',
                outcome: "passed",
                details: "matched tightened contract",
              },
            ],
            followUps: [],
          }),
          stderr: "",
        };
      }

      writeFile(
        join(repoRoot, "README.md"),
        [
          "# Demo Repo",
          "",
          "This sandbox simulates an operator repo with a loose handoff and no documented full-loop workflow yet.",
          "",
          "## Full Loop",
          "",
          "- Run `make demo` to watch signals arrive live in the TUI.",
          "- The demo then rolls those signals into a report, analyzes the evidence, and auto-applies safe changes.",
          "",
        ].join("\n"),
      );
      appendDemoEvent(
        sandbox.paths,
        {
          eventType: "demo_note",
          tool: "demo",
          sessionId: "demo-apply",
          metadata: {
            prompt_snippet: "apply -> README.md now advertises make demo",
          },
        },
        sandbox.repoRoot,
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          summary: "documented the make demo full-loop workflow in README",
          changedFiles: ["README.md"],
          validation: [
            {
              command: 'rg -n "make demo" README.md',
              outcome: "passed",
              details: "demo entry point documented",
            },
          ],
          followUps: [],
        }),
        stderr: "",
      };
    }

    if (prompt.includes("You are evaluating whether a just-applied Agent Smith improvement")) {
      const resolvedReadme = prompt.includes("document-full-loop-demo");
      appendDemoEvent(
        sandbox.paths,
        {
          eventType: "demo_note",
          tool: "demo",
          sessionId: "demo-evaluate",
          metadata: {
            prompt_snippet: resolvedReadme
              ? "evaluate -> README workflow landed"
              : "evaluate -> AGENTS contract landed",
          },
        },
        sandbox.repoRoot,
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          summary: resolvedReadme
            ? "The README now shows the full-loop path directly."
            : "The AGENTS contract now forces a tighter operator handoff.",
          outcome: "resolved",
          rationale: "The requested wording landed in the intended file and matches the recommendation scope.",
          continueLoop: !resolvedReadme,
          nextFocus: resolvedReadme ? "" : "Move to the README workflow recommendation.",
        }),
        stderr: "",
      };
    }

    return {
      exitCode: 1,
      stdout: "",
      stderr: "unexpected demo prompt",
    };
  };
}

async function pause(delayMs: number): Promise<void> {
  if (delayMs > 0) {
    await sleep(delayMs);
  }
}

function writeReportArtifacts(
  sandbox: DemoSandbox,
  reports: {
    initialReport: AgentSmithReport;
    improvementReport: ImprovementReport;
    loopReport: ImprovementLoopReport;
    finalReport: AgentSmithReport;
  },
): FullLoopDemoArtifacts {
  const artifacts: FullLoopDemoArtifacts = {
    initialReport: join(sandbox.paths.reportsDir, "demo-initial-report.txt"),
    improveReport: join(sandbox.paths.reportsDir, "demo-improve-report.txt"),
    loopReport: join(sandbox.paths.reportsDir, "demo-loop-report.txt"),
    finalReport: join(sandbox.paths.reportsDir, "demo-final-report.txt"),
    summary: join(sandbox.paths.reportsDir, "demo-summary.json"),
  };

  writeFileSync(artifacts.initialReport, renderTextReport(reports.initialReport, theme));
  writeFileSync(artifacts.improveReport, renderImprovementReport(reports.improvementReport, theme));
  writeFileSync(artifacts.loopReport, renderLoopReport(reports.loopReport, theme));
  writeFileSync(artifacts.finalReport, renderTextReport(reports.finalReport, theme));

  return artifacts;
}

async function runDemoScenario(sandbox: DemoSandbox, delayMs: number): Promise<FullLoopDemoResult> {
  const emit = async (
    eventType: string,
    sessionId: string,
    metadata: Record<string, unknown> = {},
    tool = "codex",
  ): Promise<void> => {
    appendDemoEvent(sandbox.paths, { eventType, tool, sessionId, metadata }, sandbox.repoRoot);
    await pause(delayMs);
  };
  const note = async (message: string): Promise<void> => {
    appendDemoEvent(
      sandbox.paths,
      {
        eventType: "demo_note",
        tool: "demo",
        sessionId: "demo-stage",
        metadata: { prompt_snippet: message },
      },
      sandbox.repoRoot,
    );
    await pause(delayMs);
  };

  const runner = createDemoAgentRunner(sandbox);

  await note("boot -> generating messy operator sessions");
  await emit("session_start", "demo-alpha", { prompt_snippet: "Ship the fix quickly." });
  await emit("clarifying_question", "demo-alpha", { prompt_snippet: "Need scope, target command, or validation?" });
  await emit("permission_denied", "demo-alpha", { command: "rm -rf ~/.cache/agent-smith" });
  await emit("command_failure", "demo-alpha", { command: "pnpm test" });
  await emit("session_stop", "demo-alpha", { stop_reason: "end_turn", duration_seconds: 43 });

  await emit("session_start", "demo-bravo", { prompt_snippet: "Fix the tests and keep retrying." });
  await emit("test_failure_loop", "demo-bravo", { command: "pnpm test" });
  await emit("context_compression", "demo-bravo", { prompt_snippet: "Compressed prior retries and failure context" });
  await emit("session_stop", "demo-bravo", { stop_reason: "end_turn", duration_seconds: 57 });

  await emit("session_start", "demo-charlie", { prompt_snippet: "Update docs after the runtime change." });
  await emit("session_stop", "demo-charlie", { stop_reason: "end_turn", duration_seconds: 18 });

  const rollup = rollupEvents(sandbox.paths);
  await note(`rollup -> ${rollup.ingestedEvents} events landed in SQLite`);

  const initialReport = generateReport(sandbox.paths, { tool: "codex", limit: 5 });
  await note(
    `report -> ${initialReport.totalSessions} sessions, ${initialReport.health.attentionSessions} attention, ${initialReport.health.failures.events} failures`,
  );

  const improvementReport = await generateImprovementReport(
    sandbox.paths,
    { tool: "codex", limit: 5 },
    { env: sandbox.env, repoRoot: sandbox.repoRoot, runAgent: runner },
  );
  await note(`improve -> ${improvementReport.recommendations.length} safe recommendations`);

  const loopReport = await runImprovementLoop(
    { tool: "codex", iterations: 2 },
    { env: sandbox.env, repoRoot: sandbox.repoRoot, runAgent: runner },
  );
  await note(`loop -> ${loopReport.completedRecommendationIds.length} recommendations resolved`);

  await emit("session_start", "demo-delta", {
    prompt_snippet: "Scoped request: update the docs and run focused validation only.",
  });
  await emit("session_stop", "demo-delta", { stop_reason: "end_turn", duration_seconds: 14 });

  rollupEvents(sandbox.paths);
  const finalReport = generateReport(sandbox.paths, { tool: "codex", limit: 5 });
  await note(`final -> clean session added; latest run has ${finalReport.health.activeSessions} active sessions`);

  const artifacts = writeReportArtifacts(sandbox, {
    initialReport,
    improvementReport,
    loopReport,
    finalReport,
  });

  const result: FullLoopDemoResult = {
    demoDir: sandbox.demoDir,
    homeDir: sandbox.homeDir,
    repoRoot: sandbox.repoRoot,
    metricsDir: sandbox.paths.metricsDir,
    initialReport,
    improvementReport,
    loopReport,
    finalReport,
    changedFiles: [...new Set(loopReport.iterations.flatMap((iteration) => iteration.apply.changedFiles))],
    artifacts,
  };

  writeFileSync(artifacts.summary, `${JSON.stringify(result, null, 2)}\n`);
  await note("done -> artifacts saved under metrics/reports");
  return result;
}

export async function runFullLoopDemo(options: FullLoopDemoOptions = {}): Promise<FullLoopDemoResult> {
  const sandbox = createDemoSandbox(options.demoDir);
  const delayMs = options.delayMs ?? 220;

  if (!options.watch) {
    return await runDemoScenario(sandbox, delayMs);
  }

  const controller = new AbortController();
  const watchTask = runWatchTui(sandbox.paths, {
    tail: 0,
    pollMs: 120,
    signal: controller.signal,
  });

  await pause(delayMs);
  try {
    const result = await runDemoScenario(sandbox, delayMs);
    await pause(options.autoExitMs ?? 1200);
    controller.abort();
    await watchTask;
    return result;
  } catch (error) {
    controller.abort();
    await watchTask.catch(() => undefined);
    throw error;
  }
}

export function renderFullLoopDemo(result: FullLoopDemoResult): string {
  const changedFiles = result.changedFiles.length > 0 ? result.changedFiles.join(", ") : "none";
  return [
    theme.bold(theme.accent("Agent Smith Demo")),
    `${theme.dim("Demo dir:")} ${result.demoDir}`,
    `${theme.dim("Repo root:")} ${result.repoRoot}`,
    `${theme.dim("Metrics dir:")} ${result.metricsDir}`,
    "",
    `${theme.bold(theme.info("Flow"))}`,
    `  Signals: ${result.initialReport.totalEvents} events across ${result.initialReport.totalSessions} sessions`,
    `  Improve: ${result.improvementReport.recommendations.length} recommendation(s)`,
    `  Loop: ${result.loopReport.stopReason} after ${result.loopReport.iterations.length} iteration(s)`,
    `  Files changed: ${changedFiles}`,
    "",
    `${theme.bold(theme.info("Artifacts"))}`,
    `  initial report: ${result.artifacts.initialReport}`,
    `  improve report: ${result.artifacts.improveReport}`,
    `  loop report: ${result.artifacts.loopReport}`,
    `  final report: ${result.artifacts.finalReport}`,
    `  summary json: ${result.artifacts.summary}`,
    "",
  ].join("\n");
}
