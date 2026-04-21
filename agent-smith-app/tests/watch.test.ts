import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvent } from "../src/lib/events";
import { resolvePaths } from "../src/lib/paths";
import { appendEvent } from "../src/lib/store";
import {
  applyEventToWatchDashboardState,
  buildWatchDashboardSeed,
  buildWatchDashboardState,
  createWatchDashboardState,
  createSessionWatchFormatter,
  formatWatchedEvent,
  snapshotWatchDashboard,
  watchEvents,
} from "../src/lib/watch";

describe("watch", () => {
  let metricsDir: string;

  beforeEach(() => {
    metricsDir = mkdtempSync(join(tmpdir(), "agent-smith-watch-"));
    process.env.METRICS_DIR = metricsDir;
  });

  afterEach(() => {
    delete process.env.METRICS_DIR;
    rmSync(metricsDir, { recursive: true, force: true });
  });

  test("watch yields tailed events and follows new ones", async () => {
    const paths = resolvePaths(process.env);

    appendEvent(
      paths,
      createEvent({
        eventType: "session_start",
        tool: "codex",
        sessionId: "watch-a",
        metadata: { cwd: "/tmp/project-a" },
      }),
    );

    const controller = new AbortController();
    const iterator = watchEvents(paths, {
      tail: 1,
      pollMs: 10,
      signal: controller.signal,
    });

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.session_id).toBe("watch-a");

    appendEvent(
      paths,
      createEvent({
        eventType: "command_failure",
        tool: "codex",
        sessionId: "watch-a",
        metadata: { cwd: "/tmp/project-a", command: "npm test" },
      }),
    );

    const second = await iterator.next();
    expect(second.done).toBe(false);
    expect(second.value?.event_type).toBe("command_failure");
    if (!second.value) {
      throw new Error("expected watch iterator to yield an event");
    }
    expect(formatWatchedEvent(second.value)).toContain("npm test");

    controller.abort();
  });

  test("watch can resume from a seed snapshot offset without dropping handoff events", async () => {
    const paths = resolvePaths(process.env);

    appendEvent(
      paths,
      createEvent({
        eventType: "session_start",
        tool: "codex",
        sessionId: "watch-seed",
        metadata: { cwd: "/tmp/project-a" },
      }),
    );

    const seed = buildWatchDashboardSeed(paths);
    expect(seed.state.totalEvents).toBe(1);

    appendEvent(
      paths,
      createEvent({
        eventType: "command_failure",
        tool: "codex",
        sessionId: "watch-seed",
        metadata: { cwd: "/tmp/project-a", command: "npm test" },
      }),
    );

    const controller = new AbortController();
    const iterator = watchEvents(paths, {
      startOffset: seed.nextOffset,
      pollMs: 10,
      signal: controller.signal,
    });

    const next = await iterator.next();
    expect(next.done).toBe(false);
    expect(next.value?.event_type).toBe("command_failure");
    expect(next.value?.session_id).toBe("watch-seed");

    controller.abort();
  });

  test("session watch formatter summarizes state transitions", () => {
    const formatSessionEvent = createSessionWatchFormatter();

    const startLine = formatSessionEvent(
      createEvent({
        eventType: "session_start",
        tool: "codex",
        sessionId: "watch-session",
        timestamp: "2026-04-20T12:00:00.000Z",
        metadata: { cwd: "/tmp/project-a" },
      }),
    );
    expect(startLine).toContain("START");
    expect(startLine).toContain("active=1");

    const failureLine = formatSessionEvent(
      createEvent({
        eventType: "command_failure",
        tool: "codex",
        sessionId: "watch-session",
        timestamp: "2026-04-20T12:00:05.000Z",
        metadata: { cwd: "/tmp/project-a", command: "npm test", error: "exit 1" },
      }),
    );
    expect(failureLine).toContain("FAIL");
    expect(failureLine).toContain("npm test");
    expect(failureLine).toContain("fail=1");

    const stopLine = formatSessionEvent(
      createEvent({
        eventType: "session_stop",
        tool: "codex",
        sessionId: "watch-session",
        timestamp: "2026-04-20T12:00:09.000Z",
        metadata: { stop_reason: "end_turn", duration_seconds: 9 },
      }),
    );
    expect(stopLine).toContain("STOP");
    expect(stopLine).toContain("end_turn");
    expect(stopLine).toContain("events=3");
    expect(stopLine).toContain("active=0");
  });

  test("watch dashboard snapshot separates active and historic sessions with aggregations", () => {
    const paths = resolvePaths(process.env);

    appendEvent(
      paths,
      createEvent({
        eventType: "session_start",
        tool: "codex",
        sessionId: "dashboard-a",
        timestamp: "2026-04-20T12:00:00.000Z",
        metadata: { cwd: "/tmp/project-a" },
      }),
    );
    appendEvent(
      paths,
      createEvent({
        eventType: "permission_denied",
        tool: "codex",
        sessionId: "dashboard-a",
        timestamp: "2026-04-20T12:00:03.000Z",
        metadata: { cwd: "/tmp/project-a", tool_name: "Bash" },
      }),
    );
    appendEvent(
      paths,
      createEvent({
        eventType: "session_start",
        tool: "claude",
        sessionId: "dashboard-b",
        timestamp: "2026-04-20T12:00:04.000Z",
        metadata: { cwd: "/tmp/project-b" },
      }),
    );
    appendEvent(
      paths,
      createEvent({
        eventType: "command_failure",
        tool: "claude",
        sessionId: "dashboard-b",
        timestamp: "2026-04-20T12:00:05.000Z",
        metadata: { cwd: "/tmp/project-b", command: "npm test", error: "exit 1" },
      }),
    );
    appendEvent(
      paths,
      createEvent({
        eventType: "session_stop",
        tool: "claude",
        sessionId: "dashboard-b",
        timestamp: "2026-04-20T12:00:09.000Z",
        metadata: { cwd: "/tmp/project-b", stop_reason: "end_turn", duration_seconds: 9 },
      }),
    );

    const snapshot = snapshotWatchDashboard(buildWatchDashboardState(paths), {
      activeLimit: 5,
      historyLimit: 5,
      groupLimit: 5,
    });

    expect(snapshot.totalEvents).toBe(5);
    expect(snapshot.totalSessions).toBe(2);
    expect(snapshot.activeSessions).toBe(1);
    expect(snapshot.completedSessions).toBe(1);
    expect(snapshot.attentionSessions).toBe(2);
    expect(snapshot.activeSessionRows[0]).toMatchObject({
      sessionId: "dashboard-a",
      status: "active-attention",
      denialCount: 1,
    });
    expect(snapshot.historicalSessionRows[0]).toMatchObject({
      sessionId: "dashboard-b",
      status: "attention",
      failureCount: 1,
      lastSnippet: "npm test",
    });
    expect(snapshot.toolSummary).toEqual([
      { name: "claude", events: 3, sessions: 1, activeSessions: 0, attentionSessions: 1 },
      { name: "codex", events: 2, sessions: 1, activeSessions: 1, attentionSessions: 1 },
    ]);
    expect(snapshot.recentEvents[0]).toContain("session_stop");
    expect(snapshot.recentEvents[1]).toContain("npm test");
  });

  test("watch dashboard prunes and compacts event-rate timestamps incrementally", () => {
    const state = createWatchDashboardState();
    const originalNow = Date.now;
    let now = Date.parse("2026-04-20T12:20:00.000Z");
    Date.now = () => now;

    try {
      for (let index = 0; index < 300; index += 1) {
        applyEventToWatchDashboardState(
          state,
          createEvent({
            eventType: "session_start",
            tool: "codex",
            sessionId: `rate-${index}`,
            timestamp: new Date(Date.parse("2026-04-20T12:00:00.000Z") + index * 1000).toISOString(),
            metadata: { cwd: `/tmp/project-${index}` },
          }),
        );
      }

      expect(state.eventTimestamps).toHaveLength(300);
      expect(state.eventTimestampStart).toBe(0);

      now = Date.parse("2026-04-20T12:41:00.000Z");
      applyEventToWatchDashboardState(
        state,
        createEvent({
          eventType: "command_failure",
          tool: "codex",
          sessionId: "rate-live",
          timestamp: "2026-04-20T12:40:30.000Z",
          metadata: { cwd: "/tmp/project-live", command: "bun test" },
        }),
      );

      expect(state.eventTimestampStart).toBe(0);
      expect(state.eventTimestamps).toEqual([Date.parse("2026-04-20T12:40:30.000Z")]);

      const snapshot = snapshotWatchDashboard(state);
      expect(snapshot.eventRateBuckets.reduce((total, bucket) => total + bucket, 0)).toBe(1);
    } finally {
      Date.now = originalNow;
    }
  });

  test("watch dashboard snapshot prunes stale rate timestamps during idle ticks", () => {
    const state = createWatchDashboardState();
    const originalNow = Date.now;
    let now = Date.parse("2026-04-20T12:05:00.000Z");
    Date.now = () => now;

    try {
      applyEventToWatchDashboardState(
        state,
        createEvent({
          eventType: "session_start",
          tool: "codex",
          sessionId: "idle-rate",
          timestamp: "2026-04-20T12:00:00.000Z",
          metadata: { cwd: "/tmp/project-idle" },
        }),
      );

      expect(state.eventTimestamps).toEqual([Date.parse("2026-04-20T12:00:00.000Z")]);

      now = Date.parse("2026-04-20T12:25:01.000Z");
      const snapshot = snapshotWatchDashboard(state);

      expect(snapshot.eventRateBuckets.reduce((total, bucket) => total + bucket, 0)).toBe(0);
      expect(state.eventTimestamps).toEqual([]);
      expect(state.eventTimestampStart).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });
});
