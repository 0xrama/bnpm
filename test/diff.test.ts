import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { comparePackageTrees, diffPackage, renderPackageDiff } from "../src/commands/diff.js";
import { createBnpmPaths } from "../src/config/paths.js";
import { packPackage } from "../src/package/pack.js";

test("package diff reports added, removed, and content-changed files deterministically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-diff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, "local"); const remote = join(root, "remote");
  await mkdir(join(local, "nested"), { recursive: true }); await mkdir(join(remote, "nested"), { recursive: true });
  await writeFile(join(local, "added.js"), "added");
  await writeFile(join(remote, "removed.js"), "removed");
  await writeFile(join(local, "nested", "changed.js"), "new");
  await writeFile(join(remote, "nested", "changed.js"), "old");
  await writeFile(join(local, "same.js"), "same"); await writeFile(join(remote, "same.js"), "same");
  assert.deepEqual(await comparePackageTrees(local, remote), { added: ["added.js"], removed: ["removed.js"], changed: ["nested/changed.js"] });
  const difference = await comparePackageTrees(local, remote);
  const patch = await renderPackageDiff(remote, local, difference, { unified: 0 });
  assert.match(patch, /diff --git a\/added\.js b\/added\.js/);
  assert.match(patch, /--- \/dev\/null\n\+\+\+ b\/added\.js/);
  assert.match(patch, /-old\n\+new/);
  assert.equal(await renderPackageDiff(remote, local, difference, { nameOnly: true, paths: ["nested/**"] }), "nested/changed.js");
  await writeFile(join(local, "space.js"), "const value = 1;\n"); await writeFile(join(remote, "space.js"), "const   value=1;\n");
  const whitespace = await comparePackageTrees(local, remote);
  assert.doesNotMatch(await renderPackageDiff(remote, local, whitespace, { ignoreAllSpace: true, paths: ["space.js"] }), /space\.js/);
});

test("package diff compares two exact registry specifications and renders name-only output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-diff-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, "local"); const one = join(root, "one"); const two = join(root, "two");
  for (const [directory, version, value] of [[local, "0.0.0", "local"], [one, "1.0.0", "one"], [two, "2.0.0", "two"]] as const) {
    await mkdir(directory); await writeFile(join(directory, "package.json"), JSON.stringify({ name: "pkg", version })); await writeFile(join(directory, "index.js"), `${value}\n`);
  }
  const first = await packPackage(one); const second = await packPackage(two);
  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/pkg")) return Response.json({ name: "pkg", "dist-tags": { latest: "2.0.0" }, versions: {
      "1.0.0": { name: "pkg", version: "1.0.0", dist: { integrity: first.integrity, tarball: "https://registry.example/pkg/-/pkg-1.0.0.tgz" } },
      "2.0.0": { name: "pkg", version: "2.0.0", dist: { integrity: second.integrity, tarball: "https://registry.example/pkg/-/pkg-2.0.0.tgz" } },
    } });
    if (url.endsWith("pkg-1.0.0.tgz")) return new Response(new Uint8Array(first.tarball), { headers: { "content-length": String(first.tarball.length) } });
    if (url.endsWith("pkg-2.0.0.tgz")) return new Response(new Uint8Array(second.tarball), { headers: { "content-length": String(second.tarball.length) } });
    return new Response("missing", { status: 404 });
  };
  const paths = createBnpmPaths({ cwd: local, home: root, temp: root, environment: { HOME: root, BNPM_CACHE_HOME: join(root, "cache") } });
  const result = await diffPackage({ cwd: local, paths, registry: new URL("https://registry.example/"), fetch: fetchMock, specs: ["pkg@1.0.0", "pkg@2.0.0"], render: { nameOnly: true } });
  assert.equal(result.local, "pkg@1.0.0"); assert.equal(result.remote, "pkg@2.0.0");
  assert.deepEqual(result.changed, ["index.js", "package.json"]);
  assert.equal(result.text, "index.js\npackage.json");
});

test("package diff compares canonical local-directory specifications", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-diff-directories-")); t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "current"); const one = join(root, "one"); const two = join(root, "two");
  for (const [directory, version, source] of [[current, "0.0.0", "current"], [one, "1.0.0", "first"], [two, "2.0.0", "second"]] as const) { await mkdir(directory); await writeFile(join(directory, "package.json"), JSON.stringify({ name: "local-pkg", version })); await writeFile(join(directory, "index.js"), `${source}\n`); }
  const paths = createBnpmPaths({ cwd: current, home: root, temp: root, environment: { HOME: root, BNPM_CACHE_HOME: join(root, "cache") } });
  const result = await diffPackage({ cwd: current, paths, specs: ["../one", "../two"], render: { nameOnly: true } });
  assert.equal(result.local, "local-pkg@1.0.0"); assert.equal(result.remote, "local-pkg@2.0.0"); assert.equal(result.text, "index.js\npackage.json");
});
