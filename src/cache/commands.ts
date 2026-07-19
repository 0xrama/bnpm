import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { BnpmPaths } from "../config/paths.js";
import { verifyStoreEntry } from "./store.js";
import { storePath } from "./store.js";

export interface CacheVerification {
  readonly entries: number;
  readonly valid: number;
  readonly corrupt: readonly string[];
}

export interface CacheEntry { readonly id: string; readonly integrity: string }

export async function listCache(paths: BnpmPaths, filter?: string): Promise<readonly CacheEntry[]> {
  const entries: CacheEntry[] = [];
  try {
    for (const algorithm of await readdir(paths.store, { withFileTypes: true })) {
      if (!algorithm.isDirectory()) continue;
      const parent = resolve(paths.store, algorithm.name);
      for (const digest of await readdir(parent, { withFileTypes: true })) {
        if (!digest.isDirectory() || digest.name.endsWith(".lock") || digest.name.includes(".tmp")) continue;
        const root = resolve(parent, digest.name);
        try {
          const metadata = JSON.parse(await readFile(resolve(root, ".bnpm-store.json"), "utf8")) as { integrity?: unknown };
          const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
          if (typeof metadata.integrity !== "string" || typeof manifest.name !== "string" || typeof manifest.version !== "string") continue;
          const id = `${manifest.name}@${manifest.version}`;
          if (filter === undefined || id === filter || manifest.name === filter) entries.push({ id, integrity: metadata.integrity });
          if (entries.length > 100_000) throw new Error("Cache contains more than 100000 store entries");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return entries.sort((left, right) => left.id.localeCompare(right.id) || left.integrity.localeCompare(right.integrity));
}

export async function verifyCache(paths: BnpmPaths): Promise<CacheVerification> {
  const entries: string[] = [];
  try {
    for (const algorithm of await readdir(paths.store, { withFileTypes: true })) {
      if (!algorithm.isDirectory()) continue;
      const parent = resolve(paths.store, algorithm.name);
      for (const digest of await readdir(parent, { withFileTypes: true })) {
        if (!digest.isDirectory() || digest.name.endsWith(".lock") || digest.name.includes(".tmp")) continue;
        entries.push(resolve(parent, digest.name));
        if (entries.length > 100_000) throw new Error("Cache contains more than 100000 store entries");
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: 0, valid: 0, corrupt: [] };
    throw error;
  }
  const corrupt: string[] = [];
  let valid = 0;
  for (const entry of entries.sort()) {
    try {
      const metadata = JSON.parse(await readFile(resolve(entry, ".bnpm-store.json"), "utf8")) as { integrity?: unknown };
      if (typeof metadata.integrity !== "string" || !await verifyStoreEntry(entry, metadata.integrity)) corrupt.push(entry);
      else valid += 1;
    } catch {
      corrupt.push(entry);
    }
  }
  return { entries: entries.length, valid, corrupt };
}

function confined(path: string, expected: string): void {
  const absolute = resolve(path);
  if (basename(absolute) !== expected || absolute === resolve("/") || dirname(absolute) === absolute) throw new Error(`Refusing unsafe cache path ${absolute}`);
}

function cacheRoot(paths: BnpmPaths): string {
  const parents = [paths.store, paths.cache, paths.quarantine].map((path) => dirname(resolve(path)));
  if (!parents.every((parent) => parent === parents[0])) throw new Error("Refusing cache paths that do not share one root");
  const root = parents[0] ?? resolve("/");
  if (root === resolve("/") || (process.env.HOME && root === resolve(process.env.HOME))) throw new Error(`Refusing unsafe cache root ${root}`);
  return root;
}

export async function ensureCacheOwnership(paths: BnpmPaths): Promise<void> {
  const root = cacheRoot(paths);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const marker = resolve(root, ".bnpm-cache-root");
  try {
    await writeFile(marker, "bnpm-cache-v1\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(marker, "utf8") !== "bnpm-cache-v1\n") throw new Error(`Cache ownership marker is invalid at ${marker}`);
  }
}

export async function cleanCache(paths: BnpmPaths): Promise<readonly string[]> {
  const targets = [[paths.store, "store"], [paths.cache, "cache"], [paths.quarantine, "quarantine"]] as const;
  for (const [path, expected] of targets) confined(path, expected);
  const root = cacheRoot(paths);
  if (await readFile(resolve(root, ".bnpm-cache-root"), "utf8").catch(() => "") !== "bnpm-cache-v1\n") throw new Error(`Refusing unowned cache root ${root}`);
  const removed: string[] = [];
  for (const [path] of targets) {
    const trash = `${path}.clean-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await rename(path, trash);
      removed.push(path);
      await rm(trash, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  return removed;
}

async function makeRemovable(path: string): Promise<void> {
  try {
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await makeRemovable(child);
      else await chmod(child, 0o600);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function cleanCacheEntries(paths: BnpmPaths, filter: string): Promise<readonly CacheEntry[]> {
  if (!filter || filter.includes("\0")) throw new Error("A cache package name or exact name@version is required");
  const root = cacheRoot(paths);
  if (await readFile(resolve(root, ".bnpm-cache-root"), "utf8").catch(() => "") !== "bnpm-cache-v1\n") throw new Error(`Refusing unowned cache root ${root}`);
  const entries = await listCache(paths, filter);
  for (const entry of entries) {
    const stored = storePath(paths.store, entry.integrity);
    const trash = `${stored}.clean-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await rename(stored, trash);
      await makeRemovable(trash);
      await rm(trash, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return entries;
}
