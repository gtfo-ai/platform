/**
 * **Why a run waits, against PostgreSQL 18** — S-26.5, TD-031's 2026-11-06 amendment item 8.
 *
 * `waiting` is a read over the claim's own predicates (`apps/server/src/queries/offer-waiting.ts`),
 * so what only the database can show is held here:
 *
 *  1. **Each reason from a fixture** — `owner_worker_offline` (with the last seen instant),
 *     `owner_worker_paused`, `owner_no_worker`, `owner_pick_only`, `no_taker`,
 *     `assignee_not_linked` — and `null` when the server or a taking machine can claim now. A task
 *     a linked member released reads as unassigned (`no_taker` or `null`), never
 *     `assignee_not_linked`: the *held elsewhere* fragment is the claim's.
 *  2. **The parity**: over a matrix of owner cases × the machine's policy × its state × the
 *     offer's routing × a server claimant present or not, `reason` is `null` **exactly** when some
 *     claimant's predicates admit the offer now — the server claimant (a fresh `server_claimants`
 *     row) probing the claim itself, or a connected machine probing its automatic claim, each
 *     rolled back.
 *  3. **Where it is carried**: the task read, the board's page and the Agents rows answer the same
 *     `waiting`, one statement per page.
 *  5. **The execution read's** `others_take_unassigned`: the server or another person's machine
 *     whose policy admits an unassigned task, never the reader's own.
 *
 * And backlog 1300/1301: the board's item carries `gate_wait` off the same projection as the task
 * read, the inbox lists a held CI job as `ci_held`, and neither serves a wait for a paused task.
 */
import {
  claimRunOffer,
  type PipelineStore,
  type RunOfferClaim,
  type Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, Slug, WorkerClaimPolicy } from '@platform/contracts';
import {
  agentsResponseSchema,
  inboxResponseSchema,
  OFFER_WAITING_REASONS,
  offerWaitingSchema,
  taskListItemSchema,
} from '@platform/contracts';
import { type OfferRouting, SHIPPED_TEMPLATES } from '@platform/domain';
import { pipeline } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  othersTakeUnassigned,
  waitingForRuns,
} from '../../../apps/server/src/queries/offer-waiting.js';
import {
  findTaskDetail,
  listInbox,
  listProjectTasks,
  listRunningAgents,
} from '../../../apps/server/src/queries/pipeline-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

const RUN_DIGEST = `sha256:${'c'.repeat(64)}`;
const EGRESS_DIGEST = `sha256:${'d'.repeat(64)}`;
const HELD = [RUN_DIGEST, EGRESS_DIGEST];
const STALE = [`sha256:${'e'.repeat(64)}`, `sha256:${'f'.repeat(64)}`];
const CORE = { run: RUN_DIGEST, egress: EGRESS_DIGEST };
const PROVIDER = 'jira-cloud';

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: Database;
let store: PipelineStore;
let orgId: string;
let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${(0x265000 + counter).toString(16).padStart(12, '0')}` as Id;
};

/** The instant `minutes` from now, on this process's clock (the probes' `now`). */
const at = (minutes: number): IsoDateTime =>
  new Date(Date.now() + minutes * 60_000).toISOString() as IsoDateTime;

const one = async <R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<R> => (await pool.query<R>(text, values)).rows[0] as R;

/** A transaction-shaped handle over the pool, for single statements (no begin/commit). */
const poolTx = (): Transaction => ({ adapter: 'postgres', client: pool }) as unknown as Transaction;

/** One connection, one transaction, rolled back: a claim that is only a probe. */
const probe = async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  await client.query('begin');
  try {
    return await work({ adapter: 'postgres', client } as unknown as Transaction);
  } finally {
    await client.query('rollback');
    await client.end();
  }
};

beforeAll(async () => {
  database = await createMigratedDatabase('offer-waiting');
  pool = createTestPool(database.connectionString, { max: 4 });
  drizzled = drizzle(pool) as unknown as Database;
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  orgId = (
    await one<{ id: string }>("insert into organizations (name) values ('waiting') returning id")
  ).id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

const project = async (): Promise<Id> =>
  (
    await one<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, $2, 'Waiting', 'https://git.example.test/acme/waiting.git') returning id`,
      [orgId, `wait${counter}x${nextId().slice(-6)}`],
    )
  ).id as Id;

/** An organisation **viewer** with a `member` membership in `projectId`. */
const member = async (projectId: Id, name: string): Promise<Id> => {
  const user = await one<{ id: string }>(
    "insert into users (email, name, role) values ($1, $2, 'viewer') returning id",
    [`${nextId()}@example.test`, name],
  );
  await pool.query(
    "insert into project_members (project_id, user_id, role) values ($1, $2, 'member')",
    [projectId, user.id],
  );
  return user.id as Id;
};

/** A tracker identity linked to `userId`, or an unlinked one for `null`. */
const identity = async (userId: Id | null): Promise<string> => {
  const externalId = `acct-${nextId()}`;
  if (userId !== null) {
    await pool.query(
      "insert into user_identities (provider, external_id, user_id, kind) values ($1, $2, $3, 'person')",
      [PROVIDER, externalId, userId],
    );
  }
  return externalId;
};

type MachineState = 'connected' | 'offline' | 'paused' | 'stale';

const machine = async (
  userId: Id,
  policy: WorkerClaimPolicy,
  state: MachineState,
  scope: readonly Id[] | null = null,
): Promise<{ readonly id: Id; readonly held: readonly string[]; readonly connected: boolean }> => {
  const id = nextId();
  const held = state === 'stale' ? STALE : HELD;
  await pool.query(
    `insert into workers (id, user_id, name, credential_hash, last_seen_at, claim_project_ids,
                          claim_policy, image_digests, manually_paused_at)
     values ($1, $2, 'laptop', $3,
             case when $4 then now() - interval '2 hours' else now() end,
             $5::uuid[], $6, $7::jsonb, case when $8 then now() end)`,
    [
      id,
      userId,
      id.replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      state === 'offline',
      scope,
      policy,
      JSON.stringify(held),
      state === 'paused',
    ],
  );
  return { id, held, connected: state !== 'offline' };
};

/** An `active` task at `stage`, with its stage row entered (a run's stage link resolves to it). */
const task = async (
  projectId: Id,
  options: { readonly state?: string; readonly stage?: string } = {},
): Promise<Id> => {
  const stage = options.stage ?? 'implementation';
  const row = await one<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage, stage_attempts)
     values ($1, $2, $3, 'https://jira.example.test/browse/' || $3, 'feature', $4, $5,
             jsonb_build_object($5::text, 1)) returning id`,
    [projectId, PROVIDER, `WAIT-${counter}${nextId().slice(-4)}`, options.state ?? 'active', stage],
  );
  await pool.query(
    "insert into task_stages (task_id, stage, attempt, state) values ($1, $2, 1, 'running')",
    [row.id, stage],
  );
  return row.id as Id;
};

/** The task's owner and tracker assignee, through the one owner writer (`saveOwner`). */
const own = async (
  taskId: Id,
  owner: Id | null,
  assignee: { readonly externalId: string; readonly name: string } | null = null,
): Promise<void> => {
  const current = await store.tasks.ownership(poolTx(), taskId);
  const written = await store.tasks.saveOwner(poolTx(), taskId, {
    expected: { ownerUserId: current.ownerUserId, ticketAssignee: current.ticketAssignee },
    next: {
      ownerUserId: owner,
      ownerSource: owner === null ? null : 'platform',
      ownerChangedAt: owner === null ? null : at(-60),
      ticketAssignee:
        assignee === null
          ? null
          : {
              provider: PROVIDER,
              external_id: assignee.externalId,
              display_name: assignee.name,
              platform: false,
            },
    },
  });
  expect(written).toBe(true);
};

type Routing = 'workers' | 'server';

const routingOf = (routing: Routing, assignee: Id | null): OfferRouting =>
  routing === 'workers'
    ? {
        assigneeUserId: assignee,
        assigneeUntil: null,
        serverFrom: null,
        workersFrom: at(-60),
        expiresAt: at(60 * 24),
      }
    : {
        assigneeUserId: assignee,
        assigneeUntil: null,
        serverFrom: at(-60),
        workersFrom: null,
        expiresAt: at(60 * 24),
      };

/** A `created` run of `taskId` with an `open` offer; an ask's names its asker. */
const offered = async (
  projectId: Id,
  taskId: Id,
  options: { readonly routing?: Routing; readonly askedBy?: Id } = {},
): Promise<Id> => {
  const runId = nextId();
  const kind = options.askedBy === undefined ? 'stage' : 'ask';
  await store.runs.insert(poolTx(), {
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
    createdAt: at(0),
    startedAt: null,
  });
  await store.offers.insert(poolTx(), {
    id: nextId(),
    runId,
    taskId,
    projectId,
    stage: 'implementation' as Slug,
    attempt: 1,
    kind,
    offeredAt: at(-1),
    routing: routingOf(options.routing ?? 'workers', options.askedBy ?? null),
  });
  if (options.askedBy !== undefined) {
    const ask = await one<{ id: string }>(
      `insert into task_asks (task_id, project_id, source, asked_by_user_id, question, run_id)
       values ($1, $2, 'ui', $3, 'which module sums the footer?', $4) returning id`,
      [taskId, projectId, options.askedBy, runId],
    );
    await pool.query('update runs set ask_id = $2 where id = $1', [runId, ask.id]);
  }
  return runId;
};

const claimantPresent = async (present: boolean): Promise<void> => {
  await pool.query('delete from server_claimants');
  if (present) {
    await pool.query(
      `insert into server_claimants (holder, renewed_at, expires_at)
       values ('server:waiting-test', now(), now() + interval '1 hour')`,
    );
  }
};

const serverProbe = (runId: Id): RunOfferClaim => ({
  eligibility: { runId },
  claimantKind: 'server',
  owner: 'server:waiting-test',
  expiresAt: at(10),
  now: at(0),
});

const workerProbe = (workerId: Id, held: readonly string[], runId: Id): RunOfferClaim => ({
  eligibility: { runId },
  claimantKind: 'worker',
  owner: `worker:${workerId}`,
  expiresAt: at(10),
  now: at(0),
  worker: { workerId, heldImageDigests: held, images: CORE, runTokenHash: 'e'.repeat(64) },
});

/** Whether any claimant's own claim admits the run's offer now — each probe rolled back. */
const admitted = async (
  runId: Id,
  serverRunning: boolean,
  machines: readonly {
    readonly id: Id;
    readonly held: readonly string[];
    readonly connected: boolean;
  }[],
): Promise<boolean> => {
  if (
    serverRunning &&
    (await probe((tx) => claimRunOffer(store.offers, tx, serverProbe(runId)))) !== null
  ) {
    return true;
  }
  for (const entry of machines) {
    // A machine claims only by calling, and every call records its contact: only a connected one.
    if (
      entry.connected &&
      (await probe((tx) =>
        claimRunOffer(store.offers, tx, workerProbe(entry.id, entry.held, runId)),
      )) !== null
    ) {
      return true;
    }
  }
  return false;
};

const waitingOfRun = async (runId: Id) =>
  (await waitingForRuns(drizzled, [runId], CORE)).get(runId) ?? null;

type OwnerCase = 'mine' | 'another' | 'unowned' | 'released' | 'held' | 'ask';

/**
 * One fixture: a project with Alice (and Bob, the other owner), a task in the given owner case,
 * Alice's one machine (or none), and an open offer routed as given.
 */
const fixture = async (input: {
  readonly owner: OwnerCase;
  readonly policy: WorkerClaimPolicy | null;
  readonly state: MachineState;
  readonly routing: Routing;
}) => {
  const projectId = await project();
  const alice = await member(projectId, 'Alice');
  const bob = await member(projectId, 'Bob');
  const taskId = await task(projectId);
  if (input.owner === 'mine') await own(taskId, alice);
  if (input.owner === 'another') await own(taskId, bob);
  if (input.owner === 'released') {
    // Released by a linked member: no owner, the ticket still Alice's in the tracker.
    await own(taskId, null, { externalId: await identity(alice), name: 'Alice' });
  }
  if (input.owner === 'held') {
    await own(taskId, null, { externalId: await identity(null), name: 'Jan Novák' });
  }
  const machines = input.policy === null ? [] : [await machine(alice, input.policy, input.state)];
  const runId = await offered(projectId, taskId, {
    routing: input.routing,
    ...(input.owner === 'ask' ? { askedBy: alice } : {}),
  });
  return { projectId, taskId, runId, alice, bob, machines };
};

describe('each reason from a fixture, and null when somebody can take it now (criterion 1)', () => {
  it('names the owner’s machine offline with its last contact, paused, absent, or only picking', async () => {
    await claimantPresent(false);
    const offline = await fixture({
      owner: 'mine',
      policy: 'mine',
      state: 'offline',
      routing: 'workers',
    });
    const read = await waitingOfRun(offline.runId);
    expect(read).toMatchObject({
      reason: 'owner_worker_offline',
      user: { user_id: offline.alice, name: 'Alice' },
      assignee_name: null,
    });
    const lastSeen = Date.parse(read?.last_seen_at ?? '');
    expect(Math.abs(lastSeen - (Date.now() - 2 * 3_600_000))).toBeLessThan(5 * 60_000);

    const paused = await fixture({
      owner: 'mine',
      policy: 'everything',
      state: 'paused',
      routing: 'workers',
    });
    expect(await waitingOfRun(paused.runId)).toEqual({
      reason: 'owner_worker_paused',
      user: { user_id: paused.alice, name: 'Alice' },
      last_seen_at: null,
      assignee_name: null,
    });

    const none = await fixture({
      owner: 'mine',
      policy: null,
      state: 'connected',
      routing: 'workers',
    });
    expect(await waitingOfRun(none.runId)).toMatchObject({
      reason: 'owner_no_worker',
      user: { user_id: none.alice },
    });

    const picking = await fixture({
      owner: 'mine',
      policy: 'pick_only',
      state: 'connected',
      routing: 'workers',
    });
    expect(await waitingOfRun(picking.runId)).toMatchObject({
      reason: 'owner_pick_only',
      user: { user_id: picking.alice },
    });

    // An ask's "owner" is its asker, as the claim's *mine* is.
    const ask = await fixture({
      owner: 'ask',
      policy: 'mine',
      state: 'offline',
      routing: 'workers',
    });
    expect(await waitingOfRun(ask.runId)).toMatchObject({
      reason: 'owner_worker_offline',
      user: { user_id: ask.alice },
    });
  });

  it('says nobody takes an unassigned task, and that a held one waits for a machine that takes everyone’s', async () => {
    await claimantPresent(false);
    const unowned = await fixture({
      owner: 'unowned',
      policy: 'mine',
      state: 'connected',
      routing: 'workers',
    });
    expect(await waitingOfRun(unowned.runId)).toEqual({
      reason: 'no_taker',
      user: null,
      last_seen_at: null,
      assignee_name: null,
    });
    const held = await fixture({
      owner: 'held',
      policy: 'mine_and_unassigned',
      state: 'connected',
      routing: 'workers',
    });
    expect(await waitingOfRun(held.runId)).toEqual({
      reason: 'assignee_not_linked',
      user: null,
      last_seen_at: null,
      assignee_name: 'Jan Novák',
    });
  });

  it('is null when a taking machine or the server can claim now', async () => {
    await claimantPresent(false);
    const taken = await fixture({
      owner: 'unowned',
      policy: 'mine_and_unassigned',
      state: 'connected',
      routing: 'workers',
    });
    expect(await waitingOfRun(taken.runId)).toEqual({
      reason: null,
      user: null,
      last_seen_at: null,
      assignee_name: null,
    });
    const serverRouted = await fixture({
      owner: 'mine',
      policy: null,
      state: 'connected',
      routing: 'server',
    });
    expect((await waitingOfRun(serverRouted.runId))?.reason).toBe('owner_no_worker');
    await claimantPresent(true);
    expect((await waitingOfRun(serverRouted.runId))?.reason).toBeNull();
    await claimantPresent(false);
  });

  it('reads a task a linked member released as unassigned — no_taker or null, never assignee_not_linked', async () => {
    await claimantPresent(false);
    const released = await fixture({
      owner: 'released',
      policy: 'mine',
      state: 'connected',
      routing: 'workers',
    });
    expect((await waitingOfRun(released.runId))?.reason).toBe('no_taker');
    const releasedTaken = await fixture({
      owner: 'released',
      policy: 'mine_and_unassigned',
      state: 'connected',
      routing: 'workers',
    });
    expect((await waitingOfRun(releasedTaken.runId))?.reason).toBeNull();
    // The claim's own fragment agrees: not held elsewhere.
    const [row] = (
      await pool.query<{ held: boolean }>(
        `select ${pipeline.taskHeldElsewhereSql('t')} as held from tasks t where t.id = $1`,
        [released.taskId],
      )
    ).rows;
    expect(row?.held).toBe(false);
  });

  it('answers nothing for a run whose offer is no longer open', async () => {
    await claimantPresent(false);
    const taken = await fixture({
      owner: 'unowned',
      policy: 'everything',
      state: 'connected',
      routing: 'workers',
    });
    const machineId = taken.machines[0]?.id as Id;
    const client = createTestClient(database.connectionString);
    await client.connect();
    try {
      await client.query('begin');
      const claimed = await claimRunOffer(
        store.offers,
        { adapter: 'postgres', client } as unknown as Transaction,
        workerProbe(machineId, HELD, taken.runId),
      );
      expect(claimed?.runId).toBe(taken.runId);
      await client.query('commit');
    } finally {
      await client.end();
    }
    expect(await waitingOfRun(taken.runId)).toBeNull();
  });
});

describe('the parity: a null reason ⇔ some claimant’s predicates admit the offer now (criterion 2)', () => {
  it('agrees with the claim itself over the matrix, and reaches every reason', async () => {
    const OWNERS: readonly OwnerCase[] = ['mine', 'another', 'unowned', 'released', 'held', 'ask'];
    const POLICIES: readonly (WorkerClaimPolicy | null)[] = [
      null,
      'everything',
      'mine_and_unassigned',
      'mine',
      'pick_only',
    ];
    const STATES: readonly MachineState[] = ['connected', 'offline', 'paused', 'stale'];
    const ROUTINGS: readonly Routing[] = ['workers', 'server'];
    const cases: Awaited<ReturnType<typeof fixture>>[] = [];
    const labels: string[] = [];
    for (const owner of OWNERS) {
      for (const policy of POLICIES) {
        // With no machine, its state means nothing: one case.
        for (const state of policy === null ? (['connected'] as const) : STATES) {
          for (const routing of ROUTINGS) {
            cases.push(await fixture({ owner, policy, state, routing }));
            labels.push(`${owner} × ${policy ?? 'no machine'} × ${state} × ${routing}`);
          }
        }
      }
    }
    const seen = new Set<string | null>();
    for (const serverRunning of [false, true]) {
      await claimantPresent(serverRunning);
      // One statement for every run, as the Agents list asks it.
      const reads = await waitingForRuns(
        drizzled,
        cases.map((entry) => entry.runId),
        CORE,
      );
      for (const [index, entry] of cases.entries()) {
        const read = reads.get(entry.runId);
        expect(offerWaitingSchema.parse(read)).toEqual(read);
        const label = `${labels[index]} × server ${serverRunning ? 'running' : 'absent'}`;
        expect(read?.reason === null, label).toBe(
          await admitted(entry.runId, serverRunning, entry.machines),
        );
        if (labels[index]?.startsWith('released')) {
          expect(read?.reason, label).not.toBe('assignee_not_linked');
        }
        seen.add(read?.reason ?? null);
      }
    }
    await claimantPresent(false);
    expect([...seen].sort()).toEqual([...OFFER_WAITING_REASONS, null].sort());
  }, 300_000);
});

describe('where it is carried: the task read, the board and the Agents rows (criterion 3)', () => {
  it('answers the same waiting on all three, and null where nothing waits', async () => {
    await claimantPresent(false);
    const offline = await fixture({
      owner: 'mine',
      policy: 'mine',
      state: 'offline',
      routing: 'workers',
    });
    const expected = await waitingOfRun(offline.runId);
    expect(expected?.reason).toBe('owner_worker_offline');

    const detail = await findTaskDetail(drizzled, offline.taskId, { coreDigests: CORE });
    expect(detail?.task.waiting).toEqual(expected);

    const page = await listProjectTasks(
      drizzled,
      offline.projectId,
      { limit: 50 },
      { coreDigests: CORE },
    );
    const item = page?.items.find((entry) => entry.id === offline.taskId);
    expect(taskListItemSchema.parse(item).waiting).toEqual(expected);

    const agents = agentsResponseSchema.parse(
      await listRunningAgents(drizzled, { coreDigests: CORE }),
    );
    expect(agents.items.find((entry) => entry.run.id === offline.runId)?.waiting).toEqual(expected);

    // A task with no open offer: nothing waits.
    const idle = await task(offline.projectId);
    expect((await findTaskDetail(drizzled, idle, { coreDigests: CORE }))?.task.waiting).toBeNull();
  });

  it('counts no machine as able to claim without the core’s digests, as none can', async () => {
    await claimantPresent(false);
    const taken = await fixture({
      owner: 'unowned',
      policy: 'everything',
      state: 'connected',
      routing: 'workers',
    });
    expect(
      (await waitingForRuns(drizzled, [taken.runId], CORE)).get(taken.runId)?.reason,
    ).toBeNull();
    expect((await waitingForRuns(drizzled, [taken.runId], null)).get(taken.runId)?.reason).toBe(
      'no_taker',
    );
  });
});

describe('the execution read: does anybody else take unassigned tasks (criterion 5)', () => {
  it('counts the server and another person’s machine that admits unassigned work, never the reader’s own', async () => {
    await claimantPresent(false);
    const projectId = await project();
    const reader = await member(projectId, 'Reader');
    const other = await member(projectId, 'Other');
    expect(await othersTakeUnassigned(drizzled, projectId, reader)).toBe(false);

    // The reader's own machine is not "anybody else".
    await machine(reader, 'everything', 'connected');
    expect(await othersTakeUnassigned(drizzled, projectId, reader)).toBe(false);

    // Another person's `mine` and `pick_only` machines take no unassigned task.
    await machine(other, 'mine', 'connected');
    await machine(other, 'pick_only', 'connected');
    expect(await othersTakeUnassigned(drizzled, projectId, reader)).toBe(false);

    // Another person's machine whose project list leaves the project out takes nothing here.
    const elsewhere = await project();
    await machine(other, 'mine_and_unassigned', 'offline', [elsewhere]);
    expect(await othersTakeUnassigned(drizzled, projectId, reader)).toBe(false);

    // A setting-level answer: an offline machine of another person that would take it counts.
    await machine(other, 'mine_and_unassigned', 'offline');
    expect(await othersTakeUnassigned(drizzled, projectId, reader)).toBe(true);
    // …unless the project keeps workers off its runs.
    await pool.query(
      "insert into project_execution_settings (project_id, mode) values ($1, 'server_only')",
      [projectId],
    );
    expect(await othersTakeUnassigned(drizzled, projectId, reader)).toBe(false);
    // The server takes a server_only project's unassigned tasks, when it runs.
    await claimantPresent(true);
    expect(await othersTakeUnassigned(drizzled, projectId, reader)).toBe(true);
    await pool.query(
      "update project_execution_settings set mode = 'workers_only' where project_id = $1",
      [projectId],
    );
    expect(await othersTakeUnassigned(drizzled, projectId, reader)).toBe(true);
    await pool.query(
      "update workers set revoked_at = now(), state = 'revoked' where user_id = $1",
      [other],
    );
    // Workers-only and only the reader's own machine left: nobody else.
    expect(await othersTakeUnassigned(drizzled, projectId, reader)).toBe(false);
    await claimantPresent(false);
  });
});

describe('the CI wait on the board and the inbox (backlog 1300, 1301)', () => {
  const READ = {
    pipeline_id: '3038234623',
    pipeline_url: 'https://gitlab.example.test/acme/api/-/pipelines/3038234623',
    head_sha: '1'.repeat(40),
    status: 'manual',
    held_job: 'sentry-release-commit',
    held_job_url: 'https://gitlab.example.test/acme/api/-/jobs/9003',
    draft: true,
    checked_at: '2026-11-07T10:59:30.000Z',
    timeout_minutes: 60,
  };

  it('serves gate_wait on the board item and ci_held in the inbox for an active task, never a paused one', async () => {
    const projectId = await project();
    const held = await task(projectId, { stage: 'ci_gate' });
    const running = await task(projectId, { stage: 'ci_gate' });
    const paused = await task(projectId, { stage: 'ci_gate', state: 'paused' });
    for (const [taskId, status] of [
      [held, 'manual'],
      [running, 'running'],
      [paused, 'manual'],
    ] as const) {
      const written = await store.tasks.recordCiPendingRead(
        poolTx(),
        { taskId, stage: 'ci_gate' as Slug, attempt: 1 },
        { ...READ, status, held_job: status === 'manual' ? READ.held_job : null },
      );
      expect(written).toBe(true);
    }
    const page = await listProjectTasks(drizzled, projectId, { limit: 50 });
    const byId = new Map(page?.items.map((item) => [item.id, taskListItemSchema.parse(item)]));
    expect(byId.get(held)?.gate_wait).toMatchObject({
      status: 'manual',
      held_job: 'sentry-release-commit',
    });
    // The task read's own answer, item by item.
    for (const taskId of [held, running, paused]) {
      expect(byId.get(taskId)?.gate_wait).toEqual(
        (await findTaskDetail(drizzled, taskId))?.gate_wait,
      );
    }
    expect(byId.get(running)?.gate_wait?.status).toBe('running');
    expect(byId.get(paused)?.gate_wait).toBeNull();

    const inbox = inboxResponseSchema.parse(await listInbox(drizzled));
    const listed = (inbox.ci_held ?? []).map((entry) => entry.task_id);
    expect(listed).toContain(held);
    expect(listed).not.toContain(running);
    expect(listed).not.toContain(paused);
    expect(inbox.ci_held?.find((entry) => entry.task_id === held)).toMatchObject({
      project_id: projectId,
      gate_wait: { status: 'manual', held_job_url: READ.held_job_url },
    });
  });
});
