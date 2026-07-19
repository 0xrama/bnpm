import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import type { Requirement, ResolutionGraph } from "../resolver/types.js";
import type { PackageVersionManifest } from "../registry/types.js";
import { storePath } from "../cache/store.js";
import type { AnalyzedPackage } from "../security/analyzer.js";
import type { PackagePolicyDecision } from "../security/policy.js";
import type { TrustedPackageApproval } from "../config/types.js";

export class LockfileError extends Error {
  constructor(message: string) {
    super(`Lockfile error: ${message}`);
    this.name = "LockfileError";
  }
}

export interface LockfileOptions {
  readonly registry: string;
  readonly recentReleaseHours: 1 | 6 | 24;
}

function objectFromMap<T>(map: ReadonlyMap<string, T>, convert: (value: T, key: string) => unknown): Record<string, unknown> {
  return Object.fromEntries([...map].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, convert(value, key)]));
}

export function createLockfile(
  graph: ResolutionGraph,
  requirements: readonly Requirement[],
  options: LockfileOptions,
  security?: { readonly analyses: ReadonlyMap<string, AnalyzedPackage>; readonly decisions: readonly PackagePolicyDecision[] },
): string {
  const requirementByName = new Map(requirements.map((requirement) => [requirement.name, requirement]));
  const requirementByImporter = new Map<string, Map<string, Requirement>>();
  for (const requirement of requirements) {
    const importer = requirement.importer ?? ".";
    let values = requirementByImporter.get(importer);
    if (!values) { values = new Map(); requirementByImporter.set(importer, values); }
    values.set(requirement.name, requirement);
  }
  const importerRoots = graph.importers ?? new Map([[".", graph.roots]]);
  const decisions = new Map((security?.decisions ?? []).map((decision) => [decision.packageId, decision]));
  const document = {
    lockfileVersion: 1,
    settings: { registry: options.registry, recentReleaseHours: options.recentReleaseHours },
    importers: objectFromMap(importerRoots, (roots, importer) => ({
      dependencies: objectFromMap(roots, (version, name) => ({
        specifier: requirementByImporter.get(importer)?.get(name)?.specifier ?? requirementByName.get(name)?.specifier ?? version,
        version,
        type: requirementByImporter.get(importer)?.get(name)?.kind ?? requirementByName.get(name)?.kind ?? "dependency",
      })),
    })),
    packages: objectFromMap(graph.packages, (pkg, id) => ({
      resolution: pkg.localPath === undefined
        ? { integrity: pkg.integrity, tarball: pkg.tarball.href, ...(pkg.source === undefined || pkg.source === "registry" ? {} : { source: pkg.source }) }
        : { integrity: pkg.integrity, directory: pkg.localPath, source: "directory" },
      ...(pkg.publishedAt === undefined ? {} : { publishedAt: pkg.publishedAt.toISOString() }),
      ...(pkg.dependencies.size === 0 ? {} : { dependencies: Object.fromEntries(pkg.dependencies) }),
      ...(security?.analyses.get(id)?.lifecycles.length ? {
        scripts: Object.fromEntries(security.analyses.get(id)?.lifecycles.map((fact) => [fact.stage, { command: fact.command, commandHash: fact.commandHash, contentHash: fact.contentHash }]) ?? []),
      } : {}),
      ...(security?.analyses.get(id)?.analysis.findings.length ? {
        security: { ruleSetVersion: security.analyses.get(id)?.analysis.ruleSetVersion, findings: security.analyses.get(id)?.analysis.findings },
      } : {}),
    })),
    ...(security && [...decisions.values()].some((decision) => decision.approvedLifecycles.length > 0) ? {
      approvals: Object.fromEntries([...decisions].filter(([, decision]) => decision.approvedLifecycles.length > 0).map(([id, decision]) => {
        const pkg = graph.packages.get(id);
        return [id, {
          integrity: pkg?.integrity,
          scripts: Object.fromEntries(decision.approvedLifecycles.map((fact) => [fact.stage, { commandHash: fact.commandHash, contentHash: fact.contentHash, approved: true }])),
        }];
      })),
    } : {}),
  };
  return YAML.stringify(document, { lineWidth: 0, sortMapEntries: true });
}

export async function writeLockfileAtomic(path: string, bytes: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function mapping(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new LockfileError(`${field} must be a mapping`);
  return value as Record<string, unknown>;
}

function identity(id: string): { readonly name: string; readonly version: string } {
  const context = id.indexOf("(");
  const base = context < 0 ? id : id.slice(0, context);
  const separator = base.lastIndexOf("@");
  if (separator <= 0 || separator === base.length - 1) throw new LockfileError(`invalid package identity ${id}`);
  return { name: base.slice(0, separator), version: base.slice(separator + 1) };
}

export async function readLockfileGraph(path: string, storeRoot: string): Promise<{ readonly graph: ResolutionGraph; readonly requirements: readonly Requirement[]; readonly recentReleaseHours: 1 | 6 | 24; readonly approvals: Readonly<Record<string, TrustedPackageApproval>>; readonly dangerousPackageIds: ReadonlySet<string>; readonly lifecycleScripts: ReadonlyMap<string, Readonly<Record<string, { readonly commandHash: string; readonly contentHash: string }>>> }> {
  let value: unknown;
  try {
    const document = YAML.parseDocument(await readFile(path, "utf8"), { uniqueKeys: true, strict: true });
    if (document.errors.length > 0) throw new LockfileError(document.errors[0]?.message ?? "invalid YAML");
    value = document.toJS();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LockfileError("offline or frozen install requires bnpm-lock.yaml");
    throw error;
  }
  const root = mapping(value, "root");
  if (root.lockfileVersion !== 1) throw new LockfileError("unsupported lockfileVersion");
  const settings = mapping(root.settings, "settings");
  if (![1, 6, 24].includes(settings.recentReleaseHours as number)) throw new LockfileError("invalid recentReleaseHours");
  const importerMappings = mapping(root.importers, "importers");
  const importers = new Map<string, ReadonlyMap<string, string>>();
  const requirements: Requirement[] = [];
  for (const [importerName, rawImporter] of Object.entries(importerMappings).sort(([left], [right]) => left.localeCompare(right))) {
    const importer = mapping(rawImporter, `importer ${importerName}`);
    const roots = new Map<string, string>();
    for (const [name, raw] of Object.entries(mapping(importer.dependencies ?? {}, `importer ${importerName} dependencies`)).sort(([left], [right]) => left.localeCompare(right))) {
      const entry = mapping(raw, `importer dependency ${importerName}:${name}`);
      if (typeof entry.specifier !== "string" || typeof entry.version !== "string") throw new LockfileError(`invalid importer dependency ${importerName}:${name}`);
      const kind = entry.type ?? "dependency";
      if (!["dependency", "dev", "optional", "peer", "workspace"].includes(kind as string)) throw new LockfileError(`invalid importer dependency type ${importerName}:${name}`);
      roots.set(name, entry.version);
      requirements.push({ name, specifier: entry.specifier, kind: kind as Requirement["kind"], ...(importerName === "." ? {} : { importer: importerName }) });
    }
    importers.set(importerName, roots);
  }
  const roots = new Map(importers.get(".") ?? []);
  const packages = new Map<string, import("../resolver/types.js").ResolvedPackage>();
  const lockedScripts = new Map<string, Readonly<Record<string, { readonly commandHash: string; readonly contentHash: string }>>>();
  const dangerousPackageIds = new Set<string>();
  for (const [id, raw] of Object.entries(mapping(root.packages, "packages")).sort(([left], [right]) => left.localeCompare(right))) {
    const entry = mapping(raw, `package ${id}`);
    const resolution = mapping(entry.resolution, `package ${id} resolution`);
    if (typeof resolution.integrity !== "string" || (typeof resolution.tarball !== "string" && typeof resolution.directory !== "string")) throw new LockfileError(`invalid resolution for ${id}`);
    if (resolution.source !== undefined && !["registry", "directory", "tarball", "git"].includes(resolution.source as string)) throw new LockfileError(`invalid package source for ${id}`);
    const parsedIdentity = identity(id);
    const packageRoot = storePath(storeRoot, resolution.integrity);
    let manifest: PackageVersionManifest;
    try {
      manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as PackageVersionManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LockfileError(`store entry is missing for ${id}`);
      throw error;
    }
    if (manifest.name !== parsedIdentity.name || manifest.version !== parsedIdentity.version) throw new LockfileError(`store identity mismatch for ${id}`);
    const dependencyValues = mapping(entry.dependencies ?? {}, `package ${id} dependencies`);
    const dependencies = new Map<string, string>();
    for (const [name, dependencyId] of Object.entries(dependencyValues)) {
      if (typeof dependencyId !== "string") throw new LockfileError(`invalid dependency ${id} -> ${name}`);
      dependencies.set(name, dependencyId);
    }
    const publishedAt = typeof entry.publishedAt === "string" ? new Date(entry.publishedAt) : undefined;
    if (publishedAt && Number.isNaN(publishedAt.getTime())) throw new LockfileError(`invalid publication time for ${id}`);
    packages.set(id, {
      id,
      name: parsedIdentity.name,
      version: parsedIdentity.version,
      integrity: resolution.integrity,
      tarball: typeof resolution.tarball === "string" ? new URL(resolution.tarball) : pathToFileURL(resolution.directory as string),
      ...(typeof resolution.directory === "string" ? { localPath: resolution.directory } : {}),
      ...(typeof resolution.source === "string" ? { source: resolution.source as "registry" | "directory" | "tarball" | "git" } : {}),
      ...(publishedAt === undefined ? {} : { publishedAt }),
      manifest,
      dependencies,
    });
    const scriptFacts: Record<string, { commandHash: string; contentHash: string }> = {};
    for (const [stage, rawScript] of Object.entries(mapping(entry.scripts ?? {}, `package ${id} scripts`))) {
      const script = mapping(rawScript, `package ${id} script ${stage}`);
      if (typeof script.commandHash !== "string" || typeof script.contentHash !== "string") throw new LockfileError(`invalid script facts for ${id} ${stage}`);
      scriptFacts[stage] = { commandHash: script.commandHash, contentHash: script.contentHash };
    }
    lockedScripts.set(id, scriptFacts);
    if (entry.security !== undefined) {
      const security = mapping(entry.security, `package ${id} security`);
      if (!Array.isArray(security.findings)) throw new LockfileError(`invalid security findings for ${id}`);
      for (const rawFinding of security.findings) {
        const finding = mapping(rawFinding, `package ${id} finding`);
        if (finding.severity === "dangerous") dangerousPackageIds.add(id);
      }
    }
  }
  for (const importerRoots of importers.values()) for (const id of importerRoots.values()) if (!packages.has(id)) throw new LockfileError(`importer points to missing package ${id}`);
  for (const pkg of packages.values()) for (const id of pkg.dependencies.values()) if (!packages.has(id)) throw new LockfileError(`${pkg.id} points to missing package ${id}`);
  const approvals: Record<string, TrustedPackageApproval> = {};
  for (const [id, raw] of Object.entries(mapping(root.approvals ?? {}, "approvals"))) {
    const pkg = packages.get(id);
    if (!pkg) throw new LockfileError(`approval points to missing package ${id}`);
    const entry = mapping(raw, `approval ${id}`);
    if (entry.integrity !== pkg.integrity) throw new LockfileError(`approval integrity mismatch for ${id}`);
    const scripts: Record<string, { commandHash: string; contentHash: string }> = {};
    for (const [stage, rawScript] of Object.entries(mapping(entry.scripts, `approval ${id} scripts`))) {
      const script = mapping(rawScript, `approval ${id} ${stage}`);
      if (script.approved !== true || typeof script.commandHash !== "string" || typeof script.contentHash !== "string") throw new LockfileError(`invalid script approval for ${id} ${stage}`);
      const fact = lockedScripts.get(id)?.[stage];
      if (!fact || fact.commandHash !== script.commandHash || fact.contentHash !== script.contentHash) throw new LockfileError(`script approval no longer matches facts for ${id} ${stage}`);
      scripts[stage] = { commandHash: script.commandHash, contentHash: script.contentHash };
    }
    approvals[pkg.name] = { version: pkg.version, integrity: pkg.integrity, scripts };
  }
  return { graph: { roots, packages, importers }, requirements, recentReleaseHours: settings.recentReleaseHours as 1 | 6 | 24, approvals, dangerousPackageIds, lifecycleScripts: lockedScripts };
}
