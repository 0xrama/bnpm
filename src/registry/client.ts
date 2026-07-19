import type { PackageDocument } from "./types.js";

export interface RegistryClientOptions {
  registry?: URL;
  fetch?: typeof globalThis.fetch;
  maxMetadataBytes?: number;
  timeoutMilliseconds?: number;
  maxRedirects?: number;
  maxRetries?: number;
  headers?: (url: URL) => Readonly<Record<string, string>>;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export class RegistryClient {
  readonly #registry: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxMetadataBytes: number;
  readonly #timeoutMilliseconds: number;
  readonly #maxRedirects: number;
  readonly #maxRetries: number;
  readonly #headers: (url: URL) => Readonly<Record<string, string>>;

  constructor(options: RegistryClientOptions = {}) {
    this.#registry = options.registry ?? new URL("https://registry.npmjs.org/");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxMetadataBytes = options.maxMetadataBytes ?? 32 * 1024 * 1024;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    this.#maxRedirects = options.maxRedirects ?? 5;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#headers = options.headers ?? (() => ({}));

    if (this.#registry.protocol !== "https:") {
      throw new RegistryError("Registry URL must use HTTPS");
    }
  }

  async packageDocument(name: string, signal?: AbortSignal): Promise<PackageDocument> {
    const url = new URL(encodeURIComponent(name), this.#registry);
    let response: Response | undefined;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      try {
        response = await this.#request(url, signal);
      } catch (error) {
        if (attempt === this.#maxRetries || signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        continue;
      }
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === this.#maxRetries) break;
    }
    if (!response?.ok) throw new RegistryError(`Registry request for ${name} failed with ${response?.status ?? "no response"}`, response?.status);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.#maxMetadataBytes) throw new RegistryError(`Registry metadata for ${name} exceeds the size limit`);
    if (!response.body) throw new RegistryError(`Registry returned an empty package document for ${name}`);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > this.#maxMetadataBytes) throw new RegistryError(`Registry metadata for ${name} exceeds the size limit`);
      chunks.push(chunk);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RegistryError(`Registry returned invalid JSON for ${name}`);
    }
    if (!isPackageDocument(value, name)) {
      throw new RegistryError(`Registry returned an invalid package document for ${name}`);
    }
    return value;
  }

  async #request(initialUrl: URL, signal?: AbortSignal): Promise<Response> {
    let url = initialUrl;
    for (let redirects = 0; redirects <= this.#maxRedirects; redirects += 1) {
      const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await this.#fetch(url, { headers: { accept: "application/json", ...this.#headers(url) }, redirect: "manual", signal: requestSignal });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (redirects === this.#maxRedirects) throw new RegistryError("Registry metadata exceeded the redirect limit");
      const location = response.headers.get("location");
      if (!location) throw new RegistryError("Registry redirect did not provide a location");
      url = new URL(location, url);
      if (url.protocol !== "https:") throw new RegistryError("Registry redirect must use HTTPS");
    }
    throw new RegistryError("Registry metadata exceeded the redirect limit");
  }
}

function isPackageDocument(value: unknown, requestedName: string): value is PackageDocument {
  if (typeof value !== "object" || value === null) return false;
  const document = value as Record<string, unknown>;
  return (
    document.name === requestedName &&
    typeof document["dist-tags"] === "object" &&
    document["dist-tags"] !== null &&
    typeof document.versions === "object" &&
    document.versions !== null
  );
}
