import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createBnpmPaths, type BnpmPaths } from "../config/paths.js";
import { readLockfileGraph } from "../lockfile/index.js";
import { discoverProject } from "../project/discovery.js";

function purl(name: string, version: string): string {
  const path = name.startsWith("@") ? `${name.slice(1).split("/").map(encodeURIComponent).join("/")}` : encodeURIComponent(name);
  return `pkg:npm/${path}@${encodeURIComponent(version)}`;
}

function sha512(integrity: string): string | undefined {
  const digest = integrity.match(/^sha512-([^\s]+)$/)?.[1];
  return digest ? Buffer.from(digest, "base64").toString("hex") : undefined;
}

export async function createSbom(options: { readonly cwd: string; readonly format: "cyclonedx" | "spdx"; readonly paths?: BnpmPaths }): Promise<Record<string, unknown>> {
  const discovered = await discoverProject(options.cwd);
  const root = discovered?.projectRoot ?? options.cwd;
  const paths = options.paths ?? createBnpmPaths({ cwd: root });
  const locked = await readLockfileGraph(paths.lockfile, paths.store);
  const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
  const rootName = typeof rootManifest.name === "string" ? rootManifest.name : "project";
  const rootVersion = typeof rootManifest.version === "string" ? rootManifest.version : "0.0.0";
  if (options.format === "spdx") {
    const packages = [...locked.graph.packages.values()].map((pkg) => ({ SPDXID: `SPDXRef-${createHash("sha256").update(pkg.id).digest("hex").slice(0, 16)}`, name: pkg.name, versionInfo: pkg.version, downloadLocation: pkg.tarball.href, filesAnalyzed: false, externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: purl(pkg.name, pkg.version) }], checksums: sha512(pkg.integrity) ? [{ algorithm: "SHA512", checksumValue: sha512(pkg.integrity) }] : [] }));
    return { spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", name: `${rootName}-${rootVersion}`, documentNamespace: `https://bnpm.dev/spdx/${createHash("sha256").update([...locked.graph.packages.keys()].join("\0")).digest("hex")}`, creationInfo: { created: new Date(0).toISOString(), creators: ["Tool: bnpm"] }, packages };
  }
  const components = [...locked.graph.packages.values()].map((pkg) => ({ type: "library", "bom-ref": pkg.id, name: pkg.name, version: pkg.version, purl: purl(pkg.name, pkg.version), hashes: sha512(pkg.integrity) ? [{ alg: "SHA-512", content: sha512(pkg.integrity) }] : [] }));
  const dependencies = [...locked.graph.packages.values()].map((pkg) => ({ ref: pkg.id, dependsOn: [...pkg.dependencies.values()].sort() }));
  return { bomFormat: "CycloneDX", specVersion: "1.6", serialNumber: `urn:uuid:${createHash("sha256").update([...locked.graph.packages.keys()].join("\0")).digest("hex").replace(/^(........)(....)(....)(....)(............).*$/, "$1-$2-$3-$4-$5")}`, version: 1, metadata: { component: { type: "application", name: rootName, version: rootVersion } }, components, dependencies };
}
