import type { BnpmPaths } from "../config/paths.js";
import { RegistryError } from "../registry/client.js";
import { loadRegistryConfiguration } from "../registry/configuration.js";
import type { PackedPackage } from "./pack.js";
import { generateProvenance, transparencyLogUrl, type ProvenanceBundle } from "./provenance.js";
import { trustedPublishingToken } from "./trusted-publishing.js";

export interface PublishOptions {
  readonly artifact: PackedPackage;
  readonly paths: BnpmPaths;
  readonly registry?: URL;
  readonly tag?: string;
  readonly access?: "public" | "restricted";
  readonly otp?: string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
  readonly provenance?: ProvenanceBundle;
  readonly generateProvenance?: boolean;
  readonly provenanceGenerator?: (artifact: PackedPackage) => Promise<ProvenanceBundle>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly stage?: boolean;
}

export interface PublishResult {
  readonly registry: string;
  readonly tag: string;
  readonly access?: "public" | "restricted";
  readonly status: number;
  readonly provenance: boolean;
  readonly transparencyLogUrl?: string;
  readonly stageId?: string;
}

function stringSetting(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new RegistryError(`package.json publishConfig.${key} must be a non-empty string`);
  return value;
}

function publishConfig(manifest: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const value = manifest.publishConfig;
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RegistryError("package.json publishConfig must be an object");
  return value as Readonly<Record<string, unknown>>;
}

function registryOverride(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new RegistryError("publishConfig.registry must be an absolute HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new RegistryError("publishConfig.registry must be HTTPS and must not contain credentials, query, or fragment");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

async function boundedError(response: Response): Promise<string> {
  if (!response.body) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > 1024 * 1024) return "registry response exceeded the size limit";
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text) as { error?: unknown; reason?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : typeof parsed.reason === "string" ? parsed.reason : undefined;
    return message?.slice(0, 500) ?? "";
  } catch {
    return text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
  }
}

export async function publishPackage(options: PublishOptions): Promise<PublishResult> {
  if (options.artifact.manifest.private === true) throw new RegistryError("Refusing to publish a package marked private");
  const config = publishConfig(options.artifact.manifest);
  const configuredRegistry = registryOverride(stringSetting(config.registry, "registry"));
  const defaultRegistry = options.registry ?? configuredRegistry;
  const configuration = await loadRegistryConfiguration({
    userNpmrc: options.paths.userNpmrc,
    projectNpmrc: options.paths.projectNpmrc,
    ...(defaultRegistry === undefined ? {} : { defaultRegistry }),
  });
  const registry = options.registry ?? configuredRegistry ?? configuration.registryForPackage(options.artifact.name);
  const configuredTag = stringSetting(config.tag, "tag");
  const tag = options.tag ?? configuredTag ?? "latest";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) throw new RegistryError(`Invalid distribution tag ${tag}`);
  const configuredAccess = stringSetting(config.access, "access");
  const access = options.access ?? (configuredAccess === "private" ? "restricted" : configuredAccess);
  if (access !== undefined && access !== "public" && access !== "restricted") throw new RegistryError("publish access must be public or restricted");
  if (options.generateProvenance && options.provenance) throw new RegistryError("generated and supplied provenance are mutually exclusive");
  if (options.generateProvenance && access !== "public") throw new RegistryError("provenance generation requires explicit public access");
  const provenance = options.generateProvenance
    ? await (options.provenanceGenerator ?? generateProvenance)(options.artifact)
    : options.provenance;
  const request = options.fetch ?? globalThis.fetch;
  const trustedToken = await trustedPublishingToken({
    packageName: options.artifact.name,
    registry,
    environment: options.environment ?? process.env,
    fetch: request,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const packagePath = encodeURIComponent(options.artifact.name);
  const endpoint = options.stage ? new URL(`/-/stage/package/${packagePath}`, registry) : new URL(packagePath, registry);
  const tarballUrl = new URL(`${packagePath}/-/${encodeURIComponent(options.artifact.filename)}`, registry).href;
  const versionManifest = {
    ...options.artifact.manifest,
    _id: options.artifact.id,
    dist: { integrity: options.artifact.integrity, shasum: options.artifact.shasum, tarball: tarballUrl },
  };
  const attachments: Record<string, unknown> = {
    [options.artifact.filename]: {
      content_type: "application/octet-stream",
      data: options.artifact.tarball.toString("base64"),
      length: options.artifact.size,
    },
  };
  if (provenance) {
    const serialized = JSON.stringify(provenance);
    attachments[`${options.artifact.name}-${options.artifact.version}.sigstore`] = {
      content_type: provenance.mediaType,
      data: serialized,
      length: Buffer.byteLength(serialized),
    };
  }
  const body = JSON.stringify({
    _id: options.artifact.name,
    name: options.artifact.name,
    ...(typeof options.artifact.manifest.description === "string" ? { description: options.artifact.manifest.description } : {}),
    "dist-tags": { [tag]: options.artifact.version },
    versions: { [options.artifact.version]: versionManifest },
    ...(access === undefined ? {} : { access }),
    _attachments: attachments,
  });
  let url = endpoint;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const timeout = AbortSignal.timeout(30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await request(url, {
      method: options.stage ? "POST" : "PUT",
      redirect: "manual",
      signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        ...configuration.headersFor(url),
        ...(trustedToken === undefined ? {} : { authorization: `Bearer ${trustedToken}` }),
        ...(options.otp === undefined ? {} : { "npm-otp": options.otp }),
      },
      body,
    });
    if ([307, 308].includes(response.status)) {
      if (redirect === 5) throw new RegistryError("Publish request exceeded the redirect limit");
      const location = response.headers.get("location");
      if (!location) throw new RegistryError("Publish redirect did not provide a location");
      url = new URL(location, url);
      if (url.protocol !== "https:") throw new RegistryError("Publish redirect must use HTTPS");
      if (url.origin !== registry.origin) throw new RegistryError("Publish redirect must remain on the registry origin");
      continue;
    }
    if ([301, 302, 303].includes(response.status)) throw new RegistryError("Publish registry returned an unsafe method-changing redirect", response.status);
    if (!response.ok) {
      const detail = await boundedError(response);
      throw new RegistryError(`Publish of ${options.artifact.id} failed with ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
    }
    let stageId: string | undefined;
    if (options.stage && response.body) {
      const chunks: Buffer[] = []; let size = 0;
      for await (const value of response.body) { const chunk = Buffer.from(value); size += chunk.length; if (size > 1024 * 1024) throw new RegistryError("Staged publish response exceeded 1 MiB"); chunks.push(chunk); }
      try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stageId?: unknown; id?: unknown }; stageId = typeof value.stageId === "string" ? value.stageId : typeof value.id === "string" ? value.id : undefined; } catch { throw new RegistryError("Staged publish returned invalid JSON"); }
      if (!stageId) throw new RegistryError("Staged publish response has no stage id");
    }
    const tlog = provenance ? transparencyLogUrl(provenance) : undefined;
    return { registry: registry.href, tag, ...(access === undefined ? {} : { access }), status: response.status, provenance: provenance !== undefined, ...(tlog === undefined ? {} : { transparencyLogUrl: tlog }), ...(stageId === undefined ? {} : { stageId }) };
  }
  throw new RegistryError("Publish request exceeded the redirect limit");
}
