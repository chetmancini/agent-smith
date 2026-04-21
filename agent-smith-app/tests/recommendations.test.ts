import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvent } from "../src/lib/events";
import { resolvePaths } from "../src/lib/paths";
import { generateImprovementReport } from "../src/lib/recommendations";
import { appendEvent } from "../src/lib/store";

function seedSession(
  sessionId: string,
  events: Array<{ eventType: string; metadata?: Record<string, unknown> }>,
): void {
  const paths = resolvePaths(process.env);
  appendEvent(
    paths,
    createEvent({
      eventType: "session_start",
      tool: "codex",
      sessionId,
      metadata: { cwd: "/Users/chet/code/agent-smith" },
    }),
  );

  for (const entry of events) {
    appendEvent(
      paths,
      createEvent({
        eventType: entry.eventType,
        tool: "codex",
        sessionId,
        metadata: {
          cwd: "/Users/chet/code/agent-smith",
          ...entry.metadata,
        },
      }),
    );
  }

  appendEvent(
    paths,
    createEvent({
      eventType: "session_stop",
      tool: "codex",
      sessionId,
      metadata: {
        cwd: "/Users/chet/code/agent-smith",
        stop_reason: "end_turn",
        duration_seconds: 10,
      },
    }),
  );
}

describe("recommendations", () => {
  let sandbox: string;
  let metricsDir: string;
  let home: string;
  let repoRoot: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "agent-smith-recommendations-"));
    metricsDir = join(sandbox, "metrics");
    home = join(sandbox, "home");
    repoRoot = join(sandbox, "repo");
    mkdirSync(metricsDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });

    process.env.METRICS_DIR = metricsDir;
    process.env.HOME = home;

    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      ['model = "gpt-5"', "", "[features]", "codex_hooks = true", "", "[approval]", 'policy = "on-request"', ""].join(
        "\n",
      ),
    );

    const schemaDir = join(home, ".config", "agent-smith", "schemas");
    mkdirSync(schemaDir, { recursive: true });
    writeFileSync(
      join(schemaDir, "codex-config.schema.json"),
      JSON.stringify(
        {
          type: "object",
          properties: {
            model: { type: "string", description: "Model identifier to use." },
            features: { type: "object", description: "Feature toggles." },
            profiles: {
              type: "object",
              description: "Reusable execution profiles.",
            },
            permissions: {
              type: "object",
              description: "Permission policy controls.",
            },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(schemaDir, "codex-config.schema.metadata.json"),
      JSON.stringify(
        {
          tool: "codex",
          schema_url: "https://developers.openai.com/codex/config-schema.json",
          schema_path: join(schemaDir, "codex-config.schema.json"),
          fetched_at: "2026-04-20T00:00:00.000Z",
        },
        null,
        2,
      ),
    );
  });

  afterEach(() => {
    delete process.env.METRICS_DIR;
    delete process.env.HOME;
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("assembles empirical and schema evidence before asking the agent for recommendations", async () => {
    seedSession("session-1", [
      {
        eventType: "clarifying_question",
        metadata: { prompt_snippet: "fix it" },
      },
      {
        eventType: "command_failure",
        metadata: { command: "pnpm test", error: "exit 1" },
      },
    ]);
    seedSession("session-2", [{ eventType: "permission_denied", metadata: { command: "rm -rf build" } }]);
    seedSession("session-3", [
      {
        eventType: "context_compression",
        metadata: { reason: "too much context" },
      },
    ]);

    let capturedPrompt = "";

    const report = await generateImprovementReport(
      resolvePaths(process.env),
      { tool: "codex", limit: 3 },
      {
        env: process.env,
        repoRoot,
        runAgent: ({ prompt }) => {
          capturedPrompt = prompt;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary: "Codex should tighten the operator contract before changing settings.",
              recommendations: [
                {
                  id: "tighten-request-contract",
                  title: "Tighten the request contract for Codex work",
                  priority: "high",
                  category: "prompt",
                  rationale: "Clarifying prompts and failures are both showing up in a small recent sample.",
                  evidence: [
                    "clarification rate is elevated",
                    "recent failure example includes pnpm test",
                    "schema exposes permissions for policy work",
                  ],
                  actions: [
                    {
                      type: "prompt_change",
                      description: "Require a target command, scope, and validation step in the opening request.",
                      targetFiles: [join(repoRoot, "AGENTS.md")],
                      safeToAutoApply: false,
                    },
                  ],
                },
              ],
            }),
            stderr: "",
          };
        },
      },
    );

    expect(report.tool).toBe("codex");
    expect(report.summary).toContain("tighten");
    expect(report.recommendations[0]?.id).toBe("tighten-request-contract");
    expect(report.evidence.signalRates.failures.eventCount).toBe(1);
    expect(report.evidence.signalRates.clarifications.eventCount).toBe(1);
    expect(report.evidence.signalRates.permissionDenials.eventCount).toBe(1);
    expect(report.evidence.schema.topLevelKeys).toContain("permissions");
    expect(report.evidence.config.files[0]?.availableTopLevelKeys).toContain("permissions");
    expect(capturedPrompt).toContain('"signalRates"');
    expect(capturedPrompt).toContain('"schemaDescriptionByKey"');
    expect(capturedPrompt).toContain("pnpm test");
  });

  test("fails when the agent does not return valid json", async () => {
    seedSession("session-1", []);

    await expect(
      generateImprovementReport(
        resolvePaths(process.env),
        { tool: "codex" },
        {
          env: process.env,
          repoRoot,
          runAgent: () => ({
            exitCode: 0,
            stdout: "not json",
            stderr: "",
          }),
        },
      ),
    ).rejects.toThrow("JSON object");
  });

  test("passes completed recommendation context back into the next analysis prompt", async () => {
    seedSession("session-1", []);

    let capturedPrompt = "";

    await generateImprovementReport(
      resolvePaths(process.env),
      { tool: "codex" },
      {
        env: process.env,
        repoRoot,
        runAgent: ({ prompt }) => {
          capturedPrompt = prompt;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary: "No further action required.",
              recommendations: [],
            }),
            stderr: "",
          };
        },
      },
      {
        promptContext: {
          completedRecommendationIds: ["tighten-request-contract"],
          blockedRecommendationIds: ["needs-human-approval"],
          priorIterationSummaries: ["tighten-request-contract: updated operator guidance"],
        },
      },
    );

    expect(capturedPrompt).toContain('"tighten-request-contract"');
    expect(capturedPrompt).toContain('"needs-human-approval"');
    expect(capturedPrompt).toContain("updated operator guidance");
    expect(capturedPrompt).toContain("do not repeat it");
  });
});
