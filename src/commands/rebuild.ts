import { join } from "node:path";
import { createBnpmPaths } from "../config/paths.js";
import type { BnpmPaths } from "../config/paths.js";
import { discoverProject } from "../project/discovery.js";
import { readLockfileGraph } from "../lockfile/index.js";
import { linkedPackagePath } from "../linker/project-linker.js";
import { analyzePackage, lifecycleStages, type LifecycleFact } from "../security/analyzer.js";
import { decidePackagePolicy } from "../security/policy.js";
import { runLifecycle } from "../security/script-runner.js";

export async function rebuildPackages(options: {
  readonly cwd: string;
  readonly paths?: BnpmPaths;
  readonly names?: readonly string[];
  readonly allowedDangerous?: ReadonlySet<string>;
  readonly ignoreScripts?: boolean;
  readonly signal?: AbortSignal;
  readonly onOutput?: (stream: "stdout" | "stderr", text: string, attribution: { readonly package: string; readonly stage: string }) => void;
}): Promise<{ readonly rebuilt: readonly string[]; readonly skipped: readonly string[] }> {
  const discovered = await discoverProject(options.cwd);
  const projectRoot = discovered?.projectRoot ?? options.cwd;
  const paths = options.paths ?? createBnpmPaths({ cwd: projectRoot });
  const locked = await readLockfileGraph(paths.lockfile, paths.store);
  const selected = new Set(options.names ?? []);
  const unknown = [...selected].filter((name) => ![...locked.graph.packages.values()].some((pkg) => pkg.name === name));
  if (unknown.length > 0) {
    const error = new Error(`Packages are not installed: ${unknown.join(", ")}`);
    error.name = "ResolutionError";
    throw error;
  }
  const rebuilt: string[] = [];
  const skipped: string[] = [];
  if (options.ignoreScripts) return { rebuilt, skipped };
  for (const [id, pkg] of [...locked.graph.packages].sort(([left], [right]) => left.localeCompare(right))) {
    if (selected.size > 0 && !selected.has(pkg.name)) continue;
    const root = linkedPackagePath(join(projectRoot, "node_modules"), id, pkg.name);
    const analyzed = await analyzePackage({ root, packageName: pkg.name, packageVersion: pkg.version, integrity: pkg.integrity, ...(pkg.manifest.scripts === undefined ? {} : { scripts: pkg.manifest.scripts }), stages: lifecycleStages });
    const decision = decidePackagePolicy({ analyzed, packageId: id, allowedDangerous: options.allowedDangerous ?? new Set(), ...(locked.approvals[pkg.name] === undefined ? {} : { trustedApproval: locked.approvals[pkg.name] }) });
    if (decision.blocked) {
      const error = new Error(`Dangerous package behavior blocked: ${decision.identity}`);
      error.name = "PolicyError";
      throw error;
    }
    for (const fact of decision.approvedLifecycles) {
      await runLifecycle({ fact, cwd: root, initialCwd: options.cwd, ...(options.signal === undefined ? {} : { signal: options.signal }), onOutput: (stream, text) => options.onOutput?.(stream, text, { package: decision.identity, stage: fact.stage }) });
      rebuilt.push(`${id}:${fact.stage}`);
    }
    skipped.push(...decision.skippedLifecycles.map((fact: LifecycleFact) => `${id}:${fact.stage}`));
  }
  return { rebuilt, skipped };
}
