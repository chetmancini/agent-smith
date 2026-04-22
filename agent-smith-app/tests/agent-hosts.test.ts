import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentCommand } from "../src/lib/agent-runner";
import { detectTool, schemaCachePath, schemaUrl, toolConfigCandidates, validateToolName } from "../src/lib/agent-hosts";

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

  test("validateToolName accepts pi", () => {
    expect(validateToolName("pi")).toBe(true);
  });

  test("detectTool accepts gemini from AGENT_SMITH_TOOL", () => {
    expect(detectTool(undefined, { AGENT_SMITH_TOOL: "gemini" }, "/tmp/repo")).toBe("gemini");
  });

  test("detectTool accepts pi from AGENT_SMITH_TOOL", () => {
    expect(detectTool(undefined, { AGENT_SMITH_TOOL: "pi" }, "/tmp/repo")).toBe("pi");
  });

  test("gemini config candidates honor GEMINI_CLI_HOME and empty override falls back to HOME", () => {
    expect(
      toolConfigCandidates(
        "gemini",
        { HOME: "/tmp/home", GEMINI_CLI_HOME: "/tmp/gemini-home" } as NodeJS.ProcessEnv,
        "/tmp/repo",
      ),
    ).toEqual(["/tmp/gemini-home/settings.json", "/tmp/repo/.gemini/settings.json"]);

    expect(
      toolConfigCandidates("gemini", { HOME: "/tmp/home", GEMINI_CLI_HOME: "" } as NodeJS.ProcessEnv, "/tmp/repo"),
    ).toEqual(["/tmp/home/.gemini/settings.json", "/tmp/repo/.gemini/settings.json"]);
  });

  test("detectTool finds gemini config from GEMINI_CLI_HOME", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "agent-smith-agent-hosts-"));
    const geminiHome = join(sandbox, "custom-gemini-home");
    tempDirs.push(sandbox);
    mkdirSync(geminiHome, { recursive: true });
    writeFileSync(join(geminiHome, "settings.json"), "{}\n");

    expect(
      detectTool(undefined, {
        HOME: join(sandbox, "home"),
        GEMINI_CLI_HOME: geminiHome,
        PATH: "",
      } as NodeJS.ProcessEnv),
    ).toBe("gemini");
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

  test("pi uses the bundled schema cache path and prompt mode runner", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "agent-smith-agent-hosts-"));
    const binDir = join(sandbox, "bin");
    tempDirs.push(sandbox);
    mkdirSync(binDir, { recursive: true });
    const piPath = join(binDir, "pi");
    writeFileSync(piPath, "#!/bin/sh\nexit 0\n");
    chmodSync(piPath, 0o755);

    const env = {
      HOME: "/tmp/home",
      PATH: binDir,
    } as NodeJS.ProcessEnv;

    expect(schemaUrl("pi")).toBe("bundled://schemas/pi-settings.schema.json");
    expect(schemaCachePath("pi", env)).toBe("/tmp/home/.config/agent-smith/schemas/pi-settings.schema.json");
    expect(agentCommand("pi", "review config", "/tmp/repo", env)).toEqual([piPath, "-p", "review config"]);
  });
});
