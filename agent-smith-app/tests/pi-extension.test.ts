import { describe, expect, test } from "bun:test";

import agentSmithPiExtension from "../../.pi/extensions/agent-smith";

interface RegisteredCommand {
  description: string;
  handler: (args: string) => unknown;
}

describe("Pi extension", () => {
  test("Agent Smith aliases forward full registered command names", async () => {
    const commands = new Map<string, RegisteredCommand>();
    const sentMessages: string[] = [];
    const pi = {
      on: () => {},
      registerCommand: (name: string, command: RegisteredCommand) => {
        commands.set(name, command);
      },
      sendUserMessage: (message: string) => {
        sentMessages.push(message);
      },
    };

    agentSmithPiExtension(pi);

    expect([...commands.keys()].sort()).toEqual([
      "agent-smith:analyze",
      "agent-smith:analyze-fast",
      "agent-smith:upgrade-settings",
    ]);

    await commands.get("agent-smith:analyze")?.handler("  --sessions 20  ");
    await commands.get("agent-smith:analyze-fast")?.handler("");
    await commands.get("agent-smith:upgrade-settings")?.handler(" --tool pi ");

    expect(sentMessages).toEqual([
      "/agent-smith:analyze --sessions 20",
      "/agent-smith:analyze-fast",
      "/agent-smith:upgrade-settings --tool pi",
    ]);
  });
});
