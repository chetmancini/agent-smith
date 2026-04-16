#!/bin/bash

agent_smith_metrics_migrate_sessions_schema() {
	local db_file="$1"

	for col_def in \
		"cwd TEXT" \
		"input_tokens INTEGER DEFAULT 0" \
		"output_tokens INTEGER DEFAULT 0" \
		"cache_read_tokens INTEGER DEFAULT 0" \
		"cache_create_tokens INTEGER DEFAULT 0" \
		"estimated_cost_usd REAL DEFAULT 0.0" \
		"model TEXT" \
		"assistant_turns INTEGER DEFAULT 0" \
		"compression_count INTEGER DEFAULT 0" \
		"auto_denial_count INTEGER DEFAULT 0" \
		"ended_at TEXT" \
		"end_reason TEXT"; do
		sqlite3 "$db_file" "ALTER TABLE sessions ADD COLUMN $col_def;" 2>/dev/null || true
	done

	sqlite3 "$db_file" "CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);" 2>/dev/null || true
}

agent_smith_metrics_apply_reporting_views() {
	local db_file="$1"

	agent_smith_metrics_migrate_sessions_schema "$db_file"

	sqlite3 "$db_file" <<'SQL'
DROP VIEW IF EXISTS reporting_events;
CREATE VIEW reporting_events AS
SELECT
    id,
    ts,
    tool,
    session_id,
    event_type,
    metadata,
    json_extract(metadata, '$.cwd') AS cwd,
    json_extract(metadata, '$.project_type') AS project_type,
    json_extract(metadata, '$.transcript_hash') AS transcript_hash,
    json_extract(metadata, '$.stop_reason') AS stop_reason,
    json_extract(metadata, '$.duration_seconds') AS duration_seconds,
    json_extract(metadata, '$.prompt_snippet') AS prompt_snippet,
    json_extract(metadata, '$.is_vague') AS is_vague,
    json_extract(metadata, '$.tool_name') AS tool_name,
    json_extract(metadata, '$.error') AS error,
    json_extract(metadata, '$.command') AS command,
    json_extract(metadata, '$.exit_code') AS exit_code,
    json_extract(metadata, '$.stderr_snippet') AS stderr_snippet,
    json_extract(metadata, '$.stdout_snippet') AS stdout_snippet,
    json_extract(metadata, '$.file_path') AS file_path,
    json_extract(metadata, '$.turn_id') AS turn_id,
    json_extract(metadata, '$.tool_use_id') AS tool_use_id,
    json_extract(metadata, '$.failure_count') AS failure_count,
    json_extract(metadata, '$.test_command') AS test_command,
    json_extract(metadata, '$.trigger') AS trigger,
    json_extract(metadata, '$.transcript_lines') AS transcript_lines,
    json_extract(metadata, '$.error_type') AS error_type,
    json_extract(metadata, '$.agent_id') AS agent_id,
    json_extract(metadata, '$.agent_type') AS agent_type,
    json_extract(metadata, '$.mode') AS mode,
    json_extract(metadata, '$.sessions') AS analysis_sessions,
    COALESCE(
        json_extract(metadata, '$.stderr_snippet'),
        json_extract(metadata, '$.error'),
        ''
    ) AS stderr_or_error
FROM events;

DROP VIEW IF EXISTS reporting_sessions;
CREATE VIEW reporting_sessions AS
SELECT
    id,
    session_id,
    tool,
    started_at,
    stopped_at,
    duration_seconds,
    stop_reason,
    event_count,
    failure_count,
    test_loop_count,
    clarification_count,
    denial_count,
    auto_denial_count,
    cwd,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_create_tokens,
    estimated_cost_usd,
    model,
    assistant_turns,
    compression_count,
    ended_at,
    end_reason,
    CASE
        WHEN cwd IS NULL OR RTRIM(cwd, '/') = '' THEN NULL
        ELSE REPLACE(
            RTRIM(cwd, '/'),
            RTRIM(RTRIM(cwd, '/'), REPLACE(RTRIM(cwd, '/'), '/', '')),
            ''
        )
    END AS project
FROM sessions;
SQL
}
