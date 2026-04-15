import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { AgentSmithPlugin } from "../src/index.js"
import { deriveSessionId, resetMetricsState } from "../src/lib/metrics.js"
import { findTestForFile } from "../src/lib/test-runner.js"

type MetricEvent = {
  session_id: string
  event_type: string
  metadata: Record<string, unknown>
}

type ShellCall = {
  expressions: unknown[]
  nothrow: boolean
}

function readEvents(metricsFile: string): MetricEvent[] {
  if (!existsSync(metricsFile)) {
    return []
  }

  return readFileSync(metricsFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MetricEvent)
}

function createShellStub(exitCode: number): { $: any; calls: ShellCall[] } {
  const calls: ShellCall[] = []

  const makeShell = (useNothrow = false): any => {
    const shell = ((_: TemplateStringsArray, ...expressions: unknown[]) => {
      calls.push({ expressions, nothrow: useNothrow })

      const output = {
        exitCode,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        text: () => "",
        json: () => ({}),
        arrayBuffer: () => new ArrayBuffer(0),
        bytes: () => new Uint8Array(),
        blob: () => new Blob(),
      }

      const promise = Promise.resolve(output) as Promise<typeof output> & {
        stdin: WritableStream
        quiet(): typeof promise
        nothrow(): typeof promise
        throws(_shouldThrow: boolean): typeof promise
        cwd(_cwd: string): typeof promise
        env(_env: Record<string, string> | undefined): typeof promise
      }

      promise.stdin = new WritableStream()
      promise.quiet = () => promise
      promise.nothrow = () => promise
      promise.throws = () => promise
      promise.cwd = () => promise
      promise.env = () => promise
      return promise
    }) as any

    shell.nothrow = () => makeShell(true)
    shell.throws = () => shell
    shell.cwd = () => shell
    shell.env = () => shell
    shell.escape = (input: string) => input
    shell.braces = () => []

    return shell
  }

  return { $: makeShell(), calls }
}

async function createPluginHarness(directory: string, shellExitCode = 0) {
  const logs: unknown[] = []
  const shell = createShellStub(shellExitCode)

  const hooks = await AgentSmithPlugin({
    project: { id: "plugin-test" } as any,
    client: {
      app: {
        log: async (entry: unknown) => {
          logs.push(entry)
        },
      },
    } as any,
    $: shell.$,
    directory,
    worktree: directory,
    serverUrl: new URL("http://localhost"),
  })

  return { hooks, logs, shellCalls: shell.calls }
}

describe("AgentSmithPlugin", () => {
  let tempDir: string
  let metricsDir: string
  let metricsFile: string
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    resetMetricsState()

    tempDir = mkdtempSync(join(tmpdir(), "agent-smith-opencode-plugin-"))
    metricsDir = join(tempDir, "metrics")
    metricsFile = join(metricsDir, "events.jsonl")

    process.env.METRICS_DIR = metricsDir
    process.env.AGENT_METRICS_ENABLED = "1"
  })

  afterEach(() => {
    process.env = originalEnv
    resetMetricsState()

    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  test("tracks permission replies using permissionID and response", async () => {
    const { hooks } = await createPluginHarness(tempDir)

    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "session-1" } },
      },
    })
    await hooks["permission.ask"]?.({ id: "perm-1", type: "edit", sessionID: "session-1" }, { status: "ask" })
    await hooks.event?.({
      event: {
        type: "permission.replied",
        properties: { sessionID: "session-1", permissionID: "perm-1", response: "always" },
      },
    })

    const permissionEvent = readEvents(metricsFile).find((event) => event.event_type === "permission_granted")
    expect(permissionEvent?.metadata.tool_name).toBe("edit")
  })

  test("tracks file.edited path from the file property", async () => {
    const { hooks } = await createPluginHarness(tempDir)
    const editedFile = join(tempDir, "src", "index.ts")

    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "session-2" } },
      },
    })
    await hooks.event?.({
      event: {
        type: "file.edited",
        properties: { sessionID: "session-2", file: editedFile },
      },
    })

    const fileEditedEvent = readEvents(metricsFile).find((event) => event.event_type === "file_edited")
    expect(fileEditedEvent?.metadata.file_path).toBe(editedFile)
    expect(fileEditedEvent?.metadata.lines_changed).toBe(0)

    const output = { context: [] as string[] }
    await hooks["experimental.session.compacting"]?.({ sessionID: "session-2" }, output)
    expect(output.context[0]).toContain("Files edited: 1")
  })

  test("runs post-edit tests for apply_patch using patchText file paths", async () => {
    const srcDir = join(tempDir, "src")
    mkdirSync(srcDir, { recursive: true })

    const srcFile = join(srcDir, "widget.ts")
    const testFile = join(srcDir, "widget.test.ts")
    writeFileSync(srcFile, "export const widget = 1\n")
    writeFileSync(testFile, "import { test, expect } from \"bun:test\"\n")
    writeFileSync(join(tempDir, "package.json"), "{}\n")
    writeFileSync(join(tempDir, "vitest.config.ts"), "export default {}\n")

    const testInfo = findTestForFile(srcFile)
    expect(testInfo).not.toBeNull()

    const { hooks, shellCalls } = await createPluginHarness(tempDir, 1)
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "session-3" } },
      },
    })

    const patchText = `*** Begin Patch
*** Update File: ${srcFile}
@@
-export const widget = 1
+export const widget = 2
*** End Patch
`

    for (let index = 0; index < 3; index += 1) {
      await hooks["tool.execute.after"]?.(
        {
          tool: "apply_patch",
          sessionID: "session-3",
          callID: `call-${index}`,
          args: { patchText },
        },
        {
          title: "apply_patch",
          output: "",
          metadata: { exitCode: 0 },
        }
      )
    }

    const testLoopEvent = readEvents(metricsFile).find((event) => event.event_type === "test_failure_loop")
    expect(testLoopEvent?.metadata.file_path).toBe(srcFile)
    expect(testLoopEvent?.metadata.failure_count).toBe(3)

    expect(shellCalls).toHaveLength(3)
    for (const call of shellCalls) {
      expect(call.nothrow).toBe(true)
      expect(call.expressions[0]).toEqual({ raw: testInfo?.testCommand.join(" ") })
    }
  })

  test("tracks rejected permission replies as denied", async () => {
    const { hooks } = await createPluginHarness(tempDir)

    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "session-4" } },
      },
    })
    await hooks["permission.ask"]?.({ id: "perm-2", type: "bash", sessionID: "session-4" }, { status: "ask" })
    await hooks.event?.({
      event: {
        type: "permission.replied",
        properties: { sessionID: "session-4", permissionID: "perm-2", response: "reject" },
      },
    })

    const permissionEvent = readEvents(metricsFile).find((event) => event.event_type === "permission_denied")
    expect(permissionEvent?.metadata.tool_name).toBe("bash")
  })

  test("keeps permission tracking and compaction state isolated per session", async () => {
    const { hooks } = await createPluginHarness(tempDir)
    const sessionA = "session-a"
    const sessionB = "session-b"
    const permissionId = "perm-collision"
    const editedFile = join(tempDir, "src", "isolated.ts")

    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: sessionA } },
      },
    })
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: sessionB } },
      },
    })

    await hooks["permission.ask"]?.({ id: permissionId, type: "edit", sessionID: sessionA }, { status: "ask" })
    await hooks["permission.ask"]?.({ id: permissionId, type: "bash", sessionID: sessionB }, { status: "ask" })
    await hooks.event?.({
      event: {
        type: "file.edited",
        properties: { sessionID: sessionA, file: editedFile },
      },
    })
    await hooks.event?.({
      event: {
        type: "permission.replied",
        properties: { sessionID: sessionA, permissionID: permissionId, response: "always" },
      },
    })

    const permissionEvent = readEvents(metricsFile).find((event) => event.event_type === "permission_granted")
    expect(permissionEvent?.metadata.tool_name).toBe("edit")
    expect(permissionEvent?.session_id).toBe(deriveSessionId(sessionA))

    const outputA = { context: [] as string[] }
    const outputB = { context: [] as string[] }
    await hooks["experimental.session.compacting"]?.({ sessionID: sessionA }, outputA)
    await hooks["experimental.session.compacting"]?.({ sessionID: sessionB }, outputB)

    expect(outputA.context[0]).toContain("Files edited: 1")
    expect(outputA.context[0]).toContain("Permission requests tracked: 0 pending")
    expect(outputB.context[0]).toContain("Files edited: 0")
    expect(outputB.context[0]).toContain("Permission requests tracked: 1 pending")
  })

  test("keeps overlapping session test failures attributed to the originating session", async () => {
    const srcDir = join(tempDir, "src")
    mkdirSync(srcDir, { recursive: true })

    const srcFile = join(srcDir, "widget.ts")
    writeFileSync(srcFile, "export const widget = 1\n")
    writeFileSync(join(srcDir, "widget.test.ts"), "import { test, expect } from \"bun:test\"\n")
    writeFileSync(join(tempDir, "package.json"), "{}\n")
    writeFileSync(join(tempDir, "vitest.config.ts"), "export default {}\n")

    const { hooks } = await createPluginHarness(tempDir, 1)
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "session-primary" } },
      },
    })
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "session-secondary" } },
      },
    })

    const patchText = `*** Begin Patch
*** Update File: ${srcFile}
@@
-export const widget = 1
+export const widget = 2
*** End Patch
`

    for (let index = 0; index < 3; index += 1) {
      await hooks["tool.execute.after"]?.(
        {
          tool: "apply_patch",
          sessionID: "session-primary",
          callID: `call-primary-${index}`,
          args: { patchText },
        },
        {
          title: "apply_patch",
          output: "",
          metadata: { exitCode: 0 },
        }
      )
    }

    const testLoopEvent = readEvents(metricsFile).find((event) => event.event_type === "test_failure_loop")
    expect(testLoopEvent?.session_id).toBe(deriveSessionId("session-primary"))
    expect(testLoopEvent?.metadata.file_path).toBe(srcFile)
  })
})
