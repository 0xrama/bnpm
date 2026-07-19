import { relative, sep } from "node:path";
import { createBnpmPaths } from "../config/paths.js";
import { readLockfileGraph } from "../lockfile/index.js";
import { discoverProject } from "../project/discovery.js";
import type { ResolutionGraph } from "../resolver/types.js";

export interface DependencyTreeNode {
  readonly alias: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly circular?: boolean;
  readonly dependencies: readonly DependencyTreeNode[];
}

export interface InstalledGraphReport {
  readonly roots: readonly DependencyTreeNode[];
  readonly paths: readonly (readonly string[])[];
  readonly human: string;
}

function treeNode(graph: ResolutionGraph, alias: string, id: string, ancestors: ReadonlySet<string>, depth: number): DependencyTreeNode {
  const pkg = graph.packages.get(id);
  if (!pkg) throw new Error(`Installed graph references missing package ${id}`);
  if (ancestors.has(id) || depth >= 100) return { alias, id, name: pkg.name, version: pkg.version, circular: true, dependencies: [] };
  const next = new Set(ancestors); next.add(id);
  const dependencies = [...pkg.dependencies]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([childAlias, childId]) => treeNode(graph, childAlias, childId, next, depth + 1));
  return { alias, id, name: pkg.name, version: pkg.version, dependencies };
}

function treeLines(nodes: readonly DependencyTreeNode[], indent = ""): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    const identity = node.alias === node.name ? `${node.name}@${node.version}` : `${node.alias} -> ${node.name}@${node.version}`;
    lines.push(`${indent}${identity}${node.circular ? " (cycle)" : ""}`);
    lines.push(...treeLines(node.dependencies, `${indent}  `));
  }
  return lines;
}

export function reportInstalledGraph(graph: ResolutionGraph, roots: ReadonlyMap<string, string>, options: { readonly names?: readonly string[]; readonly why?: string } = {}): InstalledGraphReport {
  const selected = new Set(options.names ?? []);
  const rootNodes = [...roots]
    .filter(([alias, id]) => {
      if (selected.size === 0) return true;
      const pkg = graph.packages.get(id);
      return selected.has(alias) || (pkg !== undefined && selected.has(pkg.name));
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([alias, id]) => treeNode(graph, alias, id, new Set(), 0));
  const paths: string[][] = [];
  if (options.why) {
    const target = options.why;
    const visit = (alias: string, id: string, path: readonly string[], ancestors: ReadonlySet<string>): void => {
      if (paths.length >= 100 || ancestors.has(id)) return;
      const pkg = graph.packages.get(id);
      if (!pkg) return;
      const label = alias === pkg.name ? `${pkg.name}@${pkg.version}` : `${alias} -> ${pkg.name}@${pkg.version}`;
      const nextPath = [...path, label];
      if (alias === target || pkg.name === target) paths.push(nextPath);
      const next = new Set(ancestors); next.add(id);
      for (const [childAlias, childId] of [...pkg.dependencies].sort(([left], [right]) => left.localeCompare(right))) visit(childAlias, childId, nextPath, next);
    };
    for (const [alias, id] of [...roots].sort(([left], [right]) => left.localeCompare(right))) visit(alias, id, [], new Set());
  }
  const human = options.why
    ? paths.length === 0 ? `${options.why} is not installed` : paths.map((path) => path.join(" > ")).join("\n")
    : rootNodes.length === 0 ? "No matching installed dependencies" : treeLines(rootNodes).join("\n");
  return { roots: rootNodes, paths, human };
}

export async function inspectInstalledGraph(cwd: string, options: { readonly names?: readonly string[]; readonly why?: string } = {}): Promise<InstalledGraphReport> {
  const discovered = await discoverProject(cwd);
  const projectRoot = discovered?.projectRoot ?? cwd;
  const importerRoot = discovered?.importerRoot ?? cwd;
  const paths = createBnpmPaths({ cwd: projectRoot });
  const locked = await readLockfileGraph(paths.lockfile, paths.store);
  const importer = relative(projectRoot, importerRoot).split(sep).join("/") || ".";
  const roots = locked.graph.importers?.get(importer) ?? (importer === "." ? locked.graph.roots : new Map());
  return reportInstalledGraph(locked.graph, roots, options);
}

export interface DuplicatePackage { readonly name: string; readonly versions: readonly string[]; readonly ids: readonly string[] }

export function duplicatePackages(graph: ResolutionGraph): readonly DuplicatePackage[] {
  const groups = new Map<string, { versions: Set<string>; ids: string[] }>();
  for (const pkg of graph.packages.values()) {
    const group = groups.get(pkg.name) ?? { versions: new Set(), ids: [] };
    group.versions.add(pkg.version); group.ids.push(pkg.id); groups.set(pkg.name, group);
  }
  return [...groups].filter(([, group]) => group.ids.length > 1).sort(([left], [right]) => left.localeCompare(right)).map(([name, group]) => ({ name, versions: [...group.versions].sort(), ids: group.ids.sort() }));
}

export async function findInstalledDuplicates(cwd: string): Promise<readonly DuplicatePackage[]> {
  const discovered = await discoverProject(cwd);
  const root = discovered?.projectRoot ?? cwd;
  const paths = createBnpmPaths({ cwd: root });
  return duplicatePackages((await readLockfileGraph(paths.lockfile, paths.store)).graph);
}
