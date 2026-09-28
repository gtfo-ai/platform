/**
 * **Two processes, one database: the `ROLE` split exercised** — WP-72, PROGRESS backlog 38.
 *
 * `ROLE` is the product's scaling story and, until this file, every process any tier had started
 * was `ROLE=all`. TD-028 made the split the **shipped** topology rather than an option — `app`
 * serves the API and the webhooks and is pinned to no launcher, `runner` runs every agent stage and
 * serves no API — so what this file asserts is the deployment `compose.yml` ships, one crossing at a
 * time. The process count is not the point; the crossings are, and each is asserted **through the
 * processes** (their HTTP answers, their stream frames, the rows they wrote) rather than through a
 * direct call (standing rules 42 and 82).
 *
 *  1. **A command answered by one process is performed by another** — a maintainer's knowledge
 *     approval on `ROLE=api` is committed by `ROLE=worker`. It is asserted with attribution: every
 *     process has its own recording view of the one fake git provider (`PipelineE2E.gitCalls`), so
 *     "the worker made the commit" is a row of evidence rather than an inference from the roles.
 *     Before WP-72 the API role held no job client at all and this crossing did not exist: the
 *     approval waited for the nightly hygiene pass (`apps/server/src/enqueue-only-jobs.ts`).
 *  2. **A transcript produced by one process is streamed by another** — the runner executes the
 *     run, `app` serves `/events`, and they share nothing but the database (TD-014).
 *  3. **Readiness differs per role for the documented reason** — the API answers ready while a
 *     worker that cannot compose a pipeline is 503 with `dispatch: down` (TD-023's amendment).
 *  4. **Each role refuses to start below its own pool floor**, and starts at it — every branch of
 *     `requiredPoolConnections` but `all`'s had never run in any tier.
 *  5. **The two crossings a user can see**: a steer sent to the process that serves the API is
 *     refused by name, because on the shipped topology that process never holds a run (backlog
 *     134); and an approval is posted with buttons only while some process holds the chat socket
 *     (backlog 200, migration 0054).
 *  6. **A run credential quoted in text a process that never minted it stores** is absent from the
 *     `inbox` row it writes and, since WP-73b, from the `mr.review.comment` event it appends
 *     (backlog 154, decision (a): the pattern rule is the defence there; backlog 260). A planted
 *     `glpat-` token is caught by the gitleaks rule; since WP-80 a token the runner **minted**
 *     through its production minter, under a prefix no gitleaks rule knows (backlog 259), is caught
 *     by the shape the runner recorded beside the mint's audit row (TD-012's M5 amendment).
 *  7. **The diff coalescer is per process**, so one gate entry costs one read *per process that ran
 *     one of its duties* (backlog 181) — counted here, and the figure is stated at the coalescer.
 *
 * ## The connection budget (criterion 3)
 *
 * Every case here starts two whole processes against the tier's one PostgreSQL container, and the
 * tier runs files in parallel. Each process is started **at its own role's floor** where the case
 * allows (the `ROLE=api` process at 4, the runner at 20), which is both the positive half of the
 * floor assertion and the cheapest configuration that is honest. The measured peak of the whole tier
 * with this file in it, and the margin under `max_connections`, are in PROGRESS under WP-72 and in
 * `test/integration/support/global-setup.ts`.
 */
import type { RunRecord } from '@platform/contracts';
import { redaction as redactionAdapters } from '@platform/infrastructure';
import { loadServerConfig, requiredPoolConnections, UndersizedPoolError } from '@platform/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase } from '../../integration/support/migrated.js';
import { PLANTED_MODEL_KEY, PLANTED_MODEL_KEY_PLACEHOLDER } from '../support/agent-workspace.js';
import {
  BOOTSTRAP_EMAIL,
  BOOTSTRAP_PASSWORD,
  Client,
  type Instance,
  startInstance,
} from '../support/instance.js';
import {
  CHAT_INTEGRATION_ID,
  GIT_PROJECT,
  inboundEvent,
  type PipelineE2E,
  startPipeline,
} from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';
import { createFakeSlack, type FakeSlack, findApprovalButton } from '../support/slack.js';
import { SseStream } from '../support/sse-client.js';

/** The custom token prefix the fake git mints under (WP-80) — no gitleaks rule knows it. */
const MINTED_PREFIX = 'acmepat-';

/** `requiredPoolConnections` for one role at the default concurrency, from its own config. */
const floorOf = (role: string): number =>
  requiredPoolConnections(
    loadServerConfig({
      ROLE: role,
      DATABASE_URL: 'postgres://127.0.0.1:5432/floor',
      APP_SECRET_KEY: 'e2e-pool-floor-probe-not-a-real-secret-000',
      APP_DB_POOL_MAX: '1000',
    }),
  );

let harness: PipelineE2E | undefined;
const instances: Instance[] = [];
let stream: SseStream | undefined;

afterEach(async () => {
  await stream?.disconnect();
  stream = undefined;
  // Instances started directly: the ones that share a database first, the owner last.
  for (const instance of instances.splice(0).reverse()) {
    await instance.stop();
  }
  await harness?.stop();
  harness = undefined;
});

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

/** A promise the test resolves, for holding a run at its workspace. */
const gate = () => {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { opened, open: () => open() };
};

const ticketMatched = (pipeline: PipelineE2E, key = 'ACME-1') =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key,
      url: `https://tickets.example.test/browse/${key}`,
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

/** How many `pipeline.outbound` jobs are still to run — the queue every provider duty is on. */
const outboundInFlight = async (pipeline: PipelineE2E): Promise<number> => {
  const [row] = await pipeline.query<{ pending: number }>(
    `select count(*)::int as pending from pgboss.job
      where name = 'pipeline.outbound' and state in ('created', 'retry', 'active')`,
  );
  return row?.pending ?? 0;
};

describe('the shipped topology: app (ROLE=all, no launcher) beside runner (ROLE=runner)', () => {
  it('runs the agent in the runner, streams it from app, refuses a steer to app by name, and redacts a run credential app never saw', async () => {
    const held = gate();
    const started = gate();
    let firstRunId: string | null = null;

    // `app`: the primary, `ROLE=all` (what `.env.example` gives the `app` service) with **no**
    // runner — `compose.yml` pins its launcher variables empty, so it subscribes neither
    // `stage.execute` nor `task.ask` (TD-028 decision 5).
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'topology-shipped',
      tickets: TICKETS,
      agent: 'none',
      processName: 'app',
      // WP-80: the fake git mints under a prefix no gitleaks rule knows — backlog 259's trigger, a
      // GitLab administrator's custom personal-access-token prefix.
      gitCredentialPrefix: MINTED_PREFIX,
      onAgentSpec: async (spec) => {
        if (firstRunId !== null) {
          return;
        }
        firstRunId = spec.runId;
        started.open();
        await held.opened;
      },
    });
    harness = pipeline;
    // The diff every gate-entry duty reads (backlog 181's count below).
    pipeline.git.setDiff({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      files: [{ path: 'src/totals.ts' }],
    });
    // `runner`: `ROLE=runner`, the only process with a runner, started at **exactly** its floor.
    await pipeline.addProcess({
      name: 'runner',
      role: 'runner',
      agent: 'real-over-fake-cli',
      env: { APP_DB_POOL_MAX: String(floorOf('runner')) },
      // WP-80: each run's git credential is minted by the runner's production minter.
      mintsRunCredentials: true,
    });
    const app = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline)]);
    await started.opened;
    const runId = firstRunId as unknown as string;

    // ── crossing 5a: a steer to the process that serves the API, while the run is live ─────────
    const live = await app.json<RunRecord>(`/api/runs/${runId}`);
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(live.body.status).toBe('running');
    const steer = await app.json<{ error: { code: string; message: string } }>(
      `/api/runs/${runId}/steer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'steer-topology-1' },
        body: JSON.stringify({ message: 'also check the rounding' }),
      },
    );
    // Named, and a 409 rather than a 200 that nobody heard (backlog 134: on this topology `app`
    // is pinned never to hold a run, so this is every steer, not an unlucky one).
    expect(steer.status, JSON.stringify(steer.body)).toBe(409);
    expect(steer.body.error.code).toBe('run_not_reachable');
    expect(
      await pipeline.query(
        "select 1 from events where type = 'run.steered' and payload->>'run_id' = $1",
        [runId],
      ),
    ).toEqual([]);

    // ── crossing 2: the runner produces the transcript, app streams it ───────────────────────────
    stream = await SseStream.open(`${pipeline.instance.baseUrl}/events?topics=run:${runId}`, {
      headers: { cookie: app.cookieHeader },
    });
    await stream.waitFor(() => stream?.received.length !== 0, 'app’s stream to open');
    held.open();
    await stream.waitFor(
      () => stream?.events().some((event) => event.event === 'assistant') === true,
      'a transcript frame, produced in the runner, on app’s stream',
      60_000,
    );
    const frame = stream.events().find((event) => event.event === 'assistant');
    expect(frame?.id).toMatch(new RegExp(`^run:${runId}:\\d+$`));
    // Both directions on the frame: the run's own credential is replaced, and the replacement is
    // there — so the frame is the redacted row, not an empty one.
    expect(frame?.data).toContain(PLANTED_MODEL_KEY_PLACEHOLDER);
    expect(frame?.data).not.toContain(PLANTED_MODEL_KEY);

    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    // ── backlog 181: one gate entry's diff reads, per process ───────────────────────────────────
    // Wait on exactly what is counted (rule 50): the reads are made by `pipeline.outbound` jobs,
    // so once that queue has nothing left to run, every read this gate entry causes has happened.
    // The dispatch queue is part of the condition: a duty is enqueued after its handler commits, so
    // an empty job queue with an event still undispatched is a gap, not an ending.
    await pipeline.waitFor(
      'the provider duties of the gate entry to finish',
      async () =>
        pipeline.gitCalls().some((call) => call.method === 'getMergeRequestDiff') &&
        (await outboundInFlight(pipeline)) === 0 &&
        (
          await pipeline.query(
            'select 1 from event_dispatch where dead_lettered_at is null limit 1',
          )
        ).length === 0,
    );
    const reads = pipeline.gitCalls().filter((call) => call.method === 'getMergeRequestDiff');
    const byProcess = new Map<string, number>();
    for (const read of reads) {
      byProcess.set(read.process, (byProcess.get(read.process) ?? 0) + 1);
    }
    // The coalescer's bound, per process: **at most one read of one revision in each process**,
    // whichever of the two took the dependency gate, the conflict warning and the risk routing.
    for (const [process, count] of byProcess) {
      expect(count, `${process} read the diff ${count} times`).toBe(1);
    }
    // …so the gate entry costs one read per process that ran one of its duties: one or two on this
    // topology, and the audit agrees with the provider's own count.
    expect(reads.length).toBe(byProcess.size);
    expect([1, 2]).toContain(reads.length);
    const audited = (await pipeline.auditRows()).filter(
      (row) => row.action === 'get_merge_request_diff',
    );
    expect(audited).toHaveLength(reads.length);
    // Which of the two it is depends on which process pg-boss handed each duty; the figure measured
    // over repeated runs is stated at `diff-coalescer.ts` rather than pinned here.

    // ── crossing 6: a run credential quoted in text app stores ───────────────────────────────────
    // A run's minted GitLab token of the documented shape, quoted in a review comment — the way a
    // run that printed its credential reaches a human who pastes it back. `app` serves every
    // webhook and never mints, so its registry of run credentials is empty by construction: what
    // keeps the value out of the `inbox` row it stores is the pattern rule alone (decision (a)).
    const mintedShape = 'glpat-FAKE0minted0in0the0runner00';
    const delivery = pipeline.git.emitReviewComment({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      discussionId: 'disc-topology-1',
      authorId: 'someone',
      text: `the run pushed with https://agentic:${mintedShape}@git.example.test/acme/api.git`,
    });
    const posted = await pipeline.deliverGit(delivery);
    expect(posted.status, JSON.stringify(posted.body)).toBe(202);
    const stored = await pipeline.query<{ payload: unknown; redaction_count: number }>(
      "select payload, redaction_count from inbox where provider = 'fake-git' order by received_at desc limit 1",
    );
    expect(stored).toHaveLength(1);
    const storedText = JSON.stringify(stored[0]?.payload);
    expect(storedText).not.toContain(mintedShape);
    expect(storedText).toContain('[REDACTED');
    expect(stored[0]?.redaction_count).toBeGreaterThan(0);
    // The `mr.review.comment` **event** is the other half, and it is the adapter's rather than the
    // ingress's: a real provider's normaliser redacts the whole delivery with the loader's platform
    // redactor before any branch reads it. The fake registration dropped that redactor until
    // WP-73b (PROGRESS backlog 260 — WP-72 measured the event carrying the value); it now applies it
    // to the body before the fake's normaliser reads it, so the event is asserted here too — the
    // pattern half of an inbound **event**, which no other tier asserts.
    const comments = await pipeline.query<{ payload: unknown }>(
      "select payload from events where type = 'mr.review.comment' and payload ->> 'thread_id' = 'disc-topology-1'",
    );
    expect(comments).toHaveLength(1);
    const eventText = JSON.stringify(comments[0]?.payload);
    expect(eventText).not.toContain(mintedShape);
    expect(eventText).toContain('[REDACTED');

    // ── crossing 6, WP-80: a credential the runner **minted**, under a custom prefix ────────────
    // TD-012's M5 amendment (PROGRESS backlog 259). The runner minted every run's credential through
    // its production minter; `app` never minted — every `mintCredential` the provider saw came from
    // the runner — so no exact-value registry in `app`'s stack ever held one, and the `glpat-` rule
    // cannot match this prefix. What redacts it in `app` is the shape the runner recorded beside the
    // mint's audit row, compiled into `app`'s rules by its refresh.
    const mints = pipeline.gitCalls().filter((call) => call.method === 'mintCredential');
    expect(mints.length).toBeGreaterThan(0);
    expect(new Set(mints.map((call) => call.process))).toEqual(new Set(['runner']));
    const minted = pipeline.git.credentials.find((row) => row.value.startsWith(MINTED_PREFIX));
    expect(minted, 'the runner minted under the custom prefix').toBeDefined();
    const mintedValue = minted?.value as string;
    // The shape row, beside the mint's audit row: a prefix, a class and a length — no value.
    const shapes = await pipeline.query<{ prefix: string; charset: string; length: number }>(
      'select prefix, charset, length from minted_credential_shapes',
    );
    expect(shapes).toEqual([
      { prefix: MINTED_PREFIX, charset: 'alnum', length: mintedValue.length },
    ]);
    expect(
      JSON.stringify(await pipeline.query('select * from minted_credential_shapes')),
    ).not.toContain(mintedValue);
    expect(
      (await pipeline.auditRows()).filter((row) => row.action === 'mint_credential').length,
    ).toBe(mints.length);
    // Rule 87: the shape was recorded at the first mint, long before this line, and a process
    // refreshes every few seconds; the wait binds the rule being installed rather than a sleep.
    // **In this tier the processes share one Node module graph**, so the installed set is shared
    // too: what this proves is that the value reaches no row `app` writes through its exact-value
    // path (its stack never held it) and is caught by a rule compiled from the database's shape
    // rows — not that `app`'s own timer was the one that installed it. The per-process read is
    // asserted in `test/integration/redaction/minted-credential-shapes.integration.test.ts`.
    await pipeline.waitFor('the minted shape to be compiled into the redaction rules', async () =>
      redactionAdapters
        .installedMintedCredentialShapeRules()
        .some((rule) => new RegExp(rule.pattern.source).test(mintedValue)),
    );
    const quoted = pipeline.git.emitReviewComment({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      discussionId: 'disc-topology-minted',
      authorId: 'someone',
      // Bare, and on purpose: inside a URL's userinfo the `connection-string` rule would redact it
      // whatever its shape (measured — the canary passed until this quote lost its URL), so the
      // only rule that can see this spelling is the minted shape's.
      text: `the job log printed the run's token ${mintedValue} before the push`,
    });
    const delivered = await pipeline.deliverGit(quoted);
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(202);
    const mintedComments = await pipeline.query<{ payload: unknown }>(
      "select payload from events where type = 'mr.review.comment' and payload ->> 'thread_id' = 'disc-topology-minted'",
    );
    expect(mintedComments).toHaveLength(1);
    const mintedText = JSON.stringify(mintedComments[0]?.payload);
    expect(mintedText).not.toContain(mintedValue);
    expect(mintedText).toContain(redactionAdapters.redactionPlaceholder(mintedValue));
    const mintedInbox = await pipeline.query<{ payload: unknown }>(
      "select payload from inbox where provider = 'fake-git' order by received_at desc limit 1",
    );
    expect(JSON.stringify(mintedInbox[0]?.payload)).not.toContain(mintedValue);
  }, 300_000);
});

describe('the scaling split: ROLE=api beside ROLE=worker', () => {
  it('commits, in the worker, a knowledge approval the API answered', async () => {
    const apiFloor = floorOf('api');
    // `ROLE=api` at **exactly** its floor — the positive half of the floor assertion, with the
    // enqueue-only job client it holds since WP-72 counted in it.
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'topology-split',
      tickets: TICKETS,
      role: 'api',
      agent: 'none',
      processName: 'api',
      env: { APP_DB_POOL_MAX: String(apiFloor) },
    });
    harness = pipeline;
    // The primary's environment is every process's; the worker gets its own floor back.
    await pipeline.addProcess({
      name: 'worker',
      role: 'worker',
      agent: 'fake-runner',
      env: { APP_DB_POOL_MAX: String(floorOf('worker')) },
    });
    const client = await signIn(pipeline.instance.baseUrl);

    const target = '.agentic/knowledge/lessons/L-2026-09-27-two-processes.md';
    const [proposal] = await pipeline.query<{ id: string }>(
      `insert into kb_proposals (project_id, source, kind, type, target_path, delta, significance,
                                 status)
       values ($1, 'human', 'technical', 'lesson', $2, $3, 0.6, 'queued')
       returning id`,
      [
        pipeline.projectId,
        target,
        '---\ntitle: Two processes\n---\nA command answered by the API is performed by a worker.\n',
      ],
    );
    const commitsBefore = pipeline.git.commits.length;

    const decided = await client.post(
      `/api/projects/${pipeline.projectId}/kb/proposals/${proposal?.id}/approve`,
      { decision: 'approve' },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    // The row reaching `applied` is the last write the apply pass makes (librarian e2e, rule 50).
    await pipeline.waitFor('the approved proposal to be applied', async () => {
      const [row] = await pipeline.query<{ status: string }>(
        'select status::text as status from kb_proposals where id = $1',
        [proposal?.id],
      );
      return row?.status === 'applied';
    });
    const commit = pipeline.git.commits.at(-1);
    expect(pipeline.git.commits.length).toBe(commitsBefore + 1);
    expect(commit?.files.map((file) => file.path)).toEqual([target]);
    // **Attributed**, not inferred: the commit went through the worker's view of the provider, and
    // the process that answered the command made no provider write at all.
    const writes = pipeline.gitCalls().filter((call) => call.method === 'commitFiles');
    expect(writes.map((call) => call.process)).toEqual(['worker']);
    // …and the job itself crossed the database: it was enqueued by a process that subscribes
    // nothing and completed by one that does.
    const [job] = await pipeline.query<{ state: string }>(
      "select state::text as state from pgboss.job where name = 'knowledge.apply' order by created_on desc limit 1",
    );
    expect(job?.state).toBe('completed');
  }, 240_000);

  it('answers ready on the API while a worker that cannot compose a pipeline is 503 for that reason', async () => {
    const api = await startInstance({
      label: 'topology-ready',
      role: 'api',
      env: { APP_DB_POOL_MAX: String(floorOf('api')) },
    });
    instances.push(api);
    const worker = await startInstance({
      role: 'worker',
      database: api.database,
      // The labelled seam `sweepReadiness` is driven through: a worker whose bus is an incomplete
      // consumer refuses to sweep, and says so on `/readyz` (TD-023's amendment).
      pipeline: null,
      env: { APP_DB_POOL_MAX: String(floorOf('worker')) },
    });
    instances.push(worker);

    const apiReady = await fetch(`${api.baseUrl}/readyz`);
    const apiBody = (await apiReady.json()) as { status: string; checks: Record<string, string> };
    expect(apiReady.status, JSON.stringify(apiBody)).toBe(200);
    // The API runs no dispatcher, so it reports none — omitted, not `ok` — and since WP-72 it
    // reports the queue client it enqueues through.
    expect(apiBody.checks).toEqual({ database: 'ok', migrations: 'ok', queue: 'ok' });

    const workerReady = await fetch(`${worker.baseUrl}/readyz`);
    const workerBody = (await workerReady.json()) as {
      status: string;
      checks: Record<string, string>;
    };
    expect(workerReady.status, JSON.stringify(workerBody)).toBe(503);
    expect(workerBody.checks).toEqual({
      database: 'ok',
      migrations: 'ok',
      queue: 'ok',
      dispatch: 'down',
    });
  }, 180_000);
});

describe('each role’s pool floor', () => {
  it('refuses to start one below its own floor, and starts at it — every role', async () => {
    const database = await createMigratedDatabase('topology-floors');
    try {
      for (const role of ['api', 'worker', 'runner', 'indexer', 'all']) {
        const floor = floorOf(role);
        const refused = await startInstance({
          role,
          database,
          env: { APP_DB_POOL_MAX: String(floor - 1) },
        }).then(
          (instance) => instance,
          (error: unknown) => error,
        );
        if (!(refused instanceof UndersizedPoolError)) {
          if (refused !== null && typeof refused === 'object' && 'stop' in refused) {
            await (refused as Instance).stop();
          }
          throw new Error(`ROLE=${role} started with APP_DB_POOL_MAX=${floor - 1}`);
        }
        expect(refused.required, role).toBe(floor);
        expect(refused.message).toContain(`ROLE=${role} needs at least ${floor} connections`);

        const accepted = await startInstance({
          role,
          database,
          env: { APP_DB_POOL_MAX: String(floor) },
        });
        await accepted.stop();
      }
    } finally {
      await database.drop();
    }
  }, 240_000);
});

describe('the approval buttons need a process holding the socket (backlog 200)', () => {
  const PLAN_ALWAYS = {
    pipeline: {
      template_overrides: { feature: { stages: { architecture: { plan_approval: 'always' } } } },
    },
  };

  const approvalIdOf = async (pipeline: PipelineE2E, key: string): Promise<string> => {
    const [row] = await pipeline.query<{ id: string }>(
      `select a.id from approvals a join tasks t on t.id = a.task_id
        where t.ticket_key = $1 order by a.requested_at limit 1`,
      [key],
    );
    if (row === undefined) {
      throw new Error(`no approval was requested for ${key}`);
    }
    return row.id;
  };

  const deliveredApproval = async (pipeline: PipelineE2E, approvalId: string) => {
    const [row] = await pipeline.query<{ delivered_at: Date | null }>(
      "select delivered_at from notifications where class = 'approval' and approval_id = $1",
      [approvalId],
    );
    return row?.delivered_at !== null && row !== undefined;
  };

  const buttonsFor = (slack: FakeSlack, approvalId: string) =>
    slack.posted.filter((message) => JSON.stringify(message.blocks ?? null).includes(approvalId));

  it('posts text from a worker with no API process, and buttons once an API process holds it', async () => {
    const slack = createFakeSlack();
    // A worker-only deployment: the one process runs the pipeline and serves no `/webhooks/*`, so
    // it holds no socket (WP-43) and names the account instead.
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'topology-buttons',
      tickets: TICKETS,
      config: PLAN_ALWAYS,
      slack,
      role: 'worker',
      processName: 'worker',
    });
    harness = pipeline;

    // ── without an API process: text naming the task page ─────────────────────────────────────
    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.settle('waiting_approval', (task) => task.state === 'waiting_approval');
    const first = await approvalIdOf(pipeline, 'ACME-1');
    await pipeline.waitFor('the first approval to be delivered', async () =>
      deliveredApproval(pipeline, first),
    );
    expect(slack.live()).toBeNull();
    expect(buttonsFor(slack, first)).toEqual([]);
    expect(findApprovalButton(slack.posted, 'approved')).toBeNull();
    expect(
      slack.posted.some((message) =>
        message.text.includes('no process is holding this chat’s connection'),
      ),
    ).toBe(true);
    expect(
      await pipeline.query('select 1 from held_connection_liveness where integration_id = $1', [
        CHAT_INTEGRATION_ID,
      ]),
    ).toEqual([]);

    // ── an API process joins and holds the socket: buttons ────────────────────────────────────
    const api = await pipeline.addProcess({
      name: 'api',
      role: 'api',
      agent: 'none',
      env: { APP_DB_POOL_MAX: String(floorOf('api')) },
    });
    await api.runtime.heldConnections?.relist();
    await pipeline.waitFor('the Socket Mode connection', async () => slack.live() !== null);
    slack.send({ type: 'hello', num_connections: 1 });
    await pipeline.waitFor(
      'the held connection to be open',
      async () =>
        api.runtime.heldConnections
          ?.status()
          .some(
            (status) => status.integrationId === CHAT_INTEGRATION_ID && status.state === 'open',
          ) ?? false,
    );
    // The row the worker's notify duty will read, written by the other process.
    const [liveness] = await pipeline.query<{ holder: string; fresh: boolean }>(
      `select holder, expires_at > now() as fresh from held_connection_liveness
        where integration_id = $1`,
      [CHAT_INTEGRATION_ID],
    );
    expect(liveness?.fresh).toBe(true);
    expect(liveness?.holder).toMatch(/^api@/);

    await pipeline.publish([ticketMatched(pipeline, 'ACME-2')]);
    await pipeline.waitFor('the second task’s approval', async () => {
      const rows = await pipeline.query<{ count: number }>(
        "select count(*)::int as count from approvals where status = 'pending'",
      );
      return (rows[0]?.count ?? 0) >= 2;
    });
    const second = await approvalIdOf(pipeline, 'ACME-2');
    await pipeline.waitFor(
      'the second approval to be posted with its buttons',
      async () => buttonsFor(slack, second).length > 0,
    );
    expect(buttonsFor(slack, first)).toEqual([]);
  }, 300_000);
});
