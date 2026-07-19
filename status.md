# Better NPM status

**Updated:** 2026-07-19  
**Repository:** `/Users/sriram/code/bnpm`  
**State:** Functional alpha; initial package-manager scope implemented and green, production qualification still in progress

## Current result

Better NPM now implements its registry package-manager scope without delegating resolution or installation to npm, pnpm, Bun, or another package manager.

The working command surface is:

- `bnpm install [spec...]`
- `bnpm ci`
- `bnpm add <spec...>`
- `bnpm remove <name...>`
- `bnpm update [name...]`
- `bnpm outdated [name...]`
- `bnpm list [name...]` / `bnpm ls`
- `bnpm why <name>`
- `bnpm query <selector>` / `bnpm diff [spec]` / `bnpm find-dupes`
- `bnpm bin` / `bnpm prefix` / `bnpm root`
- `bnpm run [--workspaces] <script> [-- args...]`
- `bnpm test` / `bnpm start` / `bnpm stop` / `bnpm restart`
- `bnpm install-test` / `bnpm install-ci-test`
- `bnpm exec [--package <spec>] <bin> [-- args...]`
- `bnpm explore <package> [-- command...]`
- `bnpm edit <package>`
- `bnpm audit [fix [--dry-run]]`
- `bnpm pack [directory]`
- `bnpm publish [directory]`
- `bnpm stage <publish|list|view|download|approve|reject> ...`
- `bnpm unpublish <package@version>`
- `bnpm access ...` / `bnpm owner ...`
- `bnpm token <create|list|revoke> ...`
- `bnpm star` / `bnpm unstar` / `bnpm stars`
- `bnpm org ...` / `bnpm team ...`
- `bnpm profile <get|set|enable-2fa|disable-2fa> ...`
- `bnpm trust <github|gitlab|circleci|list|revoke> ...`
- `bnpm login` / `bnpm adduser`
- `bnpm logout`
- `bnpm whoami`
- `bnpm view <spec>` / `bnpm info <spec>`
- `bnpm search <terms...>`
- `bnpm dist-tag <add|rm|ls> ...`
- `bnpm deprecate <spec> <message>`
- `bnpm repo` / `bnpm docs` / `bnpm bugs`
- `bnpm config <list|get|set|delete> ...`
- `bnpm init|create [initializer]` / `bnpm init -w <path>` / `bnpm version [--workspaces|--workspace <name>]`
- `bnpm shrinkwrap`
- `bnpm prune` / `bnpm dedupe` / `bnpm rebuild [name...]`
- `bnpm install-scripts <approve|deny|ls|prune> ...`
- `bnpm approve-scripts [name...]` / `bnpm deny-scripts [name...]`
- `bnpm fund`
- `bnpm cache add <spec>` / `bnpm cache ls|info [name@version]` / `bnpm cache verify` / `bnpm cache clean [name@version] --force`
- `bnpm ping` / `bnpm doctor`
- `bnpm completion`
- `bnpm pkg <get|set|delete> ...`
- `bnpm sbom [--sbom-format=cyclonedx|spdx]`
- `bnpm link [name...]` / `bnpm unlink [name...]`
- `bnpmx <spec> [-- args...]`
- `bnpmx check`

The implementation supports exact versions, ranges, tags, npm aliases, dependencies, development dependencies, optional dependencies, peer dependencies and deterministic peer contexts, overrides, workspaces, bare, absolute, and `file:` local directories and package archives with canonical relative saves, bare and aliased HTTPS tarballs, HTTPS/SSH Git sources, private and scoped registries, path-scoped authentication, web login/logout, trusted publishing, global installs, platform/CPU/Node checks, offline installs, frozen lockfiles, and warm no-op installs.

It is usable as an npm alternative for the implemented scope. It is still an alpha rather than a production-qualified universal npm replacement; see the remaining parity and qualification work below.

## Validation snapshot

The current working tree passes:

```text
npm run check     strict TypeScript: passed
npm test          180 tests: 180 passed, 0 failed
verify:package    packed install/executable smoke test: passed
git diff --check  passed
```

The test corpus covers CLI protocol behavior, safe configuration mutation, project discovery, manifests and `devEngines`, OS/CPU/libc compatibility, registry routing and authentication, web and explicit legacy login, masked-input token/password/2FA workflows, access/owner/org/team/trust/stage administration, trusted-publisher creation and OIDC, metadata search/view, distribution tags, deprecation and unpublish, resolution, direct and transitive mature-release selection, native and npm shrinkwrap lockfiles, graph querying and diffing, archive attacks, redirect credential stripping, quarantine, bounded install progress, cache verification and targeted/whole-cache cleanup confinement, integrity, immutable-store repair and concurrent promotion, isolated linking, integrity-invalidating package edits, live package links, lifecycle policy/execution/rebuild, root install lifecycle ordering and npm-compatible script environments, ignore-scripts behavior and exact approval listing/pruning, implicit native-addon builds, workspaces and selective workspace scripts/install mutations, lockfile-only and non-mutating dry-run resolution, physical dev/optional/peer omission with complete lock graphs, local directories and package archives, local/global mutations, prune/dedupe relinking, clean installs, selective and audit-driven in-range updates, outdated/funding reporting, recovery, installed and ephemeral process commands, pre-execution capability disclosure and denial, project-wide direct/transitive `bnpmx check`, npm script aliases and the `server.js` start fallback, npm-compatible POSIX and Windows executable shims, audit, SBOM generation, recent releases, HTTPS tarball/Git sources, Git semver/subdirectories/submodules/prepare builds, deterministic packing, authenticated and staged publishing, verified/generated provenance, authoring lifecycle ordering, semantic prereleases, package-lock/shrinkwrap version synchronization and `--no-save`, transactional workspace versioning, Git clean-tree enforcement, version commits/tags and rollback, and the complete static-analysis rule set.

No `TODO` or `FIXME` markers remain in the source or tests; open scope is recorded explicitly below.

## Live registry qualification

Isolated live npm-registry checks passed for:

- Express `4.21.2`, React `19.1.0`, and TypeScript `5.8.3`: 74 packages installed and all three loaded at runtime.
- The benchmark dependency set (`npm-package-arg`, `semver`, `tar-stream`, and `yaml`): 19 packages resolved after correcting optional-peer behavior.
- A combined 93-package fixture: installed successfully and its four benchmark dependencies loaded at runtime.
- A second install of an unchanged project: completed through the verified warm/no-op path.

The live fixtures also exposed and validated fixes for three real npm compatibility cases:

- Registry metadata documents larger than 10 MiB are accepted up to the bounded 32 MiB limit.
- Byte-identical duplicate tar entries are accepted, while conflicting duplicates remain blocked.
- Legacy npm tarballs may use any single consistent top-level directory prefix; mixed roots and traversal still fail closed.

## Installation and security behavior

The installer performs these trust transitions:

1. Resolve mutable requests to exact package identities and a deterministic graph.
2. Apply recent-publication, platform, engine, peer, optional, and override decisions.
3. Download through bounded HTTPS requests into quarantine.
4. Verify the strongest supported integrity digest.
5. Extract with traversal, link, duplicate-conflict, file-count, size, and compression-ratio defenses.
6. Promote integrity-verified content into an immutable content-addressed store without executing it.
7. Analyze package content, native artifacts, lifecycle commands, and executable capability evidence before linking.
8. Build an isolated dependency layout and atomically activate it.
9. Run only lifecycle scripts covered by an exact approval.

Recent releases inside the configured 1, 6, or 24-hour window require an explicit decision. CI and JSON modes never prompt and fail closed unless an exact `name@version` override is supplied.

Lifecycle approvals bind the package name, version, integrity, lifecycle stage, command hash, and referenced-content hash. Approved scripts run sequentially with bounded, attributed output. They are explicitly disclosed as **unsandboxed** and run with the current user's operating-system permissions.

The static analyzer reports stable, explainable findings for reverse shells, downloaded payload execution, credential targeting, persistence, destructive commands, miners, obfuscated process execution, and missing lifecycle files. These findings are evidence, not a guarantee that a package is safe.

Before `bnpmx` starts an executable, it summarizes detected capability evidence across the resolved graph and asks for confirmation when the tool may read AI-assistant histories or credentials, use the network, write local files, spawn processes, or run native code. Non-interactive and JSON executions fail closed unless the exact root `name@version` is supplied through `--allow-dangerous`. `bnpmx check` scans the full locked project graph, separates direct from transitive exposure, and never executes package code.

## Storage, linking, and recovery

- `bnpm-lock.yaml` records deterministic importer graphs, exact package identities, integrity, publication decisions, findings, scripts, and approvals.
- Workspace roots and members have distinct importer records and isolated member views.
- Store entries are content-addressed, sealed, read-only, verified before reuse, serialized per integrity during concurrent promotion, and repaired if corrupt.
- The linker uses isolated package instances, transitive symlinks, root aliases, executable shims, and atomic layout replacement.
- Root and dependency-local `.bin` shims are placed on project/lifecycle script `PATH`, so installed tools can be invoked by name.
- Recovery journals restore the prior valid layout after interruption between backup and activation.
- Normal installs reuse a matching verified lockfile and installed graph; offline and frozen modes fail closed when their required state is unavailable or inconsistent.
- `bnpm edit` opens only a project-local package instance, refuses direct global-store targets, and invalidates the installed layout so the next install restores verified content before using the warm path.

## Controlled performance

Run the isolated comparison with:

```sh
npm run benchmark
```

Latest result on Node `v24.18.0`, using clean per-manager projects/caches and three warm runs:

| Manager | Cold install | Warm median |
| --- | ---: | ---: |
| bnpm | 1,620 ms | 101 ms |
| pnpm | 1,690 ms | 203 ms |
| npm | 2,789 ms | 162 ms |

For this fixture, bnpm's verified warm path is about twice as fast as pnpm, and the latest isolated-cache cold run was in the same range while bnpm also performed quarantine, integrity verification, and static security inspection. Bnpm remained substantially faster than npm. Cold timings vary with registry conditions, so these figures are qualification evidence rather than a universal speed claim.

## Important compatibility corrections

Optional peer dependencies are no longer fetched or auto-installed when absent. Before this correction, `b4a` could pull an unrelated React Native/Babel tree and inflate a 19-package graph to 593 packages. An optional peer already supplied by the environment is used when compatible; a package that also declares it as a normal dependency still installs it normally.

Recent-release policy now participates in version selection instead of rejecting an already-resolved graph. Range and tag updates select the newest mature version, and every transitive dependency is filtered by the same rule; exact `name@version` overrides remain narrowly scoped and do not silently exempt their transitive graph. This covers the failure modes reported in pnpm issues #11165 and #11068.

Root peer resolution is independent of root-name ordering. A declared root host now satisfies compatible peers even when the consumer sorts first, incompatible root peers fail deterministically, and cyclic peer graphs produce a bounded resolution error.

`install <spec>` now follows npm's save-by-default behavior, while `--no-save` remains available. `ci`, common install/uninstall aliases, range-aware updates, outdated reports, graph listing, and concrete `why` paths are implemented. Dependency and project scripts can invoke installed binaries through npm-compatible `.bin` path setup.

User/project `.npmrc` files support default and scoped HTTPS registries, environment-expanded bearer/basic credentials, longest-path credential matching, per-redirect header recalculation, and authenticated registry audit routing. Tokens are never written to `bnpm-lock.yaml`. `--registry` provides a validated one-shot override.

Global commands use an isolated persistent manifest and atomically linked global bin directory, discoverable through `bnpm prefix -g` and `bnpm bin -g`. Packages with `binding.gyp` and no explicit install script receive an exact approval-bound `node-gyp rebuild` lifecycle using bnpm's bundled build tool.

`bnpm pack` uses npm's canonical packlist rules, bounded file reads, normalized archive metadata, deterministic gzip output, and explicit bundled-dependency production closures, including isolated-store symlinks constrained to the selected bundle roots. `bnpm publish` uploads that exact artifact in a single non-retried authenticated PUT, supports tag/access/OTP and `publishConfig`, refuses private packages and unsafe redirects, and runs npm authoring lifecycle phases in order. Supplied Sigstore provenance is verified against the exact package purl and SHA-512 digest; GitHub/GitLab CI can generate current in-toto/SLSA provenance, and trusted-publisher OIDC tokens are exchanged ephemerally without persistence.

Bare and aliased HTTPS tarball dependencies are downloaded without trusting a caller-provided digest, hashed with SHA-512, safely extracted, analyzed, promoted, and locked by exact digest/source. HTTPS/SSH Git dependencies and hosted shortcuts run through bounded non-interactive Git commands with hooks, prompts, and local-file transport disabled, select exact refs or the highest matching semver tag, pin the resolved commit, support path-confined package subdirectories and validated recursive submodules, run approval-gated prepare builds with isolated development dependencies, and pass canonical pack output back through safe extraction before analysis.

## Known compatibility boundaries

The current npm 11 top-level command inventory is implemented, including `install-scripts`, `edit`, `shrinkwrap`, staged downloads, granular token creation, trusted-publisher creation, password/2FA profile changes, and explicit legacy authentication. `query` now evaluates graph combinators, dependency groups, logical/relational pseudos, semver and nested manifest attributes, source types, expected-result assertions, and registry-enriched outdated/advisory selectors. `diff` now supports verified two-version registry comparisons, path filtering, unified patches, name-only output, context/whitespace controls, prefixes, and binary handling. Remaining deliberate boundaries are:

- passwords are accepted only through masked interactive prompts and never through CLI operands or JSON mode;
- query occurrence-only states such as hoisting/deduplication and exact physical `:path()` values are represented from bnpm's identity graph rather than npm Arborist's mutable `node_modules` occurrence tree;
- `diff` accepts registry, local-directory, remote-tarball, and secure Git comparison specs, but Git sources that require a prepare build remain approval-blocked and workspace-selection flags remain narrower than npm's;
- approved lifecycle scripts do not run in an operating-system sandbox;
- bnpm is a package manager and does not provide JavaScript runtime functionality.

## Remaining production qualification

The initial feature scope is implemented. The remaining work is qualification and optimization rather than placeholder command implementation:

- Reduce cold-install latency toward pnpm-class performance while retaining quarantine, integrity, and analysis guarantees.
- Exercise a wider real-project matrix, especially compiled native addons, large monorepos, complex peer graphs, private registries, and packages with approved build scripts.
- Run longer concurrent-writer, interruption, corruption, archive-fuzz, and resource-exhaustion campaigns.
- Qualify macOS release artifacts and installation UX.
- Validate Linux behavior and Windows junction/path/executable-shim behavior on their native platforms.
- Complete the first signed release rehearsal after package namespace and licensing approval.

Cross-platform GitHub Actions jobs, tag/version validation, package tarball smoke installation, SHA-256 checksums, artifact upload, and GitHub release creation are now defined. They remain qualification evidence only after the hosted macOS/Linux/Windows jobs run successfully on the repository.

The local release audit also found that this checkout has no Git remote, while `package.json` is still version `0.0.0`, marked `private`, and has no approved `license`, `repository`, `homepage`, or `bugs` metadata. Those values are ownership and release-policy decisions, so they must not be invented by an implementation pass. A public npm release and hosted CI proof therefore require the maintainer to choose the namespace/license/version, add the repository remote, and authorize publication. The locally generated package tarball and both workflow files validate successfully.

Do not describe bnpm as production-ready until those gates pass. “Functional alpha for the implemented scope” is the accurate current claim.

## Development commands

Requires Node.js 22.22.2 or newer.

```sh
npm install
npm run check
npm test
npm run build
npm run benchmark
npm run verify:package
node dist/src/cli.js --help
```

The working-tree implementation remains largely uncommitted. Preserve unrelated user changes and do not clean, stage, commit, or publish without explicit authorization.
