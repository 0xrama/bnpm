import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanCache, cleanCacheEntries, ensureCacheOwnership, listCache, verifyCache } from "../src/cache/commands.js";
import { hashLocalPackage, promoteToStore, storePath } from "../src/cache/store.js";
import { createBnpmPaths } from "../src/config/paths.js";

async function writable(path: string): Promise<void> {
  try {
    await chmod(path, 0o755);
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(path, entry.name)); else await chmod(join(path, entry.name), 0o644);
  } catch {}
}

test("cache verify reports corruption and clean is confined to resolved cache roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-cache-command-"));
  t.after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "package.json"), '{"name":"cached","version":"1.0.0"}\n');
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root, BNPM_CACHE_HOME: join(root, "cache-root") } });
  await ensureCacheOwnership(paths);
  const integrity = await hashLocalPackage(source);
  await promoteToStore(source, paths.store, integrity, { localPackage: true });
  assert.deepEqual(await verifyCache(paths), { entries: 1, valid: 1, corrupt: [] });
  assert.deepEqual(await listCache(paths, "cached@1.0.0"), [{ id: "cached@1.0.0", integrity }]);
  assert.deepEqual(await cleanCacheEntries(paths, "other"), []);
  const stored = storePath(paths.store, integrity);
  await chmod(stored, 0o755);
  await chmod(join(stored, "package.json"), 0o644);
  await writeFile(join(stored, "package.json"), "corrupt");
  const verification = await verifyCache(paths);
  assert.equal(verification.entries, 1);
  assert.equal(verification.valid, 0);
  assert.deepEqual(verification.corrupt, [stored]);
  assert.deepEqual(await cleanCache(paths), [paths.store]);
  assert.deepEqual(await readdir(paths.store), []);
  await assert.rejects(() => cleanCache({ ...paths, store: root }), /unsafe cache path/);
  assert.equal(await readFile(join(source, "package.json"), "utf8"), '{"name":"cached","version":"1.0.0"}\n');
});

test("cache clean removes only matching immutable store entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-cache-targeted-"));
  t.after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root, BNPM_CACHE_HOME: join(root, "cache-root") } });
  await ensureCacheOwnership(paths);
  for (const [name, version] of [["cached", "1.0.0"], ["cached", "2.0.0"], ["kept", "1.0.0"]] as const) {
    const source = join(root, `${name}-${version}`); await mkdir(source); await writeFile(join(source, "package.json"), JSON.stringify({ name, version }));
    const integrity = await hashLocalPackage(source); await promoteToStore(source, paths.store, integrity, { localPackage: true });
  }
  assert.equal((await cleanCacheEntries(paths, "cached@1.0.0")).length, 1);
  assert.deepEqual((await listCache(paths)).map((entry) => entry.id), ["cached@2.0.0", "kept@1.0.0"]);
  assert.equal((await cleanCacheEntries(paths, "cached")).length, 1);
  assert.deepEqual((await listCache(paths)).map((entry) => entry.id), ["kept@1.0.0"]);
});
