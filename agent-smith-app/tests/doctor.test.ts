import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { findAgentSmithRepoRoot } from "../src/lib/agent-hosts";
import { runDoctor } from "../src/lib/doctor";
import { runCli } from "../src/cli";

function writeExecutable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

function writeJson(path: string, payload: unknown): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function createIo() {
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
      readStdin: async () => "",
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("doctor", () => {
  let sandbox: string;
  let repoRoot: string;
  let home: string;
  let binDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "agent-smith-doctor-"));
    repoRoot = join(sandbox, "repo");
    home = join(sandbox, "home");
    binDir = join(sandbox, "bin");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    mkdirSync(join(repoRoot, ".claude-plugin"), { recursive: true });
    mkdirSync(join(repoRoot, ".codex-plugin"), { recursive: true });
    mkdirSync(join(repoRoot, ".agents", "plugins"), { recursive: true });
    mkdirSync(join(repoRoot, ".codex"), { recursive: true });
    mkdirSync(join(repoRoot, "hooks"), { recursive: true });
    mkdirSync(join(repoRoot, "gemini-extension", "hooks"), { recursive: true });
    mkdirSync(join(repoRoot, ".pi", "extensions", "agent-smith"), { recursive: true });
    mkdirSync(join(repoRoot, "agent-smith-app"), { recursive: true });
    mkdirSync(join(repoRoot, "opencode-plugin"), { recursive: true });
    mkdirSync(join(repoRoot, "commands"), { recursive: true });
    mkdirSync(join(repoRoot, "schemas"), { recursive: true });
    mkdirSync(join(repoRoot, "skills"), { recursive: true });

    writeJson(join(repoRoot, ".claude-plugin", "plugin.json"), {
      name: "agent-smith",
    });
    writeJson(join(repoRoot, ".codex-plugin", "plugin.json"), {
      name: "agent-smith",
    });
    writeJson(join(repoRoot, "hooks", "hooks.json"), {
      hooks: {},
    });
    writeJson(join(repoRoot, "gemini-extension", "gemini-extension.json"), {
      name: "agent-smith",
    });
    writeJson(join(repoRoot, "gemini-extension", "hooks", "hooks.json"), {
      hooks: {},
    });
    writeFileSync(join(repoRoot, ".pi", "extensions", "agent-smith", "index.ts"), "export default function () {}\n");
    writeFileSync(join(repoRoot, "commands", "analyze.md"), "# Analyze\n");
    writeJson(join(repoRoot, ".agents", "plugins", "marketplace.json"), {
      name: "agent-smith-local",
      plugins: [{ name: "agent-smith", source: { source: "local", path: "./" } }],
    });
    writeJson(join(repoRoot, ".codex", "hooks.json"), { hooks: {} });
    writeJson(join(repoRoot, "agent-smith-app", "package.json"), {
      name: "agent-smith-app",
    });
    writeJson(join(repoRoot, "opencode-plugin", "package.json"), {
      name: "agent-smith-opencode",
    });
    writeJson(join(repoRoot, "schemas", "pi-settings.schema.json"), {
      type: "object",
      properties: {},
    });
    writeFileSync(join(repoRoot, "skills", "SKILL.md"), "---\nname: test\ndescription: test\n---\n");

    env = {
      ...process.env,
      HOME: home,
      PATH: binDir,
    };
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("skips hosts with no installed binaries", () => {
    const report = runDoctor({ repoRoot, env });
    expect(report.overallStatus).toBe("skip");
    expect(report.hosts.map((host) => host.status)).toEqual(["skip", "skip", "skip", "skip", "skip"]);
  });

  test("finds the repo root when invoked from a bundled dist directory", () => {
    const distDir = join(repoRoot, "agent-smith-app", "dist");
    mkdirSync(distDir, { recursive: true });

    expect(findAgentSmithRepoRoot(distDir)).toBe(repoRoot);
  });

  test("passes when Claude, Gemini, Codex, OpenCode, and Pi are configured", () => {
    writeExecutable(join(binDir, "claude"));
    writeExecutable(join(binDir, "gemini"));
    writeExecutable(join(binDir, "codex"));
    writeExecutable(join(binDir, "opencode"));
    writeExecutable(join(binDir, "pi"));

    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {
        "agent-smith@agent-smith": [{ scope: "user", version: "0.3.0" }],
      },
    });
    writeJson(join(home, ".claude", "plugins", "known_marketplaces.json"), {
      "agent-smith": {
        source: { source: "github", repo: "chetmancini/agent-smith" },
      },
    });
    writeJson(join(home, ".claude", "settings.json"), {
      enabledPlugins: {
        "agent-smith@agent-smith": true,
      },
    });

    mkdirSync(join(home, ".gemini", "extensions", "agent-smith"), { recursive: true });
    writeJson(join(home, ".gemini", "extensions", "agent-smith", ".gemini-extension-install.json"), {
      source: resolve(repoRoot, "gemini-extension"),
      type: "link",
    });

    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `
[features]
codex_hooks = true

[projects."${resolve(repoRoot)}"]
trust_level = "trusted"
`,
    );
    mkdirSync(join(home, ".codex", "plugins", "cache", "agent-smith-local", "agent-smith", "local", ".codex-plugin"), {
      recursive: true,
    });
    writeJson(
      join(
        home,
        ".codex",
        "plugins",
        "cache",
        "agent-smith-local",
        "agent-smith",
        "local",
        ".codex-plugin",
        "plugin.json",
      ),
      { name: "agent-smith" },
    );

    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeJson(join(home, ".config", "opencode", "opencode.json"), {
      plugin: [resolve(repoRoot, "opencode-plugin")],
    });

    const report = runDoctor({ repoRoot: resolve(repoRoot), env });
    expect(report.overallStatus).toBe("pass");
    expect(report.hosts.every((host) => host.status === "pass")).toBe(true);
  });

  test("fails Gemini when the linked extension points at another checkout", () => {
    writeExecutable(join(binDir, "gemini"));
    mkdirSync(join(home, ".gemini", "extensions", "agent-smith"), { recursive: true });
    writeJson(join(home, ".gemini", "extensions", "agent-smith", ".gemini-extension-install.json"), {
      source: join(sandbox, "other-repo", "gemini-extension"),
      type: "link",
    });

    const report = runDoctor({ repoRoot: resolve(repoRoot), env });
    const gemini = report.hosts.find((host) => host.host === "gemini");
    expect(gemini?.status).toBe("fail");
    expect(gemini?.checks.find((check) => check.id === "gemini_extension_installed")?.status).toBe("fail");
  });

  test("fails Claude when the repo hooks file is missing", () => {
    writeExecutable(join(binDir, "claude"));
    rmSync(join(repoRoot, "hooks", "hooks.json"));

    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeJson(join(home, ".claude", "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {
        "agent-smith@agent-smith": [{ scope: "user", version: "0.3.0" }],
      },
    });
    writeJson(join(home, ".claude", "plugins", "known_marketplaces.json"), {
      "agent-smith": {
        source: { source: "github", repo: "chetmancini/agent-smith" },
      },
    });
    writeJson(join(home, ".claude", "settings.json"), {
      enabledPlugins: {
        "agent-smith@agent-smith": true,
      },
    });

    const report = runDoctor({ repoRoot: resolve(repoRoot), env });
    const claude = report.hosts.find((host) => host.host === "claude");
    expect(claude?.status).toBe("fail");
    expect(claude?.checks.find((check) => check.id === "claude_repo_hooks")?.status).toBe("fail");
  });

  test("passes when Codex uses a versioned plugin cache layout", () => {
    writeExecutable(join(binDir, "codex"));

    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `
[features]
codex_hooks = true

[projects."${resolve(repoRoot)}"]
trust_level = "trusted"
`,
    );
    mkdirSync(join(home, ".codex", "plugins", "agent-smith"), { recursive: true });
    mkdirSync(
      join(home, ".codex", "plugins", "cache", "local-personal-plugins", "agent-smith", "0.4.4", ".codex-plugin"),
      {
        recursive: true,
      },
    );
    writeJson(
      join(
        home,
        ".codex",
        "plugins",
        "cache",
        "local-personal-plugins",
        "agent-smith",
        "0.4.4",
        ".codex-plugin",
        "plugin.json",
      ),
      { name: "agent-smith" },
    );

    const report = runDoctor({ repoRoot: resolve(repoRoot), env });
    const codex = report.hosts.find((host) => host.host === "codex");
    expect(codex?.status).toBe("pass");
    expect(codex?.checks.find((check) => check.id === "codex_plugin_installed")?.status).toBe("pass");
  });

  test("fails Codex when hooks are not enabled", () => {
    writeExecutable(join(binDir, "codex"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `
[features]
memories = true

[projects."${resolve(repoRoot)}"]
trust_level = "trusted"
`,
    );

    const report = runDoctor({ repoRoot: resolve(repoRoot), env });
    const codex = report.hosts.find((host) => host.host === "codex");
    expect(codex?.status).toBe("fail");
    expect(codex?.checks.find((check) => check.id === "codex_hooks_enabled")?.status).toBe("fail");
  });

  test("detects OpenCode plugin from a configured plugin root directory", () => {
    writeExecutable(join(binDir, "opencode"));
    const pluginRoot = join(home, ".config", "opencode", "plugins");
    const pluginDir = join(pluginRoot, "agent-smith-opencode");
    mkdirSync(pluginDir, { recursive: true });
    writeJson(join(pluginDir, "package.json"), {
      name: "agent-smith-opencode",
    });
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeJson(join(home, ".config", "opencode", "opencode.json"), {
      plugin: [`file:${pluginRoot}`],
    });

    const report = runDoctor({ repoRoot: resolve(repoRoot), env });
    const opencode = report.hosts.find((host) => host.host === "opencode");
    expect(opencode?.status).toBe("pass");
  });

  test("passes Pi when the repo-local extension surface exists", () => {
    writeExecutable(join(binDir, "pi"));

    const report = runDoctor({ repoRoot: resolve(repoRoot), env });
    const pi = report.hosts.find((host) => host.host === "pi");
    expect(pi?.status).toBe("pass");
    expect(pi?.checks.find((check) => check.id === "pi_repo_extension")?.status).toBe("pass");
  });

  test("cli doctor --json returns nonzero on failures", async () => {
    writeExecutable(join(binDir, "codex"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nmemories = true\n");

    const io = createIo();
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = binDir;
    try {
      const exitCode = await runCli(["doctor", "--json"], io.io);
      expect(exitCode).toBe(1);
      expect(JSON.parse(io.stdout()).overallStatus).toBe("fail");
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
    }
  });
});
