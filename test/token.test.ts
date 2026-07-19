import assert from "node:assert/strict";
import test from "node:test";
import type { CommandOptions } from "../src/core/cli-parser.js";
import { tokenCreationBody } from "../src/commands/token.js";

const base: CommandOptions = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false };

test("token creation builds bounded npm-compatible granular access bodies", () => {
  assert.deepEqual(tokenCreationBody({ ...base, tokenName: "release", tokenDescription: "CI release", tokenExpires: 30, tokenPackages: ["@scope/pkg"], tokenScopes: ["@scope"], tokenOrganizations: ["acme"], tokenPackagesPermission: "read-write", tokenOrganizationsPermission: "read-only", tokenCidrs: ["192.0.2.0/24"], tokenBypass2fa: true }), {
    name: "release", description: "CI release", expires: 30, packages: ["@scope/pkg"], scopes: ["scope"], orgs: ["acme"], packages_and_scopes_permission: "read-write", orgs_permission: "read-only", cidr_whitelist: ["192.0.2.0/24"], bypass_2fa: true,
  });
  assert.throws(() => tokenCreationBody({ ...base, tokenPackages: ["pkg@1.0.0"] }), /exact package name/);
  assert.throws(() => tokenCreationBody({ ...base, tokenCidrs: ["2001:db8::/32"] }), /Invalid IPv4 CIDR/);
});
