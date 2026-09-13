/**
 * A whole pipeline, in memory, for the tests of this ring.
 *
 * It composes the real `EventBus`, the real saga handlers, the real stage executor and the real
 * interpreter over in-memory doubles, so a test can push a `ticket.matched` event in and watch a
 * task walk the template. What it deliberately does **not** contain is a job queue: `jobs` here
 * records enqueues and nothing else, and {@link PipelineHarness.drain} plays the worker by calling
 * the job handler itself.
 *
 * That is not laziness, it is standing rule 1. `packages/infrastructure` already ships an in-memory
 * `Jobs` that is held to pg-boss by a shared contract suite; a second one here would be a fake with
 * no contract test, and the first thing it would get wrong is the `stately` admission that BD-007's
 * batch window depends on. So the queue's *semantics* are asserted where the contract suite is, and
 * these tests assert what the pipeline **asks** of the queue — the queue name, the singleton key and
 * how far out `startAfter` is — which is the part that is this ring's decision.
 *
 * The clock is a value the test moves. Nothing here reads `Date.now()` (standing rule 2).
 */
import type {
  AgentRole,
  DomainEvent,
  Id,
  IsoDateTime,
  PipelineTemplate,
} from '@platform/contracts';
import { agentRoleSchema } from '@platform/contracts';
import type { RolePromptDefinition, SkillDefinition } from '@platform/domain';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { createBudgetGuard } from '../cost/guard.js';
import { costHandlers } from '../cost/runtime.js';
import { EventBus } from '../events/event-bus.js';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { createContextPackAssembler } from '../knowledge/context-pack.js';
import type { TaskCommandDependencies } from '../pipeline/commands.js';
import type { PipelineIntegrations } from '../pipeline/integrations.js';
import { staticPipelineIntegrations } from '../pipeline/integrations.js';
import type { StageExecuteData } from '../pipeline/jobs.js';
import { createStageRunPlanner, SKILLS_BY_ROLE } from '../pipeline/planner.js';
import { createPipelineRuntime, type PipelineRuntime } from '../pipeline/runtime.js';
import type { ProjectSettings } from '../pipeline/settings.js';
import { defaultProjectSettings, staticProjectSettings } from '../pipeline/settings.js';
import { createRunStopReasons } from '../pipeline/stop-reasons.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { GitProviderPort } from '../ports/integrations/git-provider.js';
import type { TaskManagementPort, TicketRefInput } from '../ports/integrations/task-management.js';
import type { EnqueueRequest, JobHandler, Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { silentLogger } from '../ports/logger.js';
import type { ClaudeRunner, RunOutcome, RunSpec, RunTranscriptSink } from '../ports/runner.js';
import { createMemoryCostStore, type MemoryCostStore } from './memory-cost.js';
import { MemoryEventing } from './memory-eventing.js';
import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
} from './memory-integrations.js';
import type { MemoryKnowledgeStore } from './memory-knowledge.js';
import { memoryKnowledgeStore } from './memory-knowledge.js';
import { createMemoryPipelineStore, type MemoryPipelineStore } from './memory-pipeline.js';

/** Enough for the longest template plus every bounded loop; a runaway pipeline passes it. */
const MAX_DISPATCHES = 500;

/** The one organisation the harness has; `cost_rollup_daily` is keyed by one (technical/03). */
export const HARNESS_ORG_ID = '00000000-0000-4000-8000-00000000e001' as Id;

/** A clock a test moves by hand; ISO-8601 because that is what the domain speaks. */
export interface TestClock {
  now(): IsoDateTime;
  advance(ms: number): void;
  get epochMs(): number;
}

export const testClock = (start = '2026-06-01T09:00:00.000Z'): TestClock => {
  let at = Date.parse(start);
  return {
    now: () => new Date(at).toISOString() as IsoDateTime,
    advance: (ms) => {
      at += ms;
    },
    get epochMs() {
      return at;
    },
  };
};

/** Sequential uuids, so a failure names a stable id. */
export const testIds = (prefix = 'aaaaaaaa'): { next(): Id } => {
  let counter = 0;
  return {
    next: () => {
      counter += 1;
      return `${prefix}-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as Id;
    },
  };
};

/** The `Jobs` port as a recorder: it accepts, it remembers, it never runs anything. */
export interface RecordingJobs extends Jobs {
  readonly enqueued: readonly EnqueueRequest[];
  readonly handlers: ReadonlyMap<string, JobHandler>;
  take(queue: string): readonly EnqueueRequest[];
  /** Only the jobs whose `startAfter` has passed on the test's clock. */
  takeDue(queue: string, nowMs: number): readonly EnqueueRequest[];
}

export const recordingJobs = (): RecordingJobs => {
  const enqueued: EnqueueRequest[] = [];
  const handlers = new Map<string, JobHandler>();
  return {
    defineQueue: async () => {},
    enqueue: async (request) => {
      enqueued.push(request as EnqueueRequest);
      return { status: 'enqueued', jobId: `job-${enqueued.length}` };
    },
    scheduleCron: async () => {},
    unscheduleCron: async () => {},
    listCronSchedules: async () => [],
    work: async (request) => {
      handlers.set(request.queue, request.handler as JobHandler);
      return { queue: request.queue, stop: async () => {} };
    },
    get enqueued() {
      return [...enqueued];
    },
    handlers,
    take: (queue) => {
      const taken = enqueued.filter((request) => request.queue === queue);
      for (const request of taken) {
        enqueued.splice(enqueued.indexOf(request), 1);
      }
      return taken;
    },
    takeDue: (queue, nowMs) => {
      const taken = enqueued.filter(
        (request) =>
          request.queue === queue &&
          (request.startAfter === undefined || request.startAfter.getTime() <= nowMs),
      );
      for (const request of taken) {
        enqueued.splice(enqueued.indexOf(request), 1);
      }
      return taken;
    },
  };
};

/** What the fake runner answers for one stage. */
export interface ScriptedRun {
  readonly status: RunOutcome['status'];
  readonly terminalReason: RunOutcome['terminalReason'];
  readonly structuredOutput?: unknown;
  readonly costUsd?: number;
  readonly error?: string | null;
  /** Written to the transcript as the `run_stopped` row's reason (WP-12). */
  readonly stopReason?: string;
  /**
   * The runner **throws** instead of returning a handle (WP-15c).
   *
   * The production runner of every build until Q52 is answered does exactly this
   * (`apps/server/src/pipeline.ts`'s `unavailableClaudeRunner`), and so does any transport error
   * once there is a transport. Before this seam existed nothing in any tier could drive the branch,
   * and the branch did not exist: a start that threw escaped both of the executor's endings and
   * left a run `running` for ever.
   */
  readonly throwsOnStart?: Error;
}

const outcomeFor = (runId: Id, scripted: ScriptedRun): RunOutcome => ({
  runId,
  status: scripted.status,
  terminalReason: scripted.terminalReason,
  sessionId: `session-${runId}`,
  numTurns: 1,
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  modelUsage: [],
  cost: { usd: scripted.costUsd ?? 0.25, is_estimate: false, price_list_id: null },
  wallMs: 1000,
  structuredOutput: (scripted.structuredOutput ?? null) as RunOutcome['structuredOutput'],
  error: scripted.error ?? null,
  redactionCount: 0,
});

export interface HarnessOptions {
  readonly projectId?: Id;
  readonly settings?: Partial<Omit<ProjectSettings, 'projectId'>>;
  /** One scripted run per stage id; a stage with no script fails the test loudly. */
  readonly runs?: Readonly<Record<string, ScriptedRun>>;
  readonly git?: Partial<GitProviderPort> | null;
  readonly taskManagement?: Partial<TaskManagementPort> | null;
  /** The binding's redactor, for a test that plants a secret in a ticket (WP-15f). */
  readonly ticketRedactor?: SecretRedactor;
  readonly reviewCommentWindowMs?: number;
  /**
   * The knowledge index the planner's context pack is built from.
   *
   * Absent means an **unindexed** project, which is what a harness without a vault honestly is:
   * `ContextPackResult` answers `not_indexed` and the prompt says so, rather than claiming the
   * project has no knowledge (WP-16's three-outcome rule). A test that wants a real pack seeds
   * `harness.knowledge` through the indexer before it publishes.
   */
  readonly knowledge?: MemoryKnowledgeStore;
  /**
   * Compose the cost ledger too (WP-19): register `costHandlers` on the bus and give the stage
   * executor a real {@link createBudgetGuard} over this store.
   *
   * Off by default, so every pipeline test written before the ledger existed keeps the handler set
   * it was written against. When it is on, the store answers `runContext` out of **this harness's
   * own** `runs` and `tasks` rows, so a ledger test charges the runs the pipeline really made.
   */
  readonly cost?: boolean;
}

export interface PipelineHarness {
  readonly memory: MemoryEventing;
  readonly bus: EventBus;
  readonly store: MemoryPipelineStore;
  readonly jobs: RecordingJobs;
  readonly runtime: PipelineRuntime;
  readonly clock: TestClock;
  readonly ids: { next(): Id };
  readonly projectId: Id;
  readonly settings: ProjectSettings;
  readonly integrations: PipelineIntegrations;
  /** The store the planner's context-pack assembler reads; seed it to get a non-empty pack. */
  readonly knowledge: MemoryKnowledgeStore;
  /** The ledger's store when `cost: true` was asked for, and `null` otherwise. */
  readonly cost: MemoryCostStore | null;
  readonly audit: ReturnType<typeof createMemoryAuditLog>;
  readonly idempotency: ReturnType<typeof createMemoryIdempotencyStore>;
  /** Every spec the runner was started with, in order. */
  readonly specs: readonly RunSpec[];
  /** What `answerTaskQuestion` and friends need (`../pipeline/commands.js`). */
  readonly commands: TaskCommandDependencies;
  script(stage: string, run: ScriptedRun): void;
  /** Appends the events and dispatches everything, running stage jobs until the loop is quiet. */
  publish(events: readonly DomainEvent[]): Promise<void>;
  drain(): Promise<void>;
  /** Every event in the log, in position order. */
  events(): readonly DomainEvent[];
  types(): readonly string[];
}

const stubGit = (overrides: Partial<GitProviderPort> | null | undefined): GitProviderPort | null =>
  overrides === null
    ? null
    : ({
        ref: {
          integrationId: '00000000-0000-4000-8000-00000000a001',
          provider: 'fake-git',
          type: 'git',
        },
        capabilities: () => ({}),
        getDefaultBranchHead: async () => ({ branch: 'main', sha: 'a'.repeat(40) }),
        isBranchProtected: async () => true,
        getPipelineStatus: async () => null,
        getMergeRequest: async () => {
          throw new Error('the test did not script getMergeRequest');
        },
        listDiscussions: async () => [],
        ...overrides,
      } as unknown as GitProviderPort);

const stubTaskManagement = (
  overrides: Partial<TaskManagementPort> | null | undefined,
): TaskManagementPort | null =>
  overrides === null
    ? null
    : ({
        ref: {
          integrationId: '00000000-0000-4000-8000-00000000a002',
          provider: 'fake-jira',
          type: 'task_management',
        },
        capabilities: () => ({}),
        /**
         * A ticket with words in it, so the harness exercises the WP-15f path by default.
         *
         * **Divergence, stated (standing rule 1):** every key answers the same ticket, where the
         * real adapter answers `not_found` for one nobody created — stricter is the safe direction
         * and this is the kind one, deliberately: the harness's tests are about the pipeline's
         * transitions, and a `readTicket` that threw would make every one of them exercise the
         * fetch's *failure* path instead. A test that wants the failure overrides `readTicket`, and
         * the real refusal is asserted against `FakeTaskManagement` (which does answer
         * `not_found`) in `ticket-snapshot.test.ts`.
         */
        readTicket: async (ref: TicketRefInput) => ({
          ref,
          issue_type: 'Story',
          title: 'Show the totals in the invoice footer',
          description: 'The footer sums the visible rows rather than all of them.',
          status: 'To Do',
          priority: null,
          labels: [],
          comments: [],
          links: [],
          epic: null,
          siblings: [],
          attachments_text: [],
          assignee: null,
          reporter: null,
          updated_at: '2026-06-01T09:00:00.000Z',
        }),
        upsertWorkpad: async () => ({
          provider: 'fake-jira',
          ticket_key: 'ACME-1',
          comment_id: 'comment-1',
          url: null,
        }),
        transition: async (_ref: unknown, to: string) => ({ changed: true, from: 'To Do', to }),
        ...overrides,
      } as unknown as TaskManagementPort);

/**
 * A role prompt per role, for the harness.
 *
 * A **double**, and the divergence is stated (standing rule 1): it is one sentence where the
 * shipped prompt in `@platform/prompts` is a page, because the application ring may not import that
 * package. The direction is harmless for what these tests assert — the pipeline's transitions do
 * not read the prompt — and `test/contract/prompts/role-prompts.contract.test.ts` is what drives
 * the **real** prompts through the real assembler.
 */
const harnessRolePrompts = (): Readonly<Record<AgentRole, RolePromptDefinition>> =>
  Object.fromEntries(
    agentRoleSchema.options.map((role) => [
      role,
      { role, version: 'harness', text: `You are the ${role}. This is the harness's prompt.` },
    ]),
  ) as Readonly<Record<AgentRole, RolePromptDefinition>>;

/**
 * A skill catalogue for the harness — the names {@link SKILLS_BY_ROLE} uses, with stub bodies.
 *
 * Stubs rather than the shipped files because this ring may not import `@platform/prompts`
 * (`biome.json`), and because what the harness exercises is the *wiring*: that a role's list
 * reaches `RunSpec.skills` and the digest reaches `prompt_version`. What the files say is held by
 * `packages/prompts`' own tests, and whether they arrive in a workspace is the e2e's (standing rule
 * 82: `FakeClaudeRunner` would pass a run whose skills were never copied).
 */
const harnessSkills = (): Readonly<Record<string, SkillDefinition>> =>
  Object.fromEntries(
    [...new Set(Object.values(SKILLS_BY_ROLE).flat())].map((name) => [
      name,
      { name, version: 'harness', text: `# ${name}\n\nThe harness's skill.\n` },
    ]),
  );

/** A UUID from the harness's id source, as the 32 hex characters the data-block nonce must be. */
const nonceFor = (id: Id): string => id.replaceAll('-', '').padEnd(32, '0').slice(0, 32);

export const createPipelineHarness = (options: HarnessOptions = {}): PipelineHarness => {
  const projectId = options.projectId ?? '00000000-0000-4000-8000-0000000000p1'.replace('p', 'b');
  const clock = testClock();
  const ids = testIds();
  const memory = new MemoryEventing();
  const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
  const store = createMemoryPipelineStore();
  const jobs = recordingJobs();
  const audit = createMemoryAuditLog();
  const knowledge = options.knowledge ?? memoryKnowledgeStore({ now: () => clock.now() });
  // Composed like production's (`apps/server/src/pipeline.ts` builds the PostgreSQL one), so the
  // pipeline's ticket writes are replayable in this tier too: a fake may be stricter than the real
  // adapter, never kinder (standing rule 1), and one with **no** store would be kinder.
  const idempotency = createMemoryIdempotencyStore();
  const scripts = new Map<string, ScriptedRun>(Object.entries(options.runs ?? {}));
  /**
   * The ledger's store, reading this harness's own `runs` and `tasks` (WP-19).
   *
   * The organisation id is the harness's one constant: the in-memory pipeline store has no
   * `organizations` table, and every rollup row needs one.
   */
  const cost =
    options.cost === true
      ? createMemoryCostStore({
          runs: async (tx, runId) => {
            const run = await store.runs.load(tx, runId);
            if (run === null) {
              return null;
            }
            const task = await store.tasks.load(tx, run.taskId);
            return {
              runId: run.id,
              taskId: run.taskId,
              projectId: run.projectId,
              orgId: HARNESS_ORG_ID,
              template: task?.task.template ?? 'feature',
              stage: run.stage,
              model: run.model,
              startedAt: run.createdAt,
            };
          },
        })
      : null;
  const specs: RunSpec[] = [];

  const gitPort = stubGit(options.git);
  const taskManagementPort = stubTaskManagement(options.taskManagement);
  const integrations: PipelineIntegrations = {
    executor: createIntegrationActionExecutor({
      auditLog: audit,
      redactor: exactSecretRedactor([]),
      // `autoAdvance`, or a rate-limit or backoff sleep inside the executor waits on a clock
      // nothing drives and the test hangs rather than fails.
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => clock.now() },
      idempotencyStore: idempotency,
    }),
    git: gitPort === null ? null : { port: gitPort, ref: gitPort.ref, project: 'acme/api' },
    taskManagement:
      taskManagementPort === null
        ? null
        : {
            port: taskManagementPort,
            ref: taskManagementPort.ref,
            // The binding's own redactor (WP-15f). A harness has no binding, so an empty exact
            // redactor is the honest double: it counts nothing and replaces nothing, which is what
            // a binding with no credentials would do. The behaviour that matters — a planted
            // secret never reaching `tasks.ticket_snapshot` — is asserted against a real one in
            // `ticket-snapshot.test.ts`, because a test whose redactor is disarmed proves nothing
            // (standing rules 31 and 35).
            redactor: options.ticketRedactor ?? exactSecretRedactor([]),
          },
  };

  const settings: ProjectSettings = defaultProjectSettings(projectId, {
    templates: SHIPPED_TEMPLATES as Readonly<Record<string, PipelineTemplate>>,
    ...options.settings,
  });

  const runner: ClaudeRunner = {
    start: (spec) => {
      specs.push(spec);
      const scripted = scripts.get(spec.stage ?? '');
      if (scripted === undefined) {
        throw new Error(`the test scripted no run for stage "${spec.stage ?? '(none)'}"`);
      }
      return {
        runId: spec.runId,
        outcome: Promise.resolve(outcomeFor(spec.runId, scripted)),
        steer: async () => {},
        stop: async () => {},
      };
    },
  };

  const stopReasons = createRunStopReasons();
  // The composition root's own sink; the pipeline wraps it exactly as `apps/server` will.
  const sink = stopReasons.observe({ append: async () => {} });

  const runtime = createPipelineRuntime({
    store,
    settings: staticProjectSettings(() => settings),
    jobs,
    // One composed set for the harness's one project. Production reads the `bindings` table
    // through `createPipelineIntegrationsLoader` (WP-15a).
    integrations: staticPipelineIntegrations(integrations),
    ids,
    clock: { now: () => clock.now() },
    unitOfWork: memory,
    ...(options.reviewCommentWindowMs === undefined
      ? {}
      : { reviewCommentWindowMs: options.reviewCommentWindowMs }),
    execution: {
      runner: wrapRunner(runner, scripts, () => clock, sink),
      planner: createStageRunPlanner({
        workspacePath: (taskId: Id) => `/workspaces/${taskId}`,
        prompts: harnessRolePrompts(),
        skills: harnessSkills(),
        // Deterministic and distinct per run: a constant would make the delimiter predictable, and
        // the executor's own ids are already the harness's one source of "unique".
        nonce: { next: () => nonceFor(ids.next()) },
        contextPacks: createContextPackAssembler({ store: knowledge, logger: silentLogger }),
        clock: { now: () => clock.now() },
      }),
      stopReasons,
      ...(cost === null ? {} : { budgets: createBudgetGuard({ store: cost }) }),
      context: (correlationId) => ({
        ids,
        actor: { kind: 'system', component: 'pipeline' },
        clock: { now: () => clock.now() },
        correlationId,
        causeEventId: null,
      }),
    },
  });

  for (const handler of runtime.handlers) {
    bus.register(handler);
  }

  if (cost !== null) {
    for (const handler of costHandlers({
      store: cost,
      context: (correlationId, causeEventId) => ({
        ids,
        actor: { kind: 'system', component: 'cost-ledger' },
        clock: { now: () => clock.now() },
        correlationId,
        causeEventId,
      }),
    })) {
      bus.register(handler);
    }
  }

  const dispatchPending = async (): Promise<number> => {
    let dispatched = 0;
    for (;;) {
      // A bounded loop with a diagnostic: a pipeline that keeps dispatching is a defect, and the
      // useful thing to report is what it was dispatching, not that the test timed out.
      if (dispatched > MAX_DISPATCHES) {
        throw new Error(
          `the pipeline dispatched more than ${MAX_DISPATCHES} events without draining; log tail: ${memory.log
            .slice(-6)
            .map((row) => `${row.position}:${row.event.type}`)
            .join(', ')}`,
        );
      }
      const pending = memory.pending;
      if (pending.length === 0) {
        return dispatched;
      }
      const next = pending[0];
      if (next === undefined) {
        return dispatched;
      }
      const stored = memory.log.find((row) => row.position === next.eventPosition) ?? null;
      if (stored === null) {
        return dispatched;
      }
      const result = await bus.dispatch(stored);
      dispatched += 1;
      if (result.status === 'failed') {
        throw new Error(
          `dispatch of ${stored.event.type} failed: ${result.handlers.find((outcome) => outcome.result === 'failed')?.error ?? 'unknown'}`,
        );
      }
      if (result.status === 'blocked' || result.status === 'busy') {
        return dispatched;
      }
    }
  };

  /**
   * Plays the worker for one queue: runs every job whose timer has come, and no others.
   *
   * A job scheduled for later is a timer, and a worker that ran it now would be a busy loop with
   * extra steps — the test moves the clock when it wants one to fire.
   */
  const runJobs = async (queue: string): Promise<number> => {
    const handler = jobs.handlers.get(queue);
    if (handler === undefined) {
      return 0;
    }
    const requests = jobs.takeDue(queue, clock.epochMs);
    for (const request of requests) {
      await handler({
        id: `job-${request.singletonKey ?? 'x'}`,
        queue: request.queue,
        data: (request.data ?? {}) as StageExecuteData,
        signal: AbortSignal.abort(),
      });
    }
    return requests.length;
  };

  let started: Promise<void> | null = null;
  const drain = async (): Promise<void> => {
    // The workers are what registers the job handlers, and `drain` is the worker here.
    started ??= runtime.start();
    await started;
    for (let round = 0; round < 200; round += 1) {
      const dispatched = await dispatchPending();
      // `pipelineOutbound` first: it is what the handlers of the dispatch just enqueued, and the
      // intake check is the job that creates the task the rest of the loop is about (WP-15d).
      const ran =
        (await runJobs(JOB_QUEUES.pipelineOutbound)) +
        (await runJobs(JOB_QUEUES.stageExecute)) +
        (await runJobs(JOB_QUEUES.mrCommentDebounce));
      if (dispatched === 0 && ran === 0) {
        return;
      }
    }
    throw new Error(
      `the pipeline did not settle in 200 rounds; last events: ${memory.log
        .slice(-8)
        .map((row) => row.event.type)
        .join(', ')}`,
    );
  };

  const commands: TaskCommandDependencies = {
    unitOfWork: memory,
    store,
    context: (correlationId) => ({
      ids,
      actor: { kind: 'system', component: 'pipeline' },
      clock: { now: () => clock.now() },
      correlationId,
      causeEventId: null,
    }),
  };

  return {
    memory,
    bus,
    store,
    jobs,
    commands,
    runtime,
    clock,
    ids,
    projectId,
    settings,
    integrations,
    knowledge,
    cost,
    audit,
    idempotency,
    specs,
    script: (stage, run) => {
      scripts.set(stage, run);
    },
    publish: async (events) => {
      await memory.transaction(async (scope) => scope.events.append(events));
      await drain();
    },
    drain,
    events: () => memory.log.map((row) => row.event),
    types: () => memory.log.map((row) => row.event.type),
  };
};

/**
 * Writes the scripted `run_stopped` row the way WP-12's adapter does — through the sink, before
 * the outcome resolves — so the executor reads the reason from the same place production puts it.
 */
const wrapRunner = (
  runner: ClaudeRunner,
  scripts: Map<string, ScriptedRun>,
  clock: () => TestClock,
  sink: RunTranscriptSink,
): ClaudeRunner => ({
  start: (spec) => {
    const scripted = scripts.get(spec.stage ?? '');
    if (scripted?.throwsOnStart !== undefined) {
      throw scripted.throwsOnStart;
    }
    const handle = runner.start(spec);
    if (scripted?.stopReason === undefined) {
      return handle;
    }
    const outcome = (async () => {
      await sink.append({
        run_id: spec.runId,
        seq: 1,
        created_at: clock().now(),
        redaction_count: 0,
        kind: 'system',
        subtype: 'run_stopped',
        data: { reason: scripted.stopReason },
      });
      return handle.outcome;
    })();
    return { ...handle, outcome };
  },
});
