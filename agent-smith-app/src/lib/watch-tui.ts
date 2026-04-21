import process from "node:process";

import { resolvePaths, type AgentSmithPaths } from "./paths";
import {
  applyEventToWatchDashboardState,
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
  donut: (options: Record<string, unknown>) => DonutWidget;
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

function renderStats(snapshot: WatchDashboardSnapshot, seedNote: string): string {
  return [
    "{bold}Totals{/bold}",
    `events: ${snapshot.totalEvents}`,
    `sessions: ${snapshot.totalSessions}`,
    `active: ${snapshot.activeSessions}`,
    `historic: ${snapshot.completedSessions}`,
    `attention: ${snapshot.attentionSessions}`,
    "",
    "{bold}Signals{/bold}",
    `failures: ${snapshot.failureEvents}`,
    `denials: ${snapshot.denialEvents}`,
    `clarifying: ${snapshot.clarificationEvents}`,
    `test loops: ${snapshot.testLoopEvents}`,
    `compressions: ${snapshot.compressionEvents}`,
    "",
    `{bold}Updated{/bold} ${snapshot.lastUpdatedAt ? compactTimestamp(snapshot.lastUpdatedAt) : "-"}`,
    seedNote,
    "",
    "{bold}Keys{/bold}",
    "q/esc exit",
    "r refresh seed",
  ].join("\n");
}

function renderAggregations(snapshot: WatchDashboardSnapshot): string {
  const lines: string[] = [];
  lines.push("{bold}Tools{/bold}");
  for (const row of snapshot.toolSummary.slice(0, 4)) {
    lines.push(
      `${row.name.padEnd(8)} ev=${String(row.events).padStart(3)} s=${String(row.sessions).padStart(2)} a=${row.activeSessions} !${row.attentionSessions}`,
    );
  }

  lines.push("");
  lines.push("{bold}Projects{/bold}");
  for (const row of snapshot.projectSummary.slice(0, 4)) {
    lines.push(
      `${truncate(row.name, 12).padEnd(12)} ev=${String(row.events).padStart(3)} s=${String(row.sessions).padStart(2)} a=${row.activeSessions} !${row.attentionSessions}`,
    );
  }

  if (snapshot.historicalSessionRows.length > 0) {
    lines.push("");
    lines.push("{bold}Last finished{/bold}");
    for (const session of snapshot.historicalSessionRows.slice(0, 2)) {
      lines.push(
        `${session.tool.padEnd(8)} ${truncate(session.project ?? "-", 12).padEnd(12)} ${formatWatchDuration(session.durationSeconds)} ${compactSessionLabel(session)}`,
      );
    }
  }

  return lines.join("\n");
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

export async function runWatchTui(
  paths: AgentSmithPaths = resolvePaths(),
  options: Pick<WatchOptions, "tool" | "project" | "tail" | "pollMs"> = {},
): Promise<number> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("watch --view tui requires an interactive terminal");
  }

  const blessedModule = await import("blessed");
  const contribModule = await import("blessed-contrib");
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
    parent: screen,
    top: 0,
    left: 0,
    width: "68%",
    height: "40%",
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
    parent: screen,
    top: "40%",
    left: 0,
    width: "68%",
    height: "45%",
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
    parent: screen,
    top: 0,
    left: "68%",
    width: "32%",
    height: "25%",
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
    parent: screen,
    top: "25%",
    left: "68%",
    width: "32%",
    height: "25%",
    label: " Session Mix ",
    radius: 9,
    arcWidth: 3,
    remainColor: "black",
    yPadding: 1,
    border: { type: "line", fg: "yellow" },
    style: {
      border: { fg: "yellow" },
      fg: "white",
    },
  });

  const aggregationBox = blessed.box({
    parent: screen,
    top: "50%",
    left: "68%",
    width: "32%",
    height: "35%",
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
    parent: screen,
    top: "85%",
    left: 0,
    width: "100%",
    height: "15%",
    label: " Recent Events ",
    tags: false,
    padding: { left: 1, right: 1 },
    border: { type: "line" },
    style: {
      border: { fg: "white" },
      fg: "white",
    },
  });

  let state = buildWatchDashboardState(paths, options);
  const seedNote = options.tail && options.tail > 0 ? `seed: last ${options.tail} events` : "seed: full history";
  let closed = false;
  const controller = new AbortController();

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
    statsBox.setContent(renderStats(snapshot, seedNote));
    aggregationBox.setContent(renderAggregations(snapshot));
    statusDonut.setData(donutData(snapshot));
    feedBox.setContent(snapshot.recentEvents.join("\n"));
    screen.render();
  };

  const close = () => {
    if (closed) {
      return;
    }

    closed = true;
    controller.abort();
    screen.destroy();
  };

  screen.key(["q", "escape", "C-c"], () => {
    close();
  });

  screen.key(["r"], () => {
    state = buildWatchDashboardState(paths, options);
    render();
  });

  render();

  const watchTask = (async () => {
    for await (const event of watchEvents(paths, {
      tool: options.tool,
      project: options.project,
      pollMs: options.pollMs,
      signal: controller.signal,
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

  await watchTask;
  return 0;
}
