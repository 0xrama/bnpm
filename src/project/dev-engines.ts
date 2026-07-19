import { readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import packageMetadata from "../../package.json" with { type: "json" };
import { parseManifest } from "./manifest.js";

export class DevEnginesError extends Error {
  constructor(message: string) { super(`devEngines: ${message}`); this.name = "DevEnginesError"; }
}

interface EngineEntry { readonly name: string; readonly version?: string; readonly onFail: "error" | "warn" | "ignore" }

function entries(value: unknown, key: string): readonly EngineEntry[] {
  const raw = Array.isArray(value) ? value : [value];
  if (raw.length === 0) throw new DevEnginesError(`${key} must not be an empty array`);
  return raw.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new DevEnginesError(`${key} must be an object or array of objects`);
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name || record.name.includes("\0")) throw new DevEnginesError(`${key}.name must be a non-empty string`);
    if (record.version !== undefined && (typeof record.version !== "string" || semver.validRange(record.version) === null)) throw new DevEnginesError(`${key}.version must be a semantic version range`);
    if (record.onFail !== undefined && !["error", "warn", "ignore"].includes(String(record.onFail))) throw new DevEnginesError(`${key}.onFail must be error, warn, or ignore`);
    return { name: record.name, ...(typeof record.version === "string" ? { version: record.version } : {}), onFail: (record.onFail ?? "error") as EngineEntry["onFail"] };
  });
}

function runtimeLibc(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const report = process.report?.getReport() as { readonly header?: { readonly glibcVersionRuntime?: unknown }; readonly sharedObjects?: readonly string[] } | undefined;
  if (typeof report?.header?.glibcVersionRuntime === "string") return "glibc";
  return report?.sharedObjects?.some((value) => /(?:^|[\\/])(?:libc\.musl|ld-musl)/.test(value)) ? "musl" : undefined;
}

export async function checkDevEngines(cwd: string, options: { readonly packageManagerVersion?: string; readonly platform?: string; readonly architecture?: string; readonly libc?: string; readonly nodeVersion?: string } = {}): Promise<readonly string[]> {
  const path = join(cwd, "package.json"); const bytes = await readFile(path, "utf8"); parseManifest(bytes, path);
  const raw = JSON.parse(bytes) as { readonly devEngines?: unknown };
  if (raw.devEngines === undefined) return [];
  if (typeof raw.devEngines !== "object" || raw.devEngines === null || Array.isArray(raw.devEngines)) throw new DevEnginesError("must be an object");
  const configured = raw.devEngines as Record<string, unknown>; const supported = new Set(["cpu", "os", "libc", "runtime", "packageManager"]);
  for (const key of Object.keys(configured)) if (!supported.has(key)) throw new DevEnginesError(`unsupported key ${key}`);
  const libc = options.libc ?? runtimeLibc();
  const environment: Readonly<Record<string, { readonly name?: string; readonly version?: string }>> = {
    cpu: { name: options.architecture ?? process.arch }, os: { name: options.platform ?? process.platform }, libc: libc === undefined ? {} : { name: libc },
    runtime: { name: "node", version: options.nodeVersion ?? process.versions.node }, packageManager: { name: "bnpm", version: options.packageManagerVersion ?? packageMetadata.version },
  };
  const warnings: string[] = [];
  for (const key of [...supported].sort()) {
    if (configured[key] === undefined) continue;
    const expected = entries(configured[key], key); const actual = environment[key] ?? {};
    const matches = expected.some((entry) => entry.name === actual.name && (entry.version === undefined || (actual.version !== undefined && semver.satisfies(actual.version, entry.version))));
    if (matches) continue;
    const message = `${key} requires ${expected.map((entry) => `${entry.name}${entry.version ? `@${entry.version}` : ""}`).join(" or ")}, current ${actual.name ?? "unknown"}${actual.version ? `@${actual.version}` : ""}`;
    if (expected.some((entry) => entry.onFail === "error")) throw new DevEnginesError(message);
    if (expected.some((entry) => entry.onFail === "warn")) warnings.push(message);
  }
  return warnings;
}
