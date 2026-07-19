import npa from "npm-package-arg";
import semver from "semver";
import { downloadUnverifiedToQuarantine, type QuarantinedTarball } from "../cache/quarantine.js";
import type { BnpmPaths } from "../config/paths.js";
import { RegistryError } from "./client.js";
import { loadRegistryConfiguration, type RegistryConfiguration } from "./configuration.js";

const maxBytes = 32 * 1024 * 1024;

async function boundedJson(response: Response, allowArray = false): Promise<Record<string, unknown> | readonly unknown[]> {
  if (!response.body) throw new RegistryError("Registry returned an empty response", response.status);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes) throw new RegistryError("Registry response exceeded the size limit", response.status);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || (!allowArray && Array.isArray(value))) throw new Error("not an object");
    return value as Record<string, unknown> | readonly unknown[];
  } catch {
    throw new RegistryError("Registry returned invalid JSON", response.status);
  }
}

async function context(paths: BnpmPaths, name: string, override?: URL) {
  const configuration = await loadRegistryConfiguration({ userNpmrc: paths.userNpmrc, projectNpmrc: paths.projectNpmrc, ...(override === undefined ? {} : { defaultRegistry: override }) });
  return { configuration, registry: override ?? configuration.registryForPackage(name) };
}

interface JsonRequestOptions {
  readonly configuration: RegistryConfiguration;
  readonly registry: URL;
  readonly path: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly body?: string;
  readonly otp?: string | undefined;
  readonly allowArray?: boolean;
}

async function requestJson(options: JsonRequestOptions & { readonly allowArray: true }): Promise<Record<string, unknown> | readonly unknown[]>;
async function requestJson(options: JsonRequestOptions): Promise<Record<string, unknown>>;
async function requestJson(options: JsonRequestOptions): Promise<Record<string, unknown> | readonly unknown[]> {
  let url = new URL(options.path, options.registry);
  const request = options.fetch ?? globalThis.fetch;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const timeout = AbortSignal.timeout(30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await request(url, {
      method: options.method ?? "GET",
      redirect: "manual",
      signal,
      headers: {
        accept: "application/json",
        ...options.configuration.headersFor(url),
        ...(options.body === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(options.body)) }),
        ...(options.otp === undefined ? {} : { "npm-otp": options.otp }),
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    if ([307, 308].includes(response.status) || ((options.method === undefined || options.method === "GET") && [301, 302, 303].includes(response.status))) {
      if (redirects === 5) throw new RegistryError("Registry request exceeded the redirect limit");
      const location = response.headers.get("location");
      if (!location) throw new RegistryError("Registry redirect did not provide a location");
      url = new URL(location, url);
      if (url.protocol !== "https:" || url.origin !== options.registry.origin) throw new RegistryError("Registry redirect must remain on the HTTPS registry origin");
      continue;
    }
    if (!response.ok) throw new RegistryError(`Registry request failed with ${response.status}`, response.status);
    if (response.status === 204 || !response.body) return {};
    return boundedJson(response, options.allowArray === true);
  }
  throw new RegistryError("Registry request exceeded the redirect limit");
}

function packageSpec(value: string): { readonly name: string; readonly escapedName: string; readonly rawSpec: string } {
  let parsed: npa.Result;
  try { parsed = npa(value); } catch { throw new RegistryError(`Invalid package specification ${value}`); }
  if (!parsed.name || !["tag", "range", "version"].includes(parsed.type)) throw new RegistryError(`Package specification must use a registry name and version: ${value}`);
  const escapedName = "escapedName" in parsed && typeof parsed.escapedName === "string" ? parsed.escapedName : encodeURIComponent(parsed.name);
  return { name: parsed.name, escapedName, rawSpec: parsed.rawSpec || "latest" };
}

export async function viewPackage(options: { readonly spec: string; readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<Record<string, unknown>> {
  const spec = packageSpec(options.spec);
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  const document = await requestJson({ configuration, registry, path: `/${spec.escapedName}`, fetch: options.fetch, signal: options.signal });
  const versions = document.versions;
  const tags = document["dist-tags"];
  if (typeof versions !== "object" || versions === null || Array.isArray(versions) || typeof tags !== "object" || tags === null || Array.isArray(tags)) throw new RegistryError("Package metadata is missing versions or distribution tags");
  const versionMap = versions as Record<string, unknown>;
  const tagMap = tags as Record<string, unknown>;
  const requested = typeof tagMap[spec.rawSpec] === "string" ? tagMap[spec.rawSpec] as string : semver.valid(spec.rawSpec) ? spec.rawSpec : semver.maxSatisfying(Object.keys(versionMap), spec.rawSpec);
  if (!requested || typeof versionMap[requested] !== "object" || versionMap[requested] === null) throw new RegistryError(`No version of ${spec.name} satisfies ${spec.rawSpec}`);
  return { ...(versionMap[requested] as Record<string, unknown>), "dist-tags": tagMap };
}

export async function searchPackages(options: { readonly terms: readonly string[]; readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<readonly Record<string, unknown>[]> {
  if (options.terms.length === 0) throw new RegistryError("Search requires at least one term");
  const { configuration, registry } = await context(options.paths, "", options.registry);
  const url = new URL("/-/v1/search", registry);
  url.searchParams.set("text", options.terms.join(" "));
  url.searchParams.set("size", "20");
  const result = await requestJson({ configuration, registry, path: url.href, fetch: options.fetch, signal: options.signal });
  if (!Array.isArray(result.objects)) throw new RegistryError("Registry search response has no objects array");
  return result.objects.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const pkg = (entry as { package?: unknown }).package;
    return typeof pkg === "object" && pkg !== null && !Array.isArray(pkg) ? [pkg as Record<string, unknown>] : [];
  });
}

export async function listDistTags(options: { readonly package: string; readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<Readonly<Record<string, string>>> {
  const spec = packageSpec(options.package);
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  const result = await requestJson({ configuration, registry, path: `/-/package/${spec.escapedName}/dist-tags`, fetch: options.fetch, signal: options.signal });
  const tags: Record<string, string> = {};
  for (const [tag, version] of Object.entries(result)) if (tag !== "_etag" && typeof version === "string") tags[tag] = version;
  return tags;
}

export async function mutateDistTag(options: { readonly action: "add" | "remove"; readonly package: string; readonly tag: string; readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal; readonly otp?: string }): Promise<void> {
  const spec = packageSpec(options.package);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.tag) || semver.validRange(options.tag)) throw new RegistryError(`Invalid distribution tag ${options.tag}`);
  if (options.action === "add" && !semver.valid(spec.rawSpec)) throw new RegistryError("dist-tag add requires an exact package version");
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  await requestJson({ configuration, registry, path: `/-/package/${spec.escapedName}/dist-tags/${encodeURIComponent(options.tag)}`, method: options.action === "add" ? "PUT" : "DELETE", ...(options.action === "add" ? { body: JSON.stringify(spec.rawSpec) } : {}), fetch: options.fetch, signal: options.signal, otp: options.otp });
}

export async function deprecatePackage(options: { readonly package: string; readonly message: string; readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal; readonly otp?: string; readonly dryRun?: boolean }): Promise<readonly string[]> {
  const spec = packageSpec(options.package);
  if (!semver.validRange(spec.rawSpec, { loose: true })) throw new RegistryError(`Invalid version range ${spec.rawSpec}`);
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  const document = await requestJson({ configuration, registry, path: `/${spec.escapedName}?write=true`, fetch: options.fetch, signal: options.signal });
  if (typeof document.versions !== "object" || document.versions === null || Array.isArray(document.versions)) throw new RegistryError("Package metadata has no versions");
  const versions = document.versions as Record<string, unknown>;
  const selected = Object.keys(versions).filter((version) => semver.satisfies(version, spec.rawSpec, { includePrerelease: true, loose: true })).sort(semver.compare);
  for (const version of selected) {
    const manifest = versions[version];
    if (typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)) (manifest as Record<string, unknown>).deprecated = options.message;
  }
  if (!options.dryRun && selected.length > 0) await requestJson({ configuration, registry, path: `/${spec.escapedName}`, method: "PUT", body: JSON.stringify(document), fetch: options.fetch, signal: options.signal, otp: options.otp });
  return selected;
}

export async function unpublishPackage(options: { readonly package: string; readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal; readonly otp?: string; readonly force?: boolean; readonly dryRun?: boolean }): Promise<{ readonly name: string; readonly version?: string; readonly entirePackage: boolean }> {
  const spec = packageSpec(options.package);
  if (spec.rawSpec !== "*" && !semver.valid(spec.rawSpec)) throw new RegistryError("Unpublish requires an exact version or name@*");
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  const document = await requestJson({ configuration, registry, path: `/${spec.escapedName}?write=true`, fetch: options.fetch, signal: options.signal });
  const revision = document._rev;
  const versionsValue = document.versions;
  const tagsValue = document["dist-tags"];
  if (typeof revision !== "string" || typeof versionsValue !== "object" || versionsValue === null || Array.isArray(versionsValue) || typeof tagsValue !== "object" || tagsValue === null || Array.isArray(tagsValue)) throw new RegistryError("Package metadata is missing revision, versions, or distribution tags");
  const versions = versionsValue as Record<string, unknown>;
  const tags = tagsValue as Record<string, unknown>;
  const selected = spec.rawSpec === "*" ? undefined : spec.rawSpec;
  if (selected && versions[selected] === undefined) return { name: spec.name, version: selected, entirePackage: false };
  const entirePackage = selected === undefined || Object.keys(versions).length <= 1;
  if (entirePackage && !options.force) throw new RegistryError("Refusing to remove an entire package or its last version without --force");
  if (options.dryRun) return { name: spec.name, ...(selected === undefined ? {} : { version: selected }), entirePackage };
  if (entirePackage) {
    await requestJson({ configuration, registry, path: `/${spec.escapedName}/-rev/${encodeURIComponent(revision)}`, method: "DELETE", fetch: options.fetch, signal: options.signal, otp: options.otp });
    return { name: spec.name, ...(selected === undefined ? {} : { version: selected }), entirePackage: true };
  }
  const manifest = versions[selected as string];
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) throw new RegistryError(`Package metadata for ${spec.name}@${selected} is invalid`);
  const dist = (manifest as { dist?: unknown }).dist;
  if (typeof dist !== "object" || dist === null || Array.isArray(dist) || typeof (dist as { tarball?: unknown }).tarball !== "string") throw new RegistryError(`Package metadata for ${spec.name}@${selected} has no tarball`);
  const tarball = new URL((dist as { tarball: string }).tarball);
  if (tarball.protocol !== "https:" || tarball.origin !== registry.origin || !tarball.pathname.startsWith(registry.pathname)) throw new RegistryError("Refusing to delete a tarball outside the selected HTTPS registry");
  delete versions[selected as string];
  for (const [tag, version] of Object.entries(tags)) if (version === selected) delete tags[tag];
  if (tags.latest === undefined) tags.latest = Object.keys(versions).filter((version) => semver.valid(version)).sort(semver.compare).at(-1);
  delete document._revisions;
  delete document._attachments;
  await requestJson({ configuration, registry, path: `/${spec.escapedName}/-rev/${encodeURIComponent(revision)}`, method: "PUT", body: JSON.stringify(document), fetch: options.fetch, signal: options.signal, otp: options.otp });
  const updated = await requestJson({ configuration, registry, path: `/${spec.escapedName}?write=true`, fetch: options.fetch, signal: options.signal });
  if (typeof updated._rev !== "string") throw new RegistryError("Updated package metadata has no revision");
  await requestJson({ configuration, registry, path: `${tarball.pathname}/-rev/${encodeURIComponent(updated._rev)}`, method: "DELETE", fetch: options.fetch, signal: options.signal, otp: options.otp });
  return { name: spec.name, version: selected, entirePackage: false };
}

interface RegistryMutationOptions { readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal; readonly otp?: string }

export async function packageAccess(options: RegistryMutationOptions & { readonly package: string; readonly action: "status" | "collaborators" }): Promise<Readonly<Record<string, string>> | { readonly public: boolean }> {
  const spec = packageSpec(options.package);
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  const result = await requestJson({ configuration, registry, path: `/-/package/${spec.escapedName}/${options.action === "status" ? "visibility" : "collaborators"}`, fetch: options.fetch, signal: options.signal });
  if (options.action === "status") {
    if (typeof result.public !== "boolean") throw new RegistryError("Registry visibility response has no public status");
    return { public: result.public };
  }
  const collaborators: Record<string, string> = {};
  for (const [name, permission] of Object.entries(result)) if (typeof permission === "string") collaborators[name] = permission === "read" ? "read-only" : permission === "write" ? "read-write" : permission;
  return collaborators;
}

export async function accessiblePackages(options: RegistryMutationOptions & { readonly owner: string }): Promise<Readonly<Record<string, string>>> {
  const owner = options.owner.replace(/^@/, "");
  const parts = owner.split(":");
  if (parts.length > 2 || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) throw new RegistryError("Invalid access owner or team");
  const { configuration, registry } = await context(options.paths, parts.length === 2 ? `@${parts[0]}/placeholder` : "", options.registry);
  const primary = parts.length === 2 ? `/-/team/${encodeURIComponent(parts[0] as string)}/${encodeURIComponent(parts[1] as string)}/package` : `/-/org/${encodeURIComponent(parts[0] as string)}/package`;
  let result: Record<string, unknown>;
  try { result = await requestJson({ configuration, registry, path: primary, fetch: options.fetch, signal: options.signal }); }
  catch (error) {
    if (!(error instanceof RegistryError) || error.status !== 404 || parts.length !== 1) throw error;
    result = await requestJson({ configuration, registry, path: `/-/user/${encodeURIComponent(parts[0] as string)}/package`, fetch: options.fetch, signal: options.signal });
  }
  const packages: Record<string, string> = {};
  for (const [name, permission] of Object.entries(result)) if (typeof permission === "string") packages[name] = permission === "read" ? "read-only" : permission === "write" ? "read-write" : permission;
  return packages;
}

export async function setPackageAccess(options: RegistryMutationOptions & { readonly package: string; readonly access?: "public" | "private"; readonly mfa?: "none" | "publish" | "automation" }): Promise<void> {
  const spec = packageSpec(options.package);
  if (options.mfa === undefined && options.access === undefined) throw new RegistryError("Package access mutation requires access or mfa");
  if (options.access === "private" && !spec.name.startsWith("@")) throw new RegistryError("Private access is only available for scoped packages");
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  const body = options.mfa === undefined
    ? { access: options.access === "private" ? "restricted" : "public" }
    : options.mfa === "none"
      ? { publish_requires_tfa: false }
      : { publish_requires_tfa: true, automation_token_overrides_tfa: options.mfa === "automation" };
  await requestJson({ configuration, registry, path: `/-/package/${spec.escapedName}/access`, method: "POST", body: JSON.stringify(body), fetch: options.fetch, signal: options.signal, otp: options.otp });
}

function team(value: string): { readonly scope: string; readonly team: string } {
  const [scope, name, extra] = value.replace(/^@/, "").split(":");
  if (!scope || !name || extra !== undefined || !/^[A-Za-z0-9._-]+$/.test(scope) || !/^[A-Za-z0-9._-]+$/.test(name)) throw new RegistryError("Team must use scope:team format");
  return { scope, team: name };
}

export async function mutateTeamAccess(options: RegistryMutationOptions & { readonly package: string; readonly team: string; readonly permission?: "read-only" | "read-write" }): Promise<void> {
  const spec = packageSpec(options.package); const parsedTeam = team(options.team);
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  await requestJson({ configuration, registry, path: `/-/team/${encodeURIComponent(parsedTeam.scope)}/${encodeURIComponent(parsedTeam.team)}/package`, method: options.permission === undefined ? "DELETE" : "PUT", body: JSON.stringify({ package: spec.name, ...(options.permission === undefined ? {} : { permissions: options.permission }) }), fetch: options.fetch, signal: options.signal, otp: options.otp });
}

export interface PackageOwner { readonly name: string; readonly email: string }

export async function packageOwners(options: RegistryMutationOptions & { readonly package: string }): Promise<readonly PackageOwner[]> {
  const spec = packageSpec(options.package);
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  const document = await requestJson({ configuration, registry, path: `/${spec.escapedName}?write=true`, fetch: options.fetch, signal: options.signal });
  if (document.maintainers === undefined) return [];
  if (!Array.isArray(document.maintainers)) throw new RegistryError("Package maintainers must be an array");
  return document.maintainers.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value) || typeof (value as { name?: unknown }).name !== "string" || typeof (value as { email?: unknown }).email !== "string") throw new RegistryError("Package metadata contains an invalid maintainer");
    return { name: (value as { name: string }).name, email: (value as { email: string }).email };
  });
}

export async function mutatePackageOwner(options: RegistryMutationOptions & { readonly package: string; readonly user: string; readonly action: "add" | "remove" }): Promise<readonly PackageOwner[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.user)) throw new RegistryError("Invalid registry username");
  const spec = packageSpec(options.package);
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  const user = await requestJson({ configuration, registry, path: `/-/user/org.couchdb.user:${encodeURIComponent(options.user)}`, fetch: options.fetch, signal: options.signal });
  if (typeof user.name !== "string" || typeof user.email !== "string") throw new RegistryError("Registry user response has no name or email");
  const document = await requestJson({ configuration, registry, path: `/${spec.escapedName}?write=true`, fetch: options.fetch, signal: options.signal });
  if (typeof document._id !== "string" || typeof document._rev !== "string" || (document.maintainers !== undefined && !Array.isArray(document.maintainers))) throw new RegistryError("Package metadata is missing owner revision data");
  const owners = (document.maintainers ?? []) as unknown[];
  const normalized = owners.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value) || typeof (value as { name?: unknown }).name !== "string" || typeof (value as { email?: unknown }).email !== "string") throw new RegistryError("Package metadata contains an invalid maintainer");
    return { name: (value as { name: string }).name, email: (value as { email: string }).email };
  });
  const next = options.action === "add" ? [...normalized.filter((owner) => owner.name !== user.name), { name: user.name, email: user.email }] : normalized.filter((owner) => owner.name !== user.name);
  if (options.action === "remove" && next.length === 0) throw new RegistryError("Cannot remove the last package owner");
  await requestJson({ configuration, registry, path: `/${spec.escapedName}/-rev/${encodeURIComponent(document._rev)}`, method: "PUT", body: JSON.stringify({ _id: document._id, _rev: document._rev, maintainers: next }), fetch: options.fetch, signal: options.signal, otp: options.otp });
  return next;
}

export async function mutatePackageStar(options: RegistryMutationOptions & { readonly package: string; readonly user: string; readonly starred: boolean }): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.user)) throw new RegistryError("Invalid registry username");
  const spec = packageSpec(options.package);
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  const document = await requestJson({ configuration, registry, path: `/${spec.escapedName}?write=true`, fetch: options.fetch, signal: options.signal });
  if (typeof document._id !== "string" || typeof document._rev !== "string" || (document.users !== undefined && (typeof document.users !== "object" || document.users === null || Array.isArray(document.users)))) throw new RegistryError("Package metadata is missing favorite revision data");
  const users = { ...((document.users ?? {}) as Record<string, unknown>) };
  if (options.starred) users[options.user] = true; else delete users[options.user];
  await requestJson({ configuration, registry, path: `/${spec.escapedName}`, method: "PUT", body: JSON.stringify({ _id: document._id, _rev: document._rev, users }), fetch: options.fetch, signal: options.signal, otp: options.otp });
}

export async function starredPackages(options: RegistryMutationOptions & { readonly user: string }): Promise<readonly string[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.user)) throw new RegistryError("Invalid registry username");
  const { configuration, registry } = await context(options.paths, "", options.registry);
  const url = new URL("/-/_view/starredByUser", registry); url.searchParams.set("key", JSON.stringify(options.user));
  const result = await requestJson({ configuration, registry, path: url.href, fetch: options.fetch, signal: options.signal });
  if (!Array.isArray(result.rows)) throw new RegistryError("Registry favorites response has no rows array");
  return result.rows.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row) || typeof (row as { value?: unknown }).value !== "string") throw new RegistryError("Registry returned an invalid favorite package");
    return (row as { value: string }).value;
  }).sort();
}

function simpleName(value: string, kind: string): string {
  const normalized = value.replace(/^@/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) throw new RegistryError(`Invalid ${kind} name`);
  return normalized;
}

export async function organizationMembers(options: RegistryMutationOptions & { readonly organization: string }): Promise<Readonly<Record<string, string>>> {
  const organization = simpleName(options.organization, "organization");
  const { configuration, registry } = await context(options.paths, `@${organization}/placeholder`, options.registry);
  const result = await requestJson({ configuration, registry, path: `/-/org/${encodeURIComponent(organization)}/user`, fetch: options.fetch, signal: options.signal });
  const members: Record<string, string> = {};
  for (const [user, role] of Object.entries(result)) if (typeof role === "string") members[user] = role;
  return members;
}

export async function mutateOrganizationMember(options: RegistryMutationOptions & { readonly organization: string; readonly user: string; readonly role?: "developer" | "admin" | "owner" }): Promise<void> {
  const organization = simpleName(options.organization, "organization"); const user = simpleName(options.user, "user");
  const { configuration, registry } = await context(options.paths, `@${organization}/placeholder`, options.registry);
  await requestJson({ configuration, registry, path: `/-/org/${encodeURIComponent(organization)}/user`, method: options.role === undefined ? "DELETE" : "PUT", body: JSON.stringify({ user, ...(options.role === undefined ? {} : { role: options.role }) }), fetch: options.fetch, signal: options.signal, otp: options.otp });
}

function teamEntity(value: string): { readonly scope: string; readonly team: string } {
  const [scope, name, extra] = value.replace(/^@/, "").split(":");
  if (!scope || !name || extra !== undefined) throw new RegistryError("Team must use scope:team format");
  return { scope: simpleName(scope, "scope"), team: simpleName(name, "team") };
}

export async function mutateRegistryTeam(options: RegistryMutationOptions & { readonly action: "create" | "destroy" | "add" | "remove"; readonly entity: string; readonly user?: string }): Promise<void> {
  const entity = teamEntity(options.entity);
  if ((options.action === "add" || options.action === "remove") && options.user === undefined) throw new RegistryError("Team membership mutation requires a user");
  const user = options.user === undefined ? undefined : simpleName(options.user, "user");
  const { configuration, registry } = await context(options.paths, `@${entity.scope}/placeholder`, options.registry);
  const path = options.action === "create" ? `/-/org/${encodeURIComponent(entity.scope)}/team` : `/-/team/${encodeURIComponent(entity.scope)}/${encodeURIComponent(entity.team)}${options.action === "add" || options.action === "remove" ? "/user" : ""}`;
  const method = options.action === "create" || options.action === "add" ? "PUT" : "DELETE";
  const body = options.action === "create" ? { name: entity.team } : user === undefined ? undefined : { user };
  await requestJson({ configuration, registry, path, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), fetch: options.fetch, signal: options.signal, otp: options.otp });
}

export async function registryTeamEntries(options: RegistryMutationOptions & { readonly entity: string }): Promise<readonly string[]> {
  const raw = options.entity.replace(/^@/, "");
  const parsed = raw.includes(":") ? teamEntity(raw) : { scope: simpleName(raw, "scope") };
  const { configuration, registry } = await context(options.paths, `@${parsed.scope}/placeholder`, options.registry);
  const path = "team" in parsed ? `/-/team/${encodeURIComponent(parsed.scope)}/${encodeURIComponent(parsed.team)}/user?format=cli` : `/-/org/${encodeURIComponent(parsed.scope)}/team?format=cli`;
  const result = await requestJson({ configuration, registry, path, fetch: options.fetch, signal: options.signal });
  const nested = result.users ?? result.teams;
  if (Array.isArray(nested) && nested.every((value) => typeof value === "string")) return [...nested].sort();
  return Object.entries(result).flatMap(([key, value]) => typeof value === "string" ? [value] : value === true ? [key] : []).sort();
}

const writableProfileKeys = new Set(["email", "fullname", "homepage", "freenode", "twitter", "github"]);

export async function registryProfile(options: RegistryMutationOptions): Promise<Readonly<Record<string, unknown>>> {
  const { configuration, registry } = await context(options.paths, "", options.registry);
  return requestJson({ configuration, registry, path: "/-/npm/v1/user", fetch: options.fetch, signal: options.signal });
}

export async function setRegistryProfile(options: RegistryMutationOptions & { readonly key: string; readonly value: string }): Promise<Readonly<Record<string, unknown>>> {
  const key = options.key.toLowerCase();
  if (!writableProfileKeys.has(key)) throw new RegistryError(`Profile field ${options.key} cannot be set non-interactively`);
  const { configuration, registry } = await context(options.paths, "", options.registry);
  const current = await requestJson({ configuration, registry, path: "/-/npm/v1/user", fetch: options.fetch, signal: options.signal });
  const body: Record<string, unknown> = {};
  for (const field of writableProfileKeys) if (current[field] === null || typeof current[field] === "string") body[field] = current[field];
  body[key] = options.value === "" ? null : options.value;
  return requestJson({ configuration, registry, path: "/-/npm/v1/user", method: "POST", body: JSON.stringify(body), fetch: options.fetch, signal: options.signal, otp: options.otp });
}

export async function mutateRegistryProfile(options: RegistryMutationOptions & { readonly change: Readonly<Record<string, unknown>>; readonly preserveWritable?: boolean }): Promise<Readonly<Record<string, unknown>>> {
  const { configuration, registry } = await context(options.paths, "", options.registry);
  const body: Record<string, unknown> = {};
  if (options.preserveWritable) {
    const current = await requestJson({ configuration, registry, path: "/-/npm/v1/user", fetch: options.fetch, signal: options.signal });
    for (const field of writableProfileKeys) if (current[field] === null || typeof current[field] === "string") body[field] = current[field];
  }
  Object.assign(body, options.change);
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > 64 * 1024) throw new RegistryError("Profile mutation body exceeds the size limit");
  return requestJson({ configuration, registry, path: "/-/npm/v1/user", method: "POST", body: serialized, fetch: options.fetch, signal: options.signal, otp: options.otp });
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function stagedPackages(options: RegistryMutationOptions & { readonly package?: string }): Promise<readonly Record<string, unknown>[]> {
  const { configuration, registry } = await context(options.paths, options.package ?? "", options.registry);
  const items: Record<string, unknown>[] = [];
  for (let page = 0; page < 100; page += 1) {
    const url = new URL("/-/stage", registry); url.searchParams.set("page", String(page)); url.searchParams.set("perPage", "100"); if (options.package) url.searchParams.set("package", packageSpec(options.package).name);
    const result = await requestJson({ configuration, registry, path: url.href, fetch: options.fetch, signal: options.signal });
    if (!Array.isArray(result.items) || typeof result.total !== "number") throw new RegistryError("Registry staged package response is invalid");
    for (const item of result.items) { if (typeof item !== "object" || item === null || Array.isArray(item)) throw new RegistryError("Registry returned an invalid staged package"); items.push(item as Record<string, unknown>); }
    if (items.length >= result.total || result.items.length < 100) return items;
  }
  throw new RegistryError("Registry staged package pagination exceeded 100 pages");
}

export async function stagedPackage(options: RegistryMutationOptions & { readonly id: string }): Promise<Readonly<Record<string, unknown>>> {
  if (!uuid.test(options.id)) throw new RegistryError("Stage id must be a UUID");
  const { configuration, registry } = await context(options.paths, "", options.registry);
  return requestJson({ configuration, registry, path: `/-/stage/${options.id}`, fetch: options.fetch, signal: options.signal });
}

export async function downloadStagedPackageTarball(options: RegistryMutationOptions & { readonly id: string }): Promise<QuarantinedTarball> {
  if (!/^[0-9a-f-]{36}$/i.test(options.id)) throw new RegistryError("Invalid staged package id");
  const { configuration, registry } = await context(options.paths, "", options.registry);
  return downloadUnverifiedToQuarantine(new URL(`/-/stage/${options.id}/tarball`, registry), {
    root: options.paths.quarantine,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    maxRetries: 2,
    headers: (url) => {
      if (url.origin !== registry.origin) throw new RegistryError("Staged package redirect must remain on the HTTPS registry origin");
      return configuration.headersFor(url);
    },
  });
}

export async function mutateStagedPackage(options: RegistryMutationOptions & { readonly id: string; readonly action: "approve" | "reject" }): Promise<void> {
  if (!uuid.test(options.id)) throw new RegistryError("Stage id must be a UUID");
  const { configuration, registry } = await context(options.paths, "", options.registry);
  await requestJson({ configuration, registry, path: options.action === "approve" ? `/-/stage/${options.id}/approve` : `/-/stage/${options.id}`, method: options.action === "approve" ? "POST" : "DELETE", fetch: options.fetch, signal: options.signal, otp: options.otp });
}

export async function packageTrust(options: RegistryMutationOptions & { readonly package: string }): Promise<readonly Record<string, unknown>[]> {
  const spec = packageSpec(options.package);
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  const result = await requestJson({ configuration, registry, path: `/-/package/${spec.escapedName}/trust`, allowArray: true, fetch: options.fetch, signal: options.signal });
  const values = Array.isArray(result) ? result : [result];
  return values.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RegistryError("Registry returned an invalid trust configuration");
    return value as Record<string, unknown>;
  });
}

export async function revokePackageTrust(options: RegistryMutationOptions & { readonly package: string; readonly id: string; readonly dryRun?: boolean }): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(options.id)) throw new RegistryError("Invalid trust configuration id");
  if (options.dryRun) return;
  const spec = packageSpec(options.package);
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  await requestJson({ configuration, registry, path: `/-/package/${spec.escapedName}/trust/${encodeURIComponent(options.id)}`, method: "DELETE", fetch: options.fetch, signal: options.signal, otp: options.otp });
}

export async function createPackageTrust(options: RegistryMutationOptions & { readonly package: string; readonly configuration: Readonly<Record<string, unknown>> }): Promise<readonly Record<string, unknown>[]> {
  const spec = packageSpec(options.package);
  const { configuration, registry } = await context(options.paths, spec.name, options.registry);
  const result = await requestJson({ configuration, registry, path: `/-/package/${spec.escapedName}/trust`, method: "POST", body: JSON.stringify([options.configuration]), allowArray: true, fetch: options.fetch, signal: options.signal, otp: options.otp });
  const values = Array.isArray(result) ? result : [result];
  return values.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RegistryError("Registry returned an invalid trust configuration");
    return value as Record<string, unknown>;
  });
}

export async function pingRegistry(options: { readonly paths: BnpmPaths; readonly registry?: URL; readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal }): Promise<{ readonly registry: string; readonly details: Readonly<Record<string, unknown>> }> {
  const { configuration, registry } = await context(options.paths, "", options.registry);
  const details = await requestJson({ configuration, registry, path: "/-/ping", fetch: options.fetch, signal: options.signal });
  return { registry: registry.href, details };
}
