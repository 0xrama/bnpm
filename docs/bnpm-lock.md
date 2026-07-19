# `bnpm-lock.yaml`

## Goals

The lockfile makes resolution, content identity, graph shape, lifecycle decisions, and security-relevant metadata reproducible. It is deterministic, human-reviewable YAML and must never contain registry credentials.

## Proposed version 1 shape

```yaml
lockfileVersion: 1
settings:
  registry: https://registry.npmjs.org/
  recentReleaseHours: 6
importers:
  .:
    dependencies:
      example:
        specifier: ^2.0.0
        version: 2.1.0
packages:
  example@2.1.0:
    resolution:
      integrity: sha512-BASE64
      tarball: https://registry.npmjs.org/example/-/example-2.1.0.tgz
    publishedAt: 2026-07-01T12:00:00.000Z
    dependencies:
      transitive: 1.0.0
    scripts:
      postinstall:
        command: node install.js
        contentHash: sha256-BASE64
    security:
      findings: []
approvals:
  example@2.1.0:
    integrity: sha512-BASE64
    scripts:
      postinstall:
        commandHash: sha256-BASE64
        contentHash: sha256-BASE64
        approved: true
```

## Canonicalization

- UTF-8 with LF endings and a final newline.
- Mapping keys sorted lexicographically when written.
- Package keys use an unambiguous canonical identity.
- Versions and integrity values are exact—never ranges or tags.
- Timestamps use UTC RFC 3339 representation.
- Empty optional collections are omitted.
- Credentials, authorization headers, and environment values are forbidden.

## Approval semantics

An approval is valid only when package name, exact version, tarball integrity, lifecycle stage, command hash, and referenced-content hash all match. A missing field, changed field, or manually malformed entry invalidates approval and requires a new decision.

Lockfile approvals are reviewable records, not proof that a script is safe. CI may adopt a policy that rejects newly added approvals until reviewed separately.

## Evolution

Readers must reject unsupported major `lockfileVersion` values. New optional fields may be introduced within a version, but changes to identity, resolution, integrity, or approval semantics require a new major lockfile version.
