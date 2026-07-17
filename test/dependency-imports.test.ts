import assert from "node:assert/strict";
import { test } from "node:test";
import semver from "semver";
import npa from "npm-package-arg";
import * as tar from "tar-stream";

test("approved dependency imports are available through strict ESM", () => {
  assert.equal(semver.satisfies("1.2.3", "^1.0.0"), true);

  const parsed = npa("@scope/package@1.2.3");
  assert.equal(parsed.name, "@scope/package");
  assert.equal(parsed.rawSpec, "1.2.3");

  assert.equal(typeof tar.extract, "function");
  assert.equal(typeof tar.pack, "function");
});
