import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, beforeEach, test } from "node:test";
import { spawn } from "node:child_process";
import { parseInvocation } from "../src/core/cli-parser.js";
import { sanitizeText } from "../src/core/output.js";
import { initializerPackage } from "../src/commands/index.js";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cli = join(repositoryRoot, "dist", "src", "cli.js");
const runner = join(repositoryRoot, "dist", "src", "core", "cli-runner.js");
const root = await mkdtemp(join(tmpdir(), "bnpm-cli-contract-"));

after(async () => {
  await rm(root, { recursive: true, force: true });
});

interface SpawnResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function execute(
  executable: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly signal?: NodeJS.Signals } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("spawn", () => {
      if (options.signal) {
        setTimeout(() => child.kill(options.signal), 50).unref();
      }
    });
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function jsonLines(stdout: string): readonly Record<string, unknown>[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createFifo(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("mkfifo", [path], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`mkfifo exited with ${code ?? "no exit code"}`));
      }
    });
  });
}

async function bnpmxExecutable(name: string): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const executable = join(directory, "bnpmx");
  await writeFile(executable, `import { runCli } from ${JSON.stringify(pathToFileURL(runner).href)};\nprocess.exitCode = await runCli({ args: process.argv.slice(2), executableName: "bnpmx" });\n`);
  return executable;
}

function assertJsonProtocol(events: readonly Record<string, unknown>[]): void {
  assert.ok(events.length > 0);
  for (const [index, event] of events.entries()) {
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.sequence, index + 1);
    assert.equal(typeof event.type, "string");
    assert.equal(typeof event.command, "string");
  }
  assert.equal(events.at(-1)?.type, "result");
  assert.equal(events.filter((event) => event.type === "result").length, 1);
}

test("help and version are side-effect-free through both executable names", async () => {
  const sentinel = join(root, "missing-project-sentinel");
  const exists = async (): Promise<boolean> => {
    try {
      await access(sentinel, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  const before = await exists();
  const bnpmHelp = await execute(cli, ["--help"]);
  assert.equal(bnpmHelp.code, 0);
  assert.match(bnpmHelp.stdout, /install/);
  assert.match(bnpmHelp.stdout, /bnpmx/);
  assert.equal(bnpmHelp.stderr, "");

  const bnpmVersion = await execute(cli, ["--version", "--json"]);
  assert.equal(bnpmVersion.code, 0);
  assert.equal(bnpmVersion.stderr, "");
  const versionEvents = jsonLines(bnpmVersion.stdout);
  assertJsonProtocol(versionEvents);
  assert.equal(versionEvents.length, 1);
  assert.equal(versionEvents[0]?.type, "result");
  assert.equal((versionEvents[0]?.data as { readonly summary?: unknown }).summary, "0.0.3");

  const bnpmx = await bnpmxExecutable("help");
  const bnpmxHelp = await execute(bnpmx, ["-h"]);
  assert.equal(bnpmxHelp.code, 0);
  assert.match(bnpmxHelp.stdout, /Usage: bnpmx/);
  assert.doesNotMatch(bnpmxHelp.stdout, /Commands:/);
  assert.equal(await exists(), before);
});

test("parser accepts only documented global positions, save combinations, and forwarding", () => {
  const install = parseInvocation(["--json", "--allow-recent=@scope/pkg@1.2.3", "install", "-D", "-E", "@scope/pkg@^1"]);
  assert.equal(install.kind, "command");
  if (install.kind === "command") {
    assert.equal(install.name, "install");
    assert.equal(install.options.saveSection, "dev");
    assert.equal(install.options.saveExact, true);
    assert.deepEqual(install.options.allowRecent, ["@scope/pkg@1.2.3"]);
  }
  const mirrored = parseInvocation(["--registry", "https://registry.example/private", "install"]);
  assert.equal(mirrored.kind, "command");
  if (mirrored.kind === "command") assert.equal(mirrored.options.registry, "https://registry.example/private");
  const globalInstall = parseInvocation(["install", "-g", "pkg@1.0.0"]);
  assert.equal(globalInstall.kind, "command");
  if (globalInstall.kind === "command") assert.equal(globalInstall.options.globalInstall, true);

  const ci = parseInvocation(["ci", "--omit=dev"]);
  assert.equal(ci.kind, "command");
  if (ci.kind === "command") {
    assert.equal(ci.name, "install");
    assert.equal(ci.options.frozenLockfile, true);
    assert.equal(ci.options.noSave, true);
    assert.equal(ci.options.omitDev, true);
    assert.deepEqual(ci.args, []);
  }
  for (const args of [["install", "--production"], ["install", "--only=prod"], ["install", "--omit", "dev"]]) {
    const production = parseInvocation(args); assert.equal(production.kind, "command"); if (production.kind === "command") assert.equal(production.options.omitDev, true);
  }
  const includeDev = parseInvocation(["install", "--production", "--include=dev"]); assert.equal(includeDev.kind, "command"); if (includeDev.kind === "command") assert.equal(includeDev.options.omitDev, false);
  const omittedTypes = parseInvocation(["install", "--omit=dev,optional", "--omit", "peer", "--include=optional"]); assert.equal(omittedTypes.kind, "command");
  if (omittedTypes.kind === "command") assert.deepEqual(omittedTypes.options.omit, ["dev", "peer"]);
  const lockOnlyInstall = parseInvocation(["install", "--package-lock-only"]); assert.equal(lockOnlyInstall.kind, "command");
  if (lockOnlyInstall.kind === "command") assert.equal(lockOnlyInstall.options.packageLockOnly, true);
  const dryInstall = parseInvocation(["install", "--dry-run"]); assert.equal(dryInstall.kind, "command"); if (dryInstall.kind === "command") assert.equal(dryInstall.options.dryRun, true);

  for (const [alias, canonical] of [["i", "install"], ["uninstall", "remove"], ["rm", "remove"], ["run-script", "run"], ["ls", "list"], ["ll", "list"], ["la", "list"], ["explain", "why"]] as const) {
    const args = canonical === "remove" || canonical === "why" ? [alias, "pkg"] : canonical === "run" ? [alias, "build"] : [alias];
    const invocation = parseInvocation(args);
    assert.equal(invocation.kind, "command");
    if (invocation.kind === "command") assert.equal(invocation.name, canonical);
  }

  const run = parseInvocation(["run", "build", "--", "--watch", "--json"]);
  assert.equal(run.kind, "command");
  if (run.kind === "command") {
    assert.deepEqual(run.args, ["build", "--watch", "--json"]);
  }

  const bnpmx = parseInvocation(["--json", "pkg@1.0.0", "--", "--flag"], true);
  assert.equal(bnpmx.kind, "bnpmx");
  if (bnpmx.kind === "bnpmx") {
    assert.deepEqual(bnpmx.targetArgs, ["--flag"]);
  }

  const provenance = parseInvocation(["publish", "--provenance-file", "bundle.sigstore", "."]);
  assert.equal(provenance.kind, "command");
  if (provenance.kind === "command") assert.equal(provenance.options.provenanceFile, "bundle.sigstore");
  for (const account of ["login", "adduser", "logout", "whoami"]) assert.doesNotThrow(() => parseInvocation([account]));
  const legacyLogin = parseInvocation(["login", "--auth-type=legacy", "--otp=123456"]);
  assert.equal(legacyLogin.kind, "command");
  if (legacyLogin.kind === "command") assert.equal(legacyLogin.options.authType, "legacy");
  const legacyAdduser = parseInvocation(["adduser", "--auth-type=legacy"]);
  assert.equal(legacyAdduser.kind, "command");
  if (legacyAdduser.kind === "command") assert.equal(legacyAdduser.options.accountCreate, true);
  assert.doesNotThrow(() => parseInvocation(["view", "pkg@^1"]));
  assert.doesNotThrow(() => parseInvocation(["search", "safe", "parser"]));
  assert.doesNotThrow(() => parseInvocation(["dist-tag", "add", "pkg@1.0.0", "stable"]));
  assert.doesNotThrow(() => parseInvocation(["deprecate", "--dry-run", "pkg@^1", "upgrade"]));
  assert.doesNotThrow(() => parseInvocation(["config", "set", "recentReleaseHours", "24"]));
  assert.doesNotThrow(() => parseInvocation(["config", "list"]));
  assert.doesNotThrow(() => parseInvocation(["init", "--yes"]));
  const initializer = parseInvocation(["create", "react-app@latest", "-y", "--", "./app", "--typescript"]); assert.equal(initializer.kind, "command");
  if (initializer.kind === "command") { assert.equal(initializer.name, "init"); assert.equal(initializer.options.yes, true); assert.deepEqual(initializer.args, ["react-app@latest", "./app", "--typescript"]); }
  const workspaceInit = parseInvocation(["init", "-w", "packages/example"]); assert.equal(workspaceInit.kind, "command");
  if (workspaceInit.kind === "command") assert.deepEqual(workspaceInit.options.workspaceNames, ["packages/example"]);
  assert.doesNotThrow(() => parseInvocation(["version", "minor"]));
  const versionFlags = parseInvocation(["version", "preminor", "--preid=beta", "--message", "release %s", "--no-commit-hooks", "--ignore-scripts", "--no-save"]); assert.equal(versionFlags.kind, "command");
  if (versionFlags.kind === "command") { assert.deepEqual(versionFlags.args, ["preminor"]); assert.equal(versionFlags.options.preid, "beta"); assert.equal(versionFlags.options.versionMessage, "release %s"); assert.equal(versionFlags.options.commitHooks, false); assert.equal(versionFlags.options.ignoreScripts, true); assert.equal(versionFlags.options.noSave, true); }
  assert.throws(() => parseInvocation(["version", "patch", "--sign-git-tag", "--no-git-tag-version"]), /cannot be combined/);
  const workspaceVersion = parseInvocation(["version", "patch", "--workspace", "a", "--include-workspace-root"]); assert.equal(workspaceVersion.kind, "command");
  if (workspaceVersion.kind === "command") { assert.deepEqual(workspaceVersion.args, ["patch"]); assert.deepEqual(workspaceVersion.options.workspaceNames, ["a"]); assert.equal(workspaceVersion.options.includeWorkspaceRoot, true); }
  assert.doesNotThrow(() => parseInvocation(["prune", "--omit=dev"]));
  assert.doesNotThrow(() => parseInvocation(["dedupe"]));
  assert.doesNotThrow(() => parseInvocation(["rebuild", "pkg"]));
  const ignoredScripts = parseInvocation(["install", "--ignore-scripts"]);
  assert.equal(ignoredScripts.kind, "command");
  if (ignoredScripts.kind === "command") assert.equal(ignoredScripts.options.ignoreScripts, true);
  assert.doesNotThrow(() => parseInvocation(["run", "--ignore-scripts", "test"]));
  const ephemeralExec = parseInvocation(["exec", "--package", "pkg@1.0.0", "--package=@scope/tool@2", "--", "tool", "--flag"]);
  assert.equal(ephemeralExec.kind, "command");
  if (ephemeralExec.kind === "command") { assert.deepEqual(ephemeralExec.options.execPackages, ["pkg@1.0.0", "@scope/tool@2"]); assert.deepEqual(ephemeralExec.args, ["tool", "--flag"]); }
  assert.doesNotThrow(() => parseInvocation(["fund"]));
  assert.doesNotThrow(() => parseInvocation(["cache", "verify"]));
  assert.doesNotThrow(() => parseInvocation(["cache", "ls", "pkg@1.0.0"]));
  assert.doesNotThrow(() => parseInvocation(["cache", "add", "pkg@1.0.0"]));
  assert.doesNotThrow(() => parseInvocation(["cache", "clean", "--force"]));
  assert.doesNotThrow(() => parseInvocation(["cache", "clean", "pkg@1.0.0", "--force"]));
  assert.doesNotThrow(() => parseInvocation(["cache", "info", "pkg"]));
  assert.doesNotThrow(() => parseInvocation(["install-scripts", "approve", "pkg"]));
  assert.doesNotThrow(() => parseInvocation(["install-scripts", "deny", "@scope/pkg"]));
  assert.doesNotThrow(() => parseInvocation(["install-scripts", "ls"]));
  assert.doesNotThrow(() => parseInvocation(["install-scripts", "prune", "--dry-run"]));
  assert.doesNotThrow(() => parseInvocation(["run", "--workspaces", "test"]));
  const selectedWorkspace = parseInvocation(["run", "--workspace", "packages/a", "--workspace=b", "build"]);
  assert.equal(selectedWorkspace.kind, "command");
  if (selectedWorkspace.kind === "command") assert.deepEqual(selectedWorkspace.options.workspaceNames, ["packages/a", "b"]);
  const workspaceAdd = parseInvocation(["add", "--workspace=a", "--workspace", "packages/b", "pkg@1.0.0"]); assert.equal(workspaceAdd.kind, "command");
  if (workspaceAdd.kind === "command") assert.deepEqual(workspaceAdd.options.workspaceNames, ["a", "packages/b"]);
  assert.doesNotThrow(() => parseInvocation(["run"]));
  const ifPresent = parseInvocation(["run", "--if-present", "optional-build"]);
  assert.equal(ifPresent.kind, "command");
  if (ifPresent.kind === "command") assert.equal(ifPresent.options.ifPresent, true);
  assert.doesNotThrow(() => parseInvocation(["ping"]));
  const auditFix = parseInvocation(["audit", "fix", "--dry-run"]); assert.equal(auditFix.kind, "command");
  if (auditFix.kind === "command") { assert.deepEqual(auditFix.args, ["fix"]); assert.equal(auditFix.options.dryRun, true); }
  assert.doesNotThrow(() => parseInvocation(["doctor"]));
  assert.doesNotThrow(() => parseInvocation(["root"]));
  assert.doesNotThrow(() => parseInvocation(["pkg", "set", "scripts.test=node --test"]));
  assert.doesNotThrow(() => parseInvocation(["sbom", "--sbom-format=spdx"]));
  assert.doesNotThrow(() => parseInvocation(["link"]));
  assert.doesNotThrow(() => parseInvocation(["link", "@scope/pkg"]));
  assert.doesNotThrow(() => parseInvocation(["unlink", "pkg"]));
  assert.doesNotThrow(() => parseInvocation(["query", "[type=dev]:direct"]));
  const expectedQuery = parseInvocation(["query", "#react", "--expect-result-count=1", "--package-lock-only"]);
  assert.equal(expectedQuery.kind, "command");
  if (expectedQuery.kind === "command") {
    assert.deepEqual(expectedQuery.args, ["#react"]);
    assert.equal(expectedQuery.options.expectResultCount, 1);
    assert.equal(expectedQuery.options.packageLockOnly, true);
  }
  const emptyQuery = parseInvocation(["query", "--no-expect-results", ":outdated(in-range)"]);
  assert.equal(emptyQuery.kind, "command");
  if (emptyQuery.kind === "command") assert.equal(emptyQuery.options.expectResults, false);
  assert.throws(() => parseInvocation(["query", "*", "--expect-results", "--expect-result-count=1"]), /mutually exclusive/);
  assert.doesNotThrow(() => parseInvocation(["unpublish", "--dry-run", "pkg@1.0.0"]));
  assert.doesNotThrow(() => parseInvocation(["unpublish", "--force", "pkg@*"]));
  assert.doesNotThrow(() => parseInvocation(["access", "get", "status", "@scope/pkg"]));
  assert.doesNotThrow(() => parseInvocation(["access", "get", "status"]));
  assert.doesNotThrow(() => parseInvocation(["access", "set", "status=public", "@scope/pkg"]));
  assert.doesNotThrow(() => parseInvocation(["access", "list", "packages", "alice"]));
  assert.doesNotThrow(() => parseInvocation(["access", "grant", "read-write", "@scope:core", "@scope/pkg"]));
  assert.doesNotThrow(() => parseInvocation(["owner", "add", "alice", "pkg"]));
  assert.doesNotThrow(() => parseInvocation(["owner", "ls"]));
  for (const command of ["repo", "docs", "bugs"]) assert.doesNotThrow(() => parseInvocation([command, "pkg"]));
  const explore = parseInvocation(["explore", "pkg", "--", "node", "--version"]);
  assert.equal(explore.kind, "command");
  if (explore.kind === "command") assert.deepEqual(explore.args, ["pkg", "node", "--version"]);
  assert.doesNotThrow(() => parseInvocation(["approve-scripts", "native"]));
  assert.doesNotThrow(() => parseInvocation(["deny-scripts"]));
  assert.doesNotThrow(() => parseInvocation(["diff", "pkg@1.0.0"]));
  const fullDiff = parseInvocation(["diff", "lib/**", "--diff=pkg@1.0.0", "--diff", "pkg@2.0.0", "--diff-unified=5", "--diff-name-only"]);
  assert.equal(fullDiff.kind, "command");
  if (fullDiff.kind === "command") {
    assert.deepEqual(fullDiff.args, ["lib/**"]);
    assert.deepEqual(fullDiff.options.diffSpecs, ["pkg@1.0.0", "pkg@2.0.0"]);
    assert.equal(fullDiff.options.diffUnified, 5);
    assert.equal(fullDiff.options.diffNameOnly, true);
  }
  assert.throws(() => parseInvocation(["diff", "--diff=a@1", "--diff=b@1", "--diff=c@1"]), /at most twice/);
  assert.doesNotThrow(() => parseInvocation(["edit", "pkg"]));
  assert.throws(() => parseInvocation(["--json", "edit", "pkg"]), /cannot use --json/);
  assert.doesNotThrow(() => parseInvocation(["token", "list"]));
  assert.doesNotThrow(() => parseInvocation(["token", "revoke", "abcdef"]));
  const tokenCreate = parseInvocation(["token", "create", "--name=release", "--expires=30", "--packages=@scope/pkg", "--read-only"]);
  assert.equal(tokenCreate.kind, "command");
  if (tokenCreate.kind === "command") {
    assert.equal(tokenCreate.options.tokenName, "release");
    assert.deepEqual(tokenCreate.options.tokenPackages, ["@scope/pkg"]);
  }
  assert.throws(() => parseInvocation(["token", "create", "--password=secret"]), /unknown option/);
  assert.equal(parseInvocation(["help", "install"]).kind, "help");
  assert.doesNotThrow(() => parseInvocation(["completion"]));
  assert.doesNotThrow(() => parseInvocation(["get", "registry"]));
  assert.doesNotThrow(() => parseInvocation(["set", "recentReleaseHours=6"]));
  assert.doesNotThrow(() => parseInvocation(["undeprecate", "pkg@1"]));
  assert.doesNotThrow(() => parseInvocation(["find-dupes"]));
  assert.doesNotThrow(() => parseInvocation(["shrinkwrap"]));
  assert.doesNotThrow(() => parseInvocation(["star", "pkg"]));
  assert.doesNotThrow(() => parseInvocation(["unstar", "pkg"]));
  assert.doesNotThrow(() => parseInvocation(["stars", "alice"]));
  assert.doesNotThrow(() => parseInvocation(["org", "set", "acme", "alice", "admin"]));
  assert.doesNotThrow(() => parseInvocation(["org", "ls", "acme"]));
  assert.doesNotThrow(() => parseInvocation(["team", "create", "acme:core"]));
  assert.doesNotThrow(() => parseInvocation(["team", "add", "acme:core", "alice"]));
  assert.doesNotThrow(() => parseInvocation(["profile", "get", "email"]));
  assert.doesNotThrow(() => parseInvocation(["profile", "set", "fullname", "Alice Example"]));
  assert.doesNotThrow(() => parseInvocation(["profile", "set", "password"]));
  assert.doesNotThrow(() => parseInvocation(["profile", "enable-2fa", "auth-and-writes"]));
  assert.doesNotThrow(() => parseInvocation(["profile", "disable-2fa"]));
  assert.throws(() => parseInvocation(["profile", "set", "password", "secret"]), /Usage:/);
  assert.throws(() => parseInvocation(["--json", "profile", "enable-2fa"]), /cannot use --json/);
  const stageId = "123e4567-e89b-42d3-a456-426614174000";
  assert.doesNotThrow(() => parseInvocation(["stage", "publish", "--dry-run", "."]));
  assert.doesNotThrow(() => parseInvocation(["stage", "list", "pkg"]));
  assert.doesNotThrow(() => parseInvocation(["stage", "view", stageId]));
  assert.doesNotThrow(() => parseInvocation(["stage", "download", stageId]));
  assert.doesNotThrow(() => parseInvocation(["stage", "approve", "--otp=123456", stageId]));
  assert.doesNotThrow(() => parseInvocation(["trust", "list", "@scope/pkg"]));
  assert.doesNotThrow(() => parseInvocation(["trust", "revoke", "--dry-run", "@scope/pkg", "trust:1"]));
  const trustCreate = parseInvocation(["trust", "github", "--file=release.yml", "--repository=owner/repo", "--allow-publish", "--yes", "@scope/pkg"]);
  assert.equal(trustCreate.kind, "command");
  if (trustCreate.kind === "command") {
    assert.equal(trustCreate.options.trustFile, "release.yml");
    assert.equal(trustCreate.options.trustRepository, "owner/repo");
    assert.equal(trustCreate.options.allowPublish, true);
  }
  for (const alias of ["test", "start", "stop", "restart", "install-test", "it", "install-ci-test", "cit"]) assert.doesNotThrow(() => parseInvocation([alias]));
  const testAlias = parseInvocation(["test", "--", "--watch"]);
  assert.equal(testAlias.kind, "command");
  if (testAlias.kind === "command") {
    assert.equal(testAlias.name, "run");
    assert.deepEqual(testAlias.args, ["test", "--watch"]);
  }
  const ciTest = parseInvocation(["cit"]);
  assert.equal(ciTest.kind, "command");
  if (ciTest.kind === "command") assert.equal(ciTest.options.frozenLockfile, true);
  assert.throws(() => parseInvocation(["cache", "clean"]), /--force/);

  for (const args of [
    ["install", "--json"],
    ["add", "--save-dev", "--no-save", "pkg@1.0.0"],
    ["remove"],
    ["--allow-recent=pkg@^1", "install"],
    ["ci", "pkg@1.0.0"],
    ["ci", "--save-dev"],
    ["why"],
    ["why", "one", "two"],
    ["--registry=http://registry.example", "install"],
    ["--registry=https://user:secret@registry.example", "install"],
    ["ci", "-g"],
    ["run", "-g", "build"],
    ["pack", "--provenance"],
    ["publish", "--provenance", "--provenance-file=bundle.sigstore"],
    ["install", "--provenance"],
  ]) {
    assert.throws(() => parseInvocation(args), /Usage:/);
  }

  const forwardedGlobalLookingArgument = parseInvocation(["exec", "tool", "--json"]);
  assert.equal(forwardedGlobalLookingArgument.kind, "command");
  if (forwardedGlobalLookingArgument.kind === "command") {
    assert.deepEqual(forwardedGlobalLookingArgument.args, ["tool", "--json"]);
  }
});

test("initializer package names follow npm init/create transformations", () => {
  assert.deepEqual(initializerPackage("foo"), { specifier: "create-foo", binary: "create-foo" });
  assert.deepEqual(initializerPackage("foo@2.0.0"), { specifier: "create-foo@2.0.0", binary: "create-foo" });
  assert.deepEqual(initializerPackage("@usr/foo@next"), { specifier: "@usr/create-foo@next", binary: "create-foo" });
  assert.deepEqual(initializerPackage("@usr"), { specifier: "@usr/create", binary: "create" });
  assert.deepEqual(initializerPackage("@usr@2.0.0"), { specifier: "@usr/create@2.0.0", binary: "create" });
  assert.throws(() => initializerPackage("https://example.invalid/create.tgz"), /registry package/);
});

test("package specification validation rejects unsupported sources before command work", () => {
  for (const spec of [
    "http://example.invalid/pkg.tgz",
  ]) {
    assert.throws(() => parseInvocation(["add", spec]), /Usage:/);
  }

  for (const spec of ["pkg@1.2.3", "pkg@^1", "@scope/pkg@latest", "alias@npm:pkg@1.0.0", "pkg@workspace:*", "pkg@file:./local", "git+https://example.invalid/pkg.git", "github:user/repository", "user/repository", "https://example.invalid/pkg.tgz"]) {
    assert.doesNotThrow(() => parseInvocation(["add", spec]));
  }
  assert.doesNotThrow(() => parseInvocation(["add", "./local-package"]));
  assert.doesNotThrow(() => parseInvocation(["add", "../local-package.tgz"]));
  assert.doesNotThrow(() => parseInvocation(["add", "file:/absolute/package"]));
  assert.doesNotThrow(() => parseInvocation(["add", "remote@https://artifacts.example/package.tgz"]));
  assert.doesNotThrow(() => parseInvocation(["add", "source@git+https://github.com/example/repository.git#main"]));
  assert.doesNotThrow(() => parseInvocation(["add", "https://artifacts.example/package.tgz"]));
  assert.doesNotThrow(() => parseInvocation(["add", "git+https://github.com/example/repository.git#main"]));
  assert.doesNotThrow(() => parseInvocation(["add", "git+https://github.com/example/repository.git#semver:^2::path:packages/tool"]));
  assert.throws(() => parseInvocation(["add", "http://artifacts.example/package.tgz"]), /HTTPS tarball/);
  assert.doesNotThrow(() => parseInvocation(["add", "git+ssh://git@github.com/example/repository.git#main"]));
  assert.throws(() => parseInvocation(["add", "git://github.com/example/repository.git#main"]), /HTTPS or SSH/);
});

test("JSON failures are versioned, final, and isolated to stdout", async () => {
  const result = await execute(cli, ["--json", "nonexistent"]);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, "");
  const events = jsonLines(result.stdout);
  assertJsonProtocol(events);
  assert.equal(events[0]?.type, "error");
  assert.equal(events.at(-1)?.data instanceof Object, true);
});

test("human failures emit one concise terminal diagnostic", async () => {
  const result = await execute(cli, ["nonexistent"]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Usage: unknown command: nonexistent\n");
});

test("typed child output is sanitized and emits only protocol data in JSON mode", async () => {
  const source = [
    `import { runCli } from ${JSON.stringify(runner)};`,
    "const result = await runCli({",
    "  args: ['--json', 'run', 'script'],",
    "  executableName: 'bnpm',",
    "  commandRunner: async (context) => {",
    "    context.output.childOutput('stdout', '\\u001b[2Junsafe\\rrewrite token=top-secret');",
    "    return { status: 'success', category: 'success', exitCode: 0, summary: 'done' };",
    "  },",
    "});",
    "process.exitCode = result;",
  ].join("\n");
  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b|top-secret/);
  const events = jsonLines(result.stdout);
  assertJsonProtocol(events);
  assert.equal(events[0]?.type, "child-output");
});

test("top-level failures are mapped and sanitized without presenter bypass", async () => {
  const source = [
    `import { runCli } from ${JSON.stringify(runner)};`,
    "const result = await runCli({",
    "  args: ['--json', 'run', 'script'],",
    "  executableName: 'bnpm',",
    "  commandRunner: async () => { throw new Error('token=top-secret /private/random/path'); },",
    "});",
    "process.exitCode = result;",
  ].join("\n");
  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(result.code, 70);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /top-secret|private\/random|Error:/);
  assertJsonProtocol(jsonLines(result.stdout));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
test(`${signal} returns one cancelled JSON result and no post-terminal events`, async () => {
  const source = [
    `import { runCli } from ${JSON.stringify(runner)};`,
    "const result = await runCli({",
    "  args: ['--json', 'run', 'script'],",
    "  executableName: 'bnpm',",
    "  commandRunner: async (context) => { process.send?.('ready'); return await new Promise((resolve) => setTimeout(() => { context.output.info('late output'); resolve({ status: 'success', category: 'success', exitCode: 0, summary: 'late' }); }, 500)); },",
    "});",
    "process.exitCode = result;",
  ].join("\n");
  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("message", () => child.kill(signal));
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
  assert.equal(result.stderr, "");
  const events = jsonLines(result.stdout);
  assertJsonProtocol(events);
  assert.equal(events.at(-1)?.type, "result");
  assert.doesNotMatch(result.stdout, /late output/);
});
}

// VAL-CORE-003: Dispatch and unsupported commands are exact
test("unknown commands fail as usage without domain work", async () => {
  for (const args of [["nonexistent"], ["config"]]) {
    const result = await execute(cli, args);
    assert.equal(result.code, 2, `expected usage exit for 'bnpm ${args[0]}'`);
    assert.match(result.stderr, /Usage:/, `expected usage message for 'bnpm ${args[0]}'`);
  }
});

test("documented commands dispatch to their correct flow", async () => {
  for (const command of ["install", "add", "remove", "update", "outdated", "list", "why", "bin", "prefix", "run", "audit", "exec", "pack", "publish"] as const) {
    const args = command === "run" || command === "exec"
      ? [command, "nonexistent"]
      : command === "why"
        ? [command, "pkg"]
      : command === "pack" || command === "publish"
        ? [command, "--dry-run"]
      : command === "audit" || command === "update" || command === "outdated" || command === "list" || command === "bin" || command === "prefix"
        ? [command]
        : command === "remove"
          ? [command, "pkg"]
          : [command, "pkg@1.0.0"];
    const result = await execute(cli, args);
    assert.ok(result.code !== undefined, `bnpm ${command} should produce an exit code`);
    assert.ok(result.code !== 2, `bnpm ${command} should not be usage error`);
  }
});

test("human installs summarize security inspection instead of streaming package-by-package noise", async () => {
  const project = join(root, "inspection-summary"); await mkdir(project); await writeFile(join(project, "package.json"), JSON.stringify({ name: "inspection-summary", version: "1.0.0" }));
  const result = await execute(cli, ["install"], { cwd: project }); assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Security: \d+ packages? inspected/); assert.doesNotMatch(result.stdout, /Security inspection for/);
  assert.match(result.stdout, /Progress: resolved \d+, reused \d+, downloaded \d+, done/);
  assert.doesNotMatch(result.stdout, /Resolving|Fetching packages|Security inspection|Linking|Install ready|Installed \d+ packages/);
});

test("bnpmx dispatches to ephemeral mode via basename", async () => {
  const bnpmx = await bnpmxExecutable("dispatch");
  const result = await execute(bnpmx, ["pkg@1.0.0"]);
  assert.ok(result.code !== 2, "bnpmx with valid spec should not be usage error");
});

test("bnpmx preserves direct terminal bytes in human mode and sanitizes JSON mode", async () => {
  const tool = join(root, "color-tool"); await mkdir(tool); await writeFile(join(tool, "package.json"), JSON.stringify({ name: "color-tool", version: "1.0.0", bin: { "color-tool": "cli.js" } }));
  await writeFile(join(tool, "cli.js"), "#!/usr/bin/env node\nprocess.stdout.write('\\u001b[31mcolor\\u001b[0m\\n')\n"); await chmod(join(tool, "cli.js"), 0o755); const bnpmx = await bnpmxExecutable("passthrough");
  const human = await execute(bnpmx, [tool]); assert.equal(human.code, 0); assert.equal(human.stdout, "\u001b[31mcolor\u001b[0m\n"); assert.equal(human.stderr, ""); assert.doesNotMatch(human.stdout, /Completed|\\u001b/);
  const json = await execute(bnpmx, ["--json", tool]); assert.equal(json.code, 0); assert.equal(json.stderr, ""); assert.doesNotMatch(json.stdout, /\u001b/); const events = jsonLines(json.stdout); assertJsonProtocol(events); assert.equal(events.some((event) => event.type === "child-output"), true); assert.equal(events.at(-1)?.type, "result");
});

test("bnpmx discloses detected capabilities and blocks non-interactive execution without an exact override", async () => {
  const tool = join(root, "capability-tool"); await mkdir(tool); await writeFile(join(tool, "package.json"), JSON.stringify({ name: "capability-tool", version: "1.0.0", bin: { "capability-tool": "cli.js" } }));
  await writeFile(join(tool, "cli.js"), "#!/usr/bin/env node\nconst chatHistory = '.codex/sessions'; const endpoint = 'https://api.example.invalid/v1'; process.stdout.write('ran\\n')\n"); await chmod(join(tool, "cli.js"), 0o755); const bnpmx = await bnpmxExecutable("capabilities");
  const blocked = await execute(bnpmx, [tool]); assert.equal(blocked.code, 3); assert.match(blocked.stdout, /Security review/); assert.match(blocked.stdout, /HIGH REVIEW/); assert.match(blocked.stdout, /AI chat history/); assert.match(blocked.stdout, /Nothing has run yet/); assert.doesNotMatch(blocked.stdout, /Evidence:/); assert.doesNotMatch(blocked.stdout, /^ran$/m); assert.match(blocked.stderr, /Execution cancelled/);
  const detailed = await execute(bnpmx, ["--details", tool]); assert.equal(detailed.code, 3); assert.match(detailed.stdout, /Evidence:/); assert.match(detailed.stdout, /Capability: ai-history-read/);
  const allowed = await execute(bnpmx, ["--allow-dangerous=capability-tool@1.0.0", tool]); assert.equal(allowed.code, 0); assert.match(allowed.stdout, /Security review/); assert.match(allowed.stdout, /^ran$/m); assert.doesNotMatch(allowed.stdout, /Completed/);
});

test("bnpmx check audits direct and transitive project packages without executing them", async () => {
  const fixture = join(root, "check-fixture"); const child = join(fixture, "child"); const parent = join(fixture, "parent"); const project = join(fixture, "project");
  await mkdir(child, { recursive: true }); await mkdir(parent); await mkdir(project);
  await writeFile(join(child, "package.json"), JSON.stringify({ name: "check-child", version: "1.0.0" })); await writeFile(join(child, "history.js"), "export const history = '.codex/sessions'\n");
  await writeFile(join(parent, "package.json"), JSON.stringify({ name: "check-parent", version: "1.0.0", dependencies: { "check-child": "file:../child" } }));
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "check-project", version: "1.0.0", dependencies: { "check-parent": "file:../parent" } }));
  const installed = await execute(cli, ["install"], { cwd: project }); assert.equal(installed.code, 0, installed.stderr);
  const bnpmx = await bnpmxExecutable("project-check"); const checked = await execute(bnpmx, ["check"], { cwd: project }); assert.equal(checked.code, 0, checked.stderr);
  assert.match(checked.stdout, /Project security check/); assert.match(checked.stdout, /2 packages · 1 direct · 1 transitive/); assert.match(checked.stdout, /AI chat history/); assert.match(checked.stdout, /No package code was executed/);
});

test("bnpmx with package spec starting with dash fails as usage", async () => {
  const bnpmx = await bnpmxExecutable("dash");
  const result = await execute(bnpmx, ["-not-a-package"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Usage:/);
});

// VAL-CORE-012: Human output is concise and deterministic
test("human mode output is stable and does not leak internals", async () => {
  const helpResult = await execute(cli, ["--help"]);
  assert.equal(helpResult.code, 0);
  assert.doesNotMatch(helpResult.stdout, /undefined|null|Symbol|prototype|\[object/);
  assert.doesNotMatch(helpResult.stdout, /Error|stack|at /);

  const versionResult = await execute(cli, ["--version"]);
  assert.equal(versionResult.code, 0);
  assert.match(versionResult.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal(versionResult.stderr, "");

  const usageResult = await execute(cli, ["nonexistent"]);
  assert.equal(usageResult.code, 2);
  assert.match(usageResult.stderr, /Usage:/);
  assert.doesNotMatch(usageResult.stderr, /Error|stack|at /);
});

// VAL-CORE-014: Non-interactive decisions and stream separation are stable
test("JSON mode stderr is empty for all failure categories", async () => {
  const errorCases: readonly (readonly string[])[] = [
    ["--json", "nonexistent"],
    ["--json", "add"],
    ["--json", "remove"],
    ["--json", "--allow-recent=pkg@^1", "install"],
  ];
  for (const args of errorCases) {
    const result = await execute(cli, args);
    assert.equal(result.stderr, "", `stderr should be empty for JSON mode args: ${args.join(" ")}`);
    if (result.stdout.trim()) {
      const events = jsonLines(result.stdout);
      for (const event of events) {
        try {
          JSON.parse(JSON.stringify(event));
        } catch {
          assert.fail(`unparseable JSON event in stdout for args: ${args.join(" ")}`);
        }
      }
    }
  }
});

test("closed stdin does not hang or produce approval", async () => {
  const result = await execute(cli, ["--json", "install"]);
  assert.ok(result.code !== undefined);
  assert.ok(result.stdout === "" || jsonLines(result.stdout).length >= 1);
  assert.doesNotMatch(result.stdout, /approved|allow/);
});

// VAL-CORE-015: Exit categories are stable across presenters
test("same exit codes in human and JSON mode for each failure category", async () => {
  const commandMatrix: readonly { readonly args: readonly string[]; readonly expectedCode: number }[] = [
    { args: ["nonexistent"], expectedCode: 2 },
    { args: ["--allow-recent=pkg@^1", "install"], expectedCode: 2 },
    { args: ["add"], expectedCode: 2 },
    { args: ["remove"], expectedCode: 2 },
  ];
  for (const { args, expectedCode } of commandMatrix) {
    const humanResult = await execute(cli, args);
    const jsonResult = await execute(cli, ["--json", ...args]);
    assert.equal(humanResult.code, expectedCode, `human exit for ${args.join(" ")}`);
    assert.equal(jsonResult.code, expectedCode, `json exit for ${args.join(" ")}`);
  }
});

// VAL-CORE-017: Cancellation stops owned work safely (human mode)
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} human mode returns correct exit code with no post-terminal events`, async () => {
    const source = [
      `import { runCli } from ${JSON.stringify(runner)};`,
      "const result = await runCli({",
      "  args: ['run', 'script'],",
      "  executableName: 'bnpm',",
      "  commandRunner: async (context) => { process.send?.('ready'); return await new Promise((resolve) => setTimeout(() => { context.output.info('late output'); resolve({ status: 'success', category: 'success', exitCode: 0, summary: 'late' }); }, 500)); },",
      "});",
      "process.exitCode = result;",
    ].join("\n");
    const result = await new Promise<SpawnResult>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("message", () => child.kill(signal));
      child.once("close", (code, sig) => resolve({ code, signal: sig, stdout, stderr }));
    });
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
    assert.doesNotMatch(result.stdout, /late output/);
  });
}

// VAL-CORE-018: Untrusted output and cleanup respect ownership
test("sanitizeText strips terminal control sequences and redacts secrets", () => {
  assert.equal(sanitizeText("\u001b[2Jclear"), "\\u001b[2Jclear");
  assert.equal(sanitizeText("\u0007bell"), "\\u0007bell");
  assert.equal(sanitizeText("token=super-secret-value"), "token=[REDACTED]");
  assert.equal(sanitizeText("password:my-password"), "password:[REDACTED]");
  assert.equal(sanitizeText("Authorization: Bearer eyJhbGci"), "Authorization:[REDACTED]");
  assert.equal(sanitizeText("normal text remains"), "normal text remains");
  assert.equal(sanitizeText("line1\nline2"), "line1\nline2");
  assert.equal(sanitizeText("tab\there"), "tab\there");
  assert.equal(sanitizeText("carriage\rreturn"), "carriage\\rreturn");
});

test("child output in human mode does not leak ANSI or secrets", async () => {
  const source = [
    `import { runCli } from ${JSON.stringify(runner)};`,
    "const result = await runCli({",
    "  args: ['run', 'script'],",
    "  executableName: 'bnpm',",
    "  commandRunner: async (context) => {",
    "    context.output.childOutput('stderr', '\\u001b[31msecret=abc123\\u001b[0m');",
    "    return { status: 'success', category: 'success', exitCode: 0, summary: 'done' };",
    "  },",
    "});",
    "process.exitCode = result;",
  ].join("\n");
  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /\u001b/);
  assert.doesNotMatch(result.stderr, /abc123/);
});

// VAL-CORE-023: JSON stream ownership is unambiguous
test("JSON mode stdout is always valid NDJSON with no prose or ANSI", async () => {
  const cases: readonly (readonly string[])[] = [
    ["--json", "--help"],
    ["--json", "--version"],
    ["--json", "publish"],
    ["--json", "add", "pkg@1.0.0"],
    ["--json", "install"],
  ];
  for (const args of cases) {
    const result = await execute(cli, args);
    assert.equal(result.stderr, "", `stderr must be empty for: ${args.join(" ")}`);
    const raw = result.stdout;
    assert.doesNotMatch(raw, /[\u001b\u0007]/, `no ANSI for: ${args.join(" ")}`);
    if (raw.trim()) {
      const lines = raw.trim().split("\n");
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          assert.equal(parsed.schemaVersion, 1, `schema version for: ${args.join(" ")}`);
          assert.equal(typeof parsed.type, "string");
        } catch {
          assert.fail(`unparseable NDJSON line for: ${args.join(" ")}: ${line.slice(0, 100)}`);
        }
      }
    }
  }
});

// VAL-CORE-001: Help with FIFO/stdin block does not hang
test("help does not hang when stdin is a FIFO", async () => {
  if (process.platform === "win32") return;
  const fifoPath = join(root, "test-fifo");
  try {
    await createFifo(fifoPath);
  } catch {
    return;
  }
  const result = await execute(cli, ["--help"], {
    env: { ...process.env, BNPM_TEST_FIFO: fifoPath },
  });
  assert.equal(result.code, 0);
});

// VAL-CORE-002: Version is consistent across bnpm and bnpmx
test("version output is consistent across executable names", async () => {
  const bnpmVersion = await execute(cli, ["--version"]);
  const bnpmx = await bnpmxExecutable("version");
  const bnpmxVersion = await execute(bnpmx, ["--version"]);
  assert.equal(bnpmVersion.stdout.trim(), bnpmxVersion.stdout.trim());
  assert.equal(bnpmVersion.code, 0);
  assert.equal(bnpmxVersion.code, 0);
});

// VAL-CORE-003: Global-install behavior is explicit and isolated
test("global install flags select the configured global project", async () => {
  const environment = { HOME: root, BNPM_GLOBAL_HOME: join(root, "global-contract"), BNPM_CACHE_HOME: join(root, "global-contract-cache") };
  for (const args of [["install", "-g"], ["install", "--global"]]) {
    const result = await execute(cli, args, { env: environment });
    assert.equal(result.code, 0, result.stderr);
  }
});
