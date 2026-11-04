/**
 * The pure half of `verify.mjs`'s `--shard` and `--merge-reports` modes: what the arguments mean,
 * which step of a target is split, what that step is given, and whether a directory holds every
 * part's report. `verify.mjs`'s docblock says what the two modes are for; this file is what
 * `verify-shards.test.ts` holds to it.
 */

/** The prefix every vitest step of a target starts with (WP-213, held by `verify.test.ts`). */
export const BOUNDED_VITEST = 'node scripts/vitest-bounded.mjs run ';

/** Where a part writes its blob, and where the merge reads them from. */
export const BLOB_DIRECTORY = '.vitest-reports';

/**
 * @param {readonly string[]} args the arguments after the target name
 * @returns {{ kind: 'whole' } | { kind: 'shard', index: number, count: number } | { kind: 'merge', dir: string }}
 */
export const parseVerifyMode = (args) => {
  if (args.length === 0) return { kind: 'whole' };
  const [flag, value, ...rest] = args;
  if (rest.length > 0 || value === undefined || value === '') {
    throw new Error(
      `expected nothing, \`--shard <i>/<n>\` or \`--merge-reports <dir>\` after the target; got ${JSON.stringify(args)}`,
    );
  }
  if (flag === '--shard') {
    const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
    const index = Number(match?.[1]);
    const count = Number(match?.[2]);
    if (match === null || index > count) {
      throw new Error(`--shard takes <i>/<n> with 1 ≤ i ≤ n; got ${JSON.stringify(value)}`);
    }
    return { kind: 'shard', index, count };
  }
  if (flag === '--merge-reports') return { kind: 'merge', dir: value };
  throw new Error(`unknown option ${JSON.stringify(flag)}; expected --shard or --merge-reports`);
};

/**
 * The one step of `steps` that runs vitest. A target with none has nothing to split, and one with
 * two would write two parts' blobs under one name — both are refused rather than guessed at.
 *
 * @param {string} target
 * @param {readonly string[]} steps
 * @param {Readonly<Record<string, string>>} scripts package.json's scripts
 */
export const shardableStep = (target, steps, scripts) => {
  const vitest = steps.filter((step) => (scripts[step] ?? '').startsWith(BOUNDED_VITEST));
  if (vitest.length !== 1) {
    throw new Error(
      `${target} cannot be split: it has ${vitest.length} vitest steps (${vitest.join(', ') || 'none'}), and a split needs exactly one`,
    );
  }
  return /** @type {string} */ (vitest[0]);
};

/**
 * What one part's vitest step is given: its part, and a blob for the merge beside the reporters a
 * person reads. Naming any reporter replaces vitest's defaults (`vitest-bounded.mjs`), so `default`
 * is named again.
 *
 * @param {number} index
 * @param {number} count
 */
export const shardArgs = (index, count) => [
  `--shard=${index}/${count}`,
  '--reporter=default',
  '--reporter=blob',
  `--outputFile.blob=${BLOB_DIRECTORY}/${blobName(index, count)}`,
];

/** @param {number} index @param {number} count */
export const blobName = (index, count) => `blob-${index}-${count}.json`;

/**
 * Why `entries` (a directory's listing, or `null` for no directory) is not exactly one complete set
 * of parts — `blob-1-n.json` … `blob-n-n.json` and nothing else — or `null` when it is. A missing
 * part is the case that matters: merged without it, the tier would report fewer files as a pass.
 *
 * @param {readonly string[] | null} entries
 * @param {string} dir
 */
export const blobSetProblem = (entries, dir) => {
  if (entries === null) return `${dir} does not exist: no part of the split reported`;
  const parts = entries.map((entry) => ({ entry, match: /^blob-(\d+)-(\d+)\.json$/.exec(entry) }));
  const strangers = parts.filter(({ match }) => match === null).map(({ entry }) => entry);
  if (strangers.length > 0) {
    return `${dir} holds files that are not part reports: ${strangers.join(', ')}`;
  }
  const counts = new Set(parts.map(({ match }) => Number(match?.[2])));
  if (counts.size !== 1) {
    return counts.size === 0
      ? `${dir} is empty: no part of the split reported`
      : `${dir} holds parts of ${counts.size} different splits (${[...counts].join(', ')})`;
  }
  const count = /** @type {number} */ ([...counts][0]);
  const present = new Set(parts.map(({ match }) => Number(match?.[1])));
  const missing = Array.from({ length: count }, (_, at) => at + 1).filter((i) => !present.has(i));
  if (missing.length > 0) {
    return `${dir} is missing ${missing.map((i) => blobName(i, count)).join(', ')}: a part that never reported is not a pass`;
  }
  const outside = [...present].filter((i) => i < 1 || i > count);
  if (outside.length > 0) {
    return `${dir} holds parts outside 1–${count}: ${outside.map((i) => blobName(i, count)).join(', ')}`;
  }
  return null;
};
