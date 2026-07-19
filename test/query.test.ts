import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichQuery, queryResolutionGraph, QueryError } from "../src/commands/query.js";
import type { ResolvedPackage, ResolutionGraph } from "../src/resolver/types.js";
import { createBnpmPaths } from "../src/config/paths.js";

function pkg(id: string, name: string, version: string, dependencies: ReadonlyMap<string, string> = new Map(), source: ResolvedPackage["source"] = "registry", metadata: Readonly<Record<string, unknown>> = {}): ResolvedPackage {
  return { id, name, version, integrity: `sha512-${Buffer.alloc(64).toString("base64")}`, tarball: new URL(`https://registry.example/${name}.tgz`), source, manifest: { name, version, ...metadata, dist: { tarball: `https://registry.example/${name}.tgz` } } as ResolvedPackage["manifest"], dependencies };
}

test("query selects deterministic lock graph metadata by name, type, attributes, and security state", () => {
  const graph: ResolutionGraph = {
    roots: new Map([["renamed", "alpha@1.2.0"], ["tool", "tool@2.0.0"]]),
    packages: new Map([
      ["alpha@1.2.0", pkg("alpha@1.2.0", "alpha", "1.2.0", new Map([["leaf", "leaf@1.0.0"]]), "registry", { license: "MIT", scripts: { postinstall: "node setup.js" } })],
      ["leaf@1.0.0", pkg("leaf@1.0.0", "leaf", "1.0.0", new Map(), "registry", { license: "ISC" })],
      ["tool@2.0.0", pkg("tool@2.0.0", "tool", "2.0.0", new Map(), "git")],
    ]),
  };
  const requirements = [
    { name: "renamed", specifier: "npm:alpha@^1", kind: "dev" as const },
    { name: "tool", specifier: "git+https://example/tool.git", kind: "dependency" as const },
  ];
  assert.deepEqual(queryResolutionGraph(graph, graph.roots, requirements, new Set(["tool@2.0.0"]), "#renamed").map((value) => value.id), ["alpha@1.2.0"]);
  assert.deepEqual(queryResolutionGraph(graph, graph.roots, requirements, new Set(), ".dev:has(#leaf)").map((value) => value.name), ["alpha"]);
  assert.deepEqual(queryResolutionGraph(graph, graph.roots, requirements, new Set(["tool@2.0.0"]), "[source=git]:dangerous").map((value) => value.name), ["tool"]);
  assert.deepEqual(queryResolutionGraph(graph, graph.roots, requirements, new Set(), "[version^=1],:empty").map((value) => value.name), ["alpha", "leaf", "tool"]);
  assert.throws(() => queryResolutionGraph(graph, graph.roots, requirements, new Set(), "[type=made-up]"), QueryError);
});

test("query supports npm-style graph combinators, group propagation, logical pseudos, semver, and manifest attributes", () => {
  const graph: ResolutionGraph = {
    roots: new Map([["alpha", "alpha@1.2.0"], ["tool", "tool@2.0.0"]]),
    packages: new Map([
      ["alpha@1.2.0", pkg("alpha@1.2.0", "alpha", "1.2.0", new Map([["leaf", "leaf@1.0.0"]]), "registry", { license: "MIT", scripts: { postinstall: "node setup.js" } })],
      ["leaf@1.0.0", pkg("leaf@1.0.0", "leaf", "1.0.0", new Map(), "registry", { license: "ISC" })],
      ["tool@2.0.0", pkg("tool@2.0.0", "tool", "2.0.0", new Map(), "git", { private: true, engines: { node: ">=22" } })],
    ]),
  };
  const requirements = [
    { name: "alpha", specifier: "^1", kind: "dev" as const },
    { name: "tool", specifier: "git+https://example/tool.git", kind: "dependency" as const },
  ];
  const names = (selector: string): readonly string[] => queryResolutionGraph(graph, graph.roots, requirements, new Set(), selector, { name: "root", version: "1.0.0", private: true }).map((value) => value.name);
  assert.deepEqual(names(":root > .dev"), ["alpha"]);
  assert.deepEqual(names(":root > * > #leaf"), ["leaf"]);
  assert.deepEqual(names(".dev"), ["alpha", "leaf"]);
  assert.deepEqual(names("#alpha@^1.0.0:not(:empty)"), ["alpha"]);
  assert.deepEqual(names(":is(#leaf,#tool)"), ["leaf", "tool"]);
  assert.deepEqual(names(":has(> #leaf)"), ["alpha"]);
  assert.deepEqual(names("#alpha ~ #tool"), ["tool"]);
  assert.deepEqual(names("[license=MIT]:attr(scripts,[postinstall])"), ["alpha"]);
  assert.deepEqual(names(":semver(^1.0.0)"), ["root", "alpha", "leaf"]);
  assert.deepEqual(names(":type(git):private"), ["tool"]);
  assert.deepEqual(names(":semver(22.0.0,:attr(engines,[node]),satisfies)"), ["tool"]);
  assert.deepEqual(names(":root"), ["root"]);
  assert.deepEqual(names(":outdated(major)"), []);
  assert.throws(() => names(":outdated(breaking)"), /unknown outdated category/);
});

test("query filters registry-enriched outdated and vulnerability context", () => {
  const graph: ResolutionGraph = { roots: new Map([["alpha", "alpha@1.0.0"]]), packages: new Map([["alpha@1.0.0", pkg("alpha@1.0.0", "alpha", "1.0.0")]]) };
  const requirements = [{ name: "alpha", specifier: "^1", kind: "dependency" as const }];
  const enrichment = {
    outdated: new Map([["alpha@1.0.0", { categories: new Set(["any", "minor", "in-range"]), versions: ["1.0.0", "1.1.0"] }]]),
    advisories: new Map([["alpha@1.0.0", [{ id: 1, packageName: "alpha", title: "unsafe", severity: "high" as const, vulnerableVersions: "<=1.0.0", cwe: ["CWE-1333"] }]]]),
  };
  const names = (selector: string): readonly string[] => queryResolutionGraph(graph, graph.roots, requirements, new Set(), selector, { name: "root", version: "1.0.0" }, enrichment).map((value) => value.name);
  assert.deepEqual(names(":outdated(in-range):vuln([severity=high])"), ["alpha"]);
  assert.deepEqual(names(":vuln([cwe=1333])"), ["alpha"]);
  assert.deepEqual(names(":outdated(major)"), []);
});

test("query enrichment fetches bounded version and advisory data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bnpm-query-enrichment-")); t.after(() => rm(root, { recursive: true, force: true })); await mkdir(join(root, "project"));
  const graph: ResolutionGraph = { roots: new Map([["alpha", "alpha@1.0.0"]]), packages: new Map([["alpha@1.0.0", pkg("alpha@1.0.0", "alpha", "1.0.0")]]) };
  const requirements = [{ name: "alpha", specifier: "^1.0.0", kind: "dependency" as const }];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/alpha")) return Response.json({ name: "alpha", "dist-tags": { latest: "2.0.0" }, versions: {
      "1.0.0": { name: "alpha", version: "1.0.0", dist: { integrity: "sha512-fixture", tarball: "https://registry.example/alpha-1.tgz" } },
      "1.1.0": { name: "alpha", version: "1.1.0", dist: { integrity: "sha512-fixture", tarball: "https://registry.example/alpha-1.1.tgz" } },
      "2.0.0": { name: "alpha", version: "2.0.0", dist: { integrity: "sha512-fixture", tarball: "https://registry.example/alpha-2.tgz" } },
    } });
    if (url.endsWith("/-/npm/v1/security/advisories/bulk") && init?.method === "POST") return Response.json({ alpha: [{ id: 7, title: "unsafe", severity: "high", vulnerable_versions: "<=1.0.0", cwe: ["CWE-1333"] }] });
    return new Response("missing", { status: 404 });
  };
  const paths = createBnpmPaths({ cwd: join(root, "project"), home: root, temp: root, environment: { HOME: root, BNPM_CACHE_HOME: join(root, "cache") } });
  const enrichment = await enrichQuery({ selector: ":outdated(in-range):vuln", graph, roots: graph.roots, requirements, paths, registry: new URL("https://registry.example/"), fetch: fetchMock });
  const result = queryResolutionGraph(graph, graph.roots, requirements, new Set(), ":outdated(in-range):vuln([cwe=1333])", { name: "root", version: "1.0.0" }, enrichment);
  assert.deepEqual(result.map((value) => value.name), ["alpha"]);
  assert.deepEqual((result[0]?.queryContext as { outdated: { categories: string[] } }).outdated.categories, ["any", "in-range", "major", "minor", "out-of-range"]);
});
