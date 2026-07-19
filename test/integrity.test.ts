import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { IntegrityError, selectExpectedIntegrity, verifyBufferIntegrity } from "../src/security/integrity.js";

const content = Buffer.from("verified package tarball");
const sha512 = `sha512-${createHash("sha512").update(content).digest("base64")}`;

test("verifies a matching strong integrity digest", () => {
  assert.equal(verifyBufferIntegrity(content, sha512).algorithm, "sha512");
});

test("rejects modified package content", () => {
  assert.throws(() => verifyBufferIntegrity(Buffer.from("modified"), sha512), IntegrityError);
});

test("selects the strongest supported digest", () => {
  const sha256 = `sha256-${createHash("sha256").update(content).digest("base64")}`;
  assert.equal(selectExpectedIntegrity(`${sha256} ${sha512}`).algorithm, "sha512");
});

test("rejects weak-only integrity metadata", () => {
  assert.throws(() => selectExpectedIntegrity("sha1-ZmFrZQ=="), /No supported strong integrity/);
});
