import { basename, relative, resolve } from "node:path";

import { AgentRunner, defaultRunAgent } from "./agent-runner";
import { repoRootFromHere, SupportedAgentTool } from "./agent-hosts";
import {
  ImproveRuntime,
  ImprovementAction,
  ImprovementFilters,
  ImprovementRecommendation,
  ImprovementReport,
  generateImprovementReport,
} from "./recommendations";
import { resolvePaths } from "./paths";

export interface LoopFilters extends ImprovementFilters {
  iterations?: number;
  includeUnsafe?: boolean;
}

export interface ApplyValidationResult {
  command: string;
  outcome: "passed" | "failed" | "not_run";
  details?: string;
}

export interface AppliedRecommendationResult {
  recommendationId: string;
  title: string;
  summary: string;
  changedFiles: string[];
  validation: ApplyValidationResult[];
  followUps: string[];
}

export interface LoopEvaluationResult {
  summary: string;
  outcome: "resolved" | "partial" | "blocked";
  rationale: string;
  continueLoop: boolean;
  nextFocus?: string;
}

export interface ImprovementLoopIteration {
  index: number;
  analysisSummary: string;
  recommendationId: string;
  recommendationTitle: string;
  recommendationPriority: ImprovementRecommendation["priority"];
  recommendationCategory: ImprovementRecommendation["category"];
  safeActionCount: number;
  apply: AppliedRecommendationResult;
  evaluation: LoopEvaluationResult;
}

export interface ImprovementLoopReport {
  metricsDir: string;
  tool: SupportedAgentTool;
  project?: string;
  stopReason:
    | "completed"
    | "max_iterations"
    | "no_auto_applicable_recommendations"
    | "no_changes_applied"
    | "stalled"
    | "blocked";
  finalSummary: string;
  completedRecommendationIds: string[];
  blockedRecommendationIds: string[];
  iterations: ImprovementLoopIteration[];
}

export interface LoopRuntime extends ImproveRuntime {
  runAgent?: AgentRunner;
}

interface ApplyResponsePayload {
  summary: string;
  changedFiles: string[];
  validation: ApplyValidationResult[];
  followUps: string[];
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("agent output did not include a JSON object");
  }

  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("agent output must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

function parseValidationList(input: unknown): ApplyValidationResult[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const outcome = candidate.outcome;
    if (
      typeof candidate.command !== "string" ||
      (outcome !== "passed" && outcome !== "failed" && outcome !== "not_run")
    ) {
      return [];
    }

    return [
      {
        command: candidate.command,
        outcome,
        details: typeof candidate.details === "string" ? candidate.details : undefined,
      },
    ];
  });
}

function parseApplyResponse(text: string): ApplyResponsePayload {
  const payload = extractJsonObject(text);
  if (typeof payload.summary !== "string") {
    throw new Error("apply response is missing summary");
  }

  return {
    summary: payload.summary,
    changedFiles: Array.isArray(payload.changedFiles)
      ? payload.changedFiles.filter((value): value is string => typeof value === "string")
      : [],
    validation: parseValidationList(payload.validation),
    followUps: Array.isArray(payload.followUps)
      ? payload.followUps.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function parseEvaluationResponse(text: string): LoopEvaluationResult {
  const payload = extractJsonObject(text);
  if (
    typeof payload.summary !== "string" ||
    (payload.outcome !== "resolved" &&
      payload.outcome !== "partial" &&
      payload.outcome !== "blocked") ||
    typeof payload.rationale !== "string" ||
    typeof payload.continueLoop !== "boolean"
  ) {
    throw new Error("evaluation response is missing required fields");
  }

  return {
    summary: payload.summary,
    outcome: payload.outcome,
    rationale: payload.rationale,
    continueLoop: payload.continueLoop,
    nextFocus: typeof payload.nextFocus === "string" ? payload.nextFocus : undefined,
  };
}

function toRepoRelative(repoRoot: string, filePath: string): string {
  const absolute = resolve(repoRoot, filePath);
  const repoRelative = relative(repoRoot, absolute);
  return repoRelative.startsWith("..") ? filePath : repoRelative || filePath;
}

function snapshotGitStatus(repoRoot: string): Map<string, string> {
  const proc = Bun.spawnSync(["git", "-C", repoRoot, "status", "--porcelain=v1", "-z"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    return new Map();
  }

  const entries = proc.stdout.toString().split("\0").filter((entry) => entry.length > 0);
  const snapshot = new Map<string, string>();

  for (const entry of entries) {
    if (entry.length < 4) {
      continue;
    }

    const path = entry.slice(3).split(" -> ").at(-1)?.trim();
    if (!path) {
      continue;
    }

    snapshot.set(path, entry.slice(0, 2));
  }

  return snapshot;
}

function diffGitStatus(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, status] of after.entries()) {
    if (before.get(path) !== status) {
      changed.push(path);
    }
  }
  return changed.sort();
}

function allowedActions(
  recommendation: ImprovementRecommendation,
  includeUnsafe: boolean,
): ImprovementAction[] {
  return recommendation.actions.filter((action) => includeUnsafe || action.safeToAutoApply);
}

function chooseRecommendation(
  report: ImprovementReport,
  attemptedIds: Map<string, number>,
  completedIds: Set<string>,
  blockedIds: Set<string>,
  includeUnsafe: boolean,
): ImprovementRecommendation | null {
  for (const recommendation of report.recommendations) {
    if (completedIds.has(recommendation.id)) {
      continue;
    }

    if (blockedIds.has(recommendation.id)) {
      continue;
    }

    if ((attemptedIds.get(recommendation.id) ?? 0) >= 2) {
      continue;
    }

    if (allowedActions(recommendation, includeUnsafe).length === 0) {
      continue;
    }

    return recommendation;
  }

  return null;
}

function buildApplyPrompt(input: {
  recommendation: ImprovementRecommendation;
  analysis: ImprovementReport;
  repoRoot: string;
  includeUnsafe: boolean;
}): string {
  const allowed = allowedActions(input.recommendation, input.includeUnsafe);

  return [
    "You are applying one Agent Smith improvement recommendation inside the repository.",
    "Implement only the allowed actions below. Do not broaden scope. Stay within the repo root.",
    "Run focused validation if it materially improves confidence.",
    "Return JSON only with this exact shape:",
    "{",
    '  "summary": "string",',
    '  "changedFiles": ["relative/path"],',
    '  "validation": [',
    '    { "command": "string", "outcome": "passed|failed|not_run", "details": "string" }',
    "  ],",
    '  "followUps": ["string"]',
    "}",
    "",
    `Repo root: ${input.repoRoot}`,
    `Analysis summary: ${input.analysis.summary}`,
    "",
    "Recommendation JSON:",
    JSON.stringify(input.recommendation, null, 2),
    "",
    "Allowed actions JSON:",
    JSON.stringify(allowed, null, 2),
  ].join("\n");
}

function buildEvaluationPrompt(input: {
  recommendation: ImprovementRecommendation;
  apply: AppliedRecommendationResult;
  analysis: ImprovementReport;
  repoRoot: string;
}): string {
  return [
    "You are evaluating whether a just-applied Agent Smith improvement actually addressed the recommendation.",
    "Inspect the repo state as needed, but keep the answer narrowly grounded in the recommendation and observed changes.",
    "Return JSON only with this exact shape:",
    "{",
    '  "summary": "string",',
    '  "outcome": "resolved|partial|blocked",',
    '  "rationale": "string",',
    '  "continueLoop": true,',
    '  "nextFocus": "string"',
    "}",
    "",
    `Repo root: ${input.repoRoot}`,
    `Analysis summary: ${input.analysis.summary}`,
    "",
    "Recommendation JSON:",
    JSON.stringify(input.recommendation, null, 2),
    "",
    "Apply result JSON:",
    JSON.stringify(input.apply, null, 2),
  ].join("\n");
}

function runAgentJson(
  runAgent: AgentRunner,
  input: { tool: SupportedAgentTool; prompt: string; repoRoot: string; env: NodeJS.ProcessEnv },
  label: string,
): string {
  const result = runAgent(input);
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed for ${input.tool}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout;
}

function applyRecommendation(input: {
  report: ImprovementReport;
  recommendation: ImprovementRecommendation;
  tool: SupportedAgentTool;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  includeUnsafe: boolean;
  runAgent: AgentRunner;
}): AppliedRecommendationResult {
  const before = snapshotGitStatus(input.repoRoot);
  const stdout = runAgentJson(
    input.runAgent,
    {
      tool: input.tool,
      prompt: buildApplyPrompt({
        recommendation: input.recommendation,
        analysis: input.report,
        repoRoot: input.repoRoot,
        includeUnsafe: input.includeUnsafe,
      }),
      repoRoot: input.repoRoot,
      env: input.env,
    },
    "apply step",
  );
  const parsed = parseApplyResponse(stdout);
  const after = snapshotGitStatus(input.repoRoot);
  const gitChangedFiles = diffGitStatus(before, after);
  const allChangedFiles = [...new Set([...parsed.changedFiles, ...gitChangedFiles])]
    .map((filePath) => toRepoRelative(input.repoRoot, filePath))
    .sort();

  return {
    recommendationId: input.recommendation.id,
    title: input.recommendation.title,
    summary: parsed.summary,
    changedFiles: allChangedFiles,
    validation: parsed.validation,
    followUps: parsed.followUps,
  };
}

function evaluateRecommendation(input: {
  report: ImprovementReport;
  recommendation: ImprovementRecommendation;
  apply: AppliedRecommendationResult;
  tool: SupportedAgentTool;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runAgent: AgentRunner;
}): LoopEvaluationResult {
  const stdout = runAgentJson(
    input.runAgent,
    {
      tool: input.tool,
      prompt: buildEvaluationPrompt({
        recommendation: input.recommendation,
        apply: input.apply,
        analysis: input.report,
        repoRoot: input.repoRoot,
      }),
      repoRoot: input.repoRoot,
      env: input.env,
    },
    "evaluation step",
  );

  return parseEvaluationResponse(stdout);
}

export async function runImprovementLoop(
  filters: LoopFilters = {},
  runtime: LoopRuntime = {},
): Promise<ImprovementLoopReport> {
  const paths = resolvePaths(runtime.env ?? process.env);
  const env = runtime.env ?? process.env;
  const repoRoot = runtime.repoRoot ?? repoRootFromHere(env);
  const runAgent = runtime.runAgent ?? defaultRunAgent;
  const maxIterations = filters.iterations ?? 3;
  const includeUnsafe = filters.includeUnsafe ?? false;

  const iterations: ImprovementLoopIteration[] = [];
  const completedIds = new Set<string>();
  const blockedIds = new Set<string>();
  const attemptedIds = new Map<string, number>();
  const priorIterationSummaries: string[] = [];
  let lastTool: SupportedAgentTool | null = null;
  let stopReason: ImprovementLoopReport["stopReason"] = "max_iterations";

  for (let index = 1; index <= maxIterations; index += 1) {
    const report = await generateImprovementReport(
      paths,
      filters,
      { ...runtime, env, repoRoot, runAgent },
      {
        promptContext: {
          completedRecommendationIds: [...completedIds],
          blockedRecommendationIds: [...blockedIds],
          priorIterationSummaries,
        },
      },
    );
    lastTool = report.tool;

    const recommendation = chooseRecommendation(
      report,
      attemptedIds,
      completedIds,
      blockedIds,
      includeUnsafe,
    );
    if (!recommendation) {
      stopReason = "no_auto_applicable_recommendations";
      break;
    }

    attemptedIds.set(recommendation.id, (attemptedIds.get(recommendation.id) ?? 0) + 1);

    const apply = applyRecommendation({
      report,
      recommendation,
      tool: report.tool,
      repoRoot,
      env,
      includeUnsafe,
      runAgent,
    });
    if (apply.changedFiles.length === 0) {
      stopReason = "no_changes_applied";
      break;
    }

    const evaluation = evaluateRecommendation({
      report,
      recommendation,
      apply,
      tool: report.tool,
      repoRoot,
      env,
      runAgent,
    });

    iterations.push({
      index,
      analysisSummary: report.summary,
      recommendationId: recommendation.id,
      recommendationTitle: recommendation.title,
      recommendationPriority: recommendation.priority,
      recommendationCategory: recommendation.category,
      safeActionCount: allowedActions(recommendation, includeUnsafe).length,
      apply,
      evaluation,
    });

    priorIterationSummaries.push(
      `${recommendation.id}: ${apply.summary}; evaluation=${evaluation.outcome}; files=${apply.changedFiles.join(", ")}`,
    );

    if (evaluation.outcome === "resolved") {
      completedIds.add(recommendation.id);
    } else if (evaluation.outcome === "blocked") {
      blockedIds.add(recommendation.id);
      stopReason = "blocked";
      break;
    }

    if ((attemptedIds.get(recommendation.id) ?? 0) >= 2 && evaluation.outcome !== "resolved") {
      stopReason = "stalled";
      break;
    }

    if (!evaluation.continueLoop) {
      stopReason = evaluation.outcome === "blocked" ? "blocked" : "completed";
      break;
    }

    if (index === maxIterations) {
      stopReason = "max_iterations";
    }
  }

  const finalSummary =
    iterations.length === 0
      ? "No auto-applicable recommendations were available for the current evidence."
      : `Completed ${completedIds.size} recommendation(s) across ${iterations.length} iteration(s).`;

  return {
    metricsDir: paths.metricsDir,
    tool: lastTool ?? "codex",
    project: filters.project,
    stopReason,
    finalSummary,
    completedRecommendationIds: [...completedIds],
    blockedRecommendationIds: [...blockedIds],
    iterations,
  };
}

export function renderLoopReport(report: ImprovementLoopReport): string {
  const lines: string[] = [];
  lines.push("Agent Smith Loop");
  lines.push(`Metrics dir: ${report.metricsDir}`);
  lines.push(`Tool: ${report.tool}`);
  if (report.project) {
    lines.push(`Project: ${report.project}`);
  }
  lines.push(`Stop reason: ${report.stopReason}`);
  lines.push(`Summary: ${report.finalSummary}`);

  if (report.iterations.length === 0) {
    return `${lines.join("\n")}\n`;
  }

  lines.push("");
  lines.push("Iterations:");
  for (const iteration of report.iterations) {
    lines.push(
      `  ${iteration.index}. [${iteration.recommendationPriority}] ${iteration.recommendationTitle} (${iteration.recommendationCategory})`,
    );
    lines.push(`     Analysis: ${iteration.analysisSummary}`);
    lines.push(`     Apply: ${iteration.apply.summary}`);
    lines.push(`     Evaluate: ${iteration.evaluation.summary} (${iteration.evaluation.outcome})`);
    if (iteration.apply.changedFiles.length > 0) {
      lines.push(`     Files: ${iteration.apply.changedFiles.map((file) => basename(file)).join(", ")}`);
    }
    if (iteration.apply.validation.length > 0) {
      lines.push(
        `     Validation: ${iteration.apply.validation
          .map((entry) => `${entry.outcome} ${entry.command}`)
          .join(" | ")}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
