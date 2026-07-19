import assert from "node:assert/strict";
import { test } from "node:test";
import { createLockfile } from "../src/lockfile/index.js";
import type { PackageDocument, PackageVersionManifest } from "../src/registry/types.js";
import { RegistryResolver, ResolutionError } from "../src/resolver/registry-resolver.js";
import type { Requirement } from "../src/resolver/types.js";

const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;

function version(name: string, value: string, dependencies: Readonly<Record<string, string>> = {}): PackageVersionManifest {
  return {
    name,
    version: value,
    dependencies,
    dist: { integrity, tarball: `https://registry.example/${encodeURIComponent(name)}/-/${value}.tgz` },
  };
}

const documents: Record<string, PackageDocument> = {
  alpha: {
    name: "alpha",
    "dist-tags": { latest: "2.0.0" },
    versions: {
      "1.0.0": version("alpha", "1.0.0"),
      "1.1.0": version("alpha", "1.1.0", { shared: "^1.0.0" }),
      "2.0.0": version("alpha", "2.0.0"),
    },
    time: { "1.1.0": "2026-01-01T00:00:00.000Z" },
  },
  shared: {
    name: "shared",
    "dist-tags": { latest: "1.0.0" },
    versions: { "1.0.0": version("shared", "1.0.0", { alpha: "^1.0.0" }) },
  },
};

test("resolver selects deterministic exact identities for ranges, aliases, and cycles", async () => {
  const calls: string[] = [];
  const resolver = new RegistryResolver({
    async packageDocument(name) {
      calls.push(name);
      const document = documents[name];
      if (!document) throw new Error(`missing fixture ${name}`);
      return document;
    },
  });
  const requirements: Requirement[] = [
    { name: "renamed", specifier: "npm:alpha@^1.0.0", kind: "dependency" },
    { name: "alpha", specifier: "latest", kind: "dev" },
  ];
  const graph = await resolver.resolve(requirements);
  assert.equal(graph.roots.get("renamed"), "alpha@1.1.0");
  assert.equal(graph.roots.get("alpha"), "alpha@2.0.0");
  assert.equal(graph.packages.get("alpha@1.1.0")?.dependencies.get("shared"), "shared@1.0.0");
  assert.equal(graph.packages.get("shared@1.0.0")?.dependencies.get("alpha"), "alpha@1.1.0");
  assert.deepEqual(calls.sort(), ["alpha", "shared"]);

  const first = createLockfile(graph, requirements, { registry: "https://registry.example/", recentReleaseHours: 6 });
  const second = createLockfile(graph, [...requirements].reverse(), { registry: "https://registry.example/", recentReleaseHours: 6 });
  assert.equal(first, second);
  assert.match(first, /^importers:/m);
  assert.match(first, /alpha@1\.1\.0:/);
  assert.match(first, /type: dev/);
  assert.equal(first.endsWith("\n"), true);
});

test("resolver fails closed for unsatisfied and weak-integrity versions", async () => {
  const resolver = new RegistryResolver({
    async packageDocument() {
      const document = documents.alpha;
      if (!document) throw new Error("missing alpha fixture");
      return document;
    },
  });
  await assert.rejects(
    () => resolver.resolve([{ name: "alpha", specifier: "^9.0.0", kind: "dependency" }]),
    ResolutionError,
  );
  const weak: PackageVersionManifest = {
    name: "weak",
    version: "1.0.0",
    dist: { tarball: "https://registry.example/weak/-/1.0.0.tgz" },
  };
  const weakResolver = new RegistryResolver({
    async packageDocument() { return { name: "weak", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": weak } }; },
  });
  await assert.rejects(() => weakResolver.resolve([{ name: "weak", specifier: "latest", kind: "dependency" }]), /integrity/);
});

test("resolver selects the newest mature direct and transitive versions", async () => {
  const toolOld = version("tool", "1.0.0", { child: "^1.0.0" });
  const toolNew = version("tool", "1.1.0", { child: "^1.0.0" });
  const childOld = version("child", "1.0.0"); const childNew = version("child", "1.1.0");
  const provider = { async packageDocument(name: string): Promise<PackageDocument> {
    if (name === "tool") return { name, "dist-tags": { latest: "1.1.0" }, versions: { "1.0.0": toolOld, "1.1.0": toolNew }, time: { "1.0.0": "2026-01-01T00:00:00.000Z", "1.1.0": "2026-07-18T23:30:00.000Z" } };
    return { name, "dist-tags": { latest: "1.1.0" }, versions: { "1.0.0": childOld, "1.1.0": childNew }, time: { "1.0.0": "2026-01-01T00:00:00.000Z", "1.1.0": "2026-07-18T23:30:00.000Z" } };
  } };
  const resolver = new RegistryResolver(provider, { minimumReleaseAgeMilliseconds: 24 * 60 * 60 * 1000, now: new Date("2026-07-19T00:00:00.000Z") });
  const graph = await resolver.resolve([{ name: "tool", specifier: "latest", kind: "dependency" }]);
  assert.equal(graph.roots.get("tool"), "tool@1.0.0"); assert.equal(graph.packages.get("tool@1.0.0")?.dependencies.get("child"), "child@1.0.0");
  const allowed = new RegistryResolver(provider, { minimumReleaseAgeMilliseconds: 24 * 60 * 60 * 1000, now: new Date("2026-07-19T00:00:00.000Z"), allowedRecentVersions: new Set(["tool@1.1.0", "child@1.1.0"]) });
  const allowedGraph = await allowed.resolve([{ name: "tool", specifier: "latest", kind: "dependency" }]); assert.equal(allowedGraph.roots.get("tool"), "tool@1.1.0"); assert.equal(allowedGraph.packages.get("tool@1.1.0")?.dependencies.get("child"), "child@1.1.0");
});

test("resolver installs compatible peers and applies deterministic overrides", async () => {
  const host: PackageDocument = {
    name: "host",
    "dist-tags": { latest: "2.0.0" },
    versions: { "1.0.0": version("host", "1.0.0"), "2.0.0": version("host", "2.0.0") },
  };
  const pluginManifest = version("plugin", "1.0.0");
  pluginManifest.peerDependencies = { host: "^1.0.0" };
  const plugin: PackageDocument = { name: "plugin", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": pluginManifest } };
  const provider = {
    async packageDocument(name: string) {
      const value = name === "host" ? host : name === "plugin" ? plugin : undefined;
      if (!value) throw new Error(name);
      return value;
    },
  };
  const resolver = new RegistryResolver(provider, { overrides: { host: "1.0.0" } });
  const graph = await resolver.resolve([
    { name: "host", specifier: "latest", kind: "dependency" },
    { name: "plugin", specifier: "1.0.0", kind: "dependency" },
  ]);
  assert.equal(graph.roots.get("host"), "host@1.0.0");
  const pluginId = [...graph.packages.keys()].find((id) => id.startsWith("plugin@1.0.0("));
  assert.equal(pluginId === undefined ? undefined : graph.packages.get(pluginId)?.dependencies.get("host"), "host@1.0.0");

  const conflictingManifest = { ...pluginManifest, dependencies: { host: "2.0.0" } };
  const conflictResolver = new RegistryResolver({
    async packageDocument(name) {
      return name === "host" ? host : { ...plugin, versions: { "1.0.0": conflictingManifest } };
    },
  });
  await assert.rejects(
    () => conflictResolver.resolve([{ name: "plugin", specifier: "1.0.0", kind: "dependency" }]),
    /requires peer host/,
  );
});

test("resolver skips incompatible optional packages and fails incompatible required roots", async () => {
  const incompatible = version("native", "1.0.0");
  incompatible.os = ["linux"];
  const parent = version("parent", "1.0.0");
  parent.optionalDependencies = { native: "1.0.0" };
  const provider = { async packageDocument(name: string) { const manifest = name === "native" ? incompatible : parent; return { name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": manifest } }; } };
  const resolver = new RegistryResolver(provider, { platform: "darwin" });
  const graph = await resolver.resolve([{ name: "parent", specifier: "1.0.0", kind: "dependency" }]);
  assert.equal(graph.packages.has("native@1.0.0"), false);
  await assert.rejects(() => resolver.resolve([{ name: "native", specifier: "1.0.0", kind: "dependency" }]), /does not support operating system/);

  const libcManifest = version("native", "1.0.0"); libcManifest.libc = ["musl"];
  const libcProvider = { async packageDocument() { return { name: "native", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": libcManifest } }; } };
  const libcResolver = new RegistryResolver(libcProvider, { platform: "linux", libc: "glibc" });
  await assert.rejects(() => libcResolver.resolve([{ name: "native", specifier: "1.0.0", kind: "dependency" }]), /does not support C library glibc/);
});

test("resolver does not auto-install an absent optional peer", async () => {
  const parent = version("parent", "1.0.0");
  parent.peerDependencies = { enormous: "^1.0.0" };
  parent.peerDependenciesMeta = { enormous: { optional: true } };
  const calls: string[] = [];
  const resolver = new RegistryResolver({
    async packageDocument(name) {
      calls.push(name);
      if (name !== "parent") throw new Error(`optional peer ${name} should not be fetched`);
      return { name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": parent } };
    },
  });
  const graph = await resolver.resolve([{ name: "parent", specifier: "1.0.0", kind: "dependency" }]);
  assert.deepEqual([...graph.packages.keys()], ["parent@1.0.0"]);
  assert.deepEqual(calls, ["parent"]);
});

test("resolver creates distinct deterministic contexts for the same package under different peers", async () => {
  const host: PackageDocument = { name: "host", "dist-tags": { latest: "2.0.0" }, versions: { "1.0.0": version("host", "1.0.0"), "2.0.0": version("host", "2.0.0") } };
  const pluginManifest = version("plugin", "1.0.0"); pluginManifest.peerDependencies = { host: ">=1 <3" };
  const plugin: PackageDocument = { name: "plugin", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": pluginManifest } };
  const left = version("left", "1.0.0", { host: "1.0.0", plugin: "1.0.0" });
  const right = version("right", "1.0.0", { host: "2.0.0", plugin: "1.0.0" });
  const resolver = new RegistryResolver({ async packageDocument(name) {
    if (name === "host") return host; if (name === "plugin") return plugin;
    const manifest = name === "left" ? left : right;
    return { name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": manifest } };
  } });
  const graph = await resolver.resolve([{ name: "left", specifier: "1.0.0", kind: "dependency" }, { name: "right", specifier: "1.0.0", kind: "dependency" }]);
  const pluginIds = [...graph.packages.keys()].filter((id) => id.startsWith("plugin@1.0.0("));
  assert.equal(pluginIds.length, 2);
  assert.notEqual(pluginIds[0], pluginIds[1]);
});

test("root peer resolution is independent of root name order and rejects conflicts", async () => {
  const host: PackageDocument = { name: "z-host", "dist-tags": { latest: "2.0.0" }, versions: { "1.0.0": version("z-host", "1.0.0"), "2.0.0": version("z-host", "2.0.0") } };
  const consumerManifest = version("a-consumer", "1.0.0");
  consumerManifest.peerDependencies = { "z-host": "^1.0.0" };
  const consumer: PackageDocument = { name: "a-consumer", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": consumerManifest } };
  const resolver = new RegistryResolver({ async packageDocument(name) { return name === "z-host" ? host : consumer; } });
  const graph = await resolver.resolve([
    { name: "a-consumer", specifier: "1.0.0", kind: "dependency" },
    { name: "z-host", specifier: "1.0.0", kind: "dependency" },
  ]);
  const consumerId = [...graph.packages.keys()].find((id) => id.startsWith("a-consumer@1.0.0("));
  assert.equal(consumerId === undefined ? undefined : graph.packages.get(consumerId)?.dependencies.get("z-host"), "z-host@1.0.0");
  await assert.rejects(() => resolver.resolve([
    { name: "a-consumer", specifier: "1.0.0", kind: "dependency" },
    { name: "z-host", specifier: "2.0.0", kind: "dependency" },
  ]), /requires peer z-host/);
});

test("cyclic peer dependencies fail deterministically", async () => {
  const left = version("left-peer", "1.0.0"); left.peerDependencies = { "right-peer": "1.0.0" };
  const right = version("right-peer", "1.0.0"); right.peerDependencies = { "left-peer": "1.0.0" };
  const resolver = new RegistryResolver({ async packageDocument(name) {
    const manifest = name === "left-peer" ? left : right;
    return { name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": manifest } };
  } });
  await assert.rejects(() => resolver.resolve([
    { name: "left-peer", specifier: "1.0.0", kind: "dependency" },
    { name: "right-peer", specifier: "1.0.0", kind: "dependency" },
  ]), /cyclic peer dependency/);
});
