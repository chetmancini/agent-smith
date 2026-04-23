import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { homeDir, repoRootFromHere } from "./agent-hosts";

const PI_EXTENSION_PATH = join(".pi", "extensions", "agent-smith", "index.ts");
const AGENT_SMITH_APP_PATH = join("agent-smith-app", "package.json");

export interface PiInstallPaths {
  repoRoot: string;
  repoExtensionPath: string;
  repoCommandsPath: string;
  repoSkillsPath: string;
  repoSchemaPath: string;
  piSettingsPath: string;
}

export interface PiInstallResult {
  paths: PiInstallPaths;
  changed: {
    settings: boolean;
  };
  installedSource: string;
  replacedSources: string[];
  manualSteps: string[];
}

export interface PiInstallInspection {
  settingsPath: string;
  currentRepoInstalled: boolean;
  installedSource: string | null;
  otherAgentSmithSources: string[];
  error: string | null;
}

interface PiSettings {
  packages?: unknown;
  [key: string]: unknown;
}

function findPiRepoRoot(startDir: string): string | null {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, PI_EXTENSION_PATH)) && existsSync(join(current, AGENT_SMITH_APP_PATH))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolvePiInstallPaths(
  options: { env?: NodeJS.ProcessEnv; cwd?: string; repoRoot?: string } = {},
): PiInstallPaths {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const repoRoot = resolve(options.repoRoot ?? findPiRepoRoot(cwd) ?? repoRootFromHere(env));
  const home = homeDir(env);

  return {
    repoRoot,
    repoExtensionPath: join(repoRoot, PI_EXTENSION_PATH),
    repoCommandsPath: join(repoRoot, "commands"),
    repoSkillsPath: join(repoRoot, "skills"),
    repoSchemaPath: join(repoRoot, "schemas", "pi-settings.schema.json"),
    piSettingsPath: join(home, ".pi", "agent", "settings.json"),
  };
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function readSettings(path: string): { raw: string; settings: PiSettings } {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (raw.length === 0) {
    return { raw, settings: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid Pi settings JSON: ${path}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid Pi settings JSON: ${path}`);
  }

  return {
    raw,
    settings: { ...(parsed as PiSettings) },
  };
}

function resolveConfiguredSource(settingsPath: string, source: string): string {
  return resolve(dirname(settingsPath), source);
}

export function normalizePiPackageSource(relativeSource: string): string {
  const source = relativeSource.replaceAll("\\", "/");
  if (source.length === 0) {
    return ".";
  }
  if (source.startsWith(".") || source.startsWith("/") || source.startsWith("//") || /^[A-Za-z]:\//.test(source)) {
    return source;
  }
  return `./${source}`;
}

function canonicalSource(settingsPath: string, repoRoot: string): string {
  const relativeSource = relative(dirname(settingsPath), repoRoot);
  return normalizePiPackageSource(relativeSource);
}

function looksLikeAgentSmithRepo(path: string): boolean {
  return existsSync(join(path, PI_EXTENSION_PATH)) && existsSync(join(path, AGENT_SMITH_APP_PATH));
}

export function inspectPiInstall(
  options: { env?: NodeJS.ProcessEnv; cwd?: string; repoRoot?: string } = {},
): PiInstallInspection {
  const paths = resolvePiInstallPaths(options);
  if (!existsSync(paths.piSettingsPath)) {
    return {
      settingsPath: paths.piSettingsPath,
      currentRepoInstalled: false,
      installedSource: null,
      otherAgentSmithSources: [],
      error: null,
    };
  }

  let settings: PiSettings;
  try {
    settings = readSettings(paths.piSettingsPath).settings;
  } catch (error) {
    return {
      settingsPath: paths.piSettingsPath,
      currentRepoInstalled: false,
      installedSource: null,
      otherAgentSmithSources: [],
      error: (error as Error).message,
    };
  }

  const { packages } = settings;
  if (packages !== undefined && !Array.isArray(packages)) {
    return {
      settingsPath: paths.piSettingsPath,
      currentRepoInstalled: false,
      installedSource: null,
      otherAgentSmithSources: [],
      error: `Pi settings packages must be an array: ${paths.piSettingsPath}`,
    };
  }

  const otherAgentSmithSources: string[] = [];
  let installedSource: string | null = null;
  for (const candidate of packages ?? []) {
    if (typeof candidate !== "string") {
      continue;
    }

    const resolvedSource = resolveConfiguredSource(paths.piSettingsPath, candidate);
    if (resolvedSource === paths.repoRoot) {
      installedSource = candidate;
      continue;
    }

    if (looksLikeAgentSmithRepo(resolvedSource)) {
      otherAgentSmithSources.push(candidate);
    }
  }

  return {
    settingsPath: paths.piSettingsPath,
    currentRepoInstalled: installedSource !== null,
    installedSource,
    otherAgentSmithSources,
    error: null,
  };
}

export function installPiPackage(
  options: { env?: NodeJS.ProcessEnv; cwd?: string; repoRoot?: string } = {},
): PiInstallResult {
  const paths = resolvePiInstallPaths(options);
  if (!existsSync(paths.repoExtensionPath)) {
    throw new Error(`missing Pi extension entrypoint: ${paths.repoExtensionPath}`);
  }
  if (!existsSync(paths.repoSchemaPath)) {
    throw new Error(`missing bundled Pi schema: ${paths.repoSchemaPath}`);
  }
  if (!existsSync(paths.repoCommandsPath)) {
    throw new Error(`missing Agent Smith commands: ${paths.repoCommandsPath}`);
  }
  if (!existsSync(paths.repoSkillsPath)) {
    throw new Error(`missing Agent Smith skills: ${paths.repoSkillsPath}`);
  }

  ensureDirectory(dirname(paths.piSettingsPath));

  const { raw, settings } = readSettings(paths.piSettingsPath);
  const existingPackages = settings.packages;
  if (existingPackages !== undefined && !Array.isArray(existingPackages)) {
    throw new Error(`Pi settings packages must be an array: ${paths.piSettingsPath}`);
  }

  const installedSource = canonicalSource(paths.piSettingsPath, paths.repoRoot);
  const replacedSources: string[] = [];
  const nextPackages: unknown[] = [];
  let inserted = false;

  for (const candidate of existingPackages ?? []) {
    if (typeof candidate !== "string") {
      nextPackages.push(candidate);
      continue;
    }

    const resolvedSource = resolveConfiguredSource(paths.piSettingsPath, candidate);
    if (resolvedSource === paths.repoRoot) {
      if (!inserted) {
        nextPackages.push(installedSource);
        inserted = true;
      }
      continue;
    }

    if (looksLikeAgentSmithRepo(resolvedSource)) {
      replacedSources.push(candidate);
      continue;
    }

    nextPackages.push(candidate);
  }

  if (!inserted) {
    nextPackages.push(installedSource);
  }

  settings.packages = nextPackages;
  const nextRaw = `${JSON.stringify(settings, null, 2)}\n`;
  const changed = nextRaw !== raw;
  if (changed) {
    writeFileSync(paths.piSettingsPath, nextRaw, { mode: 0o600 });
  }

  return {
    paths,
    changed: {
      settings: changed,
    },
    installedSource,
    replacedSources,
    manualSteps: [
      "Start a new Pi session so it reloads the updated package list.",
      "Run `agent-smith doctor` to verify the Pi checks.",
    ],
  };
}
