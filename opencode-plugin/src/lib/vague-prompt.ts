/**
 * Vague prompt detection utility for agent-smith
 * TypeScript port of hooks/vague-prompt.sh
 *
 * Detects vague/ambiguous prompts and suggests clarification
 */

/**
 * Patterns that indicate a vague prompt
 */
const VAGUE_PATTERNS = [
  /^fix (it|this|that|the bug|the issue|the problem|the error|things)\.?$/i,
  /^(make it|get it) (work|working|faster|better|right)\.?$/i,
  /^(clean( up)?|cleanup) (it|this|the code|up)\.?$/i,
  /^(improve|update|refactor|rewrite|optimize) (it|this|the code|this code)\.?$/i,
  /^help( me)?\.?$/i,
  /^(do|undo) (it|that|this)\.?$/i,
  /^(add|remove|delete) (it|this|that)\.?$/i,
  /^make (it|this|that) (better|good|work|cleaner|nicer|faster)\.?$/i,
  /^(debug|test|check|review|run) (it|this|that)\.?$/i,
  /^(continue|go ahead|proceed|keep going)\.?$/i,
  /^(try again|retry|redo)\.?$/i,
]

/**
 * Patterns that indicate a specific/concrete prompt (short-circuit)
 */
const SPECIFIC_PATTERNS = [
  /\/[a-zA-Z]/, // File path
  /```/, // Code block
  /\.ts|\.tsx|\.py|\.go|\.rs|\.rb|\.js|\.jsx/, // File extensions
  /\$[A-Z_]+/, // Environment variable
  /https?:\/\//, // URL
]

/**
 * Check if a prompt is vague and needs clarification
 */
export function isVaguePrompt(prompt: string): boolean {
  const trimmed = prompt.trim()
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length

  // Short-circuit for prompts that are clearly specific
  if (wordCount > 10) return false

  // Check for specific patterns
  for (const pattern of SPECIFIC_PATTERNS) {
    if (pattern.test(trimmed)) return false
  }

  // Check for vague patterns
  for (const pattern of VAGUE_PATTERNS) {
    if (pattern.test(trimmed)) return true
  }

  // Also flag very short action-only prompts (<=4 words starting with a verb)
  if (wordCount <= 4) {
    if (/^(fix|update|improve|refactor|rewrite|clean|debug|check|test|review|add|remove|change|edit|run|build|deploy) /i.test(trimmed)) {
      return true
    }
  }

  return false
}

/**
 * Generate a clarification note for vague prompts
 */
export function getClarificationNote(): string {
  return "[System note: The request above is brief and may be ambiguous. Before making changes, ask one short clarifying question to confirm the target file, specific behavior, or desired outcome unless the prior conversation makes intent obvious.]"
}
