import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
}

export interface FullLoopDemoArtifacts {
  initialReport: string;
  improveReport: string;
  loopReport: string;
  finalReport: string;
  summary: string;
  workingLog: string;
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

interface DemoTmuxSplitPane {
  paneId: string;
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
    AGENT_SMITH_TOOL: "claude",
  };
  const paths = resolvePaths(env);
  ensureMetricsLayout(paths);

  writeFile(
    join(homeDir, ".claude", "settings.json"),
    `${JSON.stringify(
      {
        permissions: {
          defaultMode: "acceptEdits",
          allow: ["Bash(bun test)", "Bash(rg:*)", "Edit(src/**)", "Edit(README.md)"],
        },
        model: "claude-sonnet-4-20250514",
      },
      null,
      2,
    )}\n`,
  );

  const schemaDir = join(homeDir, ".config", "agent-smith", "schemas");
  mkdirSync(schemaDir, { recursive: true });
  writeFile(
    join(schemaDir, "claude-code-settings.schema.json"),
    `${JSON.stringify(
      {
        type: "object",
        properties: {
          permissions: { type: "object", description: "Allowed tool patterns and execution defaults." },
          model: { type: "string", description: "Primary Claude model selection." },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFile(
    join(schemaDir, "claude-code-settings.schema.metadata.json"),
    `${JSON.stringify(
      {
        tool: "claude",
        schema_url: "https://json.schemastore.org/claude-code-settings.json",
        schema_path: join(schemaDir, "claude-code-settings.schema.json"),
        fetched_at: "2026-04-21T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );

  writeFile(
    join(repoRoot, "AGENTS.md"),
    [
      "# Demo Agent Instructions",
      "",
      "- Start with scope, target command, and the validation plan.",
      "- Keep fixes inside the todo app unless the operator asks for docs.",
      "- Call out any permission barriers before retrying broad commands.",
      "",
    ].join("\n"),
  );
  writeFile(
    join(repoRoot, "README.md"),
    [
      "# Todo Demo App",
      "",
      "Tiny Bun todo app used to simulate Agent Smith's full-loop telemetry.",
      "",
      "## Local commands",
      "",
      "- `bun test` runs the focused todo tests.",
      "- `bun run src/index.ts` prints the current todo labels.",
      "",
    ].join("\n"),
  );
  writeFile(
    join(repoRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "todo-demo-app",
        private: true,
        type: "module",
        scripts: {
          test: "bun test",
          start: "bun run src/index.ts",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFile(
    join(repoRoot, "src", "todos.ts"),
    [
      "export interface Todo {",
      "  id: string;",
      "  title: string;",
      "  done: boolean;",
      "}",
      "",
      "export function completeTodo(todo: Todo): Todo {",
      "  return {",
      "    ...todo,",
      "    done: false,",
      "  };",
      "}",
      "",
      "export function todoLabel(todo: Todo): string {",
      "  return `" + "$" + '{todo.done ? "[x]" : "[ ]"} ' + "$" + "{todo.title}" + "`;",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    join(repoRoot, "src", "index.ts"),
    [
      'import { completeTodo, todoLabel } from "./todos";',
      "",
      'const todo = completeTodo({ id: "1", title: "ship docs", done: false });',
      "console.log(todoLabel(todo));",
      "",
    ].join("\n"),
  );
  writeFile(
    join(repoRoot, "tests", "todos.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      "",
      'import { completeTodo, todoLabel } from "../src/todos";',
      "",
      'test("completeTodo marks the todo as done", () => {',
      '  const todo = completeTodo({ id: "1", title: "ship docs", done: false });',
      "  expect(todo.done).toBe(true);",
      '  expect(todoLabel(todo)).toBe("[x] ship docs");',
      "});",
      "",
    ].join("\n"),
  );

  runGit(repoRoot, ["init"], env);
  runGit(repoRoot, ["config", "user.email", "demo@agent-smith.local"], env);
  runGit(repoRoot, ["config", "user.name", "Agent Smith Demo"], env);
  runGit(
    repoRoot,
    ["add", "AGENTS.md", "README.md", "package.json", "src/index.ts", "src/todos.ts", "tests/todos.test.ts"],
    env,
  );
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

function demoWorkingLogPath(paths: AgentSmithPaths): string {
  return join(paths.reportsDir, "demo-claude-working.log");
}

function initializeDemoWorkingLog(paths: AgentSmithPaths): void {
  writeFileSync(demoWorkingLogPath(paths), "Claude Working\n");
}

function appendWorkingLog(paths: AgentSmithPaths, message: string): void {
  appendFileSync(demoWorkingLogPath(paths), `${new Date().toISOString().slice(11, 19)} ${message}\n`);
}

function appendWorkingLogBlock(paths: AgentSmithPaths, title: string, content: string): void {
  appendWorkingLog(paths, title);
  for (const line of content.trimEnd().split("\n")) {
    appendWorkingLog(paths, line.length > 0 ? line : " ");
  }
}

function describeDemoCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildDemoTmuxTailCommand(filePath: string): string {
  return `exec tail -n +1 -f ${shellQuote(filePath)}`;
}

function openDemoTmuxSplitPane(filePath: string): DemoTmuxSplitPane | null {
  const tmuxPane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !tmuxPane || !Bun.which("tmux")) {
    return null;
  }

  const proc = Bun.spawnSync(
    [
      "tmux",
      "split-window",
      "-d",
      "-h",
      "-p",
      "35",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      tmuxPane,
      buildDemoTmuxTailCommand(filePath),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (proc.exitCode !== 0) {
    return null;
  }

  const paneId = proc.stdout.toString().trim();
  return paneId ? { paneId } : null;
}

function closeDemoTmuxSplitPane(splitPane: DemoTmuxSplitPane | null): void {
  if (!splitPane || !Bun.which("tmux")) {
    return;
  }

  Bun.spawnSync(["tmux", "kill-pane", "-t", splitPane.paneId], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

function createDemoAgentRunner(sandbox: DemoSandbox): AgentRunner {
  return ({ prompt, repoRoot }) => {
    if (prompt.includes("You are Agent Smith's reasoning engine.")) {
      appendWorkingLog(
        sandbox.paths,
        "Claude is reviewing the telemetry summary and repo context for agentic analysis",
      );
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
            "Claude explored the todo app with repeated Bash/Edit tool calls, but the opening operator contract is still underspecified and the repo should advertise the full-loop workflow explicitly.",
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
        appendWorkingLog(sandbox.paths, "Claude is tightening AGENTS.md guidance");
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

      appendWorkingLog(sandbox.paths, "Claude is updating README.md with the demo flow");
      writeFile(
        join(repoRoot, "README.md"),
        [
          "# Todo Demo App",
          "",
          "Tiny Bun todo app used to simulate Agent Smith's full-loop telemetry.",
          "",
          "## Local commands",
          "",
          "- `bun test` runs the focused todo tests.",
          "- `bun run src/index.ts` prints the current todo labels.",
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
      appendWorkingLog(
        sandbox.paths,
        resolvedReadme ? "Claude is verifying the README workflow change" : "Claude is checking the AGENTS.md contract",
      );
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
    workingLog: demoWorkingLogPath(sandbox.paths),
  };

  writeFileSync(artifacts.initialReport, renderTextReport(reports.initialReport, theme));
  writeFileSync(artifacts.improveReport, renderImprovementReport(reports.improvementReport, theme));
  writeFileSync(artifacts.loopReport, renderLoopReport(reports.loopReport, theme));
  writeFileSync(artifacts.finalReport, renderTextReport(reports.finalReport, theme));

  return artifacts;
}

async function runDemoScenario(sandbox: DemoSandbox, delayMs: number): Promise<FullLoopDemoResult> {
  const demoTool = "claude";
  const emit = async (
    eventType: string,
    sessionId: string,
    metadata: Record<string, unknown> = {},
    tool = demoTool,
  ): Promise<void> => {
    appendDemoEvent(sandbox.paths, { eventType, tool, sessionId, metadata }, sandbox.repoRoot);
    await pause(delayMs);
  };
  const toolAttempt = async (
    sessionId: string,
    toolName: string,
    metadata: {
      command?: string;
      file_path?: string;
      turn_id?: string;
      tool_use_id?: string;
    },
  ): Promise<void> => {
    await emit("tool_attempt", sessionId, {
      tool_name: toolName,
      ...metadata,
    });
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
  const working = async (message: string): Promise<void> => {
    appendWorkingLog(sandbox.paths, message);
    await pause(delayMs);
  };

  const runner = createDemoAgentRunner(sandbox);

  await note("boot -> simulating Claude fixing a tiny todo app");
  await working("Claude is scanning the demo repo");
  await emit("session_start", "demo-alpha", {
    prompt_snippet: "Fix the todo completion bug in the demo app and tell me what you validated.",
  });
  await working("Claude is listing files");
  await toolAttempt("demo-alpha", "Bash", {
    command: "ls",
    turn_id: "turn-alpha-1",
    tool_use_id: "tool-alpha-1",
  });
  await working("Claude is running bun test");
  await toolAttempt("demo-alpha", "Bash", {
    command: "bun test",
    turn_id: "turn-alpha-2",
    tool_use_id: "tool-alpha-2",
  });
  await emit("tool_failure", "demo-alpha", {
    tool_name: "Bash",
    command: "bun test",
    error: "1 failing test: completeTodo marks the todo as done",
    exit_code: 1,
    stderr_snippet: "Expected: true\nReceived: false",
    turn_id: "turn-alpha-2",
    tool_use_id: "tool-alpha-2",
  });
  await emit("command_failure", "demo-alpha", {
    command: "bun test",
    error: "1 failing test: completeTodo marks the todo as done",
    exit_code: 1,
    stderr_snippet: "Expected: true\nReceived: false",
    turn_id: "turn-alpha-2",
    tool_use_id: "tool-alpha-2",
  });
  await working("Claude saw the failing assertion and is editing src/todos.ts");
  await toolAttempt("demo-alpha", "Edit", {
    file_path: "src/todos.ts",
    turn_id: "turn-alpha-3",
    tool_use_id: "tool-alpha-3",
  });
  await emit("clarifying_question", "demo-alpha", {
    prompt_snippet: "Should I keep the fix scoped to src/todos.ts, or also update README and AGENTS?",
  });
  await emit("permission_denied", "demo-alpha", {
    tool_name: "Write",
    command: "rm -rf ~/.cache/agent-smith",
  });
  await working("Claude wrapped the first pass and handed back a scoped question");
  await emit("session_stop", "demo-alpha", { stop_reason: "end_turn", duration_seconds: 43 });

  await emit("session_start", "demo-bravo", {
    prompt_snippet: "Fix the tests and keep retrying until the todo app passes.",
  });
  await working("Claude reopened src/todos.ts to inspect the bug");
  await toolAttempt("demo-bravo", "Bash", {
    command: "sed -n '1,200p' src/todos.ts",
    turn_id: "turn-bravo-1",
    tool_use_id: "tool-bravo-1",
  });
  await toolAttempt("demo-bravo", "Edit", {
    file_path: "src/todos.ts",
    turn_id: "turn-bravo-2",
    tool_use_id: "tool-bravo-2",
  });
  await working("Claude is rerunning bun test");
  await toolAttempt("demo-bravo", "Bash", {
    command: "bun test",
    turn_id: "turn-bravo-3",
    tool_use_id: "tool-bravo-3",
  });
  await emit("test_failure_loop", "demo-bravo", { command: "bun test" });
  await working("Claude is checking AGENTS.md and README.md for missing operator context");
  await toolAttempt("demo-bravo", "Bash", {
    command: 'rg -n "scope|validation|demo" AGENTS.md README.md',
    turn_id: "turn-bravo-4",
    tool_use_id: "tool-bravo-4",
  });
  await emit("context_compression", "demo-bravo", {
    prompt_snippet: "Compressed prior retries, failing test output, and app file context",
  });
  await working("Claude compressed prior retries before the next turn");
  await emit("session_stop", "demo-bravo", { stop_reason: "end_turn", duration_seconds: 57 });

  await emit("session_start", "demo-charlie", {
    prompt_snippet: "Update docs after the runtime change so future Claude runs start cleaner.",
  });
  await working("Claude is reading README.md");
  await toolAttempt("demo-charlie", "Bash", {
    command: "sed -n '1,200p' README.md",
    turn_id: "turn-charlie-1",
    tool_use_id: "tool-charlie-1",
  });
  await toolAttempt("demo-charlie", "Edit", {
    file_path: "README.md",
    turn_id: "turn-charlie-2",
    tool_use_id: "tool-charlie-2",
  });
  await working("Claude finished the first documentation pass");
  await emit("session_stop", "demo-charlie", { stop_reason: "end_turn", duration_seconds: 18 });

  await working(
    "Claude is rolling the captured JSONL events into SQLite so the reports can query sessions and failures",
  );
  const rollup = rollupEvents(sandbox.paths);
  await note(`rollup -> ${rollup.ingestedEvents} events landed in SQLite`);

  await working("Claude is emitting the initial operator report from the rolled-up telemetry store");
  const initialReport = generateReport(sandbox.paths, { tool: demoTool, limit: 5 });
  appendWorkingLogBlock(
    sandbox.paths,
    "Claude printed the initial operator report:",
    renderTextReport(initialReport, theme),
  );
  await note(
    `report -> ${initialReport.totalSessions} sessions, ${initialReport.health.attentionSessions} attention, ${initialReport.health.failures.events} failures`,
  );

  await working("Claude is running agentic analysis over telemetry, instructions, and repo context");
  const improvementReport = await generateImprovementReport(
    sandbox.paths,
    { tool: demoTool, limit: 5 },
    { env: sandbox.env, repoRoot: sandbox.repoRoot, runAgent: runner },
  );
  await note(`improve -> ${improvementReport.recommendations.length} safe recommendations`);
  appendWorkingLogBlock(
    sandbox.paths,
    "Claude printed the improvement report for operator review:",
    renderImprovementReport(improvementReport, theme),
  );
  await working(
    `Claude emitted the improvement report with ${describeDemoCount(
      improvementReport.recommendations.length,
      "safe recommendation",
      "safe recommendations",
    )} and is offering to apply them`,
  );

  await working("Operator accepted the safe recommendations; Claude is applying them now");
  const loopReport = await runImprovementLoop(
    { tool: demoTool, iterations: 2 },
    { env: sandbox.env, repoRoot: sandbox.repoRoot, runAgent: runner },
  );
  await note(`loop -> ${loopReport.completedRecommendationIds.length} recommendations resolved`);

  await emit("session_start", "demo-delta", {
    prompt_snippet: "Scoped request: update the docs and run focused validation for the todo app only.",
  });
  await working("Claude is running the final focused validation");
  await toolAttempt("demo-delta", "Bash", {
    command: 'rg -n "make demo|bun test" README.md AGENTS.md',
    turn_id: "turn-delta-1",
    tool_use_id: "tool-delta-1",
  });
  await emit("session_stop", "demo-delta", { stop_reason: "end_turn", duration_seconds: 14 });

  rollupEvents(sandbox.paths);
  await working("Claude is emitting the refreshed final report after the applied changes");
  const finalReport = generateReport(sandbox.paths, { tool: demoTool, limit: 5 });
  appendWorkingLogBlock(
    sandbox.paths,
    "Claude printed the refreshed final report:",
    renderTextReport(finalReport, theme),
  );
  await note(`final -> clean session added; latest run has ${finalReport.health.activeSessions} active sessions`);

  await working("Claude is writing the demo report artifacts so the operator can inspect the full loop");
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
  const delayMs = options.delayMs ?? 700;
  initializeDemoWorkingLog(sandbox.paths);

  if (!options.watch) {
    return await runDemoScenario(sandbox, delayMs);
  }

  const controller = new AbortController();
  const tmuxSplitPane = openDemoTmuxSplitPane(demoWorkingLogPath(sandbox.paths));
  const watchTask = runWatchTui(sandbox.paths, {
    tail: 0,
    pollMs: 120,
    signal: controller.signal,
    extraPane: tmuxSplitPane
      ? undefined
      : {
          filePath: demoWorkingLogPath(sandbox.paths),
          label: " Claude Working ",
        },
  });

  await pause(delayMs);
  try {
    const result = await runDemoScenario(sandbox, delayMs);
    appendWorkingLog(sandbox.paths, "Demo finished. Press q in the watch pane to close.");
    await watchTask;
    return result;
  } catch (error) {
    controller.abort();
    await watchTask.catch(() => undefined);
    throw error;
  } finally {
    controller.abort();
    closeDemoTmuxSplitPane(tmuxSplitPane);
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
    `  working log: ${result.artifacts.workingLog}`,
    `  summary json: ${result.artifacts.summary}`,
    "",
  ].join("\n");
}
