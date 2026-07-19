import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { activateProjectLayout, buildIsolatedLayout } from "../src/linker/project-linker.js";
import { duplicatePackages, reportInstalledGraph } from "../src/commands/graph.js";
import type { PackageVersionManifest } from "../src/registry/types.js";
import type { ResolutionGraph, ResolvedPackage } from "../src/resolver/types.js";

const root = await mkdtemp(join(tmpdir(), "bnpm-linker-"));
after(async () => rm(root, { recursive: true, force: true }));

async function stored(name: string, version: string, bin?: Readonly<Record<string, string>>): Promise<string> {
  const path = join(root, "store", `${name}-${version}`);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name, version, ...(bin ? { bin } : {}) }));
  if (bin) await writeFile(join(path, Object.values(bin)[0] ?? "bin.js"), "#!/usr/bin/env node\n");
  return path;
}

function pkg(name: string, version: string, dependencies = new Map<string, string>(), bin?: Readonly<Record<string, string>>): ResolvedPackage {
  const manifest: PackageVersionManifest = {
    name,
    version,
    dependencies: Object.fromEntries(dependencies),
    ...(bin ? { bin } : {}),
    dist: { integrity: "sha512-fixture", tarball: `https://registry.example/${name}.tgz` },
  };
  return { id: `${name}@${version}`, name, version, integrity: "sha512-fixture", tarball: new URL(manifest.dist.tarball), manifest, dependencies };
}

test("isolated linker wires transitive dependencies, root aliases, bins, and atomic replacement", async () => {
  const dep = pkg("dep", "1.0.0");
  const app = pkg("app", "2.0.0", new Map([["dep", dep.id]]), { app: "cli.js" });
  const graph: ResolutionGraph = {
    roots: new Map([["renamed-app", app.id]]),
    packages: new Map([[app.id, app], [dep.id, dep]]),
  };
  const stores = new Map([[app.id, await stored("app", "2.0.0", { app: "cli.js" })], [dep.id, await stored("dep", "1.0.0")]]);
  const project = join(root, "project");
  const prepared = join(project, ".prepared");
  await mkdir(project, { recursive: true });
  await mkdir(join(project, "node_modules"), { recursive: true });
  await writeFile(join(project, "node_modules", "old"), "old");
  await buildIsolatedLayout(prepared, graph, stores);
  assert.equal(JSON.parse(await readFile(join(prepared, "renamed-app", "package.json"), "utf8")).version, "2.0.0");
  assert.equal(JSON.parse(await readFile(join(prepared, "renamed-app", "node_modules", "dep", "package.json"), "utf8")).name, "dep");
  if (process.platform !== "win32") assert.equal(await realpath(join(prepared, ".bin", "app")), join(await realpath(join(prepared, "renamed-app")), "cli.js"));
  assert.match(await readFile(join(prepared, ".bin", "app.cmd"), "utf8"), /node/);
  await activateProjectLayout(project, prepared);
  assert.equal((await lstat(join(project, "node_modules", "renamed-app"))).isSymbolicLink(), true);
  await assert.rejects(stat(join(project, "node_modules", "old")));
});

test("dependency graph reports aliases and concrete why paths", () => {
  const shared = pkg("shared", "1.0.0");
  const dep = pkg("dep", "2.0.0", new Map([["shared", shared.id]]));
  const app = pkg("app", "3.0.0", new Map([["dep", dep.id]]));
  const graph: ResolutionGraph = { roots: new Map([["renamed-app", app.id]]), packages: new Map([[app.id, app], [dep.id, dep], [shared.id, shared]]) };
  const listed = reportInstalledGraph(graph, graph.roots);
  assert.match(listed.human, /renamed-app -> app@3\.0\.0/);
  assert.match(listed.human, /shared@1\.0\.0/);
  const why = reportInstalledGraph(graph, graph.roots, { why: "shared" });
  assert.deepEqual(why.paths, [["renamed-app -> app@3.0.0", "dep@2.0.0", "shared@1.0.0"]]);
  assert.match(why.human, /renamed-app.*shared@1\.0\.0/);
});

test("duplicate report distinguishes multiple instances of the same package", () => {
  const one = pkg("shared", "1.0.0");
  const two = { ...pkg("shared", "2.0.0"), id: "shared@2.0.0(peer@1.0.0)" };
  const unique = pkg("unique", "1.0.0");
  const graph: ResolutionGraph = { roots: new Map(), packages: new Map([[one.id, one], [two.id, two], [unique.id, unique]]) };
  assert.deepEqual(duplicatePackages(graph), [{ name: "shared", versions: ["1.0.0", "2.0.0"], ids: ["shared@1.0.0", "shared@2.0.0(peer@1.0.0)"] }]);
});

test("isolated package instances expose dependency binaries to lifecycle scripts", async () => {
  const tool = pkg("tool", "1.0.0", new Map(), { tool: "cli.js" });
  const app = pkg("app-with-tool", "1.0.0", new Map([["tool", tool.id]]));
  const graph: ResolutionGraph = { roots: new Map([["app-with-tool", app.id]]), packages: new Map([[app.id, app], [tool.id, tool]]) };
  const stores = new Map([[app.id, await stored("app-with-tool", "1.0.0")], [tool.id, await stored("tool", "1.0.0", { tool: "cli.js" })]]);
  const destination = join(root, "dependency-bin-layout");
  await buildIsolatedLayout(destination, graph, stores);
  const binRoot = join(destination, "app-with-tool", "node_modules", ".bin");
  if (process.platform === "win32") assert.match(await readFile(join(binRoot, "tool.cmd"), "utf8"), /node/i);
  else assert.equal(await realpath(join(binRoot, "tool")), join(await realpath(join(destination, "app-with-tool", "node_modules", "tool")), "cli.js"));
});
