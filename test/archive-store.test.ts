import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { ArchiveError, extractPackageArchive } from "../src/cache/archive.js";
import { promoteToStore, storePath, verifyStoreEntry } from "../src/cache/store.js";
import { downloadToQuarantine } from "../src/cache/quarantine.js";

const root = await mkdtemp(join(tmpdir(), "bnpm-archive-store-"));
async function makeWritable(path: string): Promise<void> {
  try {
    await chmod(path, 0o755);
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await makeWritable(join(path, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
after(async () => { await makeWritable(root); await rm(root, { recursive: true, force: true }); });

async function archive(entries: readonly { name: string; body: string; mode?: number }[]): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve, reject) => {
    pack.once("end", resolve);
    pack.once("error", reject);
  });
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: entry.name, size: Buffer.byteLength(entry.body), mode: entry.mode ?? 0o644 }, entry.body, (error) => error ? reject(error) : resolve());
    });
  }
  pack.finalize();
  await finished;
  return gzipSync(Buffer.concat(chunks));
}

async function typedArchive(entries: readonly { name: string; body?: string; type?: "file" | "symlink"; linkname?: string }[]): Promise<Buffer> {
  const pack = tar.pack(); const chunks: Buffer[] = []; pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve, reject) => { pack.once("end", resolve); pack.once("error", reject); });
  for (const entry of entries) {
    const body = entry.body ?? "";
    await new Promise<void>((resolve, reject) => pack.entry({ name: entry.name, type: entry.type ?? "file", size: entry.type === "symlink" ? 0 : Buffer.byteLength(body), ...(entry.linkname ? { linkname: entry.linkname } : {}) }, body, (error) => error ? reject(error) : resolve()));
  }
  pack.finalize(); await finished; return gzipSync(Buffer.concat(chunks));
}

test("verified archives extract safely and promote to an immutable content store", async () => {
  const tarball = await archive([
    { name: "package/package.json", body: '{"name":"fixture","version":"1.0.0"}\n' },
    { name: "package/bin.js", body: "#!/usr/bin/env node\n", mode: 0o755 },
  ]);
  const tarballPath = join(root, "valid.tgz");
  await writeFile(tarballPath, tarball);
  const extracted = await extractPackageArchive(tarballPath, join(root, "extracted"));
  assert.equal(await readFile(join(extracted.path, "bin.js"), "utf8"), "#!/usr/bin/env node\n");
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const promoted = await promoteToStore(extracted.path, join(root, "store"), integrity);
  assert.equal(promoted, storePath(join(root, "store"), integrity));
  assert.equal((await stat(join(promoted, "package.json"))).mode & 0o222, 0);
  assert.equal(await verifyStoreEntry(promoted, integrity), true);
  await chmod(promoted, 0o755);
});

test("concurrent store promotion converges and a corrupt entry is repaired", async () => {
  const source = join(root, "concurrent-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "package.json"), '{"name":"concurrent","version":"1.0.0"}');
  const integrity = `sha512-${createHash("sha512").update("concurrent fixture").digest("base64")}`;
  const storeRoot = join(root, "concurrent-store");
  const promoted = await Promise.all(Array.from({ length: 8 }, () => promoteToStore(source, storeRoot, integrity)));
  assert.equal(new Set(promoted).size, 1);
  assert.equal(await verifyStoreEntry(promoted[0] ?? "", integrity), true);
  await chmod(promoted[0] ?? "", 0o755);
  await chmod(join(promoted[0] ?? "", "package.json"), 0o644);
  await writeFile(join(promoted[0] ?? "", "package.json"), "corrupt");
  assert.equal(await verifyStoreEntry(promoted[0] ?? "", integrity), false);
  const repaired = await promoteToStore(source, storeRoot, integrity);
  assert.equal(await verifyStoreEntry(repaired, integrity), true);
  await chmod(repaired, 0o755);
});

test("archive extraction rejects traversal and removes partial output", async () => {
  const tarballPath = join(root, "traversal.tgz");
  await writeFile(tarballPath, await archive([
    { name: "package/package.json", body: "{}" },
    { name: "package/../../escaped", body: "bad" },
  ]));
  const destination = join(root, "bad-extract");
  await assert.rejects(() => extractPackageArchive(tarballPath, destination), ArchiveError);
  await assert.rejects(stat(destination));
  await assert.rejects(stat(join(root, "escaped")));
});

test("quarantine rejects redirects that downgrade tarball transport", async () => {
  const integrity = `sha512-${createHash("sha512").update("unused").digest("base64")}`;
  await assert.rejects(
    () => downloadToQuarantine(new URL("https://registry.example/package.tgz"), integrity, {
      root: join(root, "redirect-quarantine"),
      fetch: async () => new Response(null, { status: 302, headers: { location: "http://insecure.example/package.tgz" } }),
    }),
    /HTTPS/,
  );
});

test("quarantine recalculates authorization after every redirect", async () => {
  const body = Buffer.from("authenticated archive fixture");
  const integrity = `sha512-${createHash("sha512").update(body).digest("base64")}`;
  const requests: { readonly url: string; readonly authorization: string | null }[] = [];
  await downloadToQuarantine(new URL("https://private.example/package.tgz"), integrity, {
    root: join(root, "redirect-auth-quarantine"),
    headers: (url) => url.hostname === "private.example" ? { authorization: "Bearer private-secret" } : {},
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return url.includes("private.example")
        ? new Response(null, { status: 302, headers: { location: "https://cdn.example/package.tgz" } })
        : new Response(new Uint8Array(body));
    },
  });
  assert.deepEqual(requests, [
    { url: "https://private.example/package.tgz", authorization: "Bearer private-secret" },
    { url: "https://cdn.example/package.tgz", authorization: null },
  ]);
});

test("archive corpus rejects absolute, backslash, non-package, link, duplicate, and ratio attacks", async () => {
  const attacks = [
    [{ name: "package/package.json", body: "{}" }, { name: "/absolute", body: "bad" }],
    [{ name: "package/package.json", body: "{}" }, { name: "package\\escape", body: "bad" }],
    [{ name: "package/package.json", body: "{}" }, { name: "outside/file", body: "bad" }],
    [{ name: "package/package.json", body: "{}" }, { name: "package/link", type: "symlink" as const, linkname: "../outside" }],
    [{ name: "package/package.json", body: "{}" }, { name: "package/duplicate", body: "one" }, { name: "package/duplicate", body: "two" }],
  ];
  let index = 0;
  for (const entries of attacks) {
    const tarball = join(root, `attack-${index}.tgz`); await writeFile(tarball, await typedArchive(entries));
    await assert.rejects(() => extractPackageArchive(tarball, join(root, `attack-${index++}`)), ArchiveError);
  }
  const bomb = join(root, "ratio-bomb.tgz");
  await writeFile(bomb, await typedArchive([{ name: "package/package.json", body: "{}" }, { name: "package/bomb", body: "A".repeat(100_000) }]));
  await assert.rejects(() => extractPackageArchive(bomb, join(root, "ratio-bomb"), { maxCompressionRatio: 2 }), /compression-ratio/);
});

test("archive extraction accepts only byte-identical duplicate files", async () => {
  const tarballPath = join(root, "identical-duplicate.tgz");
  await writeFile(tarballPath, await archive([
    { name: "package/package.json", body: '{"name":"duplicate","version":"1.0.0"}' },
    { name: "package/generated.js", body: "export default 1;\n" },
    { name: "package/generated.js", body: "export default 1;\n" },
  ]));
  const extracted = await extractPackageArchive(tarballPath, join(root, "identical-duplicate"));
  assert.equal(await readFile(join(extracted.path, "generated.js"), "utf8"), "export default 1;\n");
});

test("archive extraction strips one consistent legacy package prefix", async () => {
  const tarballPath = join(root, "legacy-prefix.tgz");
  await writeFile(tarballPath, await archive([
    { name: "legacy-package/package.json", body: '{"name":"legacy-package","version":"1.0.0"}' },
    { name: "legacy-package/index.js", body: "module.exports = true;\n" },
  ]));
  const extracted = await extractPackageArchive(tarballPath, join(root, "legacy-prefix"));
  assert.equal(await readFile(join(extracted.path, "index.js"), "utf8"), "module.exports = true;\n");
});
