export interface PackageDistribution {
  integrity?: string;
  shasum?: string;
  tarball: string;
}

export interface PackageVersionManifest {
  name: string;
  version: string;
  dependencies?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
  peerDependencies?: Readonly<Record<string, string>>;
  peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  scripts?: Readonly<Record<string, string>>;
  bin?: string | Readonly<Record<string, string>>;
  engines?: Readonly<Record<string, string>>;
  os?: readonly string[];
  cpu?: readonly string[];
  libc?: readonly string[];
  funding?: unknown;
  dist: PackageDistribution;
}

export interface PackageDocument {
  name: string;
  "dist-tags": Readonly<Record<string, string>>;
  versions: Readonly<Record<string, PackageVersionManifest>>;
  time?: Readonly<Record<string, string>>;
}
