import npa from "npm-package-arg";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { CommandOptions } from "../core/cli-parser.js";
import { downloadToQuarantine } from "../cache/quarantine.js";
import { extractPackageArchive } from "../cache/archive.js";
import { hashLocalPackage, promoteToStore, storePath, verifyStoreEntry } from "../cache/store.js";
import { createBnpmPaths, type BnpmPaths } from "../config/paths.js";
import { activateWorkspaceImporterViews, buildIsolatedLayout } from "../linker/project-linker.js";
import { activateWithRecovery, recoverProjectLayout } from "../project/recovery.js";
import { createLockfile, readLockfileGraph, writeLockfileAtomic, LockfileError } from "../lockfile/index.js";
import { parseManifest, type DependencySection, type PackageManifest } from "../project/manifest.js";
import { discoverProject } from "../project/discovery.js";
import { discoverWorkspacePackages } from "../project/workspaces.js";
import { loadRegistryConfiguration, RegistryConfiguration, RoutedRegistryClient } from "../registry/configuration.js";
import { RegistryResolver } from "../resolver/registry-resolver.js";
import { RemoteSourceProvider, type GitPreparer } from "../resolver/source-provider.js";
import { ResolutionError } from "../resolver/registry-resolver.js";
import type { Requirement, ResolutionGraph, ResolvedPackage } from "../resolver/types.js";
import { evaluateRecentRelease, type RecentReleaseDecision } from "../security/recent-release.js";
import { loadConfigFile, composeConfig } from "../config/configuration.js";
import { analyzePackage, gitBuildStages, lifecycleStages, type AnalyzedPackage } from "../security/analyzer.js";
import { decidePackagePolicy, type PackagePolicyDecision } from "../security/policy.js";
import { linkedPackagePath } from "../linker/project-linker.js";
import { runLifecycle } from "../security/script-runner.js";
import { selectRecencyConfiguration } from "../config/configuration.js";
import type { InteractiveMode } from "../config/interactive.js";
import type { LifecycleFact } from "../security/analyzer.js";
import { ensureCacheOwnership } from "../cache/commands.js";
import { clearInstalledLayoutInvalidation, installedLayoutIsInvalidated } from "../project/invalidation.js";

export interface InstallPrompts {
  readonly mode: InteractiveMode;
  readonly selectRecencyHours?: () => Promise<string | undefined>;
  readonly allowRecent?: (decision: RecentReleaseDecision) => Promise<boolean>;
  readonly allowDangerous?: (analyzed: AnalyzedPackage) => Promise<boolean>;
  readonly approveLifecycle?: (fact: LifecycleFact, analyzed: AnalyzedPackage) => Promise<boolean>;
}

export interface InstallProjectOptions {
  readonly cwd: string;
  readonly specifications?: readonly string[];
  readonly commandOptions?: CommandOptions;
  readonly paths?: BnpmPaths;
  readonly registry?: URL;
  readonly registryConfiguration?: RegistryConfiguration;
  readonly sourceProvider?: RemoteSourceProvider;
  readonly sourceBuildDepth?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly now?: Date;
  readonly recentReleaseHours?: 1 | 6 | 24;
  readonly requirements?: readonly Requirement[];
  readonly forceResolution?: boolean;
  readonly forceRelink?: boolean;
  readonly resolutionOverrides?: Readonly<Record<string, string>>;
  readonly onChildOutput?: (stream: "stdout" | "stderr", text: string, attribution: { readonly package: string; readonly stage: string }) => void;
  readonly onSecurityEvidence?: (message: string, evidence: unknown) => void;
  readonly onProgress?: (progress: InstallProgress) => void;
  readonly prompts?: InstallPrompts;
}

export interface InstallProgress {
  readonly phase: "resolving" | "resolved" | "fetching" | "downloading" | "inspecting" | "linking" | "complete";
  readonly completed?: number;
  readonly total?: number;
  readonly cached?: number;
  readonly downloaded?: number;
  readonly package?: string;
  readonly bytes?: number;
  readonly totalBytes?: number;
}

export interface InstallProjectResult {
  readonly graph: ResolutionGraph;
  readonly lockfile: string;
  readonly recentReleaseDecisions: readonly RecentReleaseDecision[];
  readonly skippedLifecyclePackages: readonly string[];
  readonly analyses: ReadonlyMap<string, AnalyzedPackage>;
  readonly policyDecisions: readonly PackagePolicyDecision[];
}

async function forEachConcurrent<T>(values: readonly T[], concurrency: number, worker: (value: T) => Promise<void>): Promise<void> {
  let index = 0;
  const next = async (): Promise<void> => {
    while (true) {
      const current = index;
      index += 1;
      const value = values[current];
      if (value === undefined) return;
      await worker(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => next()));
}

function requirementKeys(requirements: readonly Requirement[]): readonly string[] {
  return requirements.map(({ name, specifier, importer }) => `${importer ?? "."}:${name}:${specifier}`).sort();
}

async function storedGraphIsUsable(graph: ResolutionGraph, storeRoot: string): Promise<boolean> {
  let valid = true;
  await forEachConcurrent([...graph.packages.values()], 16, async (pkg) => {
    if (!await verifyStoreEntry(storePath(storeRoot, pkg.integrity), pkg.integrity, { full: false })) valid = false;
  });
  return valid;
}

async function installedGraphMatches(projectRoot: string, graph: ResolutionGraph): Promise<boolean> {
  const importers = graph.importers ?? new Map([[".", graph.roots]]);
  try {
    if (await installedLayoutIsInvalidated(projectRoot)) return false;
    for (const [importer, roots] of importers) {
      const nodeModules = importer === "." ? join(projectRoot, "node_modules") : join(projectRoot, ...importer.split("/"), "node_modules");
      for (const [alias, id] of roots) {
        const pkg = graph.packages.get(id);
        if (!pkg) return false;
        const manifest = JSON.parse(await readFile(join(nodeModules, ...alias.split("/"), "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name !== pkg.name || manifest.version !== pkg.version) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function kindForSection(section: DependencySection): Requirement["kind"] {
  return section === "devDependencies" ? "dev" : section === "optionalDependencies" ? "optional" : section === "peerDependencies" ? "peer" : "dependency";
}

export function requirementsForManifest(manifest: PackageManifest, omitDev: boolean): readonly Requirement[] {
  const requirements = new Map<string, Requirement>();
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
    if (omitDev && section === "devDependencies") continue;
    for (const [name, specifier] of Object.entries(manifest.dependencies[section] ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      requirements.set(name, { name, specifier, kind: kindForSection(section) });
    }
  }
  return [...requirements.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function manifestRequirements(cwd: string, omitDev: boolean): Promise<readonly Requirement[]> {
  const path = join(cwd, "package.json");
  return requirementsForManifest(parseManifest(await readFile(path, "utf8"), path), omitDev);
}

function omittedDependencyTypes(options: CommandOptions | undefined): ReadonlySet<"dev" | "optional" | "peer"> {
  const omitted = new Set(options?.omit ?? []); if (options?.omitDev) omitted.add("dev"); return omitted;
}

function installationGraph(graph: ResolutionGraph, requirements: readonly Requirement[], omitted: ReadonlySet<"dev" | "optional" | "peer">): ResolutionGraph {
  if (omitted.size === 0) return graph;
  const requirementKinds = new Map(requirements.map((requirement) => [`${requirement.importer ?? "."}\0${requirement.name}`, requirement.kind]));
  const excludedRoot = (importer: string, name: string): boolean => {
    const kind = requirementKinds.get(`${importer}\0${name}`);
    return kind === "dev" ? omitted.has("dev") : kind === "optional" ? omitted.has("optional") : kind === "peer" ? omitted.has("peer") : false;
  };
  const importerSource = graph.importers ?? new Map([[".", graph.roots]]);
  const importers = new Map([...importerSource].map(([importer, roots]) => [importer, new Map([...roots].filter(([name]) => !excludedRoot(importer, name)))]));
  const roots = new Map(importers.get(".") ?? []); const reachable = new Set<string>(); const pending = [...importers.values()].flatMap((values) => [...values.values()]);
  const includedEdges = (pkg: ResolvedPackage): ReadonlyMap<string, string> => new Map([...pkg.dependencies].filter(([alias]) => {
    if (omitted.has("optional") && pkg.manifest.optionalDependencies?.[alias] !== undefined) return false;
    if (omitted.has("peer") && pkg.manifest.peerDependencies?.[alias] !== undefined && pkg.manifest.dependencies?.[alias] === undefined && pkg.manifest.optionalDependencies?.[alias] === undefined) return false;
    return true;
  }));
  while (pending.length > 0) {
    const id = pending.pop(); if (!id || reachable.has(id)) continue; reachable.add(id); const pkg = graph.packages.get(id); if (pkg) pending.push(...includedEdges(pkg).values());
  }
  const packages = new Map([...graph.packages].filter(([id]) => reachable.has(id)).map(([id, pkg]) => [id, { ...pkg, dependencies: includedEdges(pkg) }]));
  return { roots, packages, importers };
}

async function specificationRequirements(specifications: readonly string[], sourceProvider: RemoteSourceProvider, cwd: string, signal?: AbortSignal): Promise<readonly Requirement[]> {
  const requirements: Requirement[] = [];
  for (const specification of specifications) {
    const parsed = npa(specification);
    let name: string | undefined = parsed.name ?? undefined;
    if (!name && (parsed.type === "remote" || parsed.type === "git" || parsed.type === "file")) {
      const sourced = await sourceProvider.resolve("bnpm-source", parsed.rawSpec, cwd, signal);
      name = sourced?.actualName;
    }
    if (!name && parsed.type === "directory") {
      const resolved = npa.resolve("bnpm-source", parsed.rawSpec, cwd);
      const directory = typeof resolved.fetchSpec === "string" ? resolved.fetchSpec : "";
      const manifestPath = join(directory, "package.json");
      name = parseManifest(await readFile(manifestPath, "utf8"), manifestPath).name;
    }
    if (!name) throw new Error(`Package specification does not have an inferable package name: ${specification}`);
    requirements.push({ name, specifier: parsed.rawSpec || "latest", kind: "dependency" });
  }
  return requirements;
}

function policyError(message: string): Error {
  const error = new Error(message);
  error.name = "PolicyError";
  return error;
}

function sourceProjectPaths(base: BnpmPaths, cwd: string): BnpmPaths {
  const disabledPolicy = join(base.quarantine, ".source-project-policy-disabled");
  return {
    ...base,
    projectConfig: disabledPolicy,
    projectNpmrc: disabledPolicy,
    lockfile: join(cwd, "bnpm-lock.yaml"),
    virtualStore: join(cwd, "node_modules", ".bnpm"),
  };
}

export async function createGitPreparer(options: {
  readonly paths: BnpmPaths;
  readonly registryConfiguration: RegistryConfiguration;
  readonly fetch: typeof globalThis.fetch;
  readonly commandOptions?: CommandOptions;
  readonly prompts?: InstallPrompts;
  readonly sourceBuildDepth?: number;
  readonly onChildOutput?: InstallProjectOptions["onChildOutput"];
  readonly onSecurityEvidence?: InstallProjectOptions["onSecurityEvidence"];
}): Promise<GitPreparer> {
  const globalConfig = await loadConfigFile(options.paths.globalConfig);
  const projectConfig = await loadConfigFile(options.paths.projectConfig);
  const effectiveConfig = composeConfig({
    ...(globalConfig === undefined ? {} : { global: globalConfig }),
    ...(projectConfig === undefined ? {} : { project: projectConfig }),
    overrides: { allowRecent: options.commandOptions?.allowRecent ?? [] },
  });
  return async (packageRoot, rawManifest, signal) => {
    const depth = options.sourceBuildDepth ?? 0;
    if (depth >= 4) throw new ResolutionError("git prepare dependency nesting exceeds four levels");
    const name = rawManifest.name;
    const version = rawManifest.version;
    if (typeof name !== "string" || typeof version !== "string") throw new ResolutionError("git build package requires a name and version");
    const scriptsValue = rawManifest.scripts;
    if (scriptsValue !== undefined && (typeof scriptsValue !== "object" || scriptsValue === null || Array.isArray(scriptsValue))) throw new ResolutionError("git package scripts must be an object");
    const scripts = (scriptsValue ?? {}) as Readonly<Record<string, unknown>>;
    const stages = gitBuildStages.filter((stage) => typeof scripts[stage] === "string");
    const bundles = rawManifest.bundleDependencies ?? rawManifest.bundledDependencies;
    const needsInstall = stages.length > 0 || rawManifest.workspaces !== undefined || bundles === true || (Array.isArray(bundles) && bundles.length > 0);
    if (needsInstall) {
      const nested = await installProject({
        cwd: packageRoot,
        paths: sourceProjectPaths(options.paths, packageRoot),
        registryConfiguration: options.registryConfiguration,
        fetch: options.fetch,
        commandOptions: {
          json: options.commandOptions?.json ?? false,
          allowRecent: options.commandOptions?.allowRecent ?? [],
          allowDangerous: options.commandOptions?.allowDangerous ?? [],
          frozenLockfile: false,
          offline: false,
          omitDev: false,
          saveExact: false,
          noSave: true,
        },
        sourceBuildDepth: depth + 1,
        ...(signal === undefined ? {} : { signal }),
        ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
        ...(options.onChildOutput === undefined ? {} : { onChildOutput: options.onChildOutput }),
        ...(options.onSecurityEvidence === undefined ? {} : { onSecurityEvidence: options.onSecurityEvidence }),
      });
      if (nested.skippedLifecyclePackages.length > 0) throw policyError(`Git build dependencies have unapproved lifecycle scripts: ${nested.skippedLifecyclePackages.join(", ")}`);
    }
    if (stages.length === 0) return;
    const integrity = await hashLocalPackage(packageRoot);
    const declaredScripts = Object.fromEntries(stages.map((stage) => [stage, scripts[stage] as string]));
    const analyzed = await analyzePackage({ root: packageRoot, packageName: name, packageVersion: version, integrity, scripts: declaredScripts, stages });
    options.onSecurityEvidence?.(`Security inspection for Git build ${name}@${version}`, { findings: analyzed.analysis.findings, lifecycles: analyzed.lifecycles });
    const allowedDangerous = new Set(options.commandOptions?.allowDangerous ?? []);
    const identity = `${name}@${version}`;
    if (analyzed.analysis.findings.some((finding) => finding.severity === "dangerous") && !allowedDangerous.has(identity) && options.prompts?.allowDangerous && await options.prompts.allowDangerous(analyzed)) {
      allowedDangerous.add(identity);
    }
    const trusted = effectiveConfig.trustedPackages.value[name];
    const decision = decidePackagePolicy({ analyzed, allowedDangerous, ...(trusted === undefined ? {} : { trustedApproval: trusted }) });
    if (decision.blocked) throw policyError(`Dangerous Git build behavior blocked: ${identity}`);
    const approved = [...decision.approvedLifecycles];
    for (const fact of decision.skippedLifecycles) {
      if (options.prompts?.approveLifecycle && await options.prompts.approveLifecycle(fact, analyzed)) approved.push(fact);
      else throw policyError(`Git build lifecycle requires approval: ${identity} ${fact.stage}`);
    }
    for (const fact of approved.sort((left, right) => gitBuildStages.indexOf(left.stage as (typeof gitBuildStages)[number]) - gitBuildStages.indexOf(right.stage as (typeof gitBuildStages)[number]))) {
      await runLifecycle({
        fact,
        cwd: packageRoot,
        ...(signal === undefined ? {} : { signal }),
        onOutput: (stream, text) => options.onChildOutput?.(stream, text, { package: identity, stage: fact.stage }),
      });
    }
  };
}

export async function installProject(options: InstallProjectOptions): Promise<InstallProjectResult> {
  const discovered = await discoverProject(options.cwd);
  const projectRoot = discovered?.projectRoot ?? options.cwd;
  const importerRoot = discovered?.importerRoot ?? options.cwd;
  await recoverProjectLayout(projectRoot);
  const paths = options.paths ?? createBnpmPaths({ cwd: projectRoot });
  await ensureCacheOwnership(paths);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const registryConfiguration = options.registryConfiguration ?? await loadRegistryConfiguration({
    userNpmrc: paths.userNpmrc,
    projectNpmrc: paths.projectNpmrc,
    ...(options.registry === undefined ? {} : { defaultRegistry: options.registry }),
  });
  const registry = registryConfiguration.defaultRegistry;
  const registryProvider = new RoutedRegistryClient(registryConfiguration, fetchImpl);
  const prepareGit = await createGitPreparer({
    paths,
    registryConfiguration,
    fetch: fetchImpl,
    ...(options.commandOptions === undefined ? {} : { commandOptions: options.commandOptions }),
    ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
    ...(options.sourceBuildDepth === undefined ? {} : { sourceBuildDepth: options.sourceBuildDepth }),
    ...(options.onChildOutput === undefined ? {} : { onChildOutput: options.onChildOutput }),
    ...(options.onSecurityEvidence === undefined ? {} : { onSecurityEvidence: options.onSecurityEvidence }),
  });
  const sourceProvider = options.sourceProvider ?? new RemoteSourceProvider({ quarantineRoot: paths.quarantine, registryConfiguration, fetch: fetchImpl, prepareGit });
  try {
  const globalConfig = await loadConfigFile(paths.globalConfig);
  const projectConfig = await loadConfigFile(paths.projectConfig);
  const effectiveConfig = composeConfig({
    ...(globalConfig === undefined ? {} : { global: globalConfig }),
    ...(projectConfig === undefined ? {} : { project: projectConfig }),
    overrides: { allowRecent: options.commandOptions?.allowRecent ?? [] },
  });
  const firstUse = await selectRecencyConfiguration({
    commandIsSecuritySensitive: true,
    existingConfiguration: globalConfig !== undefined || projectConfig !== undefined,
    mode: options.prompts?.mode ?? { interactive: false, reason: "prompt-unavailable" },
    configPath: paths.globalConfig,
    ...(options.prompts?.selectRecencyHours === undefined ? {} : { prompt: options.prompts.selectRecencyHours }),
  });
  const configuredRecentReleaseHours = options.recentReleaseHours ?? (globalConfig === undefined && projectConfig === undefined ? firstUse.hours : effectiveConfig.recentReleaseHours.value);
  const configuredAllowedRecent = new Set(effectiveConfig.allowRecent.value);
  const resolverRecency = { minimumReleaseAgeMilliseconds: configuredRecentReleaseHours * 60 * 60 * 1000, ...(options.now === undefined ? {} : { now: options.now }), allowedRecentVersions: configuredAllowedRecent };
  const activeRequirements = options.requirements ?? (options.specifications && options.specifications.length > 0
    ? await specificationRequirements(options.specifications, sourceProvider, importerRoot, options.signal)
    : await manifestRequirements(importerRoot, false));
  options.onProgress?.({ phase: "resolving", total: activeRequirements.length });
  let lockExists = false;
  try { await stat(paths.lockfile); lockExists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!lockExists && (options.commandOptions?.offline || options.commandOptions?.frozenLockfile)) throw new LockfileError("offline or frozen install requires bnpm-lock.yaml");
  let existingLock: Awaited<ReturnType<typeof readLockfileGraph>> | undefined;
  if (lockExists) {
    try { existingLock = await readLockfileGraph(paths.lockfile, paths.store); }
    catch (error) {
      if (options.commandOptions?.offline || options.commandOptions?.frozenLockfile) throw error;
      existingLock = undefined;
    }
  }
  let locked = options.commandOptions?.offline ? existingLock : undefined;
  let workspaces: ReadonlyMap<string, string> | undefined;
  let overrides: Readonly<Record<string, string>> | undefined;
  try {
    const importerManifestPath = join(importerRoot, "package.json");
    overrides = parseManifest(await readFile(importerManifestPath, "utf8"), importerManifestPath).overrides;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (discovered?.kind === "workspace") {
    const rootManifestPath = join(projectRoot, "package.json");
    const rootManifest = parseManifest(await readFile(rootManifestPath, "utf8"), rootManifestPath);
    workspaces = await discoverWorkspacePackages(projectRoot, rootManifest.workspaces);
  } else if (discovered && discovered.projectRoot === discovered.importerRoot) {
    const rootManifestPath = join(projectRoot, "package.json");
    const rootManifest = parseManifest(await readFile(rootManifestPath, "utf8"), rootManifestPath);
    if (rootManifest.workspaces.length > 0) workspaces = await discoverWorkspacePackages(projectRoot, rootManifest.workspaces);
  }
  let requirements: readonly Requirement[] = activeRequirements;
  let importerPaths: ReadonlyMap<string, string> | undefined;
  if (workspaces && discovered) {
    const activeImporter = relative(projectRoot, importerRoot).split(sep).join("/") || ".";
    const pathsByImporter = new Map<string, string>([[".", projectRoot]]);
    for (const path of workspaces.values()) pathsByImporter.set(relative(projectRoot, path).split(sep).join("/"), path);
    importerPaths = pathsByImporter;
    const allRequirements: Requirement[] = [];
    for (const [importer, path] of [...pathsByImporter].sort(([left], [right]) => left.localeCompare(right))) {
      const importerRequirements = importer === activeImporter
        ? activeRequirements
        : await manifestRequirements(path, false);
      allRequirements.push(...importerRequirements.map((requirement) => ({ ...requirement, ...(importer === "." ? {} : { importer }) })));
    }
    requirements = allRequirements;
  }
  const lockMatches = existingLock !== undefined && JSON.stringify(requirementKeys(requirements)) === JSON.stringify(requirementKeys(existingLock.requirements));
  if (options.commandOptions?.offline && !lockMatches) throw new LockfileError("manifest requirements do not match the offline lockfile");
  const omitted = omittedDependencyTypes(options.commandOptions);
  if (!options.forceResolution && lockMatches && existingLock && await storedGraphIsUsable(installationGraph(existingLock.graph, existingLock.requirements, omitted), paths.store)) locked = existingLock;
  else if (options.commandOptions?.offline) throw new LockfileError("offline install requires complete, valid store entries");
  let resolvedGraph: ResolutionGraph | undefined;
  if (!locked && importerPaths && workspaces) {
    const importers = new Map<string, ReadonlyMap<string, string>>();
    const packages = new Map<string, import("../resolver/types.js").ResolvedPackage>();
    const provider = registryProvider;
    for (const [importer, path] of [...importerPaths].sort(([left], [right]) => left.localeCompare(right))) {
      const importerRequirements = requirements.filter((requirement) => (requirement.importer ?? ".") === importer).map(({ importer: _importer, ...requirement }) => requirement);
      const importerManifestPath = join(path, "package.json");
      const importerOverrides = parseManifest(await readFile(importerManifestPath, "utf8"), importerManifestPath).overrides;
      const part = await new RegistryResolver(provider, { baseDirectory: path, workspaces, overrides: { ...importerOverrides, ...options.resolutionOverrides }, sourceProvider, ...resolverRecency }).resolve(importerRequirements, options.signal);
      importers.set(importer, part.roots);
      for (const [id, pkg] of part.packages) {
        const existing = packages.get(id);
        if (existing && JSON.stringify([...existing.dependencies]) !== JSON.stringify([...pkg.dependencies])) throw new Error(`Conflicting workspace resolution for ${id}`);
        packages.set(id, pkg);
      }
    }
    resolvedGraph = { roots: new Map(importers.get(".") ?? []), packages: new Map([...packages].sort(([left], [right]) => left.localeCompare(right))), importers };
  }
  const graph = locked?.graph ?? resolvedGraph ?? await new RegistryResolver(
    registryProvider,
    { baseDirectory: importerRoot, ...(workspaces === undefined ? {} : { workspaces }), overrides: { ...overrides, ...options.resolutionOverrides }, sourceProvider, ...resolverRecency },
  ).resolve(requirements, options.signal);
  const installGraph = installationGraph(graph, requirements, omitted);
  options.onProgress?.({ phase: "resolved", total: installGraph.packages.size });
  const recentReleaseHours = options.recentReleaseHours ?? locked?.recentReleaseHours ?? configuredRecentReleaseHours;
  const allowedRecent = new Set(effectiveConfig.allowRecent.value);
  const recentReleaseDecisions = [...graph.packages.values()].filter((pkg) => pkg.source === "registry" || (pkg.source === undefined && pkg.localPath === undefined)).map((pkg) => evaluateRecentRelease(
    { name: pkg.name, version: pkg.version, ...(pkg.publishedAt === undefined ? {} : { publishedAt: pkg.publishedAt.toISOString() }) },
    { thresholdHours: recentReleaseHours, ...(options.now === undefined ? {} : { now: options.now }), allowedExactVersions: allowedRecent },
  ));
  for (const decision of recentReleaseDecisions) {
    if (decision.status !== "allowed" && options.prompts?.allowRecent && await options.prompts.allowRecent(decision)) allowedRecent.add(decision.identity);
  }
  const finalRecentDecisions = [...graph.packages.values()].filter((pkg) => pkg.source === "registry" || (pkg.source === undefined && pkg.localPath === undefined)).map((pkg) => evaluateRecentRelease(
    { name: pkg.name, version: pkg.version, ...(pkg.publishedAt === undefined ? {} : { publishedAt: pkg.publishedAt.toISOString() }) },
    { thresholdHours: recentReleaseHours, ...(options.now === undefined ? {} : { now: options.now }), allowedExactVersions: allowedRecent },
  ));
  const blocked = finalRecentDecisions.filter((decision) => decision.status !== "allowed");
  if (blocked.length > 0) {
    const error = new Error(`Recent-release policy blocked ${blocked.map((decision) => decision.identity).join(", ")}`);
    error.name = "PolicyError";
    throw error;
  }

  if (options.commandOptions?.packageLockOnly || options.commandOptions?.dryRun) {
    const lockfile = createLockfile(graph, requirements, { registry: registry.href, recentReleaseHours });
    if (options.commandOptions.packageLockOnly && !options.commandOptions.dryRun && !options.commandOptions.offline && !options.commandOptions.frozenLockfile) await writeLockfileAtomic(paths.lockfile, lockfile);
    return { graph, lockfile, recentReleaseDecisions: finalRecentDecisions, skippedLifecyclePackages: [], analyses: new Map(), policyDecisions: [] };
  }

  if (!options.forceRelink && locked && lockMatches && locked.dangerousPackageIds.size === 0 && await installedGraphMatches(projectRoot, installGraph)) {
    const skippedLifecyclePackages = options.commandOptions?.ignoreScripts ? [] : [...installGraph.packages.values()].filter((pkg) => {
      const approval = locked?.approvals[pkg.name];
      return lifecycleStages.some((stage) => pkg.manifest.scripts?.[stage] && approval?.scripts[stage] === undefined);
    }).map((pkg) => pkg.id);
    if (skippedLifecyclePackages.length === 0) {
      return {
        graph,
        lockfile: await readFile(paths.lockfile, "utf8"),
        recentReleaseDecisions: finalRecentDecisions,
        skippedLifecyclePackages,
        analyses: new Map(),
        policyDecisions: [],
      };
    }
  }

  const storeEntries = new Map<string, string>();
  const analyses = new Map<string, AnalyzedPackage>();
  let completedPackages = 0; let cachedPackages = 0; let downloadedPackages = 0; const progressTotal = installGraph.packages.size;
  const packageComplete = (cached: boolean): void => {
    completedPackages += 1; if (cached) cachedPackages += 1; else downloadedPackages += 1;
    options.onProgress?.({ phase: "fetching", completed: completedPackages, total: progressTotal, cached: cachedPackages, downloaded: downloadedPackages });
  };
  options.onProgress?.({ phase: "fetching", completed: 0, total: progressTotal, cached: 0, downloaded: 0 });
  const inspect = async (id: string, pkg: ResolutionGraph["packages"] extends ReadonlyMap<string, infer P> ? P : never, root: string): Promise<void> => {
    const analyzed = await analyzePackage({
      root,
      packageName: pkg.name,
      packageVersion: pkg.version,
      integrity: pkg.integrity,
      ...(pkg.manifest.scripts === undefined ? {} : { scripts: pkg.manifest.scripts }),
    });
    analyses.set(id, analyzed);
    if (analyzed.analysis.findings.length > 0 || analyzed.lifecycles.length > 0) {
      options.onSecurityEvidence?.(`Security inspection for ${id}`, { findings: analyzed.analysis.findings, lifecycles: analyzed.lifecycles });
    }
  };
  try {
  await forEachConcurrent([...installGraph.packages], 16, async ([id, pkg]) => {
    if (locked) {
      const stored = storePath(paths.store, pkg.integrity);
      storeEntries.set(id, stored);
      packageComplete(true);
      return;
    }
    if (pkg.localPath) {
      storeEntries.set(id, await promoteToStore(pkg.localPath, paths.store, pkg.integrity, { localPackage: true }));
      packageComplete(true);
      return;
    }
    if (pkg.preparedPath) {
      storeEntries.set(id, await promoteToStore(pkg.preparedPath, paths.store, pkg.integrity));
      packageComplete(true);
      return;
    }
    const warm = storePath(paths.store, pkg.integrity);
    try {
      if (!await verifyStoreEntry(warm, pkg.integrity)) throw Object.assign(new Error("missing or corrupt warm store entry"), { code: "ENOENT" });
      storeEntries.set(id, warm);
      packageComplete(true);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const quarantined = await downloadToQuarantine(pkg.tarball, pkg.integrity, {
      root: paths.quarantine,
      fetch: fetchImpl,
      headers: (url) => registryConfiguration.headersFor(url),
      onProgress: (downloadedBytes, totalBytes) => options.onProgress?.({ phase: "downloading", package: id, bytes: downloadedBytes, ...(totalBytes === undefined ? {} : { totalBytes }), completed: completedPackages, total: progressTotal, cached: cachedPackages, downloaded: downloadedPackages }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const quarantineDirectory = dirname(quarantined.path);
    try {
      const extracted = await extractPackageArchive(quarantined.path, join(quarantineDirectory, "extracted"));
      storeEntries.set(id, await promoteToStore(extracted.path, paths.store, pkg.integrity));
      packageComplete(false);
    } finally {
      await rm(quarantineDirectory, { recursive: true, force: true });
    }
  });
  let inspectedPackages = 0; options.onProgress?.({ phase: "inspecting", completed: 0, total: progressTotal, cached: cachedPackages, downloaded: downloadedPackages });
  await forEachConcurrent([...installGraph.packages], 8, async ([id, pkg]) => {
    const stored = storeEntries.get(id); if (!stored) throw new Error(`Verified store entry is unavailable for ${id}`);
    await inspect(id, pkg, stored); inspectedPackages += 1;
    options.onProgress?.({ phase: "inspecting", completed: inspectedPackages, total: progressTotal, cached: cachedPackages, downloaded: downloadedPackages });
  });
  } finally {
    await sourceProvider.cleanup();
  }

  const allowedDangerous = new Set(options.commandOptions?.allowDangerous ?? []);
  for (const analyzed of analyses.values()) {
    const identity = `${analyzed.analysis.packageName}@${analyzed.analysis.packageVersion}`;
    if (analyzed.analysis.findings.some((finding) => finding.severity === "dangerous") && !allowedDangerous.has(identity) && options.prompts?.allowDangerous && await options.prompts.allowDangerous(analyzed)) {
      allowedDangerous.add(identity);
    }
  }
  let policyDecisions = [...analyses].sort(([left], [right]) => left.localeCompare(right)).map(([packageId, analyzed]) => {
    const trustedApproval = effectiveConfig.trustedPackages.value[analyzed.analysis.packageName] ?? existingLock?.approvals[analyzed.analysis.packageName];
    return decidePackagePolicy({ analyzed, allowedDangerous, packageId, ...(trustedApproval === undefined ? {} : { trustedApproval }) });
  });
  const policyBlocked = policyDecisions.filter((decision) => decision.blocked);
  if (policyBlocked.length > 0) {
    const error = new Error(`Dangerous package behavior blocked: ${policyBlocked.map((decision) => decision.identity).join(", ")}`);
    error.name = "PolicyError";
    throw error;
  }
  if (options.prompts?.approveLifecycle) {
    const updated: PackagePolicyDecision[] = [];
    for (const decision of policyDecisions) {
      const analyzed = analyses.get(decision.packageId);
      if (!analyzed) { updated.push(decision); continue; }
      const newlyApproved: LifecycleFact[] = [];
      const stillSkipped: LifecycleFact[] = [];
      for (const fact of decision.skippedLifecycles) {
        if (await options.prompts.approveLifecycle(fact, analyzed)) newlyApproved.push(fact); else stillSkipped.push(fact);
      }
      updated.push({ ...decision, approvedLifecycles: [...decision.approvedLifecycles, ...newlyApproved], skippedLifecycles: stillSkipped });
    }
    policyDecisions = updated;
  }
  const lockfile = createLockfile(graph, requirements, { registry: registry.href, recentReleaseHours }, { analyses, decisions: policyDecisions });
  if (options.commandOptions?.frozenLockfile) {
    let current: string;
    try {
      current = await readFile(paths.lockfile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LockfileError("frozen install requires an existing bnpm-lock.yaml");
      throw error;
    }
    if (current !== lockfile) throw new LockfileError("frozen lockfile is not current with the manifest, graph, and security decisions");
  }

  const preparedRoot = await mkdtemp(join(projectRoot, ".bnpm-install-"));
  const preparedNodeModules = join(preparedRoot, "node_modules");
  try {
    options.onProgress?.({ phase: "linking", completed: 0, total: installGraph.packages.size, cached: cachedPackages, downloaded: downloadedPackages });
    await buildIsolatedLayout(preparedNodeModules, installGraph, storeEntries);
    await activateWithRecovery(projectRoot, preparedNodeModules);
    await activateWorkspaceImporterViews(projectRoot, installGraph);
    await clearInstalledLayoutInvalidation(projectRoot);
  } finally {
    await rm(preparedRoot, { recursive: true, force: true });
  }
  if (!options.commandOptions?.offline && !options.commandOptions?.frozenLockfile) await writeLockfileAtomic(paths.lockfile, lockfile);
  const stageIndex = new Map<string, number>(lifecycleStages.map((stage, index) => [stage, index]));
  const approved = policyDecisions.flatMap((decision) => decision.approvedLifecycles.map((fact) => ({ fact, packageId: decision.packageId }))).sort((left, right) =>
    left.packageId.localeCompare(right.packageId) ||
    (stageIndex.get(left.fact.stage) ?? 0) - (stageIndex.get(right.fact.stage) ?? 0),
  );
  for (const { fact, packageId: id } of options.commandOptions?.ignoreScripts ? [] : approved) {
    await runLifecycle({
      fact,
      cwd: linkedPackagePath(join(projectRoot, "node_modules"), id, fact.packageName),
      initialCwd: importerRoot,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onOutput: (stream, text) => options.onChildOutput?.(stream, text, { package: id, stage: fact.stage }),
    });
  }
  const skippedLifecyclePackages = options.commandOptions?.ignoreScripts ? [] : [...new Set(policyDecisions.flatMap((decision) => decision.skippedLifecycles.map((fact) => `${fact.packageName}@${fact.packageVersion}`)))];
  options.onProgress?.({ phase: "complete", completed: installGraph.packages.size, total: installGraph.packages.size, cached: cachedPackages, downloaded: downloadedPackages });
  return { graph: installGraph, lockfile, recentReleaseDecisions: finalRecentDecisions, skippedLifecyclePackages, analyses, policyDecisions };
  } finally {
    await sourceProvider.cleanup();
  }
}
