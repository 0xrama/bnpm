import { createHash, timingSafeEqual } from "node:crypto";

const supportedAlgorithms = ["sha512", "sha384", "sha256"] as const;
type SupportedAlgorithm = (typeof supportedAlgorithms)[number];

export interface ExpectedIntegrity {
  algorithm: SupportedAlgorithm;
  digest: Buffer;
  serialized: string;
}

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

export function selectExpectedIntegrity(integrity: string): ExpectedIntegrity {
  const entries = integrity.trim().split(/\s+/);
  for (const algorithm of supportedAlgorithms) {
    const prefix = `${algorithm}-`;
    const entry = entries.find((candidate) => candidate.startsWith(prefix));
    if (!entry) continue;

    const encoded = entry.slice(prefix.length).split("?", 1)[0];
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new IntegrityError(`Malformed ${algorithm} integrity digest`);
    }

    const digest = Buffer.from(encoded, "base64");
    if (digest.length !== createHash(algorithm).digest().length) {
      throw new IntegrityError(`Malformed ${algorithm} integrity digest length`);
    }

    return { algorithm, digest, serialized: `${algorithm}-${encoded}` };
  }

  throw new IntegrityError("No supported strong integrity digest was provided");
}

export function verifyBufferIntegrity(content: Uint8Array, integrity: string): ExpectedIntegrity {
  const expected = selectExpectedIntegrity(integrity);
  const actual = createHash(expected.algorithm).update(content).digest();
  assertDigest(expected, actual);
  return expected;
}

export function assertDigest(expected: ExpectedIntegrity, actual: Uint8Array): void {
  const actualBuffer = Buffer.from(actual);
  if (actualBuffer.length !== expected.digest.length || !timingSafeEqual(actualBuffer, expected.digest)) {
    throw new IntegrityError(`Content does not match ${expected.algorithm} integrity`);
  }
}
