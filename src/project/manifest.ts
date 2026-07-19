import npa from "npm-package-arg";
import semver from "semver";

export class ManifestError extends Error {
  constructor(message: string) {
    super(`Manifest error: ${message}`);
    this.name = "ManifestError";
  }
}

export type DependencySection = "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";

export interface PackageManifest {
  readonly path: string;
  readonly bytes: string;
  readonly name?: string;
  readonly dependencies: Readonly<Partial<Record<DependencySection, Readonly<Record<string, string>>>>>;
  readonly workspaces: readonly string[];
  readonly overrides: Readonly<Record<string, string>>;
}

export interface ManifestMutation {
  readonly operation: "add" | "remove";
  readonly name: string;
  readonly section: DependencySection;
  readonly specifier?: string;
  readonly exact?: boolean;
  readonly noSave?: boolean;
}

export interface ManifestMutationPlan {
  readonly path: string;
  readonly bytes: string;
  readonly changed: boolean;
}

const packageName = /^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const sections: readonly DependencySection[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function strictJson(bytes: string, path: string): unknown {
  let index = 0;
  function whitespace(): void {
    while (/\s/.test(bytes[index] ?? "")) index += 1;
  }
  function string(): string {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < bytes.length) {
      const character = bytes[index++] ?? "";
      if (!escaped && character === '"') {
        try {
          return JSON.parse(bytes.slice(start, index)) as string;
        } catch {
          throw new ManifestError(`${path}: invalid JSON string`);
        }
      }
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
    }
    throw new ManifestError(`${path}: unterminated JSON string`);
  }
  function value(): unknown {
    whitespace();
    const character = bytes[index];
    if (character === '"') return string();
    if (character === "{") {
      index += 1;
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      whitespace();
      if (bytes[index] === "}") {
        index += 1;
        return result;
      }
      while (true) {
        whitespace();
        if (bytes[index] !== '"') throw new ManifestError(`${path}: object key must be a string`);
        const key = string();
        if (keys.has(key)) throw new ManifestError(`${path}: duplicate key ${key}`);
        keys.add(key);
        whitespace();
        if (bytes[index++] !== ":") throw new ManifestError(`${path}: expected ':' after ${key}`);
        result[key] = value();
        whitespace();
        const separator = bytes[index++];
        if (separator === "}") return result;
        if (separator !== ",") throw new ManifestError(`${path}: expected ',' or '}'`);
      }
    }
    if (character === "[") {
      index += 1;
      const result: unknown[] = [];
      whitespace();
      if (bytes[index] === "]") {
        index += 1;
        return result;
      }
      while (true) {
        result.push(value());
        whitespace();
        const separator = bytes[index++];
        if (separator === "]") return result;
        if (separator !== ",") throw new ManifestError(`${path}: expected ',' or ']'`);
      }
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(bytes.slice(index))?.[0];
    if (!primitive) throw new ManifestError(`${path}: invalid JSON value`);
    index += primitive.length;
    return JSON.parse(primitive) as unknown;
  }
  const parsed = value();
  whitespace();
  if (index !== bytes.length) throw new ManifestError(`${path}: unexpected trailing JSON`);
  return parsed;
}

function record(value: unknown, path: string, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestError(`${path}: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateSpecifier(name: string, specifier: string, path: string): void {
  if (!packageName.test(name)) throw new ManifestError(`${path}: invalid dependency name ${name}`);
  try {
    const parsed = npa(specifier);
    if (parsed.type === "directory" && specifier.includes("file:./")) return;
    if (parsed.type === "directory" && specifier.includes("file:../")) return;
    if (parsed.type === "remote") {
      const url = new URL(parsed.fetchSpec as string);
      if (url.protocol === "https:" && !url.username && !url.password && !url.hash) return;
    }
    if (parsed.type === "git") {
      const hosted = parsed.hosted as undefined | { https(options?: { noCommittish?: boolean; noGitPlus?: boolean }): string };
      const value = typeof parsed.fetchSpec === "string" ? parsed.fetchSpec : hosted?.https({ noCommittish: true, noGitPlus: true });
      const url = new URL(value ?? "");
      const secureTransport = (url.protocol === "https:" && !url.username) || url.protocol === "ssh:";
      if (secureTransport && !url.password && !url.search && !url.hash && (parsed.gitRange === undefined || semver.validRange(parsed.gitRange))) return;
    }
    if (parsed.type === "version" || parsed.type === "range" || parsed.type === "tag" || parsed.type === "alias") return;
  } catch {
    // Normalized workspace syntax is not understood by npm-package-arg.
    if (/^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*@workspace:(?:[*~^]|[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.test(`${name}@${specifier}`)) return;
  }
  throw new ManifestError(`${path}: unsupported dependency specification for ${name}`);
}

function workspacePatterns(value: unknown, path: string): readonly string[] {
  if (value === undefined) return [];
  const patterns = Array.isArray(value) ? value : record(value, path, "workspaces").packages;
  if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string" || pattern.length === 0)) {
    throw new ManifestError(`${path}: workspaces must be an array of non-empty strings`);
  }
  return [...patterns] as string[];
}

export function parseManifest(bytes: string, path: string): PackageManifest {
  const root = record(strictJson(bytes, path), path, "root");
  if (root.name !== undefined && (typeof root.name !== "string" || !packageName.test(root.name))) {
    throw new ManifestError(`${path}: name must be a valid package name`);
  }
  const dependencies: Partial<Record<DependencySection, Readonly<Record<string, string>>>> = {};
  for (const section of sections) {
    if (root[section] === undefined) continue;
    const entries = record(root[section], path, section);
    const parsed: Record<string, string> = {};
    for (const [name, specifier] of Object.entries(entries)) {
      if (typeof specifier !== "string") throw new ManifestError(`${path}: ${section}.${name} must be a string`);
      validateSpecifier(name, specifier, path);
      parsed[name] = specifier;
    }
    dependencies[section] = parsed;
  }
  const overrides: Record<string, string> = {};
  if (root.overrides !== undefined) {
    for (const [name, specifier] of Object.entries(record(root.overrides, path, "overrides"))) {
      if (typeof specifier !== "string") throw new ManifestError(`${path}: overrides.${name} must be a string`);
      validateSpecifier(name, specifier, path);
      overrides[name] = specifier;
    }
  }
  return {
    path,
    bytes,
    ...(root.name === undefined ? {} : { name: root.name }),
    dependencies,
    workspaces: workspacePatterns(root.workspaces, path),
    overrides,
  };
}

function closingBrace(bytes: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < bytes.length; index += 1) {
    const character = bytes[index] ?? "";
    if (quoted) {
      if (!escaped && character === '"') quoted = false;
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      continue;
    }
    if (character === '"') quoted = true;
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new ManifestError("manifest object is not closed");
}

function sectionRange(bytes: string, section: DependencySection): { readonly start: number; readonly end: number } | undefined {
  let index = bytes.indexOf("{");
  if (index < 0) throw new ManifestError("manifest root is not an object");
  index += 1;
  while (index < bytes.length) {
    while (/\s/.test(bytes[index] ?? "")) index += 1;
    if (bytes[index] === "}") return undefined;
    if (bytes[index] !== '"') throw new ManifestError("manifest object key must be a string");
    const keyStart = index;
    index += 1;
    let escaped = false;
    while (index < bytes.length) {
      const character = bytes[index++] ?? "";
      if (!escaped && character === '"') break;
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
    }
    const key = JSON.parse(bytes.slice(keyStart, index)) as string;
    while (/\s/.test(bytes[index] ?? "")) index += 1;
    if (bytes[index++] !== ":") throw new ManifestError(`manifest expected ':' after ${key}`);
    while (/\s/.test(bytes[index] ?? "")) index += 1;
    const valueStart = index;
    if (key === section) {
      if (bytes[valueStart] !== "{") throw new ManifestError(`manifest ${section} does not contain an object`);
      return { start: valueStart, end: closingBrace(bytes, valueStart) };
    }

    let depth = 0;
    let quoted = false;
    escaped = false;
    while (index < bytes.length) {
      const character = bytes[index] ?? "";
      if (quoted) {
        index += 1;
        if (!escaped && character === '"') quoted = false;
        escaped = character === "\\" && !escaped;
        if (character !== "\\") escaped = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === "," && depth === 0) break;
      index += 1;
    }
    if (bytes[index] === ",") index += 1;
  }
  return undefined;
}

function indentation(bytes: string, position: number): string {
  const lineStart = bytes.lastIndexOf("\n", position) + 1;
  return /^[\t ]*/.exec(bytes.slice(lineStart))?.[0] ?? "";
}

function addToExistingSection(manifest: PackageManifest, mutation: ManifestMutation, range: { readonly start: number; readonly end: number }): string {
  const specifier = mutation.specifier;
  if (!specifier) throw new ManifestError("add requires a dependency specification");
  validateSpecifier(mutation.name, specifier, manifest.path);
  const current = manifest.dependencies[mutation.section] ?? {};
  const previous = current[mutation.name];
  const saved = mutation.exact ? specifier.replace(/^[~^]/, "") : specifier;
  if (previous === saved) return manifest.bytes;
  const newline = manifest.bytes.includes("\r\n") ? "\r\n" : "\n";
  const childIndent = Object.keys(current).length > 0 ? indentation(manifest.bytes, range.end - 1) + (indentation(manifest.bytes, range.end - 1) === indentation(manifest.bytes, range.start) ? "\t" : "") : indentation(manifest.bytes, range.start) + "\t";
  const property = `${JSON.stringify(mutation.name)}: ${JSON.stringify(saved)}`;
  if (previous !== undefined) {
    const expression = new RegExp(`(${JSON.stringify(mutation.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
    const inside = manifest.bytes.slice(range.start, range.end + 1);
    return `${manifest.bytes.slice(0, range.start)}${inside.replace(expression, `$1${JSON.stringify(saved)}`)}${manifest.bytes.slice(range.end + 1)}`;
  }
  const beforeClosing = manifest.bytes.slice(range.start + 1, range.end);
  const hasEntries = Object.keys(current).length > 0;
  if (hasEntries) {
    const trailing = /\s*$/.exec(beforeClosing)?.[0] ?? "";
    const content = beforeClosing.slice(0, beforeClosing.length - trailing.length);
    return `${manifest.bytes.slice(0, range.start + 1)}${content},${newline}${childIndent}${property}${trailing}${manifest.bytes.slice(range.end)}`;
  }
  const insertion = `${newline}${childIndent}${property}${newline}${indentation(manifest.bytes, range.start)}`;
  return `${manifest.bytes.slice(0, range.end)}${insertion}${manifest.bytes.slice(range.end)}`;
}

function addSection(manifest: PackageManifest, mutation: ManifestMutation): string {
  const specifier = mutation.specifier;
  if (!specifier) throw new ManifestError("add requires a dependency specification");
  validateSpecifier(mutation.name, specifier, manifest.path);
  const saved = mutation.exact ? specifier.replace(/^[~^]/, "") : specifier;
  const rootStart = manifest.bytes.indexOf("{");
  const rootEnd = closingBrace(manifest.bytes, rootStart);
  const newline = manifest.bytes.includes("\r\n") ? "\r\n" : "\n";
  const inside = manifest.bytes.slice(rootStart + 1, rootEnd);
  const trailing = /\s*$/.exec(inside)?.[0] ?? "";
  const content = inside.slice(0, inside.length - trailing.length);
  const detectedIndent = /(?:\r?\n)([\t ]+)"/.exec(inside)?.[1];
  const childIndent = detectedIndent ?? "  ";
  const indentUnit = childIndent.startsWith("\t") ? "\t" : "  ";
  const sectionBytes = `${JSON.stringify(mutation.section)}: {${newline}${childIndent}${indentUnit}${JSON.stringify(mutation.name)}: ${JSON.stringify(saved)}${newline}${childIndent}}`;
  const prefix = content.trim().length === 0 ? "" : `${content},`;
  const replacement = `${prefix}${newline}${childIndent}${sectionBytes}${trailing.length === 0 ? `${newline}${indentation(manifest.bytes, rootStart)}` : trailing}`;
  return `${manifest.bytes.slice(0, rootStart + 1)}${replacement}${manifest.bytes.slice(rootEnd)}`;
}

function removeFromSection(manifest: PackageManifest, mutation: ManifestMutation, range: { readonly start: number; readonly end: number }): string {
  const escapedName = JSON.stringify(mutation.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inside = manifest.bytes.slice(range.start + 1, range.end);
  const expression = new RegExp(`${escapedName}\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`);
  const match = expression.exec(inside);
  if (!match || match.index === undefined) return manifest.bytes;
  let start = match.index;
  let end = start + match[0].length;
  let cursor = end;
  while (/\s/.test(inside[cursor] ?? "")) cursor += 1;
  if (inside[cursor] === ",") {
    end = cursor + 1;
    while (/\s/.test(inside[end] ?? "")) end += 1;
  } else {
    cursor = start - 1;
    while (cursor >= 0 && /\s/.test(inside[cursor] ?? "")) cursor -= 1;
    if (inside[cursor] === ",") start = cursor;
  }
  const changed = `${inside.slice(0, start)}${inside.slice(end)}`;
  return `${manifest.bytes.slice(0, range.start + 1)}${changed}${manifest.bytes.slice(range.end)}`;
}

export function planManifestMutation(manifest: PackageManifest, mutation: ManifestMutation): ManifestMutationPlan {
  if (!packageName.test(mutation.name)) throw new ManifestError(`invalid dependency name ${mutation.name}`);
  if (mutation.noSave) throw new ManifestError("no-save mutations do not modify package.json");
  const range = sectionRange(manifest.bytes, mutation.section);
  if (mutation.operation === "remove") {
    if (!range || manifest.dependencies[mutation.section]?.[mutation.name] === undefined) {
      return { path: manifest.path, bytes: manifest.bytes, changed: false };
    }
    const bytes = removeFromSection(manifest, mutation, range);
    return { path: manifest.path, bytes, changed: bytes !== manifest.bytes };
  }
  if (!range) {
    const bytes = addSection(manifest, mutation);
    return { path: manifest.path, bytes, changed: bytes !== manifest.bytes };
  }
  const bytes = addToExistingSection(manifest, mutation, range);
  return { path: manifest.path, bytes, changed: bytes !== manifest.bytes };
}
