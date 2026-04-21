import { describe, expect, test } from "bun:test";

import { colorizeRecentEvent } from "../src/lib/watch-tui";

describe("watch tui", () => {
  test("colorizes stop failures as failures", () => {
    expect(colorizeRecentEvent("2026-04-21T12:00:00Z stop_failure command={foo}")).toBe(
      "{red-fg}2026-04-21T12:00:00Z stop_failure command={open}foo{close}{/red-fg}",
    );
  });
});
