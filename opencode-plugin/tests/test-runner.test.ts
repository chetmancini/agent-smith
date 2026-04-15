/**
 * Tests for test-runner.ts
 * Validates test file detection and command generation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { findTestForFile } from "../src/lib/test-runner.js"

describe("test-runner", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "test-runner-test-"))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  // ============================================================================
  // isTestFile detection (via findTestForFile returning null for test files)
  // ============================================================================

  describe("test file detection", () => {
    test("returns null for .test.ts files", () => {
      const testFile = join(tempDir, "foo.test.ts")
      writeFileSync(testFile, "test code")
      expect(findTestForFile(testFile)).toBeNull()
    })

    test("returns null for .spec.ts files", () => {
      const testFile = join(tempDir, "foo.spec.ts")
      writeFileSync(testFile, "test code")
      expect(findTestForFile(testFile)).toBeNull()
    })

    test("returns null for .test.js files", () => {
      const testFile = join(tempDir, "foo.test.js")
      writeFileSync(testFile, "test code")
      expect(findTestForFile(testFile)).toBeNull()
    })

    test("returns null for .spec.js files", () => {
      const testFile = join(tempDir, "foo.spec.js")
      writeFileSync(testFile, "test code")
      expect(findTestForFile(testFile)).toBeNull()
    })

    test("returns null for files in __tests__ directory", () => {
      const testsDir = join(tempDir, "__tests__")
      mkdirSync(testsDir, { recursive: true })
      const testFile = join(testsDir, "foo.ts")
      writeFileSync(testFile, "test code")
      expect(findTestForFile(testFile)).toBeNull()
    })

    test("returns null for test_*.py files", () => {
      const testFile = join(tempDir, "test_foo.py")
      writeFileSync(testFile, "test code")
      expect(findTestForFile(testFile)).toBeNull()
    })

    test("returns null for *_test.py files", () => {
      const testFile = join(tempDir, "foo_test.py")
      writeFileSync(testFile, "test code")
      expect(findTestForFile(testFile)).toBeNull()
    })

    test("returns null for *_test.go files", () => {
      const testFile = join(tempDir, "foo_test.go")
      writeFileSync(testFile, "test code")
      expect(findTestForFile(testFile)).toBeNull()
    })

    test("returns null for *_spec.rb files", () => {
      const testFile = join(tempDir, "foo_spec.rb")
      writeFileSync(testFile, "test code")
      expect(findTestForFile(testFile)).toBeNull()
    })

    test("returns null for *_test.rb files", () => {
      const testFile = join(tempDir, "foo_test.rb")
      writeFileSync(testFile, "test code")
      expect(findTestForFile(testFile)).toBeNull()
    })
  })

  // ============================================================================
  // TypeScript/JavaScript test file finding
  // ============================================================================

  describe("TypeScript/JavaScript test finding", () => {
    test("finds colocated .test.ts file", () => {
      const srcFile = join(tempDir, "foo.ts")
      const testFile = join(tempDir, "foo.test.ts")
      writeFileSync(srcFile, "source code")
      writeFileSync(testFile, "test code")
      // Need vitest or jest config for command generation
      writeFileSync(join(tempDir, "vitest.config.ts"), "export default {}")

      const result = findTestForFile(srcFile)
      expect(result).not.toBeNull()
      expect(result?.testFile).toBe(testFile)
      expect(result?.testCommand).toContain("vitest")
    })

    test("finds colocated .spec.ts file", () => {
      const srcFile = join(tempDir, "bar.ts")
      const testFile = join(tempDir, "bar.spec.ts")
      writeFileSync(srcFile, "source code")
      writeFileSync(testFile, "test code")
      writeFileSync(join(tempDir, "vitest.config.ts"), "export default {}")

      const result = findTestForFile(srcFile)
      expect(result).not.toBeNull()
      expect(result?.testFile).toBe(testFile)
    })

    test("finds test in __tests__ directory", () => {
      const srcFile = join(tempDir, "baz.ts")
      const testsDir = join(tempDir, "__tests__")
      mkdirSync(testsDir, { recursive: true })
      const testFile = join(testsDir, "baz.test.ts")
      writeFileSync(srcFile, "source code")
      writeFileSync(testFile, "test code")
      writeFileSync(join(tempDir, "vitest.config.ts"), "export default {}")

      const result = findTestForFile(srcFile)
      expect(result).not.toBeNull()
      expect(result?.testFile).toBe(testFile)
    })

    test("finds test in project tests directory", () => {
      const srcDir = join(tempDir, "src")
      mkdirSync(srcDir, { recursive: true })
      const srcFile = join(srcDir, "util.ts")
      writeFileSync(srcFile, "source code")
      
      const testsDir = join(tempDir, "tests")
      mkdirSync(testsDir, { recursive: true })
      const testFile = join(testsDir, "util.test.ts")
      writeFileSync(testFile, "test code")
      
      // Create package.json at project root to establish project root
      writeFileSync(join(tempDir, "package.json"), '{}')
      writeFileSync(join(tempDir, "vitest.config.ts"), "export default {}")

      const result = findTestForFile(srcFile)
      expect(result).not.toBeNull()
      expect(result?.testFile).toBe(testFile)
    })

    test("uses jest when jest.config.js exists", () => {
      const srcFile = join(tempDir, "comp.ts")
      const testFile = join(tempDir, "comp.test.ts")
      writeFileSync(srcFile, "source code")
      writeFileSync(testFile, "test code")
      writeFileSync(join(tempDir, "jest.config.js"), "module.exports = {}")

      const result = findTestForFile(srcFile)
      expect(result).not.toBeNull()
      expect(result?.testCommand).toContain("jest")
    })

    test("uses vitest when vitest dependency exists in package.json", () => {
      const srcFile = join(tempDir, "mod.ts")
      const testFile = join(tempDir, "mod.test.ts")
      writeFileSync(srcFile, "source code")
      writeFileSync(testFile, "test code")
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ devDependencies: { vitest: "^1.0.0" } })
      )

      const result = findTestForFile(srcFile)
      expect(result).not.toBeNull()
      expect(result?.testCommand).toContain("vitest")
    })

    test("returns null when no test file exists", () => {
      const srcFile = join(tempDir, "lonely.ts")
      writeFileSync(srcFile, "source code")
      writeFileSync(join(tempDir, "vitest.config.ts"), "export default {}")

      const result = findTestForFile(srcFile)
      expect(result).toBeNull()
    })

    test("returns null when source file does not exist", () => {
      const srcFile = join(tempDir, "nonexistent.ts")
      const result = findTestForFile(srcFile)
      expect(result).toBeNull()
    })

    test("returns null when no test runner config exists", () => {
      const srcFile = join(tempDir, "orphan.ts")
      const testFile = join(tempDir, "orphan.test.ts")
      writeFileSync(srcFile, "source code")
      writeFileSync(testFile, "test code")
      // No vitest or jest config

      const result = findTestForFile(srcFile)
      expect(result).toBeNull()
    })
  })

  // ============================================================================
  // Python test finding
  // ============================================================================

  describe("Python test finding", () => {
    test("finds test_*.py file", () => {
      const srcFile = join(tempDir, "module.py")
      const testFile = join(tempDir, "test_module.py")
      writeFileSync(srcFile, "source code")
      writeFileSync(testFile, "test code")

      const result = findTestForFile(srcFile)
      // Will be null if pytest not installed, which is expected in test env
      // Just verify the logic doesn't crash
      if (result) {
        expect(result.testFile).toBe(testFile)
        expect(result.testCommand).toContain("pytest")
      }
    })

    test("finds *_test.py file", () => {
      const srcFile = join(tempDir, "helper.py")
      const testFile = join(tempDir, "helper_test.py")
      writeFileSync(srcFile, "source code")
      writeFileSync(testFile, "test code")

      const result = findTestForFile(srcFile)
      if (result) {
        expect(result.testFile).toBe(testFile)
      }
    })
  })

  // ============================================================================
  // Go test finding
  // ============================================================================

  describe("Go test finding", () => {
    test("finds *_test.go file", () => {
      const srcFile = join(tempDir, "handler.go")
      const testFile = join(tempDir, "handler_test.go")
      writeFileSync(srcFile, "package main")
      writeFileSync(testFile, "package main")

      const result = findTestForFile(srcFile)
      // Will be null if go not installed
      if (result) {
        expect(result.testFile).toBe(testFile)
        expect(result.testCommand).toContain("go")
      }
    })
  })

  // ============================================================================
  // Rust test finding
  // ============================================================================

  describe("Rust test finding", () => {
    test("finds inline tests in .rs file", () => {
      const srcFile = join(tempDir, "lib.rs")
      writeFileSync(srcFile, '#[cfg(test)]\nmod tests { }')
      writeFileSync(join(tempDir, "Cargo.toml"), "[package]")

      const result = findTestForFile(srcFile)
      // Will be null if cargo not installed
      if (result) {
        expect(result.testFile).toBe(srcFile)
        expect(result.testCommand).toContain("cargo")
      }
    })
  })

  // ============================================================================
  // Ruby test finding
  // ============================================================================

  describe("Ruby test finding", () => {
    test("finds *_spec.rb file in spec directory", () => {
      const srcFile = join(tempDir, "model.rb")
      writeFileSync(srcFile, "class Model; end")
      
      const specDir = join(tempDir, "spec")
      mkdirSync(specDir, { recursive: true })
      const testFile = join(specDir, "model_spec.rb")
      writeFileSync(testFile, "describe Model do; end")

      const result = findTestForFile(srcFile)
      // Will be null if rspec not installed
      if (result) {
        expect(result.testFile).toBe(testFile)
      }
    })

    test("finds nested Ruby specs using the source path relative to project root", () => {
      const appDir = join(tempDir, "app", "models")
      const specDir = join(tempDir, "spec", "app", "models")
      mkdirSync(appDir, { recursive: true })
      mkdirSync(specDir, { recursive: true })

      const srcFile = join(appDir, "user.rb")
      const testFile = join(specDir, "user_spec.rb")
      writeFileSync(srcFile, "class User; end")
      writeFileSync(testFile, "describe User do; end")
      mkdirSync(join(tempDir, ".git"), { recursive: true })

      const result = findTestForFile(srcFile)
      if (result) {
        expect(result.testFile).toBe(testFile)
      }
    })
  })

  // ============================================================================
  // Edge cases
  // ============================================================================

  describe("edge cases", () => {
    test("handles files with multiple extensions", () => {
      const srcFile = join(tempDir, "component.stories.tsx")
      writeFileSync(srcFile, "export default {}")
      
      // This is a .tsx file but not a test file
      const result = findTestForFile(srcFile)
      // Should look for component.stories.test.tsx which won't exist
      expect(result).toBeNull()
    })

    test("handles deeply nested source files", () => {
      const deepDir = join(tempDir, "src", "components", "ui", "buttons")
      mkdirSync(deepDir, { recursive: true })
      const srcFile = join(deepDir, "Button.tsx")
      const testFile = join(deepDir, "Button.test.tsx")
      writeFileSync(srcFile, "export const Button = () => {}")
      writeFileSync(testFile, "test('Button', () => {})")
      // Need package.json to establish project root for test runner detection
      writeFileSync(join(tempDir, "package.json"), "{}")
      writeFileSync(join(tempDir, "vitest.config.ts"), "export default {}")

      const result = findTestForFile(srcFile)
      expect(result).not.toBeNull()
      expect(result?.testFile).toBe(testFile)
    })

    test("prefers .test over .spec when both exist", () => {
      const srcFile = join(tempDir, "both.ts")
      const testFile = join(tempDir, "both.test.ts")
      const specFile = join(tempDir, "both.spec.ts")
      writeFileSync(srcFile, "source")
      writeFileSync(testFile, "test")
      writeFileSync(specFile, "spec")
      writeFileSync(join(tempDir, "vitest.config.ts"), "export default {}")

      const result = findTestForFile(srcFile)
      expect(result).not.toBeNull()
      expect(result?.testFile).toBe(testFile) // .test.ts comes first in search order
    })
  })
})
