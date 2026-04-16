#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import process from "node:process";

import { createEvent } from "./lib/events";
import { resolvePaths } from "./lib/paths";
import { generateReport, renderTextReport } from "./lib/report";
import { rollupEvents } from "./lib/rollup";
import { appendEvent } from "./lib/store";
import { formatWatchedEvent, watchEvents } from "./lib/watch";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
}

class CliUsageError extends Error {}

function defaultIo(): CliIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: async () => await new Response(Bun.stdin.stream()).text(),
  };
}

function usage(): string {
  return `Usage:
  agent-smith emit <event_type> [--tool TOOL] [--session-id ID] [--session-hint TEXT] [--metadata JSON|--metadata-file FILE|--metadata-stdin]
  agent-smith rollup [--json]
  agent-smith report [--tool TOOL] [--project NAME] [--limit N] [--format text|json]
  agent-smith watch [--tool TOOL] [--project NAME] [--tail N] [--poll-ms N] [--json]
  agent-smith paths [--json]
`;
}

function shiftValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value) {
    throw new CliUsageError(`Missing value for ${flag}`);
  }
  return value;
}

function parseInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(`Invalid integer for ${flag}: ${value}`);
  }
  return parsed;
}

async function parseMetadata(args: string[], io: CliIO): Promise<Record<string, unknown>> {
  let raw = "{}";

  while (args.length > 0) {
    const flag = args[0];
    if (flag === "--metadata") {
      args.shift();
      raw = shiftValue(args, "--metadata");
    } else if (flag === "--metadata-file") {
      args.shift();
      raw = readFileSync(shiftValue(args, "--metadata-file"), "utf8");
    } else if (flag === "--metadata-stdin") {
      args.shift();
      raw = await io.readStdin();
    } else {
      break;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(`Invalid metadata JSON: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliUsageError("Metadata must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

function writeJson(io: CliIO, payload: unknown): void {
  io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
}

async function handleEmit(args: string[], io: CliIO): Promise<number> {
  const eventType = args.shift();
  if (!eventType) {
    throw new CliUsageError("emit requires an event type");
  }

  let tool: string | undefined;
  let sessionId: string | undefined;
  let sessionHint: string | undefined;
  let timestamp: string | undefined;
  let metadataSource: { kind: "inline" | "file" | "stdin"; value?: string } | null = null;

  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case "--tool":
        tool = shiftValue(args, "--tool");
        break;
      case "--session-id":
        sessionId = shiftValue(args, "--session-id");
        break;
      case "--session-hint":
        sessionHint = shiftValue(args, "--session-hint");
        break;
      case "--ts":
        timestamp = shiftValue(args, "--ts");
        break;
      case "--metadata":
        metadataSource = { kind: "inline", value: shiftValue(args, "--metadata") };
        break;
      case "--metadata-file":
        metadataSource = { kind: "file", value: shiftValue(args, "--metadata-file") };
        break;
      case "--metadata-stdin":
        metadataSource = { kind: "stdin" };
        break;
      default:
        throw new CliUsageError(`Unknown emit argument: ${flag}`);
    }
  }

  const metadataArgs: string[] = [];
  if (metadataSource?.kind === "inline") {
    metadataArgs.push("--metadata", metadataSource.value!);
  } else if (metadataSource?.kind === "file") {
    metadataArgs.push("--metadata-file", metadataSource.value!);
  } else if (metadataSource?.kind === "stdin") {
    metadataArgs.push("--metadata-stdin");
  }

  const metadata = await parseMetadata(metadataArgs, io);
  const paths = resolvePaths();
  const event = createEvent({ eventType, tool, sessionId, sessionHint, timestamp, metadata });
  appendEvent(paths, event);
  writeJson(io, { ok: true, paths, event });
  return 0;
}

function handleRollup(args: string[], io: CliIO): number {
  let json = false;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--json") {
      json = true;
      continue;
    }
    throw new CliUsageError(`Unknown rollup argument: ${flag}`);
  }

  const result = rollupEvents();
  if (json) {
    writeJson(io, result);
  } else {
    io.stdout(
      `Rolled up ${result.ingestedEvents} events, skipped ${result.skippedLines} malformed lines, next offset ${result.nextOffset}\n`,
    );
  }
  return 0;
}

function handleReport(args: string[], io: CliIO): number {
  let tool: string | undefined;
  let project: string | undefined;
  let limit = 5;
  let format: "text" | "json" = "text";

  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case "--tool":
        tool = shiftValue(args, "--tool");
        break;
      case "--project":
        project = shiftValue(args, "--project");
        break;
      case "--limit":
        limit = parseInteger(shiftValue(args, "--limit"), "--limit");
        break;
      case "--format": {
        const value = shiftValue(args, "--format");
        if (value !== "text" && value !== "json") {
          throw new CliUsageError(`Unsupported report format: ${value}`);
        }
        format = value;
        break;
      }
      default:
        throw new CliUsageError(`Unknown report argument: ${flag}`);
    }
  }

  const report = generateReport(resolvePaths(), { tool, project, limit });
  if (format === "json") {
    writeJson(io, report);
  } else {
    io.stdout(renderTextReport(report));
  }
  return 0;
}

async function handleWatch(args: string[], io: CliIO): Promise<number> {
  let tool: string | undefined;
  let project: string | undefined;
  let tail = 0;
  let pollMs = 1000;
  let json = false;

  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case "--tool":
        tool = shiftValue(args, "--tool");
        break;
      case "--project":
        project = shiftValue(args, "--project");
        break;
      case "--tail":
        tail = parseInteger(shiftValue(args, "--tail"), "--tail");
        break;
      case "--poll-ms":
        pollMs = parseInteger(shiftValue(args, "--poll-ms"), "--poll-ms");
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new CliUsageError(`Unknown watch argument: ${flag}`);
    }
  }

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());

  for await (const event of watchEvents(resolvePaths(), {
    tool,
    project,
    tail,
    pollMs,
    signal: controller.signal,
  })) {
    if (json) {
      io.stdout(`${JSON.stringify(event)}\n`);
    } else {
      io.stdout(`${formatWatchedEvent(event)}\n`);
    }
  }

  return 0;
}

function handlePaths(args: string[], io: CliIO): number {
  let json = false;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--json") {
      json = true;
      continue;
    }
    throw new CliUsageError(`Unknown paths argument: ${flag}`);
  }

  const paths = resolvePaths();
  if (json) {
    writeJson(io, paths);
  } else {
    io.stdout(`metricsDir: ${paths.metricsDir}\n`);
    io.stdout(`eventsFile: ${paths.eventsFile}\n`);
    io.stdout(`dbFile: ${paths.dbFile}\n`);
    io.stdout(`reportsDir: ${paths.reportsDir}\n`);
  }
  return 0;
}

export async function runCli(argv: string[], io: CliIO = defaultIo()): Promise<number> {
  const args = [...argv];
  const command = args.shift();

  if (!command || command === "-h" || command === "--help") {
    io.stdout(usage());
    return 0;
  }

  switch (command) {
    case "emit":
      return await handleEmit(args, io);
    case "rollup":
      return handleRollup(args, io);
    case "report":
      return handleReport(args, io);
    case "watch":
      return await handleWatch(args, io);
    case "paths":
      return handlePaths(args, io);
    default:
      throw new CliUsageError(`Unknown command: ${command}`);
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n\n${usage()}`);
      process.exitCode = 1;
      return;
    }

    throw error;
  }
}

if (import.meta.main) {
  await main();
}
