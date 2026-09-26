/**
 * One provider read per `(merge request, head sha)` — WP-59, PROGRESS backlog **64**.
 *
 * ## What it removes
 *
 * Three `pipeline.outbound` duties read a task's changed files through `getMergeRequestDiff`, each
 * for a reason the others cannot serve: the **dependency gate** when the Developer stage completes
 * (WP-38, it needs the patches), and at the rebase gate the **conflict warning** (WP-26, the task's
 * own diff and one per peer) and the **risk routing** (WP-37). Before this module every one of them
 * asked the provider, so one merge request at one revision was downloaded once per duty and once
 * per *other* task whose gate compared against it — the `K × (1 + min(K − 1, 10))` backlog 64
 * derived for a busy default branch. A merge request's diff at a fixed head sha is **stable**:
 * the revision is the identity (`conflictWarningIdempotencyKey` already treats it as one), so the
 * second asker within the window gets the first answer and no second request is made.
 *
 * ## What it deliberately does not coalesce
 *
 * **The pipeline status** (`gitReads.pipelineStatus`), and the reason is not the same as this
 * module's: a pipeline for a fixed sha is **not** stable. It moves from `running` to a terminal
 * state, and a re-run on the same revision reports a different outcome and a different coverage —
 * which is exactly why the coverage duty refuses to cache the head (`coverage.ts`). A coalesce there
 * would have to be bounded in *time* rather than keyed by sha, and a window chosen wrongly answers
 * the CI gate with a stale status: that is behaviour, where this is bandwidth.
 *
 * A read with **no head sha** is not coalesced either: `MergeRequestRef.head_sha` is nullish, and a
 * key without a revision would answer a changed merge request with its old files.
 *
 * ## Its bounds and its residuals, stated
 *
 *  - **Process-local.** The memo lives in this process, keyed off the long-lived
 *    `PipelineIntegrationsPort` the runtime composes (a `WeakMap`, so there is no wiring to forget and
 *    a test harness gets its own). Two processes that both run `pipeline.outbound` jobs each read
 *    once; that is still the `K²` factor gone per process, and it is not a second copy of the
 *    provider's answer in the database — no new table holds somebody's patches (BD-022).
 *  - **A window of {@link DIFF_COALESCE_WINDOW_MS}.** Long enough to span one gate entry's duties and
 *    a burst of gate entries after a default-branch move, and in the ordinary case the Developer
 *    stage's completion and the rebase gate at the same revision; a gate reached later than that
 *    reads again. The window is the memory bound together with {@link MAX_COALESCED_DIFFS}, not a
 *    freshness rule — freshness is the key's.
 *  - **The key is the revision the platform recorded**, `tasks.mr_ref.head_sha`, which moves when a
 *    stage that pushes reports `ImplementationNotes` (the Developer and the conflict resolution)
 *    and — since WP-60 (PROGRESS backlog 182) — when the provider's `mr.updated` announces a push
 *    the platform did not make, a human's or the take-over's (`provider-signals.ts`) — **forward
 *    only**, by the provider's `updated_at`, so a late delivery for an older push cannot hand this
 *    key an older revision (the CI gate no longer reads this head: it asks the provider for the
 *    live one, WP-60 review round 2). Until then a
 *    commit somebody else pushed did not move it, and inside the window the duties read the files
 *    as they were at the recorded revision. The residual now is the delivery's latency: between a
 *    push and its `mr.updated` being dispatched, the key is still the old revision — the same one
 *    every other identity on the task (the warning's idempotency key,
 *    `tasks.dependencies.head_sha`) names.
 *  - **One audit row per provider call, not per asker.** The executor records the request it made;
 *    an answer served from here was not a request and leaves no `integration_actions` row. The row
 *    that exists names the task that asked first.
 *  - **A failure is not remembered.** A rejected read is evicted, so a retry asks the provider again.
 *  - **Neither is an empty answer** (WP-59 review round 1). GitLab computes a merge request's diff
 *    **asynchronously** after a push, so a read made moments after the head moved can answer `[]`
 *    for a revision that does change files — and held for the window, that `[]` would tell the
 *    risk routing there is nothing to classify and the conflict warning there is nothing to compare,
 *    for fifteen minutes. So an empty answer is served to whoever asked alongside it (a concurrent
 *    asker shares the in-flight request) and then dropped; the next asker reads again. A merge
 *    request that genuinely changes nothing costs a read per asker, which is the cheap direction.
 */
import type { Id } from '@platform/contracts';
import type { FileDiff, MergeRequestRefInput } from '../ports/integrations/git-provider.js';
import {
  gitReads,
  type PipelineIntegrations,
  type PipelineIntegrationsPort,
} from './integrations.js';

/** How long one answer is served — see the module docblock for why this is a bound, not a TTL. */
export const DIFF_COALESCE_WINDOW_MS = 15 * 60_000;

/**
 * How many answers are held at once. Sixty-four is six conflict-warning fan-outs
 * (`MAX_CONFLICT_PEERS` + 1 = 11 merge requests each) — more than one burst of gate entries needs —
 * and at most 64 × `MAX_CONFLICT_FILES` file entries of provider text in memory.
 */
export const MAX_COALESCED_DIFFS = 64;

interface Entry {
  readonly atMs: number;
  readonly value: Promise<readonly FileDiff[]>;
}

export interface MergeRequestDiffCoalescer {
  /**
   * The answer for `key`: the one already held when it is younger than the window, otherwise
   * `perform`'s — and a concurrent asker waits on the same in-flight request rather than making its
   * own.
   */
  readonly read: (
    key: string,
    nowMs: number,
    perform: () => Promise<readonly FileDiff[]>,
  ) => Promise<readonly FileDiff[]>;
  /** How many answers are held, for the bound's test. */
  readonly size: () => number;
}

export const createMergeRequestDiffCoalescer = (
  options: { readonly windowMs?: number; readonly maxEntries?: number } = {},
): MergeRequestDiffCoalescer => {
  const windowMs = options.windowMs ?? DIFF_COALESCE_WINDOW_MS;
  const maxEntries = options.maxEntries ?? MAX_COALESCED_DIFFS;
  // Insertion-ordered, so the first key is the oldest: an eviction is `keys().next()`.
  const entries = new Map<string, Entry>();

  const evictExpired = (nowMs: number): void => {
    for (const [key, entry] of entries) {
      if (nowMs - entry.atMs >= windowMs || nowMs < entry.atMs) {
        entries.delete(key);
      }
    }
  };

  return {
    read: async (key, nowMs, perform) => {
      evictExpired(nowMs);
      const held = entries.get(key);
      if (held !== undefined) {
        return (await held.value).map((file) => ({ ...file }));
      }
      const value = perform();
      const entry: Entry = { atMs: nowMs, value };
      entries.set(key, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
      try {
        const files = await value;
        if (files.length === 0 && entries.get(key) === entry) {
          // Not remembered either: see the module docblock's "an empty answer" bullet.
          entries.delete(key);
        }
        return files.map((file) => ({ ...file }));
      } catch (error) {
        // Not remembered: the next asker makes the request again. Only this entry, and only if it is
        // still the one this call put there.
        if (entries.get(key) === entry) {
          entries.delete(key);
        }
        throw error;
      }
    },
    size: () => entries.size,
  };
};

const byPort = new WeakMap<PipelineIntegrationsPort, MergeRequestDiffCoalescer>();

/** The one coalescer for this runtime's integrations port. */
export const diffCoalescerFor = (port: PipelineIntegrationsPort): MergeRequestDiffCoalescer => {
  const existing = byPort.get(port);
  if (existing !== undefined) {
    return existing;
  }
  const created = createMergeRequestDiffCoalescer();
  byPort.set(port, created);
  return created;
};

/**
 * `gitReads(integrations).mergeRequestDiff`, coalesced per `(binding, repository, iid, head sha,
 * limit)`. `null` exactly when that read is: the project has no git binding.
 */
export const coalescedMergeRequestDiff = async (
  input: {
    readonly port: PipelineIntegrationsPort;
    readonly integrations: PipelineIntegrations;
    readonly now: string;
  },
  ref: MergeRequestRefInput,
  limit: number,
  context: { readonly projectId: Id; readonly taskId: Id | null },
): Promise<readonly FileDiff[] | null> => {
  const git = input.integrations.git;
  const reads = gitReads(input.integrations);
  const headSha = ref.head_sha ?? null;
  if (git === null || headSha === null) {
    return reads.mergeRequestDiff(ref, limit, context);
  }
  const key = JSON.stringify([
    git.ref.integrationId,
    ref.project_path ?? git.project,
    ref.iid,
    headSha,
    limit,
  ]);
  const nowMs = Date.parse(input.now);
  return diffCoalescerFor(input.port).read(key, Number.isNaN(nowMs) ? 0 : nowMs, async () => {
    // Never `null` here: the binding was checked above, and `mergeRequestDiff` answers `null` only
    // for a project without one.
    return (await reads.mergeRequestDiff(ref, limit, context)) ?? [];
  });
};
