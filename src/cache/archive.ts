import { createReadStream } from "node:fs";
import { mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, posix, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";

export interface ArchiveLimits {
  readonly maxEntries?: number;
  readonly maxExpandedBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxCompressionRatio?: number;
}

export interface ExtractedArchive {
  readonly path: string;
  readonly entries: number;
  readonly expandedBytes: number;
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(`Archive error: ${message}`);
    this.name = "ArchiveError";
  }
}

const defaults = {
  maxEntries: 100_000,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 200,
} as const;

function safeRelativePath(name: string, expectedPrefix: string | undefined): { readonly prefix: string; readonly relative?: string } {
  if (name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new ArchiveError(`unsafe entry path ${JSON.stringify(name)}`);
  }
  const normalized = posix.normalize(name);
  if (normalized === ".." || normalized.startsWith("../")) throw new ArchiveError(`entry escapes package root: ${name}`);
  const parts = normalized.split("/").filter(Boolean);
  const prefix = parts[0];
  if (!prefix) throw new ArchiveError(`archive entry has no package prefix: ${name}`);
  if (expectedPrefix !== undefined && prefix !== expectedPrefix) throw new ArchiveError(`entry is outside the archive package prefix: ${name}`);
  const relative = parts.slice(1).join("/");
  return relative.length === 0 ? { prefix } : { prefix, relative };
}

function contained(root: string, relative: string): string {
  const target = resolve(root, ...relative.split("/"));
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new ArchiveError(`entry escapes extraction root: ${relative}`);
  return target;
}

export async function extractPackageArchive(tarballPath: string, destination: string, limits: ArchiveLimits = {}): Promise<ExtractedArchive> {
  const compressedBytes = (await stat(tarballPath)).size;
  const maxEntries = limits.maxEntries ?? defaults.maxEntries;
  const maxExpandedBytes = limits.maxExpandedBytes ?? defaults.maxExpandedBytes;
  const maxFileBytes = limits.maxFileBytes ?? defaults.maxFileBytes;
  const maxCompressionRatio = limits.maxCompressionRatio ?? defaults.maxCompressionRatio;
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const root = await realpath(destination);
  let entries = 0;
  let expandedBytes = 0;
  let archivePrefix: string | undefined;
  const seen = new Map<string, { readonly type: "directory" | "file"; readonly size: number; readonly executable: boolean; readonly digest?: string }>();
  const extract = tar.extract();
  let rejectCompletion: (error: unknown) => void = () => undefined;

  const completion = new Promise<void>((resolvePromise, reject) => {
    rejectCompletion = reject;
    extract.once("finish", resolvePromise);
    extract.once("error", reject);
    extract.on("entry", (header, stream, next) => {
      void (async () => {
        entries += 1;
        if (entries > maxEntries) throw new ArchiveError(`archive exceeds ${maxEntries} entries`);
        const safePath = safeRelativePath(header.name, archivePrefix);
        archivePrefix ??= safePath.prefix;
        const relative = safePath.relative;
        if (relative === undefined) {
          stream.resume();
          stream.once("end", next);
          return;
        }
        const target = contained(root, relative);
        const prior = seen.get(relative);
        if (header.type === "directory") {
          if (prior && prior.type !== "directory") throw new ArchiveError(`conflicting duplicate archive entry ${relative}`);
          seen.set(relative, { type: "directory", size: 0, executable: false });
          await mkdir(target, { recursive: true, mode: 0o755 });
          stream.resume();
          stream.once("end", next);
          return;
        }
        if (header.type !== "file") throw new ArchiveError(`unsupported ${header.type} entry ${relative}`);
        const declaredSize = header.size ?? 0;
        const executable = ((header.mode ?? 0) & 0o111) !== 0;
        if (declaredSize > maxFileBytes) throw new ArchiveError(`${relative} exceeds the per-file size limit`);
        if (prior) {
          if (prior.type !== "file" || prior.size !== declaredSize || prior.executable !== executable) {
            throw new ArchiveError(`conflicting duplicate archive entry ${relative}`);
          }
          const duplicateHash = createHash("sha256");
          let duplicateBytes = 0;
          for await (const value of stream) {
            const chunk = Buffer.from(value);
            duplicateBytes += chunk.length;
            expandedBytes += chunk.length;
            if (duplicateBytes > maxFileBytes || expandedBytes > maxExpandedBytes) throw new ArchiveError("archive exceeds expanded-size limits");
            if (compressedBytes === 0 || expandedBytes > compressedBytes * maxCompressionRatio) {
              throw new ArchiveError(`archive exceeds the ${maxCompressionRatio}:1 compression-ratio limit`);
            }
            duplicateHash.update(chunk);
          }
          if (duplicateBytes !== declaredSize || duplicateHash.digest("hex") !== prior.digest) {
            throw new ArchiveError(`conflicting duplicate archive entry ${relative}`);
          }
          next();
          return;
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        const file = await open(target, "wx", executable ? 0o755 : 0o644);
        const contentHash = createHash("sha256");
        try {
          let fileBytes = 0;
          for await (const value of stream) {
            const chunk = Buffer.from(value);
            fileBytes += chunk.length;
            expandedBytes += chunk.length;
            if (fileBytes > maxFileBytes || expandedBytes > maxExpandedBytes) throw new ArchiveError("archive exceeds expanded-size limits");
            if (compressedBytes === 0 || expandedBytes > compressedBytes * maxCompressionRatio) {
              throw new ArchiveError(`archive exceeds the ${maxCompressionRatio}:1 compression-ratio limit`);
            }
            contentHash.update(chunk);
            await file.write(chunk);
          }
          if (fileBytes !== declaredSize) throw new ArchiveError(`archive entry size mismatch for ${relative}`);
          seen.set(relative, { type: "file", size: fileBytes, executable, digest: contentHash.digest("hex") });
        } finally {
          await file.close();
        }
        next();
      })().catch((error: unknown) => {
        stream.resume();
        extract.destroy();
        rejectCompletion(error);
      });
    });
  });

  const source = createReadStream(tarballPath);
  const gunzip = createGunzip();
  source.once("error", (error) => extract.destroy(error));
  gunzip.once("error", (error) => extract.destroy(error));
  source.pipe(gunzip).pipe(extract);
  try {
    await completion;
    await stat(join(root, "package.json"));
    return { path: root, entries, expandedBytes };
  } catch (error) {
    source.destroy();
    gunzip.destroy();
    await rm(destination, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ArchiveError("archive does not contain package/package.json");
    throw error;
  }
}
