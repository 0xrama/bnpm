import { spawn } from "node:child_process";
import semver from "semver";
import { createBnpmPaths, type BnpmPaths } from "../config/paths.js";
import { verifyCache } from "../cache/commands.js";
import { pingRegistry } from "../registry/operations.js";

export interface DoctorCheck {
  readonly name: "node" | "git" | "registry" | "cache";
  readonly ok: boolean;
  readonly detail: string;
}

async function gitVersion(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise(output.trim()) : reject(new Error(`git exited with ${code}`)));
  });
}

export async function diagnose(options: {
  readonly cwd: string;
  readonly paths?: BnpmPaths;
  readonly registry?: URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly git?: () => Promise<string>;
}): Promise<readonly DoctorCheck[]> {
  const paths = options.paths ?? createBnpmPaths({ cwd: options.cwd });
  const checks: DoctorCheck[] = [];
  const nodeOk = semver.satisfies(process.versions.node, ">=22.22.2");
  checks.push({ name: "node", ok: nodeOk, detail: process.version });
  try { checks.push({ name: "git", ok: true, detail: await (options.git ?? gitVersion)() }); }
  catch (error) { checks.push({ name: "git", ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  try {
    const ping = await pingRegistry({ paths, ...(options.registry === undefined ? {} : { registry: options.registry }), ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
    checks.push({ name: "registry", ok: true, detail: ping.registry });
  } catch (error) {
    checks.push({ name: "registry", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    const cache = await verifyCache(paths);
    checks.push({ name: "cache", ok: cache.corrupt.length === 0, detail: `${cache.valid}/${cache.entries} entries valid` });
  } catch (error) {
    checks.push({ name: "cache", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  return checks;
}
