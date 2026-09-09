/**
 * Timeout for any `it` in this package that runs `fc.assert` (technical/10).
 *
 * Not part of the package's public API — it is deliberately absent from `index.ts`. It lives under
 * `src/` because that is the only tree the repository type-checks and lints.
 *
 * **Why it exists.** A property test does hundreds of iterations of real work per `it`, so it must
 * not inherit Vitest's 5 s default timeout: a gate whose verdict depends on how fast the machine
 * is, is not a gate. That is not hypothetical — `packages/domain`'s two model suites passed on a
 * developer laptop and timed out at 5 000 ms on a two-core CI runner (run 34363371997). The six
 * property tests here have the same exposure and now carry the same cap; it is set far above the
 * work rather than just above it, because it exists to catch a hang, not to bound a slow machine.
 *
 * **Why it is a copy of `packages/domain/src/testing/property.ts`** rather than a shared import:
 * `contracts` is the innermost ring and the dependency rule gives it no workspace import at all
 * (`biome.json`, `lint/style/noRestrictedImports`). Two numbers duplicated is cheaper than an
 * import allowance that exists only for tests. A shared home needs its own package; see
 * `docs/technical/PROGRESS.md`.
 */
export const PROPERTY_TEST_TIMEOUT_MS = 30_000;
