import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { createBnpmPaths } from "../src/config/paths.js";
import { installProject } from "../src/installer/install.js";
import { loadRegistryConfiguration, parseNpmrc } from "../src/registry/configuration.js";
import { auditProject } from "../src/security/audit.js";

const root = await mkdtemp(join(tmpdir(), "bnpm-registry-configuration-"));
async function writable(path: string): Promise<void> { try { await chmod(path, 0o755); for (const item of await readdir(path, { withFileTypes: true })) if (item.isDirectory()) await writable(join(path, item.name)); } catch {} }
after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });

async function archive(name: string, version: string): Promise<Buffer> {
  const pack = tar.pack(); const chunks: Buffer[] = []; pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<void>((resolve, reject) => { pack.once("end", resolve); pack.once("error", reject); });
  const body = JSON.stringify({ name, version });
  await new Promise<void>((resolve, reject) => pack.entry({ name: "package/package.json", size: Buffer.byteLength(body) }, body, (error) => error ? reject(error) : resolve()));
  pack.finalize(); await done; return gzipSync(Buffer.concat(chunks));
}

test("npmrc loading composes scoped registries and path-scoped environment credentials", async () => {
  const userNpmrc = join(root, "config-user.npmrc");
  const projectNpmrc = join(root, "config-project.npmrc");
  await writeFile(userNpmrc, "registry=https://registry.example/base/\n//registry.example/base/:_authToken=${USER_TOKEN}\n");
  await writeFile(projectNpmrc, "@private:registry=https://private.example/npm/\n//private.example/npm/:_authToken=${PRIVATE_TOKEN}\n");
  const configuration = await loadRegistryConfiguration({ userNpmrc, projectNpmrc, environment: { USER_TOKEN: "user-secret", PRIVATE_TOKEN: "private-secret" } });
  assert.equal(configuration.registryForPackage("public-package").href, "https://registry.example/base/");
  assert.equal(configuration.registryForPackage("@private/package").href, "https://private.example/npm/");
  assert.deepEqual(configuration.headersFor(new URL("https://registry.example/base/package")), { authorization: "Bearer user-secret" });
  assert.deepEqual(configuration.headersFor(new URL("https://registry.example/other/package")), {});
  assert.deepEqual(configuration.headersFor(new URL("https://private.example/npm/package.tgz")), { authorization: "Bearer private-secret" });
  assert.deepEqual(configuration.headersFor(new URL("https://redirected.example/npm/package.tgz")), {});
  await assert.rejects(() => loadRegistryConfiguration({ userNpmrc, projectNpmrc, environment: {} }), /USER_TOKEN/);
});

test("scoped private metadata and tarballs authenticate without persisting credentials", async () => {
  const project = join(root, "private-project");
  const home = join(root, "private-home");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), '{"name":"private-project","dependencies":{"@private/pkg":"1.0.0"}}');
  await writeFile(join(project, ".npmrc"), [
    "registry=https://public.example/",
    "@private:registry=https://private.example/npm/",
    "//private.example/npm/:_authToken=metadata-secret",
    "//private.example/tarballs/:_authToken=tarball-secret",
    "",
  ].join("\n"));
  const tgz = await archive("@private/pkg", "1.0.0");
  const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
  const requests: { readonly url: string; readonly authorization: string | null }[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ url, authorization });
    if (url === "https://private.example/npm/%40private%2Fpkg") {
      assert.equal(authorization, "Bearer metadata-secret");
      return Response.json({ name: "@private/pkg", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "@private/pkg", version: "1.0.0", dist: { integrity, tarball: "https://private.example/tarballs/pkg-1.0.0.tgz" } } }, time: { "1.0.0": "2020-01-01T00:00:00.000Z" } });
    }
    if (url === "https://private.example/tarballs/pkg-1.0.0.tgz") {
      assert.equal(authorization, "Bearer tarball-secret");
      return new Response(new Uint8Array(tgz));
    }
    if (url === "https://private.example/npm/-/npm/v1/security/advisories/bulk") {
      assert.equal(init?.method, "POST");
      assert.equal(authorization, "Bearer metadata-secret");
      return Response.json({});
    }
    throw new Error(`unexpected request ${url}`);
  };
  const paths = createBnpmPaths({ home, cwd: project, environment: { BNPM_CACHE_HOME: join(root, "private-cache") } });
  await installProject({ cwd: project, paths, fetch: fetchMock, now: new Date("2026-07-18T00:00:00.000Z") });
  assert.equal(JSON.parse(await readFile(join(project, "node_modules", "@private", "pkg", "package.json"), "utf8")).version, "1.0.0");
  const lockfile = await readFile(join(project, "bnpm-lock.yaml"), "utf8");
  assert.doesNotMatch(lockfile, /metadata-secret|tarball-secret|authorization/i);
  assert.equal(requests.length, 2);
  const audited = await auditProject({ paths, fetch: fetchMock, now: new Date("2026-07-18T00:00:00.000Z") });
  assert.deepEqual(audited.advisories, []);
  assert.equal(requests.length, 3);
});

test("registry configuration rejects insecure registries and missing token variables", async () => {
  const insecure = join(root, "insecure.npmrc");
  const empty = join(root, "empty.npmrc");
  await writeFile(insecure, "registry=http://registry.example/\n");
  await writeFile(empty, "");
  await assert.rejects(() => loadRegistryConfiguration({ userNpmrc: insecure, projectNpmrc: empty }), /HTTPS/);
  assert.throws(() => parseNpmrc("//registry.example/:_authToken=${MISSING}", "missing", {}), /MISSING/);
});
