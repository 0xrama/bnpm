import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBnpmPaths } from "../src/config/paths.js";
import { accessiblePackages, createPackageTrust, deprecatePackage, listDistTags, mutateDistTag, mutateOrganizationMember, mutatePackageOwner, mutatePackageStar, mutateRegistryProfile, mutateRegistryTeam, mutateStagedPackage, mutateTeamAccess, organizationMembers, packageAccess, packageOwners, packageTrust, pingRegistry, registryProfile, registryTeamEntries, revokePackageTrust, searchPackages, setPackageAccess, setRegistryProfile, stagedPackage, stagedPackages, starredPackages, unpublishPackage, viewPackage } from "../src/registry/operations.js";
import { diagnose } from "../src/commands/doctor.js";

test("registry view and search return bounded normalized package data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-registry-ops-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/pkg") return Response.json({ name: "pkg", "dist-tags": { latest: "2.0.0" }, versions: { "1.0.0": { name: "pkg", version: "1.0.0" }, "2.0.0": { name: "pkg", version: "2.0.0", description: "current" } } });
    if (url.pathname === "/-/v1/search") {
      assert.equal(url.searchParams.get("text"), "safe parser");
      assert.equal(url.searchParams.get("size"), "20");
      return Response.json({ objects: [{ package: { name: "pkg", version: "2.0.0", description: "current" }, score: {} }] });
    }
    throw new Error(`unexpected ${url.href}`);
  };
  const viewed = await viewPackage({ spec: "pkg@^1", paths, registry: new URL("https://registry.example/"), fetch: request });
  assert.equal(viewed.version, "1.0.0");
  assert.deepEqual(viewed["dist-tags"], { latest: "2.0.0" });
  const results = await searchPackages({ terms: ["safe", "parser"], paths, registry: new URL("https://registry.example/"), fetch: request });
  assert.deepEqual(results, [{ name: "pkg", version: "2.0.0", description: "current" }]);
});

test("authenticated dist-tag and deprecate mutations use exact registry routes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-registry-mutate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=registry-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const calls: { url: string; method: string; body?: string; authorization: string | null; otp: string | null }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", ...(init?.body === undefined || init.body === null ? {} : { body: String(init.body) }), authorization: new Headers(init?.headers).get("authorization"), otp: new Headers(init?.headers).get("npm-otp") });
    if (url.endsWith("/dist-tags")) return Response.json({ latest: "2.0.0", next: "3.0.0-beta.1", _etag: "ignored" });
    if (url.includes("/dist-tags/")) return new Response(null, { status: 204 });
    if (url.includes("?write=true")) return Response.json({ name: "@scope/pkg", versions: { "1.0.0": { name: "@scope/pkg", version: "1.0.0" }, "2.0.0": { name: "@scope/pkg", version: "2.0.0" } } });
    if ((init?.method ?? "GET") === "PUT") return new Response(null, { status: 204 });
    throw new Error(`unexpected ${url}`);
  };
  const common = { paths, registry: new URL("https://registry.example/"), fetch: request };
  assert.deepEqual(await listDistTags({ ...common, package: "@scope/pkg" }), { latest: "2.0.0", next: "3.0.0-beta.1" });
  await mutateDistTag({ ...common, action: "add", package: "@scope/pkg@2.0.0", tag: "stable", otp: "123456" });
  await mutateDistTag({ ...common, action: "remove", package: "@scope/pkg", tag: "next" });
  assert.deepEqual(await deprecatePackage({ ...common, package: "@scope/pkg@^1", message: "upgrade", otp: "654321" }), ["1.0.0"]);
  assert.equal(calls[1]?.url, "https://registry.example/-/package/@scope%2fpkg/dist-tags/stable");
  assert.equal(calls[1]?.body, JSON.stringify("2.0.0"));
  assert.equal(calls[1]?.authorization, "Bearer registry-token");
  assert.equal(calls[1]?.otp, "123456");
  const put = calls.at(-1);
  assert.equal(put?.url, "https://registry.example/@scope%2fpkg");
  assert.equal(JSON.parse(put?.body ?? "{}").versions["1.0.0"].deprecated, "upgrade");
  assert.equal(JSON.parse(put?.body ?? "{}").versions["2.0.0"].deprecated, undefined);
});

test("registry ping uses the canonical bounded health route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-registry-ping-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/team/:_authToken=ping-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const result = await pingRegistry({ paths, registry: new URL("https://registry.example/team/"), fetch: async (input, init) => {
    assert.equal(String(input), "https://registry.example/-/ping");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    return Response.json({ ok: true });
  } });
  assert.deepEqual(result, { registry: "https://registry.example/team/", details: { ok: true } });
});

test("unpublish removes an exact version transactionally and protects the last version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-unpublish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=registry-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const initial = { _id: "pkg", _rev: "1-a", name: "pkg", "dist-tags": { latest: "2.0.0", old: "1.0.0" }, versions: { "1.0.0": { name: "pkg", version: "1.0.0", dist: { tarball: "https://registry.example/pkg/-/pkg-1.0.0.tgz" } }, "2.0.0": { name: "pkg", version: "2.0.0", dist: { tarball: "https://registry.example/pkg/-/pkg-2.0.0.tgz" } } } };
  const calls: { url: string; method: string; body?: string }[] = [];
  let reads = 0;
  const request: typeof fetch = async (input, init) => {
    const url = String(input); const method = init?.method ?? "GET";
    calls.push({ url, method, ...(init?.body === undefined || init.body === null ? {} : { body: String(init.body) }) });
    if (method === "GET") { reads += 1; return Response.json(reads === 1 ? structuredClone(initial) : { ...initial, _rev: "2-b" }); }
    return new Response(null, { status: 204 });
  };
  const result = await unpublishPackage({ package: "pkg@1.0.0", paths, registry: new URL("https://registry.example/"), fetch: request, otp: "123456" });
  assert.deepEqual(result, { name: "pkg", version: "1.0.0", entirePackage: false });
  assert.equal(calls[1]?.url, "https://registry.example/pkg/-rev/1-a");
  const updated = JSON.parse(calls[1]?.body ?? "{}") as typeof initial;
  assert.deepEqual(Object.keys(updated.versions), ["2.0.0"]);
  assert.deepEqual(updated["dist-tags"], { latest: "2.0.0" });
  assert.equal(calls[3]?.url, "https://registry.example/pkg/-/pkg-1.0.0.tgz/-rev/2-b");
  const lastFetch: typeof fetch = async () => Response.json({ ...initial, versions: { "2.0.0": initial.versions["2.0.0"] }, "dist-tags": { latest: "2.0.0" } });
  await assert.rejects(() => unpublishPackage({ package: "pkg@2.0.0", paths, registry: new URL("https://registry.example/"), fetch: lastFetch }), /without --force/);
  assert.deepEqual(await unpublishPackage({ package: "pkg@2.0.0", paths, registry: new URL("https://registry.example/"), fetch: lastFetch, dryRun: true, force: true }), { name: "pkg", version: "2.0.0", entirePackage: true });
});

test("access and owner commands use authenticated exact registry mutations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-access-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=registry-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const calls: { path: string; method: string; body?: Record<string, unknown>; auth: string | null }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method, ...(init?.body === undefined || init.body === null ? {} : { body: JSON.parse(String(init.body)) as Record<string, unknown> }), auth: new Headers(init?.headers).get("authorization") });
    if (url.pathname.endsWith("/visibility")) return Response.json({ public: true });
    if (url.pathname.endsWith("/collaborators")) return Response.json({ alice: "write" });
    if (url.pathname.includes("org.couchdb.user")) return Response.json({ name: "bob", email: "bob@example.test" });
    if (url.pathname === "/@scope%2fpkg") return Response.json({ _id: "@scope/pkg", _rev: "3-c", maintainers: [{ name: "alice", email: "alice@example.test" }] });
    return new Response(null, { status: 204 });
  };
  const common = { paths, registry: new URL("https://registry.example/"), fetch: request, otp: "123456" };
  assert.deepEqual(await packageAccess({ ...common, package: "@scope/pkg", action: "status" }), { public: true });
  assert.deepEqual(await packageAccess({ ...common, package: "@scope/pkg", action: "collaborators" }), { alice: "read-write" });
  await setPackageAccess({ ...common, package: "@scope/pkg", access: "private" });
  await setPackageAccess({ ...common, package: "@scope/pkg", mfa: "automation" });
  await mutateTeamAccess({ ...common, package: "@scope/pkg", team: "@scope:core", permission: "read-only" });
  assert.deepEqual(await packageOwners({ ...common, package: "@scope/pkg" }), [{ name: "alice", email: "alice@example.test" }]);
  assert.deepEqual(await mutatePackageOwner({ ...common, package: "@scope/pkg", user: "bob", action: "add" }), [{ name: "alice", email: "alice@example.test" }, { name: "bob", email: "bob@example.test" }]);
  assert.ok(calls.every((call) => call.auth === "Bearer registry-token"));
  assert.deepEqual(calls.find((call) => call.path.endsWith("/access") && call.body?.access)?.body, { access: "restricted" });
  assert.deepEqual(calls.find((call) => call.path.includes("/-/team/"))?.body, { package: "@scope/pkg", permissions: "read-only" });
  assert.deepEqual(calls.at(-1)?.body?.maintainers, [{ name: "alice", email: "alice@example.test" }, { name: "bob", email: "bob@example.test" }]);
});

test("accessible package listing falls back from an organization to a user", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-access-packages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=registry-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const calls: string[] = [];
  const request: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/-/org/alice/package") return new Response("not found", { status: 404 });
    if (path === "/-/user/alice/package") return Response.json({ pkg: "write", readonly: "read" });
    throw new Error(`unexpected ${path}`);
  };
  const result = await accessiblePackages({ paths, owner: "alice", registry: new URL("https://registry.example/"), fetch: request });
  assert.deepEqual(result, { pkg: "read-write", readonly: "read-only" });
  assert.deepEqual(calls, ["/-/org/alice/package", "/-/user/alice/package"]);
});

test("package favorites preserve revision data and list deterministic names", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-stars-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=registry-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  let mutation: Record<string, unknown> | undefined;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/pkg" && (init?.method ?? "GET") === "GET") return Response.json({ _id: "pkg", _rev: "1-a", users: { alice: true } });
    if (url.pathname === "/pkg" && init?.method === "PUT") { mutation = JSON.parse(String(init.body)) as Record<string, unknown>; return Response.json({ ok: true }); }
    if (url.pathname === "/-/_view/starredByUser") { assert.equal(url.searchParams.get("key"), '"bob"'); return Response.json({ rows: [{ value: "zeta" }, { value: "alpha" }] }); }
    throw new Error(`unexpected ${url.href}`);
  };
  const common = { paths, registry: new URL("https://registry.example/"), fetch: request };
  await mutatePackageStar({ ...common, package: "pkg", user: "bob", starred: true });
  assert.deepEqual(mutation, { _id: "pkg", _rev: "1-a", users: { alice: true, bob: true } });
  assert.deepEqual(await starredPackages({ ...common, user: "bob" }), ["alpha", "zeta"]);
});

test("organization and team administration uses canonical authenticated routes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-org-team-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=registry-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const calls: { path: string; search: string; method: string; body?: Record<string, unknown>; otp: string | null }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, search: url.search, method, ...(init?.body === undefined || init.body === null ? {} : { body: JSON.parse(String(init.body)) as Record<string, unknown> }), otp: new Headers(init?.headers).get("npm-otp") });
    if (method === "GET" && url.pathname.endsWith("/user") && url.pathname.startsWith("/-/org/")) return Response.json({ alice: "owner", bob: "developer" });
    if (method === "GET" && url.pathname.endsWith("/team")) return Response.json({ teams: ["acme:core"] });
    return new Response(null, { status: 204 });
  };
  const common = { paths, registry: new URL("https://registry.example/"), fetch: request, otp: "123456" };
  assert.deepEqual(await organizationMembers({ ...common, organization: "@acme" }), { alice: "owner", bob: "developer" });
  await mutateOrganizationMember({ ...common, organization: "acme", user: "carol", role: "admin" });
  await mutateRegistryTeam({ ...common, action: "create", entity: "@acme:core" });
  await mutateRegistryTeam({ ...common, action: "add", entity: "acme:core", user: "carol" });
  assert.deepEqual(await registryTeamEntries({ ...common, entity: "acme" }), ["acme:core"]);
  assert.deepEqual(calls[1]?.body, { user: "carol", role: "admin" });
  assert.equal(calls[2]?.path, "/-/org/acme/team");
  assert.deepEqual(calls[2]?.body, { name: "core" });
  assert.equal(calls[3]?.path, "/-/team/acme/core/user");
  assert.ok(calls.slice(1, 4).every((call) => call.otp === "123456"));
});

test("profile reads and preserves writable fields during non-secret updates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=registry-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  let body: Record<string, unknown> | undefined;
  const request: typeof fetch = async (_input, init) => {
    if ((init?.method ?? "GET") === "GET") return Response.json({ name: "alice", email: "old@example.test", fullname: "Alice", twitter: null, tfa: { mode: "auth-only" } });
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ ...body, name: "alice" });
  };
  const common = { paths, registry: new URL("https://registry.example/"), fetch: request, otp: "123456" };
  assert.equal((await registryProfile(common)).name, "alice");
  const updated = await setRegistryProfile({ ...common, key: "email", value: "new@example.test" });
  assert.equal(updated.email, "new@example.test");
  assert.deepEqual(body, { email: "new@example.test", fullname: "Alice", twitter: null });
  await assert.rejects(() => setRegistryProfile({ ...common, key: "password", value: "secret" }), /cannot be set non-interactively/);
  await mutateRegistryProfile({ ...common, change: { password: { old: "old-secret", new: "new-secret" } }, preserveWritable: true });
  assert.deepEqual(body, { email: "old@example.test", fullname: "Alice", twitter: null, password: { old: "old-secret", new: "new-secret" } });
  await mutateRegistryProfile({ ...common, change: { tfa: { password: "account-secret", mode: "auth-and-writes" } } });
  assert.deepEqual(body, { tfa: { password: "account-secret", mode: "auth-and-writes" } });
});

test("staged package administration validates ids and exact mutation routes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=registry-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const calls: { path: string; method: string }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET"; calls.push({ path: url.pathname, method });
    if (url.pathname === "/-/stage" && method === "GET") return Response.json({ items: [{ id, name: "pkg", version: "1.0.0" }], total: 1 });
    if (url.pathname === `/-/stage/${id}` && method === "GET") return Response.json({ id, name: "pkg", version: "1.0.0" });
    return new Response(null, { status: 204 });
  };
  const common = { paths, registry: new URL("https://registry.example/"), fetch: request, otp: "123456" };
  assert.equal((await stagedPackages(common))[0]?.id, id);
  assert.equal((await stagedPackage({ ...common, id })).name, "pkg");
  await mutateStagedPackage({ ...common, id, action: "approve" });
  await mutateStagedPackage({ ...common, id, action: "reject" });
  assert.deepEqual(calls.slice(-2), [{ path: `/-/stage/${id}/approve`, method: "POST" }, { path: `/-/stage/${id}`, method: "DELETE" }]);
  await assert.rejects(() => stagedPackage({ ...common, id: "not-a-uuid" }), /UUID/);
});

test("trusted publisher records accept array responses and revoke exact ids", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=registry-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const calls: { path: string; method: string; body?: unknown; otp: string | null }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET"; calls.push({ path: url.pathname, method, ...(init?.body === undefined || init.body === null ? {} : { body: JSON.parse(String(init.body)) }), otp: new Headers(init?.headers).get("npm-otp") });
    if (method === "GET") return Response.json([{ id: "trust:1", type: "github", claims: { repository: "owner/repo" }, permissions: ["createPackage"] }]);
    if (method === "POST") return Response.json([{ id: "trust:2", type: "github" }]);
    return new Response(null, { status: 204 });
  };
  const common = { paths, registry: new URL("https://registry.example/"), fetch: request, otp: "123456" };
  assert.equal((await packageTrust({ ...common, package: "@scope/pkg" }))[0]?.type, "github");
  const configuration = { type: "github", claims: { repository: "owner/repo", workflow_ref: { file: "release.yml" } }, permissions: ["createPackage"] };
  assert.equal((await createPackageTrust({ ...common, package: "@scope/pkg", configuration }))[0]?.id, "trust:2");
  assert.deepEqual(calls.at(-1), { path: "/-/package/@scope%2fpkg/trust", method: "POST", body: [configuration], otp: "123456" });
  await revokePackageTrust({ ...common, package: "@scope/pkg", id: "trust:1" });
  assert.deepEqual(calls.at(-1), { path: "/-/package/@scope%2fpkg/trust/trust%3A1", method: "DELETE", otp: "123456" });
});

test("doctor composes Node, Git, registry, and cache diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root, BNPM_CACHE_HOME: join(root, "cache-root") } });
  const checks = await diagnose({ cwd: root, paths, registry: new URL("https://registry.example/"), git: async () => "git version test", fetch: async () => Response.json({ ok: true }) });
  assert.deepEqual(checks.map(({ name, ok }) => ({ name, ok })), [
    { name: "node", ok: true },
    { name: "git", ok: true },
    { name: "registry", ok: true },
    { name: "cache", ok: true },
  ]);
});
