import { Database } from "bun:sqlite";

import { resolvePaths, type AgentSmithPaths } from "./paths";
import { rollupEvents } from "./rollup";

export interface ReportFilters {
  tool?: string;
  project?: string;
  limit?: number;
}

export interface ToolSummary {
  tool: string;
  events: number;
  sessions: number;
}

export interface EventTypeSummary {
  eventType: string;
  count: number;
  sessions: number;
}

export interface ProjectSummary {
  project: string;
  events: number;
  sessions: number;
}

export interface FailureSummary {
  ts: string;
  tool: string;
  sessionId: string;
  eventType: string;
  project: string | null;
  snippet: string | null;
}

export interface SignalSummary {
  sessions: number;
  events: number;
}

export interface HealthSummary {
  activeSessions: number;
  attentionSessions: number;
  failures: SignalSummary;
  permissionDenials: SignalSummary;
  clarifications: SignalSummary;
  testFailureLoops: SignalSummary;
  contextCompressions: SignalSummary;
}

export interface SessionSummary {
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
  lastSnippet: string | null;
}

export interface StopReasonSummary {
  stopReason: string;
  sessions: number;
}

export interface FailureHotspot {
  snippet: string;
  count: number;
  sessions: number;
}

export interface AgentSmithReport {
  metricsDir: string;
  totalEvents: number;
  totalSessions: number;
  health: HealthSummary;
  activeSessions: SessionSummary[];
  attentionSessions: SessionSummary[];
  recentSessions: SessionSummary[];
  stopReasons: StopReasonSummary[];
  failureHotspots: FailureHotspot[];
  tools: ToolSummary[];
  eventTypes: EventTypeSummary[];
  projects: ProjectSummary[];
  recentFailures: FailureSummary[];
}

function openDatabase(paths: AgentSmithPaths): Database {
  return new Database(paths.dbFile, { create: true, readonly: true });
}

function buildWhere(filters: ReportFilters): {
  where: string;
  params: string[];
};
function buildWhere(filters: ReportFilters, fieldPrefix: string): {
  where: string;
  params: string[];
};
function buildWhere(filters: ReportFilters, fieldPrefix = ""): {
  where: string;
  params: string[];
} {
  const clauses: string[] = [];
  const params: string[] = [];

  if (filters.tool) {
    clauses.push(`${fieldPrefix}tool = ?`);
    params.push(filters.tool);
  }

  if (filters.project) {
    clauses.push(`${fieldPrefix}project = ?`);
    params.push(filters.project);
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function finalWhere(where: string, extraClauses: string[] = []): string {
  const clauses = [where ? where.replace(/^WHERE /, "") : "", ...extraClauses].filter(Boolean);
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

function classifySessionStatus(session: Omit<SessionSummary, "status">): SessionSummary["status"] {
  const attention =
    session.failureCount > 0 || session.denialCount > 0 || session.testLoopCount > 0 || session.compressionCount > 0;
  if (!session.endedAt) {
    return attention ? "active-attention" : "active";
  }
  return attention ? "attention" : "completed";
}

function querySessionRows(
  db: Database,
  filters: ReportFilters,
  extraClauses: string[],
  orderBy: string,
  limit: number,
): SessionSummary[] {
  const { where, params } = buildWhere(filters, "s.");
  const rows = db
    .query(
      `
        SELECT
          s.session_id AS sessionId,
          s.tool,
          s.project,
          s.started_at AS startedAt,
          s.ended_at AS endedAt,
          s.duration_seconds AS durationSeconds,
          s.stop_reason AS stopReason,
          s.event_count AS eventCount,
          s.failure_count AS failureCount,
          s.denial_count AS denialCount,
          s.clarification_count AS clarificationCount,
          s.test_loop_count AS testLoopCount,
          s.compression_count AS compressionCount,
          COALESCE(
            (
              SELECT e.snippet
              FROM events e
              WHERE e.session_id = s.session_id
                AND e.snippet IS NOT NULL
                AND e.event_type <> 'session_stop'
              ORDER BY e.ts DESC, e.id DESC
              LIMIT 1
            ),
            (
              SELECT e.snippet
              FROM events e
              WHERE e.session_id = s.session_id
                AND e.snippet IS NOT NULL
              ORDER BY e.ts DESC, e.id DESC
              LIMIT 1
            )
          ) AS lastSnippet
        FROM sessions s
        ${finalWhere(where, extraClauses)}
        ORDER BY ${orderBy}
        LIMIT ?
      `,
    )
    .all(...params, limit) as Array<Omit<SessionSummary, "status">>;

  return rows.map((row) => ({
    ...row,
    status: classifySessionStatus(row),
  }));
}

function compactTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return "-";
  }

  return timestamp.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "-";
  }

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
  }

  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder === 0 ? `${hours}h` : `${hours}h${minuteRemainder}m`;
}

function truncateSnippet(snippet: string | null, limit = 72): string | null {
  if (!snippet) {
    return null;
  }

  return snippet.length <= limit ? snippet : `${snippet.slice(0, limit - 1)}…`;
}

function renderSessionSummary(session: SessionSummary): string {
  const parts = [
    session.status.padEnd(16),
    session.tool.padEnd(8),
    (session.project ?? "-").padEnd(18),
    session.sessionId.slice(0, 8),
  ];

  if (session.endedAt) {
    parts.push(`ended=${compactTimestamp(session.endedAt)}`);
  } else if (session.startedAt) {
    parts.push(`started=${compactTimestamp(session.startedAt)}`);
  }

  if (session.stopReason) {
    parts.push(`reason=${session.stopReason}`);
  }

  if (session.durationSeconds !== null) {
    parts.push(`duration=${formatDuration(session.durationSeconds)}`);
  }

  parts.push(`events=${session.eventCount}`);

  if (session.failureCount > 0) {
    parts.push(`fail=${session.failureCount}`);
  }
  if (session.denialCount > 0) {
    parts.push(`deny=${session.denialCount}`);
  }
  if (session.clarificationCount > 0) {
    parts.push(`ask=${session.clarificationCount}`);
  }
  if (session.testLoopCount > 0) {
    parts.push(`loop=${session.testLoopCount}`);
  }
  if (session.compressionCount > 0) {
    parts.push(`compress=${session.compressionCount}`);
  }

  const snippet = truncateSnippet(session.lastSnippet);
  if (snippet) {
    parts.push(`last=${snippet}`);
  }

  return `  ${parts.join(" ")}`;
}

export function generateReport(paths = resolvePaths(), filters: ReportFilters = {}): AgentSmithReport {
  rollupEvents(paths);

  const db = openDatabase(paths);
  try {
    const { where, params } = buildWhere(filters);
    const limit = filters.limit ?? 5;

    const totalEvents =
      (db.query(`SELECT COUNT(*) AS count FROM events ${where}`).get(...params) as { count: number } | null)?.count ??
      0;

    const totalSessions =
      (db.query(`SELECT COUNT(*) AS count FROM sessions ${where}`).get(...params) as { count: number } | null)?.count ??
      0;

    const health =
      (
        db.query(
          `
            SELECT
              COALESCE(SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END), 0) AS activeSessions,
              COALESCE(
                SUM(
                  CASE
                    WHEN failure_count > 0 OR denial_count > 0 OR test_loop_count > 0 OR compression_count > 0
                    THEN 1
                    ELSE 0
                  END
                ),
                0
              ) AS attentionSessions,
              COALESCE(SUM(CASE WHEN failure_count > 0 THEN 1 ELSE 0 END), 0) AS failureSessions,
              COALESCE(SUM(failure_count), 0) AS failureEvents,
              COALESCE(SUM(CASE WHEN denial_count > 0 THEN 1 ELSE 0 END), 0) AS denialSessions,
              COALESCE(SUM(denial_count), 0) AS denialEvents,
              COALESCE(SUM(CASE WHEN clarification_count > 0 THEN 1 ELSE 0 END), 0) AS clarificationSessions,
              COALESCE(SUM(clarification_count), 0) AS clarificationEvents,
              COALESCE(SUM(CASE WHEN test_loop_count > 0 THEN 1 ELSE 0 END), 0) AS testLoopSessions,
              COALESCE(SUM(test_loop_count), 0) AS testLoopEvents,
              COALESCE(SUM(CASE WHEN compression_count > 0 THEN 1 ELSE 0 END), 0) AS compressionSessions,
              COALESCE(SUM(compression_count), 0) AS compressionEvents
            FROM sessions
            ${where}
          `,
        ).get(...params) as
        | {
            activeSessions: number;
            attentionSessions: number;
            failureSessions: number;
            failureEvents: number;
            denialSessions: number;
            denialEvents: number;
            clarificationSessions: number;
            clarificationEvents: number;
            testLoopSessions: number;
            testLoopEvents: number;
            compressionSessions: number;
            compressionEvents: number;
          }
        | null
      ) ?? {
        activeSessions: 0,
        attentionSessions: 0,
        failureSessions: 0,
        failureEvents: 0,
        denialSessions: 0,
        denialEvents: 0,
        clarificationSessions: 0,
        clarificationEvents: 0,
        testLoopSessions: 0,
        testLoopEvents: 0,
        compressionSessions: 0,
        compressionEvents: 0,
      };

    const activeSessions = querySessionRows(
      db,
      filters,
      ["s.ended_at IS NULL"],
      "COALESCE(s.started_at, '') ASC, s.session_id ASC",
      limit,
    );

    const attentionSessions = querySessionRows(
      db,
      filters,
      ["(s.failure_count > 0 OR s.denial_count > 0 OR s.test_loop_count > 0 OR s.compression_count > 0)"],
      [
        "CASE WHEN s.ended_at IS NULL THEN 0 ELSE 1 END ASC",
        "(s.failure_count + s.denial_count + s.test_loop_count + s.compression_count) DESC",
        "COALESCE(s.ended_at, s.started_at, '') DESC",
        "s.session_id ASC",
      ].join(", "),
      limit,
    );

    const recentSessions = querySessionRows(
      db,
      filters,
      [],
      "COALESCE(s.ended_at, s.started_at, '') DESC, s.session_id ASC",
      limit,
    );

    const stopReasons = db
      .query(`
        SELECT stop_reason AS stopReason, COUNT(*) AS sessions
        FROM sessions
        ${finalWhere(where, ["stop_reason IS NOT NULL"])}
        GROUP BY stop_reason
        ORDER BY sessions DESC, stop_reason ASC
        LIMIT ?
      `)
      .all(...params, limit) as StopReasonSummary[];

    const failureHotspots = db
      .query(`
        SELECT
          COALESCE(snippet, event_type) AS snippet,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions
        FROM events
        ${finalWhere(where, ["event_type IN ('tool_failure', 'command_failure', 'session_error', 'stop_failure')"])}
        GROUP BY COALESCE(snippet, event_type)
        ORDER BY count DESC, snippet ASC
        LIMIT ?
      `)
      .all(...params, limit) as FailureHotspot[];

    const tools = db
      .query(`
        SELECT tool, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
        FROM events
        ${where}
        GROUP BY tool
        ORDER BY events DESC, tool ASC
      `)
      .all(...params) as ToolSummary[];

    const eventTypes = db
      .query(`
        SELECT event_type AS eventType, COUNT(*) AS count, COUNT(DISTINCT session_id) AS sessions
        FROM events
        ${where}
        GROUP BY event_type
        ORDER BY count DESC, event_type ASC
        LIMIT ?
      `)
      .all(...params, limit) as EventTypeSummary[];

    const projectWhere = [where, where ? "AND project IS NOT NULL" : "WHERE project IS NOT NULL"]
      .filter(Boolean)
      .join(" ");

    const projects = db
      .query(`
        SELECT project, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
        FROM events
        ${projectWhere}
        GROUP BY project
        ORDER BY events DESC, project ASC
        LIMIT ?
      `)
      .all(...params, limit) as ProjectSummary[];

    const failureWhereClauses = [
      where ? where.replace(/^WHERE /, "") : "",
      "event_type IN ('tool_failure', 'command_failure', 'session_error', 'stop_failure')",
    ].filter(Boolean);

    const failureWhere = failureWhereClauses.length > 0 ? `WHERE ${failureWhereClauses.join(" AND ")}` : "";

    const recentFailures = db
      .query(`
        SELECT
          ts,
          tool,
          session_id AS sessionId,
          event_type AS eventType,
          project,
          snippet
        FROM events
        ${failureWhere}
        ORDER BY ts DESC
        LIMIT ?
      `)
      .all(...params, limit) as FailureSummary[];

    return {
      metricsDir: paths.metricsDir,
      totalEvents,
      totalSessions,
      health: {
        activeSessions: health.activeSessions,
        attentionSessions: health.attentionSessions,
        failures: {
          sessions: health.failureSessions,
          events: health.failureEvents,
        },
        permissionDenials: {
          sessions: health.denialSessions,
          events: health.denialEvents,
        },
        clarifications: {
          sessions: health.clarificationSessions,
          events: health.clarificationEvents,
        },
        testFailureLoops: {
          sessions: health.testLoopSessions,
          events: health.testLoopEvents,
        },
        contextCompressions: {
          sessions: health.compressionSessions,
          events: health.compressionEvents,
        },
      },
      activeSessions,
      attentionSessions,
      recentSessions,
      stopReasons,
      failureHotspots,
      tools,
      eventTypes,
      projects,
      recentFailures,
    };
  } finally {
    db.close();
  }
}

export function renderTextReport(report: AgentSmithReport): string {
  const lines: string[] = [];
  lines.push("Agent Smith Report");
  lines.push(`Metrics dir: ${report.metricsDir}`);
  lines.push(`Events: ${report.totalEvents}`);
  lines.push(`Sessions: ${report.totalSessions}`);
  lines.push(`Active sessions: ${report.health.activeSessions}`);
  lines.push(`Sessions needing attention: ${report.health.attentionSessions}`);

  lines.push("");
  lines.push("Health:");
  lines.push(`  failures: ${report.health.failures.sessions} sessions / ${report.health.failures.events} events`);
  lines.push(
    `  permission denials: ${report.health.permissionDenials.sessions} sessions / ${report.health.permissionDenials.events} events`,
  );
  lines.push(
    `  clarifying questions: ${report.health.clarifications.sessions} sessions / ${report.health.clarifications.events} events`,
  );
  lines.push(
    `  test failure loops: ${report.health.testFailureLoops.sessions} sessions / ${report.health.testFailureLoops.events} events`,
  );
  lines.push(
    `  context compressions: ${report.health.contextCompressions.sessions} sessions / ${report.health.contextCompressions.events} events`,
  );

  if (report.activeSessions.length > 0) {
    lines.push("");
    lines.push("Active sessions:");
    for (const row of report.activeSessions) {
      lines.push(renderSessionSummary(row));
    }
  }

  if (report.attentionSessions.length > 0) {
    lines.push("");
    lines.push("Needs attention:");
    for (const row of report.attentionSessions) {
      lines.push(renderSessionSummary(row));
    }
  }

  if (report.recentSessions.length > 0) {
    lines.push("");
    lines.push("Recent sessions:");
    for (const row of report.recentSessions) {
      lines.push(renderSessionSummary(row));
    }
  }

  if (report.stopReasons.length > 0) {
    lines.push("");
    lines.push("Stop reasons:");
    for (const row of report.stopReasons) {
      lines.push(`  ${row.stopReason}: ${row.sessions} sessions`);
    }
  }

  if (report.failureHotspots.length > 0) {
    lines.push("");
    lines.push("Failure hotspots:");
    for (const row of report.failureHotspots) {
      lines.push(`  ${row.snippet}: ${row.count} failures / ${row.sessions} sessions`);
    }
  }

  if (report.tools.length > 0) {
    lines.push("");
    lines.push("By tool:");
    for (const row of report.tools) {
      lines.push(`  ${row.tool}: ${row.events} events / ${row.sessions} sessions`);
    }
  }

  if (report.eventTypes.length > 0) {
    lines.push("");
    lines.push("Top event types:");
    for (const row of report.eventTypes) {
      lines.push(`  ${row.eventType}: ${row.count} events / ${row.sessions} sessions`);
    }
  }

  if (report.projects.length > 0) {
    lines.push("");
    lines.push("Projects:");
    for (const row of report.projects) {
      lines.push(`  ${row.project}: ${row.events} events / ${row.sessions} sessions`);
    }
  }

  if (report.recentFailures.length > 0) {
    lines.push("");
    lines.push("Recent failures:");
    for (const row of report.recentFailures) {
      const suffix = row.snippet ? ` - ${row.snippet}` : "";
      const project = row.project ? ` ${row.project}` : "";
      lines.push(`  ${row.ts} ${row.tool}${project} ${row.eventType}${suffix}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
