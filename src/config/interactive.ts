export type NonInteractiveReason = "json" | "ci" | "stdin-not-tty" | "stderr-not-tty" | "prompt-unavailable";

export type InteractiveMode =
  | { readonly interactive: true; readonly reason: "terminal" }
  | { readonly interactive: false; readonly reason: NonInteractiveReason };

export interface InteractiveDetectionOptions {
  readonly json: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly stdinIsTTY: boolean | undefined;
  readonly stderrIsTTY: boolean | undefined;
  readonly promptAvailable: boolean;
}

export function detectInteractiveMode(options: InteractiveDetectionOptions): InteractiveMode {
  if (options.json) {
    return { interactive: false, reason: "json" };
  }
  if (options.environment.CI !== undefined && options.environment.CI !== "" && options.environment.CI !== "0") {
    return { interactive: false, reason: "ci" };
  }
  if (options.stdinIsTTY !== true) {
    return { interactive: false, reason: "stdin-not-tty" };
  }
  if (options.stderrIsTTY !== true) {
    return { interactive: false, reason: "stderr-not-tty" };
  }
  if (!options.promptAvailable) {
    return { interactive: false, reason: "prompt-unavailable" };
  }
  return { interactive: true, reason: "terminal" };
}
