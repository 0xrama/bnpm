# Better NPM product specification

## Mission

Better NPM is a production-oriented npm-compatible package manager that combines pnpm-style installation performance with explicit, evidence-based supply-chain protections. It is a package manager, not a JavaScript runtime.

## Supported platforms

- macOS
- Linux
- Windows
- Node.js 22.22.2 or newer
- Public npm registry compatibility initially

## Commands

| Command | Purpose |
| --- | --- |
| `bnpm install [spec...]` | Install explicit packages or the dependencies in `package.json` |
| `bnpm ci` | Recreate the exact locked installation |
| `bnpm add <spec...>` | Add dependencies to the manifest and install them |
| `bnpm remove <name...>` | Remove dependencies and update the installation |
| `bnpm update [name...]` | Refresh all or selected dependencies within declared ranges |
| `bnpm outdated [name...]` | Report current, wanted, and latest versions |
| `bnpm list [name...]` | Display the installed dependency graph |
| `bnpm why <name>` | Explain root-to-package installation paths |
| `bnpm query` / `bnpm diff` / `bnpm find-dupes` | Inspect the verified graph and package contents |
| `bnpm bin` | Print the local or global executable directory |
| `bnpm prefix` | Print the local or global installation prefix |
| `bnpm root` | Print the local or global `node_modules` directory |
| `bnpm run <script>` | Analyze and execute a project script |
| `bnpm test` / `bnpm restart` / install-test variants | Run npm-compatible script workflows |
| `bnpm audit` | Report registry advisories and local static findings |
| `bnpm exec <bin>` | Execute an already installed package binary |
| `bnpm explore <package>` | Run an exact command in an installed package directory |
| `bnpm edit <package>` | Edit a project-local instance while invalidating verified install state |
| `bnpm pack [directory]` | Create a deterministic npm-compatible package tarball |
| `bnpm publish [directory]` | Publish the exact verified package artifact |
| `bnpm stage` / `bnpm unpublish` | Manage staged and removed package publications |
| `bnpm access` / `bnpm owner` / `bnpm token` | Manage package access and granular authentication tokens |
| `bnpm star` / `bnpm org` / `bnpm team` / `bnpm profile` / `bnpm trust` | Manage registry state, profile security, and trusted publishers |
| `bnpm login` / `bnpm logout` / `bnpm whoami` | Manage web or explicit legacy authentication and identity |
| `bnpm view` / `bnpm search` | Query bounded package metadata and registry search |
| `bnpm dist-tag` / `bnpm deprecate` | Maintain published package metadata |
| `bnpm config` | Manage the safe writable configuration surface |
| `bnpm init` / `bnpm version` | Initialize and version local packages |
| `bnpm shrinkwrap` | Export the verified graph as deterministic npm lockfile v3 data |
| `bnpm prune` / `bnpm dedupe` / `bnpm rebuild` | Maintain and rebuild the verified install graph |
| `bnpm approve-scripts` / `bnpm deny-scripts` | Change exact lockfile-bound lifecycle approvals |
| `bnpm fund` / `bnpm cache` | Report funding and verify or explicitly clean storage |
| `bnpm ping` / `bnpm doctor` | Diagnose registry, runtime, Git, and cache health |
| `bnpm pkg` / `bnpm sbom` / `bnpm link` / `bnpm completion` | Author manifests, export SBOMs, create live links, and configure shells |
| `bnpmx <spec>` | Resolve, quarantine, analyze, cache, and execute a package |

## Dependency compatibility

The first production milestone supports registry packages, dist-tags, semantic version ranges, dependencies, dev dependencies, optional dependencies, peer dependencies, npm aliases, overrides, workspaces, local `file:` dependencies, bare and aliased HTTPS tarballs, and bare and aliased HTTPS/SSH Git sources. Git sources support exact refs, semver tag selection, package subdirectories, validated recursive submodules, and approval-gated prepare builds.

Scoped public and private registry packages are supported through strict `.npmrc` routing, path-scoped authentication, web login/logout, trusted-publisher OIDC, and one-shot HTTPS registry overrides. Packing uses canonical npm file-selection rules, explicit bundled-dependency production closures, and deterministic archives. Publishing supports dry runs, distribution tags, public/restricted access, OTP headers, `publishConfig`, authoring lifecycle phases, verified provenance files, and GitHub/GitLab in-toto/SLSA provenance generation.

## Installation behavior

1. Read the project manifest and configuration.
2. Resolve the complete dependency graph using Better NPM's resolver.
3. Fetch package archives into quarantine.
4. Verify integrity and archive safety.
5. Analyze every package that declares lifecycle scripts, including transitive dependencies.
6. evaluate publication recency for every resolved package.
7. Present all findings and required decisions before linking or execution.
8. Link packages from a global content-addressable store into an isolated project layout.
9. Skip unapproved lifecycle scripts. Installation finishes with a prominent warning if a required script was skipped.
10. Execute approved scripts sequentially and attribute their output to the package and lifecycle stage.

Packages without lifecycle scripts install without a prompt.

## Lifecycle approval

Approvals bind to all of the following:

- Package name and version
- Registry tarball integrity
- Lifecycle stage and exact command
- Hash of the command and referenced script content

Any change invalidates approval. Trusted-package entries may exist at project or global scope, but do not bypass integrity or script-hash matching.

Approved scripts run with the user's normal operating-system permissions. Better NPM does not claim to sandbox them. Every approval view must state this clearly.

## Static findings

Analysis covers lifecycle command strings, referenced shell or JavaScript files, and the complete unpacked package. Findings include a stable rule identifier, severity, behavior description, package, file path, line and column when available, and a minimal evidence excerpt.

Initial high-confidence behaviors include reverse-shell patterns, miner installation or execution, remote payload download followed by execution, credential targeting, persistence mechanisms, destructive filesystem commands, and suspicious obfuscation connected to process or network execution.

A dangerous finding blocks by default. It can be overridden interactively or with an exact `--allow-dangerous=name@version` entry. CI does not accept an unrestricted override.

## Recent-release policy

First-run setup offers 1-hour, 6-hour, and 24-hour warning windows. The global setting is used unless a project enforces a stricter policy. Non-interactive environments default to one hour if no configuration exists.

Every resolved dependency is checked. In CI, recent releases fail installation unless each exact `name@version` is supplied through `--allow-recent`.

## Output

Commands offer a concise interactive interface and `--json`. JSON mode never prompts. Policy failures use documented, stable exit codes and emit machine-readable evidence.

## Non-goals for the first milestone

- Running JavaScript without Node.js
- Claiming complete malware detection
- Enforcing a cross-platform OS sandbox
- Assigning opaque package risk scores
