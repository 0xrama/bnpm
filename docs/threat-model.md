# Threat model

## Assets

Better NPM aims to protect developer credentials, source code, local files, CI secrets, compute resources, project integrity, and dependency-graph reproducibility.

## Trust boundaries

Untrusted inputs include registry metadata, package manifests, tarballs, dependency lifecycle scripts, package source files, advisory responses, lockfile changes, and command-line package specifications. The public npm registry is a transport and metadata source, not a guarantee that package contents are safe.

## Primary threats

- A newly compromised package version is selected through a broad range or dist-tag.
- A direct or transitive lifecycle script downloads and executes a payload.
- A script opens a reverse shell, installs a miner, steals credentials, establishes persistence, or modifies files outside the project.
- An archive escapes extraction through `..`, absolute paths, unsafe links, device entries, or platform-specific path confusion.
- A decompression bomb consumes disk, memory, or CPU.
- Registry metadata points to content whose digest differs from the lockfile or expected integrity.
- A mutable tag changes between user approval and download.
- A trusted package changes its scripts without requiring new approval.
- A malicious lockfile or project configuration silently weakens policy.
- Terminal escape sequences or crafted package names mislead the approval interface.

## Controls

### Before extraction

- Require HTTPS registry and tarball URLs.
- Apply response and archive size limits.
- Verify Subresource Integrity using the strongest supported digest.
- Store downloads under unpredictable quarantine paths.

### During extraction

- Normalize paths and reject absolute, parent-relative, drive-prefixed, UNC, NUL-containing, and platform-ambiguous paths.
- Reject links that resolve outside the extraction root.
- Reject device nodes and unsupported entry types.
- Limit file count, expanded bytes, per-file bytes, and compression ratio.
- Do not execute files in quarantine.

### Before installation

- Analyze command strings, referenced scripts, and complete package content.
- Check publication time for every selected version.
- Resolve a dist-tag to an exact version before asking for approval.
- Present concrete evidence and sanitize all terminal output.
- Bind approvals to package identity, integrity, lifecycle command, and referenced-content hash.

### During script execution

- Never execute a lifecycle script without explicit or previously valid approval.
- Execute approved scripts sequentially with package-attributed output.
- State that scripts run unsandboxed with the user's permissions.
- Avoid passing Better NPM credentials to child environments unless required.
- Redact secrets from diagnostic output where identifiable.

## Accepted limitations

Static analysis cannot prove that code is safe and may miss dynamically constructed behavior. It may also produce false positives. Once approved, an unsandboxed lifecycle script can perform any operation allowed to the current user. Better NPM therefore provides informed control, integrity, quarantine, and reproducibility—not perfect containment.

Runtime behavior after a package is imported by an application is outside the initial permission model. Project scripts are analyzed before `bnpm run`, but application runtime sandboxing is out of scope.

## Policy integrity

Project policy may be committed to source control. Global policy is user-controlled. A project may tighten but must not silently weaken a global recent-release threshold. CI overrides must identify exact package versions. Dangerous and recent overrides must be visible in JSON output and logs.

## Security test requirements

Maintain regression fixtures for path traversal, unsafe symlinks, archive bombs, integrity mismatch, future or malformed publication timestamps, terminal injection, reverse-shell signatures, miner downloaders, obfuscated process execution, changed script hashes, and transitive lifecycle scripts.
