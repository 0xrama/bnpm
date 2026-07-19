import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import type { CommandOptions } from "../src/core/cli-parser.js";
import { createBnpmPaths } from "../src/config/paths.js";
import { addDependencies, removeDependencies } from "../src/installer/mutations.js";

const root = await mkdtemp(join(tmpdir(), "bnpm-mutations-"));
const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cli = join(repositoryRoot, "dist", "src", "cli.js");
async function writable(path: string): Promise<void> { try { await chmod(path, 0o755); for (const item of await readdir(path, { withFileTypes: true })) if (item.isDirectory()) await writable(join(path, item.name)); } catch {} }
after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });

const options: CommandOptions = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveSection: "dev", saveExact: false, noSave: false };

async function tgz(): Promise<Buffer> {
  const pack = tar.pack(); const chunks: Buffer[] = []; pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<void>((resolve, reject) => { pack.once("end", resolve); pack.once("error", reject); });
  const body = '{"name":"added","version":"1.0.0"}';
  await new Promise<void>((resolve, reject) => pack.entry({ name: "package/package.json", size: body.length }, body, (error) => error ? reject(error) : resolve()));
  pack.finalize(); await done; return gzipSync(Buffer.concat(chunks));
}

function execute(cwd: string, args: readonly string[], cache: string): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, BNPM_CACHE_HOME: cache, CI: "1" }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

test("add and remove update the manifest only after a successful install", async () => {
  const project = join(root, "project"); await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), '{\n  "name": "project"\n}\n');
  const archive = await tgz(); const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const fetchMock: typeof fetch = async (input) => String(input).endsWith("added-1.0.0.tgz")
    ? new Response(new Uint8Array(archive))
    : Response.json({ name: "added", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "added", version: "1.0.0", dist: { integrity, tarball: "https://registry.example/added-1.0.0.tgz" } } }, time: { "1.0.0": "2020-01-01T00:00:00Z" } });
  const paths = createBnpmPaths({ home: join(root, "home"), cwd: project, environment: { BNPM_CACHE_HOME: join(root, "cache") } });
  const common = { paths, registry: new URL("https://registry.example/"), fetch: fetchMock, now: new Date("2026-07-18T00:00:00Z") };
  await addDependencies(project, ["added@^1.0.0"], options, common);
  assert.equal(JSON.parse(await readFile(join(project, "package.json"), "utf8")).devDependencies.added, "^1.0.0");
  await removeDependencies(project, ["added"], options, common);
  assert.equal(JSON.parse(await readFile(join(project, "package.json"), "utf8")).devDependencies.added, undefined);
});

test("install specs save by default and ci recreates the locked layout", async () => {
  const project = join(root, "install-save-project");
  const local = join(project, "local");
  const cache = join(root, "install-save-cache");
  await mkdir(local, { recursive: true });
  await writeFile(join(project, "package.json"), '{\n  "name": "install-save-project",\n  "version": "1.0.0"\n}\n');
  await writeFile(join(local, "package.json"), '{\n  "name": "added",\n  "version": "1.0.0",\n  "main": "index.js"\n}\n');
  await writeFile(join(local, "index.js"), "module.exports = 42;\n");

  const installed = await execute(project, ["install", "added@file:./local"], cache);
  assert.equal(installed.code, 0, installed.stderr);
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8")) as { readonly dependencies?: Readonly<Record<string, string>> };
  assert.equal(manifest.dependencies?.added, "file:./local");
  assert.equal(JSON.parse(await readFile(join(project, "node_modules", "added", "package.json"), "utf8")).version, "1.0.0");

  await rm(join(project, "node_modules"), { recursive: true, force: true });
  const cleanInstalled = await execute(project, ["ci"], cache);
  assert.equal(cleanInstalled.code, 0, cleanInstalled.stderr);
  assert.equal(JSON.parse(await readFile(join(project, "node_modules", "added", "package.json"), "utf8")).name, "added");
});
