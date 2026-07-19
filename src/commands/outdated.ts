import npa from "npm-package-arg";
import semver from "semver";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverProject } from "../project/discovery.js";
import { parseManifest } from "../project/manifest.js";
import { requirementsForManifest } from "../installer/install.js";
import type { PackageDocument } from "../registry/types.js";
import { DependencyError } from "../project/dependency-error.js";
import { createBnpmPaths } from "../config/paths.js";
import { loadRegistryConfiguration, RegistryConfiguration, RoutedRegistryClient } from "../registry/configuration.js";

export interface OutdatedDependency {
  readonly name: string;
  readonly current?: string;
  readonly wanted: string;
  readonly latest: string;
  readonly declared: string;
  readonly type: "dependency" | "dev" | "optional" | "peer" | "workspace";
}

function selectedVersion(document: PackageDocument, specifier: string): string | undefined {
  if (semver.valid(specifier)) return document.versions[specifier] ? specifier : undefined;
  const tagged = document["dist-tags"][specifier];
  if (tagged) return tagged;
  const range = semver.validRange(specifier);
  return range ? semver.maxSatisfying(Object.keys(document.versions), range) ?? undefined : undefined;
}

export async function findOutdatedDependencies(options: {
  readonly cwd: string;
  readonly names?: readonly string[];
  readonly registry?: URL;
  readonly registryConfiguration?: RegistryConfiguration;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}): Promise<readonly OutdatedDependency[]> {
  const discovered = await discoverProject(options.cwd);
  const projectRoot = discovered?.projectRoot ?? options.cwd;
  const importerRoot = discovered?.importerRoot ?? options.cwd;
  const manifestPath = join(importerRoot, "package.json");
  const requirements = requirementsForManifest(parseManifest(await readFile(manifestPath, "utf8"), manifestPath), false);
  const selectedNames = new Set(options.names ?? []);
  const declaredNames = new Set(requirements.map((requirement) => requirement.name));
  for (const name of selectedNames) if (!declaredNames.has(name)) throw new DependencyError(`Dependency is not declared: ${name}`);
  const paths = createBnpmPaths({ cwd: projectRoot });
  const configuration = options.registryConfiguration ?? await loadRegistryConfiguration({
    userNpmrc: paths.userNpmrc,
    projectNpmrc: paths.projectNpmrc,
    ...(options.registry === undefined ? {} : { defaultRegistry: options.registry }),
  });
  const client = new RoutedRegistryClient(configuration, options.fetch ?? globalThis.fetch);
  const entries: OutdatedDependency[] = [];
  for (const requirement of requirements) {
    if (selectedNames.size > 0 && !selectedNames.has(requirement.name)) continue;
    if (requirement.specifier.startsWith("file:") || requirement.specifier.startsWith("workspace:")) continue;
    const parsed = npa.resolve(requirement.name, requirement.specifier);
    const request = parsed.type === "alias" ? (parsed as npa.AliasResult).subSpec : parsed;
    if (!request.name || !["version", "range", "tag"].includes(request.type)) continue;
    const document = await client.packageDocument(request.name, options.signal);
    const wanted = selectedVersion(document, request.rawSpec);
    const latest = document["dist-tags"].latest;
    if (!wanted || !latest) continue;
    let current: string | undefined;
    try {
      const installed = JSON.parse(await readFile(join(importerRoot, "node_modules", ...requirement.name.split("/"), "package.json"), "utf8")) as { version?: unknown };
      if (typeof installed.version === "string") current = installed.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === wanted && current === latest) continue;
    entries.push({ name: requirement.name, ...(current === undefined ? {} : { current }), wanted, latest, declared: requirement.specifier, type: requirement.kind });
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}
