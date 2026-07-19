import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { defaultConfig, recentReleaseHours, type BnpmConfig, type RecentReleaseHours, type TrustedPackageApproval } from "./types.js";
import type { InteractiveMode } from "./interactive.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Configuration error: ${message}`);
    this.name = "ConfigError";
  }
}

export type ConfigSource = "default" | "global" | "project" | "environment" | "override";

export interface ConfigInput {
  readonly recentReleaseHours?: RecentReleaseHours;
  readonly trustedPackages?: Readonly<Record<string, TrustedPackageApproval>>;
}

export interface EffectiveValue<T> {
  readonly value: T;
  readonly source: ConfigSource;
}

export interface EffectiveConfig {
  readonly recentReleaseHours: EffectiveValue<RecentReleaseHours>;
  readonly trustedPackages: EffectiveValue<Readonly<Record<string, TrustedPackageApproval>>>;
  readonly allowRecent: EffectiveValue<readonly string[]>;
}

const packageName = /^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const exactIdentity = /^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function object(value: unknown, source: string, key: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${source}: ${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function recentHours(value: unknown, source: string): RecentReleaseHours {
  if (typeof value !== "number" || !recentReleaseHours.includes(value as RecentReleaseHours)) {
    throw new ConfigError(`${source}: recentReleaseHours must be one of 1, 6, 24`);
  }
  return value as RecentReleaseHours;
}

function approvals(value: unknown, source: string): Readonly<Record<string, TrustedPackageApproval>> {
  const parsed: Record<string, TrustedPackageApproval> = {};
  for (const [name, approvalValue] of Object.entries(object(value, source, "trustedPackages"))) {
    if (!packageName.test(name)) {
      throw new ConfigError(`${source}: trustedPackages has invalid package name ${name}`);
    }
    const approval = object(approvalValue, source, `trustedPackages.${name}`);
    if (typeof approval.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(approval.version)) {
      throw new ConfigError(`${source}: trustedPackages.${name}.version must be an exact semantic version`);
    }
    if (typeof approval.integrity !== "string" || approval.integrity.length === 0) {
      throw new ConfigError(`${source}: trustedPackages.${name}.integrity must be a non-empty string`);
    }
    const scripts = object(approval.scripts, source, `trustedPackages.${name}.scripts`);
    const parsedScripts: Record<string, { commandHash: string; contentHash: string }> = {};
    for (const [stage, scriptValue] of Object.entries(scripts)) {
      const script = object(scriptValue, source, `trustedPackages.${name}.scripts.${stage}`);
      if (typeof script.commandHash !== "string" || script.commandHash.length === 0 || typeof script.contentHash !== "string" || script.contentHash.length === 0) {
        throw new ConfigError(`${source}: trustedPackages.${name}.scripts.${stage} requires non-empty commandHash and contentHash`);
      }
      parsedScripts[stage] = { commandHash: script.commandHash, contentHash: script.contentHash };
    }
    parsed[name] = { version: approval.version, integrity: approval.integrity, scripts: parsedScripts };
  }
  return parsed;
}

export function parseConfig(bytes: string, source: string): ConfigInput {
  const document = YAML.parseDocument(bytes, { uniqueKeys: true, strict: true });
  if (document.errors.length > 0) {
    throw new ConfigError(`${source}: ${document.errors[0]?.message ?? "invalid YAML"}`);
  }
  const value = document.toJS();
  if (value === null || value === undefined) {
    return {};
  }
  const parsed = object(value, source, "root");
  const allowed = new Set(["recentReleaseHours", "trustedPackages"]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`${source}: unknown security-sensitive key ${key}`);
    }
  }
  return {
    ...(parsed.recentReleaseHours === undefined ? {} : { recentReleaseHours: recentHours(parsed.recentReleaseHours, source) }),
    ...(parsed.trustedPackages === undefined ? {} : { trustedPackages: approvals(parsed.trustedPackages, source) }),
  };
}

export async function loadConfigFile(path: string): Promise<ConfigInput | undefined> {
  try {
    return parseConfig(await readFile(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sourceFor(input: ConfigInput | undefined, source: ConfigSource): ConfigSource | "default" {
  return input?.recentReleaseHours === undefined ? "default" : source;
}

function validateExactOverrides(values: readonly string[]): readonly string[] {
  for (const value of values) {
    if (!exactIdentity.test(value)) {
      throw new ConfigError(`one-shot override must be an exact name@version identity: ${value}`);
    }
  }
  return [...values];
}

export function composeConfig(options: {
  readonly global?: ConfigInput;
  readonly project?: ConfigInput;
  readonly environment?: ConfigInput;
  readonly overrides?: { readonly allowRecent?: readonly string[] };
}): EffectiveConfig {
  const globalHours = options.global?.recentReleaseHours ?? defaultConfig.recentReleaseHours;
  const projectHours = options.project?.recentReleaseHours;
  if (projectHours !== undefined && projectHours < globalHours) {
    throw new ConfigError("project recentReleaseHours cannot weaken global policy");
  }
  const projectEffective = projectHours ?? globalHours;
  const environmentHours = options.environment?.recentReleaseHours;
  if (environmentHours !== undefined && environmentHours < projectEffective) {
    throw new ConfigError("environment recentReleaseHours cannot weaken effective policy");
  }
  const effectiveHours = environmentHours ?? projectEffective;
  const trusted = { ...(options.global?.trustedPackages ?? {}), ...(options.project?.trustedPackages ?? {}) };
  return {
    recentReleaseHours: {
      value: effectiveHours,
      source:
        environmentHours !== undefined
          ? "environment"
          : projectHours !== undefined
            ? "project"
            : sourceFor(options.global, "global"),
    },
    trustedPackages: {
      value: trusted,
      source: options.project?.trustedPackages === undefined ? (options.global?.trustedPackages === undefined ? "default" : "global") : "project",
    },
    allowRecent: {
      value: validateExactOverrides(options.overrides?.allowRecent ?? []),
      source: options.overrides?.allowRecent === undefined ? "default" : "override",
    },
  };
}

async function saveRecencyConfiguration(path: string, hours: RecentReleaseHours): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `recentReleaseHours: ${hours}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true }));
  }
}

export interface RecencySetupOptions {
  readonly commandIsSecuritySensitive: boolean;
  readonly existingConfiguration: boolean;
  readonly mode: InteractiveMode;
  readonly configPath: string;
  readonly prompt?: () => Promise<string | undefined>;
}

export async function selectRecencyConfiguration(options: RecencySetupOptions): Promise<{ readonly hours: RecentReleaseHours; readonly source: "default" | "first-use" }> {
  if (!options.commandIsSecuritySensitive || options.existingConfiguration || !options.mode.interactive || options.prompt === undefined) {
    return { hours: 1, source: "default" };
  }
  for (let attempts = 0; attempts < 3; attempts += 1) {
    const response = await options.prompt();
    if (response === undefined) {
      return { hours: 1, source: "default" };
    }
    if (response === "1" || response === "6" || response === "24") {
      const hours = Number(response) as RecentReleaseHours;
      await saveRecencyConfiguration(options.configPath, hours);
      return { hours, source: "first-use" };
    }
  }
  return { hours: 1, source: "default" };
}
