import { readFile, stat } from "node:fs/promises";
import npa from "npm-package-arg";
import type { Bundle, SignOptions } from "sigstore";
import type { PackedPackage } from "./pack.js";

const maxProvenanceBytes = 10 * 1024 * 1024;

export interface ProvenanceBundle {
  readonly mediaType: string;
  readonly dsseEnvelope: { readonly payload: string };
  readonly [key: string]: unknown;
}

export interface ProvenanceServices {
  readonly verify: (bundle: ProvenanceBundle) => Promise<unknown>;
}

export interface ProvenanceSigner {
  (payload: Buffer, payloadType: string, options?: SignOptions): Promise<ProvenanceBundle>;
}

export class ProvenanceError extends Error {
  constructor(message: string) {
    super(`Provenance error: ${message}`);
    this.name = "ProvenanceError";
  }
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function packagePurl(name: string, version: string): string {
  const api = npa as typeof npa & { toPurl(spec: npa.Result): string };
  return api.toPurl(npa.resolve(name, version));
}

function sha512Hex(integrity: string): string {
  const value = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)?.[1];
  if (!value) throw new Error("Packed package has invalid SHA-512 integrity");
  return Buffer.from(value, "base64").toString("hex");
}

export function provenanceSubject(artifact: PackedPackage): { readonly name: string; readonly digest: { readonly sha512: string } } {
  return { name: packagePurl(artifact.name, artifact.version), digest: { sha512: sha512Hex(artifact.integrity) } };
}

export function extractProvenancePayload(bundle: ProvenanceBundle): Record<string, unknown> {
  if (!bundle.dsseEnvelope || typeof bundle.dsseEnvelope.payload !== "string" || bundle.dsseEnvelope.payload.length === 0) {
    throw new Error("No dsseEnvelope with payload found in Sigstore bundle");
  }
  try {
    return record(JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8")), "Sigstore payload must be an object");
  } catch (error) {
    throw new Error(`Failed to parse payload from dsseEnvelope: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadProvenance(
  artifact: PackedPackage,
  path: string,
  services: ProvenanceServices = { verify: async (bundle) => (await import("sigstore")).verify(bundle as Bundle) },
): Promise<ProvenanceBundle> {
  let info;
  try { info = await stat(path); } catch (error) { throw new ProvenanceError(`cannot read provenance file: ${error instanceof Error ? error.message : String(error)}`); }
  if (!info.isFile() || info.size > maxProvenanceBytes) throw new ProvenanceError(`file must be a regular file no larger than ${maxProvenanceBytes} bytes`);
  let bundle: ProvenanceBundle;
  try {
    const parsed = record(JSON.parse(await readFile(path, "utf8")), "Sigstore bundle must be an object");
    if (typeof parsed.mediaType !== "string" || parsed.mediaType.length === 0) throw new Error("Sigstore bundle has no mediaType");
    const envelope = record(parsed.dsseEnvelope, "Sigstore bundle has no dsseEnvelope");
    if (typeof envelope.payload !== "string") throw new Error("Sigstore bundle has no payload");
    bundle = parsed as unknown as ProvenanceBundle;
  } catch (error) {
    throw new ProvenanceError(`invalid bundle: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const payload = extractProvenancePayload(bundle);
    if (!Array.isArray(payload.subject) || payload.subject.length !== 1) throw new Error("Sigstore bundle must contain exactly one subject");
    const subject = record(payload.subject[0], "Sigstore bundle subject must be an object");
    const digest = record(subject.digest, "Sigstore bundle subject must contain a digest");
    const expected = provenanceSubject(artifact);
    if (subject.name !== expected.name) throw new Error(`subject ${String(subject.name)} does not match the package: ${expected.name}`);
    if (digest.sha512 !== expected.digest.sha512) throw new Error("subject digest does not match the package");
  } catch (error) {
    throw new ProvenanceError(error instanceof Error ? error.message : String(error));
  }
  try { await services.verify(bundle); } catch (error) { throw new ProvenanceError(`signature verification failed: ${error instanceof Error ? error.message : String(error)}`); }
  return bundle;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new ProvenanceError(`missing required CI environment variable ${name}`);
  return value;
}

function githubStatement(artifact: PackedPackage, environment: NodeJS.ProcessEnv): Record<string, unknown> {
  required(environment, "ACTIONS_ID_TOKEN_REQUEST_URL");
  const repository = required(environment, "GITHUB_REPOSITORY");
  const server = required(environment, "GITHUB_SERVER_URL");
  const workflowRefValue = required(environment, "GITHUB_WORKFLOW_REF").replace(`${repository}/`, "");
  const delimiter = workflowRefValue.indexOf("@");
  if (delimiter <= 0 || delimiter === workflowRefValue.length - 1) throw new ProvenanceError("GITHUB_WORKFLOW_REF is malformed");
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [provenanceSubject(artifact)],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: { ref: workflowRefValue.slice(delimiter + 1), repository: `${server}/${repository}`, path: workflowRefValue.slice(0, delimiter) } },
        internalParameters: { github: { event_name: environment.GITHUB_EVENT_NAME, repository_id: environment.GITHUB_REPOSITORY_ID, repository_owner_id: environment.GITHUB_REPOSITORY_OWNER_ID } },
        resolvedDependencies: [{ uri: `git+${server}/${repository}@${required(environment, "GITHUB_REF")}`, digest: { gitCommit: required(environment, "GITHUB_SHA") } }],
      },
      runDetails: {
        builder: { id: `https://github.com/actions/runner/${required(environment, "RUNNER_ENVIRONMENT")}` },
        metadata: { invocationId: `${server}/${repository}/actions/runs/${required(environment, "GITHUB_RUN_ID")}/attempts/${required(environment, "GITHUB_RUN_ATTEMPT")}` },
      },
    },
  };
}

function gitlabStatement(artifact: PackedPackage, environment: NodeJS.ProcessEnv): Record<string, unknown> {
  const projectUrl = required(environment, "CI_PROJECT_URL");
  const commit = required(environment, "CI_COMMIT_SHA");
  return {
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [provenanceSubject(artifact)],
    predicateType: "https://slsa.dev/provenance/v0.2",
    predicate: {
      buildType: "https://github.com/npm/cli/gitlab/v0alpha1",
      builder: { id: `${projectUrl}/-/runners/${required(environment, "CI_RUNNER_ID")}` },
      invocation: {
        configSource: { uri: `git+${projectUrl}`, digest: { sha1: commit }, entryPoint: required(environment, "CI_JOB_NAME") },
        parameters: { CI: environment.CI, CI_COMMIT_REF_NAME: environment.CI_COMMIT_REF_NAME, CI_PIPELINE_SOURCE: environment.CI_PIPELINE_SOURCE },
        environment: { server: environment.CI_SERVER_URL, project: environment.CI_PROJECT_PATH, job: { id: environment.CI_JOB_ID }, pipeline: { id: environment.CI_PIPELINE_ID, ref: environment.CI_CONFIG_PATH } },
      },
      metadata: { buildInvocationId: required(environment, "CI_JOB_URL"), completeness: { parameters: true, environment: true, materials: false }, reproducible: false },
      materials: [{ uri: `git+${projectUrl}`, digest: { sha1: commit } }],
    },
  };
}

export async function generateProvenance(
  artifact: PackedPackage,
  environment: NodeJS.ProcessEnv = process.env,
  signer: ProvenanceSigner = async (payload, payloadType, options) => (await import("sigstore")).attest(payload, payloadType, options) as Promise<ProvenanceBundle>,
): Promise<ProvenanceBundle> {
  let statement: Record<string, unknown>;
  let signOptions: SignOptions | undefined;
  if (environment.GITHUB_ACTIONS === "true") {
    statement = githubStatement(artifact, environment);
  } else if (environment.GITLAB_CI === "true") {
    statement = gitlabStatement(artifact, environment);
    signOptions = { identityToken: required(environment, "SIGSTORE_ID_TOKEN") };
  } else {
    throw new ProvenanceError("automatic generation is supported only in GitHub Actions or GitLab CI");
  }
  return signer(Buffer.from(JSON.stringify(statement)), "application/vnd.in-toto+json", signOptions);
}

export function transparencyLogUrl(bundle: ProvenanceBundle): string | undefined {
  const material = bundle.verificationMaterial;
  if (typeof material !== "object" || material === null || Array.isArray(material)) return undefined;
  const entries = (material as { tlogEntries?: unknown }).tlogEntries;
  if (!Array.isArray(entries) || typeof entries[0] !== "object" || entries[0] === null) return undefined;
  const index = (entries[0] as { logIndex?: unknown }).logIndex;
  return typeof index === "number" || typeof index === "string" ? `https://search.sigstore.dev/?logIndex=${encodeURIComponent(String(index))}` : undefined;
}
