export const recentReleaseHours = [1, 6, 24] as const;
export type RecentReleaseHours = (typeof recentReleaseHours)[number];

export interface BnpmConfig {
  recentReleaseHours: RecentReleaseHours;
  trustedPackages: Readonly<Record<string, TrustedPackageApproval>>;
}

export interface TrustedPackageApproval {
  version: string;
  integrity: string;
  scripts: Readonly<Record<string, { commandHash: string; contentHash: string }>>;
}

export const defaultConfig: BnpmConfig = {
  recentReleaseHours: 1,
  trustedPackages: {},
};
