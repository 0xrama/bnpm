import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { spawn } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "bnpm-global-install-"));
const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cli = join(repositoryRoot, "dist", "src", "cli.js");
async function writable(path: string): Promise<void> { try { await chmod(path, 0o755); for (const item of await readdir(path, { withFileTypes: true })) if (item.isDirectory()) await writable(join(path, item.name)); } catch {} }
after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });

function execute(cwd: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...environment, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("global install, list, exec, and remove use an isolated persistent project", async () => {
  const cwd = join(root, "caller");
  const globalRoot = join(root, "global");
  const local = join(globalRoot, "local");
  await mkdir(cwd, { recursive: true }); await mkdir(local, { recursive: true });
  await writeFile(join(local, "package.json"), '{"name":"fixture-tool","version":"1.0.0","bin":{"fixture-tool":"cli.js"}}');
  await writeFile(join(local, "cli.js"), "#!/usr/bin/env node\nconsole.log('global-tool-ok')\n");
  const environment = { HOME: join(root, "home"), BNPM_GLOBAL_HOME: globalRoot, BNPM_CACHE_HOME: join(root, "cache") };

  const installed = await execute(cwd, ["install", "-g", "fixture-tool@file:./local"], environment);
  assert.equal(installed.code, 0, installed.stderr);
  const manifest = JSON.parse(await readFile(join(globalRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(manifest.dependencies["fixture-tool"], "file:./local");

  const listed = await execute(cwd, ["list", "-g"], environment);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /fixture-tool@1\.0\.0/);

  const bin = await execute(cwd, ["bin", "-g"], environment);
  assert.equal(bin.code, 0, bin.stderr);
  assert.equal(bin.stdout, `${join(globalRoot, "bin")}\n`);
  const prefix = await execute(cwd, ["prefix", "--global"], environment);
  assert.equal(prefix.code, 0, prefix.stderr);
  assert.equal(prefix.stdout, `${globalRoot}\n`);

  const executed = await execute(cwd, ["exec", "-g", "fixture-tool"], environment);
  assert.equal(executed.code, 0, executed.stderr);
  assert.match(executed.stdout, /global-tool-ok/);

  const direct = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const executable = join(globalRoot, "bin", process.platform === "win32" ? "fixture-tool.cmd" : "fixture-tool");
    const child = spawn(executable, [], { shell: process.platform === "win32", stdio: ["ignore", "pipe", "ignore"] });
    let stdout = ""; child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", reject); child.once("close", (code) => resolve({ code, stdout }));
  });
  assert.equal(direct.code, 0); assert.match(direct.stdout, /global-tool-ok/);

  const removed = await execute(cwd, ["remove", "-g", "fixture-tool"], environment);
  assert.equal(removed.code, 0, removed.stderr);
  const finalManifest = JSON.parse(await readFile(join(globalRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(finalManifest.dependencies["fixture-tool"], undefined);
});
