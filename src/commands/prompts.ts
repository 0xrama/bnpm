import { createInterface } from "node:readline/promises";
import { detectInteractiveMode } from "../config/interactive.js";
import type { InstallPrompts } from "../installer/install.js";
import type { CommandOptions } from "../core/cli-parser.js";
import type { AnalyzedPackage, LifecycleFact } from "../security/analyzer.js";
import type { RecentReleaseDecision } from "../security/recent-release.js";

async function ask(question: string): Promise<string | undefined> {
  const readline = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try { return (await readline.question(question)).trim(); }
  catch { return undefined; }
  finally { readline.close(); }
}

const yes = (value: string | undefined): boolean => value?.toLowerCase() === "y" || value?.toLowerCase() === "yes";

export function commandInstallPrompts(options: CommandOptions, beforePrompt: () => void = () => {}): InstallPrompts {
  const mode = detectInteractiveMode({ json: options.json, environment: process.env, stdinIsTTY: process.stdin.isTTY, stderrIsTTY: process.stderr.isTTY, promptAvailable: true });
  const prompt = (question: string): Promise<string | undefined> => { beforePrompt(); return ask(question); };
  return {
    mode,
    ...(mode.interactive ? {
      selectRecencyHours: () => prompt("Choose recent-release warning window in hours [1/6/24] (default 1): "),
      allowRecent: (decision: RecentReleaseDecision) => prompt(`${decision.identity}: ${decision.reason}. Install this recently published package? [y/N] `).then(yes),
      allowDangerous: (analyzed: AnalyzedPackage) => {
        const identity = `${analyzed.analysis.packageName}@${analyzed.analysis.packageVersion}`;
        const rules = analyzed.analysis.findings.filter((finding) => finding.severity === "dangerous").map((finding) => finding.ruleId).join(", ");
        return prompt(`${identity} has dangerous findings (${rules}). Override and continue? [y/N] `).then(yes);
      },
      approveLifecycle: (fact: LifecycleFact) => prompt(
        `${fact.packageName}@${fact.packageVersion} wants to run ${fact.stage}: ${fact.command}\n` +
        "This command is NOT sandboxed and will run with your normal operating-system permissions. Approve once? [y/N] ",
      ).then(yes),
    } : {}),
  };
}

export async function confirmCommand(question: string, options: Pick<CommandOptions, "json" | "yes">): Promise<boolean> {
  if (options.yes === true) return true;
  const mode = detectInteractiveMode({ json: options.json, environment: process.env, stdinIsTTY: process.stdin.isTTY, stderrIsTTY: process.stderr.isTTY, promptAvailable: true });
  if (!mode.interactive) return false;
  return yes(await ask(`${question} [y/N] `));
}

export async function readSecret(question: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || typeof process.stdin.setRawMode !== "function") return undefined;
  process.stderr.write(question);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  return new Promise<string | undefined>((resolvePromise) => {
    const finish = (result: string | undefined): void => {
      process.stdin.off("data", data);
      signal?.removeEventListener("abort", aborted);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write("\n");
      resolvePromise(result);
    };
    const aborted = (): void => { finish(undefined); };
    const data = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") { finish(value); return; }
        if (character === "\u0003") { finish(undefined); return; }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " " && value.length < 1024) value += character;
      }
    };
    process.stdin.on("data", data);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) finish(undefined);
  });
}

export async function readInput(question: string, json: boolean): Promise<string | undefined> {
  const mode = detectInteractiveMode({ json, environment: process.env, stdinIsTTY: process.stdin.isTTY, stderrIsTTY: process.stderr.isTTY, promptAvailable: true });
  return mode.interactive ? ask(question) : undefined;
}
