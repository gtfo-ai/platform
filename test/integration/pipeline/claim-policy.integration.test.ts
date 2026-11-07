/**
 * **What a person's machine takes, against PostgreSQL 18** — S-26.4, TD-031's 2026-11-06
 * amendment items 6–7 (BD-032's 2026-11-06 amendment 2–3).
 *
 * The claim policy (`workers.claim_policy`, migration 0108) is a conjunct of the claim's **own
 * statement** for an automatic claim (`workerPolicyTakesSql`), and a pick assigns in the claim's
 * transaction. What only the database can show is held here:
 *
 *  1. **The matrix**: an automatic claim's answer for each policy × task case — mine, another's,
 *     unowned, released by a linked member (owner `null`, still theirs in the tracker: unassigned),
 *     held by an unlinked person, held by a non-member, an ask I asked, an ask another person asked —
 *     equal to the domain's `claimPolicyTakes`, cell by cell; **no policy admits what the
 *     eligibility refuses**; **a reassignment applies to an open offer** (the owner read live); and
 *     the *held elsewhere* the claim reads is the one fragment (`taskHeldElsewhereSql`) the pick, the
 *     owner command and S-26.5 read.
 *  2. **Legacy rows**: a `null` policy reads `pick_only` over `'{}'` and `everything` otherwise, and
 *     a legacy `'{}'` narrows no project once the policy says something else.
 *  3. **Routing**: the online assignee is the owner only when the owner's worker policy is not
 *     `pick_only` and its scope takes the project; a reassignment leaves the open offer's head start
 *     with the previous owner, whose `mine` machine still cannot claim it.
 *  4. **Picks through `RemoteRuns.claim`**: an unassigned stage offer becomes the picker's (`via:
 *     pick`, one `task.owner` row beside `worker.take_offer`, in the claim's transaction); a task held
 *     by an unlinked person or a non-member is claimed without assigning; another person's task is
 *     refused by the pick's `as_of`; an ask assigns nothing.
 *  5. **The list and the count**: `claimable` is narrowed by the project list (`'{}'` narrows
 *     nothing), names the owner and `mine`; `policy_skipped_offers` counts what the policy leaves.
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
import type { Id, IsoDateTime, Slug, WorkerClaimPolicy } from '@platform/contracts';
import { WORKER_CLAIM_POLICIES } from '@platform/contracts';
import {
  claimPolicyTakes,
  FEATURE_TEMPLATE,
  type OfferRouting,
  SHIPPED_TEMPLATES,
} from '@platform/domain';
import { eventing, pipeline } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import { createPostgresWorkerStore } from '../../../apps/server/src/queries/worker-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

const NOW = '2026-11-07T09:00:00.000Z' as IsoDateTime;
const PAST = '2026-11-07T08:00:00.000Z' as IsoDateTime;
const FUTURE = '2099-01-01T00:00:00.000Z' as IsoDateTime;
const RUN_DIGEST = `sha256:${'c'.repeat(64)}`;
const EGRESS_DIGEST = `sha256:${'d'.repeat(64)}`;
const HELD = [RUN_DIGEST, EGRESS_DIGEST];
const PROVIDER = 'jira-cloud';

let database: MigratedDatabase;
let store: PipelineStore;
let orgId: string;
let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${(0x264000 + counter).toString(16).padStart(12, '0')}` as Id;
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
  database = await createMigratedDatabase('claim-policy');
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const [org] = await sql<{ id: string }>(
    "insert into organizations (name) values ('claim-policy') returning id",
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
     values ($1, $2, 'Policy', 'https://git.example.test/acme/policy.git') returning id`,
    [orgId, `${key}${counter}x${Date.now() % 100_000}`],
  );
  return row?.id as Id;
};

/** An organisation **viewer** with a `member` membership in each project named. */
const user = async (memberOf: readonly Id[], name = 'Someone'): Promise<Id> => {
  const [row] = await sql<{ id: string }>(
    "insert into users (email, name, role) values ($1, $2, 'viewer') returning id",
    [`${nextId()}@example.test`, name],
  );
  for (const projectId of memberOf) {
    await sql("insert into project_members (project_id, user_id, role) values ($1, $2, 'member')", [
      projectId,
      row?.id,
    ]);
  }
  return row?.id as Id;
};

/** A tracker identity linked to `userId` (a `person`), or `null` for an unlinked account. */
const identity = async (userId: Id | null): Promise<string> => {
  const externalId = `acct-${nextId()}`;
  if (userId !== null) {
    await sql(
      "insert into user_identities (provider, external_id, user_id, kind) values ($1, $2, $3, 'person')",
      [PROVIDER, externalId, userId],
    );
  }
  return externalId;
};

const worker = async (
  userId: Id,
  options: {
    readonly policy?: WorkerClaimPolicy | null;
    readonly scope?: readonly Id[] | null;
  } = {},
): Promise<Id> => {
  const id = nextId();
  await sql(
    `insert into workers (id, user_id, name, credential_hash, last_seen_at, claim_project_ids,
                          claim_policy)
     values ($1, $2, 'laptop', $3, now(), $4::uuid[], $5)`,
    [
      id,
      userId,
      id.replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      options.scope ?? null,
      options.policy === undefined ? 'everything' : options.policy,
    ],
  );
  return id;
};

const setPolicy = async (workerId: Id, policy: WorkerClaimPolicy | null): Promise<void> => {
  await sql('update workers set claim_policy = $2 where id = $1', [workerId, policy]);
};

const task = async (projectId: Id): Promise<Id> => {
  const taskId = nextId();
  await inTx(async (tx) =>
    store.tasks.insert(tx, {
      task: {
        id: taskId,
        projectId,
        ticket: {
          provider: PROVIDER,
          key: `POL-${counter}`,
          url: `https://jira.example.test/browse/POL-${counter}`,
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

/** The task's owner and stored tracker assignee, written as `saveOwner` leaves them. */
const own = async (
  taskId: Id,
  owner: Id | null,
  assignee: { readonly externalId: string; readonly platform?: boolean } | null = null,
  changedAt: IsoDateTime = PAST,
): Promise<void> => {
  // Through the one owner writer (`saveOwner`), never a statement of this file's own: the
  // column-ownership census reads every statement that writes the table, tests included.
  const written = await inTx(async (tx) => {
    const current = await store.tasks.ownership(tx, taskId);
    return store.tasks.saveOwner(tx, taskId, {
      expected: { ownerUserId: current.ownerUserId, ticketAssignee: current.ticketAssignee },
      next: {
        ownerUserId: owner,
        ownerSource: owner === null ? null : 'platform',
        ownerChangedAt: owner === null ? null : changedAt,
        ticketAssignee:
          assignee === null
            ? null
            : {
                provider: PROVIDER,
                external_id: assignee.externalId,
                display_name: 'Assignee',
                platform: assignee.platform ?? false,
              },
      },
    });
  });
  expect(written).toBe(true);
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

/** A committed `created` run of `taskId` with an `open` offer; an ask's names its asker. */
const offered = async (
  projectId: Id,
  taskId: Id,
  options: {
    readonly routing?: OfferRouting;
    readonly askedBy?: Id;
  } = {},
): Promise<Id> => {
  const runId = nextId();
  const kind = options.askedBy === undefined ? 'stage' : 'ask';
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
      kind,
      offeredAt: NOW,
      routing:
        options.routing ??
        (options.askedBy === undefined
          ? workersRouting()
          : workersRouting({ assigneeUserId: options.askedBy })),
    });
  });
  if (options.askedBy !== undefined) {
    const [ask] = await sql<{ id: string }>(
      `insert into task_asks (task_id, project_id, source, asked_by_user_id, question, run_id)
       values ($1, $2, 'ui', $3, 'which module sums the footer?', $4) returning id`,
      [taskId, projectId, options.askedBy, runId],
    );
    await sql('update runs set ask_id = $2 where id = $1', [runId, ask?.id]);
  }
  return runId;
};

const workerClaim = (
  workerId: Id,
  options: { readonly runId?: Id; readonly pick?: boolean; readonly now?: IsoDateTime } = {},
): RunOfferClaim => ({
  eligibility: options.runId === undefined ? {} : { runId: options.runId },
  claimantKind: 'worker',
  owner: `worker:${workerId}`,
  expiresAt: '2026-11-07T09:10:00.000Z' as IsoDateTime,
  now: options.now ?? NOW,
  worker: {
    workerId,
    heldImageDigests: HELD,
    images: { run: RUN_DIGEST, egress: EGRESS_DIGEST },
    runTokenHash: 'e'.repeat(64),
    ...(options.pick === true ? { pick: true } : {}),
  },
});

/** An automatic claim narrowed to `runId`, probed and rolled back unless `commit`. */
const automatic = async (workerId: Id, runId: Id, commit = false, now?: IsoDateTime) =>
  (
    await inTx(
      async (tx) =>
        claimRunOffer(
          store.offers,
          tx,
          workerClaim(workerId, { runId, ...(now === undefined ? {} : { now }) }),
        ),
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

/** The one *held elsewhere* fragment, asked of a task row by itself (the owner command's read). */
const heldElsewhere = async (taskId: Id): Promise<boolean> => {
  const [row] = await sql<{ held: boolean }>(
    `select ${pipeline.taskHeldElsewhereSql('t')} as held from tasks t where t.id = $1`,
    [taskId],
  );
  return row?.held === true;
};

/** The eight task cases of criterion 1, each with what the domain's matrix asks of it. */
type TaskCase =
  | 'mine'
  | 'another’s'
  | 'unowned'
  | 'released by a linked member'
  | 'held by an unlinked person'
  | 'held by a non-member'
  | 'an ask I asked'
  | 'an ask another person asked';

const CASE_FACTS: Readonly<Record<TaskCase, { mine: boolean; unassigned: boolean }>> = {
  mine: { mine: true, unassigned: false },
  'another’s': { mine: false, unassigned: false },
  unowned: { mine: false, unassigned: true },
  'released by a linked member': { mine: false, unassigned: true },
  'held by an unlinked person': { mine: false, unassigned: false },
  'held by a non-member': { mine: false, unassigned: false },
  'an ask I asked': { mine: true, unassigned: false },
  'an ask another person asked': { mine: false, unassigned: false },
};

/** One fixture: a project, the worker's user ("me") and another member, and the case's offer. */
const arrange = async (
  c: TaskCase,
): Promise<{ projectId: Id; me: Id; other: Id; taskId: Id; runId: Id }> => {
  const projectId = await project('m');
  const me = await user([projectId], 'Me');
  const other = await user([projectId], 'Other');
  const taskId = await task(projectId);
  switch (c) {
    case 'mine':
      await own(taskId, me);
      break;
    case 'another’s':
      await own(taskId, other);
      break;
    case 'unowned':
      break;
    case 'released by a linked member':
      // Owner null, the ticket still the member's in the tracker.
      await own(taskId, null, { externalId: await identity(other) });
      break;
    case 'held by an unlinked person':
      await own(taskId, null, { externalId: await identity(null) });
      break;
    case 'held by a non-member': {
      const outsider = await user([], 'Outsider');
      await own(taskId, null, { externalId: await identity(outsider) });
      break;
    }
    case 'an ask I asked':
    case 'an ask another person asked':
      // The task is somebody else's: an ask's "mine" is its asker, never the task's owner.
      await own(taskId, c === 'an ask I asked' ? other : me);
      break;
  }
  const askedBy = c === 'an ask I asked' ? me : c === 'an ask another person asked' ? other : null;
  const runId = await offered(projectId, taskId, askedBy === null ? {} : { askedBy });
  return { projectId, me, other, taskId, runId };
};

describe('the policy × task matrix of an automatic claim (S-26.4, criterion 1)', () => {
  const CASES = Object.keys(CASE_FACTS) as TaskCase[];
  const CELLS = CASES.flatMap((c) => WORKER_CLAIM_POLICIES.map((policy) => [c, policy] as const));

  it.each(CELLS)('%s under %s: the claim answers the domain’s matrix', async (c, policy) => {
    const { me, runId } = await arrange(c);
    const w = await worker(me, { policy });
    const expected = claimPolicyTakes(policy, CASE_FACTS[c]);
    expect(await automatic(w, runId)).toBe(expected ? runId : null);
    // The list says the same, and a pick ignores the policy (another's stage task aside).
    const entry = (await listed(w)).find((offer) => offer.runId === runId);
    expect(entry?.automatic).toBe(expected);
    expect(entry?.mine).toBe(CASE_FACTS[c].mine);
  });

  it('covers every case of the slice and every policy', () => {
    expect(CELLS).toHaveLength(8 * 4);
  });

  it.each(WORKER_CLAIM_POLICIES)('%s admits nothing the eligibility refuses', async (policy) => {
    const projectId = await project('e');
    const me = await user([projectId]);
    const outsider = await user([]);
    const taskId = await task(projectId);
    await own(taskId, me);
    // Before `workers_from`, a member's own task: refused whatever the policy.
    const early = await offered(projectId, taskId, {
      routing: workersRouting({ workersFrom: FUTURE }),
    });
    expect(await automatic(await worker(me, { policy }), early)).toBeNull();
    // A user who may not run in the project, owning nothing there: refused whatever the policy.
    const otherTask = await task(projectId);
    await own(otherTask, null);
    const open = await offered(projectId, otherTask);
    expect(await automatic(await worker(outsider, { policy }), open)).toBeNull();
  });

  it('a reassignment applies to an open offer at once: the owner is read live', async () => {
    const { me, other, taskId, runId } = await arrange('another’s');
    const w = await worker(me, { policy: 'mine' });
    expect(await automatic(w, runId)).toBeNull();
    await own(taskId, me);
    expect(await automatic(w, runId)).toBe(runId);
    await own(taskId, other);
    expect(await automatic(w, runId)).toBeNull();
  });

  it('reads held elsewhere through the one fragment the pick, the owner command and S-26.5 read', async () => {
    // Textually: the claim's *unassigned* is built of `taskHeldElsewhereSql` itself.
    expect(pipeline.offerIsUnassignedSql).toContain(pipeline.taskHeldElsewhereSql('ut'));
    // And by its answer: for each ownerless case, unassigned ⇔ not held elsewhere.
    for (const c of [
      'unowned',
      'released by a linked member',
      'held by an unlinked person',
      'held by a non-member',
    ] as const) {
      const { me, taskId, runId } = await arrange(c);
      const w = await worker(me, { policy: 'mine_and_unassigned' });
      expect(`${c}: ${await automatic(w, runId)}`).toBe(
        `${c}: ${(await heldElsewhere(taskId)) ? null : runId}`,
      );
    }
  });
});

describe('legacy rows keep their meaning (S-26.4, criterion 2)', () => {
  it('a null policy reads pick_only over {} and everything otherwise; {} narrows no project', async () => {
    const a = await project('la');
    const b = await project('lb');
    const me = await user([a, b]);
    const other = await user([a, b]);
    const taskA = await task(a);
    await own(taskA, other);
    const runA = await offered(a, taskA);
    const legacyPickOnly = await worker(me, { policy: null, scope: [] });
    const legacyEverything = await worker(me, { policy: null, scope: null });
    expect(await automatic(legacyPickOnly, runA)).toBeNull();
    expect(await automatic(legacyEverything, runA)).toBe(runA);
    // `{}` with a policy of its own narrows nothing: every project is listed and taken.
    await setPolicy(legacyPickOnly, 'everything');
    expect(await automatic(legacyPickOnly, runA)).toBe(runA);
    const taskB = await task(b);
    const runB = await offered(b, taskB);
    const runs = (await listed(legacyPickOnly)).map((offer) => offer.runId);
    expect(runs).toEqual(expect.arrayContaining([runA, runB]));
    // A scope naming A narrows the list to A — what `GET offers` shows (criterion 5).
    await sql('update workers set claim_project_ids = array[$2::uuid] where id = $1', [
      legacyPickOnly,
      a,
    ]);
    const narrowed = (await listed(legacyPickOnly)).map((offer) => offer.runId);
    expect(narrowed).toContain(runA);
    expect(narrowed).not.toContain(runB);
  });

  it('the worker store reads the stored policy, and a new worker is written mine_and_unassigned', async () => {
    const pool = createTestPool(database.connectionString, { max: 2 });
    try {
      const workers = createPostgresWorkerStore(drizzle(pool) as unknown as Database);
      const me = await user([]);
      const legacy = await worker(me, { policy: null, scope: [] });
      const stored = await worker(me, { policy: 'mine' });
      const rows = await workers.listWorkers(me);
      expect(rows.find((row) => row.id === legacy)?.claimPolicy).toBe('pick_only');
      expect(rows.find((row) => row.id === stored)?.claimPolicy).toBe('mine');
      // The legacy `[]` stays as stored until its owner writes: a write never stores `{}`.
      expect(
        await workers.setClaimScope({ workerId: legacy, projectIds: [], policy: 'pick_only' }),
      ).toEqual({ status: 'empty_scope' });
      // A repeat of what the legacy row reads as writes nothing.
      expect(
        await workers.setClaimScope({ workerId: legacy, projectIds: null, policy: 'pick_only' }),
      ).toMatchObject({ status: 'set', claimPolicy: 'pick_only', performed: false });
    } finally {
      await pool.end();
    }
  });
});

describe('routing: the owner’s head start and the policy (S-26.4, criterion 3)', () => {
  const routeFor = async (projectId: Id, assignee: Id) =>
    inTx(async (tx) =>
      routeNewOffer(pipeline.createPostgresExecutionRoutingRepository(), tx, {
        projectId,
        assigneeUserId: assignee,
        now: new Date().toISOString() as IsoDateTime,
      }),
    );

  it('holds a head start for the owner only when their machine’s policy is not pick_only and its scope takes the project', async () => {
    const projectId = await project('r');
    const elsewhere = await project('re');
    const owner = await user([projectId, elsewhere]);
    const w = await worker(owner, { policy: 'pick_only' });
    expect((await routeFor(projectId, owner)).assigneeUntil).toBeNull();
    await setPolicy(w, 'mine');
    expect((await routeFor(projectId, owner)).assigneeUntil).not.toBeNull();
    await sql('update workers set claim_project_ids = array[$2::uuid] where id = $1', [
      w,
      elsewhere,
    ]);
    expect((await routeFor(projectId, owner)).assigneeUntil).toBeNull();
    // A legacy pick-only row (null policy over `{}`) holds nothing either.
    await sql("update workers set claim_project_ids = '{}', claim_policy = null where id = $1", [
      w,
    ]);
    expect((await routeFor(projectId, owner)).assigneeUntil).toBeNull();
    await setPolicy(w, 'mine_and_unassigned');
    expect((await routeFor(projectId, owner)).assigneeUntil).not.toBeNull();
  });

  it('a reassignment leaves the open offer’s head start with the previous owner, whose mine machine still cannot claim it', async () => {
    const projectId = await project('ra');
    const previous = await user([projectId]);
    const next = await user([projectId]);
    const taskId = await task(projectId);
    await own(taskId, previous);
    // The offer as routing wrote it for the previous owner: their window, the pool after it.
    const runId = await offered(projectId, taskId, {
      routing: workersRouting({
        assigneeUserId: previous,
        assigneeUntil: FUTURE,
        workersFrom: FUTURE,
      }),
    });
    await own(taskId, next, null, NOW);
    const [offer] = await sql<{ assignee_user_id: string }>(
      'select assignee_user_id from run_offers where run_id = $1',
      [runId],
    );
    expect(offer?.assignee_user_id).toBe(previous);
    // The previous owner's `mine` machine: the window is theirs, the task is not — refused.
    expect(await automatic(await worker(previous, { policy: 'mine' }), runId)).toBeNull();
    // The new owner's `mine` machine waits out the window (`workers_from` ahead).
    expect(await automatic(await worker(next, { policy: 'mine' }), runId)).toBeNull();
    // Inside the window the previous owner's machine claims only what its policy admits.
    expect(await automatic(await worker(previous, { policy: 'everything' }), runId)).toBe(runId);
  });
});

describe('picks through RemoteRuns.claim (S-26.4, criterion 4)', () => {
  const withRemote = async <T>(
    work: (remote: ReturnType<typeof createRemoteRuns>) => Promise<T>,
  ): Promise<T> => {
    const pool = createTestPool(database.connectionString, { max: 4 });
    try {
      const context = (correlationId: Id) => ({
        ids: { next: () => crypto.randomUUID() as Id },
        actor: { kind: 'system' as const, component: 'test' },
        clock: { now: () => NOW },
        correlationId,
        causeEventId: null,
      });
      const remote = createRemoteRuns({
        unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
        store,
        context,
        runPlans: createTestRunPlanSealer(),
        packager: {
          build: async () => {
            throw new Error('this test packages nothing: the claim and its owner are the subject');
          },
        },
        credentials: { revoke: async () => {} },
        tokens: {
          mint: () => ({ token: 't', hash: 'a'.repeat(64) }),
          hashOf: () => 'a'.repeat(64),
          same: (left, right) => left === right,
        },
        settle: async () => {
          throw new Error('nothing is settled here');
        },
        lateCost: { record: async () => ({ recorded: false, charge: null }) } as never,
        takeAudit: pipeline.createPostgresWorkerTakeAudit(),
      });
      return await work(remote);
    } finally {
      await pool.end();
    }
  };
  const pickInput = (workerId: Id, runId: Id, asOf?: IsoDateTime) => ({
    workerId,
    heldImageDigests: HELD,
    images: { run: RUN_DIGEST, egress: EGRESS_DIGEST },
    now: NOW,
    pick: runId,
    ...(asOf === undefined ? {} : { asOf }),
  });
  const ownership = async (taskId: Id) =>
    (
      await sql<{ owner_user_id: string | null; owner_source: string | null }>(
        'select owner_user_id, owner_source from tasks where id = $1',
        [taskId],
      )
    )[0];
  const actions = async (taskId: Id) =>
    sql<{ action: string; user_id: string; params: Record<string, unknown> }>(
      `select action, user_id, params from human_actions
        where task_id = $1 and action in ('worker.take_offer', 'task.owner') order by action`,
      [taskId],
    );
  const ownerEvents = async (taskId: Id) =>
    sql<{ payload: Record<string, unknown> }>(
      "select payload from events where stream_id = $1 and type = 'task.owner.changed'",
      [taskId],
    );

  it('makes the picker the owner of an unassigned stage offer in the claim’s transaction — via pick, one task.owner row', async () => {
    const { me, taskId, runId } = await arrange('unowned');
    const w = await worker(me, { policy: 'pick_only' });
    expect(await withRemote((remote) => remote.claim(pickInput(w, runId)))).toEqual({
      kind: 'not_packaged',
      runId,
    });
    expect(await ownership(taskId)).toEqual({ owner_user_id: me, owner_source: 'platform' });
    expect(await actions(taskId)).toEqual([
      {
        action: 'task.owner',
        user_id: me,
        params: {
          user_id: me,
          via: 'pick',
          worker_id: w,
          run_id: runId,
          changed: true,
          owner_user_id: me,
        },
      },
      {
        action: 'worker.take_offer',
        user_id: me,
        params: { worker_id: w, run_id: runId, via: 'worker_ui' },
      },
    ]);
    expect((await ownerEvents(taskId)).map((event) => event.payload)).toEqual([
      expect.objectContaining({ owner_user_id: me, previous_owner_user_id: null, via: 'pick' }),
    ]);
  });

  it('a task released by a linked member is unassigned: a pick assigns it', async () => {
    const { me, taskId, runId } = await arrange('released by a linked member');
    const w = await worker(me, { policy: 'pick_only' });
    await withRemote((remote) => remote.claim(pickInput(w, runId)));
    expect((await ownership(taskId))?.owner_user_id).toBe(me);
  });

  it.each(['held by an unlinked person', 'held by a non-member'] as const)(
    'claims a task %s without assigning',
    async (c) => {
      const { me, taskId, runId } = await arrange(c);
      const w = await worker(me, { policy: 'pick_only' });
      expect(await withRemote((remote) => remote.claim(pickInput(w, runId)))).toEqual({
        kind: 'not_packaged',
        runId,
      });
      expect((await ownership(taskId))?.owner_user_id).toBeNull();
      expect((await actions(taskId)).map((row) => row.action)).toEqual(['worker.take_offer']);
      expect(await ownerEvents(taskId)).toEqual([]);
    },
  );

  it('refuses another person’s task by the list’s as_of, naming the owner, and claims nothing', async () => {
    const { me, other, taskId, runId } = await arrange('another’s');
    const w = await worker(me, { policy: 'everything' });
    const before = '2026-11-07T07:00:00.000Z' as IsoDateTime;
    const after = '2026-11-07T08:30:00.000Z' as IsoDateTime;
    const answers = await withRemote(async (remote) => [
      await remote.claim(pickInput(w, runId, before)),
      await remote.claim(pickInput(w, runId, after)),
      await remote.claim(pickInput(w, runId)),
    ]);
    expect(answers).toEqual([
      {
        kind: 'owned_by_another',
        owner: { userId: other, name: 'Other' },
        refusal: 'task_taken_by_another',
      },
      {
        kind: 'owned_by_another',
        owner: { userId: other, name: 'Other' },
        refusal: 'task_owned_by_another',
      },
      {
        kind: 'owned_by_another',
        owner: { userId: other, name: 'Other' },
        refusal: 'task_owned_by_another',
      },
    ]);
    const [offer] = await sql<{ state: string }>('select state from run_offers where run_id = $1', [
      runId,
    ]);
    expect(offer?.state).toBe('open');
    expect((await ownership(taskId))?.owner_user_id).toBe(other);
    expect(await actions(taskId)).toEqual([]);
  });

  it('names no owner to a worker the eligibility refuses — every other reason is none', async () => {
    const { other, runId } = await arrange('mine');
    const outsider = await user([]);
    const w = await worker(outsider, { policy: 'everything' });
    expect(other).toBeDefined();
    expect(await withRemote((remote) => remote.claim(pickInput(w, runId)))).toEqual({
      kind: 'none',
    });
  });

  it('a pick of an ask assigns nothing, whoever owns its task', async () => {
    const { me, taskId, runId } = await arrange('an ask another person asked');
    // The task is mine (the arrangement's), the ask another person's: the pick takes the ask.
    const w = await worker(me, { policy: 'pick_only' });
    await own(taskId, null);
    expect(await withRemote((remote) => remote.claim(pickInput(w, runId)))).toEqual({
      kind: 'not_packaged',
      runId,
    });
    expect((await ownership(taskId))?.owner_user_id).toBeNull();
    expect((await actions(taskId)).map((row) => row.action)).toEqual(['worker.take_offer']);
  });
});

describe('the list and the count (S-26.4, criterion 5)', () => {
  it('says which listed task is held elsewhere — the one fragment, so a pick of it assigns nothing (S-26.7)', async () => {
    for (const c of [
      'unowned',
      'released by a linked member',
      'held by an unlinked person',
      'held by a non-member',
      'mine',
    ] as const) {
      const { me, taskId, runId } = await arrange(c);
      const w = await worker(me, { policy: 'everything' });
      const entry = (await listed(w)).find((offer) => offer.runId === runId);
      expect(`${c}: ${entry?.heldElsewhere}`).toBe(`${c}: ${await heldElsewhere(taskId)}`);
    }
    // The two held cases are held, the released one is not (it is unassigned: a pick assigns it).
    const held = async (c: TaskCase) => {
      const { me, runId } = await arrange(c);
      const w = await worker(me, { policy: 'everything' });
      return (await listed(w)).find((offer) => offer.runId === runId)?.heldElsewhere;
    };
    expect(await held('held by an unlinked person')).toBe(true);
    expect(await held('held by a non-member')).toBe(true);
    expect(await held('released by a linked member')).toBe(false);
  });

  it('names the owner and mine, and counts what the policy leaves for others', async () => {
    const projectId = await project('lc');
    const me = await user([projectId], 'Me');
    const other = await user([projectId], 'Other');
    const mineTask = await task(projectId);
    await own(mineTask, me);
    const theirsTask = await task(projectId);
    await own(theirsTask, other);
    // Open to workers long before the database's own clock: the count asks `now()`, not `NOW`.
    const longOpen = {
      routing: workersRouting({ workersFrom: '2020-01-01T00:00:00.000Z' as IsoDateTime }),
    };
    const mineRun = await offered(projectId, mineTask, longOpen);
    const theirsRun = await offered(projectId, theirsTask, longOpen);
    const w = await worker(me, { policy: 'mine' });
    const list = await listed(w);
    expect(list.find((offer) => offer.runId === mineRun)).toMatchObject({
      owner: { userId: me, name: 'Me' },
      mine: true,
      automatic: true,
    });
    expect(list.find((offer) => offer.runId === theirsRun)).toMatchObject({
      owner: { userId: other, name: 'Other' },
      mine: false,
      automatic: false,
    });
    const pool = createTestPool(database.connectionString, { max: 2 });
    try {
      const workers = createPostgresWorkerStore(drizzle(pool) as unknown as Database);
      const core = { run: RUN_DIGEST, egress: EGRESS_DIGEST };
      await workers.recordContact({ workerId: w, protocolVersion: 4, imageDigests: HELD });
      const skipped = async () =>
        (await workers.listWorkers(me, core)).find((row) => row.id === w)?.policySkippedOffers;
      // Exactly the other's task is left; `everything` leaves nothing; no digests count nothing.
      expect(await skipped()).toBe(1);
      expect(await workers.policySkippedOffers(w, core)).toBe(1);
      await setPolicy(w, 'everything');
      expect(await skipped()).toBe(0);
      await setPolicy(w, 'pick_only');
      expect(await skipped()).toBe(2);
      expect((await workers.listWorkers(me)).find((row) => row.id === w)?.policySkippedOffers).toBe(
        null,
      );
    } finally {
      await pool.end();
    }
  });
});
