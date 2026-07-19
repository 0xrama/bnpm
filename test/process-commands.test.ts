import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { execInstalled, exploreInstalled, runProjectInstallLifecycle, runProjectScript, runProjectScriptLifecycle } from "../src/commands/process.js";
import type { Output } from "../src/core/output.js";
import { runCommand } from "../src/commands/index.js";
import type { CommandOptions } from "../src/core/cli-parser.js";

const root = await mkdtemp(join(tmpdir(), "bnpm-process-"));
after(async () => rm(root, { recursive: true, force: true }));
function capture(): { output: Output; text: string[] } {
  const text: string[] = [];
  return { text, output: { info() {}, error() {}, result() {}, childOutput(_stream, value) { text.push(value); } } };
}

test("project run and installed exec forward bounded attributed output", async () => {
  const project = join(root, "project"); const bin = join(project, "node_modules", ".bin"); await mkdir(bin, { recursive: true });
  await writeFile(join(project, "package.json"), '{"name":"project","version":"1.0.0","scripts":{"hello":"node -e \\"console.log(process.argv[1])\\"","use-tool":"tool"}}');
  const first = capture();
  assert.equal(await runProjectScript(project, "hello", ["argument"], new AbortController().signal, first.output, new Set()), 0);
  assert.match(first.text.join(""), /argument/);
  const executable = join(project, "tool.js"); await writeFile(executable, "#!/usr/bin/env node\nconsole.log('tool-ok')\n"); await chmod(executable, 0o755);
  if (process.platform === "win32") await writeFile(join(bin, "tool.cmd"), `@node "${executable.replaceAll('"', '""')}" %*\r\n`);
  else await symlink("../../tool.js", join(bin, "tool"));
  const script = capture();
  assert.equal(await runProjectScript(project, "use-tool", [], new AbortController().signal, script.output, new Set()), 0);
  assert.match(script.text.join(""), /tool-ok/);
  const second = capture();
  assert.equal(await execInstalled(project, "tool", [], new AbortController().signal, second.output), 0);
  assert.match(second.text.join(""), /tool-ok/);
});

test("run --workspaces executes members deterministically through the project analyzer", async () => {
  const project = join(root, "workspace-run");
  for (const name of ["a", "b"]) {
    const path = join(project, "packages", name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", scripts: { build: `node -e "require('fs').writeFileSync('built.txt','${name}')"`, selected: `node -e "require('fs').writeFileSync('selected.txt','${name}')"` } }));
  }
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }));
  const options: CommandOptions = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false, workspaces: true };
  assert.equal(await runCommand("run", { args: ["build"], cwd: project, output: capture().output, invokedAsBnpmx: false, options, signal: new AbortController().signal }), 0);
  assert.equal(await readFile(join(project, "packages", "a", "built.txt"), "utf8"), "a");
  assert.equal(await readFile(join(project, "packages", "b", "built.txt"), "utf8"), "b");
  const selectedOptions: CommandOptions = { ...options, workspaces: false, workspaceNames: ["b"] };
  assert.equal(await runCommand("run", { args: ["selected"], cwd: project, output: capture().output, invokedAsBnpmx: false, options: selectedOptions, signal: new AbortController().signal }), 0);
  await assert.rejects(readFile(join(project, "packages", "a", "selected.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(project, "packages", "b", "selected.txt"), "utf8"), "b");
});

test("script aliases preserve pre/post lifecycle order and restart falls back to stop/start", async () => {
  const project = join(root, "script-aliases");
  await mkdir(project);
  const append = (value: string) => `node -e "require('fs').appendFileSync('order.txt','${value} ')"`;
  await writeFile(join(project, "package.json"), JSON.stringify({
    name: "aliases",
    version: "1.0.0",
    scripts: {
      pretest: append("pretest"), test: append("test"), posttest: append("posttest"),
      prestop: append("prestop"), stop: append("stop"), poststop: append("poststop"),
      prestart: append("prestart"), start: append("start"), poststart: append("poststart"),
    },
  }));
  const signal = new AbortController().signal;
  assert.equal(await runProjectScriptLifecycle(project, "test", [], signal, capture().output, new Set()), 0);
  const options: CommandOptions = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false };
  assert.equal(await runCommand("restart", { args: [], cwd: project, output: capture().output, invokedAsBnpmx: false, options, signal }), 0);
  assert.equal(await readFile(join(project, "order.txt"), "utf8"), "pretest test posttest prestop stop poststop prestart start poststart ");
  await writeFile(join(project, "order.txt"), "");
  assert.equal(await runProjectScriptLifecycle(project, "test", [], signal, capture().output, new Set(), false), 0);
  assert.equal(await readFile(join(project, "order.txt"), "utf8"), "test ");
});

test("start uses the npm-compatible server.js fallback through project analysis", async () => {
  const project = join(root, "start-fallback"); await mkdir(project);
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "fallback", version: "1.0.0" }));
  await writeFile(join(project, "server.js"), "require('fs').writeFileSync('started.txt', process.argv[2])\n");
  assert.equal(await runProjectScriptLifecycle(project, "start", ["ready"], new AbortController().signal, capture().output, new Set()), 0);
  assert.equal(await readFile(join(project, "started.txt"), "utf8"), "ready");
});

test("root install lifecycle follows npm ordering after layout activation", async () => {
  const project = join(root, "root-install-lifecycle"); await mkdir(project);
  const append = (value: string) => `node -e "require('fs').appendFileSync('install-order.txt','${value} ')"`;
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "root-install", version: "1.0.0", scripts: Object.fromEntries(["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"].map((stage) => [stage, append(stage)])) }));
  assert.equal(await runProjectInstallLifecycle(project, new AbortController().signal, capture().output, new Set()), 0);
  assert.equal(await readFile(join(project, "install-order.txt"), "utf8"), "preinstall install postinstall prepublish preprepare prepare postprepare ");
});

test("run lists scripts and --if-present makes a missing script a successful no-op", async () => {
  const project = join(root, "run-list"); await mkdir(project); await writeFile(join(project, "package.json"), JSON.stringify({ name: "run-list", version: "1.0.0", scripts: { test: "node --test", build: "node build.js" } }));
  const messages: string[] = []; const output: Output = { info(message) { messages.push(message); }, error() {}, result() {}, childOutput() {} };
  const base: CommandOptions = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false };
  assert.equal(await runCommand("run", { args: [], cwd: project, output, invokedAsBnpmx: false, options: base, signal: new AbortController().signal }), 0);
  assert.equal(messages[0], "build\ntest");
  assert.equal(await runCommand("run", { args: ["missing"], cwd: project, output, invokedAsBnpmx: false, options: { ...base, ifPresent: true }, signal: new AbortController().signal }), 0);
});

test("project scripts receive npm-compatible lifecycle environment variables", async () => {
  const project = join(root, "script-environment"); await mkdir(project);
  const script = "node -e \"require('fs').writeFileSync('env.json',JSON.stringify({event:process.env.npm_lifecycle_event,name:process.env.npm_package_name,version:process.env.npm_package_version,json:process.env.npm_package_json,init:process.env.INIT_CWD,command:process.env.npm_command,userAgent:process.env.npm_config_user_agent}))\"";
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "script-environment", version: "2.3.4", scripts: { inspect: script } }));
  assert.equal(await runProjectScriptLifecycle(project, "inspect", [], new AbortController().signal, capture().output, new Set()), 0);
  const environment = JSON.parse(await readFile(join(project, "env.json"), "utf8"));
  assert.deepEqual({ event: environment.event, name: environment.name, version: environment.version, json: environment.json, init: environment.init, command: environment.command }, { event: "inspect", name: "script-environment", version: "2.3.4", json: join(project, "package.json"), init: project, command: "run-script" });
  assert.match(environment.userAgent, /^bnpm\/0\.0\.0 node\//);
});

test("explore runs an exact command in an installed package directory", async () => {
  const project = join(root, "explore");
  const installed = join(project, "node_modules", "pkg");
  await mkdir(installed, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
  const result = capture();
  assert.equal(await exploreInstalled(project, "pkg", ["node", "-e", "console.log(process.cwd())"], new AbortController().signal, result.output), 0);
  assert.match(result.text.join(""), /node_modules\/pkg/);
  await assert.rejects(() => exploreInstalled(project, "missing", ["node"], new AbortController().signal, result.output), /not found/);
});

test("exec --package installs and runs a relative local package ephemerally", async () => {
  const project = join(root, "ephemeral-exec"); const tool = join(project, "tool"); await mkdir(tool, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));
  await writeFile(join(tool, "package.json"), JSON.stringify({ name: "fixture-tool", version: "1.0.0", bin: { fixture: "cli.js" } }));
  await writeFile(join(tool, "cli.js"), "#!/usr/bin/env node\nconsole.log('ephemeral:' + process.argv[2])\n");
  const result = capture(); const options: CommandOptions = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false, execPackages: ["file:./tool"] };
  assert.equal(await runCommand("exec", { args: ["fixture", "ok"], cwd: project, output: result.output, invokedAsBnpmx: false, options, signal: new AbortController().signal }), 0);
  assert.match(result.text.join(""), /ephemeral:ok/);
});
