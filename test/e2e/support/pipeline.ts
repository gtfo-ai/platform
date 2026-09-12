/**
 * A whole pipeline inside a whole **`apps/server` instance**, on a real PostgreSQL — WP-15a.
 *
 * Until WP-15a this file composed its own `createPipelineRuntime`, which is what WP-15's own
 * acceptance criterion allowed and what made "M1 complete" a claim about a test harness rather than
 * about the product. It no longer does. `startInstance` starts the real composition root
 * (`apps/server/src/runtime.ts`), and everything the pipeline runs on is what a container runs on:
 *
 *  - the real event store, dispatch queue and outbox **worker** on its own timer — nothing here
 *    calls `drain()`, so ordering, chaining and idempotency are the dispatcher's;
 *  - the real **pg-boss** jobs runtime, so `stage.execute`'s queue policy, `stately` and
 *    `startAfter` are pg-boss's and not an in-memory double's;
 *  - the real **binding loader**, reading `bindings` joined to `integrations` and decrypting
 *    `secrets` with `APP_SECRET_KEY`, which is the whole point of the work package: the test seeds
 *    *rows*, not objects.
 *
 * Two ends are still fakes, and they are the two technical/10 names for this tier: the model
 * (`FakeClaudeRunner`) and the providers. The providers arrive through the **registry**, so the
 * loader, the decryption, the config validation and the redactor composition in front of them are
 * all production code — only the thing on the far side of the HTTP call is a double.
 *
 * ## Time is real here, and that is the trade
 *
 * The old harness moved a virtual clock and played the worker by hand, which made it deterministic
 * and made it a harness. A real instance owns its own timers, so this waits: {@link PipelineE2E
 * .settle} polls the database for the state a test is waiting for and fails with the dispatcher's
 * own recorded error if a handler died on the way. The poll intervals are turned down
 * (`APP_JOBS_POLL_INTERVAL_SECONDS`, `APP_DISPATCH_POLL_INTERVAL_MS`) rather than the assertions
 * being given generous sleeps — standing rule 2: a wall-clock assertion is a hardware assertion, so
 * nothing below asserts *how long* anything took, only that it arrived.
 */

import { randomUUID } from 'node:crypto';
import type { ClaudeRunner, Jobs, PlatformToolPort, RunSpec } from '@platform/application';
import type {
  DomainEvent,
  Id,
  JsonObject,
  JsonValue,
  TicketSnapshot,
  TranscriptEvent,
} from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import {
  eventing as eventingAdapters,
  runner as runnerAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import type { IntegrationRegistry } from '@platform/integrations';
import {
  createFakeGitProvider,
  createFakeTaskManagement,
  createIntegrationRegistry,
  FAKE_TASK_MANAGEMENT_PROVIDER_ID,
  fakeGitRegistration,
  fakeTaskManagementRegistration,
} from '@platform/integrations';
import pg from 'pg';
import type { MigratedDatabase } from '../../integration/support/migrated.js';
import {
  type AgentRunCapture,
  PLANTED_MODEL_KEY,
  scriptedWorkspaces,
  type WorkspaceRelease,
} from './agent-workspace.js';
import { type Instance, startInstance } from './instance.js';

export const GIT_INTEGRATION_ID = '00000000-0000-4000-8000-00000000a001' as Id;
export const TICKETS_INTEGRATION_ID = '00000000-0000-4000-8000-00000000a002' as Id;
export const GIT_PROJECT = 'acme/api';

/** Obviously fake, and the value the redaction assertions look for. */
export const GIT_BINDING_TOKEN = 'FAKE-git-binding-token-not-a-real-secret';
export const TICKET_BINDING_TOKEN = 'FAKE-ticket-binding-token-not-a-real-secret';

/** The instance's own `APP_SECRET_KEY`; the seeded `secrets` rows are sealed under it. */
const APP_SECRET_KEY = 'e2e-test-secret-key-not-a-real-secret-0000';

/** How long a test waits for the instance's own timers before calling it a failure. */
const SETTLE_TIMEOUT_MS = 90_000;
const SETTLE_POLL_MS = 50;

export interface ScenarioSpec {
  readonly structuredOutput: unknown;
  readonly costUsd?: number;
}

const transcriptFor = (runId: Id, at: string, text: string): TranscriptEvent[] => [
  {
    run_id: runId,
    seq: 1,
    created_at: at,
    redaction_count: 0,
    kind: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text }],
  },
];

export interface TaskSnapshot {
  readonly id: string;
  readonly state: string;
  readonly current_stage: string | null;
  readonly cost_actual: string;
  readonly iteration_counters: Record<string, number>;
  readonly stage_attempts: Record<string, number>;
  readonly template: string;
  /** `tasks.ticket_snapshot` — the ticket's own words, or null when the platform never read it. */
  readonly ticket_snapshot: TicketSnapshot | null;
  readonly ticket_snapshot_at: Date | null;
}

/** What the harness seeded before the scenarios are built. */
export interface SeededWorld {
  /** The merge request the developer stage will claim in its `ImplementationNotes`. */
  readonly mr: { readonly iid: number; readonly url: string; readonly headSha: string };
  readonly branch: string;
}

/** One `integration_actions` row, as the e2e reads it back. */
export interface IntegrationActionRow {
  readonly action: string;
  readonly status: string;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly redaction_count: number;
  readonly attempts: number;
  readonly payload: JsonObject;
}

/** One `kb_search` a run made through the production `PlatformToolPort`. */
export interface KbSearchCall {
  readonly stage: string;
  readonly result: unknown;
}

export interface PipelineE2E {
  readonly instance: Instance;
  readonly world: SeededWorld;
  readonly database: MigratedDatabase;
  readonly git: ReturnType<typeof createFakeGitProvider>;
  readonly tickets: ReturnType<typeof createFakeTaskManagement>;
  readonly projectId: Id;
  readonly userId: Id;
  readonly specs: readonly RunSpec[];
  /**
   * Every `kb_search` the runs made, awaited — see {@link StartPipelineOptions.kbSearchQuery}.
   *
   * A promise per call rather than a mutable array: the tool answer arrives after `start` returns,
   * so an array read at assertion time is a race, and a race in a harness is a flake in every test
   * that uses it (standing rule 76).
   */
  kbSearches(): Promise<readonly KbSearchCall[]>;
  /**
   * The `integration_actions` rows the **production** audit-log adapter wrote (WP-15b).
   *
   * Read from the database rather than from a recorder the harness supplied, which is the whole
   * point: nothing in this tier passes an `IntegrationAuditLog` any more, so an assertion on these
   * rows is an assertion about the adapter `apps/server` composes for itself (standing rules 31/35).
   */
  auditRows(): Promise<readonly IntegrationActionRow[]>;
  /** Appends the events exactly as an inbound webhook adapter would, and returns. */
  publish(events: readonly DomainEvent[]): Promise<void>;
  /** Waits for the instance's own workers to reach a task state, or fails naming what it saw. */
  settle(what: string, predicate: (task: TaskSnapshot) => boolean): Promise<TaskSnapshot>;
  /**
   * Waits for anything else the pipeline causes — a provider side effect, a row in another table.
   *
   * Separate from {@link settle} because **a task state is not its own consequences**. The status
   * mapping and the workpad are handlers in TD-005's integrations band (priority 100–199), so they
   * run *after* the core handler that wrote `tasks.state` has committed: a test that settles on
   * `ready_for_merge` and then reads the ticket is asserting one transaction's effect against
   * another's timing, and it fails a few runs in a hundred with the previous status still in place.
   *
   * **And the wait must be on exactly what the test then asserts** — not on a nearer consequence.
   * That is the second half of the same lesson and it cost a second round: the workpad assertion
   * waited on the *ticket status*, which is handler **110**, and then read the *workpad body*, which
   * is handler **120**. Priority order guarantees 110 commits first, so the wait could never be
   * sufficient; it passed most of the time only because the two handlers finish inside one 50 ms
   * poll. Not a rare interleaving — a structurally short wait with a high pass rate, which is the
   * worse kind. Standing rule 50's frame: bound the **silence** you care about, not something that
   * happens to precede it. So: whatever line the test asserts, wait for *that* line.
   *
   * **WP-15d moved what that ordering rests on, and the wait has to move with it.** Neither handler
   * calls the provider any more: each enqueues a `pipeline.outbound` job after its own commit, and
   * one worker serves that queue, so the status still normally reaches the ticket before the render
   * — in the order the handlers decided, which is the useful half of the old guarantee. What is
   * gone is the *guarantee*: two jobs enqueued microseconds apart are ordered by pg-boss, not by
   * TD-005's bands. A test that asserts both must therefore wait for **both**, which is what
   * `pipeline.e2e.test.ts` now does, and no test may infer one from the other.
   */
  waitFor(what: string, check: () => Promise<boolean>): Promise<void>;
  /** Every event of the log, in position order. */
  events(): Promise<readonly DomainEvent[]>;
  task(): Promise<TaskSnapshot>;
  /**
   * Is this event still on TD-005's dispatch queue?
   *
   * The queue row is deleted when every handler of the event has committed, so `false` is "the
   * dispatcher got to it" — the one question the WP-15d measurement asks of an event that has
   * nothing to do with the provider call holding the pipeline up.
   */
  awaitingDispatch(eventId: string): Promise<boolean>;
  /** How many task rows exist, for a measurement that publishes more than one ticket. */
  taskCount(): Promise<number>;
  /**
   * Posts a provider delivery to the instance's own `/webhooks/:provider/:integrationId` (WP-15c).
   *
   * The one path in this harness that is **not** a shortcut: `publish` appends events the way an
   * adapter would, and this makes the instance do it — through the real route, the real content-type
   * parser, the real loader, the real signature check and the real `inbox`.
   */
  deliver(delivery: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  }): Promise<{ readonly status: number; readonly body: unknown }>;
  /** Every `inbox` row, for the dedup assertions. */
  inbox(): Promise<readonly { provider: string; delivery_id: string; verified: boolean }[]>;
  /**
   * One entry per run the instance actually started, with the scripted CLI it drove — empty unless
   * {@link StartPipelineOptions.agent} is `real-over-fake-cli`.
   *
   * `cli.stdin` is "every frame the SDK wrote to stdin, parsed" and `cli.spawnOptions` is what the
   * SDK passed the spawn: between them they are the **bytes the CLI received**, which is the only
   * place a claim about the prompt can be falsified.
   */
  readonly agentRuns: readonly AgentRunCapture[];
  /** How each run's workspace was released, in order. Empty in `fake-runner` mode. */
  readonly workspaceReleases: readonly WorkspaceRelease[];
  /** Every `run_messages` row the production sink wrote, in order. */
  transcript(): Promise<readonly TranscriptRow[]>;
  stop(): Promise<void>;
}

/** One `run_messages` row, as the e2e reads it back. */
export interface TranscriptRow {
  readonly run_id: string;
  readonly seq: number;
  readonly kind: string;
  readonly payload: JsonObject;
  readonly search_text: string | null;
  readonly redaction_count: number;
  readonly size_bytes: number;
}

export interface StartPipelineOptions {
  /**
   * One scenario per stage id; a stage with no scenario is an error the fake raises.
   *
   * A function of the seeded world, because the `ImplementationNotes` a developer produces name the
   * merge request it opened — and in production the agent opens it through the platform tool, so
   * the iid is the provider's to choose, not the fixture's.
   */
  readonly scenarios: (world: SeededWorld) => Readonly<Record<string, ScenarioSpec>>;
  readonly label?: string;
  /** CI status for the merge request's head commit. `null` seeds none (a project with no CI). */
  readonly ciStatus?: 'success' | 'failed' | null;
  /** Tickets the fake task-management provider knows; the workpad is written on one of them. */
  readonly tickets?: readonly {
    readonly key: string;
    readonly title: string;
    readonly issueType?: string;
  }[];
  /** `projects.config` — technical/12's effective configuration, as the settings port reads it. */
  readonly config?: JsonObject;
  /**
   * Delay every `upsertWorkpad` by this many milliseconds, to force the interleaving that used to
   * make the workpad assertion flaky roughly one run in five (backlog 1b, standing rule 76).
   *
   * It is **not** load and it is not a sleep in an assertion: it widens one already-existing window
   * so that a test waiting on the wrong line fails **every** time instead of rarely. A flake you
   * can only wait for is one you cannot prove fixed.
   *
   * **Which window, since WP-15d.** It used to be the gap between the status handler (TD-005
   * priority 110) and the workpad handler (120) *inside one dispatch*. Neither handler calls the
   * provider now: each enqueues a `pipeline.outbound` job after its own commit, and one worker runs
   * that queue in the order they were enqueued — so the delay lands on the render **after** the
   * status transition has already reached the ticket, which is the same window with the same sign.
   * A test that waits for the status and then reads the workpad body still fails deterministically;
   * a test that asserts both must wait for both, because the ordering is now the queue's rather
   * than TD-005's.
   */
  readonly workpadDelayMs?: number;
  /**
   * Awaited before **every git read the intake makes** — the default-branch head and the branch
   * protection — so a test can hold one open and ask what the rest of the instance can still do.
   *
   * It is the knob WP-15d's measurement needs and nothing else: a provider call is the one thing
   * on the pipeline's path whose latency is somebody else's, so the question "what does the
   * platform stop doing while a provider is slow?" cannot be asked without being able to make one
   * slow. A promise the test resolves is used rather than a sleep, so the assertion is about what
   * happened *while the call was in flight* rather than about a duration (standing rule 2).
   */
  readonly gitReadLatency?: () => Promise<void>;
  /**
   * When set, every run whose role may call `kb_search` calls it once with this query, through the
   * production `PlatformToolPort` the instance composed.
   *
   * The fake Claude runner does not call platform tools (divergence 6 of its register), so there is
   * no other way to ask "is `kb_search` callable from a run?" of a **composed** instance — which is
   * one of WP-17's acceptance criteria and the reason `PipelineComposition.runner` is a factory
   * over the tools rather than a runner.
   */
  readonly kbSearchQuery?: string;
  /** Extra environment for the instance — `APP_DB_POOL_MAX` at the shipped default, say. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Wraps the `Jobs` the pipeline enqueues through — the labelled seam of
   * {@link PipelineComposition.jobs} (WP-15c).
   *
   * Its one user is `intake-recovery.e2e.test.ts`, which drops the intake wake-up to reproduce the
   * loss PROGRESS backlog 20 is about: `afterCommit` is at-most-once, so a process that dies
   * between the intake handler's commit and its enqueue leaves a matched ticket with no task row.
   * Dropping the enqueue is the same loss and is deterministic, where killing a process at a
   * microsecond boundary is not.
   */
  readonly jobs?: (jobs: Jobs) => Jobs;
  /**
   * Which runner the instance composes (WP-15g).
   *
   * `fake-runner` (the default, and what six e2e files use) passes `PipelineComposition.runner` and
   * drives `FakeClaudeRunner`, which picks its scenario from `spec.stage` and never reads the prompt.
   * `real-over-fake-cli` passes a **workspace provisioner** instead, so the instance composes the
   * *production* `createClaudeRunner` — the real SDK `query()`, the real control protocol, the real
   * `run_messages` sink, the real per-run redactor — and the only double is the scripted CLI process
   * (`./agent-workspace.ts`). It is the only mode in which an assertion about the prompt can fail
   * (standing rule 82), and it is also the mode that needs a model credential, which the harness
   * plants.
   *
   * `none` passes **neither** seam and no credential, which is the state every production process is
   * in today (Q52): the instance composes `unavailableClaudeRunner`, logs which piece is missing, and
   * still runs intake, the gates, the status mapping, the workpad and every outbound provider call.
   * It is Q59(b)'s acceptance case.
   */
  readonly agent?: 'fake-runner' | 'real-over-fake-cli' | 'none';
  /**
   * Start against a database another instance already used, and do not seed it again.
   *
   * One test needs this: the handover that shows an uncomposed instance **queued** a
   * `ticket.matched` instead of consuming it. See `uncomposed.e2e.test.ts`.
   */
  readonly reuse?: { readonly database: MigratedDatabase; readonly projectId: Id };
}

/**
 * Seeds the rows the loader reads: an organisation, a project, a user, two integrations with a
 * sealed credential each, and a binding per integration.
 *
 * Sealed with the **real** envelope under the instance's own `APP_SECRET_KEY`, so the decryption
 * path in `PostgresSecretStore` is executed rather than stubbed. A fixture that inserted plaintext
 * would leave the one piece of this work package that touches a credential untested.
 */
export const seedWorld = async (
  pool: pg.Pool,
  config: JsonObject,
): Promise<{ projectId: Id; userId: Id }> => {
  const key = secretAdapters.deriveSecretKey(APP_SECRET_KEY);
  const seed = await pool.query<{ project_id: string; user_id: string }>(
    `with org as (insert into organizations (name) values ('e2e') returning id),
          project as (
            insert into projects (org_id, key, name, repo_url, config)
            select id, 'api', 'API', 'https://git.example.test/acme/api.git', $1::jsonb from org
            returning id
          ),
          human as (
            insert into users (email, name) values ('pipeline@example.test', 'Operator') returning id
          )
     select (select id from project) as project_id, (select id from human) as user_id`,
    [JSON.stringify(config)],
  );
  const projectId = seed.rows[0]?.project_id as Id;
  const userId = seed.rows[0]?.user_id as Id;

  const orgId = (
    await pool.query<{ org_id: string }>('select org_id from projects where id = $1', [projectId])
  ).rows[0]?.org_id as string;

  const bind = async (
    integrationId: Id,
    type: string,
    provider: string,
    name: string,
    integrationConfig: JsonObject,
    token: string,
  ): Promise<void> => {
    // The id is generated here rather than by the column default: it is in the envelope's AAD, so
    // it has to exist before the ciphertext does (`envelope.ts`).
    const secretId = randomUUID();
    const secret = await pool.query<{ id: string }>(
      'insert into secrets (id, ciphertext, key_id) values ($1, $2, $3) returning id',
      [
        secretId,
        secretAdapters.sealSecret(key, secretAdapters.secretDocument('token', token), secretId),
        key.keyId,
      ],
    );
    await pool.query(
      `insert into integrations (id, org_id, type, provider, name, config, secret_ids)
       values ($1, $2, $3::integration_type, $4, $5, $6::jsonb, array[$7::uuid])`,
      [
        integrationId,
        orgId,
        type,
        provider,
        name,
        JSON.stringify(integrationConfig),
        secret.rows[0]?.id,
      ],
    );
    await pool.query('insert into bindings (project_id, integration_id) values ($1, $2)', [
      projectId,
      integrationId,
    ]);
  };

  await bind(
    GIT_INTEGRATION_ID,
    'git',
    'fake-git',
    'acme fake git',
    { project: GIT_PROJECT },
    GIT_BINDING_TOKEN,
  );
  await bind(
    TICKETS_INTEGRATION_ID,
    'task_management',
    'fake-task-management',
    'acme fake tickets',
    {},
    TICKET_BINDING_TOKEN,
  );

  return { projectId, userId };
};

export const startPipeline = async (options: StartPipelineOptions): Promise<PipelineE2E> => {
  const git = createFakeGitProvider({
    integrationId: GIT_INTEGRATION_ID,
    projects: [{ path: GIT_PROJECT, defaultBranch: 'main' }],
  });
  const tickets = createFakeTaskManagement({
    integrationId: TICKETS_INTEGRATION_ID,
    tickets: options.tickets ?? [],
  });

  // The merge request the Implementation stage will report. In production the developer agent opens
  // it with the `open_mr` platform tool; the fake Claude runner does not call tools (its divergence
  // 6), so the harness opens it and the scenario reports what the provider chose.
  const branch = 'agentic/acme-1';
  const seededMr = await git.openMergeRequest({
    project: GIT_PROJECT,
    branch,
    target: 'main',
    title: 'Draft: sum the invoice footer',
    description: 'Opened by the developer stage.',
    draft: true,
    labels: ['agentic'],
    reviewers: [],
    remove_source_branch: true,
  });
  if (options.ciStatus !== null) {
    git.setPipeline({
      project: GIT_PROJECT,
      headSha: seededMr.head_sha,
      status: options.ciStatus ?? 'success',
      jobs:
        options.ciStatus === 'failed'
          ? [{ name: 'test:unit', status: 'failed', log: 'FAIL src/totals.test.ts' }]
          : [{ name: 'test:unit', status: 'success' }],
    });
  }
  const world: SeededWorld = {
    mr: { iid: seededMr.ref.iid, url: seededMr.web_url, headSha: seededMr.head_sha },
    branch,
  };
  const scenarios = options.scenarios(world);

  const specs: RunSpec[] = [];

  const fake = runnerAdapters.createFakeClaudeRunner({
    sink: { append: async () => {} },
    clock: { now: () => Date.now(), setTimer: () => () => {} },
    select: (spec) => {
      const scenario = scenarios[spec.stage ?? ''];
      if (scenario === undefined) {
        throw new runnerAdapters.FakeScenarioError(`no scenario for stage "${spec.stage ?? ''}"`);
      }
      return {
        events: transcriptFor(
          spec.runId,
          new Date().toISOString(),
          `${spec.stage ?? 'stage'} did its work`,
        ),
        status: 'completed',
        terminalReason: 'success',
        numTurns: 3,
        usage: {
          input_tokens: 1200,
          output_tokens: 400,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        modelUsage: [],
        cost: { usd: scenario.costUsd ?? 0.4, is_estimate: false, price_list_id: null },
        structuredOutput: scenario.structuredOutput,
        error: null,
      };
    },
  });
  /**
   * Every `kb_search` the harness's runs made, through the **production** `PlatformToolPort`.
   *
   * The fake Claude runner does not call platform tools (its divergence 6), so the call is made
   * here, from inside `start`, with the `PlatformToolContext` the real runner would build from the
   * spec. That is what makes "`kb_search` is callable from a run" an assertion about the composition
   * rather than about a unit: the port, the PostgreSQL knowledge store and the pool all come from
   * `composePipeline`, and the only double is the thing standing in for the model.
   */
  const kbSearchCalls: Promise<KbSearchCall>[] = [];
  const runner = (tools: PlatformToolPort): ClaudeRunner => ({
    start: (spec) => {
      specs.push(spec);
      const query = options.kbSearchQuery;
      if (query !== undefined && spec.platformTools.includes('kb_search')) {
        kbSearchCalls.push(
          tools
            .kbSearch(
              { query },
              {
                runId: spec.runId,
                taskId: spec.taskId,
                projectId: spec.projectId,
                mode: spec.mode,
                signal: new AbortController().signal,
              },
            )
            .then((result: JsonValue) => ({ stage: spec.stage ?? '', result })),
        );
      }
      return fake.start(spec);
    },
  });

  if (options.workpadDelayMs !== undefined) {
    const upsert = tickets.upsertWorkpad.bind(tickets);
    (tickets as { upsertWorkpad: typeof tickets.upsertWorkpad }).upsertWorkpad = async (
      ref,
      marker,
      markdown,
    ) => {
      await new Promise((resolve) => setTimeout(resolve, options.workpadDelayMs));
      return upsert(ref, marker, markdown);
    };
  }

  if (options.gitReadLatency !== undefined) {
    const { gitReadLatency } = options;
    const head = git.getDefaultBranchHead.bind(git);
    const protectedBranch = git.isBranchProtected.bind(git);
    const slow = git as {
      getDefaultBranchHead: typeof git.getDefaultBranchHead;
      isBranchProtected: typeof git.isBranchProtected;
    };
    slow.getDefaultBranchHead = async (project) => {
      await gitReadLatency();
      return head(project);
    };
    slow.isBranchProtected = async (project, branch) => {
      await gitReadLatency();
      return protectedBranch(project, branch);
    };
  }

  // The fakes reach the pipeline the way a real provider does: through the registry, resolved by
  // the `provider` column of the seeded `integrations` row (WP-15a).
  const registry = (): IntegrationRegistry =>
    createIntegrationRegistry([
      fakeGitRegistration({ port: git, token: GIT_BINDING_TOKEN }),
      fakeTaskManagementRegistration({ port: tickets, token: TICKET_BINDING_TOKEN }),
    ]);

  /**
   * The `real-over-fake-cli` half (WP-15g): a provisioner whose process is a scripted CLI, and the
   * production runner above it.
   *
   * Built unconditionally so the closure is one shape, and only *passed* in that mode — passing both
   * seams would let `composition.runner` win and the mode would silently be the old one.
   */
  const scripted = scriptedWorkspaces(
    (stage) => {
      const scenario = scenarios[stage];
      if (scenario === undefined) {
        throw new Error(`no scenario for stage "${stage}"`);
      }
      return scenario;
    },
    (spec) => {
      specs.push(spec);
    },
  );
  const realRunner = options.agent === 'real-over-fake-cli';
  const noRunner = options.agent === 'none';

  const instance = await startInstance({
    label: options.label ?? 'pipeline',
    ...(options.reuse === undefined ? {} : { database: options.reuse.database }),
    env: {
      APP_SECRET_KEY,
      // Turn the instance's own timers down rather than sleeping in the assertions.
      APP_JOBS_POLL_INTERVAL_SECONDS: '0.5',
      APP_DISPATCH_POLL_INTERVAL_MS: '25',
      // The dispatcher's floor plus the pipeline's job workers (`pipeline/runtime.ts`).
      APP_DB_POOL_MAX: '16',
      // The credential `composeAgentRunner` refuses to compose a runner without in `api` mode. It is
      // planted rather than absent precisely so the redaction assertions have something to look for.
      ...(realRunner ? { ANTHROPIC_API_KEY: PLANTED_MODEL_KEY } : {}),
      ...options.env,
    },
    // No `auditLog` and no `idempotency`: the instance builds both from its own pool (WP-15b).
    pipeline: {
      registry,
      ...(realRunner ? { workspaces: scripted.provisioner } : {}),
      ...(realRunner || noRunner ? {} : { runner }),
      ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
    },
  });

  const pool = new pg.Pool({ connectionString: instance.database.connectionString, max: 4 });
  const { projectId, userId } =
    options.reuse === undefined
      ? await seedWorld(pool, options.config ?? {})
      : { projectId: options.reuse.projectId, userId: options.reuse.projectId };

  // An inbound adapter's half of the append: a webhook endpoint writes the normalised events in a
  // transaction of its own and the instance's outbox worker picks them up. WP-15a does not build
  // that endpoint, so the harness performs the same append.
  const inbound = eventingAdapters.createEventing({
    pool,
    connectionString: instance.database.connectionString,
    config: { maxConcurrency: 1 },
  });

  const stuckDispatch = async (): Promise<string | null> => {
    const { rows } = await pool.query<{ event_position: string; error: string | null }>(
      'select event_position, error from event_dispatch where error is not null order by event_position',
    );
    const stuck = rows[0];
    return stuck === undefined
      ? null
      : `event ${stuck.event_position} is stuck in the dispatch queue: ${stuck.error ?? 'no error recorded'}`;
  };

  const task = async (): Promise<TaskSnapshot> => {
    const { rows } = await pool.query<TaskSnapshot>(
      `select id, state, current_stage, cost_actual, iteration_counters, stage_attempts, template,
              ticket_snapshot, ticket_snapshot_at
         from tasks order by created_at limit 1`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('no task was created');
    }
    return row;
  };

  return {
    instance,
    world,
    database: instance.database,
    git,
    tickets,
    projectId,
    userId,
    specs,
    agentRuns: scripted.runs,
    workspaceReleases: scripted.releases,
    transcript: async () => {
      const { rows } = await pool.query<TranscriptRow>(
        `select run_id, seq, kind, payload, search_text, redaction_count, size_bytes
           from run_messages order by created_at, seq`,
      );
      return rows;
    },
    kbSearches: async () => Promise.all(kbSearchCalls),
    auditRows: async () => {
      const { rows } = await pool.query<IntegrationActionRow>(
        `select action, status, project_id, task_id, redaction_count, attempts, payload
           from integration_actions order by created_at, id`,
      );
      return rows;
    },
    publish: async (events) => {
      await inbound.unitOfWork.transaction(async (scope) => scope.events.append(events));
    },
    settle: async (what, predicate) => {
      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      let last: TaskSnapshot | null = null;
      for (;;) {
        const stuck = await stuckDispatch();
        if (stuck !== null) {
          throw new Error(`${stuck} (waiting for ${what})`);
        }
        last = await task().catch(() => null);
        if (last !== null && predicate(last)) {
          return last;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `the pipeline never reached ${what}; the task is ${
              last === null
                ? 'not created'
                : `state=${last.state} stage=${last.current_stage ?? 'none'}`
            }`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      }
    },
    waitFor: async (what, check) => {
      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      for (;;) {
        const stuck = await stuckDispatch();
        if (stuck !== null) {
          throw new Error(`${stuck} (waiting for ${what})`);
        }
        if (await check()) {
          return;
        }
        if (Date.now() > deadline) {
          const snapshot = await task().catch(() => null);
          throw new Error(
            `the pipeline never reached ${what}; the task is ${
              snapshot === null
                ? 'not created'
                : `state=${snapshot.state} stage=${snapshot.current_stage ?? 'none'}`
            }`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      }
    },
    events: async () => {
      // `actor` and `cause_event_id` are read too: WP-15c's recovery is identified by the **system
      // actor** it stamps on a re-emitted `ticket.matched`, and a test that could not see the actor
      // could not tell a re-emission from the delivery that preceded it.
      const { rows } = await pool.query<{ id: string; payload: unknown; type: string }>(
        'select id, type, payload, actor, cause_event_id from events order by position',
      );
      return rows as unknown as readonly DomainEvent[];
    },
    task,
    awaitingDispatch: async (eventId) => {
      const { rows } = await pool.query<{ pending: number }>(
        `select count(*)::int as pending
           from event_dispatch d join events e on e.position = d.event_position
          where e.id = $1`,
        [eventId],
      );
      return (rows[0]?.pending ?? 0) > 0;
    },
    taskCount: async () => {
      const { rows } = await pool.query<{ count: number }>('select count(*)::int from tasks');
      return rows[0]?.count ?? 0;
    },
    deliver: async (delivery) => {
      const response = await fetch(
        `${instance.baseUrl}/webhooks/${FAKE_TASK_MANAGEMENT_PROVIDER_ID}/${TICKETS_INTEGRATION_ID}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...delivery.headers },
          body: delivery.body,
        },
      );
      const text = await response.text();
      return { status: response.status, body: text === '' ? null : JSON.parse(text) };
    },
    inbox: async () => {
      const { rows } = await pool.query<{
        provider: string;
        delivery_id: string;
        verified: boolean;
      }>('select provider, delivery_id, verified from inbox order by received_at');
      return rows;
    },
    stop: async () => {
      await inbound.stop();
      await pool.end();
      await instance.stop();
    },
  };
};

/** An inbound event as a provider adapter would append it. */
let stream = 0;
export const inboundEvent = <T extends DomainEvent['type']>(
  type: T,
  payload: Extract<DomainEvent, { type: T }>['payload'],
): DomainEvent => {
  stream += 1;
  const suffix = stream.toString(16).padStart(12, '0');
  return domainEventSchemasByType[type].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: 'project',
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: {
      kind: 'integration',
      integration_id: TICKETS_INTEGRATION_ID,
      provider: 'fake-task-management',
    },
    occurred_at: new Date().toISOString(),
    type,
    payload,
  }) as DomainEvent;
};
