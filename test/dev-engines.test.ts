import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDevEngines, DevEnginesError } from "../src/project/dev-engines.js";

test("devEngines validates root toolchain requirements with error, warn, and alternatives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-dev-engines-")); t.after(() => rm(root, { recursive: true, force: true })); await mkdir(join(root, "project"));
  const path = join(root, "project", "package.json");
  await writeFile(path, JSON.stringify({ name: "project", version: "1.0.0", devEngines: { runtime: { name: "node", version: ">=22" }, packageManager: [{ name: "npm", onFail: "warn" }, { name: "pnpm", onFail: "ignore" }], os: { name: "linux" }, libc: { name: "glibc" } } }));
  assert.deepEqual(await checkDevEngines(join(root, "project"), { platform: "linux", libc: "glibc", nodeVersion: "22.22.2", packageManagerVersion: "1.0.0" }), ["packageManager requires npm or pnpm, current bnpm@1.0.0"]);
  await assert.rejects(() => checkDevEngines(join(root, "project"), { platform: "darwin", libc: "glibc", nodeVersion: "22.22.2" }), DevEnginesError);
  await writeFile(path, JSON.stringify({ name: "project", version: "1.0.0", devEngines: { runtime: { name: "node", version: "not-semver" } } }));
  await assert.rejects(() => checkDevEngines(join(root, "project")), /semantic version range/);
});
