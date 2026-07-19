# Changelog

All notable changes to Better NPM are recorded here. The project follows Semantic Versioning once it leaves the `0.x` development series.

## Unreleased

### Added

- Independent registry resolution, integrity verification, quarantine, safe extraction, content-addressed storage, isolated linking, peer contexts, workspaces, global installs, and recovery.
- Full-graph recent-release checks, explainable static findings, and exact lifecycle approvals.
- HTTPS tarball and HTTPS/SSH Git sources with bare-name inference, semver tags, subdirectories, validated recursive submodules, and approval-gated prepare builds.
- Deterministic npm-compatible packing, authenticated publishing, trusted-publisher OIDC, verified/generated Sigstore provenance, and web account management.
- Registry view/search/dist-tag/deprecation operations, safe configuration mutation, init/version authoring, prune/dedupe/rebuild, funding reports, and cache verification/cleanup.
- Cross-platform CI, reproducible package smoke verification, checksums, and tag-driven GitHub release artifacts.

### Security

- Bounded network, metadata, archive, output, process, and filesystem operations across trust boundaries.
- Credentials remain path-scoped, are recalculated on redirects, are removed from lifecycle environments, and are never persisted to the lockfile.

## 0.0.0

Initial development version. No production release has been declared.
