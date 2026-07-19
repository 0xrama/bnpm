import npa from "npm-package-arg";
import semver from "semver";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { extractPackageArchive } from "../cache/archive.js";
import { downloadUnverifiedToQuarantine } from "../cache/quarantine.js";
import { parseManifest } from "../project/manifest.js";
import type { RegistryConfiguration } from "../registry/configuration.js";
import type { PackageVersionManifest } from "../registry/types.js";
import { ResolutionError, type PackageSourceProvider, type SourcePackage } from "./registry-resolver.js";
import { packPackage } from "../package/pack.js";

export interface RemoteSourceProviderOptions {
  readonly quarantineRoot: string;
  readonly registryConfiguration: RegistryConfiguration;
  readonly fetch?: typeof globalThis.fetch;
  readonly runGit?: (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<string>;
  readonly prepareGit?: (packageRoot: string, manifest: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<void>;
}

export type GitPreparer = NonNullable<RemoteSourceProviderOptions["prepareGit"]>;

async function defaultRunGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
  });
  const stdout: Buffer[] = [];
  let bytes = 0;
  let exceeded = false;
  const consume = (chunk: Buffer, keep: boolean): void => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { exceeded = true; child.kill("SIGTERM"); return; }
    if (keep) stdout.push(Buffer.from(chunk));
  };
  child.stdout.on("data", (chunk: Buffer) => consume(chunk, true));
  child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
  const abort = (): void => { child.kill("SIGTERM"); };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => child.kill("SIGTERM"), 2 * 60_000);
  timer.unref();
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code, closedSignal) => resolvePromise({ code, signal: closedSignal }));
    });
    if (signal?.aborted) throw signal.reason;
    if (exceeded) throw new ResolutionError("git produced more than 1 MiB of output");
    if (result.code !== 0) throw new ResolutionError(`git ${args[0] ?? "command"} failed (${result.code ?? result.signal})`);
    return Buffer.concat(stdout).toString("utf8").trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function gitTagForRange(output: string, range: string): string {
  const validRange = semver.validRange(range);
  if (!validRange) throw new ResolutionError(`invalid git semver range ${range}`);
  const tags = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^[a-f0-9]{40}\s+refs\/tags\/(.+?)(?:\^\{\})?$/i.exec(line.trim());
    const tag = match?.[1];
    if (!tag) continue;
    const version = semver.valid(tag);
    if (version && semver.satisfies(version, validRange)) tags.set(tag, version);
  }
  const selected = [...tags].sort(([leftTag, leftVersion], [rightTag, rightVersion]) => semver.rcompare(leftVersion, rightVersion) || leftTag.localeCompare(rightTag))[0];
  if (!selected) throw new ResolutionError(`no git tag satisfies ${range}`);
  return `refs/tags/${selected[0]}`;
}

function safeGitSubdir(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.includes("\\") || normalized.split("/").some((part) => !part || part === "." || part === "..") || !/^[A-Za-z0-9._/-]+$/.test(normalized)) {
    throw new ResolutionError("git package subdirectory is unsafe");
  }
  return normalized;
}

function gitBuildRequired(manifest: Readonly<Record<string, unknown>>): boolean {
  const scripts = manifest.scripts;
  const hasBuildScript = typeof scripts === "object" && scripts !== null && !Array.isArray(scripts) && ["preinstall", "install", "postinstall", "prepare"].some((stage) => typeof (scripts as Record<string, unknown>)[stage] === "string");
  const bundles = manifest.bundleDependencies ?? manifest.bundledDependencies;
  return hasBuildScript || manifest.workspaces !== undefined || bundles === true || (Array.isArray(bundles) && bundles.length > 0);
}

async function gitModules(directory: string, repository: URL, runGit: (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<string>, signal?: AbortSignal): Promise<readonly string[]> {
  try { if (!(await stat(join(directory, ".gitmodules"))).isFile()) return []; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const output = await runGit(["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.url$"], directory, signal);
  const names: string[] = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const match = /^submodule\.(.+)\.url\s+(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2] || !/^[A-Za-z0-9._/-]+$/.test(match[1])) throw new ResolutionError("git submodule configuration is malformed");
    const raw = match[2];
    let url: URL;
    try {
      if (raw.startsWith("./") || raw.startsWith("../")) url = new URL(raw, `${repository.href.replace(/\/+$/, "")}/`);
      else url = new URL(raw);
    } catch { throw new ResolutionError(`git submodule ${match[1]} has an invalid URL`); }
    if (!secureGitUrl(url)) throw new ResolutionError(`git submodule ${match[1]} must use HTTPS or SSH without embedded passwords`);
    names.push(match[1]);
  }
  if (names.length === 0) throw new ResolutionError(".gitmodules does not declare any valid submodule URLs");
  return names.sort((left, right) => left.localeCompare(right));
}

async function findGitModuleRoots(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  let directories = 0;
  const walk = async (directory: string): Promise<void> => {
    directories += 1;
    if (directories > 20_000) throw new ResolutionError("git submodule scan exceeds 20,000 directories");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isFile() && entry.name === ".gitmodules") found.push(directory);
      else if (entry.isDirectory()) await walk(join(directory, entry.name));
    }
  };
  await walk(root);
  return found.sort((left, right) => left.localeCompare(right));
}

async function initializeSubmodules(checkout: string, repository: URL, runGit: (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<string>, signal?: AbortSignal): Promise<void> {
  const names = await gitModules(checkout, repository, runGit, signal);
  if (names.length === 0) return;
  const overrides = names.flatMap((name) => ["-c", `submodule.${name}.update=checkout`]);
  await runGit([...overrides, "submodule", "update", "--init", "--depth=1"], checkout, signal);
  for (const directory of await findGitModuleRoots(checkout)) {
    if (directory === checkout) continue;
    const originValue = await runGit(["remote", "get-url", "origin"], directory, signal);
    const origin = new URL(originValue);
    if (!secureGitUrl(origin)) throw new ResolutionError("nested git submodule origin must use HTTPS or SSH without embedded passwords");
    await gitModules(directory, origin, runGit, signal);
  }
  await runGit([...overrides, "submodule", "update", "--init", "--recursive", "--depth=1"], checkout, signal);
}

function gitRepository(parsed: npa.Result): URL {
  const hosted = parsed.hosted as undefined | { https(options?: { noCommittish?: boolean; noGitPlus?: boolean }): string };
  const value = typeof parsed.fetchSpec === "string" ? parsed.fetchSpec : hosted?.https({ noCommittish: true, noGitPlus: true });
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new ResolutionError("git dependency does not provide a valid HTTPS repository URL"); }
  if (!secureGitUrl(url)) throw new ResolutionError("git dependencies must use HTTPS or SSH without embedded passwords, query, or fragment");
  return url;
}

function secureGitUrl(url: URL): boolean {
  return (url.protocol === "https:" || url.protocol === "ssh:") && !url.password && !url.search && !url.hash && (url.protocol === "ssh:" || !url.username);
}

export class RemoteSourceProvider implements PackageSourceProvider {
  readonly #pending = new Map<string, Promise<SourcePackage>>();
  readonly #temporaryDirectories = new Set<string>();
  constructor(readonly options: RemoteSourceProviderOptions) {}

  async resolve(name: string, specifier: string, fromDirectory: string, signal?: AbortSignal): Promise<SourcePackage | undefined> {
    let parsed: npa.Result;
    try { parsed = npa.resolve(name, specifier, fromDirectory); } catch { return undefined; }
    if (parsed.type !== "remote" && parsed.type !== "git" && parsed.type !== "file") return undefined;
    if (parsed.type === "file") {
      const path = typeof parsed.fetchSpec === "string" ? parsed.fetchSpec : ""; const canonical = resolve(path); const key = pathToFileURL(canonical).href;
      let pending = this.#pending.get(key); if (!pending) { pending = this.#materializeLocalArchive(name, canonical); this.#pending.set(key, pending); }
      try { return await pending; } catch (error) { this.#pending.delete(key); throw error; }
    }
    const url = parsed.type === "remote" ? new URL(parsed.fetchSpec as string) : gitRepository(parsed);
    if (parsed.type === "remote" && (url.protocol !== "https:" || url.username || url.password || url.hash)) throw new ResolutionError(`remote tarball for ${name} must be an HTTPS URL without credentials or fragment`);
    const gitSubdir = safeGitSubdir((parsed as npa.Result & { readonly gitSubdir?: string }).gitSubdir);
    const key = parsed.type === "git" ? `${url.href}#${parsed.gitRange === undefined ? parsed.gitCommittish ?? "HEAD" : `semver:${parsed.gitRange}`}:${gitSubdir ?? ""}` : url.href;
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = parsed.type === "git" ? this.#materializeGit(name, url, parsed.gitCommittish ?? "HEAD", parsed.gitRange ?? undefined, gitSubdir, signal) : this.#materialize(name, url, signal);
      this.#pending.set(key, pending);
    }
    try { return await pending; }
    catch (error) { this.#pending.delete(key); throw error; }
  }

  async #materializeLocalArchive(requestedName: string, archive: string): Promise<SourcePackage> {
    const info = await stat(archive); if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new ResolutionError(`local package archive for ${requestedName} is invalid or exceeds 512 MiB`);
    const bytes = await readFile(archive); const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    await mkdir(this.options.quarantineRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.options.quarantineRoot, "file-")); const extractedPath = join(directory, "extracted");
    try {
      const extracted = await extractPackageArchive(archive, extractedPath); const manifestPath = join(extracted.path, "package.json"); const raw = JSON.parse(await readFile(manifestPath, "utf8")) as PackageVersionManifest;
      parseManifest(JSON.stringify(raw), manifestPath);
      if (typeof raw.name !== "string" || typeof raw.version !== "string" || !semver.valid(raw.version)) throw new ResolutionError(`local package archive ${archive} requires a valid package name and semantic version`);
      this.#temporaryDirectories.add(directory);
      return { actualName: raw.name, version: raw.version, manifest: { ...raw, dist: { integrity, tarball: pathToFileURL(archive).href } }, integrity, tarball: pathToFileURL(archive), preparedPath: extracted.path, source: "tarball" };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }

  async cleanup(): Promise<void> {
    const paths = [...this.#temporaryDirectories];
    this.#temporaryDirectories.clear();
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  }

  async #materialize(requestedName: string, url: URL, signal?: AbortSignal): Promise<SourcePackage> {
    const quarantined = await downloadUnverifiedToQuarantine(url, {
      root: this.options.quarantineRoot,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      headers: (target) => this.options.registryConfiguration.headersFor(target),
      ...(signal === undefined ? {} : { signal }),
    });
    const directory = dirname(quarantined.path);
    const extractedPath = join(directory, "extracted");
    try {
      const extracted = await extractPackageArchive(quarantined.path, extractedPath);
      const manifestPath = join(extracted.path, "package.json");
      const bytes = await readFile(manifestPath, "utf8");
      parseManifest(bytes, manifestPath);
      const raw = JSON.parse(bytes) as PackageVersionManifest;
      if (typeof raw.name !== "string" || typeof raw.version !== "string" || !semver.valid(raw.version)) {
        throw new ResolutionError(`remote tarball ${url.href} requires a valid package name and semantic version`);
      }
      const manifest: PackageVersionManifest = { ...raw, dist: { integrity: quarantined.integrity, tarball: url.href } };
      this.#temporaryDirectories.add(directory);
      return {
        actualName: raw.name,
        version: raw.version,
        manifest,
        integrity: quarantined.integrity,
        tarball: url,
        preparedPath: extracted.path,
        source: "tarball",
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async #materializeGit(requestedName: string, repository: URL, ref: string, range: string | undefined, subdir: string | undefined, signal?: AbortSignal): Promise<SourcePackage> {
    await mkdir(this.options.quarantineRoot, { recursive: true });
    const directory = await mkdtemp(join(this.options.quarantineRoot, "git-"));
    const checkout = join(directory, "checkout");
    await mkdir(checkout);
    const runGit = this.options.runGit ?? defaultRunGit;
    try {
      await runGit(["init", "--quiet"], checkout, signal);
      await runGit(["remote", "add", "origin", repository.href], checkout, signal);
      const selectedRef = range === undefined ? ref : gitTagForRange(await runGit(["ls-remote", "--tags", "origin"], checkout, signal), range);
      await runGit(["fetch", "--quiet", "--depth=1", "--filter=blob:none", "origin", selectedRef], checkout, signal);
      await runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"], checkout, signal);
      await initializeSubmodules(checkout, repository, runGit, signal);
      const commit = await runGit(["rev-parse", "--verify", "HEAD"], checkout, signal);
      if (!/^[a-f0-9]{40}$/i.test(commit)) throw new ResolutionError("git did not resolve an exact commit");
      const packageRoot = subdir === undefined ? checkout : resolve(checkout, ...subdir.split("/"));
      if (packageRoot !== checkout && !packageRoot.startsWith(`${checkout}${sep}`)) throw new ResolutionError("git package subdirectory escapes the checkout");
      const sourceManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Readonly<Record<string, unknown>>;
      if (gitBuildRequired(sourceManifest)) {
        if (!this.options.prepareGit) throw new ResolutionError("git package requires a build but no approved build workflow is available");
        await this.options.prepareGit(packageRoot, sourceManifest, signal);
      }
      const artifact = await packPackage(packageRoot);
      const tarballPath = join(directory, "package.tgz");
      await writeFile(tarballPath, artifact.tarball, { flag: "wx", mode: 0o600 });
      const extracted = await extractPackageArchive(tarballPath, join(directory, "extracted"));
      await rm(checkout, { recursive: true, force: true });
      const exactUrl = new URL(`git+${repository.href}#${commit}${subdir === undefined ? "" : `::path:${subdir}`}`);
      const manifest = { ...artifact.manifest, name: artifact.name, version: artifact.version, dist: { integrity: artifact.integrity, tarball: exactUrl.href } } as unknown as PackageVersionManifest;
      this.#temporaryDirectories.add(directory);
      return { actualName: artifact.name, version: artifact.version, manifest, integrity: artifact.integrity, tarball: exactUrl, preparedPath: extracted.path, source: "git" };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
