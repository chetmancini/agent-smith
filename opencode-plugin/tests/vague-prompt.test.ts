/**
 * Tests for vague-prompt.ts
 * Validates vague prompt detection patterns
 */

import { describe, test, expect } from "bun:test"
import { isVaguePrompt, getClarificationNote } from "../src/lib/vague-prompt.js"

describe("vague-prompt", () => {
  // ============================================================================
  // isVaguePrompt - vague patterns
  // ============================================================================

  describe("isVaguePrompt - detects vague prompts", () => {
    test("fix it", () => {
      expect(isVaguePrompt("fix it")).toBe(true)
    })

    test("fix this", () => {
      expect(isVaguePrompt("fix this")).toBe(true)
    })

    test("fix that", () => {
      expect(isVaguePrompt("fix that")).toBe(true)
    })

    test("fix the bug", () => {
      expect(isVaguePrompt("fix the bug")).toBe(true)
    })

    test("fix the issue", () => {
      expect(isVaguePrompt("fix the issue")).toBe(true)
    })

    test("fix the problem", () => {
      expect(isVaguePrompt("fix the problem")).toBe(true)
    })

    test("fix the error", () => {
      expect(isVaguePrompt("fix the error")).toBe(true)
    })

    test("make it work", () => {
      expect(isVaguePrompt("make it work")).toBe(true)
    })

    test("get it working", () => {
      expect(isVaguePrompt("get it working")).toBe(true)
    })

    test("make it faster", () => {
      expect(isVaguePrompt("make it faster")).toBe(true)
    })

    test("make it better", () => {
      expect(isVaguePrompt("make it better")).toBe(true)
    })

    test("clean up", () => {
      expect(isVaguePrompt("clean up")).toBe(true)
    })

    test("cleanup the code", () => {
      expect(isVaguePrompt("cleanup the code")).toBe(true)
    })

    test("improve it", () => {
      expect(isVaguePrompt("improve it")).toBe(true)
    })

    test("improve this", () => {
      expect(isVaguePrompt("improve this")).toBe(true)
    })

    test("update it", () => {
      expect(isVaguePrompt("update it")).toBe(true)
    })

    test("refactor it", () => {
      expect(isVaguePrompt("refactor it")).toBe(true)
    })

    test("refactor the code", () => {
      expect(isVaguePrompt("refactor the code")).toBe(true)
    })

    test("rewrite it", () => {
      expect(isVaguePrompt("rewrite it")).toBe(true)
    })

    test("optimize it", () => {
      expect(isVaguePrompt("optimize it")).toBe(true)
    })

    test("help", () => {
      expect(isVaguePrompt("help")).toBe(true)
    })

    test("help me", () => {
      expect(isVaguePrompt("help me")).toBe(true)
    })

    test("do it", () => {
      expect(isVaguePrompt("do it")).toBe(true)
    })

    test("undo that", () => {
      expect(isVaguePrompt("undo that")).toBe(true)
    })

    test("add it", () => {
      expect(isVaguePrompt("add it")).toBe(true)
    })

    test("remove it", () => {
      expect(isVaguePrompt("remove it")).toBe(true)
    })

    test("delete this", () => {
      expect(isVaguePrompt("delete this")).toBe(true)
    })

    test("make this better", () => {
      expect(isVaguePrompt("make this better")).toBe(true)
    })

    test("make that work", () => {
      expect(isVaguePrompt("make that work")).toBe(true)
    })

    test("debug it", () => {
      expect(isVaguePrompt("debug it")).toBe(true)
    })

    test("test this", () => {
      expect(isVaguePrompt("test this")).toBe(true)
    })

    test("check it", () => {
      expect(isVaguePrompt("check it")).toBe(true)
    })

    test("review this", () => {
      expect(isVaguePrompt("review this")).toBe(true)
    })

    test("run it", () => {
      expect(isVaguePrompt("run it")).toBe(true)
    })

    test("continue", () => {
      expect(isVaguePrompt("continue")).toBe(true)
    })

    test("go ahead", () => {
      expect(isVaguePrompt("go ahead")).toBe(true)
    })

    test("proceed", () => {
      expect(isVaguePrompt("proceed")).toBe(true)
    })

    test("keep going", () => {
      expect(isVaguePrompt("keep going")).toBe(true)
    })

    test("try again", () => {
      expect(isVaguePrompt("try again")).toBe(true)
    })

    test("retry", () => {
      expect(isVaguePrompt("retry")).toBe(true)
    })

    test("redo", () => {
      expect(isVaguePrompt("redo")).toBe(true)
    })

    // Short action-only prompts
    test("fix something (short action)", () => {
      expect(isVaguePrompt("fix something")).toBe(true)
    })

    test("update things", () => {
      expect(isVaguePrompt("update things")).toBe(true)
    })

    test("refactor code", () => {
      expect(isVaguePrompt("refactor code")).toBe(true)
    })
  })

  // ============================================================================
  // isVaguePrompt - specific patterns (should NOT be vague)
  // ============================================================================

  describe("isVaguePrompt - allows specific prompts", () => {
    test("contains file path", () => {
      expect(isVaguePrompt("fix /src/index.ts")).toBe(false)
    })

    test("contains code block", () => {
      expect(isVaguePrompt("update this ```const x = 1```")).toBe(false)
    })

    test("contains TypeScript extension", () => {
      expect(isVaguePrompt("fix the foo.ts file")).toBe(false)
    })

    test("contains JavaScript extension", () => {
      expect(isVaguePrompt("update bar.js")).toBe(false)
    })

    test("contains Python extension", () => {
      expect(isVaguePrompt("refactor main.py")).toBe(false)
    })

    test("contains Go extension", () => {
      expect(isVaguePrompt("improve server.go")).toBe(false)
    })

    test("contains Rust extension", () => {
      expect(isVaguePrompt("optimize lib.rs")).toBe(false)
    })

    test("contains Ruby extension", () => {
      expect(isVaguePrompt("fix app.rb")).toBe(false)
    })

    test("contains environment variable", () => {
      expect(isVaguePrompt("check $PATH variable")).toBe(false)
    })

    test("contains URL", () => {
      expect(isVaguePrompt("fetch https://example.com")).toBe(false)
    })

    test("long detailed prompt", () => {
      expect(
        isVaguePrompt(
          "Please refactor the authentication middleware to use JWT tokens instead of session cookies"
        )
      ).toBe(false)
    })

    test("prompt with specific function name", () => {
      expect(
        isVaguePrompt("fix the getUserById function in the auth module")
      ).toBe(false)
    })

    test("prompt with error message", () => {
      expect(
        isVaguePrompt("fix the TypeError: Cannot read property of undefined")
      ).toBe(false)
    })
  })

  // ============================================================================
  // isVaguePrompt - edge cases
  // ============================================================================

  describe("isVaguePrompt - edge cases", () => {
    test("empty string", () => {
      expect(isVaguePrompt("")).toBe(false)
    })

    test("whitespace only", () => {
      expect(isVaguePrompt("   ")).toBe(false)
    })

    test("case insensitive - FIX IT", () => {
      expect(isVaguePrompt("FIX IT")).toBe(true)
    })

    test("case insensitive - Fix It", () => {
      expect(isVaguePrompt("Fix It")).toBe(true)
    })

    test("with trailing period", () => {
      expect(isVaguePrompt("fix it.")).toBe(true)
    })

    test("with extra whitespace", () => {
      expect(isVaguePrompt("  fix it  ")).toBe(true)
    })

    test("exactly 10 words but vague", () => {
      expect(isVaguePrompt("fix the thing that is broken right now please")).toBe(false)
    })

    test("more than 10 words is not vague", () => {
      expect(
        isVaguePrompt(
          "this is a very long prompt with more than ten words so it should not be vague"
        )
      ).toBe(false)
    })
  })

  // ============================================================================
  // getClarificationNote
  // ============================================================================

  describe("getClarificationNote", () => {
    test("returns a system note string", () => {
      const note = getClarificationNote()
      expect(note).toContain("[System note:")
      expect(note).toContain("clarifying question")
    })

    test("mentions asking about target or behavior", () => {
      const note = getClarificationNote()
      expect(note).toContain("target file")
      expect(note).toContain("behavior")
    })
  })
})
