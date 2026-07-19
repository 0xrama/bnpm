import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBnpmPaths } from "../src/config/paths.js";
import type { CommandOptions } from "../src/core/cli-parser.js";
import type { Output } from "../src/core/output.js";
import { runCommand } from "../src/commands/index.js";
import { packPackage } from "../src/package/pack.js";
import { publishPackage } from "../src/package/publish.js";
import { generateProvenance, loadProvenance, provenanceSubject } from "../src/package/provenance.js";
import { changePackageVersion, initializePackage, initializeWorkspace, nextPackageVersion } from "../src/package/authoring.js";

const options: CommandOptions = {
  json: false,
  allowRecent: [],
  allowDangerous: [],
  frozenLockfile: false,
  offline: false,
  omitDev: false,
  saveExact: false,
  noSave: false,
};

function silentOutput(results: unknown[]): Output {
  return {
    info: () => undefined,
    error: () => undefined,
    childOutput: () => undefined,
    result: (result) => results.push(result),
  };
}

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bnpm-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist", "nested"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@scope/fixture",
    version: "1.2.3",
    files: ["dist"],
    main: "entry.js",
    bin: { fixture: "cli.js" },
  }));
  await writeFile(join(root, "README.md"), "readme\n");
  await writeFile(join(root, "LICENSE"), "license\n");
  await writeFile(join(root, "entry.js"), "export default 1\n");
  await writeFile(join(root, "cli.js"), "#!/usr/bin/env node\n");
  await chmod(join(root, "cli.js"), 0o755);
  await writeFile(join(root, "secret.txt"), "not published\n");
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=never-pack-this\n");
  await writeFile(join(root, "dist", "included.js"), "included\n");
  await writeFile(join(root, "dist", "nested", ".npmignore"), "ignored.js\n");
  await writeFile(join(root, "dist", "nested", "ignored.js"), "ignored\n");
  return root;
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function gitVersionFixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bnpm-version-git-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "version-fixture", version: "1.2.3" }, null, 2)}\n`);
  await writeFile(join(root, "package-lock.json"), `${JSON.stringify({ name: "version-fixture", version: "1.2.3", lockfileVersion: 3, packages: { "": { name: "version-fixture", version: "1.2.3" } } }, null, 2)}\n`);
  git(root, "init", "-q"); git(root, "config", "user.name", "Better NPM Tests"); git(root, "config", "user.email", "bnpm@example.invalid"); git(root, "config", "commit.gpgsign", "false"); git(root, "config", "tag.gpgsign", "false"); git(root, "add", "package.json", "package-lock.json"); git(root, "commit", "-q", "-m", "initial");
  return root;
}

test("init creates an npm-compatible manifest and version updates atomically", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "bnpm-init-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "My Package");
  await mkdir(root);
  const manifest = await initializePackage({ directory: root });
  assert.equal(manifest.name, "my-package");
  assert.equal(manifest.version, "1.0.0");
  const patch = await changePackageVersion(root, "patch");
  assert.deepEqual(patch, { name: "my-package", previous: "1.0.0", version: "1.0.1" });
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "1.0.1");
  await assert.rejects(() => initializePackage({ directory: root }), /already exists/);
  await assert.rejects(() => changePackageVersion(root, "not-a-version"), /invalid version/);
});

test("version calculation supports prerelease identifiers and protects equal versions", () => {
  assert.equal(nextPackageVersion("1.2.3", "preminor", { preid: "beta" }), "1.3.0-beta.0");
  assert.equal(nextPackageVersion("1.3.0-beta.0", "prerelease", { preid: "beta" }), "1.3.0-beta.1");
  assert.throws(() => nextPackageVersion("1.2.3", "1.2.3"), /already/);
  assert.equal(nextPackageVersion("1.2.3", "1.2.3", { allowSame: true }), "1.2.3");
});

test("workspace init creates a confined member and registers it in the root manifest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-workspace-init-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), '{"name":"workspace-root","private":true}\n');
  const created = await initializeWorkspace({ root, workspace: "packages/example", createManifest: true });
  assert.equal(created.workspace, "packages/example"); assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).workspaces[0], "packages/example");
  assert.equal(JSON.parse(await readFile(join(root, "packages", "example", "package.json"), "utf8")).name, "example");
  await assert.rejects(() => initializeWorkspace({ root, workspace: "../escape", createManifest: true }), /safe relative/);
});

test("version command runs authoring lifecycles around the manifest update", async (t) => {
  const root = await fixture(t);
  const path = join(root, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const append = (stage: string): string => `node -e "require('fs').appendFileSync('version-order.log','${stage}:'+require('./package.json').version+'\\n')"`;
  manifest.scripts = { preversion: append("preversion"), version: append("version"), postversion: append("postversion") };
  await writeFile(path, JSON.stringify(manifest));
  assert.equal(await runCommand("version", { args: ["patch"], cwd: root, output: silentOutput([]), invokedAsBnpmx: false, options, signal: new AbortController().signal }), 0);
  assert.equal(await readFile(join(root, "version-order.log"), "utf8"), "preversion:1.2.3\nversion:1.2.4\npostversion:1.2.4\n");
});

test("version command creates a Git commit and tag with npm lifecycle version variables", async (t) => {
  const root = await gitVersionFixture(t); const path = join(root, "package.json"); const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  manifest.scripts = { version: "node -e \"require('fs').writeFileSync('version-env',process.env.npm_old_version+'>'+process.env.npm_new_version)\"" };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`); git(root, "add", "package.json"); git(root, "commit", "-q", "-m", "add lifecycle");
  assert.equal(await runCommand("version", { args: ["patch"], cwd: root, output: silentOutput([]), invokedAsBnpmx: false, options: { ...options, versionMessage: "release %s" }, signal: new AbortController().signal }), 0);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, "1.2.4"); assert.equal(await readFile(join(root, "version-env"), "utf8"), "1.2.3>1.2.4");
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")); assert.equal(lock.version, "1.2.4"); assert.equal(lock.packages[""].version, "1.2.4");
  assert.equal(git(root, "log", "-1", "--pretty=%s"), "release 1.2.4"); assert.equal(git(root, "tag", "--points-at", "HEAD"), "v1.2.4");
  assert.match(git(root, "show", "--pretty=", "--name-only", "HEAD"), /package-lock\.json/);
});

test("version command refuses dirty Git state and supports manifest-only mode", async (t) => {
  const root = await gitVersionFixture(t); const path = join(root, "package.json"); await writeFile(join(root, "dirty.txt"), "dirty\n");
  assert.equal(await runCommand("version", { args: ["patch"], cwd: root, output: silentOutput([]), invokedAsBnpmx: false, options, signal: new AbortController().signal }), 7);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, "1.2.3");
  const head = git(root, "rev-parse", "HEAD"); assert.equal(await runCommand("version", { args: ["patch"], cwd: root, output: silentOutput([]), invokedAsBnpmx: false, options: { ...options, gitTagVersion: false }, signal: new AbortController().signal }), 0);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, "1.2.4"); assert.equal(JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")).version, "1.2.4"); assert.equal(git(root, "rev-parse", "HEAD"), head); assert.equal(git(root, "tag"), "");
  assert.equal(await runCommand("version", { args: ["patch"], cwd: root, output: silentOutput([]), invokedAsBnpmx: false, options: { ...options, gitTagVersion: false, noSave: true }, signal: new AbortController().signal }), 0);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, "1.2.5"); assert.equal(JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")).version, "1.2.4");
});

test("version command restores package.json when its target Git tag exists", async (t) => {
  const root = await gitVersionFixture(t); const path = join(root, "package.json"); const original = await readFile(path, "utf8"); const lockPath = join(root, "package-lock.json"); const originalLock = await readFile(lockPath, "utf8"); const head = git(root, "rev-parse", "HEAD"); git(root, "tag", "v1.2.4");
  assert.equal(await runCommand("version", { args: ["patch"], cwd: root, output: silentOutput([]), invokedAsBnpmx: false, options, signal: new AbortController().signal }), 7);
  assert.equal(await readFile(path, "utf8"), original); assert.equal(await readFile(lockPath, "utf8"), originalLock); assert.equal(git(root, "rev-parse", "HEAD"), head); assert.equal(git(root, "status", "--porcelain"), "");
});

test("version command updates selected workspaces and root lock metadata transactionally", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-version-workspaces-")); t.after(() => rm(root, { recursive: true, force: true })); const a = join(root, "packages", "a"); const b = join(root, "packages", "b"); await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "root", version: "1.0.0", private: true, workspaces: ["packages/*"] }));
  const lifecycle = "node -e \"require('fs').writeFileSync('version-env',process.env.npm_old_version+'>'+process.env.npm_new_version)\""; await writeFile(join(a, "package.json"), JSON.stringify({ name: "a", version: "1.0.0", scripts: { version: lifecycle } })); await writeFile(join(b, "package.json"), JSON.stringify({ name: "b", version: "2.0.0" }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ name: "root", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "root", version: "1.0.0" }, "packages/a": { name: "a", version: "1.0.0" }, "packages/b": { name: "b", version: "2.0.0" } } }));
  assert.equal(await runCommand("version", { args: ["patch"], cwd: root, output: silentOutput([]), invokedAsBnpmx: false, options: { ...options, workspaces: true }, signal: new AbortController().signal }), 0);
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "1.0.0"); assert.equal(JSON.parse(await readFile(join(a, "package.json"), "utf8")).version, "1.0.1"); assert.equal(JSON.parse(await readFile(join(b, "package.json"), "utf8")).version, "2.0.1"); assert.equal(await readFile(join(a, "version-env"), "utf8"), "1.0.0>1.0.1");
  let lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")); assert.equal(lock.version, "1.0.0"); assert.equal(lock.packages["packages/a"].version, "1.0.1"); assert.equal(lock.packages["packages/b"].version, "2.0.1");
  assert.equal(await runCommand("version", { args: ["minor"], cwd: root, output: silentOutput([]), invokedAsBnpmx: false, options: { ...options, workspaceNames: ["a"], includeWorkspaceRoot: true }, signal: new AbortController().signal }), 0);
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "1.1.0"); assert.equal(JSON.parse(await readFile(join(a, "package.json"), "utf8")).version, "1.1.0"); assert.equal(JSON.parse(await readFile(join(b, "package.json"), "utf8")).version, "2.0.1"); lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")); assert.equal(lock.version, "1.1.0"); assert.equal(lock.packages[""].version, "1.1.0"); assert.equal(lock.packages["packages/a"].version, "1.1.0");
  git(root, "init", "-q"); git(root, "config", "user.name", "Better NPM Tests"); git(root, "config", "user.email", "bnpm@example.invalid"); git(root, "config", "commit.gpgsign", "false"); git(root, "config", "tag.gpgsign", "false"); git(root, "add", "."); git(root, "commit", "-q", "-m", "workspace versions"); git(root, "tag", "v3.0.0"); const head = git(root, "rev-parse", "HEAD");
  assert.equal(await runCommand("version", { args: ["from-git"], cwd: root, output: silentOutput([]), invokedAsBnpmx: false, options: { ...options, workspaces: true }, signal: new AbortController().signal }), 0);
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "1.1.0"); assert.equal(JSON.parse(await readFile(join(a, "package.json"), "utf8")).version, "3.0.0"); assert.equal(JSON.parse(await readFile(join(b, "package.json"), "utf8")).version, "3.0.0"); assert.equal(git(root, "rev-parse", "HEAD"), head); assert.equal(git(root, "tag"), "v3.0.0");
});

test("pack uses npm file-selection rules and produces deterministic verified metadata", async (t) => {
  const root = await fixture(t);
  const first = await packPackage(root);
  const second = await packPackage(root);
  assert.deepEqual(first.tarball, second.tarball);
  assert.equal(first.filename, "scope-fixture-1.2.3.tgz");
  assert.match(first.integrity, /^sha512-/);
  assert.match(first.shasum, /^[a-f0-9]{40}$/);
  assert.equal(first.size, first.tarball.length);
  assert.deepEqual(first.files.map((file) => file.path), ["cli.js", "dist/included.js", "entry.js", "LICENSE", "package.json", "README.md"]);
  assert.equal(first.files.find((file) => file.path === "cli.js")?.mode, 0o755);
  assert.ok(!first.tarball.includes(Buffer.from("never-pack-this")));
});

test("pack command supports dry-run and atomically writes to pack-destination", async (t) => {
  const root = await fixture(t);
  const destination = join(root, "artifacts");
  await mkdir(destination);
  const dryResults: unknown[] = [];
  assert.equal(await runCommand("pack", { args: [], cwd: root, output: silentOutput(dryResults), invokedAsBnpmx: false, options: { ...options, dryRun: true, packDestination: destination }, signal: new AbortController().signal }), 0);
  await assert.rejects(stat(join(destination, "scope-fixture-1.2.3.tgz")), { code: "ENOENT" });
  const results: unknown[] = [];
  assert.equal(await runCommand("pack", { args: [], cwd: root, output: silentOutput(results), invokedAsBnpmx: false, options: { ...options, packDestination: destination }, signal: new AbortController().signal }), 0);
  const bytes = await readFile(join(destination, "scope-fixture-1.2.3.tgz"));
  assert.equal(bytes.length, (await packPackage(root)).size);
  assert.equal(results.length, 1);
});

test("publish authenticates a scoped PUT and embeds the exact packed tarball", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, ".npmrc"), "//registry.example/team/:_authToken=publish-secret\n");
  const artifact = await packPackage(root);
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    return new Response(null, { status: 201 });
  };
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const result = await publishPackage({ artifact, paths, registry: new URL("https://registry.example/team/"), tag: "next", access: "public", otp: "123456", fetch: fetchMock });
  assert.equal(result.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://registry.example/team/%40scope%2Ffixture");
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer publish-secret");
  assert.equal(headers.get("npm-otp"), "123456");
  assert.equal(calls[0]?.init?.method, "PUT");
  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, any>;
  assert.equal(body["dist-tags"].next, "1.2.3");
  assert.equal(body.access, "public");
  assert.equal(body.versions["1.2.3"].dist.integrity, artifact.integrity);
  assert.deepEqual(Buffer.from(body._attachments[artifact.filename].data, "base64"), artifact.tarball);
});

test("staged publish posts the verified artifact and returns the exact stage id", async (t) => {
  const root = await fixture(t);
  const artifact = await packPackage(root);
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const stageId = "123e4567-e89b-42d3-a456-426614174000";
  const result = await publishPackage({ artifact, paths, registry: new URL("https://registry.example/"), stage: true, environment: {}, fetch: async (input, init) => {
    assert.equal(String(input), "https://registry.example/-/stage/package/%40scope%2Ffixture");
    assert.equal(init?.method, "POST");
    assert.equal(JSON.parse(String(init?.body)).versions[artifact.version].dist.integrity, artifact.integrity);
    return Response.json({ stageId }, { status: 201 });
  } });
  assert.equal(result.stageId, stageId);
});

test("publish refuses private packages and cross-origin redirects without leaking a second request", async (t) => {
  const root = await fixture(t);
  const artifact = await packPackage(root);
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  let calls = 0;
  const redirecting: typeof fetch = async () => {
    calls += 1;
    return new Response(null, { status: 307, headers: { location: "https://attacker.example/upload" } });
  };
  await assert.rejects(() => publishPackage({ artifact, paths, registry: new URL("https://registry.example/"), otp: "123456", fetch: redirecting }), /remain on the registry origin/);
  assert.equal(calls, 1);
  await assert.rejects(() => publishPackage({ artifact: { ...artifact, manifest: { ...artifact.manifest, private: true } }, paths, registry: new URL("https://registry.example/"), fetch: async () => { throw new Error("must not fetch"); } }), /marked private/);
});

test("publish verifies and attaches an exact Sigstore provenance bundle", async (t) => {
  const root = await fixture(t);
  const artifact = await packPackage(root);
  const subject = provenanceSubject(artifact);
  const bundle = {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: { payload: Buffer.from(JSON.stringify({ subject: [subject] })).toString("base64") },
    verificationMaterial: {},
  };
  const path = join(root, "provenance.json");
  await writeFile(path, JSON.stringify(bundle));
  let verified = 0;
  const provenance = await loadProvenance(artifact, path, { verify: async (value) => { verified += 1; assert.deepEqual(value, bundle); } });
  assert.equal(verified, 1);
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  let metadata: Record<string, any> | undefined;
  await publishPackage({ artifact, paths, registry: new URL("https://registry.example/"), provenance, fetch: async (_input, init) => {
    metadata = JSON.parse(String(init?.body));
    return new Response(null, { status: 201 });
  } });
  const attachment = metadata?._attachments[`${artifact.name}-${artifact.version}.sigstore`];
  assert.equal(attachment.content_type, bundle.mediaType);
  assert.deepEqual(JSON.parse(attachment.data), bundle);
  assert.equal(attachment.length, Buffer.byteLength(attachment.data));
});

test("provenance rejects a mismatched package digest before publish", async (t) => {
  const root = await fixture(t);
  const artifact = await packPackage(root);
  const subject = provenanceSubject(artifact);
  const bundle = {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: { payload: Buffer.from(JSON.stringify({ subject: [{ ...subject, digest: { sha512: "00" } }] })).toString("base64") },
  };
  const path = join(root, "bad-provenance.json");
  await writeFile(path, JSON.stringify(bundle));
  let verified = false;
  await assert.rejects(() => loadProvenance(artifact, path, { verify: async () => { verified = true; } }), /digest does not match/);
  assert.equal(verified, false);
});

test("automatic provenance produces a GitHub SLSA statement and transparency URL", async (t) => {
  const root = await fixture(t);
  const artifact = await packPackage(root);
  let statement: Record<string, any> | undefined;
  const bundle = await generateProvenance(artifact, {
    GITHUB_ACTIONS: "true",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token",
    GITHUB_REPOSITORY: "owner/repository",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_WORKFLOW_REF: "owner/repository/.github/workflows/release.yml@refs/heads/main",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "a".repeat(40),
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "2",
  }, async (payload, payloadType) => {
    assert.equal(payloadType, "application/vnd.in-toto+json");
    statement = JSON.parse(payload.toString("utf8"));
    return { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", dsseEnvelope: { payload: "e30=" }, verificationMaterial: { tlogEntries: [{ logIndex: "9" }] } };
  });
  assert.deepEqual(statement?.subject, [provenanceSubject(artifact)]);
  assert.equal(statement?.predicateType, "https://slsa.dev/provenance/v1");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const result = await publishPackage({ artifact, paths, registry: new URL("https://registry.example/"), access: "public", generateProvenance: true, provenanceGenerator: async () => bundle, environment: {}, fetch: async () => new Response(null, { status: 201 }) });
  assert.equal(result.provenance, true);
  assert.equal(result.transparencyLogUrl, "https://search.sigstore.dev/?logIndex=9");
});

test("trusted publishing exchanges a CI OIDC token without persisting or exposing it", async (t) => {
  const root = await fixture(t);
  const artifact = await packPackage(root);
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const calls: { url: string; authorization: string | null }[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.includes("/oidc/token/exchange/")) return Response.json({ token: "short-lived-publish-token" });
    return new Response(null, { status: 201 });
  };
  await publishPackage({ artifact, paths, registry: new URL("https://registry.example/team/"), environment: { GITLAB_CI: "true", NPM_ID_TOKEN: "ci-id-token" }, fetch: fetchMock });
  assert.deepEqual(calls, [
    { url: "https://registry.example/-/npm/v1/oidc/token/exchange/package/@scope%2ffixture", authorization: "Bearer ci-id-token" },
    { url: "https://registry.example/team/%40scope%2Ffixture", authorization: "Bearer short-lived-publish-token" },
  ]);
  assert.equal((await readFile(join(root, "package.json"), "utf8")).includes("short-lived-publish-token"), false);
});

test("pack and publish dry-run execute npm lifecycle phases in order", async (t) => {
  const root = await fixture(t);
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const append = (stage: string): string => `node -e "require('fs').appendFileSync('order.log','${stage}\\n')"`;
  manifest.scripts = {
    prepublishOnly: append("prepublishOnly"),
    prepack: append("prepack"),
    prepare: append("prepare"),
    postpack: append("postpack"),
    publish: append("publish"),
    postpublish: append("postpublish"),
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const approvals = ["@scope/fixture@1.2.3"];
  assert.equal(await runCommand("pack", { args: [], cwd: root, output: silentOutput([]), invokedAsBnpmx: false, options: { ...options, dryRun: true, allowDangerous: approvals }, signal: new AbortController().signal }), 0);
  assert.equal(await readFile(join(root, "order.log"), "utf8"), "prepack\nprepare\npostpack\n");
  await writeFile(join(root, "order.log"), "");
  assert.equal(await runCommand("publish", { args: [], cwd: root, output: silentOutput([]), invokedAsBnpmx: false, options: { ...options, dryRun: true, allowDangerous: approvals }, signal: new AbortController().signal }), 0);
  assert.equal(await readFile(join(root, "order.log"), "utf8"), "prepublishOnly\nprepack\nprepare\npostpack\npublish\npostpublish\n");
});

test("pack includes explicitly bundled dependencies and their production closure", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "bnpm-pack-bundle-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "package");
  const bundled = join(base, "store", "bundled");
  const nested = join(bundled, "node_modules", "nested");
  await mkdir(join(root, "node_modules"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "bundle-root", version: "1.0.0", dependencies: { bundled: "1.0.0" }, bundleDependencies: ["bundled"] }));
  await writeFile(join(bundled, "package.json"), JSON.stringify({ name: "bundled", version: "1.0.0", dependencies: { nested: "1.0.0" } }));
  await writeFile(join(bundled, "index.js"), "bundled\n");
  await writeFile(join(nested, "package.json"), JSON.stringify({ name: "nested", version: "1.0.0" }));
  await writeFile(join(nested, "index.js"), "nested\n");
  await symlink(bundled, join(root, "node_modules", "bundled"), process.platform === "win32" ? "junction" : "dir");
  const artifact = await packPackage(root);
  const paths = artifact.files.map((file) => file.path);
  assert.ok(paths.includes("node_modules/bundled/package.json"));
  assert.ok(paths.includes("node_modules/bundled/index.js"));
  assert.ok(paths.includes("node_modules/bundled/node_modules/nested/package.json"));
  assert.ok(paths.includes("node_modules/bundled/node_modules/nested/index.js"));
});
