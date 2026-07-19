import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateRecentRelease } from "../src/security/recent-release.js";

const now = new Date("2026-07-12T12:00:00.000Z");

test("blocks a release inside the configured window", () => {
  const result = evaluateRecentRelease(
    { name: "example", version: "1.0.0", publishedAt: "2026-07-12T11:30:00.000Z" },
    { thresholdHours: 1, now },
  );
  assert.equal(result.status, "blocked");
});

test("allows an older release", () => {
  const result = evaluateRecentRelease(
    { name: "example", version: "1.0.0", publishedAt: "2026-07-12T05:00:00.000Z" },
    { thresholdHours: 6, now },
  );
  assert.equal(result.status, "allowed");
});

test("requires an exact name and version override", () => {
  const release = { name: "example", version: "1.0.0", publishedAt: "2026-07-12T11:30:00.000Z" };
  assert.equal(
    evaluateRecentRelease(release, {
      thresholdHours: 1,
      now,
      allowedExactVersions: new Set(["example@1.0.0"]),
    }).status,
    "allowed",
  );
  assert.equal(
    evaluateRecentRelease(release, {
      thresholdHours: 1,
      now,
      allowedExactVersions: new Set(["example@latest"]),
    }).status,
    "blocked",
  );
});

test("blocks future timestamps and reports missing timestamps", () => {
  assert.equal(
    evaluateRecentRelease(
      { name: "example", version: "1.0.0", publishedAt: "2026-07-13T00:00:00.000Z" },
      { thresholdHours: 1, now },
    ).status,
    "blocked",
  );
  assert.equal(
    evaluateRecentRelease({ name: "example", version: "1.0.0" }, { thresholdHours: 1, now }).status,
    "unknown",
  );
});
