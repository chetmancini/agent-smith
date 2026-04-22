import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentCommand } from "../src/lib/agent-runner";
import { detectTool, schemaCachePath, schemaUrl, validateToolName } from "../src/lib/agent-hosts";

describe("agent hosts", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validateToolName accepts gemini", () => {
    expect(validateToolName("gemini")).toBe(true);
  });

  test("detectTool accepts gemini from AGENT_SMITH_TOOL", () => {
    expect(detectTool(undefined, { AGENT_SMITH_TOOL: "gemini" }, "/tmp/repo")).toBe("gemini");
  });

  test("gemini uses the checked-in schema cache path and prompt mode runner", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "agent-smith-agent-hosts-"));
    const binDir = join(sandbox, "bin");
    tempDirs.push(sandbox);
    mkdirSync(binDir, { recursive: true });
    const geminiPath = join(binDir, "gemini");
    writeFileSync(geminiPath, "#!/bin/sh\nexit 0\n");
    chmodSync(geminiPath, 0o755);

    const env = {
      HOME: "/tmp/home",
      PATH: binDir,
    } as NodeJS.ProcessEnv;

    expect(schemaUrl("gemini")).toBe(
      "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json",
    );
    expect(schemaCachePath("gemini", env)).toBe(
      "/tmp/home/.config/agent-smith/schemas/gemini-cli-settings.schema.json",
    );
    expect(agentCommand("gemini", "review config", "/tmp/repo", env)).toEqual([geminiPath, "-p", "review config"]);
  });
});
