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

export interface AgentSmithReport {
  metricsDir: string;
  totalEvents: number;
  totalSessions: number;
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
} {
  const clauses: string[] = [];
  const params: string[] = [];

  if (filters.tool) {
    clauses.push("tool = ?");
    params.push(filters.tool);
  }

  if (filters.project) {
    clauses.push("project = ?");
    params.push(filters.project);
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
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
      (
        db.query(`SELECT COUNT(DISTINCT session_id) AS count FROM events ${where}`).get(...params) as {
          count: number;
        } | null
      )?.count ?? 0;

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
