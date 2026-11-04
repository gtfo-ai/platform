/**
 * The offer's one claim and the per-task index — WP-274 criterion (5), TD-031 decisions 1–2, against
 * a real PostgreSQL 18.
 *
 * The contract suite holds the in-memory store's offer predicates to PostgreSQL's one call at a time;
 * what only a database can show is two claimants **at once**:
 *
 *  1. **Two concurrent claimants over one offer — exactly one wins**, measured over 200 iterations.
 *     Each iteration commits a fresh `open` offer, then opens two transactions on two connections and
 *     issues TD-031 §2's claim from both together. `for update skip locked` makes the second skip the
 *     row the first holds (or, once the first committed, find it no longer `open`), so one claim
 *     answers the offer at epoch 1 and the other answers nothing — never both, never epoch 2.
 *  2. **A second open stage offer for one task violates the index** (`run_offers_one_live_stage_per_task`),
 *     whether the first is `open` or `claimed`, and is admitted once the first is closed.
 *  3. **Routing** (WP-278, TD-031 decision 8): the server's claim honours `server_from` (never for a
 *     `workers_only` offer, at once for an offer from before WP-278), the expiry read finds only open
 *     offers past `expires_at`, and the execution repository's settings, online-assignee and
 *     claimant-liveness reads answer from the database.
 */
import {
  claimRunOffer,
  INITIAL_TASK_VERSION,
  type PipelineStore,
  type StoredTask,
  type Transaction,
  unroutedOfferForTest,
} from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { FEATURE_TEMPLATE, type OfferRouting, SHIPPED_TEMPLATES } from '@platform/domain';
import { pipeline } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient } from '../support/postgres.js';

const NOW = '2026-11-04T09:00:00.000Z' as IsoDateTime;
const ITERATIONS = 200;

let database: MigratedDatabase;
let projectId: Id;
let store: PipelineStore;
let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as Id;
};

beforeAll(async () => {
  database = await createMigratedDatabase('run-offers');
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('run-offers') returning id",
    );
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as Id;
  } finally {
    await client.end();
  }
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
    if (ended) {
      return;
    }
    ended = true;
    try {
      await client.query(verb);
    } finally {
      await client.end();
    }
  };
  return {
    tx: { adapter: 'postgres', client } as unknown as Transaction,
    commit: async () => end('commit'),
    rollback: async () => end('rollback'),
  };
};

/** A committed task. */
const committedTask = async (): Promise<Id> => {
  const setup = await begin();
  const taskId = nextId();
  const stored: StoredTask = {
    task: {
      id: taskId,
      projectId,
      ticket: {
        provider: 'fake-jira',
        key: `ACME-${counter}`,
        url: `https://jira.example.test/browse/ACME-${counter}`,
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
  } as unknown as StoredTask;
  await store.tasks.insert(setup.tx, stored);
  await setup.commit();
  return taskId;
};

/** A committed `running` run of `taskId`, with an `open` stage offer when `offered`. */
const committedRun = async (
  taskId: Id,
  offered = true,
  routing: OfferRouting = unroutedOfferForTest(NOW),
): Promise<{ runId: Id; offerId: Id }> => {
  const setup = await begin();
  const runId = nextId();
  const offerId = nextId();
  await store.runs.insert(setup.tx, {
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
    status: 'running',
    terminalReason: null,
    sessionId: null,
    numTurns: 0,
    usage: null,
    cost: null,
    wallMs: 0,
    createdAt: NOW,
    startedAt: NOW,
  });
  if (offered) {
    await store.offers.insert(setup.tx, {
      id: offerId,
      runId,
      taskId,
      projectId,
      stage: 'implementation' as Slug,
      attempt: 1,
      kind: 'stage',
      offeredAt: NOW,
      routing,
    });
  }
  await setup.commit();
  return { runId, offerId };
};

/**
 * One claimant's transaction. `lockTimeoutMs` makes a claim that would wait on the row lock fail at
 * once rather than at the test's deadline: with `skip locked` it never waits, so the timeout is never
 * reached; without it, the claim blocks behind the holder and the timeout turns that into an error
 * (review round 1 — the canary otherwise died only at the 120 s deadline).
 */
const claimFrom = (owner: string, runId: Id, lockTimeoutMs?: number) => async () => {
  const claimant = await begin();
  try {
    if (lockTimeoutMs !== undefined) {
      await (
        claimant.tx as unknown as { client: { query: (sql: string) => Promise<unknown> } }
      ).client.query(`set local lock_timeout = '${lockTimeoutMs}ms'`);
    }
    const claimed = await claimRunOffer(store.offers, claimant.tx, {
      eligibility: { runId },
      claimantKind: 'server',
      owner,
      expiresAt: '2026-11-04T09:05:00.000Z' as IsoDateTime,
      now: NOW,
    });
    await claimant.commit();
    return claimed;
  } catch (error) {
    await claimant.rollback();
    throw error;
  }
};

const read = async <R extends Record<string, unknown>>(text: string, values: unknown[]) => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    return (await client.query<R>(text, values)).rows;
  } finally {
    await client.end();
  }
};

describe('two concurrent claimants over one offer (WP-274 criterion 5)', () => {
  it(`exactly one wins, at epoch 1, in each of ${ITERATIONS} iterations`, async () => {
    const tally = { oneWinner: 0, firstWon: 0, secondWon: 0 };
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const taskId = await committedTask();
      const { runId, offerId } = await committedRun(taskId);
      const [first, second] = await Promise.all([
        claimFrom('server:claimant-a', runId)(),
        claimFrom('server:claimant-b', runId)(),
      ]);
      const winners = [first, second].filter((claim) => claim !== null);
      expect(winners, `iteration ${iteration}`).toHaveLength(1);
      expect(winners[0]).toMatchObject({ offerId, runId, epoch: 1 });
      tally.oneWinner += 1;
      if (first !== null) tally.firstWon += 1;
      else tally.secondWon += 1;
      // The row agrees with the answer: one claim's epoch, one claim's owner.
      const rows = await read<{
        state: string;
        offer_epoch: number;
        run_epoch: number;
        lease_owner: string;
      }>(
        `select o.state, o.lease_epoch as offer_epoch, r.lease_epoch as run_epoch, r.lease_owner
           from run_offers o join runs r on r.id = o.run_id where o.run_id = $1`,
        [runId],
      );
      expect(rows).toEqual([
        { state: 'claimed', offer_epoch: 1, run_epoch: 1, lease_owner: winners[0]?.owner },
      ]);
    }
    expect(tally.oneWinner).toBe(ITERATIONS);
    // Printed for the record (PROGRESS, WP-274): which side won is PostgreSQL's scheduling, not a
    // property of the claim — what is asserted is that exactly one did, every time.
    console.info(
      `run-offers: ${ITERATIONS} iterations, one winner each; first ${tally.firstWon}, second ${tally.secondWon}`,
    );
  }, 600_000);
});

describe('the claim skips, never waits (WP-274 criterion 5, TD-031 §2)', () => {
  /**
   * The 200 iterations above let PostgreSQL schedule the two claims, so they do not show which
   * interleaving each one took. This case pins the one that `skip locked` exists for: the first
   * claim has taken the row and **not committed**, and the second claim — on another connection —
   * answers nothing at once rather than blocking on the row lock and claiming it at epoch 2 after
   * the first commits.
   */
  it('answers nothing while another uncommitted claim holds the offer, and the holder commits epoch 1', async () => {
    const taskId = await committedTask();
    const { runId } = await committedRun(taskId);
    const holder = await begin();
    try {
      const held = await claimRunOffer(store.offers, holder.tx, {
        eligibility: { runId },
        claimantKind: 'server',
        owner: 'server:claimant-a',
        expiresAt: '2026-11-04T09:05:00.000Z' as IsoDateTime,
        now: NOW,
      });
      expect(held).toMatchObject({ epoch: 1 });
      expect(await claimFrom('server:claimant-b', runId, 2_000)()).toBeNull();
      await holder.commit();
    } finally {
      await holder.rollback();
    }
    expect(await claimFrom('server:claimant-b', runId)()).toBeNull();
    expect(
      await read<{ lease_owner: string; lease_epoch: number }>(
        'select lease_owner, lease_epoch from runs where id = $1',
        [runId],
      ),
    ).toEqual([{ lease_owner: 'server:claimant-a', lease_epoch: 1 }]);
  });
});

describe('the per-task index (WP-274 criterion 5, TD-031 §1)', () => {
  const secondStageOffer = async (taskId: Id): Promise<unknown> => {
    const { runId } = await committedRun(taskId, false);
    const attempt = await begin();
    try {
      await store.offers.insert(attempt.tx, {
        id: nextId(),
        runId,
        taskId,
        projectId,
        stage: 'implementation' as Slug,
        attempt: 1,
        kind: 'stage',
        offeredAt: NOW,
        routing: unroutedOfferForTest(NOW),
      });
      await attempt.commit();
      return null;
    } catch (error) {
      await attempt.rollback();
      return error;
    }
  };

  it('refuses a second stage offer for one task while the first is open', async () => {
    const taskId = await committedTask();
    await committedRun(taskId);
    expect(await secondStageOffer(taskId)).toMatchObject({
      code: '23505',
      constraint: 'run_offers_one_live_stage_per_task',
    });
  });

  it('refuses it while the first is claimed, and admits it once the first run’s finish settles it', async () => {
    const taskId = await committedTask();
    const { runId } = await committedRun(taskId);
    expect(await claimFrom('server:claimant-a', runId)()).toMatchObject({ epoch: 1 });
    expect(await secondStageOffer(taskId)).toMatchObject({
      code: '23505',
      constraint: 'run_offers_one_live_stage_per_task',
    });
    const ending = await begin();
    expect(
      await store.runs.finish(ending.tx, {
        runId,
        status: 'completed',
        terminalReason: 'success',
        sessionId: null,
        numTurns: 1,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        cost: { usd: 0, is_estimate: false, price_list_id: null },
        wallMs: 1,
        lease: { epoch: 1, owner: 'server:claimant-a' },
      }),
    ).toBe(true);
    await ending.commit();
    expect(await secondStageOffer(taskId)).toBeNull();
  });

  it('admits an ask offer beside an open stage offer (TD-031 §13)', async () => {
    const taskId = await committedTask();
    await committedRun(taskId);
    const { runId } = await committedRun(taskId, false);
    const ask = await begin();
    await store.offers.insert(ask.tx, {
      id: nextId(),
      runId,
      taskId,
      projectId,
      stage: null,
      attempt: 1,
      kind: 'ask',
      offeredAt: NOW,
      routing: unroutedOfferForTest(NOW),
    });
    await ask.commit();
  });
});

const at = (seconds: number): IsoDateTime =>
  new Date(Date.parse(NOW) + seconds * 1000).toISOString() as IsoDateTime;

const routed = (serverFrom: number | null, workersFrom: number | null): OfferRouting => ({
  assigneeUserId: null,
  assigneeUntil: null,
  serverFrom: serverFrom === null ? null : at(serverFrom),
  workersFrom: workersFrom === null ? null : at(workersFrom),
  expiresAt: at(3_600),
});

/** The server's claim of one run at `now`, committed. */
const serverClaimAt = async (runId: Id, now: IsoDateTime) => {
  const claimant = await begin();
  try {
    const claimed = await claimRunOffer(store.offers, claimant.tx, {
      eligibility: { runId },
      claimantKind: 'server',
      owner: 'server:routing',
      expiresAt: at(3_900),
      now,
    });
    await claimant.commit();
    return claimed;
  } catch (error) {
    await claimant.rollback();
    throw error;
  }
};

describe('the server claim honours the offer’s routing (WP-278, TD-031 decision 8)', () => {
  it('takes an offer only from its server_from', async () => {
    const { runId } = await committedRun(await committedTask(), true, routed(300, 0));
    expect(await serverClaimAt(runId, at(299))).toBeNull();
    expect((await serverClaimAt(runId, at(300)))?.epoch).toBe(1);
  });

  it('never takes a workers_only offer, and takes one from before WP-278 at once', async () => {
    const workersOnly = await committedRun(await committedTask(), true, routed(null, 0));
    expect(await serverClaimAt(workersOnly.runId, at(86_400))).toBeNull();
    const unrouted = await committedRun(await committedTask());
    expect((await serverClaimAt(unrouted.runId, NOW))?.epoch).toBe(1);
  });
});

describe('the offer-timeout read (WP-278, TD-031 decision 1)', () => {
  it('finds an open offer at its expires_at, not before, and never a claimed one', async () => {
    const open = await committedRun(await committedTask(), true, routed(null, 0));
    const claimed = await committedRun(await committedTask(), true, routed(0, 0));
    await serverClaimAt(claimed.runId, NOW);
    const expiredAt = async (now: IsoDateTime) => {
      const reader = await begin();
      try {
        return (await store.offers.expiredOpen(reader.tx, { now, limit: 1_000 })).map(
          (offer) => offer.runId,
        );
      } finally {
        await reader.rollback();
      }
    };
    expect(await expiredAt(at(3_599))).not.toContain(open.runId);
    const found = await expiredAt(at(3_600));
    expect(found).toContain(open.runId);
    expect(found).not.toContain(claimed.runId);
    const [row] = await read<{ expires_at: Date }>(
      'select expires_at from run_offers where run_id = $1',
      [open.runId],
    );
    expect(row?.expires_at.toISOString()).toBe(at(3_600));
  });
});

describe('the execution routing repository (WP-278, migration 0097)', () => {
  const routingStore = pipeline.createPostgresExecutionRoutingRepository();

  const within = async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
    const scope = await begin();
    try {
      const answer = await work(scope.tx);
      await scope.commit();
      return answer;
    } catch (error) {
      await scope.rollback();
      throw error;
    }
  };

  it('answers null for no stored settings, and the stored row once written', async () => {
    expect(await within((tx) => routingStore.settings(tx, projectId))).toBeNull();
    await read(
      `insert into project_execution_settings (project_id, mode, prefer, offer_timeout_seconds)
       values ($1, 'workers_only', 'workers', 600)`,
      [projectId],
    );
    expect(await within((tx) => routingStore.settings(tx, projectId))).toEqual({
      mode: 'workers_only',
      prefer: 'workers',
      fallbackAfterSeconds: null,
      assigneeWindowSeconds: 120,
      offerTimeoutSeconds: 600,
    });
    await read('delete from project_execution_settings where project_id = $1', [projectId]);
  });

  it('answers an assignee online only for a member’s active, unpaused worker seen in the last minute', async () => {
    const [user] = await read<{ id: string }>(
      "insert into users (email, name) values ('dev@example.test', 'Dev') returning id",
      [],
    );
    const userId = user?.id as Id;
    const online = () =>
      within((tx) =>
        routingStore.assigneeOnline(tx, {
          projectId,
          userId,
          now: new Date().toISOString() as IsoDateTime,
        }),
      );
    await read(
      `insert into workers (id, user_id, name, credential_hash, last_seen_at)
       values ($1, $2, 'laptop', repeat('a', 64), now())`,
      [nextId(), userId],
    );
    expect(await online()).toBe(false); // not a member yet
    await read(
      "insert into project_members (project_id, user_id, role) values ($1, $2, 'viewer')",
      [projectId, userId],
    );
    expect(await online()).toBe(false); // a viewer may not take runs
    await read("update project_members set role = 'member' where user_id = $1", [userId]);
    expect(await online()).toBe(true);
    await read(
      "update workers set last_seen_at = now() - interval '61 seconds' where user_id = $1",
      [userId],
    );
    expect(await online()).toBe(false);
    await read(
      `update workers set last_seen_at = now(), paused_until = now() + interval '1 hour',
              paused_reason = 'usage_limited' where user_id = $1`,
      [userId],
    );
    expect(await online()).toBe(false);
  });

  it('says a server claimant is running from its renewal until its release', async () => {
    const running = () => within((tx) => routingStore.serverClaimantRunning(tx));
    expect(await running()).toBe(false);
    await within((tx) =>
      routingStore.renewServerClaimant(tx, { holder: 'server:a', ttlMs: 60_000 }),
    );
    expect(await running()).toBe(true);
    await within((tx) =>
      routingStore.renewServerClaimant(tx, { holder: 'server:a', ttlMs: 60_000 }),
    );
    await within((tx) => routingStore.releaseServerClaimant(tx, 'server:a'));
    expect(await running()).toBe(false);
    await read(
      `insert into server_claimants (holder, renewed_at, expires_at)
       values ('server:dead', now() - interval '2 minutes', now() - interval '1 minute')`,
      [],
    );
    expect(await running()).toBe(false);
  });
});
