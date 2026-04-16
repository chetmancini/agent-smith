import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvent } from "../src/lib/events";
import { resolvePaths } from "../src/lib/paths";
import { appendEvent } from "../src/lib/store";
import { formatWatchedEvent, watchEvents } from "../src/lib/watch";

describe("watch", () => {
  let metricsDir: string;

  beforeEach(() => {
    metricsDir = mkdtempSync(join(tmpdir(), "agent-smith-watch-"));
    process.env.METRICS_DIR = metricsDir;
  });

  afterEach(() => {
    delete process.env.METRICS_DIR;
    rmSync(metricsDir, { recursive: true, force: true });
  });

  test("watch yields tailed events and follows new ones", async () => {
    const paths = resolvePaths(process.env);

    appendEvent(
      paths,
      createEvent({
        eventType: "session_start",
        tool: "codex",
        sessionId: "watch-a",
        metadata: { cwd: "/tmp/project-a" },
      }),
    );

    const controller = new AbortController();
    const iterator = watchEvents(paths, {
      tail: 1,
      pollMs: 10,
      signal: controller.signal,
    });

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.session_id).toBe("watch-a");

    appendEvent(
      paths,
      createEvent({
        eventType: "command_failure",
        tool: "codex",
        sessionId: "watch-a",
        metadata: { cwd: "/tmp/project-a", command: "npm test" },
      }),
    );

    const second = await iterator.next();
    expect(second.done).toBe(false);
    expect(second.value?.event_type).toBe("command_failure");
    expect(formatWatchedEvent(second.value!)).toContain("npm test");

    controller.abort();
  });
});
