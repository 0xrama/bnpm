import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, lstat, mkdir, readFile, readlink, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { selectExpectedIntegrity } from "../security/integrity.js";

export function storePath(root: string, integrity: string): string {
  const expected = selectExpectedIntegrity(integrity);
  return join(root, expected.algorithm, expected.digest.toString("hex"));
}

async function makeImmutable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await makeImmutable(path);
      await chmod(path, 0o555);
    } else if (entry.isFile()) {
      const mode = (await stat(path)).mode;
      await chmod(path, mode & 0o111 ? 0o555 : 0o444);
    }
  }
}

export function includeLocalPackagePath(root: string, path: string): boolean {
  const first = relative(root, path).split(/[\\/]/)[0];
  return first !== "node_modules" && first !== ".git" && first !== ".bnpm" && first !== "bnpm-lock.yaml" && first !== ".bnpm-store.json";
}

export async function hashLocalPackage(root: string, maxBytes = 1024 * 1024 * 1024): Promise<string> {
  const hash = createHash("sha512");
  let bytes = 0;
  const visit = async (path: string): Promise<void> => {
    if (!includeLocalPackagePath(root, path)) return;
    const info = await lstat(path);
    const key = relative(root, path).split("\\").join("/");
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      if (target.startsWith("/") || target.split(/[\\/]/).includes("..")) throw new Error(`Local package contains unsafe symlink ${key}`);
      hash.update(`L\0${key}\0${target}\0`);
      return;
    }
    if (info.isDirectory()) {
      hash.update(`D\0${key}\0`);
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
      return;
    }
    if (!info.isFile()) throw new Error(`Local package contains unsupported entry ${key}`);
    hash.update(`F\0${key}\0${info.mode & 0o111}\0${info.size}\0`);
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error("Local package exceeds the content-size limit");
      hash.update(chunk);
    }
    hash.update("\0");
  };
  await visit(root);
  return `sha512-${hash.digest("base64")}`;
}

export async function promoteToStore(extractedPath: string, root: string, integrity: string, options: { readonly localPackage?: boolean } = {}): Promise<string> {
  const target = storePath(root, integrity);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const lock = `${target}.lock`;
  await acquireStoreLock(lock);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    if (await verifyStoreEntry(target, integrity)) return target;
    await removeStoreEntry(target);
    await cp(extractedPath, temporary, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      ...(options.localPackage ? { filter: (source: string) => source === extractedPath || includeLocalPackagePath(extractedPath, source) } : {}),
    });
    const contentIntegrity = await hashLocalPackage(temporary);
    const packageJsonHash = createHash("sha256").update(await readFile(join(temporary, "package.json"))).digest("base64");
    await writeFile(join(temporary, ".bnpm-store.json"), `${JSON.stringify({ version: 1, integrity, contentIntegrity, packageJsonHash })}\n`, { mode: 0o444, flag: "wx" });
    await makeImmutable(temporary);
    await chmod(temporary, 0o555);
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (!await verifyStoreEntry(target, integrity)) throw new Error(`Concurrent store promotion produced an invalid entry for ${integrity}`);
    return target;
  } finally {
    await makeRemovable(temporary);
    await rm(temporary, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

async function acquireStoreLock(path: string, timeoutMilliseconds = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for store lock ${path}`);
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
}

async function makeRemovable(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isDirectory()) {
      await chmod(path, 0o755);
      for (const entry of await readdir(path)) await makeRemovable(join(path, entry));
    } else if (!info.isSymbolicLink()) await chmod(path, 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function verifyStoreEntry(path: string, integrity: string, options: { readonly full?: boolean } = {}): Promise<boolean> {
  try {
    const metadata = JSON.parse(await readFile(join(path, ".bnpm-store.json"), "utf8")) as { version?: unknown; integrity?: unknown; contentIntegrity?: unknown; packageJsonHash?: unknown };
    if (metadata.version !== 1 || metadata.integrity !== integrity || typeof metadata.contentIntegrity !== "string" || typeof metadata.packageJsonHash !== "string") return false;
    const packageJson = await readFile(join(path, "package.json"));
    if (createHash("sha256").update(packageJson).digest("base64") !== metadata.packageJsonHash) return false;
    return options.full === false || await hashLocalPackage(path) === metadata.contentIntegrity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

export async function removeStoreEntry(path: string): Promise<void> {
  await makeRemovable(path);
  await rm(path, { recursive: true, force: true });
}
