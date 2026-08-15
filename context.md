# Code Context

## Files Retrieved
1. `src/core/cli-parser.ts` (lines 1-180, 254-883) - command type/catalog, aliases, option parsing, normalization, and validation.
2. `src/core/cli-runner.ts` (lines 1-293) - confirms parsed commands are dispatched directly through `runCommand`; no filename/reflection-based command loading.
3. `src/commands/index.ts` (lines 1-61, 1035-1075) - command catalog and the largest concrete duplicated call construction.
4. `src/linker/project-linker.ts` (lines 1-200) - contains the sole source export with no source/test reference.
5. `src/registry/account.ts` (lines 1-33) - one bounded JSON response reader.
6. `src/registry/operations.ts` (lines 1-83, 415-458) - a second bounded JSON response reader and duplicated trust-result decoding.
7. `src/package/trusted-publishing.ts` (lines 9-24) - a third bounded JSON response reader with different failure semantics.
8. `src/installer/install.ts` (lines 81-95) - duplicated concurrency helper.
9. `src/security/audit.ts` (lines 13-19) - duplicated concurrency helper.
10. `package.json` (lines 1-39) - package has CLI bins and ships `dist/src`, but defines no `exports` map/library entry point.

## Key Code

### Ranked genuine reduction candidates

#### 1. Centralize the command catalog (high confidence, largest likely reduction)
Evidence:
- `src/core/cli-parser.ts:79-81` repeats the full canonical command union in `ParsedCommand.name`.
- `src/core/cli-parser.ts:113-180` maintains a second command catalog as `commandAliases`.
- `src/commands/index.ts:51-52` maintains the canonical names again as `commandNames` / `CommandName`.
- `src/core/cli-runner.ts:78-148` separately hard-codes the displayed command catalog in help text.

A single command metadata constant (canonical name, aliases, help row) could derive the canonical union, alias lookup, completion names, and help rows. This removes substantial duplicated command declarations rather than packing lines. Dynamic-dispatch constraint is satisfied: `src/core/cli-runner.ts:151-167` calls imported `runCommand` directly, and `src/commands/index.ts` branches on the canonical name; there is no filesystem-based dynamic command discovery to preserve.

Risk: **medium-high**. Alias-specific rewrites still exist in `parseInvocation` (`src/core/cli-parser.ts:731-765`, e.g. `ci`, script aliases, `get`, `set`, `undeprecate`) and must not be mistaken for catalog-only data. Help ordering/descriptions are user-visible CLI contract. Avoid introducing a circular import between parser and commands; place metadata in a neutral core module.

#### 2. Extract one bounded HTTP JSON reader (medium confidence)
Evidence:
- `src/registry/account.ts:8-33` buffers a response with a byte cap, parses JSON, validates an object, and maps failures to `RegistryError`.
- `src/registry/operations.ts:8-27` implements essentially the same loop/parser, adding optional arrays and a different cap/message.
- `src/package/trusted-publishing.ts:9-24` repeats the bounded buffering/parser yet again, returning `undefined` instead of throwing.

A small shared primitive parameterized by maximum bytes and object/array acceptance can remove roughly two implementations while callers retain their distinct error/optional behavior. This is genuine duplicated mechanism, not stylistic consolidation.

Risk: **medium**. Preserve 1 MiB versus 32 MiB limits, empty-body behavior, array acceptance, response status in errors, and trusted-publishing's deliberate fail-closed-as-`undefined` behavior.

#### 3. Extract the identical bounded-concurrency loop (high confidence, modest reduction)
Evidence:
- `src/installer/install.ts:84-88`
- `src/linker/project-linker.ts:52-56`
- `src/security/audit.ts:16-19`

All three use a shared index and `Promise.all(Array.from({length: min(concurrency, values.length)}, next))` with the same fail-fast semantics. A private core utility would replace three copies with one.

Risk: **low**. Keep ordering, fail-fast rejection, and the current behavior for empty inputs/concurrency. Net reduction is modest after the new module/imports.

#### 4. Remove the unreferenced `validateLinkedPackage` export (high confidence, tiny reduction)
Evidence:
- `src/linker/project-linker.ts:197-200` defines `validateLinkedPackage`.
- Repository-wide exact-symbol search finds no other source or test reference.
- It is not part of CLI dispatch: dispatch is static through `src/core/cli-runner.ts:1-6,151-167`.

This removes the function and makes `readFile` removable from the import at `src/linker/project-linker.ts:2` (no other use in that file).

Risk: **low-medium**. `package.json:12-16` ships all of `dist/src`, and there is no `exports` map, so consumers could deep-import this undocumented function even though the package declares only CLI bins (`package.json:6-9`). If deep imports are considered supported, deprecate or add an exports boundary before removal.

#### 5. Deduplicate install/mutation callback option construction (medium confidence, modest reduction)
Evidence:
- `src/commands/index.ts:1049-1075` repeats the same `signal`, registry, prompts, child-output, security-evidence, and progress properties for `addDependencies`, `removeDependencies`, and `updateDependencies`.

Construct one shared mutation options object before the ternary and pass it to all three calls. This removes real repeated wiring and reduces the chance that one mutation path omits a security callback.

Risk: **low-medium**. Check contextual TypeScript typing/excess-property behavior and ensure prompts are instantiated once per workspace operation exactly as intended.

#### 6. Share trust response decoding locally (high confidence, tiny reduction)
Evidence:
- `src/registry/operations.ts:421-429` and `src/registry/operations.ts:445-454` both normalize object-or-array results and validate every element as a non-array object with the same error.

A local `trustConfigurations(result)` helper removes the duplicate validation block.

Risk: **low**. Preserve returned readonly-object shape and exact rejection of primitives/null/nested arrays.

### Audit exclusions / negative findings
- No semantically dead source file was found: every `src/**/*.ts` file participates through a static import or is the CLI entry point/type declaration.
- No placeholder/no-op subsystem was found. Searches for TODO, “not implemented,” no-op markers, and trivial empty returns only found legitimate optional/error cases.
- Clone analysis found only 55 duplicated lines out of ~10.8k source lines; aside from the candidates above, reported similarities were short domain-specific validation blocks where abstraction would likely add indirection without meaningful net SLOC reduction.
- Individual exported declarations generally have source/test consumers. Because `dist/src` is shipped without an `exports` boundary, removing other apparently internal exports solely because tests do not import them would carry avoidable deep-import compatibility risk.

## Architecture
`src/cli.ts` invokes `runCli`; `src/core/cli-runner.ts` parses with `parseInvocation` and statically dispatches canonical names to the monolithic `runCommand` in `src/commands/index.ts`. That command layer wires focused command, installer, registry, package, project, cache, and security modules. Consequently, command names and exports cannot be judged by filename-based usage: aliases are normalized in the parser, then dispatched through the canonical union. The only proven dead export is `validateLinkedPackage`; command modules themselves are all imported by the command hub or downstream modules.

## Start Here
Open `src/core/cli-parser.ts` first. Its repeated command union/alias catalog is the highest-value structural reduction and defines the constraints that any shared command metadata must preserve.
