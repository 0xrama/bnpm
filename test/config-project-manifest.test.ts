import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  ConfigError,
  composeConfig,
  loadConfigFile,
  parseConfig,
  selectRecencyConfiguration,
} from "../src/config/configuration.js";
import { createBnpmPaths } from "../src/config/paths.js";
import { getConfig, listConfig, mutateConfig } from "../src/config/commands.js";
import { detectInteractiveMode } from "../src/config/interactive.js";
import {
  ManifestError,
  parseManifest,
  planManifestMutation,
  type ManifestMutation,
} from "../src/project/manifest.js";
import { discoverProject } from "../src/project/discovery.js";

const root = await mkdtemp(join(tmpdir(), "bnpm-config-project-"));

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("VAL-CORE-006: configuration precedence and provenance are deterministic", () => {
  const global = parseConfig("recentReleaseHours: 6\n", "global.yaml");
  const project = parseConfig("recentReleaseHours: 24\n", "project/bnpm.yaml");
  const first = composeConfig({
    global,
    project,
    environment: { recentReleaseHours: 24 },
    overrides: { allowRecent: ["example@1.2.3"] },
  });
  const second = composeConfig({
    global,
    project,
    environment: { recentReleaseHours: 24 },
    overrides: { allowRecent: ["example@1.2.3"] },
  });
  assert.deepEqual(first, second);
  assert.equal(first.recentReleaseHours.value, 24);
  assert.equal(first.recentReleaseHours.source, "environment");
  assert.deepEqual(first.allowRecent.value, ["example@1.2.3"]);
  assert.equal(first.allowRecent.source, "override");
});

test("VAL-CORE-007: malformed, duplicate, and security-weakening configuration fails closed", () => {
  for (const source of [
    "recentReleaseHours: 2\n",
    "recentReleaseHours: 1\nrecentReleaseHours: 6\n",
    "trustedPackages: nope\n",
    "unknownSecuritySetting: true\n",
    "trustedPackages:\n  package:\n    integrity: ''\n    scripts: {}\n",
  ]) {
    assert.throws(() => parseConfig(source, "invalid.yaml"), ConfigError);
  }
  const global = parseConfig("recentReleaseHours: 6\n", "global.yaml");
  const project = parseConfig("recentReleaseHours: 1\n", "project/bnpm.yaml");
  assert.throws(() => composeConfig({ global, project }), /cannot weaken global policy/);
});

test("macOS path service is overridable and produces deterministic isolated locations", () => {
  const paths = createBnpmPaths({
    home: "/private/test-home",
    cwd: "/private/project",
    temp: "/private/tmp",
    environment: {},
  });
  assert.equal(paths.globalConfig, "/private/test-home/Library/Application Support/bnpm/config.yaml");
  assert.equal(paths.userNpmrc, "/private/test-home/.npmrc");
  assert.equal(paths.store, "/private/test-home/Library/Caches/bnpm/store");
  assert.equal(paths.projectConfig, "/private/project/bnpm.yaml");
  assert.equal(paths.projectNpmrc, "/private/project/.npmrc");
  assert.equal(paths.globalRoot, "/private/test-home/Library/Application Support/bnpm/global");
  assert.equal(paths.globalBin, "/private/test-home/Library/Application Support/bnpm/global/bin");
  assert.equal(paths.lockfile, "/private/project/bnpm-lock.yaml");
  assert.equal(paths.ephemeralRoot, "/private/tmp/bnpmx");
});

test("Windows path service uses roaming config, local cache, and TEMP", () => {
  const paths = createBnpmPaths({
    home: "C:\\Users\\test",
    cwd: "C:\\project",
    platform: "win32",
    environment: { APPDATA: "C:\\Roaming", LOCALAPPDATA: "C:\\Local", TEMP: "C:\\Temp" },
  });
  assert.match(paths.globalConfig, /Roaming.*bnpm.*config\.yaml$/);
  assert.match(paths.store, /Local.*bnpm.*store$/);
  assert.match(paths.ephemeralRoot, /Temp.*bnpmx$/);
});

test("config commands safely manage registry and recency without exposing credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-config-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  const paths = createBnpmPaths({ cwd: project, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  await writeFile(paths.userNpmrc, "//registry.example/:_authToken=secret\nregistry=https://old.example/\n");
  await mutateConfig(paths, "set", "registry", "https://registry.example/team");
  assert.equal(await getConfig(paths, "registry"), "https://registry.example/team/");
  assert.match(await readFile(paths.userNpmrc, "utf8"), /_authToken=secret/);
  assert.doesNotMatch(JSON.stringify(await listConfig(paths)), /secret/);
  await mutateConfig(paths, "set", "recentReleaseHours", "24");
  assert.equal(await getConfig(paths, "recentReleaseHours"), 24);
  await mutateConfig(paths, "delete", "recentReleaseHours");
  assert.equal(await getConfig(paths, "recentReleaseHours"), 1);
  await mutateConfig(paths, "delete", "registry");
  assert.equal(await getConfig(paths, "registry"), "https://registry.npmjs.org/");
  assert.match(await readFile(paths.userNpmrc, "utf8"), /_authToken=secret/);
  await assert.rejects(() => mutateConfig(paths, "set", "registry", "http://insecure.example"), /HTTPS/);
  await assert.rejects(() => mutateConfig(paths, "set", "_authToken", "never"), /unsupported writable key/);
});

test("VAL-CORE-008 and VAL-CORE-009: recency setup prompts only when safely interactive and persists atomically", async () => {
  const configPath = join(root, "setup", "config.yaml");
  let calls = 0;
  const selected = await selectRecencyConfiguration({
    commandIsSecuritySensitive: true,
    existingConfiguration: false,
    mode: { interactive: true, reason: "terminal" },
    configPath,
    prompt: async () => {
      calls += 1;
      return "6";
    },
  });
  assert.deepEqual(selected, { hours: 6, source: "first-use" });
  assert.equal(calls, 1);
  assert.equal(await readFile(configPath, "utf8"), "recentReleaseHours: 6\n");
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);

  for (const mode of [
    { interactive: false, reason: "json" as const },
    { interactive: false, reason: "ci" as const },
    { interactive: false, reason: "stdin-not-tty" as const },
  ] as const) {
    const result = await selectRecencyConfiguration({
      commandIsSecuritySensitive: true,
      existingConfiguration: false,
      mode,
      configPath: join(root, `non-interactive-${mode.reason}.yaml`),
    });
    assert.deepEqual(result, { hours: 1, source: "default" });
  }
  assert.equal(calls, 1);
});

test("VAL-CORE-020 and VAL-CORE-021: interactive detection is EOF-safe and setup retries are bounded", async () => {
  assert.deepEqual(
    detectInteractiveMode({ json: false, environment: {}, stdinIsTTY: true, stderrIsTTY: true, promptAvailable: true }),
    { interactive: true, reason: "terminal" },
  );
  for (const input of [
    { json: true, environment: {}, stdinIsTTY: true, stderrIsTTY: true, promptAvailable: true },
    { json: false, environment: { CI: "1" }, stdinIsTTY: true, stderrIsTTY: true, promptAvailable: true },
    { json: false, environment: {}, stdinIsTTY: false, stderrIsTTY: true, promptAvailable: true },
    { json: false, environment: {}, stdinIsTTY: true, stderrIsTTY: true, promptAvailable: false },
  ]) {
    assert.equal(detectInteractiveMode(input).interactive, false);
  }
  let calls = 0;
  const result = await selectRecencyConfiguration({
    commandIsSecuritySensitive: true,
    existingConfiguration: false,
    mode: { interactive: true, reason: "terminal" },
    configPath: join(root, "cancelled.yaml"),
    prompt: async () => {
      calls += 1;
      return calls === 3 ? undefined : "bad";
    },
  });
  assert.deepEqual(result, { hours: 1, source: "default" });
  assert.equal(calls, 3);
  await assert.rejects(stat(join(root, "cancelled.yaml")));
});

test("VAL-CORE-010: strict manifests and save intents fail before mutation", () => {
  for (const input of [
    "{",
    '{"dependencies":{"a":"1.0.0","a":"2.0.0"}}',
    '{"dependencies":[]}',
    '{"dependencies":{"bad name":"1.0.0"}}',
    '{"dependencies":{"pkg":"git://example.invalid/pkg.git"}}',
  ]) {
    assert.throws(() => parseManifest(input, "package.json"), ManifestError);
  }
  const manifest = parseManifest('{\n  "name": "project",\n  "dependencies": { "pkg": "^1.0.0" }\n}\n', "package.json");
  assert.equal(manifest.dependencies.dependencies?.pkg, "^1.0.0");
  assert.throws(
    () => planManifestMutation(manifest, { operation: "add", name: "pkg", specifier: "1.0.0", section: "dependencies", noSave: true }),
    ManifestError,
  );
});

test("VAL-CORE-011: manifest plans preserve formatting and never write", () => {
  const source = '{\r\n\t"name": "project",\r\n\t"dependencies": {\r\n\t\t"alpha": "^1.0.0"\r\n\t},\r\n\t"custom": { "keep": true }\r\n}';
  const manifest = parseManifest(source, "package.json");
  const mutation: ManifestMutation = { operation: "add", name: "beta", specifier: "^2.0.0", section: "dependencies", exact: false };
  const plan = planManifestMutation(manifest, mutation);
  assert.match(plan.bytes, /\r\n\t\t"beta": "\^2\.0\.0"\r\n\t}/);
  assert.match(plan.bytes, /"custom": \{ "keep": true \}/);
  assert.equal(plan.bytes.endsWith("\n"), false);
  assert.equal((plan.bytes.match(/"beta"/g) ?? []).length, 1);
  assert.equal(manifest.bytes, source);

  const removal = planManifestMutation(parseManifest(plan.bytes, "package.json"), {
    operation: "remove",
    name: "alpha",
    section: "dependencies",
  });
  assert.equal(parseManifest(removal.bytes, "package.json").dependencies.dependencies?.alpha, undefined);
  assert.equal(parseManifest(removal.bytes, "package.json").dependencies.dependencies?.beta, "^2.0.0");

  const withoutDependencies = parseManifest('{\n  "name": "empty"\n}\n', "package.json");
  const firstAddition = planManifestMutation(withoutDependencies, {
    operation: "add",
    name: "first",
    section: "devDependencies",
    specifier: "^3.0.0",
  });
  assert.equal(parseManifest(firstAddition.bytes, "package.json").dependencies.devDependencies?.first, "^3.0.0");

  const onlyRemoval = planManifestMutation(parseManifest('{"dependencies":{"only":"1.0.0"}}', "package.json"), {
    operation: "remove",
    name: "only",
    section: "dependencies",
  });
  assert.deepEqual(parseManifest(onlyRemoval.bytes, "package.json").dependencies.dependencies, {});

  const misleadingNestedKey = parseManifest(
    '{"custom":{"dependencies":{"shadow":true}},"dependencies":{"real":"1.0.0"}}',
    "package.json",
  );
  const nestedSafePlan = planManifestMutation(misleadingNestedKey, {
    operation: "add",
    name: "second",
    section: "dependencies",
    specifier: "2.0.0",
  });
  assert.match(nestedSafePlan.bytes, /"shadow":true/);
  assert.equal(parseManifest(nestedSafePlan.bytes, "package.json").dependencies.dependencies?.second, "2.0.0");
});

test("VAL-CORE-019 and VAL-CROSS-023: project discovery selects nearest importer without crossing boundaries", async () => {
  const workspace = join(root, "workspace");
  const member = join(workspace, "packages", "member");
  const nested = join(member, "src", "deep");
  const outside = join(root, "outside");
  await mkdir(nested, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, "package.json"), '{"name":"root","workspaces":["packages/*"]}\n');
  await writeFile(join(member, "package.json"), '{"name":"member"}\n');
  const workspaceRoot = await realpath(workspace);
  const memberRoot = await realpath(member);
  const discovered = await discoverProject(nested);
  assert.deepEqual(discovered, { projectRoot: workspaceRoot, importerRoot: memberRoot, kind: "workspace" });

  const independent = join(workspace, "independent");
  await mkdir(join(independent, "lib"), { recursive: true });
  await writeFile(join(independent, "package.json"), '{"name":"independent"}\n');
  assert.deepEqual(await discoverProject(join(independent, "lib")), {
    projectRoot: await realpath(independent),
    importerRoot: await realpath(independent),
    kind: "project",
  });
  assert.equal(await discoverProject(outside), undefined);

  const linked = join(root, "linked-member");
  await symlink(member, linked, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await discoverProject(join(linked, "src")), { projectRoot: workspaceRoot, importerRoot: memberRoot, kind: "workspace" });
});
