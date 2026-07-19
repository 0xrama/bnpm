import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { findOutdatedDependencies } from "../src/commands/outdated.js";
import { createBnpmPaths } from "../src/config/paths.js";
import type { CommandOptions } from "../src/core/cli-parser.js";
import { installProject } from "../src/installer/install.js";
import { updateDependencies } from "../src/installer/mutations.js";

const root = await mkdtemp(join(tmpdir(), "bnpm-outdated-update-"));
async function writable(path: string): Promise<void> { try { await chmod(path, 0o755); for (const item of await readdir(path, { withFileTypes: true })) if (item.isDirectory()) await writable(join(path, item.name)); } catch {} }
after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });

const commandOptions: CommandOptions = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false };

async function packageArchive(name: string, version: string): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<void>((resolve, reject) => { pack.once("end", resolve); pack.once("error", reject); });
  const manifest = JSON.stringify({ name, version });
  await new Promise<void>((resolve, reject) => pack.entry({ name: "package/package.json", size: Buffer.byteLength(manifest) }, manifest, (error) => error ? reject(error) : resolve()));
  pack.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}

test("outdated reports current, wanted, and latest versions without mutation", async () => {
  const project = join(root, "outdated-project");
  await mkdir(join(project, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(project, "node_modules", "alias"), { recursive: true });
  const manifest = '{\n  "name": "outdated-project",\n  "dependencies": {\n    "pkg": "^1.0.0",\n    "alias": "npm:real@^1.0.0"\n  }\n}\n';
  await writeFile(join(project, "package.json"), manifest);
  await writeFile(join(project, "node_modules", "pkg", "package.json"), '{"name":"pkg","version":"1.0.0"}');
  await writeFile(join(project, "node_modules", "alias", "package.json"), '{"name":"real","version":"1.0.0"}');
  const fetchMock: typeof fetch = async (input) => {
    const name = decodeURIComponent(new URL(String(input)).pathname.slice(1));
    const actual = name === "real" ? "real" : "pkg";
    return Response.json({
      name: actual,
      "dist-tags": { latest: "2.0.0" },
      versions: {
        "1.0.0": { name: actual, version: "1.0.0", dist: { integrity: "sha512-unused", tarball: `https://registry.example/${actual}-1.0.0.tgz` } },
        "1.2.0": { name: actual, version: "1.2.0", dist: { integrity: "sha512-unused", tarball: `https://registry.example/${actual}-1.2.0.tgz` } },
        "2.0.0": { name: actual, version: "2.0.0", dist: { integrity: "sha512-unused", tarball: `https://registry.example/${actual}-2.0.0.tgz` } },
      },
    });
  };
  const entries = await findOutdatedDependencies({ cwd: project, registry: new URL("https://registry.example/"), fetch: fetchMock });
  assert.deepEqual(entries.map(({ name, current, wanted, latest }) => ({ name, current, wanted, latest })), [
    { name: "alias", current: "1.0.0", wanted: "1.2.0", latest: "2.0.0" },
    { name: "pkg", current: "1.0.0", wanted: "1.2.0", latest: "2.0.0" },
  ]);
  assert.equal(await readFile(join(project, "package.json"), "utf8"), manifest);
  await assert.rejects(() => findOutdatedDependencies({ cwd: project, names: ["absent"], registry: new URL("https://registry.example/"), fetch: fetchMock }), /not declared/);
});

test("update refreshes selected ranges while pinning unselected direct dependencies", async () => {
  const project = join(root, "update-project");
  await mkdir(project, { recursive: true });
  const manifest = '{\n  "name": "update-project",\n  "dependencies": {\n    "pkg": "^1.0.0",\n    "stable": "^1.0.0"\n  }\n}\n';
  await writeFile(join(project, "package.json"), manifest);
  const archives = new Map<string, Buffer>();
  for (const name of ["pkg", "stable"]) for (const version of ["1.0.0", "1.1.0", "1.2.0"]) archives.set(`${name}@${version}`, await packageArchive(name, version));
  let newer = false;
  const fetchMock: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const tarball = /\/(pkg|stable)-(1\.0\.0|1\.1\.0|1\.2\.0)\.tgz$/.exec(url.pathname);
    if (tarball) {
      const archive = archives.get(`${tarball[1]}@${tarball[2]}`);
      if (!archive) throw new Error("missing archive fixture");
      return new Response(new Uint8Array(archive));
    }
    const name = decodeURIComponent(url.pathname.slice(1));
    const versions = newer ? ["1.0.0", "1.1.0", "1.2.0"] : ["1.0.0"];
    return Response.json({
      name,
      "dist-tags": { latest: versions.at(-1) },
      versions: Object.fromEntries(versions.map((version) => {
        const archive = archives.get(`${name}@${version}`) ?? Buffer.alloc(0);
        return [version, { name, version, dist: { integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`, tarball: `https://registry.example/${name}-${version}.tgz` } }];
      })),
      time: Object.fromEntries(versions.map((version) => [version, version === "1.2.0" ? "2026-07-17T23:30:00.000Z" : "2020-01-01T00:00:00.000Z"])),
    });
  };
  const paths = createBnpmPaths({ home: join(root, "update-home"), cwd: project, environment: { BNPM_CACHE_HOME: join(root, "update-cache") } });
  const common = { paths, registry: new URL("https://registry.example/"), fetch: fetchMock, now: new Date("2026-07-18T00:00:00.000Z") };
  await installProject({ cwd: project, commandOptions, ...common });
  assert.equal(JSON.parse(await readFile(join(project, "node_modules", "pkg", "package.json"), "utf8")).version, "1.0.0");
  newer = true;
  await updateDependencies(project, ["pkg"], commandOptions, common);
  // The newest matching release is only 30 minutes old, so update selects the newest mature version instead of aborting.
  assert.equal(JSON.parse(await readFile(join(project, "node_modules", "pkg", "package.json"), "utf8")).version, "1.1.0");
  assert.equal(JSON.parse(await readFile(join(project, "node_modules", "stable", "package.json"), "utf8")).version, "1.0.0");
  assert.equal(await readFile(join(project, "package.json"), "utf8"), manifest);
});
