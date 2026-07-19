import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { RegistryError } from "./client.js";
import { loadRegistryConfiguration } from "./configuration.js";
import type { BnpmPaths } from "../config/paths.js";

const maxResponseBytes = 1024 * 1024;

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new RegistryError("Registry returned an empty account response", response.status);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > maxResponseBytes) throw new RegistryError("Registry account response exceeded the size limit", response.status);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new RegistryError("Registry returned invalid account JSON", response.status);
  }
}

function secureUrl(value: unknown, purpose: string): URL {
  let url: URL;
  try { url = new URL(typeof value === "string" ? value : ""); } catch { throw new RegistryError(`Registry returned an invalid ${purpose} URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new RegistryError(`Registry returned an unsafe ${purpose} URL`);
  return url;
}

function credentialKey(registry: URL): string {
  return `//${registry.host}${registry.pathname}:_authToken`;
}

async function npmrc(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

async function updateCredential(path: string, registry: URL, token?: string): Promise<void> {
  const key = credentialKey(registry);
  const lines = (await npmrc(path)).split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith(`${key}=`) && !trimmed.startsWith(`${key.replace(":_authToken", ":_auth") }=`);
  });
  while (lines.at(-1) === "") lines.pop();
  if (token !== undefined) lines.push(`${key}=${token}`);
  const bytes = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function updateBasicCredential(path: string, registry: URL, username: string, password: string): Promise<void> {
  const key = credentialKey(registry).replace(":_authToken", ":_auth");
  const tokenKey = key.replace(":_auth", ":_authToken");
  const lines = (await npmrc(path)).split(/\r?\n/).filter((line) => { const trimmed = line.trim(); return !trimmed.startsWith(`${key}=`) && !trimmed.startsWith(`${tokenKey}=`); });
  while (lines.at(-1) === "") lines.pop();
  lines.push(`${key}=${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try { await writeFile(temporary, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

async function configuration(paths: BnpmPaths, registry?: URL) {
  const loaded = await loadRegistryConfiguration({ userNpmrc: paths.userNpmrc, projectNpmrc: paths.projectNpmrc, ...(registry === undefined ? {} : { defaultRegistry: registry }) });
  return { loaded, registry: registry ?? loaded.defaultRegistry };
}

export async function registryWhoami(options: { readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<string> {
  const { loaded, registry } = await configuration(options.paths, options.registry);
  const response = await (options.fetch ?? globalThis.fetch)(new URL("/-/whoami", registry), {
    redirect: "error",
    signal: requestSignal(options.signal),
    headers: { accept: "application/json", ...loaded.headersFor(registry) },
  });
  if (!response.ok) throw new RegistryError(`Registry identity request failed with ${response.status}`, response.status);
  const body = await json(response);
  if (typeof body.username !== "string" || body.username.length === 0) throw new RegistryError("Registry identity response has no username");
  return body.username;
}

export async function registryLogin(options: {
  readonly paths: BnpmPaths;
  readonly registry?: URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly open: (url: URL) => Promise<void>;
  readonly announce?: (url: URL) => void;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<{ readonly registry: string; readonly loginUrl: string }> {
  const { registry } = await configuration(options.paths, options.registry);
  const request = options.fetch ?? globalThis.fetch;
  const response = await request(new URL("/-/v1/login", registry), {
    method: "POST",
    redirect: "error",
    signal: requestSignal(options.signal),
    headers: { accept: "application/json", "content-type": "application/json", "npm-auth-type": "web" },
    body: "{}",
  });
  if (!response.ok) throw new RegistryError(`Registry web login is unavailable (${response.status})`, response.status);
  const body = await json(response);
  const loginUrl = secureUrl(body.loginUrl, "login");
  const doneUrl = secureUrl(body.doneUrl, "login completion");
  options.announce?.(loginUrl);
  await options.open(loginUrl);
  const now = options.now ?? Date.now;
  const deadline = now() + 10 * 60_000;
  const wait = options.wait ?? (async (milliseconds, signal) => { await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }); });
  while (now() < deadline) {
    const check = await request(doneUrl, { redirect: "error", signal: requestSignal(options.signal), headers: { accept: "application/json" } });
    const result = await json(check);
    if (check.status === 200) {
      if (typeof result.token !== "string" || result.token.length === 0) throw new RegistryError("Registry completed login without a token");
      await updateCredential(options.paths.userNpmrc, registry, result.token);
      return { registry: registry.href, loginUrl: loginUrl.href };
    }
    if (check.status !== 202) throw new RegistryError(`Registry login polling failed with ${check.status}`, check.status);
    const retry = Number(check.headers.get("retry-after"));
    await wait(Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 30_000) : 1000, options.signal);
  }
  throw new RegistryError("Registry login timed out");
}

export async function registryLegacyLogin(options: {
  readonly paths: BnpmPaths;
  readonly username: string;
  readonly password: string;
  readonly email?: string;
  readonly create?: boolean;
  readonly registry?: URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly otp?: string;
}): Promise<{ readonly registry: string; readonly username: string; readonly created: boolean }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.username)) throw new RegistryError("Legacy login requires a valid username");
  if (!options.password || options.password.length > 1024) throw new RegistryError("Legacy login requires a bounded password");
  if (options.create && (!options.email || options.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(options.email))) throw new RegistryError("Legacy adduser requires a valid email address");
  const { registry } = await configuration(options.paths, options.registry);
  const request = options.fetch ?? globalThis.fetch;
  const endpoint = new URL(`/-/user/org.couchdb.user:${encodeURIComponent(options.username)}`, registry);
  const base = { _id: `org.couchdb.user:${options.username}`, name: options.username, password: options.password, ...(options.email === undefined ? {} : { email: options.email }), type: "user", roles: [] as string[], date: new Date().toISOString() };
  const headers = { accept: "application/json", "content-type": "application/json", ...(options.otp === undefined ? {} : { "npm-otp": options.otp }) };
  const initial = await request(endpoint, { method: "PUT", redirect: "error", signal: requestSignal(options.signal), headers, body: JSON.stringify(base) });
  let result: Record<string, unknown>;
  if (initial.ok) result = await json(initial);
  else {
    if (options.create || initial.status !== 409) throw new RegistryError(`Legacy registry login failed with ${initial.status}`, initial.status);
    const readUrl = new URL(endpoint); readUrl.searchParams.set("write", "true");
    const read = await request(readUrl, { redirect: "error", signal: requestSignal(options.signal), headers: { accept: "application/json" } });
    if (!read.ok) throw new RegistryError(`Legacy registry identity lookup failed with ${read.status}`, read.status);
    const current = await json(read);
    if (typeof current._rev !== "string" || current._rev.length === 0) throw new RegistryError("Legacy registry identity has no revision");
    const document = { ...current, ...base, roles: Array.isArray(current.roles) ? current.roles : [] };
    const update = new URL(`${endpoint.pathname}/-rev/${encodeURIComponent(current._rev)}`, registry);
    const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`, "utf8").toString("base64")}`;
    const response = await request(update, { method: "PUT", redirect: "error", signal: requestSignal(options.signal), headers: { ...headers, authorization }, body: JSON.stringify(document) });
    if (!response.ok) throw new RegistryError(`Legacy registry authentication failed with ${response.status}`, response.status);
    result = await json(response);
  }
  if (typeof result.token === "string" && result.token.length > 0) await updateCredential(options.paths.userNpmrc, registry, result.token);
  else await updateBasicCredential(options.paths.userNpmrc, registry, options.username, options.password);
  return { registry: registry.href, username: options.username, created: options.create === true };
}

export async function registryLogout(options: { readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<string> {
  const { loaded, registry } = await configuration(options.paths, options.registry);
  const authorization = loaded.headersFor(registry).authorization;
  if (!authorization?.startsWith("Bearer ")) throw new RegistryError(`Not logged in to ${registry.href}`);
  const token = authorization.slice("Bearer ".length);
  const response = await (options.fetch ?? globalThis.fetch)(new URL(`/-/user/token/${encodeURIComponent(token)}`, registry), {
    method: "DELETE",
    redirect: "error",
    signal: requestSignal(options.signal),
    headers: { accept: "application/json", authorization },
  });
  if (!response.ok) throw new RegistryError(`Registry logout failed with ${response.status}`, response.status);
  await updateCredential(options.paths.userNpmrc, registry);
  return registry.href;
}

export interface RegistryToken { readonly id: string; readonly name?: string; readonly created?: string; readonly readonly: boolean; readonly cidr: readonly string[] }
export interface CreatedRegistryToken { readonly token: string; readonly name?: string; readonly created?: string; readonly expires?: string; readonly readonly?: boolean; readonly cidr?: readonly string[] }

interface RawToken { readonly key: string; readonly name?: string; readonly created?: string; readonly readonly?: boolean; readonly cidr_whitelist?: readonly string[] }

async function tokenPage(url: URL, loaded: Awaited<ReturnType<typeof loadRegistryConfiguration>>, request: typeof globalThis.fetch, signal?: AbortSignal): Promise<{ readonly tokens: readonly RawToken[]; readonly next?: URL }> {
  const response = await request(url, { redirect: "error", signal: requestSignal(signal), headers: { accept: "application/json", ...loaded.headersFor(url) } });
  if (!response.ok) throw new RegistryError(`Registry token request failed with ${response.status}`, response.status);
  const body = await json(response);
  if (!Array.isArray(body.objects)) throw new RegistryError("Registry token response has no objects array");
  const tokens = body.objects.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value) || typeof (value as { key?: unknown }).key !== "string") throw new RegistryError("Registry returned an invalid token record");
    const token = value as { key: string; name?: unknown; created?: unknown; readonly?: unknown; cidr_whitelist?: unknown };
    if (token.name !== undefined && typeof token.name !== "string" || token.created !== undefined && typeof token.created !== "string" || token.readonly !== undefined && typeof token.readonly !== "boolean" || token.cidr_whitelist !== undefined && (!Array.isArray(token.cidr_whitelist) || token.cidr_whitelist.some((entry) => typeof entry !== "string"))) throw new RegistryError("Registry returned invalid token metadata");
    return { key: token.key, ...(token.name === undefined ? {} : { name: token.name }), ...(token.created === undefined ? {} : { created: token.created }), readonly: token.readonly === true, cidr_whitelist: (token.cidr_whitelist ?? []) as string[] };
  });
  const nextValue = typeof body.urls === "object" && body.urls !== null && !Array.isArray(body.urls) ? (body.urls as { next?: unknown }).next : undefined;
  if (nextValue !== undefined && typeof nextValue !== "string") throw new RegistryError("Registry token pagination URL is invalid");
  return { tokens, ...(nextValue === undefined || nextValue === "" ? {} : { next: new URL(nextValue, url) }) };
}

async function rawTokens(options: { readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<{ readonly loaded: Awaited<ReturnType<typeof loadRegistryConfiguration>>; readonly registry: URL; readonly tokens: readonly RawToken[] }> {
  const { loaded, registry } = await configuration(options.paths, options.registry);
  const request = options.fetch ?? globalThis.fetch;
  const tokens: RawToken[] = [];
  let url: URL | undefined = new URL("/-/npm/v1/tokens", registry);
  for (let pages = 0; url !== undefined && pages < 100; pages += 1) {
    if (url.protocol !== "https:" || url.origin !== registry.origin) throw new RegistryError("Registry token pagination must remain on the HTTPS registry origin");
    const page = await tokenPage(url, loaded, request, options.signal);
    tokens.push(...page.tokens);
    if (tokens.length > 10_000) throw new RegistryError("Registry returned more than 10,000 tokens");
    url = page.next;
  }
  if (url !== undefined) throw new RegistryError("Registry token pagination exceeded 100 pages");
  return { loaded, registry, tokens };
}

function tokenIds(tokens: readonly RawToken[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const token of tokens) {
    let id = token.key;
    for (let length = 6; length < token.key.length; length += 1) {
      const candidate = token.key.slice(0, length);
      if (!tokens.some((other) => other !== token && other.key.startsWith(candidate))) { id = candidate; break; }
    }
    result.set(token.key, id);
  }
  return result;
}

export async function registryTokens(options: { readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<readonly RegistryToken[]> {
  const { tokens } = await rawTokens(options); const ids = tokenIds(tokens);
  return tokens.map((token) => ({ id: ids.get(token.key) ?? token.key, ...(token.name === undefined ? {} : { name: token.name }), ...(token.created === undefined ? {} : { created: token.created }), readonly: token.readonly === true, cidr: token.cidr_whitelist ?? [] }));
}

export async function revokeRegistryTokens(options: { readonly ids: readonly string[]; readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal; readonly otp?: string }): Promise<readonly string[]> {
  const { loaded, registry, tokens } = await rawTokens(options);
  const keys = options.ids.map((id) => {
    const matches = tokens.filter((token) => token.key.startsWith(id));
    if (matches.length !== 1) throw new RegistryError(matches.length === 0 ? `Unknown token id ${id}` : `Ambiguous token id ${id}`);
    return matches[0]?.key as string;
  });
  for (const key of keys) {
    const url = new URL(`/-/npm/v1/tokens/token/${encodeURIComponent(key)}`, registry);
    const response = await (options.fetch ?? globalThis.fetch)(url, { method: "DELETE", redirect: "error", signal: requestSignal(options.signal), headers: { accept: "application/json", ...loaded.headersFor(url), ...(options.otp === undefined ? {} : { "npm-otp": options.otp }) } });
    if (!response.ok) throw new RegistryError(`Registry token revocation failed with ${response.status}`, response.status);
  }
  return options.ids;
}

export async function createRegistryToken(options: {
  readonly paths: BnpmPaths;
  readonly password: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly registry?: URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly otp?: string;
}): Promise<CreatedRegistryToken> {
  if (!options.password || options.password.length > 1024) throw new RegistryError("A bounded account password is required to create a token");
  const { loaded, registry } = await configuration(options.paths, options.registry);
  const url = new URL("/-/npm/v1/tokens", registry);
  const body = JSON.stringify({ ...options.body, password: options.password });
  const response = await (options.fetch ?? globalThis.fetch)(url, { method: "POST", redirect: "error", signal: requestSignal(options.signal), headers: { accept: "application/json", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...loaded.headersFor(url), ...(options.otp === undefined ? {} : { "npm-otp": options.otp }) }, body });
  if (!response.ok) throw new RegistryError(`Registry token creation failed with ${response.status}`, response.status);
  const result = await json(response);
  if (typeof result.token !== "string" || result.token.length < 8 || result.token.length > 4096) throw new RegistryError("Registry token creation response has no bounded token");
  if ((result.name !== undefined && typeof result.name !== "string") || (result.created !== undefined && typeof result.created !== "string") || (result.expires !== undefined && typeof result.expires !== "string") || (result.readonly !== undefined && typeof result.readonly !== "boolean") || (result.cidr_whitelist !== undefined && (!Array.isArray(result.cidr_whitelist) || result.cidr_whitelist.some((value) => typeof value !== "string")))) throw new RegistryError("Registry returned invalid created token metadata");
  return { token: result.token, ...(result.name === undefined ? {} : { name: result.name as string }), ...(result.created === undefined ? {} : { created: result.created as string }), ...(result.expires === undefined ? {} : { expires: result.expires as string }), ...(result.readonly === undefined ? {} : { readonly: result.readonly as boolean }), ...(result.cidr_whitelist === undefined ? {} : { cidr: result.cidr_whitelist as string[] }) };
}
