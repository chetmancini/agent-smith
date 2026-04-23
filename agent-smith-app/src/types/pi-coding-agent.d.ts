declare module "@mariozechner/pi-coding-agent" {
  export interface ExtensionAPI {
    on(eventName: string, handler: (...args: never[]) => unknown): void;
    registerCommand(name: string, command: { description: string; handler: (args: string) => unknown }): void;
    sendUserMessage(message: string): void;
  }

  export interface ExtensionContext {
    cwd: string;
    sessionManager: {
      getLeafId(): string | null;
      getSessionFile(): string | null;
      getSessionId(): string;
    };
  }

  export interface InputEvent {
    images?: unknown[];
    source?: string;
    text: string;
  }

  export interface SessionCompactEvent {
    summary?: string;
  }

  export interface SessionShutdownEvent {
    reason?: string;
  }

  export interface SessionStartEvent {
    cwd?: string;
    reason?: string;
  }

  export interface ToolCallEvent {
    input: Record<string, unknown>;
    toolCallId: string;
    toolName: string;
  }

  export interface ToolResultEvent {
    content: Array<{ text?: string; type: string }>;
    input: Record<string, unknown>;
    isError: boolean;
    toolCallId: string;
    toolName: string;
  }

  export interface TurnEndEvent {
    durationMs?: number;
  }
}
