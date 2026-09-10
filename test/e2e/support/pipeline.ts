/**
 * A whole pipeline on a real PostgreSQL, with fake Claude and fake providers.
 *
 * technical/10's `e2e-fake-claude` tier: "one ticket through the whole pipeline: webhook → intake →
 * stages → MR events → retro, with `FakeClaudeRunner` replaying scenario fixtures and fake
 * providers". Everything below `apps/` is the real thing —
 *
 *  - the real event store, dispatch queue and `EventBus` (`createEventing`), so ordering per stream,
 *    idempotency and chaining are the platform's, not a test double's;
 *  - the real `PipelineStore` on the migrated schema, so every transition is a row a human could
 *    query afterwards;
 *  - the real `IntegrationActionExecutor` in front of the fake providers, so the shadow guard, the
 *    audit row and the rate limiter are on the path;
 *  - the real in-memory `Jobs` adapter (held to pg-boss by a contract suite), so `stately` and
 *    `startAfter` mean what they mean in production.
 *
 * — and the two ends are fakes on purpose: the model (`FakeClaudeRunner`, replaying scenarios whose
 * artifacts must validate against the published schemas) and the providers.
 *
 * **Time is virtual.** The jobs runtime carries the clock and the test moves it; nothing here waits
 * on a real deadline (standing rule 2).
 */

import type {
  ClaudeRunner,
  Jobs,
  PipelineIntegrations,
  PipelineRuntime,
  ProjectSettings,
  RunSpec,
  TaskCommandDependencies,
} from '@platform/application';
import {
  basicStageRunPlanner,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createPipelineRuntime,
  createRunStopReasons,
  createVirtualTimer,
  defaultProjectSettings,
  exactSecretRedactor,
  staticProjectSettings,
} from '@platform/application';
import type { DomainEvent, Id, TranscriptEvent } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import {
  eventing as eventingAdapters,
  jobs as jobsAdapters,
  pipeline as pipelineAdapters,
  runner as runnerAdapters,
} from '@platform/infrastructure';
import { createFakeGitProvider, createFakeTaskManagement } from '@platform/integrations';
import pg from 'pg';
import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../../integration/support/migrated.js';

export const GIT_INTEGRATION_ID = '00000000-0000-4000-8000-00000000a001';
export const TICKETS_INTEGRATION_ID = '00000000-0000-4000-8000-00000000a002';
export const GIT_PROJECT = 'acme/api';

/** Ids the fake Claude runner hands back; sequential so a failure names a stable run. */
const sequentialIds = (prefix: string): { next(): Id } => {
  let counter = 0;
  return {
    next: () => {
      counter += 1;
      return `${prefix}-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as Id;
    },
  };
};

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

export interface PipelineE2E {
  readonly world: SeededWorld;
  readonly database: MigratedDatabase;
  readonly runtime: PipelineRuntime;
  readonly jobs: ReturnType<typeof jobsAdapters.createInMemoryJobs>;
  readonly git: ReturnType<typeof createFakeGitProvider>;
  readonly tickets: ReturnType<typeof createFakeTaskManagement>;
  readonly commands: TaskCommandDependencies;
  readonly projectId: Id;
  readonly userId: Id;
  readonly settings: ProjectSettings;
  readonly specs: readonly RunSpec[];
  /** Appends the events, then dispatches and drains until the pipeline is quiet. */
  publish(events: readonly DomainEvent[]): Promise<void>;
  drain(): Promise<void>;
  /** Every event of the log, in position order. */
  events(): Promise<readonly DomainEvent[]>;
  task(): Promise<TaskSnapshot>;
  stop(): Promise<void>;
}

export interface TaskSnapshot {
  readonly id: string;
  readonly state: string;
  readonly current_stage: string | null;
  readonly cost_actual: string;
  readonly iteration_counters: Record<string, number>;
  readonly stage_attempts: Record<string, number>;
  readonly template: string;
}

/** What the harness seeded before the scenarios are built. */
export interface SeededWorld {
  /** The merge request the developer stage will claim in its `ImplementationNotes`. */
  readonly mr: { readonly iid: number; readonly url: string; readonly headSha: string };
  readonly branch: string;
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
  readonly settings?: Partial<Omit<ProjectSettings, 'projectId'>>;
  readonly label?: string;
  /** CI status for the merge request's head commit. `null` seeds none (a project with no CI). */
  readonly ciStatus?: 'success' | 'failed' | null;
  /** Tickets the fake task-management provider knows; the workpad is written on one of them. */
  readonly tickets?: readonly {
    readonly key: string;
    readonly title: string;
    readonly issueType?: string;
  }[];
}

export const startPipeline = async (options: StartPipelineOptions): Promise<PipelineE2E> => {
  const database = await createMigratedDatabase(options.label ?? 'pipeline');
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 12 });

  const seed = await pool.query<{ project_id: string; user_id: string }>(
    `with org as (insert into organizations (name) values ('e2e') returning id),
          project as (
            insert into projects (org_id, key, name, repo_url)
            select id, 'api', 'API', 'https://git.example.test/acme/api.git' from org returning id
          ),
          human as (
            insert into users (email, name) values ('operator@example.test', 'Operator') returning id
          )
     select (select id from project) as project_id, (select id from human) as user_id`,
  );
  const projectId = seed.rows[0]?.project_id as Id;
  const userId = seed.rows[0]?.user_id as Id;

  const eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { pollIntervalMs: 50 },
  });

  // The virtual clock starts at the real instant the harness does, and never advances on its own.
  // Not a fixed date: the event log has monthly partitions and refuses a back-dated event
  // (`PartitionWindowError`), so a hard-coded 2026-06-01 would pass in June and fail in September.
  // Everything after this point is still deterministic — only the origin is real.
  // A job that exhausts its retries is silent by default, and a silent job failure looks exactly
  // like a pipeline that decided to stop. The harness surfaces it as the drain's error instead.
  const jobFailures: { queue: string; error: unknown }[] = [];
  const jobs = jobsAdapters.createInMemoryJobs({
    startTime: new Date(),
    onJobFailed: (queue, _jobId, error) => {
      jobFailures.push({ queue, error });
    },
  });
  await jobs.start();

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

  const audit = createMemoryAuditLog();
  const integrations: PipelineIntegrations = {
    executor: createIntegrationActionExecutor({
      auditLog: audit,
      redactor: exactSecretRedactor([]),
      // `autoAdvance`, or a rate-limit or backoff sleep inside the executor waits on a clock
      // nothing drives and the test hangs rather than fails.
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => jobs.now().toISOString() as never },
    }),
    git: { port: git, ref: git.ref, project: GIT_PROJECT },
    taskManagement: { port: tickets, ref: tickets.ref },
  };

  const settings: ProjectSettings = defaultProjectSettings(projectId, {
    templates: SHIPPED_TEMPLATES,
    ...options.settings,
  });

  const ids = sequentialIds('aaaaaaaa');
  const specs: RunSpec[] = [];
  const stopReasons = createRunStopReasons();
  const sink = stopReasons.observe({ append: async () => {} });

  const fake = runnerAdapters.createFakeClaudeRunner({
    sink,
    clock: { now: () => jobs.now().getTime(), setTimer: () => () => {} },
    select: (spec) => {
      const scenario = scenarios[spec.stage ?? ''];
      if (scenario === undefined) {
        throw new runnerAdapters.FakeScenarioError(`no scenario for stage "${spec.stage ?? ''}"`);
      }
      return {
        events: transcriptFor(
          spec.runId,
          jobs.now().toISOString(),
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
  const runner: ClaudeRunner = {
    start: (spec) => {
      specs.push(spec);
      return fake.start(spec);
    },
  };

  /**
   * The queue, with every handler wrapped so the *first* throw is the test's failure.
   *
   * `stage.execute` is declared with `retryLimit: 2` and a 30-second backoff, which is right in
   * production and wrong here: a handler that throws would be retried on a timer nothing advances,
   * and the test would see a pipeline that simply stopped. Recording the throw makes the cause the
   * error rather than the symptom.
   */
  const observedJobs: Jobs = {
    ...jobs.jobs,
    work: async (request) => {
      const handler = request.handler as (job: unknown) => Promise<void>;
      return jobs.jobs.work({
        ...request,
        handler: (async (job: unknown) => {
          try {
            await handler(job);
          } catch (error) {
            jobFailures.push({ queue: request.queue, error });
            throw error;
          }
        }) as typeof request.handler,
      });
    },
  };

  const store = pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const commandContext = (correlationId: Id) => ({
    ids,
    actor: { kind: 'system' as const, component: 'pipeline' },
    clock: { now: () => jobs.now().toISOString() as never },
    correlationId,
    causeEventId: null,
  });

  const runtime = createPipelineRuntime({
    store,
    settings: staticProjectSettings(() => settings),
    jobs: observedJobs,
    integrations,
    ids,
    clock: { now: () => jobs.now().toISOString() },
    unitOfWork: eventing.unitOfWork,
    execution: {
      runner,
      planner: basicStageRunPlanner({ workspacePath: (taskId) => `/workspaces/${taskId}` }),
      stopReasons,
      context: commandContext,
    },
  });
  for (const handler of runtime.handlers) {
    eventing.bus.register(handler);
  }
  await runtime.start();

  const commands: TaskCommandDependencies = {
    unitOfWork: eventing.unitOfWork,
    store,
    context: commandContext,
  };

  /** Reports a queued event whose handler failed, with the error the dispatcher recorded. */
  const assertNothingStuck = async (): Promise<void> => {
    const { rows } = await pool.query<{ event_position: string; error: string | null }>(
      `select event_position, error from event_dispatch where error is not null order by event_position`,
    );
    const stuck = rows[0];
    if (stuck !== undefined) {
      throw new Error(
        `event ${stuck.event_position} is stuck in the dispatch queue: ${stuck.error ?? 'no error recorded'}`,
      );
    }
  };

  /**
   * Dispatch everything pending, then run whatever the handlers enqueued, until neither moves.
   *
   * The outbox worker would do the first half on its own timer; driving it by hand is what keeps
   * the test deterministic — and `jobs.drain()` is the real adapter's, so the queue policies apply.
   */
  const drain = async (): Promise<void> => {
    for (let round = 0; round < 400; round += 1) {
      const sweep = await eventing.worker.drain();
      if (sweep.failed > 0) {
        throw new Error(`the dispatcher failed ${sweep.failed} event(s); see handler_executions`);
      }
      // A *chained* dispatch's failure is invisible in the sweep report — the sweep counts the
      // event it took off the queue, and a handler that fails three events deeper leaves its event
      // queued with a backoff nothing here advances. Without this the loop simply stops, and the
      // test reports the state it stopped in rather than the handler that failed.
      await assertNothingStuck();
      const due = jobs
        .snapshot()
        .filter(
          (job) => job.state === 'created' && job.startAfter.getTime() <= jobs.now().getTime(),
        );
      await jobs.drain();
      const failure = jobFailures.shift();
      if (failure !== undefined) {
        throw new Error(`the ${failure.queue} job failed: ${String(failure.error)}`, {
          cause: failure.error,
        });
      }
      // Quiet means both: nothing left in the outbox and no job whose timer has come.
      if (sweep.dispatched === 0 && due.length === 0) {
        return;
      }
    }
    throw new Error('the pipeline did not settle in 400 rounds');
  };

  return {
    world,
    database,
    runtime,
    jobs,
    git,
    tickets,
    commands,
    projectId,
    userId,
    settings,
    specs,
    publish: async (events) => {
      await eventing.unitOfWork.transaction(async (scope) => scope.events.append(events));
      await drain();
    },
    drain,
    events: async () => {
      const { rows } = await pool.query<{ payload: unknown; type: string }>(
        'select type, payload from events order by position',
      );
      return rows as unknown as readonly DomainEvent[];
    },
    task: async () => {
      const { rows } = await pool.query<TaskSnapshot>(
        `select id, state, current_stage, cost_actual, iteration_counters, stage_attempts, template
           from tasks order by created_at limit 1`,
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error('no task was created');
      }
      return row;
    },
    stop: async () => {
      await runtime.stop();
      await eventing.stop();
      await jobs.stop();
      await pool.end();
      await database.drop();
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
