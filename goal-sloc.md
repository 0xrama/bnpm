# Structural SLOC pass

## Target and metric

- Target: structural reductions only; stop before cosmetic, risky, or scope-cutting changes.
- Metric: non-blank, non-`//`-comment-only TypeScript/JavaScript lines; doc comments count.
- Baseline: **14,252** (`src` 10,146; `test` 3,990; `scripts` 116).
- Current: **14,207** (`src` 10,102; `test` 3,989; `scripts` 116), a net reduction of **45**.
- Floor: one six-line ambient declaration is generated/type scaffolding; tests and scripts are tracked separately. No vendored source is counted.

## Preflight and verification

- Branch: `simplify/sloc-audit` (no commits made because repository instructions require explicit authorization).
- Baseline and milestone checks: `npm run check`, `npm test` (185/185), `npm run verify:package`, and `git diff --check`.
- Runtime exercise: isolated live install of `is-number@7.0.0`, followed by loading and exercising its API.
- Semantic analysis: TypeScript `noUnusedLocals`/`noUnusedParameters`, Knip unused-file/export analysis, Madge orphan/cycle analysis, and JSCPD duplication analysis.
- Current duplication report: 17 duplicated lines (0.16%); remaining matches cross validation boundaries where consolidation would increase coupling.

## Changes

- Deleted one semantically unreferenced internal function and other unused declarations/imports/parameters.
- Enabled TypeScript unused-local and unused-parameter checks to prevent recurrence.
- Consolidated repeated install callback wiring, bounded concurrency, bounded HTTP-body reads, and trust-response validation.
- Preserved response limits, error semantics, concurrency behavior, and command behavior.
- Independent review found no blocker; it prompted restoration of an exported deep-import API and stricter validation in the shared concurrency helper.

## Self-audit

- Structural reductions: **100%** (dead-code removal and genuine de-duplication).
- Cheap levers: **0%** (no comment trimming, whitespace packing, formatter changes, ruler changes, or scope cuts).
- Stop condition: the structural well is nearly dry. Remaining larger proposals would centralize command metadata across parser/help/dispatch or couple manifest and CLI validation; their regression and architecture risk exceeds their modest format-normalized savings.
