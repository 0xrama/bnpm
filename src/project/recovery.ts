import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

interface LayoutJournal {
  readonly version: 1;
  readonly target: string;
  readonly backup: string;
  readonly prepared: string;
  readonly phase: "prepared" | "backed-up" | "activated";
}

const journalName = ".bnpm-layout-transaction.json";

function journalPath(projectRoot: string): string { return join(projectRoot, journalName); }

function validate(projectRoot: string, journal: LayoutJournal): void {
  if (journal.version !== 1 || journal.target !== join(projectRoot, "node_modules")) throw new Error("Invalid bnpm recovery journal");
  if (dirname(journal.backup) !== projectRoot || !basename(journal.backup).startsWith(".bnpm-node_modules-backup-")) throw new Error("Invalid bnpm recovery backup path");
  if (dirname(dirname(journal.prepared)) !== projectRoot || basename(journal.prepared) !== "node_modules" || !basename(dirname(journal.prepared)).startsWith(".bnpm-install-")) throw new Error("Invalid bnpm prepared layout path");
}

async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }

async function save(path: string, journal: LayoutJournal): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(journal)}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function recoverProjectLayout(projectRoot: string): Promise<void> {
  const path = journalPath(projectRoot);
  let journal: LayoutJournal;
  try { journal = JSON.parse(await readFile(path, "utf8")) as LayoutJournal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  validate(projectRoot, journal);
  const targetExists = await exists(journal.target);
  const backupExists = await exists(journal.backup);
  if (!targetExists && backupExists) await rename(journal.backup, journal.target);
  else if (targetExists && backupExists) await rm(journal.backup, { recursive: true, force: true });
  await rm(dirname(journal.prepared), { recursive: true, force: true });
  await rm(path, { force: true });
}

export async function activateWithRecovery(projectRoot: string, prepared: string): Promise<void> {
  await recoverProjectLayout(projectRoot);
  const target = join(projectRoot, "node_modules");
  const backup = join(projectRoot, `.bnpm-node_modules-backup-${randomUUID()}`);
  const path = journalPath(projectRoot);
  let journal: LayoutJournal = { version: 1, target, backup, prepared, phase: "prepared" };
  await save(path, journal);
  try {
    try { await rename(target, backup); journal = { ...journal, phase: "backed-up" }; await save(path, journal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(prepared, target);
    journal = { ...journal, phase: "activated" }; await save(path, journal);
    await rm(backup, { recursive: true, force: true });
    await rm(path, { force: true });
  } catch (error) {
    await recoverProjectLayout(projectRoot);
    throw error;
  }
}
