import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageProperties } from "../src/project/pkg.js";

test("pkg reads and transactionally updates safe nested package properties", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-pkg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "old" } }, null, 2));
  assert.equal(await packageProperties({ directory: root, action: "get", operands: ["scripts.test"] }), "old");
  await packageProperties({ directory: root, action: "set", operands: ["scripts.test=node --test", "repository.type=git"] });
  assert.deepEqual(await packageProperties({ directory: root, action: "get", operands: ["scripts.test", "repository.type"] }), { "scripts.test": "node --test", "repository.type": "git" });
  await packageProperties({ directory: root, action: "delete", operands: ["scripts.test"] });
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.scripts.test, undefined);
  assert.equal(manifest.repository.type, "git");
  await assert.rejects(() => packageProperties({ directory: root, action: "set", operands: ["__proto__.polluted=yes"] }), /invalid package property path/);
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
});
