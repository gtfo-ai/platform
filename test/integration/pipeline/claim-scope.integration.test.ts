/**
 * **What a worker picks up, against PostgreSQL 18** — WP-293, TD-031's 2026-11-05 claim-scope
 * amendment (decision 8) and Q127 (a).
 *
 * The claim scope (`workers.claim_project_ids`, migration 0101) is a conjunct of the claim's own
 * statement for an **automatic** claim, and a pick (`RemoteClaimant.pick`) is the one claim with its
 * run named and the scope ignored. What only the database can show is held here:
 *
 *  1. **An automatic claim obeys the scope**: `[A]` takes A's offer and leaves B's *older* one, `[]`
 *     takes nothing, `null` takes the oldest.
 *  2. **The scope only narrows**: a scope naming a project whose runs the user may not take, or a
 *     `server_only` project, claims nothing — automatically or by a pick.
 *  3. **A pick ignores the scope and nothing else**: refused before `workers_from` — on a hybrid,
 *     server-preferred project the server's window is never jumped (Q127 (a)) — inside another
 *     user's head start, for an excluded worker, while paused by a usage limit or by its owner; and
 *     admitted outside the scope.
 *  4. **The list is the claim**: `claimable` over one fixture set equals the set a pick admits —
 *     every listed offer claimable, every unlisted open offer refused (each pick rolled back) —
 *     inside the worker's project list, which narrows the list since S-26.4 (a pick ignores it).
 *  5. **One winner**: a pick racing the server claimant and a second worker over one offer — exactly
 *     one claims it, over 200 iterations.
 *  6. **Routing (§5)**: an assignee whose worker is pick-only, or whose scope leaves the project out,
 *     gets no head start (`assignee_until` null); one whose scope takes it does.
 *  7. **The audit**: a pick through `RemoteRuns.claim` leaves one `worker.take_offer` row under the
 *     worker's user, in the claim's transaction; a refused pick leaves none.
 */
import {
  claimRunOffer,
  createRemoteRuns,
  createTestRunPlanSealer,
  INITIAL_TASK_VERSION,
  type PipelineStore,
  type RunOfferClaim,
  routeNewOffer,
  type StoredTask,
  type Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { FEATURE_TEMPLATE, type OfferRouting, SHIPPED_TEMPLATES } from '@platform/domain';
import { eventing, pipeline } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

const NOW = '2026-11-05T09:00:00.000Z' as IsoDateTime;
const PAST = '2026-11-05T08:00:00.000Z' as IsoDateTime;
const LONG_AGO = '2026-11-05T07:00:00.000Z' as IsoDateTime;
const FUTURE = '2099-01-01T00:00:00.000Z' as IsoDateTime;
const RUN_DIGEST = `sha256:${'c'.repeat(64)}`;
const EGRESS_DIGEST = `sha256:${'d'.repeat(64)}`;
const HELD = [RUN_DIGEST, EGRESS_DIGEST];

let database: MigratedDatabase;
let store: PipelineStore;
let orgId: string;
let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${(0x293000 + counter).toString(16).padStart(12, '0')}` as Id;
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
  database = await createMigratedDatabase('claim-scope');
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const [org] = await sql<{ id: string }>(
    "insert into organizations (name) values ('claim-scope') returning id",
  );
  orgId = org?.id as string;
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

/** One connection, one transaction; `commit: false` rolls it back (a claim that is only a probe). */
const inTx = async <T>(work: (tx: Transaction) => Promise<T>, commit = true): Promise<T> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  await client.query('begin');
  try {
    const result = await work({ adapter: 'postgres', client } as unknown as Transaction);
    await client.query(commit ? 'commit' : 'rollback');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
};

const project = async (key: string): Promise<Id> => {
  const [row] = await sql<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, $2, 'Scope', 'https://git.example.test/acme/scope.git') returning id`,
    [orgId, `${key}${counter}x${Date.now() % 100_000}`],
  );
  return row?.id as Id;
};

/**
 * An organisation **viewer** — so a project membership at `member` is what lets them run there
 * (the effective role, backlog 886) — with the memberships named.
 */
const user = async (memberOf: readonly Id[]): Promise<Id> => {
  const [row] = await sql<{ id: string }>(
    "insert into users (email, name, role) values ($1, 'Someone', 'viewer') returning id",
    [`${nextId()}@example.test`],
  );
  for (const projectId of memberOf) {
    await sql("insert into project_members (project_id, user_id, role) values ($1, $2, 'member')", [
      projectId,
      row?.id,
    ]);
  }
  return row?.id as Id;
};

const worker = async (userId: Id, scope: readonly Id[] | null = null): Promise<Id> => {
  const id = nextId();
  await sql(
    `insert into workers (id, user_id, name, credential_hash, last_seen_at, claim_project_ids)
     values ($1, $2, 'laptop', $3, now(), $4::uuid[])`,
    [id, userId, id.replaceAll('-', '').padEnd(64, '0').slice(0, 64), scope],
  );
  return id;
};

const setScope = async (workerId: Id, scope: readonly Id[] | null): Promise<void> => {
  await sql('update workers set claim_project_ids = $2::uuid[] where id = $1', [workerId, scope]);
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
          key: `SCP-${counter}`,
          url: `https://jira.example.test/browse/SCP-${counter}`,
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

/** Open to workers since an hour ago, the server never (`workers_only`). */
const workersRouting = (overrides: Partial<OfferRouting> = {}): OfferRouting => ({
  assigneeUserId: null,
  assigneeUntil: null,
  serverFrom: null,
  workersFrom: PAST,
  expiresAt: FUTURE,
  ...overrides,
});

/** A committed `created` run of `projectId` with an `open` offer, offered at `offeredAt`. */
const offered = async (
  projectId: Id,
  options: {
    readonly routing?: OfferRouting;
    readonly offeredAt?: IsoDateTime;
    readonly excluded?: readonly Id[];
  } = {},
): Promise<Id> => {
  const taskId = await task(projectId);
  const runId = nextId();
  await inTx(async (tx) => {
    await store.runs.insert(tx, {
      id: runId,
      taskId,
      projectId,
      stage: 'implementation' as Slug,
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
      projectId,
      stage: 'implementation' as Slug,
      attempt: 1,
      kind: 'stage',
      offeredAt: options.offeredAt ?? NOW,
      routing: options.routing ?? workersRouting(),
      ...(options.excluded === undefined ? {} : { excludedWorkerIds: options.excluded }),
    });
  });
  return runId;
};

const workerClaim = (
  workerId: Id,
  options: { readonly runId?: Id; readonly pick?: boolean } = {},
): RunOfferClaim => ({
  eligibility: options.runId === undefined ? {} : { runId: options.runId },
  claimantKind: 'worker',
  owner: `worker:${workerId}`,
  expiresAt: '2026-11-05T09:10:00.000Z' as IsoDateTime,
  now: NOW,
  worker: {
    workerId,
    heldImageDigests: HELD,
    images: { run: RUN_DIGEST, egress: EGRESS_DIGEST },
    runTokenHash: 'e'.repeat(64),
    ...(options.pick === true ? { pick: true } : {}),
  },
});

/** An automatic claim (`eligibility: {}`): the oldest offer the worker's eligibility and scope admit. */
const automatic = async (workerId: Id) =>
  (await inTx(async (tx) => claimRunOffer(store.offers, tx, workerClaim(workerId))))?.runId ?? null;

/** A pick of `runId`; `commit: false` probes it and rolls it back. */
const pick = async (workerId: Id, runId: Id, commit = true) =>
  (
    await inTx(
      async (tx) => claimRunOffer(store.offers, tx, workerClaim(workerId, { runId, pick: true })),
      commit,
    )
  )?.runId ?? null;

const listed = async (workerId: Id) =>
  inTx(async (tx) =>
    store.offers.claimable(tx, {
      worker: {
        workerId,
        heldImageDigests: HELD,
        images: { run: RUN_DIGEST, egress: EGRESS_DIGEST },
      },
      now: NOW,
      limit: 50,
    }),
  );

const offerState = async (runId: Id) =>
  (await sql<{ state: string }>('select state from run_offers where run_id = $1', [runId]))[0]
    ?.state;

describe('an automatic claim obeys the worker’s claim scope (WP-293)', () => {
  it('[A] takes A’s offer and leaves B’s older one; null then takes B', async () => {
    const a = await project('a');
    const b = await project('b');
    const alice = await user([a, b]);
    const olderB = await offered(b, { offeredAt: LONG_AGO });
    const newerA = await offered(a, { offeredAt: PAST });
    const w = await worker(alice, [a]);
    expect(await automatic(w)).toBe(newerA);
    expect(await offerState(olderB)).toBe('open');
    // A scope of every project takes the older one (the positive control for B's refusal).
    await setScope(w, null);
    expect(await automatic(w)).toBe(olderB);
  });

  it('[] (pick only) takes nothing automatically, and a pick takes the same offer', async () => {
    const a = await project('p');
    const alice = await user([a]);
    const runId = await offered(a);
    const w = await worker(alice, []);
    expect(await automatic(w)).toBeNull();
    expect(await offerState(runId)).toBe('open');
    expect(await pick(w, runId)).toBe(runId);
    expect(await offerState(runId)).toBe('claimed');
  });

  it('only narrows: a scope naming a project the user may not run, or a server_only one, claims nothing', async () => {
    const mine = await project('m');
    const theirs = await project('t');
    const serverOnly = await project('s');
    const alice = await user([mine, serverOnly]);
    const foreign = await offered(theirs);
    const server = await offered(serverOnly, {
      routing: workersRouting({ workersFrom: null, serverFrom: PAST }),
    });
    const w = await worker(alice, [theirs, serverOnly]);
    expect(await automatic(w)).toBeNull();
    expect(await pick(w, foreign)).toBeNull();
    expect(await pick(w, server)).toBeNull();
    expect(await listed(w)).toEqual([]);
    expect(await offerState(foreign)).toBe('open');
    expect(await offerState(server)).toBe('open');
  });
});

describe('a pick ignores the scope and nothing else (WP-293, Q127 (a))', () => {
  it('admits an offer outside the scope', async () => {
    const a = await project('o');
    const b = await project('i');
    const alice = await user([a, b]);
    const outside = await offered(b);
    const w = await worker(alice, [a]);
    expect(await automatic(w)).toBeNull();
    expect(await pick(w, outside)).toBe(outside);
  });

  const refusals: readonly [
    string,
    (ctx: { projectId: Id; alice: Id; bob: Id; worker: Id }) => Promise<Id>,
  ][] = [
    [
      'before workers_from',
      async ({ projectId }) =>
        offered(projectId, { routing: workersRouting({ workersFrom: FUTURE }) }),
    ],
    [
      'inside a hybrid, server-preferred project’s server window (Q127 (a))',
      async ({ projectId }) =>
        offered(projectId, {
          routing: workersRouting({ serverFrom: PAST, workersFrom: FUTURE }),
        }),
    ],
    [
      'inside another user’s head start',
      async ({ projectId, bob }) =>
        offered(projectId, {
          routing: workersRouting({
            assigneeUserId: bob,
            assigneeUntil: FUTURE,
            workersFrom: FUTURE,
          }),
        }),
    ],
    [
      'for an excluded worker',
      async ({ projectId, worker: excluded }) => offered(projectId, { excluded: [excluded] }),
    ],
    [
      'while paused by a usage limit',
      async ({ projectId, worker: paused }) => {
        await sql(
          "update workers set paused_until = $2, paused_reason = 'usage_limited' where id = $1",
          [paused, FUTURE],
        );
        return offered(projectId);
      },
    ],
    [
      'while paused by its owner',
      async ({ projectId, worker: held }) => {
        await sql('update workers set manually_paused_at = now() where id = $1', [held]);
        return offered(projectId);
      },
    ],
  ];

  it.each(refusals)('is refused %s — and not listed', async (_name, arrange) => {
    const projectId = await project('r');
    const alice = await user([projectId]);
    const bob = await user([projectId]);
    // Pick only: the scope cannot be what refuses, so the refusal is the eligibility's.
    const w = await worker(alice, []);
    const runId = await arrange({ projectId, alice, bob, worker: w });
    expect(await listed(w)).toEqual([]);
    expect(await pick(w, runId)).toBeNull();
    expect(await offerState(runId)).toBe('open');
  });

  it('inside the worker’s own user’s head start, admits it (the positive control)', async () => {
    const projectId = await project('h');
    const alice = await user([projectId]);
    const w = await worker(alice, []);
    const runId = await offered(projectId, {
      routing: workersRouting({
        assigneeUserId: alice,
        assigneeUntil: FUTURE,
        workersFrom: FUTURE,
      }),
    });
    expect((await listed(w)).map((offer) => offer.runId)).toEqual([runId]);
    expect(await pick(w, runId)).toBe(runId);
  });
});

describe('the list is the claim (WP-293, the claim-scope amendment §4)', () => {
  it('lists exactly what a pick admits over one fixture set, oldest first, with what the scope takes', async () => {
    const a = await project('la');
    const b = await project('lb');
    const elsewhere = await project('lx');
    const alice = await user([a, b]);
    const bob = await user([a]);
    const w = await worker(alice, [a]);
    const fixtures: Id[] = [
      await offered(a, { offeredAt: '2026-11-05T08:10:00.000Z' as IsoDateTime }),
      await offered(b, { offeredAt: '2026-11-05T08:05:00.000Z' as IsoDateTime }),
      await offered(a, { routing: workersRouting({ workersFrom: FUTURE }) }),
      await offered(a, {
        routing: workersRouting({ serverFrom: PAST, workersFrom: FUTURE }),
      }),
      await offered(a, {
        routing: workersRouting({
          assigneeUserId: bob,
          assigneeUntil: FUTURE,
          workersFrom: FUTURE,
        }),
      }),
      await offered(a, { excluded: [w] }),
      await offered(elsewhere),
      await offered(b, {
        routing: workersRouting({ workersFrom: null, serverFrom: PAST }),
      }),
    ];
    // S-26.4 (TD-031's 2026-11-06 amendment item 7): the list is narrowed by the project list,
    // and the pick still ignores it — so inside the scope the list is the claim, and B's offer is
    // admitted by a pick without being listed.
    const list = await listed(w);
    expect(list.map((offer) => offer.runId)).toEqual([fixtures[0]]);
    expect(list.map((offer) => offer.automatic)).toEqual([true]);
    expect(list[0]).toMatchObject({ kind: 'stage', stage: 'implementation', role: 'developer' });
    const admitted: Id[] = [];
    for (const runId of fixtures) {
      if ((await pick(w, runId, false)) !== null) admitted.push(runId);
    }
    expect(new Set(admitted)).toEqual(new Set([fixtures[0], fixtures[1]]));
    // Every project: the list and the pick agree over the whole fixture set.
    await setScope(w, null);
    const everyProject = await listed(w);
    expect(everyProject.map((offer) => offer.runId)).toEqual([fixtures[1], fixtures[0]]);
    expect(new Set(admitted)).toEqual(new Set(everyProject.map((offer) => offer.runId)));
    // Probes only: every fixture is still open.
    for (const runId of fixtures) expect(await offerState(runId)).toBe('open');
  });
});

describe('one winner when a pick races the server and another worker (WP-293)', () => {
  it('claims each offer exactly once over 200 iterations', async () => {
    const projectId = await project('race');
    const alice = await user([projectId]);
    const bob = await user([projectId]);
    const picker = await worker(alice, []);
    const other = await worker(bob, null);
    const pool = createTestPool(database.connectionString, { max: 6 });
    const claimOn = async (claim: RunOfferClaim) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const won = await claimRunOffer(
          store.offers,
          { adapter: 'postgres', client } as unknown as Transaction,
          claim,
        );
        await client.query('commit');
        return won === null ? null : claim.claimantKind === 'server' ? 'server' : claim.owner;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    };
    const tally = new Map<string, number>();
    try {
      for (let iteration = 0; iteration < 200; iteration += 1) {
        // Open to both sides: the server's window and the workers' have both begun.
        const runId = await offered(projectId, {
          routing: workersRouting({ serverFrom: PAST, workersFrom: PAST }),
        });
        const winners = (
          await Promise.all([
            claimOn(workerClaim(picker, { runId, pick: true })),
            claimOn({
              eligibility: { runId },
              claimantKind: 'server',
              owner: 'server:race',
              expiresAt: '2026-11-05T09:10:00.000Z' as IsoDateTime,
              now: NOW,
            }),
            claimOn(workerClaim(other, { runId })),
          ])
        ).filter((winner): winner is string => winner !== null);
        expect(winners).toHaveLength(1);
        const [row] = await sql<{ state: string; lease_epoch: number }>(
          'select state, lease_epoch from run_offers where run_id = $1',
          [runId],
        );
        expect(row).toEqual({ state: 'claimed', lease_epoch: 1 });
        tally.set(winners[0] as string, (tally.get(winners[0] as string) ?? 0) + 1);
      }
    } finally {
      await pool.end();
    }
    expect([...tally.values()].reduce((sum, n) => sum + n, 0)).toBe(200);
  }, 240_000);
});

describe('routing: the online assignee’s scope must take the project (the claim-scope amendment §5)', () => {
  const routeFor = async (projectId: Id, assignee: Id) =>
    inTx(async (tx) =>
      routeNewOffer(pipeline.createPostgresExecutionRoutingRepository(), tx, {
        projectId,
        assigneeUserId: assignee,
        now: new Date().toISOString() as IsoDateTime,
      }),
    );

  it('gives no head start to a pick-only or out-of-scope worker, and one to a worker whose scope takes it', async () => {
    const projectId = await project('route');
    const other = await project('other');
    const alice = await user([projectId, other]);
    const w = await worker(alice, []);
    expect((await routeFor(projectId, alice)).assigneeUntil).toBeNull();
    await setScope(w, [other]);
    expect((await routeFor(projectId, alice)).assigneeUntil).toBeNull();
    await setScope(w, [projectId]);
    expect((await routeFor(projectId, alice)).assigneeUntil).not.toBeNull();
    await setScope(w, null);
    expect((await routeFor(projectId, alice)).assigneeUntil).not.toBeNull();
  });
});

describe('the audit of a pick (WP-293)', () => {
  it('writes one worker.take_offer row under the worker’s user in the claim’s transaction, none for a refused pick', async () => {
    const projectId = await project('audit');
    const alice = await user([projectId]);
    const w = await worker(alice, []);
    const runId = await offered(projectId);
    const refusedRun = await offered(projectId, {
      routing: workersRouting({ workersFrom: FUTURE }),
    });
    const pool = createTestPool(database.connectionString, { max: 4 });
    try {
      const context = (correlationId: Id) => ({
        ids: { next: () => crypto.randomUUID() as Id },
        actor: { kind: 'system' as const, component: 'test' },
        clock: { now: () => NOW },
        correlationId,
        causeEventId: null,
      });
      let settled = 0;
      const remote = createRemoteRuns({
        unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
        store,
        context,
        runPlans: createTestRunPlanSealer(),
        packager: {
          build: async () => {
            throw new Error('this test packages nothing: the claim and its audit are the subject');
          },
        },
        credentials: { revoke: async () => {} },
        tokens: {
          mint: () => ({ token: 't', hash: 'a'.repeat(64) }),
          hashOf: () => 'a'.repeat(64),
          same: (left, right) => left === right,
        },
        settle: async () => {
          settled += 1;
          throw new Error('nothing is settled here');
        },
        lateCost: { record: async () => ({ recorded: false, charge: null }) } as never,
        takeAudit: pipeline.createPostgresWorkerTakeAudit(),
      });
      const claimInput = (pickRun: Id) => ({
        workerId: w,
        heldImageDigests: HELD,
        images: { run: RUN_DIGEST, egress: EGRESS_DIGEST },
        now: NOW,
        pick: pickRun,
      });
      expect(await remote.claim(claimInput(refusedRun))).toEqual({ kind: 'none' });
      expect(await remote.claim(claimInput(runId))).toEqual({ kind: 'not_packaged', runId });
      expect(settled).toBe(1);
      const rows = await sql<{ user_id: string; task_id: string; params: unknown }>(
        "select user_id, task_id, params from human_actions where action = 'worker.take_offer'",
      );
      const [offer] = await sql<{ task_id: string }>(
        'select task_id from run_offers where run_id = $1',
        [runId],
      );
      expect(rows).toEqual([
        {
          user_id: alice,
          task_id: offer?.task_id,
          params: { worker_id: w, run_id: runId, via: 'worker_ui' },
        },
      ]);
    } finally {
      await pool.end();
    }
  });
});
