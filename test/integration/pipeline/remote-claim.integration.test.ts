/**
 * **A remote worker's claim, release and fence against PostgreSQL 18** — WP-281, TD-031 decisions 2,
 * 6, 7 and 8, PROGRESS backlogs 714 and 701.
 *
 * The unit tier (`packages/application/src/pipeline/remote-runs.test.ts`) drives the protocol's
 * commands over the in-memory store, whose worker eligibility is a callback (its divergence 13). What
 * only the database can show is held here:
 *
 *  1. **The eligibility is the claim's own statement** (`WORKER_ELIGIBLE` in
 *     `postgres-run-offers.ts`): each of TD-031 §8's clauses refuses on its own — a revoked worker, a
 *     ban in force (and not an expired one), a pause, a member below `member`, an exclusion, an image
 *     not held, `workers_from` not reached (or never), a static or deploy-key run credential, an ask
 *     offer — with a positive control that claims the same offer once the fact is put back; the
 *     assignee's head start admits the assignee's worker and no one else's.
 *  2. **What the claim writes**: `worker_id` on the offer and the run, the token's hash and epoch, the
 *     offer's `image_digests`, the lease under `worker:<id>`.
 *  3. **Backlog 714**: the claim, the renewal, the spawn marker and `finish`'s fence re-ask the
 *     worker in their own statement — a revoke or a ban committed before them is seen — so a claim
 *     that committed just before a revoke renews nothing after it.
 *  4. **The release** (backlog 701): the claim undone, the epoch kept, the exclusion appended once, a
 *     repeat recognised, `run_started` after the marker, `lease_lost` under another epoch.
 *  5. **The run token's holder** and **a run's live minted credentials** read from the tables.
 */
import {
  claimRunOffer,
  INITIAL_TASK_VERSION,
  LeaseLostError,
  type PipelineStore,
  type RunOfferClaim,
  type StoredTask,
  type Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { FEATURE_TEMPLATE, type OfferRouting, SHIPPED_TEMPLATES } from '@platform/domain';
import { pipeline, recovery } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient } from '../support/postgres.js';

const NOW = '2026-11-04T09:00:00.000Z' as IsoDateTime;
const PAST = '2026-11-04T08:00:00.000Z' as IsoDateTime;
const FUTURE = '2099-01-01T00:00:00.000Z' as IsoDateTime;
const RUN_DIGEST = `sha256:${'a'.repeat(64)}`;
const EGRESS_DIGEST = `sha256:${'b'.repeat(64)}`;
const HELD = [RUN_DIGEST, EGRESS_DIGEST];
const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 0,
};

let database: MigratedDatabase;
let store: PipelineStore;
let orgId: string;
let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${(0x281000 + counter).toString(16).padStart(12, '0')}` as Id;
};

const sql = async <R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<R[]> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    return (await client.query<R>(text, values)).rows;
  } finally {
    await client.end();
  }
};

beforeAll(async () => {
  database = await createMigratedDatabase('remote-claim');
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const [org] = await sql<{ id: string }>(
    "insert into organizations (name) values ('remote-claim') returning id",
  );
  orgId = org?.id as string;
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

/** One connection, one transaction, ended exactly once. */
const begin = async () => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  await client.query('begin');
  let ended = false;
  const end = async (verb: 'commit' | 'rollback'): Promise<void> => {
    if (ended) return;
    ended = true;
    try {
      await client.query(verb);
    } finally {
      await client.end();
    }
  };
  return {
    client,
    tx: { adapter: 'postgres', client } as unknown as Transaction,
    commit: async () => end('commit'),
    rollback: async () => end('rollback'),
  };
};

/** Runs `work` in a committed transaction of its own. */
const inTx = async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
  const scope = await begin();
  try {
    const result = await work(scope.tx);
    await scope.commit();
    return result;
  } catch (error) {
    await scope.rollback();
    throw error;
  }
};

interface World {
  readonly projectId: Id;
  readonly alice: Id;
  readonly bob: Id;
  /** Alice's worker and Bob's; Bob is a project `viewer` unless a case makes him more. */
  readonly w1: Id;
  readonly w2: Id;
}

/** A fresh project with two users, their workers, Alice a `member` and Bob a `viewer`. */
const world = async (): Promise<World> => {
  const [project] = await sql<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, $2, 'Remote', 'https://git.example.test/acme/remote.git') returning id`,
    [orgId, `r${counter}x${Date.now() % 100_000}`],
  );
  const projectId = project?.id as Id;
  const user = async (role: string): Promise<Id> => {
    const [row] = await sql<{ id: string }>(
      'insert into users (email, name) values ($1, $2) returning id',
      [`${nextId()}@example.test`, 'Someone'],
    );
    await sql('insert into project_members (project_id, user_id, role) values ($1, $2, $3)', [
      projectId,
      row?.id,
      role,
    ]);
    return row?.id as Id;
  };
  const alice = await user('member');
  const bob = await user('viewer');
  const worker = async (userId: Id): Promise<Id> => {
    const id = nextId();
    await sql(
      `insert into workers (id, user_id, name, credential_hash, last_seen_at)
       values ($1, $2, 'laptop', $3, now())`,
      [id, userId, id.replaceAll('-', '').padEnd(64, '0').slice(0, 64)],
    );
    return id;
  };
  return { projectId, alice, bob, w1: await worker(alice), w2: await worker(bob) };
};

const task = async (projectId: Id): Promise<Id> => {
  const taskId = nextId();
  await inTx(async (tx) =>
    store.tasks.insert(tx, {
      task: {
        id: taskId,
        projectId,
        ticket: {
          provider: 'fake-jira',
          key: `REM-${counter}`,
          url: `https://jira.example.test/browse/REM-${counter}`,
        },
        template: 'feature',
        mode: 'normal',
        state: 'active',
        currentStage: 'implementation' as Slug,
        stageAttempts: { implementation: 1 },
        iterationCounters: {},
        limits: {
          code_review: 3,
          business_review: 2,
          ci_fix: 3,
          human_rounds: 3,
          refinement_questions: 2,
          architecture_revisions: 2,
          rebase: 2,
          rebase_rechecks: 10,
          dependency_policy: 2,
        },
        sequence: 1,
      },
      template: FEATURE_TEMPLATE,
      pipelineDial: null,
      qaStage: false,
      priorityRank: 2,
      createdAt: NOW,
      branch: null,
      mr: null,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      estimateBasis: null,
      estimateSamples: null,
      ticketSnapshot: null,
      ticketSnapshotAt: null,
      ticketSignalAt: null,
      reviewSubject: null,
      historySample: null,
      riskClasses: [],
      coverage: null,
      dependencies: null,
      requiredReviewers: null,
      reviewThreads: null,
      readyHeadSha: null,
      ciHeadSha: null,
      ciExcusedPaths: [],
      requestedByUserId: null,
      version: INITIAL_TASK_VERSION,
    } as unknown as StoredTask),
  );
  return taskId;
};

/** Routing open to workers since an hour ago, the server never. */
const workersRouting = (overrides: Partial<OfferRouting> = {}): OfferRouting => ({
  assigneeUserId: null,
  assigneeUntil: null,
  serverFrom: null,
  workersFrom: PAST,
  expiresAt: FUTURE,
  ...overrides,
});

/** A committed `created` run with an `open` offer of `kind`. */
const offered = async (
  w: World,
  options: { readonly routing?: OfferRouting; readonly kind?: 'stage' | 'ask' } = {},
): Promise<Id> => {
  const taskId = await task(w.projectId);
  const runId = nextId();
  const kind = options.kind ?? 'stage';
  await inTx(async (tx) => {
    await store.runs.insert(tx, {
      id: runId,
      taskId,
      projectId: w.projectId,
      stage: kind === 'stage' ? ('implementation' as Slug) : null,
      role: 'developer',
      mode: 'normal',
      attempt: 1,
      model: 'claude-opus-5',
      effort: 'high',
      promptVersion: 'test@1',
      systemPrompt: null,
      userPrompt: null,
      redactionCount: 0,
      contextPack: null,
      settings: null,
      reserveUsd: null,
      promptsWithheld: null,
      providerMode: 'api',
      status: 'created',
      terminalReason: null,
      sessionId: null,
      numTurns: 0,
      usage: null,
      cost: null,
      wallMs: 0,
      createdAt: NOW,
      startedAt: null,
    });
    await store.offers.insert(tx, {
      id: nextId(),
      runId,
      taskId,
      projectId: w.projectId,
      stage: kind === 'stage' ? ('implementation' as Slug) : null,
      attempt: 1,
      kind,
      offeredAt: NOW,
      routing: options.routing ?? workersRouting(),
    });
  });
  return runId;
};

const workerClaim = (workerId: Id, runId: Id, held: readonly string[] = HELD): RunOfferClaim => ({
  eligibility: { runId },
  claimantKind: 'worker',
  owner: `worker:${workerId}`,
  expiresAt: '2026-11-04T09:10:00.000Z' as IsoDateTime,
  now: NOW,
  worker: {
    workerId,
    heldImageDigests: held,
    images: { run: RUN_DIGEST, egress: EGRESS_DIGEST },
    runTokenHash: 'f'.repeat(64),
  },
});

const claim = async (workerId: Id, runId: Id, held?: readonly string[]) =>
  inTx(async (tx) => claimRunOffer(store.offers, tx, workerClaim(workerId, runId, held)));

const offerState = async (runId: Id) =>
  (await sql<{ state: string }>('select state from run_offers where run_id = $1', [runId]))[0]
    ?.state;

describe('the worker claim’s eligibility is its own statement (TD-031 §8)', () => {
  it('claims for an eligible worker and writes the worker, the token, the images and the lease', async () => {
    const w = await world();
    const runId = await offered(w);
    const claimed = await claim(w.w1, runId);
    expect(claimed).toMatchObject({
      runId,
      epoch: 1,
      owner: `worker:${w.w1}`,
      images: { run: RUN_DIGEST, egress: EGRESS_DIGEST },
    });
    const [offer] = await sql<{
      state: string;
      claimant_kind: string;
      worker_id: string;
      run_token_hash: string;
      run_token_epoch: number;
      image_digests: unknown;
    }>(
      `select state, claimant_kind, worker_id, run_token_hash, run_token_epoch, image_digests
         from run_offers where run_id = $1`,
      [runId],
    );
    expect(offer).toEqual({
      state: 'claimed',
      claimant_kind: 'worker',
      worker_id: w.w1,
      run_token_hash: 'f'.repeat(64),
      run_token_epoch: 1,
      image_digests: { run: RUN_DIGEST, egress: EGRESS_DIGEST },
    });
    const [run] = await sql<{
      status: string;
      worker_id: string;
      lease_owner: string;
      lease_epoch: number;
    }>('select status, worker_id, lease_owner, lease_epoch from runs where id = $1', [runId]);
    expect(run).toEqual({
      status: 'starting',
      worker_id: w.w1,
      lease_owner: `worker:${w.w1}`,
      lease_epoch: 1,
    });
  });

  const refusals: readonly [
    string,
    (w: World, runId: Id) => Promise<void>,
    (w: World, runId: Id) => Promise<void>,
  ][] = [
    [
      'a revoked worker',
      async (w) => {
        await sql("update workers set revoked_at = now(), state = 'revoked' where id = $1", [w.w1]);
      },
      async (w) => {
        await sql("update workers set revoked_at = null, state = 'active' where id = $1", [w.w1]);
      },
    ],
    [
      'a ban in force (an expired ban admits)',
      async (w) => {
        await sql(
          "update users set banned = true, ban_expires = now() + interval '1 day' where id = $1",
          [w.alice],
        );
      },
      async (w) => {
        await sql("update users set ban_expires = now() - interval '1 day' where id = $1", [
          w.alice,
        ]);
      },
    ],
    [
      'a disabled user',
      async (w) => {
        await sql("update users set status = 'disabled' where id = $1", [w.alice]);
      },
      async (w) => {
        await sql("update users set status = 'active' where id = $1", [w.alice]);
      },
    ],
    [
      'a paused worker',
      async (w) => {
        await sql(
          "update workers set paused_until = $2, paused_reason = 'usage_limited' where id = $1",
          [w.w1, FUTURE],
        );
      },
      async (w) => {
        await sql('update workers set paused_until = $2 where id = $1', [w.w1, PAST]);
      },
    ],
    [
      'a user below member (viewer)',
      async (w) => {
        await sql("update project_members set role = 'viewer' where user_id = $1", [w.alice]);
      },
      async (w) => {
        await sql("update project_members set role = 'maintainer' where user_id = $1", [w.alice]);
      },
    ],
    [
      'an excluded worker',
      async (w, runId) => {
        await sql('update run_offers set excluded_worker_ids = array[$2::uuid] where run_id = $1', [
          runId,
          w.w1,
        ]);
      },
      async (_w, runId) => {
        await sql("update run_offers set excluded_worker_ids = '{}' where run_id = $1", [runId]);
      },
    ],
    [
      'an offer naming images the worker does not hold',
      async (_w, runId) => {
        await sql(
          `update run_offers set image_digests = jsonb_build_object('run', $2::text, 'egress', $3::text)
            where run_id = $1`,
          [runId, `sha256:${'c'.repeat(64)}`, EGRESS_DIGEST],
        );
      },
      async (_w, runId) => {
        await sql('update run_offers set image_digests = null where run_id = $1', [runId]);
      },
    ],
    [
      'workers_from not reached',
      async (_w, runId) => {
        await sql('update run_offers set workers_from = $2 where run_id = $1', [runId, FUTURE]);
      },
      async (_w, runId) => {
        await sql('update run_offers set workers_from = $2 where run_id = $1', [runId, PAST]);
      },
    ],
    [
      'workers_from never (server_only)',
      async (_w, runId) => {
        await sql('update run_offers set workers_from = null, server_from = $2 where run_id = $1', [
          runId,
          PAST,
        ]);
      },
      async (_w, runId) => {
        await sql('update run_offers set workers_from = $2 where run_id = $1', [runId, PAST]);
      },
    ],
  ];

  it.each(refusals)(
    'refuses %s, and claims the same offer once the fact is put back',
    async (_name, refuse, restore) => {
      const w = await world();
      const runId = await offered(w);
      await refuse(w, runId);
      expect(await claim(w.w1, runId)).toBeNull();
      expect(await offerState(runId)).toBe('open');
      await restore(w, runId);
      expect((await claim(w.w1, runId))?.runId).toBe(runId);
    },
  );

  it('refuses a project whose git integration declares a static or deploy-key run credential (WP-282’s opt-in)', async () => {
    for (const source of ['static', 'deploy_key'] as const) {
      const w = await world();
      const runId = await offered(w);
      const [integration] = await sql<{ id: string }>(
        `insert into integrations (org_id, type, provider, name, config)
         values ($1, 'git', 'gitlab', $2, jsonb_build_object('run_credential', $3::text)) returning id`,
        [orgId, `git-${nextId()}`, source],
      );
      const [binding] = await sql<{ id: string }>(
        'insert into bindings (project_id, integration_id) values ($1, $2) returning id',
        [w.projectId, integration?.id],
      );
      expect(await claim(w.w1, runId)).toBeNull();
      await sql(
        "update integrations set config = jsonb_build_object('run_credential', 'minted') where id = $1",
        [integration?.id],
      );
      expect((await claim(w.w1, runId))?.runId).toBe(runId);
      expect(binding?.id).toBeDefined();
    }
  });

  it('refuses an ask offer: an ask’s ending is not served to a worker before WP-283', async () => {
    const w = await world();
    const runId = await offered(w, { kind: 'ask' });
    expect(await claim(w.w1, runId)).toBeNull();
  });

  it('gives the assignee’s worker the head start and nobody else', async () => {
    const w = await world();
    await sql("update project_members set role = 'member' where user_id = $1", [w.bob]);
    const runId = await offered(w, {
      routing: workersRouting({
        workersFrom: FUTURE,
        assigneeUserId: w.alice,
        assigneeUntil: FUTURE,
      }),
    });
    expect(await claim(w.w2, runId)).toBeNull();
    expect((await claim(w.w1, runId))?.runId).toBe(runId);
  });
});

describe('backlog 714: the holder re-asked in each fenced write', () => {
  it('a revoke committed before the renewal, the marker or finish is seen by each', async () => {
    const w = await world();
    const runId = await offered(w);
    await claim(w.w1, runId);
    const fence = { epoch: 1, owner: `worker:${w.w1}` };
    expect(
      await inTx(async (tx) =>
        store.runs.renewLease(tx, { runId, owner: fence.owner, epoch: 1, expiresAt: FUTURE }),
      ),
    ).toBe(true);
    await sql("update workers set revoked_at = now(), state = 'revoked' where id = $1", [w.w1]);
    expect(
      await inTx(async (tx) =>
        store.runs.renewLease(tx, { runId, owner: fence.owner, epoch: 1, expiresAt: FUTURE }),
      ),
    ).toBe(false);
    await expect(
      inTx(async (tx) => store.runs.markCliSpawnRequested(tx, { runId, at: NOW, lease: fence })),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      inTx(async (tx) =>
        store.runs.finish(tx, {
          runId,
          status: 'failed',
          terminalReason: 'error_during_execution',
          sessionId: null,
          numTurns: 0,
          usage: ZERO_USAGE,
          cost: null,
          wallMs: 0,
          lease: fence,
        }),
      ),
    ).rejects.toBeInstanceOf(LeaseLostError);
    const [run] = await sql<{ status: string }>('select status from runs where id = $1', [runId]);
    expect(run?.status).toBe('starting');
  });

  it('a claim committed just before a revoke is fenced from the revoke on: its lease expired, its renewal refused', async () => {
    const w = await world();
    const runId = await offered(w);
    expect((await claim(w.w1, runId))?.runId).toBe(runId);
    // `WorkerStore.revokeWorker`'s two writes (WP-280): the worker, then its live runs' leases.
    await inTx(async (tx) => {
      const client = (tx as unknown as { client: { query: typeof sql } }).client;
      await client.query("update workers set revoked_at = now(), state = 'revoked' where id = $1", [
        w.w1,
      ]);
      await client.query(
        `update runs set lease_expires_at = now()
          where worker_id = $1 and status in ('created', 'starting', 'running')`,
        [w.w1],
      );
    });
    const [run] = await sql<{ expired: boolean }>(
      'select lease_expires_at <= now() as expired from runs where id = $1',
      [runId],
    );
    expect(run?.expired).toBe(true);
    // A revoke whose lease expiry ran while the claim was still uncommitted would not see the run
    // (its snapshot has no worker on it); what closes that interleaving is this: every later fenced
    // write re-asks the worker in its own statement, so the run can renew nothing.
    expect(
      await inTx(async (tx) =>
        store.runs.renewLease(tx, {
          runId,
          owner: `worker:${w.w1}`,
          epoch: 1,
          expiresAt: FUTURE,
        }),
      ),
    ).toBe(false);
  });

  it('the run token’s holder reads the worker usable, and not once it is revoked or its user banned', async () => {
    const w = await world();
    const runId = await offered(w);
    await claim(w.w1, runId);
    const holder = async () => inTx(async (tx) => store.offers.runTokenHolder(tx, runId));
    expect(await holder()).toMatchObject({
      tokenHash: 'f'.repeat(64),
      tokenEpoch: 1,
      workerId: w.w1,
      workerUsable: true,
      runStatus: 'starting',
      endedAt: null,
    });
    await sql('update users set banned = true, ban_expires = null where id = $1', [w.alice]);
    expect((await holder())?.workerUsable).toBe(false);
  });
});

describe('the release (backlog 701)', () => {
  it('undoes the claim only, keeps the epoch, appends the exclusion once, and recognises a repeat', async () => {
    const w = await world();
    const runId = await offered(w);
    await claim(w.w1, runId);
    const release = (epoch: number, owner = `worker:${w.w1}`) =>
      inTx(async (tx) =>
        store.offers.release(tx, {
          runId,
          epoch,
          owner,
          reason: 'provision_failed',
          excludeWorkerId: w.w1,
          now: NOW,
        }),
      );
    expect((await release(1, `worker:${w.w2}`)).kind).toBe('lease_lost');
    expect((await release(1)).kind).toBe('released');
    const [offer] = await sql<{
      state: string;
      lease_epoch: number;
      release_reason: string;
      excluded_worker_ids: string[];
      worker_id: string;
    }>(
      `select state, lease_epoch, release_reason, excluded_worker_ids, worker_id
         from run_offers where run_id = $1`,
      [runId],
    );
    expect(offer).toEqual({
      state: 'open',
      lease_epoch: 1,
      release_reason: 'provision_failed',
      excluded_worker_ids: [w.w1],
      worker_id: w.w1,
    });
    const [run] = await sql<{
      status: string;
      lease_owner: string | null;
      worker_id: string | null;
    }>('select status, lease_owner, worker_id from runs where id = $1', [runId]);
    expect(run).toEqual({ status: 'created', lease_owner: null, worker_id: null });
    expect((await release(1)).kind).toBe('already_released');
    // The exclusion holds, and another worker's claim moves the epoch past the released one.
    expect(await claim(w.w1, runId)).toBeNull();
    await sql("update project_members set role = 'member' where user_id = $1", [w.bob]);
    expect((await claim(w.w2, runId))?.epoch).toBe(2);
    expect((await release(1)).kind).toBe('lease_lost');
    const [after] = await sql<{ excluded_worker_ids: string[] }>(
      'select excluded_worker_ids from run_offers where run_id = $1',
      [runId],
    );
    expect(after?.excluded_worker_ids).toEqual([w.w1]);
  });

  it('is run_started once the spawn marker is written', async () => {
    const w = await world();
    const runId = await offered(w);
    await claim(w.w1, runId);
    const fence = { epoch: 1, owner: `worker:${w.w1}` };
    expect(
      await inTx(async (tx) =>
        store.runs.markCliSpawnRequested(tx, { runId, at: NOW, lease: fence }),
      ),
    ).toBe(true);
    expect(
      (
        await inTx(async (tx) =>
          store.offers.release(tx, {
            runId,
            epoch: 1,
            owner: fence.owner,
            reason: 'shutdown',
            excludeWorkerId: null,
            now: NOW,
          }),
        )
      ).kind,
    ).toBe('run_started');
    expect(await offerState(runId)).toBe('claimed');
  });
});

describe('a run’s live minted credentials, whatever its status (WP-281)', () => {
  it('finds an unexpired mint of a created run, and not once a successful revoke is recorded', async () => {
    const w = await world();
    const runId = await offered(w);
    const [taskRow] = await sql<{ task_id: string }>('select task_id from runs where id = $1', [
      runId,
    ]);
    const [integration] = await sql<{ id: string }>(
      `insert into integrations (org_id, type, provider, name) values ($1, 'git', 'gitlab', $2)
       returning id`,
      [orgId, `git-${nextId()}`],
    );
    await sql(
      `insert into integration_actions
         (integration_id, task_id, direction, action, payload, result, status, attempts,
          redaction_count)
       values ($1, $2, 'out', 'mint_credential', jsonb_build_object('run_id', $3::text),
               jsonb_build_object('revoke_id', 'acme/remote#81', 'scope', 'push',
                                  'expires_at', '2099-01-01T00:00:00.000Z'), 'ok', 1, 0)`,
      [integration?.id, taskRow?.task_id, runId],
    );
    const credentialStore = recovery.createPostgresRunCredentialStore();
    const live = () =>
      inTx(async (tx) =>
        credentialStore.liveCredentialsOfRun(tx, {
          runId,
          now: new Date().toISOString() as IsoDateTime,
        }),
      );
    expect(await live()).toMatchObject([
      { runId, integrationId: integration?.id, revokeId: 'acme/remote#81', scope: 'push' },
    ]);
    await sql(
      `insert into integration_actions
         (integration_id, task_id, direction, action, payload, result, status, attempts,
          redaction_count)
       values ($1, $2, 'out', 'revoke_credential', jsonb_build_object('revoke_id', 'acme/remote#81'),
               jsonb_build_object('revoked', true), 'ok', 1, 0)`,
      [integration?.id, taskRow?.task_id],
    );
    expect(await live()).toEqual([]);
  });

  it('scopes a release’s revoke to the mints recorded by then — never a later claimant’s', async () => {
    const w = await world();
    const runId = await offered(w);
    const [taskRow] = await sql<{ task_id: string }>('select task_id from runs where id = $1', [
      runId,
    ]);
    const [integration] = await sql<{ id: string }>(
      `insert into integrations (org_id, type, provider, name) values ($1, 'git', 'gitlab', $2)
       returning id`,
      [orgId, `git-${nextId()}`],
    );
    const mint = async (revokeId: string, createdAt: string) =>
      sql(
        `insert into integration_actions
           (integration_id, task_id, direction, action, payload, result, status, attempts,
            redaction_count, created_at)
         values ($1, $2, 'out', 'mint_credential', jsonb_build_object('run_id', $3::text),
                 jsonb_build_object('revoke_id', $4::text, 'scope', 'push',
                                    'expires_at', '2099-01-01T00:00:00.000Z'), 'ok', 1, 0,
                 $5::timestamptz)`,
        [integration?.id, taskRow?.task_id, runId, revokeId, createdAt],
      );
    const now = Date.now();
    await mint('acme/remote#91', new Date(now - 60_000).toISOString());
    await mint('acme/remote#92', new Date(now - 1_000).toISOString());
    const credentialStore = recovery.createPostgresRunCredentialStore();
    const live = (mintedBefore?: string) =>
      inTx(async (tx) =>
        credentialStore.liveCredentialsOfRun(tx, {
          runId,
          now: new Date(now).toISOString() as IsoDateTime,
          ...(mintedBefore === undefined ? {} : { mintedBefore: mintedBefore as IsoDateTime }),
        }),
      );
    expect((await live()).map((row) => row.revokeId)).toEqual(['acme/remote#91', 'acme/remote#92']);
    expect((await live(new Date(now - 30_000).toISOString())).map((row) => row.revokeId)).toEqual([
      'acme/remote#91',
    ]);
  });
});
