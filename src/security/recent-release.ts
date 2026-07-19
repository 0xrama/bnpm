import type { RecentReleaseHours } from "../config/types.js";

export interface ReleaseIdentity {
  name: string;
  version: string;
  publishedAt?: string;
}

export interface RecentReleaseDecision {
  identity: string;
  status: "allowed" | "blocked" | "unknown";
  ageMilliseconds?: number;
  thresholdHours: RecentReleaseHours;
  reason: string;
}

export interface RecentReleasePolicy {
  thresholdHours: RecentReleaseHours;
  now?: Date;
  allowedExactVersions?: ReadonlySet<string>;
}

export function evaluateRecentRelease(
  release: ReleaseIdentity,
  policy: RecentReleasePolicy,
): RecentReleaseDecision {
  const identity = `${release.name}@${release.version}`;
  const base = { identity, thresholdHours: policy.thresholdHours };

  if (!release.publishedAt) {
    return { ...base, status: "unknown", reason: "Registry metadata has no publication timestamp" };
  }

  const publishedAt = Date.parse(release.publishedAt);
  if (!Number.isFinite(publishedAt)) {
    return { ...base, status: "unknown", reason: "Registry publication timestamp is invalid" };
  }

  const ageMilliseconds = (policy.now ?? new Date()).getTime() - publishedAt;
  const thresholdMilliseconds = policy.thresholdHours * 60 * 60 * 1_000;
  const isRecent = ageMilliseconds < thresholdMilliseconds;

  if (!isRecent) {
    return { ...base, status: "allowed", ageMilliseconds, reason: "Release is older than the configured window" };
  }

  if (policy.allowedExactVersions?.has(identity)) {
    return { ...base, status: "allowed", ageMilliseconds, reason: "Exact recent version was explicitly allowed" };
  }

  return {
    ...base,
    status: "blocked",
    ageMilliseconds,
    reason: ageMilliseconds < 0 ? "Publication timestamp is in the future" : "Release is inside the configured window",
  };
}
