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
 *     not held, `workers_from` not reached (or never), a static or deploy-key run credential — with
 *     a positive control that claims the same offer once the fact is put back; the assignee's head
 *     start admits the assignee's worker and no one else's, for a stage offer and (WP-283, backlog
 *     741) for an ask's, whose assignee is the asker.
 *  2. **What the claim writes**: `worker_id` on the offer and the run, the token's hash and epoch, the
 *     offer's `image_digests`, the lease under `worker:<id>`.
 *  3. **Backlog 714**: the claim, the renewal, the spawn marker and `finish`'s fence re-ask the
 *     worker in their own statement — a revoke or a ban committed before them is seen — so a claim
 *     that committed just before a revoke renews nothing after it.
 *  4. **The release** (backlog 701): the claim undone, the epoch kept, the exclusion appended once, a
 *     repeat recognised, `run_started` after the marker, `lease_lost` under another epoch.
 *  5. **The run token's holder** and **a run's live minted credentials** read from the tables.
 *  7. **Backlog 744 (S-22.14)**: a claim the admission re-check refuses is **rolled back** by
 *     PostgreSQL — the offer open again, no `run.claimed`, the epoch unchanged — and the refusal's own
 *     transaction withdraws it (`budget_at_claim`), ends its run `cancelled` and pauses the task. The
 *     memory store keeps a rolled-back write (its divergence 4), so only this tier shows the withdrawal.
 *  6. **WP-282's statements** (`postgres-remote-run-calls.ts`): one transcript row per `(run_id,
 *     seq)` on a table whose key carries the partition column; a tool call's claim, answer and
 *     take-over; an approval decided once and delivered once; the session mirror once per position;
 *     and `ssh_signatures` counted in the statement that checks the fence — one cap per run however
 *     many connections (API replicas) race for it, nothing counted under a stale epoch, another
 *     worker or a settled offer.
 */
import { createHash } from 'node:crypto';
import {
  type BlockingBudget,
  claimRunOffer,
  createClaimAdmission,
  createRemoteRuns,
  createTestRunPlanSealer,
  defaultProjectSettings,
  INITIAL_TASK_VERSION,
  LeaseLostError,
  type PipelineStore,
  type RunOfferClaim,
  type StoredTask,
  type Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, Slug, TranscriptEvent } from '@platform/contracts';
import { FEATURE_TEMPLATE, type OfferRouting, SHIPPED_TEMPLATES } from '@platform/domain';
import { eventing, pipeline, recovery } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { remoteRunCredentialOf } from '../../../apps/server/src/worker-run-calls.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

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

/**
 * A fresh project with two users, their workers, Alice a `member` and Bob a `viewer` **of the
 * project**. Both are organisation `viewer`s — not the column's default `member` — so the membership
 * is what decides, and a refusal below `member` is the membership's (backlog 886: the effective role
 * is the higher of the two, and an organisation `member` would claim with any membership or none).
 */
const world = async (): Promise<World> => {
  const [project] = await sql<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, $2, 'Remote', 'https://git.example.test/acme/remote.git') returning id`,
    [orgId, `r${counter}x${Date.now() % 100_000}`],
  );
  const projectId = project?.id as Id;
  const user = async (role: string): Promise<Id> => {
    const [row] = await sql<{ id: string }>(
      "insert into users (email, name, role) values ($1, $2, 'viewer') returning id",
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
      'a worker its owner paused from the local page (WP-292)',
      async (w) => {
        await sql('update workers set manually_paused_at = now() where id = $1', [w.w1]);
      },
      async (w) => {
        await sql('update workers set manually_paused_at = null where id = $1', [w.w1]);
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

  it('refuses a project whose git integration declares a static or deploy-key run credential unless remote_run_credential is allow (WP-282, Q124 (a))', async () => {
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
      // Absent is `deny`, and so is `deny` said explicitly.
      expect(await claim(w.w1, runId)).toBeNull();
      await sql(
        "update integrations set config = config || jsonb_build_object('remote_run_credential', 'deny') where id = $1",
        [integration?.id],
      );
      expect(await claim(w.w1, runId)).toBeNull();
      // The opt-in admits it, the credential source unchanged.
      await sql(
        "update integrations set config = config || jsonb_build_object('remote_run_credential', 'allow') where id = $1",
        [integration?.id],
      );
      expect((await claim(w.w1, runId))?.runId).toBe(runId);
      expect(binding?.id).toBeDefined();
    }
  });

  it('the packager reads the opt-in as the claim does: every non-minted git binding must allow (review of PR #22)', async () => {
    const w = await world();
    const runId = await offered(w);
    const bind = async (config: Record<string, string>) => {
      const [integration] = await sql<{ id: string }>(
        `insert into integrations (org_id, type, provider, name, config)
         values ($1, 'git', 'gitlab', $2, $3::jsonb) returning id`,
        [orgId, `git-${nextId()}`, JSON.stringify(config)],
      );
      await sql('insert into bindings (project_id, integration_id) values ($1, $2)', [
        w.projectId,
        integration?.id,
      ]);
      return integration?.id as string;
    };
    await bind({ run_credential: 'static', remote_run_credential: 'allow' });
    const denying = await bind({ run_credential: 'deploy_key' });
    const pool = createTestPool(database.connectionString, { max: 1 });
    try {
      const read = remoteRunCredentialOf(pool);
      // One allows, one does not: both the claim and the packager refuse.
      expect(await read(w.projectId)).toBe('deny');
      expect(await claim(w.w1, runId)).toBeNull();
      await sql(
        "update integrations set config = config || jsonb_build_object('remote_run_credential', 'allow') where id = $1",
        [denying],
      );
      expect(await read(w.projectId)).toBe('allow');
      expect((await claim(w.w1, runId))?.runId).toBe(runId);
    } finally {
      await pool.end();
    }
  });

  it('admits a minted project with no opt-in at all', async () => {
    const w = await world();
    const runId = await offered(w);
    const [integration] = await sql<{ id: string }>(
      `insert into integrations (org_id, type, provider, name, config)
       values ($1, 'git', 'gitlab', $2, jsonb_build_object('run_credential', 'minted')) returning id`,
      [orgId, `git-${nextId()}`],
    );
    await sql('insert into bindings (project_id, integration_id) values ($1, $2)', [
      w.projectId,
      integration?.id,
    ]);
    expect((await claim(w.w1, runId))?.runId).toBe(runId);
  });

  it('claims an ask offer for the asker’s worker inside its head start, and nobody else’s (WP-283, backlog 741)', async () => {
    const w = await world();
    await sql("update project_members set role = 'member' where user_id = $1", [w.bob]);
    const runId = await offered(w, {
      kind: 'ask',
      routing: workersRouting({
        workersFrom: FUTURE,
        assigneeUserId: w.alice,
        assigneeUntil: FUTURE,
      }),
    });
    expect(await claim(w.w2, runId)).toBeNull();
    expect((await claim(w.w1, runId))?.runId).toBe(runId);
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

describe('backlog 886: the claim reads the effective role, as rbac.ts does', () => {
  /** A user of organisation role `orgRole`, with `membership` in the project or none, and a worker. */
  const someone = async (w: World, orgRole: string, membership: string | null): Promise<Id> => {
    const [row] = await sql<{ id: string }>(
      'insert into users (email, name, role) values ($1, $2, $3) returning id',
      [`${nextId()}@example.test`, 'Someone', orgRole],
    );
    const userId = row?.id as Id;
    if (membership !== null) {
      await sql('insert into project_members (project_id, user_id, role) values ($1, $2, $3)', [
        w.projectId,
        userId,
        membership,
      ]);
    }
    const workerId = nextId();
    await sql(
      `insert into workers (id, user_id, name, credential_hash, last_seen_at)
       values ($1, $2, 'laptop', $3, now())`,
      [workerId, userId, workerId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)],
    );
    return workerId;
  };

  it.each(['member', 'maintainer', 'admin'])(
    'claims for an organisation %s with no project membership at all',
    async (orgRole) => {
      const w = await world();
      const workerId = await someone(w, orgRole, null);
      const runId = await offered(w);
      expect((await claim(workerId, runId))?.runId).toBe(runId);
    },
  );

  it('refuses an organisation viewer with no project membership', async () => {
    const w = await world();
    const workerId = await someone(w, 'viewer', null);
    const runId = await offered(w);
    expect(await claim(workerId, runId)).toBeNull();
    expect(await offerState(runId)).toBe('open');
  });

  it('claims for an organisation viewer whom a project membership promotes to member', async () => {
    const w = await world();
    const workerId = await someone(w, 'viewer', 'member');
    const runId = await offered(w);
    expect((await claim(workerId, runId))?.runId).toBe(runId);
  });

  it('a viewer membership never demotes an organisation member', async () => {
    const w = await world();
    const workerId = await someone(w, 'member', 'viewer');
    const runId = await offered(w);
    expect((await claim(workerId, runId))?.runId).toBe(runId);
  });

  it('another project’s membership promotes nothing here', async () => {
    const w = await world();
    const elsewhere = await world();
    const [row] = await sql<{ id: string }>(
      "insert into users (email, name, role) values ($1, 'Someone', 'viewer') returning id",
      [`${nextId()}@example.test`],
    );
    await sql("insert into project_members (project_id, user_id, role) values ($1, $2, 'admin')", [
      elsewhere.projectId,
      row?.id,
    ]);
    const workerId = nextId();
    await sql(
      `insert into workers (id, user_id, name, credential_hash, last_seen_at)
       values ($1, $2, 'laptop', $3, now())`,
      [workerId, row?.id, workerId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)],
    );
    const runId = await offered(w);
    expect(await claim(workerId, runId)).toBeNull();
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

describe('WP-282: the run-scoped calls’ statements', () => {
  const calls = pipeline.createPostgresRemoteRunCallStore();
  const digest = (n: number): string => n.toString(16).padStart(64, '0');

  /** A claimed run of a fresh world: the offer `claimed` at epoch 1 by `w1`. */
  const claimed = async () => {
    const w = await world();
    const runId = await offered(w);
    expect((await claim(w.w1, runId))?.runId).toBe(runId);
    return { w, runId };
  };

  const entry = (runId: Id, seq: number, text: string, at: Date = new Date()): TranscriptEvent =>
    ({
      run_id: runId,
      seq,
      created_at: at.toISOString(),
      redaction_count: 0,
      kind: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text }],
    }) as TranscriptEvent;

  it('transcript: one row per (run_id, seq), whatever instant a repeat names', async () => {
    const { runId } = await claimed();
    expect(
      await inTx((tx) =>
        calls.appendTranscript(tx, runId, [entry(runId, 0, 'first'), entry(runId, 1, 'b')]),
      ),
    ).toBe(2);
    const later = new Date(Date.now() + 1_000);
    expect(
      await inTx((tx) =>
        calls.appendTranscript(tx, runId, [entry(runId, 0, 'again', later), entry(runId, 2, 'c')]),
      ),
    ).toBe(1);
    const rows = await sql<{ seq: number; text: string }>(
      `select seq, payload -> 'content' -> 0 ->> 'text' as text
         from run_messages where run_id = $1 order by seq`,
      [runId],
    );
    expect(rows).toEqual([
      { seq: 0, text: 'first' },
      { seq: 1, text: 'b' },
      { seq: 2, text: 'c' },
    ]);
  });

  it('tool calls: a claim, its answer; a fresh claim refused; a stale one taken over only for the same call', async () => {
    const { runId } = await claimed();
    const claimOf = (at: string, takeOverBefore: string | null, input = digest(1)) =>
      inTx((tx) =>
        calls.claimToolCall(tx, {
          runId,
          toolUseDigest: digest(9),
          toolName: 'open_mr',
          inputDigest: input,
          epoch: 1,
          at: at as IsoDateTime,
          takeOverBefore: takeOverBefore as IsoDateTime | null,
        }),
      );
    expect(await claimOf('2026-11-04T09:00:00.000Z', null)).toBe(true);
    expect(await claimOf('2026-11-04T09:01:00.000Z', null)).toBe(false);
    // Stale, but another input: never taken over.
    expect(await claimOf('2026-11-04T09:10:00.000Z', '2026-11-04T09:05:00.000Z', digest(2))).toBe(
      false,
    );
    expect(await claimOf('2026-11-04T09:10:00.000Z', '2026-11-04T09:05:00.000Z')).toBe(true);
    await inTx((tx) =>
      calls.completeToolCall(tx, {
        runId,
        toolUseDigest: digest(9),
        result: { iid: 7 },
        isError: false,
        redactionCount: 1,
        at: '2026-11-04T09:11:00.000Z' as IsoDateTime,
      }),
    );
    const found = await inTx((tx) => calls.findToolCall(tx, runId, digest(9)));
    expect(found).toMatchObject({
      toolName: 'open_mr',
      inputDigest: digest(1),
      answer: { result: { iid: 7 }, isError: false },
    });
    // An answered call is never claimed again, however old.
    expect(await claimOf('2026-11-04T10:00:00.000Z', '2026-11-04T09:59:00.000Z')).toBe(false);
  });

  it('approvals: one per tool use, decided once, delivered once', async () => {
    const { runId } = await claimed();
    const open = (id: Id) =>
      inTx((tx) =>
        calls.openApproval(tx, {
          id,
          runId,
          toolUseDigest: digest(3),
          toolName: 'WebFetch',
          epoch: 1,
          at: NOW,
        }),
      );
    const first = await open(nextId());
    expect(first.created).toBe(true);
    expect(await open(nextId())).toEqual({ id: first.id, created: false });
    for (const decision of ['deny', 'allow'] as const) {
      await inTx((tx) =>
        calls.decideApproval(tx, {
          id: first.id,
          decision,
          reason: decision,
          questionId: null,
          at: NOW,
        }),
      );
    }
    const take = () => inTx((tx) => calls.takeDecidedApprovals(tx, { runId, at: NOW, limit: 10 }));
    expect(await take()).toEqual([
      { approvalId: first.id, decision: 'deny', reason: 'deny', questionId: null },
    ]);
    expect(await take()).toEqual([]);
  });

  it('session lines: stored once per position', async () => {
    const { runId } = await claimed();
    const append = (fromLine: number, lines: string[]) =>
      inTx((tx) =>
        calls.appendSessionLines(tx, {
          runId,
          sessionId: 'sess-1',
          fromLine,
          lines: lines.map((text) => ({ text, redactionCount: 0 })),
        }),
      );
    expect(await append(0, ['a', 'b'])).toBe(2);
    expect(await append(1, ['b', 'c'])).toBe(1);
    expect(await inTx((tx) => calls.sessionLineCount(tx, runId))).toBe(3);
  });

  it('ssh signatures: counted under the fence up to the cap; a stale epoch, another worker and a settled offer count nothing', async () => {
    const { w, runId } = await claimed();
    const count = (epoch: number, workerId: Id) =>
      inTx((tx) => calls.countSignature(tx, { runId, epoch, workerId, max: 2 }));
    expect(await count(1, w.w1)).toEqual({ kind: 'counted', signatures: 1 });
    expect(await count(2, w.w1)).toEqual({ kind: 'lost' });
    expect(await count(1, w.w2)).toEqual({ kind: 'lost' });
    expect(await count(1, w.w1)).toEqual({ kind: 'counted', signatures: 2 });
    expect(await count(1, w.w1)).toEqual({ kind: 'cap' });
    // The run's terminal writer closes the offer: from then on, nothing is counted.
    await sql("update run_offers set state = 'settled', settled_at = now() where run_id = $1", [
      runId,
    ]);
    expect(await count(1, w.w1)).toEqual({ kind: 'lost' });
    const [row] = await sql<{ ssh_signatures: number }>(
      'select ssh_signatures from run_offers where run_id = $1',
      [runId],
    );
    expect(row?.ssh_signatures).toBe(2);
  });

  it('ssh signatures: one cap per run however many connections race for it', async () => {
    const { w, runId } = await claimed();
    // Two pools stand for two `ROLE=api` replicas: 40 requests against a cap of 25.
    const replicas = [
      createTestPool(database.connectionString, { max: 4 }),
      createTestPool(database.connectionString, { max: 4 }),
    ];
    try {
      const attempt = async (replica: (typeof replicas)[number]) => {
        const client = await replica.connect();
        try {
          await client.query('begin');
          const answer = await calls.countSignature(
            { adapter: 'postgres', client } as unknown as Transaction,
            { runId, epoch: 1, workerId: w.w1, max: 25 },
          );
          await client.query('commit');
          return answer.kind;
        } catch (error) {
          await client.query('rollback');
          throw error;
        } finally {
          client.release();
        }
      };
      const kinds = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          attempt(replicas[index % 2] as (typeof replicas)[number]),
        ),
      );
      expect(kinds.filter((kind) => kind === 'counted')).toHaveLength(25);
      expect(kinds.filter((kind) => kind === 'cap')).toHaveLength(15);
      const [row] = await sql<{ ssh_signatures: number }>(
        'select ssh_signatures from run_offers where run_id = $1',
        [runId],
      );
      expect(row?.ssh_signatures).toBe(25);
    } finally {
      await Promise.all(replicas.map((replica) => replica.end()));
    }
  });
});

describe('backlog 744: a claim the admission re-check refuses (TD-031 §2)', () => {
  it('is rolled back; the offer withdrawn budget_at_claim, its run cancelled, the task paused, the epoch unchanged', async () => {
    const w = await world();
    const runId = await offered(w);
    const pool = createTestPool(database.connectionString, { max: 4 });
    try {
      const context = (correlationId: Id) => ({
        ids: { next: () => crypto.randomUUID() as Id },
        actor: { kind: 'system' as const, component: 'test' },
        clock: { now: () => NOW },
        correlationId,
        causeEventId: null,
      });
      const blocker: BlockingBudget = {
        id: nextId(),
        scope: 'project',
        window: 'month',
        limitUsd: 10,
        spentUsd: 10,
        pendingUsd: 0,
        heldUsd: 0,
        heldRuns: 0,
        reserveUsd: 0,
        windowStart: PAST,
      } as BlockingBudget;
      let packaged = 0;
      const remote = createRemoteRuns({
        unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
        store,
        context,
        runPlans: createTestRunPlanSealer(),
        packager: {
          build: async () => {
            packaged += 1;
            throw new Error('a refused claim is never packaged');
          },
        },
        credentials: { revoke: async () => {} },
        tokens: {
          mint: () => ({ token: 't', hash: createHash('sha256').update('t').digest('hex') }),
          hashOf: (token) => createHash('sha256').update(token).digest('hex'),
          same: (a, b) => a === b,
        },
        settle: async () => {
          throw new Error('nothing is settled here');
        },
        lateCost: { record: async () => ({ recorded: false, charge: null }) } as never,
        admission: createClaimAdmission({
          store,
          settings: async (projectId) => defaultProjectSettings(projectId),
          budgets: { blockingFor: async () => blocker },
          context,
        }),
      });
      expect(
        await remote.claim({
          workerId: w.w1,
          heldImageDigests: HELD,
          images: { run: RUN_DIGEST, egress: EGRESS_DIGEST },
          now: NOW,
        }),
      ).toEqual({ kind: 'none' });
      expect(packaged).toBe(0);
      const [offer] = await sql<{
        state: string;
        withdrawn_reason: string | null;
        lease_epoch: number;
      }>('select state, withdrawn_reason, lease_epoch from run_offers where run_id = $1', [runId]);
      expect(offer).toEqual({
        state: 'withdrawn',
        withdrawn_reason: 'budget_at_claim',
        lease_epoch: 0,
      });
      const [run] = await sql<{ status: string; lease_epoch: number; worker_id: string | null }>(
        'select status::text as status, lease_epoch, worker_id from runs where id = $1',
        [runId],
      );
      expect(run).toEqual({ status: 'cancelled', lease_epoch: 0, worker_id: null });
      const [taskRow] = await sql<{ state: string }>(
        'select t.state::text as state from tasks t join runs r on r.task_id = t.id where r.id = $1',
        [runId],
      );
      expect(taskRow?.state).toBe('paused');
      const claimed = await sql(
        "select 1 from events where type = 'run.claimed' and payload->>'run_id' = $1",
        [runId],
      );
      expect(claimed).toEqual([]);
      const paused = await sql<{ payload: { budget_scope: string } }>(
        "select payload from events where type = 'task.paused' and payload->>'task_id' = (select task_id::text from runs where id = $1)",
        [runId],
      );
      expect(paused[0]?.payload).toMatchObject({ reason: 'budget', budget_scope: 'project' });
    } finally {
      await pool.end();
    }
  }, 60_000);
});
