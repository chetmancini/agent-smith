import process from "node:process";

import type * as Blessed from "blessed";

import { resolvePaths, type AgentSmithPaths } from "./paths";
import {
  applyEventToWatchDashboardState,
  buildWatchDashboardSeed,
  buildWatchDashboardState,
  formatWatchDuration,
  snapshotWatchDashboard,
  watchEvents,
  type WatchDashboardSnapshot,
  type WatchOptions,
  type WatchSessionSummary,
} from "./watch";

interface TableWidget {
  setData: (data: { headers: string[]; data: string[][] }) => void;
}

interface SparklineWidget {
  setData: (titles: string[], datasets: number[][]) => void;
}

interface DonutWidget {
  setData: (
    data: Array<{
      percent: number;
      label: string;
      color: string;
      percentAltNumber?: number;
    }>,
  ) => void;
}

interface BlessedContribModule {
  table: (options: Record<string, unknown>) => TableWidget;
  sparkline: (options: Record<string, unknown>) => SparklineWidget;
  donut: (options: Record<string, unknown>) => DonutWidget;
}

type BlessedModule = typeof Blessed;
type BlessedRuntimeModule = BlessedModule & { default?: BlessedModule };
type BlessedNode = Blessed.Widgets.Node;

function requireTuiModule<T>(specifier: string): T {
  return import.meta.require(specifier) as T;
}

function compactTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return "-";
  }

  return timestamp.slice(11, 19);
}

function compactSessionLabel(session: WatchSessionSummary): string {
  const friction = [
    session.failureCount > 0 ? `f${session.failureCount}` : "",
    session.denialCount > 0 ? `d${session.denialCount}` : "",
    session.testLoopCount > 0 ? `l${session.testLoopCount}` : "",
    session.compressionCount > 0 ? `c${session.compressionCount}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return friction.length > 0 ? friction : "-";
}

function truncate(value: string | null, limit: number): string {
  if (!value) {
    return "-";
  }

  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function truncatePlain(value: string, limit: number): string {
  if (limit <= 0) {
    return "";
  }

  return value.length <= limit ? value : `${value.slice(0, Math.max(limit - 1, 0))}…`;
}

function tableRowsForSessions(sessions: WatchSessionSummary[]): string[][] {
  if (sessions.length === 0) {
    return [["-", "-", "-", "-", "-", "-"]];
  }

  return sessions.map((session) => [
    session.tool,
    session.project ?? "-",
    session.sessionId.slice(0, 8),
    session.status.replace("active-attention", "active!").replace("attention", "needs-attn"),
    session.status === "active" || session.status === "active-attention"
      ? compactTimestamp(session.startedAt)
      : compactTimestamp(session.lastTs),
    truncate(session.lastSnippet ?? session.stopReason ?? session.lastEventType, 28),
  ]);
}

function formatElapsed(lastUpdatedAt: string | null): string {
  if (!lastUpdatedAt) {
    return "";
  }

  const agoSeconds = Math.max(0, Math.floor((Date.now() - new Date(lastUpdatedAt).getTime()) / 1000));
  if (agoSeconds < 60) {
    return ` (${agoSeconds}s ago)`;
  }

  const mins = Math.floor(agoSeconds / 60);
  const secs = agoSeconds % 60;
  return ` (${mins}m${secs}s ago)`;
}

function renderStats(snapshot: WatchDashboardSnapshot, seedNote: string, tickCount: number): string {
  const attention = snapshot.attentionSessions > 0 ? `{yellow-fg}${snapshot.attentionSessions}{/yellow-fg}` : "0";
  const failures = snapshot.failureEvents > 0 ? `{red-fg}${snapshot.failureEvents}{/red-fg}` : "0";
  const denials = snapshot.denialEvents > 0 ? `{yellow-fg}${snapshot.denialEvents}{/yellow-fg}` : "0";
  const loops = snapshot.testLoopEvents > 0 ? `{yellow-fg}${snapshot.testLoopEvents}{/yellow-fg}` : "0";
  const compressions = snapshot.compressionEvents > 0 ? `{yellow-fg}${snapshot.compressionEvents}{/yellow-fg}` : "0";
  const pulse = tickCount % 2 === 0 ? "{green-fg}●{/green-fg}" : "{green-fg}○{/green-fg}";
  const elapsed = formatElapsed(snapshot.lastUpdatedAt);

  return [
    "{bold}{cyan-fg}Totals{/cyan-fg}{/bold}",
    `events: {blue-fg}${snapshot.totalEvents}{/blue-fg}`,
    `sessions: {blue-fg}${snapshot.totalSessions}{/blue-fg}`,
    `active: {green-fg}${snapshot.activeSessions}{/green-fg}`,
    `historic: ${snapshot.completedSessions}`,
    `attention: ${attention}`,
    "",
    "{bold}{magenta-fg}Signals{/magenta-fg}{/bold}",
    `failures: ${failures}`,
    `denials: ${denials}`,
    `clarifying: {blue-fg}${snapshot.clarificationEvents}{/blue-fg}`,
    `test loops: ${loops}`,
    `compressions: ${compressions}`,
    "",
    `${pulse} {bold}{green-fg}Updated{/green-fg}{/bold} ${snapshot.lastUpdatedAt ? compactTimestamp(snapshot.lastUpdatedAt) : "-"}{gray-fg}${elapsed}{/gray-fg}`,
    `{gray-fg}${seedNote}{/gray-fg}`,
    "",
    "{bold}{yellow-fg}Keys{/yellow-fg}{/bold}",
    "{yellow-fg}q{/yellow-fg}/{yellow-fg}esc{/yellow-fg} exit",
    "{yellow-fg}r{/yellow-fg} refresh seed",
  ].join("\n");
}

function renderAggregations(snapshot: WatchDashboardSnapshot): string {
  const lines: string[] = [];
  lines.push("{bold}{cyan-fg}Tools{/cyan-fg}{/bold}");
  for (const row of snapshot.toolSummary.slice(0, 4)) {
    lines.push(
      `{cyan-fg}${row.name.padEnd(8)}{/cyan-fg} ev=${String(row.events).padStart(3)} s=${String(row.sessions).padStart(2)} a={green-fg}${row.activeSessions}{/green-fg} !{yellow-fg}${row.attentionSessions}{/yellow-fg}`,
    );
  }

  lines.push("");
  lines.push("{bold}{magenta-fg}Projects{/magenta-fg}{/bold}");
  for (const row of snapshot.projectSummary.slice(0, 4)) {
    lines.push(
      `{magenta-fg}${truncate(row.name, 12).padEnd(12)}{/magenta-fg} ev=${String(row.events).padStart(3)} s=${String(row.sessions).padStart(2)} a={green-fg}${row.activeSessions}{/green-fg} !{yellow-fg}${row.attentionSessions}{/yellow-fg}`,
    );
  }

  if (snapshot.historicalSessionRows.length > 0) {
    lines.push("");
    lines.push("{bold}{green-fg}Last finished{/green-fg}{/bold}");
    for (const session of snapshot.historicalSessionRows.slice(0, 2)) {
      lines.push(
        `{green-fg}${session.tool.padEnd(8)}{/green-fg} ${truncate(session.project ?? "-", 12).padEnd(12)} ${formatWatchDuration(session.durationSeconds)} ${compactSessionLabel(session)}`,
      );
    }
  }

  return lines.join("\n");
}

function escapeBlessedTagText(value: string): string {
  return value.replace(/[{}]/g, (char) => (char === "{" ? "{open}" : "{close}"));
}

export function colorizeRecentEvent(line: string): string {
  const escapedLine = escapeBlessedTagText(line);

  if (
    line.includes("tool_failure") ||
    line.includes("command_failure") ||
    line.includes("session_error") ||
    line.includes("stop_failure")
  ) {
    return `{red-fg}${escapedLine}{/red-fg}`;
  }

  if (
    line.includes("permission_denied") ||
    line.includes("test_failure_loop") ||
    line.includes("context_compression")
  ) {
    return `{yellow-fg}${escapedLine}{/yellow-fg}`;
  }

  if (line.includes("session_stop")) {
    return `{cyan-fg}${escapedLine}{/cyan-fg}`;
  }

  if (line.includes("session_start")) {
    return `{green-fg}${escapedLine}{/green-fg}`;
  }

  return `{white-fg}${escapedLine}{/white-fg}`;
}

function renderRecentEvents(lines: string[], terminalWidth: number): string {
  const contentWidth = Math.max(terminalWidth - 2, 24);
  return lines.map((line) => colorizeRecentEvent(truncatePlain(line, contentWidth))).join("\n");
}

function donutData(snapshot: WatchDashboardSnapshot): Array<{
  percent: number;
  label: string;
  color: string;
  percentAltNumber?: number;
}> {
  const total = snapshot.totalSessions;
  if (total === 0) {
    return [{ percent: 100, percentAltNumber: 0, label: "idle", color: "gray" }];
  }

  return [
    {
      label: "active",
      percent: Math.round((snapshot.statusBreakdown.active / total) * 100),
      percentAltNumber: snapshot.statusBreakdown.active,
      color: "green",
    },
    {
      label: "attention",
      percent: Math.round((snapshot.statusBreakdown.attention / total) * 100),
      percentAltNumber: snapshot.statusBreakdown.attention,
      color: "yellow",
    },
    {
      label: "done",
      percent: Math.round((snapshot.statusBreakdown.completed / total) * 100),
      percentAltNumber: snapshot.statusBreakdown.completed,
      color: "cyan",
    },
  ];
}

function appendWidgets(screen: Blessed.Widgets.Screen, widgets: BlessedNode[]): void {
  for (const widget of widgets) {
    screen.append(widget);
  }
}

export async function runWatchTui(
  paths: AgentSmithPaths = resolvePaths(),
  options: Pick<WatchOptions, "tool" | "project" | "tail" | "pollMs" | "signal"> = {},
): Promise<number> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("watch --view tui requires an interactive terminal");
  }

  const blessedModule = requireTuiModule<BlessedRuntimeModule>("blessed");
  const contribModule = requireTuiModule<Record<string, unknown>>("blessed-contrib");
  const blessed = blessedModule.default ?? blessedModule;
  const contrib = (contribModule.default ?? contribModule) as BlessedContribModule;

  const screen = blessed.screen({
    smartCSR: true,
    dockBorders: true,
    fullUnicode: true,
    autoPadding: true,
    title: "Agent Smith Watch",
  });

  const activeTable = contrib.table({
    top: 0,
    left: 0,
    width: "68%",
    height: "34%",
    label: " Active Sessions ",
    keys: true,
    interactive: false,
    border: { type: "line", fg: "cyan" },
    columnSpacing: 2,
    columnWidth: [8, 14, 10, 12, 8, 30],
    style: {
      border: { fg: "cyan" },
      header: { fg: "black", bg: "cyan", bold: true },
      cell: { fg: "white" },
    },
  });

  const historyTable = contrib.table({
    top: "34%",
    left: 0,
    width: "68%",
    height: "44%",
    label: " History ",
    keys: true,
    interactive: false,
    border: { type: "line", fg: "magenta" },
    columnSpacing: 2,
    columnWidth: [8, 14, 10, 12, 8, 30],
    style: {
      border: { fg: "magenta" },
      header: { fg: "black", bg: "magenta", bold: true },
      cell: { fg: "white" },
    },
  });

  const statsBox = blessed.box({
    top: 0,
    left: "68%",
    width: "32%",
    height: "20%",
    label: " Stats ",
    tags: true,
    padding: { left: 1, right: 1 },
    border: { type: "line" },
    style: {
      border: { fg: "green" },
      fg: "white",
    },
  });

  const statusDonut = contrib.donut({
    top: "20%",
    left: "68%",
    width: "32%",
    height: "20%",
    label: " Session Mix ",
    radius: 7,
    arcWidth: 3,
    remainColor: "black",
    yPadding: 1,
    border: { type: "line", fg: "yellow" },
    style: {
      border: { fg: "yellow" },
      fg: "white",
    },
  });

  const activitySparkline = contrib.sparkline({
    top: "40%",
    left: "68%",
    width: "32%",
    height: "12%",
    label: " Event Rate (15m) ",
    tags: true,
    border: { type: "line", fg: "cyan" },
    style: {
      fg: "cyan",
      border: { fg: "cyan" },
    },
  });

  const aggregationBox = blessed.box({
    top: "52%",
    left: "68%",
    width: "32%",
    height: "26%",
    label: " Aggregations ",
    tags: true,
    padding: { left: 1, right: 1 },
    border: { type: "line" },
    style: {
      border: { fg: "blue" },
      fg: "white",
    },
  });

  const feedBox = blessed.box({
    top: "78%",
    left: 0,
    width: "100%",
    height: "22%",
    label: " Recent Events ",
    tags: true,
    padding: { left: 0, right: 0 },
    border: { type: "line" },
    style: {
      border: { fg: "green" },
      fg: "white",
    },
  });

  appendWidgets(screen, [
    activeTable as unknown as BlessedNode,
    historyTable as unknown as BlessedNode,
    statsBox,
    statusDonut as unknown as BlessedNode,
    activitySparkline as unknown as BlessedNode,
    aggregationBox,
    feedBox,
  ]);

  let { state, nextOffset } = buildWatchDashboardSeed(paths, options);
  const seedNote = options.tail && options.tail > 0 ? `seed: last ${options.tail} events` : "seed: full history";
  let closed = false;
  let tickCount = 0;
  const controller = new AbortController();
  const externalAbort = () => {
    close();
  };

  const render = () => {
    const snapshot = snapshotWatchDashboard(state, {
      activeLimit: 8,
      historyLimit: 10,
      groupLimit: 6,
    });

    activeTable.setData({
      headers: ["tool", "project", "session", "status", "time", "detail"],
      data: tableRowsForSessions(snapshot.activeSessionRows),
    });
    historyTable.setData({
      headers: ["tool", "project", "session", "status", "time", "detail"],
      data: tableRowsForSessions(snapshot.historicalSessionRows),
    });
    statsBox.setContent(renderStats(snapshot, seedNote, tickCount));
    statusDonut.setData(donutData(snapshot));
    activitySparkline.setData(["events/min"], [snapshot.eventRateBuckets]);
    aggregationBox.setContent(renderAggregations(snapshot));
    feedBox.setContent(renderRecentEvents(snapshot.recentEvents, screen.cols));
    screen.render();
  };

  const tickInterval = setInterval(() => {
    tickCount += 1;
    if (!closed) {
      render();
    }
  }, 2000);

  const close = () => {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(tickInterval);
    controller.abort();
    screen.destroy();
  };

  if (options.signal) {
    if (options.signal.aborted) {
      close();
    } else {
      options.signal.addEventListener("abort", externalAbort, { once: true });
    }
  }

  screen.key(["q", "escape", "C-c"], () => {
    close();
  });

  screen.key(["r"], () => {
    state = buildWatchDashboardState(paths, options);
    render();
  });

  screen.on("resize", render);

  render();

  const watchTask = (async () => {
    for await (const event of watchEvents(paths, {
      tool: options.tool,
      project: options.project,
      pollMs: options.pollMs,
      signal: controller.signal,
      startOffset: nextOffset,
    })) {
      applyEventToWatchDashboardState(state, event);
      render();
    }
  })().catch((error: unknown) => {
    if (!closed) {
      statsBox.setContent(`{bold}Watch error{/bold}\n${String(error)}`);
      screen.render();
    }
  });

  await new Promise<void>((resolve) => {
    screen.once("destroy", () => resolve());
  });

  options.signal?.removeEventListener("abort", externalAbort);
  await watchTask;
  return 0;
}
