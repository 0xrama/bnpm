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

## 0.0.3 - 2026-07-20

### Changed

- Install output now uses one in-place pnpm-style progress line with compact permanent progress and security summaries; detailed evidence remains available through `--details` and JSON output.
- Lifecycle prompts clear active progress cleanly, and `--ignore-scripts` no longer asks about scripts that will not run.

## 0.0.2 - 2026-07-20

### Fixed

- Increased the bounded registry metadata budget from 32 MiB to 64 MiB so large packuments such as Vite resolve successfully while retaining a hard safety limit.

## 0.0.0

Initial development version. No production release has been declared.
