import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";

import { ensureMetricsLayout, hardenPrivateFile, type AgentSmithPaths } from "./paths";
import type { ImprovementRecommendation } from "./recommendations";

export type RecommendationHistoryState =
  | "seen"
  | "partial"
  | "resolved"
  | "blocked"
  | "stalled"
  | "regressed"
  | "no_changes";

export interface RecommendationHistoryRow {
  fingerprint: string;
  recommendationId: string;
  title: string;
  priority: ImprovementRecommendation["priority"];
  category: ImprovementRecommendation["category"];
  totalAttempts: number;
  resolvedCount: number;
  blockedCount: number;
  stalledCount: number;
  regressionCount: number;
  lastState: RecommendationHistoryState;
  lastSummary: string | null;
  lastSeenAt: string;
}

export interface RecommendationHistoryMemory {
  byFingerprint: Map<string, RecommendationHistoryRow>;
  attemptedCounts: Map<string, number>;
  completedFingerprints: Set<string>;
  blockedFingerprints: Set<string>;
  historicalOutcomes: string[];
}

export interface RecordRecommendationOutcomeInput {
  paths: AgentSmithPaths;
  repoRoot: string;
  tool: string;
  runId: string;
  iterationIndex: number;
  recommendation: ImprovementRecommendation;
  state: RecommendationHistoryState;
  applySummary: string;
  evaluationSummary?: string;
  changedFiles?: string[];
}

interface RecommendationHistoryDbRow {
  fingerprint: string;
  recommendation_id: string;
  title: string;
  priority: ImprovementRecommendation["priority"];
  category: ImprovementRecommendation["category"];
  total_attempts: number;
  resolved_count: number;
  blocked_count: number;
  stalled_count: number;
  regression_count: number;
  last_state: RecommendationHistoryState;
  last_summary: string | null;
  last_seen_at: string;
}

interface ExistingHistoryRow {
  total_attempts: number;
  last_state: RecommendationHistoryState;
  last_seen_run_id: string | null;
}

function openHistoryDatabase(paths: AgentSmithPaths): Database {
  ensureMetricsLayout(paths);
  const db = new Database(paths.dbFile, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS recommendation_history (
      repo_root TEXT NOT NULL,
      tool TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      recommendation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      priority TEXT NOT NULL,
      category TEXT NOT NULL,
      target_files_json TEXT NOT NULL,
      action_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_seen_run_id TEXT,
      last_state TEXT NOT NULL DEFAULT 'seen',
      last_summary TEXT,
      total_attempts INTEGER NOT NULL DEFAULT 0,
      resolved_count INTEGER NOT NULL DEFAULT 0,
      blocked_count INTEGER NOT NULL DEFAULT 0,
      stalled_count INTEGER NOT NULL DEFAULT 0,
      regression_count INTEGER NOT NULL DEFAULT 0,
      last_attempted_at TEXT,
      last_resolved_at TEXT,
      PRIMARY KEY (repo_root, tool, fingerprint)
    );

    CREATE INDEX IF NOT EXISTS idx_recommendation_history_scope
      ON recommendation_history(repo_root, tool, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS recommendation_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_root TEXT NOT NULL,
      tool TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      run_id TEXT NOT NULL,
      iteration_index INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      state TEXT NOT NULL,
      recommendation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      apply_summary TEXT NOT NULL,
      evaluation_summary TEXT,
      changed_files_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recommendation_attempts_scope
      ON recommendation_attempts(repo_root, tool, fingerprint, recorded_at DESC);
  `);

  return db;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeTargetFile(repoRoot: string, filePath: string): string {
  const absolute = resolve(repoRoot, filePath);
  const repoRelative = relative(repoRoot, absolute);
  return repoRelative.startsWith("..") ? filePath.trim() : repoRelative || filePath.trim();
}

function recommendationShape(
  repoRoot: string,
  recommendation: ImprovementRecommendation,
): {
  recommendationId: string;
  title: string;
  priority: ImprovementRecommendation["priority"];
  category: ImprovementRecommendation["category"];
  actionCount: number;
  normalizedTargetFiles: string[];
  fingerprint: string;
} {
  const normalizedTargetFiles = [
    ...new Set(
      recommendation.actions.flatMap((action) =>
        action.targetFiles.map((filePath) => normalizeTargetFile(repoRoot, filePath)),
      ),
    ),
  ].sort();

  const actionSignature = recommendation.actions.map((action) => ({
    type: action.type,
    safeToAutoApply: action.safeToAutoApply,
    targetFiles: [...new Set(action.targetFiles.map((filePath) => normalizeTargetFile(repoRoot, filePath)))].sort(),
  }));

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        id: normalizeText(recommendation.id),
        category: recommendation.category,
        actionSignature,
      }),
    )
    .digest("hex")
    .slice(0, 16);

  return {
    recommendationId: recommendation.id,
    title: recommendation.title,
    priority: recommendation.priority,
    category: recommendation.category,
    actionCount: recommendation.actions.length,
    normalizedTargetFiles,
    fingerprint,
  };
}

function ensureHistoryRow(
  db: Database,
  input: {
    repoRoot: string;
    tool: string;
    runId: string;
    recommendation: ImprovementRecommendation;
    now: string;
  },
): { fingerprint: string; totalAttempts: number; lastState: RecommendationHistoryState } {
  const shape = recommendationShape(input.repoRoot, input.recommendation);
  const existing = db
    .query(
      `
        SELECT total_attempts, last_state, last_seen_run_id
        FROM recommendation_history
        WHERE repo_root = ? AND tool = ? AND fingerprint = ?
      `,
    )
    .get(input.repoRoot, input.tool, shape.fingerprint) as ExistingHistoryRow | null;

  if (!existing) {
    db.query(
      `
        INSERT INTO recommendation_history (
          repo_root,
          tool,
          fingerprint,
          recommendation_id,
          title,
          priority,
          category,
          target_files_json,
          action_count,
          first_seen_at,
          last_seen_at,
          last_seen_run_id,
          last_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seen')
      `,
    ).run(
      input.repoRoot,
      input.tool,
      shape.fingerprint,
      shape.recommendationId,
      shape.title,
      shape.priority,
      shape.category,
      JSON.stringify(shape.normalizedTargetFiles),
      shape.actionCount,
      input.now,
      input.now,
      input.runId,
    );

    return { fingerprint: shape.fingerprint, totalAttempts: 0, lastState: "seen" };
  }

  const nextState =
    existing.last_state === "resolved" && existing.last_seen_run_id !== input.runId ? "regressed" : existing.last_state;
  const regressionIncrement = nextState === "regressed" && existing.last_state !== "regressed" ? 1 : 0;

  db.query(
    `
      UPDATE recommendation_history
      SET recommendation_id = ?,
          title = ?,
          priority = ?,
          category = ?,
          target_files_json = ?,
          action_count = ?,
          last_seen_at = ?,
          last_seen_run_id = ?,
          last_state = ?,
          regression_count = regression_count + ?
      WHERE repo_root = ? AND tool = ? AND fingerprint = ?
    `,
  ).run(
    shape.recommendationId,
    shape.title,
    shape.priority,
    shape.category,
    JSON.stringify(shape.normalizedTargetFiles),
    shape.actionCount,
    input.now,
    input.runId,
    nextState,
    regressionIncrement,
    input.repoRoot,
    input.tool,
    shape.fingerprint,
  );

  return { fingerprint: shape.fingerprint, totalAttempts: existing.total_attempts, lastState: nextState };
}

function formatHistorySummary(row: RecommendationHistoryDbRow): string {
  const parts: string[] = [`[${row.last_state}] ${row.recommendation_id}: ${row.last_summary?.trim() || row.title}`];
  const suffix: string[] = [];
  if (row.total_attempts > 0) {
    suffix.push(`attempts=${row.total_attempts}`);
  }
  if (row.regression_count > 0) {
    suffix.push(`regressions=${row.regression_count}`);
  }
  if (suffix.length > 0) {
    parts.push(`(${suffix.join(", ")})`);
  }
  return parts.join(" ");
}

export function createLoopRunId(): string {
  return randomUUID();
}

export function recommendationFingerprint(repoRoot: string, recommendation: ImprovementRecommendation): string {
  return recommendationShape(repoRoot, recommendation).fingerprint;
}

export function loadRecommendationHistory(
  paths: AgentSmithPaths,
  input: { repoRoot: string; tool: string; limit?: number },
): RecommendationHistoryMemory {
  const db = openHistoryDatabase(paths);
  try {
    const rows = db
      .query(
        `
          SELECT
            fingerprint,
            recommendation_id,
            title,
            priority,
            category,
            total_attempts,
            resolved_count,
            blocked_count,
            stalled_count,
            regression_count,
            last_state,
            last_summary,
            last_seen_at
          FROM recommendation_history
          WHERE repo_root = ? AND tool = ?
          ORDER BY COALESCE(last_attempted_at, last_seen_at) DESC
          LIMIT ?
        `,
      )
      .all(input.repoRoot, input.tool, input.limit ?? 20) as RecommendationHistoryDbRow[];

    const byFingerprint = new Map<string, RecommendationHistoryRow>();
    const attemptedCounts = new Map<string, number>();
    const completedFingerprints = new Set<string>();
    const blockedFingerprints = new Set<string>();

    for (const row of rows) {
      byFingerprint.set(row.fingerprint, {
        fingerprint: row.fingerprint,
        recommendationId: row.recommendation_id,
        title: row.title,
        priority: row.priority,
        category: row.category,
        totalAttempts: row.total_attempts,
        resolvedCount: row.resolved_count,
        blockedCount: row.blocked_count,
        stalledCount: row.stalled_count,
        regressionCount: row.regression_count,
        lastState: row.last_state,
        lastSummary: row.last_summary,
        lastSeenAt: row.last_seen_at,
      });
      attemptedCounts.set(row.fingerprint, row.total_attempts);
      if (row.last_state === "resolved") {
        completedFingerprints.add(row.fingerprint);
      }
      if (row.last_state === "blocked" || row.last_state === "stalled") {
        blockedFingerprints.add(row.fingerprint);
      }
    }

    return {
      byFingerprint,
      attemptedCounts,
      completedFingerprints,
      blockedFingerprints,
      historicalOutcomes: rows.map(formatHistorySummary),
    };
  } finally {
    db.close();
  }
}

export function syncSeenRecommendations(
  paths: AgentSmithPaths,
  input: {
    repoRoot: string;
    tool: string;
    runId: string;
    recommendations: ImprovementRecommendation[];
  },
): void {
  if (input.recommendations.length === 0) {
    return;
  }

  const db = openHistoryDatabase(paths);
  try {
    const now = new Date().toISOString();
    const transaction = db.transaction((recommendations: ImprovementRecommendation[]) => {
      for (const recommendation of recommendations) {
        ensureHistoryRow(db, { ...input, recommendation, now });
      }
    });
    transaction(input.recommendations);
    hardenPrivateFile(paths.dbFile);
  } finally {
    db.close();
  }
}

export function recordRecommendationOutcome(input: RecordRecommendationOutcomeInput): void {
  const db = openHistoryDatabase(input.paths);
  try {
    const now = new Date().toISOString();
    const ensured = ensureHistoryRow(db, {
      repoRoot: input.repoRoot,
      tool: input.tool,
      runId: input.runId,
      recommendation: input.recommendation,
      now,
    });

    const summary = input.evaluationSummary?.trim() || input.applySummary.trim();

    db.query(
      `
        INSERT INTO recommendation_attempts (
          repo_root,
          tool,
          fingerprint,
          run_id,
          iteration_index,
          recorded_at,
          state,
          recommendation_id,
          title,
          apply_summary,
          evaluation_summary,
          changed_files_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      input.repoRoot,
      input.tool,
      ensured.fingerprint,
      input.runId,
      input.iterationIndex,
      now,
      input.state,
      input.recommendation.id,
      input.recommendation.title,
      input.applySummary,
      input.evaluationSummary ?? null,
      JSON.stringify(input.changedFiles ?? []),
    );

    db.query(
      `
        UPDATE recommendation_history
        SET recommendation_id = ?,
            title = ?,
            priority = ?,
            category = ?,
            last_seen_at = ?,
            last_seen_run_id = ?,
            last_state = ?,
            last_summary = ?,
            total_attempts = ?,
            resolved_count = resolved_count + ?,
            blocked_count = blocked_count + ?,
            stalled_count = stalled_count + ?,
            last_attempted_at = ?,
            last_resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE last_resolved_at END
        WHERE repo_root = ? AND tool = ? AND fingerprint = ?
      `,
    ).run(
      input.recommendation.id,
      input.recommendation.title,
      input.recommendation.priority,
      input.recommendation.category,
      now,
      input.runId,
      input.state,
      summary,
      ensured.totalAttempts + 1,
      input.state === "resolved" ? 1 : 0,
      input.state === "blocked" ? 1 : 0,
      input.state === "stalled" ? 1 : 0,
      now,
      input.state,
      now,
      input.repoRoot,
      input.tool,
      ensured.fingerprint,
    );

    hardenPrivateFile(input.paths.dbFile);
  } finally {
    db.close();
  }
}
