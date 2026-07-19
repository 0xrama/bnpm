import { lstat, mkdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BnpmPaths } from "../config/paths.js";

export async function ensureGlobalProject(paths: BnpmPaths): Promise<void> {
  await mkdir(paths.globalRoot, { recursive: true, mode: 0o755 });
  const manifest = join(paths.globalRoot, "package.json");
  try {
    await writeFile(manifest, '{\n  "name": "bnpm-global",\n  "private": true,\n  "dependencies": {}\n}\n', { encoding: "utf8", mode: 0o644, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function exposeGlobalBins(paths: BnpmPaths): Promise<void> {
  const target = join(paths.globalRoot, "node_modules", ".bin");
  await mkdir(target, { recursive: true, mode: 0o755 });
  await mkdir(dirname(paths.globalBin), { recursive: true, mode: 0o755 });
  try {
    const existing = await lstat(paths.globalBin);
    if (existing.isSymbolicLink()) {
      const linked = await readlink(paths.globalBin);
      if (resolve(dirname(paths.globalBin), linked) === target) return;
    }
    if (existing.isDirectory() && process.platform === "win32") return;
    throw new Error(`Global bin path already exists and is not managed by bnpm: ${paths.globalBin}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${paths.globalBin}.${randomUUID()}.tmp`;
  try {
    await symlink(process.platform === "win32" ? target : relative(dirname(temporary), target), temporary, process.platform === "win32" ? "junction" : "dir");
    await rename(temporary, paths.globalBin);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
