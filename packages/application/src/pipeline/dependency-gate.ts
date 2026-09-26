/**
 * The dependency gate — product/04:58, product/18:43, BD-030, Q84 (WP-38).
 *
 * > *"Adding a third-party dependency follows the project policy (`ask` by default → a question
 * > with license and maintenance status; `allow` for allow-listed packages; `block`)."*
 *
 * A handler that decides and a `pipeline.outbound` duty that calls, which is the shape WP-15d
 * requires of anything that reaches a provider. It closes the gap PROGRESS recorded at this row:
 * `policies.dependency_policy` shipped with a default and **no reader anywhere**, and nothing in
 * the platform could see a dependency being added — `changedPathsOf` keeps paths and throws every
 * patch away.
 *
 * ## When it fires, and why that is the Developer stage rather than the rebase gate
 *
 * On `task.stage.completed` for the stage that produces `ImplementationNotes` — which is
 * product/04's own placement (S3, the Developer stage) and is the first moment a diff exists. Two
 * consequences follow from that choice and are the reason for it:
 *
 *  - the merge request is on the task row by the time this runs. `recordMergeRequest` is the core
 *    band's handler for the same event (priority 10) and this one is in the integrations band
 *    (120), so TD-005's ordering *within one event* does the work no extra trigger would;
 *  - a `block` returns to the stage that added the package while the change is still the developer's
 *    to undo, rather than after review and CI have been spent on it.
 *
 * Every re-run of the implementation stage re-checks, because each one completes: a package added
 * on the fifth push is gated like one added on the first.
 *
 * ## The three endings, and what each leaves behind
 *
 * Every ending writes `tasks.dependencies` first — the record the Checks panel reads — and then
 * does exactly one countable thing (standing rule 79: the assertion is the row, never a status):
 *
 *  - **allow** — nothing. Zero questions, zero returns, one record whose `decision` is `allow`
 *    (or `none` when the diff touched no manifest at all).
 *  - **ask** — one `questions` row, blocking, whose text names the packages with their licence and
 *    maintenance status, and the task moves to `waiting_answers`. It is the **existing** question
 *    gate: the same aggregate, the same `task.question.asked`, the same saga that resumes the stage
 *    when it is answered and escalates when it expires — and, since WP-56, the same deadline: it
 *    is created with `questionDeadlineRule` and `pipeline.deadlines` arms its timer, so it expires
 *    after the project's `question_timeout` on the working calendar like any other question. No
 *    second mechanism is introduced here.
 *  - **block** — one `task.stage.returned` back to the stage that produced the notes, carrying a
 *    reason that names the package, and it spends the **`dependency_policy`** loop (BD-008's
 *    family, default 2). A loop of its own rather than the leaving stage's, because this job fires
 *    whenever the queue reaches it: measured on the e2e, a blocked package spent two `rebase`
 *    rounds and then three **`human_rounds`**, and escalated with *"human_rounds iteration limit of
 *    3 reached: the project's dependency policy blocks npm:lodash"* — a bound nobody had spent,
 *    named after a loop nobody had been round (standing rule 81, and the defect
 *    `RETURN_LOOPS_BY_EDGE` exists for). The escalation at the end of the bound is still
 *    `returnToStage`'s own.
 *
 * ## What one implementation completion costs a provider
 *
 * One `get_merge_request_diff` (up to {@link MAX_CONFLICT_FILES} files, with their patches), and
 * then at most {@link MAX_METADATA_LOOKUPS} registry lookups — **zero** of them unless an operator
 * has declared a registry host (`APP_DEPENDENCY_REGISTRY_HOSTS`, empty by default, Q84 and backlog
 * 48). The diff is read even when the policy is `allow` everywhere, because the Checks panel's
 * dependency item is the product's other half and a panel that says nothing is indistinguishable
 * from a gate that did not run.
 *
 * ## Everything here is untrusted text (BD-022)
 *
 * A package name and a manifest path come out of somebody's diff — in a fork workflow, out of a
 * contributor's. They are redacted through the git binding's redactor before they are compared,
 * stored, put in a question or handed back to a stage as a return reason, exactly as
 * `conflict-warning.ts` does and for the same reason; the registry's licence string is
 * third-party text and is bounded at the write. Nothing here interpolates either into a provider
 * request: the registry client validates the name against the ecosystem's own pattern and encodes
 * it.
 */
import type {
  AddedDependency,
  DependencyMetadata,
  Id,
  TaskDependencies,
} from '@platform/contracts';
import { dependencyMetadataSchema, taskDependenciesSchema } from '@platform/contracts';
import type {
  CommandContext,
  DeadlineRule,
  DependencyPolicyConfig,
  DetectedDependency,
} from '@platform/domain';
import {
  askQuestion,
  boundReportedDependencies,
  compilePipeline,
  dependencyPolicyFor,
  detectDependencyChanges,
  gateDecisionFor,
  isRunnableTaskState,
  openQuestion,
  stageOf,
  toQuestionRecord,
} from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { DependencyMetadataPort } from '../ports/dependency-metadata.js';
import {
  notCheckedMetadata,
  UNCONFIGURED_DEPENDENCY_METADATA,
  unavailableMetadata,
} from '../ports/dependency-metadata.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { MAX_CONFLICT_FILES } from './conflict-warning.js';
import { questionDeadlineRule } from './deadline-rules.js';
import { coalescedMergeRequestDiff } from './diff-coalescer.js';
import { integrationsForProject, noRunScopedSecrets } from './integrations.js';
import { enqueueOutbound, enqueueStage, type PipelineOutboundData } from './jobs.js';
import type { RebaseJobOptions } from './rebase.js';
import type { PipelineSagaOptions } from './saga.js';
import { PIPELINE_ACTOR, type StoredTask } from './store.js';
import {
  escalateTaskAfterConflict,
  retryOnTaskConflict,
  TaskConflictExhaustedError,
} from './task-conflict.js';
import { applyDecision } from './transitions.js';

export interface DependencyGateOptions extends RebaseJobOptions {
  /**
   * The registry client, or the shipped non-answer.
   *
   * Optional so that every existing composition and every test harness keeps compiling with the
   * honest default rather than with a silently absent collaborator: `UNCONFIGURED_DEPENDENCY_METADATA`
   * answers `not_checked`, which is exactly what an instance with no declared registry host does.
   */
  readonly dependencyMetadata?: DependencyMetadataPort;
}

/** The artifact whose stage this gate follows — product/04 S3's output. */
const IMPLEMENTATION_ARTIFACT = 'ImplementationNotes';

/**
 * The bounded loop a block spends — `ITERATION_LOOPS`' `dependency_policy`, default 2.
 *
 * Named here rather than derived from the stage the task happens to be at: see the module docblock
 * for the measurement that decided it.
 */
const DEPENDENCY_POLICY_LOOP = 'dependency_policy' as const;

/**
 * How many packages one task's gate may ask a registry about.
 *
 * Ten, and it is a spend bound rather than a product number: a lockfile refresh can add a hundred
 * transitive packages and each lookup is one or two HTTP requests to somebody else's service. The
 * packages are looked up **manifest first** (`detectDependencyChanges` orders them that way), so the
 * ones a human actually chose are the ones that get a licence; the rest keep `not_checked`, which
 * says *"nobody asked"* rather than *"nothing to say"*.
 */
export const MAX_METADATA_LOOKUPS = 10;

/** How much of a package name or path survives into the record, a question or a return reason. */
const MAX_STORED_NAME = 200;
const MAX_STORED_PATH = 500;

/**
 * `task.stage.completed` for the Developer stage → decide to check, and let the job call.
 *
 * Priority **120**, the integrations band, beside the conflict warning and the reviewer routing.
 * The core band's own consumer of this event is the saga at priority 10, which records the merge
 * request and moves the task on; this handler reads the task only to ask whether the stage that
 * completed is the one that produces `ImplementationNotes`, and enqueues.
 */
const dependencyGateHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.dependency.gate',
  priority: 120,
  eventTypes: ['task.stage.completed'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.stage.completed') {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, event.payload.task_id);
    if (stored === null) {
      return;
    }
    const pipeline = compilePipeline(stored.task.template, stored.template);
    if (stageOf(pipeline, event.payload.stage)?.produces !== IMPLEMENTATION_ARTIFACT) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'dependency_gate',
      project_id: event.payload.project_id,
      task_id: event.payload.task_id,
      cause_event_id: event.id,
      // The stage that produced the diff: where a `block` sends the task back to, and the stage a
      // question belongs to so that answering it resumes the right run.
      stage: event.payload.stage,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/** Every handler this module registers, for the runtime to spread. */
export const dependencyGateHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  dependencyGateHandler(options),
];

/**
 * `pipeline.outbound` duty **dependency_gate**: read this task's diff, apply the project's policy.
 *
 * **What it re-validates on fire** (TD-004): the task still exists, is not terminal and still has a
 * merge request. It does *not* require the task to still be at the stage that follows the
 * implementation — a CI gate settles on its own schedule — but each ending re-checks what it needs:
 * a question needs an `active` task, and a return needs a stage that has somewhere to return to.
 */
export const runDependencyGate = async (
  options: DependencyGateOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  const producedBy = typeof data.stage === 'string' ? data.stage : null;
  if (taskId === undefined || producedBy === null) {
    return;
  }
  const stored = await options.unitOfWork.transaction(async (scope) => {
    const loaded = await options.store.tasks.load(scope.tx, taskId);
    if (
      loaded === null ||
      loaded.mr === null ||
      loaded.task.state === 'done' ||
      loaded.task.state === 'cancelled'
    ) {
      return null;
    }
    return loaded;
  });
  if (stored === null || stored.mr === null) {
    return;
  }

  const settings = await options.settings.forProject(stored.task.projectId);
  const config = settings.config.policies?.dependency_policy as DependencyPolicyConfig | undefined;

  // Outside every transaction (WP-15d), and outside a run, so the call's scope holds no minted
  // credential (Q55).
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const redactor = integrations.git?.redactor ?? null;
  const redact = (value: string): string =>
    redactor === null ? value : redactor.redactText(value).value;
  const context = { projectId: stored.task.projectId, taskId: stored.task.id };
  // WP-59, backlog 64: coalesced per `(merge request, head sha)`. This is the read on a clock of its
  // own — the Developer stage's completion — so it shares an answer with the rebase gate's two
  // duties only when the gate is reached at the same revision inside the window.
  const files = await coalescedMergeRequestDiff(
    { port: options.integrations, integrations, now: options.clock.now() },
    stored.mr,
    MAX_CONFLICT_FILES,
    context,
  );
  if (files === null) {
    // A project whose git integration was removed keeps running (standing rule 20). Nothing is
    // recorded: a gate that wrote "no dependencies added" here would be reporting a fact it could
    // not establish.
    logger.info(
      { task_id: stored.task.id },
      'dependency gate: this project has no git binding, so there is no diff to read',
    );
    return;
  }

  // Redacted **before** anything parses, compares or stores them, for `changedPathsOf`'s stated
  // reason: an exact-match redactor cannot find a secret a later cut has already halved.
  const scan = detectDependencyChanges(
    files.map((file) => ({
      path: redact(file.new_path),
      patch: file.diff === null || file.diff === undefined ? null : redact(file.diff),
    })),
    { diffTruncated: files.length >= MAX_CONFLICT_FILES },
  );

  /**
   * **Resolve first, cut second** — the order `MAX_DETECTED_DEPENDENCIES` promises (review round 2).
   *
   * The policy is resolved for *every* package the diff added and the decision is taken over all of
   * them, so the twenty-sixth package blocks the task exactly as the first would; only the list
   * that is stored, quoted and shown is bounded, and the registry is asked about the packages that
   * survive the cut rather than about ones nobody will see.
   */
  const resolved = scan.added.map((entry) => ({
    entry,
    ...dependencyPolicyFor(config, entry.ecosystem, entry.name),
  }));
  const decision = gateDecisionFor(resolved.map((item) => item.policy));
  const bounded = boundReportedDependencies(resolved);
  const metadata = await describeAll(options, bounded.reported, logger);

  const record: TaskDependencies = {
    head_sha: stored.mr.head_sha ?? null,
    decision,
    added: bounded.reported.map(
      ({ entry, policy, allowlisted }, index): AddedDependency => ({
        ecosystem: entry.ecosystem,
        name: entry.name.slice(0, MAX_STORED_NAME),
        from: entry.from,
        path: entry.path.slice(0, MAX_STORED_PATH),
        policy,
        allowlisted,
        metadata: metadata[index] ?? notCheckedMetadata(),
      }),
    ),
    unread: scan.unread.map((entry) => ({
      ecosystem: entry.ecosystem,
      path: entry.path.slice(0, MAX_STORED_PATH),
    })),
    truncated: scan.truncated || bounded.truncated,
    question_id: null,
    checked_at: options.clock.now(),
  };

  logger.info(
    {
      task_id: stored.task.id,
      files: files.length,
      added: record.added.length,
      unread: record.unread.length,
      decision,
    },
    scan.unread.length === 0
      ? 'dependency gate: the merge request’s diff was read'
      : 'dependency gate: the diff changed a manifest this build cannot read, which the panel names',
  );

  if (decision === 'ask') {
    await askAboutDependencies(
      options,
      { stored, producedBy, record, logger },
      // WP-56: the question expires on the organisation's calendar at the project's limit, like
      // every other question — the settings were read above, outside any transaction.
      questionDeadlineRule(options.calendar, settings.config),
    );
    return;
  }
  await save(options, stored.task.id, record);
  if (decision === 'block') {
    await blockForDependencies(options, { stored, producedBy, record, redact, logger });
  }
};

/**
 * The registry lookups, bounded and never fatal — **in either of the two ways a port can fail**.
 *
 * `Promise` by `Promise` rather than in parallel: the bound is small, the call is to somebody
 * else's service, and a burst of ten simultaneous requests to one host is what a rate limit is for.
 *
 * A lookup that **throws** — which the port promises not to do, so this is the guard for an adapter
 * that breaks its contract — is `unavailable` for that package and nothing else (Q84: the gate must
 * never depend on the call succeeding). A lookup that **answers something `tasks.dependencies`
 * cannot hold** is the same failure wearing the other mask, and it was live until review round 2:
 * the shipped client read npm's `license` unbounded while `dependencyMetadataSchema.license` is
 * `.max(200)`, so one long licence made the `taskDependenciesSchema.parse` below throw — no record,
 * no question, no `block`, and a dead job. The adapter is fixed; the **gate refuses closed anyway**,
 * because this decision is the platform's and a package it cannot describe is still a package it
 * must ask about or block (standing rules 16, 18, 20). Every answer is therefore parsed here, and
 * one the record refuses becomes `unavailable` — the same ending a registry outage gets.
 */
const describeAll = async (
  options: DependencyGateOptions,
  resolved: readonly { readonly entry: DetectedDependency }[],
  logger: Logger,
): Promise<readonly DependencyMetadata[]> => {
  const port = options.dependencyMetadata ?? UNCONFIGURED_DEPENDENCY_METADATA;
  const answers: DependencyMetadata[] = [];
  for (const [index, item] of resolved.entries()) {
    if (index >= MAX_METADATA_LOOKUPS) {
      answers.push(notCheckedMetadata());
      continue;
    }
    try {
      const answer = await port.describe({
        ecosystem: item.entry.ecosystem,
        name: item.entry.name,
      });
      const storable = dependencyMetadataSchema.safeParse(answer);
      if (!storable.success) {
        logger.warn(
          { ecosystem: item.entry.ecosystem, issues: storable.error.issues.length },
          'dependency gate: the registry lookup answered a shape this record cannot hold, so the package is gated without a licence',
        );
        answers.push(unavailableMetadata());
        continue;
      }
      answers.push(storable.data);
    } catch (error) {
      logger.warn(
        { ecosystem: item.entry.ecosystem, err: error },
        'dependency gate: the registry lookup threw, which the port promises not to do; the gate carries on without it',
      );
      answers.push(unavailableMetadata());
    }
  }
  return answers;
};

interface EndingInput {
  readonly stored: StoredTask;
  readonly producedBy: string;
  readonly record: TaskDependencies;
  readonly logger: Logger;
}

/** One line per package for the question and for the return reason. */
const describeDependency = (entry: AddedDependency): string => {
  const licence =
    entry.metadata.status === 'checked'
      ? `licence ${entry.metadata.license ?? 'not published'}`
      : entry.metadata.status === 'not_checked'
        ? 'licence not checked'
        : entry.metadata.status === 'unsupported'
          ? 'licence not checked (no registry for this ecosystem on this build)'
          : 'licence unavailable (the registry could not be reached)';
  const published =
    entry.metadata.last_published_at === null
      ? 'last release unknown'
      : `last release ${entry.metadata.last_published_at.slice(0, 10)}`;
  const deprecated = entry.metadata.deprecated === true ? ', deprecated by its author' : '';
  return `${entry.ecosystem}:${entry.name} (${entry.from === 'manifest' ? 'declared in' : 'locked by'} ${entry.path}) — ${licence}, ${published}${deprecated}`;
};

/**
 * A transaction of this job's own that writes the task, on the conflict bound (WP-15e).
 *
 * The same shape `jobs.ts` gives its own writes and for the same reason — a `save` refused because
 * another writer moved the row re-runs the **whole** unit, and exhausting the bound **escalates**
 * the task rather than dropping the decision. It is spelled here rather than imported because
 * `inTaskTransaction` there takes a `PipelineJobOptions` (a `StageExecutor` this duty has no use
 * for); the ending is identical, which is what matters.
 */
const inTaskTransaction = async <T>(
  options: DependencyGateOptions,
  taskId: Id,
  what: string,
  unit: (
    scope: Parameters<Parameters<RebaseJobOptions['unitOfWork']['transaction']>[0]>[0],
  ) => Promise<T>,
): Promise<T | null> => {
  try {
    return await retryOnTaskConflict(
      { taskId, what, ...(options.logger === undefined ? {} : { logger: options.logger }) },
      async () => options.unitOfWork.transaction(unit),
    );
  } catch (error) {
    if (!(error instanceof TaskConflictExhaustedError)) {
      throw error;
    }
    (options.logger ?? silentLogger).error(
      { task_id: taskId, what, attempts: error.attempts, err: error },
      'the dependency gate lost every race writing this task; it is escalated',
    );
    await escalateTaskAfterConflict(
      {
        unitOfWork: options.unitOfWork,
        store: options.store,
        context: (id) => commandContextFor(options, id),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
      error,
    );
    return null;
  }
};

/**
 * The **ask** ending: one blocking question on the existing gate.
 *
 * The question and the record are written in **one** transaction, so a crash cannot leave a record
 * claiming `ask` with no question to answer — `question_id` is the link the panel follows and a
 * dangling one would be a screen pointing at nothing.
 *
 * `askQuestion` needs an `active` task, and the window in which it might not be is real but narrow:
 * a human pauses, cancels or takes the task over in the seconds after the stage completed. That
 * case is **named, not silent** (standing rule 18) — the record is still written with the decision
 * it reached, so the panel shows the packages, and the log says the question could not be asked
 * rather than leaving a maintainer to read a blank as "nothing was added".
 */
const askAboutDependencies = async (
  options: DependencyGateOptions,
  input: EndingInput,
  deadlineFrom: DeadlineRule,
): Promise<void> => {
  const { stored, record, logger } = input;
  const lines = record.added
    .filter((entry) => entry.policy === 'ask')
    .map((entry) => `- ${describeDependency(entry)}`);
  const text =
    `This change adds ${lines.length === 1 ? 'a third-party dependency' : `${lines.length} third-party dependencies`}. ` +
    `The project's dependency policy is "ask", so it needs your decision before the task goes on:\n${lines.join('\n')}\n` +
    'Answer "yes" to accept them, or say which to remove.';

  await inTaskTransaction(
    options,
    stored.task.id,
    'asking about an added dependency',
    async (scope) => {
      const current = await options.store.tasks.load(scope.tx, stored.task.id);
      if (current === null) {
        return;
      }
      if (current.task.state !== 'active') {
        await options.store.tasks.saveDependencies(
          scope.tx,
          stored.task.id,
          taskDependenciesSchema.parse(record),
        );
        logger.warn(
          { task_id: stored.task.id, state: current.task.state, added: record.added.length },
          'dependency gate: the task stopped being active before the dependency question could be asked, so the packages are on the panel and nobody was asked',
        );
        return;
      }
      const context = commandContextFor(options, stored.task.id);
      const question = openQuestion(
        {
          id: context.ids.next(),
          taskId: stored.task.id,
          projectId: stored.task.projectId,
          // The stage that added the package, so answering resumes *that* stage — the saga reads
          // `question.stage` — rather than whatever the task drifted to while CI was running.
          stage: input.producedBy,
          text,
          blocking: true,
          options: ['yes', 'no'],
          deadlineFrom,
        },
        context,
      );
      await options.store.questions.insert(scope.tx, question);
      const asked = askQuestion(current.task, { question: toQuestionRecord(question) }, context);
      await options.store.tasks.save(scope.tx, { ...current, task: asked.aggregate });
      await options.store.tasks.saveDependencies(
        scope.tx,
        stored.task.id,
        taskDependenciesSchema.parse({ ...record, question_id: question.id }),
      );
      await scope.events.append(asked.events);
      logger.info(
        { task_id: stored.task.id, question_id: question.id, added: record.added.length },
        'dependency gate: the project’s policy is "ask", so the task is waiting for an answer',
      );
    },
  );
};

/**
 * The **block** ending: return the task to the stage that added the package.
 *
 * It spends **{@link DEPENDENCY_POLICY_LOOP}, a counter of its own** (`ITERATION_LOOPS`, default 2,
 * in `AGENT_ITERATION_LOOPS` so a human decision refills it), rather than the loop the *leaving*
 * stage owns. That is the module docblock's measurement rather than a preference: this job fires
 * whenever the outbound worker reaches it, so the task has usually moved past the CI gate, and
 * `returnLoopFor` would charge the block to whichever loop the stage it happens to be at owns —
 * on the first e2e run, two `rebase` rounds and then three `human_rounds`, ending in *"human_rounds
 * iteration limit of 3 reached: the project's dependency policy blocks npm:lodash"*: a bound nobody
 * had spent, named after a loop nobody had been round (standing rule 81). It has **no
 * `pipeline.limits` key**, like `refinement_questions` and `architecture_revisions` — a project that
 * wants a different answer changes the *policy* — and the escalation at the end of the bound is
 * still `returnToStage`'s own, with the brief below. The loop is logged on every block, because a
 * counter's name is an explanation.
 *
 * A stage with no return edge at all cannot return — the interpreter's fail-closed direction — and
 * that is **named rather than ignored**: the task stays where it is, the record is on the panel, and
 * the log says the block could not be applied.
 */
const blockForDependencies = async (
  options: DependencyGateOptions,
  input: EndingInput & { readonly redact: (value: string) => string },
): Promise<void> => {
  const { stored, record, logger } = input;
  const blocked = record.added.filter((entry) => entry.policy === 'block');
  const reason = input.redact(
    `the project's dependency policy blocks ${blocked.map((entry) => `${entry.ecosystem}:${entry.name}`).join(', ')}`,
  );

  const work = await inTaskTransaction(
    options,
    stored.task.id,
    'returning a task for a blocked dependency',
    async (scope) => {
      const current = await options.store.tasks.load(scope.tx, stored.task.id);
      /**
       * **`from` is read here rather than captured before the provider call**, and that is the
       * whole re-validation (TD-004). This job fires whenever the queue reaches it, so the task has
       * usually moved on from the stage that completed — measured on the e2e: the block lands at
       * `rebase_gate` or at `ready_for_merge` far more often than at the CI gate. Requiring the
       * stage not to have moved would make the gate fire almost never, which is the failure mode a
       * re-validation is most likely to hide.
       */
      if (current === null || !isRunnableTaskState(current.task.state)) {
        return null;
      }
      const from = current.task.currentStage;
      if (from === null || from === input.producedBy) {
        // Already back where the block would send it: another attempt is in flight, or a human
        // moved it. Nothing to do, and nothing to count.
        return null;
      }
      const pipeline = compilePipeline(current.task.template, current.template);
      const applied = await applyDecision({
        store: options.store,
        pipeline,
        tx: scope.tx,
        stored: current,
        decision: {
          kind: 'return',
          from,
          to: input.producedBy,
          loop: DEPENDENCY_POLICY_LOOP,
          reason,
          escalationBrief:
            `${current.task.ticket.key} keeps adding a dependency this project's policy blocks (${reason}). ` +
            'Either allow-list the package in `.agentic/config.yml` or tell the task what to use instead, then hand it back.',
        },
        context: commandContextFor(options, current.task.id),
        causedByEventId: null,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      await scope.events.append(applied.events);
      return applied.work;
    },
  );
  if (work !== null && work !== undefined) {
    await enqueueStage(options.jobs, work);
  }
  logger.info(
    {
      task_id: stored.task.id,
      to: input.producedBy,
      loop: DEPENDENCY_POLICY_LOOP,
      blocked: blocked.length,
    },
    'dependency gate: the project’s policy blocks a package this change adds, so the task went back to the stage that added it',
  );
};

const commandContextFor = (options: DependencyGateOptions, taskId: Id): CommandContext => ({
  ids: options.ids,
  actor: PIPELINE_ACTOR,
  clock: options.clock as CommandContext['clock'],
  correlationId: taskId,
  causeEventId: null,
});

/**
 * The narrow write, in a transaction of its own.
 *
 * Never `save`: this job runs beside the stage executor's transactions, so a whole-row write would
 * put back the state, the stage and the cost as they were when the job started (standing rule 79).
 * The record is parsed by the store on the way in, which is where a shape the panel cannot render
 * is refused (WP-15h).
 */
const save = async (
  options: DependencyGateOptions,
  taskId: Id,
  dependencies: TaskDependencies,
): Promise<void> => {
  await options.unitOfWork.transaction(async (scope) => {
    await options.store.tasks.saveDependencies(
      scope.tx,
      taskId,
      taskDependenciesSchema.parse(dependencies),
    );
  });
};
