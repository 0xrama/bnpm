import { constants } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BnpmPaths } from "../config/paths.js";
import { extractPackageArchive } from "../cache/archive.js";
import { parseManifest } from "../project/manifest.js";
import { downloadStagedPackageTarball } from "../registry/operations.js";
import { PackError } from "../package/pack.js";
import semver from "semver";

export interface DownloadedStage {
  readonly id: string;
  readonly package: string;
  readonly version: string;
  readonly filename: string;
  readonly path: string;
  readonly bytes: number;
  readonly integrity: string;
  readonly entries: number;
  readonly expandedBytes: number;
}

export async function downloadStage(options: {
  readonly id: string;
  readonly cwd: string;
  readonly paths: BnpmPaths;
  readonly registry?: URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}): Promise<DownloadedStage> {
  const tarball = await downloadStagedPackageTarball(options);
  const inspection = await mkdtemp(join(options.paths.quarantine, "stage-inspect-"));
  try {
    const extracted = await extractPackageArchive(tarball.path, join(inspection, "package"));
    const manifestPath = join(extracted.path, "package.json");
    const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
    const raw = JSON.parse(manifest.bytes) as Record<string, unknown>;
    const version = raw.version;
    if (!manifest.name || typeof version !== "string" || semver.valid(version) !== version) throw new PackError("staged package manifest requires a valid name and exact semantic version");
    const safeName = manifest.name.replace(/^@/, "").replace("/", "-");
    const filename = `${safeName}-${version}-${options.id}.tgz`;
    const destination = resolve(options.cwd, filename);
    try {
      await copyFile(tarball.path, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PackError(`refusing to replace existing staged package download ${filename}`);
      throw error;
    }
    return { id: options.id, package: manifest.name, version, filename, path: destination, bytes: tarball.bytes, integrity: tarball.integrity, entries: extracted.entries, expandedBytes: extracted.expandedBytes };
  } finally {
    await Promise.all([
      rm(dirname(tarball.path), { recursive: true, force: true }),
      rm(inspection, { recursive: true, force: true }),
    ]);
  }
}
