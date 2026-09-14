/**
 * What "how close was it" means, as arithmetic — product/19 §13 (WP-34).
 *
 * > *"comparison: file-overlap Jaccard, size ratio, tests added ratio, acceptance criteria the human
 * > MR covers vs the agent's"* … *"Aggregate report per shadow batch: predicted cost per ticket by
 * > size, similarity distribution, list of 'high similarity + low cost' tickets as the launch
 * > candidates"*
 *
 * Everything here is pure and takes its inputs as arguments: two lists of changed paths, two diff
 * stats, a list of reported tickets. Nothing reads a clock, a provider or a row — the shadow batch
 * and the report duty in the application ring do that, and this file is what decides what the
 * numbers mean.
 *
 * ## Three judgements the document does not make, stated where they are made
 *
 * 1. **The Jaccard is over `new_path`, case-sensitively, after both sides are deduplicated.** A
 *    provider reports a rename as one file with two paths; using the post-change path on both sides
 *    is the only choice that makes "the agent touched the same file" mean the same thing on both.
 *    Case-sensitively because a repository's path identity is the repository's, not the platform's
 *    (standing rule 15 is the mirror of this: a *guard* folds case because the filesystem does; a
 *    *measurement* must not, or two genuinely different files on a case-sensitive remote become
 *    one).
 * 2. **An empty intersection of two empty sets is `1`, not `0`.** Two diffs that changed nothing
 *    are identical. It is unreachable through the shadow report (a side with no diff produces no
 *    overlap block at all) and it is the mathematically right answer, so it is written rather than
 *    left to a `0/0`.
 * 3. **The size ratio is the agent's changed lines over the human's**, insertions plus deletions,
 *    and it is `null` when the human changed no lines — the same refusal `testsAddedRatio` makes
 *    for the same reason. A ratio with a zero denominator is not "infinitely bigger", it is a
 *    question nobody asked. It is **not** a hypothetical case either: a provider that declined to
 *    render its patches (GitLab's `collapsed`/`too_large`, a `null` body) publishes the file's path
 *    and no lines, so `report.ts` counts zero for a merge request that plainly changed something —
 *    which is why the answer is `null` and the report's `notes` says a diff was not rendered.
 *    Before WP-34's review round 2 this answered `0`, and the Shadow screen printed
 *    *"size ratio: 0.00"* — the agent's work measured against a denominator nobody has (rule 16).
 */

/** One side of the comparison: what a diff touched, and how big it was. */
export interface ShadowDiffSummary {
  /** Post-change paths, in any order; duplicates are collapsed. */
  readonly paths: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
}

export interface ShadowOverlap {
  readonly files_jaccard: number;
  /** `null` when the human side has no countable line to divide by (judgement 3). */
  readonly size_ratio: number | null;
  readonly tests_added_ratio: number | null;
  readonly agent_test_files: number;
  readonly human_test_files: number;
}

/**
 * Whether a changed path is a test file.
 *
 * Deliberately **broad and named**, covering the conventions this platform has actually met rather
 * than a language-complete list: a directory segment called `test`, `tests`, `spec`, `specs`,
 * `__tests__` or `testing`, or a basename carrying `.test.`, `.spec.`, `_test.`, `-test.`,
 * `_spec.`, `-spec.`, or beginning `test_`. Two consequences are stated rather than discovered:
 *
 *  - it **over**-reports on a repository with a directory genuinely called `spec` that holds
 *    something else, which inflates both sides of `tests_added_ratio` and is therefore the safe
 *    direction for a *ratio*;
 *  - it **under**-reports a project whose tests live somewhere else entirely, which is why the two
 *    counts travel beside the ratio: a reader who sees `0 / 0` can tell "no tests were added" from
 *    "this repository does not name its tests the way we look for them".
 *
 * It is case-insensitive on the *pattern* (`Test_`, `.Spec.`) because the conventions are written
 * in both cases in the wild; the Jaccard above is not, because that one is an identity question.
 */
export const isTestPath = (path: string): boolean => {
  const lower = path.toLowerCase();
  const segments = lower.split('/').filter((segment) => segment !== '');
  const basename = segments.at(-1) ?? '';
  const directories = segments.slice(0, -1);
  if (directories.some((segment) => TEST_DIRECTORIES.has(segment))) {
    return true;
  }
  if (basename.startsWith('test_') || basename.startsWith('spec_')) {
    return true;
  }
  return TEST_BASENAME_MARKERS.some((marker) => basename.includes(marker));
};

const TEST_DIRECTORIES: ReadonlySet<string> = new Set([
  'test',
  'tests',
  'spec',
  'specs',
  '__tests__',
  'testing',
]);

const TEST_BASENAME_MARKERS: readonly string[] = [
  '.test.',
  '.spec.',
  '_test.',
  '-test.',
  '_spec.',
  '-spec.',
];

/**
 * `|A ∩ B| / |A ∪ B|`, with two empty sets answering `1` (judgement 2 above).
 *
 * **One guard, not two.** The first draft opened with `if (a.size === 0 && b.size === 0) return 1`
 * *and* ended with `union === 0 ? 1 : …`, and a canary deleting the first left every test green —
 * standing rule 41's shape exactly: a value bounded twice has two untestable guards. The union is
 * zero in precisely the case the early return described, so the ending is the single source and the
 * opening is gone.
 */
export const filesJaccard = (left: readonly string[], right: readonly string[]): number => {
  const a = new Set(left);
  const b = new Set(right);
  let shared = 0;
  for (const path of a) {
    if (b.has(path)) {
      shared += 1;
    }
  }
  const union = a.size + b.size - shared;
  return union === 0 ? 1 : shared / union;
};

const changedLines = (side: ShadowDiffSummary): number => side.insertions + side.deletions;

const testFilesOf = (side: ShadowDiffSummary): number =>
  new Set(side.paths.filter(isTestPath)).size;

/**
 * The whole comparison block, computed once from both sides.
 *
 * `size_ratio` is the agent's changed lines over the human's, and **`null` whenever the human side
 * has no countable line** — whether that is a merge request that genuinely changed nothing or, the
 * reachable case, one whose patches the provider declined to render. Both are the same fact about
 * this number: there is no denominator. The two counts a reader would want instead are not this
 * function's to publish (`agent_diff_stats` carries the agent's, and the report's `notes` says when
 * a side was not rendered), and a `0` here would be read as *"the agent changed nothing"*.
 */
export const compareShadowDiffs = (
  agent: ShadowDiffSummary,
  human: ShadowDiffSummary,
): ShadowOverlap => {
  const humanLines = changedLines(human);
  const agentLines = changedLines(agent);
  const agentTests = testFilesOf(agent);
  const humanTests = testFilesOf(human);
  return {
    files_jaccard: filesJaccard(agent.paths, human.paths),
    size_ratio: humanLines === 0 ? null : agentLines / humanLines,
    tests_added_ratio: humanTests === 0 ? null : agentTests / humanTests,
    agent_test_files: agentTests,
    human_test_files: humanTests,
  };
};

// ── The batch aggregate ──────────────────────────────────────────────────────

/** product/19 §13's size bands; `tasks.size` is the same enum. */
export type ShadowSize = 'S' | 'M' | 'L' | 'XL';

export const SHADOW_SIZES: readonly ShadowSize[] = ['S', 'M', 'L', 'XL'];

/**
 * Five fixed similarity buckets, `[0,0.2) … [0.8,1]`.
 *
 * Fixed rather than computed from the batch, so two batches can be put beside each other. The last
 * bucket is closed at both ends, which is the only way a perfect `1.0` lands anywhere at all.
 */
export const SIMILARITY_BUCKETS: readonly { readonly from: number; readonly to: number }[] = [
  { from: 0, to: 0.2 },
  { from: 0.2, to: 0.4 },
  { from: 0.4, to: 0.6 },
  { from: 0.6, to: 0.8 },
  { from: 0.8, to: 1 },
];

/** What the aggregate needs from one ticket of a batch. */
export interface ShadowBatchEntry {
  readonly ticketKey: string;
  readonly taskId: string;
  readonly size: ShadowSize | null;
  readonly costUsd: number;
  readonly predictedCostUsd: number | null;
  /** `overlap.files_jaccard`, or `null` when this ticket has no comparison. */
  readonly similarity: number | null;
  /** Whether a `shadow_reports` row exists for this ticket. */
  readonly reported: boolean;
}

export interface ShadowBatchAggregate {
  readonly cost_by_size: readonly {
    readonly size: ShadowSize;
    readonly tickets: number;
    readonly median_cost_usd: number;
    readonly median_predicted_cost_usd: number | null;
  }[];
  readonly similarity_distribution: readonly {
    readonly from: number;
    readonly to: number;
    readonly tickets: number;
  }[];
  readonly launch_candidates: readonly {
    readonly ticket_key: string;
    readonly task_id: string;
    readonly similarity: number;
    readonly cost_usd: number;
  }[];
  readonly reported: number;
  readonly compared: number;
}

/**
 * The **median**, not the mean — the same choice product/19 §15 makes for the cost estimate, and
 * for the same reason: one escalated ticket that burned its whole cap would otherwise move the
 * figure a founder reads as "what a ticket of this size costs".
 *
 * Even counts average the two middle values, which is the ordinary definition and is what makes a
 * two-ticket band answer something between its two tickets rather than arbitrarily one of them.
 */
export const medianOf = (values: readonly number[]): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/**
 * product/19 §13's *"list of 'high similarity + low cost' tickets as the launch candidates"*.
 *
 * The two words the document leaves undefined are defined here, once, and the definition travels
 * with the number the screen shows:
 *
 *  - **high similarity** is `files_jaccard >= 0.6` — the top two of the five fixed buckets, so the
 *    threshold is the bucket boundary a reader can already see rather than a second scale;
 *  - **low cost** is *at or below the median cost of the batch's reported tickets*, which makes it
 *    a statement about this batch rather than a dollar figure that ages. A batch with one reported
 *    ticket has that ticket as its own median, so a single similar ticket is a candidate — which is
 *    right: with one sample there is nothing to be cheaper than.
 *
 * Ordered by similarity descending, then by cost ascending, then by ticket key, so the list is
 * stable for a screenshot and for a test.
 */
export const LAUNCH_CANDIDATE_SIMILARITY = 0.6;

export const summariseShadowBatch = (
  entries: readonly ShadowBatchEntry[],
): ShadowBatchAggregate => {
  const reported = entries.filter((entry) => entry.reported);
  const compared = reported.filter(
    (entry): entry is ShadowBatchEntry & { similarity: number } => entry.similarity !== null,
  );

  const costBySize = SHADOW_SIZES.flatMap((size) => {
    const inBand = reported.filter((entry) => entry.size === size);
    if (inBand.length === 0) {
      // Absent, not zero: a band nobody shadowed has no median (standing rule 16).
      return [];
    }
    const predicted = inBand
      .map((entry) => entry.predictedCostUsd)
      .filter((value): value is number => value !== null);
    return [
      {
        size,
        tickets: inBand.length,
        median_cost_usd: medianOf(inBand.map((entry) => entry.costUsd)) ?? 0,
        median_predicted_cost_usd: medianOf(predicted),
      },
    ];
  });

  const distribution = SIMILARITY_BUCKETS.map((bucket, index) => ({
    from: bucket.from,
    to: bucket.to,
    tickets: compared.filter((entry) =>
      index === SIMILARITY_BUCKETS.length - 1
        ? entry.similarity >= bucket.from && entry.similarity <= bucket.to
        : entry.similarity >= bucket.from && entry.similarity < bucket.to,
    ).length,
  }));

  const medianCost = medianOf(reported.map((entry) => entry.costUsd));
  const candidates = compared
    .filter(
      (entry) =>
        entry.similarity >= LAUNCH_CANDIDATE_SIMILARITY &&
        (medianCost === null || entry.costUsd <= medianCost),
    )
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        left.costUsd - right.costUsd ||
        left.ticketKey.localeCompare(right.ticketKey),
    )
    .map((entry) => ({
      ticket_key: entry.ticketKey,
      task_id: entry.taskId,
      similarity: entry.similarity,
      cost_usd: entry.costUsd,
    }));

  return {
    cost_by_size: costBySize,
    similarity_distribution: distribution,
    launch_candidates: candidates,
    reported: reported.length,
    compared: compared.length,
  };
};
