/**
 * Agent Smith - Native OpenCode Plugin
 *
 * Self-tuning feedback loop for OpenCode. Collects session metrics,
 * analyzes patterns, and produces tuning recommendations.
 *
 * This is the native TypeScript implementation that uses OpenCode's
 * native event system, providing richer telemetry than the shell-hook shim.
 */

import type { Plugin } from "@opencode-ai/plugin"
import {
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
  setSessionId,
} from "./lib/metrics.js"
import { findTestForFile } from "./lib/test-runner.js"
import { isVaguePrompt, getClarificationNote } from "./lib/vague-prompt.js"

/**
 * Commands that are expected to fail (not real errors)
 */
const EXPECTED_FAILURE_COMMANDS = [
  /command -v/,
  /which /,
  /test -/,
  /\[ -/,
  /git rev-parse/,
  /hash /,
  /type /,
]

/**
 * Check if a bash command failure is expected (not a real error)
 */
function isExpectedFailure(command: string): boolean {
  return EXPECTED_FAILURE_COMMANDS.some((pattern) => pattern.test(command))
}

/**
 * Extract a value from a nested object path safely
 */
function getNestedValue(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function extractPatchedFilePaths(patchText: string): string[] {
  const filePaths = new Set<string>()

  for (const line of patchText.split("\n")) {
    const customPatchMatch = line.match(/^\*\*\* (?:Add|Update) File: (.+)$/)
    if (customPatchMatch) {
      filePaths.add(customPatchMatch[1])
      continue
    }

    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/)
    if (moveMatch) {
      filePaths.add(moveMatch[1])
      continue
    }

    const unifiedDiffMatch = line.match(/^\+\+\+ b\/(.+)$/)
    if (unifiedDiffMatch) {
      filePaths.add(unifiedDiffMatch[1])
    }
  }

  return [...filePaths]
}

function extractEditedFilePaths(args: Record<string, unknown> | undefined): string[] {
  const filePaths = new Set<string>()
  const directPathCandidates = [args?.filePath, args?.file_path, args?.path, args?.file]

  for (const candidate of directPathCandidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      filePaths.add(candidate)
    }
  }

  const patchText = args?.patchText ?? args?.patch_text
  if (typeof patchText === "string" && patchText.length > 0) {
    for (const filePath of extractPatchedFilePaths(patchText)) {
      filePaths.add(filePath)
    }
  }

  return [...filePaths]
}

function isPermissionGrantedResponse(response: unknown): boolean | undefined {
  if (response === "once" || response === "always") {
    return true
  }

  if (response === "reject") {
    return false
  }

  return undefined
}

type PendingPermission = {
  tool: string
  timestamp: number
}

type SessionState = {
  pendingPermissions: Map<string, PendingPermission>
  editedFiles: Set<string>
}

/**
 * Agent Smith OpenCode Plugin
 */
export const AgentSmithPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  // Log plugin initialization
  await client.app.log({
    body: {
      service: "agent-smith",
      level: "info",
      message: "Agent Smith plugin initialized",
      extra: { directory, worktree },
    },
  })

  const sessionStates = new Map<string, SessionState>()

  // Get project identifier from project object or directory
  const projectId = project?.id ?? directory.split("/").pop() ?? "unknown"

  function getSessionState(sessionId: string, create = true): SessionState | undefined {
    const existing = sessionStates.get(sessionId)
    if (existing || !create) {
      return existing
    }

    const created: SessionState = {
      pendingPermissions: new Map<string, PendingPermission>(),
      editedFiles: new Set<string>(),
    }
    sessionStates.set(sessionId, created)
    return created
  }

  return {
    /**
     * Session lifecycle and other events
     */
    event: async ({ event }) => {
      const eventType = event.type
      const props = event.properties as Record<string, unknown>
      const eventSessionId =
        (props?.sessionID as string | undefined) ??
        (props?.sessionId as string | undefined) ??
        ((props?.info as Record<string, unknown> | undefined)?.id as string | undefined)

      switch (eventType) {
        case "session.created": {
          const info = props?.info as Record<string, unknown> | undefined
          const sessionId = (info?.id as string) ?? eventSessionId ?? ""
          if (sessionId) {
            sessionStates.set(sessionId, {
              pendingPermissions: new Map<string, PendingPermission>(),
              editedFiles: new Set<string>(),
            })
          }
          setSessionId(sessionId)
          metricsOnSessionStart(directory, projectId, sessionId)

          await client.app.log({
            body: {
              service: "agent-smith",
              level: "debug",
              message: "Session started",
              extra: { sessionId, directory },
            },
          })
          break
        }

        case "session.idle": {
          metricsOnSessionStop("idle", eventSessionId)
          break
        }

        case "session.deleted": {
          metricsOnSessionStop("deleted", eventSessionId)
          if (eventSessionId) {
            sessionStates.delete(eventSessionId)
          }
          break
        }

        case "session.error": {
          const info = props?.info as Record<string, unknown> | undefined
          const error = (info?.error as string) ?? (props?.error as string) ?? "unknown"
          metricsOnSessionError(error, undefined, eventSessionId)
          metricsOnSessionStop("error", eventSessionId)
          if (eventSessionId) {
            sessionStates.delete(eventSessionId)
          }

          await client.app.log({
            body: {
              service: "agent-smith",
              level: "warn",
              message: "Session error recorded",
              extra: { error },
            },
          })
          break
        }

        case "session.compacted": {
          metricsOnContextCompression("auto", undefined, eventSessionId)

          await client.app.log({
            body: {
              service: "agent-smith",
              level: "debug",
              message: "Context compression recorded",
            },
          })
          break
        }

        // Note: permission.asked is only in v2 SDK, so we handle it via the
        // permission.ask hook below instead

        case "permission.replied": {
          const id = (props?.permissionID ?? props?.requestID ?? props?.id) as string | undefined
          const granted =
            (props?.granted as boolean | undefined) ??
            isPermissionGrantedResponse(props?.response ?? props?.reply)
          const sessionState = eventSessionId ? getSessionState(eventSessionId, false) : undefined

          if (id !== undefined && granted !== undefined && sessionState) {
            const pending = sessionState.pendingPermissions.get(id)
            if (pending) {
              if (granted) {
                metricsOnPermissionGranted(pending.tool, eventSessionId)
              } else {
                metricsOnPermissionDenied(pending.tool, eventSessionId)
              }
              sessionState.pendingPermissions.delete(id)
            }
          }
          break
        }

        case "file.edited": {
          const path = (props?.file ?? props?.path) as string | undefined
          const linesChanged = props?.linesChanged as number | undefined
          if (path) {
            metricsOnFileEdited(path, linesChanged, eventSessionId)
            if (eventSessionId) {
              getSessionState(eventSessionId)?.editedFiles.add(path)
            }
          }
          break
        }

        case "tui.prompt.append": {
          // Vague prompt detection via event system
          const text = props?.text as string | undefined
          if (text && isVaguePrompt(text)) {
            metricsOnClarifyingQuestion(text, eventSessionId)
          }
          break
        }
      }
    },

    /**
     * Permission hook — track permission asks
     */
    "permission.ask": async (input, _output) => {
      // Permission.type contains the tool name (e.g., "bash", "edit", "read")
      const toolName = input.type ?? "unknown"
      const permissionId = input.id ?? `${Date.now()}-${toolName}`
      const sessionState = getSessionState(input.sessionID)
      sessionState?.pendingPermissions.set(permissionId, { tool: toolName, timestamp: Date.now() })

      // Don't modify the output status — just observe
    },

    /**
     * Tool execution hooks — track failures and run tests
     */
    "tool.execute.after": async (input, output) => {
      const toolName = input.tool ?? "unknown"
      const args = input.args as Record<string, unknown> | undefined
      const editedFilePaths = extractEditedFilePaths(args)
      const sessionId = input.sessionID

      // Parse exit code from output.output or metadata
      // The output format is { title, output, metadata }
      let exitCode = 0
      let errorMessage = ""
      const command = input.args?.command as string ?? ""

      // Try to extract exit code from metadata or output
      const metadata = output.metadata as Record<string, unknown> | undefined
      if (metadata) {
        exitCode = (metadata.exitCode as number) ?? (metadata.exit_code as number) ?? 0
        errorMessage = (metadata.stderr as string) ?? (metadata.error as string) ?? ""
      }

      // Also check if output.output contains error indicators
      if (exitCode === 0 && output.output) {
        // Check for common error patterns in output
        if (output.output.includes("Error:") || output.output.includes("FAILED")) {
          exitCode = 1
          errorMessage = output.output.slice(0, 500)
        }
      }

      // Track failures
      if (exitCode !== 0) {
        const filePath = editedFilePaths[0]
        const turnId =
          (getNestedValue(input, "turnId") as string | undefined) ??
          (getNestedValue(input, "turn_id") as string | undefined) ??
          (getNestedValue(metadata, "turnId") as string | undefined) ??
          (getNestedValue(metadata, "turn_id") as string | undefined)
        const toolUseId =
          (getNestedValue(input, "toolUseId") as string | undefined) ??
          (getNestedValue(input, "tool_use_id") as string | undefined) ??
          (getNestedValue(input, "id") as string | undefined) ??
          (getNestedValue(metadata, "toolUseId") as string | undefined) ??
          (getNestedValue(metadata, "tool_use_id") as string | undefined)

        // Skip expected failures for bash commands
        if (toolName.toLowerCase() === "bash") {
          if (isExpectedFailure(command)) {
            return
          }
        }

        if (!errorMessage) {
          errorMessage = `exit ${exitCode}`
        }
        metricsOnToolFailure(toolName, errorMessage, command, {
          exitCode,
          stderrText: errorMessage,
          stdoutText: output.output,
          filePath,
          turnId,
          toolUseId,
        }, sessionId)
      }

      // Run tests after file edits (Edit, Write, Patch, MultiEdit, apply_patch)
      const fileEditTools = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])
      if (fileEditTools.has(toolName.toLowerCase())) {
        for (const filePath of editedFilePaths) {
          const testInfo = findTestForFile(filePath)
          if (!testInfo) {
            continue
          }

          const cmdString = testInfo.testCommand.join(" ")
          try {
            const result = await $.nothrow()`${{ raw: cmdString }}`.quiet()
            const passed = result.exitCode === 0
            metricsOnTestResult(passed, cmdString, filePath, sessionId)

            if (!passed) {
              await client.app.log({
                body: {
                  service: "agent-smith",
                  level: "warn",
                  message: `Tests failed for ${filePath}`,
                  extra: {
                    testFile: testInfo.testFile,
                    testCommand: cmdString,
                  },
                },
              })
            }
          } catch (error) {
            await client.app.log({
              body: {
                service: "agent-smith",
                level: "warn",
                message: `Failed to run post-edit tests for ${filePath}`,
                extra: {
                  testFile: testInfo.testFile,
                  testCommand: cmdString,
                  error: error instanceof Error ? error.message : String(error),
                },
              },
            })
          }
        }
      }
    },

    /**
     * Chat message hook — detect vague prompts
     */
    "chat.message": async (input, output) => {
      // Check the user message for vague prompts
      const parts = output.parts ?? []
      for (const part of parts) {
        if (part.type === "text" && typeof part.text === "string") {
          if (isVaguePrompt(part.text)) {
            metricsOnClarifyingQuestion(part.text, input.sessionID)

            // Inject clarification note as an additional part
            output.parts.push({
              type: "text",
              text: getClarificationNote(),
            } as typeof part)

            await client.app.log({
              body: {
                service: "agent-smith",
                level: "debug",
                message: "Vague prompt detected, injecting clarification note",
                extra: { promptSnippet: part.text.slice(0, 50) },
              },
            })
            break // Only inject once per message
          }
        }
      }
    },

    /**
     * Compaction hook — inject custom context for session continuity
     */
    "experimental.session.compacting": async (_input, output) => {
      const sessionState = getSessionState(_input.sessionID, false)
      // Track that compaction is happening
      metricsOnContextCompression("compacting", undefined, _input.sessionID)

      // Inject agent-smith context into compaction prompt
      output.context.push(`## Agent Smith Session Context

This session is instrumented by Agent Smith for metrics collection.
Session metrics collected so far:
- Files edited: ${sessionState?.editedFiles.size ?? 0}
- Permission requests tracked: ${sessionState?.pendingPermissions.size ?? 0} pending

Continue maintaining code quality and following project conventions.`)
    },
  }
}

// Default export for OpenCode plugin loader
export default AgentSmithPlugin
