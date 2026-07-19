# Better NPM

Better NPM (`bnpm`) is an npm-compatible package manager designed for fast installs and explicit supply-chain security decisions.

> Better NPM has a functional alpha command surface. It is not production-qualified yet; review the limitations below before using it for critical projects.

## Commands

- `bnpm install [spec...]` resolves and installs dependencies with bounded resolve, fetch/cache, byte-download, inspection, and linking progress; explicit specs are saved by default. Lockfile-only, non-mutating dry-run, and dev/optional/peer omit/include modes are supported.
- `bnpm ci` recreates the installation exactly from `bnpm-lock.yaml`.
- `bnpm add <spec...>` updates `package.json` and installs.
- `bnpm remove <name...>` removes dependencies and updates the installation.
- `bnpm update [name...]` refreshes all or selected dependencies within declared ranges.
- `bnpm outdated [name...]` reports current, wanted, and latest versions.
- `bnpm list [name...]` displays the installed graph; `bnpm why <name>` explains installation paths.
- `bnpm query <selector>` supports npm-style graph combinators, dependency groups, semver/manifest selectors, registry-enriched outdated and vulnerability filters, and expected-result assertions. `bnpm diff` emits verified unified patches for the local package or two registry, directory, remote-tarball, or secure Git sources with path, context, whitespace, prefix, and name-only controls; `bnpm find-dupes` reports duplicate identities.
- `bnpm bin`, `bnpm prefix`, and `bnpm root` print local or global installation paths.
- `bnpm run [--workspaces|--workspace <name>] [script] [-- args...]` lists scripts or analyzes and runs a project, selected workspaces, or every workspace; install mutations accept the same workspace selection and `--if-present` safely skips missing scripts. Scripts receive npm-compatible lifecycle and package environment variables.
- `bnpm test`, `start`, `stop`, `restart`, `install-test`, and `install-ci-test` provide npm-compatible script workflows.
- `bnpm audit` combines local static findings with npm registry advisories; `bnpm audit fix` applies safe in-range re-resolution and supports dry-run.
- `bnpm exec <bin> [-- args...]` runs an installed binary; repeated `--package <spec>` options install inspected packages ephemerally before execution.
- `bnpm explore <package> [-- command...]` runs a command inside an installed package.
- `bnpm edit <package>` opens a project-local installed instance and invalidates it for verified replacement on the next install.
- `bnpm pack [directory]` creates a deterministic npm-compatible tarball; use `--dry-run` or `--pack-destination` as needed.
- `bnpm publish [directory]` packs and publishes the exact verified artifact with scoped auth, tag, access, OTP, trusted-publisher OIDC, Sigstore provenance, and dry-run support.
- `bnpm stage` safely publishes, lists, inspects, downloads, approves, or rejects staged artifacts; `bnpm unpublish` handles exact registry removals.
- `bnpm access`, `owner`, `token`, `star`, `org`, `team`, `profile`, and `trust` expose bounded package and account administration, granular tokens, trusted publishers, passwords, and 2FA. Passwords use masked prompts and are never accepted as CLI operands.
- `bnpm login`, `bnpm logout`, and `bnpm whoami` manage web authentication, explicit legacy authentication, and identity.
- `bnpm view`, `bnpm search`, `bnpm dist-tag`, and `bnpm deprecate` provide bounded registry metadata and package-maintenance workflows.
- `bnpm init`/`bnpm create` creates default packages, safely registers new workspaces, or resolves and executes inspected `create-*` initializer packages with npm-compatible naming and argument forwarding. `bnpm version` runs npm-compatible authoring lifecycles, semantic/prerelease calculation, lockfile synchronization, transactional workspace selection, clean-tree checks, Git commits and tags (or manifest-only mode); `bnpm config` manages safe user settings.
- `bnpm shrinkwrap` exports the verified registry graph as deterministic npm lockfile v3 data.
- `bnpm approve-scripts` and `bnpm deny-scripts` explicitly mutate exact lockfile-bound lifecycle approvals.
- `bnpm prune`, `bnpm dedupe`, `bnpm rebuild`, `bnpm fund`, `bnpm cache add|ls|info|verify|clean`, `bnpm ping`, and `bnpm doctor` maintain and diagnose verified installations, storage, and registry access. Cache cleanup can target one package identity instead of deleting the entire store.
- `bnpm install-scripts approve|deny|ls|prune` manages exact integrity- and content-hash-bound lifecycle approvals; `approve-scripts` and `deny-scripts` remain concise aliases.
- `bnpm pkg`, `bnpm sbom`, `bnpm link`/`unlink`, and `bnpm completion` cover manifest updates, software bills of materials, live development links, and shell integration.
- `bnpmx <spec> [-- args...]` installs and inspects an ephemeral package, gives a decision-first summary of detected execution capabilities across its dependency graph, and requires confirmation before starting it. Use `bnpmx --details <spec>` for raw package and file evidence.
- `bnpmx check` scans every direct and transitive package recorded for the current project, reports runtime capabilities, lifecycle scripts, static findings, and registry advisories, and never executes package code.

Install, remove, update, outdated, list, why, audit, exec, bin, and prefix support `-g`/`--global` where applicable. Registry selection supports user/project `.npmrc`, scoped registries, path-scoped bearer/basic credentials, environment expansion, and one-shot `--registry` overrides. Dependency sources include registry packages, workspaces, bare, absolute, or `file:` local directories and package archives (saved canonically as relative `file:` requirements), HTTPS tarballs, and HTTPS/SSH Git repositories and hosted shortcuts, including semver tag selection, package subdirectories, validated recursive submodules, and approved prepare builds.

## Implemented safeguards

- Full-graph recent-publication checks with a first-use 1/6/24-hour policy, mature-version fallback during direct and transitive resolution, and exact non-cascading overrides.
- Bounded HTTPS metadata/tarball requests, redirects, retries, deadlines, archive sizes, and extraction ratios.
- Strong integrity verification before safe extraction and content-addressable promotion.
- Explainable high-confidence static findings for reverse shells, remote payload execution, miners, credential targeting, persistence, destructive commands, and obfuscated process execution.
- Pre-execution capability disclosure for ephemeral binaries, including AI-session history, credential/config access, network requests, local writes, subprocesses, and opaque native code.
- Lifecycle approval bound to package version, integrity, stage, command hash, and referenced-content hash.
- Deterministic lockfile security records, isolated package instances, offline/frozen installs, and interrupted-layout recovery.

Approved lifecycle scripts are **not sandboxed**. They run with the current user's normal operating-system permissions after an exact approval.

## Current limitations

- The implementation is still alpha. Initial live-project, adversarial-archive, concurrency, corruption-repair, and controlled performance checks pass, but the broader production matrix is not complete.
- The latest controlled isolated-cache fixture puts cold installs in pnpm's range while retaining static inspection; verified warm installs are about twice as fast. Results vary with registry conditions, and larger-project qualification remains incomplete.
- macOS is the primary development target. Linux and Windows interfaces exist, but neither is advertised as production-qualified.
- Native-platform release qualification is not complete. Web authentication is the default; password-only registries require the explicit `--auth-type=legacy` flow.

## Principles

- Resolve and install packages without delegating to another package manager.
- Use a global content-addressable store and isolated symlink layout.
- Quarantine and inspect package archives before linking them into a project.
- Never run dependency lifecycle scripts without informed approval.
- Warn about newly published versions throughout the dependency graph.
- Produce concrete, explainable findings rather than an opaque risk score.

## Development

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

See [`docs/product-spec.md`](docs/product-spec.md), [`docs/threat-model.md`](docs/threat-model.md), [`docs/architecture.md`](docs/architecture.md), and [`docs/releasing.md`](docs/releasing.md).
