import { storePath } from "../cache/store.js";
import type { BnpmPaths } from "../config/paths.js";
import { readLockfileGraph } from "../lockfile/index.js";
import { fetchBulkAdvisories, type RegistryAdvisory } from "../registry/audit.js";
import { analyzePackage, type AnalyzedPackage } from "./analyzer.js";
import { loadRegistryConfiguration, RegistryConfiguration } from "../registry/configuration.js";
import type { ResolutionGraph } from "../resolver/types.js";

export interface AuditResult {
  readonly analyzedAt: string;
  readonly packages: ReadonlyMap<string, AnalyzedPackage>;
  readonly advisories: readonly RegistryAdvisory[];
  readonly graph: ResolutionGraph;
}

async function forEachConcurrent<T>(values: readonly T[], concurrency: number, worker: (value: T) => Promise<void>): Promise<void> {
  let index = 0; const next = async (): Promise<void> => { while (true) { const value = values[index++]; if (value === undefined) return; await worker(value); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => next()));
}

export async function auditProject(options: { readonly paths: BnpmPaths; readonly registry?: URL; readonly registryConfiguration?: RegistryConfiguration; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal; readonly now?: Date }): Promise<AuditResult> {
  const { graph } = await readLockfileGraph(options.paths.lockfile, options.paths.store);
  const packages = new Map<string, AnalyzedPackage>();
  await forEachConcurrent([...graph.packages], 8, async ([id, pkg]) => {
    try {
      packages.set(id, await analyzePackage({
        root: storePath(options.paths.store, pkg.integrity),
        packageName: pkg.name,
        packageVersion: pkg.version,
        integrity: pkg.integrity,
        ...(pkg.manifest.scripts === undefined ? {} : { scripts: pkg.manifest.scripts }),
      }));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  });
  const configuration = options.registryConfiguration ?? await loadRegistryConfiguration({
    userNpmrc: options.paths.userNpmrc,
    projectNpmrc: options.paths.projectNpmrc,
    ...(options.registry === undefined ? {} : { defaultRegistry: options.registry }),
  });
  const packagesByRegistry = new Map<string, Map<string, import("../resolver/types.js").ResolvedPackage>>();
  for (const [id, pkg] of graph.packages) {
    if (pkg.source !== "registry" && (pkg.source !== undefined || pkg.localPath !== undefined || pkg.preparedPath !== undefined)) continue;
    const registry = configuration.registryForPackage(pkg.name).href;
    let packages = packagesByRegistry.get(registry);
    if (!packages) { packages = new Map(); packagesByRegistry.set(registry, packages); }
    packages.set(id, pkg);
  }
  const advisoryGroups = await Promise.all([...packagesByRegistry].sort(([left], [right]) => left.localeCompare(right)).map(([registry, packages]) => fetchBulkAdvisories({
    graph: { roots: new Map(), packages },
    registry: new URL(registry),
    headers: (url) => configuration.headersFor(url),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })));
  const advisories = advisoryGroups.flat().sort((left, right) => left.packageName.localeCompare(right.packageName) || String(left.id).localeCompare(String(right.id)));
  return { analyzedAt: (options.now ?? new Date()).toISOString(), packages, advisories, graph };
}
