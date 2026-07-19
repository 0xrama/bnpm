import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import semver from "semver";
import { PackError } from "./pack.js";

async function atomicJson(path: string, value: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function defaultName(directory: string): string {
  const normalized = basename(directory).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "");
  if (!normalized) throw new PackError("cannot infer a valid package name from the directory");
  return normalized;
}

export async function initializePackage(options: {
  readonly directory: string;
  readonly values?: Readonly<Partial<Record<"name" | "version" | "description" | "entry" | "license", string>>>;
}): Promise<Readonly<Record<string, unknown>>> {
  const path = join(options.directory, "package.json");
  try { await readFile(path); throw new PackError("package.json already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const name = options.values?.name || defaultName(options.directory);
  if (!/^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new PackError("package name is invalid");
  const version = options.values?.version || "1.0.0";
  if (!semver.valid(version)) throw new PackError("package version must be exact semantic version");
  const manifest: Record<string, unknown> = {
    name,
    version,
    description: options.values?.description ?? "",
    main: options.values?.entry || "index.js",
    scripts: { test: "echo \"Error: no test specified\" && exit 1" },
    keywords: [],
    author: "",
    license: options.values?.license || "ISC",
  };
  await atomicJson(path, manifest);
  return manifest;
}

export async function initializeWorkspace(options: { readonly root: string; readonly workspace: string; readonly createManifest: boolean }): Promise<{ readonly root: string; readonly directory: string; readonly workspace: string; readonly manifest?: Readonly<Record<string, unknown>> }> {
  if (!options.workspace || options.workspace.includes("\0") || isAbsolute(options.workspace) || options.workspace.split(/[\\/]/).includes("..")) throw new PackError("workspace init path must be a safe relative directory");
  const root = await realpath(options.root); const directory = resolve(root, options.workspace);
  if (!directory.startsWith(`${root}${sep}`)) throw new PackError("workspace init path escapes the project root");
  const rootPath = join(root, "package.json"); let document: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(await readFile(rootPath, "utf8")); if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object"); document = parsed as Record<string, unknown>; }
  catch (error) { throw new PackError(`cannot read workspace root package.json: ${error instanceof Error ? error.message : String(error)}`); }
  const workspace = relative(root, directory).split(sep).join("/"); const current = document.workspaces;
  if (current === undefined) document.workspaces = [workspace];
  else if (Array.isArray(current) && current.every((value) => typeof value === "string")) document.workspaces = [...new Set([...current, workspace])];
  else if (typeof current === "object" && current !== null && !Array.isArray(current) && Array.isArray((current as { packages?: unknown }).packages) && (current as { packages: unknown[] }).packages.every((value) => typeof value === "string")) document.workspaces = { ...current, packages: [...new Set([...(current as { packages: string[] }).packages, workspace])] };
  else throw new PackError("workspace root has an invalid workspaces field");
  await mkdir(directory, { recursive: true });
  const manifest = options.createManifest ? await initializePackage({ directory }) : undefined;
  try { await atomicJson(rootPath, document); }
  catch (error) { if (options.createManifest) await rm(join(directory, "package.json"), { force: true }); throw error; }
  return { root, directory, workspace, ...(manifest === undefined ? {} : { manifest }) };
}

export async function readPackageVersion(directory: string): Promise<{ readonly name: string; readonly version: string; readonly manifest: Record<string, unknown> }> {
  const path = join(directory, "package.json");
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    throw new PackError(`cannot read package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string" || !semver.valid(manifest.version)) throw new PackError("package.json requires a name and exact semantic version");
  return { name: manifest.name, version: manifest.version, manifest };
}

export function nextPackageVersion(current: string, requested: string, options: { readonly preid?: string; readonly allowSame?: boolean } = {}): string {
  const release = ["major", "minor", "patch", "premajor", "preminor", "prepatch", "prerelease"].includes(requested)
    ? options.preid === undefined ? semver.inc(current, requested as semver.ReleaseType) : semver.inc(current, requested as semver.ReleaseType, options.preid)
    : semver.valid(requested);
  if (!release) throw new PackError(`invalid version or release type ${requested}`);
  if (release === current && !options.allowSame) throw new PackError(`version is already ${release}`);
  return release;
}

export async function changePackageVersion(directory: string, requested: string, options: { readonly preid?: string; readonly allowSame?: boolean } = {}): Promise<{ readonly name: string; readonly previous: string; readonly version: string }> {
  const current = await readPackageVersion(directory);
  const release = nextPackageVersion(current.version, requested, options);
  await atomicJson(join(directory, "package.json"), { ...current.manifest, version: release });
  return { name: current.name, previous: current.version, version: release };
}
