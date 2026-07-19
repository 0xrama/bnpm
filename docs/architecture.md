# Architecture

## Design principles

- Keep the CLI and hot installation path small.
- Separate policy decisions from I/O so behavior is testable and usable by interactive and JSON clients.
- Never link or execute unverified package content.
- Resolve mutable specifications to immutable identities early.
- Bound network, archive, filesystem, and analysis resource consumption.
- Prefer Node.js built-ins; add dependencies only where implementing the behavior correctly is materially safer.

## System flow

```text
CLI -> configuration -> manifest -> resolver -> immutable graph
                                        |
                                        v
registry -> quarantine download -> integrity -> safe extraction -> analysis
                                                              |
                                                              v
policy review -> content-addressable store -> isolated linker -> approved scripts
```

The resolver produces a complete immutable graph before installation mutates the project. Fetch, verification, and static analysis can run with bounded concurrency. User decisions are collected after analysis. Linking is transactional: construct a new virtual store, then atomically replace project links and lockfile where the platform permits.

## Modules

### CLI

Owns argument parsing, interactive presentation, JSON serialization, stable exit codes, and signal handling. `bnpmx` enters the same application through a distinct executable name and selects ephemeral execution mode. Domain modules never print or prompt directly.

### Configuration

Loads defaults, global configuration, project policy, environment-safe CLI options, and exact one-shot overrides. Project policy can tighten the recent-release threshold but cannot silently weaken global policy. Configuration parsing is strict and reports unknown security-sensitive keys.

### Registry client

Fetches npm packuments and tarballs over HTTPS, supports scoped names and private registries, validates response types and sizes, and applies bounded retries only to safe requests. Registry credentials are selected by HTTPS origin and longest path prefix, recalculated after redirects, held only in memory, and never logged or persisted to lockfiles.

### Resolver

Accepts manifest requirements, workspace packages, overrides, and a registry metadata provider. It resolves tags and ranges to exact versions, handles optional and peer dependencies, detects unsatisfied or conflicting peers, and returns a deterministic graph. Resolution does not download tarballs or execute scripts.

Resolver correctness needs fixture tests for npm-compatible edge cases. Selection order must be specified and stable rather than relying on object iteration or response order.

### Quarantine and archive handling

Downloads each tarball to a random, non-executable quarantine path while incrementally hashing and enforcing compressed-byte limits. Extraction occurs only after integrity verification and uses a dedicated safe tar reader with path, link, entry-count, expanded-size, and compression-ratio checks.

A package is promoted to the store only after extraction and analysis complete. Failed downloads/extractions and completed prepared sources delete their quarantine directories; abrupt process termination may leave an abandoned directory for later maintenance cleanup.

### Non-registry sources

Bare or aliased HTTPS tarballs are streamed to quarantine under compressed-size and redirect limits, assigned a locally computed SHA-512 identity, safely extracted, and resolved from their real manifest. HTTPS and SSH Git sources use argument-array subprocesses with hooks, prompts, and local-file transport disabled; exact refs or the highest matching semver tag are resolved to an exact commit. Package subdirectories are path-confined, recursive submodule URLs are validated before fetch, and prepare builds install development dependencies before approval-gated execution. The selected package directory is passed through canonical npm pack rules and safe archive extraction. Both source types remain temporary until the normal analyzer/store transition and are recorded distinctly in the lockfile so registry publication policy is not applied to explicit sources.

### Analyzer

Produces facts, not a score. It has three layers:

1. Parse lifecycle command strings into commands and shell constructs where possible.
2. Follow statically referenced local scripts from lifecycle entries.
3. Scan package content using high-confidence behavior rules and lightweight syntax-aware analysis.

Rules return stable identifiers, evidence, locations, severity, and remediation text. Analysis limits prevent intentionally pathological files from exhausting memory or CPU. Rule-set version is recorded with cached findings.

### Policy engine

Combines script presence, findings, publication timestamps, trusted-package entries, lockfile approvals, interactive decisions, and CI flags into explicit allow, skip, or block outcomes. It is pure and deterministic given its inputs.

### Store and linker

The global store is content-addressed by verified package integrity. A project-local `.bnpm` virtual store contains package instances representing resolved peer contexts. Hard links (or safe copy fallback) materialize files from the global store; symlinks/junctions create dependency relationships and top-level `node_modules` entries.

Store writes use temporary paths followed by atomic rename. Concurrent processes coordinate per-integrity promotion without a global install lock. Store content is treated as immutable.

### Script runner

Runs only approved lifecycle stages, sequentially, from the correct package directory. It sanitizes inherited environment variables where feasible, marks output with package identity, handles termination, and records skipped or failed scripts. It does not claim sandboxing.

### Audit

Combines npm advisory responses with current local analyzer findings. Registry failures and a clean advisory result are distinct states. Audit output identifies the data source and timestamp.

### Maintenance and authoring

Prune and dedupe reuse the resolver and atomic linker with the warm no-op shortcut disabled. Rebuild re-analyzes installed instances and executes only lifecycle facts still covered by exact lockfile approvals. Cache verification checks stored content identities without mutation; cache cleanup requires `--force` and confines resolved targets to the store, metadata cache, and quarantine directories. Registry metadata mutations use bounded JSON, same-origin HTTPS redirects, scoped credentials, and one-shot non-retried writes. Init, semantic version changes, and configuration writes use atomic replacement.

### Package authoring

The packer uses npm's canonical packlist selection rules, derives explicit bundled-dependency production closures from installed manifests, confines isolated-store symlink traversal to those selected roots, bounds file count and expanded bytes, and writes normalized tar/gzip metadata so identical inputs produce identical bytes. The publisher constructs registry metadata from that exact artifact, recalculates path-scoped authorization, confines redirects to the registry origin, never retries the non-idempotent PUT, and supports tag, access, OTP, `publishConfig`, trusted-publisher OIDC, and dry-run behavior. Supplied Sigstore bundles are signature-verified and bound to the package purl and SHA-512 digest; generated GitHub/GitLab statements use in-toto/SLSA provenance and expose the transparency-log URL. Project authoring scripts pass through the same analyzer and exact dangerous-script approval boundary used by `bnpm run`.

## Data locations

Platform-specific paths are selected through a small path service:

- Global configuration: platform config directory under `bnpm/config.yaml`
- Global store: platform cache/data directory under `bnpm/store`
- Project policy: `bnpm.yaml`
- Lockfile: `bnpm-lock.yaml`
- Virtual store: `node_modules/.bnpm`
- Quarantine: global cache under `bnpm/quarantine`

No global path is assumed to be `~/.config` on Windows or macOS.

## Concurrency and performance

Metadata requests and package downloads use separate bounded pools. Duplicate package requests are coalesced. Integrity checking happens during streaming download. Analysis and extraction are bounded by CPU and expanded-size budgets. The resolver and lockfile writer remain deterministic regardless of completion order.

Initial benchmarks will measure cold install, warm install, repeated monorepo install, disk usage, metadata request count, and time spent in analysis. Security checks are not silently disabled to improve benchmark results.

## Failure and recovery

Before mutation, failures leave the existing install untouched. During linking, Better NPM builds a replacement layout and records enough state to remove abandoned temporary trees. Lockfile output uses temporary-file plus rename. Script failure does not corrupt the store; it marks the project installation incomplete and returns a nonzero exit code according to policy.

## Initial implementation milestones

1. CLI contracts, config schema, registry client, integrity verification, and recent-release policy.
2. npm-compatible resolver and deterministic graph/lockfile fixtures.
3. safe tar extraction and content-addressable global store.
4. isolated linker, workspace support, and transactional project updates.
5. lifecycle discovery, script hashing, trusted approvals, and interactive review.
6. analyzer rule engine, `audit`, project-script analysis, and `bnpmx` execution.
7. cross-platform compatibility, recovery, security corpus, and performance tuning.
