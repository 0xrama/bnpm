import type { ResolutionGraph } from "../resolver/types.js";
import { RegistryError } from "./client.js";

export interface RegistryAdvisory {
  readonly id: string | number;
  readonly packageName: string;
  readonly title: string;
  readonly severity: "info" | "low" | "moderate" | "high" | "critical";
  readonly vulnerableVersions: string;
  readonly cwe?: readonly string[];
  readonly url?: string;
}

export async function fetchBulkAdvisories(options: {
  readonly graph: ResolutionGraph;
  readonly registry?: URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
  readonly headers?: (url: URL) => Readonly<Record<string, string>>;
}): Promise<readonly RegistryAdvisory[]> {
  const registry = options.registry ?? new URL("https://registry.npmjs.org/");
  if (registry.protocol !== "https:") throw new RegistryError("Audit registry URL must use HTTPS");
  const versions: Record<string, string[]> = {};
  for (const pkg of options.graph.packages.values()) (versions[pkg.name] ??= []).push(pkg.version);
  for (const values of Object.values(versions)) values.sort();
  if (Object.keys(versions).length === 0) return [];
  let url = new URL("-/npm/v1/security/advisories/bulk", registry);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await (options.fetch ?? globalThis.fetch)(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...options.headers?.(url) },
      body: JSON.stringify(versions),
      redirect: "manual",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirects === 5) throw new RegistryError("Registry audit exceeded the redirect limit");
    const location = response.headers.get("location");
    if (!location) throw new RegistryError("Registry audit redirect did not provide a location");
    url = new URL(location, url);
    if (url.protocol !== "https:") throw new RegistryError("Registry audit redirect must use HTTPS");
  }
  if (!response) throw new RegistryError("Registry audit request did not return a response");
  if (!response.ok || !response.body) throw new RegistryError(`Registry audit request failed with ${response.status}`, response.status);
  const limit = options.maxBytes ?? 10 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value); bytes += chunk.length;
    if (bytes > limit) throw new RegistryError("Registry audit response exceeds the size limit");
    chunks.push(chunk);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new RegistryError("Registry audit response is invalid JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new RegistryError("Registry audit response is invalid");
  const advisories: RegistryAdvisory[] = [];
  for (const [packageName, rawEntries] of Object.entries(parsed as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
    if (!Array.isArray(rawEntries)) throw new RegistryError(`Registry advisories for ${packageName} are invalid`);
    for (const raw of rawEntries) {
      if (raw === null || typeof raw !== "object") throw new RegistryError(`Registry advisory for ${packageName} is invalid`);
      const entry = raw as Record<string, unknown>;
      if ((typeof entry.id !== "string" && typeof entry.id !== "number") || typeof entry.title !== "string" || typeof entry.severity !== "string" || typeof entry.vulnerable_versions !== "string" || !["info", "low", "moderate", "high", "critical"].includes(entry.severity)) {
        throw new RegistryError(`Registry advisory for ${packageName} is invalid`);
      }
      const cwe = Array.isArray(entry.cwe) ? entry.cwe.filter((value): value is string => typeof value === "string") : typeof entry.cwe === "string" ? [entry.cwe] : [];
      advisories.push({ id: entry.id, packageName, title: entry.title, severity: entry.severity as RegistryAdvisory["severity"], vulnerableVersions: entry.vulnerable_versions, ...(cwe.length === 0 ? {} : { cwe }), ...(typeof entry.url === "string" ? { url: entry.url } : {}) });
    }
  }
  return advisories.sort((left, right) => left.packageName.localeCompare(right.packageName) || String(left.id).localeCompare(String(right.id)));
}
