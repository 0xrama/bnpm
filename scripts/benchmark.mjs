import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "bnpm-benchmark-"));
const manifest = JSON.stringify({
  name: "bnpm-benchmark",
  private: true,
  dependencies: {
    "npm-package-arg": "13.0.2",
    semver: "7.8.5",
    "tar-stream": "3.2.0",
    yaml: "2.9.0",
  },
}, null, 2) + "\n";

async function run(command, args, options) {
  const started = process.hrtime.bigint();
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostic = "";
    const collect = (chunk) => {
      if (diagnostic.length < 16_384) diagnostic += chunk.toString("utf8").slice(0, 16_384 - diagnostic.length);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}: ${diagnostic.trim() || "no diagnostic output"}`)));
  });
  void result;
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function writable(path) {
  try {
    await chmod(path, 0o755);
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(path, entry.name));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const candidates = [
  {
    name: "bnpm",
    command: process.execPath,
    args: [join(repository, "dist", "src", "cli.js"), "install"],
    environment: (cache) => ({ BNPM_CACHE_HOME: cache, CI: "1" }),
  },
  {
    name: "pnpm",
    command: "pnpm",
    args: ["install", "--ignore-scripts", "--reporter=silent"],
    environment: (cache) => ({ PNPM_HOME: join(cache, "home"), XDG_CACHE_HOME: join(cache, "xdg-cache"), npm_config_cache: join(cache, "npm-cache"), npm_config_store_dir: join(cache, "store") }),
  },
  {
    name: "npm",
    command: "npm",
    args: ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"],
    environment: (cache) => ({ npm_config_cache: cache }),
  },
];

const results = [];
try {
  for (const candidate of candidates) {
    const project = join(root, candidate.name, "project");
    const cache = join(root, candidate.name, "cache");
    await mkdir(project, { recursive: true });
    await mkdir(cache, { recursive: true });
    await writeFile(join(project, "package.json"), manifest);
    const cold = await run(candidate.command, candidate.args, { cwd: project, env: candidate.environment(cache) });
    const warmRuns = [];
    for (let iteration = 0; iteration < 3; iteration += 1) warmRuns.push(await run(candidate.command, candidate.args, { cwd: project, env: candidate.environment(cache) }));
    results.push({ manager: candidate.name, coldMilliseconds: Math.round(cold), warmMedianMilliseconds: Math.round(median(warmRuns)), warmRunsMilliseconds: warmRuns.map(Math.round) });
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, node: process.version, packages: Object.keys(JSON.parse(manifest).dependencies), results }, null, 2)}\n`);
} finally {
  await writable(root);
  await rm(root, { recursive: true, force: true });
}
