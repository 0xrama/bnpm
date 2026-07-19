import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createBnpmPaths, type BnpmPaths } from "../config/paths.js";
import { discoverProject } from "../project/discovery.js";
import { parseManifest } from "../project/manifest.js";
import { ProcessCommandError } from "./process.js";
import { invalidateInstalledLayout } from "../project/invalidation.js";

const packageName = /^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseEditor(value: string): readonly string[] {
  if (!value.trim() || value.includes("\0") || /[\r\n]/.test(value)) throw new ProcessCommandError("Editor command is empty or invalid");
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/.test(character)) {
      if (current) { result.push(current); current = ""; }
    } else current += character;
  }
  if (escaped || quote) throw new ProcessCommandError("Editor command has incomplete quoting");
  if (current) result.push(current);
  if (!result[0]) throw new ProcessCommandError("Editor command is empty or invalid");
  return result;
}

export async function editInstalledPackage(options: {
  readonly cwd: string;
  readonly name: string;
  readonly signal: AbortSignal;
  readonly editor?: readonly string[];
  readonly paths?: BnpmPaths;
}): Promise<{ readonly package: string; readonly path: string }> {
  if (!packageName.test(options.name)) throw new ProcessCommandError(`Invalid package name: ${options.name}`);
  const discovered = await discoverProject(options.cwd);
  if (!discovered) throw new ProcessCommandError("No project package.json was found");
  const logical = join(discovered.importerRoot, "node_modules", ...options.name.split("/"));
  let target: string;
  try {
    const info = await lstat(logical);
    if (!info.isDirectory() && !info.isSymbolicLink()) throw new ProcessCommandError(`Installed package path is not a directory: ${options.name}`);
    target = await realpath(logical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProcessCommandError(`Installed package not found: ${options.name}`);
    throw error;
  }
  const paths = options.paths ?? createBnpmPaths({ cwd: discovered.projectRoot });
  const store = await realpath(paths.store).catch(() => resolve(paths.store));
  if (target === store || target.startsWith(`${store}${sep}`)) throw new ProcessCommandError("Refusing to edit immutable global store content directly");
  const manifestPath = join(target, "package.json");
  parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
  const editor = options.editor ?? parseEditor(process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "vi"));
  await invalidateInstalledLayout(discovered.projectRoot, `edit:${options.name}`);
  const child = spawn(editor[0] as string, [...editor.slice(1), target], { cwd: target, stdio: "inherit", windowsHide: false });
  const abort = (): void => { child.kill("SIGTERM"); };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    const code = await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolvePromise(exitCode ?? (signal === "SIGINT" ? 130 : 1)));
    });
    if (options.signal.aborted) throw options.signal.reason;
    if (code !== 0) throw new ProcessCommandError(`Editor exited with ${code}`);
    return { package: options.name, path: target };
  } finally {
    options.signal.removeEventListener("abort", abort);
  }
}
