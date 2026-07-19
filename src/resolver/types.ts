import type { PackageVersionManifest } from "../registry/types.js";

export interface Requirement {
  name: string;
  specifier: string;
  kind: "dependency" | "dev" | "optional" | "peer" | "workspace";
  importer?: string;
}

export interface ResolvedPackage {
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
  dependencies: ReadonlyMap<string, string>;
}

export interface ResolutionGraph {
  roots: ReadonlyMap<string, string>;
  packages: ReadonlyMap<string, ResolvedPackage>;
  importers?: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export interface Resolver {
  resolve(requirements: readonly Requirement[], signal?: AbortSignal): Promise<ResolutionGraph>;
}
