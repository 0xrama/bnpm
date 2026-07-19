import { createBnpmPaths, type BnpmPaths } from "../config/paths.js";
import { readLockfileGraph } from "../lockfile/index.js";
import { discoverProject } from "../project/discovery.js";

export interface FundingEntry {
  readonly package: string;
  readonly type?: string;
  readonly url: string;
}

function funding(value: unknown): readonly { readonly type?: string; readonly url: string }[] {
  if (typeof value === "string") return [{ url: value }];
  if (Array.isArray(value)) return value.flatMap(funding);
  if (typeof value !== "object" || value === null) return [];
  const entry = value as { type?: unknown; url?: unknown };
  if (typeof entry.url !== "string") return [];
  let url: URL;
  try { url = new URL(entry.url); } catch { return []; }
  if (url.protocol !== "https:") return [];
  return [{ ...(typeof entry.type === "string" && entry.type.length > 0 ? { type: entry.type } : {}), url: url.href }];
}

export async function listFunding(options: { readonly cwd: string; readonly paths?: BnpmPaths }): Promise<readonly FundingEntry[]> {
  const discovered = await discoverProject(options.cwd);
  const root = discovered?.projectRoot ?? options.cwd;
  const paths = options.paths ?? createBnpmPaths({ cwd: root });
  const locked = await readLockfileGraph(paths.lockfile, paths.store);
  return [...locked.graph.packages.values()].sort((left, right) => left.id.localeCompare(right.id)).flatMap((pkg) => funding(pkg.manifest.funding).map((entry) => ({ package: pkg.id, ...entry })));
}
