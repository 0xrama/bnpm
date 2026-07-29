import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

interface LegacyLayoutJournal {
  readonly version: 1;
  readonly target: string;
  readonly backup: string;
  readonly prepared: string;
  readonly phase: "prepared" | "backed-up" | "activated";
}

interface TransactionTarget {
  readonly target: string;
  readonly backup: string;
  readonly prepared: string;
}

interface InstallationJournal {
  readonly version: 2;
  readonly targets: readonly TransactionTarget[];
}

export interface PreparedInstallationTarget {
  readonly target: string;
  readonly prepared: string;
}

const journalName = ".bnpm-layout-transaction.json";

function journalPath(projectRoot: string): string { return join(projectRoot, journalName); }

function confined(projectRoot: string, path: string): boolean {
  const value = relative(projectRoot, path);
  return value !== "" && !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`);
}

function validateLegacy(projectRoot: string, journal: LegacyLayoutJournal): void {
  if (journal.version !== 1 || journal.target !== join(projectRoot, "node_modules")) throw new Error("Invalid bnpm recovery journal");
  if (dirname(journal.backup) !== projectRoot || !basename(journal.backup).startsWith(".bnpm-node_modules-backup-")) throw new Error("Invalid bnpm recovery backup path");
  if (dirname(dirname(journal.prepared)) !== projectRoot || basename(journal.prepared) !== "node_modules" || !basename(dirname(journal.prepared)).startsWith(".bnpm-install-")) throw new Error("Invalid bnpm prepared layout path");
}

function validateTransaction(projectRoot: string, journal: InstallationJournal): void {
  if (journal.version !== 2 || !Array.isArray(journal.targets) || journal.targets.length === 0) throw new Error("Invalid bnpm recovery journal");
  for (const entry of journal.targets) {
    if (!confined(projectRoot, entry.target) || !confined(projectRoot, entry.backup) || !confined(projectRoot, entry.prepared)) throw new Error(`Invalid bnpm transaction path: target=${entry.target} backup=${entry.backup} prepared=${entry.prepared} root=${projectRoot}`);
    if (dirname(entry.backup) !== dirname(entry.target) || !basename(entry.backup).startsWith(".bnpm-backup-")) throw new Error("Invalid bnpm transaction backup");
    const preparedRelative = relative(projectRoot, entry.prepared);
    if (!preparedRelative.split(sep)[0]?.startsWith(".bnpm-install-")) throw new Error("Invalid bnpm prepared transaction path");
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function save(path: string, journal: LegacyLayoutJournal | InstallationJournal): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(journal)}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

async function recoverTransaction(projectRoot: string, journal: InstallationJournal): Promise<void> {
  validateTransaction(projectRoot, journal);
  for (const entry of [...journal.targets].reverse()) {
    const targetExists = await exists(entry.target);
    const backupExists = await exists(entry.backup);
    const preparedExists = await exists(entry.prepared);
    if (backupExists) {
      if (targetExists) await rm(entry.target, { recursive: true, force: true });
      await rename(entry.backup, entry.target);
    } else if (!preparedExists && targetExists) {
      await rm(entry.target, { recursive: true, force: true });
    }
    if (preparedExists) await rm(entry.prepared, { recursive: true, force: true });
  }
}

export async function recoverProjectLayout(projectRoot: string): Promise<void> {
  const path = journalPath(projectRoot);
  let journal: LegacyLayoutJournal | InstallationJournal;
  try { journal = JSON.parse(await readFile(path, "utf8")) as LegacyLayoutJournal | InstallationJournal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (journal.version === 1) {
    validateLegacy(projectRoot, journal);
    const targetExists = await exists(journal.target);
    const backupExists = await exists(journal.backup);
    if (!targetExists && backupExists) await rename(journal.backup, journal.target);
    else if (targetExists && backupExists) await rm(journal.backup, { recursive: true, force: true });
    await rm(dirname(journal.prepared), { recursive: true, force: true });
  } else {
    await recoverTransaction(projectRoot, journal);
  }
  await rm(path, { force: true });
}

export async function activateInstallationWithRecovery(projectRoot: string, preparedTargets: readonly PreparedInstallationTarget[]): Promise<void> {
  await recoverProjectLayout(projectRoot);
  if (preparedTargets.length === 0) throw new Error("Installation transaction has no targets");
  const targets = preparedTargets.map(({ target, prepared }) => ({ target, prepared, backup: join(dirname(target), `.bnpm-backup-${randomUUID()}`) }));
  const journal: InstallationJournal = { version: 2, targets };
  validateTransaction(projectRoot, journal);
  const path = journalPath(projectRoot);
  await save(path, journal);
  try {
    for (const entry of targets) {
      try { await rename(entry.target, entry.backup); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const entry of targets) await rename(entry.prepared, entry.target);
    await rm(path, { force: true });
    await Promise.allSettled(targets.map((entry) => rm(entry.backup, { recursive: true, force: true })));
  } catch (error) {
    await recoverTransaction(projectRoot, journal);
    await rm(path, { force: true });
    throw error;
  }
}
