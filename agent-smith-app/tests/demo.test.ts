import { describe, expect, test } from "bun:test";

import { buildDemoTmuxTailCommand } from "../src/lib/demo";

describe("demo", () => {
  test("builds a tmux tail command with shell-safe quoting", () => {
    expect(buildDemoTmuxTailCommand("/tmp/demo path/claude's.log")).toBe(
      "exec tail -n +1 -F '/tmp/demo path/claude'\\''s.log'",
    );
  });
});
