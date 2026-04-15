/**
 * Test runner utility for agent-smith.
 * Delegates test target discovery to the shared repo helper used by shell hooks.
 */

import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export interface TestResult {
  found: boolean
  testFile?: string
  testCommand?: string
  passed?: boolean
  output?: string
}

interface SharedTestTarget {
  found?: boolean
  test_file?: string
  test_command?: string[]
}

const sharedHelperPath = fileURLToPath(new URL("../../../scripts/find-test-target.sh", import.meta.url))

/**
 * Find the test file and command for a given source file
 */
export function findTestForFile(filePath: string): { testFile: string; testCommand: string[] } | null {
  if (!existsSync(filePath)) return null

  try {
    const raw = execFileSync("bash", [sharedHelperPath, filePath], {
      encoding: "utf-8",
      env: process.env,
    }).trim()
    if (!raw) return null

    const result = JSON.parse(raw) as SharedTestTarget
    if (!result.found || !result.test_file || !Array.isArray(result.test_command) || result.test_command.length === 0) {
      return null
    }

    return {
      testFile: result.test_file,
      testCommand: result.test_command,
    }
  } catch {
    return null
  }
}

/**
 * Run tests for a file and return the result
 */
export async function runTestsForFile(
  filePath: string,
  $: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>
): Promise<TestResult> {
  const testInfo = findTestForFile(filePath)

  if (!testInfo) {
    return { found: false }
  }

  const { testFile, testCommand } = testInfo
  const cmdString = testCommand.join(" ")

  try {
    const result = await $(cmdString)
    const passed = result.exitCode === 0

    return {
      found: true,
      testFile,
      testCommand: cmdString,
      passed,
      output: passed ? result.stdout : result.stderr || result.stdout,
    }
  } catch (error) {
    return {
      found: true,
      testFile,
      testCommand: cmdString,
      passed: false,
      output: error instanceof Error ? error.message : String(error),
    }
  }
}
