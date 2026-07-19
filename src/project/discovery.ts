import { readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseManifest } from "./manifest.js";

export interface DiscoveredProject {
  readonly projectRoot: string;
  readonly importerRoot: string;
  readonly kind: "project" | "workspace";
}

interface ManifestAtPath {
  readonly root: string;
  readonly workspaces: readonly string[];
}

async function manifestAt(root: string): Promise<ManifestAtPath | undefined> {
  try {
    const path = resolve(root, "package.json");
    const manifest = parseManifest(await readFile(path, "utf8"), path);
    return { root, workspaces: manifest.workspaces };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function workspacePatternMatches(pattern: string, importerPath: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = importerPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const expression = new RegExp(
    `^${normalizedPattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}$`,
  );
  return expression.test(normalizedPath);
}

export async function discoverProject(cwd: string): Promise<DiscoveredProject | undefined> {
  let current = await realpath(cwd);
  const manifests: ManifestAtPath[] = [];
  while (true) {
    const manifest = await manifestAt(current);
    if (manifest) manifests.push(manifest);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const importer = manifests[0];
  if (!importer) return undefined;
  if (importer.workspaces.length > 0) {
    return { projectRoot: importer.root, importerRoot: importer.root, kind: "project" };
  }
  for (const workspace of manifests.slice(1)) {
    const importerPath = relative(workspace.root, importer.root).split(sep).join("/");
    if (workspace.workspaces.some((pattern) => workspacePatternMatches(pattern, importerPath))) {
      return { projectRoot: workspace.root, importerRoot: importer.root, kind: "workspace" };
    }
  }
  return { projectRoot: importer.root, importerRoot: importer.root, kind: "project" };
}
