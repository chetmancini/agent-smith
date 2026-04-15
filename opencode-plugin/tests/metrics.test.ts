/**
 * Tests for metrics.ts
 * TypeScript port of tests/lib/metrics.bats
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// Import the functions to test
import {
  deriveSessionId,
  jsonEscape,
  truncateStr,
  emitMetric,
  setSessionId,
  getSessionId,
  metricsOnSessionStart,
  metricsOnSessionStop,
  metricsOnSessionError,
  metricsOnToolFailure,
  metricsOnPermissionDenied,
  metricsOnPermissionGranted,
  metricsOnClarifyingQuestion,
  metricsOnContextCompression,
  metricsOnTestResult,
  metricsOnFileEdited,
  resetMetricsState,
} from "../src/lib/metrics.js"

// Test helpers
let metricsDir: string
let metricsFile: string
let originalEnv: NodeJS.ProcessEnv
const shellMetricsLib = fileURLToPath(new URL("../../hooks/lib/metrics.sh", import.meta.url))

function readEvents(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) {
    return []
  }

  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function withoutTimestamps(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return events.map(({ ts: _ts, ...event }) => event)
}

describe("metrics", () => {
  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env }
    
    // Reset module state to avoid cross-test contamination
    resetMetricsState()
    
    // Create temp directory for metrics
    metricsDir = mkdtempSync(join(tmpdir(), "agent-smith-test-"))
    metricsFile = join(metricsDir, "events.jsonl")
    
    // Set env vars for testing
    process.env.METRICS_DIR = metricsDir
    process.env.AGENT_METRICS_ENABLED = "1"
    
    // Initialize session
    setSessionId("test-session-001")
  })

  afterEach(() => {
    // Restore original env
    process.env = originalEnv
    
    // Clean up temp directory
    try {
      rmSync(metricsDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  // ============================================================================
  // jsonEscape
  // ============================================================================

  describe("jsonEscape", () => {
    test("handles plain strings", () => {
      expect(jsonEscape("hello world")).toBe("hello world")
    })

    test("escapes double quotes", () => {
      expect(jsonEscape('say "hello"')).toBe('say \\"hello\\"')
    })

    test("escapes backslashes", () => {
      expect(jsonEscape("path\\to\\file")).toBe("path\\\\to\\\\file")
    })

    test("escapes newlines", () => {
      expect(jsonEscape("line1\nline2")).toBe("line1\\nline2")
    })

    test("escapes tabs", () => {
      expect(jsonEscape("col1\tcol2")).toBe("col1\\tcol2")
    })

    test("escapes carriage returns", () => {
      expect(jsonEscape("before\rafter")).toBe("before\\rafter")
    })

    test("strips other control characters", () => {
      // BEL (0x07), VT (0x0B), ESC (0x1B), DEL (0x7F)
      expect(jsonEscape("a\x07b\x0Bc\x1Bd\x7Fe")).toBe("abcde")
    })

    test("produces valid JSON with all control chars", () => {
      const nasty = 'quo"te back\\slash\nnew\rret\ttab\x07bel\x1Besc\x01soh'
      const escaped = jsonEscape(nasty)
      // Wrap in a JSON object and verify it parses
      const json = `{"v":"${escaped}"}`
      expect(() => JSON.parse(json)).not.toThrow()
    })
  })

  // ============================================================================
  // truncateStr
  // ============================================================================

  describe("truncateStr", () => {
    test("returns short strings unchanged", () => {
      expect(truncateStr("short", 500)).toBe("short")
    })

    test("truncates long strings", () => {
      const longStr = "x".repeat(600)
      expect(truncateStr(longStr, 10)).toBe("xxxxxxxxxx...")
    })

    test("defaults to 500 chars", () => {
      const longStr = "y".repeat(600)
      const result = truncateStr(longStr)
      expect(result.length).toBe(503) // 500 + "..."
    })

    test("removes dangling backslash from split escape sequence", () => {
      // Simulate json_escape'd output: 9 chars + \" = 11 chars, truncate at 10
      // cuts between \ and " leaving a dangling backslash
      const escaped = 'abcdefghi\\"rest' // \ at position 10, " at 11
      expect(truncateStr(escaped, 10)).toBe("abcdefghi...")
    })

    test("preserves valid trailing escaped backslash", () => {
      // Ends with \\\\ (two escaped backslashes = 4 chars), even count is fine
      const escaped = "abcdef\\\\\\\\"
      expect(truncateStr(escaped, 10)).toBe("abcdef\\\\\\\\")
    })

    test("produces valid JSON when cutting escaped content", () => {
      // Build a string with many escaped quotes: \"\"\"...
      let escaped = ""
      for (let i = 0; i < 100; i++) {
        escaped += '\\"'
      }
      const truncated = truncateStr(escaped, 51)
      // Verify it's valid inside a JSON string
      const json = `{"v":"${truncated}"}`
      expect(() => JSON.parse(json)).not.toThrow()
    })
  })

  // ============================================================================
  // deriveSessionId
  // ============================================================================

  describe("deriveSessionId", () => {
    test("produces consistent hash from path", () => {
      const first = deriveSessionId("/tmp/transcript-abc.jsonl")
      const second = deriveSessionId("/tmp/transcript-abc.jsonl")
      expect(first).toBe(second)
    })

    test("produces different hashes for different paths", () => {
      const hashA = deriveSessionId("/tmp/a.jsonl")
      const hashB = deriveSessionId("/tmp/b.jsonl")
      expect(hashA).not.toBe(hashB)
    })

    test("falls back to date-PID without path", () => {
      const result = deriveSessionId("")
      // Should match pattern: YYYYMMDDHHMMSS-PID
      expect(result).toMatch(/^\d{14}-\d+$/)
    })

    test("produces 12 character hex hash", () => {
      const result = deriveSessionId("/some/path")
      expect(result).toMatch(/^[0-9a-f]{12}$/)
    })
  })

  // ============================================================================
  // emitMetric (low-level)
  // ============================================================================

  describe("emitMetric", () => {
    test("creates metrics directory", () => {
      rmSync(metricsDir, { recursive: true, force: true })
      emitMetric("test_event", { key: "value" })
      expect(existsSync(metricsDir)).toBe(true)
    })

    test("writes valid JSONL", () => {
      emitMetric("test_event", { key: "value" })
      expect(existsSync(metricsFile)).toBe(true)
      
      const content = readFileSync(metricsFile, "utf-8")
      expect(() => JSON.parse(content.trim())).not.toThrow()
    })

    test("includes all required fields", () => {
      emitMetric("session_start", { cwd: "/tmp" })
      
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      expect(event.tool).toBe("opencode")
      expect(event.event_type).toBe("session_start")
      expect(event.session_id).toBeDefined()
      expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    test("preserves metadata JSON", () => {
      emitMetric("tool_failure", { tool_name: "Bash", error: "exit 1" })
      
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      expect(event.metadata.tool_name).toBe("Bash")
      expect(event.metadata.error).toBe("exit 1")
    })

    test("appends multiple events", () => {
      emitMetric("session_start", { cwd: "/tmp" })
      emitMetric("tool_failure", { tool_name: "Edit" })
      emitMetric("session_stop", { stop_reason: "end_turn" })
      
      const content = readFileSync(metricsFile, "utf-8")
      const lines = content.trim().split("\n")
      expect(lines.length).toBe(3)
    })

    test("never fails even with bad directory", () => {
      process.env.METRICS_DIR = "/nonexistent/readonly/path"
      expect(() => emitMetric("test", { key: "value" })).not.toThrow()
    })
  })

  // ============================================================================
  // Kill switch: AGENT_METRICS_ENABLED=0
  // ============================================================================

  describe("kill switch", () => {
    test("emitMetric is a no-op when AGENT_METRICS_ENABLED=0", () => {
      process.env.AGENT_METRICS_ENABLED = "0"
      emitMetric("test_event", { key: "value" })
      expect(existsSync(metricsFile)).toBe(false)
    })

    test("metricsOnSessionStart is a no-op when disabled", () => {
      process.env.AGENT_METRICS_ENABLED = "0"
      metricsOnSessionStart("/tmp", "nodejs")
      expect(existsSync(metricsFile)).toBe(false)
    })

    test("metricsOnSessionStop is a no-op when disabled", () => {
      process.env.AGENT_METRICS_ENABLED = "0"
      metricsOnSessionStop("end_turn")
      expect(existsSync(metricsFile)).toBe(false)
    })

    test("metricsOnTestResult is a no-op when disabled", () => {
      process.env.AGENT_METRICS_ENABLED = "0"
      metricsOnTestResult(false, "npm test", "src/foo.ts")
      expect(existsSync(metricsFile)).toBe(false)
    })
  })

  // ============================================================================
  // Hook-level wrappers
  // ============================================================================

  describe("metricsOnSessionStart", () => {
    test("emits session_start with cwd and project_type", () => {
      metricsOnSessionStart("/home/user/project", "nodejs", "transcript-123")
      
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      expect(event.event_type).toBe("session_start")
      expect(event.metadata.cwd).toBe("/home/user/project")
      expect(event.metadata.project_type).toBe("nodejs")
    })

    test("includes transcript_hash in metadata", () => {
      metricsOnSessionStart("/tmp", "python", "hint", "/some/transcript.jsonl")
      
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      // Should be a 12-char hex hash
      expect(event.metadata.transcript_hash).toMatch(/^[0-9a-f]{12}$/)
    })
  })

  describe("metricsOnSessionStop", () => {
    test("emits session_stop with duration", () => {
      // Start a session first
      setSessionId("duration-test")
      
      // Wait a tiny bit to ensure some duration
      metricsOnSessionStop("end_turn")
      
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      expect(event.event_type).toBe("session_stop")
      expect(event.metadata.stop_reason).toBe("end_turn")
      expect(typeof event.metadata.duration_seconds).toBe("number")
    })
  })

  describe("metricsOnSessionError", () => {
    test("emits session_error with truncated error", () => {
      metricsOnSessionError("Something went wrong")
      
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      expect(event.event_type).toBe("session_error")
      expect(event.metadata.error).toBe("Something went wrong")
    })
  })

  describe("metricsOnClarifyingQuestion", () => {
    test("emits clarifying_question with truncated prompt", () => {
      metricsOnClarifyingQuestion("fix it")
      
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      expect(event.event_type).toBe("clarifying_question")
      expect(event.metadata.prompt_snippet).toBe("fix it")
      expect(event.metadata.is_vague).toBe(true)
    })
  })

  describe("metricsOnTestResult", () => {
    test("does not emit for passing tests", () => {
      metricsOnTestResult(true, "npm test", "src/foo.ts")
      expect(existsSync(metricsFile)).toBe(false)
    })

    test("does not emit until 3 consecutive failures", () => {
      metricsOnTestResult(false, "npm test", "src/foo.ts")
      expect(existsSync(metricsFile)).toBe(false)
      
      metricsOnTestResult(false, "npm test", "src/foo.ts")
      expect(existsSync(metricsFile)).toBe(false)
    })

    test("emits test_failure_loop at 3 failures", () => {
      metricsOnTestResult(false, "npm test", "src/foo.ts")
      metricsOnTestResult(false, "npm test", "src/foo.ts")
      metricsOnTestResult(false, "npm test", "src/foo.ts")
      
      expect(existsSync(metricsFile)).toBe(true)
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      expect(event.event_type).toBe("test_failure_loop")
      expect(event.metadata.failure_count).toBe(3)
    })

    test("tracks failure loops per explicit session", () => {
      metricsOnTestResult(false, "npm test", "src/foo.ts", "session-a")
      metricsOnTestResult(false, "npm test", "src/foo.ts", "session-a")
      metricsOnTestResult(false, "npm test", "src/foo.ts", "session-b")
      expect(existsSync(metricsFile)).toBe(false)

      metricsOnTestResult(false, "npm test", "src/foo.ts", "session-a")

      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())

      expect(event.event_type).toBe("test_failure_loop")
      expect(event.session_id).toBe(deriveSessionId("session-a"))
      expect(event.metadata.failure_count).toBe(3)
    })
  })

  describe("metricsOnToolFailure", () => {
    test("emits tool_failure", () => {
      metricsOnToolFailure("Edit", "file not found")
      
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      expect(event.event_type).toBe("tool_failure")
      expect(event.metadata.tool_name).toBe("Edit")
    })

    test("emits command_failure for Bash", () => {
      metricsOnToolFailure("Bash", "exit 1", "rm -rf /oops")
      
      const content = readFileSync(metricsFile, "utf-8")
      const lines = content.trim().split("\n")
      
      // Should have 2 events: tool_failure + command_failure
      expect(lines.length).toBe(2)
      
      const commandFailure = JSON.parse(lines[1])
      expect(commandFailure.event_type).toBe("command_failure")
    })

    test("preserves the shared rich Bash failure contract", () => {
      const sessionHint = "shared-contract-session"
      const errorText = 'permission "denied"\nline 2\x07'
      const stdoutText = 'stdout "preview"\nsecond line'
      const shellRun = spawnSync(
        "bash",
        [
          "-lc",
          `source "${shellMetricsLib}"; METRICS_SESSION_ID=$(derive_session_id "$SESSION_HINT"); export METRICS_SESSION_ID; metrics_on_tool_failure "$TOOL_NAME" "$ERROR_MESSAGE" "$COMMAND" "$EXIT_CODE" "$STDERR_TEXT" "$STDOUT_TEXT" "$FILE_PATH" "$TURN_ID" "$TOOL_USE_ID"`,
        ],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            METRICS_DIR: metricsDir,
            AGENT_METRICS_ENABLED: "1",
            AGENT_SMITH_TOOL: "opencode",
            SESSION_HINT: sessionHint,
            TOOL_NAME: "Bash",
            ERROR_MESSAGE: errorText,
            COMMAND: 'npm test --grep "unit"',
            EXIT_CODE: "23",
            STDERR_TEXT: errorText,
            STDOUT_TEXT: stdoutText,
            FILE_PATH: "src/index.ts",
            TURN_ID: "turn-123",
            TOOL_USE_ID: "tool-456",
          },
        }
      )

      expect(shellRun.status).toBe(0)
      const shellEvents = withoutTimestamps(readEvents(metricsFile))

      rmSync(metricsFile, { force: true })
      resetMetricsState()
      setSessionId(sessionHint)
      metricsOnToolFailure("Bash", errorText, 'npm test --grep "unit"', {
        exitCode: 23,
        stderrText: errorText,
        stdoutText,
        filePath: "src/index.ts",
        turnId: "turn-123",
        toolUseId: "tool-456",
      })

      const nativeEvents = withoutTimestamps(readEvents(metricsFile))
      expect(nativeEvents).toEqual(shellEvents)
    })
  })

  describe("metricsOnPermissionDenied", () => {
    test("emits permission_denied", () => {
      metricsOnPermissionDenied("Write")
      
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      expect(event.event_type).toBe("permission_denied")
      expect(event.metadata.tool_name).toBe("Write")
    })

    test("preserves the shared permission_denied contract", () => {
      const sessionHint = "permission-shared-session"
      const shellRun = spawnSync(
        "bash",
        [
          "-lc",
          `source "${shellMetricsLib}"; METRICS_SESSION_ID=$(derive_session_id "$SESSION_HINT"); export METRICS_SESSION_ID; metrics_on_permission_denied "$TOOL_NAME"`,
        ],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            METRICS_DIR: metricsDir,
            AGENT_METRICS_ENABLED: "1",
            AGENT_SMITH_TOOL: "opencode",
            SESSION_HINT: sessionHint,
            TOOL_NAME: "Write",
          },
        }
      )

      expect(shellRun.status).toBe(0)
      const shellEvents = withoutTimestamps(readEvents(metricsFile))

      rmSync(metricsFile, { force: true })
      resetMetricsState()
      setSessionId(sessionHint)
      metricsOnPermissionDenied("Write")

      const nativeEvents = withoutTimestamps(readEvents(metricsFile))
      expect(nativeEvents).toEqual(shellEvents)
    })
  })

  describe("metricsOnPermissionGranted", () => {
    test("emits permission_granted (OpenCode-specific)", () => {
      metricsOnPermissionGranted("Bash")
      
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      expect(event.event_type).toBe("permission_granted")
      expect(event.metadata.tool_name).toBe("Bash")
    })
  })

  describe("metricsOnContextCompression", () => {
    test("emits context_compression event", () => {
      metricsOnContextCompression("auto", 50)
      
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      expect(event.event_type).toBe("context_compression")
      expect(event.metadata.trigger).toBe("auto")
      expect(event.metadata.transcript_lines).toBe(50)
    })
  })

  describe("metricsOnFileEdited", () => {
    test("emits file_edited (OpenCode-specific)", () => {
      metricsOnFileEdited("/src/index.ts", 42)
      
      const content = readFileSync(metricsFile, "utf-8")
      const event = JSON.parse(content.trim())
      
      expect(event.event_type).toBe("file_edited")
      expect(event.metadata.file_path).toBe("/src/index.ts")
      expect(event.metadata.lines_changed).toBe(42)
    })
  })

  describe("shared contract parity", () => {
    test("preserves the shared clarifying_question contract", () => {
      const sessionHint = "clarifying-shared-session"
      const shellRun = spawnSync(
        "bash",
        [
          "-lc",
          `source "${shellMetricsLib}"; METRICS_SESSION_ID=$(derive_session_id "$SESSION_HINT"); export METRICS_SESSION_ID; metrics_on_clarifying_question "$PROMPT_TEXT"`,
        ],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            METRICS_DIR: metricsDir,
            AGENT_METRICS_ENABLED: "1",
            AGENT_SMITH_TOOL: "opencode",
            SESSION_HINT: sessionHint,
            PROMPT_TEXT: "fix it",
          },
        }
      )

      expect(shellRun.status).toBe(0)
      const shellEvents = withoutTimestamps(readEvents(metricsFile))

      rmSync(metricsFile, { force: true })
      resetMetricsState()
      setSessionId(sessionHint)
      metricsOnClarifyingQuestion("fix it")

      const nativeEvents = withoutTimestamps(readEvents(metricsFile))
      expect(nativeEvents).toEqual(shellEvents)
    })

    test("preserves the shared test_failure_loop contract", () => {
      const sessionHint = "test-loop-shared-session"
      const shellRun = spawnSync(
        "bash",
        [
          "-lc",
          `source "${shellMetricsLib}"; METRICS_SESSION_ID=$(derive_session_id "$SESSION_HINT"); export METRICS_SESSION_ID; metrics_on_test_result 0 "$TEST_COMMAND" "$FILE_PATH"; metrics_on_test_result 0 "$TEST_COMMAND" "$FILE_PATH"; metrics_on_test_result 0 "$TEST_COMMAND" "$FILE_PATH"`,
        ],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            METRICS_DIR: metricsDir,
            AGENT_METRICS_ENABLED: "1",
            AGENT_SMITH_TOOL: "opencode",
            SESSION_HINT: sessionHint,
            TEST_COMMAND: "npm test -- foo",
            FILE_PATH: "src/foo.ts",
          },
        }
      )

      expect(shellRun.status).toBe(0)
      const shellEvents = withoutTimestamps(readEvents(metricsFile))

      rmSync(metricsFile, { force: true })
      resetMetricsState()
      setSessionId(sessionHint)
      metricsOnTestResult(false, "npm test -- foo", "src/foo.ts")
      metricsOnTestResult(false, "npm test -- foo", "src/foo.ts")
      metricsOnTestResult(false, "npm test -- foo", "src/foo.ts")

      const nativeEvents = withoutTimestamps(readEvents(metricsFile))
      expect(nativeEvents).toEqual(shellEvents)
    })
  })
})
