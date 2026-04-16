import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvent } from "../src/lib/events";
import { resolvePaths } from "../src/lib/paths";
import { generateReport } from "../src/lib/report";
import { rollupEvents } from "../src/lib/rollup";
import { appendEvent } from "../src/lib/store";

describe("rollup and report", () => {
  let metricsDir: string;

  beforeEach(() => {
    metricsDir = mkdtempSync(join(tmpdir(), "agent-smith-app-"));
    process.env.METRICS_DIR = metricsDir;
  });

  afterEach(() => {
    delete process.env.METRICS_DIR;
    rmSync(metricsDir, { recursive: true, force: true });
  });

  test("rollup ingests JSONL events into SQLite and report summarizes them", () => {
    const paths = resolvePaths(process.env);

    appendEvent(
      paths,
      createEvent({
        eventType: "session_start",
        tool: "codex",
        sessionId: "session-a",
        metadata: { cwd: "/Users/chet/code/agent-smith" },
      }),
    );
    appendEvent(
      paths,
      createEvent({
        eventType: "command_failure",
        tool: "codex",
        sessionId: "session-a",
        metadata: {
          cwd: "/Users/chet/code/agent-smith",
          command: "npm test",
          error: "exit 1",
        },
      }),
    );
    appendEvent(
      paths,
      createEvent({
        eventType: "session_stop",
        tool: "codex",
        sessionId: "session-a",
        metadata: {
          cwd: "/Users/chet/code/agent-smith",
          stop_reason: "end_turn",
          duration_seconds: 12,
        },
      }),
    );
    appendEvent(
      paths,
      createEvent({
        eventType: "session_start",
        tool: "claude",
        sessionId: "session-b",
        metadata: { cwd: "/Users/chet/code/other-project" },
      }),
    );

    const result = rollupEvents(paths);
    expect(result.ingestedEvents).toBe(4);
    expect(result.skippedLines).toBe(0);

    const report = generateReport(paths, { limit: 10 });
    expect(report.totalEvents).toBe(4);
    expect(report.totalSessions).toBe(2);
    expect(report.tools).toEqual([
      { tool: "codex", events: 3, sessions: 1 },
      { tool: "claude", events: 1, sessions: 1 },
    ]);
    expect(report.projects[0]).toEqual({
      project: "agent-smith",
      events: 3,
      sessions: 1,
    });
    expect(report.recentFailures).toHaveLength(1);
    expect(report.recentFailures[0]?.snippet).toBe("npm test");
  });

  test("rollup skips malformed partial lines and keeps the next offset stable", () => {
    const paths = resolvePaths(process.env);

    appendEvent(
      paths,
      createEvent({
        eventType: "session_start",
        tool: "codex",
        sessionId: "session-a",
        metadata: { cwd: "/tmp/project-a" },
      }),
    );

    writeFileSync(paths.eventsFile, `${readFileSync(paths.eventsFile, "utf8")}{"broken":true`);

    const result = rollupEvents(paths);
    expect(result.ingestedEvents).toBe(1);
    expect(result.skippedLines).toBe(0);
  });
});
