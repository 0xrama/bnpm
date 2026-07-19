declare module "npm-packlist" {
  interface PackageTree {
    readonly path: string;
    readonly package: Record<string, unknown>;
    readonly isProjectRoot: boolean;
    readonly edgesOut: ReadonlyMap<string, unknown>;
    readonly workspaces?: ReadonlyMap<string, string>;
  }

  function packlist(tree: PackageTree): Promise<string[]>;
  export = packlist;
}
