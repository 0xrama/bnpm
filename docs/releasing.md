# Release process

Better NPM uses semantic versions. During the `0.x` series, a minor release may contain compatibility changes; patch releases remain backward-compatible bug and security fixes.

## Release checklist

1. Move relevant entries from `Unreleased` in `CHANGELOG.md` into a section named for the new version and date.
2. Run `bnpm version <version>` or update the manifest through an equivalent reviewed change.
3. Run `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run verify:package`, and `npm run benchmark`.
4. Confirm the hosted Linux, macOS, and Windows CI matrix passes.
5. Review the packed file list and SHA-256 checksum. Do not release from a dirty working tree.
6. Create and push an annotated, signed `v<version>` tag. The tag must exactly match `package.json`.
7. The release workflow rebuilds and tests the npm tarball, uploads it with `SHA256SUMS`, and creates the GitHub release.
8. Publishing to a registry is a separate authorized action. Use trusted publishing and generated provenance with explicit public access; never place a long-lived registry token in the workflow.

The package remains marked private until project ownership, package namespace, and licensing are explicitly approved. The artifact workflow intentionally does not bypass that gate.
