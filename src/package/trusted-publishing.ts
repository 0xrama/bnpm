import npa from "npm-package-arg";

const maxResponseBytes = 1024 * 1024;

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function boundedJson(response: Response): Promise<Record<string, unknown> | undefined> {
  if (!response.body) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > maxResponseBytes) return undefined;
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function supportedCi(environment: Readonly<Record<string, string | undefined>>): boolean {
  return environment.GITHUB_ACTIONS === "true" || environment.GITLAB_CI === "true" || environment.CIRCLECI === "true";
}

async function githubIdToken(
  registry: URL,
  environment: Readonly<Record<string, string | undefined>>,
  request: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const rawUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!rawUrl || !requestToken) return undefined;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
  url.searchParams.set("audience", `npm:${registry.hostname}`);
  const response = await request(url, {
    redirect: "error",
    signal: requestSignal(signal),
    headers: { accept: "application/json", authorization: `Bearer ${requestToken}` },
  });
  if (!response.ok) return undefined;
  const body = await boundedJson(response);
  return typeof body?.value === "string" && body.value.length > 0 ? body.value : undefined;
}

export async function trustedPublishingToken(options: {
  readonly packageName: string;
  readonly registry: URL;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  if (!supportedCi(environment)) return undefined;
  const request = options.fetch ?? globalThis.fetch;
  try {
    const idToken = environment.NPM_ID_TOKEN ?? (environment.GITHUB_ACTIONS === "true"
      ? await githubIdToken(options.registry, environment, request, options.signal)
      : undefined);
    if (!idToken) return undefined;
    const parsed = npa(options.packageName);
    const escapedName = "escapedName" in parsed && typeof parsed.escapedName === "string" ? parsed.escapedName : encodeURIComponent(options.packageName);
    const endpoint = new URL(`/-/npm/v1/oidc/token/exchange/package/${escapedName}`, options.registry);
    const response = await request(endpoint, {
      method: "POST",
      redirect: "error",
      signal: requestSignal(options.signal),
      headers: { accept: "application/json", authorization: `Bearer ${idToken}` },
    });
    if (!response.ok) return undefined;
    const body = await boundedJson(response);
    return typeof body?.token === "string" && body.token.length > 0 ? body.token : undefined;
  } catch {
    return undefined;
  }
}
