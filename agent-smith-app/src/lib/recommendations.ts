import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import {
  detectTool,
  ensureSchemaCached,
  existingToolConfigs,
  readJsonFile,
  readSchemaMetadata,
  repoRootFromHere,
  schemaCachePath,
  type SupportedAgentTool,
} from "./agent-hosts";
import { type AgentRunner, defaultRunAgent } from "./agent-runner";
import { eventSnippet } from "./events";
import { resolvePaths, type AgentSmithPaths } from "./paths";
import { generateReport } from "./report";
import { rollupEvents } from "./rollup";
import { createTerminalTheme, type TerminalTheme } from "./terminal-theme";

export interface ImprovementFilters {
  tool?: SupportedAgentTool;
  project?: string;
  limit?: number;
  refreshSchema?: boolean;
}

export interface SignalRate {
  sessions: number;
  totalSessions: number;
  rate: number;
  eventCount: number;
}

export interface SchemaConfigDiff {
  configPath: string;
  parseMode: "json" | "toml";
  unknownTopLevelKeys: string[];
  deprecatedTopLevelKeys: string[];
  availableTopLevelKeys: string[];
  currentTopLevelKeys: string[];
  redactedConfig: Record<string, unknown> | null;
}

export interface ImprovementEvidence {
  tool: SupportedAgentTool;
  project?: string;
  totalSessions: number;
  report: ReturnType<typeof generateReport>;
  signalRates: {
    failures: SignalRate;
    clarifications: SignalRate;
    permissionDenials: SignalRate;
    contextCompression: SignalRate;
    testFailureLoops: SignalRate;
  };
  recentExamples: {
    failures: EvidenceExample[];
    clarifications: EvidenceExample[];
    permissionDenials: EvidenceExample[];
    contextCompression: EvidenceExample[];
    testFailureLoops: EvidenceExample[];
  };
  schema: {
    schemaPath: string;
    metadata: ReturnType<typeof readSchemaMetadata>;
    topLevelKeys: string[];
    schemaDescriptionByKey: Record<string, string>;
  };
  config: {
    files: SchemaConfigDiff[];
  };
}

export interface EvidenceExample {
  ts: string;
  sessionId: string;
  project: string | null;
  snippet: string;
}

export interface ImprovementAction {
  type: "config_change" | "prompt_change" | "workflow_change" | "investigate";
  description: string;
  targetFiles: string[];
  safeToAutoApply: boolean;
}

export interface ImprovementRecommendation {
  id: string;
  title: string;
  priority: "high" | "medium" | "low";
  category: "config" | "prompt" | "workflow" | "testing" | "telemetry" | "investigation";
  rationale: string;
  evidence: string[];
  actions: ImprovementAction[];
}

export interface ImprovementReport {
  metricsDir: string;
  tool: SupportedAgentTool;
  project?: string;
  summary: string;
  evidence: ImprovementEvidence;
  recommendations: ImprovementRecommendation[];
}

export interface ImproveRuntime {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  runAgent?: AgentRunner;
}

export interface ImprovementPromptContext {
  completedRecommendationIds?: string[];
  blockedRecommendationIds?: string[];
  priorIterationSummaries?: string[];
  historicalRecommendationOutcomes?: string[];
}

interface AggregateRow {
  totalSessions: number;
  failureSessions: number;
  failureEvents: number;
  clarificationSessions: number;
  clarifications: number;
  denialSessions: number;
  denials: number;
  compressionSessions: number;
  compressions: number;
  testLoopSessions: number;
  testLoops: number;
}

interface SchemaDocument {
  description?: unknown;
  properties?: Record<string, { description?: unknown; deprecated?: unknown }> | unknown;
}

function openDatabase(paths: AgentSmithPaths): Database {
  return new Database(paths.dbFile, { create: true, readonly: true });
}

function buildWhere(
  filters: { tool?: string; project?: string },
  fieldPrefix = "",
): { where: string; params: string[] } {
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

function rate(sessions: number, totalSessions: number, eventCount: number): SignalRate {
  return {
    sessions,
    totalSessions,
    rate: totalSessions > 0 ? Math.round((sessions / totalSessions) * 1000) / 1000 : 0,
    eventCount,
  };
}

function queryAggregate(db: Database, filters: { tool?: string; project?: string }): AggregateRow {
  const { where, params } = buildWhere(filters);
  const row = db
    .query(
      `
        SELECT
          COUNT(*) AS totalSessions,
          COALESCE(SUM(CASE WHEN failure_count > 0 THEN 1 ELSE 0 END), 0) AS failureSessions,
          COALESCE(SUM(failure_count), 0) AS failureEvents,
          COALESCE(SUM(CASE WHEN clarification_count > 0 THEN 1 ELSE 0 END), 0) AS clarificationSessions,
          COALESCE(SUM(clarification_count), 0) AS clarifications,
          COALESCE(SUM(CASE WHEN denial_count > 0 THEN 1 ELSE 0 END), 0) AS denialSessions,
          COALESCE(SUM(denial_count), 0) AS denials,
          COALESCE(SUM(CASE WHEN compression_count > 0 THEN 1 ELSE 0 END), 0) AS compressionSessions,
          COALESCE(SUM(compression_count), 0) AS compressions,
          COALESCE(SUM(CASE WHEN test_loop_count > 0 THEN 1 ELSE 0 END), 0) AS testLoopSessions,
          COALESCE(SUM(test_loop_count), 0) AS testLoops
        FROM sessions
        ${where}
      `,
    )
    .get(...params) as AggregateRow | null;

  return (
    row ?? {
      totalSessions: 0,
      failureSessions: 0,
      failureEvents: 0,
      clarificationSessions: 0,
      clarifications: 0,
      denialSessions: 0,
      denials: 0,
      compressionSessions: 0,
      compressions: 0,
      testLoopSessions: 0,
      testLoops: 0,
    }
  );
}

function queryExamples(
  db: Database,
  filters: { tool?: string; project?: string },
  eventTypes: string[],
  limit: number,
): EvidenceExample[] {
  const { where, params } = buildWhere(filters);
  const typePlaceholders = eventTypes.map(() => "?").join(", ");
  const clauses = [where ? where.replace(/^WHERE /, "") : "", `event_type IN (${typePlaceholders})`]
    .filter(Boolean)
    .join(" AND ");
  const finalWhere = clauses.length > 0 ? `WHERE ${clauses}` : "";

  const rows = db
    .query(
      `
        SELECT ts, session_id AS sessionId, project, snippet, metadata
        FROM events
        ${finalWhere}
        ORDER BY ts DESC
        LIMIT ?
      `,
    )
    .all(...params, ...eventTypes, limit) as Array<{
    ts: string;
    sessionId: string;
    project: string | null;
    snippet: string | null;
    metadata: string;
  }>;

  return rows.map((row) => {
    const metadata = (() => {
      try {
        return JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();

    return {
      ts: row.ts,
      sessionId: row.sessionId,
      project: row.project,
      snippet:
        row.snippet?.trim() ||
        eventSnippet({
          ts: row.ts,
          tool: filters.tool ?? "unknown",
          session_id: row.sessionId,
          event_type: eventTypes[0] ?? "unknown",
          metadata,
        }) ||
        "(no snippet)",
    };
  });
}

function parseConfigFile(path: string): {
  parseMode: "json" | "toml";
  value: Record<string, unknown>;
} {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".toml")) {
    return {
      parseMode: "toml",
      value: Bun.TOML.parse(text) as Record<string, unknown>,
    };
  }

  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config root must be an object: ${path}`);
  }

  return {
    parseMode: "json",
    value: parsed as Record<string, unknown>,
  };
}

function redactConfig(value: unknown, path = ""): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactConfig(item, `${path}[${index}]`));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    const looksSecret =
      /(api.?key|token|secret|password|passwd|authorization|credential|private.?key|client.?secret)/.test(lowered);
    result[key] = looksSecret ? "[REDACTED]" : redactConfig(child, `${path}.${key}`);
  }
  return result;
}

function schemaProperties(schema: SchemaDocument): Record<string, { description?: unknown; deprecated?: unknown }> {
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    return {};
  }
  return schema.properties as Record<string, { description?: unknown; deprecated?: unknown }>;
}

function buildSchemaDiff(
  tool: SupportedAgentTool,
  env: NodeJS.ProcessEnv,
): {
  files: SchemaConfigDiff[];
  topLevelKeys: string[];
  schemaDescriptionByKey: Record<string, string>;
} {
  const schemaPath = schemaCachePath(tool, env);
  const schemaPayload = readJsonFile(schemaPath) as SchemaDocument | null;
  if (!schemaPayload) {
    throw new Error(`schema cache missing or invalid at ${schemaPath}`);
  }

  const properties = schemaProperties(schemaPayload);
  const topLevelKeys = Object.keys(properties).sort();
  const schemaDescriptionByKey = Object.fromEntries(
    topLevelKeys.flatMap((key) => {
      const description = properties[key]?.description;
      return typeof description === "string" && description.trim().length > 0 ? [[key, description.trim()]] : [];
    }),
  );

  const files = existingToolConfigs(tool, env).map((configPath) => {
    const parsed = parseConfigFile(configPath);
    const currentKeys = Object.keys(parsed.value).sort();
    const unknownTopLevelKeys = currentKeys.filter((key) => !(key in properties));
    const deprecatedTopLevelKeys = currentKeys.filter((key) => properties[key]?.deprecated === true);
    const availableTopLevelKeys = topLevelKeys.filter((key) => !(key in parsed.value));

    return {
      configPath,
      parseMode: parsed.parseMode,
      unknownTopLevelKeys,
      deprecatedTopLevelKeys,
      availableTopLevelKeys,
      currentTopLevelKeys: currentKeys,
      redactedConfig: redactConfig(parsed.value) as Record<string, unknown>,
    };
  });

  return { files, topLevelKeys, schemaDescriptionByKey };
}

function buildPrompt(evidence: ImprovementEvidence, context: ImprovementPromptContext = {}): string {
  const lines = [
    "You are Agent Smith's reasoning engine.",
    "Read the empirical telemetry evidence, schema state, and current config structure below.",
    "Produce recommendations that are driven by the evidence, not by generic best practices.",
    "Use schema-backed configuration reasoning where relevant. Do not recommend keys that are absent from the current schema evidence.",
    "Return JSON only. No markdown, no commentary outside JSON.",
    "",
    "Return an object with this exact shape:",
    "{",
    '  "summary": "string",',
    '  "recommendations": [',
    "    {",
    '      "id": "kebab-case-string",',
    '      "title": "string",',
    '      "priority": "high|medium|low",',
    '      "category": "config|prompt|workflow|testing|telemetry|investigation",',
    '      "rationale": "string",',
    '      "evidence": ["string"],',
    '      "actions": [',
    "        {",
    '          "type": "config_change|prompt_change|workflow_change|investigate",',
    '          "description": "string",',
    '          "targetFiles": ["string"],',
    '          "safeToAutoApply": false',
    "        }",
    "      ]",
    "    }",
    "  ]",
    "}",
    "",
  ];

  if ((context.completedRecommendationIds ?? []).length > 0) {
    lines.push(`Already completed recommendation ids: ${JSON.stringify(context.completedRecommendationIds)}`);
  }
  if ((context.blockedRecommendationIds ?? []).length > 0) {
    lines.push(`Blocked recommendation ids: ${JSON.stringify(context.blockedRecommendationIds)}`);
  }
  if ((context.priorIterationSummaries ?? []).length > 0) {
    lines.push("Prior iteration summaries:");
    for (const summary of context.priorIterationSummaries ?? []) {
      lines.push(`- ${summary}`);
    }
    lines.push("");
  }
  if ((context.historicalRecommendationOutcomes ?? []).length > 0) {
    lines.push("Historical recommendation outcomes from prior loop runs:");
    for (const summary of context.historicalRecommendationOutcomes ?? []) {
      lines.push(`- ${summary}`);
    }
    lines.push("");
  }

  lines.push(
    "If a recommendation id is already completed or blocked, do not repeat it. Prefer the next-best actionable recommendation instead.",
    "If prior loop history shows a resolved recommendation resurfacing, treat that as a regression and explain why it returned.",
    "Evidence JSON:",
    JSON.stringify(evidence, null, 2),
  );

  return lines.join("\n");
}

function parseAgentResponse(text: string): {
  summary: string;
  recommendations: ImprovementRecommendation[];
} {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("agent output did not include a JSON object");
  }

  const payload = JSON.parse(trimmed.slice(start, end + 1)) as {
    summary?: unknown;
    recommendations?: unknown;
  };

  if (typeof payload.summary !== "string") {
    throw new Error("agent output is missing summary");
  }
  if (!Array.isArray(payload.recommendations)) {
    throw new Error("agent output is missing recommendations");
  }

  const recommendations = payload.recommendations.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`recommendation ${index} is not an object`);
    }
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.title !== "string" ||
      (candidate.priority !== "high" && candidate.priority !== "medium" && candidate.priority !== "low") ||
      (candidate.category !== "config" &&
        candidate.category !== "prompt" &&
        candidate.category !== "workflow" &&
        candidate.category !== "testing" &&
        candidate.category !== "telemetry" &&
        candidate.category !== "investigation") ||
      typeof candidate.rationale !== "string" ||
      !Array.isArray(candidate.evidence) ||
      !Array.isArray(candidate.actions)
    ) {
      throw new Error(`recommendation ${index} is missing required fields`);
    }

    const priority: ImprovementRecommendation["priority"] = candidate.priority;
    const category: ImprovementRecommendation["category"] = candidate.category;

    const actions: ImprovementAction[] = candidate.actions.map((action, actionIndex) => {
      if (!action || typeof action !== "object" || Array.isArray(action)) {
        throw new Error(`recommendation ${index} action ${actionIndex} is not an object`);
      }
      const actionCandidate = action as Record<string, unknown>;
      if (
        (actionCandidate.type !== "config_change" &&
          actionCandidate.type !== "prompt_change" &&
          actionCandidate.type !== "workflow_change" &&
          actionCandidate.type !== "investigate") ||
        typeof actionCandidate.description !== "string" ||
        !Array.isArray(actionCandidate.targetFiles) ||
        typeof actionCandidate.safeToAutoApply !== "boolean"
      ) {
        throw new Error(`recommendation ${index} action ${actionIndex} is missing required fields`);
      }

      const type: ImprovementAction["type"] = actionCandidate.type;

      return {
        type,
        description: actionCandidate.description,
        targetFiles: actionCandidate.targetFiles.filter((value): value is string => typeof value === "string"),
        safeToAutoApply: actionCandidate.safeToAutoApply,
      };
    });

    return {
      id: candidate.id,
      title: candidate.title,
      priority,
      category,
      rationale: candidate.rationale,
      evidence: candidate.evidence.filter((value): value is string => typeof value === "string"),
      actions,
    };
  });

  return {
    summary: payload.summary,
    recommendations,
  };
}

export async function generateImprovementReport(
  paths = resolvePaths(),
  filters: ImprovementFilters = {},
  runtime: ImproveRuntime = {},
  options: { promptContext?: ImprovementPromptContext } = {},
): Promise<ImprovementReport> {
  rollupEvents(paths);

  const env = runtime.env ?? process.env;
  const repoRoot = runtime.repoRoot ?? repoRootFromHere(env);
  const tool = detectTool(filters.tool, env, repoRoot);

  await ensureSchemaCached(tool, { env, refresh: filters.refreshSchema });
  const schemaInfo = buildSchemaDiff(tool, env);

  const db = openDatabase(paths);
  try {
    const limit = filters.limit ?? 5;
    const aggregate = queryAggregate(db, { tool, project: filters.project });
    const report = generateReport(paths, {
      tool,
      project: filters.project,
      limit,
    });
    const evidence: ImprovementEvidence = {
      tool,
      project: filters.project,
      totalSessions: aggregate.totalSessions,
      report,
      signalRates: {
        failures: rate(aggregate.failureSessions, aggregate.totalSessions, aggregate.failureEvents),
        clarifications: rate(aggregate.clarificationSessions, aggregate.totalSessions, aggregate.clarifications),
        permissionDenials: rate(aggregate.denialSessions, aggregate.totalSessions, aggregate.denials),
        contextCompression: rate(aggregate.compressionSessions, aggregate.totalSessions, aggregate.compressions),
        testFailureLoops: rate(aggregate.testLoopSessions, aggregate.totalSessions, aggregate.testLoops),
      },
      recentExamples: {
        failures: queryExamples(
          db,
          { tool, project: filters.project },
          ["command_failure", "tool_failure", "session_error", "stop_failure"],
          limit,
        ),
        clarifications: queryExamples(db, { tool, project: filters.project }, ["clarifying_question"], limit),
        permissionDenials: queryExamples(db, { tool, project: filters.project }, ["permission_denied"], limit),
        contextCompression: queryExamples(db, { tool, project: filters.project }, ["context_compression"], limit),
        testFailureLoops: queryExamples(db, { tool, project: filters.project }, ["test_failure_loop"], limit),
      },
      schema: {
        schemaPath: schemaCachePath(tool, env),
        metadata: readSchemaMetadata(tool, env),
        topLevelKeys: schemaInfo.topLevelKeys,
        schemaDescriptionByKey: schemaInfo.schemaDescriptionByKey,
      },
      config: {
        files: schemaInfo.files,
      },
    };

    const prompt = buildPrompt(evidence, options.promptContext);
    const runAgent = runtime.runAgent ?? defaultRunAgent;
    const result = runAgent({ tool, prompt, repoRoot, env });
    if (result.exitCode !== 0) {
      throw new Error(
        `reasoning engine failed for ${tool}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
      );
    }

    const parsed = parseAgentResponse(result.stdout);
    return {
      metricsDir: paths.metricsDir,
      tool,
      project: filters.project,
      summary: parsed.summary,
      evidence,
      recommendations: parsed.recommendations,
    };
  } finally {
    db.close();
  }
}

function priorityTone(priority: ImprovementRecommendation["priority"]): "danger" | "warning" | "info" {
  switch (priority) {
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
      return "info";
  }
}

export function renderImprovementReport(
  report: ImprovementReport,
  theme: TerminalTheme = createTerminalTheme(),
): string {
  const lines: string[] = [];

  lines.push(theme.bold(theme.accent("Agent Smith Improve")));
  lines.push(`${theme.dim("Metrics dir:")} ${report.metricsDir}`);
  lines.push(`${theme.dim("Tool:")} ${theme.accent(report.tool)}`);
  lines.push(`${theme.dim("Sessions:")} ${report.evidence.totalSessions}`);
  if (report.project) {
    lines.push(`${theme.dim("Project:")} ${report.project}`);
  }

  lines.push("");
  lines.push(theme.bold(theme.info("Summary")));
  lines.push(`  ${report.summary}`);

  if (report.recommendations.length === 0) {
    lines.push("");
    lines.push(theme.bold(theme.info("Recommendations")));
    lines.push(`  ${theme.muted("None")}`);
    return `${lines.join("\n")}\n`;
  }

  lines.push("");
  lines.push(theme.bold(theme.info("Recommendations")));

  for (const recommendation of report.recommendations) {
    lines.push(
      `  ${theme.tone(`[${recommendation.priority}]`, priorityTone(recommendation.priority))} ${recommendation.title} ${theme.dim(`(${recommendation.category})`)}`,
    );
    lines.push(`    ${theme.dim("Why:")} ${recommendation.rationale}`);
    if (recommendation.evidence.length > 0) {
      lines.push(`    ${theme.dim("Evidence:")} ${recommendation.evidence.join(" | ")}`);
    }
    for (const action of recommendation.actions) {
      const targets =
        action.targetFiles.length > 0
          ? ` -> ${action.targetFiles.map((file) => basename(file) || file).join(", ")}`
          : "";
      lines.push(
        `    ${theme.dim("Action:")} ${action.type}${action.safeToAutoApply ? ` ${theme.success("[safe]")}` : ""} ${action.description}${targets}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
