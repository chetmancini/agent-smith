import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";

import { type AgentSmithEvent, parseEventLine, projectFromEvent } from "./events";
import { type AgentSmithPaths, ensureMetricsLayout, hardenPrivateFile } from "./paths";

export interface EventFilters {
  tool?: string;
  project?: string;
  limit?: number;
}

export interface EventChunk {
  events: AgentSmithEvent[];
  nextOffset: number;
  skippedLines: number;
}

export function appendEvent(paths: AgentSmithPaths, event: AgentSmithEvent): void {
  ensureMetricsLayout(paths);
  appendFileSync(paths.eventsFile, `${JSON.stringify(event)}\n`, {
    mode: 0o600,
  });
  hardenPrivateFile(paths.eventsFile);
}

export function readEventsSince(eventsFile: string, offset = 0): EventChunk {
  if (!existsSync(eventsFile)) {
    return { events: [], nextOffset: 0, skippedLines: 0 };
  }

  const buffer = readFileSync(eventsFile);
  if (offset >= buffer.length) {
    return { events: [], nextOffset: buffer.length, skippedLines: 0 };
  }

  const chunk = buffer.subarray(offset);
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return { events: [], nextOffset: offset, skippedLines: 0 };
  }

  const completeChunk = chunk.subarray(0, lastNewline + 1);
  const text = completeChunk.toString("utf8");
  const lines = text.split("\n");

  const events: AgentSmithEvent[] = [];
  let skippedLines = 0;

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    const event = parseEventLine(line);
    if (!event) {
      skippedLines += 1;
      continue;
    }

    events.push(event);
  }

  return {
    events,
    nextOffset: offset + completeChunk.length,
    skippedLines,
  };
}

export function readAllEvents(paths: AgentSmithPaths, filters: EventFilters = {}): AgentSmithEvent[] {
  const { events } = readEventsSince(paths.eventsFile, 0);
  const filtered = events.filter((event) => matchesEvent(event, filters));

  if (!filters.limit || filtered.length <= filters.limit) {
    return filtered;
  }

  return filtered.slice(-filters.limit);
}

export function currentEventFileSize(eventsFile: string): number {
  if (!existsSync(eventsFile)) {
    return 0;
  }

  return statSync(eventsFile).size;
}

export function matchesEvent(event: AgentSmithEvent, filters: EventFilters = {}): boolean {
  if (filters.tool && event.tool !== filters.tool) {
    return false;
  }

  if (filters.project) {
    const project = projectFromEvent(event);
    if (project !== filters.project) {
      return false;
    }
  }

  return true;
}
