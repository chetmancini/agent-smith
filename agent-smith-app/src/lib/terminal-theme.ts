import process from "node:process";

type Tone = "accent" | "info" | "success" | "warning" | "danger" | "muted";

export interface TerminalTheme {
  enabled: boolean;
  bold: (text: string) => string;
  dim: (text: string) => string;
  accent: (text: string) => string;
  info: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
  danger: (text: string) => string;
  muted: (text: string) => string;
  tone: (text: string, tone: Tone) => string;
}

const ansi = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  cyan: "\u001B[36m",
  blue: "\u001B[34m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
  gray: "\u001B[90m",
} as const;

function wrap(enabled: boolean, open: string, text: string): string {
  return enabled ? `${open}${text}${ansi.reset}` : text;
}

export function shouldUseColor(options: { env?: NodeJS.ProcessEnv; isTTY?: boolean } = {}): boolean {
  const env = options.env ?? process.env;

  if (Object.hasOwn(env, "NO_COLOR")) {
    return false;
  }

  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR !== "0";
  }

  if (env.CLICOLOR_FORCE !== undefined) {
    return env.CLICOLOR_FORCE !== "0";
  }

  if (env.CLICOLOR === "0") {
    return false;
  }

  return Boolean(options.isTTY);
}

export function createTerminalTheme(options: { color?: boolean } = {}): TerminalTheme {
  const enabled = options.color ?? false;

  const tone = (text: string, requested: Tone): string => {
    switch (requested) {
      case "accent":
        return wrap(enabled, ansi.cyan, text);
      case "info":
        return wrap(enabled, ansi.blue, text);
      case "success":
        return wrap(enabled, ansi.green, text);
      case "warning":
        return wrap(enabled, ansi.yellow, text);
      case "danger":
        return wrap(enabled, ansi.red, text);
      case "muted":
        return wrap(enabled, ansi.gray, text);
    }
  };

  return {
    enabled,
    bold: (text) => wrap(enabled, ansi.bold, text),
    dim: (text) => wrap(enabled, ansi.dim, text),
    accent: (text) => tone(text, "accent"),
    info: (text) => tone(text, "info"),
    success: (text) => tone(text, "success"),
    warning: (text) => tone(text, "warning"),
    danger: (text) => tone(text, "danger"),
    muted: (text) => tone(text, "muted"),
    tone,
  };
}
