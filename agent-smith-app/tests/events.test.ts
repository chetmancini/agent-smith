import { describe, expect, test } from "bun:test";

import { createEvent, deriveSessionId, parseEventLine, projectFromEvent } from "../src/lib/events";

describe("events", () => {
  test("deriveSessionId is stable for a hint", () => {
    expect(deriveSessionId("same-seed")).toBe(deriveSessionId("same-seed"));
    expect(deriveSessionId("same-seed")).not.toBe(deriveSessionId("other-seed"));
  });

  test("createEvent fills defaults", () => {
    const event = createEvent({
      eventType: "session_start",
      tool: "codex",
      sessionHint: "transcript-123",
      metadata: { cwd: "/tmp/project-alpha" },
    });

    expect(event.tool).toBe("codex");
    expect(event.session_id).toHaveLength(12);
    expect(event.metadata.cwd).toBe("/tmp/project-alpha");
  });

  test("parseEventLine ignores malformed input", () => {
    expect(parseEventLine("not-json")).toBeNull();
    expect(parseEventLine("{}")).toBeNull();
  });

  test("projectFromEvent returns the cwd basename", () => {
    const event = createEvent({
      eventType: "session_start",
      metadata: { cwd: "/Users/chet/code/agent-smith/" },
    });

    expect(projectFromEvent(event)).toBe("agent-smith");
  });
});
