import { readFile } from "node:fs/promises";
import { ConfigError } from "../config/configuration.js";

interface NpmrcValues {
  readonly registry?: string;
  readonly scopedRegistries: ReadonlyMap<string, string>;
  readonly credentials: ReadonlyMap<string, string>;
}

interface Credential {
  readonly prefix: URL;
  readonly authorization: string;
}

const scopePattern = /^@[a-z0-9][a-z0-9._-]*$/i;

function expandEnvironment(value: string, environment: Readonly<Record<string, string | undefined>>, source: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const replacement = environment[name];
    if (replacement === undefined) throw new ConfigError(`${source}: environment variable ${name} is required by npmrc`);
    return replacement;
  });
}

export function parseNpmrc(bytes: string, source: string, environment: Readonly<Record<string, string | undefined>> = process.env): NpmrcValues {
  let registry: string | undefined;
  const scopedRegistries = new Map<string, string>();
  const credentials = new Map<string, string>();
  for (const [index, rawLine] of bytes.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = expandEnvironment(line.slice(separator + 1).trim(), environment, `${source}:${index + 1}`);
    if (key === "registry") registry = value;
    else if (key.endsWith(":registry")) {
      const scope = key.slice(0, -":registry".length);
      if (!scopePattern.test(scope)) throw new ConfigError(`${source}:${index + 1}: invalid registry scope ${scope}`);
      scopedRegistries.set(scope, value);
    } else if (key.startsWith("//") && (key.endsWith(":_authToken") || key.endsWith(":_auth"))) {
      credentials.set(key, value);
    } else if (key === "_authToken" || key === "_auth") {
      credentials.set(key, value);
    }
  }
  return { ...(registry === undefined ? {} : { registry }), scopedRegistries, credentials };
}

function registryUrl(value: string, source: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConfigError(`${source}: registry must be an absolute URL`); }
  if (url.protocol !== "https:") throw new ConfigError(`${source}: registry must use HTTPS`);
  if (url.username || url.password || url.search || url.hash) throw new ConfigError(`${source}: registry URL must not embed credentials, query, or fragment`);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function credentialPrefix(key: string, defaultRegistry: URL, source: string): { readonly prefix: URL; readonly scheme: "Bearer" | "Basic" } {
  const token = key.endsWith(":_authToken");
  const auth = key.endsWith(":_auth");
  if (!key.startsWith("//")) return { prefix: defaultRegistry, scheme: token || key === "_authToken" ? "Bearer" : "Basic" };
  const suffix = token ? ":_authToken" : auth ? ":_auth" : "";
  const raw = key.slice(0, -suffix.length);
  const prefix = registryUrl(`https:${raw}`, source);
  return { prefix, scheme: token ? "Bearer" : "Basic" };
}

export class RegistryConfiguration {
  readonly defaultRegistry: URL;
  readonly scopedRegistries: ReadonlyMap<string, URL>;
  readonly #credentials: readonly Credential[];

  constructor(options: { readonly defaultRegistry: URL; readonly scopedRegistries?: ReadonlyMap<string, URL>; readonly credentials?: readonly Credential[] }) {
    this.defaultRegistry = options.defaultRegistry;
    this.scopedRegistries = options.scopedRegistries ?? new Map();
    this.#credentials = [...(options.credentials ?? [])].sort((left, right) => right.prefix.href.length - left.prefix.href.length);
  }

  registryForPackage(name: string): URL {
    const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : undefined;
    return (scope === undefined ? undefined : this.scopedRegistries.get(scope)) ?? this.defaultRegistry;
  }

  headersFor(url: URL): Readonly<Record<string, string>> {
    const credential = this.#credentials.find(({ prefix }) => url.origin === prefix.origin && url.pathname.startsWith(prefix.pathname));
    return credential ? { authorization: credential.authorization } : {};
  }
}

async function optionalNpmrc(path: string, environment: Readonly<Record<string, string | undefined>>): Promise<NpmrcValues | undefined> {
  try { return parseNpmrc(await readFile(path, "utf8"), path, environment); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function loadRegistryConfiguration(options: {
  readonly userNpmrc: string;
  readonly projectNpmrc: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly defaultRegistry?: URL;
}): Promise<RegistryConfiguration> {
  const environment = options.environment ?? process.env;
  const user = await optionalNpmrc(options.userNpmrc, environment);
  const project = await optionalNpmrc(options.projectNpmrc, environment);
  const environmentRegistry = environment.npm_config_registry ?? environment.NPM_CONFIG_REGISTRY;
  const defaultRegistry = registryUrl(options.defaultRegistry?.href ?? environmentRegistry ?? project?.registry ?? user?.registry ?? "https://registry.npmjs.org/", "registry configuration");
  const scopedRaw = new Map([...(user?.scopedRegistries ?? []), ...(project?.scopedRegistries ?? [])]);
  const scopedRegistries = new Map([...scopedRaw].map(([scope, value]) => [scope, registryUrl(value, `${scope}:registry`)]));
  const rawCredentials = new Map([...(user?.credentials ?? []), ...(project?.credentials ?? [])]);
  const credentials: Credential[] = [];
  for (const [key, value] of rawCredentials) {
    if (!value) throw new ConfigError(`registry credential ${key} must not be empty`);
    const { prefix, scheme } = credentialPrefix(key, defaultRegistry, key);
    credentials.push({ prefix, authorization: `${scheme} ${value}` });
  }
  return new RegistryConfiguration({ defaultRegistry, scopedRegistries, credentials });
}

export class RoutedRegistryClient {
  readonly #clients = new Map<string, import("./client.js").RegistryClient>();
  constructor(readonly configuration: RegistryConfiguration, readonly fetch: typeof globalThis.fetch = globalThis.fetch) {}
  async packageDocument(name: string, signal?: AbortSignal): Promise<import("./types.js").PackageDocument> {
    const registry = this.configuration.registryForPackage(name);
    let client = this.#clients.get(registry.href);
    if (!client) {
      const { RegistryClient } = await import("./client.js");
      client = new RegistryClient({ registry, fetch: this.fetch, headers: (url) => this.configuration.headersFor(url) });
      this.#clients.set(registry.href, client);
    }
    return client.packageDocument(name, signal);
  }
}
