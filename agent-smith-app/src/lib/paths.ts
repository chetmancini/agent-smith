import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentSmithPaths {
  metricsDir: string;
  eventsFile: string;
  dbFile: string;
  reportsDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): AgentSmithPaths {
  const metricsDir = env.METRICS_DIR ?? join(homedir(), ".config", "agent-smith");

  return {
    metricsDir,
    eventsFile: join(metricsDir, "events.jsonl"),
    dbFile: join(metricsDir, "rollup.db"),
    reportsDir: join(metricsDir, "reports"),
  };
}

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort only.
  }
}

export function hardenPrivateFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }

  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort only.
  }
}

export function ensureMetricsLayout(paths: AgentSmithPaths): void {
  ensurePrivateDir(paths.metricsDir);
  ensurePrivateDir(paths.reportsDir);
}
