import type { TrustedPackageApproval } from "../config/types.js";
import type { AnalyzedPackage, LifecycleFact } from "./analyzer.js";

export interface PackagePolicyDecision {
  readonly packageId: string;
  readonly identity: string;
  readonly blocked: boolean;
  readonly approvedLifecycles: readonly LifecycleFact[];
  readonly skippedLifecycles: readonly LifecycleFact[];
  readonly reasons: readonly string[];
}

export function decidePackagePolicy(options: {
  readonly analyzed: AnalyzedPackage;
  readonly allowedDangerous: ReadonlySet<string>;
  readonly trustedApproval?: TrustedPackageApproval;
  readonly packageId?: string;
}): PackagePolicyDecision {
  const identity = `${options.analyzed.analysis.packageName}@${options.analyzed.analysis.packageVersion}`;
  const dangerous = options.analyzed.analysis.findings.filter((finding) => finding.severity === "dangerous");
  const blocked = dangerous.length > 0 && !options.allowedDangerous.has(identity);
  const approvedLifecycles: LifecycleFact[] = [];
  const skippedLifecycles: LifecycleFact[] = [];
  for (const lifecycle of options.analyzed.lifecycles) {
    const trusted = options.trustedApproval;
    const stage = trusted?.scripts[lifecycle.stage];
    if (
      trusted?.version === lifecycle.packageVersion &&
      trusted.integrity === lifecycle.integrity &&
      stage?.commandHash === lifecycle.commandHash &&
      stage.contentHash === lifecycle.contentHash
    ) approvedLifecycles.push(lifecycle);
    else skippedLifecycles.push(lifecycle);
  }
  const reasons = [
    ...(blocked ? [`${dangerous.length} dangerous finding${dangerous.length === 1 ? "" : "s"} require an exact override`] : []),
    ...(skippedLifecycles.length > 0 ? [`${skippedLifecycles.length} lifecycle script${skippedLifecycles.length === 1 ? "" : "s"} lack an exact trusted approval`] : []),
  ];
  return { packageId: options.packageId ?? identity, identity, blocked, approvedLifecycles, skippedLifecycles, reasons };
}
