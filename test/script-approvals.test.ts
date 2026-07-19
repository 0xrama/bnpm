import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { inspectScriptApprovals, mutateApprovalDocument, pruneScriptApprovals } from "../src/commands/script-approvals.js";
import { createBnpmPaths } from "../src/config/paths.js";

const lock = YAML.stringify({
  lockfileVersion: 1,
  settings: { registry: "https://registry.example/", recentReleaseHours: 1 },
  importers: { ".": { dependencies: {} } },
  packages: {
    "native@1.0.0": {
      resolution: { integrity: "sha512-exact", tarball: "https://registry.example/native.tgz" },
      scripts: { install: { command: "node-gyp rebuild", commandHash: "command-hash", contentHash: "content-hash" } },
    },
  },
}, { sortMapEntries: true });

test("script approvals bind exact locked hashes and can be explicitly removed", () => {
  const approved = mutateApprovalDocument(lock, new Set(["native@1.0.0"]), "approve");
  const parsed = YAML.parse(approved) as { approvals: Record<string, { integrity: string; scripts: Record<string, Record<string, unknown>> }> };
  assert.deepEqual(parsed.approvals["native@1.0.0"], { integrity: "sha512-exact", scripts: { install: { approved: true, commandHash: "command-hash", contentHash: "content-hash" } } });
  const denied = YAML.parse(mutateApprovalDocument(approved, new Set(["native@1.0.0"]), "deny")) as { approvals?: unknown };
  assert.equal(denied.approvals, undefined);
  assert.throws(() => mutateApprovalDocument(lock, new Set(["missing@1.0.0"]), "approve"), /package missing/);
});

test("install-scripts lists pending approvals and prunes stale exact facts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-script-approvals-")); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, environment: { HOME: root, BNPM_CACHE_HOME: join(root, "cache") } });
  const document = YAML.parse(lock) as Record<string, unknown>;
  document.approvals = { "missing@1.0.0": { integrity: "sha512-old", scripts: {} } };
  await writeFile(paths.lockfile, YAML.stringify(document));
  assert.deepEqual(await inspectScriptApprovals({ cwd: root, paths }), { pending: ["native@1.0.0"], approved: [], stale: ["missing@1.0.0"] });
  assert.deepEqual(await pruneScriptApprovals({ cwd: root, paths, dryRun: true }), ["missing@1.0.0"]);
  assert.match(await readFile(paths.lockfile, "utf8"), /missing@1\.0\.0/);
  assert.deepEqual(await pruneScriptApprovals({ cwd: root, paths }), ["missing@1.0.0"]);
  assert.doesNotMatch(await readFile(paths.lockfile, "utf8"), /missing@1\.0\.0/);
});
