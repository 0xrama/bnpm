import assert from "node:assert/strict";
import test from "node:test";
import { packageNavigationUrl } from "../src/commands/navigation.js";

test("package navigation normalizes repository links and rejects unsafe browser targets", () => {
  const metadata = { repository: { type: "git", url: "git+ssh://git@github.com/example/tool.git" }, homepage: "https://example.test/tool", bugs: { url: "https://github.com/example/tool/issues?q=open" } };
  assert.equal(packageNavigationUrl(metadata, "repo", "tool").href, "https://github.com/example/tool");
  assert.equal(packageNavigationUrl(metadata, "docs", "tool").href, "https://example.test/tool");
  assert.equal(packageNavigationUrl(metadata, "bugs", "tool").href, "https://github.com/example/tool/issues?q=open");
  assert.equal(packageNavigationUrl({}, "docs", "@scope/tool").href, "https://www.npmjs.com/package/%40scope%2Ftool");
  assert.throws(() => packageNavigationUrl({ homepage: "http://example.test" }, "docs", "tool"), /HTTPS/);
  assert.throws(() => packageNavigationUrl({ bugs: "https://user:secret@example.test" }, "bugs", "tool"), /credentials/);
});
