/**
 * The core's half of the worker protocol (WP-281), over the in-memory store — every command a
 * remote worker's request performs: the claim with TD-031 §8's eligibility, the package after the
 * commit, the run token, the heartbeat (backlog 714's re-check), the release (backlog 701), the spawn
 * marker, `finish` through `settleRun`, and late cost.
 *
 * The offers come from a harness composed with **no** claimant (`runsAgents: false`): the stage job
 * ends at the offer, and with no server claimant in the instance every offer is open to workers at
 * once (TD-031 §8's third reading). What the memory store cannot show — the eligibility asked **in the
 * committing statement**, a revoke that commits between authentication and the write — is asserted
 * against PostgreSQL in `test/integration/pipeline/remote-claim.integration.test.ts` (divergence 13).
 */

import type {
  DomainEvent,
  Id,
  IsoDateTime,
  RunPackage as WorkerRunPackage,
} from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { DEFAULT_WIP_LIMITS } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { BlockingBudget } from '../cost/guard.js';
import type { LateRunSpend } from '../cost/late.js';
import { RUN_CREDENTIAL_UNAVAILABLE_DIAGNOSIS, RunStartError } from '../ports/runner.js';
import { WorkspaceError } from '../ports/workspace.js';
import type { MemoryRemoteWorker } from '../testing/memory-pipeline.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { createTestRunPlanSealer } from '../testing/run-plans.js';
import { createClaimAdmission } from './claim-admission.js';
import { RUN_START_RETRY_MS } from './jobs.js';
import {
  createRemoteRuns,
  type RemotePackageAnswer,
  type RemoteRuns,
  type RunTokens,
  settleOutcomeOfFinish,
} from './remote-runs.js';
import { MAX_RUN_START_ATTEMPTS, type SettleRunRequest, type SettleRunResult } from './settle.js';

const PROJECT = '00000000-0000-4000-8000-0000000281b1';
const W1 = '00000000-0000-4000-8000-0000000281f1';
const W2 = '00000000-0000-4000-8000-0000000281f2';
const ALICE = '00000000-0000-4000-8000-0000000281a1';
const BOB = '00000000-0000-4000-8000-0000000281a2';
const RUN_DIGEST = `sha256:${'a'.repeat(64)}`;
const EGRESS_DIGEST = `sha256:${'b'.repeat(64)}`;
const IMAGES = { run: RUN_DIGEST, egress: EGRESS_DIGEST };
const HELD = [RUN_DIGEST, EGRESS_DIGEST];

const ticketMatched = (key: string, seq: number): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: `00000000-0000-4000-9000-0000002810${String(seq).padStart(2, '0')}`,
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: seq,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

/** Deterministic tokens: `token-N`, stored as `hash:token-N`. */
const fakeTokens = (): RunTokens & { readonly minted: string[] } => {
  const minted: string[] = [];
  return {
    minted,
    mint: () => {
      const token = `token-${minted.length + 1}`;
      minted.push(token);
      return { token, hash: `hash:${token}` };
    },
    hashOf: (token) => `hash:${token}`,
    same: (a, b) => a === b,
  };
};

interface World {
  readonly harness: PipelineHarness;
  readonly remote: RemoteRuns;
  readonly workers: Map<
    Id,
    MemoryRemoteWorker & { usable: boolean; pausedUntil: IsoDateTime | null }
  >;
  readonly credentialSource: { value: 'minted' | 'static' | 'deploy_key' | null };
  readonly tokens: ReturnType<typeof fakeTokens>;
  readonly built: { epoch: number; runToken: string; images: typeof IMAGES }[];
  readonly revoked: Id[];
  readonly lateSpends: LateRunSpend[];
  readonly runId: Id;
}

const world = async (
  options: {
    readonly packager?: () => Promise<RemotePackageAnswer>;
    readonly settle?: (request: SettleRunRequest) => Promise<SettleRunResult>;
    readonly before?: (harness: PipelineHarness) => void;
    readonly tickets?: number;
    /** Backlog 744: the budget the claim's admission re-check asks; absent, no re-check. */
    readonly budgetAtClaim?: () => BlockingBudget | null;
    /** Backlog 744: the refusal's own transaction fails (a task write that lost every race). */
    readonly refusalFails?: boolean;
    /** WP-293: where a pick's audit goes; `null` composes none. */
    readonly takes?: { workerId: Id; runId: Id; taskId: Id }[] | null;
  } = {},
): Promise<World> => {
  const workers: World['workers'] = new Map();
  const members = new Set<string>([`${PROJECT}#${ALICE}`, `${PROJECT}#${BOB}`]);
  for (const [id, userId] of [
    [W1, ALICE],
    [W2, BOB],
  ] as const) {
    workers.set(id, {
      userId,
      usable: true,
      pausedUntil: null,
      memberOf: (projectId) => members.has(`${projectId}#${userId}`),
    });
  }
  const credentialSource: World['credentialSource'] = { value: 'minted' };
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runsAgents: false,
    settings: { wip: { ...DEFAULT_WIP_LIMITS, maxParallelTasks: 10, maxParallelRuns: 10 } },
    remoteWorkers: {
      remoteWorkers: (id) => workers.get(id),
      runCredentialSource: () => credentialSource.value,
    },
  });
  options.before?.(harness);
  for (let index = 1; index <= (options.tickets ?? 1); index += 1) {
    await harness.publish([ticketMatched(`ACME-${index}`, index)]);
  }
  const tokens = fakeTokens();
  const built: World['built'] = [];
  const revoked: Id[] = [];
  const lateSpends: LateRunSpend[] = [];
  const remote = createRemoteRuns({
    unitOfWork: harness.memory,
    store: harness.store,
    context: harness.commands.context,
    runPlans: createTestRunPlanSealer(),
    packager: {
      build: async (input) => {
        built.push({ epoch: input.epoch, runToken: input.runToken, images: { ...input.images } });
        return (
          (await options.packager?.()) ?? {
            kind: 'package',
            package: { runId: input.spec.runId, epoch: input.epoch } as unknown as WorkerRunPackage,
          }
        );
      },
    },
    credentials: {
      revoke: async (runId) => {
        revoked.push(runId);
      },
    },
    tokens,
    ...(options.takes === null
      ? {}
      : {
          takeAudit: {
            record: async (_tx, entry) => {
              // The pick's own row; whether it assigned (S-26.4) is the integration tier's.
              options.takes?.push({
                workerId: entry.workerId,
                runId: entry.runId,
                taskId: entry.taskId,
              });
            },
          },
        }),
    settle: options.settle ?? (async (request) => harness.runtime.executor.settle(request)),
    lateCost: {
      record: async (_scope, spend) => {
        lateSpends.push(spend);
        return { recorded: true, charge: null };
      },
    },
    ...(options.budgetAtClaim === undefined
      ? {}
      : {
          admission: ((admission) =>
            options.refusalFails === true
              ? {
                  recheck: admission.recheck,
                  refuse: async () => {
                    throw new Error('the task write lost every race');
                  },
                }
              : admission)(
            createClaimAdmission({
              store: harness.store,
              settings: async () => harness.settings,
              budgets: { blockingFor: async () => options.budgetAtClaim?.() ?? null },
              context: harness.commands.context,
            }),
          ),
        }),
  });
  const runId = harness.store.offerRows()[0]?.runId as Id;
  return {
    harness,
    remote,
    workers,
    credentialSource,
    tokens,
    built,
    revoked,
    lateSpends,
    runId,
  };
};

const claimAs = (w: World, workerId: Id, held: readonly string[] = HELD) =>
  w.remote.claim({ workerId, heldImageDigests: held, images: IMAGES, now: w.harness.clock.now() });

const ranOutcome = (runId: Id) =>
  settleOutcomeOfFinish(runId, {
    epoch: 1,
    stop_reason: null,
    outcome: {
      kind: 'ran',
      status: 'completed',
      terminal_reason: 'success',
      session_id: null,
      num_turns: 2,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: 0,
      },
      model_usage: [],
      cost: { usd: 0.02, is_estimate: false, price_list_id: null },
      wall_ms: 1_000,
      structured_output: null,
      error: null,
      redaction_count: 0,
    },
  });

describe('the admission re-check at a worker’s claim (backlog 744)', () => {
  it('an organisation budget spent since the offer: no package, the task paused, the worker answered none', async () => {
    let blocked = false;
    const w = await world({
      budgetAtClaim: () =>
        blocked
          ? ({
              id: '00000000-0000-4000-8000-0000000007a5',
              scope: 'org',
              window: 'month',
              limitUsd: 10,
              spentUsd: 10,
              pendingUsd: 0,
              heldUsd: 0,
              heldRuns: 0,
              reserveUsd: 0,
              windowStart: '2026-06-01T00:00:00.000Z',
            } as BlockingBudget)
          : null,
    });
    blocked = true;
    expect(await claimAs(w, W1)).toEqual({ kind: 'none' });
    expect(w.built).toHaveLength(0);
    expect(w.harness.types()).not.toContain('run.claimed');
    const paused = w.harness.events().find((event) => event.type === 'task.paused');
    expect(paused?.payload).toMatchObject({ reason: 'budget', budget_scope: 'organization' });
  });

  it('answers none, never an error, when the refusal itself cannot be written', async () => {
    const blocked = {
      id: '00000000-0000-4000-8000-0000000007a6',
      scope: 'project',
      window: 'month',
      limitUsd: 10,
      spentUsd: 10,
      pendingUsd: 0,
      heldUsd: 0,
      heldRuns: 0,
      reserveUsd: 0,
      windowStart: '2026-06-01T00:00:00.000Z',
    } as BlockingBudget;
    const w = await world({ budgetAtClaim: () => blocked, refusalFails: true });
    expect(await claimAs(w, W1)).toEqual({ kind: 'none' });
    expect(w.built).toHaveLength(0);
  });

  it('claims as before while nothing refuses it', async () => {
    const w = await world({ budgetAtClaim: () => null });
    expect((await claimAs(w, W1)).kind).toBe('claimed');
  });
});

describe('the remote claim (WP-281, TD-031 decisions 2, 7, 8)', () => {
  it('claims the open offer for a worker: worker on the offer and the run, run.claimed names it, the token stored hashed, the package built after the claim', async () => {
    const w = await world();
    expect(w.harness.store.offerRows()[0]?.state).toBe('open');

    const answer = await claimAs(w, W1);

    expect(answer.kind).toBe('claimed');
    const offer = w.harness.store.offerRows()[0];
    expect(offer).toMatchObject({ state: 'claimed', claimantKind: 'worker', leaseEpoch: 1 });
    expect(w.harness.store.leaseOf(w.runId)?.owner).toBe(`worker:${W1}`);
    const claimed = w.harness.events().find((event) => event.type === 'run.claimed');
    expect(claimed?.payload).toMatchObject({
      claimant_kind: 'worker',
      worker_id: W1,
      lease_epoch: 1,
    });
    const holder = await w.harness.memory.transaction(async (scope) =>
      w.harness.store.offers.runTokenHolder(scope.tx, w.runId),
    );
    // The token's stored form only, at the claim's epoch, under the claiming worker.
    expect(holder).toMatchObject({ tokenHash: 'hash:token-1', tokenEpoch: 1, workerId: W1 });
    expect(w.built).toEqual([{ epoch: 1, runToken: 'token-1', images: IMAGES }]);
    // No session ran in the core, and no `run.started` before the worker's spawn call.
    expect(w.harness.types()).not.toContain('run.started');
  });

  it.each([
    [
      'a revoked worker (or a user who may not act)',
      (w: World) => {
        (w.workers.get(W1) as { usable: boolean }).usable = false;
      },
    ],
    [
      'a paused worker',
      (w: World) => {
        (w.workers.get(W1) as { pausedUntil: IsoDateTime | null }).pausedUntil =
          '2099-01-01T00:00:00.000Z' as IsoDateTime;
      },
    ],
    [
      'a worker whose user is not a project member',
      (w: World) => {
        const known = w.workers.get(W1) as MemoryRemoteWorker;
        w.workers.set(W1, { ...known, usable: true, pausedUntil: null, memberOf: () => false });
      },
    ],
    [
      'a project whose run credential is static (WP-282’s opt-in)',
      (w: World) => {
        w.credentialSource.value = 'static';
      },
    ],
    [
      'a project whose run credential is a deploy key (WP-282’s opt-in)',
      (w: World) => {
        w.credentialSource.value = 'deploy_key';
      },
    ],
  ] as const)(
    'refuses %s, and the same offer is claimed once the fact is put back',
    async (_name, refuse) => {
      const w = await world();
      refuse(w);
      expect((await claimAs(w, W1)).kind).toBe('none');
      expect(w.harness.store.offerRows()[0]?.state).toBe('open');
      expect(w.built).toEqual([]);
      // Positive control (standing rule 6): the other worker, or the fact restored, claims it.
      const restored = await world();
      expect((await claimAs(restored, W1)).kind).toBe('claimed');
    },
  );

  it('refuses a worker that does not hold the images, and claims for one that does', async () => {
    const w = await world();
    expect((await claimAs(w, W1, [RUN_DIGEST])).kind).toBe('none');
    expect((await claimAs(w, W1, [EGRESS_DIGEST, RUN_DIGEST])).kind).toBe('claimed');
  });

  it('refuses every worker on a server_only project: workers_from is never', async () => {
    const w = await world({
      before: (harness) =>
        harness.store.setExecutionSettings(PROJECT, {
          mode: 'server_only',
          prefer: 'server',
          fallbackAfterSeconds: null,
          assigneeWindowSeconds: 120,
          offerTimeoutSeconds: 86_400,
        }),
    });
    expect(w.harness.store.offerRows()[0]?.routing.workersFrom).toBeNull();
    expect((await claimAs(w, W1)).kind).toBe('none');
  });

  it('settles a run it cannot package as not started, under the worker’s claim, and ends the hold', async () => {
    const w = await world({
      packager: async () => {
        throw new WorkspaceError('invalid_spec', 'the binding can mint nothing for a writing run', {
          reason: 'run_credential_unavailable',
        });
      },
    });
    const answer = await claimAs(w, W1);
    expect(answer).toEqual({ kind: 'not_packaged', runId: w.runId });
    const failed = w.harness.events().find((event) => event.type === 'run.failed');
    expect(failed?.payload).toMatchObject({
      run_id: w.runId,
      terminal_reason: 'error_during_execution',
    });
    expect(w.harness.store.offerRows()[0]?.state).toBe('settled');
  });

  /**
   * TD-031's 2026-11-05 amendment (backlog 740): a mint that fails after the claim is a **start
   * failure**, never a release — so Q59(a)'s bound spaces the retries `RUN_START_RETRY_MS` apart and
   * ends them in `needs_human` after `MAX_RUN_START_ATTEMPTS`, each attempt one failed run, with no
   * worker excluded. Before the amendment the offer reopened at once and the claim re-minted forever.
   */
  it('settles an always-failing retryable mint as not started, three times 30 s apart, then needs_human — never a release', async () => {
    const mints: number[] = [];
    let harnessRef: PipelineHarness | null = null;
    const w = await world({
      packager: async () => {
        mints.push(harnessRef?.clock.epochMs ?? 0);
        throw new RunStartError('the provider answered 503', {
          retryable: true,
          diagnosis: RUN_CREDENTIAL_UNAVAILABLE_DIAGNOSIS,
        });
      },
    });
    harnessRef = w.harness;
    for (let attempt = 1; attempt <= MAX_RUN_START_ATTEMPTS + 1; attempt += 1) {
      const answer = await claimAs(w, W1);
      expect(answer.kind).toBe(attempt <= MAX_RUN_START_ATTEMPTS ? 'not_packaged' : 'none');
      w.harness.clock.advance(RUN_START_RETRY_MS);
      await w.harness.drain();
    }
    expect(mints).toHaveLength(MAX_RUN_START_ATTEMPTS);
    for (let index = 1; index < mints.length; index += 1) {
      expect((mints[index] ?? 0) - (mints[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        RUN_START_RETRY_MS,
      );
    }
    const failed = w.harness.events().filter((event) => event.type === 'run.failed');
    expect(failed).toHaveLength(MAX_RUN_START_ATTEMPTS);
    expect(
      failed.map(
        (event) => (event.payload as { start_failure?: { diagnosis: string } }).start_failure,
      ),
    ).toEqual(
      Array(MAX_RUN_START_ATTEMPTS).fill(
        expect.objectContaining({
          diagnosis: expect.stringContaining('run_credential_unavailable'),
        }),
      ),
    );
    expect(w.harness.types()).not.toContain('run.offer.released');
    expect(w.harness.store.offerRows().every((row) => row.state === 'settled')).toBe(true);
    // No worker excluded: the provider's fault is not the worker's.
    expect(w.harness.store.offerRows().map((row) => row.state)).toHaveLength(
      MAX_RUN_START_ATTEMPTS,
    );
    const task = await w.harness.store.tasks.load(
      {} as never,
      w.harness.store.offerRows()[0]?.taskId as Id,
    );
    expect(task?.task.state).toBe('needs_human');
  });

  it('escalates a non-retryable mint failure (forbidden) on its first attempt', async () => {
    let mints = 0;
    const w = await world({
      packager: async () => {
        mints += 1;
        throw new RunStartError('the token may not mint', {
          retryable: false,
          diagnosis: RUN_CREDENTIAL_UNAVAILABLE_DIAGNOSIS,
        });
      },
    });
    expect((await claimAs(w, W1)).kind).toBe('not_packaged');
    w.harness.clock.advance(RUN_START_RETRY_MS);
    await w.harness.drain();
    expect((await claimAs(w, W1)).kind).toBe('none');
    expect(mints).toBe(1);
    const task = await w.harness.store.tasks.load(
      {} as never,
      w.harness.store.offerRows()[0]?.taskId as Id,
    );
    expect(task?.task.state).toBe('needs_human');
  });
});

describe('the run token (TD-031 decision 7)', () => {
  it('authenticates its own run while the worker may act, until fifteen minutes after the end', async () => {
    const w = await world();
    await claimAs(w, W1);
    const now = w.harness.clock.now();
    expect(await w.remote.authenticate({ runId: w.runId, token: 'token-1', now })).toEqual({
      runId: w.runId,
      workerId: W1,
    });
    expect(await w.remote.authenticate({ runId: w.runId, token: 'token-2', now })).toBeNull();

    (w.workers.get(W1) as { usable: boolean }).usable = false;
    expect(await w.remote.authenticate({ runId: w.runId, token: 'token-1', now })).toBeNull();
    (w.workers.get(W1) as { usable: boolean }).usable = true;

    // Ended by a cancel in place: the token keeps authenticating for late-cost, then stops.
    await w.harness.memory.transaction(async (scope) =>
      w.harness.store.runs.finish(scope.tx, {
        runId: w.runId,
        status: 'cancelled',
        terminalReason: 'cancelled',
        sessionId: null,
        numTurns: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        cost: null,
        wallMs: 0,
      }),
    );
    const ended = Date.parse(w.harness.clock.now());
    const at = (ms: number) => new Date(ended + ms).toISOString() as IsoDateTime;
    expect(
      await w.remote.authenticate({ runId: w.runId, token: 'token-1', now: at(14 * 60_000) }),
    ).not.toBeNull();
    expect(
      await w.remote.authenticate({ runId: w.runId, token: 'token-1', now: at(16 * 60_000) }),
    ).toBeNull();
  });
});

describe('the heartbeat (TD-031 §§2, 14; backlog 714)', () => {
  it('renews the 10-minute lease under the claim, and answers lease_lost for another epoch or a revoked worker', async () => {
    const w = await world();
    await claimAs(w, W1);
    w.harness.clock.advance(20_000);
    const now = w.harness.clock.now();
    const beat = await w.remote.heartbeat({
      runId: w.runId,
      workerId: W1,
      epoch: 1,
      acks: [],
      now,
    });
    expect(beat).toEqual({
      kind: 'renewed',
      leaseExpiresAt: new Date(Date.parse(now) + 600_000).toISOString(),
      commands: [],
    });
    expect(w.harness.store.leaseOf(w.runId)?.expiresAt).toBe(
      new Date(Date.parse(now) + 600_000).toISOString(),
    );
    expect(
      (await w.remote.heartbeat({ runId: w.runId, workerId: W1, epoch: 2, acks: [], now })).kind,
    ).toBe('lease_lost');
    expect(
      (await w.remote.heartbeat({ runId: w.runId, workerId: W2, epoch: 1, acks: [], now })).kind,
    ).toBe('lease_lost');
    // Backlog 714: the renewal re-asks whether the holder may act, in its own write.
    (w.workers.get(W1) as { usable: boolean }).usable = false;
    expect(
      (await w.remote.heartbeat({ runId: w.runId, workerId: W1, epoch: 1, acks: [], now })).kind,
    ).toBe('lease_lost');
  });

  it('delivers a pending cancel, stamps the worker’s ack, and ignores an ack of a command that is not the run’s', async () => {
    const w = await world();
    await claimAs(w, W1);
    const commandId = '00000000-0000-4000-8000-0000000281c1' as Id;
    await w.harness.memory.transaction(async (scope) =>
      w.harness.store.runCommands.insert(scope.tx, {
        id: commandId,
        runId: w.runId,
        taskId: w.harness.store.offerRows()[0]?.taskId as Id,
        actorUserId: null,
        instruction: { kind: 'cancel' },
      }),
    );
    const now = w.harness.clock.now();
    const first = await w.remote.heartbeat({
      runId: w.runId,
      workerId: W1,
      epoch: 1,
      acks: [{ commandId: '00000000-0000-4000-8000-0000000281c9' as Id, outcome: 'applied' }],
      now,
    });
    expect(first).toMatchObject({
      kind: 'renewed',
      commands: [{ id: commandId, kind: 'cancel', payload: {} }],
    });
    // Delivered until acked: the same command rides the next beat too.
    expect(await w.remote.pending({ runId: w.runId, workerId: W1 })).toHaveLength(1);
    const acked = await w.remote.heartbeat({
      runId: w.runId,
      workerId: W1,
      epoch: 1,
      acks: [{ commandId, outcome: 'applied' }],
      now,
    });
    expect(acked).toMatchObject({ kind: 'renewed', commands: [] });
    expect(w.harness.store.runCommandRows().find((row) => row.id === commandId)?.applied).toBe(
      true,
    );
  });
});

describe('acks are scoped to the run and its holder', () => {
  it('leaves pending a command of another run, held by another worker, that this worker acks refused', async () => {
    const w = await world({ tickets: 2 });
    await claimAs(w, W1);
    await claimAs(w, W2);
    const [first, second] = w.harness.store.offerRows();
    const theirs = '00000000-0000-4000-8000-0000000281c7' as Id;
    await w.harness.memory.transaction(async (scope) =>
      w.harness.store.runCommands.insert(scope.tx, {
        id: theirs,
        runId: second?.runId as Id,
        taskId: second?.taskId as Id,
        actorUserId: null,
        instruction: { kind: 'cancel' },
      }),
    );
    expect(w.harness.store.leaseOf(second?.runId as Id)?.owner).toBe(`worker:${W2}`);
    const beat = await w.remote.heartbeat({
      runId: first?.runId as Id,
      workerId: W1,
      epoch: 1,
      acks: [{ commandId: theirs, outcome: 'refused', reason: 'register_miss' }],
      now: w.harness.clock.now(),
    });
    expect(beat.kind).toBe('renewed');
    const row = w.harness.store.runCommandRows().find((entry) => entry.id === theirs);
    expect(row).toMatchObject({ applied: false, refusedReason: null });
    // Its own holder still receives it.
    expect(await w.remote.pending({ runId: second?.runId as Id, workerId: W2 })).toHaveLength(1);
  });
});

describe('the release (TD-031 decision 6 as amended §4; backlog 701)', () => {
  it('undoes the claim only, before the spawn marker: offer open at the same epoch, run created, lease cleared, credential revoked; a repeat writes nothing', async () => {
    const w = await world();
    await claimAs(w, W1);
    const now = w.harness.clock.now();
    expect(
      await w.remote.release({
        runId: w.runId,
        workerId: W1,
        epoch: 1,
        reason: 'image_missing',
        now,
      }),
    ).toBe('released');
    expect(w.harness.store.offerRows()[0]).toMatchObject({ state: 'open', leaseEpoch: 1 });
    expect(w.harness.store.leaseOf(w.runId)).toBeNull();
    const run = await w.harness.memory.transaction(async (scope) =>
      w.harness.store.runs.load(scope.tx, w.runId),
    );
    expect(run?.status).toBe('created');
    expect(w.revoked).toEqual([w.runId]);
    const types = w.harness.types();
    expect(types).toContain('run.claimed');
    expect(types).toContain('run.offer.released');
    expect(types).not.toContain('run.failed');
    const eventsBefore = types.length;

    expect(
      await w.remote.release({
        runId: w.runId,
        workerId: W1,
        epoch: 1,
        reason: 'image_missing',
        now,
      }),
    ).toBe('already_released');
    expect(w.harness.types()).toHaveLength(eventsBefore);
    expect(w.revoked).toEqual([w.runId]);

    // `image_missing` excludes nobody: the same worker claims it again, at the next epoch, and the
    // released claim's epoch is stale from then on.
    expect((await claimAs(w, W1)).kind).toBe('claimed');
    expect(w.harness.store.offerRows()[0]?.leaseEpoch).toBe(2);
    expect(
      await w.remote.release({
        runId: w.runId,
        workerId: W1,
        epoch: 1,
        reason: 'image_missing',
        now,
      }),
    ).toBe('lease_lost');
  });

  it('excludes the worker for provision_failed and usage_limited, and another worker still claims it', async () => {
    for (const reason of ['provision_failed', 'usage_limited'] as const) {
      const w = await world();
      await claimAs(w, W1);
      const now = w.harness.clock.now();
      expect(await w.remote.release({ runId: w.runId, workerId: W1, epoch: 1, reason, now })).toBe(
        'released',
      );
      expect((await claimAs(w, W1)).kind).toBe('none');
      expect((await claimAs(w, W2)).kind).toBe('claimed');
    }
  });

  it('is refused run_started once the spawn marker is written, and lease_lost for another worker', async () => {
    const w = await world();
    await claimAs(w, W1);
    const now = w.harness.clock.now();
    expect(
      await w.remote.release({ runId: w.runId, workerId: W2, epoch: 1, reason: 'shutdown', now }),
    ).toBe('lease_lost');
    expect((await w.remote.spawn({ runId: w.runId, workerId: W1, epoch: 1, now })).kind).toBe(
      'spawned',
    );
    expect(
      await w.remote.release({ runId: w.runId, workerId: W1, epoch: 1, reason: 'shutdown', now }),
    ).toBe('run_started');
    expect(w.harness.store.offerRows()[0]?.state).toBe('claimed');
  });
});

describe('the spawn marker (TD-031’s 2026-11-04 amendment §4)', () => {
  it('writes the marker and run.started under the claim; a repeat answers the first instant; a stale epoch or a revoked worker is lease_lost', async () => {
    const w = await world();
    await claimAs(w, W1);
    const first = w.harness.clock.now();
    expect(await w.remote.spawn({ runId: w.runId, workerId: W1, epoch: 2, now: first })).toEqual({
      kind: 'lease_lost',
    });
    // Backlog 714: the marker's fence re-asks the holder in its own write.
    (w.workers.get(W1) as { usable: boolean }).usable = false;
    expect(await w.remote.spawn({ runId: w.runId, workerId: W1, epoch: 1, now: first })).toEqual({
      kind: 'lease_lost',
    });
    (w.workers.get(W1) as { usable: boolean }).usable = true;
    expect(w.harness.types()).not.toContain('run.started');

    expect(await w.remote.spawn({ runId: w.runId, workerId: W1, epoch: 1, now: first })).toEqual({
      kind: 'spawned',
      startedAt: first,
    });
    const started = w.harness.events().filter((event) => event.type === 'run.started');
    expect(started).toHaveLength(1);
    expect(started[0]?.payload).toMatchObject({ context_pack: { tier0: expect.any(Array) } });
    w.harness.clock.advance(5_000);
    expect(
      await w.remote.spawn({ runId: w.runId, workerId: W1, epoch: 1, now: w.harness.clock.now() }),
    ).toEqual({ kind: 'already_spawned', startedAt: first });
    expect(w.harness.events().filter((event) => event.type === 'run.started')).toHaveLength(1);
  });
});

describe('finish (TD-031 §3, the four-field request)', () => {
  it('settles through settleRun under the worker’s fence, revokes the credential, and a repeat answers already_settled', async () => {
    const w = await world();
    await claimAs(w, W1);
    const now = w.harness.clock.now();
    await w.remote.spawn({ runId: w.runId, workerId: W1, epoch: 1, now });
    const outcome = ranOutcome(w.runId);
    const settled = await w.remote.finish({
      runId: w.runId,
      workerId: W1,
      epoch: 1,
      outcome,
      stopReason: null,
    });
    expect(settled).toMatchObject({ kind: 'settled', ending: { epoch: 1 } });
    expect(w.revoked).toEqual([w.runId]);
    const again = await w.remote.finish({
      runId: w.runId,
      workerId: W1,
      epoch: 1,
      outcome,
      stopReason: null,
    });
    expect(again.kind).toBe('already_settled');
    expect(w.harness.store.offerRows()[0]?.state).toBe('settled');
  });

  it('names what the settling process passes as endingDetail in the escalation (backlog 754’s bound)', async () => {
    let harness: PipelineHarness | null = null;
    const w = await world({
      settle: async (request) =>
        (harness as unknown as PipelineHarness).runtime.executor.settle({
          ...request,
          endingDetail: 'the core holds at most 100000 transcript entries of a remote run',
        }),
    });
    harness = w.harness;
    await claimAs(w, W1);
    await w.remote.spawn({ runId: w.runId, workerId: W1, epoch: 1, now: w.harness.clock.now() });
    const ran = ranOutcome(w.runId);
    await w.remote.finish({
      runId: w.runId,
      workerId: W1,
      epoch: 1,
      outcome: { ...ran, status: 'cancelled', terminalReason: 'cancelled', structuredOutput: null },
      stopReason: null,
    });
    const escalated = w.harness.events().find((event) => event.type === 'task.escalated');
    expect(JSON.stringify(escalated?.payload)).toContain(
      'the run ended as cancelled (cancelled): the core holds at most 100000 transcript entries',
    );
  });

  it('answers lease_lost for a stale epoch, another worker and a revoked worker (backlog 714), writing nothing', async () => {
    const w = await world();
    await claimAs(w, W1);
    await w.remote.spawn({ runId: w.runId, workerId: W1, epoch: 1, now: w.harness.clock.now() });
    const outcome = ranOutcome(w.runId);
    for (const [workerId, epoch] of [
      [W1, 2],
      [W2, 1],
    ] as const) {
      expect(
        (await w.remote.finish({ runId: w.runId, workerId, epoch, outcome, stopReason: null }))
          .kind,
      ).toBe('lease_lost');
    }
    (w.workers.get(W1) as { usable: boolean }).usable = false;
    expect(
      (await w.remote.finish({ runId: w.runId, workerId: W1, epoch: 1, outcome, stopReason: null }))
        .kind,
    ).toBe('lease_lost');
    expect(w.harness.store.offerRows()[0]?.state).toBe('claimed');
    expect(w.revoked).toEqual([]);
  });

  it('answers run_gone for a run whose task was deleted (task_gone), and settles a not_started report', async () => {
    const gone = await world({
      settle: async () => ({
        kind: 'task_gone',
        ending: null,
        outcome: { kind: 'skipped', reason: 'gone' },
      }),
    });
    await claimAs(gone, W1);
    expect(
      (
        await gone.remote.finish({
          runId: gone.runId,
          workerId: W1,
          epoch: 1,
          outcome: ranOutcome(gone.runId),
          stopReason: null,
        })
      ).kind,
    ).toBe('run_gone');

    const w = await world();
    await claimAs(w, W1);
    const report = settleOutcomeOfFinish(w.runId, {
      epoch: 1,
      stop_reason: null,
      outcome: {
        kind: 'not_started',
        failure: 'the workspace could not be created',
        detail: 'docker: image not found',
        detail_truncated: false,
        transient: false,
        spawn_requested: false,
      },
    });
    const settled = await w.remote.finish({
      runId: w.runId,
      workerId: W1,
      epoch: 1,
      outcome: report,
      stopReason: null,
    });
    expect(settled).toMatchObject({ kind: 'settled', ending: { status: 'failed' } });
    expect(w.harness.store.startFailureOf(w.runId)).toMatchObject({ kind: 'not_started' });
  });
});

describe('finish of an ask run (WP-283, backlog 741)', () => {
  it('settles through the ask’s own ending, never settleRun, and answers the row’s ending', async () => {
    const stageSettles: SettleRunRequest[] = [];
    const w = await world({
      settle: async (request) => {
        stageSettles.push(request);
        throw new Error('a stage settle for an ask run');
      },
    });
    await claimAs(w, W1);
    await w.remote.spawn({ runId: w.runId, workerId: W1, epoch: 1, now: w.harness.clock.now() });
    const asked: SettleRunRequest[] = [];
    // The same commands, over a store whose row for this run reads as an ask's (stage null, an
    // ask id) — the one fact `finish` routes on.
    const store = {
      ...w.harness.store,
      runs: new Proxy(w.harness.store.runs, {
        get: (target, key, receiver) =>
          key === 'load'
            ? async (tx: unknown, runId: Id) => {
                const row = await target.load(tx as never, runId);
                return row === null || runId !== w.runId
                  ? row
                  : { ...row, stage: null, askId: '00000000-0000-4000-8000-0000000283aa' };
              }
            : Reflect.get(target, key, receiver),
      }),
    };
    const remote = createRemoteRuns({
      unitOfWork: w.harness.memory,
      store,
      context: w.harness.commands.context,
      runPlans: createTestRunPlanSealer(),
      packager: { build: async () => ({ kind: 'package', package: {} as WorkerRunPackage }) },
      credentials: { revoke: async () => {} },
      tokens: w.tokens,
      settle: async (request) => {
        stageSettles.push(request);
        throw new Error('a stage settle for an ask run');
      },
      settleAsk: async (request) => {
        asked.push(request);
        // The ask's ending ends the row through the same settle machinery a stage's uses.
        await w.harness.runtime.executor.settle(request).catch(() => undefined);
        return { kind: 'settled' };
      },
      lateCost: { record: async () => ({ recorded: true, charge: null }) },
    });
    const answer = await remote.finish({
      runId: w.runId,
      workerId: W1,
      epoch: 1,
      outcome: ranOutcome(w.runId),
      stopReason: null,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.fence).toEqual({ epoch: 1, owner: `worker:${W1}` });
    expect(stageSettles).toHaveLength(0);
    expect(answer).toMatchObject({ kind: 'settled', ending: { epoch: 1, status: 'completed' } });
  });
});

describe('the core’s spawn marker beats the claimant’s word (rule 16)', () => {
  /**
   * PR #9 review: a run whose CLI spawn marker is written and whose claimant then reports it
   * `not_started` with `spawn_requested: false` must not record a measured zero — it may have spent.
   * `settleRun` reads the marker under its lock (both claimants), so the run is held unmeasured.
   */
  it('settles a spawned run reported not_started with spawn_requested false as unmeasured, not zero', async () => {
    const w = await world();
    await claimAs(w, W1);
    await w.remote.spawn({ runId: w.runId, workerId: W1, epoch: 1, now: w.harness.clock.now() });
    const settled = await w.remote.finish({
      runId: w.runId,
      workerId: W1,
      epoch: 1,
      outcome: {
        kind: 'not_started',
        failure: 'the workspace could not be created',
        detail: null,
        detailTruncated: false,
        transient: false,
        spawnRequested: false,
      },
      stopReason: null,
    });
    expect(settled.kind).toBe('settled');
    const run = await w.harness.store.runs.load({} as never, w.runId);
    expect(run?.cost).toBeNull();
    const failed = w.harness.events().find((event) => event.type === 'run.failed');
    expect(failed).toBeDefined();
    expect((failed?.payload as { cost?: unknown } | undefined)?.cost ?? null).toBeNull();
  });

  it('keeps the measured zero for a run that never reached its marker', async () => {
    const w = await world();
    await claimAs(w, W1);
    await w.remote.finish({
      runId: w.runId,
      workerId: W1,
      epoch: 1,
      outcome: {
        kind: 'not_started',
        failure: 'the workspace could not be created',
        detail: null,
        detailTruncated: false,
        transient: false,
        spawnRequested: false,
      },
      stopReason: null,
    });
    const run = await w.harness.store.runs.load({} as never, w.runId);
    expect(run?.cost).toMatchObject({ usd: 0 });
  });
});

describe('late cost (Q70 (b))', () => {
  it('is run_live while the run is live, lease_lost for another claim, and recorded once another writer ended it', async () => {
    const w = await world();
    await claimAs(w, W1);
    const spend = {
      sessionId: null,
      numTurns: 3,
      wallMs: 2_000,
      cost: { usd: 0.4, is_estimate: false, price_list_id: null },
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: 0,
      },
      modelUsage: [],
    };
    const now = w.harness.clock.now();
    expect(await w.remote.lateCost({ runId: w.runId, workerId: W1, epoch: 1, spend, now })).toEqual(
      { kind: 'run_live' },
    );
    await w.harness.memory.transaction(async (scope) =>
      w.harness.store.runs.finish(scope.tx, {
        runId: w.runId,
        status: 'cancelled',
        terminalReason: 'cancelled',
        sessionId: null,
        numTurns: 0,
        usage: spend.usage,
        cost: null,
        wallMs: 0,
      }),
    );
    expect(await w.remote.lateCost({ runId: w.runId, workerId: W2, epoch: 1, spend, now })).toEqual(
      { kind: 'lease_lost' },
    );
    expect(w.lateSpends).toEqual([]);
    expect(await w.remote.lateCost({ runId: w.runId, workerId: W1, epoch: 1, spend, now })).toEqual(
      { kind: 'recorded', recorded: true },
    );
    expect(w.lateSpends).toMatchObject([{ runId: w.runId, numTurns: 3, cost: { usd: 0.4 } }]);
  });
});

describe('settleOutcomeOfFinish', () => {
  it('reads a null cost as unmeasured — never a zero that reads as free (rule 16)', () => {
    const runId = '00000000-0000-4000-8000-0000000281d1' as Id;
    const measured = ranOutcome(runId);
    expect('kind' in measured).toBe(false);
    expect(measured).toMatchObject({ cost: { usd: 0.02 } });
    expect((measured as { costUnmeasured?: boolean }).costUnmeasured).toBeUndefined();
    const unmeasured = settleOutcomeOfFinish(runId, {
      epoch: 1,
      stop_reason: 'cancelled',
      outcome: {
        kind: 'ran',
        status: 'cancelled',
        terminal_reason: 'cancelled',
        session_id: null,
        num_turns: 1,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        model_usage: [],
        cost: null,
        wall_ms: 10,
        structured_output: null,
        error: null,
        redaction_count: 0,
      },
    });
    expect(unmeasured).toMatchObject({ costUnmeasured: true, runId });
  });
});

describe('take this one, and what a worker could claim (WP-293)', () => {
  it('lists the offer with the scope ignored, picks it past a pick-only scope, and audits the pick once', async () => {
    const takes: { workerId: Id; runId: Id; taskId: Id }[] = [];
    const w = await world({ takes });
    const alice = w.workers.get(W1);
    if (alice === undefined) throw new Error('no W1');
    w.workers.set(W1, { ...alice, claimProjectIds: [] });
    const now = w.harness.clock.now();
    expect(await claimAs(w, W1)).toEqual({ kind: 'none' });
    const listed = await w.remote.offers({
      workerId: W1,
      heldImageDigests: HELD,
      images: IMAGES,
      now,
      limit: 50,
    });
    expect(listed.map((offer) => [offer.runId, offer.automatic])).toEqual([[w.runId, false]]);
    const picked = await w.remote.claim({
      workerId: W1,
      heldImageDigests: HELD,
      images: IMAGES,
      now,
      pick: w.runId,
    });
    expect(picked).toMatchObject({ kind: 'claimed', runId: w.runId });
    expect(takes).toEqual([{ workerId: W1, runId: w.runId, taskId: expect.any(String) }]);
    // Taken: neither listed nor picked again, and no second audit row.
    expect(
      await w.remote.offers({
        workerId: W2,
        heldImageDigests: HELD,
        images: IMAGES,
        now,
        limit: 50,
      }),
    ).toEqual([]);
    expect(
      await w.remote.claim({
        workerId: W2,
        heldImageDigests: HELD,
        images: IMAGES,
        now,
        pick: w.runId,
      }),
    ).toEqual({ kind: 'none' });
    expect(takes).toHaveLength(1);
  });

  it('refuses a pick by name in a composition with no audit — a person’s act is never unrecorded', async () => {
    const w = await world({ takes: null });
    await expect(
      w.remote.claim({
        workerId: W1,
        heldImageDigests: HELD,
        images: IMAGES,
        now: w.harness.clock.now(),
        pick: w.runId,
      }),
    ).rejects.toThrow(/takeAudit/);
    // The automatic claim needs none.
    expect(await claimAs(w, W1)).toMatchObject({ kind: 'claimed' });
  });
});
