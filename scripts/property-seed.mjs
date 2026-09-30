/**
 * Which seed every fast-check property in this repository draws from (WP-97, PROGRESS backlogs 253
 * and 270).
 *
 * **In the gate, one fixed seed, for every property in every package.** Unseeded, fast-check draws
 * a fresh seed per run, so a branch a property reaches only on some draws is covered on some runs
 * and not others — WP-70 measured two branches of `cost/ledger.ts` moving between runs of one tree,
 * and a coverage ratchet (`coverage-ratchet.mjs`) that reads a figure which moves by itself would
 * flap. WP-73c fixed the seed for `packages/domain` alone, by an import each property file had to
 * remember; the ten property files outside it still drew fresh seeds, so their rings could still
 * move and an unseeded plant under `packages/application` passed the census. Now the seed is set
 * by a vitest **setup file** (`test/support/property-seed.ts`) in every project that collects a
 * property file, so no file can forget it and `contracts` — which the dependency rule gives no
 * workspace import — gets it without one. `property-seed.test.ts` holds the setup file to every
 * such project, and refuses a file that sets a seed of its own.
 *
 * **Out of the gate, a fresh seed, weekly.** What a fixed seed costs is exploration: a run meets
 * only the draws the last one met, and a new value is drawn only when a test or this constant
 * changes. `.github/workflows/property-exploration.yml` buys it back — `property-exploration.mjs`
 * draws a random seed, runs every property file with it through `PROPERTY_SEED`, and on a failure
 * prints the seed and the command that replays it. It is scheduled, never a pull-request gate, so a
 * counterexample it finds is a red workflow somebody reads, not a flaky merge.
 *
 * Plain JavaScript with no imports, because both a vitest setup file and a plain Node script read
 * it. Its test tier is `property-seed.test.ts` (standing rule 33).
 */

/** The environment variable that overrides the gate seed — the exploration run's, and a replay's. */
export const PROPERTY_SEED_VARIABLE = 'PROPERTY_SEED';

/**
 * The gate's seed. Its value is the one WP-73c chose for `packages/domain`, kept so the domain's
 * properties explore exactly what they explored before the seed moved here.
 */
export const GATE_PROPERTY_SEED = 20_260_927;

const INT32_MIN = -(2 ** 31);
const INT32_END = 2 ** 31;

/**
 * The seed a run draws from: the environment's when it names one, the gate's otherwise. A value
 * that is not a 32-bit integer is **refused**, never read as "unset" — a replay that silently ran
 * on the gate seed would report green for a counterexample it never drew.
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {{ seed: number, source: 'gate' | 'environment' }}
 */
export const seedFrom = (env) => {
  const raw = env[PROPERTY_SEED_VARIABLE];
  if (raw === undefined || raw === '') return { seed: GATE_PROPERTY_SEED, source: 'gate' };
  const seed = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(seed) || seed < INT32_MIN || seed >= INT32_END) {
    throw new Error(
      `${PROPERTY_SEED_VARIABLE} must be a 32-bit integer (fast-check's seed), got ${JSON.stringify(raw)}`,
    );
  }
  return { seed, source: 'environment' };
};
