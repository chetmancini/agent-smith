import { setTimeout as sleep } from "node:timers/promises";

import type { AgentSmithPaths } from "./paths";
import { eventSnippet, type AgentSmithEvent, projectFromEvent } from "./events";
import { resolvePaths } from "./paths";
import { currentEventFileSize, matchesEvent, readAllEvents, readEventsSince } from "./store";
import { createTerminalTheme, type TerminalTheme } from "./terminal-theme";

export interface WatchOptions {
  tool?: string;
  project?: string;
  tail?: number;
  pollMs?: number;
  signal?: AbortSignal;
  startOffset?: number;
}

const failureEventTypes = new Set(["tool_failure", "command_failure", "session_error", "stop_failure"]);

interface SessionWatchState {
  sessionId: string;
  tool: string;
  project: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  stopReason: string | null;
  active: boolean;
  eventCount: number;
  failureCount: number;
  denialCount: number;
  clarificationCount: number;
  testLoopCount: number;
  compressionCount: number;
  lastTs: string | null;
  lastEventType: string | null;
  lastSnippet: string | null;
}

export interface WatchSessionSummary {
  sessionId: string;
  tool: string;
  project: string | null;
  status: "active" | "active-attention" | "attention" | "completed";
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  stopReason: string | null;
  eventCount: number;
  failureCount: number;
  denialCount: number;
  clarificationCount: number;
  testLoopCount: number;
  compressionCount: number;
  lastTs: string | null;
  lastEventType: string | null;
  lastSnippet: string | null;
}

export interface WatchGroupSummary {
  name: string;
  events: number;
  sessions: number;
  activeSessions: number;
  attentionSessions: number;
}

export interface WatchStatusBreakdown {
  active: number;
  attention: number;
  completed: number;
}

export interface WatchDashboardSnapshot {
  totalEvents: number;
  totalSessions: number;
  activeSessions: number;
  completedSessions: number;
  attentionSessions: number;
  failureEvents: number;
  denialEvents: number;
  clarificationEvents: number;
  testLoopEvents: number;
  compressionEvents: number;
  lastUpdatedAt: string | null;
  statusBreakdown: WatchStatusBreakdown;
  activeSessionRows: WatchSessionSummary[];
  historicalSessionRows: WatchSessionSummary[];
  toolSummary: WatchGroupSummary[];
  projectSummary: WatchGroupSummary[];
  recentEvents: string[];
  eventRateBuckets: number[];
}

export interface WatchDashboardState {
  sessions: Map<string, SessionWatchState>;
  totalEvents: number;
  lastUpdatedAt: string | null;
  recentEvents: string[];
  eventTimestamps: number[];
}

export interface WatchDashboardSeed {
  state: WatchDashboardState;
  nextOffset: number;
}

export async function* watchEvents(
  paths = resolvePaths(),
  options: WatchOptions = {},
): AsyncGenerator<AgentSmithEvent> {
  let offset = options.startOffset ?? currentEventFileSize(paths.eventsFile);

  if (options.startOffset === undefined && options.tail && options.tail > 0) {
    const recent = readAllEvents(paths, {
      tool: options.tool,
      project: options.project,
      limit: options.tail,
    });
    for (const event of recent) {
      yield event;
    }
  }

  while (!options.signal?.aborted) {
    const chunk = readEventsSince(paths.eventsFile, offset);
    offset = chunk.nextOffset;

    for (const event of chunk.events) {
      if (matchesEvent(event, { tool: options.tool, project: options.project })) {
        yield event;
      }
    }

    await sleep(options.pollMs ?? 1000, undefined, {
      signal: options.signal,
    }).catch((error) => {
      if (options.signal?.aborted || error?.name === "AbortError") {
        return;
      }
      throw error;
    });
  }
}

function eventTone(eventType: string): "success" | "warning" | "danger" | "info" {
  switch (eventType) {
    case "session_start":
      return "success";
    case "permission_denied":
    case "test_failure_loop":
    case "context_compression":
      return "warning";
    case "tool_failure":
    case "command_failure":
    case "session_error":
    case "stop_failure":
      return "danger";
    default:
      return "info";
  }
}

export function formatWatchedEvent(event: AgentSmithEvent, theme: TerminalTheme = createTerminalTheme()): string {
  const project = projectFromEvent(event) ?? "-";
  const snippet = eventSnippet(event);
  const time = theme.muted(event.ts.slice(11, 19));
  const session = theme.muted(event.session_id.slice(0, 8));
  const suffix = snippet.length > 0 ? ` ${snippet}` : "";

  return `${time} ${theme.accent(event.tool.padEnd(8))} ${project.padEnd(18)} ${theme.tone(event.event_type.padEnd(20), eventTone(event.event_type))} ${session}${suffix}`;
}

function createInitialSessionState(event: AgentSmithEvent): SessionWatchState {
  return {
    sessionId: event.session_id,
    tool: event.tool,
    project: projectFromEvent(event),
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    stopReason: null,
    active: false,
    eventCount: 0,
    failureCount: 0,
    denialCount: 0,
    clarificationCount: 0,
    testLoopCount: 0,
    compressionCount: 0,
    lastTs: null,
    lastEventType: null,
    lastSnippet: null,
  };
}

function countActiveSessions(sessions: Map<string, SessionWatchState>): number {
  let active = 0;
  for (const session of sessions.values()) {
    if (session.active) {
      active += 1;
    }
  }
  return active;
}

export function formatWatchDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "-";
  }

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
}

function sessionNeedsAttention(
  session: Pick<SessionWatchState, "failureCount" | "denialCount" | "testLoopCount" | "compressionCount">,
): boolean {
  return (
    session.failureCount > 0 || session.denialCount > 0 || session.testLoopCount > 0 || session.compressionCount > 0
  );
}

function resolveSessionStatus(session: SessionWatchState): WatchSessionSummary["status"] {
  if (session.active) {
    return sessionNeedsAttention(session) ? "active-attention" : "active";
  }

  return sessionNeedsAttention(session) ? "attention" : "completed";
}

function eventDetail(event: AgentSmithEvent): string {
  const snippet = eventSnippet(event);
  return snippet.length > 0 ? snippet : event.event_type;
}

function truncate(text: string, limit = 80): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function summarizeGroups(
  sessions: SessionWatchState[],
  selectName: (session: SessionWatchState) => string,
): WatchGroupSummary[] {
  const groups = new Map<string, WatchGroupSummary>();

  for (const session of sessions) {
    const name = selectName(session);
    const summary = groups.get(name) ?? {
      name,
      events: 0,
      sessions: 0,
      activeSessions: 0,
      attentionSessions: 0,
    };

    summary.events += session.eventCount;
    summary.sessions += 1;
    if (session.active) {
      summary.activeSessions += 1;
    }
    if (sessionNeedsAttention(session)) {
      summary.attentionSessions += 1;
    }

    groups.set(name, summary);
  }

  return [...groups.values()].sort((left, right) => {
    return right.events - left.events || right.sessions - left.sessions || left.name.localeCompare(right.name);
  });
}

function formatDashboardRecentEvent(event: AgentSmithEvent, session: SessionWatchState): string {
  const snippet = eventDetail(event);
  const project = session.project ?? "-";
  const suffix = snippet.length > 0 ? ` ${truncate(snippet, 64)}` : "";
  return `${event.ts.slice(11, 19)} ${event.tool.padEnd(8)} ${project.padEnd(16)} ${event.event_type}${suffix}`;
}

export function createWatchDashboardState(): WatchDashboardState {
  return {
    sessions: new Map<string, SessionWatchState>(),
    totalEvents: 0,
    lastUpdatedAt: null,
    recentEvents: [],
    eventTimestamps: [],
  };
}

export function applyEventToWatchDashboardState(state: WatchDashboardState, event: AgentSmithEvent): void {
  const session = state.sessions.get(event.session_id) ?? createInitialSessionState(event);
  const snippet = eventSnippet(event);

  session.tool = event.tool;
  session.project = projectFromEvent(event) ?? session.project;
  session.lastTs = event.ts;
  session.lastEventType = event.event_type;
  session.eventCount += 1;

  if (event.event_type === "session_start") {
    session.startedAt ??= event.ts;
    session.active = true;
    session.endedAt = null;
    session.durationSeconds = null;
    session.stopReason = null;
  } else if (event.event_type === "session_stop") {
    session.active = false;
    session.endedAt = event.ts;
    session.durationSeconds =
      typeof event.metadata.duration_seconds === "number" ? event.metadata.duration_seconds : session.durationSeconds;
    session.stopReason =
      typeof event.metadata.stop_reason === "string" ? event.metadata.stop_reason : session.stopReason;
  } else if (!session.startedAt) {
    session.startedAt = event.ts;
  }

  if (failureEventTypes.has(event.event_type)) {
    session.failureCount += 1;
  } else if (event.event_type === "permission_denied") {
    session.denialCount += 1;
  } else if (event.event_type === "clarifying_question") {
    session.clarificationCount += 1;
  } else if (event.event_type === "test_failure_loop") {
    session.testLoopCount += 1;
  } else if (event.event_type === "context_compression") {
    session.compressionCount += 1;
  }

  if (snippet.length > 0 && (event.event_type !== "session_stop" || !session.lastSnippet)) {
    session.lastSnippet = snippet;
  }

  state.totalEvents += 1;
  state.lastUpdatedAt = event.ts;
  state.sessions.set(event.session_id, session);
  state.recentEvents.unshift(formatDashboardRecentEvent(event, session));
  state.recentEvents = state.recentEvents.slice(0, 24);

  const eventEpoch = new Date(event.ts).getTime();
  state.eventTimestamps.push(eventEpoch);
  const cutoff = Date.now() - 20 * 60 * 1000;
  state.eventTimestamps = state.eventTimestamps.filter((ts) => ts >= cutoff);
}

export function buildWatchDashboardState(
  paths: AgentSmithPaths = resolvePaths(),
  options: Pick<WatchOptions, "tool" | "project" | "tail"> = {},
): WatchDashboardState {
  return buildWatchDashboardSeed(paths, options).state;
}

export function buildWatchDashboardSeed(
  paths: AgentSmithPaths = resolvePaths(),
  options: Pick<WatchOptions, "tool" | "project" | "tail"> = {},
): WatchDashboardSeed {
  const state = createWatchDashboardState();
  const chunk = readEventsSince(paths.eventsFile, 0);
  const filtered = chunk.events.filter((event) =>
    matchesEvent(event, {
      tool: options.tool,
      project: options.project,
    }),
  );
  const events =
    options.tail && options.tail > 0 && filtered.length > options.tail ? filtered.slice(-options.tail) : filtered;

  for (const event of events) {
    applyEventToWatchDashboardState(state, event);
  }

  return {
    state,
    nextOffset: chunk.nextOffset,
  };
}

export function snapshotWatchDashboard(
  state: WatchDashboardState,
  options: { activeLimit?: number; historyLimit?: number; groupLimit?: number } = {},
): WatchDashboardSnapshot {
  const sessions = [...state.sessions.values()];
  const sessionRows: WatchSessionSummary[] = sessions.map((session) => ({
    sessionId: session.sessionId,
    tool: session.tool,
    project: session.project,
    status: resolveSessionStatus(session),
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationSeconds: session.durationSeconds,
    stopReason: session.stopReason,
    eventCount: session.eventCount,
    failureCount: session.failureCount,
    denialCount: session.denialCount,
    clarificationCount: session.clarificationCount,
    testLoopCount: session.testLoopCount,
    compressionCount: session.compressionCount,
    lastTs: session.lastTs,
    lastEventType: session.lastEventType,
    lastSnippet: session.lastSnippet,
  }));

  const byRecent = (left: WatchSessionSummary, right: WatchSessionSummary) => {
    const leftTs = left.lastTs ?? "";
    const rightTs = right.lastTs ?? "";
    return rightTs.localeCompare(leftTs) || left.sessionId.localeCompare(right.sessionId);
  };

  const activeSessionRows = sessionRows
    .filter((session) => session.status === "active" || session.status === "active-attention")
    .sort((left, right) => {
      const leftAttention = left.status === "active-attention" ? 1 : 0;
      const rightAttention = right.status === "active-attention" ? 1 : 0;
      return rightAttention - leftAttention || byRecent(left, right);
    })
    .slice(0, options.activeLimit ?? 8);

  const historicalSessionRows = sessionRows
    .filter((session) => session.status === "attention" || session.status === "completed")
    .sort(byRecent)
    .slice(0, options.historyLimit ?? 12);

  const activeSessions = sessionRows.filter(
    (session) => session.status === "active" || session.status === "active-attention",
  ).length;
  const attentionSessions = sessionRows.filter(
    (session) => session.status === "active-attention" || session.status === "attention",
  ).length;
  const completedSessions = sessionRows.length - activeSessions;

  const now = Date.now();
  const bucketCount = 15;
  const bucketDurationMs = 60_000;
  const eventRateBuckets: number[] = new Array(bucketCount).fill(0);
  for (const ts of state.eventTimestamps) {
    const bucketsAgo = Math.floor((now - ts) / bucketDurationMs);
    if (bucketsAgo >= 0 && bucketsAgo < bucketCount) {
      eventRateBuckets[bucketCount - 1 - bucketsAgo] += 1;
    }
  }

  return {
    totalEvents: state.totalEvents,
    totalSessions: sessionRows.length,
    activeSessions,
    completedSessions,
    attentionSessions,
    failureEvents: sessionRows.reduce((total, session) => total + session.failureCount, 0),
    denialEvents: sessionRows.reduce((total, session) => total + session.denialCount, 0),
    clarificationEvents: sessionRows.reduce((total, session) => total + session.clarificationCount, 0),
    testLoopEvents: sessionRows.reduce((total, session) => total + session.testLoopCount, 0),
    compressionEvents: sessionRows.reduce((total, session) => total + session.compressionCount, 0),
    lastUpdatedAt: state.lastUpdatedAt,
    statusBreakdown: {
      active: sessionRows.filter((session) => session.status === "active").length,
      attention: attentionSessions,
      completed: sessionRows.filter((session) => session.status === "completed").length,
    },
    activeSessionRows,
    historicalSessionRows,
    toolSummary: summarizeGroups(sessions, (session) => session.tool).slice(0, options.groupLimit ?? 6),
    projectSummary: summarizeGroups(sessions, (session) => session.project ?? "-").slice(0, options.groupLimit ?? 6),
    recentEvents: [...state.recentEvents],
    eventRateBuckets,
  };
}

export function createSessionWatchFormatter(
  theme: TerminalTheme = createTerminalTheme(),
): (event: AgentSmithEvent) => string {
  const state = createWatchDashboardState();

  return (event) => {
    applyEventToWatchDashboardState(state, event);
    const session = state.sessions.get(event.session_id) ?? createInitialSessionState(event);

    let level = "EVENT";
    let detail = eventDetail(event);

    switch (event.event_type) {
      case "session_start":
        level = "START";
        detail = "session opened";
        break;
      case "session_stop": {
        level = "STOP";
        const stopReason = session.stopReason ?? "unknown";
        const durationSeconds = session.durationSeconds;
        detail = [
          stopReason,
          formatWatchDuration(durationSeconds),
          `events=${session.eventCount}`,
          session.failureCount > 0 ? `fail=${session.failureCount}` : "",
          session.denialCount > 0 ? `deny=${session.denialCount}` : "",
          session.clarificationCount > 0 ? `ask=${session.clarificationCount}` : "",
          session.testLoopCount > 0 ? `loop=${session.testLoopCount}` : "",
          session.compressionCount > 0 ? `compress=${session.compressionCount}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        break;
      }
      case "tool_failure":
      case "command_failure":
      case "session_error":
      case "stop_failure":
        level = "FAIL";
        detail = `${eventDetail(event)} fail=${session.failureCount}`;
        break;
      case "permission_denied":
        level = "DENY";
        detail = `${eventDetail(event)} deny=${session.denialCount}`;
        break;
      case "clarifying_question":
        level = "ASK";
        detail = `${eventDetail(event)} ask=${session.clarificationCount}`;
        break;
      case "test_failure_loop":
        level = "LOOP";
        detail = `${eventDetail(event)} loop=${session.testLoopCount}`;
        break;
      case "context_compression":
        level = "COMPRESS";
        detail = `${eventDetail(event)} compress=${session.compressionCount}`;
        break;
      default:
        break;
    }

    const time = event.ts.slice(11, 19);
    const project = session.project ?? "-";
    const active = countActiveSessions(state.sessions);
    const tone =
      level === "FAIL"
        ? "danger"
        : level === "DENY" || level === "LOOP" || level === "COMPRESS"
          ? "warning"
          : level === "START"
            ? "success"
            : "info";

    return [
      theme.muted(time),
      theme.tone(level.padEnd(8), tone),
      theme.accent(session.tool.padEnd(8)),
      project.padEnd(18),
      theme.muted(event.session_id.slice(0, 8)),
      theme.dim(`active=${active}`),
      truncate(detail),
    ].join(" ");
  };
}
