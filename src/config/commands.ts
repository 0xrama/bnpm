import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import YAML from "yaml";
import type { BnpmPaths } from "./paths.js";
import { ConfigError, loadConfigFile, parseConfig, type ConfigInput } from "./configuration.js";
import { defaultConfig, recentReleaseHours, type RecentReleaseHours } from "./types.js";
import { loadRegistryConfiguration } from "../registry/configuration.js";

export type WritableConfigKey = "registry" | "recentReleaseHours";

function key(value: string): WritableConfigKey {
  if (value !== "registry" && value !== "recentReleaseHours") throw new ConfigError(`unsupported writable key ${value}`);
  return value;
}

async function optional(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

async function atomic(path: string, bytes: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function validRegistry(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConfigError("registry must be an absolute HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new ConfigError("registry must use HTTPS without credentials, query, or fragment");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

async function setRegistry(path: string, value?: string): Promise<void> {
  const lines = (await optional(path)).split(/\r?\n/).filter((line) => !/^\s*registry\s*=/.test(line));
  while (lines.at(-1) === "") lines.pop();
  if (value !== undefined) lines.push(`registry=${validRegistry(value)}`);
  await atomic(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

async function setRecency(path: string, value?: string): Promise<void> {
  const current = await loadConfigFile(path) ?? {};
  let hours: RecentReleaseHours | undefined;
  if (value !== undefined) {
    const number = Number(value);
    if (!recentReleaseHours.includes(number as RecentReleaseHours)) throw new ConfigError("recentReleaseHours must be one of 1, 6, 24");
    hours = number as RecentReleaseHours;
  }
  const next: ConfigInput = { ...(hours === undefined ? {} : { recentReleaseHours: hours }), ...(current.trustedPackages === undefined ? {} : { trustedPackages: current.trustedPackages }) };
  const bytes = Object.keys(next).length === 0 ? "" : YAML.stringify(next, { sortMapEntries: true });
  parseConfig(bytes, path);
  await atomic(path, bytes);
}

export async function getConfig(paths: BnpmPaths, rawKey: string): Promise<string | number> {
  const selected = key(rawKey);
  if (selected === "registry") return (await loadRegistryConfiguration({ userNpmrc: paths.userNpmrc, projectNpmrc: paths.projectNpmrc })).defaultRegistry.href;
  return (await loadConfigFile(paths.globalConfig))?.recentReleaseHours ?? defaultConfig.recentReleaseHours;
}

export async function listConfig(paths: BnpmPaths): Promise<Readonly<Record<WritableConfigKey, string | number>>> {
  return { registry: await getConfig(paths, "registry"), recentReleaseHours: await getConfig(paths, "recentReleaseHours") };
}

export async function mutateConfig(paths: BnpmPaths, action: "set" | "delete", rawKey: string, value?: string): Promise<void> {
  const selected = key(rawKey);
  if (action === "set" && value === undefined) throw new ConfigError(`config set ${selected} requires a value`);
  if (selected === "registry") await setRegistry(paths.userNpmrc, action === "set" ? value : undefined);
  else await setRecency(paths.globalConfig, action === "set" ? value : undefined);
}
