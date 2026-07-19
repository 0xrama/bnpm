import npa from "npm-package-arg";
import semver from "semver";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashLocalPackage } from "../cache/store.js";
import { parseManifest } from "../project/manifest.js";
import type { PackageDocument, PackageVersionManifest } from "../registry/types.js";
import type { Requirement, ResolutionGraph, ResolvedPackage, Resolver } from "./types.js";

export interface PackageMetadataProvider {
  packageDocument(name: string, signal?: AbortSignal): Promise<PackageDocument>;
}

export interface SourcePackage {
  readonly actualName: string;
  readonly version: string;
  readonly manifest: PackageVersionManifest;
  readonly integrity: string;
  readonly tarball: URL;
  readonly preparedPath: string;
  readonly source: "tarball" | "git";
}

export interface PackageSourceProvider {
  resolve(name: string, specifier: string, fromDirectory: string, signal?: AbortSignal): Promise<SourcePackage | undefined>;
}

export class ResolutionError extends Error {
  constructor(message: string) {
    super(`Resolution error: ${message}`);
    this.name = "ResolutionError";
  }
}

interface SelectedPackage {
  readonly requestedName: string;
  readonly actualName: string;
  readonly version: string;
  readonly manifest: PackageVersionManifest;
  readonly integrity: string;
  readonly tarball: URL;
  readonly publishedAt?: Date;
  readonly localPath?: string;
  readonly preparedPath?: string;
  readonly source?: "registry" | "directory" | "tarball" | "git";
}

interface MutablePackage {
  id: string;
  name: string;
  version: string;
  integrity: string;
  tarball: URL;
  localPath?: string;
  preparedPath?: string;
  source?: "registry" | "directory" | "tarball" | "git";
  publishedAt?: Date;
  manifest: PackageVersionManifest;
  dependencies: Map<string, string>;
}

export interface RegistryResolverOptions {
  readonly baseDirectory?: string;
  readonly workspaces?: ReadonlyMap<string, string>;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly platform?: string;
  readonly architecture?: string;
  readonly nodeVersion?: string;
  readonly libc?: string;
  readonly sourceProvider?: PackageSourceProvider;
  readonly minimumReleaseAgeMilliseconds?: number;
  readonly now?: Date;
  readonly allowedRecentVersions?: ReadonlySet<string>;
}

function allowedByList(values: readonly string[] | undefined, current: string): boolean {
  if (!values || values.length === 0) return true;
  if (values.includes(`!${current}`)) return false;
  const positives = values.filter((value) => !value.startsWith("!"));
  return positives.length === 0 || positives.includes(current) || positives.includes("any");
}

let cachedRuntimeLibc: string | undefined;
let runtimeLibcChecked = false;
function runtimeLibc(): string | undefined {
  if (runtimeLibcChecked) return cachedRuntimeLibc;
  runtimeLibcChecked = true;
  const report = process.report?.getReport() as { readonly header?: { readonly glibcVersionRuntime?: unknown }; readonly sharedObjects?: readonly string[] } | undefined;
  cachedRuntimeLibc = typeof report?.header?.glibcVersionRuntime === "string" ? "glibc" : report?.sharedObjects?.some((value) => /(?:^|[\\/])(?:libc\.musl|ld-musl)/.test(value)) ? "musl" : undefined;
  return cachedRuntimeLibc;
}

function assertCompatible(manifest: PackageVersionManifest, id: string, options: RegistryResolverOptions): void {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const libc = options.libc ?? (platform === "linux" && platform === process.platform ? runtimeLibc() : undefined);
  if (!allowedByList(manifest.os, platform)) throw new ResolutionError(`${id} does not support operating system ${platform}`);
  if (!allowedByList(manifest.cpu, architecture)) throw new ResolutionError(`${id} does not support CPU architecture ${architecture}`);
  if (platform === "linux" && manifest.libc && (!libc || !allowedByList(manifest.libc, libc))) throw new ResolutionError(`${id} does not support C library ${libc ?? "unknown"}`);
  const nodeRange = manifest.engines?.node;
  if (nodeRange && semver.validRange(nodeRange) && !semver.satisfies(nodeVersion, nodeRange)) throw new ResolutionError(`${id} requires Node.js ${nodeRange}, current ${nodeVersion}`);
}

function sortedEntries<T>(value: Readonly<Record<string, T>> | undefined): readonly (readonly [string, T])[] {
  return Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

function validateManifest(name: string, version: string, manifest: PackageVersionManifest): void {
  if (manifest.name !== name || manifest.version !== version || !semver.valid(version)) {
    throw new ResolutionError(`${name}@${version} has inconsistent registry metadata`);
  }
  if (typeof manifest.dist?.integrity !== "string" || manifest.dist.integrity.length === 0) {
    throw new ResolutionError(`${name}@${version} does not provide strong integrity metadata`);
  }
  let tarball: URL;
  try {
    tarball = new URL(manifest.dist.tarball);
  } catch {
    throw new ResolutionError(`${name}@${version} has an invalid tarball URL`);
  }
  if (tarball.protocol !== "https:") throw new ResolutionError(`${name}@${version} tarball must use HTTPS`);
}

function requestedPackage(name: string, specifier: string): { readonly actualName: string; readonly rawSpec: string } {
  let parsed: npa.Result;
  try {
    parsed = npa.resolve(name, specifier);
  } catch {
    throw new ResolutionError(`invalid requirement ${name}@${specifier}`);
  }
  if (parsed.type === "alias") {
    const alias = parsed as npa.AliasResult;
    if (!alias.subSpec.name || !["version", "range", "tag"].includes(alias.subSpec.type)) {
      throw new ResolutionError(`unsupported alias requirement ${name}@${specifier}`);
    }
    return { actualName: alias.subSpec.name, rawSpec: alias.subSpec.rawSpec };
  }
  if (!parsed.name || !["version", "range", "tag"].includes(parsed.type)) {
    throw new ResolutionError(`unsupported registry requirement ${name}@${specifier}`);
  }
  return { actualName: parsed.name, rawSpec: parsed.rawSpec };
}

function selectVersion(document: PackageDocument, specifier: string, options: RegistryResolverOptions): string {
  if (semver.valid(specifier)) return specifier;
  const tagged = document["dist-tags"][specifier];
  const range = tagged === undefined ? semver.validRange(specifier) : "*";
  if (!range) throw new ResolutionError(`${document.name}@${specifier} is not a valid version, range, or tag`);
  const candidates = Object.keys(document.versions).filter((version) => semver.valid(version) && semver.satisfies(version, range)).sort(semver.rcompare);
  if (tagged !== undefined && candidates.includes(tagged)) { candidates.splice(candidates.indexOf(tagged), 1); candidates.unshift(tagged); }
  const minimumAge = options.minimumReleaseAgeMilliseconds;
  const cutoff = minimumAge === undefined ? undefined : (options.now ?? new Date()).getTime() - minimumAge;
  const selected = candidates.find((version) => {
    if (cutoff === undefined || options.allowedRecentVersions?.has(`${document.name}@${version}`)) return true;
    const timestamp = document.time?.[version]; if (timestamp === undefined) return false;
    const published = new Date(timestamp).getTime(); return Number.isFinite(published) && published <= cutoff;
  });
  if (!selected) throw new ResolutionError(`no version of ${document.name} satisfies ${specifier}`);
  return selected;
}

export class RegistryResolver implements Resolver {
  readonly #documents = new Map<string, Promise<PackageDocument>>();
  readonly #locals = new Map<string, Promise<SelectedPackage>>();

  constructor(readonly provider: PackageMetadataProvider, readonly options: RegistryResolverOptions = {}) {}

  #document(name: string, signal?: AbortSignal): Promise<PackageDocument> {
    let pending = this.#documents.get(name);
    if (!pending) {
      pending = this.provider.packageDocument(name, signal);
      this.#documents.set(name, pending);
    }
    return pending;
  }

  async #prefetch(requirements: readonly (readonly [string, string])[], signal?: AbortSignal): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const [name, specifier] of requirements) {
      if (specifier.startsWith("file:") || specifier.startsWith("workspace:")) continue;
      try {
        const parsed = npa.resolve(name, this.options.overrides?.[name] ?? specifier);
        if (parsed.type === "remote" || parsed.type === "git") continue;
        const request = requestedPackage(name, this.options.overrides?.[name] ?? specifier);
        pending.push(this.#document(request.actualName, signal));
      } catch {
        // Resolution reports the precise unsupported requirement in deterministic order.
      }
    }
    await Promise.allSettled(pending);
  }

  async #local(path: string, requestedName: string): Promise<SelectedPackage> {
    const canonical = await realpath(path);
    let pending = this.#locals.get(canonical);
    if (!pending) {
      pending = (async () => {
        const manifestPath = resolve(canonical, "package.json");
        const bytes = await readFile(manifestPath, "utf8");
        parseManifest(bytes, manifestPath);
        const raw = JSON.parse(bytes) as PackageVersionManifest;
        if (typeof raw.name !== "string" || typeof raw.version !== "string" || !semver.valid(raw.version)) {
          throw new ResolutionError(`${manifestPath} requires a valid name and semantic version`);
        }
        const integrity = await hashLocalPackage(canonical);
        const manifest: PackageVersionManifest = { ...raw, dist: { integrity, tarball: pathToFileURL(canonical).href } };
        return {
          requestedName,
          actualName: raw.name,
          version: raw.version,
          manifest,
          integrity,
          tarball: pathToFileURL(canonical),
          localPath: canonical,
          source: "directory",
        };
      })();
      this.#locals.set(canonical, pending);
    }
    return pending;
  }

  async #select(name: string, specifier: string, fromDirectory: string, signal?: AbortSignal): Promise<SelectedPackage> {
    if (specifier.startsWith("workspace:")) {
      const workspacePath = this.options.workspaces?.get(name);
      if (!workspacePath) throw new ResolutionError(`workspace package ${name} was not found`);
      const selected = await this.#local(workspacePath, name);
      const requested = specifier.slice("workspace:".length);
      const range = requested === "*" || requested === "^" || requested === "~" ? "*" : requested;
      if (!semver.satisfies(selected.version, range)) throw new ResolutionError(`${name}@${selected.version} does not satisfy ${specifier}`);
      return selected;
    }
    const local = npa.resolve(name, specifier, fromDirectory);
    if (local.type === "directory") return this.#local(String(local.fetchSpec), name);
    if (local.type === "file") {
      const sourced = await this.options.sourceProvider?.resolve(name, specifier, fromDirectory, signal);
      if (!sourced) throw new ResolutionError(`local package archive for ${name} could not be resolved`);
      return { requestedName: name, ...sourced };
    }
    const sourced = await this.options.sourceProvider?.resolve(name, specifier, fromDirectory, signal);
    if (sourced) return { requestedName: name, ...sourced };
    const request = requestedPackage(name, specifier);
    const pending = this.#document(request.actualName, signal);
    let document: PackageDocument;
    try {
      document = await pending;
    } catch (error) {
      this.#documents.delete(request.actualName);
      throw error;
    }
    const version = selectVersion(document, request.rawSpec, this.options);
    const manifest = document.versions[version];
    if (!manifest) throw new ResolutionError(`${document.name}@${version} is missing from registry versions`);
    validateManifest(request.actualName, version, manifest);
    const published = document.time?.[version];
    const publishedAt = published === undefined ? undefined : new Date(published);
    if (publishedAt && Number.isNaN(publishedAt.getTime())) throw new ResolutionError(`${request.actualName}@${version} has an invalid publication timestamp`);
    return {
      requestedName: name,
      actualName: request.actualName,
      version,
      manifest,
      integrity: manifest.dist.integrity ?? "",
      tarball: new URL(manifest.dist.tarball),
      ...(publishedAt === undefined ? {} : { publishedAt }),
      source: "registry",
    };
  }

  async resolve(requirements: readonly Requirement[], signal?: AbortSignal): Promise<ResolutionGraph> {
    const roots = new Map<string, string>();
    const packages = new Map<string, MutablePackage>();
    const directRequirements = new Map<string, Requirement>();
    for (const requirement of requirements) {
      if (directRequirements.has(requirement.name)) throw new ResolutionError(`duplicate root requirement ${requirement.name}`);
      directRequirements.set(requirement.name, requirement);
    }
    const resolvingPeerContexts = new Set<string>();

    const resolveOne = async (name: string, specifier: string, fromDirectory: string, environment: ReadonlyMap<string, string>): Promise<string> => {
      if (signal?.aborted) throw signal.reason;
      specifier = this.options.overrides?.[name] ?? specifier;
      const selected = await this.#select(name, specifier, fromDirectory, signal);
      const baseId = `${selected.actualName}@${selected.version}`;
      assertCompatible(selected.manifest, baseId, this.options);
      await this.#prefetch([
        ...sortedEntries(selected.manifest.peerDependencies).filter(([peerName]) => !selected.manifest.peerDependenciesMeta?.[peerName]?.optional),
        ...sortedEntries(selected.manifest.dependencies),
        ...sortedEntries(selected.manifest.optionalDependencies),
      ], signal);
      const peerIds = new Map<string, string>();
      if (resolvingPeerContexts.has(baseId)) throw new ResolutionError(`cyclic peer dependency involving ${baseId}`);
      resolvingPeerContexts.add(baseId);
      try {
      for (const [peerName, peerRange] of sortedEntries(selected.manifest.peerDependencies)) {
        const optionalPeer = selected.manifest.peerDependenciesMeta?.[peerName]?.optional === true;
        const inherited = environment.get(peerName);
        if (inherited) {
          const inheritedPackage = packages.get(inherited);
          if (inheritedPackage && semver.validRange(peerRange) && semver.satisfies(inheritedPackage.version, peerRange)) {
            peerIds.set(peerName, inherited);
            continue;
          }
        }
        if (optionalPeer) continue;
        const peerSpecifier = directRequirements.get(peerName)?.specifier ?? selected.manifest.dependencies?.[peerName] ?? peerRange;
        try {
          const peerId = await resolveOne(peerName, peerSpecifier, selected.localPath ?? fromDirectory, environment);
          const peerPackage = packages.get(peerId);
          if (peerPackage && semver.validRange(peerRange) && !semver.satisfies(peerPackage.version, peerRange)) {
            throw new ResolutionError(`${baseId} requires peer ${peerName}@${peerRange} but resolved ${peerPackage.version}`);
          }
          peerIds.set(peerName, peerId);
        } catch (error) {
          throw error;
        }
      }
      } finally {
        resolvingPeerContexts.delete(baseId);
      }
      const peerContext = [...peerIds].map(([peerName, peerId]) => `${peerName}=${peerId}`).join("+");
      const id = peerContext ? `${baseId}(${peerContext})` : baseId;
      const existing = packages.get(id);
      if (existing) {
        if (existing.integrity !== selected.integrity) throw new ResolutionError(`conflicting sources resolve to ${id}`);
        return id;
      }
      const node: MutablePackage = {
        id,
        name: selected.actualName,
        version: selected.version,
        integrity: selected.integrity,
        tarball: selected.tarball,
        ...(selected.publishedAt === undefined ? {} : { publishedAt: selected.publishedAt }),
        ...(selected.localPath === undefined ? {} : { localPath: selected.localPath }),
        ...(selected.preparedPath === undefined ? {} : { preparedPath: selected.preparedPath }),
        ...(selected.source === undefined ? {} : { source: selected.source }),
        manifest: selected.manifest,
        dependencies: new Map(),
      };
      packages.set(id, node);
      for (const [peerName, peerId] of peerIds) node.dependencies.set(peerName, peerId);
      const childEnvironment = new Map(environment);
      for (const [peerName, peerId] of peerIds) childEnvironment.set(peerName, peerId);
      childEnvironment.set(selected.actualName, id);
      const dependencies = { ...(selected.manifest.dependencies ?? {}), ...(selected.manifest.optionalDependencies ?? {}) };
      for (const [dependencyName, dependencySpecifier] of sortedEntries(dependencies)) {
        if (peerIds.has(dependencyName)) continue;
        const packagesBeforeOptional = new Set(packages.keys());
        try {
          const dependencyId = await resolveOne(dependencyName, dependencySpecifier, selected.localPath ?? fromDirectory, childEnvironment);
          node.dependencies.set(dependencyName, dependencyId);
          childEnvironment.set(dependencyName, dependencyId);
        } catch (error) {
          if (selected.manifest.optionalDependencies?.[dependencyName] !== undefined || selected.manifest.peerDependenciesMeta?.[dependencyName]?.optional) {
            for (const packageId of packages.keys()) if (!packagesBeforeOptional.has(packageId)) packages.delete(packageId);
            continue;
          }
          throw error;
        }
      }
      return id;
    };

    const sortedRequirements = [...requirements].sort((left, right) => left.name.localeCompare(right.name));
    await this.#prefetch(sortedRequirements.map((requirement) => [requirement.name, requirement.specifier] as const), signal);
    const rootEnvironment = new Map<string, string>();
    for (const requirement of sortedRequirements) {
      const id = await resolveOne(requirement.name, requirement.specifier, this.options.baseDirectory ?? process.cwd(), rootEnvironment);
      roots.set(requirement.name, id);
      rootEnvironment.set(requirement.name, id);
    }
    return {
      roots: new Map([...roots].sort(([left], [right]) => left.localeCompare(right))),
      packages: new Map(
        [...packages]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, value]) => [id, { ...value, dependencies: new Map([...value.dependencies].sort(([left], [right]) => left.localeCompare(right))) }]),
      ),
    };
  }
}
