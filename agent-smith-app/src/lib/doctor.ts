import { accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { repoRootFromHere } from "./agent-hosts";
import { codexPluginInstalledInCache, personalMarketplaceHasAgentSmith } from "./codex-install";
import { createTerminalTheme, type TerminalTheme } from "./terminal-theme";

export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorHostResult {
  host: "claude" | "gemini" | "codex" | "opencode" | "pi";
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
  const repoHooks = join(repoRoot, "hooks", "hooks.json");

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
      "claude_repo_hooks",
      "Repo Claude hooks file",
      existsSync(repoHooks),
      `${repoHooks} exists`,
      `${repoHooks} is missing`,
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
  const repoMarketplace = join(repoRoot, ".agents", "plugins", "marketplace.json");
  const personalPluginPath = join(home, ".codex", "plugins", "agent-smith");
  const personalMarketplacePath = join(home, ".agents", "plugins", "marketplace.json");
  const installSurfaceReady =
    existsSync(repoMarketplace) ||
    (existsSync(personalPluginPath) && personalMarketplaceHasAgentSmith(personalMarketplacePath));

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
      "codex_plugin_install_surface",
      "Codex plugin marketplace",
      installSurfaceReady,
      existsSync(repoMarketplace)
        ? `${repoMarketplace} is available for repo-scoped install`
        : `${personalMarketplacePath} points to ${personalPluginPath}`,
      `Add a repo marketplace at ${repoMarketplace} or run agent-smith install-codex`,
    ),
    makeCheck(
      "codex_plugin_installed",
      "Installed Codex plugin",
      codexPluginInstalledInCache(env),
      "Agent Smith is installed for Codex",
      "Agent Smith is not installed yet; open the Plugin Directory and install it from the marketplace",
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
        ? "Codex binary found and Agent Smith is installed and ready"
        : "Codex binary found, but Agent Smith still needs Codex setup or install steps",
    checks,
  };
}

function geminiExtensionConfigured(
  installPath: string,
  installPayload: unknown,
  repoRoot: string,
): { status: DoctorStatus; detail: string } {
  if (!installPayload || typeof installPayload !== "object" || Array.isArray(installPayload)) {
    return {
      status: "fail",
      detail: `${installPath} is missing or invalid JSON`,
    };
  }

  const source = (installPayload as { source?: unknown }).source;
  if (typeof source !== "string" || source.trim().length === 0) {
    return {
      status: "fail",
      detail: `${installPath} does not record an extension source path`,
    };
  }

  const repoExtensionDir = resolve(repoRoot, "gemini-extension");
  const configuredSource = resolve(source);
  if (configuredSource !== repoExtensionDir) {
    return {
      status: "fail",
      detail: `Gemini points at ${configuredSource}, not ${repoExtensionDir}`,
    };
  }

  const installType = (installPayload as { type?: unknown }).type;
  const installMode = typeof installType === "string" && installType.trim().length > 0 ? installType : "install";
  return {
    status: "pass",
    detail: `Gemini ${installMode} source points at ${repoExtensionDir}`,
  };
}

function detectGemini(repoRoot: string, env: NodeJS.ProcessEnv): DoctorHostResult {
  const binary = "gemini";
  const binaryPath = findBinary(binary, env);
  if (!binaryPath) {
    return makeSkipHost("gemini", binary);
  }

  const home = homeDir(env);
  const repoManifest = join(repoRoot, "gemini-extension", "gemini-extension.json");
  const repoHooks = join(repoRoot, "gemini-extension", "hooks", "hooks.json");
  const installPath = join(home, ".gemini", "extensions", "agent-smith", ".gemini-extension-install.json");
  const installCheck = geminiExtensionConfigured(installPath, readJson(installPath), repoRoot);

  const checks: DoctorCheck[] = [
    makeCheck(
      "gemini_repo_manifest",
      "Repo Gemini extension manifest",
      existsSync(repoManifest),
      `${repoManifest} exists`,
      `${repoManifest} is missing`,
    ),
    makeCheck(
      "gemini_repo_hooks",
      "Repo Gemini hooks file",
      existsSync(repoHooks),
      `${repoHooks} exists`,
      `${repoHooks} is missing`,
    ),
    {
      id: "gemini_extension_installed",
      label: "Gemini extension link",
      status: installCheck.status,
      detail:
        installCheck.status === "pass"
          ? installCheck.detail
          : `${installCheck.detail}; run \`gemini extensions link ./gemini-extension\` from the repo root`,
    },
  ];

  const status = combineStatuses(checks.map((check) => check.status));
  return {
    host: "gemini",
    binary,
    installed: true,
    binaryPath,
    status,
    summary:
      status === "pass"
        ? "Gemini binary found and Agent Smith extension is linked to this checkout"
        : "Gemini binary found, but Agent Smith still needs the Gemini extension linked from this checkout",
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

function detectPi(repoRoot: string, env: NodeJS.ProcessEnv): DoctorHostResult {
  const binary = "pi";
  const binaryPath = findBinary(binary, env);
  if (!binaryPath) {
    return makeSkipHost("pi", binary);
  }

  const repoExtension = join(repoRoot, ".pi", "extensions", "agent-smith", "index.ts");
  const repoSchema = join(repoRoot, "schemas", "pi-settings.schema.json");
  const repoCommands = join(repoRoot, "commands");
  const repoSkills = join(repoRoot, "skills");

  const checks: DoctorCheck[] = [
    makeCheck(
      "pi_repo_extension",
      "Repo Pi extension",
      existsSync(repoExtension),
      `${repoExtension} exists`,
      `${repoExtension} is missing`,
    ),
    makeCheck(
      "pi_repo_schema",
      "Bundled Pi settings schema",
      existsSync(repoSchema),
      `${repoSchema} exists`,
      `${repoSchema} is missing`,
    ),
    makeCheck(
      "pi_repo_commands",
      "Repo Agent Smith prompts",
      existsSync(repoCommands),
      `${repoCommands} exists for Pi prompt discovery`,
      `${repoCommands} is missing`,
    ),
    makeCheck(
      "pi_repo_skills",
      "Repo Agent Smith skills",
      existsSync(repoSkills),
      `${repoSkills} exists for Pi skill discovery`,
      `${repoSkills} is missing`,
    ),
  ];

  const status = combineStatuses(checks.map((check) => check.status));
  return {
    host: "pi",
    binary,
    installed: true,
    binaryPath,
    status,
    summary:
      status === "pass"
        ? "Pi binary found and Agent Smith's repo-local Pi extension is ready"
        : "Pi binary found, but the repo-local Agent Smith Pi extension surface is incomplete",
    checks,
  };
}

export function runDoctor(options?: { repoRoot?: string; env?: NodeJS.ProcessEnv }): DoctorReport {
  const env = options?.env ?? process.env;
  const repoRoot = options?.repoRoot ?? repoRootFromHere();
  const hosts = [
    detectClaude(repoRoot, env),
    detectGemini(repoRoot, env),
    detectCodex(repoRoot, env),
    detectOpenCode(repoRoot, env),
    detectPi(repoRoot, env),
  ];

  const activeStatuses = hosts.filter((host) => host.installed).map((host) => host.status);

  const overallStatus = activeStatuses.length === 0 ? "skip" : combineStatuses(activeStatuses);

  return {
    repoRoot,
    overallStatus,
    hosts,
  };
}

function doctorStatusTone(status: DoctorStatus): "success" | "warning" | "danger" | "muted" {
  switch (status) {
    case "pass":
      return "success";
    case "warn":
      return "warning";
    case "fail":
      return "danger";
    case "skip":
      return "muted";
  }
}

export function renderDoctorReport(report: DoctorReport, theme: TerminalTheme = createTerminalTheme()): string {
  const lines: string[] = [];
  lines.push(
    `${theme.bold(theme.accent("Agent Smith Doctor"))} ${theme.tone(`(${report.overallStatus})`, doctorStatusTone(report.overallStatus))}`,
  );
  lines.push(`${theme.dim("Repo root:")} ${report.repoRoot}`);

  for (const host of report.hosts) {
    lines.push("");
    lines.push(`${theme.accent(host.host)}: ${theme.tone(host.status, doctorStatusTone(host.status))}`);
    lines.push(`  ${theme.dim("binary:")} ${host.binaryPath ?? "not installed"}`);
    lines.push(`  ${theme.dim("summary:")} ${host.summary}`);
    for (const check of host.checks) {
      lines.push(
        `  - ${theme.tone(`[${check.status}]`, doctorStatusTone(check.status))} ${check.label}: ${check.detail}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
