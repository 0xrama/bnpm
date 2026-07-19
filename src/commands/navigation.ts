import { RegistryError } from "../registry/client.js";

export type NavigationKind = "repo" | "docs" | "bugs";

function candidate(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { url?: unknown }).url === "string") return (value as { url: string }).url;
  return undefined;
}

function repositoryUrl(value: string): string {
  if (/^[^/:\s]+\/[^/\s]+$/.test(value)) return `https://github.com/${value.replace(/\.git$/, "")}`;
  if (value.startsWith("github:")) return `https://github.com/${value.slice("github:".length).replace(/\.git$/, "")}`;
  if (value.startsWith("git+")) value = value.slice(4);
  if (value.startsWith("git://")) value = `https://${value.slice("git://".length)}`;
  if (value.startsWith("ssh://") || value.startsWith("git@")) {
    const match = /^(?:ssh:\/\/)?git@([^/:]+)[:/]([^\s]+)$/.exec(value);
    if (!match?.[1] || !match[2]) throw new RegistryError("Package repository URL is not a supported web location");
    return `https://${match[1]}/${match[2].replace(/\.git$/, "")}`;
  }
  return value.replace(/\.git$/, "");
}

function secure(value: string, purpose: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RegistryError(`Package ${purpose} URL is invalid`); }
  if (url.protocol !== "https:" || url.username || url.password) throw new RegistryError(`Package ${purpose} URL must use HTTPS without credentials`);
  return url;
}

export function packageNavigationUrl(metadata: Readonly<Record<string, unknown>>, kind: NavigationKind, packageName: string): URL {
  const repository = candidate(metadata.repository);
  const raw = kind === "repo"
    ? repository === undefined ? undefined : repositoryUrl(repository)
    : kind === "docs"
      ? candidate(metadata.homepage)
      : candidate(metadata.bugs) ?? (repository === undefined ? undefined : `${repositoryUrl(repository).replace(/\/$/, "")}/issues`);
  return raw === undefined ? new URL(`https://www.npmjs.com/package/${encodeURIComponent(packageName)}`) : secure(raw, kind);
}
