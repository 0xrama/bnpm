import { readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseManifest } from "./manifest.js";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(`Workspace error: ${message}`);
    this.name = "WorkspaceError";
  }
}

function segmentMatches(pattern: string, value: string): boolean {
  const expression = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
  return expression.test(value);
}

function patternMatches(pattern: string, path: string): boolean {
  const patterns = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "").split("/");
  const parts = path.replace(/\\/g, "/").split("/");
  const match = (patternIndex: number, partIndex: number): boolean => {
    if (patternIndex === patterns.length) return partIndex === parts.length;
    if (patterns[patternIndex] === "**") return match(patternIndex + 1, partIndex) || (partIndex < parts.length && match(patternIndex, partIndex + 1));
    return partIndex < parts.length && segmentMatches(patterns[patternIndex] ?? "", parts[partIndex] ?? "") && match(patternIndex + 1, partIndex + 1);
  };
  return match(0, 0);
}

export async function discoverWorkspacePackages(root: string, patterns: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const canonicalRoot = await realpath(root);
  const packages = new Map<string, string>();
  let visited = 0;
  const walk = async (directory: string): Promise<void> => {
    visited += 1;
    if (visited > 10_000) throw new WorkspaceError("workspace discovery exceeded 10,000 directories");
    const relativePath = relative(canonicalRoot, directory).split(sep).join("/");
    if (relativePath && patterns.some((pattern) => patternMatches(pattern, relativePath))) {
      try {
        const manifestPath = join(directory, "package.json");
        const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
        if (!manifest.name) throw new WorkspaceError(`${manifestPath} requires a package name`);
        if (packages.has(manifest.name)) throw new WorkspaceError(`duplicate workspace package name ${manifest.name}`);
        packages.set(manifest.name, await realpath(directory));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || ["node_modules", ".git", ".bnpm"].includes(entry.name)) continue;
      await walk(join(directory, entry.name));
    }
  };
  await walk(canonicalRoot);
  return new Map([...packages].sort(([left], [right]) => left.localeCompare(right)));
}
