import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import tar from "tar-stream";
import { createGzip } from "node:zlib";
import { createBnpmPaths } from "../src/config/paths.js";
import { createGitPreparer, installProject } from "../src/installer/install.js";
import { addDependencies } from "../src/installer/mutations.js";
import { RegistryConfiguration } from "../src/registry/configuration.js";
import { RegistryResolver } from "../src/resolver/registry-resolver.js";
import { RemoteSourceProvider } from "../src/resolver/source-provider.js";

async function writable(path: string): Promise<void> {
  try {
    await chmod(path, 0o755);
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(path, entry.name));
  } catch {}
}

async function tarball(files: Readonly<Record<string, string>>): Promise<Buffer> {
  const pack = tar.pack();
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    gzip.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    gzip.once("end", () => resolve(Buffer.concat(chunks)));
    gzip.once("error", reject);
  });
  pack.pipe(gzip);
  for (const [path, contents] of Object.entries(files)) pack.entry({ name: `package/${path}` }, contents);
  pack.finalize();
  return completed;
}

test("HTTPS tarball dependencies are quarantined, locked by digest, and reinstall offline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-remote-"));
  t.after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "project"));
  const project = join(root, "project");
  const url = "https://artifacts.example/packages/remote.tgz";
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "project", dependencies: { remote: url } }));
  const archive = await tarball({
    "package.json": JSON.stringify({ name: "actual-remote", version: "1.2.3", main: "index.js" }),
    "index.js": "module.exports = 'remote-ok'\n",
  });
  let requests = 0;
  const fetchMock: typeof fetch = async (input) => {
    requests += 1;
    assert.equal(String(input), url);
    return new Response(new Uint8Array(archive), { status: 200, headers: { "content-length": String(archive.length) } });
  };
  const paths = createBnpmPaths({ cwd: project, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const first = await installProject({ cwd: project, paths, fetch: fetchMock, recentReleaseHours: 1, commandOptions: { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false } });
  assert.equal(first.graph.packages.get("actual-remote@1.2.3")?.source, "tarball");
  assert.equal(await readFile(join(project, "node_modules", "remote", "index.js"), "utf8"), "module.exports = 'remote-ok'\n");
  const lock = await readFile(paths.lockfile, "utf8");
  assert.match(lock, /source: tarball/);
  assert.match(lock, /integrity: sha512-/);
  assert.match(lock, /https:\/\/artifacts\.example\/packages\/remote\.tgz/);
  assert.deepEqual(await readdir(paths.quarantine), []);
  await rm(join(project, "node_modules"), { recursive: true, force: true });
  await installProject({ cwd: project, paths, fetch: async () => { throw new Error("offline install must not fetch"); }, commandOptions: { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: true, omitDev: false, saveExact: false, noSave: false } });
  assert.equal(await readFile(join(project, "node_modules", "remote", "index.js"), "utf8"), "module.exports = 'remote-ok'\n");
  assert.equal(requests, 1);
});

test("HTTPS Git dependencies are packed canonically and pinned to the resolved commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-git-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const calls: string[][] = [];
  const sourceProvider = new RemoteSourceProvider({
    quarantineRoot: join(root, "quarantine"),
    registryConfiguration: new RegistryConfiguration({ defaultRegistry: new URL("https://registry.npmjs.org/") }),
    runGit: async (args, cwd) => {
      calls.push([...args]);
      if (args[0] === "checkout") {
        await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "git-package", version: "2.0.0", main: "index.js" }));
        await writeFile(join(cwd, "index.js"), "module.exports = 'git-ok'\n");
      }
      return args[0] === "rev-parse" ? commit : "";
    },
  });
  const resolver = new RegistryResolver({ packageDocument: async () => { throw new Error("git dependency must not query the registry"); } }, { baseDirectory: root, sourceProvider });
  const graph = await resolver.resolve([{ name: "git-alias", specifier: "git+https://github.com/example/repository.git#main", kind: "dependency" }]);
  const pkg = graph.packages.get("git-package@2.0.0");
  assert.equal(pkg?.source, "git");
  assert.equal(pkg?.tarball.href, `git+https://github.com/example/repository.git#${commit}`);
  assert.match(pkg?.integrity ?? "", /^sha512-/);
  assert.equal(await readFile(join(pkg?.preparedPath ?? "", "index.js"), "utf8"), "module.exports = 'git-ok'\n");
  assert.deepEqual(calls.map((args) => args[0]), ["init", "remote", "fetch", "checkout", "rev-parse"]);
  assert.ok(calls[2]?.includes("main"));
  await sourceProvider.cleanup();
  assert.deepEqual(await readdir(join(root, "quarantine")), []);
});

test("bare HTTPS tarball operands infer and transactionally save the manifest name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-bare-source-"));
  t.after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "package.json"), '{"name":"project"}\n');
  const url = "https://artifacts.example/bare.tgz";
  const archive = await tarball({
    "package.json": JSON.stringify({ name: "inferred-package", version: "3.1.4", main: "index.js" }),
    "index.js": "module.exports = 'inferred'\n",
  });
  let requests = 0;
  const paths = createBnpmPaths({ cwd: project, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  await addDependencies(project, [url], { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false }, {
    paths,
    fetch: async () => { requests += 1; return new Response(new Uint8Array(archive), { status: 200 }); },
    recentReleaseHours: 1,
  });
  assert.equal(requests, 1, "name inference and install should reuse one quarantined download");
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  assert.deepEqual(manifest.dependencies, { "inferred-package": url });
  assert.equal(await readFile(join(project, "node_modules", "inferred-package", "index.js"), "utf8"), "module.exports = 'inferred'\n");
});

test("Git semver selectors choose the highest matching tag and preserve package subdirectories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-git-semver-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commit = "abcdef0123456789abcdef0123456789abcdef01";
  const calls: string[][] = [];
  const provider = new RemoteSourceProvider({
    quarantineRoot: join(root, "quarantine"),
    registryConfiguration: new RegistryConfiguration({ defaultRegistry: new URL("https://registry.npmjs.org/") }),
    runGit: async (args, cwd) => {
      calls.push([...args]);
      if (args[0] === "ls-remote") return [
        "1111111111111111111111111111111111111111\trefs/tags/v1.9.0",
        "2222222222222222222222222222222222222222\trefs/tags/v2.0.0",
        "3333333333333333333333333333333333333333\trefs/tags/v2.4.0",
        "4444444444444444444444444444444444444444\trefs/tags/v3.0.0",
      ].join("\n");
      if (args[0] === "checkout") {
        const packageRoot = join(cwd, "packages", "tool");
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "semver-git", version: "2.4.0", main: "index.js" }));
        await writeFile(join(packageRoot, "index.js"), "semver git\n");
      }
      return args[0] === "rev-parse" ? commit : "";
    },
  });
  const resolver = new RegistryResolver({ packageDocument: async () => { throw new Error("must not use registry"); } }, { baseDirectory: root, sourceProvider: provider });
  const graph = await resolver.resolve([{ name: "alias", specifier: "git+https://github.com/example/repository.git#semver:^2::path:packages/tool", kind: "dependency" }]);
  const pkg = graph.packages.get("semver-git@2.4.0");
  assert.equal(pkg?.tarball.href, `git+https://github.com/example/repository.git#${commit}::path:packages/tool`);
  assert.ok(calls.find((args) => args[0] === "fetch")?.includes("refs/tags/v2.4.0"));
  assert.equal(await readFile(join(pkg?.preparedPath ?? "", "index.js"), "utf8"), "semver git\n");
  await provider.cleanup();
});

test("Git submodules are initialized recursively only after HTTPS URL validation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-git-submodule-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commit = "fedcba9876543210fedcba9876543210fedcba98";
  const calls: { args: string[]; cwd: string }[] = [];
  const provider = new RemoteSourceProvider({
    quarantineRoot: join(root, "quarantine"),
    registryConfiguration: new RegistryConfiguration({ defaultRegistry: new URL("https://registry.npmjs.org/") }),
    runGit: async (args, cwd) => {
      calls.push({ args: [...args], cwd });
      if (args[0] === "checkout") {
        await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "submodule-package", version: "1.0.0", files: ["index.js", "vendor"] }));
        await writeFile(join(cwd, "index.js"), "root\n");
        await writeFile(join(cwd, ".gitmodules"), '[submodule "vendor"]\npath = vendor\nurl = https://github.com/example/vendor.git\n');
      }
      if (args.includes("submodule") && !args.includes("--recursive")) {
        await mkdir(join(cwd, "vendor"), { recursive: true });
        await writeFile(join(cwd, "vendor", "index.js"), "vendor\n");
        await writeFile(join(cwd, "vendor", ".gitmodules"), '[submodule "nested"]\npath = nested\nurl = ../nested.git\n');
      }
      if (args[0] === "config") return cwd.endsWith("vendor") ? "submodule.nested.url ../nested.git" : "submodule.vendor.url https://github.com/example/vendor.git";
      if (args[0] === "remote" && args[1] === "get-url") return "https://github.com/example/vendor.git";
      return args[0] === "rev-parse" ? commit : "";
    },
  });
  const resolver = new RegistryResolver({ packageDocument: async () => { throw new Error("must not use registry"); } }, { baseDirectory: root, sourceProvider: provider });
  const graph = await resolver.resolve([{ name: "submodule-package", specifier: "git+https://github.com/example/root.git#main", kind: "dependency" }]);
  const pkg = graph.packages.get("submodule-package@1.0.0");
  assert.equal(await readFile(join(pkg?.preparedPath ?? "", "vendor", "index.js"), "utf8"), "vendor\n");
  assert.ok(calls.some(({ args }) => args.includes("submodule") && args.includes("--recursive")));
  assert.ok(calls.some(({ cwd }) => cwd.endsWith("vendor")), "nested .gitmodules should be inspected before recursion");
  await provider.cleanup();
});

test("Git submodules reject non-HTTPS URLs before any submodule fetch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-git-submodule-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[][] = [];
  const provider = new RemoteSourceProvider({
    quarantineRoot: join(root, "quarantine"),
    registryConfiguration: new RegistryConfiguration({ defaultRegistry: new URL("https://registry.npmjs.org/") }),
    runGit: async (args, cwd) => {
      calls.push([...args]);
      if (args[0] === "checkout") {
        await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "unsafe-submodule", version: "1.0.0" }));
        await writeFile(join(cwd, ".gitmodules"), '[submodule "unsafe"]\npath = unsafe\nurl = git@github.com:example/unsafe.git\n');
      }
      if (args[0] === "config") return "submodule.unsafe.url git@github.com:example/unsafe.git";
      return "";
    },
  });
  await assert.rejects(() => provider.resolve("unsafe", "git+https://github.com/example/root.git#main", root), /invalid URL|must use HTTPS/);
  assert.ok(!calls.some((args) => args.includes("submodule")), "unsafe submodule URL must fail before initialization");
  await provider.cleanup();
});

test("Git prepare builds install dev dependencies and require lifecycle approval before packing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-git-prepare-"));
  t.after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });
  const project = join(root, "project");
  await mkdir(project);
  const specifier = "git+https://github.com/example/build.git#main";
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "project", dependencies: { "git-build": specifier } }));
  const paths = createBnpmPaths({ cwd: project, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const registryConfiguration = new RegistryConfiguration({ defaultRegistry: new URL("https://registry.npmjs.org/") });
  const approvedStages: string[] = [];
  const prompts = {
    mode: { interactive: true, reason: "terminal" } as const,
    approveLifecycle: async (fact: { readonly stage: string }) => { approvedStages.push(fact.stage); return true; },
  };
  const fetchMock: typeof fetch = async () => { throw new Error("Git prepare fixture must not use the registry"); };
  const prepareGit = await createGitPreparer({ paths, registryConfiguration, fetch: fetchMock, commandOptions: { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false }, prompts });
  const provider = new RemoteSourceProvider({
    quarantineRoot: paths.quarantine,
    registryConfiguration,
    fetch: fetchMock,
    prepareGit,
    runGit: async (args, cwd) => {
      if (args[0] === "checkout") {
        const tool = join(cwd, "..", "build-tool");
        await mkdir(tool);
        await writeFile(join(tool, "package.json"), JSON.stringify({ name: "builder-tool", version: "1.0.0", bin: { "builder-tool": "cli.js" } }));
        await writeFile(join(tool, "cli.js"), "#!/usr/bin/env node\nrequire('fs').writeFileSync(require('path').join(process.cwd(),'built.js'),'built by prepare\\n')\n");
        await chmod(join(tool, "cli.js"), 0o755);
        await writeFile(join(cwd, "package.json"), JSON.stringify({
          name: "git-build",
          version: "1.0.0",
          files: ["built.js"],
          devDependencies: { "builder-tool": "file:../build-tool" },
          scripts: { prepare: "builder-tool" },
        }));
      }
      return args[0] === "rev-parse" ? "1234567890abcdef1234567890abcdef12345678" : "";
    },
  });
  await installProject({ cwd: project, paths, registryConfiguration, sourceProvider: provider, fetch: fetchMock, prompts, recentReleaseHours: 1, commandOptions: { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false } });
  assert.deepEqual(approvedStages, ["prepare"]);
  assert.equal(await readFile(join(project, "node_modules", "git-build", "built.js"), "utf8"), "built by prepare\n");
  await assert.rejects(readFile(join(project, "node_modules", "git-build", "node_modules", "builder-tool", "package.json"), "utf8"), { code: "ENOENT" });
});
