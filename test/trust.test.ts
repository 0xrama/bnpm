import assert from "node:assert/strict";
import test from "node:test";
import { trustConfiguration } from "../src/commands/trust.js";
import type { CommandOptions } from "../src/core/cli-parser.js";

const base: CommandOptions = { json: false, allowRecent: [], allowDangerous: [], frozenLockfile: false, offline: false, omitDev: false, saveExact: false, noSave: false };
const one = "123e4567-e89b-42d3-a456-426614174000";
const two = "223e4567-e89b-42d3-a456-426614174000";
const three = "323e4567-e89b-42d3-a456-426614174000";

test("trusted publisher configurations map exact provider claims and permissions", () => {
  assert.deepEqual(trustConfiguration("github", { ...base, trustRepository: "owner/repo", trustFile: "release.yml", trustEnvironment: "production", allowPublish: true }), {
    type: "github", claims: { repository: "owner/repo", workflow_ref: { file: "release.yml" }, environment: "production" }, permissions: ["createPackage"],
  });
  assert.deepEqual(trustConfiguration("gitlab", { ...base, trustProject: "group/subgroup/project", trustFile: ".gitlab-ci.yaml", allowStagePublish: true }), {
    type: "gitlab", claims: { project_path: "group/subgroup/project", ci_config_ref_uri: { file: ".gitlab-ci.yaml" } }, permissions: ["createStagedPackage"],
  });
  assert.deepEqual(trustConfiguration("circleci", { ...base, trustOrganizationId: one, trustProjectId: two, trustPipelineDefinitionId: three, trustVcsOrigin: "github.com/owner/repo", trustContextIds: [one], allowPublish: true, allowStagePublish: true }), {
    type: "circleci", claims: { "oidc.circleci.com/org-id": one, "oidc.circleci.com/project-id": two, "oidc.circleci.com/pipeline-definition-id": three, "oidc.circleci.com/vcs-origin": "github.com/owner/repo", "oidc.circleci.com/context-ids": [one] }, permissions: ["createPackage", "createStagedPackage"],
  });
});

test("trusted publisher configurations reject unsafe or incomplete claims", () => {
  assert.throws(() => trustConfiguration("github", { ...base, trustRepository: "owner/repo", trustFile: "../release.yml", allowPublish: true }), /basename-only/);
  assert.throws(() => trustConfiguration("gitlab", { ...base, trustProject: "project", trustFile: "ci.yml", allowPublish: true }), /group\/project/);
  assert.throws(() => trustConfiguration("circleci", { ...base, trustOrganizationId: "bad", trustProjectId: two, trustPipelineDefinitionId: three, trustVcsOrigin: "https://github.com/owner/repo", allowPublish: true }), /vcs-origin/);
});
