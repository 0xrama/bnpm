import { join } from "node:path";

export interface PathEnvironment {
  readonly home?: string;
  readonly cwd?: string;
  readonly temp?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export interface BnpmPaths {
  readonly globalConfig: string;
  readonly userNpmrc: string;
  readonly store: string;
  readonly cache: string;
  readonly quarantine: string;
  readonly projectConfig: string;
  readonly projectNpmrc: string;
  readonly lockfile: string;
  readonly virtualStore: string;
  readonly ephemeralRoot: string;
  readonly globalRoot: string;
  readonly globalBin: string;
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required to resolve bnpm paths`);
  }
  return value;
}

export function createBnpmPaths(options: PathEnvironment = {}): BnpmPaths {
  const environment = options.environment ?? process.env;
  const home = options.home ?? environment.HOME;
  const cwd = options.cwd ?? process.cwd();
  const temp = options.temp ?? environment.TMPDIR ?? environment.TEMP ?? "/tmp";
  const platform = options.platform ?? process.platform;
  const configHome =
    environment.BNPM_CONFIG_HOME ??
    (platform === "darwin"
      ? join(required(home, "HOME"), "Library", "Application Support", "bnpm")
      : platform === "win32"
        ? join(environment.APPDATA ?? join(required(home, "HOME"), "AppData", "Roaming"), "bnpm")
      : join(required(home, "HOME"), ".config", "bnpm"));
  const cacheHome =
    environment.BNPM_CACHE_HOME ??
    (platform === "darwin"
      ? join(required(home, "HOME"), "Library", "Caches", "bnpm")
      : platform === "win32"
        ? join(environment.LOCALAPPDATA ?? join(required(home, "HOME"), "AppData", "Local"), "bnpm")
      : join(required(home, "HOME"), ".cache", "bnpm"));
  const globalRoot = environment.BNPM_GLOBAL_HOME ?? (platform === "darwin"
    ? join(required(home, "HOME"), "Library", "Application Support", "bnpm", "global")
    : platform === "win32"
      ? join(environment.LOCALAPPDATA ?? join(required(home, "HOME"), "AppData", "Local"), "bnpm", "global")
      : join(environment.XDG_DATA_HOME ?? join(required(home, "HOME"), ".local", "share"), "bnpm", "global"));
  return {
    globalConfig: join(configHome, "config.yaml"),
    userNpmrc: environment.NPM_CONFIG_USERCONFIG ?? join(required(home, "HOME"), ".npmrc"),
    store: join(cacheHome, "store"),
    cache: join(cacheHome, "cache"),
    quarantine: join(cacheHome, "quarantine"),
    projectConfig: join(cwd, "bnpm.yaml"),
    projectNpmrc: join(cwd, ".npmrc"),
    lockfile: join(cwd, "bnpm-lock.yaml"),
    virtualStore: join(cwd, "node_modules", ".bnpm"),
    ephemeralRoot: join(temp, "bnpmx"),
    globalRoot,
    globalBin: join(globalRoot, "bin"),
  };
}
