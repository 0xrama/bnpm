# Better NPM implementation status and production-readiness plan

**Recorded:** 2026-07-22  
**Current package:** `@0xrama/bnpm@0.0.3`  
**Assessment:** Functional alpha with a real package-management core; not production-ready.

## Executive summary

Better NPM is substantially more than a CLI prototype. It resolves and installs packages itself rather than wrapping npm or pnpm. Version `0.0.3` is published as `@0xrama/bnpm`, and the packaged `bnpm` executable reports `0.0.3`.

The current implementation includes a custom registry resolver, deterministic lockfile, quarantine and integrity pipeline, content-addressed store, isolated linking, lifecycle approval system, registry and publishing operations, workspaces, cache commands, auditing, SBOM generation, and recent-publication policy.

Normal registry installation works, the security design contains valuable protections, and the current small benchmark is competitive. However, the lockfile and clean-CI contract, warm-store integrity checks, and lifecycle transaction model are production blockers. The project is currently suitable for experimentation and controlled projects, not as the sole package manager for critical CI or broad npm ecosystem compatibility.

## Implemented package-manager capabilities

- Custom registry resolver for versions, ranges, tags, npm aliases, dependencies, optionals, peer contexts, overrides, platform constraints, and explicit workspaces.
- Registry packages, local directories and archives, HTTPS tarballs, and HTTPS/SSH Git sources.
- Deterministic `bnpm-lock.yaml`.
- Quarantine download, integrity verification, bounded archive extraction, content-addressed store, and isolated linking.
- Install, add, remove, update, CI, and global operations.
- Project scripts, lifecycle approvals, implicit `node-gyp`, `bnpm exec`, and `bnpmx`.
- Registry authentication, metadata operations, audit, pack, publish, access/account commands, trusted publishing, and provenance generation.
- Workspaces, offline installs, cache operations, SBOM, graph queries, diff, and shrinkwrap export.
- Recent-publication policy across the resolved graph.
- Security analysis and exact hash-bound lifecycle approvals.

The implemented package flow is:

```text
CLI → manifest/config → resolver → registry/source fetch
    → quarantine/integrity/extraction → store → analysis/policy
    → isolated node_modules layout → approved lifecycle scripts
```

## Verification snapshot

The following checks were performed on 2026-07-22:

- TypeScript check: **passed**.
- Test suite: **181/181 passed**.
- Packaged installation/executable smoke test: **passed**.
- Live registry install of `is-number@7.0.0`: **passed**.
- Loading the installed package through Node: **passed**.
- Published npm version: `0.0.3`.
- Shipped CLI entrypoint reported version `0.0.3`.

Current controlled benchmark fixture:

| Manager | Cold | Warm median |
| --- | ---: | ---: |
| bnpm | 1,472 ms | 117 ms |
| pnpm | 1,446 ms | 309 ms |
| npm | 2,718 ms | 296 ms |

This benchmark covers four packages on one machine. It demonstrates a competitive path, not general pnpm-class performance.

# Production blockers

## P0. Redesign the lockfile as a complete reconstruction contract

### Problem

`readLockfileGraph()` reconstructs package manifests by reading them from the existing global store (`src/lockfile/index.ts:105-173`). Consequently, a valid `bnpm-lock.yaml` cannot hydrate an empty cache on a fresh machine.

A fresh-cache reproduction using a valid lockfile and isolated empty `BNPM_CACHE_HOME` failed with:

```text
Lockfile error: store entry is missing for is-number@7.0.0
exit: 3
```

The command also emitted an internal `exitCode: 70` event before reporting the result as a security-policy failure with exit code 3. Error classification is inconsistent.

### Required outcome

The lockfile must contain enough immutable information to reconstruct every package without pre-existing local state:

- Exact identity and source type.
- Registry or source location.
- Integrity digest.
- Dependency edges and peer context.
- Manifest fields needed for linking, lifecycle discovery, compatibility checks, and policy.
- Publication timestamp and security decisions where applicable.

### Acceptance criteria

- A project containing only `package.json` and `bnpm-lock.yaml` installs successfully with an empty `BNPM_CACHE_HOME`.
- The install does not perform mutable semver resolution.
- Every fetched artifact is verified against lockfile integrity.
- Offline mode still fails clearly if required artifacts are unavailable.
- Lockfile errors map to one stable result category and process exit code.

## P0. Bind lock validity to every resolution-affecting input

### Problem

`requirementKeys()` compares only importer, package name, and specifier. It excludes:

- Dependency kind: production, development, optional, peer, or workspace.
- Root and workspace overrides.
- Registry/source routing that affects package identity.
- Relevant resolver and workspace settings.

An override or dependency-section change can therefore reuse a graph generated under different semantics.

### Required outcome

Add a normalized lockfile settings/input snapshot or hash covering every value that can alter resolution or installation semantics.

### Acceptance criteria

- Changing an override invalidates or deterministically updates the lock.
- Moving a dependency between dependency sections updates lock metadata and omit behavior.
- Workspace manifest and selection changes cannot silently reuse an obsolete graph.
- Frozen installs reject all mismatches with an actionable error.
- Equivalent normalized inputs remain deterministic regardless of JSON key order.

## P0. Require full integrity verification for store reuse

### Problem

Locked graph reuse calls:

```ts
verifyStoreEntry(..., { full: false })
```

This verifies store metadata and `package.json`, not every installed file. Corruption or tampering elsewhere in a package can survive the locked warm path until an explicit full cache verification.

### Required outcome

Warm installs must preserve the central guarantee that linked content matches the expected package integrity.

Potential approaches must be evaluated for security and performance:

- Full verification on every reuse.
- A sealed Merkle/file manifest verified against immutable filesystem metadata.
- Platform-supported immutable or verifiable storage primitives.

A metadata-only shortcut is insufficient unless mutations are reliably detectable.

### Acceptance criteria

- Modifying any stored executable or source file is detected before it is linked or executed.
- Corrupt entries are safely repaired online or rejected offline.
- Verification remains bounded and benchmarked.
- The security guarantee is documented accurately.

## P0. Make `bnpm ci` an exact clean recreation

### Problem

`ci` is primarily parsed as install with frozen-lockfile behavior. The warm-layout check verifies required root identities but does not prove the complete physical layout is exact or free of extraneous entries.

### Required outcome

`bnpm ci` must:

1. Validate the lock against all manifest and resolution inputs.
2. Reconstruct packages from an empty store when necessary.
3. Remove or atomically replace the previous installation.
4. Recreate the exact locked graph.
5. Verify the resulting physical layout.

### Acceptance criteria

- Extraneous root and transitive packages are removed.
- Missing packages are restored.
- Incorrect peer-context instances are replaced.
- Fresh-cache and warm-cache results are physically equivalent.
- Failure before activation leaves the prior valid layout untouched.

# Resolver and workspace compatibility

## P1. Expand resolver compatibility

### Current boundaries

- Overrides are flat `Record<string,string>` values; nested and ancestor-scoped npm overrides are unsupported.
- Only explicit `workspace:` requirements select local workspaces. Ordinary compatible semver dependencies do not automatically prefer matching workspace packages.
- Workspace importers are resolved separately and merged rather than resolved as one global graph.
- Workspace patterns support a limited glob grammar.
- Optional dependencies are skipped for resolution failures, but later fetching, extraction, or lifecycle failures are not consistently optional.
- Missing protocols and features include `link:`, `portal:`, patches, and catalogs.
- The implementation does not consume `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, or `yarn.lock`; shrinkwrap support is export-only.

Some features such as catalogs and patches are pnpm-oriented rather than required for npm compatibility. They should remain lower priority than resolver correctness.

### Required work

- Implement nested and ancestor-scoped override semantics.
- Define and implement normal semver-to-workspace selection behavior.
- Resolve workspace importers as one deterministic graph or formally define safe merge semantics.
- Expand workspace pattern compatibility, including exclusions where appropriate.
- Treat optional package failures consistently across resolution, fetch, extraction, analysis, linking, and lifecycle execution.
- Build a resolver compatibility corpus covering peer conflicts, aliases with overrides, cycles, malformed metadata, deprecated versions, platform optionals, and large graphs.
- Decide whether foreign lockfile import is a product requirement; document the boundary if not.

### Acceptance criteria

- Resolver behavior is deterministic across shuffled manifest and registry metadata ordering.
- Complex peer-context fixtures match documented npm-compatible expectations.
- Multi-workspace peer graphs resolve without importer-order dependence.
- Optional package failure never aborts installation when npm semantics require it to be skipped.
- Unsupported protocols fail with clear, source-specific diagnostics.

# Lifecycle and native build correctness

## P1. Make lifecycle execution transactional and dependency-topological

### Problem

Dependency lifecycle scripts currently run after the new layout is activated and the lockfile is written. Scripts are ordered lexically by package ID and stage rather than by dependency topology.

If an approved script fails, the new layout and lock can remain active without a durable installation-incomplete state.

### Required work

- Order dependency builds topologically while preserving stage ordering.
- Define cycle behavior explicitly.
- Run scripts against a staged layout or add a durable incomplete-install journal.
- Roll back activation when practical, or fail closed until a repair install completes.
- Treat optional package build failures according to optional dependency semantics.
- Terminate complete process trees on cancellation and timeout.
- Qualify real native addons and build toolchains.

### Acceptance criteria

- Dependencies build before consumers.
- Script failure cannot leave a layout that is treated as a successful warm installation.
- The next install detects and repairs interrupted or failed lifecycle state.
- Optional native-addon failure behaves correctly.
- Timeout and cancellation terminate descendants on macOS, Linux, and Windows.

## P1. Qualify native addons

Required qualification matrix:

- Representative `node-gyp` packages.
- N-API and ABI-specific addons.
- macOS ARM64 and x64 where supported.
- Linux glibc and musl.
- Windows MSVC toolchains.
- Optional prebuilt-binary fallback packages.
- Packages with install, postinstall, and prepare workflows.

Approved scripts remain **unsandboxed** and execute with the user’s operating-system permissions. This must remain prominent in every approval path.

# Security hardening

## P1. Improve analyzer depth and validation

### Current implementation

The static analyzer primarily contains:

- Seven regular-expression security rules.
- Five regular-expression capability rules.
- Limited lifecycle-referenced-file discovery.
- Native binary magic detection.

This provides useful evidence but is not robust malware analysis and can be evaded.

### Required work

- Introduce syntax-aware JavaScript analysis for process, filesystem, network, decoding, and dynamic execution flows.
- Expand shell parsing beyond regular-expression matching.
- Track simple data flow from decoding/download operations into execution sinks.
- Add a versioned malicious and benign corpus.
- Measure false positives and false negatives for every rule revision.
- Add obfuscation and evasion regressions.
- Keep findings evidence-based rather than introducing an opaque score.

### Acceptance criteria

- Every rule has benign, malicious, and evasion fixtures.
- Analyzer limits remain deterministic under pathological files.
- Rule-set version changes invalidate cached analysis correctly.
- Capability claims distinguish detected evidence from guaranteed behavior.

## P1. Correct security pipeline guarantees

Required work:

- Do not treat shared-store promotion as final trust before analysis and policy complete.
- Ensure rejected content cannot become a trusted reusable entry merely because it was promoted.
- Add install-side registry signature or attestation verification if supported by the selected registry ecosystem.
- Keep authoring-side Sigstore/provenance support separate from install-time verification claims.
- Resolve the partial warm-store verification blocker.

### Acceptance criteria

- Store state has explicit quarantine, analyzed, policy-reviewed, and reusable trust transitions.
- Rejected or incomplete entries cannot enter a trusted warm path.
- Documentation exactly matches implemented trust transitions.

# Cache, networking, and offline behavior

## P2. Build a mature metadata and artifact cache

### Current boundary

Offline mode currently means that the exact lock and every required store entry already exist.

Missing behavior includes:

- Lock-driven refill of missing store entries.
- Registry metadata cache.
- ETag and conditional requests.
- `prefer-offline` behavior.
- Retry backoff and `Retry-After` handling.
- Stale store-lock owner/death recovery.
- Cache performance and disk-use accounting.

### Required work

- Add bounded registry metadata caching with explicit freshness semantics.
- Support conditional requests.
- Fetch missing artifacts directly from immutable lockfile data.
- Add retry backoff, jitter, and `Retry-After` for safe idempotent requests.
- Recover stale per-entry store locks safely.
- Add cache hit, byte reuse, and disk-use measurements.

### Acceptance criteria

- Warm installs minimize network requests without accepting stale mutable resolution unexpectedly.
- `prefer-offline`, online, frozen, and offline modes have distinct documented semantics.
- Concurrent and crashed writers cannot permanently block a store entry.
- Cache cleanup remains path-confined and cannot delete unrelated files.

# Storage and linking

## P2. Implement or accurately document the physical storage strategy

### Problem

The project linker clones or copies package trees into project instances. It does not currently implement the documented hard-link-first model.

On filesystems without efficient copy-on-write cloning, this can copy complete packages per project and peer context.

### Required work

- Decide whether the production strategy is reflink, hard link, clone, copy, or a platform-specific hierarchy.
- Implement the selected strategy with safe fallbacks.
- Measure disk amplification across projects and peer contexts.
- Handle case-insensitive collisions, long paths, junctions, and filesystem limitations.
- Update architecture documentation to describe actual behavior.

### Acceptance criteria

- Disk reuse is measured against npm and pnpm on representative graphs.
- File ownership and mutability guarantees are preserved.
- Editing a project instance cannot mutate the global store.
- Fallback behavior is explicit and observable.

# Configuration and CLI compatibility

## P2. Expand `.npmrc` and configuration compatibility

### Current boundary

`bnpm config` can write only:

- `registry`
- `recentReleaseHours`

The `.npmrc` reader covers registry routing and a narrow set of token/basic authentication forms. It does not provide broad npm configuration compatibility such as enterprise proxy, CA/client certificate, legacy authentication, fetch tuning, script shell, installation strategy, or most npm CLI settings.

Observed CLI option placement is also stricter than npm:

```text
bnpm install --json   → unknown option
bnpm --json install   → works
```

### Required work

- Define the supported npm configuration compatibility subset.
- Prioritize enterprise proxy, CA, client certificate, auth, fetch, and script-shell settings.
- Accept global options in conventional positions where ambiguity is absent.
- Add stable diagnostics for intentionally unsupported npm settings.
- Avoid silently accepting settings that do not affect behavior.

### Acceptance criteria

- Common private-registry configurations work without custom rewrites.
- Credentials remain path-scoped and are recalculated across redirects.
- Unsupported settings are reported clearly when they would affect correctness or security.
- CLI option placement matches documented npm-compatible conventions.

# Production qualification

## P1. Establish native cross-platform CI

There is currently no `.github/workflows` directory in this checkout, despite `status.md` claiming workflows are defined.

Required jobs:

- macOS ARM64.
- Linux x64 with glibc.
- Linux musl where supported.
- Windows x64.
- Supported Node LTS versions.
- Package build, test, packed installation, real registry install, cache reuse, and fresh-cache CI scenarios.

Platform-specific verification must cover:

- NTFS junction and rename behavior.
- Windows executable shims and quoting.
- Case-insensitive filesystem collisions.
- Long paths.
- POSIX permissions and symlinks.
- Native build toolchains.

## P1. Add failure-injection and concurrency campaigns

Required scenarios:

- Process termination during download, extraction, store promotion, layout activation, lockfile rename, and lifecycle scripts.
- Concurrent installers targeting the same project.
- Concurrent installers sharing the global store.
- Stale locks and dead owners.
- Disk-full failures.
- Permission failures.
- Corrupted archives and stored content.
- Registry timeouts, truncated responses, redirect loops, throttling, and retryable failures.

Every scenario must prove either atomic success or safe recovery.

## P1. Expand real ecosystem qualification

Required fixture matrix:

- Large web applications.
- CLI tools with many binaries.
- Deep and conflicting peer graphs.
- Large monorepos.
- Native addons.
- Packages with approved build scripts.
- Scoped private packages.
- Multiple scoped registries.
- Git dependencies with tags, submodules, subdirectories, and prepare builds.
- Packages with unusual but valid tar structures.
- Optional platform packages.

## P2. Expand performance qualification

Measure at minimum:

- Cold installation time.
- Warm no-op time.
- Fresh-cache locked CI time.
- Monorepo installation time.
- Peak memory.
- Registry request count.
- Downloaded and reused bytes.
- Extraction and analysis time.
- Linking time.
- Disk amplification.
- Concurrent-install behavior.

Security checks must not be disabled for benchmark comparisons.

# Documentation and release cleanup

## Correct stale status claims

`status.md` is stale in several places:

- It reports 180 tests; the current suite has 181.
- It says `package.json` is version `0.0.0` and private; it is version `0.0.3` with public publishing configured.
- Version `0.0.3` is present on the npm registry.
- It says GitHub Actions workflows are defined; this checkout has no `.github/workflows` directory.
- `package.json` still lacks explicit license, repository, homepage, and bugs metadata.
- Its “initial package-manager scope implemented” wording does not disclose the fresh-cache `ci` failure or partial warm-store verification.

Documentation must describe these as correctness blockers rather than only production qualification work.

## Complete release metadata and policy

Before a production claim or stable release:

- Add an approved license.
- Add repository, homepage, and issue tracker metadata.
- Define release ownership and signing policy.
- Produce signed release artifacts and checksums.
- Run the hosted platform matrix successfully.
- Publish and verify a release candidate through the same consumer installation path users will follow.

# Recommended execution order

1. Redesign the lockfile as a complete fetch and reconstruction contract.
2. Make fresh-cache `bnpm ci` reproduce an exact clean installation.
3. Bind lock validity to overrides, dependency kinds, registry/source settings, and workspace state.
4. Require full integrity verification before warm-store reuse.
5. Make lifecycle activation transactional and dependency-topological.
6. Expand resolver, workspace, and optional-dependency compatibility.
7. Add native cross-platform CI and failure-injection testing.
8. Add metadata caching, conditional fetches, retry backoff, and lock-driven cache repair.
9. Implement or accurately document the physical storage strategy.
10. Broaden configuration, CLI, and advanced package-manager feature parity.
11. Correct status and architecture documentation after implementation behavior is verified.
12. Complete signed release qualification before describing the project as production-ready.

# Definition of production-ready

Better NPM should not be described as production-ready until all of the following are demonstrated:

- A lockfile alone can reproduce a project on a fresh machine without mutable resolution.
- `bnpm ci` produces a clean, exact installation and removes extraneous state.
- Every reused package is verified against immutable expected content.
- Lifecycle failure cannot leave an apparently successful installation.
- Resolver and workspace behavior pass a broad compatibility corpus.
- macOS, Linux, and Windows run the full native test and smoke matrix.
- Private registries and common enterprise networking configurations are qualified.
- Crash, corruption, concurrency, and resource-exhaustion campaigns recover safely.
- Performance and disk-use results hold across representative real projects.
- Release artifacts, metadata, checksums, and signing policy are complete.

# Comparison references

- [npm package specifications](https://docs.npmjs.com/cli/v11/using-npm/package-spec/)
- [npm configuration](https://docs.npmjs.com/cli/v11/using-npm/config/)
- [pnpm feature comparison](https://pnpm.io/next/feature-comparison)
