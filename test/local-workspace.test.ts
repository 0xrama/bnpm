import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createBnpmPaths } from "../src/config/paths.js";
import { installProject } from "../src/installer/install.js";
import { packPackage } from "../src/package/pack.js";
import { runCommand } from "../src/commands/index.js";
import type { CommandOptions } from "../src/core/cli-parser.js";
import type { Output } from "../src/core/output.js";
import { addDependencies } from "../src/installer/mutations.js";

const root = await mkdtemp(join(tmpdir(), "bnpm-local-workspace-"));
async function writable(path: string): Promise<void> { try { await chmod(path, 0o755); for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(path, entry.name)); } catch {} }
after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });

test("relative file dependencies are content-addressed and installed without registry access", async () => {
  const project = join(root, "file-project");
  const local = join(root, "local-package");
  await mkdir(project, { recursive: true }); await mkdir(local, { recursive: true });
  await writeFile(join(project, "package.json"), '{"name":"project","dependencies":{"local":"file:../local-package"}}');
  await writeFile(join(local, "package.json"), '{"name":"local","version":"1.2.3"}');
  await writeFile(join(local, "index.js"), "export default 42;\n");
  const paths = createBnpmPaths({ home: join(root, "home"), cwd: project, environment: { BNPM_CACHE_HOME: join(root, "file-cache") } });
  const result = await installProject({ cwd: project, paths, fetch: async () => { throw new Error("local install used registry"); } });
  assert.equal(result.graph.roots.get("local"), "local@1.2.3");
  assert.equal(await readFile(join(project, "node_modules", "local", "index.js"), "utf8"), "export default 42;\n");
  assert.match(await readFile(paths.lockfile, "utf8"), /directory:/);
});

test("relative local package archives are safely extracted, inferred, and installed", async () => {
  const project = join(root, "archive-project"); const source = join(root, "archive-source"); await mkdir(project); await mkdir(source);
  await writeFile(join(project, "package.json"), '{"name":"archive-consumer","version":"1.0.0"}');
  await writeFile(join(source, "package.json"), '{"name":"archive-package","version":"3.2.1"}'); await writeFile(join(source, "index.js"), "export default 'archive';\n");
  const archive = join(root, "archive-package.tgz"); await writeFile(archive, (await packPackage(source)).tarball);
  const paths = createBnpmPaths({ home: join(root, "archive-home"), cwd: project, environment: { BNPM_CACHE_HOME: join(root, "archive-cache") } });
  const result = await installProject({ cwd: project, paths, specifications: ["file:../archive-package.tgz"], fetch: async () => { throw new Error("local archive install used registry"); } });
  assert.equal(result.graph.roots.get("archive-package"), "archive-package@3.2.1");
  assert.equal(await readFile(join(project, "node_modules", "archive-package", "index.js"), "utf8"), "export default 'archive';\n");
  assert.match(await readFile(paths.lockfile, "utf8"), /source: tarball/);
});

test("package-lock-only resolves without creating an installation layout", async () => {
  const project = join(root, "lock-only-project"); const local = join(root, "lock-only-package"); await mkdir(project); await mkdir(local);
  await writeFile(join(project, "package.json"), '{"name":"lock-only","dependencies":{"local":"file:../lock-only-package"}}');
  await writeFile(join(local, "package.json"), '{"name":"local","version":"1.0.0"}');
  const paths = createBnpmPaths({ home: join(root, "lock-only-home"), cwd: project, environment: { BNPM_CACHE_HOME: join(root, "lock-only-cache") } });
  const result = await installProject({ cwd: project, paths, commandOptions: { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, packageLockOnly: true, saveExact: false, noSave: false } });
  assert.equal(result.graph.roots.get("local"), "local@1.0.0"); assert.match(await readFile(paths.lockfile, "utf8"), /local@1\.0\.0/);
  await assert.rejects(() => readFile(join(project, "node_modules", "local", "package.json")), /ENOENT/);
});

test("install mutation dry-runs resolve without changing manifests, lockfiles, or layouts", async () => {
  const project = join(root, "dry-run-project"); const local = join(root, "dry-run-package"); await mkdir(project); await mkdir(local);
  const original = '{"name":"dry-run","version":"1.0.0"}\n'; await writeFile(join(project, "package.json"), original); await writeFile(join(local, "package.json"), '{"name":"dry-local","version":"1.0.0"}');
  const paths = createBnpmPaths({ home: join(root, "dry-run-home"), cwd: project, environment: { BNPM_CACHE_HOME: join(root, "dry-run-cache") } });
  const options: CommandOptions = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, dryRun: true, saveExact: false, noSave: false };
  const result = await addDependencies(project, ["dry-local@file:../dry-run-package"], options, { paths }); assert.equal(result.graph.roots.get("dry-local"), "dry-local@1.0.0");
  assert.equal(await readFile(join(project, "package.json"), "utf8"), original);
  await assert.rejects(() => readFile(paths.lockfile), /ENOENT/); await assert.rejects(() => readFile(join(project, "node_modules", "dry-local", "package.json")), /ENOENT/);
});

test("bare local directory operands infer names and save canonical relative file specs", async () => {
  const project = join(root, "bare-directory-project"); const local = join(root, "bare-directory-package"); await mkdir(project); await mkdir(local);
  await writeFile(join(project, "package.json"), '{"name":"bare-consumer","version":"1.0.0"}'); await writeFile(join(local, "package.json"), '{"name":"bare-local","version":"4.0.0"}');
  const paths = createBnpmPaths({ home: join(root, "bare-home"), cwd: project, environment: { BNPM_CACHE_HOME: join(root, "bare-cache") } });
  const options: CommandOptions = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false };
  await addDependencies(project, ["../bare-directory-package"], options, { paths });
  assert.equal(JSON.parse(await readFile(join(project, "package.json"), "utf8")).dependencies["bare-local"], "file:../bare-directory-package");
  assert.equal(JSON.parse(await readFile(join(project, "node_modules", "bare-local", "package.json"), "utf8")).version, "4.0.0");
});

test("omit and include control physical dev, optional, and peer layouts while retaining the lock graph", async () => {
  const project = join(root, "omit-project"); await mkdir(project);
  for (const name of ["prod", "dev", "optional", "peer"]) { const directory = join(root, `omit-${name}`); await mkdir(directory); await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0" })); }
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "omit-root", dependencies: { prod: "file:../omit-prod" }, devDependencies: { dev: "file:../omit-dev" }, optionalDependencies: { optional: "file:../omit-optional" }, peerDependencies: { peer: "file:../omit-peer" } }));
  const paths = createBnpmPaths({ home: join(root, "omit-home"), cwd: project, environment: { BNPM_CACHE_HOME: join(root, "omit-cache") } });
  const options = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: true, omit: ["dev", "optional", "peer"] as const, saveExact: false, noSave: false };
  const result = await installProject({ cwd: project, paths, commandOptions: options });
  assert.deepEqual([...result.graph.roots.keys()], ["prod"]); assert.equal(JSON.parse(await readFile(join(project, "node_modules", "prod", "package.json"), "utf8")).name, "prod");
  for (const name of ["dev", "optional", "peer"]) await assert.rejects(() => readFile(join(project, "node_modules", name, "package.json")), /ENOENT/);
  const lockfile = await readFile(paths.lockfile, "utf8"); for (const name of ["prod", "dev", "optional", "peer"]) assert.match(lockfile, new RegExp(`${name}@1\\.0\\.0`));
});

test("workspace protocol resolves members from the workspace root", async () => {
  const workspace = join(root, "workspace");
  const app = join(workspace, "packages", "app");
  const lib = join(workspace, "packages", "lib");
  await mkdir(app, { recursive: true }); await mkdir(lib, { recursive: true });
  await writeFile(join(workspace, "package.json"), '{"name":"root","workspaces":["packages/*"]}');
  await writeFile(join(app, "package.json"), '{"name":"app","version":"1.0.0","dependencies":{"lib":"workspace:*"}}');
  await writeFile(join(lib, "package.json"), '{"name":"lib","version":"2.0.0"}');
  await writeFile(join(lib, "index.js"), "module.exports = 'workspace';\n");
  const paths = createBnpmPaths({ home: join(root, "home"), cwd: workspace, environment: { BNPM_CACHE_HOME: join(root, "workspace-cache") } });
  const result = await installProject({ cwd: app, paths, fetch: async () => { throw new Error("workspace install used registry"); } });
  assert.equal(result.graph.importers?.get("packages/app")?.get("lib"), "lib@2.0.0");
  assert.equal(JSON.parse(await readFile(join(app, "node_modules", "lib", "package.json"), "utf8")).version, "2.0.0");
  const lockfile = await readFile(paths.lockfile, "utf8");
  assert.match(lockfile, /packages\/app:/);
  assert.match(lockfile, /packages\/lib:/);
  await installProject({
    cwd: app,
    paths,
    commandOptions: { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: true, omitDev: false, saveExact: false, noSave: false },
    fetch: async () => { throw new Error("offline workspace install used registry"); },
  });
  assert.equal(JSON.parse(await readFile(join(app, "node_modules", "lib", "package.json"), "utf8")).name, "lib");
});

test("workspace-scoped add mutates every selected member and refreshes the shared layout", async () => {
  const workspace = join(root, "workspace-add"); const a = join(workspace, "packages", "a"); const b = join(workspace, "packages", "b"); const dependency = join(workspace, "dependency");
  await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true }); await mkdir(dependency);
  await writeFile(join(workspace, "package.json"), '{"name":"root","private":true,"workspaces":["packages/*"]}');
  await writeFile(join(a, "package.json"), '{"name":"a","version":"1.0.0"}'); await writeFile(join(b, "package.json"), '{"name":"b","version":"1.0.0"}');
  await writeFile(join(dependency, "package.json"), '{"name":"shared-dep","version":"1.0.0"}');
  const options: CommandOptions = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false, workspaceNames: ["a", "b"] };
  const output: Output = { info() {}, error() {}, result() {}, childOutput() {} };
  const previous = process.env.BNPM_CACHE_HOME; process.env.BNPM_CACHE_HOME = join(root, "workspace-add-cache");
  try { assert.equal(await runCommand("add", { args: ["shared-dep@file:../../dependency"], cwd: workspace, output, invokedAsBnpmx: false, options, signal: new AbortController().signal }), 0); }
  finally { if (previous === undefined) delete process.env.BNPM_CACHE_HOME; else process.env.BNPM_CACHE_HOME = previous; }
  for (const member of [a, b]) {
    assert.equal(JSON.parse(await readFile(join(member, "package.json"), "utf8")).dependencies["shared-dep"], "file:../../dependency");
    assert.equal(JSON.parse(await readFile(join(member, "node_modules", "shared-dep", "package.json"), "utf8")).version, "1.0.0");
  }
});
