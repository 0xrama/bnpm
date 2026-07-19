import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { createBnpmPaths } from "../src/config/paths.js";
import { installProject } from "../src/installer/install.js";
import { storePath } from "../src/cache/store.js";
import { listFunding } from "../src/commands/fund.js";
import { createSbom } from "../src/commands/sbom.js";
import { invalidateInstalledLayout } from "../src/project/invalidation.js";

const root = await mkdtemp(join(tmpdir(), "bnpm-installer-"));
async function makeWritable(path: string): Promise<void> {
  try {
    await chmod(path, 0o755);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeWritable(join(path, entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
after(async () => {
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
});

async function packageTarball(): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve, reject) => { pack.once("end", resolve); pack.once("error", reject); });
  const body = '{"name":"fixture","version":"1.0.0","bin":{"fixture":"cli.js"},"funding":{"type":"individual","url":"https://fund.example/fixture"}}\n';
  await new Promise<void>((resolve, reject) => pack.entry({ name: "package/package.json", size: Buffer.byteLength(body) }, body, (error) => error ? reject(error) : resolve()));
  const cli = "#!/usr/bin/env node\nconsole.log('fixture')\n";
  await new Promise<void>((resolve, reject) => pack.entry({ name: "package/cli.js", size: Buffer.byteLength(cli), mode: 0o755 }, cli, (error) => error ? reject(error) : resolve()));
  pack.finalize();
  await finished;
  return gzipSync(Buffer.concat(chunks));
}

test("installer completes a verified scriptless registry install end to end", async () => {
  const project = join(root, "project");
  const cache = join(root, "cache");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(project, { recursive: true }));
  await writeFile(join(project, "package.json"), '{"name":"project","dependencies":{"fixture":"^1.0.0"}}\n');
  const tarball = await packageTarball();
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/fixture")) return Response.json({
      name: "fixture",
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": { name: "fixture", version: "1.0.0", bin: { fixture: "cli.js" }, dist: { integrity, tarball: "https://registry.example/fixture/-/fixture-1.0.0.tgz" } } },
      time: { "1.0.0": "2026-01-01T00:00:00.000Z" },
    });
    if (url.endsWith("fixture-1.0.0.tgz")) return new Response(new Uint8Array(tarball), { status: 200, headers: { "content-length": String(tarball.length) } });
    return new Response("not found", { status: 404 });
  };
  const paths = createBnpmPaths({ home: join(root, "home"), cwd: project, temp: join(root, "tmp"), environment: { BNPM_CACHE_HOME: cache } });
  const result = await installProject({ cwd: project, paths, registry: new URL("https://registry.example/"), fetch: fetchMock, now: new Date("2026-07-18T00:00:00Z") });
  assert.equal(result.graph.roots.get("fixture"), "fixture@1.0.0");
  assert.equal(JSON.parse(await readFile(join(project, "node_modules", "fixture", "package.json"), "utf8")).version, "1.0.0");
  const installedBin = join(project, "node_modules", ".bin", process.platform === "win32" ? "fixture.cmd" : "fixture");
  if (process.platform === "win32") assert.match(await readFile(installedBin, "utf8"), /node/i);
  else assert.equal((await stat(installedBin)).mode & 0o111, 0o111);
  assert.match(await readFile(paths.lockfile, "utf8"), /fixture@1\.0\.0/);
  assert.deepEqual(await listFunding({ cwd: project, paths }), [{ package: "fixture@1.0.0", type: "individual", url: "https://fund.example/fixture" }]);
  const cyclonedx = await createSbom({ cwd: project, paths, format: "cyclonedx" });
  assert.equal(cyclonedx.bomFormat, "CycloneDX");
  assert.equal((cyclonedx.components as Array<{ name: string }>)[0]?.name, "fixture");
  const spdx = await createSbom({ cwd: project, paths, format: "spdx" });
  assert.equal(spdx.spdxVersion, "SPDX-2.3");

  const offlineOptions = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: true, omitDev: false, saveExact: false, noSave: false } as const;
  await installProject({
    cwd: project,
    paths,
    registry: new URL("https://registry.example/"),
    fetch: async () => { throw new Error("offline install attempted network access"); },
    commandOptions: offlineOptions,
    now: new Date("2026-07-18T00:00:00Z"),
  });
  assert.equal(JSON.parse(await readFile(join(project, "node_modules", "fixture", "package.json"), "utf8")).name, "fixture");

  const edited = join(project, "node_modules", "fixture", "edited.js");
  await writeFile(edited, "changed\n");
  await invalidateInstalledLayout(project, "test-edit");
  await installProject({ cwd: project, paths, registry: new URL("https://registry.example/"), fetch: async () => { throw new Error("invalidated offline relink attempted network access"); }, commandOptions: offlineOptions, now: new Date("2026-07-18T00:00:00Z") });
  await assert.rejects(stat(edited), { code: "ENOENT" });
  await assert.rejects(stat(join(project, ".bnpm-install-invalidated")), { code: "ENOENT" });

  const extraneous = join(project, "node_modules", "extraneous");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(extraneous));
  await writeFile(join(extraneous, "package.json"), '{"name":"extraneous","version":"1.0.0"}\n');
  await installProject({
    cwd: project,
    paths,
    registry: new URL("https://registry.example/"),
    fetch: async () => { throw new Error("prune attempted network access"); },
    commandOptions: offlineOptions,
    forceRelink: true,
    now: new Date("2026-07-18T00:00:00Z"),
  });
  await assert.rejects(stat(extraneous), { code: "ENOENT" });

  const stored = storePath(paths.store, integrity);
  await chmod(stored, 0o755);
  await chmod(join(stored, "package.json"), 0o644);
  await writeFile(join(stored, "package.json"), "corrupt");
  await installProject({ cwd: project, paths, registry: new URL("https://registry.example/"), fetch: fetchMock, now: new Date("2026-07-18T00:00:00Z") });
  assert.equal(JSON.parse(await readFile(join(project, "node_modules", "fixture", "package.json"), "utf8")).version, "1.0.0");
});
