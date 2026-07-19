import npa from "npm-package-arg";
import semver from "semver";

export type SaveSection = "prod" | "dev" | "optional" | "peer";
export type OmitDependencyType = "dev" | "optional" | "peer";

export interface GlobalOptions {
  readonly json: boolean;
  readonly details?: boolean;
  readonly registry?: string;
  readonly allowRecent: readonly string[];
  readonly allowDangerous: readonly string[];
}

export interface CommandOptions extends GlobalOptions {
  readonly globalInstall?: boolean;
  readonly dryRun?: boolean;
  readonly packDestination?: string;
  readonly tag?: string;
  readonly access?: "public" | "restricted";
  readonly otp?: string;
  readonly provenance?: boolean;
  readonly provenanceFile?: string;
  readonly yes?: boolean;
  readonly force?: boolean;
  readonly workspaces?: boolean;
  readonly workspaceNames?: readonly string[];
  readonly includeWorkspaceRoot?: boolean;
  readonly ifPresent?: boolean;
  readonly ignoreScripts?: boolean;
  readonly sbomFormat?: "cyclonedx" | "spdx";
  readonly trustFile?: string;
  readonly trustRepository?: string;
  readonly trustProject?: string;
  readonly trustEnvironment?: string;
  readonly trustOrganizationId?: string;
  readonly trustProjectId?: string;
  readonly trustPipelineDefinitionId?: string;
  readonly trustVcsOrigin?: string;
  readonly trustContextIds?: readonly string[];
  readonly allowPublish?: boolean;
  readonly allowStagePublish?: boolean;
  readonly tokenName?: string;
  readonly tokenDescription?: string;
  readonly tokenExpires?: number;
  readonly tokenPackages?: readonly string[];
  readonly tokenPackagesAll?: boolean;
  readonly tokenScopes?: readonly string[];
  readonly tokenOrganizations?: readonly string[];
  readonly tokenPackagesPermission?: "read-only" | "read-write";
  readonly tokenOrganizationsPermission?: "read-only" | "read-write";
  readonly tokenCidrs?: readonly string[];
  readonly tokenBypass2fa?: boolean;
  readonly tokenReadOnly?: boolean;
  readonly authType?: "web" | "legacy";
  readonly accountCreate?: boolean;
  readonly expectResults?: boolean;
  readonly expectResultCount?: number;
  readonly packageLockOnly?: boolean;
  readonly execPackages?: readonly string[];
  readonly gitTagVersion?: boolean;
  readonly commitHooks?: boolean;
  readonly signGitTag?: boolean;
  readonly versionMessage?: string;
  readonly preid?: string;
  readonly allowSameVersion?: boolean;
  readonly diffSpecs?: readonly string[];
  readonly diffNameOnly?: boolean;
  readonly diffUnified?: number;
  readonly diffIgnoreAllSpace?: boolean;
  readonly diffNoPrefix?: boolean;
  readonly diffSrcPrefix?: string;
  readonly diffDstPrefix?: string;
  readonly diffText?: boolean;
  readonly frozenLockfile: boolean;
  readonly offline: boolean;
  readonly omitDev: boolean;
  readonly omit?: readonly OmitDependencyType[];
  readonly saveSection?: SaveSection;
  readonly saveExact: boolean;
  readonly noSave: boolean;
}

export interface ParsedCommand {
  readonly kind: "command";
  readonly name: "install" | "install-test" | "install-ci-test" | "add" | "remove" | "update" | "outdated" | "list" | "why" | "query" | "diff" | "find-dupes" | "bin" | "prefix" | "root" | "run" | "restart" | "audit" | "exec" | "explore" | "edit" | "pack" | "publish" | "stage" | "unpublish" | "access" | "owner" | "token" | "star" | "unstar" | "stars" | "org" | "team" | "profile" | "trust" | "login" | "logout" | "whoami" | "view" | "search" | "repo" | "docs" | "bugs" | "dist-tag" | "deprecate" | "config" | "init" | "version" | "shrinkwrap" | "prune" | "dedupe" | "rebuild" | "install-scripts" | "approve-scripts" | "deny-scripts" | "fund" | "cache" | "ping" | "doctor" | "completion" | "pkg" | "sbom" | "link" | "unlink";
  readonly options: CommandOptions;
  readonly args: readonly string[];
}

export interface ParsedBnpmx {
  readonly kind: "bnpmx";
  readonly options: GlobalOptions;
  readonly specifier: string;
  readonly targetArgs: readonly string[];
}

export interface ParsedHelp {
  readonly kind: "help";
  readonly json: boolean;
}

export interface ParsedVersion {
  readonly kind: "version";
  readonly json: boolean;
}

export type Invocation = ParsedCommand | ParsedBnpmx | ParsedHelp | ParsedVersion;

export class UsageError extends Error {
  constructor(message: string) {
    super(`Usage: ${message}`);
    this.name = "UsageError";
  }
}

const commandAliases: Readonly<Record<string, ParsedCommand["name"]>> = {
  install: "install",
  i: "install",
  ci: "install",
  add: "add",
  remove: "remove",
  uninstall: "remove",
  rm: "remove",
  un: "remove",
  r: "remove",
  update: "update",
  outdated: "outdated",
  list: "list",
  ls: "list",
  ll: "list",
  la: "list",
  why: "why",
  explain: "why",
  query: "query",
  diff: "diff",
  "find-dupes": "find-dupes",
  bin: "bin",
  prefix: "prefix",
  root: "root",
  run: "run",
  "run-script": "run",
  test: "run",
  start: "run",
  stop: "run",
  restart: "restart",
  "install-test": "install-test",
  it: "install-test",
  "install-ci-test": "install-ci-test",
  cit: "install-ci-test",
  audit: "audit",
  exec: "exec",
  explore: "explore",
  edit: "edit",
  pack: "pack",
  publish: "publish",
  stage: "stage",
  unpublish: "unpublish",
  access: "access",
  owner: "owner",
  token: "token",
  star: "star",
  unstar: "unstar",
  stars: "stars",
  org: "org",
  team: "team",
  profile: "profile",
  trust: "trust",
  login: "login",
  adduser: "login",
  logout: "logout",
  whoami: "whoami",
  view: "view",
  info: "view",
  search: "search",
  repo: "repo",
  docs: "docs",
  bugs: "bugs",
  dist: "dist-tag",
  "dist-tag": "dist-tag",
  deprecate: "deprecate",
  undeprecate: "deprecate",
  config: "config",
  get: "config",
  set: "config",
  init: "init",
  create: "init",
  innit: "init",
  version: "version",
  verison: "version",
  shrinkwrap: "shrinkwrap",
  prune: "prune",
  dedupe: "dedupe",
  ddp: "dedupe",
  rebuild: "rebuild",
  rb: "rebuild",
  "install-scripts": "install-scripts",
  "approve-scripts": "approve-scripts",
  "deny-scripts": "deny-scripts",
  fund: "fund",
  cache: "cache",
  ping: "ping",
  doctor: "doctor",
  completion: "completion",
  pkg: "pkg",
  sbom: "sbom",
  link: "link",
  unlink: "unlink",
};
const saveFlags: Readonly<Record<string, SaveSection>> = {
  "--save-prod": "prod",
  "--save-dev": "dev",
  "-D": "dev",
  "--save-optional": "optional",
  "-O": "optional",
  "--save-peer": "peer",
};

function requireOverride(flag: string, value: string | undefined): string {
  if (!value) {
    throw new UsageError(`${flag} requires an exact name@version value`);
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1 || value.slice(at + 1).includes("@")) {
    throw new UsageError(`${flag} requires an exact name@version value`);
  }
  let parsed: npa.Result;
  try {
    parsed = npa(value);
  } catch {
    throw new UsageError(`${flag} requires an exact name@version value`);
  }
  if (parsed.type !== "version" || parsed.name === undefined || parsed.rawSpec !== value.slice(at + 1)) {
    throw new UsageError(`${flag} requires an exact name@version value`);
  }
  return value;
}

function consumeGlobal(args: readonly string[]): { readonly options: GlobalOptions; readonly rest: readonly string[] } {
  let json = false;
  let details = false;
  let registry: string | undefined;
  const allowRecent: string[] = [];
  const allowDangerous: string[] = [];
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--json") {
      json = true;
      index += 1;
      continue;
    }
    if (arg === "--details") {
      details = true;
      index += 1;
      continue;
    }
    if (arg === "--registry" || arg.startsWith("--registry=")) {
      const value = arg === "--registry" ? args[index + 1] : arg.slice("--registry=".length);
      let parsed: URL;
      try { parsed = new URL(value ?? ""); } catch { throw new UsageError("--registry requires an absolute HTTPS URL"); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new UsageError("--registry requires an HTTPS URL without embedded credentials, query, or fragment");
      }
      registry = parsed.href;
      index += arg === "--registry" ? 2 : 1;
      continue;
    }
    if (arg === "--allow-recent" || arg === "--allow-dangerous") {
      const value = args[index + 1];
      const override = requireOverride(arg, value);
      (arg === "--allow-recent" ? allowRecent : allowDangerous).push(override);
      index += 2;
      continue;
    }
    if (arg.startsWith("--allow-recent=")) {
      allowRecent.push(requireOverride("--allow-recent", arg.slice("--allow-recent=".length)));
      index += 1;
      continue;
    }
    if (arg.startsWith("--allow-dangerous=")) {
      allowDangerous.push(requireOverride("--allow-dangerous", arg.slice("--allow-dangerous=".length)));
      index += 1;
      continue;
    }
    break;
  }
  return { options: { json, ...(details ? { details: true } : {}), ...(registry === undefined ? {} : { registry }), allowRecent, allowDangerous }, rest: args.slice(index) };
}

function validateSpecifier(specifier: string): void {
  let parsed: npa.Result;
  try {
    parsed = npa(specifier);
  } catch {
    if (
      /^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*@workspace:(?:[*~^]|[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.test(
        specifier,
      )
    ) {
      return;
    }
    throw new UsageError(`invalid package specification: ${specifier}`);
  }
  if (parsed.type === "directory") {
    return;
  }
  if (parsed.type === "file") {
    return;
  }
  if (parsed.type === "remote") {
    const url = new URL(parsed.fetchSpec as string);
    if (url.protocol === "https:" && !url.username && !url.password && !url.hash) return;
    throw new UsageError(`HTTPS tarball specifications must not embed credentials or fragments: ${specifier}`);
  }
  if (parsed.type === "git") {
    const hosted = parsed.hosted as undefined | { https(options?: { noCommittish?: boolean; noGitPlus?: boolean }): string };
    const value = typeof parsed.fetchSpec === "string" ? parsed.fetchSpec : hosted?.https({ noCommittish: true, noGitPlus: true });
    const url = new URL(value ?? "");
    const secureTransport = (url.protocol === "https:" && !url.username) || url.protocol === "ssh:";
    if (secureTransport && !url.password && !url.search && !url.hash && (parsed.gitRange === undefined || semver.validRange(parsed.gitRange))) return;
    throw new UsageError(`Git specifications must use HTTPS or SSH without embedded passwords: ${specifier}`);
  }
  if (!["version", "range", "tag", "alias"].includes(parsed.type)) {
    throw new UsageError(`unsupported package source: ${specifier}`);
  }
  if (parsed.type === "alias" && "subSpec" in parsed && parsed.subSpec) {
    validateSpecifier((parsed as npa.AliasResult).subSpec.raw);
  }
}

function parseCommandOptions(args: readonly string[], global: GlobalOptions): { readonly options: CommandOptions; readonly operands: readonly string[] } {
  let frozenLockfile = false;
  let offline = false;
  const omitted = new Set<OmitDependencyType>(process.env.NODE_ENV === "production" ? ["dev"] : []);
  let saveSection: SaveSection | undefined;
  let saveExact = false;
  let noSave = false;
  let globalInstall = false;
  let dryRun = false;
  let packDestination: string | undefined;
  let tag: string | undefined;
  let access: "public" | "restricted" | undefined;
  let otp: string | undefined;
  let provenance = false;
  let provenanceFile: string | undefined;
  let yes = false;
  let force = false;
  let workspaces = false;
  const workspaceNames: string[] = [];
  let includeWorkspaceRoot = false;
  let ifPresent = false;
  let ignoreScripts = false;
  let sbomFormat: "cyclonedx" | "spdx" | undefined;
  let trustFile: string | undefined;
  let trustRepository: string | undefined;
  let trustProject: string | undefined;
  let trustEnvironment: string | undefined;
  let trustOrganizationId: string | undefined;
  let trustProjectId: string | undefined;
  let trustPipelineDefinitionId: string | undefined;
  let trustVcsOrigin: string | undefined;
  const trustContextIds: string[] = [];
  let allowPublish = false;
  let allowStagePublish = false;
  let tokenName: string | undefined;
  let tokenDescription: string | undefined;
  let tokenExpires: number | undefined;
  const tokenPackages: string[] = [];
  let tokenPackagesAll = false;
  const tokenScopes: string[] = [];
  const tokenOrganizations: string[] = [];
  let tokenPackagesPermission: "read-only" | "read-write" | undefined;
  let tokenOrganizationsPermission: "read-only" | "read-write" | undefined;
  const tokenCidrs: string[] = [];
  let tokenBypass2fa = false;
  let tokenReadOnly = false;
  let authType: "web" | "legacy" | undefined;
  let expectResults: boolean | undefined;
  let expectResultCount: number | undefined;
  let packageLockOnly = false;
  const execPackages: string[] = [];
  let gitTagVersion = true; let commitHooks = true; let signGitTag = false; let versionMessage: string | undefined; let preid: string | undefined; let allowSameVersion = false;
  const diffSpecs: string[] = [];
  let diffNameOnly = false;
  let diffUnified: number | undefined;
  let diffIgnoreAllSpace = false;
  let diffNoPrefix = false;
  let diffSrcPrefix: string | undefined;
  let diffDstPrefix: string | undefined;
  let diffText = false;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--frozen-lockfile") {
      frozenLockfile = true;
    } else if (arg === "--offline") {
      offline = true;
    } else if (arg === "--production" || arg === "--production=true" || arg === "--only=prod" || arg === "--only=production") {
      omitted.add("dev");
    } else if (arg === "--omit" || arg.startsWith("--omit=")) {
      const value = arg === "--omit" ? args[index + 1] : arg.slice("--omit=".length);
      const values = value?.split(",") ?? [];
      if (values.length === 0 || values.some((entry): entry is string => !["dev", "optional", "peer"].includes(entry))) throw new UsageError("--omit requires dev, optional, or peer");
      for (const entry of values) omitted.add(entry as OmitDependencyType); if (arg === "--omit") index += 1;
    } else if (arg === "--include" || arg.startsWith("--include=") || arg === "--production=false") {
      const value = arg === "--production=false" ? "dev" : arg === "--include" ? args[index + 1] : arg.slice("--include=".length);
      const values = value?.split(",") ?? [];
      if (values.length === 0 || values.some((entry): entry is string => !["dev", "optional", "peer", "prod"].includes(entry))) throw new UsageError("--include requires prod, dev, optional, or peer");
      for (const entry of values) if (entry !== "prod") omitted.delete(entry as OmitDependencyType); if (arg === "--include") index += 1;
    } else if (arg === "--save-exact" || arg === "-E") {
      saveExact = true;
    } else if (arg === "--no-save") {
      noSave = true;
    } else if (arg === "--global" || arg === "-g") {
      globalInstall = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--pack-destination" || arg.startsWith("--pack-destination=")) {
      const value = arg === "--pack-destination" ? args[index + 1] : arg.slice("--pack-destination=".length);
      if (!value || value.startsWith("-")) throw new UsageError("--pack-destination requires a directory");
      packDestination = value;
      if (arg === "--pack-destination") index += 1;
    } else if (arg === "--tag" || arg.startsWith("--tag=")) {
      const value = arg === "--tag" ? args[index + 1] : arg.slice("--tag=".length);
      if (!value || value.startsWith("-") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new UsageError("--tag requires a valid distribution tag");
      tag = value;
      if (arg === "--tag") index += 1;
    } else if (arg === "--access" || arg.startsWith("--access=")) {
      const value = arg === "--access" ? args[index + 1] : arg.slice("--access=".length);
      if (value === "private") access = "restricted";
      else if (value === "public" || value === "restricted") access = value;
      else throw new UsageError("--access must be public, restricted, or private");
      if (arg === "--access") index += 1;
    } else if (arg === "--otp" || arg.startsWith("--otp=")) {
      const value = arg === "--otp" ? args[index + 1] : arg.slice("--otp=".length);
      if (!value || value.startsWith("-") || !/^\d{6,10}$/.test(value)) throw new UsageError("--otp requires a 6-10 digit one-time password");
      otp = value;
      if (arg === "--otp") index += 1;
    } else if (arg === "--provenance") {
      provenance = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--workspaces") {
      workspaces = true;
    } else if (arg === "--workspace" || arg === "-w" || arg.startsWith("--workspace=")) {
      const value = arg === "--workspace" || arg === "-w" ? args[index + 1] : arg.slice("--workspace=".length);
      if (!value || value.startsWith("-") || value.includes("\0")) throw new UsageError("--workspace requires a workspace name or path");
      workspaceNames.push(value); if (arg === "--workspace" || arg === "-w") index += 1;
    } else if (arg === "--include-workspace-root") {
      includeWorkspaceRoot = true;
    } else if (arg === "--if-present") {
      ifPresent = true;
    } else if (arg === "--ignore-scripts") {
      ignoreScripts = true;
    } else if (arg === "--sbom-format" || arg.startsWith("--sbom-format=")) {
      const value = arg === "--sbom-format" ? args[index + 1] : arg.slice("--sbom-format=".length);
      if (value !== "cyclonedx" && value !== "spdx") throw new UsageError("--sbom-format must be cyclonedx or spdx");
      sbomFormat = value;
      if (arg === "--sbom-format") index += 1;
    } else if (["--file", "--repository", "--repo", "--project", "--environment", "--env", "--org-id", "--project-id", "--pipeline-definition-id", "--vcs-origin", "--context-id"].some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      const equals = arg.indexOf("=");
      const flag = equals < 0 ? arg : arg.slice(0, equals);
      const value = arg === flag ? args[index + 1] : arg.slice(flag.length + 1);
      if (!value || value.startsWith("-") || value.includes("\0")) throw new UsageError(`${flag} requires a value`);
      if (flag === "--file") trustFile = value;
      else if (flag === "--repository" || flag === "--repo") trustRepository = value;
      else if (flag === "--project") trustProject = value;
      else if (flag === "--environment" || flag === "--env") trustEnvironment = value;
      else if (flag === "--org-id") trustOrganizationId = value;
      else if (flag === "--project-id") trustProjectId = value;
      else if (flag === "--pipeline-definition-id") trustPipelineDefinitionId = value;
      else if (flag === "--vcs-origin") trustVcsOrigin = value;
      else trustContextIds.push(value);
      if (arg === flag) index += 1;
    } else if (arg === "--allow-publish") {
      allowPublish = true;
    } else if (arg === "--allow-stage-publish" || arg === "--allow-staged-publish") {
      allowStagePublish = true;
    } else if (["--name", "--token-description", "--expires", "--packages", "--scopes", "--orgs", "--packages-and-scopes-permission", "--orgs-permission", "--cidr"].some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      const equals = arg.indexOf("="); const flag = equals < 0 ? arg : arg.slice(0, equals);
      const value = equals < 0 ? args[index + 1] : arg.slice(equals + 1);
      if (!value || value.startsWith("-") || value.includes("\0")) throw new UsageError(`${flag} requires a value`);
      if (flag === "--name") tokenName = value;
      else if (flag === "--token-description") tokenDescription = value;
      else if (flag === "--expires") { const days = Number(value); if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new UsageError("--expires requires 1-3650 days"); tokenExpires = days; }
      else if (flag === "--packages") tokenPackages.push(...value.split(",").filter(Boolean));
      else if (flag === "--scopes") tokenScopes.push(...value.split(",").filter(Boolean));
      else if (flag === "--orgs") tokenOrganizations.push(...value.split(",").filter(Boolean));
      else if (flag === "--packages-and-scopes-permission") { if (value !== "read-only" && value !== "read-write") throw new UsageError(`${flag} must be read-only or read-write`); tokenPackagesPermission = value; }
      else if (flag === "--orgs-permission") { if (value !== "read-only" && value !== "read-write") throw new UsageError(`${flag} must be read-only or read-write`); tokenOrganizationsPermission = value; }
      else tokenCidrs.push(...value.split(",").filter(Boolean));
      if (equals < 0) index += 1;
    } else if (arg === "--packages-all") {
      tokenPackagesAll = true;
    } else if (arg === "--bypass-2fa") {
      tokenBypass2fa = true;
    } else if (arg === "--read-only") {
      tokenReadOnly = true;
    } else if (arg === "--auth-type" || arg.startsWith("--auth-type=")) {
      const value = arg === "--auth-type" ? args[index + 1] : arg.slice("--auth-type=".length);
      if (value !== "web" && value !== "legacy") throw new UsageError("--auth-type must be web or legacy");
      authType = value;
      if (arg === "--auth-type") index += 1;
    } else if (arg === "--expect-results") {
      expectResults = true;
    } else if (arg === "--no-expect-results") {
      expectResults = false;
    } else if (arg === "--expect-result-count" || arg.startsWith("--expect-result-count=")) {
      const value = arg === "--expect-result-count" ? args[index + 1] : arg.slice("--expect-result-count=".length);
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 0) throw new UsageError("--expect-result-count requires a non-negative integer");
      expectResultCount = count;
      if (arg === "--expect-result-count") index += 1;
    } else if (arg === "--package-lock-only") {
      packageLockOnly = true;
    } else if (arg === "--no-git-tag-version") {
      gitTagVersion = false;
    } else if (arg === "--git-tag-version") {
      gitTagVersion = true;
    } else if (arg === "--no-commit-hooks") {
      commitHooks = false;
    } else if (arg === "--commit-hooks") {
      commitHooks = true;
    } else if (arg === "--sign-git-tag") {
      signGitTag = true;
    } else if (arg === "--allow-same-version") {
      allowSameVersion = true;
    } else if (arg === "--message" || arg === "-m" || arg.startsWith("--message=")) {
      const value = arg === "--message" || arg === "-m" ? args[index + 1] : arg.slice("--message=".length); if (!value || value.includes("\0")) throw new UsageError("--message requires a commit message"); versionMessage = value; if (arg === "--message" || arg === "-m") index += 1;
    } else if (arg === "--preid" || arg.startsWith("--preid=")) {
      const value = arg === "--preid" ? args[index + 1] : arg.slice("--preid=".length); if (!value || !/^[0-9A-Za-z-]+$/.test(value)) throw new UsageError("--preid requires an alphanumeric prerelease identifier"); preid = value; if (arg === "--preid") index += 1;
    } else if (arg === "--package" || arg.startsWith("--package=")) {
      const value = arg === "--package" ? args[index + 1] : arg.slice("--package=".length);
      if (!value || value.startsWith("-") || value.includes("\0")) throw new UsageError("--package requires a package specification");
      validateSpecifier(value); execPackages.push(value); if (arg === "--package") index += 1;
    } else if (["--diff", "--diff-unified", "--diff-src-prefix", "--diff-dst-prefix"].some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      const equals = arg.indexOf("="); const flag = equals < 0 ? arg : arg.slice(0, equals);
      const value = equals < 0 ? args[index + 1] : arg.slice(equals + 1);
      if (value === undefined || value === "" || (flag !== "--diff-src-prefix" && flag !== "--diff-dst-prefix" && value.startsWith("-"))) throw new UsageError(`${flag} requires a value`);
      if (flag === "--diff") { if (diffSpecs.length >= 2) throw new UsageError("--diff may be specified at most twice"); diffSpecs.push(value); }
      else if (flag === "--diff-unified") { const count = Number(value); if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) throw new UsageError("--diff-unified requires an integer from 0 to 10000"); diffUnified = count; }
      else if (flag === "--diff-src-prefix") diffSrcPrefix = value;
      else diffDstPrefix = value;
      if (equals < 0) index += 1;
    } else if (arg === "--diff-name-only") {
      diffNameOnly = true;
    } else if (arg === "--diff-ignore-all-space") {
      diffIgnoreAllSpace = true;
    } else if (arg === "--diff-no-prefix") {
      diffNoPrefix = true;
    } else if (arg === "--diff-text") {
      diffText = true;
    } else if (arg === "--provenance-file" || arg.startsWith("--provenance-file=")) {
      const value = arg === "--provenance-file" ? args[index + 1] : arg.slice("--provenance-file=".length);
      if (!value || value.startsWith("-")) throw new UsageError("--provenance-file requires a file path");
      provenanceFile = value;
      if (arg === "--provenance-file") index += 1;
    } else {
      const section = saveFlags[arg];
      if (section !== undefined) {
        if (saveSection !== undefined && saveSection !== section) {
          throw new UsageError("save-section flags are mutually exclusive");
        }
        saveSection = section;
      } else if (arg.startsWith("-")) {
        throw new UsageError(`unknown option: ${arg}`);
      } else {
        break;
      }
    }
    index += 1;
  }
  if (noSave && (saveSection !== undefined || saveExact)) {
    throw new UsageError("--no-save conflicts with save flags");
  }
  if (provenance && provenanceFile !== undefined) throw new UsageError("--provenance and --provenance-file are mutually exclusive");
  if (expectResults !== undefined && expectResultCount !== undefined) throw new UsageError("--expect-results and --expect-result-count are mutually exclusive");
  return {
    options: {
      ...global,
      globalInstall,
      dryRun,
      ...(packDestination === undefined ? {} : { packDestination }),
      ...(tag === undefined ? {} : { tag }),
      ...(access === undefined ? {} : { access }),
      ...(otp === undefined ? {} : { otp }),
      ...(provenance ? { provenance: true } : {}),
      ...(provenanceFile === undefined ? {} : { provenanceFile }),
      ...(yes ? { yes: true } : {}),
      ...(force ? { force: true } : {}),
      ...(workspaces ? { workspaces: true } : {}),
      ...(workspaceNames.length === 0 ? {} : { workspaceNames }),
      ...(includeWorkspaceRoot ? { includeWorkspaceRoot: true } : {}),
      ...(ifPresent ? { ifPresent: true } : {}),
      ...(ignoreScripts ? { ignoreScripts: true } : {}),
      ...(sbomFormat === undefined ? {} : { sbomFormat }),
      ...(trustFile === undefined ? {} : { trustFile }),
      ...(trustRepository === undefined ? {} : { trustRepository }),
      ...(trustProject === undefined ? {} : { trustProject }),
      ...(trustEnvironment === undefined ? {} : { trustEnvironment }),
      ...(trustOrganizationId === undefined ? {} : { trustOrganizationId }),
      ...(trustProjectId === undefined ? {} : { trustProjectId }),
      ...(trustPipelineDefinitionId === undefined ? {} : { trustPipelineDefinitionId }),
      ...(trustVcsOrigin === undefined ? {} : { trustVcsOrigin }),
      ...(trustContextIds.length === 0 ? {} : { trustContextIds }),
      ...(allowPublish ? { allowPublish: true } : {}),
      ...(allowStagePublish ? { allowStagePublish: true } : {}),
      ...(tokenName === undefined ? {} : { tokenName }),
      ...(tokenDescription === undefined ? {} : { tokenDescription }),
      ...(tokenExpires === undefined ? {} : { tokenExpires }),
      ...(tokenPackages.length === 0 ? {} : { tokenPackages }),
      ...(tokenPackagesAll ? { tokenPackagesAll: true } : {}),
      ...(tokenScopes.length === 0 ? {} : { tokenScopes }),
      ...(tokenOrganizations.length === 0 ? {} : { tokenOrganizations }),
      ...(tokenPackagesPermission === undefined ? {} : { tokenPackagesPermission }),
      ...(tokenOrganizationsPermission === undefined ? {} : { tokenOrganizationsPermission }),
      ...(tokenCidrs.length === 0 ? {} : { tokenCidrs }),
      ...(tokenBypass2fa ? { tokenBypass2fa: true } : {}),
      ...(tokenReadOnly ? { tokenReadOnly: true } : {}),
      ...(authType === undefined ? {} : { authType }),
      ...(expectResults === undefined ? {} : { expectResults }),
      ...(expectResultCount === undefined ? {} : { expectResultCount }),
      ...(packageLockOnly ? { packageLockOnly: true } : {}),
      ...(execPackages.length === 0 ? {} : { execPackages }),
      ...(gitTagVersion ? {} : { gitTagVersion: false }),
      ...(commitHooks ? {} : { commitHooks: false }),
      ...(signGitTag ? { signGitTag: true } : {}),
      ...(versionMessage === undefined ? {} : { versionMessage }),
      ...(preid === undefined ? {} : { preid }),
      ...(allowSameVersion ? { allowSameVersion: true } : {}),
      ...(diffSpecs.length === 0 ? {} : { diffSpecs }),
      ...(diffNameOnly ? { diffNameOnly: true } : {}),
      ...(diffUnified === undefined ? {} : { diffUnified }),
      ...(diffIgnoreAllSpace ? { diffIgnoreAllSpace: true } : {}),
      ...(diffNoPrefix ? { diffNoPrefix: true } : {}),
      ...(diffSrcPrefix === undefined ? {} : { diffSrcPrefix }),
      ...(diffDstPrefix === undefined ? {} : { diffDstPrefix }),
      ...(diffText ? { diffText: true } : {}),
      frozenLockfile,
      offline,
      omitDev: omitted.has("dev"),
      ...(omitted.size === 0 ? {} : { omit: [...omitted].sort() }),
      ...(saveSection === undefined ? {} : { saveSection }),
      saveExact,
      noSave,
    },
    operands: args.slice(index),
  };
}

function normalizeQueryArguments(args: readonly string[]): readonly string[] {
  const options: string[] = []; const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (value === "--expect-result-count") {
      options.push(value);
      if (args[index + 1] !== undefined) options.push(args[++index] as string);
    } else if (["--expect-results", "--no-expect-results", "--package-lock-only", "--global", "-g", "--workspaces"].includes(value) || value.startsWith("--expect-result-count=")) options.push(value);
    else operands.push(value);
  }
  return [...options, ...operands];
}

function normalizeDiffArguments(args: readonly string[]): readonly string[] {
  const options: string[] = []; const operands: string[] = [];
  const valued = new Set(["--diff", "--diff-unified", "--diff-src-prefix", "--diff-dst-prefix"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? ""; const flag = value.split("=", 1)[0] ?? value;
    if (valued.has(flag)) { options.push(value); if (value === flag && args[index + 1] !== undefined) options.push(args[++index] as string); }
    else if (["--diff-name-only", "--diff-ignore-all-space", "--diff-no-prefix", "--diff-text", "--global", "-g"].includes(value)) options.push(value);
    else operands.push(value);
  }
  return [...options, ...operands];
}

function parseChildArguments(name: "run" | "exec", operands: readonly string[]): readonly string[] {
  const primary = operands[0];
  if (!primary || primary === "--" || !/^[A-Za-z0-9._:-]+$/.test(primary)) {
    throw new UsageError(`${name} requires an exact ${name === "run" ? "script" : "binary"} name`);
  }
  return [primary, ...(operands[1] === "--" ? operands.slice(2) : operands.slice(1))];
}

function normalizeExecArguments(args: readonly string[]): readonly string[] {
  const separator = args.indexOf("--");
  if (separator < 0) return args;
  return [...args.slice(0, separator), ...args.slice(separator + 1)];
}

function normalizeInitArguments(args: readonly string[]): readonly string[] {
  const separator = args.indexOf("--"); const before = separator < 0 ? args : args.slice(0, separator); const forwarded = separator < 0 ? [] : args.slice(separator + 1);
  const options: string[] = []; const operands: string[] = [];
  for (let index = 0; index < before.length; index += 1) {
    const value = before[index] ?? "";
    if (["--yes", "-y", "--include-workspace-root"].includes(value) || value.startsWith("--workspace=")) options.push(value);
    else if (value === "--workspace" || value === "-w") { options.push(value); if (before[index + 1] !== undefined) options.push(before[++index] as string); }
    else operands.push(value);
  }
  return [...options, ...operands, ...forwarded];
}

function normalizeVersionArguments(args: readonly string[]): readonly string[] {
  const options: string[] = []; const operands: string[] = []; const valued = new Set(["--message", "-m", "--preid", "--workspace", "-w"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? ""; const flag = value.split("=", 1)[0] ?? value;
    if (valued.has(flag)) { options.push(value); if (value === flag && args[index + 1] !== undefined) options.push(args[++index] as string); }
    else if (["--no-git-tag-version", "--git-tag-version", "--no-commit-hooks", "--commit-hooks", "--sign-git-tag", "--allow-same-version", "--force", "--ignore-scripts", "--no-save", "--workspaces", "--include-workspace-root"].includes(value) || value.startsWith("--message=") || value.startsWith("--preid=") || value.startsWith("--workspace=")) options.push(value);
    else operands.push(value);
  }
  return [...options, ...operands];
}

export function parseInvocation(args: readonly string[], invokedAsBnpmx = false): Invocation {
  const { options: global, rest } = consumeGlobal(args);
  const first = rest[0];
  if (!invokedAsBnpmx && (first === "help" || first === "help-search")) {
    if (rest.length > 2 || rest[1]?.startsWith("-")) throw new UsageError(`${first} accepts at most one topic`);
    return { kind: "help", json: global.json };
  }
  if (first === "--help" || first === "-h") {
    if (!rest.slice(1).every((argument) => argument === "--json")) {
      throw new UsageError("--help cannot be combined with command operands");
    }
    return { kind: "help", json: global.json || rest.slice(1).includes("--json") };
  }
  if (first === "--version" || first === "-v") {
    if (!rest.slice(1).every((argument) => argument === "--json")) {
      throw new UsageError("--version cannot be combined with command operands");
    }
    return { kind: "version", json: global.json || rest.slice(1).includes("--json") };
  }
  if (rest.length === 0 && !invokedAsBnpmx) {
    return { kind: "help", json: global.json };
  }
  if (invokedAsBnpmx) {
    if (!first || first.startsWith("-")) {
      throw new UsageError("bnpmx requires one package specification");
    }
    validateSpecifier(first);
    const trailing = rest.slice(1);
    if (trailing[0] !== undefined && trailing[0] !== "--") {
      throw new UsageError("bnpmx target arguments must follow --");
    }
    return { kind: "bnpmx", options: global, specifier: first, targetArgs: trailing.slice(trailing[0] === "--" ? 1 : 0) };
  }
  const canonicalName = first === undefined ? undefined : commandAliases[first];
  if (!first || canonicalName === undefined) {
    throw new UsageError(`unknown command: ${first ?? ""}`);
  }
  const name = canonicalName;
  const scriptAlias = first === "test" || first === "start" || first === "stop";
  const commandArguments = scriptAlias
    ? [first, ...rest.slice(1)]
    : first === "get"
      ? ["get", ...rest.slice(1)]
      : first === "set"
        ? rest.length === 2 && rest[1]?.includes("=") ? ["set", ...rest[1].split(/=(.*)/s).slice(0, 2)] : ["set", ...rest.slice(1)]
        : first === "undeprecate"
          ? [...rest.slice(1), ""]
          : name === "stage"
            ? rest.slice(2)
          : name === "trust"
              ? rest.slice(2)
            : name === "token"
              ? rest.slice(2)
              : name === "query"
                ? normalizeQueryArguments(rest.slice(1))
                : name === "diff"
                  ? normalizeDiffArguments(rest.slice(1))
                  : name === "exec"
                    ? normalizeExecArguments(rest.slice(1))
                    : name === "init"
                      ? normalizeInitArguments(rest.slice(1))
                      : name === "version"
                        ? normalizeVersionArguments(rest.slice(1))
                    : name === "audit" && rest.includes("--dry-run")
                      ? ["--dry-run", ...rest.slice(1).filter((value) => value !== "--dry-run")]
                  : name === "install-scripts" && rest.includes("--dry-run")
                    ? ["--dry-run", ...rest.slice(1).filter((value) => value !== "--dry-run")]
    : name === "cache" && rest.at(-1) === "--force"
    ? ["--force", ...rest.slice(1, -1)]
    : rest.slice(1);
  const parsed = parseCommandOptions(commandArguments, global);
  const ci = first === "ci" || name === "install-ci-test";
  if (ci && (parsed.operands.length > 0 || parsed.options.saveSection !== undefined || parsed.options.saveExact)) {
    throw new UsageError("ci accepts no package operands or save flags");
  }
  const options: CommandOptions = ci
    ? { ...parsed.options, frozenLockfile: true, noSave: true }
    : first === "adduser" ? { ...parsed.options, accountCreate: true } : parsed.options;
  if (name === "edit" && options.json) throw new UsageError("edit is interactive and cannot use --json");
  const operands = name === "stage" || name === "trust" || name === "token" ? [rest[1] ?? "", ...parsed.operands] : parsed.operands;
  const hasAuthoringOptions = options.dryRun || options.packDestination !== undefined || options.tag !== undefined || options.access !== undefined || options.otp !== undefined || options.provenance === true || options.provenanceFile !== undefined;
  const hasNonDryAuthoringOptions = options.packDestination !== undefined || options.tag !== undefined || options.access !== undefined || options.otp !== undefined || options.provenance === true || options.provenanceFile !== undefined;
  if (!["pack", "publish", "stage", "unpublish", "access", "owner", "token", "star", "unstar", "org", "team", "profile", "trust", "login", "deprecate", "dist-tag", "diff"].includes(name) && hasNonDryAuthoringOptions) throw new UsageError("package authoring options are not valid for this command");
  if (options.dryRun && !["install", "add", "remove", "update", "prune", "dedupe", "pack", "publish", "stage", "unpublish", "deprecate", "trust", "install-scripts", "audit"].includes(name)) throw new UsageError("--dry-run is not valid for this command");
  if (name === "pack" && (options.tag !== undefined || options.access !== undefined || options.otp !== undefined || options.provenance === true || options.provenanceFile !== undefined)) throw new UsageError("publish options are not valid for pack");
  if (name === "publish" && options.packDestination !== undefined) throw new UsageError("--pack-destination is only valid for pack");
  if (name === "stage" && options.packDestination !== undefined) throw new UsageError("--pack-destination is not valid for stage");
  if (options.yes && name !== "init" && name !== "trust") throw new UsageError("--yes is only valid for init or trust");
  if (options.force && name !== "cache" && name !== "unpublish" && name !== "version") throw new UsageError("--force is only valid for cache clean, unpublish, or version");
  const workspaceCommands = ["install", "install-test", "install-ci-test", "add", "remove", "update", "outdated", "list", "run", "query", "init", "version"];
  if (options.workspaces && !workspaceCommands.includes(name)) throw new UsageError("--workspaces is not valid for this command");
  if (options.workspaceNames !== undefined && !workspaceCommands.includes(name)) throw new UsageError("--workspace is not valid for this command");
  if (options.includeWorkspaceRoot && !workspaceCommands.includes(name)) throw new UsageError("--include-workspace-root is not valid for this command");
  if (options.includeWorkspaceRoot && !options.workspaces && options.workspaceNames === undefined) throw new UsageError("--include-workspace-root requires --workspaces or --workspace");
  if (name === "init" && (options.workspaces || options.includeWorkspaceRoot)) throw new UsageError("init supports one --workspace path, not --workspaces or --include-workspace-root");
  if (options.ifPresent && name !== "run") throw new UsageError("--if-present is only valid for run");
  if (options.ignoreScripts && !["install", "install-test", "install-ci-test", "add", "remove", "update", "prune", "dedupe", "rebuild", "pack", "publish", "run", "version"].includes(name)) throw new UsageError("--ignore-scripts is not valid for this command");
  if (options.sbomFormat && name !== "sbom") throw new UsageError("--sbom-format is only valid for sbom");
  const hasTrustOptions = options.trustFile !== undefined || options.trustRepository !== undefined || options.trustProject !== undefined || options.trustEnvironment !== undefined || options.trustOrganizationId !== undefined || options.trustProjectId !== undefined || options.trustPipelineDefinitionId !== undefined || options.trustVcsOrigin !== undefined || options.trustContextIds !== undefined || options.allowPublish === true || options.allowStagePublish === true;
  if (hasTrustOptions && name !== "trust") throw new UsageError("trusted-publisher options are only valid for trust");
  const hasTokenOptions = options.tokenName !== undefined || options.tokenDescription !== undefined || options.tokenExpires !== undefined || options.tokenPackages !== undefined || options.tokenPackagesAll === true || options.tokenScopes !== undefined || options.tokenOrganizations !== undefined || options.tokenPackagesPermission !== undefined || options.tokenOrganizationsPermission !== undefined || options.tokenCidrs !== undefined || options.tokenBypass2fa === true || options.tokenReadOnly === true;
  if (hasTokenOptions && name !== "token") throw new UsageError("token creation options are only valid for token");
  if (hasTokenOptions && name === "token" && operands[0] !== "create") throw new UsageError("token creation options require token create");
  if (options.authType !== undefined && name !== "login") throw new UsageError("--auth-type is only valid for login or adduser");
  if ((options.expectResults !== undefined || options.expectResultCount !== undefined) && name !== "query") throw new UsageError("query expectation options are only valid for query");
  if (options.packageLockOnly === true && name !== "query" && name !== "install") throw new UsageError("--package-lock-only is only valid for query or install");
  const hasDiffOptions = options.diffSpecs !== undefined || options.diffNameOnly || options.diffUnified !== undefined || options.diffIgnoreAllSpace || options.diffNoPrefix || options.diffSrcPrefix !== undefined || options.diffDstPrefix !== undefined || options.diffText;
  if (hasDiffOptions && name !== "diff") throw new UsageError("diff options are only valid for diff");
  if ((name === "deprecate" || name === "dist-tag") && (options.packDestination !== undefined || options.tag !== undefined || options.access !== undefined || options.provenance === true || options.provenanceFile !== undefined)) throw new UsageError("unsupported package authoring option for registry mutation");
  if (name === "unpublish" && (options.packDestination !== undefined || options.tag !== undefined || options.access !== undefined || options.provenance === true || options.provenanceFile !== undefined)) throw new UsageError("unsupported package authoring option for unpublish");
  if ((name === "access" || name === "owner") && (options.dryRun || options.packDestination !== undefined || options.tag !== undefined || options.access !== undefined || options.provenance === true || options.provenanceFile !== undefined)) throw new UsageError(`unsupported package authoring option for ${name}`);
  if (name === "token" && (options.dryRun || options.packDestination !== undefined || options.tag !== undefined || options.access !== undefined || options.provenance === true || options.provenanceFile !== undefined)) throw new UsageError("unsupported package authoring option for token");
  if ((name === "star" || name === "unstar") && (options.dryRun || options.packDestination !== undefined || options.tag !== undefined || options.access !== undefined || options.provenance === true || options.provenanceFile !== undefined)) throw new UsageError(`unsupported package authoring option for ${name}`);
  if ((name === "org" || name === "team") && (options.dryRun || options.packDestination !== undefined || options.tag !== undefined || options.access !== undefined || options.provenance === true || options.provenanceFile !== undefined)) throw new UsageError(`unsupported package authoring option for ${name}`);
  if (name === "profile" && (options.dryRun || options.packDestination !== undefined || options.tag !== undefined || options.access !== undefined || options.provenance === true || options.provenanceFile !== undefined)) throw new UsageError("unsupported package authoring option for profile");
  if (name === "trust" && (options.packDestination !== undefined || options.tag !== undefined || options.access !== undefined || options.provenance === true || options.provenanceFile !== undefined)) throw new UsageError("unsupported package authoring option for trust");
  if (name === "login" && (options.dryRun || options.packDestination !== undefined || options.tag !== undefined || options.access !== undefined || options.provenance === true || options.provenanceFile !== undefined)) throw new UsageError("only --otp is valid as a package-authoring option for legacy login");
  if (name === "diff" && (options.dryRun || options.packDestination !== undefined || options.access !== undefined || options.otp !== undefined || options.provenance === true || options.provenanceFile !== undefined)) throw new UsageError("only --tag is valid as a package-authoring option for diff");
  if (ci && options.globalInstall) throw new UsageError("ci cannot be used with --global");
  if (options.globalInstall && !["install", "add", "remove", "update", "outdated", "list", "why", "query", "bin", "prefix", "root", "audit", "exec"].includes(name)) {
    throw new UsageError(`--global is not supported for ${name}`);
  }
  if (options.execPackages !== undefined && name !== "exec") throw new UsageError("--package is only valid for exec");
  if (options.execPackages !== undefined && options.globalInstall) throw new UsageError("exec --package cannot be combined with --global");
  const hasVersionOptions = options.gitTagVersion === false || options.commitHooks === false || options.signGitTag === true || options.versionMessage !== undefined || options.preid !== undefined || options.allowSameVersion === true;
  if (hasVersionOptions && name !== "version") throw new UsageError("version-control options are only valid for version");
  if (name === "version" && options.signGitTag && options.gitTagVersion === false) throw new UsageError("--sign-git-tag cannot be combined with --no-git-tag-version");
  const hasInstallPolicy = options.frozenLockfile || options.offline || options.omit !== undefined || (options.packageLockOnly === true && name !== "query");
  const hasSaveIntent = options.saveSection !== undefined || options.saveExact || options.noSave;
  if (name !== "install" && name !== "install-test" && name !== "install-ci-test" && name !== "prune" && name !== "dedupe" && hasInstallPolicy) {
    if (name !== "update" || options.frozenLockfile || options.offline) throw new UsageError("install policy options are only valid for install");
  }
  if (name !== "install" && name !== "install-test" && name !== "install-ci-test" && name !== "add" && !(name === "version" && options.noSave && options.saveSection === undefined && !options.saveExact) && hasSaveIntent) {
    throw new UsageError("save options are only valid for install, add, or version --no-save");
  }
  if (name === "audit") {
    if (operands.length > 1 || (operands.length === 1 && operands[0] !== "fix") || (options.dryRun && operands[0] !== "fix")) throw new UsageError("audit accepts no operands or fix [--dry-run]");
  } else if (name === "bin" || name === "prefix" || name === "root" || name === "login" || name === "logout" || name === "whoami" || name === "shrinkwrap" || name === "prune" || name === "dedupe" || name === "find-dupes" || name === "fund" || name === "ping" || name === "doctor" || name === "completion" || name === "sbom" || name === "restart" || name === "install-test" || name === "install-ci-test") {
    if (operands.length !== 0) {
      throw new UsageError(`${name} accepts no operands`);
    }
  } else if (name === "pkg") {
    const action = operands[0];
    if (!((action === "get" && operands.length >= 1) || (action === "set" && operands.length >= 2) || (action === "delete" && operands.length >= 2))) throw new UsageError("pkg requires get [key...], set <key=value...>, or delete <key...>");
  } else if (name === "cache") {
    const valid = (operands[0] === "verify" && operands.length === 1 && !options.force)
      || (operands[0] === "clean" && operands.length <= 2 && options.force)
      || (["ls", "list", "info"].includes(operands[0] ?? "") && operands.length <= 2 && !options.force)
      || (operands[0] === "add" && operands.length === 2 && !options.force);
    if (!valid) throw new UsageError("cache requires add <spec>, ls [name@version], verify, or clean [name@version] --force");
    if (operands[0] === "add") validateSpecifier(operands[1] ?? "");
  } else if (name === "install-scripts") {
    const action = operands[0];
    const names = operands.slice(1);
    const validNames = names.every((operand) => /^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operand));
    if (!validNames || !((action === "approve" || action === "deny") && names.length > 0 && !options.dryRun) && !(action === "ls" && names.length === 0 && !options.dryRun) && !(action === "prune" && names.length === 0)) throw new UsageError("install-scripts requires approve <pkg...>, deny <pkg...>, ls, or prune [--dry-run]");
  } else if (name === "init") {
    if (operands[0]?.startsWith("-") || operands[0]?.includes("\0")) throw new UsageError("init accepts an initializer package followed by arguments");
  } else if (name === "version") {
    if (operands.length > 1 || operands[0]?.startsWith("-")) throw new UsageError("version accepts at most one version or release type");
  } else if (name === "config") {
    const action = operands[0];
    const valid = (action === "list" && operands.length === 1) || (action === "get" && operands.length === 2) || (action === "delete" && operands.length === 2) || (action === "set" && operands.length === 3);
    if (!valid) throw new UsageError("config requires list, get <key>, set <key> <value>, or delete <key>");
  } else if (name === "view") {
    if (operands.length !== 1 || operands[0]?.startsWith("-")) throw new UsageError("view requires one package specification");
  } else if (name === "search") {
    if (operands.length === 0) throw new UsageError("search requires at least one term");
  } else if (name === "repo" || name === "docs" || name === "bugs") {
    if (operands.length > 1 || operands[0]?.startsWith("-")) throw new UsageError(`${name} accepts at most one package name`);
  } else if (name === "dist-tag") {
    const action = operands[0];
    const valid = (action === "add" && operands.length >= 2 && operands.length <= 3) || (["rm", "remove"].includes(action ?? "") && operands.length === 3) || (["ls", "list"].includes(action ?? "") && operands.length === 2);
    if (!valid) throw new UsageError("dist-tag requires add <package@version> [tag], rm <package> <tag>, or ls <package>");
  } else if (name === "deprecate") {
    if (operands.length !== 2) throw new UsageError("deprecate requires <package@range> <message>");
  } else if (name === "unpublish") {
    if (operands.length !== 1 || operands[0]?.startsWith("-")) throw new UsageError("unpublish requires one exact package@version or package@*");
  } else if (name === "stage") {
    const action = operands[0]; const uuidValue = operands[1] ?? "";
    const valid = (action === "publish" && operands.length <= 2 && !operands[1]?.startsWith("-")) || (action === "list" && operands.length <= 2) || (["view", "download", "approve", "reject"].includes(action ?? "") && operands.length === 2 && /^[0-9a-f-]{36}$/i.test(uuidValue));
    if (!valid) throw new UsageError("stage requires publish [directory], list [package], or view|download|approve|reject <stage-id>");
  } else if (name === "access") {
    const valid = (operands[0] === "get" && operands[1] === "status" && operands.length >= 2 && operands.length <= 3)
      || (operands[0] === "set" && /^(?:status=(?:public|private)|mfa=(?:none|publish|automation)|2fa=(?:none|publish|automation))$/.test(operands[1] ?? "") && operands.length >= 2 && operands.length <= 3)
      || (["list", "ls"].includes(operands[0] ?? "") && ((operands[1] === "collaborators" && operands.length >= 2 && operands.length <= 3) || (operands[1] === "packages" && operands.length >= 2 && operands.length <= 3)))
      || (operands[0] === "grant" && ["read-only", "read-write"].includes(operands[1] ?? "") && operands.length >= 3 && operands.length <= 4)
      || (operands[0] === "revoke" && operands.length >= 2 && operands.length <= 3);
    if (!valid) throw new UsageError("access requires get status [pkg], set status|mfa=<value> [pkg], list collaborators [pkg], list packages [owner], grant <permission> <team> [pkg], or revoke <team> [pkg]");
  } else if (name === "owner") {
    const valid = (["ls", "list"].includes(operands[0] ?? "") && operands.length >= 1 && operands.length <= 2) || (operands[0] === "add" && operands.length >= 2 && operands.length <= 3) || (["rm", "remove"].includes(operands[0] ?? "") && operands.length >= 2 && operands.length <= 3);
    if (!valid) throw new UsageError("owner requires ls [pkg], add <user> [pkg], or rm <user> [pkg]");
  } else if (name === "token") {
    const valid = (["list", "ls"].includes(operands[0] ?? "") && operands.length === 1) || (["revoke", "rm", "remove", "delete"].includes(operands[0] ?? "") && operands.length >= 2) || (operands[0] === "create" && operands.length === 1);
    if (!valid) throw new UsageError("token requires list, create, or revoke <id...>");
  } else if (name === "star" || name === "unstar") {
    if (operands.length === 0) throw new UsageError(`${name} requires at least one package name`);
    for (const operand of operands) validateSpecifier(operand);
  } else if (name === "stars") {
    if (operands.length > 1 || (operands[0] !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operands[0]))) throw new UsageError("stars accepts at most one registry username");
  } else if (name === "org") {
    const valid = (["ls", "list"].includes(operands[0] ?? "") && operands.length >= 2 && operands.length <= 3) || (["set", "add"].includes(operands[0] ?? "") && operands.length >= 3 && operands.length <= 4 && (operands[3] === undefined || ["developer", "admin", "owner"].includes(operands[3]))) || (["rm", "remove"].includes(operands[0] ?? "") && operands.length === 3);
    if (!valid) throw new UsageError("org requires ls <org> [user], set <org> <user> [role], or rm <org> <user>");
  } else if (name === "team") {
    const valid = (["create", "destroy"].includes(operands[0] ?? "") && operands.length === 2) || (["add", "rm", "remove"].includes(operands[0] ?? "") && operands.length === 3) || (["ls", "list"].includes(operands[0] ?? "") && operands.length === 2);
    if (!valid) throw new UsageError("team requires create|destroy <scope:team>, add|rm <scope:team> <user>, or ls <scope|scope:team>");
  } else if (name === "profile") {
    const action = operands[0];
    const valid = (action === "get" && operands.length <= 2)
      || (action === "set" && ((operands[1] === "password" && operands.length === 2) || (operands.length === 3 && ["email", "fullname", "homepage", "freenode", "twitter", "github"].includes(operands[1] ?? ""))))
      || (["enable-2fa", "enable-tfa", "enable2fa", "enabletfa"].includes(action ?? "") && operands.length <= 2 && (operands[1] === undefined || ["auth-only", "auth-and-writes"].includes(operands[1])))
      || (["disable-2fa", "disable-tfa", "disable2fa", "disabletfa"].includes(action ?? "") && operands.length === 1);
    if (!valid) throw new UsageError("profile supports get [key], set <field> <value>, set password, enable-2fa [auth-only|auth-and-writes], or disable-2fa");
    if (options.json && ["set", "enable-2fa", "enable-tfa", "enable2fa", "enabletfa", "disable-2fa", "disable-tfa", "disable2fa", "disabletfa"].includes(action ?? "") && (operands[1] === "password" || action !== "set")) throw new UsageError("secret-bearing profile changes are interactive and cannot use --json");
  } else if (name === "trust") {
    const provider = operands[0];
    const valid = (provider === "list" && operands.length >= 1 && operands.length <= 2)
      || (provider === "revoke" && operands.length >= 2 && operands.length <= 3)
      || (["github", "gitlab", "circleci"].includes(provider ?? "") && operands.length >= 1 && operands.length <= 2 && (options.allowPublish === true || options.allowStagePublish === true));
    if (!valid) throw new UsageError("trust supports list [package], revoke [package] <id>, or github|gitlab|circleci [package] with provider options and at least one publish permission");
  } else if (name === "pack" || name === "publish") {
    if (operands.length > 1 || operands[0]?.startsWith("-")) throw new UsageError(`${name} accepts at most one package directory`);
  } else if (name === "run" || name === "exec") {
    if (name === "run" && operands.length === 0) return { kind: "command", name, options, args: [] };
    return { kind: "command", name, options, args: parseChildArguments(name, operands) };
  } else if (name === "explore") {
    const packageName = operands[0];
    if (!packageName || !/^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packageName) || (operands.length > 1 && operands[1] !== "--")) throw new UsageError("explore requires <package> [-- <command> [args...]]");
    return { kind: "command", name, options, args: [packageName, ...operands.slice(operands[1] === "--" ? 2 : 1)] };
  } else if (name === "edit") {
    if (operands.length !== 1 || !/^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operands[0] ?? "")) throw new UsageError("edit requires one exact installed package name");
  } else if (name === "link" || name === "unlink") {
    if (operands.some((operand) => !/^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operand))) throw new UsageError(`${name} accepts only exact package names`);
  } else if (name === "query") {
    if (operands.length !== 1 || !operands[0]?.trim()) throw new UsageError("query requires one dependency selector");
  } else if (name === "diff") {
    if (operands.some((operand) => operand.startsWith("-") || operand.includes("\0"))) throw new UsageError("diff paths must not be options or contain NUL bytes");
  } else if (name === "remove" || name === "update" || name === "outdated" || name === "list" || name === "why" || name === "rebuild" || name === "approve-scripts" || name === "deny-scripts") {
    if (
      (name === "remove" && operands.length === 0) ||
      (name === "why" && operands.length !== 1) ||
      operands.some((operand) => !/^(?:@[^/@\s]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operand))
    ) {
      throw new UsageError(name === "why" ? "why requires one exact package name" : `${name} accepts only exact dependency names${name === "remove" ? " and requires at least one" : ""}`);
    }
  } else {
    if (name === "add" && operands.length === 0) {
      throw new UsageError("add requires at least one package specification");
    }
    for (const specifier of operands) {
      validateSpecifier(specifier);
    }
  }
  return { kind: "command", name, options, args: operands };
}
