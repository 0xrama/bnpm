import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { createBnpmPaths, type BnpmPaths } from "../config/paths.js";
import { readLockfileGraph, writeLockfileAtomic, LockfileError } from "../lockfile/index.js";
import { discoverProject } from "../project/discovery.js";

function mapping(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LockfileError(`${field} must be a mapping`);
  return value as Record<string, unknown>;
}

export function mutateApprovalDocument(bytes: string, selectedIds: ReadonlySet<string>, action: "approve" | "deny"): string {
  const document = YAML.parseDocument(bytes, { uniqueKeys: true, strict: true });
  if (document.errors.length > 0) throw new LockfileError(document.errors[0]?.message ?? "invalid YAML");
  const root = mapping(document.toJS(), "root");
  const packages = mapping(root.packages, "packages");
  const approvals = mapping(root.approvals ?? {}, "approvals");
  for (const id of selectedIds) {
    const pkg = mapping(packages[id], `package ${id}`);
    if (action === "deny") { delete approvals[id]; continue; }
    const resolution = mapping(pkg.resolution, `package ${id} resolution`);
    if (typeof resolution.integrity !== "string") throw new LockfileError(`package ${id} has no integrity`);
    const scripts = mapping(pkg.scripts, `package ${id} scripts`);
    const approved: Record<string, unknown> = {};
    for (const [stage, raw] of Object.entries(scripts)) {
      const script = mapping(raw, `package ${id} script ${stage}`);
      if (typeof script.commandHash !== "string" || typeof script.contentHash !== "string") throw new LockfileError(`package ${id} has invalid script facts`);
      approved[stage] = { commandHash: script.commandHash, contentHash: script.contentHash, approved: true };
    }
    if (Object.keys(approved).length === 0) throw new LockfileError(`package ${id} has no lifecycle scripts to approve`);
    approvals[id] = { integrity: resolution.integrity, scripts: approved };
  }
  if (Object.keys(approvals).length === 0) delete root.approvals;
  else root.approvals = approvals;
  return YAML.stringify(root, { lineWidth: 0, sortMapEntries: true });
}

export async function mutateScriptApprovals(options: { readonly cwd: string; readonly names: readonly string[]; readonly action: "approve" | "deny"; readonly paths?: BnpmPaths }): Promise<readonly string[]> {
  const discovered = await discoverProject(options.cwd);
  const root = discovered?.projectRoot ?? options.cwd;
  const paths = options.paths ?? createBnpmPaths({ cwd: root });
  const locked = await readLockfileGraph(paths.lockfile, paths.store);
  const requested = new Set(options.names);
  const selected = [...locked.lifecycleScripts]
    .filter(([id, scripts]) => Object.keys(scripts).length > 0 && (requested.size === 0 || requested.has(locked.graph.packages.get(id)?.name ?? "")))
    .map(([id]) => id);
  if (requested.size > 0) {
    const matched = new Set(selected.map((id) => locked.graph.packages.get(id)?.name));
    const missing = [...requested].filter((name) => !matched.has(name));
    if (missing.length > 0) throw new LockfileError(`no locked lifecycle scripts found for ${missing.join(", ")}`);
  }
  if (selected.length === 0) return [];
  const bytes = await readFile(paths.lockfile, "utf8");
  await writeLockfileAtomic(paths.lockfile, mutateApprovalDocument(bytes, new Set(selected), options.action));
  return selected;
}

export interface ScriptApprovalStatus {
  readonly pending: readonly string[];
  readonly approved: readonly string[];
  readonly stale: readonly string[];
}

function approvalMatches(pkg: Record<string, unknown>, rawApproval: unknown): boolean {
  try {
    const approval = mapping(rawApproval, "approval");
    const resolution = mapping(pkg.resolution, "resolution");
    if (approval.integrity !== resolution.integrity) return false;
    const scripts = mapping(pkg.scripts ?? {}, "scripts");
    const approvedScripts = mapping(approval.scripts, "approval scripts");
    if (Object.keys(scripts).length === 0 || Object.keys(scripts).length !== Object.keys(approvedScripts).length) return false;
    return Object.entries(scripts).every(([stage, raw]) => {
      const fact = mapping(raw, `script ${stage}`); const approved = mapping(approvedScripts[stage], `approval ${stage}`);
      return approved.approved === true && approved.commandHash === fact.commandHash && approved.contentHash === fact.contentHash;
    });
  } catch { return false; }
}

export async function inspectScriptApprovals(options: { readonly cwd: string; readonly paths?: BnpmPaths }): Promise<ScriptApprovalStatus> {
  const discovered = await discoverProject(options.cwd); const root = discovered?.projectRoot ?? options.cwd;
  const paths = options.paths ?? createBnpmPaths({ cwd: root }); const document = YAML.parse(await readFile(paths.lockfile, "utf8")) as unknown;
  const top = mapping(document, "root"); const packages = mapping(top.packages, "packages"); const approvals = mapping(top.approvals ?? {}, "approvals");
  const pending: string[] = []; const approved: string[] = [];
  for (const [id, raw] of Object.entries(packages)) {
    const pkg = mapping(raw, `package ${id}`); const scripts = mapping(pkg.scripts ?? {}, `package ${id} scripts`);
    if (Object.keys(scripts).length === 0) continue;
    (approvalMatches(pkg, approvals[id]) ? approved : pending).push(id);
  }
  const stale = Object.keys(approvals).filter((id) => packages[id] === undefined || !approvalMatches(mapping(packages[id], `package ${id}`), approvals[id]));
  return { pending: pending.sort(), approved: approved.sort(), stale: stale.sort() };
}

export async function pruneScriptApprovals(options: { readonly cwd: string; readonly dryRun?: boolean; readonly paths?: BnpmPaths }): Promise<readonly string[]> {
  const discovered = await discoverProject(options.cwd); const root = discovered?.projectRoot ?? options.cwd;
  const paths = options.paths ?? createBnpmPaths({ cwd: root }); const bytes = await readFile(paths.lockfile, "utf8");
  const status = await inspectScriptApprovals({ cwd: root, paths });
  if (status.stale.length === 0 || options.dryRun) return status.stale;
  const document = YAML.parseDocument(bytes, { uniqueKeys: true, strict: true });
  if (document.errors.length > 0) throw new LockfileError(document.errors[0]?.message ?? "invalid YAML");
  const top = mapping(document.toJS(), "root"); const approvals = mapping(top.approvals ?? {}, "approvals");
  for (const id of status.stale) delete approvals[id];
  if (Object.keys(approvals).length === 0) delete top.approvals; else top.approvals = approvals;
  await writeLockfileAtomic(paths.lockfile, YAML.stringify(top, { lineWidth: 0, sortMapEntries: true }));
  return status.stale;
}
