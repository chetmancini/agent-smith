import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
