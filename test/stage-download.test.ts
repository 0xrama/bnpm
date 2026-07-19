import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBnpmPaths } from "../src/config/paths.js";
import { downloadStage } from "../src/commands/stage.js";
import { packPackage } from "../src/package/pack.js";

const stageId = "123e4567-e89b-42d3-a456-426614174000";

test("staged downloads are authenticated, quarantined, validated, and written exclusively", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-stage-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "source");
  const destination = join(root, "destination");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(destination);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@scope/pkg", version: "1.2.3" }));
  await writeFile(join(packageRoot, "index.js"), "export default 42;\n");
  const artifact = await packPackage(packageRoot);
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=stage-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const request: typeof fetch = async (input, init) => {
    assert.equal(String(input), `https://registry.example/-/stage/${stageId}/tarball`);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer stage-token");
    return new Response(new Uint8Array(artifact.tarball), { headers: { "content-length": String(artifact.tarball.length) } });
  };
  const downloaded = await downloadStage({ id: stageId, cwd: destination, paths, registry: new URL("https://registry.example/"), fetch: request });
  assert.equal(downloaded.package, "@scope/pkg");
  assert.equal(downloaded.version, "1.2.3");
  assert.equal(downloaded.filename, `scope-pkg-1.2.3-${stageId}.tgz`);
  assert.match(downloaded.integrity, /^sha512-/);
  assert.deepEqual(await readFile(downloaded.path), artifact.tarball);
  await assert.rejects(() => downloadStage({ id: stageId, cwd: destination, paths, registry: new URL("https://registry.example/"), fetch: request }), /refusing to replace/);
});

test("staged downloads reject cross-origin redirects before following them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-stage-redirect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=stage-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  let calls = 0;
  const request: typeof fetch = async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "https://evil.example/package.tgz" } });
  };
  await assert.rejects(() => downloadStage({ id: stageId, cwd: root, paths, registry: new URL("https://registry.example/"), fetch: request }), /redirect must remain on the HTTPS registry origin/);
  assert.equal(calls, 1);
});
