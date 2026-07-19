import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import semver from "semver";
import npa from "npm-package-arg";
import { createBnpmPaths, type BnpmPaths } from "../config/paths.js";
import { readLockfileGraph } from "../lockfile/index.js";
import { discoverProject } from "../project/discovery.js";
import type { PackageVersionManifest } from "../registry/types.js";
import type { PackageDocument } from "../registry/types.js";
import { fetchBulkAdvisories, type RegistryAdvisory } from "../registry/audit.js";
import { loadRegistryConfiguration, RoutedRegistryClient } from "../registry/configuration.js";
import type { Requirement, ResolutionGraph } from "../resolver/types.js";

export class QueryError extends Error {
  constructor(message: string) {
    super(`Invalid dependency selector: ${message}`);
    this.name = "QueryError";
  }
}

type QueryKind = Requirement["kind"] | "bundled";

export interface QueryResult {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly direct: boolean;
  readonly aliases: readonly string[];
  readonly types: readonly QueryKind[];
  readonly dangerous: boolean;
  readonly dependencies: readonly string[];
  readonly dependents: readonly string[];
}

interface QueryNode extends QueryResult {
  readonly manifest: PackageVersionManifest & Readonly<Record<string, unknown>>;
  readonly dependencyIds: readonly string[];
  readonly parentIds: readonly string[];
  readonly root: boolean;
  readonly linked: boolean;
  readonly path: string;
}

interface QueryEnrichment {
  readonly outdated?: ReadonlyMap<string, { readonly categories: ReadonlySet<string>; readonly versions: readonly string[] }>;
  readonly advisories?: ReadonlyMap<string, readonly RegistryAdvisory[]>;
}

interface MatchContext {
  readonly nodes: ReadonlyMap<string, QueryNode>;
  readonly scope: string;
}

type SimpleSelector = (node: QueryNode, context: MatchContext) => boolean;
interface CompoundSelector { readonly tests: readonly SimpleSelector[] }
interface SelectorSequence { readonly compounds: readonly CompoundSelector[]; readonly combinators: readonly (">" | " " | "~")[] }

const kinds = new Set<QueryKind>(["dependency", "dev", "optional", "peer", "workspace", "bundled"]);

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function splitTopLevel(value: string, delimiter: string): readonly string[] {
  const values: string[] = [];
  let start = 0; let round = 0; let square = 0; let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote) { if (character === quote && value[index - 1] !== "\\") quote = ""; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === delimiter && round === 0 && square === 0) { values.push(value.slice(start, index).trim()); start = index + 1; }
    if (round < 0 || square < 0) throw new QueryError(`unbalanced selector ${value}`);
  }
  if (round !== 0 || square !== 0 || quote) throw new QueryError(`unbalanced selector ${value}`);
  values.push(value.slice(start).trim());
  return values;
}

function attributeExpression(expression: string): { readonly key?: string; readonly operator?: string; readonly expected?: string } {
  const match = /^\[\s*([A-Za-z0-9_.-]*)\s*(?:(~=|\*=|\|=|\^=|\$=|=)\s*(.*?)\s*)?\]$/.exec(expression);
  if (!match) throw new QueryError(`invalid attribute selector ${expression}`);
  return { ...(match[1] ? { key: match[1] } : {}), ...(match[2] ? { operator: match[2] } : {}), ...(match[3] !== undefined ? { expected: unquote(match[3]) } : {}) };
}

function primitiveMatches(actual: unknown, operator: string | undefined, expected: string | undefined): boolean {
  if (operator === undefined) return actual !== undefined;
  if (Array.isArray(actual)) return actual.some((value) => primitiveMatches(value, operator, expected));
  if (actual === null || actual === undefined || (typeof actual !== "string" && typeof actual !== "number" && typeof actual !== "boolean")) return false;
  const value = String(actual); const wanted = expected ?? "";
  if (operator === "=") return value === wanted;
  if (operator === "~=") return value.split(/\s+/).includes(wanted);
  if (operator === "*=") return value.includes(wanted);
  if (operator === "^=") return value.startsWith(wanted);
  if (operator === "$=") return value.endsWith(wanted);
  return value === wanted || value.startsWith(`${wanted}-`);
}

function derivedValue(node: QueryNode, key: string): unknown {
  if (key === "id") return node.id;
  if (key === "source") return node.source;
  if (key === "type") return node.types;
  if (key === "path") return node.path;
  if (key === "dangerous") return node.dangerous;
  return node.manifest[key];
}

function matchesAttribute(node: QueryNode, expression: string): boolean {
  const { key, operator, expected } = attributeExpression(expression);
  if (!key) return Object.values(node.manifest).some((value) => primitiveMatches(value, operator, expected));
  return primitiveMatches(derivedValue(node, key), operator, expected);
}

function nestedAttribute(value: unknown, parts: readonly string[], expression: string): boolean {
  if (parts.length === 0) {
    if (Array.isArray(value)) return value.some((item) => nestedAttribute(item, [], expression));
    if (typeof value !== "object" || value === null) return false;
    const { key, operator, expected } = attributeExpression(expression);
    if (!key) return Object.values(value).some((item) => primitiveMatches(item, operator, expected));
    const selected = (value as Record<string, unknown>)[key];
    return primitiveMatches(selected, operator, expected);
  }
  if (Array.isArray(value)) return value.some((item) => nestedAttribute(item, parts, expression));
  if (typeof value !== "object" || value === null) return false;
  const [head, ...tail] = parts;
  return head !== undefined && nestedAttribute((value as Record<string, unknown>)[head], tail, expression);
}

function nestedValues(value: unknown, parts: readonly string[], expression: string): readonly string[] {
  if (Array.isArray(value)) return value.flatMap((item) => nestedValues(item, parts, expression));
  if (typeof value !== "object" || value === null) return [];
  if (parts.length > 0) { const [head, ...tail] = parts; return head === undefined ? [] : nestedValues((value as Record<string, unknown>)[head], tail, expression); }
  const { key } = attributeExpression(expression); if (!key) return [];
  const selected = (value as Record<string, unknown>)[key];
  return Array.isArray(selected) ? selected.filter((item): item is string => typeof item === "string") : typeof selected === "string" ? [selected] : [];
}

function semverMatch(actual: string, spec: string, operation: string): boolean {
  const validActual = semver.valid(actual); const validSpec = semver.valid(spec);
  const rangeActual = semver.validRange(actual); const rangeSpec = semver.validRange(spec);
  try {
    if (operation === "infer") {
      if (validActual && validSpec) return semver.eq(validActual, validSpec);
      if (!validActual && !validSpec && rangeActual && rangeSpec) return semver.intersects(rangeActual, rangeSpec);
      if (validActual && rangeSpec) return semver.satisfies(validActual, rangeSpec);
      if (validSpec && rangeActual) return semver.satisfies(validSpec, rangeActual);
      return false;
    }
    if (operation === "satisfies") return Boolean((validActual && rangeSpec && semver.satisfies(validActual, rangeSpec)) || (validSpec && rangeActual && semver.satisfies(validSpec, rangeActual)));
    if (operation === "intersects") return Boolean(rangeActual && rangeSpec && semver.intersects(rangeActual, rangeSpec));
    if (operation === "subset") return Boolean(rangeActual && rangeSpec && semver.subset(rangeActual, rangeSpec));
    if (!validActual || !validSpec) return false;
    if (operation === "gt") return semver.gt(validActual, validSpec);
    if (operation === "gte") return semver.gte(validActual, validSpec);
    if (operation === "lt") return semver.lt(validActual, validSpec);
    if (operation === "lte") return semver.lte(validActual, validSpec);
    if (operation === "eq") return semver.eq(validActual, validSpec);
    if (operation === "neq") return semver.neq(validActual, validSpec);
    if (operation === "gtr") return Boolean(rangeSpec && semver.gtr(validActual, rangeSpec));
    if (operation === "ltr") return Boolean(rangeSpec && semver.ltr(validActual, rangeSpec));
  } catch { return false; }
  throw new QueryError(`unknown semver function ${operation}`);
}

function pseudoArguments(rest: string): { readonly name: string; readonly body?: string; readonly consumed: number } {
  const name = /^:([A-Za-z-]+)/.exec(rest)?.[1];
  if (!name) throw new QueryError(`invalid pseudo selector near ${rest}`);
  let consumed = name.length + 1;
  if (rest[consumed] !== "(") return { name, consumed };
  let depth = 0; let quote = "";
  for (let index = consumed; index < rest.length; index += 1) {
    const character = rest[index] ?? "";
    if (quote) { if (character === quote && rest[index - 1] !== "\\") quote = ""; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "(") depth += 1;
    if (character === ")" && --depth === 0) return { name, body: rest.slice(consumed + 1, index), consumed: index + 1 };
  }
  throw new QueryError(`unclosed :${name}()`);
}

function descendants(node: QueryNode, context: MatchContext): readonly QueryNode[] {
  const found: QueryNode[] = []; const seen = new Set<string>(); const pending = [...node.dependencyIds];
  while (pending.length > 0) {
    const id = pending.shift(); if (!id || seen.has(id)) continue; seen.add(id);
    const value = context.nodes.get(id); if (!value) continue; found.push(value); pending.push(...value.dependencyIds);
  }
  return found;
}

function compound(selector: string): CompoundSelector {
  let rest = selector.trim();
  if (!rest) throw new QueryError("empty compound selector");
  const tests: SimpleSelector[] = [];
  if (rest.startsWith("*")) rest = rest.slice(1);
  const packageSelector = /^#((?:@[^/\s]+\/)?[^@.[\]:,\s>~]+)(?:@([A-Za-z0-9*+_.<>=|^~-]+))?/.exec(rest);
  if (packageSelector?.[1]) {
    const name = packageSelector[1]; const range = packageSelector[2];
    tests.push((node) => (node.name === name || node.aliases.includes(name)) && (range === undefined || semverMatch(node.version, range, "infer")));
    rest = rest.slice(packageSelector[0].length);
  }
  while (rest.length > 0) {
    const type = /^\.(prod|dependency|dev|optional|peer|workspace|bundled)/.exec(rest);
    if (type?.[1]) {
      const kind: QueryKind = type[1] === "prod" ? "dependency" : type[1] as QueryKind;
      tests.push((node) => node.types.includes(kind)); rest = rest.slice(type[0].length); continue;
    }
    if (rest.startsWith("[")) {
      const end = rest.indexOf("]"); if (end < 0) throw new QueryError(`unclosed attribute selector ${rest}`);
      const expression = rest.slice(0, end + 1); const parsed = attributeExpression(expression);
      if (parsed.key === "type" && parsed.operator === "=" && parsed.expected !== undefined && !kinds.has(parsed.expected as QueryKind)) throw new QueryError(`unknown dependency type ${parsed.expected}`);
      tests.push((node) => matchesAttribute(node, expression)); rest = rest.slice(end + 1); continue;
    }
    if (rest.startsWith(":")) {
      const pseudo = pseudoArguments(rest); const body = pseudo.body?.trim();
      if (pseudo.name === "root") tests.push((node) => node.root);
      else if (pseudo.name === "scope") tests.push((node, context) => node.id === context.scope);
      else if (pseudo.name === "direct") tests.push((node) => node.direct);
      else if (pseudo.name === "dangerous") tests.push((node) => node.dangerous);
      else if (pseudo.name === "empty") tests.push((node) => node.dependencyIds.length === 0);
      else if (pseudo.name === "private") tests.push((node) => node.manifest.private === true);
      else if (pseudo.name === "link") tests.push((node) => node.linked);
      else if (pseudo.name === "deduped") tests.push((node) => node.parentIds.length > 1);
      else if (["extraneous", "invalid", "missing"].includes(pseudo.name)) tests.push(() => false);
      else if (pseudo.name === "overridden") tests.push((node) => node.id.includes("(override:"));
      else if (pseudo.name === "not" || pseudo.name === "is") {
        if (!body) throw new QueryError(`:${pseudo.name} requires a selector`);
        const nested = selectorList(body); const expected = pseudo.name === "is";
        tests.push((node, context) => nested.some((sequence) => matchSequence(node, sequence, context)) === expected);
      } else if (pseudo.name === "has") {
        if (!body) throw new QueryError(":has requires a selector");
        const relativeSelector = body.startsWith(">") || body.startsWith("~") ? `:scope${body}` : `:scope ${body}`;
        const nested = selectorList(relativeSelector);
        tests.push((node, context) => [...context.nodes.values()].some((candidate) => nested.some((sequence) => matchSequence(candidate, sequence, { ...context, scope: node.id }))));
      } else if (pseudo.name === "type") {
        if (!body) throw new QueryError(":type requires a source type");
        const expected = unquote(body);
        const accepted = new Set(["registry", "git", "directory", "file", "remote", "tarball", "tag", "range", "version", "alias"]);
        if (!accepted.has(expected)) throw new QueryError(`unknown package source type ${expected}`);
        tests.push((node) => expected === "registry" ? node.source === "registry" : expected === "file" ? node.source === "directory" : expected === "remote" ? node.source === "tarball" : ["tag", "range", "version", "alias"].includes(expected) ? node.source === "registry" : node.source === expected);
      } else if (pseudo.name === "semver") {
        const args = splitTopLevel(body ?? "", ","); const spec = unquote(args[0] ?? "");
        if (!spec || args.length > 3) throw new QueryError(":semver requires a spec and at most two optional arguments");
        const fieldExpression = args[1] || "[version]";
        let values: (node: QueryNode) => readonly string[];
        if (fieldExpression.startsWith(":attr(")) {
          const attribute = pseudoArguments(fieldExpression); if (attribute.name !== "attr" || attribute.consumed !== fieldExpression.length) throw new QueryError(":semver has an invalid :attr field selector");
          const attributeArgs = splitTopLevel(attribute.body ?? "", ","); const expression = attributeArgs.at(-1) ?? ""; attributeExpression(expression); const parts = attributeArgs.slice(0, -1).map(unquote);
          values = (node) => nestedValues(node.manifest, parts, expression);
        } else {
          const field = attributeExpression(fieldExpression).key; if (!field) throw new QueryError(":semver field selector requires an attribute name"); values = (node) => { const actual = derivedValue(node, field); return typeof actual === "string" ? [actual] : []; };
        }
        const operation = unquote(args[2] || "infer");
        tests.push((node) => values(node).some((actual) => semverMatch(actual, spec, operation)));
      } else if (pseudo.name === "attr") {
        const args = splitTopLevel(body ?? "", ","); const expression = args.at(-1) ?? "";
        attributeExpression(expression); const parts = args.slice(0, -1).map(unquote);
        tests.push((node) => nestedAttribute(node.manifest, parts, expression));
      } else if (pseudo.name === "path") {
        if (!body) throw new QueryError(":path requires a pattern");
        const pattern = unquote(body); const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("\u0000", ".*");
        const matcher = new RegExp(`^${escaped}$`); tests.push((node) => matcher.test(node.path));
      } else if (pseudo.name === "outdated") {
        const category = body || "any";
        if (!["any", "in-range", "out-of-range", "major", "minor", "patch"].includes(category)) throw new QueryError(`unknown outdated category ${category}`);
        tests.push((node) => ((node.queryContext as { readonly outdated?: { readonly categories?: readonly string[] } } | undefined)?.outdated?.categories ?? []).includes(category));
      } else if (pseudo.name === "vuln") {
        const filters = body ? splitTopLevel(body, ",").map(attributeExpression) : [];
        for (const filter of filters) if (!filter.key || filter.operator !== "=" || !["severity", "cwe"].includes(filter.key)) throw new QueryError(":vuln filters support only [severity=value] or [cwe=value]");
        tests.push((node) => ((node.queryContext as { readonly advisories?: readonly RegistryAdvisory[] } | undefined)?.advisories ?? []).some((advisory) => filters.length === 0 || filters.some((filter) => filter.key === "severity" ? advisory.severity === filter.expected : (advisory.cwe ?? []).some((cwe) => cwe === filter.expected || cwe === `CWE-${filter.expected}`))));
      } else throw new QueryError(`unsupported pseudo selector :${pseudo.name}`);
      rest = rest.slice(pseudo.consumed); continue;
    }
    throw new QueryError(`unsupported selector near ${rest}`);
  }
  return { tests };
}

function sequence(selector: string): SelectorSequence {
  const compounds: CompoundSelector[] = []; const combinators: (">" | " " | "~")[] = [];
  let buffer = ""; let round = 0; let square = 0; let quote = ""; let pending: ">" | " " | "~" | undefined;
  const flush = (): void => { const value = buffer.trim(); buffer = ""; if (!value) return; if (compounds.length > 0) combinators.push(pending ?? " "); compounds.push(compound(value)); pending = undefined; };
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index] ?? "";
    if (quote) { buffer += character; if (character === quote && selector[index - 1] !== "\\") quote = ""; continue; }
    if (character === '"' || character === "'") { quote = character; buffer += character; continue; }
    if (character === "(") round += 1; else if (character === ")") round -= 1; else if (character === "[") square += 1; else if (character === "]") square -= 1;
    if (round === 0 && square === 0 && (character === ">" || character === "~")) { flush(); pending = character; continue; }
    if (round === 0 && square === 0 && /\s/.test(character)) { flush(); if (compounds.length > 0 && pending === undefined) pending = " "; continue; }
    buffer += character;
  }
  flush();
  if (compounds.length === 0 || combinators.length !== compounds.length - 1) throw new QueryError(`invalid selector sequence ${selector}`);
  return { compounds, combinators };
}

function selectorList(selector: string): readonly SelectorSequence[] {
  return splitTopLevel(selector, ",").map((value) => { if (!value) throw new QueryError("empty selector"); return sequence(value); });
}

function matchesCompound(node: QueryNode, value: CompoundSelector, context: MatchContext): boolean { return value.tests.every((test) => test(node, context)); }

function matchSequence(node: QueryNode, value: SelectorSequence, context: MatchContext, index = value.compounds.length - 1): boolean {
  const current = value.compounds[index]; if (!current || !matchesCompound(node, current, context)) return false;
  if (index === 0) return true;
  const relation = value.combinators[index - 1];
  if (relation === ">") return node.parentIds.some((id) => { const parent = context.nodes.get(id); return parent !== undefined && matchSequence(parent, value, context, index - 1); });
  if (relation === " ") {
    const seen = new Set<string>(); const pending = [...node.parentIds];
    while (pending.length > 0) { const id = pending.shift(); if (!id || seen.has(id)) continue; seen.add(id); const parent = context.nodes.get(id); if (!parent) continue; if (matchSequence(parent, value, context, index - 1)) return true; pending.push(...parent.parentIds); }
    return false;
  }
  for (const parentId of node.parentIds) {
    const parent = context.nodes.get(parentId); if (!parent) continue;
    for (const siblingId of parent.dependencyIds) { if (siblingId === node.id) continue; const sibling = context.nodes.get(siblingId); if (sibling && matchSequence(sibling, value, context, index - 1)) return true; }
  }
  return false;
}

function propagateTypes(graph: ResolutionGraph, roots: ReadonlyMap<string, string>, requirements: readonly Requirement[]): ReadonlyMap<string, ReadonlySet<QueryKind>> {
  const result = new Map<string, Set<QueryKind>>();
  const add = (id: string, kind: QueryKind): void => {
    const seen = new Set<string>(); const pending = [id];
    while (pending.length > 0) { const current = pending.shift(); if (!current || seen.has(current)) continue; seen.add(current); const values = result.get(current) ?? new Set<QueryKind>(); values.add(kind); result.set(current, values); pending.push(...(graph.packages.get(current)?.dependencies.values() ?? [])); }
  };
  for (const [alias, id] of roots) add(id, requirements.find((requirement) => requirement.name === alias)?.kind ?? "dependency");
  for (const pkg of graph.packages.values()) {
    const raw = pkg.manifest as PackageVersionManifest & { readonly bundleDependencies?: readonly string[]; readonly bundledDependencies?: readonly string[] };
    for (const name of raw.bundleDependencies ?? raw.bundledDependencies ?? []) { const id = pkg.dependencies.get(name); if (id) add(id, "bundled"); }
  }
  return result;
}

export function queryResolutionGraph(graph: ResolutionGraph, roots: ReadonlyMap<string, string>, requirements: readonly Requirement[], dangerousIds: ReadonlySet<string>, selector: string, rootManifest: Readonly<Record<string, unknown>> = { name: "(root)", version: "0.0.0", private: true }, enrichment: QueryEnrichment = {}): readonly QueryResult[] {
  const selectors = selectorList(selector);
  const aliases = new Map<string, string[]>();
  for (const [alias, id] of roots) { const names = aliases.get(id) ?? []; names.push(alias); aliases.set(id, names); }
  const parents = new Map<string, Set<string>>();
  for (const pkg of graph.packages.values()) for (const dependency of pkg.dependencies.values()) { const values = parents.get(dependency) ?? new Set(); values.add(pkg.id); parents.set(dependency, values); }
  const rootId = "\u0000root";
  for (const id of roots.values()) { const values = parents.get(id) ?? new Set(); values.add(rootId); parents.set(id, values); }
  const types = propagateTypes(graph, roots, requirements);
  const nodes = new Map<string, QueryNode>();
  const rootNode: QueryNode = { ...rootManifest, id: rootId, name: typeof rootManifest.name === "string" ? rootManifest.name : "(root)", version: typeof rootManifest.version === "string" ? rootManifest.version : "0.0.0", source: "project", direct: false, aliases: [], types: ["dependency"], dangerous: false, dependencies: [...roots.keys()].sort(), dependents: [], manifest: rootManifest as PackageVersionManifest & Readonly<Record<string, unknown>>, dependencyIds: [...new Set(roots.values())].sort(), parentIds: [], root: true, linked: false, path: "." };
  nodes.set(rootId, rootNode);
  for (const pkg of [...graph.packages.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const manifest = pkg.manifest as PackageVersionManifest & Readonly<Record<string, unknown>>;
    const outdated = enrichment.outdated?.get(pkg.id); const advisories = enrichment.advisories?.get(pkg.id) ?? [];
    const queryContext = { ...(outdated === undefined ? {} : { outdated: { categories: [...outdated.categories].sort() }, versions: outdated.versions }), ...(advisories.length === 0 ? {} : { advisories }) };
    const node: QueryNode = { ...manifest, id: pkg.id, name: pkg.name, version: pkg.version, source: pkg.source ?? "registry", direct: aliases.has(pkg.id), aliases: [...(aliases.get(pkg.id) ?? [])].sort(), types: [...(types.get(pkg.id) ?? [])].sort(), dangerous: dangerousIds.has(pkg.id), dependencies: [...pkg.dependencies.keys()].sort(), dependents: [...(parents.get(pkg.id) ?? [])].filter((id) => id !== rootId).sort(), ...(Object.keys(queryContext).length === 0 ? {} : { queryContext }), manifest, dependencyIds: [...new Set(pkg.dependencies.values())].sort(), parentIds: [...(parents.get(pkg.id) ?? [])].sort(), root: false, linked: pkg.source === "directory", path: `node_modules/${(aliases.get(pkg.id)?.[0] ?? pkg.name).replaceAll("/", "/node_modules/")}` };
    nodes.set(pkg.id, node);
  }
  const context: MatchContext = { nodes, scope: rootId };
  return [...nodes.values()].filter((node) => selectors.some((value) => matchSequence(node, value, context))).map(({ manifest: _manifest, dependencyIds: _dependencyIds, parentIds: _parentIds, root: _root, linked: _linked, path: _path, ...result }) => result);
}

function declaredRanges(graph: ResolutionGraph, roots: ReadonlyMap<string, string>, requirements: readonly Requirement[]): ReadonlyMap<string, readonly string[]> {
  const values = new Map<string, string[]>(); const add = (id: string, specifier: string): void => { let range = semver.validRange(specifier); if (!range) { try { const parsed = npa(specifier); const request = parsed.type === "alias" ? (parsed as npa.AliasResult).subSpec : parsed; range = semver.validRange(request.rawSpec); } catch {} } if (range) { const entries = values.get(id) ?? []; entries.push(range); values.set(id, entries); } };
  for (const requirement of requirements) { const id = roots.get(requirement.name); if (id) add(id, requirement.specifier); }
  for (const pkg of graph.packages.values()) for (const [alias, id] of pkg.dependencies) {
    const manifest = pkg.manifest; const specifier = manifest.optionalDependencies?.[alias] ?? manifest.dependencies?.[alias] ?? manifest.devDependencies?.[alias] ?? manifest.peerDependencies?.[alias];
    if (specifier) add(id, specifier);
  }
  return values;
}

export async function enrichQuery(options: { readonly selector: string; readonly graph: ResolutionGraph; readonly roots: ReadonlyMap<string, string>; readonly requirements: readonly Requirement[]; readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<QueryEnrichment> {
  const needsOutdated = options.selector.includes(":outdated"); const needsVulnerability = options.selector.includes(":vuln");
  if (!needsOutdated && !needsVulnerability) return {};
  const configuration = await loadRegistryConfiguration({ userNpmrc: options.paths.userNpmrc, projectNpmrc: options.paths.projectNpmrc, ...(options.registry === undefined ? {} : { defaultRegistry: options.registry }) });
  let outdated: Map<string, { categories: ReadonlySet<string>; versions: readonly string[] }> | undefined;
  if (needsOutdated) {
    const client = new RoutedRegistryClient(configuration, options.fetch ?? globalThis.fetch); const documents = new Map<string, PackageDocument>();
    const names = [...new Set([...options.graph.packages.values()].filter((pkg) => (pkg.source ?? "registry") === "registry").map((pkg) => pkg.name))].sort(); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => { while (cursor < names.length) { const name = names[cursor++]; if (name) documents.set(name, await client.packageDocument(name, options.signal)); } }));
    const ranges = declaredRanges(options.graph, options.roots, options.requirements); outdated = new Map();
    for (const pkg of options.graph.packages.values()) {
      const document = documents.get(pkg.name); if (!document) continue;
      const versions = Object.keys(document.versions).filter((version) => semver.valid(version)).sort(semver.compare); const greater = versions.filter((version) => semver.gt(version, pkg.version)); if (greater.length === 0) continue;
      const categories = new Set<string>(["any"]); const current = semver.parse(pkg.version);
      if (current && greater.some((version) => semver.major(version) > current.major)) categories.add("major");
      if (current && greater.some((version) => semver.major(version) === current.major && semver.minor(version) > current.minor)) categories.add("minor");
      if (current && greater.some((version) => semver.major(version) === current.major && semver.minor(version) === current.minor && semver.patch(version) > current.patch)) categories.add("patch");
      const declared = ranges.get(pkg.id) ?? []; if (declared.some((range) => greater.some((version) => semver.satisfies(version, range)))) categories.add("in-range"); if (declared.some((range) => greater.some((version) => !semver.satisfies(version, range)))) categories.add("out-of-range");
      outdated.set(pkg.id, { categories, versions });
    }
  }
  let advisories: Map<string, readonly RegistryAdvisory[]> | undefined;
  if (needsVulnerability) {
    const groups = new Map<string, Map<string, import("../resolver/types.js").ResolvedPackage>>();
    for (const [id, pkg] of options.graph.packages) { const registry = configuration.registryForPackage(pkg.name).href; const values = groups.get(registry) ?? new Map(); values.set(id, pkg); groups.set(registry, values); }
    const found = (await Promise.all([...groups].map(([registry, packages]) => fetchBulkAdvisories({ graph: { roots: new Map(), packages }, registry: new URL(registry), headers: (url) => configuration.headersFor(url), ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.signal === undefined ? {} : { signal: options.signal }) })))).flat();
    advisories = new Map(); for (const pkg of options.graph.packages.values()) { const matches = found.filter((advisory) => advisory.packageName === pkg.name && semver.satisfies(pkg.version, advisory.vulnerableVersions)); if (matches.length > 0) advisories.set(pkg.id, matches); }
  }
  return { ...(outdated === undefined ? {} : { outdated }), ...(advisories === undefined ? {} : { advisories }) };
}

export async function queryInstalledPackages(options: { readonly cwd: string; readonly selector: string; readonly paths?: BnpmPaths; readonly allWorkspaces?: boolean; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<readonly QueryResult[]> {
  const discovered = await discoverProject(options.cwd);
  const root = discovered?.projectRoot ?? options.cwd;
  const importerRoot = discovered?.importerRoot ?? options.cwd;
  const paths = options.paths ?? createBnpmPaths({ cwd: root });
  const locked = await readLockfileGraph(paths.lockfile, paths.store);
  const importer = relative(root, importerRoot).split(sep).join("/") || ".";
  const roots = options.allWorkspaces
    ? new Map([...(locked.graph.importers ?? new Map([[".", locked.graph.roots]])).values()].flatMap((values) => [...values]))
    : locked.graph.importers?.get(importer) ?? (importer === "." ? locked.graph.roots : new Map());
  const requirements = options.allWorkspaces ? locked.requirements : locked.requirements.filter((requirement) => (requirement.importer ?? ".") === importer);
  const manifestPath = `${importerRoot}${sep}package.json`;
  const rootManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Readonly<Record<string, unknown>>;
  const enrichment = await enrichQuery({ selector: options.selector, graph: locked.graph, roots, requirements, paths, ...(options.registry === undefined ? {} : { registry: options.registry }), ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  return queryResolutionGraph(locked.graph, roots, requirements, locked.dangerousPackageIds, options.selector, rootManifest, enrichment);
}
