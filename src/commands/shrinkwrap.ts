import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { BnpmPaths } from "../config/paths.js";
import { createBnpmPaths } from "../config/paths.js";
import { readLockfileGraph, writeLockfileAtomic, LockfileError } from "../lockfile/index.js";
import { discoverProject } from "../project/discovery.js";
import type { Requirement, ResolutionGraph, ResolvedPackage } from "../resolver/types.js";

const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const copiedRootFields = ["name", "version", "license", "engines", "os", "cpu", "bin", "workspaces", ...dependencyFields] as const;
const maximumOccurrences = 100_000;

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LockfileError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function selectedFields(source: Readonly<Record<string, unknown>>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap((field) => source[field] === undefined ? [] : [[field, source[field]]]));
}

function manifestRecord(pkg: ResolvedPackage): Record<string, unknown> {
  return pkg.manifest as unknown as Record<string, unknown>;
}

function packageEntry(pkg: ResolvedPackage, alias: string, flags: { readonly dev: boolean; readonly optional: boolean }): Record<string, unknown> {
  if (pkg.source !== undefined && pkg.source !== "registry") {
    throw new LockfileError(`npm-shrinkwrap export does not support ${pkg.source} source ${pkg.id}`);
  }
  const manifest = manifestRecord(pkg);
  const scripts = manifest.scripts;
  const hasInstallScript = typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
    && ["preinstall", "install", "postinstall"].some((stage) => typeof (scripts as Record<string, unknown>)[stage] === "string");
  return {
    ...(alias === pkg.name ? {} : { name: pkg.name }),
    version: pkg.version,
    resolved: pkg.tarball.href,
    integrity: pkg.integrity,
    ...(flags.dev ? { dev: true } : {}),
    ...(flags.optional ? { optional: true } : {}),
    ...(hasInstallScript ? { hasInstallScript: true } : {}),
    ...selectedFields(manifest, ["license", "engines", "os", "cpu", "bin", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]),
  };
}

interface Occurrence {
  readonly path: string;
  readonly alias: string;
  readonly id: string;
  readonly dev: boolean;
  readonly optional: boolean;
  readonly available: ReadonlyMap<string, string>;
  readonly ancestors: ReadonlySet<string>;
}

export function createNpmShrinkwrap(
  graph: ResolutionGraph,
  rootManifest: Readonly<Record<string, unknown>>,
  requirements: readonly Requirement[],
  importer = ".",
): string {
  const roots = graph.importers?.get(importer) ?? (importer === "." ? graph.roots : undefined);
  if (!roots) throw new LockfileError(`lockfile has no importer ${importer}`);
  const requirementKinds = new Map(requirements.filter((requirement) => (requirement.importer ?? ".") === importer).map((requirement) => [requirement.name, requirement.kind]));
  const entries = new Map<string, Record<string, unknown>>();
  entries.set("", selectedFields(rootManifest, copiedRootFields));
  const rootAvailability = new Map(roots);
  const queue: Occurrence[] = [...roots].sort(([left], [right]) => left.localeCompare(right)).map(([alias, id]) => ({
    path: `node_modules/${alias}`,
    alias,
    id,
    dev: requirementKinds.get(alias) === "dev",
    optional: requirementKinds.get(alias) === "optional",
    available: rootAvailability,
    ancestors: new Set<string>(),
  }));
  for (let index = 0; index < queue.length; index += 1) {
    if (index >= maximumOccurrences) throw new LockfileError(`npm-shrinkwrap export exceeds ${maximumOccurrences} package occurrences`);
    const occurrence = queue[index] as Occurrence;
    if (entries.has(occurrence.path)) continue;
    const pkg = graph.packages.get(occurrence.id);
    if (!pkg) throw new LockfileError(`package occurrence points to missing ${occurrence.id}`);
    entries.set(occurrence.path, packageEntry(pkg, occurrence.alias, occurrence));
    const ancestors = new Set(occurrence.ancestors); ancestors.add(occurrence.id);
    const available = new Map(occurrence.available); available.set(pkg.name, occurrence.id);
    for (const [alias, dependencyId] of [...pkg.dependencies].sort(([left], [right]) => left.localeCompare(right))) {
      if (available.get(alias) === dependencyId || ancestors.has(dependencyId)) continue;
      const childAvailability = new Map(available); childAvailability.set(alias, dependencyId);
      queue.push({ path: `${occurrence.path}/node_modules/${alias}`, alias, id: dependencyId, dev: occurrence.dev, optional: occurrence.optional, available: childAvailability, ancestors });
    }
  }
  const packages = Object.fromEntries([...entries].sort(([left], [right]) => left === "" ? -1 : right === "" ? 1 : left.localeCompare(right)));
  const name = typeof rootManifest.name === "string" ? rootManifest.name : undefined;
  const version = typeof rootManifest.version === "string" ? rootManifest.version : undefined;
  return `${JSON.stringify({ ...(name === undefined ? {} : { name }), ...(version === undefined ? {} : { version }), lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

export async function shrinkwrapProject(cwd: string): Promise<{ readonly path: string; readonly packages: number }> {
  const discovered = await discoverProject(cwd);
  if (!discovered) throw new LockfileError("no package.json was found for the current project");
  const paths: BnpmPaths = createBnpmPaths({ cwd: discovered.projectRoot });
  const importer = discovered.importerRoot === discovered.projectRoot ? "." : relative(discovered.projectRoot, discovered.importerRoot).split(sep).join("/");
  const manifestPath = resolve(discovered.importerRoot, "package.json");
  const manifest = object(JSON.parse(await readFile(manifestPath, "utf8")), manifestPath);
  const locked = await readLockfileGraph(paths.lockfile, paths.store);
  const bytes = createNpmShrinkwrap(locked.graph, manifest, locked.requirements, importer);
  const path = resolve(discovered.importerRoot, "npm-shrinkwrap.json");
  await writeLockfileAtomic(path, bytes);
  return { path, packages: Object.keys(object((JSON.parse(bytes) as Record<string, unknown>).packages, "packages")).length - 1 };
}
