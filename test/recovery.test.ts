import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { recoverProjectLayout } from "../src/project/recovery.js";

const root = await mkdtemp(join(tmpdir(), "bnpm-recovery-"));
after(async () => rm(root, { recursive: true, force: true }));

test("recovery restores the previous layout after interruption between backup and activation", async () => {
  const project = join(root, "project"); const backup = join(project, ".bnpm-node_modules-backup-fixture"); const prepared = join(project, ".bnpm-install-fixture", "node_modules");
  await mkdir(backup, { recursive: true }); await mkdir(prepared, { recursive: true }); await writeFile(join(backup, "old"), "preserved");
  await writeFile(join(project, ".bnpm-layout-transaction.json"), JSON.stringify({ version: 1, target: join(project, "node_modules"), backup, prepared, phase: "backed-up" }));
  await recoverProjectLayout(project);
  assert.equal(await readFile(join(project, "node_modules", "old"), "utf8"), "preserved");
});
