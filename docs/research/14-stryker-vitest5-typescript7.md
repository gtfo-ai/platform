# 14 — StrykerJS against this repository's pinned toolchain (vitest 5, TypeScript 7)

> Gathered by the architect's research agent, session 8 (2026-09-27), for the M5 placement of
> **WP-78** (mutation testing). The repository pins `vitest` 5.0.0, `@vitest/coverage-v8` 5.0.0 and
> `typescript` 7.0.2 (`package.json`). Everything below was read from the npm registry and the
> StrykerJS repository on that date; an item marked `[unverified]` is an inference and is listed in
> `docs/TODO.md` under *Verification*.

## Versions and licence
- `@stryker-mutator/core` **10.0.0**, published 2026-08-14, Apache-2.0, `engines.node >=22.0.0`
  (previous: 9.6.1, 2026-04-10). https://registry.npmjs.org/@stryker-mutator/core
- `@stryker-mutator/vitest-runner` **10.0.0**, same day, Apache-2.0.
  https://registry.npmjs.org/@stryker-mutator/vitest-runner

## Vitest 5
- The runner's peer range at v10.0.0 is `vitest >=2.0.0`, so it installs beside vitest 5.0.0 with no
  peer warning.
  https://github.com/stryker-mutator/stryker-js/blob/v10.0.0/packages/vitest-runner/package.json
- **Blocker, open:** issue #6210 — on Vitest 5 the runner's per-test name filter matches nothing
  (Vitest 5 joins names with `' > '`, the runner with a space), so every covered mutant reports
  *Survived*; the reporter's score fell from 47.36 to 2.96.
  https://github.com/stryker-mutator/stryker-js/issues/6210 — fix PR #6220, open:
  https://github.com/stryker-mutator/stryker-js/pull/6220
- Related, open: #6213 (mutants with `testsCompleted: 0` reported as Survived).
  https://github.com/stryker-mutator/stryker-js/issues/6213
- `coverageAnalysis: "all"` may sidestep the name filter — `[unverified]`.

## TypeScript 7
- The instrumenter parses with Babel, not the TypeScript API.
  https://registry.npmjs.org/@stryker-mutator/instrumenter
- **Blocker, open:** core 10.0.0 imports `typescript` to rewrite `tsconfig.json` in the sandbox and
  crashes on TypeScript 7 (`ts.parseConfigFileTextToJson is not a function`) unless run `inPlace`.
  https://github.com/stryker-mutator/stryker-js/blob/v10.0.0/packages/core/src/sandbox/ts-config-preprocessor.ts
  — fix PR #6231, open: https://github.com/stryker-mutator/stryker-js/pull/6231; tracking issue
  #6111, open: https://github.com/stryker-mutator/stryker-js/issues/6111
- Workarounds: `--inPlace` (follows from the code above), or TypeScript 6 installed under the name
  `typescript` (`[unverified]`, and it would be a second compiler in a repository that pins one).

## pnpm and vitest `projects`
- Under pnpm, plugins must be listed in the config's `plugins` array.
  https://github.com/stryker-mutator/stryker-js/blob/master/docs/troubleshooting.md
- No option selects one project of a multi-project vitest config (issue #6215, PR #6216, both open),
  so a run executes every project — this repository's `vitest.config.ts` declares several.
  https://github.com/stryker-mutator/stryker-js/issues/6215
- The runner forces `pool: 'threads'` (documented limitation), and #6223 (open) reports SIGSEGV on
  large test sets under it.
  https://github.com/stryker-mutator/stryker-js/blob/master/docs/vitest-runner.md ·
  https://github.com/stryker-mutator/stryker-js/issues/6223

## Consequence for the plan
A StrykerJS 10.0.0 run over this toolchain today would either crash at start (TypeScript 7) or report
a near-zero score (Vitest 5), so WP-78's `break: 70` would fail on the instrument, not on the tests.
WP-78 is therefore scheduled in M5 **behind an upstream precondition** (#6210 and #6231 fixed in a
published release), re-read when the row is picked up.
