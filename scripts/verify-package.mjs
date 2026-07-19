import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "bnpm-package-verification-"));

async function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise(output.trim()) : reject(new Error(`${command} exited with ${code}: ${output.trim()}`)));
  });
}

try {
  const packOutput = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], repository));
  const filename = packOutput?.[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not report an artifact filename");
  const consumer = join(root, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), '{"name":"bnpm-package-consumer","private":true}\n');
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(root, filename)], consumer);
  const executable = process.platform === "win32" ? join(consumer, "node_modules", ".bin", "bnpm.cmd") : join(consumer, "node_modules", ".bin", "bnpm");
  const version = await run(executable, ["--version"], consumer);
  const expected = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(repository, "package.json"), "utf8"))).version;
  if (version !== expected) throw new Error(`installed bnpm reported ${version}, expected ${expected}`);
  process.stdout.write(`verified ${filename} with bnpm ${version}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
