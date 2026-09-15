/**
 * The history bootstrap's composition, and the two decisions in it that are not wiring (WP-35).
 *
 * `composeHistoryBootstrap` itself is exercised by the `e2e-fake-claude` tier against a real
 * instance — that is the only place a pg-boss worker, an outbox sweep and a `bindings` row can all
 * be present at once, and a unit test of it would be a test of a mock (`pipeline.test.ts`'s
 * argument). What is unit-testable is what this module *decides*:
 *
 *  - **the command refuses by name on a process with no queue**, rather than recording a batch that
 *    nothing will ever collect — which is worse than a refusal, because the unique index then
 *    refuses every later attempt as `already_running`;
 *  - **the gate answers the application's own predicate and its own estimator**, so the screen and
 *    the command cannot disagree about whether a bootstrap may start or what it would cost
 *    (standing rule 9).
 */
import {
  DEFAULT_BOOTSTRAP_BUDGET_USD,
  DEFAULT_BOOTSTRAP_MERGE_REQUESTS,
} from '@platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createHistoryBootstrapCommands, createHistoryBootstrapGate } from './bootstrap.js';
import { OnboardingUnavailableError } from './onboarding.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';

/** A pool that answers one scripted project row to every query. */
const poolOf = (config: unknown) =>
  ({ query: vi.fn(async () => ({ rows: [{ config }], rowCount: 1 })) }) as never;

/** A database whose every select answers an empty list — no git binding, no live batch. */
const databaseOf = (rows: readonly unknown[]) =>
  ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: async () => rows }) }),
      }),
    }),
  }) as never;

/**
 * A unit of work whose transaction is a **postgres** one answering no rows.
 *
 * The adapter tag is load-bearing rather than decoration: `postgresTransaction` refuses a handle
 * from another adapter by name, which is what stops a store reaching a client it was not given.
 */
const eventingOf = () =>
  ({
    unitOfWork: {
      transaction: async (work: (scope: unknown) => Promise<unknown>) =>
        work({
          tx: {
            adapter: 'postgres',
            client: { query: async () => ({ rows: [], rowCount: 0 }) },
          },
        }),
    },
  }) as never;

describe('createHistoryBootstrapCommands', () => {
  it('refuses by name on a process that runs no workers, rather than recording a dead batch', async () => {
    const commands = createHistoryBootstrapCommands({
      pool: poolOf({}),
      database: databaseOf([]),
      eventing: eventingOf(),
      jobs: null,
    });
    await expect(
      commands.start({
        projectId: PROJECT as never,
        mergeRequests: null,
        userId: PROJECT as never,
      }),
    ).rejects.toBeInstanceOf(OnboardingUnavailableError);
  });
});

describe('createHistoryBootstrapGate', () => {
  const gate = (config: unknown, bindings: readonly unknown[]) =>
    createHistoryBootstrapGate({
      pool: poolOf(config),
      database: databaseOf(bindings),
      eventing: eventingOf(),
    });

  it('publishes the refusal the command would make, for a project with the feature off', async () => {
    const answer = await gate({}, [{ id: 'x' }])(PROJECT, null);
    expect(answer.canStart).toBe(false);
    expect(answer.blockedReason).toContain('features.history_bootstrap.enabled');
  });

  it('publishes `no_git_binding` for a project with nothing to mine', async () => {
    const answer = await gate({ features: { history_bootstrap: { enabled: true } } }, [])(
      PROJECT,
      null,
    );
    expect(answer.canStart).toBe(false);
    expect(answer.blockedReason).toContain('no git integration');
  });

  it('answers the estimate for the project’s own N when the caller names none', async () => {
    const answer = await gate({ features: { history_bootstrap: { enabled: true } } }, [
      { id: 'x' },
    ])(PROJECT, null);
    expect(answer.canStart).toBe(true);
    expect(answer.blockedReason).toBeNull();
    expect(answer.estimate.mergeRequests).toBe(DEFAULT_BOOTSTRAP_MERGE_REQUESTS);
    expect(answer.estimate.capUsd).toBe(DEFAULT_BOOTSTRAP_BUDGET_USD);
    // product/19 §18's arithmetic, end to end: 200 at 20 a run is ten runs at the Sonnet cap.
    expect(answer.estimate.batches).toBe(10);
    expect(answer.estimate.estimatedUsd).toBe(DEFAULT_BOOTSTRAP_BUDGET_USD);
  });

  it('answers the estimate for the N the caller asked about, so moving the number re-asks', async () => {
    const answer = await gate(
      { features: { history_bootstrap: { enabled: true, budget_usd: 5 } } },
      [{ id: 'x' }],
    )(PROJECT, 60);
    expect(answer.estimate.mergeRequests).toBe(60);
    expect(answer.estimate.batches).toBe(3);
    expect(answer.estimate.estimatedUsd).toBe(6);
    // …and it says in advance that this one will stop at the cap rather than refusing it.
    expect(answer.estimate.capUsd).toBe(5);
    expect(answer.estimate.stopsAtCap).toBe(true);
  });
});
