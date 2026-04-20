import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export type SupportedAgentTool = "claude" | "codex" | "opencode";

export interface SchemaMetadata {
  tool: SupportedAgentTool;
  schema_url: string;
  schema_path: string;
  fetched_at: string;
}

export function repoRootFromHere(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return resolve(dirname(currentFile), "..", "..", "..");
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ?? homedir();
}

export function findBinary(binary: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathValue = env.PATH ?? "";
  for (const entry of pathValue.split(":")) {
    if (!entry) {
      continue;
    }

    const candidate = join(entry, binary);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // keep scanning
    }
  }

  return null;
}

export function validateToolName(tool: string): tool is SupportedAgentTool {
  return tool === "claude" || tool === "codex" || tool === "opencode";
}

export function toolConfigCandidates(
  tool: SupportedAgentTool,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string[] {
  const home = homeDir(env);

  switch (tool) {
    case "claude":
      return [
        join(home, ".claude", "settings.json"),
        join(home, ".claude", "settings.local.json"),
        join(cwd, ".claude", "settings.json"),
      ];
    case "codex":
      return [join(home, ".codex", "config.toml")];
    case "opencode":
      return [join(home, ".config", "opencode", "opencode.json")];
  }
}

export function existingToolConfigs(
  tool: SupportedAgentTool,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string[] {
  return toolConfigCandidates(tool, env, cwd).filter((candidate) => existsSync(candidate));
}

export function firstExistingToolConfig(
  tool: SupportedAgentTool,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | null {
  return existingToolConfigs(tool, env, cwd)[0] ?? null;
}

export function detectTool(
  explicitTool?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): SupportedAgentTool {
  if (explicitTool) {
    if (validateToolName(explicitTool)) {
      return explicitTool;
    }
    throw new Error(`unsupported tool '${explicitTool}'`);
  }

  const envTool = env.AGENT_SMITH_TOOL;
  if (envTool) {
    if (validateToolName(envTool)) {
      return envTool;
    }
    throw new Error(`unsupported AGENT_SMITH_TOOL '${envTool}'`);
  }

  const configuredTools = (["claude", "codex", "opencode"] as const).filter(
    (tool) => existingToolConfigs(tool, env, cwd).length > 0,
  );
  if (configuredTools.length === 1) {
    return configuredTools[0];
  }

  const cliTools = (["claude", "codex", "opencode"] as const).filter((tool) => {
    return findBinary(tool, env) !== null;
  });
  if (cliTools.length === 1) {
    return cliTools[0];
  }

  throw new Error(
    "unable to infer which agent to inspect. Set AGENT_SMITH_TOOL=claude, AGENT_SMITH_TOOL=codex, or AGENT_SMITH_TOOL=opencode.",
  );
}

export function schemaUrl(tool: SupportedAgentTool): string {
  switch (tool) {
    case "claude":
      return "https://json.schemastore.org/claude-code-settings.json";
    case "codex":
      return "https://developers.openai.com/codex/config-schema.json";
    case "opencode":
      return "https://opencode.ai/config.json";
  }
}

export function schemaCachePath(tool: SupportedAgentTool, env: NodeJS.ProcessEnv = process.env): string {
  const base = join(homeDir(env), ".config", "agent-smith", "schemas");
  switch (tool) {
    case "claude":
      return join(base, "claude-code-settings.schema.json");
    case "codex":
      return join(base, "codex-config.schema.json");
    case "opencode":
      return join(base, "opencode-config.schema.json");
  }
}

export function schemaMetadataPath(
  tool: SupportedAgentTool,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = join(homeDir(env), ".config", "agent-smith", "schemas");
  switch (tool) {
    case "claude":
      return join(base, "claude-code-settings.schema.metadata.json");
    case "codex":
      return join(base, "codex-config.schema.metadata.json");
    case "opencode":
      return join(base, "opencode-config.schema.metadata.json");
  }
}

export function readJsonFile(path: string): unknown | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function readSchemaMetadata(
  tool: SupportedAgentTool,
  env: NodeJS.ProcessEnv = process.env,
): SchemaMetadata | null {
  const payload = readJsonFile(schemaMetadataPath(tool, env));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const candidate = payload as Partial<SchemaMetadata>;
  if (
    candidate.tool !== tool ||
    typeof candidate.schema_url !== "string" ||
    typeof candidate.schema_path !== "string" ||
    typeof candidate.fetched_at !== "string"
  ) {
    return null;
  }

  return candidate as SchemaMetadata;
}

export async function ensureSchemaCached(
  tool: SupportedAgentTool,
  options: { env?: NodeJS.ProcessEnv; refresh?: boolean } = {},
): Promise<{ schemaPath: string; metadataPath: string }> {
  const env = options.env ?? process.env;
  const schemaPath = schemaCachePath(tool, env);
  const metadataPath = schemaMetadataPath(tool, env);
  mkdirSync(dirname(schemaPath), { recursive: true, mode: 0o700 });

  if (!options.refresh && existsSync(schemaPath)) {
    return { schemaPath, metadataPath };
  }

  const url = schemaUrl(tool);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch schema for ${tool}: ${response.status} ${response.statusText}`);
  }

  const body = await response.text();
  writeFileSync(schemaPath, body, { mode: 0o600 });
  writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        tool,
        schema_url: url,
        schema_path: schemaPath,
        fetched_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  return { schemaPath, metadataPath };
}
