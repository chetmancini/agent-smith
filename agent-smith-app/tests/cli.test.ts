import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  beforeEach(() => {
    metricsDir = mkdtempSync(join(tmpdir(), "agent-smith-cli-"));
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

  test("improve prints structured recommendations as json", async () => {
    const home = join(metricsDir, "home");
    const binDir = join(metricsDir, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".config", "agent-smith", "schemas"), { recursive: true });

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
});
