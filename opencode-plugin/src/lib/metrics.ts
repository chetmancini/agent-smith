/**
 * Shared metrics emission library for agent-smith
 * TypeScript port of hooks/lib/metrics.sh
 *
 * Appends structured JSONL events to ~/.config/agent-smith/events.jsonl
 * Never throws — all operations are wrapped in try/catch
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, chmodSync, unlinkSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

// Configuration - use getters for testability (env vars can be set per-test)
function isMetricsEnabled(): boolean {
  return process.env.AGENT_METRICS_ENABLED !== "0"
}

function getMetricsDir(): string {
  return process.env.METRICS_DIR ?? join(homedir(), ".config", "agent-smith")
}

function getMetricsFile(): string {
  return join(getMetricsDir(), "events.jsonl")
}

const TOOL_NAME = "opencode"

// State
let metricsSessionId: string | null = null
let sessionStartTs: number | null = null
const testFailCounts = new Map<string, number>()

/**
 * Reset all module state (for testing only)
 */
export function resetMetricsState(): void {
  metricsSessionId = null
  sessionStartTs = null
  testFailCounts.clear()
}

/**
 * Ensure metrics directory exists with proper permissions
 */
function ensureMetricsDir(): void {
  try {
    const dir = getMetricsDir()
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  } catch {
    // Silently ignore — never block the agent
  }
}

/**
 * Derive a stable session ID from a string (SHA-256 truncated to 12 chars)
 */
export function deriveSessionId(input: string): string {
  if (!input) {
    return `${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${process.pid}`
  }
  return createHash("sha256").update(input).digest("hex").slice(0, 12)
}

/**
 * Escape a string for safe JSON embedding
 * Handles backslash, double-quote, and ASCII control characters
 */
export function jsonEscape(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\x00-\x1f\x7f]/g, "") // Strip remaining control chars
}

/**
 * Truncate a string to N characters, handling split escape sequences
 */
export function truncateStr(str: string, max = 500): string {
  if (str.length <= max) return str

  let truncated = str.slice(0, max)

  // Count trailing backslashes — odd count means we split an escape sequence
  const trailingBackslashes = truncated.match(/\\+$/)
  if (trailingBackslashes && trailingBackslashes[0].length % 2 === 1) {
    truncated = truncated.slice(0, -1)
  }

  return truncated + "..."
}

/**
 * Low-level emit — appends one JSONL line
 */
export function emitMetric(eventType: string, metadata: Record<string, unknown>): void {
  if (!isMetricsEnabled()) return

  try {
    ensureMetricsDir()

    const sessionId = metricsSessionId ?? deriveSessionId("")
    const ts = new Date().toISOString()

    const line = JSON.stringify({
      ts,
      tool: TOOL_NAME,
      session_id: sessionId,
      event_type: eventType,
      metadata,
    })

    appendFileSync(getMetricsFile(), line + "\n", { mode: 0o600 })
  } catch {
    // Silently ignore — never block the agent
  }
}

/**
 * Set the current session ID and persist start timestamp
 */
export function setSessionId(sessionId: string): void {
  metricsSessionId = deriveSessionId(sessionId)
  sessionStartTs = Date.now()

  try {
    ensureMetricsDir()
    const dir = getMetricsDir()
    const stateFile = join(dir, `.current_session_${TOOL_NAME}`)
    writeFileSync(stateFile, metricsSessionId, { mode: 0o600 })

    const tsFile = join(dir, `.session_start_ts_${metricsSessionId}`)
    writeFileSync(tsFile, String(Math.floor(sessionStartTs / 1000)), { mode: 0o600 })
  } catch {
    // Silently ignore
  }
}

/**
 * Get the current session ID
 */
export function getSessionId(): string | null {
  return metricsSessionId
}

/**
 * Restore session ID from a hint or persisted state
 */
export function restoreSessionId(hint?: string): void {
  if (hint) {
    metricsSessionId = deriveSessionId(hint)
    return
  }

  // Try to load from persisted state
  try {
    const stateFile = join(getMetricsDir(), `.current_session_${TOOL_NAME}`)
    if (existsSync(stateFile)) {
      metricsSessionId = readFileSync(stateFile, "utf-8").trim()
    }
  } catch {
    // Silently ignore
  }
}

// ============================================================================
// High-level metric emitters (one per hook type)
// ============================================================================

/**
 * Emit session_start metric
 */
export function metricsOnSessionStart(
  cwd: string,
  projectType = "unknown",
  sessionHint?: string,
  transcriptPath?: string
): void {
  if (!isMetricsEnabled()) return

  if (sessionHint) {
    setSessionId(sessionHint)
  }

  const transcriptHash = transcriptPath ? deriveSessionId(transcriptPath) : ""

  emitMetric("session_start", {
    cwd: jsonEscape(cwd),
    project_type: jsonEscape(projectType),
    transcript_hash: transcriptHash,
  })
}

/**
 * Emit session_stop metric
 */
export function metricsOnSessionStop(stopReason = "unknown"): void {
  if (!isMetricsEnabled()) return

  let durationSeconds = 0

  if (sessionStartTs) {
    durationSeconds = Math.floor((Date.now() - sessionStartTs) / 1000)
  } else if (metricsSessionId) {
    // Try to read from persisted timestamp file
    try {
      const tsFile = join(getMetricsDir(), `.session_start_ts_${metricsSessionId}`)
      if (existsSync(tsFile)) {
        const startTs = parseInt(readFileSync(tsFile, "utf-8").trim(), 10)
        durationSeconds = Math.floor(Date.now() / 1000) - startTs
      }
    } catch {
      // Silently ignore
    }
  }

  emitMetric("session_stop", {
    stop_reason: jsonEscape(stopReason),
    duration_seconds: durationSeconds,
  })
}

/**
 * Emit session_error metric (OpenCode-specific — no Claude Code equivalent)
 */
export function metricsOnSessionError(error: string, context?: Record<string, unknown>): void {
  if (!isMetricsEnabled()) return

  emitMetric("session_error", {
    error: truncateStr(jsonEscape(error), 500),
    ...context,
  })
}

/**
 * Emit tool_failure metric
 */
export function metricsOnToolFailure(toolName: string, error: string, command?: string): void {
  if (!isMetricsEnabled()) return

  emitMetric("tool_failure", {
    tool_name: jsonEscape(toolName),
    error: truncateStr(jsonEscape(error), 500),
  })

  // For Bash tool failures, also emit command_failure
  if (toolName.toLowerCase() === "bash" && command) {
    emitMetric("command_failure", {
      command: truncateStr(jsonEscape(command), 300),
      error: truncateStr(jsonEscape(error), 500),
    })
  }
}

/**
 * Emit permission_denied metric
 */
export function metricsOnPermissionDenied(toolName: string): void {
  if (!isMetricsEnabled()) return

  emitMetric("permission_denied", {
    tool_name: jsonEscape(toolName),
  })
}

/**
 * Emit permission_granted metric (OpenCode-specific — tracks grants, not just denials)
 */
export function metricsOnPermissionGranted(toolName: string): void {
  if (!isMetricsEnabled()) return

  emitMetric("permission_granted", {
    tool_name: jsonEscape(toolName),
  })
}

/**
 * Emit clarifying_question metric for vague prompts
 */
export function metricsOnClarifyingQuestion(promptText: string): void {
  if (!isMetricsEnabled()) return

  emitMetric("clarifying_question", {
    prompt_snippet: truncateStr(jsonEscape(promptText), 100),
    is_vague: true,
  })
}

/**
 * Emit context_compression metric
 */
export function metricsOnContextCompression(trigger: string, transcriptLines?: number): void {
  if (!isMetricsEnabled()) return

  emitMetric("context_compression", {
    trigger: jsonEscape(trigger),
    transcript_lines: transcriptLines ?? 0,
  })

  // Invalidate cost cursor so next stop does a full rescan
  if (metricsSessionId) {
    try {
      const cursorFile = join(getMetricsDir(), `.cost_cursor_${metricsSessionId}`)
      if (existsSync(cursorFile)) {
        unlinkSync(cursorFile)
      }
    } catch {
      // Silently ignore
    }
  }
}

/**
 * Track test results and emit test_failure_loop when 3+ consecutive failures
 */
export function metricsOnTestResult(passed: boolean, testCommand: string, filePath: string): void {
  if (!isMetricsEnabled()) return

  const counterKey = metricsSessionId ?? "global"

  if (passed) {
    testFailCounts.delete(counterKey)
    return
  }

  // Increment failure counter
  const failCount = (testFailCounts.get(counterKey) ?? 0) + 1
  testFailCounts.set(counterKey, failCount)

  if (failCount >= 3) {
    emitMetric("test_failure_loop", {
      test_command: truncateStr(jsonEscape(testCommand), 300),
      failure_count: failCount,
      file_path: jsonEscape(filePath),
    })
  }
}

/**
 * Emit file_edited metric (OpenCode-specific — tracks all file edits)
 */
export function metricsOnFileEdited(filePath: string, linesChanged?: number): void {
  if (!isMetricsEnabled()) return

  emitMetric("file_edited", {
    file_path: jsonEscape(filePath),
    lines_changed: linesChanged ?? 0,
  })
}
