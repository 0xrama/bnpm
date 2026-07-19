import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { assertDigest, selectExpectedIntegrity } from "../security/integrity.js";

export interface QuarantineOptions {
  root: string;
  maxCompressedBytes?: number;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  maxRedirects?: number;
  maxRetries?: number;
  timeoutMilliseconds?: number;
  headers?: (url: URL) => Readonly<Record<string, string>>;
  onProgress?: (bytes: number, totalBytes?: number) => void;
}

export interface QuarantinedTarball {
  path: string;
  bytes: number;
  integrity: string;
}

const defaultMaxCompressedBytes = 100 * 1024 * 1024;

export async function downloadToQuarantine(
  tarball: URL,
  integrity: string,
  options: QuarantineOptions,
): Promise<QuarantinedTarball> {
  return download(tarball, options, integrity);
}

export async function downloadUnverifiedToQuarantine(tarball: URL, options: QuarantineOptions): Promise<QuarantinedTarball> {
  return download(tarball, options);
}

async function download(tarball: URL, options: QuarantineOptions, integrity?: string): Promise<QuarantinedTarball> {
  if (tarball.protocol !== "https:") throw new Error("Tarball URL must use HTTPS");

  const expected = integrity === undefined ? undefined : selectExpectedIntegrity(integrity);
  const maxBytes = options.maxCompressedBytes ?? defaultMaxCompressedBytes;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  await mkdir(options.root, { recursive: true });

  const directory = join(options.root, randomUUID());
  const path = join(directory, "package.tgz");
  await mkdir(directory, { mode: 0o700 });

  let file: FileHandle | undefined;
  try {
    const response = await fetchTarball(tarball, fetchImpl, options);
    if (!response.ok || !response.body) {
      throw new Error(`Tarball download failed with ${response.status}`);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`Tarball exceeds the ${maxBytes} byte compressed-size limit`);
    }

    file = await open(path, "wx", 0o600);
    const hash = createHash(expected?.algorithm ?? "sha512");
    let bytes = 0;
    options.onProgress?.(0, Number.isFinite(declaredLength) && declaredLength >= 0 ? declaredLength : undefined);

    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`Tarball exceeds the ${maxBytes} byte compressed-size limit`);
      hash.update(chunk);
      await writeAll(file, chunk);
      options.onProgress?.(bytes, Number.isFinite(declaredLength) && declaredLength >= 0 ? declaredLength : undefined);
    }

    const digest = hash.digest();
    if (expected) assertDigest(expected, digest);
    await file.close();
    file = undefined;
    return { path, bytes, integrity: expected?.serialized ?? `sha512-${digest.toString("base64")}` };
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function fetchTarball(url: URL, fetchImpl: typeof globalThis.fetch, options: QuarantineOptions): Promise<Response> {
  const maxRetries = options.maxRetries ?? 2;
  const maxRedirects = options.maxRedirects ?? 5;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let current = url;
    try {
      for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
        const timeout = AbortSignal.timeout(options.timeoutMilliseconds ?? 60_000);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const headers = options.headers?.(current);
        const response = await fetchImpl(current, { ...(headers === undefined ? {} : { headers }), redirect: "manual", signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirects === maxRedirects) throw new Error("Tarball download exceeded the redirect limit");
          const location = response.headers.get("location");
          if (!location) throw new Error("Tarball redirect did not provide a location");
          current = new URL(location, current);
          if (current.protocol !== "https:") throw new Error("Tarball redirect must use HTTPS");
          continue;
        }
        if ([408, 429, 500, 502, 503, 504].includes(response.status) && attempt < maxRetries) {
          await response.body?.cancel();
          break;
        }
        return response;
      }
    } catch (error) {
      if (attempt === maxRetries || options.signal?.aborted || (error instanceof Error && error.message.includes("redirect"))) throw error;
      continue;
    }
  }
  throw new Error("Tarball download failed after bounded retries");
}

async function writeAll(file: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
    if (bytesWritten === 0) throw new Error("Unable to write quarantined tarball");
    offset += bytesWritten;
  }
}
