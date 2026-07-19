import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBnpmPaths } from "../src/config/paths.js";
import { createRegistryToken, registryLegacyLogin, registryLogin, registryLogout, registryTokens, registryWhoami, revokeRegistryTokens } from "../src/registry/account.js";

test("web login polls, persists an owner-only token, identifies, and logs out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-account-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const registry = new URL("https://registry.example/team/");
  const calls: { url: string; method: string; authorization: string | null }[] = [];
  let poll = 0;
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
    if (url === "https://registry.example/-/v1/login") return Response.json({ loginUrl: "https://accounts.example/login?id=1", doneUrl: "https://registry.example/-/v1/done?id=1" });
    if (url.includes("/-/v1/done")) {
      poll += 1;
      return poll === 1 ? Response.json({}, { status: 202, headers: { "retry-after": "1" } }) : Response.json({ token: "account-token" });
    }
    if (url === "https://registry.example/-/whoami") return Response.json({ username: "developer" });
    if (url.includes("/-/user/token/")) return new Response(null, { status: 204 });
    throw new Error(`unexpected request ${url}`);
  };
  let opened: string | undefined;
  let waited = 0;
  const login = await registryLogin({ paths, registry, fetch: request, open: async (url) => { opened = url.href; }, wait: async (milliseconds) => { waited += milliseconds; } });
  assert.equal(opened, "https://accounts.example/login?id=1");
  assert.equal(login.registry, registry.href);
  assert.equal(waited, 1000);
  assert.equal(await readFile(paths.userNpmrc, "utf8"), "//registry.example/team/:_authToken=account-token\n");
  assert.equal((await stat(paths.userNpmrc)).mode & 0o777, 0o600);
  assert.equal(await registryWhoami({ paths, registry, fetch: request }), "developer");
  assert.equal(calls.at(-1)?.authorization, "Bearer account-token");
  assert.equal(await registryLogout({ paths, registry, fetch: request }), registry.href);
  assert.equal(calls.at(-1)?.authorization, "Bearer account-token");
  assert.equal(await readFile(paths.userNpmrc, "utf8"), "");
});

test("web login rejects unsafe browser and polling URLs before opening", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-account-unsafe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  let opened = false;
  await assert.rejects(() => registryLogin({
    paths,
    registry: new URL("https://registry.example/"),
    fetch: async () => Response.json({ loginUrl: "javascript:alert(1)", doneUrl: "https://registry.example/done" }),
    open: async () => { opened = true; },
  }), /unsafe login URL/);
  assert.equal(opened, false);
});

test("explicit legacy login performs the CouchDB revision challenge without persisting plaintext credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-account-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const calls: { path: string; search: string; method: string; authorization: string | null; body?: Record<string, unknown> }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, search: url.search, method, authorization: new Headers(init?.headers).get("authorization"), ...(init?.body === undefined || init.body === null ? {} : { body: JSON.parse(String(init.body)) as Record<string, unknown> }) });
    if (method === "PUT" && !url.pathname.includes("/-rev/")) return Response.json({ error: "conflict" }, { status: 409 });
    if (method === "GET") return Response.json({ _id: "org.couchdb.user:alice", _rev: "2-rev", name: "alice", roles: ["developer"], email: "alice@example.test" });
    return Response.json({ ok: true, token: "legacy-session-token" });
  };
  const result = await registryLegacyLogin({ paths, username: "alice", password: "account-password", registry: new URL("https://registry.example/"), fetch: request, otp: "123456" });
  assert.deepEqual(result, { registry: "https://registry.example/", username: "alice", created: false });
  assert.deepEqual(calls.map(({ path, method }) => ({ path, method })), [
    { path: "/-/user/org.couchdb.user:alice", method: "PUT" },
    { path: "/-/user/org.couchdb.user:alice", method: "GET" },
    { path: "/-/user/org.couchdb.user:alice/-rev/2-rev", method: "PUT" },
  ]);
  assert.equal(calls[2]?.authorization, `Basic ${Buffer.from("alice:account-password").toString("base64")}`);
  assert.deepEqual(calls[2]?.body?.roles, ["developer"]);
  const npmrc = await readFile(paths.userNpmrc, "utf8");
  assert.match(npmrc, /legacy-session-token/);
  assert.doesNotMatch(npmrc, /account-password/);
});

test("token listing emits unambiguous safe ids and revocation resolves an exact key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-token-admin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=account-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const deleted: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer account-token");
    if ((init?.method ?? "GET") === "DELETE") { deleted.push(url.pathname); return new Response(null, { status: 204 }); }
    return Response.json({ objects: [
      { key: "abcdef111111", name: "publish", created: "2026-01-01", readonly: false },
      { key: "abcdef222222", name: "read", created: "2026-01-02", readonly: true, cidr_whitelist: ["192.0.2.0/24"] },
    ], urls: {} });
  };
  assert.deepEqual(await registryTokens({ paths, registry: new URL("https://registry.example/"), fetch: request }), [
    { id: "abcdef1", name: "publish", created: "2026-01-01", readonly: false, cidr: [] },
    { id: "abcdef2", name: "read", created: "2026-01-02", readonly: true, cidr: ["192.0.2.0/24"] },
  ]);
  assert.deepEqual(await revokeRegistryTokens({ ids: ["abcdef1"], paths, registry: new URL("https://registry.example/"), fetch: request, otp: "123456" }), ["abcdef1"]);
  assert.deepEqual(deleted, ["/-/npm/v1/tokens/token/abcdef111111"]);
  await assert.rejects(() => revokeRegistryTokens({ ids: ["abcdef"], paths, registry: new URL("https://registry.example/"), fetch: request }), /Ambiguous/);
});

test("token creation sends a masked-input password only in the bounded authenticated request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-token-create-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=account-token\n");
  const paths = createBnpmPaths({ cwd: root, home: root, temp: root, platform: "linux", environment: { HOME: root } });
  const request: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://registry.example/-/npm/v1/tokens");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer account-token");
    assert.equal(new Headers(init?.headers).get("npm-otp"), "123456");
    assert.deepEqual(JSON.parse(String(init?.body)), { name: "release", readonly: true, password: "account-password" });
    return Response.json({ token: "npm_created_secret", name: "release", created: "2026-07-19", readonly: true });
  };
  assert.deepEqual(await createRegistryToken({ paths, password: "account-password", body: { name: "release", readonly: true }, registry: new URL("https://registry.example/"), fetch: request, otp: "123456" }), { token: "npm_created_secret", name: "release", created: "2026-07-19", readonly: true });
});
