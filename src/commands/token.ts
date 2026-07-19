import npa from "npm-package-arg";
import type { CommandOptions } from "../core/cli-parser.js";
import { RegistryError } from "../registry/client.js";

function packageName(value: string): string {
  let parsed: npa.Result;
  try { parsed = npa(value); } catch { throw new RegistryError(`Invalid token package ${value}`); }
  if (!parsed.name || parsed.rawSpec !== "*" || parsed.type !== "range") throw new RegistryError(`Token package must be an exact package name: ${value}`);
  return parsed.name;
}

function ipv4Cidr(value: string): string {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
  if (!match || match.slice(1, 5).some((part) => Number(part) > 255) || Number(match[5]) > 32) throw new RegistryError(`Invalid IPv4 CIDR ${value}`);
  return value;
}

export function tokenCreationBody(options: CommandOptions): Readonly<Record<string, unknown>> {
  if (options.tokenName !== undefined && (!options.tokenName.trim() || options.tokenName.length > 128)) throw new RegistryError("Token name must contain 1-128 characters");
  if (options.tokenDescription !== undefined && options.tokenDescription.length > 1024) throw new RegistryError("Token description exceeds 1024 characters");
  const scopes = (options.tokenScopes ?? []).map((value) => value.replace(/^@/, ""));
  const organizations = options.tokenOrganizations ?? [];
  if (scopes.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))) throw new RegistryError("Token scopes must be exact scope names");
  if (organizations.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))) throw new RegistryError("Token organizations must be exact organization names");
  return {
    ...(options.tokenName === undefined ? {} : { name: options.tokenName }),
    ...(options.tokenDescription === undefined ? {} : { description: options.tokenDescription }),
    ...(options.tokenExpires === undefined ? {} : { expires: options.tokenExpires }),
    ...(options.tokenPackages === undefined ? {} : { packages: options.tokenPackages.map(packageName) }),
    ...(options.tokenPackagesAll ? { packages_all: true } : {}),
    ...(scopes.length === 0 ? {} : { scopes }),
    ...(organizations.length === 0 ? {} : { orgs: organizations }),
    ...(options.tokenPackagesPermission === undefined ? {} : { packages_and_scopes_permission: options.tokenPackagesPermission }),
    ...(options.tokenOrganizationsPermission === undefined ? {} : { orgs_permission: options.tokenOrganizationsPermission }),
    ...(options.tokenCidrs === undefined ? {} : { cidr_whitelist: options.tokenCidrs.map(ipv4Cidr) }),
    ...(options.tokenBypass2fa ? { bypass_2fa: true } : {}),
    ...(options.tokenReadOnly ? { readonly: true } : {}),
  };
}
