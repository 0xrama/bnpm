import { ExitCode, type ExitCode as ExitCodeValue } from "../core/exit-codes.js";
import type { CommandOptions } from "../core/cli-parser.js";
import type { Output } from "../core/output.js";
import { installProject, type InstallProgress } from "../installer/install.js";
import { addDependencies, removeDependencies, updateDependencies } from "../installer/mutations.js";
import { execInstalled, exploreInstalled, ProcessCommandError, projectScriptNames, runProjectInstallLifecycle, runProjectScript, runProjectScriptIfPresent, runProjectScriptLifecycle } from "./process.js";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { createBnpmPaths } from "../config/paths.js";
import type { GlobalOptions } from "../core/cli-parser.js";
import { auditProject } from "../security/audit.js";
import { commandInstallPrompts, confirmCommand, readInput, readSecret } from "./prompts.js";
import { findOutdatedDependencies } from "./outdated.js";
import { findInstalledDuplicates, inspectInstalledGraph } from "./graph.js";
import { discoverProject } from "../project/discovery.js";
import { ensureGlobalProject, exposeGlobalBins } from "../project/global.js";
import { PackError, packPackage } from "../package/pack.js";
import { publishPackage } from "../package/publish.js";
import { loadProvenance } from "../package/provenance.js";
import { createRegistryToken, registryLegacyLogin, registryLogin, registryLogout, registryTokens, registryWhoami, revokeRegistryTokens } from "../registry/account.js";
import { spawn } from "node:child_process";
import { accessiblePackages, createPackageTrust, deprecatePackage, listDistTags, mutateDistTag, mutateOrganizationMember, mutatePackageOwner, mutatePackageStar, mutateRegistryProfile, mutateRegistryTeam, mutateStagedPackage, mutateTeamAccess, organizationMembers, packageAccess, packageOwners, packageTrust, pingRegistry, registryProfile, registryTeamEntries, revokePackageTrust, searchPackages, setPackageAccess, setRegistryProfile, stagedPackage, stagedPackages, starredPackages, unpublishPackage, viewPackage } from "../registry/operations.js";
import { getConfig, listConfig, mutateConfig } from "../config/commands.js";
import { changePackageVersion, initializePackage, initializeWorkspace, nextPackageVersion, readPackageVersion } from "../package/authoring.js";
import { rebuildPackages } from "./rebuild.js";
import { listFunding } from "./fund.js";
import { cleanCache, cleanCacheEntries, listCache, verifyCache } from "../cache/commands.js";
import { parseManifest } from "../project/manifest.js";
import { discoverWorkspacePackages } from "../project/workspaces.js";
import { diagnose } from "./doctor.js";
import { packageProperties } from "../project/pkg.js";
import { createSbom } from "./sbom.js";
import { linkPackages, registerLink, unregisterLink } from "../project/link.js";
import { queryInstalledPackages, QueryError } from "./query.js";
import { packageNavigationUrl } from "./navigation.js";
import { inspectScriptApprovals, mutateScriptApprovals, pruneScriptApprovals } from "./script-approvals.js";
import { diffPackage } from "./diff.js";
import { downloadStage } from "./stage.js";
import { shrinkwrapProject } from "./shrinkwrap.js";
import { editInstalledPackage } from "./edit.js";
import { trustConfiguration } from "./trust.js";
import { tokenCreationBody } from "./token.js";
import { checkDevEngines, DevEnginesError } from "../project/dev-engines.js";
import type { ExecutionCapability } from "../security/analyzer.js";
import npa from "npm-package-arg";

export const commandNames = ["install", "install-test", "install-ci-test", "add", "remove", "update", "outdated", "list", "why", "query", "diff", "find-dupes", "bin", "prefix", "root", "run", "restart", "audit", "exec", "explore", "edit", "pack", "publish", "stage", "unpublish", "access", "owner", "token", "star", "unstar", "stars", "org", "team", "profile", "trust", "login", "logout", "whoami", "view", "search", "repo", "docs", "bugs", "dist-tag", "deprecate", "config", "init", "version", "shrinkwrap", "prune", "dedupe", "rebuild", "install-scripts", "approve-scripts", "deny-scripts", "fund", "cache", "ping", "doctor", "completion", "pkg", "sbom", "link", "unlink"] as const;
export type CommandName = (typeof commandNames)[number];

export interface CommandContext {
  args: readonly string[];
  cwd: string;
  output: Output;
  invokedAsBnpmx: boolean;
  options?: CommandOptions;
  signal: AbortSignal;
}

function selectedRegistry(options: GlobalOptions | undefined): { readonly registry?: URL } {
  return options?.registry === undefined ? {} : { registry: new URL(options.registry) };
}

function installProgressReporter(context: CommandContext): (progress: InstallProgress) => void {
  let lastPhase: InstallProgress["phase"] | undefined; let lastAt = 0;
  return (progress) => {
    const now = Date.now(); const phaseChanged = progress.phase !== lastPhase; const completed = progress.completed ?? 0; const total = progress.total ?? 0;
    const reused = progress.cached ?? 0; const downloaded = progress.downloaded ?? 0;
    let message: string;
    if (!phaseChanged && (progress.phase === "fetching" || progress.phase === "inspecting") && now - lastAt < 100 && completed !== total) return;
    if (progress.phase === "downloading") {
      if (!phaseChanged && now - lastAt < 100) return;
      const bytes = progress.bytes ?? 0; const totalBytes = progress.totalBytes; const amount = totalBytes === undefined ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${(bytes / 1024 / 1024).toFixed(1)}/${(totalBytes / 1024 / 1024).toFixed(1)} MiB`;
      message = `Downloading ${(progress.package ?? "package").split("(")[0]} · ${amount} · ${completed}/${total}`;
    } else if (progress.phase === "resolving") message = `Progress: resolving ${total} direct dependenc${total === 1 ? "y" : "ies"}`;
    else if (progress.phase === "resolved") message = `Progress: resolved ${total}`;
    else if (progress.phase === "fetching") message = `Progress: resolved ${total}, reused ${reused}, downloaded ${downloaded}, fetched ${completed}/${total}`;
    else if (progress.phase === "inspecting") message = `Progress: resolved ${total}, reused ${reused}, downloaded ${downloaded}, inspected ${completed}/${total}`;
    else if (progress.phase === "linking") message = `Progress: resolved ${total}, reused ${reused}, downloaded ${downloaded}, linking`;
    else {
      context.output.finishProgress?.();
      context.output.info(`Progress: resolved ${total}, reused ${reused}, downloaded ${downloaded}, done`, progress);
      lastPhase = progress.phase; lastAt = now; return;
    }
    context.output.progress?.(message, progress);
    lastPhase = progress.phase; lastAt = now;
  };
}

async function commandLocation(context: CommandContext): Promise<{ readonly cwd: string; readonly globalPaths?: ReturnType<typeof createBnpmPaths> }> {
  if (!context.options?.globalInstall) return { cwd: context.cwd };
  const paths = createBnpmPaths({ cwd: context.cwd });
  await ensureGlobalProject(paths);
  return { cwd: paths.globalRoot, globalPaths: paths };
}

async function selectedWorkspaceRoots(cwd: string, options: CommandOptions): Promise<readonly string[]> {
  if (!options.workspaces && options.workspaceNames === undefined) return [cwd];
  const discovered = await discoverProject(cwd); const root = discovered?.projectRoot ?? cwd; const manifestPath = join(root, "package.json");
  const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath); const members = await discoverWorkspacePackages(root, manifest.workspaces);
  const requested = new Set(options.workspaceNames ?? []);
  const selected = [...members].filter(([name, path]) => requested.size === 0 || requested.has(name) || requested.has(relative(root, path).split(sep).join("/")) || [...requested].some((value) => path.startsWith(`${resolve(root, value)}${sep}`)));
  if (selected.length === 0 && !options.includeWorkspaceRoot) throw new ProcessCommandError(requested.size === 0 ? "No workspaces were found" : `No workspace matched: ${[...requested].join(", ")}`);
  return [...(options.includeWorkspaceRoot ? [root] : []), ...selected.map(([, path]) => path)].filter((path, index, values) => values.indexOf(path) === index).sort();
}

async function currentPackageName(cwd: string): Promise<string> {
  const discovered = await discoverProject(cwd);
  if (!discovered) throw new PackError("no package.json was found for the current project");
  const path = join(discovered.importerRoot, "package.json");
  const name = parseManifest(await readFile(path, "utf8"), path).name;
  if (!name) throw new PackError("package.json has no package name");
  return name;
}

async function openExternal(url: URL): Promise<void> {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url.href]] as const
    : process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url.href]] as const
      : ["xdg-open", [url.href]] as const;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolvePromise(); });
  });
}

async function runAuthoringGit(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; const limit = 1024 * 1024;
  const consume = (target: Buffer[], chunk: Buffer): void => { bytes += chunk.length; if (bytes <= limit) target.push(chunk); else child.kill("SIGTERM"); };
  child.stdout.on("data", (chunk: Buffer) => consume(stdout, chunk)); child.stderr.on("data", (chunk: Buffer) => consume(stderr, chunk));
  const abort = (): void => { child.kill("SIGTERM"); }; signal.addEventListener("abort", abort, { once: true });
  try {
    const code = await new Promise<number>((resolvePromise, reject) => { child.once("error", reject); child.once("close", (value) => resolvePromise(value ?? 1)); }).catch((error: unknown) => {
      throw new PackError(`cannot run Git: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (signal.aborted) throw signal.reason; if (bytes > limit) throw new PackError("Git output exceeded 1 MiB");
    if (code !== 0) throw new PackError(`git ${args[0] ?? "command"} failed${stderr.length ? `: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 1000)}` : ""}`);
    return Buffer.concat(stdout).toString("utf8").trim();
  } finally { signal.removeEventListener("abort", abort); }
}

async function gitRoot(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  try { return await runAuthoringGit(cwd, ["rev-parse", "--show-toplevel"], signal); } catch (error) { if (error instanceof PackError) return undefined; throw error; }
}

async function writeVersionFile(path: string, bytes: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.restore`;
  try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 }); await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

interface VersionLockfileUpdate { readonly path: string; readonly original: string; readonly updated: string }

async function prepareVersionLockfileUpdates(directory: string, version: string | undefined, workspaceVersions: ReadonlyMap<string, string> = new Map()): Promise<readonly VersionLockfileUpdate[]> {
  const updates: VersionLockfileUpdate[] = [];
  for (const name of ["package-lock.json", "npm-shrinkwrap.json"] as const) {
    const path = join(directory, name); let original: string;
    try { original = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    let document: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(original); if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object"); document = parsed as Record<string, unknown>; }
    catch (error) { throw new PackError(`cannot update ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    if (version !== undefined) document.version = version;
    if (typeof document.packages === "object" && document.packages !== null && !Array.isArray(document.packages)) {
      const packages = document.packages as Record<string, unknown>; const root = packages[""];
      if (version !== undefined && typeof root === "object" && root !== null && !Array.isArray(root)) (root as Record<string, unknown>).version = version;
      for (const [workspace, workspaceVersion] of workspaceVersions) {
        const entry = packages[workspace];
        if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) (entry as Record<string, unknown>).version = workspaceVersion;
        else packages[workspace] = { version: workspaceVersion };
      }
    }
    updates.push({ path, original, updated: `${JSON.stringify(document, null, 2)}\n` });
  }
  return updates;
}

async function execEphemeral(context: CommandContext, specifications: readonly string[], binary: string, args: readonly string[]): Promise<number> {
  const paths = createBnpmPaths({ cwd: context.cwd }); await mkdir(paths.ephemeralRoot, { recursive: true, mode: 0o700 });
  const project = await mkdtemp(join(paths.ephemeralRoot, "exec-"));
  const options: CommandOptions = { ...(context.options as CommandOptions), frozenLockfile: false, offline: false, omitDev: true, noSave: true };
  try {
    const normalized = specifications.map((specification) => specification.startsWith("file:./") || specification.startsWith("file:../") ? `file:${relative(project, resolve(context.cwd, specification.slice("file:".length))).split(sep).join("/")}` : specification);
    const result = await installProject({ cwd: project, ...selectedRegistry(options), specifications: normalized, commandOptions: options, signal: context.signal, prompts: commandInstallPrompts(options), onChildOutput: (stream, text, attribution) => context.output.childOutput(stream, text, attribution), onSecurityEvidence: (message, evidence) => context.output.info(message, evidence) });
    if (result.skippedLifecyclePackages.length > 0) throw new ProcessCommandError(`Ephemeral execution blocked because lifecycle scripts were skipped for ${result.skippedLifecyclePackages.join(", ")}`);
    return await execInstalled(project, binary, args, context.signal, context.output, context.output.passthroughChildOutput === true);
  } finally { await rm(project, { recursive: true, force: true }); }
}

type GroupedCapability = { readonly behavior: string; readonly severity: ExecutionCapability["severity"]; readonly packages: Set<string>; readonly evidence: Set<string> };

const capabilityOrder: readonly ExecutionCapability["kind"][] = ["ai-history-read", "credential-read", "native-code", "process-spawn", "network-access", "local-write"];

function evidenceValue(evidence: string): string {
  const separator = evidence.indexOf(": ");
  return separator < 0 ? evidence : evidence.slice(separator + 2);
}

function namedMatches(evidence: readonly string[], names: readonly { readonly label: string; readonly expression: RegExp }[]): string[] {
  return names.filter(({ expression }) => evidence.some((value) => expression.test(value))).map(({ label }) => label);
}

function compactList(values: readonly string[], limit = 6): string {
  const unique = [...new Set(values)];
  return unique.length <= limit ? unique.join(", ") : `${unique.slice(0, limit).join(", ")} +${unique.length - limit} more`;
}

function capabilitySummary(kind: ExecutionCapability["kind"], evidence: readonly string[]): { readonly title: string; readonly summary: string; readonly sensitive: boolean } {
  if (kind === "ai-history-read") {
    const products = namedMatches(evidence, [
      { label: "Codex", expression: /CODEX_HOME|Codex|\.codex/i }, { label: "Claude Code", expression: /Claude/i }, { label: "Cursor", expression: /Cursor/i },
      { label: "Gemini CLI", expression: /Gemini/i }, { label: "OpenCode", expression: /OpenCode|opencode/i }, { label: "Kimi", expression: /Kimi|\.kimi/i },
      { label: "Qwen", expression: /Qwen|\.qwen/i }, { label: "Cline", expression: /Cline/i }, { label: "Amp", expression: /amp\/threads/i },
      { label: "Zed", expression: /Zed\/threads/i }, { label: "Grok", expression: /GROK_HOME/i }, { label: "Hermes", expression: /HERMES_HOME/i },
      { label: "KiloCode", expression: /KiloCode/i }, { label: "JCode", expression: /JCODE_HOME/i }, { label: "Antigravity", expression: /antigravity/i },
    ]);
    return { title: "AI chat history", summary: compactList(products), sensitive: true };
  }
  if (kind === "credential-read") {
    const types = namedMatches(evidence, [
      { label: "API tokens", expression: /API_TOKEN|api[_-]?token/i }, { label: "macOS Keychain", expression: /Keychain/i },
      { label: "OAuth tokens", expression: /oauth/i }, { label: "refresh tokens", expression: /refresh/i }, { label: "session tokens", expression: /session/i },
      { label: "credential files", expression: /credentials|secrets|auth\.json|hosts\.yml/i },
    ]);
    return { title: "Credentials and tokens", summary: compactList(types), sensitive: true };
  }
  if (kind === "network-access") {
    const hosts = evidence.map(evidenceValue).map((value) => { try { return new URL(value).hostname; } catch { return value; } }).filter((value) => value !== "127.0.0.1");
    return { title: "Internet access", summary: compactList(hosts), sensitive: false };
  }
  if (kind === "local-write") return { title: "Writes local files", summary: compactList(evidence.map(evidenceValue), 5), sensitive: false };
  if (kind === "process-spawn") return { title: "Starts other programs", summary: "uses subprocess APIs", sensitive: false };
  return { title: "Native executable code", summary: compactList(evidence.map(evidenceValue), 4), sensitive: false };
}

function capabilityDisclosure(identity: string, binary: string, grouped: ReadonlyMap<ExecutionCapability["kind"], GroupedCapability>, details: boolean): string {
  const highRisk = grouped.has("ai-history-read") || grouped.has("credential-read");
  const lines = [
    `Security review for ${identity} (${binary})`,
    `${highRisk ? "HIGH REVIEW" : "REVIEW"} — ${highRisk ? "This tool may access sensitive data on your Mac." : "This tool requests access worth reviewing."}`,
  ];
  const sections = [
    { title: "SENSITIVE DATA", kinds: capabilityOrder.filter((kind) => capabilitySummary(kind, []).sensitive) },
    { title: "SYSTEM ACTIVITY", kinds: capabilityOrder.filter((kind) => !capabilitySummary(kind, []).sensitive) },
  ];
  for (const section of sections) {
    const entries = section.kinds.flatMap((kind) => { const entry = grouped.get(kind); return entry ? [[kind, entry] as const] : []; });
    if (entries.length === 0) continue;
    lines.push("", section.title);
    for (const [kind, entry] of entries) {
      const presentation = capabilitySummary(kind, [...entry.evidence]);
      lines.push(`  ${entry.severity === "warning" ? "!" : "•"} ${presentation.title}`);
      if (presentation.summary) lines.push(`    ${presentation.summary}`);
      if (details) {
        lines.push(`    Packages: ${[...entry.packages].sort().join(", ")}`);
        lines.push(`    Evidence: ${[...entry.evidence].sort().slice(0, 16).join("; ")}`);
        lines.push(`    Capability: ${kind}`);
      }
    }
  }
  lines.push("", "Nothing has run yet. These are clues found in the package, not proof that every action will occur.");
  if (!details) lines.push("For raw package and file evidence, rerun with --details.");
  return lines.join("\n");
}

export function initializerPackage(initializer: string): { readonly specifier: string; readonly binary: string } {
  const scopeOnly = /^(@[a-z0-9][a-z0-9._-]*)(?:@(.+))?$/i.exec(initializer);
  if (scopeOnly) {
    const version = scopeOnly[2]; return { specifier: `${scopeOnly[1]}/create${version ? `@${version}` : ""}`, binary: "create" };
  }
  let parsed: npa.Result; try { parsed = npa(initializer); } catch { throw new ProcessCommandError(`Invalid initializer package: ${initializer}`); }
  if (!parsed.name || !["version", "range", "tag"].includes(parsed.type)) throw new ProcessCommandError(`Initializer must be a registry package: ${initializer}`);
  const slash = parsed.name.lastIndexOf("/"); const shortName = slash < 0 ? parsed.name : parsed.name.slice(slash + 1); const target = slash < 0 ? `create-${parsed.name}` : `${parsed.name.slice(0, slash)}/create-${shortName}`;
  const suffix = parsed.rawSpec === "*" ? "" : `@${parsed.rawSpec}`; return { specifier: `${target}${suffix}`, binary: `create-${shortName}` };
}

export async function runCommand(name: CommandName, context: CommandContext): Promise<ExitCodeValue> {
  if (["install", "install-test", "install-ci-test", "add", "remove", "update", "run", "restart"].includes(name) && !context.options?.globalInstall) {
    try { for (const warning of await checkDevEngines(context.cwd)) context.output.info(`devEngines warning: ${warning}`); }
    catch (error) { if (error instanceof DevEnginesError) { context.output.error(error.message); return ExitCode.policyBlocked; } throw error; }
  }
  if (name === "edit") {
    try {
      const result = await editInstalledPackage({ cwd: context.cwd, name: context.args[0] ?? "", signal: context.signal });
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Edited ${result.package}`, evidence: result });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "ProcessCommandError" || error.name === "ManifestError")) return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "shrinkwrap") {
    try {
      const result = await shrinkwrapProject(context.cwd);
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Created npm-shrinkwrap.json with ${result.packages} package${result.packages === 1 ? "" : "s"}`, humanMessage: result.path, evidence: result });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "LockfileError" || error.name === "ManifestError")) return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "trust") {
    try {
      const paths = createBnpmPaths({ cwd: context.cwd }); const common = { paths, ...selectedRegistry(context.options), signal: context.signal, ...(context.options?.otp === undefined ? {} : { otp: context.options.otp }) };
      if (context.args[0] === "list") {
        const packageName = context.args[1] ?? await currentPackageName(context.cwd);
        const configurations = await packageTrust({ ...common, package: packageName });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${configurations.length} trust configuration${configurations.length === 1 ? "" : "s"}`, humanMessage: JSON.stringify(configurations, null, 2), evidence: { package: packageName, configurations } });
      } else if (context.args[0] === "revoke") {
        const packageName = context.args.length === 2 ? await currentPackageName(context.cwd) : context.args[1] ?? "";
        const id = context.args.length === 2 ? context.args[1] ?? "" : context.args[2] ?? "";
        await revokePackageTrust({ ...common, package: packageName, id, dryRun: context.options?.dryRun === true });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${context.options?.dryRun ? "Would revoke" : "Revoked"} trust configuration ${id}`, evidence: { package: packageName, id, dryRun: context.options?.dryRun === true } });
      } else {
        const provider = context.args[0] as "github" | "gitlab" | "circleci";
        const packageName = context.args[1] ?? await currentPackageName(context.cwd);
        const configuration = trustConfiguration(provider, context.options as CommandOptions);
        if (context.options?.dryRun) {
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Would create ${provider} trust for ${packageName}`, humanMessage: JSON.stringify(configuration, null, 2), evidence: { package: packageName, configuration, dryRun: true } });
        } else {
          const confirmed = await confirmCommand(`Anyone with matching ${provider} workflow access may publish ${packageName}. Create this trusted publisher?`, context.options as CommandOptions);
          if (!confirmed) {
            context.output.info("Trusted-publisher creation requires interactive confirmation or --yes");
            return ExitCode.policyBlocked;
          }
          const configurations = await createPackageTrust({ ...common, package: packageName, configuration });
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Created ${provider} trust for ${packageName}`, humanMessage: JSON.stringify(configurations, null, 2), evidence: { package: packageName, configurations } });
        }
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError")) return ExitCode.networkFailure;
      if (error instanceof Error && (error.name === "ManifestError" || error.name === "PackError" || error.name === "TrustError")) return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "stage" && context.args[0] !== "publish") {
    try {
      const paths = createBnpmPaths({ cwd: context.cwd }); const common = { paths, ...selectedRegistry(context.options), signal: context.signal, ...(context.options?.otp === undefined ? {} : { otp: context.options.otp }) };
      const action = context.args[0];
      if (action === "list") {
        const items = await stagedPackages({ ...common, ...(context.args[1] === undefined ? {} : { package: context.args[1] }) });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${items.length} staged package${items.length === 1 ? "" : "s"}`, humanMessage: JSON.stringify(items, null, 2), evidence: { items } });
      } else if (action === "view") {
        const item = await stagedPackage({ ...common, id: context.args[1] ?? "" });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Staged package ${context.args[1]}`, humanMessage: JSON.stringify(item, null, 2), evidence: item });
      } else if (action === "download") {
        const item = await downloadStage({ ...common, cwd: context.cwd, id: context.args[1] ?? "" });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Downloaded ${item.package}@${item.version}`, humanMessage: item.filename, evidence: item });
      } else {
        await mutateStagedPackage({ ...common, id: context.args[1] ?? "", action: action === "approve" ? "approve" : "reject" });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${action === "approve" ? "Approved" : "Rejected"} staged package ${context.args[1]}`, evidence: { action, id: context.args[1] } });
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError")) return ExitCode.networkFailure;
      if (error instanceof Error && error.name === "ArchiveError") return ExitCode.integrityFailure;
      if (error instanceof Error && error.name === "PackError") return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "profile") {
    try {
      const paths = createBnpmPaths({ cwd: context.cwd }); const common = { paths, ...selectedRegistry(context.options), signal: context.signal, ...(context.options?.otp === undefined ? {} : { otp: context.options.otp }) };
      const action = context.args[0];
      if (action === "get") {
        const profile = await registryProfile(common); const key = context.args[1]; const output = key === undefined ? profile : { [key]: profile[key] };
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: "Registry profile", humanMessage: JSON.stringify(output, null, 2), evidence: output });
      } else if (action === "set" && context.args[1] !== "password") {
        const key = context.args[1] ?? ""; const profile = await setRegistryProfile({ ...common, key, value: context.args[2] ?? "" }); const output = { [key]: profile[key] };
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: "Registry profile", humanMessage: JSON.stringify(output, null, 2), evidence: output });
      } else if (action === "set") {
        const current = await readSecret("Current registry password: ", context.signal); const next = await readSecret("New registry password: ", context.signal); const confirmation = await readSecret("Confirm new registry password: ", context.signal);
        if (!current || !next || next !== confirmation) { context.output.info("Password change cancelled or new passwords did not match"); return ExitCode.policyBlocked; }
        await mutateRegistryProfile({ ...common, change: { password: { old: current, new: next } }, preserveWritable: true });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: "Changed registry password" });
      } else if (["enable-2fa", "enable-tfa", "enable2fa", "enabletfa"].includes(action ?? "")) {
        const mode = context.args[1] ?? "auth-and-writes"; const password = await readSecret("Registry password: ", context.signal);
        if (!password) { context.output.info("Enabling 2FA requires a masked password prompt"); return ExitCode.policyBlocked; }
        const challenge = await mutateRegistryProfile({ ...common, change: { tfa: { password, mode } } });
        if (typeof challenge.tfa === "object" && challenge.tfa !== null) {
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Two-factor authentication set to ${mode}` });
        } else {
          let setup: URL; try { setup = new URL(typeof challenge.tfa === "string" ? challenge.tfa : ""); } catch { throw new PackError("registry returned an invalid two-factor setup challenge"); }
          if (setup.protocol !== "otpauth:" || setup.searchParams.get("secret") === null) throw new PackError("registry returned an invalid two-factor setup challenge");
          const otp = await readSecret(`Authenticator setup URI: ${setup.href}\nOne-time code: `, context.signal);
          if (!otp || !/^\d{6,10}$/.test(otp)) { context.output.info("Two-factor setup requires a valid one-time code"); return ExitCode.policyBlocked; }
          const finalized = await mutateRegistryProfile({ ...common, change: { tfa: [otp] } });
          if (!Array.isArray(finalized.tfa) || finalized.tfa.some((code) => typeof code !== "string")) throw new PackError("registry returned invalid two-factor recovery codes");
          const recoveryCodes = finalized.tfa as string[];
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: "Enabled two-factor authentication; store the recovery codes securely", humanMessage: recoveryCodes.join("\n"), evidence: { recoveryCodes } });
        }
      } else {
        const password = await readSecret("Registry password: ", context.signal);
        if (!password) { context.output.info("Disabling 2FA requires a masked password prompt"); return ExitCode.policyBlocked; }
        await mutateRegistryProfile({ ...common, change: { tfa: { password, mode: "disable" } } });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: "Disabled two-factor authentication" });
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError")) return ExitCode.networkFailure;
      if (error instanceof Error && error.name === "PackError") return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "org" || name === "team") {
    try {
      const paths = createBnpmPaths({ cwd: context.cwd }); const common = { paths, ...selectedRegistry(context.options), signal: context.signal, ...(context.options?.otp === undefined ? {} : { otp: context.options.otp }) };
      if (name === "org") {
        const [action, organization, user, role] = context.args;
        if (action === "ls" || action === "list") {
          const members = await organizationMembers({ ...common, organization: organization ?? "" });
          const selected = user === undefined ? members : members[user] === undefined ? {} : { [user]: members[user] };
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${Object.keys(selected).length} organization member${Object.keys(selected).length === 1 ? "" : "s"}`, humanMessage: Object.entries(selected).map(([name, value]) => `${name} - ${value}`).join("\n"), evidence: { organization, members: selected } });
        } else {
          await mutateOrganizationMember({ ...common, organization: organization ?? "", user: user ?? "", ...(action === "set" || action === "add" ? { role: (role ?? "developer") as "developer" | "admin" | "owner" } : {}) });
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${action === "rm" || action === "remove" ? "Removed" : "Updated"} organization member`, evidence: { action, organization, user, role: role ?? "developer" } });
        }
      } else {
        const [action, entity, user] = context.args;
        if (action === "ls" || action === "list") {
          const entries = await registryTeamEntries({ ...common, entity: entity ?? "" });
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${entries.length} team entr${entries.length === 1 ? "y" : "ies"}`, humanMessage: entries.join("\n"), evidence: { entity, entries } });
        } else {
          const mutation = action === "rm" || action === "remove" ? "remove" : action as "create" | "destroy" | "add";
          await mutateRegistryTeam({ ...common, action: mutation, entity: entity ?? "", ...(user === undefined ? {} : { user }) });
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${mutation} team operation completed`, evidence: { action: mutation, entity, user } });
        }
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError")) return ExitCode.networkFailure;
      throw error;
    }
  }
  if (name === "star" || name === "unstar" || name === "stars") {
    try {
      const paths = createBnpmPaths({ cwd: context.cwd }); const registry = selectedRegistry(context.options).registry;
      const common = { paths, ...(registry === undefined ? {} : { registry }), signal: context.signal };
      const user = context.args[0] && name === "stars" ? context.args[0] : await registryWhoami(common);
      if (name === "stars") {
        const packages = await starredPackages({ ...common, user });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${packages.length} favorite package${packages.length === 1 ? "" : "s"}`, humanMessage: packages.join("\n") || "No favorite packages", evidence: { user, packages } });
      } else {
        for (const packageName of context.args) await mutatePackageStar({ ...common, package: packageName, user, starred: name === "star", ...(context.options?.otp === undefined ? {} : { otp: context.options.otp }) });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${name === "star" ? "Starred" : "Unstarred"} ${context.args.length} package${context.args.length === 1 ? "" : "s"}`, evidence: { user, packages: context.args, starred: name === "star" } });
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError")) return ExitCode.networkFailure;
      throw error;
    }
  }
  if (name === "completion") {
    const commands = [...commandNames].sort().join(" ");
    const script = `# bash/zsh completion for bnpm\n_bnpm_complete() { COMPREPLY=( $(compgen -W '${commands}' -- \"${'$'}{COMP_WORDS[COMP_CWORD]}\") ); }\ncomplete -F _bnpm_complete bnpm bnpmx`;
    context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: "Shell completion", humanMessage: script, evidence: { script } });
    return ExitCode.success;
  }
  if (name === "find-dupes") {
    try {
      const duplicates = await findInstalledDuplicates(context.cwd);
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${duplicates.length} duplicated package name${duplicates.length === 1 ? "" : "s"}`, humanMessage: duplicates.map((entry) => `${entry.name}: ${entry.versions.join(", ")}`).join("\n") || "No duplicate packages", evidence: { duplicates } });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && error.name === "LockfileError") return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "token") {
    try {
      const paths = createBnpmPaths({ cwd: context.cwd }); const registry = selectedRegistry(context.options).registry;
      if (context.args[0] === "create") {
        const password = await readSecret("Registry password: ", context.signal);
        if (!password) {
          context.output.info("Token creation requires a masked interactive password prompt");
          return ExitCode.policyBlocked;
        }
        const body = tokenCreationBody(context.options as CommandOptions);
        const token = await createRegistryToken({ paths, password, body, ...(registry === undefined ? {} : { registry }), signal: context.signal, ...(context.options?.otp === undefined ? {} : { otp: context.options.otp }) });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: "Created authentication token", humanMessage: token.token, evidence: token });
      } else if (context.args[0] === "list" || context.args[0] === "ls") {
        const tokens = await registryTokens({ paths, ...(registry === undefined ? {} : { registry }), signal: context.signal });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${tokens.length} authentication token${tokens.length === 1 ? "" : "s"}`, humanMessage: tokens.map((token) => `${token.id}${token.name ? ` ${token.name}` : ""}${token.readonly ? " read-only" : ""}`).join("\n") || "No authentication tokens", evidence: { tokens } });
      } else {
        const ids = await revokeRegistryTokens({ paths, ...(registry === undefined ? {} : { registry }), ids: context.args.slice(1), signal: context.signal, ...(context.options?.otp === undefined ? {} : { otp: context.options.otp }) });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Revoked ${ids.length} authentication token${ids.length === 1 ? "" : "s"}`, evidence: { ids } });
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError")) return ExitCode.networkFailure;
      throw error;
    }
  }
  if (name === "diff") {
    try {
      const explicitSpecs = context.options?.diffSpecs;
      const legacySpec = explicitSpecs === undefined ? context.args[0] : undefined;
      const filters = explicitSpecs === undefined ? context.args.slice(legacySpec === undefined ? 0 : 1) : context.args;
      const result = await diffPackage({ cwd: context.cwd, ...(explicitSpecs === undefined ? legacySpec === undefined ? {} : { spec: legacySpec } : { specs: explicitSpecs }), ...(filters.length === 0 ? {} : { filters }), ...(context.options?.tag === undefined ? {} : { tag: context.options.tag }), render: { ...(context.options?.diffNameOnly ? { nameOnly: true } : {}), ...(context.options?.diffUnified === undefined ? {} : { unified: context.options.diffUnified }), ...(context.options?.diffIgnoreAllSpace ? { ignoreAllSpace: true } : {}), ...(context.options?.diffNoPrefix ? { noPrefix: true } : {}), ...(context.options?.diffSrcPrefix === undefined ? {} : { srcPrefix: context.options.diffSrcPrefix }), ...(context.options?.diffDstPrefix === undefined ? {} : { dstPrefix: context.options.diffDstPrefix }), ...(context.options?.diffText ? { text: true } : {}) }, ...selectedRegistry(context.options), signal: context.signal });
      const human = result.text || "No package differences";
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${result.added.length + result.removed.length + result.changed.length} package file difference${result.added.length + result.removed.length + result.changed.length === 1 ? "" : "s"}`, humanMessage: human, evidence: result });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError")) return ExitCode.networkFailure;
      if (error instanceof Error && (error.name === "PackError" || error.name === "ArchiveError" || error.name === "IntegrityError")) return ExitCode.integrityFailure;
      throw error;
    }
  }
  if (name === "approve-scripts" || name === "deny-scripts") {
    try {
      const action = name === "approve-scripts" ? "approve" : "deny";
      const packages = await mutateScriptApprovals({ cwd: context.cwd, names: context.args, action });
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${action === "approve" ? "Approved" : "Denied"} scripts for ${packages.length} locked package${packages.length === 1 ? "" : "s"}`, evidence: { action, packages } });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && error.name === "LockfileError") return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "install-scripts") {
    try {
      const action = context.args[0] ?? "";
      if (action === "ls") {
        const status = await inspectScriptApprovals({ cwd: context.cwd });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${status.pending.length} package${status.pending.length === 1 ? "" : "s"} await script review`, humanMessage: status.pending.join("\n") || "No install scripts await review", evidence: status });
      } else if (action === "prune") {
        const packages = await pruneScriptApprovals({ cwd: context.cwd, ...(context.options?.dryRun ? { dryRun: true } : {}) });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${context.options?.dryRun ? "Would prune" : "Pruned"} ${packages.length} stale script approval${packages.length === 1 ? "" : "s"}`, humanMessage: packages.join("\n"), evidence: { packages, dryRun: context.options?.dryRun === true } });
      } else {
        const packages = await mutateScriptApprovals({ cwd: context.cwd, names: context.args.slice(1), action: action as "approve" | "deny" });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${action === "approve" ? "Approved" : "Denied"} scripts for ${packages.length} locked package${packages.length === 1 ? "" : "s"}`, evidence: { action, packages } });
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && error.name === "LockfileError") return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "explore") {
    try {
      const discovered = await discoverProject(context.cwd);
      const root = discovered?.importerRoot ?? context.cwd;
      const code = await exploreInstalled(root, context.args[0] ?? "", context.args.slice(1), context.signal, context.output);
      return code === 0 ? ExitCode.success : ExitCode.installIncomplete;
    } catch (error) {
      if (error instanceof ProcessCommandError || (error instanceof Error && error.name === "ManifestError")) return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "repo" || name === "docs" || name === "bugs") {
    try {
      let packageName = context.args[0];
      if (!packageName) {
        const discovered = await discoverProject(context.cwd);
        const root = discovered?.importerRoot ?? context.cwd;
        const path = join(root, "package.json");
        packageName = parseManifest(await readFile(path, "utf8"), path).name;
      }
      if (!packageName) throw new PackError("package.json has no package name");
      const paths = createBnpmPaths({ cwd: context.cwd });
      const metadata = await viewPackage({ paths, ...selectedRegistry(context.options), spec: packageName, signal: context.signal });
      const url = packageNavigationUrl(metadata, name, packageName);
      await openExternal(url);
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Opened ${url.href}`, humanMessage: url.href, evidence: { package: packageName, url: url.href, kind: name } });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError")) return ExitCode.networkFailure;
      if (error instanceof Error && (error.name === "ManifestError" || error.name === "PackError")) return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "access" || name === "owner") {
    try {
      const paths = createBnpmPaths({ cwd: context.cwd });
      const common = { paths, ...selectedRegistry(context.options), signal: context.signal, ...(context.options?.otp === undefined ? {} : { otp: context.options.otp }) };
      if (name === "owner") {
        const [action, first, second] = context.args;
        const packageName = (action === "ls" || action === "list" ? first : second) ?? await currentPackageName(context.cwd);
        const owners = action === "ls" || action === "list" ? await packageOwners({ ...common, package: packageName }) : await mutatePackageOwner({ ...common, action: action === "add" ? "add" : "remove", user: first ?? "", package: packageName });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${owners.length} package owner${owners.length === 1 ? "" : "s"}`, humanMessage: owners.map((owner) => `${owner.name} <${owner.email}>`).join("\n") || "no owner found", evidence: { owners } });
      } else {
        const [action, subcommand, first, second] = context.args;
        if ((action === "list" || action === "ls") && subcommand === "packages") {
          const owner = first ?? await registryWhoami(common);
          const result = await accessiblePackages({ ...common, owner });
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${Object.keys(result).length} accessible package${Object.keys(result).length === 1 ? "" : "s"}`, humanMessage: JSON.stringify(result, null, 2), evidence: result });
        } else if (action === "get" || action === "list" || action === "ls") {
          const packageName = first ?? await currentPackageName(context.cwd);
          const result = await packageAccess({ ...common, package: packageName, action: action === "get" ? "status" : "collaborators" });
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: "Package access", humanMessage: JSON.stringify(result, null, 2), evidence: result });
        } else if (action === "set") {
          const [setting, value] = (subcommand ?? "").split("=");
          const packageName = first ?? await currentPackageName(context.cwd);
          await setPackageAccess({ ...common, package: packageName, ...(setting === "status" ? { access: value as "public" | "private" } : { mfa: value as "none" | "publish" | "automation" }) });
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Set package ${setting} to ${value}`, evidence: { package: packageName, setting, value } });
        } else {
          const packageName = (action === "grant" ? second : first) ?? await currentPackageName(context.cwd);
          const team = action === "grant" ? first ?? "" : subcommand ?? "";
          await mutateTeamAccess({ ...common, package: packageName, team, ...(action === "grant" ? { permission: subcommand as "read-only" | "read-write" } : {}) });
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${action === "grant" ? "Granted" : "Revoked"} team access`, evidence: { action, package: packageName, team } });
        }
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError")) return ExitCode.networkFailure;
      if (error instanceof Error && (error.name === "ManifestError" || error.name === "PackError")) return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "unpublish") {
    try {
      const paths = createBnpmPaths({ cwd: context.cwd });
      const result = await unpublishPackage({ paths, ...selectedRegistry(context.options), package: context.args[0] ?? "", signal: context.signal, force: context.options?.force === true, dryRun: context.options?.dryRun === true, ...(context.options?.otp === undefined ? {} : { otp: context.options.otp }) });
      const identity = `${result.name}${result.version ? `@${result.version}` : ""}`;
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${context.options?.dryRun ? "Would unpublish" : "Unpublished"} ${identity}`, humanMessage: `- ${identity}`, evidence: result });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError")) return ExitCode.networkFailure;
      throw error;
    }
  }
  if (name === "query") {
    try {
      const location = await commandLocation(context);
      const packages = await queryInstalledPackages({ cwd: location.cwd, selector: context.args[0] ?? "", ...(location.globalPaths === undefined ? {} : { paths: location.globalPaths }), ...(context.options?.workspaces ? { allWorkspaces: true } : {}), ...selectedRegistry(context.options), signal: context.signal });
      if (context.options?.expectResultCount !== undefined && packages.length !== context.options.expectResultCount) throw new QueryError(`expected ${context.options.expectResultCount} result${context.options.expectResultCount === 1 ? "" : "s"}, found ${packages.length}`);
      if (context.options?.expectResults === true && packages.length === 0) throw new QueryError("expected at least one result, found none");
      if (context.options?.expectResults === false && packages.length > 0) throw new QueryError(`expected no results, found ${packages.length}`);
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${packages.length} matching package${packages.length === 1 ? "" : "s"}`, humanMessage: JSON.stringify(packages, null, 2), evidence: { packages } });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof QueryError || (error instanceof Error && error.name === "LockfileError")) return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "restart") {
    try {
      const scripts = await projectScriptNames(context.cwd);
      const approvals = new Set(context.options?.allowDangerous ?? []);
      if (scripts.has("stop")) {
        const code = await runProjectScriptLifecycle(context.cwd, "stop", [], context.signal, context.output, approvals);
        if (code !== 0) return ExitCode.installIncomplete;
      }
      const target = scripts.has("restart") ? "restart" : scripts.has("start") ? "start" : undefined;
      if (!target) throw new ProcessCommandError("Unknown project script: restart");
      const code = await runProjectScriptLifecycle(context.cwd, target, [], context.signal, context.output, approvals);
      return code === 0 ? ExitCode.success : ExitCode.installIncomplete;
    } catch (error) {
      if (error instanceof ProcessCommandError || (error instanceof Error && error.name === "ManifestError")) return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "link" || name === "unlink") {
    try {
      const result = name === "link"
        ? context.args.length === 0 ? [await registerLink({ cwd: context.cwd })] : await linkPackages({ cwd: context.cwd, names: context.args })
        : await unregisterLink({ cwd: context.cwd, names: context.args });
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${name === "link" ? "Linked" : "Unlinked"} ${result.length} package${result.length === 1 ? "" : "s"}`, evidence: { packages: result } });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "ManifestError" || (error as NodeJS.ErrnoException).code === "ENOENT")) return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "pkg") {
    try {
      const action = context.args[0] as "get" | "set" | "delete";
      const value = await packageProperties({ directory: context.cwd, action, operands: context.args.slice(1) });
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: action === "get" ? "Package properties" : `Package properties ${action === "set" ? "updated" : "deleted"}`, humanMessage: JSON.stringify(value, null, 2), evidence: value });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && error.name === "ManifestError") return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "sbom") {
    try {
      const document = await createSbom({ cwd: context.cwd, format: context.options?.sbomFormat ?? "cyclonedx" });
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${context.options?.sbomFormat ?? "cyclonedx"} SBOM`, humanMessage: JSON.stringify(document, null, 2), evidence: document });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && error.name === "LockfileError") return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "doctor") {
    const checks = await diagnose({ cwd: context.cwd, ...selectedRegistry(context.options), signal: context.signal });
    const failed = checks.filter((check) => !check.ok);
    const human = checks.map((check) => `${check.ok ? "ok" : "not ok"} - ${check.name}: ${check.detail}`).join("\n");
    const exitCode = failed.length === 0 ? ExitCode.success : failed.some((check) => check.name === "cache") ? ExitCode.integrityFailure : ExitCode.networkFailure;
    context.output.result({ status: failed.length === 0 ? "success" : "failure", category: failed.length === 0 ? "success" : exitCode === ExitCode.integrityFailure ? "integrity" : "network", exitCode, summary: failed.length === 0 ? "All diagnostics passed" : `${failed.length} diagnostics failed`, humanMessage: human, evidence: { checks } });
    return exitCode;
  }
  if (name === "ping") {
    try {
      const paths = createBnpmPaths({ cwd: context.cwd });
      const result = await pingRegistry({ paths, ...selectedRegistry(context.options), signal: context.signal });
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `PONG ${result.registry}`, humanMessage: `PONG ${result.registry}`, evidence: result });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError" || error.name === "TypeError")) return ExitCode.networkFailure;
      throw error;
    }
  }
  if (name === "cache") {
    const paths = createBnpmPaths({ cwd: context.cwd });
    if (context.args[0] === "clean") {
      const filter = context.args[1];
      if (filter !== undefined) {
        const removed = await cleanCacheEntries(paths, filter);
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Removed ${removed.length} cache entr${removed.length === 1 ? "y" : "ies"}`, evidence: { removed } });
      } else {
        const removed = await cleanCache(paths);
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Cleaned ${removed.length} cache director${removed.length === 1 ? "y" : "ies"}`, evidence: { removed } });
      }
      return ExitCode.success;
    }
    if (["ls", "list", "info"].includes(context.args[0] ?? "")) {
      const entries = await listCache(paths, context.args[1]);
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${entries.length} cache entr${entries.length === 1 ? "y" : "ies"}`, humanMessage: entries.map((entry) => `${entry.id} ${entry.integrity}`).join("\n") || "Cache is empty", evidence: { entries } });
      return ExitCode.success;
    }
    if (context.args[0] === "add") {
      await mkdir(paths.ephemeralRoot, { recursive: true, mode: 0o700 }); const temporary = await mkdtemp(join(paths.ephemeralRoot, "cache-add-"));
      try {
        const cacheOptions: CommandOptions = { json: context.options?.json ?? false, ...(context.options?.registry === undefined ? {} : { registry: context.options.registry }), allowRecent: context.options?.allowRecent ?? [], allowDangerous: context.options?.allowDangerous ?? [], frozenLockfile: false, offline: false, omitDev: true, saveExact: false, noSave: true, ignoreScripts: true };
        const requested = context.args[1] ?? "";
        const specification = requested.startsWith("file:./") || requested.startsWith("file:../") ? `file:${relative(temporary, resolve(context.cwd, requested.slice("file:".length))).split(sep).join("/")}` : requested;
        const result = await installProject({ cwd: temporary, ...selectedRegistry(context.options), specifications: [specification], commandOptions: cacheOptions, signal: context.signal, prompts: commandInstallPrompts(cacheOptions), onSecurityEvidence: (message, evidence) => context.output.info(message, evidence) });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Cached ${result.graph.packages.size} package${result.graph.packages.size === 1 ? "" : "s"}`, evidence: { packages: [...result.graph.packages.keys()].sort() } });
        return ExitCode.success;
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    const result = await verifyCache(paths);
    context.output.result({ status: result.corrupt.length === 0 ? "success" : "failure", category: result.corrupt.length === 0 ? "success" : "integrity", exitCode: result.corrupt.length === 0 ? ExitCode.success : ExitCode.integrityFailure, summary: `${result.valid}/${result.entries} cache entries verified`, evidence: result });
    return result.corrupt.length === 0 ? ExitCode.success : ExitCode.integrityFailure;
  }
  if (name === "fund") {
    try {
      const entries = await listFunding({ cwd: context.cwd });
      const human = entries.map((entry) => `${entry.package}${entry.type ? ` (${entry.type})` : ""}: ${entry.url}`).join("\n") || "No funding information found";
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${entries.length} funding link${entries.length === 1 ? "" : "s"}`, humanMessage: human, evidence: { entries } });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && error.name === "LockfileError") return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "rebuild") {
    try {
      const result = await rebuildPackages({ cwd: context.cwd, names: context.args, allowedDangerous: new Set(context.options?.allowDangerous ?? []), ...(context.options?.ignoreScripts ? { ignoreScripts: true } : {}), signal: context.signal, onOutput: (stream, text, attribution) => context.output.childOutput(stream, text, attribution) });
      context.output.info(`Rebuilt ${result.rebuilt.length} lifecycle stage${result.rebuilt.length === 1 ? "" : "s"}`, result);
      if (result.skipped.length > 0) {
        context.output.error(`Skipped ${result.skipped.length} unapproved lifecycle stage${result.skipped.length === 1 ? "" : "s"}`);
        return ExitCode.installIncomplete;
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "PolicyError" || error.name === "LockfileError")) return ExitCode.policyBlocked;
      if (error instanceof Error && error.name === "ResolutionError") return ExitCode.resolutionFailure;
      if (error instanceof Error && error.name === "ScriptExecutionError") return ExitCode.installIncomplete;
      throw error;
    }
  }
  if (name === "init") {
    try {
      if (context.options?.workspaceNames !== undefined) {
        if (context.options.workspaceNames.length !== 1) throw new PackError("init requires exactly one --workspace path");
        const prepared = await initializeWorkspace({ root: context.cwd, workspace: context.options.workspaceNames[0] ?? "", createManifest: context.args.length === 0 });
        if (context.args.length > 0) {
          const initializer = initializerPackage(context.args[0] ?? ""); const code = await execEphemeral({ ...context, cwd: prepared.directory }, [initializer.specifier], initializer.binary, context.args.slice(1));
          return code === 0 ? ExitCode.success : ExitCode.installIncomplete;
        }
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Created workspace ${prepared.workspace}`, humanMessage: join(prepared.directory, "package.json"), evidence: prepared });
        return ExitCode.success;
      }
      if (context.args.length > 0) {
        const initializer = initializerPackage(context.args[0] ?? ""); const code = await execEphemeral(context, [initializer.specifier], initializer.binary, context.args.slice(1));
        return code === 0 ? ExitCode.success : ExitCode.installIncomplete;
      }
      if (!context.options?.yes) context.output.info("Using safe defaults; pass --yes to suppress this notice.");
      const manifest = await initializePackage({ directory: context.cwd });
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Created ${join(context.cwd, "package.json")}`, evidence: manifest });
      return ExitCode.success;
    } catch (error) {
      if ((error instanceof Error && error.name === "PackError") || error instanceof ProcessCommandError) return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "version") {
    try {
      if (context.options?.workspaces || context.options?.workspaceNames !== undefined) {
        const roots = await selectedWorkspaceRoots(context.cwd, context.options); const versions = await Promise.all(roots.map(async (root) => ({ root, ...(await readPackageVersion(root)), original: await readFile(join(root, "package.json"), "utf8") })));
        if (context.args.length === 0) {
          const evidence = Object.fromEntries(versions.map((entry) => [entry.name, entry.version])); context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${versions.length} package version${versions.length === 1 ? "" : "s"}`, humanMessage: versions.map((entry) => `${entry.name}\nv${entry.version}`).join("\n"), evidence }); return ExitCode.success;
        }
        let requested = context.args[0] ?? "";
        if (requested === "from-git") { const repository = await gitRoot(context.cwd, context.signal); if (!repository) throw new PackError("from-git requires a Git repository with a version tag"); const tag = await runAuthoringGit(repository, ["describe", "--tags", "--abbrev=0"], context.signal); requested = tag.startsWith("v") ? tag.slice(1) : tag; }
        const planned = versions.map((entry) => ({ ...entry, next: nextPackageVersion(entry.version, requested, { ...(context.options?.preid === undefined ? {} : { preid: context.options.preid }), ...(context.options?.allowSameVersion ? { allowSame: true } : {}) }) }));
        const discovered = await discoverProject(context.cwd); const projectRoot = discovered?.projectRoot ?? context.cwd; const rootEntry = planned.find((entry) => resolve(entry.root) === resolve(projectRoot)); const workspaceVersions = new Map(planned.filter((entry) => entry !== rootEntry).map((entry) => [relative(projectRoot, entry.root).split(sep).join("/"), entry.next]));
        const lockfileUpdates = context.options.noSave ? [] : await prepareVersionLockfileUpdates(projectRoot, rootEntry?.next, workspaceVersions); const approvals = new Set(context.options.allowDangerous ?? []);
        try {
          for (const entry of planned) {
            const environment = { npm_old_version: entry.version, npm_new_version: entry.next }; if (!context.options.ignoreScripts) await runProjectScriptIfPresent(entry.root, "preversion", context.signal, context.output, approvals, environment);
            await changePackageVersion(entry.root, entry.next, { allowSame: true }); if (!context.options.ignoreScripts) await runProjectScriptIfPresent(entry.root, "version", context.signal, context.output, approvals, environment);
          }
          for (const update of lockfileUpdates) await writeVersionFile(update.path, update.updated);
        } catch (error) {
          for (const entry of planned) await writeVersionFile(join(entry.root, "package.json"), entry.original); for (const update of lockfileUpdates) await writeVersionFile(update.path, update.original); throw error;
        }
        if (!context.options.ignoreScripts) for (const entry of planned) await runProjectScriptIfPresent(entry.root, "postversion", context.signal, context.output, approvals, { npm_old_version: entry.version, npm_new_version: entry.next });
        const evidence = Object.fromEntries(planned.map((entry) => [entry.name, { previous: entry.version, version: entry.next }])); context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Versioned ${planned.length} package${planned.length === 1 ? "" : "s"}`, humanMessage: planned.map((entry) => `${entry.name}\nv${entry.next}`).join("\n"), evidence }); return ExitCode.success;
      }
      if (context.args.length === 0) {
        const current = await readPackageVersion(context.cwd);
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: current.version, humanMessage: current.version, evidence: { name: current.name, version: current.version, node: process.version } });
        return ExitCode.success;
      }
      const approvals = new Set(context.options?.allowDangerous ?? []); const current = await readPackageVersion(context.cwd); const detectedRepository = await gitRoot(context.cwd, context.signal); const repository = context.options?.gitTagVersion === false ? undefined : detectedRepository;
      if (repository && !context.options?.force && await runAuthoringGit(repository, ["status", "--porcelain"], context.signal)) throw new PackError("Git working directory is not clean; use --force only after reviewing the changes");
      let requested = context.args[0] ?? "";
      if (requested === "from-git") {
        if (!detectedRepository) throw new PackError("from-git requires a Git repository with a version tag"); const tag = await runAuthoringGit(detectedRepository, ["describe", "--tags", "--abbrev=0"], context.signal); requested = tag.startsWith("v") ? tag.slice(1) : tag;
      }
      const next = nextPackageVersion(current.version, requested, { ...(context.options?.preid === undefined ? {} : { preid: context.options.preid }), ...(context.options?.allowSameVersion ? { allowSame: true } : {}) });
      const versionEnvironment = { npm_old_version: current.version, npm_new_version: next }; const manifestPath = join(context.cwd, "package.json"); const original = await readFile(manifestPath, "utf8"); const lockfileUpdates = context.options?.noSave ? [] : await prepareVersionLockfileUpdates(context.cwd, next); let previousHead: string | undefined; let committed = false; let changed: { readonly name: string; readonly previous: string; readonly version: string };
      try {
        if (!context.options?.ignoreScripts) await runProjectScriptIfPresent(context.cwd, "preversion", context.signal, context.output, approvals, versionEnvironment);
        changed = await changePackageVersion(context.cwd, next, { allowSame: true });
        for (const update of lockfileUpdates) await writeVersionFile(update.path, update.updated);
        if (!context.options?.ignoreScripts) await runProjectScriptIfPresent(context.cwd, "version", context.signal, context.output, approvals, versionEnvironment);
        if (repository) {
          previousHead = await runAuthoringGit(repository, ["rev-parse", "HEAD"], context.signal); const changedPaths = [manifestPath, ...lockfileUpdates.map((update) => update.path)]; const packagePaths = await Promise.all(changedPaths.map(async (path) => relative(repository, await realpath(path)))); if (packagePaths.some((path) => !path || path.startsWith(`..${sep}`) || path === "..")) throw new PackError("version metadata is outside the Git repository");
          const tag = `v${next}`; try { await runAuthoringGit(repository, ["rev-parse", "--verify", `refs/tags/${tag}`], context.signal); throw new PackError(`Git tag ${tag} already exists`); } catch (error) { if (!(error instanceof PackError) || error.message === `Git tag ${tag} already exists`) throw error; }
          await runAuthoringGit(repository, ["add", "--", ...packagePaths], context.signal);
          const message = (context.options?.versionMessage ?? "v%s").replaceAll("%s", next); const commitArgs = ["commit", ...(context.options?.commitHooks === false ? ["--no-verify"] : []), "-m", message]; await runAuthoringGit(repository, commitArgs, context.signal); committed = true;
          await runAuthoringGit(repository, context.options?.signGitTag ? ["tag", "-s", "-m", tag, tag] : ["tag", tag], context.signal);
        }
      } catch (error) {
        if (committed && previousHead && repository) await runAuthoringGit(repository, ["reset", "--mixed", previousHead], context.signal).catch(() => undefined);
        await writeVersionFile(manifestPath, original); for (const update of lockfileUpdates) await writeVersionFile(update.path, update.original); throw error;
      }
      if (!context.options?.ignoreScripts) await runProjectScriptIfPresent(context.cwd, "postversion", context.signal, context.output, approvals, versionEnvironment);
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: changed.version, humanMessage: `v${changed.version}`, evidence: changed });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && error.name === "PackError") return ExitCode.resolutionFailure;
      if (error instanceof ProcessCommandError) return ExitCode.installIncomplete;
      throw error;
    }
  }
  if (name === "config") {
    try {
      const paths = createBnpmPaths({ cwd: context.cwd });
      const action = context.args[0];
      if (action === "list") {
        const values = await listConfig(paths);
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: "Configuration", humanMessage: Object.entries(values).map(([entry, value]) => `${entry}=${value}`).join("\n"), evidence: values });
      } else if (action === "get") {
        const value = await getConfig(paths, context.args[1] ?? "");
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: String(value), humanMessage: String(value), evidence: { key: context.args[1], value } });
      } else {
        await mutateConfig(paths, action === "set" ? "set" : "delete", context.args[1] ?? "", context.args[2]);
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${action === "set" ? "Set" : "Deleted"} ${context.args[1]}`, evidence: { action, key: context.args[1] } });
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && error.name === "ConfigError") return ExitCode.policyBlocked;
      throw error;
    }
  }
  if (name === "view" || name === "search" || name === "dist-tag" || name === "deprecate") {
    try {
      const paths = createBnpmPaths({ cwd: context.cwd });
      const registry = selectedRegistry(context.options).registry;
      const common = { paths, ...(registry === undefined ? {} : { registry }), signal: context.signal };
      if (name === "view") {
        const result = await viewPackage({ ...common, spec: context.args[0] ?? "" });
        const identity = `${String(result.name ?? context.args[0])}@${String(result.version ?? "unknown")}`;
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: identity, humanMessage: `${identity}${typeof result.description === "string" ? `\n${result.description}` : ""}`, evidence: result });
      } else if (name === "search") {
        const results = await searchPackages({ ...common, terms: context.args });
        const lines = results.map((result) => `${String(result.name ?? "unknown")}@${String(result.version ?? "unknown")}${typeof result.description === "string" ? ` - ${result.description}` : ""}`);
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${results.length} package${results.length === 1 ? "" : "s"} found`, humanMessage: lines.join("\n") || "No matches found", evidence: { results } });
      } else if (name === "dist-tag") {
        const action = context.args[0];
        if (action === "ls" || action === "list") {
          const tags = await listDistTags({ ...common, package: context.args[1] ?? "" });
          const lines = Object.entries(tags).sort(([left], [right]) => left.localeCompare(right)).map(([tag, version]) => `${tag}: ${version}`);
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${Object.keys(tags).length} distribution tags`, humanMessage: lines.join("\n"), evidence: { tags } });
        } else {
          const mutation = action === "add" ? "add" : "remove";
          const tag = context.args[2] ?? "latest";
          await mutateDistTag({ ...common, action: mutation, package: context.args[1] ?? "", tag, ...(context.options?.otp === undefined ? {} : { otp: context.options.otp }) });
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${mutation === "add" ? "Set" : "Removed"} tag ${tag}`, humanMessage: `${mutation === "add" ? "+" : "-"}${tag}`, evidence: { action: mutation, package: context.args[1], tag } });
        }
      } else {
        const versions = await deprecatePackage({ ...common, package: context.args[0] ?? "", message: context.args[1] ?? "", ...(context.options?.otp === undefined ? {} : { otp: context.options.otp }), dryRun: context.options?.dryRun === true });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${context.options?.dryRun ? "Would deprecate" : "Deprecated"} ${versions.length} version${versions.length === 1 ? "" : "s"}`, evidence: { versions, message: context.args[1], dryRun: context.options?.dryRun === true } });
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError")) return ExitCode.networkFailure;
      throw error;
    }
  }
  if (name === "login" || name === "logout" || name === "whoami") {
    try {
      const paths = createBnpmPaths({ cwd: context.cwd });
      const registry = selectedRegistry(context.options).registry;
      if (name === "whoami") {
        const username = await registryWhoami({ paths, ...(registry === undefined ? {} : { registry }), signal: context.signal });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: username, humanMessage: username, evidence: { username } });
      } else if (name === "logout") {
        const result = await registryLogout({ paths, ...(registry === undefined ? {} : { registry }), signal: context.signal });
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Logged out of ${result}`, humanMessage: `Logged out of ${result}`, evidence: { registry: result } });
      } else {
        if (context.options?.authType === "legacy") {
          const username = await readInput("Registry username: ", context.options.json); const password = await readSecret("Registry password: ", context.signal); const email = context.options.accountCreate ? await readInput("Email address: ", context.options.json) : undefined;
          if (!username || !password || (context.options.accountCreate && !email)) { context.output.info("Legacy authentication requires interactive username, password, and adduser email inputs"); return ExitCode.policyBlocked; }
          const result = await registryLegacyLogin({ paths, username, password, ...(email === undefined ? {} : { email }), create: context.options.accountCreate === true, ...(registry === undefined ? {} : { registry }), signal: context.signal, ...(context.options.otp === undefined ? {} : { otp: context.options.otp }) });
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${result.created ? "Created" : "Authenticated"} registry user ${result.username}`, evidence: result });
        } else {
          const result = await registryLogin({ paths, ...(registry === undefined ? {} : { registry }), signal: context.signal, open: openExternal, announce: (url) => context.output.info(`Log in at ${url.href}`) });
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Logged in to ${result.registry}`, humanMessage: `Logged in to ${result.registry}`, evidence: result });
        }
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "ConfigError")) return ExitCode.networkFailure;
      throw error;
    }
  }
  if (name === "pack") {
    try {
      const packageRoot = resolve(context.cwd, context.args[0] ?? ".");
      const approvals = new Set(context.options?.allowDangerous ?? []);
      if (!context.options?.ignoreScripts) await runProjectScriptIfPresent(packageRoot, "prepack", context.signal, context.output, approvals);
      if (!context.options?.ignoreScripts) await runProjectScriptIfPresent(packageRoot, "prepare", context.signal, context.output, approvals);
      const artifact = await packPackage(packageRoot);
      if (!context.options?.ignoreScripts) await runProjectScriptIfPresent(packageRoot, "postpack", context.signal, context.output, approvals);
      const destination = resolve(context.cwd, context.options?.packDestination ?? ".", artifact.filename);
      if (!context.options?.dryRun) {
        const temporary = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
        try {
          await writeFile(temporary, artifact.tarball, { flag: "wx", mode: 0o644 });
          await rename(temporary, destination);
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
      }
      const evidence = {
        id: artifact.id,
        name: artifact.name,
        version: artifact.version,
        filename: artifact.filename,
        path: destination,
        size: artifact.size,
        unpackedSize: artifact.unpackedSize,
        shasum: artifact.shasum,
        integrity: artifact.integrity,
        files: artifact.files,
        dryRun: context.options?.dryRun === true,
      };
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: artifact.filename, humanMessage: artifact.filename, evidence });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && error.name === "PackError") return ExitCode.resolutionFailure;
      if (error instanceof ProcessCommandError) return ExitCode.installIncomplete;
      throw error;
    }
  }
  if (name === "publish" || name === "stage") {
    try {
      const staged = name === "stage";
      const packageRoot = resolve(context.cwd, context.args[staged ? 1 : 0] ?? ".");
      const approvals = new Set(context.options?.allowDangerous ?? []);
      if (!context.options?.ignoreScripts) await runProjectScriptIfPresent(packageRoot, "prepublishOnly", context.signal, context.output, approvals);
      if (!context.options?.ignoreScripts) await runProjectScriptIfPresent(packageRoot, "prepack", context.signal, context.output, approvals);
      if (!context.options?.ignoreScripts) await runProjectScriptIfPresent(packageRoot, "prepare", context.signal, context.output, approvals);
      const artifact = await packPackage(packageRoot);
      if (!context.options?.ignoreScripts) await runProjectScriptIfPresent(packageRoot, "postpack", context.signal, context.output, approvals);
      if (artifact.manifest.private === true) throw new PackError("refusing to publish a package marked private");
      const evidence = {
        id: artifact.id,
        name: artifact.name,
        version: artifact.version,
        filename: artifact.filename,
        size: artifact.size,
        unpackedSize: artifact.unpackedSize,
        shasum: artifact.shasum,
        integrity: artifact.integrity,
        files: artifact.files,
      };
      if (context.options?.dryRun) {
        if (!context.options.ignoreScripts) await runProjectScriptIfPresent(packageRoot, "publish", context.signal, context.output, approvals);
        if (!context.options.ignoreScripts) await runProjectScriptIfPresent(packageRoot, "postpublish", context.signal, context.output, approvals);
        context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Dry run: ${artifact.id}`, humanMessage: `Dry run: ${artifact.id}`, evidence: { ...evidence, dryRun: true } });
        return ExitCode.success;
      }
      const result = await publishPackage({
        artifact,
        paths: createBnpmPaths({ cwd: packageRoot }),
        ...selectedRegistry(context.options),
        ...(context.options?.tag === undefined ? {} : { tag: context.options.tag }),
        ...(context.options?.access === undefined ? {} : { access: context.options.access }),
        ...(context.options?.otp === undefined ? {} : { otp: context.options.otp }),
        ...(context.options?.provenanceFile === undefined ? {} : { provenance: await loadProvenance(artifact, resolve(packageRoot, context.options.provenanceFile)) }),
        ...(context.options?.provenance === true ? { generateProvenance: true } : {}),
        signal: context.signal,
        ...(staged ? { stage: true } : {}),
      });
      if (!context.options?.ignoreScripts) await runProjectScriptIfPresent(packageRoot, "publish", context.signal, context.output, approvals);
      if (!context.options?.ignoreScripts) await runProjectScriptIfPresent(packageRoot, "postpublish", context.signal, context.output, approvals);
      context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `${staged ? "Staged" : "Published"} ${artifact.id}`, humanMessage: `${staged ? "Staged" : "Published"} ${artifact.id}${result.stageId ? ` (${result.stageId})` : ""}`, evidence: { ...evidence, ...result, dryRun: false } });
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && error.name === "PackError") return ExitCode.resolutionFailure;
      if (error instanceof ProcessCommandError) return ExitCode.installIncomplete;
      if (error instanceof Error && error.name === "ConfigError") return ExitCode.policyBlocked;
      if (error instanceof Error && error.name === "ProvenanceError") return ExitCode.policyBlocked;
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "TypeError")) return ExitCode.networkFailure;
      throw error;
    }
  }
  if (name === "bin" || name === "prefix" || name === "root") {
    const paths = createBnpmPaths({ cwd: context.cwd });
    const discovered = await discoverProject(context.cwd);
    const localPrefix = discovered?.importerRoot ?? context.cwd;
    const value = context.options?.globalInstall
      ? name === "bin" ? paths.globalBin : name === "root" ? join(paths.globalRoot, "node_modules") : paths.globalRoot
      : name === "bin" ? join(localPrefix, "node_modules", ".bin") : name === "root" ? join(localPrefix, "node_modules") : localPrefix;
    context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: value, humanMessage: value, evidence: { path: value, global: context.options?.globalInstall === true } });
    return ExitCode.success;
  }
  if (name === "install" || name === "install-test" || name === "install-ci-test" || name === "add" || name === "remove" || name === "update" || name === "prune" || name === "dedupe") {
    try {
      if (!context.options) throw new Error("Command options are unavailable");
      const location = await commandLocation(context);
      const roots = location.globalPaths ? [location.cwd] : await selectedWorkspaceRoots(location.cwd, context.options);
      for (const cwd of roots) {
      const securityEvents: { readonly message: string; readonly evidence: unknown }[] = [];
      const collectSecurityEvidence = (message: string, evidence: unknown): void => { securityEvents.push({ message, evidence }); };
      const reportProgress = installProgressReporter(context);
      const result = name === "add" || (name === "install" && context.args.length > 0)
        ? await addDependencies(cwd, context.args, context.options, {
            signal: context.signal,
            ...selectedRegistry(context.options),
            prompts: commandInstallPrompts(context.options, () => context.output.finishProgress?.()),
            onChildOutput: (stream, text, attribution) => context.output.childOutput(stream, text, attribution),
            onSecurityEvidence: collectSecurityEvidence,
            onProgress: reportProgress,
          })
        : name === "remove"
          ? await removeDependencies(cwd, context.args, context.options, {
              signal: context.signal,
              ...selectedRegistry(context.options),
              prompts: commandInstallPrompts(context.options, () => context.output.finishProgress?.()),
              onChildOutput: (stream, text, attribution) => context.output.childOutput(stream, text, attribution),
              onSecurityEvidence: collectSecurityEvidence,
              onProgress: reportProgress,
            })
          : name === "update"
            ? await updateDependencies(cwd, context.args, context.options, {
                signal: context.signal,
                ...selectedRegistry(context.options),
                prompts: commandInstallPrompts(context.options, () => context.output.finishProgress?.()),
                onChildOutput: (stream, text, attribution) => context.output.childOutput(stream, text, attribution),
                onSecurityEvidence: collectSecurityEvidence,
                onProgress: reportProgress,
              })
          : await installProject({
              cwd,
              ...selectedRegistry(context.options),
              specifications: context.args,
              commandOptions: context.options,
              signal: context.signal,
              prompts: commandInstallPrompts(context.options, () => context.output.finishProgress?.()),
              onChildOutput: (stream, text, attribution) => context.output.childOutput(stream, text, attribution),
              onSecurityEvidence: collectSecurityEvidence,
              onProgress: reportProgress,
              ...((name === "prune" || name === "dedupe") ? { forceRelink: true } : {}),
              ...(name === "dedupe" ? { forceResolution: true } : {}),
            });
      if (context.options.json || context.options.details) for (const event of securityEvents.sort((left, right) => left.message.localeCompare(right.message))) context.output.info(event.message, event.evidence);
      if (!context.options.json) {
        const findings = [...result.analyses.values()].flatMap((analyzed) => analyzed.analysis.findings);
        const lifecycles = [...result.analyses.values()].flatMap((analyzed) => analyzed.lifecycles);
        const limited = findings.filter((finding) => finding.ruleId === "BNPM-SEC-009").length;
        const warnings = findings.length - limited;
        const securitySummary = result.analyses.size === 0 && context.options.packageLockOnly
          ? "Security: content inspection skipped for lockfile-only resolution"
          : result.analyses.size === 0 && result.graph.packages.size > 0
            ? "Security: existing verified decisions reused"
            : `Security: ${result.analyses.size} package${result.analyses.size === 1 ? "" : "s"} inspected · ${warnings === 0 ? "no findings" : `${warnings} finding${warnings === 1 ? "" : "s"}`} · ${lifecycles.length === 0 ? "no install scripts" : `${lifecycles.length} install script${lifecycles.length === 1 ? "" : "s"}`}${limited > 0 ? ` · ${limited} bounded scan${limited === 1 ? "" : "s"}` : ""}${(warnings > 0 || lifecycles.length > 0 || limited > 0) && !context.options.details ? " (use --details)" : ""}`;
        context.output.info(securitySummary);
      }
      if (location.globalPaths && !context.options.packageLockOnly && !context.options.dryRun) await exposeGlobalBins(location.globalPaths);
      if (result.skippedLifecyclePackages.length > 0) {
        context.output.error(`Skipped unapproved lifecycle scripts for ${result.skippedLifecyclePackages.join(", ")}`);
        return ExitCode.installIncomplete;
      }
      if (!context.options.dryRun && !context.options.packageLockOnly && !context.options.ignoreScripts && !location.globalPaths && ["install", "install-test", "install-ci-test", "add", "remove", "update"].includes(name)) {
        const code = await runProjectInstallLifecycle(cwd, context.signal, context.output, new Set(context.options.allowDangerous));
        if (code !== 0) return ExitCode.installIncomplete;
      }
      if (name === "install-test" || name === "install-ci-test") {
        const code = await runProjectScriptLifecycle(cwd, "test", [], context.signal, context.output, new Set(context.options.allowDangerous), !context.options.ignoreScripts);
        if (code !== 0) return ExitCode.installIncomplete;
      }
      }
      return ExitCode.success;
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const report = (): void => context.output.error(error instanceof Error ? error.message : String(error));
      if (name === "PolicyError" || name === "LockfileError" || name === "ConfigError") { report(); return ExitCode.policyBlocked; }
      if (name === "IntegrityError" || name === "ArchiveError") { report(); return ExitCode.integrityFailure; }
      if (name === "RegistryError" || name === "TypeError") { report(); return ExitCode.networkFailure; }
      if (name === "ResolutionError" || name === "ManifestError" || name === "DependencyError") { report(); return ExitCode.resolutionFailure; }
      if (name === "ScriptExecutionError") { report(); return ExitCode.installIncomplete; }
      if (error instanceof ProcessCommandError) { report(); return ExitCode.resolutionFailure; }
      throw error;
    }
  }
  if (name === "outdated") {
    try {
      const location = await commandLocation(context);
      const entries = await findOutdatedDependencies({ cwd: location.cwd, names: context.args, signal: context.signal, ...selectedRegistry(context.options) });
      if (entries.length === 0) context.output.info("All dependencies are current");
      for (const entry of entries) {
        context.output.info(`${entry.name}: ${entry.current ?? "missing"} -> ${entry.wanted} (latest ${entry.latest})`, entry);
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && (error.name === "RegistryError" || error.name === "TypeError")) return ExitCode.networkFailure;
      if (error instanceof Error && error.name === "ConfigError") return ExitCode.policyBlocked;
      if (error instanceof Error && (error.name === "ManifestError" || error.name === "DependencyError")) return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "list" || name === "why") {
    try {
      const location = await commandLocation(context);
      const report = await inspectInstalledGraph(location.cwd, name === "list" ? { names: context.args } : { why: context.args[0] ?? "" });
      if (name === "list") {
        context.output.info(report.human, { roots: report.roots });
      } else {
        context.output.info(report.human, { package: context.args[0], paths: report.paths });
      }
      return ExitCode.success;
    } catch (error) {
      if (error instanceof Error && error.name === "LockfileError") return ExitCode.resolutionFailure;
      throw error;
    }
  }
  if (name === "run" || name === "exec") {
    try {
      const location = await commandLocation(context);
      const [target, ...args] = context.args;
      if (!target) {
        if (name === "exec") return ExitCode.usage;
        const scripts = [...await projectScriptNames(location.cwd)].sort();
        context.output.info(scripts.join("\n") || "No scripts defined", { scripts });
        return ExitCode.success;
      }
      if (name === "run" && (context.options?.workspaces || context.options?.workspaceNames !== undefined)) {
        const discovered = await discoverProject(location.cwd);
        const root = discovered?.projectRoot ?? location.cwd;
        const manifestPath = join(root, "package.json");
        const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
        const members = await discoverWorkspacePackages(root, manifest.workspaces);
        const requested = new Set(context.options.workspaceNames ?? []);
        const selected = [...members].filter(([workspace, path]) => requested.size === 0 || requested.has(workspace) || requested.has(relative(root, path).split(sep).join("/")) || [...requested].some((value) => path.startsWith(`${resolve(root, value)}${sep}`)));
        if (selected.length === 0) throw new ProcessCommandError(requested.size === 0 ? "No workspaces were found" : `No workspace matched: ${[...requested].join(", ")}`);
        if (context.options.includeWorkspaceRoot) {
          context.output.info(`Running ${target} in workspace root`);
          if (context.options.ifPresent && !(await projectScriptNames(root)).has(target)) {
            context.output.info(`Skipping missing script ${target} in workspace root`);
          } else {
          const code = await runProjectScriptLifecycle(root, target, args, context.signal, context.output, new Set(context.options.allowDangerous), !context.options.ignoreScripts);
          if (code !== 0) return ExitCode.installIncomplete;
          }
        }
        for (const [workspace, path] of selected.sort(([left], [right]) => left.localeCompare(right))) {
          if (context.options.ifPresent && !(await projectScriptNames(path)).has(target)) { context.output.info(`Skipping missing script ${target} in ${workspace}`); continue; }
          context.output.info(`Running ${target} in ${workspace}`);
          const code = await runProjectScriptLifecycle(path, target, args, context.signal, context.output, new Set(context.options.allowDangerous), !context.options.ignoreScripts);
          if (code !== 0) return ExitCode.installIncomplete;
        }
        return ExitCode.success;
      }
      if (name === "run" && context.options?.ifPresent && !(await projectScriptNames(location.cwd)).has(target)) return ExitCode.success;
      const code = name === "run"
        ? await runProjectScriptLifecycle(location.cwd, target, args, context.signal, context.output, new Set(context.options?.allowDangerous ?? []), !context.options?.ignoreScripts)
        : context.options?.execPackages !== undefined
          ? await execEphemeral(context, context.options.execPackages, target, args)
          : await execInstalled(location.cwd, target, args, context.signal, context.output, context.output.passthroughChildOutput === true);
      return code === 0 ? ExitCode.success : ExitCode.installIncomplete;
    } catch (error) {
      if (error instanceof ProcessCommandError) { context.output.error(error.message); return ExitCode.resolutionFailure; }
      throw error;
    }
  }
  if (name === "audit") {
    try {
      const location = await commandLocation(context);
      const projectRoot = (await discoverProject(location.cwd))?.projectRoot ?? location.cwd;
      let result = await auditProject({ paths: createBnpmPaths({ cwd: projectRoot }), signal: context.signal, ...selectedRegistry(context.options) });
      const initialAdvisories = result.advisories.length;
      if (context.args[0] === "fix" && initialAdvisories > 0) {
        if (context.options?.dryRun) {
          context.output.result({ status: "success", category: "success", exitCode: ExitCode.success, summary: `Would re-resolve ${initialAdvisories} advisor${initialAdvisories === 1 ? "y" : "ies"} within declared dependency ranges`, evidence: { advisories: result.advisories, dryRun: true } });
          return ExitCode.success;
        }
        const commandOptions = context.options as CommandOptions;
        const fixed = await installProject({ cwd: location.cwd, commandOptions, forceResolution: true, signal: context.signal, ...selectedRegistry(context.options), prompts: commandInstallPrompts(commandOptions), onChildOutput: (stream, text, attribution) => context.output.childOutput(stream, text, attribution), onSecurityEvidence: (message, evidence) => context.output.info(message, evidence) });
        if (fixed.skippedLifecyclePackages.length > 0) { context.output.error(`Skipped unapproved lifecycle scripts for ${fixed.skippedLifecyclePackages.join(", ")}`); return ExitCode.installIncomplete; }
        result = await auditProject({ paths: createBnpmPaths({ cwd: projectRoot }), signal: context.signal, ...selectedRegistry(context.options) });
        context.output.info(`Audit fix removed ${initialAdvisories - result.advisories.length} of ${initialAdvisories} advisories without changing declared ranges`, { before: initialAdvisories, after: result.advisories.length });
      }
      let blocked = false;
      for (const [id, analyzed] of result.packages) {
        if (analyzed.analysis.findings.length > 0) context.output.info(`Local security findings for ${id}`, analyzed.analysis.findings);
        if (analyzed.analysis.findings.some((finding) => finding.severity === "dangerous")) blocked = true;
      }
      for (const advisory of result.advisories) {
        context.output.info(`Registry advisory for ${advisory.packageName}: ${advisory.title}`, advisory);
        if (advisory.severity === "high" || advisory.severity === "critical") blocked = true;
      }
      context.output.info(`Audit completed at ${result.analyzedAt}`, { packageCount: result.packages.size, advisoryCount: result.advisories.length });
      return blocked ? ExitCode.policyBlocked : ExitCode.success;
    } catch (error) {
      if (error instanceof Error && error.name === "RegistryError") return ExitCode.networkFailure;
      if (error instanceof Error && error.name === "LockfileError") return ExitCode.resolutionFailure;
      if (error instanceof Error && error.name === "ConfigError") return ExitCode.policyBlocked;
      throw error;
    }
  }
  return ExitCode.usage;
}

export async function runBnpmxCommand(context: Omit<CommandContext, "options">, global: GlobalOptions, specification: string, targetArgs: readonly string[]): Promise<ExitCodeValue> {
  if (specification === "check") {
    if (targetArgs.length > 0) { context.output.error("bnpmx check does not accept package arguments"); return ExitCode.usage; }
    try {
      const discovered = await discoverProject(context.cwd); const projectRoot = discovered?.projectRoot ?? context.cwd;
      const result = await auditProject({ paths: createBnpmPaths({ cwd: projectRoot }), ...selectedRegistry(global), signal: context.signal });
      const directIdentities = new Set([...result.graph.roots.values(), ...[...(result.graph.importers?.values() ?? [])].flatMap((roots) => [...roots.values()])].map((id) => { const pkg = result.graph.packages.get(id); return pkg ? `${pkg.name}@${pkg.version}` : id; }));
      const capabilities = [...result.packages.values()].flatMap((analyzed) => analyzed.capabilities ?? []);
      const grouped = new Map<ExecutionCapability["kind"], GroupedCapability>();
      for (const capability of capabilities) {
        let entry = grouped.get(capability.kind); if (!entry) { entry = { behavior: capability.behavior, severity: capability.severity, packages: new Set(), evidence: new Set() }; grouped.set(capability.kind, entry); }
        entry.packages.add(`${capability.packageName}@${capability.packageVersion}`); for (const evidence of capability.evidence) entry.evidence.add(evidence);
      }
      const findings = [...result.packages.values()].flatMap((analyzed) => analyzed.analysis.findings); const lifecycles = [...result.packages.values()].flatMap((analyzed) => analyzed.lifecycles);
      const direct = directIdentities.size; const transitive = Math.max(0, result.graph.packages.size - direct);
      const lines = ["Project security check", `${result.graph.packages.size} packages · ${direct} direct · ${transitive} transitive`];
      if (grouped.size > 0) lines.push("", "RUNTIME CAPABILITIES");
      for (const kind of capabilityOrder) {
        const entry = grouped.get(kind); if (!entry) continue; const presentation = capabilitySummary(kind, [...entry.evidence]); const identities = [...entry.packages]; const directCount = identities.filter((identity) => directIdentities.has(identity)).length;
        lines.push(`  ${entry.severity === "warning" ? "!" : "•"} ${presentation.title} · ${identities.length} package${identities.length === 1 ? "" : "s"} (${directCount} direct, ${identities.length - directCount} transitive)`);
        if (presentation.summary) lines.push(`    ${presentation.summary}`);
        if (global.details) lines.push(`    Packages: ${identities.sort().join(", ")}`, `    Evidence: ${[...entry.evidence].sort().slice(0, 24).join("; ")}`);
      }
      lines.push("", "INSTALL-TIME REVIEW", `  ${lifecycles.length > 0 ? "!" : "✓"} ${lifecycles.length} lifecycle script${lifecycles.length === 1 ? "" : "s"}`, `  ${findings.length > 0 ? "!" : "✓"} ${findings.length} static finding${findings.length === 1 ? "" : "s"}`, `  ${result.advisories.length > 0 ? "!" : "✓"} ${result.advisories.length} registry advisor${result.advisories.length === 1 ? "y" : "ies"}`);
      if (global.details && findings.length > 0) for (const finding of findings.sort((left, right) => left.packageName.localeCompare(right.packageName) || left.ruleId.localeCompare(right.ruleId))) lines.push(`    ${finding.severity.toUpperCase()} ${finding.packageName}@${finding.packageVersion} ${finding.ruleId}: ${finding.behavior} (${finding.location?.path ?? "package"})`);
      lines.push("", `Scanned ${result.packages.size}/${result.graph.packages.size} locked packages. No package code was executed.`); if (!global.details) lines.push("Use bnpmx --details check for package and file evidence.");
      context.output.info(lines.join("\n"), { graph: { packages: result.graph.packages.size, direct, transitive }, capabilities, findings, lifecycles, advisories: result.advisories });
      return findings.some((finding) => finding.severity === "dangerous") || result.advisories.some((advisory) => advisory.severity === "high" || advisory.severity === "critical") ? ExitCode.policyBlocked : ExitCode.success;
    } catch (error) {
      context.output.error(error instanceof Error ? error.message : String(error)); const name = error instanceof Error ? error.name : "";
      return name === "LockfileError" ? ExitCode.resolutionFailure : name === "RegistryError" ? ExitCode.networkFailure : ExitCode.internalError;
    }
  }
  const base = createBnpmPaths({ cwd: context.cwd }).ephemeralRoot;
  await mkdir(base, { recursive: true, mode: 0o700 });
  const project = await mkdtemp(join(base, "run-"));
  const options: CommandOptions = {
    ...global,
    frozenLockfile: false,
    offline: false,
    omitDev: true,
    saveExact: false,
    noSave: true,
  };
  try {
    const result = await installProject({
      cwd: project,
      ...selectedRegistry(global),
      specifications: [specification],
      commandOptions: options,
      signal: context.signal,
      prompts: commandInstallPrompts(options),
      onChildOutput: (stream, text, attribution) => context.output.childOutput(stream, text, attribution),
      onSecurityEvidence: (message, evidence) => context.output.info(message, evidence),
    });
    if (result.skippedLifecyclePackages.length > 0) {
      context.output.error(`bnpmx will not execute because lifecycle scripts were skipped for ${result.skippedLifecyclePackages.join(", ")}`);
      return ExitCode.installIncomplete;
    }
    const root = [...result.graph.roots][0];
    if (!root) return ExitCode.usage;
    const pkg = result.graph.packages.get(root[1]);
    if (!pkg) return ExitCode.internalError;
    const bin = pkg.manifest.bin;
    const preferred = basename(root[0]);
    const binary = typeof bin === "string"
      ? basename(pkg.name)
      : bin?.[preferred] !== undefined
        ? preferred
        : bin?.[basename(pkg.name)] !== undefined
          ? basename(pkg.name)
          : Object.keys(bin ?? {}).sort()[0];
    if (!binary) {
      context.output.error(`${pkg.id} does not expose an executable`);
      return ExitCode.usage;
    }
    const capabilities = [...result.analyses.values()].flatMap((analyzed) => analyzed.capabilities ?? []);
    if (capabilities.length > 0) {
      const grouped = new Map<ExecutionCapability["kind"], GroupedCapability>();
      for (const capability of capabilities) {
        let entry = grouped.get(capability.kind); if (!entry) { entry = { behavior: capability.behavior, severity: capability.severity, packages: new Set(), evidence: new Set() }; grouped.set(capability.kind, entry); }
        entry.packages.add(`${capability.packageName}@${capability.packageVersion}`); for (const evidence of capability.evidence) entry.evidence.add(evidence);
      }
      const identity = `${pkg.name}@${pkg.version}`; const explicitlyAllowed = global.allowDangerous.includes(identity);
      context.output.info(capabilityDisclosure(identity, binary, grouped, global.details === true), capabilities);
      if (!explicitlyAllowed && !await confirmCommand(`Allow ${identity} to run?`, { json: global.json, yes: false })) {
        context.output.error(`Execution cancelled before ${binary} started. Review the disclosure or pass --allow-dangerous=${identity} for this exact version.`);
        return ExitCode.policyBlocked;
      }
    }
    const code = await execInstalled(project, binary, targetArgs, context.signal, context.output, context.output.passthroughChildOutput === true);
    return code === 0 ? ExitCode.success : ExitCode.installIncomplete;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "PolicyError" || name === "LockfileError" || name === "ConfigError") return ExitCode.policyBlocked;
    if (name === "IntegrityError" || name === "ArchiveError") return ExitCode.integrityFailure;
    if (name === "RegistryError" || name === "TypeError" || name === "TimeoutError") return ExitCode.networkFailure;
    if (name === "ResolutionError" || name === "ManifestError" || name === "DependencyError") return ExitCode.resolutionFailure;
    if (name === "ScriptExecutionError") return ExitCode.installIncomplete;
    if (error instanceof ProcessCommandError) return ExitCode.resolutionFailure;
    throw error;
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}
