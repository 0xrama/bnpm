import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { resolve } from "node:path";
import npa from "npm-package-arg";
import { extractPackageArchive } from "../cache/archive.js";
import { downloadToQuarantine } from "../cache/quarantine.js";
import { createBnpmPaths, type BnpmPaths } from "../config/paths.js";
import { packPackage } from "../package/pack.js";
import { discoverProject } from "../project/discovery.js";
import { loadRegistryConfiguration } from "../registry/configuration.js";
import { RegistryError } from "../registry/client.js";
import { viewPackage } from "../registry/operations.js";
import { RemoteSourceProvider } from "../resolver/source-provider.js";

export interface PackageDiff { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] }

export interface DiffRenderOptions {
  readonly paths?: readonly string[];
  readonly nameOnly?: boolean;
  readonly unified?: number;
  readonly ignoreAllSpace?: boolean;
  readonly noPrefix?: boolean;
  readonly srcPrefix?: string;
  readonly dstPrefix?: string;
  readonly text?: boolean;
}

async function hashes(root: string): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  if (entries.length > 100_000) throw new RegistryError("Package diff exceeds 100,000 files");
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(root, path).split(sep).join("/");
    const bytes = await readFile(path);
    if (bytes.length > 128 * 1024 * 1024) throw new RegistryError(`Package diff file ${name} exceeds 128 MiB`);
    result.set(name, createHash("sha256").update(bytes).digest("hex"));
  }
  return result;
}

export async function comparePackageTrees(localRoot: string, remoteRoot: string): Promise<PackageDiff> {
  const [local, remote] = await Promise.all([hashes(localRoot), hashes(remoteRoot)]);
  const added = [...local.keys()].filter((path) => !remote.has(path)).sort();
  const removed = [...remote.keys()].filter((path) => !local.has(path)).sort();
  const changed = [...local.keys()].filter((path) => remote.has(path) && remote.get(path) !== local.get(path)).sort();
  return { added, removed, changed };
}

function selected(path: string, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((raw) => {
    const filter = raw.replace(/^\.\//, "").replaceAll("\\", "/").replace(/\/$/, "");
    if (!filter) return true;
    const escaped = filter.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("?", "[^/]").replaceAll("\u0000", ".*");
    return path === filter || path.startsWith(`${filter}/`) || new RegExp(`^${escaped}$`).test(path);
  });
}

interface LineOperation { readonly kind: "equal" | "add" | "remove"; readonly line: string }

function lineOperations(before: string, after: string, ignoreAllSpace: boolean): readonly LineOperation[] {
  const left = before.length === 0 ? [] : before.split("\n"); const right = after.length === 0 ? [] : after.split("\n");
  const normalized = (value: string): string => ignoreAllSpace ? value.replace(/\s+/g, "") : value;
  const cells = (left.length + 1) * (right.length + 1);
  if (cells > 4_000_000) return [...left.map((line): LineOperation => ({ kind: "remove", line })), ...right.map((line): LineOperation => ({ kind: "add", line }))];
  const matrix = new Uint32Array(cells); const width = right.length + 1;
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
    const offset = leftIndex * width + rightIndex;
    matrix[offset] = normalized(left[leftIndex] ?? "") === normalized(right[rightIndex] ?? "") ? 1 + (matrix[offset + width + 1] ?? 0) : Math.max(matrix[offset + width] ?? 0, matrix[offset + 1] ?? 0);
  }
  const operations: LineOperation[] = []; let leftIndex = 0; let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    if (leftIndex < left.length && rightIndex < right.length && normalized(left[leftIndex] ?? "") === normalized(right[rightIndex] ?? "")) { operations.push({ kind: "equal", line: right[rightIndex] ?? "" }); leftIndex += 1; rightIndex += 1; }
    else if (rightIndex < right.length && (leftIndex >= left.length || (matrix[leftIndex * width + rightIndex + 1] ?? 0) > (matrix[(leftIndex + 1) * width + rightIndex] ?? 0))) { operations.push({ kind: "add", line: right[rightIndex] ?? "" }); rightIndex += 1; }
    else { operations.push({ kind: "remove", line: left[leftIndex] ?? "" }); leftIndex += 1; }
  }
  return operations;
}

function hunks(operations: readonly LineOperation[], context: number): string {
  const changed = operations.flatMap((operation, index) => operation.kind === "equal" ? [] : [index]);
  if (changed.length === 0) return "";
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context); const end = Math.min(operations.length, index + context + 1); const previous = ranges.at(-1);
    if (previous && start <= previous[1]) previous[1] = end; else ranges.push([start, end]);
  }
  const oldBefore = new Uint32Array(operations.length + 1); const newBefore = new Uint32Array(operations.length + 1);
  for (let index = 0; index < operations.length; index += 1) { const operation = operations[index]; oldBefore[index + 1] = (oldBefore[index] ?? 0) + (operation?.kind === "add" ? 0 : 1); newBefore[index + 1] = (newBefore[index] ?? 0) + (operation?.kind === "remove" ? 0 : 1); }
  return ranges.map(([start, end]) => {
    const oldCount = (oldBefore[end] ?? 0) - (oldBefore[start] ?? 0); const newCount = (newBefore[end] ?? 0) - (newBefore[start] ?? 0);
    const oldStart = oldCount === 0 ? oldBefore[start] ?? 0 : (oldBefore[start] ?? 0) + 1; const newStart = newCount === 0 ? newBefore[start] ?? 0 : (newBefore[start] ?? 0) + 1;
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
    return [header, ...operations.slice(start, end).map((operation) => `${operation.kind === "add" ? "+" : operation.kind === "remove" ? "-" : " "}${operation.line}`)].join("\n");
  }).join("\n");
}

export async function renderPackageDiff(beforeRoot: string, afterRoot: string, difference: PackageDiff, options: DiffRenderOptions = {}): Promise<string> {
  const files = [...new Set([...difference.added, ...difference.removed, ...difference.changed])].filter((path) => selected(path, options.paths ?? [])).sort();
  if (options.nameOnly) return files.join("\n");
  const sourcePrefix = options.noPrefix ? "" : options.srcPrefix ?? "a/"; const destinationPrefix = options.noPrefix ? "" : options.dstPrefix ?? "b/";
  const output: string[] = [];
  for (const path of files) {
    const added = difference.added.includes(path); const removed = difference.removed.includes(path);
    const before = added ? Buffer.alloc(0) : await readFile(join(beforeRoot, ...path.split("/"))); const after = removed ? Buffer.alloc(0) : await readFile(join(afterRoot, ...path.split("/")));
    const source = added ? "/dev/null" : `${sourcePrefix}${path}`; const destination = removed ? "/dev/null" : `${destinationPrefix}${path}`;
    const binary = !options.text && (before.includes(0) || after.includes(0));
    const body = binary ? `Binary files ${source} and ${destination} differ` : hunks(lineOperations(before.toString("utf8"), after.toString("utf8"), options.ignoreAllSpace === true), options.unified ?? 3);
    if (!body) continue;
    output.push(`diff --git ${sourcePrefix}${path} ${destinationPrefix}${path}`, `--- ${source}`, `+++ ${destination}`, body);
  }
  return output.filter((line) => line.length > 0).join("\n");
}

function normalizeDiffSpecifier(spec: string, packageName: string): string {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(spec) ? `${packageName}@${spec.replace(/^v/, "")}` : spec;
}

interface MaterializedTree { readonly root: string; readonly id: string; cleanup(): Promise<void> }

async function registryTree(spec: string, options: { readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<MaterializedTree> {
  const metadata = await viewPackage({ spec, paths: options.paths, ...(options.registry === undefined ? {} : { registry: options.registry }), ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const dist = metadata.dist;
  if (typeof metadata.name !== "string" || typeof metadata.version !== "string" || typeof dist !== "object" || dist === null || Array.isArray(dist) || typeof (dist as { integrity?: unknown }).integrity !== "string" || typeof (dist as { tarball?: unknown }).tarball !== "string") throw new RegistryError("Registry version metadata is missing exact distribution data");
  const configuration = await loadRegistryConfiguration({ userNpmrc: options.paths.userNpmrc, projectNpmrc: options.paths.projectNpmrc, ...(options.registry === undefined ? {} : { defaultRegistry: options.registry }) });
  const remote = await downloadToQuarantine(new URL((dist as { tarball: string }).tarball), (dist as { integrity: string }).integrity, { root: options.paths.quarantine, headers: (url) => configuration.headersFor(url), ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const temporary = dirname(remote.path); const extracted = await extractPackageArchive(remote.path, join(temporary, "extracted"));
  return { root: extracted.path, id: `${metadata.name}@${metadata.version}`, cleanup: async () => rm(temporary, { recursive: true, force: true }) };
}

async function materializeComparison(spec: string, cwd: string, options: { readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<MaterializedTree> {
  let parsed: npa.Result;
  try { parsed = npa(spec, cwd); } catch { return registryTree(spec, options); }
  if (parsed.type === "directory") {
    const directory = resolve(String(parsed.fetchSpec)); const artifact = await packPackage(directory); const temporary = await mkdtemp(join(options.paths.quarantine, "diff-directory-"));
    try { const path = join(temporary, artifact.filename); await writeFile(path, artifact.tarball, { flag: "wx", mode: 0o600 }); const extracted = await extractPackageArchive(path, join(temporary, "extracted")); return { root: extracted.path, id: artifact.id, cleanup: async () => rm(temporary, { recursive: true, force: true }) }; }
    catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }
  if (parsed.type === "remote" || parsed.type === "git") {
    const configuration = await loadRegistryConfiguration({ userNpmrc: options.paths.userNpmrc, projectNpmrc: options.paths.projectNpmrc, ...(options.registry === undefined ? {} : { defaultRegistry: options.registry }) });
    const provider = new RemoteSourceProvider({ quarantineRoot: options.paths.quarantine, registryConfiguration: configuration, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    try {
      const sourced = await provider.resolve("bnpm-diff", spec, cwd, options.signal);
      if (!sourced) throw new RegistryError(`Unsupported package comparison source: ${spec}`);
      return { root: sourced.preparedPath, id: `${sourced.actualName}@${sourced.version}`, cleanup: async () => provider.cleanup() };
    } catch (error) { await provider.cleanup(); throw error; }
  }
  return registryTree(spec, options);
}

export async function diffPackage(options: { readonly cwd: string; readonly spec?: string; readonly specs?: readonly string[]; readonly filters?: readonly string[]; readonly render?: DiffRenderOptions; readonly tag?: string; readonly paths?: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<PackageDiff & { readonly local: string; readonly remote: string; readonly text: string }> {
  const discovered = await discoverProject(options.cwd);
  const packageRoot = discovered?.importerRoot ?? options.cwd;
  const artifact = await packPackage(packageRoot);
  const paths = options.paths ?? createBnpmPaths({ cwd: packageRoot });
  await mkdir(paths.quarantine, { recursive: true, mode: 0o700 });
  const localTemporary = await mkdtemp(join(paths.quarantine, "diff-local-"));
  const comparisons: MaterializedTree[] = [];
  try {
    const localTarball = join(localTemporary, `${randomBytes(8).toString("hex")}.tgz`);
    await writeFile(localTarball, artifact.tarball, { flag: "wx", mode: 0o600 });
    const localExtracted = await extractPackageArchive(localTarball, join(localTemporary, "extracted"));
    const requested = (options.specs ?? (options.spec === undefined ? [] : [options.spec])).map((spec) => normalizeDiffSpecifier(spec, artifact.name));
    if (requested.length > 2) throw new RegistryError("Package diff accepts at most two comparison specifications");
    const common = { paths, ...(options.registry === undefined ? {} : { registry: options.registry }), ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.signal === undefined ? {} : { signal: options.signal }) };
    const first = requested.length === 2 ? await materializeComparison(requested[0] as string, packageRoot, common) : undefined;
    const second = await materializeComparison(requested.at(-1) ?? `${artifact.name}@${options.tag ?? "latest"}`, packageRoot, common);
    if (first) comparisons.push(first); comparisons.push(second);
    const beforeRoot = first?.root ?? second.root; const afterRoot = first ? second.root : localExtracted.path;
    const rawDifference = await comparePackageTrees(afterRoot, beforeRoot);
    const filters = options.filters ?? [];
    const difference: PackageDiff = { added: rawDifference.added.filter((path) => selected(path, filters)), removed: rawDifference.removed.filter((path) => selected(path, filters)), changed: rawDifference.changed.filter((path) => selected(path, filters)) };
    const render = { ...options.render, ...(options.filters === undefined ? {} : { paths: options.filters }) };
    return { ...difference, local: first?.id ?? artifact.id, remote: first ? second.id : second.id, text: await renderPackageDiff(beforeRoot, afterRoot, difference, render) };
  } finally {
    await rm(localTemporary, { recursive: true, force: true });
    await Promise.all(comparisons.map((comparison) => comparison.cleanup()));
  }
}
