import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import npa from "npm-package-arg";
import type { CommandOptions, SaveSection } from "../core/cli-parser.js";
import { parseManifest, planManifestMutation, type DependencySection } from "../project/manifest.js";
import { discoverProject } from "../project/discovery.js";
import { DependencyError } from "../project/dependency-error.js";
import { createGitPreparer, installProject, requirementsForManifest, type InstallProjectOptions, type InstallProjectResult } from "./install.js";
import { createBnpmPaths } from "../config/paths.js";
import { loadRegistryConfiguration } from "../registry/configuration.js";
import { RemoteSourceProvider } from "../resolver/source-provider.js";

const allSections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

function dependencySection(save: SaveSection | undefined): DependencySection {
  return save === "dev" ? "devDependencies" : save === "optional" ? "optionalDependencies" : save === "peer" ? "peerDependencies" : "dependencies";
}

async function writeManifestAtomic(path: string, bytes: string): Promise<void> {
  const temporary = join(dirname(path), `.package-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function parsedSpecification(specification: string, cwd: string, sourceProvider: RemoteSourceProvider, signal?: AbortSignal): Promise<{ readonly name: string; readonly specifier: string }> {
  const parsed = npa(specification);
  let name: string | undefined = parsed.name ?? undefined;
  if (!name && (parsed.type === "remote" || parsed.type === "git" || parsed.type === "file")) {
    const sourced = await sourceProvider.resolve("bnpm-source", parsed.rawSpec, cwd, signal);
    name = sourced?.actualName;
  }
  if (!name && parsed.type === "directory") {
    const resolved = npa.resolve("bnpm-source", parsed.rawSpec, cwd); const manifestPath = join(String(resolved.fetchSpec), "package.json"); name = parseManifest(await readFile(manifestPath, "utf8"), manifestPath).name;
  }
  if (!name) throw new DependencyError(`Package specification does not have an inferable name: ${specification}`);
  if (parsed.type === "directory" || parsed.type === "file") {
    const resolved = npa.resolve(name, parsed.rawSpec, cwd); const path = relative(cwd, String(resolved.fetchSpec)).split(sep).join("/"); return { name, specifier: `file:${path.startsWith(".") ? path : `./${path}`}` };
  }
  return { name, specifier: parsed.rawSpec || "latest" };
}

export async function addDependencies(
  cwd: string,
  specifications: readonly string[],
  commandOptions: CommandOptions,
  installOptions: Omit<InstallProjectOptions, "cwd" | "specifications" | "requirements" | "commandOptions"> = {},
): Promise<InstallProjectResult> {
  if (commandOptions.noSave) return installProject({ cwd, specifications, commandOptions, ...installOptions });
  const discovered = await discoverProject(cwd);
  const importerRoot = discovered?.importerRoot ?? cwd;
  const projectRoot = discovered?.projectRoot ?? cwd;
  const paths = installOptions.paths ?? createBnpmPaths({ cwd: projectRoot });
  const registryConfiguration = installOptions.registryConfiguration ?? await loadRegistryConfiguration({
    userNpmrc: paths.userNpmrc,
    projectNpmrc: paths.projectNpmrc,
    ...(installOptions.registry === undefined ? {} : { defaultRegistry: installOptions.registry }),
  });
  const fetchImpl = installOptions.fetch ?? globalThis.fetch;
  const sourceProvider = installOptions.sourceProvider ?? new RemoteSourceProvider({
    quarantineRoot: paths.quarantine,
    registryConfiguration,
    fetch: fetchImpl,
    prepareGit: await createGitPreparer({
      paths,
      registryConfiguration,
      fetch: fetchImpl,
      commandOptions,
      ...(installOptions.prompts === undefined ? {} : { prompts: installOptions.prompts }),
      ...(installOptions.sourceBuildDepth === undefined ? {} : { sourceBuildDepth: installOptions.sourceBuildDepth }),
      ...(installOptions.onChildOutput === undefined ? {} : { onChildOutput: installOptions.onChildOutput }),
      ...(installOptions.onSecurityEvidence === undefined ? {} : { onSecurityEvidence: installOptions.onSecurityEvidence }),
    }),
  });
  const manifestPath = join(importerRoot, "package.json");
  try {
    let bytes = await readFile(manifestPath, "utf8");
    const targetSection = dependencySection(commandOptions.saveSection);
    for (const specification of specifications) {
      const parsed = await parsedSpecification(specification, importerRoot, sourceProvider, installOptions.signal);
      for (const section of allSections) {
        if (section === targetSection) continue;
        const manifest = parseManifest(bytes, manifestPath);
        if (manifest.dependencies[section]?.[parsed.name] !== undefined) {
          bytes = planManifestMutation(manifest, { operation: "remove", name: parsed.name, section }).bytes;
        }
      }
      bytes = planManifestMutation(parseManifest(bytes, manifestPath), {
        operation: "add",
        name: parsed.name,
        section: targetSection,
        specifier: parsed.specifier,
        exact: commandOptions.saveExact,
      }).bytes;
    }
    const prospective = parseManifest(bytes, manifestPath);
    const result = await installProject({ cwd, requirements: requirementsForManifest(prospective, false), commandOptions, ...installOptions, paths, registryConfiguration, sourceProvider });
    if (!commandOptions.dryRun) await writeManifestAtomic(manifestPath, bytes);
    return result;
  } finally {
    await sourceProvider.cleanup();
  }
}

export async function removeDependencies(
  cwd: string,
  names: readonly string[],
  commandOptions: CommandOptions,
  installOptions: Omit<InstallProjectOptions, "cwd" | "specifications" | "requirements" | "commandOptions"> = {},
): Promise<InstallProjectResult> {
  const importerRoot = (await discoverProject(cwd))?.importerRoot ?? cwd;
  const manifestPath = join(importerRoot, "package.json");
  let bytes = await readFile(manifestPath, "utf8");
  for (const name of names) {
    for (const section of allSections) {
      bytes = planManifestMutation(parseManifest(bytes, manifestPath), { operation: "remove", name, section }).bytes;
    }
  }
  const prospective = parseManifest(bytes, manifestPath);
  const result = await installProject({ cwd, requirements: requirementsForManifest(prospective, false), commandOptions, ...installOptions });
  if (!commandOptions.dryRun) await writeManifestAtomic(manifestPath, bytes);
  return result;
}

export async function updateDependencies(
  cwd: string,
  names: readonly string[],
  commandOptions: CommandOptions,
  installOptions: Omit<InstallProjectOptions, "cwd" | "specifications" | "requirements" | "commandOptions" | "forceResolution" | "resolutionOverrides"> = {},
): Promise<InstallProjectResult> {
  const importerRoot = (await discoverProject(cwd))?.importerRoot ?? cwd;
  const manifestPath = join(importerRoot, "package.json");
  const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
  const requirements = requirementsForManifest(manifest, false);
  const declared = new Set(requirements.map((requirement) => requirement.name));
  for (const name of names) if (!declared.has(name)) throw new DependencyError(`Dependency is not declared: ${name}`);
  const selected = new Set(names);
  const resolutionOverrides: Record<string, string> = {};
  if (selected.size > 0) {
    for (const requirement of requirements) {
      if (selected.has(requirement.name) || requirement.specifier.startsWith("file:") || requirement.specifier.startsWith("workspace:")) continue;
      const parsed = npa.resolve(requirement.name, requirement.specifier);
      if (parsed.type === "alias" || parsed.type === "remote" || parsed.type === "git") continue;
      try {
        const installed = JSON.parse(await readFile(join(importerRoot, "node_modules", ...requirement.name.split("/"), "package.json"), "utf8")) as { version?: unknown };
        if (typeof installed.version === "string") resolutionOverrides[requirement.name] = installed.version;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return installProject({
    cwd,
    requirements,
    commandOptions,
    forceResolution: true,
    resolutionOverrides,
    ...installOptions,
  });
}
