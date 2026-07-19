import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { createBnpmPaths } from "../src/config/paths.js";
import { editInstalledPackage, parseEditor } from "../src/commands/edit.js";

test("edit opens the project-local package instance without a shell", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-edit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "node_modules", ".bnpm", "pkg@1.0.0", "node_modules", "pkg");
  const logical = join(root, "node_modules", "pkg");
  await mkdir(target, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "root", version: "1.0.0" }));
  await writeFile(join(target, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
  await symlink(process.platform === "win32" ? target : relative(join(root, "node_modules"), target), logical, process.platform === "win32" ? "junction" : "dir");
  const signal = new AbortController().signal;
  const result = await editInstalledPackage({ cwd: root, name: "pkg", signal, editor: [process.execPath, "-e", "require('node:fs').writeFileSync(require('node:path').join(process.argv[1], 'edited.txt'), 'ok')"] });
  assert.equal(result.path, await realpath(target));
  assert.equal(await readFile(join(target, "edited.txt"), "utf8"), "ok");
  assert.match(await readFile(join(root, ".bnpm-install-invalidated"), "utf8"), /edit:pkg/);
});

test("edit parser handles quoted arguments and direct global-store targets are refused", async (t) => {
  assert.deepEqual(parseEditor("code --wait 'profile one'"), ["code", "--wait", "profile one"]);
  assert.throws(() => parseEditor("code 'unterminated"), /incomplete quoting/);
  const root = await mkdtemp(join(tmpdir(), "bnpm-edit-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const target = join(paths.store, "direct");
  await mkdir(target, { recursive: true });
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "root", version: "1.0.0" }));
  await writeFile(join(target, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
  await symlink(target, join(root, "node_modules", "pkg"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => editInstalledPackage({ cwd: root, name: "pkg", signal: new AbortController().signal, editor: [process.execPath], paths }), /immutable global store/);
});
