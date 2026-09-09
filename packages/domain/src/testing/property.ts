/**
 * Shared settings for the property and model-based tests of this package (technical/10).
 *
 * Not part of the package's public API — it is deliberately absent from `index.ts`. It lives under
 * `src/` because that is the only tree the repository type-checks and lints.
 *
 * **Why this file exists.** A property test does hundreds of iterations of real work per `it`, so
 * it is one to two orders of magnitude slower than a unit test and must not inherit Vitest's 5 s
 * default timeout. The two `fc.commands` model suites passed on a developer laptop (~1.2 s each)
 * and timed out at 5 000 ms on a two-core CI runner (run 34363371997, job "unit + contract"). A
 * gate that depends on how fast the machine is, is not a gate.
 *
 * The timeout is therefore set far above the work rather than just above it: it exists to catch a
 * hung test, not to bound a slow machine. The run counts are pinned in the same place so the
 * amount of work is a stated decision rather than whatever fast-check's default happens to be, and
 * so the next property test written here inherits both.
 */

/**
 * Timeout for any `it` that runs `fc.assert`. Roughly 25× the slowest property test measured
 * locally, which leaves headroom for a runner several times slower under v8 coverage.
 */
export const PROPERTY_TEST_TIMEOUT_MS = 30_000;

/**
 * Runs for a model-based (`fc.commands`) suite. Each run is a whole command sequence against both
 * the model and the real aggregate, with the invariants re-checked after every step, so a run here
 * costs far more than a run of a plain property (~4 ms locally against ~0.2 ms).
 *
 * **300, not fewer.** The timeout above is what fixes the CI flake; cutting samples would buy
 * about 0.8 s and cost detection power — a bug hit by 1 % of sequences is missed 13.4 % of the
 * time at 200 runs against 4.9 % at 300, and 300 runs still finish some 12× inside the timeout.
 * The `size: '+1'` bias — the thing that decides *what* is explored — is left alone either way.
 */
export const MODEL_RUNS = 300;
