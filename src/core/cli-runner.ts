import { basename } from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };
import { runCommand, type CommandContext } from "../commands/index.js";
import { ExitCode, type ExitCode as ExitCodeValue } from "./exit-codes.js";
import { parseInvocation, UsageError, type Invocation } from "./cli-parser.js";
import { createOutput, type CommandResult, type Output, type ResultCategory, type ResultStatus } from "./output.js";

const version = packageMetadata.version;

export interface CommandExecutionContext extends CommandContext {
  readonly invocation: Invocation;
  readonly signal: AbortSignal;
}

export type CommandRunner = (context: CommandExecutionContext) => Promise<CommandResult>;

export interface RunCliOptions {
  readonly args: readonly string[];
  readonly executableName?: string;
  readonly commandRunner?: CommandRunner;
}

function usageResult(error: UsageError): CommandResult {
  return { status: "failure", category: "usage", exitCode: ExitCode.usage, summary: error.message };
}

function failureResult(category: ResultCategory, exitCode: number, summary: string): CommandResult {
  const status: ResultStatus = category === "incomplete" ? "incomplete" : category === "cancelled" ? "cancelled" : "failure";
  return { status, category, exitCode, summary };
}

function resultForExitCode(exitCode: number, summary: string): CommandResult {
  const category: ResultCategory =
    exitCode === ExitCode.success
      ? "success"
      : exitCode === ExitCode.usage
        ? "usage"
        : exitCode === ExitCode.policyBlocked
          ? "policy"
          : exitCode === ExitCode.integrityFailure
            ? "integrity"
            : exitCode === ExitCode.networkFailure
              ? "network"
              : exitCode === ExitCode.installIncomplete
                ? "incomplete"
                : exitCode === ExitCode.sigint || exitCode === ExitCode.sigterm
                  ? "cancelled"
                  : "internal";
  const status: ResultStatus =
    category === "success" ? "success" : category === "incomplete" ? "incomplete" : category === "cancelled" ? "cancelled" : "failure";
  return { status, category, exitCode, summary };
}

export function mapError(error: unknown): CommandResult {
  if (error instanceof UsageError) {
    return usageResult(error);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return failureResult("cancelled", ExitCode.sigint, "Cancelled");
  }
  return failureResult("internal", ExitCode.internalError, "Internal error");
}

function help(invokedAsBnpmx: boolean): string {
  if (invokedAsBnpmx) {
    return "Usage: bnpmx [--json] [--allow-recent=name@version] [--allow-dangerous=name@version] <package> [-- args...]\n\nResolve, inspect, and execute one package in an isolated temporary project.";
  }
  return [
    "Usage: bnpm [global options] <command> [options] [operands]",
    "",
    "Commands:",
    "  install [spec...]                 Install manifest dependencies or package specs",
    "  add <spec...>                     Add package dependencies",
    "  remove <name...>                  Remove direct dependencies",
    "  run <script> [-- args...]         Analyze and run a project script",
    "  exec <bin> [-- args...]           Execute an installed binary",
    "  audit                             Run registry and local security audits",
    "  bnpmx <package> [-- args...]      Resolve and execute an ephemeral package",
    "",
    "Global options:",
    "  -h, --help  -v, --version  --json",
    "  --allow-recent=name@version  --allow-dangerous=name@version",
    "",
    "Install options:",
    "  --frozen-lockfile  --offline  --omit=dev",
    "  --save-prod  -D, --save-dev  -O, --save-optional  --save-peer",
    "  -E, --save-exact  --no-save",
  ].join("\n");
}

function defaultRunner(context: CommandExecutionContext): Promise<CommandResult> {
  if (context.invocation.kind === "bnpmx") {
    return Promise.resolve(
      failureResult("internal", ExitCode.internalError, "bnpmx is not implemented yet"),
    );
  }
  if (context.invocation.kind !== "command") {
    return Promise.resolve({ status: "success", category: "success", exitCode: ExitCode.success, summary: "Completed" });
  }
  const commandName = context.invocation.name;
  return runCommand(commandName, context).then((exitCode) =>
    resultForExitCode(
      exitCode === ExitCode.usage ? ExitCode.internalError : exitCode,
      exitCode === ExitCode.success ? "Completed" : `${commandName} is not implemented yet`,
    ),
  );
}

function executableIsBnpmx(name: string): boolean {
  return basename(name) === "bnpmx";
}

function selectCommand(invocation: Invocation): string {
  if (invocation.kind === "command") {
    return invocation.name;
  }
  return invocation.kind;
}

export async function runCli(options: RunCliOptions): Promise<number> {
  const invokedAsBnpmx = executableIsBnpmx(options.executableName ?? process.argv[1] ?? "bnpm");
  let invocation: Invocation;
  try {
    invocation = parseInvocation(options.args, invokedAsBnpmx);
  } catch (error) {
    const output = createOutput(requestsJson(options.args, invokedAsBnpmx), invokedAsBnpmx ? "bnpmx" : "bnpm");
    const result = mapError(error);
    output.error(result.summary, { category: result.category, exitCode: result.exitCode });
    output.result(result);
    return result.exitCode;
  }

  const isJson = invocation.kind === "help" || invocation.kind === "version" ? invocation.json : invocation.options.json;
  const output = createOutput(isJson, selectCommand(invocation));
  if (invocation.kind === "help") {
    const helpText = help(invokedAsBnpmx);
    output.result({
      status: "success",
      category: "success",
      exitCode: ExitCode.success,
      summary: "Help displayed",
      humanMessage: helpText,
      evidence: { help: helpText },
    });
    return ExitCode.success;
  }
  if (invocation.kind === "version") {
    output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: version });
    return ExitCode.success;
  }

  const controller = new AbortController();
  let cancellation: ExitCodeValue | undefined;
  let resolveCancellation: ((result: CommandResult) => void) | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (cancellation === undefined) {
      cancellation = signal === "SIGINT" ? ExitCode.sigint : ExitCode.sigterm;
      controller.abort();
      resolveCancellation?.(
        failureResult(
          "cancelled",
          cancellation,
          cancellation === ExitCode.sigint ? "Cancelled by SIGINT" : "Cancelled by SIGTERM",
        ),
      );
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const cancelled = new Promise<CommandResult>((resolve) => {
    resolveCancellation = resolve;
  });
  const run = (options.commandRunner ?? defaultRunner)({
    args: invocation.kind === "bnpmx" ? [invocation.specifier, ...invocation.targetArgs] : invocation.args,
    cwd: process.cwd(),
    output,
    invokedAsBnpmx,
    invocation,
    signal: controller.signal,
  });
  try {
    const result = await Promise.race([run, cancelled]);
    output.result(result);
    return result.exitCode;
  } catch (error) {
    const result = cancellation === undefined ? mapError(error) : failureResult("cancelled", cancellation, "Cancelled");
    output.error(result.summary, { category: result.category, exitCode: result.exitCode });
    output.result(result);
    return result.exitCode;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

function requestsJson(args: readonly string[], invokedAsBnpmx: boolean): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      return true;
    }
    if (argument === "--allow-recent" || argument === "--allow-dangerous") {
      index += 1;
      continue;
    }
    if (argument?.startsWith("--allow-recent=") || argument?.startsWith("--allow-dangerous=")) {
      continue;
    }
    if (argument === "--help" || argument === "-h" || argument === "--version" || argument === "-v") {
      return args.slice(index + 1).includes("--json");
    }
    if (invokedAsBnpmx || argument === "install" || argument === "add" || argument === "remove" || argument === "run" || argument === "audit" || argument === "exec") {
      return false;
    }
    return false;
  }
  return false;
}
