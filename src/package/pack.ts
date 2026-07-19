import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, join, posix, relative, resolve, sep } from "node:path";
import { createGzip } from "node:zlib";
import packlist from "npm-packlist";
import semver from "semver";
import tar from "tar-stream";

const maxFiles = 100_000;
const maxUnpackedBytes = 1024 * 1024 * 1024;
const maxFileBytes = 128 * 1024 * 1024;
const portableTime = new Date("1985-10-26T08:15:00.000Z");
const packageName = /^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class PackError extends Error {
  constructor(message: string) {
    super(`Pack error: ${message}`);
    this.name = "PackError";
  }
}

export interface PackedFile {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
}

export interface PackedPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly shasum: string;
  readonly integrity: string;
  readonly files: readonly PackedFile[];
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly tarball: Buffer;
}

function record(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PackError(`${source} must contain a JSON object`);
  return value as Record<string, unknown>;
}

function safePath(root: string, entry: string): string {
  if (!entry || entry.includes("\0") || entry.includes("\\") || entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) {
    throw new PackError(`unsafe package path ${JSON.stringify(entry)}`);
  }
  const normalized = posix.normalize(entry);
  if (normalized === ".." || normalized.startsWith("../")) throw new PackError(`package path escapes the root: ${entry}`);
  const target = resolve(root, ...normalized.split("/"));
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new PackError(`package path escapes the root: ${entry}`);
  return target;
}

async function readRegularFile(root: string, entry: string, allowedRoots: ReadonlySet<string>): Promise<{ readonly bytes: Buffer; readonly mode: number }> {
  const path = safePath(root, entry);
  const info = await lstat(path);
  if (!info.isFile()) throw new PackError(`unsupported non-file entry ${entry}`);
  if (info.size > maxFileBytes) throw new PackError(`${entry} exceeds the ${maxFileBytes}-byte per-file limit`);
  const canonical = await realpath(path);
  if (canonical !== root && !canonical.startsWith(`${root}${sep}`) && ![...allowedRoots].some((allowed) => canonical === allowed || canonical.startsWith(`${allowed}${sep}`))) {
    throw new PackError(`${entry} resolves outside the package root and bundled dependencies`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile()) throw new PackError(`unsupported non-file entry ${entry}`);
    const bytes = await handle.readFile();
    if (bytes.length !== current.size || bytes.length > maxFileBytes) throw new PackError(`${entry} changed while it was being packed`);
    return { bytes, mode: (current.mode & 0o111) === 0 ? 0o644 : 0o755 };
  } finally {
    await handle.close();
  }
}

interface PackTree {
  readonly path: string;
  readonly package: Record<string, unknown>;
  readonly isProjectRoot: boolean;
  readonly edgesOut: Map<string, PackEdge>;
}

interface PackNode {
  readonly path: string;
  readonly target: PackTree;
  readonly isLink: boolean;
}

interface PackEdge {
  readonly peer: boolean;
  readonly dev: boolean;
  readonly to?: PackNode;
}

function dependencyNames(manifest: Record<string, unknown>, field: string): readonly string[] {
  const value = manifest[field];
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PackError(`package.json ${field} must be an object`);
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

async function installedTree(path: string, manifest: Record<string, unknown>, isProjectRoot: boolean, cache: Map<string, PackTree>): Promise<PackTree> {
  const canonical = await realpath(path);
  const existing = cache.get(canonical);
  if (existing) return existing;
  const edgesOut = new Map<string, PackEdge>();
  const tree: PackTree = { path, package: manifest, isProjectRoot, edgesOut };
  cache.set(canonical, tree);
    const prod = new Set([...dependencyNames(manifest, "dependencies"), ...dependencyNames(manifest, "optionalDependencies")]);
    const dev = new Set(dependencyNames(manifest, "devDependencies"));
    const peer = new Set(dependencyNames(manifest, "peerDependencies"));
    const relevant = isProjectRoot
      ? Array.isArray(manifest.bundleDependencies) ? manifest.bundleDependencies.filter((name): name is string => typeof name === "string") : []
      : [...prod];
    const kinds = [...new Set(relevant)].map((name) => ({ name, peer: !prod.has(name) && peer.has(name), dev: !prod.has(name) && dev.has(name) }));
    for (const kind of kinds.sort((left, right) => left.name.localeCompare(right.name))) {
      if (edgesOut.has(kind.name)) continue;
      const logical = join(path, "node_modules", ...kind.name.split("/"));
      try {
        const info = await lstat(logical);
        const targetPath = await realpath(logical);
        const raw = record(JSON.parse(await readFile(join(targetPath, "package.json"), "utf8")), join(targetPath, "package.json"));
        const target = await installedTree(targetPath, raw, false, cache);
        edgesOut.set(kind.name, { peer: kind.peer, dev: kind.dev, to: { path: logical, target, isLink: info.isSymbolicLink() || targetPath !== logical } });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        edgesOut.set(kind.name, { peer: kind.peer, dev: kind.dev });
      }
    }
  return tree;
}

function bundledEdges(tree: PackTree): readonly (readonly [string, PackEdge])[] {
  const names = tree.isProjectRoot
    ? Array.isArray(tree.package.bundleDependencies) ? tree.package.bundleDependencies.filter((name): name is string => typeof name === "string") : []
    : [...dependencyNames(tree.package, "dependencies"), ...dependencyNames(tree.package, "optionalDependencies")];
  return [...new Set(names)].sort((left, right) => left.localeCompare(right)).flatMap((name) => {
    const edge = tree.edgesOut.get(name);
    return edge && !edge.peer && !edge.dev ? [[name, edge] as const] : [];
  });
}

async function treeRoots(tree: PackTree, seen = new Set<PackTree>(), roots = new Set<string>()): Promise<ReadonlySet<string>> {
  if (seen.has(tree)) return roots;
  seen.add(tree);
  roots.add(await realpath(tree.path));
  for (const [, edge] of bundledEdges(tree)) if (edge.to) await treeRoots(edge.to.target, seen, roots);
  return roots;
}

interface BundleMapping { readonly real: string; readonly logical: string }

async function bundleMappings(tree: PackTree, root: string, logical = root, seen = new Set<string>(), mappings: BundleMapping[] = []): Promise<readonly BundleMapping[]> {
  const key = `${await realpath(tree.path)}\0${logical}`;
  if (seen.has(key)) return mappings;
  seen.add(key);
  for (const [name, edge] of bundledEdges(tree)) {
    if (!edge.to) continue;
    const real = await realpath(edge.to.target.path);
    const childLogical = join(logical, "node_modules", ...name.split("/"));
    mappings.push({ real, logical: childLogical });
    await bundleMappings(edge.to.target, root, childLogical, seen, mappings);
  }
  return mappings.sort((left, right) => right.real.length - left.real.length);
}

async function logicalSelection(root: string, entry: string, mappings: readonly BundleMapping[]): Promise<string> {
  const absolute = resolve(root, ...entry.split("/"));
  if (absolute === root || absolute.startsWith(`${root}${sep}`)) return entry;
  const canonical = await realpath(absolute);
  const mapping = mappings.find(({ real }) => canonical === real || canonical.startsWith(`${real}${sep}`));
  if (!mapping) throw new PackError(`packlist selected a path outside the package and bundled dependencies: ${entry}`);
  return relative(root, join(mapping.logical, relative(mapping.real, canonical))).split(sep).join("/");
}

function normalizeBundles(manifest: Record<string, unknown>): Record<string, unknown> {
  const value = manifest.bundleDependencies ?? manifest.bundledDependencies;
  if (value === undefined || value === false) return { ...manifest, bundleDependencies: [] };
  if (value === true) return { ...manifest, bundleDependencies: dependencyNames(manifest, "dependencies") };
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !packageName.test(name))) throw new PackError("bundleDependencies must be a boolean or an array of package names");
  return { ...manifest, bundleDependencies: [...new Set(value as string[])].sort((left, right) => left.localeCompare(right)) };
}

async function archive(entries: readonly { readonly path: string; readonly bytes: Buffer; readonly mode: number }[]): Promise<Buffer> {
  const pack = tar.pack();
  const gzip = createGzip({ level: 9 });
  const chunks: Buffer[] = [];
  const completion = new Promise<Buffer>((resolvePromise, reject) => {
    gzip.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    gzip.once("end", () => resolvePromise(Buffer.concat(chunks)));
    gzip.once("error", reject);
    pack.once("error", reject);
  });
  pack.pipe(gzip);
  for (const entry of entries) {
    await new Promise<void>((resolvePromise, reject) => {
      pack.entry({
        name: `package/${entry.path}`,
        type: "file",
        size: entry.bytes.length,
        mode: entry.mode,
        uid: 0,
        gid: 0,
        uname: "",
        gname: "",
        mtime: portableTime,
      }, entry.bytes, (error) => error ? reject(error) : resolvePromise());
    });
  }
  pack.finalize();
  return completion;
}

export async function packPackage(directory: string): Promise<PackedPackage> {
  const root = await realpath(directory);
  let manifest: Record<string, unknown>;
  try {
    manifest = record(JSON.parse(await readFile(join(root, "package.json"), "utf8")), join(root, "package.json"));
  } catch (error) {
    if (error instanceof PackError) throw error;
    throw new PackError(`${join(root, "package.json")} is missing or invalid JSON`);
  }
  const name = manifest.name;
  const version = manifest.version;
  if (typeof name !== "string" || !packageName.test(name)) throw new PackError("package.json requires a valid name");
  if (typeof version !== "string" || semver.valid(version) !== version) throw new PackError("package.json requires an exact semantic version");
  const tree = await installedTree(root, normalizeBundles(manifest), true, new Map());
  const selected = await packlist(tree);
  const allowedRoots = await treeRoots(tree);
  const mappings = await bundleMappings(tree, root);
  const logicalFiles = await Promise.all(selected.map((entry) => logicalSelection(root, entry, mappings)));
  if (logicalFiles.length > maxFiles) throw new PackError(`package exceeds the ${maxFiles}-file limit`);
  const entries: { path: string; bytes: Buffer; mode: number }[] = [];
  let unpackedSize = 0;
  for (const entry of [...new Set(logicalFiles)].sort((left, right) => left.localeCompare(right, "en"))) {
    const file = await readRegularFile(root, entry, allowedRoots);
    unpackedSize += file.bytes.length;
    if (unpackedSize > maxUnpackedBytes) throw new PackError(`package exceeds the ${maxUnpackedBytes}-byte unpacked-size limit`);
    entries.push({ path: entry, ...file });
  }
  if (!entries.some((entry) => entry.path === "package.json")) throw new PackError("packlist omitted package.json");
  const tarball = await archive(entries);
  const filename = `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
  return {
    id: `${name}@${version}`,
    name,
    version,
    filename,
    size: tarball.length,
    unpackedSize,
    shasum: createHash("sha1").update(tarball).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    files: entries.map((entry) => ({ path: entry.path, size: entry.bytes.length, mode: entry.mode })),
    manifest,
    tarball,
  };
}
