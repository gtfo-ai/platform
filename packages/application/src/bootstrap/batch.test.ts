/**
 * The start command: the four refusals, the estimate and the one countable effect (WP-35).
 *
 * Every assertion is on a **row or a queued job** rather than on a return value: the command's whole
 * product is a `history_bootstrap_batches` row and a `bootstrap.history` wake-up, and a test that
 * read the result object would be green on a command that wrote neither.
 *
 * Both directions on every gate (standing rule 42), and the size bound is asserted **at the value
 * and one past it** — `MAX_BOOTSTRAP_MERGE_REQUESTS` accepted, `+ 1` refused — because a command
 * that refused every N would pass a suite that only checked the refusal.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  BOOTSTRAP_BATCH_SIZE,
  DEFAULT_BOOTSTRAP_BUDGET_USD,
  DEFAULT_BOOTSTRAP_MERGE_REQUESTS,
  MAX_BOOTSTRAP_MERGE_REQUESTS,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { staticProjectSettings } from '../pipeline/settings.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { estimateFor, historyBootstrapSettings, startHistoryBootstrap } from './batch.js';
import type { HistoryBootstrapStore } from './ports.js';

const PROJECT = '00000000-0000-4000-8000-0000000000f1' as Id;
const USER = '00000000-0000-4000-8000-0000000000f2' as Id;

interface WorldOptions {
  readonly enabled?: boolean;
  readonly mergeRequests?: number;
  readonly budgetUsd?: number;
  readonly days?: number;
}

const world = (options: WorldOptions = {}) =>
  createPipelineHarness({
    projectId: PROJECT,
    settings: {
      config: {
        features: {
          history_bootstrap: {
            enabled: options.enabled ?? true,
            ...(options.mergeRequests === undefined
              ? {}
              : { merge_requests: options.mergeRequests }),
            ...(options.budgetUsd === undefined ? {} : { budget_usd: options.budgetUsd }),
            ...(options.days === undefined ? {} : { days: options.days }),
          },
        },
      },
    },
    runs: {},
  });

const start = async (
  harness: PipelineHarness,
  input: {
    readonly mergeRequests?: number | null;
    readonly hasGitBinding?: boolean;
    readonly store?: HistoryBootstrapStore;
  } = {},
) =>
  startHistoryBootstrap(
    {
      unitOfWork: harness.memory,
      store: input.store ?? harness.bootstrap,
      settings: staticProjectSettings(() => harness.settings),
      jobs: harness.jobs,
      ids: harness.ids,
      clock: { now: () => harness.clock.now() as IsoDateTime },
      hasGitBinding: async () => input.hasGitBinding ?? true,
    },
    {
      projectId: PROJECT,
      mergeRequests: input.mergeRequests ?? null,
      requestedByUserId: USER,
    },
  );

const queued = (harness: PipelineHarness) =>
  harness.jobs.enqueued.filter((job) => job.queue === JOB_QUEUES.historyBootstrap);

describe('starting a history bootstrap', () => {
  it('records the batch with what the operator was shown, and enqueues the collection', async () => {
    const harness = world();
    const result = await start(harness);
    expect(result.status).toBe('started');

    const [batch] = harness.bootstrap.batches;
    expect(batch?.projectId).toBe(PROJECT);
    expect(batch?.requestedBy).toBe(USER);
    expect(batch?.status).toBe('collecting');
    // The figures are **copied**, so a later settings edit cannot rewrite what this batch was
    // allowed to spend or what its operator was told it would cost.
    expect(batch?.mergeRequests).toBe(DEFAULT_BOOTSTRAP_MERGE_REQUESTS);
    expect(batch?.batchSize).toBe(BOOTSTRAP_BATCH_SIZE);
    expect(batch?.capUsd).toBe(DEFAULT_BOOTSTRAP_BUDGET_USD);
    expect(batch?.estimatedUsd).toBe(DEFAULT_BOOTSTRAP_BUDGET_USD);

    const jobs = queued(harness);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({ kind: 'collect', batch_id: batch?.id });
  });

  it('makes no provider call at all, which is what keeps 253 reads out of an HTTP request', async () => {
    const harness = world();
    await start(harness);
    // The audit log is what the executor writes for every read and every write. Empty is the
    // assertion: the command decides and the job calls (WP-15d's shape, one work package on).
    expect(harness.audit.entries).toEqual([]);
  });

  it('refuses when the feature is off, and does not create a batch', async () => {
    const harness = world({ enabled: false });
    const result = await start(harness);
    expect(result.status).toBe('blocked');
    expect(result.status === 'blocked' ? result.blocker : null).toBe('feature_disabled');
    expect(harness.bootstrap.batches).toEqual([]);
    expect(queued(harness)).toEqual([]);
  });

  it('refuses a project with no git binding rather than starting a batch that finds nothing', async () => {
    const harness = world();
    const result = await start(harness, { hasGitBinding: false });
    expect(result.status === 'blocked' ? result.blocker : null).toBe('no_git_binding');
    expect(harness.bootstrap.batches).toEqual([]);
  });

  it('refuses a second batch while one is live, and admits one after it finishes', async () => {
    const harness = world();
    expect((await start(harness)).status).toBe('started');

    const second = await start(harness);
    expect(second.status === 'blocked' ? second.blocker : null).toBe('already_running');
    expect(harness.bootstrap.batches).toHaveLength(1);

    // The other direction (rule 42): once the first has finished, a second may start.
    const first = harness.bootstrap.batches[0];
    await harness.memory.transaction(async (scope) => {
      await harness.bootstrap.markEmpty(
        scope.tx,
        first?.id as Id,
        'nothing to mine',
        harness.clock.now() as IsoDateTime,
      );
    });
    expect((await start(harness)).status).toBe('started');
    expect(harness.bootstrap.batches).toHaveLength(2);
  });

  it('refuses the loser of a race with the same answer the read gives, not a 500', async () => {
    // The one case the `liveBatch` read cannot close: two commands that both read **before** either
    // inserts. There is no concurrency on this tier, so the race is instrumented — `liveBatch`
    // answers "none" while the write still sees the live batch — and what is under test is the
    // command's mapping of the store's refusal, driven through the real in-memory double rather
    // than a stub that throws (its divergence 2 enforces the index's rule).
    const harness = world();
    expect((await start(harness)).status).toBe('started');

    // The double's own methods, with the read blinded: `createBatch` is still the real one, so the
    // refusal under test is the double's (divergence 2) rather than a stub's.
    const blind: HistoryBootstrapStore = { ...harness.bootstrap, liveBatch: async () => null };
    const raced = await start(harness, { store: blind });
    expect(raced.status === 'blocked' ? raced.blocker : null).toBe('already_running');
    // The countable effects: no second row, and no second collection was woken.
    expect(harness.bootstrap.batches).toHaveLength(1);
    expect(queued(harness)).toHaveLength(1);

    // The other direction, which is what keeps the mapping a translation rather than a swallow
    // (standing rule 42): a store that fails for any other reason fails the command.
    const broken: HistoryBootstrapStore = {
      ...harness.bootstrap,
      liveBatch: async () => null,
      createBatch: async () => {
        throw new Error('the connection died mid-insert');
      },
    };
    await expect(start(harness, { store: broken })).rejects.toThrow('the connection died');
  });

  it('accepts N at the documented maximum and refuses one past it', async () => {
    const atMax = world();
    expect((await start(atMax, { mergeRequests: MAX_BOOTSTRAP_MERGE_REQUESTS })).status).toBe(
      'started',
    );
    expect(atMax.bootstrap.batches[0]?.mergeRequests).toBe(MAX_BOOTSTRAP_MERGE_REQUESTS);

    const past = world();
    const refused = await start(past, { mergeRequests: MAX_BOOTSTRAP_MERGE_REQUESTS + 1 });
    expect(refused.status === 'blocked' ? refused.blocker : null).toBe(
      'merge_requests_out_of_range',
    );
    expect(past.bootstrap.batches).toEqual([]);
  });

  it('refuses a repository-configured N past the maximum too, not only a caller’s', async () => {
    // The bound has two sources — the request body and `features.history_bootstrap.merge_requests`
    // — and a bound only the wire checks is not a bound on the other path (standing rule 14).
    const harness = world({ mergeRequests: MAX_BOOTSTRAP_MERGE_REQUESTS + 500 });
    const result = await start(harness);
    expect(result.status === 'blocked' ? result.blocker : null).toBe('merge_requests_out_of_range');
  });

  it('takes the project’s own N and window when the caller names none', async () => {
    const harness = world({ mergeRequests: 40, days: 30, budgetUsd: 6 });
    const result = await start(harness);
    expect(result.status === 'started' ? result.estimate.mergeRequests : null).toBe(40);
    expect(result.status === 'started' ? result.estimate.batches : null).toBe(2);
    expect(result.status === 'started' ? result.estimate.estimatedUsd : null).toBe(4);
    expect(harness.bootstrap.batches[0]?.days).toBe(30);
    expect(harness.bootstrap.batches[0]?.capUsd).toBe(6);
  });
});

describe('the estimate the wizard is shown', () => {
  it('says so when the batch will stop at the cap, rather than refusing it', async () => {
    const harness = world({ budgetUsd: 5 });
    const estimate = estimateFor(harness.settings, 200);
    expect(estimate.estimatedUsd).toBe(20);
    expect(estimate.capUsd).toBe(5);
    expect(estimate.stopsAtCap).toBe(true);
    // …and the batch still starts, which is the behaviour product/19 asks for.
    expect((await start(harness, { mergeRequests: 200 })).status).toBe('started');
  });

  it('applies product/19’s defaults to a project that configured nothing', () => {
    const harness = world({ enabled: false });
    expect(historyBootstrapSettings(harness.settings)).toEqual({
      enabled: false,
      mergeRequests: DEFAULT_BOOTSTRAP_MERGE_REQUESTS,
      days: 183,
      capUsd: DEFAULT_BOOTSTRAP_BUDGET_USD,
    });
  });
});
