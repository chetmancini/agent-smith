import { describe, expect, test } from "bun:test";

import { createEvent } from "../src/lib/events";
import { renderTextReport } from "../src/lib/report";
import { createTerminalTheme, shouldUseColor } from "../src/lib/terminal-theme";
import { formatWatchedEvent } from "../src/lib/watch";

describe("terminal theme", () => {
  test("detects standard color env toggles", () => {
    expect(shouldUseColor({ isTTY: true, env: {} })).toBe(true);
    expect(shouldUseColor({ isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
    expect(shouldUseColor({ isTTY: false, env: { FORCE_COLOR: "1" } })).toBe(true);
    expect(shouldUseColor({ isTTY: true, env: { CLICOLOR: "0" } })).toBe(false);
  });

  test("watch formatting emits ansi when color is enabled", () => {
    const event = createEvent({
      eventType: "command_failure",
      tool: "codex",
      sessionId: "color-watch",
      timestamp: "2026-04-21T12:00:00.000Z",
      metadata: { cwd: "/tmp/color-watch", command: "bun test" },
    });

    const rendered = formatWatchedEvent(event, createTerminalTheme({ color: true }));
    expect(rendered).toContain("\u001B[");
    expect(rendered).toContain("command_failure");
  });

  test("report rendering emits ansi when color is enabled", () => {
    const report = {
      metricsDir: "/tmp/metrics",
      totalEvents: 4,
      totalSessions: 2,
      health: {
        activeSessions: 1,
        attentionSessions: 1,
        failures: { sessions: 1, events: 1 },
        permissionDenials: { sessions: 0, events: 0 },
        clarifications: { sessions: 0, events: 0 },
        testFailureLoops: { sessions: 0, events: 0 },
        contextCompressions: { sessions: 0, events: 0 },
      },
      activeSessions: [],
      attentionSessions: [],
      recentSessions: [],
      stopReasons: [],
      failureHotspots: [],
      tools: [],
      eventTypes: [],
      projects: [],
      recentFailures: [],
    };

    const rendered = renderTextReport(report, createTerminalTheme({ color: true }));
    expect(rendered).toContain("\u001B[");
    expect(rendered).toContain("Agent Smith Report");
  });
});
