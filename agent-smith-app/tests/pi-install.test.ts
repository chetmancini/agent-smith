import { describe, expect, test } from "bun:test";

import { normalizePiPackageSource } from "../src/lib/pi-install";

describe("pi install", () => {
  test("preserves absolute Windows drive paths", () => {
    expect(normalizePiPackageSource("C:/repo/agent-smith")).toBe("C:/repo/agent-smith");
  });

  test("preserves absolute UNC paths", () => {
    expect(normalizePiPackageSource("//server/share/agent-smith")).toBe("//server/share/agent-smith");
  });

  test("prefixes bare relative paths", () => {
    expect(normalizePiPackageSource("repo/agent-smith")).toBe("./repo/agent-smith");
  });

  test("preserves dot-prefixed relative paths", () => {
    expect(normalizePiPackageSource("../agent-smith")).toBe("../agent-smith");
  });
});
