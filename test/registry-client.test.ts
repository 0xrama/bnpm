import assert from "node:assert/strict";
import { test } from "node:test";
import { RegistryClient, RegistryError } from "../src/registry/client.js";

test("requests full metadata for a scoped package", async () => {
  let requestedUrl = "";
  const fetchMock: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return Response.json({ name: "@scope/example", "dist-tags": { latest: "1.0.0" }, versions: {} });
  };

  const client = new RegistryClient({ fetch: fetchMock });
  const document = await client.packageDocument("@scope/example");
  assert.equal(document.name, "@scope/example");
  assert.match(requestedUrl, /%40scope%2Fexample$/i);
});

test("rejects invalid registry responses", async () => {
  const fetchMock: typeof fetch = async () => Response.json({ error: "not a packument" });
  const client = new RegistryClient({ fetch: fetchMock });
  await assert.rejects(() => client.packageDocument("example"), RegistryError);
});

test("requires HTTPS registry transport", () => {
  assert.throws(() => new RegistryClient({ registry: new URL("http://registry.example/") }), /HTTPS/);
});

test("bounds metadata bytes and HTTPS redirects", async () => {
  const oversized = new RegistryClient({ maxMetadataBytes: 4, fetch: async () => new Response("12345") });
  await assert.rejects(() => oversized.packageDocument("example"), /4 bytes safety limit/);
  const redirected = new RegistryClient({ fetch: async () => new Response(null, { status: 302, headers: { location: "http://insecure.example/package" } }) });
  await assert.rejects(() => redirected.packageDocument("example"), /HTTPS/);
});

test("default metadata budget accepts Vite-sized packuments and remains bounded", async () => {
  const document = JSON.stringify({ name: "vite", "dist-tags": { latest: "1.0.0" }, versions: {} });
  const accepted = new RegistryClient({ fetch: async () => new Response(document, { headers: { "content-length": String(39 * 1024 * 1024) } }) });
  assert.equal((await accepted.packageDocument("vite")).name, "vite");

  const rejected = new RegistryClient({ fetch: async () => new Response(document, { headers: { "content-length": String(65 * 1024 * 1024) } }) });
  await assert.rejects(() => rejected.packageDocument("vite"), /64 MiB safety limit/);
});
