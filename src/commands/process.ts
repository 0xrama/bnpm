import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { parseManifest } from "../project/manifest.js";
import { analyzePackage } from "../security/analyzer.js";
import type { Output } from "../core/output.js";
import packageMetadata from "../../package.json" with { type: "json" };

export class ProcessCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessCommandError";
  }
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function execute(options: {
  readonly command: string;
  readonly args?: readonly string[];
  readonly shell: boolean;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly output: Output;
  readonly attribution?: { readonly package?: string; readonly stage?: string };
  readonly environment?: Readonly<Record<string, string>>;
  readonly passthrough?: boolean;
}): Promise<number> {
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    shell: options.shell,
    stdio: options.passthrough ? "inherit" : ["inherit", "pipe", "pipe"],
    env: { ...process.env, ...options.environment, PATH: [join(options.cwd, "node_modules", ".bin"), process.env.PATH].filter((value): value is string => Boolean(value)).join(delimiter) },
    windowsHide: true,
  });
  let bytes = 0;
  const limit = 8 * 1024 * 1024;
  const consume = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    bytes += chunk.length;
    if (bytes <= limit) options.output.childOutput(stream, chunk.toString("utf8"), options.attribution);
    else if (bytes - chunk.length <= limit) options.output.childOutput("stderr", `[output truncated after ${limit} bytes]`, { ...options.attribution, truncated: true });
  };
  if (!options.passthrough) {
    child.stdout!.on("data", (chunk: Buffer) => consume("stdout", chunk));
    child.stderr!.on("data", (chunk: Buffer) => consume("stderr", chunk));
  }
  const abort = (): void => { child.kill("SIGTERM"); };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => resolve(exitCode ?? (exitSignal === "SIGINT" ? 130 : 1)));
    });
    if (options.signal.aborted) throw options.signal.reason;
    return code;
  } finally {
    options.signal.removeEventListener("abort", abort);
  }
}

export async function runProjectScript(cwd: string, name: string, args: readonly string[], signal: AbortSignal, output: Output, allowedDangerous: ReadonlySet<string>, lifecycleEnvironment: Readonly<Record<string, string>> = {}): Promise<number> {
  const path = join(cwd, "package.json");
  const bytes = await readFile(path, "utf8");
  const strict = parseManifest(bytes, path);
  const raw = JSON.parse(bytes) as { version?: unknown; scripts?: unknown };
  if (raw.scripts === null || typeof raw.scripts !== "object" || Array.isArray(raw.scripts)) throw new ProcessCommandError("package.json does not define scripts");
  const command = (raw.scripts as Record<string, unknown>)[name];
  if (typeof command !== "string" || command.length === 0) throw new ProcessCommandError(`Unknown project script: ${name}`);
  const version = typeof raw.version === "string" ? raw.version : "0.0.0";
  const packageName = strict.name ?? "project";
  const analyzed = await analyzePackage({ root: cwd, packageName, packageVersion: version, integrity: "local-project" });
  const dangerous = analyzed.analysis.findings.filter((finding) => finding.severity === "dangerous");
  if (dangerous.length > 0 && !allowedDangerous.has(`${packageName}@${version}`)) {
    output.info(`Project script analysis found ${dangerous.length} dangerous behavior${dangerous.length === 1 ? "" : "s"}`, dangerous);
    throw new ProcessCommandError(`Project script blocked by security policy: ${name}`);
  }
  const fullCommand = args.length === 0 ? command : `${command} ${args.map(shellQuote).join(" ")}`;
  return execute({ command: fullCommand, shell: true, cwd, signal, output, attribution: { package: `${packageName}@${version}`, stage: `run:${name}` }, environment: { INIT_CWD: cwd, npm_command: "run-script", npm_lifecycle_event: name, npm_package_json: path, npm_package_name: packageName, npm_package_version: version, npm_node_execpath: process.execPath, npm_execpath: process.argv[1] ?? "bnpm", npm_config_user_agent: `bnpm/${packageMetadata.version} node/${process.versions.node} ${process.platform} ${process.arch}`, ...lifecycleEnvironment } });
}

export async function runProjectScriptIfPresent(cwd: string, name: string, signal: AbortSignal, output: Output, allowedDangerous: ReadonlySet<string>, lifecycleEnvironment: Readonly<Record<string, string>> = {}): Promise<void> {
  const path = join(cwd, "package.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as { scripts?: unknown };
  if (raw.scripts === undefined) return;
  if (raw.scripts === null || typeof raw.scripts !== "object" || Array.isArray(raw.scripts)) throw new ProcessCommandError("package.json scripts must be an object");
  if (!Object.prototype.hasOwnProperty.call(raw.scripts, name)) return;
  const code = await runProjectScript(cwd, name, [], signal, output, allowedDangerous, lifecycleEnvironment);
  if (code !== 0) throw new ProcessCommandError(`Project script ${name} exited with ${code}`);
}

export async function projectScriptNames(cwd: string): Promise<ReadonlySet<string>> {
  const path = join(cwd, "package.json");
  const bytes = await readFile(path, "utf8");
  parseManifest(bytes, path);
  const raw = JSON.parse(bytes) as { scripts?: unknown };
  if (raw.scripts === undefined) return new Set();
  if (raw.scripts === null || typeof raw.scripts !== "object" || Array.isArray(raw.scripts)) throw new ProcessCommandError("package.json scripts must be an object");
  const names = new Set<string>();
  for (const [name, command] of Object.entries(raw.scripts)) {
    if (typeof command !== "string") throw new ProcessCommandError(`package.json script ${name} must be a string`);
    names.add(name);
  }
  return names;
}

export async function runProjectScriptLifecycle(cwd: string, name: string, args: readonly string[], signal: AbortSignal, output: Output, allowedDangerous: ReadonlySet<string>, includeHooks = true): Promise<number> {
  const scripts = await projectScriptNames(cwd);
  if (!scripts.has(name)) {
    if (name !== "start") throw new ProcessCommandError(`Unknown project script: ${name}`);
    try { await access(join(cwd, "server.js")); } catch { throw new ProcessCommandError(`Unknown project script: ${name}`); }
    const manifestPath = join(cwd, "package.json"); const bytes = await readFile(manifestPath, "utf8"); const strict = parseManifest(bytes, manifestPath);
    const raw = JSON.parse(bytes) as { version?: unknown }; const version = typeof raw.version === "string" ? raw.version : "0.0.0"; const packageName = strict.name ?? "project";
    const analyzed = await analyzePackage({ root: cwd, packageName, packageVersion: version, integrity: "local-project" });
    const dangerous = analyzed.analysis.findings.filter((finding) => finding.severity === "dangerous");
    if (dangerous.length > 0 && !allowedDangerous.has(`${packageName}@${version}`)) {
      output.info(`Project script analysis found ${dangerous.length} dangerous behavior${dangerous.length === 1 ? "" : "s"}`, dangerous);
      throw new ProcessCommandError("Project start fallback blocked by security policy");
    }
    return execute({ command: process.execPath, args: ["server.js", ...args], shell: false, cwd, signal, output, attribution: { package: `${packageName}@${version}`, stage: "run:start" }, environment: { INIT_CWD: cwd, npm_command: "start", npm_lifecycle_event: "start", npm_package_json: manifestPath, npm_package_name: packageName, npm_package_version: version, npm_node_execpath: process.execPath, npm_execpath: process.argv[1] ?? "bnpm", npm_config_user_agent: `bnpm/${packageMetadata.version} node/${process.versions.node} ${process.platform} ${process.arch}` } });
  }
  for (const stage of includeHooks ? [`pre${name}`, name, `post${name}`] : [name]) {
    if (!scripts.has(stage)) continue;
    const code = await runProjectScript(cwd, stage, stage === name ? args : [], signal, output, allowedDangerous);
    if (code !== 0) return code;
  }
  return 0;
}

export async function runProjectInstallLifecycle(cwd: string, signal: AbortSignal, output: Output, allowedDangerous: ReadonlySet<string>): Promise<number> {
  const scripts = await projectScriptNames(cwd);
  for (const stage of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"]) {
    if (!scripts.has(stage)) continue;
    const code = await runProjectScript(cwd, stage, [], signal, output, allowedDangerous);
    if (code !== 0) return code;
  }
  return 0;
}

export async function execInstalled(cwd: string, binary: string, args: readonly string[], signal: AbortSignal, output: Output, passthrough = false): Promise<number> {
  if (!/^[A-Za-z0-9._-]+$/.test(binary)) throw new ProcessCommandError(`Invalid executable name: ${binary}`);
  const path = join(cwd, "node_modules", ".bin", process.platform === "win32" ? `${binary}.cmd` : binary);
  try { await access(path); } catch { throw new ProcessCommandError(`Installed executable not found: ${binary}`); }
  if (process.platform === "win32") {
    const shim = await readFile(path, "utf8");
    const match = /(?:^|\r?\n)@?node\s+"([^"]+)"\s+%\*\s*(?:\r?\n|$)/i.exec(shim);
    if (!match?.[1]) throw new ProcessCommandError(`Installed executable has an unsupported Windows shim: ${binary}`);
    const expanded = match[1].replace(/^%~dp0[\\/]/i, "");
    const target = resolve(dirname(path), expanded);
    return execute({ command: process.execPath, args: [target, ...args], shell: false, cwd, signal, output, attribution: { package: binary, stage: "exec" }, passthrough });
  }
  return execute({ command: path, args, shell: false, cwd, signal, output, attribution: { package: binary, stage: "exec" }, passthrough });
}

export async function exploreInstalled(cwd: string, packageName: string, command: readonly string[], signal: AbortSignal, output: Output): Promise<number> {
  if (!/^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packageName)) throw new ProcessCommandError(`Invalid package name: ${packageName}`);
  let packageRoot: string;
  try { packageRoot = await realpath(join(cwd, "node_modules", ...packageName.split("/"))); } catch { throw new ProcessCommandError(`Installed package not found: ${packageName}`); }
  const manifestPath = join(packageRoot, "package.json");
  parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
  const executable = command[0] ?? (process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh");
  if (command.length > 0 && (!/^[A-Za-z0-9._+-]+$/.test(executable) || executable.includes(".."))) throw new ProcessCommandError(`Invalid explore executable: ${executable}`);
  return execute({ command: executable, args: command.slice(1), shell: false, cwd: packageRoot, signal, output, attribution: { package: packageName, stage: "explore" } });
}
