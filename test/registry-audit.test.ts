import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchBulkAdvisories } from "../src/registry/audit.js";
import type { ResolutionGraph, ResolvedPackage } from "../src/resolver/types.js";

const pkg: ResolvedPackage = { id: "example@1.0.0", name: "example", version: "1.0.0", integrity: "sha512-x", tarball: new URL("https://registry.example/example.tgz"), manifest: { name: "example", version: "1.0.0", dist: { integrity: "sha512-x", tarball: "https://registry.example/example.tgz" } }, dependencies: new Map() };
const graph: ResolutionGraph = { roots: new Map([["example", pkg.id]]), packages: new Map([[pkg.id, pkg]]) };

test("bulk audit posts exact installed versions and validates advisories", async () => {
  let body = "";
  const advisories = await fetchBulkAdvisories({
    graph,
    registry: new URL("https://registry.example/"),
    fetch: async (_input, init) => { body = String(init?.body); return Response.json({ example: [{ id: 1, title: "fixture advisory", severity: "high", vulnerable_versions: "<=1.0.0", url: "https://advisories.example/1" }] }); },
  });
  assert.deepEqual(JSON.parse(body), { example: ["1.0.0"] });
  assert.equal(advisories[0]?.severity, "high");
  await assert.rejects(() => fetchBulkAdvisories({ graph, fetch: async () => Response.json({ example: [{ bad: true }] }) }), /invalid/);
});
