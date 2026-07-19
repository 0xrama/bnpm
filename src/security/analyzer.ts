import { createHash } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { PackageAnalysis, SecurityFinding } from "./findings.js";

export const lifecycleStages = ["preinstall", "install", "postinstall"] as const;
export const gitBuildStages = ["preinstall", "install", "postinstall", "prepare"] as const;
export type LifecycleStage = (typeof gitBuildStages)[number] | "prepack" | "postpack" | "prepublishOnly" | "publish" | "postpublish";

export interface LifecycleFact {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly integrity: string;
  readonly stage: LifecycleStage;
  readonly command: string;
  readonly commandHash: string;
  readonly contentHash: string;
  readonly referencedFiles: readonly string[];
}

export interface AnalyzedPackage {
  readonly analysis: PackageAnalysis;
  readonly lifecycles: readonly LifecycleFact[];
  readonly capabilities?: readonly ExecutionCapability[];
}

export type ExecutionCapabilityKind = "ai-history-read" | "credential-read" | "network-access" | "local-write" | "process-spawn" | "native-code";

export interface ExecutionCapability {
  readonly kind: ExecutionCapabilityKind;
  readonly severity: "notice" | "warning";
  readonly packageName: string;
  readonly packageVersion: string;
  readonly behavior: string;
  readonly evidence: readonly string[];
}

interface Rule {
  readonly id: string;
  readonly severity: "warning" | "dangerous";
  readonly behavior: string;
  readonly expression: RegExp;
  readonly remediation: string;
}

const rules: readonly Rule[] = [
  { id: "BNPM-SEC-001", severity: "dangerous", behavior: "Possible reverse-shell behavior", expression: /(?:\/dev\/tcp\/|\bnc\s+[^\n]*\s-e\s|bash\s+-i[^\n]*(?:>&|\|))/i, remediation: "Remove or independently verify the reverse-shell behavior." },
  { id: "BNPM-SEC-002", severity: "dangerous", behavior: "Remote payload download followed by execution", expression: /(?:(?:curl|wget)\b[^\n|;&]*(?:\||&&|;)\s*(?:sh|bash|node|python)|(?:curl|wget)\b[^\n]*(?:chmod\s+\+x|child_process))/i, remediation: "Pin and verify downloaded content instead of executing a remote payload." },
  { id: "BNPM-SEC-003", severity: "warning", behavior: "Credential or secret material is targeted", expression: /(?:\.npmrc|\.ssh(?:\/|\\)|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|NPM_TOKEN|GITHUB_TOKEN|keychain|(?:credentials|secrets)\.json)/i, remediation: "Confirm why installation needs access to credentials or secret stores." },
  { id: "BNPM-SEC-004", severity: "dangerous", behavior: "Persistence mechanism is installed", expression: /(?:crontab|LaunchAgents|LaunchDaemons|systemctl\s+enable|schtasks\s+\/create)/i, remediation: "Remove persistence changes from package installation." },
  { id: "BNPM-SEC-005", severity: "dangerous", behavior: "Destructive filesystem command is present", expression: /(?:rm\s+-rf\s+(?:\/|~)|mkfs\b|diskutil\s+erase|format\s+[A-Z]:)/i, remediation: "Remove destructive filesystem operations." },
  { id: "BNPM-SEC-006", severity: "dangerous", behavior: "Cryptocurrency miner behavior is present", expression: /(?:xmrig|stratum\+(?:tcp|ssl)|cryptonight|minerd\b)/i, remediation: "Remove miner download or execution behavior." },
  { id: "BNPM-SEC-007", severity: "warning", behavior: "Obfuscated content is connected to process execution", expression: /(?:eval\s*\(\s*(?:Buffer\.from|atob)|child_process[^\n]{0,160}(?:base64|fromCharCode))/i, remediation: "Replace obfuscated execution with reviewable source." },
] as const;

const capabilityRules: readonly { readonly kind: Exclude<ExecutionCapabilityKind, "native-code">; readonly severity: "notice" | "warning"; readonly behavior: string; readonly expression: RegExp }[] = [
  { kind: "ai-history-read", severity: "warning", behavior: "May read local AI assistant chat logs and session history", expression: /(?:CODEX_HOME|GEMINI_CLI_HOME|HERMES_HOME|JCODE_HOME|GROK_HOME|\.codex(?:\/|\\)|\.claude\/projects|\.config\/opencode|opencode\/storage\/message|\.cursor|\.gemini|amp\/threads|droid\.factory\/sessions|\.kimi\/sessions|\.qwen\/projects|roocode|kilocode|cline|antigravity-cache\/sessions|zed\/threads|trae-cache\/sessions|warp-cache)/ig },
  { kind: "credential-read", severity: "warning", behavior: "May read authentication tokens, credentials, cookies, or account configuration", expression: /(?:auth\.json|credentials\.json|codex-credentials\.json|secrets\.json|hosts\.yml|oauth[_-]?token|refresh[_-]?token|session[_-]?token|api[_-]?token|keychain|credential store)/ig },
  { kind: "network-access", severity: "notice", behavior: "May make outbound network requests", expression: /https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+/ig },
  { kind: "local-write", severity: "notice", behavior: "May write local configuration, cache, database, or report files", expression: /(?:writeFile(?:Sync)?|create_dir(?:_all)?|\.config\/tokscale|stats-cache\.json|tui-data-cache\.json|\.sqlite|\.db\b)/ig },
  { kind: "process-spawn", severity: "warning", behavior: "May launch subprocesses or platform-native helper programs", expression: /(?:child_process|spawnSync|execSync|Command::new|std::process::Command)/ig },
] as const;

const hash = (value: string | Buffer): string => `sha256-${createHash("sha256").update(value).digest("base64")}`;

function passiveEvidencePath(path: string): boolean {
  return /(?:^|\/)(?:readme|changelog|changes|license)(?:\.[^/]*)?$|\.(?:md|mdx|map|d\.ts|d\.mts|d\.cts)$/i.test(path);
}

function referencedCommandFiles(command: string): readonly string[] {
  const matches = command.matchAll(/(?:^|\s)(?:node|sh|bash|zsh|python(?:3)?|\.\/)(?:\s+)?([A-Za-z0-9_./-]+\.(?:js|cjs|mjs|sh|py))(?:\s|$)/g);
  return [...new Set([...matches].map((match) => match[1]).filter((value): value is string => value !== undefined))].sort();
}

function safeReference(root: string, path: string): string {
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`Lifecycle script references a file outside the package: ${path}`);
  return target;
}

function finding(rule: Rule, packageName: string, packageVersion: string, path: string, content: string, index: number): SecurityFinding {
  const before = content.slice(0, index);
  const line = before.split("\n").length;
  const column = index - before.lastIndexOf("\n");
  const evidence = content.slice(Math.max(0, index - 40), Math.min(content.length, index + 120)).replace(/\s+/g, " ").slice(0, 160);
  return { ruleId: rule.id, severity: rule.severity, packageName, packageVersion, behavior: rule.behavior, evidence, location: { path, line, column }, remediation: rule.remediation };
}

export async function analyzePackage(options: {
  readonly root: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly integrity: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly stages?: readonly LifecycleStage[];
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}): Promise<AnalyzedPackage> {
  const maxFiles = options.maxFiles ?? 20_000;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  let files = 0;
  let bytes = 0;
  let limitedAt: string | undefined;
  const findings: SecurityFinding[] = [];
  const capabilityEvidence = new Map<ExecutionCapabilityKind, { readonly severity: "notice" | "warning"; readonly behavior: string; readonly evidence: Set<string> }>();
  const recordCapability = (kind: ExecutionCapabilityKind, severity: "notice" | "warning", behavior: string, evidence: string): void => {
    let current = capabilityEvidence.get(kind); if (!current) { current = { severity, behavior, evidence: new Set() }; capabilityEvidence.set(kind, current); }
    if (current.evidence.size < 64) current.evidence.add(evidence.replace(/[^\x20-\x7E]+/g, " ").slice(0, 160));
  };
  const scanCapabilities = (path: string, content: Buffer, inspectMagic = false): void => {
    const magic = content.subarray(0, 4).toString("hex");
    if (inspectMagic && (["cffaedfe", "cefaedfe", "feedfacf", "feedface", "7f454c46"].includes(magic) || content.subarray(0, 2).toString("ascii") === "MZ")) recordCapability("native-code", "warning", "Contains native executable code that cannot be fully inspected as JavaScript", path);
    const searchable = content.toString("latin1");
    for (const rule of capabilityRules) {
      if (passiveEvidencePath(path) || (rule.kind === "network-access" && /(?:^|\/)package\.json$/i.test(path))) continue;
      rule.expression.lastIndex = 0; let matches = 0;
      for (const match of searchable.matchAll(rule.expression)) {
        const value = match[0]; if (!value) continue; let displayed = value;
        if (rule.kind === "network-access") { try { displayed = new URL(value.replace(/[\"'`]+$/g, "")).origin; } catch { /* retain bounded source evidence */ } }
        else if (rule.kind === "ai-history-read") {
          if (/CODEX_HOME|\.codex/i.test(value)) displayed = "Codex: $CODEX_HOME or ~/.codex";
          else if (/claude/i.test(value)) displayed = "Claude Code: ~/.claude/projects";
          else if (/opencode/i.test(value)) displayed = "OpenCode session storage";
          else if (/cursor/i.test(value)) displayed = "Cursor session storage";
          else if (/GEMINI|\.gemini/i.test(value)) displayed = "Gemini CLI session storage";
        }
        recordCapability(rule.kind, rule.severity, rule.behavior, `${path}: ${displayed}`); if (++matches >= 256) break;
      }
    }
  };
  const scan = (path: string, content: string): void => {
    if (passiveEvidencePath(path)) return;
    for (const rule of rules) {
      rule.expression.lastIndex = 0;
      const match = rule.expression.exec(content);
      if (match?.index === undefined) continue;
      const lineStart = content.lastIndexOf("\n", match.index - 1) + 1;
      const prefix = content.slice(lineStart, match.index);
      if (rule.id === "BNPM-SEC-002" && /\b(?:echo|printf|console\.(?:log|warn|error))\b/i.test(prefix)) continue;
      findings.push(finding(rule, options.packageName, options.packageVersion, path, content, match.index));
    }
  };
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (["node_modules", ".git", ".bnpm-store.json"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) continue;
      files += 1;
      if (files > maxFiles) throw new Error(`Package analysis exceeds ${maxFiles} files`);
      const size = (await stat(path)).size;
      const displayPath = relative(options.root, path).split(sep).join("/");
      if (passiveEvidencePath(displayPath)) continue;
      const handle = await open(path, "r");
      try {
        const chunks: Buffer[] = []; let position = 0; let overlap = Buffer.alloc(0); const chunkSize = 1024 * 1024;
        while (position < size && bytes < maxBytes) {
          const length = Math.min(chunkSize, size - position, maxBytes - bytes); if (length <= 0) break;
          const chunk = Buffer.allocUnsafe(length); const result = await handle.read(chunk, 0, length, position); if (result.bytesRead === 0) break;
          const content = chunk.subarray(0, result.bytesRead); if (size <= 2 * 1024 * 1024) chunks.push(content); bytes += result.bytesRead;
          scanCapabilities(displayPath, overlap.length === 0 ? content : Buffer.concat([overlap, content]), position === 0);
          overlap = content.subarray(Math.max(0, content.length - 256)); position += result.bytesRead;
        }
        if (position < size) limitedAt ??= displayPath;
        if (position === size && size <= 2 * 1024 * 1024) {
          const content = Buffer.concat(chunks); if (!content.includes(0)) scan(displayPath, content.toString("utf8"));
        }
        if (position === 0) {
          const magic = Buffer.allocUnsafe(Math.min(4, size)); const result = await handle.read(magic, 0, magic.length, 0);
          scanCapabilities(displayPath, magic.subarray(0, result.bytesRead), true);
        }
      } finally { await handle.close(); }
    }
  };
  await walk(options.root);
  if (limitedAt !== undefined) findings.push({
    ruleId: "BNPM-SEC-009",
    severity: "warning",
    packageName: options.packageName,
    packageVersion: options.packageVersion,
    behavior: "Static content inspection reached its bounded scan budget",
    evidence: `Scanned ${bytes} bytes; remaining content starts at or after ${limitedAt}`.slice(0, 160),
    location: { path: limitedAt },
    remediation: "Use package-specific review or sandboxing when complete static inspection is required.",
  });
  const lifecycles: LifecycleFact[] = [];
  for (const stage of options.stages ?? lifecycleStages) {
    const declaredCommand = options.scripts?.[stage];
    let command = declaredCommand;
    let implicitNodeGyp = false;
    if (stage === "install" && declaredCommand === undefined) {
      try {
        implicitNodeGyp = (await stat(join(options.root, "binding.gyp"))).isFile();
        if (implicitNodeGyp) command = "node-gyp rebuild";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!command) continue;
    scan(`package.json#scripts.${stage}`, command);
    const referencedFiles = implicitNodeGyp ? ["binding.gyp"] : referencedCommandFiles(command);
    const referencedContent: Buffer[] = [];
    for (const path of referencedFiles) {
      try {
        const content = await readFile(safeReference(options.root, path));
        referencedContent.push(Buffer.from(`${path}\0`), content, Buffer.from("\0"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        referencedContent.push(Buffer.from(`${path}\0[MISSING]\0`));
        findings.push({
          ruleId: "BNPM-SEC-008",
          severity: "warning",
          packageName: options.packageName,
          packageVersion: options.packageVersion,
          behavior: "Lifecycle command references a file absent from the package",
          evidence: path.slice(0, 160),
          location: { path: `package.json#scripts.${stage}` },
          remediation: "Publish the referenced script or remove the lifecycle command.",
        });
      }
    }
    lifecycles.push({
      packageName: options.packageName,
      packageVersion: options.packageVersion,
      integrity: options.integrity,
      stage,
      command,
      commandHash: hash(command),
      contentHash: hash(Buffer.concat(referencedContent)),
      referencedFiles,
    });
  }
  findings.sort((left, right) => left.ruleId.localeCompare(right.ruleId) || (left.location?.path ?? "").localeCompare(right.location?.path ?? ""));
  const capabilities = [...capabilityEvidence].sort(([left], [right]) => left.localeCompare(right)).map(([kind, value]) => ({ kind, severity: value.severity, packageName: options.packageName, packageVersion: options.packageVersion, behavior: value.behavior, evidence: [...value.evidence].sort() }));
  return { analysis: { packageName: options.packageName, packageVersion: options.packageVersion, integrity: options.integrity, ruleSetVersion: "1", findings }, lifecycles, capabilities };
}
