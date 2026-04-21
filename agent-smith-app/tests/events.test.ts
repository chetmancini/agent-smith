import { describe, expect, test } from "bun:test";

import { createEvent, deriveSessionId, eventSnippet, parseEventLine, projectFromEvent } from "../src/lib/events";

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

  test("eventSnippet formats tool attempts with command or file path detail", () => {
    expect(
      eventSnippet(
        createEvent({
          eventType: "tool_attempt",
          metadata: { tool_name: "Bash", command: "bun test" },
        }),
      ),
    ).toBe("Bash bun test");

    expect(
      eventSnippet(
        createEvent({
          eventType: "tool_attempt",
          metadata: { tool_name: "Edit", file_path: "src/todos.ts" },
        }),
      ),
    ).toBe("Edit src/todos.ts");
  });
});
