import { setTimeout as sleep } from "node:timers/promises";

import { eventSnippet, AgentSmithEvent, projectFromEvent } from "./events";
import { resolvePaths, AgentSmithPaths } from "./paths";
import { currentEventFileSize, matchesEvent, readAllEvents, readEventsSince } from "./store";

export interface WatchOptions {
  tool?: string;
  project?: string;
  tail?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

export async function* watchEvents(
  paths = resolvePaths(),
  options: WatchOptions = {},
): AsyncGenerator<AgentSmithEvent> {
  let offset = currentEventFileSize(paths.eventsFile);

  if (options.tail && options.tail > 0) {
    const recent = readAllEvents(paths, {
      tool: options.tool,
      project: options.project,
      limit: options.tail,
    });
    for (const event of recent) {
      yield event;
    }
  }

  while (!options.signal?.aborted) {
    const chunk = readEventsSince(paths.eventsFile, offset);
    offset = chunk.nextOffset;

    for (const event of chunk.events) {
      if (matchesEvent(event, { tool: options.tool, project: options.project })) {
        yield event;
      }
    }

    await sleep(options.pollMs ?? 1000, undefined, { signal: options.signal }).catch((error) => {
      if (options.signal?.aborted || error?.name === "AbortError") {
        return;
      }
      throw error;
    });
  }
}

export function formatWatchedEvent(event: AgentSmithEvent): string {
  const project = projectFromEvent(event) ?? "-";
  const snippet = eventSnippet(event);
  const time = event.ts.slice(11, 19);
  const session = event.session_id.slice(0, 8);
  const suffix = snippet.length > 0 ? ` ${snippet}` : "";

  return `${time} ${event.tool.padEnd(8)} ${project.padEnd(18)} ${event.event_type.padEnd(20)} ${session}${suffix}`;
}
