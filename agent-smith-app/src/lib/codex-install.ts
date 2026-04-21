import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { homeDir, repoRootFromHere } from "./agent-hosts";

const PLUGIN_NAME = "agent-smith";
const DEFAULT_MARKETPLACE_NAME = "local-personal-plugins";
const DEFAULT_MARKETPLACE_DISPLAY_NAME = "Local Personal Plugins";
const PERSONAL_PLUGIN_SOURCE = `./.codex/plugins/${PLUGIN_NAME}`;

export interface CodexInstallPaths {
  repoRoot: string;
  repoManifestPath: string;
  repoHooksPath: string;
  repoMarketplacePath: string;
  codexConfigPath: string;
  personalPluginPath: string;
  personalMarketplacePath: string;
}

export interface CodexInstallResult {
  paths: CodexInstallPaths;
  changed: {
    pluginLink: boolean;
    marketplace: boolean;
    config: boolean;
  };
  manualSteps: string[];
}

interface CodexManifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  author?: unknown;
  homepage?: unknown;
  repository?: unknown;
  license?: unknown;
  keywords?: unknown;
}

interface MarketplaceEntry {
  name: string;
  source: {
    source: "local";
    path: string;
  };
  policy: {
    installation: "AVAILABLE";
    authentication: "ON_INSTALL";
  };
  category: string;
  description?: string;
  version?: string;
  author?: CodexManifest["author"];
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
}

interface MarketplaceFile {
  name?: string;
  interface?: {
    displayName?: string;
  };
  plugins: MarketplaceEntry[];
  [key: string]: unknown;
}

function findPluginRoot(startDir: string): string | null {
  let current = resolve(startDir);

  for (;;) {
    if (existsSync(join(current, ".codex-plugin", "plugin.json"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveCodexInstallPaths(
  options: { env?: NodeJS.ProcessEnv; cwd?: string; repoRoot?: string } = {},
): CodexInstallPaths {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const repoRoot = resolve(options.repoRoot ?? findPluginRoot(cwd) ?? repoRootFromHere(env));
  const home = homeDir(env);

  return {
    repoRoot,
    repoManifestPath: join(repoRoot, ".codex-plugin", "plugin.json"),
    repoHooksPath: join(repoRoot, ".codex", "hooks.json"),
    repoMarketplacePath: join(repoRoot, ".agents", "plugins", "marketplace.json"),
    codexConfigPath: join(home, ".codex", "config.toml"),
    personalPluginPath: join(home, ".codex", "plugins", PLUGIN_NAME),
    personalMarketplacePath: join(home, ".agents", "plugins", "marketplace.json"),
  };
}

function readJsonFile(path: string): unknown | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readCodexManifest(path: string): CodexManifest {
  const payload = readJsonFile(path);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`invalid Codex plugin manifest: ${path}`);
  }
  return payload as CodexManifest;
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function makeBackupPath(path: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${path}.backup-${stamp}`;
}

function ensurePluginLink(paths: CodexInstallPaths): boolean {
  ensureDirectory(dirname(paths.personalPluginPath));

  if (existsSync(paths.personalPluginPath)) {
    const stats = lstatSync(paths.personalPluginPath);
    if (stats.isSymbolicLink()) {
      const target = resolve(dirname(paths.personalPluginPath), readlinkSync(paths.personalPluginPath));
      if (target === paths.repoRoot) {
        return false;
      }
    }

    renameSync(paths.personalPluginPath, makeBackupPath(paths.personalPluginPath));
  }

  symlinkSync(paths.repoRoot, paths.personalPluginPath, "dir");
  return true;
}

function serializeTomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function upsertTomlValue(text: string, header: string, key: string, value: string): string {
  const normalized = text.replaceAll("\r\n", "\n");
  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex >= 0) {
    let sectionEnd = lines.length;
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      if (/^\[[^\n]+\]$/.test(lines[index] ?? "")) {
        sectionEnd = index;
        break;
      }
    }

    for (let index = headerIndex + 1; index < sectionEnd; index += 1) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index] ?? "")) {
        const next = `${key} = ${value}`;
        if (lines[index] === next) {
          return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
        }
        lines[index] = next;
        return `${lines.join("\n").replace(/\n*$/, "\n")}`;
      }
    }

    lines.splice(sectionEnd, 0, `${key} = ${value}`);
    return `${lines.join("\n").replace(/\n*$/, "\n")}`;
  }

  const trimmed = normalized.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}${header}\n${key} = ${value}\n`;
}

function ensureCodexConfig(paths: CodexInstallPaths): boolean {
  ensureDirectory(dirname(paths.codexConfigPath));
  const original = existsSync(paths.codexConfigPath) ? readFileSync(paths.codexConfigPath, "utf8") : "";
  let next = upsertTomlValue(original, "[features]", "codex_hooks", "true");
  next = upsertTomlValue(next, `[projects.${serializeTomlString(paths.repoRoot)}]`, "trust_level", '"trusted"');

  if (next === original) {
    return false;
  }

  writeFileSync(paths.codexConfigPath, next, { mode: 0o600 });
  return true;
}

function buildMarketplaceEntry(manifest: CodexManifest): MarketplaceEntry {
  return {
    name: PLUGIN_NAME,
    source: {
      source: "local",
      path: PERSONAL_PLUGIN_SOURCE,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Coding",
    description: typeof manifest.description === "string" ? manifest.description : undefined,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
    author: typeof manifest.author === "object" && manifest.author ? manifest.author : undefined,
    homepage: typeof manifest.homepage === "string" ? manifest.homepage : undefined,
    repository: typeof manifest.repository === "string" ? manifest.repository : undefined,
    license: typeof manifest.license === "string" ? manifest.license : undefined,
    keywords: Array.isArray(manifest.keywords)
      ? manifest.keywords.filter((value): value is string => typeof value === "string")
      : undefined,
  };
}

export function personalMarketplaceHasAgentSmith(
  marketplacePath: string,
  expectedPath = PERSONAL_PLUGIN_SOURCE,
): boolean {
  const payload = readJsonFile(marketplacePath);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const plugins = (payload as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) {
    return false;
  }

  return plugins.some((plugin) => {
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
      return false;
    }
    const candidate = plugin as {
      name?: unknown;
      source?: string | { path?: unknown; source?: unknown };
    };
    if (candidate.name !== PLUGIN_NAME) {
      return false;
    }
    if (typeof candidate.source === "string") {
      return candidate.source === expectedPath;
    }
    return candidate.source?.path === expectedPath;
  });
}

export function codexPluginInstalledInCache(env: NodeJS.ProcessEnv = process.env): boolean {
  const home = homeDir(env);
  const cacheRoot = join(home, ".codex", "plugins", "cache");
  if (!existsSync(cacheRoot)) {
    return false;
  }

  try {
    for (const marketplaceName of readdirSync(cacheRoot)) {
      const manifestPath = join(cacheRoot, marketplaceName, PLUGIN_NAME, "local", ".codex-plugin", "plugin.json");
      if (existsSync(manifestPath)) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

function ensurePersonalMarketplace(paths: CodexInstallPaths, manifest: CodexManifest): boolean {
  ensureDirectory(dirname(paths.personalMarketplacePath));

  const existingRaw = existsSync(paths.personalMarketplacePath)
    ? readFileSync(paths.personalMarketplacePath, "utf8")
    : "";
  const existing = existingRaw.length > 0 ? readJsonFile(paths.personalMarketplacePath) : null;
  if (existingRaw.length > 0 && existing === null) {
    throw new Error(`invalid personal marketplace JSON: ${paths.personalMarketplacePath}`);
  }

  const marketplace: MarketplaceFile =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? ({ ...existing } as MarketplaceFile)
      : {
          name: DEFAULT_MARKETPLACE_NAME,
          interface: {
            displayName: DEFAULT_MARKETPLACE_DISPLAY_NAME,
          },
          plugins: [],
        };

  if (!Array.isArray(marketplace.plugins)) {
    throw new Error(`personal marketplace is missing a plugins array: ${paths.personalMarketplacePath}`);
  }

  if (typeof marketplace.name !== "string" || marketplace.name.trim().length === 0) {
    marketplace.name = DEFAULT_MARKETPLACE_NAME;
  }
  marketplace.interface = {
    ...(marketplace.interface ?? {}),
    displayName:
      typeof marketplace.interface?.displayName === "string" && marketplace.interface.displayName.trim().length > 0
        ? marketplace.interface.displayName
        : DEFAULT_MARKETPLACE_DISPLAY_NAME,
  };

  const entry = buildMarketplaceEntry(manifest);
  const nextPlugins = marketplace.plugins.filter((plugin) => plugin?.name !== PLUGIN_NAME);
  nextPlugins.push(entry);
  marketplace.plugins = nextPlugins;

  const nextRaw = `${JSON.stringify(marketplace, null, 2)}\n`;
  if (nextRaw === existingRaw) {
    return false;
  }

  writeFileSync(paths.personalMarketplacePath, nextRaw, { mode: 0o600 });
  return true;
}

export function installCodexPlugin(
  options: { env?: NodeJS.ProcessEnv; cwd?: string; repoRoot?: string } = {},
): CodexInstallResult {
  const paths = resolveCodexInstallPaths(options);
  if (!existsSync(paths.repoManifestPath)) {
    throw new Error(`missing Codex plugin manifest: ${paths.repoManifestPath}`);
  }
  if (!existsSync(paths.repoHooksPath)) {
    throw new Error(`missing Codex hooks file: ${paths.repoHooksPath}`);
  }

  const manifest = readCodexManifest(paths.repoManifestPath);
  const changed = {
    pluginLink: ensurePluginLink(paths),
    marketplace: ensurePersonalMarketplace(paths, manifest),
    config: ensureCodexConfig(paths),
  };

  const manualSteps = codexPluginInstalledInCache(options.env)
    ? [
        "Restart Codex so the updated marketplace and config are reloaded.",
        "Run `agent-smith doctor` to verify the Codex checks.",
      ]
    : [
        "Restart Codex so the new marketplace is discovered.",
        "Open the Plugin Directory, choose your personal marketplace, and install Agent Smith.",
        "Run `agent-smith doctor` after install to verify the Codex checks.",
      ];

  return {
    paths,
    changed,
    manualSteps,
  };
}
