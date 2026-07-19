import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const marker = ".bnpm-install-invalidated";

export async function invalidateInstalledLayout(projectRoot: string, reason: string): Promise<void> {
  await writeFile(join(projectRoot, marker), `${JSON.stringify({ version: 1, reason })}\n`, { mode: 0o600 });
}

export async function installedLayoutIsInvalidated(projectRoot: string): Promise<boolean> {
  try { await access(join(projectRoot, marker)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function clearInstalledLayoutInvalidation(projectRoot: string): Promise<void> {
  await rm(join(projectRoot, marker), { force: true });
}
