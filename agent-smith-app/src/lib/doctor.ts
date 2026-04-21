import { accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorHostResult {
  host: "claude" | "codex" | "opencode";
  binary: string;
  installed: boolean;
  binaryPath: string | null;
  status: DoctorStatus;
  summary: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  repoRoot: string;
  overallStatus: DoctorStatus;
  hosts: DoctorHostResult[];
}

function statusRank(status: DoctorStatus): number {
  switch (status) {
    case "fail":
      return 4;
    case "warn":
      return 3;
    case "pass":
      return 2;
    case "skip":
      return 1;
  }
}

function combineStatuses(statuses: DoctorStatus[]): DoctorStatus {
  let winner: DoctorStatus = "skip";
  for (const status of statuses) {
    if (statusRank(status) > statusRank(winner)) {
      winner = status;
    }
  }
  return winner;
}

function makeCheck(id: string, label: string, ok: boolean, passDetail: string, failDetail: string): DoctorCheck {
  return {
    id,
    label,
    status: ok ? "pass" : "fail",
    detail: ok ? passDetail : failDetail,
  };
}

function makeSkipHost(host: DoctorHostResult["host"], binary: string): DoctorHostResult {
  return {
    host,
    binary,
    installed: false,
    binaryPath: null,
    status: "skip",
    summary: `${binary} is not installed; skipped host-specific validation`,
    checks: [],
  };
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8");
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? "";
}

function expandHome(input: string, env: NodeJS.ProcessEnv): string {
  if (input === "~") {
    return homeDir(env);
  }
  if (input.startsWith("~/")) {
    return join(homeDir(env), input.slice(2));
  }
  return input;
}

function repoRootFromHere(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return resolve(dirname(currentFile), "..", "..", "..");
}

function findBinary(binary: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = env.PATH ?? "";
  for (const entry of pathValue.split(":")) {
    if (!entry) {
      continue;
    }
    const candidate = join(entry, binary);
    try {
      accessSync(candidate, constants.X_OK);
      const stats = statSync(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

function codexHooksEnabled(configText: string): boolean {
  const section = extractTomlSection(configText, /^\[features\]$/m);
  return section ? /\bcodex_hooks\s*=\s*true\b/.test(section) : false;
}

function codexRepoTrusted(configText: string, repoRoot: string): boolean {
  const escaped = repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\[projects\\."${escaped}"\\]$`, "m");
  const section = extractTomlSection(configText, pattern);
  return section ? /\btrust_level\s*=\s*"trusted"/.test(section) : false;
}

function extractTomlSection(text: string, headerPattern: RegExp): string | null {
  const match = headerPattern.exec(text);
  if (!match || match.index < 0) {
    return null;
  }

  const start = match.index;
  const remainder = text.slice(start);
  const nextHeaderOffset = remainder.slice(match[0].length).search(/\n\[[^\n]+\]/);
  if (nextHeaderOffset < 0) {
    return remainder;
  }

  return remainder.slice(0, match[0].length + nextHeaderOffset + 1);
}

function opencodePluginConfigured(
  configPath: string,
  pluginEntries: unknown,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): { status: DoctorStatus; detail: string } {
  if (!Array.isArray(pluginEntries)) {
    return {
      status: "fail",
      detail: "plugin must be an array in opencode.json",
    };
  }

  const configDir = dirname(configPath);
  const repoPluginDir = resolve(repoRoot, "opencode-plugin");

  for (const entry of pluginEntries) {
    if (entry === "agent-smith-opencode") {
      return {
        status: "pass",
        detail: 'opencode.json directly enables "agent-smith-opencode"',
      };
    }

    if (typeof entry !== "string") {
      continue;
    }

    let rawPath = entry.startsWith("file:") ? entry.slice(5) : entry;
    rawPath = expandHome(rawPath, env);
    const resolvedPath = isAbsolute(rawPath) ? rawPath : resolve(configDir, rawPath);

    if (!existsSync(resolvedPath)) {
      continue;
    }

    if (resolve(resolvedPath) === repoPluginDir) {
      return {
        status: "pass",
        detail: `opencode.json points directly at ${repoPluginDir}`,
      };
    }

    const directPackage = readJson(join(resolvedPath, "package.json")) as {
      name?: unknown;
    } | null;
    if (directPackage?.name === "agent-smith-opencode") {
      return {
        status: "pass",
        detail: `plugin source ${resolvedPath} resolves to agent-smith-opencode`,
      };
    }

    try {
      for (const child of new Bun.Glob("*/package.json").scanSync({
        cwd: resolvedPath,
      })) {
        const pkg = readJson(join(resolvedPath, child)) as {
          name?: unknown;
        } | null;
        if (pkg?.name === "agent-smith-opencode") {
          return {
            status: "pass",
            detail: `plugin source ${resolvedPath} contains agent-smith-opencode`,
          };
        }
      }
    } catch {
      // ignore scan issues
    }
  }

  return {
    status: "fail",
    detail: 'opencode.json does not point to "agent-smith-opencode" or a plugin source containing it',
  };
}

function detectClaude(repoRoot: string, env: NodeJS.ProcessEnv): DoctorHostResult {
  const binary = "claude";
  const binaryPath = findBinary(binary, env);
  if (!binaryPath) {
    return makeSkipHost("claude", binary);
  }

  const home = homeDir(env);
  const installedPluginsPath = join(home, ".claude", "plugins", "installed_plugins.json");
  const knownMarketplacesPath = join(home, ".claude", "plugins", "known_marketplaces.json");
  const settingsPath = join(home, ".claude", "settings.json");
  const repoManifest = join(repoRoot, ".claude-plugin", "plugin.json");

  const installedPlugins = readJson(installedPluginsPath) as {
    plugins?: Record<string, unknown>;
  } | null;
  const knownMarketplaces = readJson(knownMarketplacesPath) as {
    [key: string]: { source?: { repo?: unknown } };
  } | null;
  const settings = readJson(settingsPath) as {
    enabledPlugins?: Record<string, unknown>;
  } | null;

  const pluginKey = "agent-smith@agent-smith";

  const checks: DoctorCheck[] = [
    makeCheck(
      "claude_repo_manifest",
      "Repo Claude manifest",
      existsSync(repoManifest),
      `${repoManifest} exists`,
      `${repoManifest} is missing`,
    ),
    makeCheck(
      "claude_marketplace_known",
      "Claude marketplace source",
      knownMarketplaces?.["agent-smith"]?.source?.repo === "chetmancini/agent-smith",
      "Claude knows the agent-smith marketplace source",
      "Claude marketplace source for agent-smith is missing or points elsewhere",
    ),
    makeCheck(
      "claude_plugin_installed",
      "Claude installed plugin",
      Boolean(installedPlugins?.plugins?.[pluginKey]),
      `${pluginKey} is present in installed_plugins.json`,
      `${pluginKey} is not present in ~/.claude/plugins/installed_plugins.json`,
    ),
    makeCheck(
      "claude_plugin_enabled",
      "Claude enabled plugin",
      settings?.enabledPlugins?.[pluginKey] === true,
      `${pluginKey} is enabled in ~/.claude/settings.json`,
      `${pluginKey} is not enabled in ~/.claude/settings.json`,
    ),
  ];

  const status = combineStatuses(checks.map((check) => check.status));
  return {
    host: "claude",
    binary,
    installed: true,
    binaryPath,
    status,
    summary:
      status === "pass"
        ? "Claude binary found and Agent Smith is installed and enabled"
        : "Claude binary found, but Agent Smith is not fully installed or enabled",
    checks,
  };
}

function detectCodex(repoRoot: string, env: NodeJS.ProcessEnv): DoctorHostResult {
  const binary = "codex";
  const binaryPath = findBinary(binary, env);
  if (!binaryPath) {
    return makeSkipHost("codex", binary);
  }

  const home = homeDir(env);
  const configPath = join(home, ".codex", "config.toml");
  const configText = readText(configPath) ?? "";
  const repoManifest = join(repoRoot, ".codex-plugin", "plugin.json");
  const repoHooks = join(repoRoot, ".codex", "hooks.json");

  const checks: DoctorCheck[] = [
    makeCheck(
      "codex_repo_manifest",
      "Repo Codex manifest",
      existsSync(repoManifest),
      `${repoManifest} exists`,
      `${repoManifest} is missing`,
    ),
    makeCheck(
      "codex_repo_hooks",
      "Repo Codex hooks file",
      existsSync(repoHooks),
      `${repoHooks} exists`,
      `${repoHooks} is missing`,
    ),
    makeCheck(
      "codex_config_present",
      "Codex user config",
      configText.length > 0,
      `${configPath} exists`,
      `${configPath} is missing`,
    ),
    makeCheck(
      "codex_hooks_enabled",
      "codex_hooks feature",
      configText.length > 0 && codexHooksEnabled(configText),
      "codex_hooks = true is enabled in ~/.codex/config.toml",
      "codex_hooks = true is not enabled in ~/.codex/config.toml",
    ),
    makeCheck(
      "codex_repo_trusted",
      "Trusted repo checkout",
      configText.length > 0 && codexRepoTrusted(configText, repoRoot),
      `${repoRoot} is trusted in ~/.codex/config.toml`,
      `${repoRoot} is not marked trusted in ~/.codex/config.toml`,
    ),
  ];

  const status = combineStatuses(checks.map((check) => check.status));
  return {
    host: "codex",
    binary,
    installed: true,
    binaryPath,
    status,
    summary:
      status === "pass"
        ? "Codex binary found and repo-local Agent Smith integration is ready"
        : "Codex binary found, but repo-local Agent Smith integration is incomplete",
    checks,
  };
}

function detectOpenCode(repoRoot: string, env: NodeJS.ProcessEnv): DoctorHostResult {
  const binary = "opencode";
  const binaryPath = findBinary(binary, env);
  if (!binaryPath) {
    return makeSkipHost("opencode", binary);
  }

  const home = homeDir(env);
  const configPath = join(home, ".config", "opencode", "opencode.json");
  const config = readJson(configPath) as { plugin?: unknown } | null;
  const repoPackagePath = join(repoRoot, "opencode-plugin", "package.json");
  const repoPackage = readJson(repoPackagePath) as { name?: unknown } | null;
  const pluginCheck = config
    ? opencodePluginConfigured(configPath, config.plugin, env, repoRoot)
    : {
        status: "fail" as const,
        detail: `${configPath} is missing or invalid JSON`,
      };

  const checks: DoctorCheck[] = [
    makeCheck(
      "opencode_repo_package",
      "Repo OpenCode package",
      repoPackage?.name === "agent-smith-opencode",
      `${repoPackagePath} exposes agent-smith-opencode`,
      `${repoPackagePath} is missing or does not declare agent-smith-opencode`,
    ),
    makeCheck(
      "opencode_config_present",
      "OpenCode user config",
      Boolean(config),
      `${configPath} exists`,
      `${configPath} is missing or invalid JSON`,
    ),
    {
      id: "opencode_plugin_configured",
      label: "OpenCode plugin configuration",
      status: pluginCheck.status,
      detail: pluginCheck.detail,
    },
  ];

  const status = combineStatuses(checks.map((check) => check.status));
  return {
    host: "opencode",
    binary,
    installed: true,
    binaryPath,
    status,
    summary:
      status === "pass"
        ? "OpenCode binary found and Agent Smith plugin configuration is present"
        : "OpenCode binary found, but Agent Smith plugin configuration is incomplete",
    checks,
  };
}

export function runDoctor(options?: { repoRoot?: string; env?: NodeJS.ProcessEnv }): DoctorReport {
  const env = options?.env ?? process.env;
  const repoRoot = options?.repoRoot ?? repoRootFromHere();
  const hosts = [detectClaude(repoRoot, env), detectCodex(repoRoot, env), detectOpenCode(repoRoot, env)];

  const activeStatuses = hosts.filter((host) => host.installed).map((host) => host.status);

  const overallStatus = activeStatuses.length === 0 ? "skip" : combineStatuses(activeStatuses);

  return {
    repoRoot,
    overallStatus,
    hosts,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`Agent Smith Doctor (${report.overallStatus})`);
  lines.push(`Repo root: ${report.repoRoot}`);

  for (const host of report.hosts) {
    lines.push("");
    lines.push(`${host.host}: ${host.status}`);
    lines.push(`  binary: ${host.binaryPath ?? "not installed"}`);
    lines.push(`  summary: ${host.summary}`);
    for (const check of host.checks) {
      lines.push(`  - [${check.status}] ${check.label}: ${check.detail}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
