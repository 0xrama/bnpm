import { chmod, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createBnpmPaths, type BnpmPaths } from "../config/paths.js";
import { discoverProject } from "./discovery.js";
import { ManifestError } from "./manifest.js";

interface LinkManifest { readonly name: string; readonly version: string; readonly bin: Readonly<Record<string, string>> }
const packageName = /^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function manifest(root: string): Promise<LinkManifest> {
  const value = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown; bin?: unknown };
  if (typeof value.name !== "string" || !packageName.test(value.name) || typeof value.version !== "string") throw new ManifestError(`${root}/package.json requires a valid name and version`);
  const bin: Record<string, string> = {};
  if (typeof value.bin === "string") bin[value.name.includes("/") ? value.name.slice(value.name.lastIndexOf("/") + 1) : value.name] = value.bin;
  else if (typeof value.bin === "object" && value.bin !== null && !Array.isArray(value.bin)) {
    for (const [name, path] of Object.entries(value.bin)) if (/^[A-Za-z0-9._-]+$/.test(name) && typeof path === "string") bin[name] = path;
  }
  for (const path of Object.values(bin)) if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new ManifestError(`${root}/package.json has an unsafe bin path`);
  return { name: value.name, version: value.version, bin };
}

function packagePath(nodeModules: string, name: string): string {
  return join(nodeModules, ...name.split("/"));
}

async function replaceWithLink(path: string, target: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) throw new ManifestError(`refusing to replace non-link path ${path}`);
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const linkParent = await realpath(dirname(path));
  const relativeTarget = process.platform === "win32" ? target : relative(linkParent, target) || ".";
  await symlink(relativeTarget, path, process.platform === "win32" ? "junction" : "dir");
}

async function writeBins(binRoot: string, packageRoot: string, packageId: string, bins: Readonly<Record<string, string>>): Promise<void> {
  await mkdir(binRoot, { recursive: true });
  const canonicalBinRoot = await realpath(binRoot);
  for (const [name, entry] of Object.entries(bins)) {
    const executable = resolve(packageRoot, ...entry.split(/[\\/]/));
    if (executable !== packageRoot && !executable.startsWith(`${packageRoot}${sep}`)) throw new ManifestError(`bin ${name} escapes linked package`);
    const shim = join(binRoot, process.platform === "win32" ? `${name}.cmd` : name);
    try {
      if (process.platform === "win32") {
        if (!(await readFile(shim, "utf8")).startsWith(`@REM bnpm-link:${packageId}\r\n`)) throw new ManifestError(`refusing to replace bin ${shim} owned by another package`);
      } else {
        const info = await lstat(shim);
        if (!info.isSymbolicLink() || await realpath(shim) !== executable) throw new ManifestError(`refusing to replace bin ${shim} owned by another package`);
      }
      await rm(shim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (process.platform === "win32") await writeFile(shim, `@REM bnpm-link:${packageId}\r\n@node "${executable.replaceAll('"', '""')}" %*\r\n`, { mode: 0o755 });
    else {
      await symlink(relative(canonicalBinRoot, executable), shim);
      await chmod(executable, (await lstat(executable)).mode | 0o111);
    }
  }
}

async function removeBins(binRoot: string, packageRoot: string, packageId: string, bins: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, entry] of Object.entries(bins)) {
    const shim = join(binRoot, process.platform === "win32" ? `${name}.cmd` : name);
    try {
      if (process.platform === "win32") {
        if ((await readFile(shim, "utf8")).startsWith(`@REM bnpm-link:${packageId}\r\n`)) await rm(shim);
      } else if ((await realpath(shim)) === resolve(packageRoot, ...entry.split(/[\\/]/))) await rm(shim);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function removeOwnedLink(path: string, expectedTarget?: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!info) return;
  if (!info.isSymbolicLink()) throw new ManifestError(`refusing to remove non-link path ${path}`);
  if (expectedTarget && await realpath(path) !== await realpath(expectedTarget)) throw new ManifestError(`link ${path} does not point to the expected package`);
  await rm(path);
}

export async function registerLink(options: { readonly cwd: string; readonly paths?: BnpmPaths }): Promise<{ readonly name: string; readonly target: string }> {
  const target = await realpath(options.cwd);
  const value = await manifest(target);
  const paths = options.paths ?? createBnpmPaths({ cwd: target });
  const link = packagePath(join(paths.globalRoot, "node_modules"), value.name);
  await replaceWithLink(link, target);
  await writeBins(paths.globalBin, target, value.name, value.bin);
  return { name: value.name, target };
}

export async function linkPackages(options: { readonly cwd: string; readonly names: readonly string[]; readonly paths?: BnpmPaths }): Promise<readonly { readonly name: string; readonly target: string }[]> {
  const discovered = await discoverProject(options.cwd);
  const project = discovered?.importerRoot ?? options.cwd;
  const paths = options.paths ?? createBnpmPaths({ cwd: project });
  const results: { name: string; target: string }[] = [];
  for (const name of options.names) {
    if (!packageName.test(name)) throw new ManifestError(`invalid linked package name ${name}`);
    const globalLink = packagePath(join(paths.globalRoot, "node_modules"), name);
    const target = await realpath(globalLink);
    const value = await manifest(target);
    if (value.name !== name) throw new ManifestError(`global link ${name} points to package ${value.name}`);
    await replaceWithLink(packagePath(join(project, "node_modules"), name), target);
    await writeBins(join(project, "node_modules", ".bin"), target, name, value.bin);
    results.push({ name, target });
  }
  return results;
}

export async function unregisterLink(options: { readonly cwd: string; readonly names: readonly string[]; readonly paths?: BnpmPaths }): Promise<readonly string[]> {
  const paths = options.paths ?? createBnpmPaths({ cwd: options.cwd });
  if (options.names.length === 0) {
    const target = await realpath(options.cwd);
    const value = await manifest(target);
    await removeOwnedLink(packagePath(join(paths.globalRoot, "node_modules"), value.name), target);
    await removeBins(paths.globalBin, target, value.name, value.bin);
    return [value.name];
  }
  const discovered = await discoverProject(options.cwd);
  const project = discovered?.importerRoot ?? options.cwd;
  for (const name of options.names) {
    if (!packageName.test(name)) throw new ManifestError(`invalid linked package name ${name}`);
    const path = packagePath(join(project, "node_modules"), name);
    const target = await realpath(path);
    const value = await manifest(target);
    await removeOwnedLink(path);
    await removeBins(join(project, "node_modules", ".bin"), target, name, value.bin);
  }
  return [...options.names];
}
