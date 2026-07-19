import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readlink, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResolutionGraph } from "../resolver/types.js";

export class LinkerError extends Error {
  constructor(message: string) {
    super(`Linker error: ${message}`);
    this.name = "LinkerError";
  }
}

function instanceName(id: string): string {
  return id.replaceAll("/", "+");
}

function importerName(importer: string): string {
  return Buffer.from(importer).toString("base64url");
}

export function linkedPackagePath(nodeModules: string, id: string, name: string): string {
  return packagePath(join(nodeModules, ".bnpm", instanceName(id)), name);
}

async function makeInstanceWritable(root: string): Promise<void> {
  await chmod(root, 0o755);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await makeInstanceWritable(path);
    else if (entry.isFile()) await chmod(path, (await stat(path)).mode & 0o111 ? 0o755 : 0o644);
  }
}

async function cloneStoreTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: false, mode: 0o755 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".bnpm-store.json") continue;
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) await cloneStoreTree(sourcePath, targetPath);
    else if (entry.isFile()) await copyFile(sourcePath, targetPath, constants.COPYFILE_FICLONE);
    else if (entry.isSymbolicLink()) await symlink(await readlink(sourcePath), targetPath);
    else throw new LinkerError(`unsupported store entry ${sourcePath}`);
  }
}

function packagePath(instanceRoot: string, name: string): string {
  return join(instanceRoot, "node_modules", ...name.split("/"));
}

async function forEachConcurrent<T>(values: readonly T[], concurrency: number, worker: (value: T) => Promise<void>): Promise<void> {
  let index = 0;
  const next = async (): Promise<void> => { while (true) { const value = values[index++]; if (value === undefined) return; await worker(value); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => next()));
}

async function linkDirectory(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const linkTarget = process.platform === "win32" ? target : relative(dirname(path), target) || ".";
  await symlink(linkTarget, path, process.platform === "win32" ? "junction" : "dir");
}

function safeBinPath(packageRoot: string, value: string): string {
  if (value.includes("\0") || value.includes("\\") || isAbsolute(value)) throw new LinkerError(`unsafe executable path ${value}`);
  const target = resolve(packageRoot, value);
  if (target !== packageRoot && !target.startsWith(`${packageRoot}${sep}`)) throw new LinkerError(`executable escapes package root: ${value}`);
  return target;
}

function bins(name: string, value: string | Readonly<Record<string, string>> | undefined): readonly (readonly [string, string])[] {
  if (typeof value === "string") return [[basename(name), value]];
  return Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

async function createRootBins(nodeModules: string, graph: ResolutionGraph): Promise<void> {
  const binRoot = join(nodeModules, ".bin");
  await mkdir(binRoot, { recursive: true });
  for (const [alias, id] of graph.roots) {
    const pkg = graph.packages.get(id);
    if (!pkg) throw new LinkerError(`root ${alias} points to missing package ${id}`);
    const rootPackage = join(nodeModules, ...alias.split("/"));
    for (const [name, binPath] of bins(pkg.name, pkg.manifest.bin)) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new LinkerError(`invalid executable name ${name}`);
      const target = safeBinPath(rootPackage, binPath);
      const linkPath = join(binRoot, name);
      const relativeTarget = relative(binRoot, target);
      if (process.platform === "win32") {
        const windowsTarget = relativeTarget.replaceAll("/", "\\");
        await writeFile(`${linkPath}.cmd`, `@ECHO off\r\nnode "%~dp0\\${windowsTarget}" %*\r\n`, { mode: 0o755 });
        await writeFile(`${linkPath}.ps1`, `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& node "$basedir/${relativeTarget.replaceAll("\\", "/")}" $args\nexit $LASTEXITCODE\n`, { mode: 0o755 });
      } else {
        await symlink(relativeTarget, linkPath, "file");
        await chmod(target, 0o755);
        const windowsTarget = relativeTarget.replaceAll("/", "\\");
        await writeFile(`${linkPath}.cmd`, `@ECHO off\r\nnode "%~dp0\\${windowsTarget}" %*\r\n`, { mode: 0o755 });
      }
    }
  }
}

export async function buildIsolatedLayout(
  destination: string,
  graph: ResolutionGraph,
  storeEntries: ReadonlyMap<string, string>,
): Promise<void> {
  await mkdir(destination, { recursive: false, mode: 0o755 });
  const virtualStore = join(destination, ".bnpm");
  await mkdir(virtualStore, { recursive: true });
  const instances = new Map<string, string>();
  await forEachConcurrent([...graph.packages], 8, async ([id, pkg]) => {
    const store = storeEntries.get(id);
    if (!store) throw new LinkerError(`missing verified store entry for ${id}`);
    const instance = join(virtualStore, instanceName(id));
    const target = packagePath(instance, pkg.name);
    await mkdir(dirname(target), { recursive: true });
    await cloneStoreTree(store, target);
    await makeInstanceWritable(target);
    instances.set(id, target);
  });
  await forEachConcurrent([...graph.packages], 8, async ([id, pkg]) => {
    const packageRoot = instances.get(id);
    if (!packageRoot) throw new LinkerError(`missing package instance ${id}`);
    const dependencyRoot = join(packageRoot, "node_modules");
    await mkdir(dependencyRoot, { recursive: true });
    for (const [alias, dependencyId] of pkg.dependencies) {
      const target = instances.get(dependencyId);
      if (!target) throw new LinkerError(`${id} points to missing dependency ${dependencyId}`);
      await linkDirectory(target, join(dependencyRoot, ...alias.split("/")));
    }
    await createRootBins(dependencyRoot, { roots: pkg.dependencies, packages: graph.packages });
  });
  for (const [alias, id] of graph.roots) {
    const target = instances.get(id);
    if (!target) throw new LinkerError(`root ${alias} points to missing package ${id}`);
    await linkDirectory(target, join(destination, ...alias.split("/")));
  }
  await createRootBins(destination, graph);
  for (const [importer, roots] of graph.importers ?? []) {
    if (importer === ".") continue;
    const view = join(destination, ".bnpm-importers", importerName(importer));
    await mkdir(view, { recursive: true });
    for (const [alias, id] of roots) {
      const target = instances.get(id);
      if (!target) throw new LinkerError(`importer ${importer} points to missing package ${id}`);
      await linkDirectory(target, join(view, ...alias.split("/")));
    }
    await createRootBins(view, { roots, packages: graph.packages });
  }
}

export async function activateWorkspaceImporterViews(projectRoot: string, graph: ResolutionGraph): Promise<void> {
  for (const importer of graph.importers?.keys() ?? []) {
    if (importer === "." || isAbsolute(importer) || importer.split(/[\\/]/).includes("..")) continue;
    const importerRoot = resolve(projectRoot, importer);
    if (!importerRoot.startsWith(`${projectRoot}${sep}`)) throw new LinkerError(`unsafe importer path ${importer}`);
    const target = join(importerRoot, "node_modules");
    const temporary = join(importerRoot, `.bnpm-node_modules-${randomUUID()}.tmp`);
    const backup = join(importerRoot, `.bnpm-node_modules-${randomUUID()}.backup`);
    const view = join(projectRoot, "node_modules", ".bnpm-importers", importerName(importer));
    await symlink(process.platform === "win32" ? view : relative(importerRoot, view), temporary, process.platform === "win32" ? "junction" : "dir");
    let backedUp = false;
    try {
      try { await rename(target, backup); backedUp = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(temporary, target);
      if (backedUp) await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (backedUp) { await rm(target, { recursive: true, force: true }); await rename(backup, target); }
      throw error;
    }
  }
}

export async function activateProjectLayout(projectRoot: string, preparedNodeModules: string): Promise<void> {
  const target = join(projectRoot, "node_modules");
  const backup = join(projectRoot, `.bnpm-node_modules-backup-${randomUUID()}`);
  let backedUp = false;
  try {
    try {
      await rename(target, backup);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(preparedNodeModules, target);
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (backedUp) {
      await rm(target, { recursive: true, force: true });
      await rename(backup, target);
    }
    throw error;
  }
}

export async function validateLinkedPackage(path: string, expectedName: string, expectedVersion: string): Promise<void> {
  const parsed = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
  if (parsed.name !== expectedName || parsed.version !== expectedVersion) throw new LinkerError(`linked package identity mismatch at ${path}`);
}
