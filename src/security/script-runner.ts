import { spawn } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LifecycleFact } from "./analyzer.js";
import packageMetadata from "../../package.json" with { type: "json" };

export class ScriptExecutionError extends Error {
  constructor(message: string) {
    super(`Lifecycle script failed: ${message}`);
    this.name = "ScriptExecutionError";
  }
}

const removedEnvironment = /(?:TOKEN|PASSWORD|SECRET|AUTH|COOKIE|NPM_CONFIG_USERCONFIG)/i;
const bundledToolBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../..", "node_modules", ".bin");

export async function runLifecycle(options: {
  readonly fact: LifecycleFact;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
  readonly maxOutputBytes?: number;
  readonly onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  readonly initialCwd?: string;
}): Promise<void> {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!removedEnvironment.test(key)) environment[key] = value;
  environment.npm_lifecycle_event = options.fact.stage;
  environment.npm_package_name = options.fact.packageName;
  environment.npm_package_version = options.fact.packageVersion;
  environment.npm_package_json = join(options.cwd, "package.json");
  environment.npm_command = "install";
  environment.npm_node_execpath = process.execPath;
  environment.npm_execpath = process.argv[1] ?? "bnpm";
  environment.npm_config_user_agent = `bnpm/${packageMetadata.version} node/${process.versions.node} ${process.platform} ${process.arch}`;
  environment.INIT_CWD = options.initialCwd ?? options.cwd;
  environment.PATH = [join(options.cwd, "node_modules", ".bin"), bundledToolBin, environment.PATH].filter((value): value is string => Boolean(value)).join(delimiter);
  const child = spawn(options.fact.command, {
    cwd: options.cwd,
    env: environment,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const maxOutput = options.maxOutputBytes ?? 1024 * 1024;
  let outputBytes = 0;
  let truncated = false;
  const consume = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    if (truncated) return;
    outputBytes += chunk.length;
    if (outputBytes > maxOutput) {
      truncated = true;
      options.onOutput?.("stderr", `[output truncated after ${maxOutput} bytes]`);
      child.kill("SIGTERM");
      return;
    }
    options.onOutput?.(stream, chunk.toString("utf8"));
  };
  child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk));
  const abort = (): void => { child.kill("SIGTERM"); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMilliseconds ?? 5 * 60_000);
  timer.unref();
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (options.signal?.aborted) throw options.signal.reason;
    if (truncated) throw new ScriptExecutionError(`${options.fact.packageName}@${options.fact.packageVersion} ${options.fact.stage} exceeded output limits`);
    if (result.code !== 0) throw new ScriptExecutionError(`${options.fact.packageName}@${options.fact.packageVersion} ${options.fact.stage} exited with ${result.code ?? result.signal}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
