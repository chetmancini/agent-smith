/**
 * Test runner utility for agent-smith
 * TypeScript port of hooks/test-result.sh
 *
 * Finds and runs tests corresponding to edited source files
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, basename, extname, join } from "node:path"
import { execSync } from "node:child_process"

export interface TestResult {
  found: boolean
  testFile?: string
  testCommand?: string
  passed?: boolean
  output?: string
}

/**
 * Check if a file is itself a test file
 */
function isTestFile(filePath: string): boolean {
  const ext = extname(filePath)
  const stem = basename(filePath, ext)
  const dir = dirname(filePath)

  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
      return /\.(test|spec)$/.test(stem) || /__tests__/.test(dir)

    case ".py":
      return /^test_|_test$/.test(stem)

    case ".go":
      return /_test$/.test(stem)

    case ".rb":
      return /_spec$|_test$/.test(stem)

    default:
      return false
  }
}

/**
 * Find the first existing file from a list of candidates
 */
function findTestFile(candidates: string[]): string | undefined {
  return candidates.find((c) => existsSync(c))
}

/**
 * Detect the project root by looking for common config files
 */
function findProjectRoot(startDir: string): string {
  let dir = startDir
  while (dir !== "/") {
    if (
      existsSync(join(dir, "package.json")) ||
      existsSync(join(dir, "Cargo.toml")) ||
      existsSync(join(dir, "go.mod")) ||
      existsSync(join(dir, ".git"))
    ) {
      return dir
    }
    dir = dirname(dir)
  }
  return startDir
}

/**
 * Check if a command exists in PATH
 */
function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/**
 * Find the test file and command for a given source file
 */
export function findTestForFile(filePath: string): { testFile: string; testCommand: string[] } | null {
  if (!existsSync(filePath)) return null
  if (isTestFile(filePath)) return null

  const ext = extname(filePath)
  const dir = dirname(filePath)
  const stem = basename(filePath, ext)
  const projectRoot = findProjectRoot(dir)

  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs": {
      const testExt = ext
      const altExt = ext === ".tsx" ? ".ts" : ext === ".jsx" ? ".js" : undefined

      const candidates = [
        join(dir, `${stem}.test${testExt}`),
        join(dir, `${stem}.spec${testExt}`),
        join(dir, "__tests__", `${stem}.test${testExt}`),
        join(dir, "__tests__", `${stem}${testExt}`),
        join(projectRoot, "tests", `${stem}.test${testExt}`),
        join(projectRoot, "test", `${stem}.test${testExt}`),
      ]

      if (altExt) {
        candidates.push(join(dir, `${stem}.test${altExt}`), join(dir, `${stem}.spec${altExt}`))
      }

      const testFile = findTestFile(candidates)
      if (!testFile) return null

      // Determine test runner
      let testCommand: string[] | null = null

      if (
        existsSync(join(projectRoot, "vitest.config.ts")) ||
        existsSync(join(projectRoot, "vitest.config.js")) ||
        existsSync(join(projectRoot, "vitest.config.mts"))
      ) {
        testCommand = ["npx", "vitest", "run", testFile, "--reporter=verbose"]
      } else if (
        existsSync(join(projectRoot, "jest.config.ts")) ||
        existsSync(join(projectRoot, "jest.config.js")) ||
        existsSync(join(projectRoot, "jest.config.json"))
      ) {
        testCommand = ["npx", "jest", testFile, "--passWithNoTests"]
      } else {
        // Check package.json for test runner
        try {
          const pkgPath = join(projectRoot, "package.json")
          if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
            const deps = { ...pkg.dependencies, ...pkg.devDependencies }
            if (deps.vitest) {
              testCommand = ["npx", "vitest", "run", testFile, "--reporter=verbose"]
            } else if (deps.jest) {
              testCommand = ["npx", "jest", testFile, "--passWithNoTests"]
            }
          }
        } catch {
          // Ignore parse errors
        }
      }

      if (!testCommand) return null
      return { testFile, testCommand }
    }

    case ".py": {
      const candidates = [
        join(dir, `test_${stem}.py`),
        join(dir, `${stem}_test.py`),
        join(projectRoot, "tests", `test_${stem}.py`),
        join(projectRoot, "test", `test_${stem}.py`),
        join(projectRoot, "tests", `${stem}_test.py`),
      ]

      const testFile = findTestFile(candidates)
      if (!testFile || !commandExists("pytest")) return null

      return {
        testFile,
        testCommand: ["pytest", testFile, "-x", "-q", "--tb=short"],
      }
    }

    case ".go": {
      const testFile = join(dir, `${stem}_test.go`)
      if (!existsSync(testFile) || !commandExists("go")) return null

      return {
        testFile,
        testCommand: ["go", "test", dir, "-run", ".", "-count=1"],
      }
    }

    case ".rs": {
      if (!commandExists("cargo") || !existsSync(join(projectRoot, "Cargo.toml"))) return null

      // Check for inline tests or integration tests
      try {
        const content = readFileSync(filePath, "utf-8")
        if (content.includes("#[cfg(test)]") || existsSync(join(projectRoot, "tests"))) {
          return {
            testFile: filePath,
            testCommand: ["cargo", "test"],
          }
        }
      } catch {
        // Ignore read errors
      }
      return null
    }

    case ".rb": {
      const candidates = [
        join(projectRoot, "spec", `${stem}_spec.rb`),
        join(projectRoot, "test", `${stem}_test.rb`),
      ]

      const testFile = findTestFile(candidates)
      if (!testFile) return null

      if (testFile.endsWith("_spec.rb") && commandExists("rspec")) {
        return {
          testFile,
          testCommand: ["rspec", testFile, "--format", "progress"],
        }
      } else if (commandExists("ruby")) {
        return {
          testFile,
          testCommand: ["ruby", "-Itest", testFile],
        }
      }
      return null
    }

    default:
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
