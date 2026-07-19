import { basename } from "node:path";
import type { CommandOptions } from "../core/cli-parser.js";

export class TrustError extends Error {
  constructor(message: string) { super(message); this.name = "TrustError"; }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function yamlFile(value: string | undefined, provider: string): string {
  if (!value || basename(value) !== value || !/\.ya?ml$/i.test(value)) throw new TrustError(`${provider} trust requires a basename-only YAML file`);
  return value;
}

function entity(value: string | undefined, provider: "github" | "gitlab"): string {
  const parts = value?.split("/") ?? [];
  if ((provider === "github" && parts.length !== 2) || (provider === "gitlab" && parts.length < 2) || parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new TrustError(`${provider} trust requires ${provider === "github" ? "owner/repository" : "group/project"}`);
  }
  return parts.join("/");
}

function requiredUuid(value: string | undefined, field: string): string {
  if (!value || !uuid.test(value)) throw new TrustError(`${field} must be a UUID`);
  return value;
}

export function trustConfiguration(provider: "github" | "gitlab" | "circleci", options: CommandOptions): Readonly<Record<string, unknown>> {
  const permissions = [...(options.allowPublish ? ["createPackage"] : []), ...(options.allowStagePublish ? ["createStagedPackage"] : [])];
  if (permissions.length === 0) throw new TrustError("At least one trusted-publisher permission is required");
  if (provider === "github") {
    return { type: provider, claims: { repository: entity(options.trustRepository, provider), workflow_ref: { file: yamlFile(options.trustFile, provider) }, ...(options.trustEnvironment === undefined ? {} : { environment: options.trustEnvironment }) }, permissions };
  }
  if (provider === "gitlab") {
    return { type: provider, claims: { project_path: entity(options.trustProject ?? options.trustRepository, provider), ci_config_ref_uri: { file: yamlFile(options.trustFile, provider) }, ...(options.trustEnvironment === undefined ? {} : { environment: options.trustEnvironment }) }, permissions };
  }
  const vcsOrigin = options.trustVcsOrigin;
  if (!vcsOrigin || vcsOrigin.includes("://") || vcsOrigin.split("/").length < 3 || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){2,}$/.test(vcsOrigin)) throw new TrustError("CircleCI vcs-origin must use provider/owner/repository without a URL scheme");
  const contexts = options.trustContextIds ?? [];
  if (contexts.some((value) => !uuid.test(value))) throw new TrustError("CircleCI context-id must be a UUID");
  return { type: provider, claims: { "oidc.circleci.com/org-id": requiredUuid(options.trustOrganizationId, "org-id"), "oidc.circleci.com/project-id": requiredUuid(options.trustProjectId, "project-id"), "oidc.circleci.com/pipeline-definition-id": requiredUuid(options.trustPipelineDefinitionId, "pipeline-definition-id"), "oidc.circleci.com/vcs-origin": vcsOrigin, ...(contexts.length === 0 ? {} : { "oidc.circleci.com/context-ids": contexts }) }, permissions };
}
