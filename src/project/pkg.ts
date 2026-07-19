import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ManifestError, parseManifest } from "./manifest.js";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);

function segments(path: string): readonly string[] {
  if (!path || path.includes("\0")) throw new ManifestError(`invalid package property path ${path}`);
  const normalized = path.replace(/\[([0-9]+|"[^"]+"|'[^']+')\]/g, (_match, value: string) => `.${value.replace(/^['"]|['"]$/g, "")}`);
  const result = normalized.split(".");
  if (result.some((part) => !part || forbidden.has(part) || !/^[A-Za-z0-9_@/-]+$/.test(part))) throw new ManifestError(`invalid package property path ${path}`);
  return result;
}

function readAt(root: unknown, path: string): unknown {
  let value = root;
  for (const part of segments(path)) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function setAt(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = segments(path);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const nested = current[part];
    if (nested === undefined) current[part] = {};
    else if (typeof nested !== "object" || nested === null || Array.isArray(nested)) throw new ManifestError(`${path} crosses a non-object property`);
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1) ?? ""] = value;
}

function deleteAt(root: Record<string, unknown>, path: string): void {
  const parts = segments(path);
  let current: Record<string, unknown> | undefined = root;
  for (const part of parts.slice(0, -1)) {
    const nested: unknown = current?.[part];
    if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return;
    current = nested as Record<string, unknown>;
  }
  if (current) delete current[parts.at(-1) ?? ""];
}

async function manifest(directory: string): Promise<{ readonly path: string; readonly value: Record<string, unknown> }> {
  const path = join(directory, "package.json");
  const bytes = await readFile(path, "utf8");
  parseManifest(bytes, path);
  const value = JSON.parse(bytes) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ManifestError(`${path}: root must be an object`);
  return { path, value: value as Record<string, unknown> };
}

async function save(path: string, value: Record<string, unknown>): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    parseManifest(await readFile(temporary, "utf8"), path);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function packageProperties(options: {
  readonly directory: string;
  readonly action: "get" | "set" | "delete";
  readonly operands: readonly string[];
}): Promise<unknown> {
  const loaded = await manifest(options.directory);
  if (options.action === "get") {
    if (options.operands.length === 0) return loaded.value;
    if (options.operands.length === 1) return readAt(loaded.value, options.operands[0] ?? "");
    return Object.fromEntries(options.operands.map((path) => [path, readAt(loaded.value, path)]));
  }
  if (options.action === "set") {
    for (const operand of options.operands) {
      const separator = operand.indexOf("=");
      if (separator <= 0) throw new ManifestError(`pkg set requires key=value, received ${operand}`);
      setAt(loaded.value, operand.slice(0, separator), operand.slice(separator + 1));
    }
  } else {
    for (const operand of options.operands) deleteAt(loaded.value, operand);
  }
  await save(loaded.path, loaded.value);
  return loaded.value;
}
