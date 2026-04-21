import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePaths } from "../src/lib/paths";
import { runCli } from "../src/cli";

function createIo(stdin = "") {
  let stdout = "";
  let stderr = "";

  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      readStdin: async () => stdin,
      isTTY: false,
    },
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

describe("cli", () => {
  let metricsDir: string;
  let homeDir: string;
  let repoDir: string;

  beforeEach(() => {
    metricsDir = mkdtempSync(join(tmpdir(), "agent-smith-cli-"));
    homeDir = join(metricsDir, "home");
    repoDir = join(metricsDir, "repo");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    process.env.METRICS_DIR = metricsDir;
  });

  afterEach(() => {
    delete process.env.METRICS_DIR;
    rmSync(metricsDir, { recursive: true, force: true });
  });

  test("emit writes an event", async () => {
    const { io, getStdout } = createIo();
    const exitCode = await runCli(
      [
        "emit",
        "session_start",
        "--tool",
        "codex",
        "--session-id",
        "abc123",
        "--metadata",
        '{"cwd":"/tmp/test-project"}',
      ],
      io,
    );

    expect(exitCode).toBe(0);
    const paths = resolvePaths(process.env);
    expect(existsSync(paths.eventsFile)).toBe(true);
    const lines = readFileSync(paths.eventsFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      tool: "codex",
      session_id: "abc123",
      event_type: "session_start",
    });
    expect(JSON.parse(getStdout())).toMatchObject({ ok: true });
  });

  test("emit accepts custom telemetry tool names", async () => {
    const { io } = createIo();
    const exitCode = await runCli(
      [
        "emit",
        "session_start",
        "--tool",
        "wrapper-bot",
        "--session-id",
        "custom-1",
        "--metadata",
        '{"cwd":"/tmp/test-project"}',
      ],
      io,
    );

    expect(exitCode).toBe(0);
    const paths = resolvePaths(process.env);
    const lines = readFileSync(paths.eventsFile, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      tool: "wrapper-bot",
      session_id: "custom-1",
      event_type: "session_start",
    });
  });

  test("report prints text output", async () => {
    const emitIo = createIo();
    await runCli(
      [
        "emit",
        "command_failure",
        "--tool",
        "codex",
        "--session-id",
        "report-1",
        "--metadata",
        '{"cwd":"/tmp/agent-smith","command":"npm test"}',
      ],
      emitIo.io,
    );

    const reportIo = createIo();
    const exitCode = await runCli(["report"], reportIo.io);
    expect(exitCode).toBe(0);
    expect(reportIo.getStdout()).toContain("Agent Smith Report");
    expect(reportIo.getStdout()).toContain("codex");
    expect(reportIo.getStdout()).toContain("npm test");
  });

  test("report filters by custom telemetry tool names", async () => {
    const emitIo = createIo();
    await runCli(
      [
        "emit",
        "command_failure",
        "--tool",
        "wrapper-bot",
        "--session-id",
        "report-custom",
        "--metadata",
        '{"cwd":"/tmp/agent-smith","command":"npm test"}',
      ],
      emitIo.io,
    );
    await runCli(
      [
        "emit",
        "command_failure",
        "--tool",
        "codex",
        "--session-id",
        "report-core",
        "--metadata",
        '{"cwd":"/tmp/agent-smith","command":"pnpm test"}',
      ],
      emitIo.io,
    );

    const reportIo = createIo();
    const exitCode = await runCli(["report", "--tool", "wrapper-bot", "--format", "json"], reportIo.io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(reportIo.getStdout())).toMatchObject({
      totalEvents: 1,
      totalSessions: 1,
      tools: [{ tool: "wrapper-bot", events: 1, sessions: 1 }],
    });
  });

  test("watch accepts custom telemetry tool filters", async () => {
    const emitIo = createIo();
    await runCli(
      [
        "emit",
        "command_failure",
        "--tool",
        "wrapper-bot",
        "--session-id",
        "watch-custom",
        "--metadata",
        '{"cwd":"/tmp/agent-smith","command":"npm test"}',
      ],
      emitIo.io,
    );

    const { io, getStdout } = createIo();
    const listeners = new Map<string, () => void>();
    const originalOnce = process.once;

    Object.defineProperty(process, "once", {
      configurable: true,
      value: ((event: string | symbol, listener: () => void) => {
        listeners.set(String(event), listener);
        return process;
      }) as typeof process.once,
    });

    try {
      const originalStdout = io.stdout;
      io.stdout = (text: string) => {
        originalStdout(text);
        listeners.get("SIGINT")?.();
      };

      const exitCode = await runCli(["watch", "--tool", "wrapper-bot", "--tail", "1", "--poll-ms", "10", "--json"], io);

      expect(exitCode).toBe(0);
      expect(getStdout()).toContain('"tool":"wrapper-bot"');
      expect(getStdout()).toContain('"event_type":"command_failure"');
    } finally {
      Object.defineProperty(process, "once", {
        configurable: true,
        value: originalOnce,
      });
    }
  });

  test("demo runs headless and emits artifact paths plus applied changes", async () => {
    const { io, getStdout, getStderr } = createIo();
    const demoDir = join(metricsDir, "demo-run");

    const exitCode = await runCli(["demo", "--demo-dir", demoDir, "--delay-ms", "0", "--no-watch", "--json"], io);

    expect(exitCode).toBe(0);
    expect(getStderr()).toBe("");

    const payload = JSON.parse(getStdout()) as {
      metricsDir: string;
      repoRoot: string;
      loopReport: { stopReason: string; completedRecommendationIds: string[] };
      changedFiles: string[];
      artifacts: Record<string, string>;
    };

    expect(payload.loopReport.stopReason).toBe("completed");
    expect(payload.loopReport.completedRecommendationIds).toEqual([
      "tighten-request-contract",
      "document-full-loop-demo",
    ]);
    expect(payload.changedFiles).toEqual(["AGENTS.md", "README.md"]);
    expect(readFileSync(join(payload.repoRoot, "AGENTS.md"), "utf8")).toContain("scope, target command");
    expect(readFileSync(join(payload.repoRoot, "README.md"), "utf8")).toContain("make demo");
    const events = readFileSync(join(payload.metricsDir, "events.jsonl"), "utf8");
    expect(events).toContain('"tool":"claude"');
    expect(events).toContain('"event_type":"tool_attempt"');
    expect(events).toContain('"command":"bun test"');
    expect(events).toContain('"file_path":"src/todos.ts"');
    expect(existsSync(payload.artifacts.initialReport)).toBe(true);
    expect(existsSync(payload.artifacts.improveReport)).toBe(true);
    expect(existsSync(payload.artifacts.loopReport)).toBe(true);
    expect(existsSync(payload.artifacts.finalReport)).toBe(true);
    expect(existsSync(payload.artifacts.workingLog)).toBe(true);
    expect(existsSync(payload.artifacts.summary)).toBe(true);
    expect(readFileSync(payload.artifacts.workingLog, "utf8")).toContain("Claude is running bun test");
  });

  test("watch rejects json output with tui view", async () => {
    const { io } = createIo();
    await expect(runCli(["watch", "--view", "tui", "--json"], io)).rejects.toThrow(
      "--json cannot be combined with --view tui",
    );
  });
  test("improve prints structured recommendations as json", async () => {
    const home = join(metricsDir, "home");
    const binDir = join(metricsDir, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".config", "agent-smith", "schemas"), {
      recursive: true,
    });

    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(
      join(home, ".config", "agent-smith", "schemas", "codex-config.schema.json"),
      JSON.stringify({
        type: "object",
        properties: {
          model: { type: "string" },
          permissions: { type: "object" },
        },
      }),
    );
    writeFileSync(
      join(home, ".config", "agent-smith", "schemas", "codex-config.schema.metadata.json"),
      JSON.stringify({
        tool: "codex",
        schema_url: "https://developers.openai.com/codex/config-schema.json",
        schema_path: join(home, ".config", "agent-smith", "schemas", "codex-config.schema.json"),
        fetched_at: "2026-04-20T00:00:00.000Z",
      }),
    );
    writeExecutable(
      join(binDir, "codex"),
      `#!/bin/sh
printf '%s\n' '{"summary":"Use Codex-specific reasoning output.","recommendations":[{"id":"codex-config-review","title":"Review Codex permission policy","priority":"medium","category":"config","rationale":"Empirical data suggests repeated permission friction.","evidence":["permission denials are present"],"actions":[{"type":"config_change","description":"Inspect the Codex permission policy before the failing step.","targetFiles":["'$HOME/.codex/config.toml'"],"safeToAutoApply":false}]}]}'
`,
    );

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousTool = process.env.AGENT_SMITH_TOOL;
    process.env.HOME = home;
    process.env.PATH = binDir;
    process.env.AGENT_SMITH_TOOL = "codex";

    try {
      for (const sessionId of ["improve-1", "improve-2", "improve-3"]) {
        const emitIo = createIo();
        await runCli(
          [
            "emit",
            "session_start",
            "--tool",
            "codex",
            "--session-id",
            sessionId,
            "--metadata",
            '{"cwd":"/tmp/agent-smith"}',
          ],
          emitIo.io,
        );

        await runCli(
          [
            "emit",
            "permission_denied",
            "--tool",
            "codex",
            "--session-id",
            sessionId,
            "--metadata",
            '{"cwd":"/tmp/agent-smith","command":"rm -rf build"}',
          ],
          emitIo.io,
        );

        await runCli(
          [
            "emit",
            "session_stop",
            "--tool",
            "codex",
            "--session-id",
            sessionId,
            "--metadata",
            '{"cwd":"/tmp/agent-smith","stop_reason":"end_turn","duration_seconds":8}',
          ],
          emitIo.io,
        );
      }

      const improveIo = createIo();
      const exitCode = await runCli(["improve", "--tool", "codex", "--format", "json"], improveIo.io);
      expect(exitCode).toBe(0);

      const payload = JSON.parse(improveIo.getStdout()) as {
        tool: string;
        summary: string;
        recommendations: Array<{ id: string }>;
      };
      expect(payload.tool).toBe("codex");
      expect(payload.summary).toContain("Codex");
      expect(payload.recommendations.map((item) => item.id)).toContain("codex-config-review");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousTool === undefined) {
        delete process.env.AGENT_SMITH_TOOL;
      } else {
        process.env.AGENT_SMITH_TOOL = previousTool;
      }
    }
  });

  test("paths prints json", async () => {
    const { io, getStdout } = createIo();
    const exitCode = await runCli(["paths", "--json"], io);
    expect(exitCode).toBe(0);
    expect(JSON.parse(getStdout())).toMatchObject({
      metricsDir,
      eventsFile: `${metricsDir}/events.jsonl`,
      dbFile: `${metricsDir}/rollup.db`,
    });
  });

  test("install-codex links the plugin, writes the personal marketplace, and updates codex config", async () => {
    mkdirSync(join(repoDir, ".codex-plugin"), { recursive: true });
    mkdirSync(join(repoDir, ".codex"), { recursive: true });
    writeFileSync(
      join(repoDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "agent-smith",
        version: "0.4.0",
        description: "Agent Smith",
      }),
    );
    writeFileSync(join(repoDir, ".codex", "hooks.json"), JSON.stringify({ hooks: {} }));

    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const { io, getStdout } = createIo();
      const exitCode = await runCli(["install-codex", "--repo-root", repoDir], io);
      expect(exitCode).toBe(0);
      expect(getStdout()).toContain("Codex install scaffold is ready");

      const pluginLink = join(homeDir, ".codex", "plugins", "agent-smith");
      expect(lstatSync(pluginLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(pluginLink)).toBe(repoDir);

      const marketplace = JSON.parse(readFileSync(join(homeDir, ".agents", "plugins", "marketplace.json"), "utf8")) as {
        plugins: Array<{ name: string; source: { path: string } }>;
      };
      expect(marketplace.plugins).toContainEqual(
        expect.objectContaining({
          name: "agent-smith",
          source: expect.objectContaining({ path: "./.codex/plugins/agent-smith" }),
        }),
      );

      const configText = readFileSync(join(homeDir, ".codex", "config.toml"), "utf8");
      expect(configText).toContain("[features]");
      expect(configText).toContain("codex_hooks = true");
      expect(configText).toContain(`[projects."${repoDir}"]`);
      expect(configText).toContain('trust_level = "trusted"');
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  test("refresh-schemas writes the detected tool schema without shelling out", async () => {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(join(homeDir, ".codex", "config.toml"), 'model = "gpt-5.4"\n');

    const { io, getStdout } = createIo();
    const exitCode = await runCli(["refresh-schemas"], io, {
      schema: {
        env: { ...process.env, HOME: homeDir, PATH: "" },
        cwd: repoDir,
        now: () => new Date("2026-04-20T12:00:00.000Z"),
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              type: "object",
              properties: { model: { type: "string" } },
            }),
            { status: 200 },
          ),
      },
    });

    expect(exitCode).toBe(0);
    expect(getStdout()).toContain("Refreshed Codex schema");
    expect(existsSync(join(homeDir, ".config", "agent-smith", "schemas", "codex-config.schema.json"))).toBe(true);
    expect(
      JSON.parse(
        readFileSync(join(homeDir, ".config", "agent-smith", "schemas", "codex-config.schema.metadata.json"), "utf8"),
      ),
    ).toMatchObject({
      tool: "codex",
      fetched_at: "2026-04-20T12:00:00.000Z",
    });
  });

  test("refresh-schemas caches the OpenCode schema and models.dev reference schema", async () => {
    mkdirSync(join(homeDir, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(homeDir, ".config", "opencode", "opencode.json"),
      '{ "model": "anthropic/claude-sonnet-4-6" }\n',
    );

    const fetchedUrls: string[] = [];
    const { io, getStdout } = createIo();
    const exitCode = await runCli(["refresh-schemas", "--tool", "opencode"], io, {
      schema: {
        env: { ...process.env, HOME: homeDir, PATH: "" },
        cwd: repoDir,
        now: () => new Date("2026-04-20T12:00:00.000Z"),
        fetchImpl: async (input) => {
          fetchedUrls.push(input);
          if (input === "https://opencode.ai/config.json") {
            return new Response(
              JSON.stringify({
                type: "object",
                properties: {
                  model: { $ref: "https://models.dev/model-schema.json#/$defs/Model" },
                },
              }),
              { status: 200 },
            );
          }
          if (input === "https://models.dev/model-schema.json") {
            return new Response(
              JSON.stringify({
                $defs: {
                  Model: { type: "string" },
                },
              }),
              { status: 200 },
            );
          }
          return new Response("not found", { status: 404, statusText: "Not Found" });
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(getStdout()).toContain("Refreshed OpenCode schema");
    expect(existsSync(join(homeDir, ".config", "agent-smith", "schemas", "opencode-config.schema.json"))).toBe(true);
    expect(existsSync(join(homeDir, ".config", "agent-smith", "schemas", "models-dev-model.schema.json"))).toBe(true);
    expect(fetchedUrls).toEqual(["https://opencode.ai/config.json", "https://models.dev/model-schema.json"]);
  });

  test("validate-schemas reports fallback validation details from the native CLI", async () => {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    mkdirSync(join(homeDir, ".config", "agent-smith", "schemas"), {
      recursive: true,
    });
    writeFileSync(
      join(homeDir, ".codex", "config.toml"),
      ['model = "gpt-5.4"', 'approval_policy = "on-request"', ""].join("\n"),
    );
    writeFileSync(
      join(homeDir, ".config", "agent-smith", "schemas", "codex-config.schema.json"),
      JSON.stringify({
        type: "object",
        properties: {
          model: { type: "string" },
          approval_policy: { type: "string", deprecated: true },
          sandbox_mode: { type: "string" },
        },
      }),
    );

    const { io, getStdout } = createIo();
    const exitCode = await runCli(["validate-schemas", "--tool", "codex"], io, {
      schema: {
        env: { ...process.env, HOME: homeDir, PATH: "" },
        cwd: repoDir,
        runAjv: () => ({ exitCode: -1, stdout: "", stderr: "" }),
      },
    });

    expect(exitCode).toBe(0);
    expect(getStdout()).toContain("Tool: Codex");
    expect(getStdout()).toContain("Parse: valid toml");
    expect(getStdout()).toContain("Schema check: skipped (ajv not installed); using schema diff fallback");
    expect(getStdout()).toContain("Deprecated top-level keys in use: approval_policy");
    expect(getStdout()).toContain("Available top-level schema keys not set: sandbox_mode");
  });

  test("validate-schemas passes models.dev ref to ajv for OpenCode", async () => {
    mkdirSync(join(homeDir, ".config", "opencode"), { recursive: true });
    mkdirSync(join(homeDir, ".config", "agent-smith", "schemas"), {
      recursive: true,
    });
    writeFileSync(
      join(homeDir, ".config", "opencode", "opencode.json"),
      '{ "model": "anthropic/claude-sonnet-4-6" }\n',
    );
    writeFileSync(
      join(homeDir, ".config", "agent-smith", "schemas", "opencode-config.schema.json"),
      JSON.stringify({
        type: "object",
        properties: {
          model: { $ref: "https://models.dev/model-schema.json#/$defs/Model" },
        },
      }),
    );
    writeFileSync(
      join(homeDir, ".config", "agent-smith", "schemas", "models-dev-model.schema.json"),
      JSON.stringify({
        $defs: {
          Model: { type: "string" },
        },
      }),
    );

    const ajvCalls: string[][] = [];
    const { io, getStdout } = createIo();
    const exitCode = await runCli(["validate-schemas", "--tool", "opencode"], io, {
      schema: {
        env: { ...process.env, HOME: homeDir, PATH: "" },
        cwd: repoDir,
        runAjv: (args) => {
          ajvCalls.push(args);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(getStdout()).toContain("Tool: OpenCode");
    expect(ajvCalls).toHaveLength(1);
    expect(ajvCalls[0]).toContain("-r");
    expect(ajvCalls[0]).toContain(join(homeDir, ".config", "agent-smith", "schemas", "models-dev-model.schema.json"));
  });

  test("update-settings alias returns a deterministic upgrade plan from native schema logic", async () => {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    mkdirSync(join(homeDir, ".config", "agent-smith", "schemas"), {
      recursive: true,
    });
    writeFileSync(
      join(homeDir, ".codex", "config.toml"),
      ['model = "gpt-5.4"', 'approval_policy = "on-request"', ""].join("\n"),
    );
    writeFileSync(
      join(homeDir, ".config", "agent-smith", "schemas", "codex-config.schema.json"),
      JSON.stringify({
        type: "object",
        properties: {
          model: { type: "string", description: "Primary model to use." },
          approval_policy: {
            type: "string",
            deprecated: true,
            description: "Old approval setting.",
          },
          sandbox_mode: { type: "string", description: "Sandbox policy." },
          profiles: {
            type: "object",
            description: "Named configuration profiles.",
          },
        },
      }),
    );
    writeFileSync(
      join(homeDir, ".config", "agent-smith", "schemas", "codex-config.schema.metadata.json"),
      JSON.stringify({
        tool: "codex",
        schema_url: "https://developers.openai.com/codex/config-schema.json",
        schema_path: join(homeDir, ".config", "agent-smith", "schemas", "codex-config.schema.json"),
        fetched_at: "2026-04-20T12:00:00.000Z",
      }),
    );

    const { io, getStdout } = createIo();
    const exitCode = await runCli(["update-settings", "--tool", "codex", "--no-refresh"], io, {
      schema: {
        env: { ...process.env, HOME: homeDir, PATH: "" },
        cwd: repoDir,
        runAjv: () => ({ exitCode: -1, stdout: "", stderr: "" }),
      },
    });

    expect(exitCode).toBe(0);
    expect(getStdout()).toContain("Settings Upgrade Plan");
    expect(getStdout()).toContain("approval_policy (deprecated)");
    expect(getStdout()).toContain("sandbox_mode");
    expect(getStdout()).toContain("profiles");
    expect(getStdout()).toContain("agent-smith validate-agent-config --tool codex --refresh");
  });
});
