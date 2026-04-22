import { type SupportedAgentTool, findBinary } from "./agent-hosts";

export interface AgentRunInput {
  tool: SupportedAgentTool;
  prompt: string;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}

export interface AgentRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type AgentRunner = (input: AgentRunInput) => AgentRunResult;

export function agentCommand(
  tool: SupportedAgentTool,
  prompt: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const binary = findBinary(tool, env);
  if (!binary) {
    throw new Error(`${tool} CLI not found in PATH`);
  }

  switch (tool) {
    case "claude":
      return [binary, "--plugin-dir", repoRoot, "-p", prompt];
    case "gemini":
      return [binary, "-p", prompt];
    case "codex":
      return [binary, "exec", "-C", repoRoot, prompt];
    case "opencode":
      return [binary, "run", "--dir", repoRoot, prompt];
  }
}

export const defaultRunAgent: AgentRunner = (input) => {
  const command = agentCommand(input.tool, input.prompt, input.repoRoot, input.env);
  const proc = Bun.spawnSync(command, {
    env: {
      ...input.env,
      AGENT_SMITH_TOOL: input.tool,
    },
    cwd: input.repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
};
