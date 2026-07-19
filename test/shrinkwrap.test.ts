import assert from "node:assert/strict";
import test from "node:test";
import { createNpmShrinkwrap } from "../src/commands/shrinkwrap.js";
import type { PackageVersionManifest } from "../src/registry/types.js";
import type { ResolutionGraph, ResolvedPackage } from "../src/resolver/types.js";

const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function pkg(name: string, version: string, dependencies: ReadonlyMap<string, string> = new Map(), source?: "registry" | "directory"): ResolvedPackage {
  const manifest: PackageVersionManifest = { name, version, dependencies: Object.fromEntries(dependencies), dist: { integrity, tarball: `https://registry.example/${name}/-/${name}-${version}.tgz` } };
  return { id: `${name}@${version}`, name, version, integrity, tarball: new URL(manifest.dist.tarball), manifest, dependencies, ...(source === undefined ? {} : { source }) };
}

test("shrinkwrap export deterministically represents aliases, conflicts, and dependency cycles", () => {
  const sharedOne = pkg("shared", "1.0.0", new Map([["a", "a@1.0.0"]]));
  const sharedTwo = pkg("shared", "2.0.0");
  const a = pkg("a", "1.0.0", new Map([["shared", sharedOne.id]]));
  const b = pkg("b", "1.0.0", new Map([["shared", sharedTwo.id]]));
  const packages = new Map([[a.id, a], [b.id, b], [sharedOne.id, sharedOne], [sharedTwo.id, sharedTwo]]);
  const graph: ResolutionGraph = { roots: new Map([["alias-a", a.id], ["b", b.id]]), packages };
  const requirements = [{ name: "alias-a", specifier: "npm:a@1.0.0", kind: "dev" as const }, { name: "b", specifier: "1.0.0", kind: "dependency" as const }];
  const manifest = { name: "fixture", version: "1.0.0", dependencies: { b: "1.0.0" }, devDependencies: { "alias-a": "npm:a@1.0.0" } };
  const first = createNpmShrinkwrap(graph, manifest, requirements);
  const second = createNpmShrinkwrap(graph, manifest, [...requirements].reverse());
  assert.equal(first, second);
  const document = JSON.parse(first) as { lockfileVersion: number; packages: Record<string, Record<string, unknown>> };
  assert.equal(document.lockfileVersion, 3);
  assert.deepEqual(document.packages[""], manifest);
  assert.equal(document.packages["node_modules/alias-a"]?.name, "a");
  assert.equal(document.packages["node_modules/alias-a"]?.dev, true);
  assert.equal(document.packages["node_modules/alias-a/node_modules/shared"]?.version, "1.0.0");
  assert.equal(document.packages["node_modules/b/node_modules/shared"]?.version, "2.0.0");
  assert.equal(Object.keys(document.packages).some((path) => path.includes("shared/node_modules/a")), false);
  assert.equal(first.endsWith("\n"), true);
});

test("shrinkwrap export refuses local sources that npm cannot reproduce from registry integrity", () => {
  const local = pkg("local", "1.0.0", new Map(), "directory");
  const graph: ResolutionGraph = { roots: new Map([["local", local.id]]), packages: new Map([[local.id, local]]) };
  assert.throws(() => createNpmShrinkwrap(graph, { name: "fixture", version: "1.0.0", dependencies: { local: "file:../local" } }, [{ name: "local", specifier: "file:../local", kind: "dependency" }]), /does not support directory source/);
});
