import { createHash } from "node:crypto";

export type AgentTool = "claude" | "gemini" | "codex" | "opencode" | "pi" | "unknown";

export interface AgentSmithEvent {
  ts: string;
  tool: string;
  session_id: string;
  event_type: string;
  metadata: Record<string, unknown>;
}

export interface CreateEventInput {
  eventType: string;
  tool?: string;
  sessionId?: string;
  sessionHint?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export function deriveSessionId(seed?: string): string {
  if (seed && seed.length > 0) {
    return createHash("sha256").update(seed).digest("hex").slice(0, 12);
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `${timestamp}-${process.pid}`;
}

function normalizeTimestamp(input?: string): string {
  if (!input) {
    return new Date().toISOString();
  }

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${input}`);
  }

  return parsed.toISOString();
}

function normalizeMetadata(input?: Record<string, unknown>): Record<string, unknown> {
  if (!input) {
    return {};
  }

  if (Array.isArray(input)) {
    throw new Error("Event metadata must be a JSON object");
  }

  return input;
}

export function createEvent(input: CreateEventInput): AgentSmithEvent {
  if (!input.eventType) {
    throw new Error("eventType is required");
  }

  const sessionId = input.sessionId ?? deriveSessionId(input.sessionHint);

  return {
    ts: normalizeTimestamp(input.timestamp),
    tool: input.tool ?? "unknown",
    session_id: sessionId,
    event_type: input.eventType,
    metadata: normalizeMetadata(input.metadata),
  };
}

export function parseEventLine(line: string): AgentSmithEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const event = parsed as Partial<AgentSmithEvent>;
  if (
    typeof event.ts !== "string" ||
    typeof event.tool !== "string" ||
    typeof event.session_id !== "string" ||
    typeof event.event_type !== "string" ||
    !event.metadata ||
    typeof event.metadata !== "object" ||
    Array.isArray(event.metadata)
  ) {
    return null;
  }

  try {
    return {
      ts: new Date(event.ts).toISOString(),
      tool: event.tool,
      session_id: event.session_id,
      event_type: event.event_type,
      metadata: event.metadata,
    };
  } catch {
    return null;
  }
}

export function projectFromEvent(event: AgentSmithEvent): string | null {
  const cwd = event.metadata.cwd;
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    return null;
  }

  const trimmed = cwd.replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return null;
  }

  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
}

export function eventSnippet(event: AgentSmithEvent): string {
  const metadata = event.metadata;
  if (event.event_type === "tool_attempt") {
    const toolName = typeof metadata.tool_name === "string" ? metadata.tool_name.trim() : "";
    const detailCandidate =
      typeof metadata.command === "string" && metadata.command.trim().length > 0
        ? metadata.command.trim()
        : typeof metadata.file_path === "string" && metadata.file_path.trim().length > 0
          ? metadata.file_path.trim()
          : "";

    if (toolName.length > 0 && detailCandidate.length > 0) {
      return `${toolName} ${detailCandidate}`;
    }

    if (detailCandidate.length > 0) {
      return detailCandidate;
    }

    if (toolName.length > 0) {
      return toolName;
    }
  }

  const candidates = [
    metadata.command,
    metadata.file_path,
    metadata.error,
    metadata.prompt_snippet,
    metadata.tool_name,
    metadata.stop_reason,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return "";
}
