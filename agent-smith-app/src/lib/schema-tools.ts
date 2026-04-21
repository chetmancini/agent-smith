import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectTool,
  ensureSchemaCached,
  existingToolConfigs,
  findBinary,
  readJsonFile,
  readSchemaMetadata,
  type SupportedAgentTool,
  toolLabel,
} from "./agent-hosts";
import { createTerminalTheme, type TerminalTheme } from "./terminal-theme";

export type SchemaConfigParseMode = "json" | "toml";
export type SchemaValidationStatus = "valid" | "invalid" | "skipped";
export type ValidationReportStatus = "valid" | "invalid" | "no-configs";

interface SchemaProperty {
  description?: unknown;
  deprecated?: unknown;
  default?: unknown;
}

interface SchemaDocument {
  properties?: unknown;
}

export interface AjvRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SchemaToolRuntime {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetchImpl?: (input: string) => Promise<Response>;
  now?: () => Date;
  runAjv?: (args: string[], env: NodeJS.ProcessEnv) => AjvRunResult;
}

export interface SchemaRefreshResult {
  tool: SupportedAgentTool;
  toolLabel: string;
  schemaPath: string;
  metadataPath: string;
  metadata: ReturnType<typeof readSchemaMetadata>;
}

export interface ConfigValidationResult {
  configPath: string;
  parseMode: SchemaConfigParseMode | null;
  parseStatus: SchemaValidationStatus;
  parseError: string | null;
  schemaCheckStatus: SchemaValidationStatus;
  schemaCheckMode: "ajv" | "fallback";
  schemaCheckDetails: string[];
  unknownTopLevelKeys: string[];
  deprecatedTopLevelKeys: string[];
  availableTopLevelKeys: string[];
  currentTopLevelKeys: string[];
}

export interface SchemaValidationReport {
  tool: SupportedAgentTool;
  toolLabel: string;
  schemaPath: string;
  metadata: ReturnType<typeof readSchemaMetadata>;
  status: ValidationReportStatus;
  configs: ConfigValidationResult[];
}

export interface UpgradeFeature {
  key: string;
  configPaths: string[];
  description: string | null;
  defaultValue: unknown;
}

export interface UpgradeIssue {
  key: string;
  kind: "deprecated" | "unknown";
  configPaths: string[];
  description: string | null;
}

export interface UpgradeSettingsReport {
  tool: SupportedAgentTool;
  toolLabel: string;
  schemaPath: string;
  metadata: ReturnType<typeof readSchemaMetadata>;
  validation: SchemaValidationReport;
  newFeatures: UpgradeFeature[];
  investigateLater: UpgradeFeature[];
  issues: UpgradeIssue[];
  implementationPlan: string[];
  summary: string;
}

function schemaProperties(schema: SchemaDocument): Record<string, SchemaProperty> {
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    return {};
  }

  return schema.properties as Record<string, SchemaProperty>;
}

function parseConfigFile(path: string): {
  parseMode: SchemaConfigParseMode;
  value: Record<string, unknown>;
} {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".toml")) {
    const parsed = Bun.TOML.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`config root must be an object: ${path}`);
    }

    return {
      parseMode: "toml",
      value: parsed as Record<string, unknown>,
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

function defaultRunAjv(args: string[], env: NodeJS.ProcessEnv): AjvRunResult {
  const ajvPath = findBinary("ajv", env);
  if (!ajvPath) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: "ajv not installed",
    };
  }

  const result = spawnSync(ajvPath, args, {
    env,
    encoding: "utf8",
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function formatAjvDetails(result: AjvRunResult): string[] {
  const lines = `${result.stderr}${result.stdout}`
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  return lines.length > 0 ? lines : ["schema validation failed"];
}

function validateWithAjv(
  schemaPath: string,
  configPath: string,
  parseMode: SchemaConfigParseMode,
  runtime: SchemaToolRuntime,
): { status: SchemaValidationStatus; details: string[] } {
  const runner = runtime.runAjv ?? defaultRunAjv;
  const env = runtime.env ?? process.env;
  const args = [
    "validate",
    "-s",
    schemaPath,
    "-d",
    configPath,
    `--spec=${parseMode === "toml" ? "draft2020" : "draft7"}`,
  ];
  const result = runner(args, env);

  if (result.exitCode === -1) {
    return {
      status: "skipped",
      details: ["Schema check: skipped (ajv not installed); using schema diff fallback"],
    };
  }

  if (result.exitCode === 0) {
    return {
      status: "valid",
      details: ["Schema check: valid (ajv)"],
    };
  }

  return {
    status: "invalid",
    details: ["Schema check: invalid (ajv)", ...formatAjvDetails(result)],
  };
}

function buildSchemaDiff(
  schemaPath: string,
  config: Record<string, unknown>,
): {
  currentTopLevelKeys: string[];
  unknownTopLevelKeys: string[];
  deprecatedTopLevelKeys: string[];
  availableTopLevelKeys: string[];
} {
  const schemaPayload = readJsonFile(schemaPath) as SchemaDocument | null;
  if (!schemaPayload) {
    throw new Error(`schema cache missing or invalid at ${schemaPath}`);
  }

  const properties = schemaProperties(schemaPayload);
  const currentTopLevelKeys = Object.keys(config).sort();
  const topLevelKeys = Object.keys(properties).sort();

  return {
    currentTopLevelKeys,
    unknownTopLevelKeys: currentTopLevelKeys.filter((key) => !(key in properties)),
    deprecatedTopLevelKeys: currentTopLevelKeys.filter((key) => properties[key]?.deprecated === true),
    availableTopLevelKeys: topLevelKeys.filter((key) => !(key in config)),
  };
}

function propertyDescription(schemaPath: string, key: string): string | null {
  const schemaPayload = readJsonFile(schemaPath) as SchemaDocument | null;
  if (!schemaPayload) {
    return null;
  }

  const description = schemaProperties(schemaPayload)[key]?.description;
  return typeof description === "string" && description.trim().length > 0 ? description.trim() : null;
}

function propertyDefault(schemaPath: string, key: string): unknown {
  const schemaPayload = readJsonFile(schemaPath) as SchemaDocument | null;
  if (!schemaPayload) {
    return null;
  }

  return schemaProperties(schemaPayload)[key]?.default ?? null;
}

export async function refreshSchemaCache(
  explicitTool?: string,
  runtime: SchemaToolRuntime = {},
): Promise<SchemaRefreshResult> {
  const env = runtime.env ?? process.env;
  const cwd = runtime.cwd ?? process.cwd();
  const tool = detectTool(explicitTool, env, cwd);
  const { schemaPath, metadataPath } = await ensureSchemaCached(tool, {
    env,
    refresh: true,
    fetchImpl: runtime.fetchImpl,
    now: runtime.now,
  });

  return {
    tool,
    toolLabel: toolLabel(tool),
    schemaPath,
    metadataPath,
    metadata: readSchemaMetadata(tool, env),
  };
}

export async function validateAgentConfig(
  explicitTool?: string,
  options: { refresh?: boolean } & SchemaToolRuntime = {},
): Promise<SchemaValidationReport> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const tool = detectTool(explicitTool, env, cwd);
  const { schemaPath } = await ensureSchemaCached(tool, {
    env,
    refresh: options.refresh,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });

  const configs = existingToolConfigs(tool, env, cwd);
  if (configs.length === 0) {
    return {
      tool,
      toolLabel: toolLabel(tool),
      schemaPath,
      metadata: readSchemaMetadata(tool, env),
      status: "no-configs",
      configs: [],
    };
  }

  const results: ConfigValidationResult[] = [];

  for (const configPath of configs) {
    let tempDir: string | null = null;

    try {
      const parsed = parseConfigFile(configPath);
      const diff = buildSchemaDiff(schemaPath, parsed.value);

      let ajvConfigPath = configPath;
      if (parsed.parseMode === "toml") {
        tempDir = mkdtempSync(join(tmpdir(), "agent-smith-ajv-"));
        ajvConfigPath = join(tempDir, "config.json");
        writeFileSync(ajvConfigPath, `${JSON.stringify(parsed.value, null, 2)}\n`);
      }

      const schemaCheck = validateWithAjv(schemaPath, ajvConfigPath, parsed.parseMode, options);
      results.push({
        configPath,
        parseMode: parsed.parseMode,
        parseStatus: "valid",
        parseError: null,
        schemaCheckStatus: schemaCheck.status,
        schemaCheckMode: schemaCheck.status === "skipped" ? "fallback" : "ajv",
        schemaCheckDetails: schemaCheck.details,
        unknownTopLevelKeys: diff.unknownTopLevelKeys,
        deprecatedTopLevelKeys: diff.deprecatedTopLevelKeys,
        availableTopLevelKeys: diff.availableTopLevelKeys,
        currentTopLevelKeys: diff.currentTopLevelKeys,
      });
    } catch (error) {
      results.push({
        configPath,
        parseMode: configPath.endsWith(".toml") ? "toml" : "json",
        parseStatus: "invalid",
        parseError: (error as Error).message,
        schemaCheckStatus: "skipped",
        schemaCheckMode: "fallback",
        schemaCheckDetails: ["Schema check: skipped (config parse failed)"],
        unknownTopLevelKeys: [],
        deprecatedTopLevelKeys: [],
        availableTopLevelKeys: [],
        currentTopLevelKeys: [],
      });
    } finally {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  const status = results.some((result) => result.parseStatus === "invalid" || result.schemaCheckStatus === "invalid")
    ? "invalid"
    : "valid";

  return {
    tool,
    toolLabel: toolLabel(tool),
    schemaPath,
    metadata: readSchemaMetadata(tool, env),
    status,
    configs: results,
  };
}

function summarizeAvailableFeatures(
  schemaPath: string,
  configs: ConfigValidationResult[],
): { newFeatures: UpgradeFeature[]; investigateLater: UpgradeFeature[] } {
  const pathByKey = new Map<string, Set<string>>();

  for (const config of configs) {
    for (const key of config.availableTopLevelKeys) {
      const entries = pathByKey.get(key) ?? new Set<string>();
      entries.add(config.configPath);
      pathByKey.set(key, entries);
    }
  }

  const allFeatures = [...pathByKey.entries()]
    .map(([key, paths]) => ({
      key,
      configPaths: [...paths].sort(),
      description: propertyDescription(schemaPath, key),
      defaultValue: propertyDefault(schemaPath, key),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));

  return {
    newFeatures: [],
    investigateLater: allFeatures,
  };
}

function summarizeIssues(schemaPath: string, configs: ConfigValidationResult[]): UpgradeIssue[] {
  const issues = new Map<string, UpgradeIssue>();

  for (const config of configs) {
    for (const key of config.deprecatedTopLevelKeys) {
      const current = issues.get(`deprecated:${key}`) ?? {
        key,
        kind: "deprecated" as const,
        configPaths: [],
        description: propertyDescription(schemaPath, key),
      };
      current.configPaths = [...new Set([...current.configPaths, config.configPath])].sort();
      issues.set(`deprecated:${key}`, current);
    }

    for (const key of config.unknownTopLevelKeys) {
      const current = issues.get(`unknown:${key}`) ?? {
        key,
        kind: "unknown" as const,
        configPaths: [],
        description: null,
      };
      current.configPaths = [...new Set([...current.configPaths, config.configPath])].sort();
      issues.set(`unknown:${key}`, current);
    }
  }

  return [...issues.values()].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind.localeCompare(right.kind);
    }
    return left.key.localeCompare(right.key);
  });
}

function buildImplementationPlan(
  report: SchemaValidationReport,
  availableFeatures: UpgradeFeature[],
  issues: UpgradeIssue[],
): string[] {
  const lines: string[] = [];
  const issuePaths = [...new Set(issues.flatMap((issue) => issue.configPaths))].sort();
  const featurePaths = [...new Set(availableFeatures.flatMap((feature) => feature.configPaths))].sort();

  lines.push(
    `Rerun agent-smith validate-agent-config --tool ${report.tool} --refresh after each config change to keep the cached schema current.`,
  );

  if (report.status === "invalid") {
    lines.push("Fix parse or schema validation failures before changing settings coverage.");
  }

  if (issues.length > 0) {
    lines.push(`Remove or migrate deprecated/unknown keys in ${issuePaths.join(", ")}.`);
  }

  if (availableFeatures.length > 0) {
    lines.push(
      `Review unset schema keys in ${featurePaths.join(", ")} and explicitly adopt only the ones that match your current workflow.`,
    );
  }

  if (lines.length === 1) {
    lines.push("No schema drift detected; keep the current config and refresh the schema periodically.");
  }

  return lines;
}

export async function generateUpgradeSettingsReport(
  explicitTool?: string,
  options: { refresh?: boolean } & SchemaToolRuntime = {},
): Promise<UpgradeSettingsReport> {
  const validation = await validateAgentConfig(explicitTool, {
    ...options,
    refresh: options.refresh ?? true,
  });
  const { newFeatures, investigateLater } = summarizeAvailableFeatures(validation.schemaPath, validation.configs);
  const issues = summarizeIssues(validation.schemaPath, validation.configs);
  const implementationPlan = buildImplementationPlan(validation, investigateLater, issues);

  const summaryParts = [
    `${validation.configs.length} config file${validation.configs.length === 1 ? "" : "s"} checked`,
    issues.length > 0
      ? `${issues.length} drift item${issues.length === 1 ? "" : "s"} found`
      : "no deprecated or unknown keys",
    investigateLater.length > 0
      ? `${investigateLater.length} unset schema key${investigateLater.length === 1 ? "" : "s"} to review`
      : "no unset top-level schema keys",
  ];

  return {
    tool: validation.tool,
    toolLabel: validation.toolLabel,
    schemaPath: validation.schemaPath,
    metadata: validation.metadata,
    validation,
    newFeatures,
    investigateLater,
    issues,
    implementationPlan,
    summary: summaryParts.join("; "),
  };
}

export function renderRefreshSchemaResult(
  result: SchemaRefreshResult,
  theme: TerminalTheme = createTerminalTheme(),
): string {
  return `${theme.success("Refreshed")} ${theme.accent(result.toolLabel)} ${theme.dim("schema:")} ${result.schemaPath}\n`;
}

function renderKeyList(label: string, keys: string[]): string {
  if (keys.length === 0) {
    return `${label}: none`;
  }

  const preview = keys.slice(0, 10).join(", ");
  const suffix = keys.length > 10 ? " ..." : "";
  return `${label}: ${preview}${suffix}`;
}

function validationTone(
  status: ValidationReportStatus | SchemaValidationStatus,
): "success" | "warning" | "danger" | "muted" {
  switch (status) {
    case "valid":
      return "success";
    case "skipped":
    case "no-configs":
      return "warning";
    case "invalid":
      return "danger";
  }
}

export function renderValidationReport(
  report: SchemaValidationReport,
  theme: TerminalTheme = createTerminalTheme(),
): string {
  const lines: string[] = [];
  lines.push(theme.bold(theme.accent("Schema Validation Summary")));
  lines.push(`${theme.dim("Tool:")} ${theme.accent(report.toolLabel)}`);
  lines.push(`${theme.dim("Schema:")} ${report.schemaPath}`);
  if (report.metadata?.fetched_at) {
    lines.push(`${theme.dim("Fetched:")} ${report.metadata.fetched_at}`);
  }

  if (report.status === "no-configs") {
    lines.push(
      `${theme.dim("Status:")} ${theme.tone(`no installed ${report.toolLabel} config files found`, validationTone(report.status))}`,
    );
    return `${lines.join("\n")}\n`;
  }

  for (const config of report.configs) {
    lines.push("");
    lines.push(`${theme.bold(theme.info("Config"))}: ${config.configPath}`);

    if (config.parseStatus === "invalid") {
      lines.push(`Parse: ${theme.danger(`invalid ${config.parseMode ?? "config"}`)}`);
      if (config.parseError) {
        lines.push(`  ${config.parseError}`);
      }
      continue;
    }

    lines.push(`Parse: ${theme.success(`valid ${config.parseMode}`)}`);
    for (const detail of config.schemaCheckDetails) {
      if (detail.startsWith("Schema check:")) {
        lines.push(theme.info(detail));
      } else {
        lines.push(`  ${detail}`);
      }
    }
    lines.push(renderKeyList("Unknown top-level keys", config.unknownTopLevelKeys));
    lines.push(renderKeyList("Deprecated top-level keys in use", config.deprecatedTopLevelKeys));
    lines.push(renderKeyList("Available top-level schema keys not set", config.availableTopLevelKeys));
  }

  return `${lines.join("\n")}\n`;
}

function renderFeature(feature: UpgradeFeature): string[] {
  const lines = [`- ${feature.key}`];
  lines.push(`  Config: ${feature.configPaths.join(", ")}`);
  if (feature.description) {
    lines.push(`  Description: ${feature.description}`);
  }
  if (feature.defaultValue !== null && feature.defaultValue !== undefined) {
    lines.push(`  Default: ${JSON.stringify(feature.defaultValue)}`);
  }
  return lines;
}

function renderIssue(issue: UpgradeIssue): string[] {
  const lines = [`- ${issue.key} (${issue.kind})`];
  lines.push(`  Config: ${issue.configPaths.join(", ")}`);
  if (issue.description) {
    lines.push(`  Description: ${issue.description}`);
  }
  return lines;
}

export function renderUpgradeSettingsReport(
  report: UpgradeSettingsReport,
  theme: TerminalTheme = createTerminalTheme(),
): string {
  const lines: string[] = [];
  lines.push(theme.bold(theme.accent("Settings Upgrade Plan")));
  lines.push(`${theme.dim("Tool:")} ${theme.accent(report.toolLabel)}`);
  lines.push(`${theme.dim("Schema:")} ${report.schemaPath}`);
  if (report.metadata?.fetched_at) {
    lines.push(`${theme.dim("Fetched:")} ${report.metadata.fetched_at}`);
  }

  lines.push("");
  lines.push(theme.bold(theme.info("Summary")));
  lines.push(`  ${report.summary}`);

  lines.push("");
  lines.push(theme.bold(theme.success("New Features Worth Adopting")));
  if (report.newFeatures.length === 0) {
    lines.push(`  ${theme.muted("None identified automatically")}`);
  } else {
    for (const feature of report.newFeatures) {
      lines.push(...renderFeature(feature));
    }
  }

  lines.push("");
  lines.push(theme.bold(theme.warning("Deprecations and Removals")));
  if (report.issues.length === 0) {
    lines.push(`  ${theme.muted("None")}`);
  } else {
    for (const issue of report.issues) {
      lines.push(...renderIssue(issue));
    }
  }

  lines.push("");
  lines.push(theme.bold(theme.info("Investigate Later")));
  if (report.investigateLater.length === 0) {
    lines.push(`  ${theme.muted("None")}`);
  } else {
    for (const feature of report.investigateLater) {
      lines.push(...renderFeature(feature));
    }
  }

  lines.push("");
  lines.push(theme.bold(theme.accent("Implementation Plan")));
  for (const [index, step] of report.implementationPlan.entries()) {
    lines.push(`${index + 1}. ${step}`);
  }

  return `${lines.join("\n")}\n`;
}
