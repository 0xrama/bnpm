import { ExitCode, type ExitCode as ExitCodeValue } from "../core/exit-codes.js";
import type { Output } from "../core/output.js";

export const commandNames = ["install", "add", "remove", "run", "audit", "exec"] as const;
export type CommandName = (typeof commandNames)[number];

export interface CommandContext {
  args: readonly string[];
  cwd: string;
  output: Output;
  invokedAsBnpmx: boolean;
}

export async function runCommand(name: CommandName, context: CommandContext): Promise<ExitCodeValue> {
  void name;
  void context;
  return ExitCode.usage;
}
