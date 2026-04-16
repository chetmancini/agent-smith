import { Database } from "bun:sqlite";

import { AgentSmithEvent, eventSnippet, projectFromEvent } from "./events";
import { resolvePaths, AgentSmithPaths, ensureMetricsLayout, hardenPrivateFile } from "./paths";
import { readEventsSince } from "./store";

export interface RollupResult {
  ingestedEvents: number;
  skippedLines: number;
  nextOffset: number;
}

const failureEvents = new Set(["tool_failure", "command_failure", "session_error", "stop_failure"]);

function openDatabase(paths: AgentSmithPaths): Database {
  ensureMetricsLayout(paths);
  const db = new Database(paths.dbFile, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      tool TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      metadata TEXT NOT NULL,
      cwd TEXT,
      project TEXT,
      snippet TEXT,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool);
    CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project);
    CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      started_at TEXT,
      stopped_at TEXT,
      ended_at TEXT,
      duration_seconds INTEGER,
      stop_reason TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      clarification_count INTEGER NOT NULL DEFAULT 0,
      test_loop_count INTEGER NOT NULL DEFAULT 0,
      denial_count INTEGER NOT NULL DEFAULT 0,
      compression_count INTEGER NOT NULL DEFAULT 0,
      cwd TEXT,
      project TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_tool ON sessions(tool);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

    CREATE TABLE IF NOT EXISTS daily_rollup (
      date TEXT NOT NULL,
      tool TEXT NOT NULL,
      event_type TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      session_count INTEGER NOT NULL DEFAULT 0,
      sample_metadata TEXT,
      PRIMARY KEY(date, tool, event_type)
    );

    CREATE TABLE IF NOT EXISTS ingestion_state (
      file_path TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      last_ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

function getCurrentOffset(db: Database, eventsFile: string): number {
  const row = db
    .query("SELECT byte_offset FROM ingestion_state WHERE file_path = ?")
    .get(eventsFile) as { byte_offset: number } | null;

  return row?.byte_offset ?? 0;
}

function upsertDailyRollup(db: Database): void {
  db.exec(`
    UPDATE daily_rollup
    SET session_count = COALESCE((
      SELECT COUNT(DISTINCT events.session_id)
      FROM events
      WHERE substr(events.ts, 1, 10) = daily_rollup.date
        AND events.tool = daily_rollup.tool
        AND events.event_type = daily_rollup.event_type
    ), 0);
  `);
}

export function rollupEvents(paths = resolvePaths()): RollupResult {
  const db = openDatabase(paths);
  try {
    const offset = getCurrentOffset(db, paths.eventsFile);
    const chunk = readEventsSince(paths.eventsFile, offset);

    if (chunk.events.length === 0 && chunk.skippedLines === 0) {
      return { ingestedEvents: 0, skippedLines: 0, nextOffset: chunk.nextOffset };
    }

    const insertEvent = db.query(`
      INSERT INTO events (ts, tool, session_id, event_type, metadata, cwd, project, snippet)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertDaily = db.query(`
      INSERT INTO daily_rollup (date, tool, event_type, count, session_count, sample_metadata)
      VALUES (?, ?, ?, 1, 1, ?)
      ON CONFLICT(date, tool, event_type) DO UPDATE SET
        count = daily_rollup.count + 1,
        sample_metadata = excluded.sample_metadata
    `);

    const upsertSession = db.query(`
      INSERT INTO sessions (
        session_id,
        tool,
        started_at,
        stopped_at,
        ended_at,
        duration_seconds,
        stop_reason,
        event_count,
        failure_count,
        clarification_count,
        test_loop_count,
        denial_count,
        compression_count,
        cwd,
        project
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        tool = excluded.tool,
        started_at = COALESCE(sessions.started_at, excluded.started_at),
        stopped_at = COALESCE(excluded.stopped_at, sessions.stopped_at),
        ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
        duration_seconds = COALESCE(excluded.duration_seconds, sessions.duration_seconds),
        stop_reason = COALESCE(excluded.stop_reason, sessions.stop_reason),
        event_count = sessions.event_count + 1,
        failure_count = sessions.failure_count + excluded.failure_count,
        clarification_count = sessions.clarification_count + excluded.clarification_count,
        test_loop_count = sessions.test_loop_count + excluded.test_loop_count,
        denial_count = sessions.denial_count + excluded.denial_count,
        compression_count = sessions.compression_count + excluded.compression_count,
        cwd = COALESCE(sessions.cwd, excluded.cwd),
        project = COALESCE(sessions.project, excluded.project)
    `);

    const updateOffset = db.query(`
      INSERT INTO ingestion_state (file_path, byte_offset)
      VALUES (?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        byte_offset = excluded.byte_offset,
        last_ingested_at = datetime('now')
    `);

    const transaction = db.transaction((events: AgentSmithEvent[]) => {
      for (const event of events) {
        const metadataJson = JSON.stringify(event.metadata);
        const cwd = typeof event.metadata.cwd === "string" ? event.metadata.cwd : null;
        const project = projectFromEvent(event);
        const snippet = eventSnippet(event);

        insertEvent.run(
          event.ts,
          event.tool,
          event.session_id,
          event.event_type,
          metadataJson,
          cwd,
          project,
          snippet.length > 0 ? snippet : null,
        );

        insertDaily.run(event.ts.slice(0, 10), event.tool, event.event_type, metadataJson);

        const isSessionStop = event.event_type === "session_stop";
        upsertSession.run(
          event.session_id,
          event.tool,
          event.event_type === "session_start" ? event.ts : null,
          isSessionStop ? event.ts : null,
          isSessionStop ? event.ts : null,
          isSessionStop && typeof event.metadata.duration_seconds === "number"
            ? event.metadata.duration_seconds
            : null,
          isSessionStop && typeof event.metadata.stop_reason === "string"
            ? event.metadata.stop_reason
            : null,
          failureEvents.has(event.event_type) ? 1 : 0,
          event.event_type === "clarifying_question" ? 1 : 0,
          event.event_type === "test_failure_loop" ? 1 : 0,
          event.event_type === "permission_denied" ? 1 : 0,
          event.event_type === "context_compression" ? 1 : 0,
          cwd,
          project,
        );
      }

      updateOffset.run(paths.eventsFile, chunk.nextOffset);
      upsertDailyRollup(db);
    });

    transaction(chunk.events);
    hardenPrivateFile(paths.dbFile);

    return {
      ingestedEvents: chunk.events.length,
      skippedLines: chunk.skippedLines,
      nextOffset: chunk.nextOffset,
    };
  } finally {
    db.close();
  }
}
