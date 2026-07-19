export type FindingSeverity = "notice" | "warning" | "dangerous";

export interface SourceLocation {
  path: string;
  line?: number;
  column?: number;
}

export interface SecurityFinding {
  ruleId: string;
  severity: FindingSeverity;
  packageName: string;
  packageVersion: string;
  behavior: string;
  evidence: string;
  location?: SourceLocation;
  remediation?: string;
}

export interface PackageAnalysis {
  packageName: string;
  packageVersion: string;
  integrity: string;
  ruleSetVersion: string;
  findings: readonly SecurityFinding[];
}
