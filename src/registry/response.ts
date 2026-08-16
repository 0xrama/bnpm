export type BoundedBody =
  | { readonly kind: "ok"; readonly bytes: Buffer }
  | { readonly kind: "empty" }
  | { readonly kind: "too-large" };

export async function readBoundedBody(response: Response, maxBytes: number): Promise<BoundedBody> {
  if (!response.body) return { kind: "empty" };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    if ((size += chunk.length) > maxBytes) return { kind: "too-large" };
    chunks.push(chunk);
  }
  return { kind: "ok", bytes: Buffer.concat(chunks) };
}
