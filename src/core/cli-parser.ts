import npa from "npm-package-arg";

export type SaveSection = "prod" | "dev" | "optional" | "peer";

export interface GlobalOptions {
  readonly json: boolean;
  readonly allowRecent: readonly string[];
  readonly allowDangerous: readonly string[];
}

export interface CommandOptions extends GlobalOptions {
  readonly frozenLockfile: boolean;
  readonly offline: boolean;
  readonly omitDev: boolean;
  readonly saveSection?: SaveSection;
  readonly saveExact: boolean;
  readonly noSave: boolean;
}

export interface ParsedCommand {
  readonly kind: "command";
  readonly name: "install" | "add" | "remove" | "run" | "audit" | "exec";
  readonly options: CommandOptions;
  readonly args: readonly string[];
}

export interface ParsedBnpmx {
  readonly kind: "bnpmx";
  readonly options: GlobalOptions;
  readonly specifier: string;
  readonly targetArgs: readonly string[];
}

export interface ParsedHelp {
  readonly kind: "help";
  readonly json: boolean;
}

export interface ParsedVersion {
  readonly kind: "version";
  readonly json: boolean;
}

export type Invocation = ParsedCommand | ParsedBnpmx | ParsedHelp | ParsedVersion;

export class UsageError extends Error {
  constructor(message: string) {
    super(`Usage: ${message}`);
    this.name = "UsageError";
  }
}

const commandNames = new Set(["install", "add", "remove", "run", "audit", "exec"]);
const saveFlags: Readonly<Record<string, SaveSection>> = {
  "--save-prod": "prod",
  "--save-dev": "dev",
  "-D": "dev",
  "--save-optional": "optional",
  "-O": "optional",
  "--save-peer": "peer",
};

function requireOverride(flag: string, value: string | undefined): string {
  if (!value) {
    throw new UsageError(`${flag} requires an exact name@version value`);
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1 || value.slice(at + 1).includes("@")) {
    throw new UsageError(`${flag} requires an exact name@version value`);
  }
  let parsed: npa.Result;
  try {
    parsed = npa(value);
  } catch {
    throw new UsageError(`${flag} requires an exact name@version value`);
  }
  if (parsed.type !== "version" || parsed.name === undefined || parsed.rawSpec !== value.slice(at + 1)) {
    throw new UsageError(`${flag} requires an exact name@version value`);
  }
  return value;
}

function consumeGlobal(args: readonly string[]): { readonly options: GlobalOptions; readonly rest: readonly string[] } {
  let json = false;
  const allowRecent: string[] = [];
  const allowDangerous: string[] = [];
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--json") {
      json = true;
      index += 1;
      continue;
    }
    if (arg === "--allow-recent" || arg === "--allow-dangerous") {
      const value = args[index + 1];
      const override = requireOverride(arg, value);
      (arg === "--allow-recent" ? allowRecent : allowDangerous).push(override);
      index += 2;
      continue;
    }
    if (arg.startsWith("--allow-recent=")) {
      allowRecent.push(requireOverride("--allow-recent", arg.slice("--allow-recent=".length)));
      index += 1;
      continue;
    }
    if (arg.startsWith("--allow-dangerous=")) {
      allowDangerous.push(requireOverride("--allow-dangerous", arg.slice("--allow-dangerous=".length)));
      index += 1;
      continue;
    }
    break;
  }
  return { options: { json, allowRecent, allowDangerous }, rest: args.slice(index) };
}

function validateSpecifier(specifier: string): void {
  let parsed: npa.Result;
  try {
    parsed = npa(specifier);
  } catch {
    if (
      /^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*@workspace:(?:\*|[~^]?(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)?)$/.test(
        specifier,
      )
    ) {
      return;
    }
    throw new UsageError(`invalid package specification: ${specifier}`);
  }
  if (parsed.type === "directory") {
    if (!specifier.includes("file:./") && !specifier.includes("file:../")) {
      throw new UsageError(`only relative file: package specifications are supported: ${specifier}`);
    }
    return;
  }
  if (!["version", "range", "tag", "alias"].includes(parsed.type)) {
    throw new UsageError(`unsupported package source: ${specifier}`);
  }
  if (parsed.type === "alias" && "subSpec" in parsed && parsed.subSpec) {
    validateSpecifier((parsed as npa.AliasResult).subSpec.raw);
  }
}

function parseCommandOptions(args: readonly string[], global: GlobalOptions): { readonly options: CommandOptions; readonly operands: readonly string[] } {
  let frozenLockfile = false;
  let offline = false;
  let omitDev = false;
  let saveSection: SaveSection | undefined;
  let saveExact = false;
  let noSave = false;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--frozen-lockfile") {
      frozenLockfile = true;
    } else if (arg === "--offline") {
      offline = true;
    } else if (arg === "--omit=dev") {
      omitDev = true;
    } else if (arg === "--save-exact" || arg === "-E") {
      saveExact = true;
    } else if (arg === "--no-save") {
      noSave = true;
    } else {
      const section = saveFlags[arg];
      if (section !== undefined) {
        if (saveSection !== undefined && saveSection !== section) {
          throw new UsageError("save-section flags are mutually exclusive");
        }
        saveSection = section;
      } else if (arg.startsWith("-")) {
        throw new UsageError(`unknown option: ${arg}`);
      } else {
        break;
      }
    }
    index += 1;
  }
  if (noSave && (saveSection !== undefined || saveExact)) {
    throw new UsageError("--no-save conflicts with save flags");
  }
  return {
    options: {
      ...global,
      frozenLockfile,
      offline,
      omitDev,
      ...(saveSection === undefined ? {} : { saveSection }),
      saveExact,
      noSave,
    },
    operands: args.slice(index),
  };
}

function parseChildArguments(name: "run" | "exec", operands: readonly string[]): readonly string[] {
  const primary = operands[0];
  if (!primary || primary === "--") {
    throw new UsageError(`${name} requires an exact ${name === "run" ? "script" : "binary"} name`);
  }
  return [primary, ...(operands[1] === "--" ? operands.slice(2) : operands.slice(1))];
}

export function parseInvocation(args: readonly string[], invokedAsBnpmx = false): Invocation {
  const { options: global, rest } = consumeGlobal(args);
  const first = rest[0];
  if (first === "--help" || first === "-h") {
    if (!rest.slice(1).every((argument) => argument === "--json")) {
      throw new UsageError("--help cannot be combined with command operands");
    }
    return { kind: "help", json: global.json || rest.slice(1).includes("--json") };
  }
  if (first === "--version" || first === "-v") {
    if (!rest.slice(1).every((argument) => argument === "--json")) {
      throw new UsageError("--version cannot be combined with command operands");
    }
    return { kind: "version", json: global.json || rest.slice(1).includes("--json") };
  }
  if (rest.length === 0 && !invokedAsBnpmx) {
    return { kind: "help", json: global.json };
  }
  if (invokedAsBnpmx) {
    if (!first || first.startsWith("-")) {
      throw new UsageError("bnpmx requires one package specification");
    }
    validateSpecifier(first);
    const trailing = rest.slice(1);
    if (trailing[0] !== undefined && trailing[0] !== "--") {
      throw new UsageError("bnpmx target arguments must follow --");
    }
    return { kind: "bnpmx", options: global, specifier: first, targetArgs: trailing.slice(trailing[0] === "--" ? 1 : 0) };
  }
  if (!first || !commandNames.has(first)) {
    throw new UsageError(`unknown command: ${first ?? ""}`);
  }
  const name = first as ParsedCommand["name"];
  const { options, operands } = parseCommandOptions(rest.slice(1), global);
  const hasInstallPolicy = options.frozenLockfile || options.offline || options.omitDev;
  const hasSaveIntent = options.saveSection !== undefined || options.saveExact || options.noSave;
  if (name !== "install" && hasInstallPolicy) {
    throw new UsageError("install policy options are only valid for install");
  }
  if (name !== "install" && name !== "add" && hasSaveIntent) {
    throw new UsageError("save options are only valid for install or add");
  }
  if (name === "audit") {
    if (operands.length !== 0) {
      throw new UsageError("audit accepts no operands");
    }
  } else if (name === "run" || name === "exec") {
    return { kind: "command", name, options, args: parseChildArguments(name, operands) };
  } else if (name === "remove") {
    if (
      operands.length === 0 ||
      operands.some((operand) => !/^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operand))
    ) {
      throw new UsageError("remove requires at least one exact dependency name");
    }
  } else {
    if (name === "add" && operands.length === 0) {
      throw new UsageError("add requires at least one package specification");
    }
    for (const specifier of operands) {
      validateSpecifier(specifier);
    }
  }
  return { kind: "command", name, options, args: operands };
}
