import { basename } from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };
import { runBnpmxCommand, runCommand, type CommandContext } from "../commands/index.js";
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
              : exitCode === ExitCode.resolutionFailure
                ? "resolution"
              : exitCode === ExitCode.installIncomplete
                ? "incomplete"
                : exitCode === ExitCode.sigint || exitCode === ExitCode.sigterm
                  ? "cancelled"
                  : "internal";
  const status: ResultStatus =
    category === "success" ? "success" : category === "incomplete" ? "incomplete" : category === "cancelled" ? "cancelled" : "failure";
  return { status, category, exitCode, summary };
}

function summaryForCommand(command: string, exitCode: number): string {
  if (exitCode === ExitCode.success) return "Completed";
  if (exitCode === ExitCode.policyBlocked) return "Blocked by security policy";
  if (exitCode === ExitCode.integrityFailure) return "Package integrity or archive verification failed";
  if (exitCode === ExitCode.networkFailure) return "Registry or network request failed";
  if (exitCode === ExitCode.resolutionFailure) return "Dependency resolution failed";
  if (exitCode === ExitCode.installIncomplete) return "Installation completed with skipped lifecycle scripts";
  return `${command} failed`;
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
    return "Usage: bnpmx [--json] [--details] [--allow-recent=name@version] [--allow-dangerous=name@version] <package> [-- args...]\n       bnpmx [--json] [--details] check\n\nResolve, inspect, and execute one package, or check every direct and transitive package in the current project.";
  }
  return [
    "Usage: bnpm [global options] <command> [options] [operands]",
    "",
    "Commands:",
    "  install [spec...]                 Install manifest dependencies or package specs",
    "  ci                                Install exactly from bnpm-lock.yaml",
    "  add <spec...>                     Add package dependencies",
    "  remove <name...>                  Remove direct dependencies (aliases: uninstall, rm)",
    "  update [name...]                  Resolve newer versions within declared ranges",
    "  outdated [name...]                Report current, wanted, and latest versions",
    "  list [name...]                    Show the installed dependency graph (alias: ls)",
    "  why <name>                        Explain why a package is installed",
    "  query <selector>                  Query the verified dependency graph with npm selectors",
    "  diff [package@version]            Emit verified package patches; --diff may be used twice",
    "  find-dupes                       Report duplicate package instances without mutation",
    "  bin                               Print the local or global executable directory",
    "  prefix                            Print the local or global installation prefix",
    "  root                              Print the local or global node_modules directory",
    "  run [--workspaces] <script> ...   Analyze and run a project or workspace script",
    "  test / start / stop / restart     npm-compatible project script aliases",
    "  install-test / install-ci-test    Install (or CI install), then run test",
    "  exec [--package <spec>] <bin> ... Execute an installed or ephemeral binary",
    "  explore <package> [-- command]    Run a command inside an installed package",
    "  edit <package>                    Edit a project-local installed package safely",
    "  audit [fix [--dry-run]]           Report advisories or apply safe in-range fixes",
    "  pack [directory]                  Create a deterministic npm package tarball",
    "  publish [directory]               Publish a verified package tarball",
    "  stage <publish|list|view|download|approve|reject> ...  Manage staged publication",
    "  unpublish <package@version>       Remove an exact registry version (--force for last)",
    "  access ... / owner ...            Manage package visibility, teams, and owners",
    "  token <create|list|revoke> ...    Create, list, or revoke authentication tokens",
    "  star / unstar / stars             Manage registry package favorites",
    "  org ... / team ...                Manage registry organizations and teams",
    "  profile <get|set|enable-2fa|disable-2fa> ...  Manage registry profile security",
    "  trust <github|gitlab|circleci|list|revoke> ...  Manage trusted publishers",
    "  login                             Log in via web or explicit legacy flow (alias: adduser)",
    "  logout                            Revoke and remove the current registry token",
    "  whoami                            Display the current registry username",
    "  view <package>                    Show package metadata (alias: info)",
    "  search <terms...>                 Search registry packages",
    "  repo / docs / bugs [package]      Open validated package project links",
    "  dist-tag <add|rm|ls> ...          Manage package distribution tags",
    "  deprecate <package@range> <msg>   Deprecate matching package versions",
    "  config <list|get|set|delete> ...  Manage safe user configuration",
    "  init [initializer] ...            Create package.json or run an inspected create-* package",
    "  version [release|version]        Show or update the package version",
    "  shrinkwrap                       Export the verified graph as npm-shrinkwrap.json",
    "  prune                             Remove packages not declared by the project",
    "  dedupe                            Re-resolve and converge compatible package instances",
    "  rebuild [name...]                 Rerun exactly approved dependency build scripts",
    "  install-scripts <approve|deny|ls|prune> ...  Manage exact lifecycle approvals",
    "  approve-scripts / deny-scripts    Mutate exact lockfile-bound lifecycle approvals",
    "  fund                              Show validated funding links for installed packages",
    "  cache <add|ls|verify|clean>       Prefetch, inspect, verify, or clean bnpm caches",
    "  ping                              Check registry routing and authentication",
    "  doctor                            Diagnose Node, Git, registry, and cache health",
    "  completion                        Print bash/zsh command completion",
    "  pkg <get|set|delete> ...          Read or transactionally update package.json",
    "  sbom [--sbom-format=<format>]     Generate CycloneDX or SPDX from the lockfile",
    "  link [name...] / unlink [name...] Register or consume live package links",
    "  bnpmx <package> [-- args...]      Resolve and execute an ephemeral package",
    "  i                                 Alias for install",
    "",
    "Global options:",
    "  -h, --help  -v, --version  --json  --details  --registry=https://registry.example/",
    "  --allow-recent=name@version  --allow-dangerous=name@version",
    "",
    "Install options:",
    "  -g, --global  --frozen-lockfile  --offline  --omit=dev",
    "  --save-prod  -D, --save-dev  -O, --save-optional  --save-peer",
    "  -E, --save-exact  --no-save",
    "",
    "Package authoring options:",
    "  --dry-run  --pack-destination=<directory>",
    "  --tag=<tag>  --access=<public|restricted>  --otp=<code>",
    "  --provenance  --provenance-file=<path>",
  ].join("\n");
}

function defaultRunner(context: CommandExecutionContext): Promise<CommandResult> {
  if (context.invocation.kind === "bnpmx") {
    return runBnpmxCommand(context, context.invocation.options, context.invocation.specifier, context.invocation.targetArgs).then((exitCode) =>
      resultForExitCode(exitCode, summaryForCommand("bnpmx", exitCode)),
    );
  }
  if (context.invocation.kind !== "command") {
    return Promise.resolve({ status: "success", category: "success", exitCode: ExitCode.success, summary: "Completed" });
  }
  const commandName = context.invocation.name;
  return runCommand(commandName, { ...context, options: context.invocation.options }).then((exitCode) =>
    resultForExitCode(
      exitCode === ExitCode.usage ? ExitCode.internalError : exitCode,
      summaryForCommand(commandName, exitCode),
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

function presentFailure(output: Output, json: boolean, result: CommandResult): void {
  if (json) {
    output.error(result.summary, { category: result.category, exitCode: result.exitCode });
  }
  output.result(result);
}

export async function runCli(options: RunCliOptions): Promise<number> {
  const invokedAsBnpmx = executableIsBnpmx(options.executableName ?? process.argv[1] ?? "bnpm");
  let invocation: Invocation;
  try {
    invocation = parseInvocation(options.args, invokedAsBnpmx);
  } catch (error) {
    const json = requestsJson(options.args, invokedAsBnpmx);
    const output = createOutput(json, invokedAsBnpmx ? "bnpmx" : "bnpm");
    const result = mapError(error);
    presentFailure(output, json, result);
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
    const directHumanExecution = !isJson && result.status === "success" && (invocation.kind === "bnpmx" || (invocation.kind === "command" && invocation.name === "exec"));
    if (!directHumanExecution) output.result(result);
    return result.exitCode;
  } catch (error) {
    const result = cancellation === undefined ? mapError(error) : failureResult("cancelled", cancellation, "Cancelled");
    presentFailure(output, isJson, result);
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
    if (argument === "--allow-recent" || argument === "--allow-dangerous" || argument === "--registry") {
      index += 1;
      continue;
    }
    if (argument?.startsWith("--allow-recent=") || argument?.startsWith("--allow-dangerous=") || argument?.startsWith("--registry=")) {
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
