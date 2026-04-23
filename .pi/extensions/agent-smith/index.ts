import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
} from "@mariozechner/pi-coding-agent";

const EXTENSION_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EXTENSION_ROOT, "..", "..", "..");
const HOOKS_ROOT = join(REPO_ROOT, "hooks");
const COMMANDS_ROOT = join(REPO_ROOT, "commands");
const SKILLS_ROOT = join(REPO_ROOT, "skills");

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function transcriptPath(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? "";
}

function runHook(
  scriptName: string,
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const proc = spawnSync("bash", [join(HOOKS_ROOT, scriptName)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AGENT_SMITH_TOOL: "pi",
      ...extraEnv,
    },
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
  });

  return {
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    status: proc.status ?? 1,
  };
}

function registerAliasCommand(pi: ExtensionAPI, commandName: string, targetPrompt: string): void {
  pi.registerCommand(commandName, {
    description: `Run Agent Smith ${targetPrompt} through Pi`,
    handler: async (args) => {
      const suffix = args.trim().length > 0 ? ` ${args.trim()}` : "";
      pi.sendUserMessage(`/${commandName}${suffix}`);
    },
  });
}

function shouldTrackTool(toolName: string): boolean {
  return toolName === "bash" || toolName === "edit" || toolName === "write";
}

function toolAttemptPayload(event: ToolCallEvent, ctx: ExtensionContext): Record<string, unknown> | null {
  switch (event.toolName) {
    case "bash":
      return {
        tool_name: "run_shell_command",
        tool_input: {
          command: event.input.command,
        },
        session_id: sessionId(ctx),
        tool_use_id: event.toolCallId,
        turn_id: ctx.sessionManager.getLeafId() ?? "",
      };
    case "edit":
      return {
        tool_name: "replace",
        tool_input: {
          file_path: event.input.path,
        },
        session_id: sessionId(ctx),
        tool_use_id: event.toolCallId,
        turn_id: ctx.sessionManager.getLeafId() ?? "",
      };
    case "write":
      return {
        tool_name: "write_file",
        tool_input: {
          file_path: event.input.path,
        },
        session_id: sessionId(ctx),
        tool_use_id: event.toolCallId,
        turn_id: ctx.sessionManager.getLeafId() ?? "",
      };
    default:
      return null;
  }
}

function firstTextContent(content: ToolResultEvent["content"]): string {
  const parts = content.flatMap((item) => {
    if (item.type === "text" && typeof item.text === "string") {
      return [item.text];
    }
    return [];
  });
  return parts.join("\n").trim();
}

function toolFailurePayload(event: ToolResultEvent, ctx: ExtensionContext): Record<string, unknown> | null {
  switch (event.toolName) {
    case "bash":
      return {
        tool_name: "run_shell_command",
        tool_input: {
          command: typeof event.input.command === "string" ? event.input.command : "",
        },
        tool_response: {
          exit_code: 1,
          stderr: firstTextContent(event.content),
        },
        error: firstTextContent(event.content) || "tool execution failed",
        session_id: sessionId(ctx),
        tool_use_id: event.toolCallId,
        turn_id: ctx.sessionManager.getLeafId() ?? "",
      };
    case "edit":
      return {
        tool_name: "replace",
        tool_input: {
          file_path: typeof event.input.path === "string" ? event.input.path : "",
        },
        tool_response: {
          exit_code: 1,
          stderr: firstTextContent(event.content),
        },
        error: firstTextContent(event.content) || "tool execution failed",
        session_id: sessionId(ctx),
        tool_use_id: event.toolCallId,
        turn_id: ctx.sessionManager.getLeafId() ?? "",
      };
    case "write":
      return {
        tool_name: "write_file",
        tool_input: {
          file_path: typeof event.input.path === "string" ? event.input.path : "",
        },
        tool_response: {
          exit_code: 1,
          stderr: firstTextContent(event.content),
        },
        error: firstTextContent(event.content) || "tool execution failed",
        session_id: sessionId(ctx),
        tool_use_id: event.toolCallId,
        turn_id: ctx.sessionManager.getLeafId() ?? "",
      };
    default:
      return null;
  }
}

function testResultPayload(event: ToolResultEvent, ctx: ExtensionContext): Record<string, unknown> | null {
  switch (event.toolName) {
    case "edit":
    case "write":
      return {
        tool_input: {
          file_path: typeof event.input.path === "string" ? event.input.path : "",
        },
        session_id: sessionId(ctx),
      };
    default:
      return null;
  }
}

function onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void {
  runHook("session-start.sh", {
    cwd: ctx.cwd,
    session_id: sessionId(ctx),
    transcript_path: transcriptPath(ctx),
    reason: event.reason,
  });
}

function onTurnEnd(_event: TurnEndEvent, ctx: ExtensionContext): void {
  runHook("session-stop.sh", {
    stop_reason: "turn_complete",
    session_id: sessionId(ctx),
    transcript_path: transcriptPath(ctx),
  });
}

function onSessionShutdown(_event: SessionShutdownEvent, ctx: ExtensionContext): void {
  runHook("session-end.sh", {
    reason: "shutdown",
    session_id: sessionId(ctx),
    transcript_path: transcriptPath(ctx),
  });
  runHook("analyze-trigger.sh", {
    session_id: sessionId(ctx),
  });
}

function onSessionCompact(_event: SessionCompactEvent, ctx: ExtensionContext): void {
  // Pi's session_compact/session_before_compact events do not expose whether the
  // compaction was automatic or user-initiated, so we record an explicit
  // "unknown" trigger instead of guessing and overstating parity with Claude/Gemini.
  runHook(
    "compact.sh",
    {
      session_id: sessionId(ctx),
      transcript_path: transcriptPath(ctx),
    },
    { COMPACT_TRIGGER: "unknown" },
  );
}

function onInput(
  event: InputEvent,
  ctx: ExtensionContext,
): { action: "transform"; text: string; images?: InputEvent["images"] } | undefined {
  if (event.source === "extension" || event.text.startsWith("/") || event.text.startsWith("!")) {
    return undefined;
  }

  const result = runHook("vague-prompt.sh", {
    prompt: event.text,
    session_id: sessionId(ctx),
  });
  const note = result.stdout.trim();
  if (!note) {
    return undefined;
  }

  return {
    action: "transform",
    text: `${event.text}\n\n${note}`,
    images: event.images,
  };
}

function onToolCall(event: ToolCallEvent, ctx: ExtensionContext): void {
  if (!shouldTrackTool(event.toolName)) {
    return;
  }

  const payload = toolAttemptPayload(event, ctx);
  if (payload) {
    runHook("tool-attempt.sh", payload);
  }
}

function onToolResult(event: ToolResultEvent, ctx: ExtensionContext): void {
  if (!shouldTrackTool(event.toolName)) {
    return;
  }

  if (event.isError) {
    const failurePayload = toolFailurePayload(event, ctx);
    if (failurePayload) {
      runHook("tool-failure.sh", failurePayload);
    }
    return;
  }

  const testPayload = testResultPayload(event, ctx);
  if (testPayload) {
    runHook("test-result.sh", testPayload);
  }
}

export default function agentSmithPiExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    promptPaths: [COMMANDS_ROOT],
    skillPaths: [SKILLS_ROOT],
  }));

  registerAliasCommand(pi, "agent-smith:analyze", "analyze");
  registerAliasCommand(pi, "agent-smith:analyze-fast", "analyze-fast");
  registerAliasCommand(pi, "agent-smith:upgrade-settings", "upgrade-settings");

  pi.on("session_start", onSessionStart);
  pi.on("turn_end", onTurnEnd);
  pi.on("session_shutdown", onSessionShutdown);
  pi.on("session_compact", onSessionCompact);
  pi.on("input", onInput);
  pi.on("tool_call", onToolCall);
  pi.on("tool_result", onToolResult);
}
