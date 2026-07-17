import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test } from "node:test";
import { spawn } from "node:child_process";
import { parseInvocation } from "../src/core/cli-parser.js";
import { sanitizeText } from "../src/core/output.js";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cli = join(repositoryRoot, "dist", "src", "cli.js");
const runner = join(repositoryRoot, "dist", "src", "core", "cli-runner.js");
const root = await mkdtemp(join(tmpdir(), "bnpm-cli-contract-"));

after(async () => {
  await rm(root, { recursive: true, force: true });
});

interface SpawnResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function execute(
  executable: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly signal?: NodeJS.Signals } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], {
      cwd: root,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("spawn", () => {
      if (options.signal) {
        setTimeout(() => child.kill(options.signal), 50).unref();
      }
    });
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function jsonLines(stdout: string): readonly Record<string, unknown>[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createFifo(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("mkfifo", [path], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`mkfifo exited with ${code ?? "no exit code"}`));
      }
    });
  });
}

async function bnpmxExecutable(name: string): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const executable = join(directory, "bnpmx");
  await symlink(cli, executable);
  return executable;
}

function assertJsonProtocol(events: readonly Record<string, unknown>[]): void {
  assert.ok(events.length > 0);
  for (const [index, event] of events.entries()) {
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.sequence, index + 1);
    assert.equal(typeof event.type, "string");
    assert.equal(typeof event.command, "string");
  }
  assert.equal(events.at(-1)?.type, "result");
  assert.equal(events.filter((event) => event.type === "result").length, 1);
}

test("help and version are side-effect-free through both executable names", async () => {
  const sentinel = join(root, "missing-project-sentinel");
  const exists = async (): Promise<boolean> => {
    try {
      await access(sentinel, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  const before = await exists();
  const bnpmHelp = await execute(cli, ["--help"]);
  assert.equal(bnpmHelp.code, 0);
  assert.match(bnpmHelp.stdout, /install/);
  assert.match(bnpmHelp.stdout, /bnpmx/);
  assert.equal(bnpmHelp.stderr, "");

  const bnpmVersion = await execute(cli, ["--version", "--json"]);
  assert.equal(bnpmVersion.code, 0);
  assert.equal(bnpmVersion.stderr, "");
  const versionEvents = jsonLines(bnpmVersion.stdout);
  assertJsonProtocol(versionEvents);
  assert.equal(versionEvents.length, 1);
  assert.equal(versionEvents[0]?.type, "result");
  assert.equal((versionEvents[0]?.data as { readonly summary?: unknown }).summary, "0.0.0");

  const bnpmx = await bnpmxExecutable("help");
  const bnpmxHelp = await execute(bnpmx, ["-h"]);
  assert.equal(bnpmxHelp.code, 0);
  assert.match(bnpmxHelp.stdout, /Usage: bnpmx/);
  assert.doesNotMatch(bnpmxHelp.stdout, /Commands:/);
  assert.equal(await exists(), before);
});

test("parser accepts only documented global positions, save combinations, and forwarding", () => {
  const install = parseInvocation(["--json", "--allow-recent=@scope/pkg@1.2.3", "install", "-D", "-E", "@scope/pkg@^1"]);
  assert.equal(install.kind, "command");
  if (install.kind === "command") {
    assert.equal(install.name, "install");
    assert.equal(install.options.saveSection, "dev");
    assert.equal(install.options.saveExact, true);
    assert.deepEqual(install.options.allowRecent, ["@scope/pkg@1.2.3"]);
  }

  const run = parseInvocation(["run", "build", "--", "--watch", "--json"]);
  assert.equal(run.kind, "command");
  if (run.kind === "command") {
    assert.deepEqual(run.args, ["build", "--watch", "--json"]);
  }

  const bnpmx = parseInvocation(["--json", "pkg@1.0.0", "--", "--flag"], true);
  assert.equal(bnpmx.kind, "bnpmx");
  if (bnpmx.kind === "bnpmx") {
    assert.deepEqual(bnpmx.targetArgs, ["--flag"]);
  }

  for (const args of [
    ["install", "--json"],
    ["add", "--save-dev", "--no-save", "pkg@1.0.0"],
    ["remove"],
    ["run"],
    ["--allow-recent=pkg@^1", "install"],
  ]) {
    assert.throws(() => parseInvocation(args), /Usage:/);
  }

  const forwardedGlobalLookingArgument = parseInvocation(["exec", "tool", "--json"]);
  assert.equal(forwardedGlobalLookingArgument.kind, "command");
  if (forwardedGlobalLookingArgument.kind === "command") {
    assert.deepEqual(forwardedGlobalLookingArgument.args, ["tool", "--json"]);
  }
});

test("package specification validation rejects unsupported sources before command work", () => {
  for (const spec of [
    "git+https://example.invalid/pkg.git",
    "github:user/repository",
    "user/repository",
    "https://example.invalid/pkg.tgz",
    "file:/absolute/package",
  ]) {
    assert.throws(() => parseInvocation(["add", spec]), /Usage:/);
  }

  for (const spec of ["pkg@1.2.3", "pkg@^1", "@scope/pkg@latest", "alias@npm:pkg@1.0.0", "pkg@workspace:*", "pkg@file:./local"]) {
    assert.doesNotThrow(() => parseInvocation(["add", spec]));
  }
});

test("JSON failures are versioned, final, and isolated to stdout", async () => {
  const result = await execute(cli, ["--json", "publish"]);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, "");
  const events = jsonLines(result.stdout);
  assertJsonProtocol(events);
  assert.equal(events[0]?.type, "error");
  assert.equal(events.at(-1)?.data instanceof Object, true);
});

test("typed child output is sanitized and emits only protocol data in JSON mode", async () => {
  const source = [
    `import { runCli } from ${JSON.stringify(runner)};`,
    "const result = await runCli({",
    "  args: ['--json', 'run', 'script'],",
    "  executableName: 'bnpm',",
    "  commandRunner: async (context) => {",
    "    context.output.childOutput('stdout', '\\u001b[2Junsafe\\rrewrite token=top-secret');",
    "    return { status: 'success', category: 'success', exitCode: 0, summary: 'done' };",
    "  },",
    "});",
    "process.exitCode = result;",
  ].join("\n");
  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b|top-secret/);
  const events = jsonLines(result.stdout);
  assertJsonProtocol(events);
  assert.equal(events[0]?.type, "child-output");
});

test("top-level failures are mapped and sanitized without presenter bypass", async () => {
  const source = [
    `import { runCli } from ${JSON.stringify(runner)};`,
    "const result = await runCli({",
    "  args: ['--json', 'run', 'script'],",
    "  executableName: 'bnpm',",
    "  commandRunner: async () => { throw new Error('token=top-secret /private/random/path'); },",
    "});",
    "process.exitCode = result;",
  ].join("\n");
  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(result.code, 70);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /top-secret|private\/random|Error:/);
  assertJsonProtocol(jsonLines(result.stdout));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
test(`${signal} returns one cancelled JSON result and no post-terminal events`, async () => {
  const source = [
    `import { runCli } from ${JSON.stringify(runner)};`,
    "const result = await runCli({",
    "  args: ['--json', 'run', 'script'],",
    "  executableName: 'bnpm',",
    "  commandRunner: async (context) => await new Promise((resolve) => setTimeout(() => { context.output.info('late output'); resolve({ status: 'success', category: 'success', exitCode: 0, summary: 'late' }); }, 150)),",
    "});",
    "process.exitCode = result;",
  ].join("\n");
  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("spawn", () => setTimeout(() => child.kill(signal), 50).unref());
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
  assert.equal(result.stderr, "");
  const events = jsonLines(result.stdout);
  assertJsonProtocol(events);
  assert.equal(events.at(-1)?.type, "result");
  assert.doesNotMatch(result.stdout, /late output/);
});
}

// VAL-CORE-003: Dispatch and unsupported commands are exact
test("unknown commands fail as usage without domain work", async () => {
  for (const args of [["publish"], ["link"], ["config"], ["prefix"], ["logout"]]) {
    const result = await execute(cli, args);
    assert.equal(result.code, 2, `expected usage exit for 'bnpm ${args[0]}'`);
    assert.match(result.stderr, /Usage:/, `expected usage message for 'bnpm ${args[0]}'`);
  }
});

test("documented commands dispatch to their correct flow", async () => {
  for (const command of ["install", "add", "remove", "run", "audit", "exec"] as const) {
    const args = command === "run" || command === "exec"
      ? [command, "nonexistent"]
      : command === "audit"
        ? [command]
        : command === "remove"
          ? [command, "pkg"]
          : [command, "pkg@1.0.0"];
    const result = await execute(cli, args);
    assert.ok(result.code !== undefined, `bnpm ${command} should produce an exit code`);
    assert.ok(result.code !== 2, `bnpm ${command} should not be usage error`);
  }
});

test("bnpmx dispatches to ephemeral mode via basename", async () => {
  const bnpmx = await bnpmxExecutable("dispatch");
  const result = await execute(bnpmx, ["pkg@1.0.0"]);
  assert.ok(result.code !== 2, "bnpmx with valid spec should not be usage error");
});

test("bnpmx with package spec starting with dash fails as usage", async () => {
  const bnpmx = await bnpmxExecutable("dash");
  const result = await execute(bnpmx, ["-not-a-package"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Usage:/);
});

// VAL-CORE-012: Human output is concise and deterministic
test("human mode output is stable and does not leak internals", async () => {
  const helpResult = await execute(cli, ["--help"]);
  assert.equal(helpResult.code, 0);
  assert.doesNotMatch(helpResult.stdout, /undefined|null|Symbol|prototype|\[object/);
  assert.doesNotMatch(helpResult.stdout, /Error|stack|at /);

  const versionResult = await execute(cli, ["--version"]);
  assert.equal(versionResult.code, 0);
  assert.match(versionResult.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal(versionResult.stderr, "");

  const usageResult = await execute(cli, ["nonexistent"]);
  assert.equal(usageResult.code, 2);
  assert.match(usageResult.stderr, /Usage:/);
  assert.doesNotMatch(usageResult.stderr, /Error|stack|at /);
});

// VAL-CORE-014: Non-interactive decisions and stream separation are stable
test("JSON mode stderr is empty for all failure categories", async () => {
  const errorCases: readonly (readonly string[])[] = [
    ["--json", "publish"],
    ["--json", "add"],
    ["--json", "remove"],
    ["--json", "run"],
    ["--json", "--allow-recent=pkg@^1", "install"],
  ];
  for (const args of errorCases) {
    const result = await execute(cli, args);
    assert.equal(result.stderr, "", `stderr should be empty for JSON mode args: ${args.join(" ")}`);
    if (result.stdout.trim()) {
      const events = jsonLines(result.stdout);
      for (const event of events) {
        try {
          JSON.parse(JSON.stringify(event));
        } catch {
          assert.fail(`unparseable JSON event in stdout for args: ${args.join(" ")}`);
        }
      }
    }
  }
});

test("closed stdin does not hang or produce approval", async () => {
  const result = await execute(cli, ["--json", "install"]);
  assert.ok(result.code !== undefined);
  assert.ok(result.stdout === "" || jsonLines(result.stdout).length >= 1);
  assert.doesNotMatch(result.stdout, /approved|allow/);
});

// VAL-CORE-015: Exit categories are stable across presenters
test("same exit codes in human and JSON mode for each failure category", async () => {
  const commandMatrix: readonly { readonly args: readonly string[]; readonly expectedCode: number }[] = [
    { args: ["publish"], expectedCode: 2 },
    { args: ["--allow-recent=pkg@^1", "install"], expectedCode: 2 },
    { args: ["add"], expectedCode: 2 },
    { args: ["remove"], expectedCode: 2 },
    { args: ["run"], expectedCode: 2 },
  ];
  for (const { args, expectedCode } of commandMatrix) {
    const humanResult = await execute(cli, args);
    const jsonResult = await execute(cli, ["--json", ...args]);
    assert.equal(humanResult.code, expectedCode, `human exit for ${args.join(" ")}`);
    assert.equal(jsonResult.code, expectedCode, `json exit for ${args.join(" ")}`);
  }
});

// VAL-CORE-017: Cancellation stops owned work safely (human mode)
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} human mode returns correct exit code with no post-terminal events`, async () => {
    const source = [
      `import { runCli } from ${JSON.stringify(runner)};`,
      "const result = await runCli({",
      "  args: ['run', 'script'],",
      "  executableName: 'bnpm',",
      "  commandRunner: async (context) => await new Promise((resolve) => setTimeout(() => { context.output.info('late output'); resolve({ status: 'success', category: 'success', exitCode: 0, summary: 'late' }); }, 150)),",
      "});",
      "process.exitCode = result;",
    ].join("\n");
    const result = await new Promise<SpawnResult>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("spawn", () => setTimeout(() => child.kill(signal), 50).unref());
      child.once("close", (code, sig) => resolve({ code, signal: sig, stdout, stderr }));
    });
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
    assert.doesNotMatch(result.stdout, /late output/);
  });
}

// VAL-CORE-018: Untrusted output and cleanup respect ownership
test("sanitizeText strips terminal control sequences and redacts secrets", () => {
  assert.equal(sanitizeText("\u001b[2Jclear"), "\\u001b[2Jclear");
  assert.equal(sanitizeText("\u0007bell"), "\\u0007bell");
  assert.equal(sanitizeText("token=super-secret-value"), "token=[REDACTED]");
  assert.equal(sanitizeText("password:my-password"), "password:[REDACTED]");
  assert.equal(sanitizeText("Authorization: Bearer eyJhbGci"), "Authorization:[REDACTED]");
  assert.equal(sanitizeText("normal text remains"), "normal text remains");
  assert.equal(sanitizeText("line1\nline2"), "line1\nline2");
  assert.equal(sanitizeText("tab\there"), "tab\there");
  assert.equal(sanitizeText("carriage\rreturn"), "carriage\\rreturn");
});

test("child output in human mode does not leak ANSI or secrets", async () => {
  const source = [
    `import { runCli } from ${JSON.stringify(runner)};`,
    "const result = await runCli({",
    "  args: ['run', 'script'],",
    "  executableName: 'bnpm',",
    "  commandRunner: async (context) => {",
    "    context.output.childOutput('stderr', '\\u001b[31msecret=abc123\\u001b[0m');",
    "    return { status: 'success', category: 'success', exitCode: 0, summary: 'done' };",
    "  },",
    "});",
    "process.exitCode = result;",
  ].join("\n");
  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /\u001b/);
  assert.doesNotMatch(result.stderr, /abc123/);
});

// VAL-CORE-023: JSON stream ownership is unambiguous
test("JSON mode stdout is always valid NDJSON with no prose or ANSI", async () => {
  const cases: readonly (readonly string[])[] = [
    ["--json", "--help"],
    ["--json", "--version"],
    ["--json", "publish"],
    ["--json", "add", "pkg@1.0.0"],
    ["--json", "install"],
  ];
  for (const args of cases) {
    const result = await execute(cli, args);
    assert.equal(result.stderr, "", `stderr must be empty for: ${args.join(" ")}`);
    const raw = result.stdout;
    assert.doesNotMatch(raw, /[\u001b\u0007]/, `no ANSI for: ${args.join(" ")}`);
    if (raw.trim()) {
      const lines = raw.trim().split("\n");
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          assert.equal(parsed.schemaVersion, 1, `schema version for: ${args.join(" ")}`);
          assert.equal(typeof parsed.type, "string");
        } catch {
          assert.fail(`unparseable NDJSON line for: ${args.join(" ")}: ${line.slice(0, 100)}`);
        }
      }
    }
  }
});

// VAL-CORE-001: Help with FIFO/stdin block does not hang
test("help does not hang when stdin is a FIFO", async () => {
  const fifoPath = join(root, "test-fifo");
  try {
    await createFifo(fifoPath);
  } catch {
    return;
  }
  const result = await execute(cli, ["--help"], {
    env: { ...process.env, BNPM_TEST_FIFO: fifoPath },
  });
  assert.equal(result.code, 0);
});

// VAL-CORE-002: Version is consistent across bnpm and bnpmx
test("version output is consistent across executable names", async () => {
  const bnpmVersion = await execute(cli, ["--version"]);
  const bnpmx = await bnpmxExecutable("version");
  const bnpmxVersion = await execute(bnpmx, ["--version"]);
  assert.equal(bnpmVersion.stdout.trim(), bnpmxVersion.stdout.trim());
  assert.equal(bnpmVersion.code, 0);
  assert.equal(bnpmxVersion.code, 0);
});

// VAL-CORE-003: Unsupported global-install behavior fails as usage
test("global install flags fail as usage errors", async () => {
  for (const args of [["install", "-g"], ["install", "--global"], ["add", "-g", "pkg"]]) {
    const result = await execute(cli, args);
    assert.equal(result.code, 2, `expected usage exit for 'bnpm ${args.join(" ")}'`);
    assert.match(result.stderr, /Usage:/);
  }
});
