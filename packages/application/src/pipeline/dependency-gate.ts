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
  TaskState,
} from '@platform/contracts';
import { dependencyMetadataSchema, taskDependenciesSchema } from '@platform/contracts';
import type {
  CommandContext,
  DeadlineRule,
  DependencyPolicyConfig,
  DetectedDependency,
} from '@platform/domain';
import {
  addedLinesContain,
  askQuestion,
  boundReportedDependencies,
  compilePipeline,
  dependencyPolicyFor,
  detectDependencyChanges,
  gateDecisionFor,
  isRunnableTaskState,
  isTerminalTaskState,
  LIBRARIAN_STAGE,
  MERGED_GATE_STAGE,
  openQuestion,
  READY_FOR_MERGE_STAGE,
  RETROSPECTIVE_STAGE,
  stageOf,
  toQuestionRecord,
} from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import { MIN_SECRET_LENGTH } from '../integrations/redaction.js';
import { openSshPrivateKeyBody } from '../integrations/ssh-deploy-key.js';
import type { DependencyMetadataPort } from '../ports/dependency-metadata.js';
import {
  notCheckedMetadata,
  UNCONFIGURED_DEPENDENCY_METADATA,
  unavailableMetadata,
} from '../ports/dependency-metadata.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { parkForConfigRefusal } from './config-refusal.js';
import { questionDeadlineRule } from './deadline-rules.js';
import { coalescedMergeRequestDiff, MAX_CONFLICT_FILES } from './diff-coalescer.js';
import {
  type DeployKeyRunCredential,
  integrationsForProject,
  noRunScopedSecrets,
  type StaticRunCredential,
} from './integrations.js';
import { escalateTaskWithBrief } from './job-escalation.js';
import { enqueueOutbound, enqueueStage, type PipelineOutboundData } from './jobs.js';
import type { RebaseJobOptions } from './rebase.js';
import type { PipelineSagaOptions } from './saga.js';
import type { StageExecutionJob } from './stage-executor.js';
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
 * The core band's own consumer of this event is the saga at priority 10, which checks the reported
 * merge request against the platform's record (WP-138) and moves the task on; this handler reads the task only to ask whether the stage that
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
    const pipeline = compilePipeline(
      stored.task.template,
      stored.template,
      stored.pipelineDial,
      stored.qaStage,
    );
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

/**
 * `task.resumed` → perform a **deferred** ending (WP-67, PROGRESS backlog 96, Q91).
 *
 * The gate decides once, in a job, and until WP-67 an ending that met a task at a stop a human owns
 * — `paused`, `needs_human`, `waiting_answers`, `waiting_approval` — gave up and nothing ever tried
 * again: a question nobody was asked, and for `block`, a package the policy blocks on a branch
 * nobody was told about. The record now says so (`deferred_stage`), and every one of those four
 * stops ends in a stage entry that emits `task.resumed` (`RESUMED_FROM` in the Task aggregate —
 * `enterStage`, and since WP-73 the tail-stage entry a pause at `ready_for_merge` leaves by), so
 * this is the idempotent trigger: the record is the predicate and the job clears it in the same
 * transaction that performs the ending, so a second resume finds nothing to do.
 *
 * The handler **reads** before it enqueues, so a resume with nothing deferred — almost all of them —
 * costs no job. That read is sound only because the gate writes the deferral under the task row's
 * lock (see {@link deferOrPerform}): a deferral either committed before the resume did, and is seen
 * here, or it was written after, and then the gate saw the task already `active` and performed the
 * ending itself instead of deferring it.
 *
 * `ready_for_merge`, `merged` and `retro` are not stops, and a question is not deferred at them —
 * Q91's answer rather than a gap: a task that passed review never becomes `active` again and is
 * not interrupted with a question. A task *paused* at `ready_for_merge` is a stop, and its resume
 * performs a deferred `block` (WP-73, backlog 244).
 *
 * **The enqueue below is at-most-once** (TD-004): a process that dies between the resume's commit
 * and it leaves an `active` task carrying the deferral. Since WP-84 that is a row of
 * `recovery/stranded.ts`'s table (`recovery/deferred-dependency.ts`, backlog 240), which finds the
 * task by its newest `task.resumed` and re-enqueues the same duty once per resume.
 */
const dependencyGateResumeHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.dependency.gate.resume',
  priority: 120,
  eventTypes: ['task.resumed'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.resumed') {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, event.payload.task_id);
    const deferred = stored?.dependencies?.deferred_stage ?? null;
    if (stored === null || deferred === null) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'dependency_gate_resume',
      project_id: event.payload.project_id,
      task_id: event.payload.task_id,
      cause_event_id: event.id,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/** Every handler this module registers, for the runtime to spread. */
export const dependencyGateHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  dependencyGateHandler(options),
  dependencyGateResumeHandler(options),
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
  if (settings.configRefusal !== undefined) {
    // WP-106 review round 1: the gate's three endings (pass, a question, a return) are a policy,
    // and the policy is the unreadable document's. Parked by name, decided again on resume.
    await parkForConfigRefusal(options, {
      taskId,
      refusal: settings.configRefusal,
      what: 'the dependency policy for its changes',
    });
    return;
  }
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

  // WP-137 (TD-028 decision 13 item 5): the platform's one added control over a static run
  // credential — a merge request whose added lines carry the token parks the task. Compared before
  // the gate's own redaction below; the adapter's transport has already replaced the value with the
  // binding redactor's placeholder, which is searched too (review round 1).
  if (
    await parkOnStaticRunTokenLeak(options, stored, integrations.git?.staticRunCredential, files)
  ) {
    return;
  }
  if (await parkOnDeployKeyLeak(options, stored, integrations.git?.deployKeyRunCredential, files)) {
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
      questionDeadlineRule(options.calendar, settings),
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

/**
 * How many files of a merge request's diff add the static run token on an added line (WP-137) —
 * its exact value **or** the placeholder the binding's redactor writes in its place (review round 1):
 * a real adapter's response has already been through that redactor, which knows the run token as a
 * sealed secret of the integration, so against GitLab the diff carries the placeholder and never the
 * value. The raw value covers a provider that did not redact. `0` for no static credential.
 *
 * Residual, stated: the placeholder is text, so an agent that writes it literally into an added line
 * parks its own task — a self-inflicted stop, never a leak.
 */
export const staticRunTokenLeaks = (
  fixed: StaticRunCredential | undefined,
  files: readonly { readonly diff?: string | null }[],
): number => {
  const token = fixed?.value ?? '';
  if (token.trim().length < MIN_SECRET_LENGTH) {
    return 0;
  }
  const needles = [token, ...(fixed?.redactedAs === undefined ? [] : [fixed.redactedAs])];
  return files.filter(
    (file) =>
      typeof file.diff === 'string' &&
      needles.some((needle) => addedLinesContain(file.diff as string, needle)),
  ).length;
};

/**
 * The needles of a deploy key's private text (WP-146, TD-028 decision 13b item 7): its whole base64
 * body as one string, each armour line from the third on — the first two of every unencrypted Ed25519
 * key share the container's fixed header and the public key, so they are not evidence of **this**
 * private key — and the binding redactor's placeholder (a provider response the adapter hands back
 * already carries that instead of the value). Empty when no key is held.
 */
export const deployKeyNeedles = (key: DeployKeyRunCredential | undefined): readonly string[] => {
  const text = key?.privateKey ?? '';
  const body = openSshPrivateKeyBody(text);
  if (body === null || body.length < MIN_SECRET_LENGTH) {
    return [];
  }
  const lines = text
    .slice(text.indexOf('-----BEGIN'))
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => !line.startsWith('-----'))
    .map((line) => line.trim())
    .slice(2)
    .filter((line) => line.length >= 40);
  return [body, ...lines, ...(key?.redactedAs === undefined ? [] : [key.redactedAs])];
};

/** How many files of `files` add the deploy key's private text, by {@link deployKeyNeedles}. */
export const deployKeyLeaks = (
  key: DeployKeyRunCredential | undefined,
  files: readonly { readonly diff?: string | null }[],
): number => {
  const needles = deployKeyNeedles(key);
  if (needles.length === 0) {
    return 0;
  }
  return files.filter(
    (file) =>
      typeof file.diff === 'string' &&
      needles.some((needle) => addedLinesContain(file.diff as string, needle)),
  ).length;
};

/**
 * **A merge request that adds the deploy key's private text parks its task** (WP-146, decision 13b
 * item 7) — the key never enters a run container, so a hit means it reached the repository some
 * other way; either way it works until it is removed from the project. Same shape as the static
 * token's: the brief says **remove the key**, and never prints it.
 */
const parkOnDeployKeyLeak = async (
  options: DependencyGateOptions,
  stored: StoredTask,
  key: DeployKeyRunCredential | undefined,
  files: readonly { readonly new_path: string; readonly diff?: string | null }[],
): Promise<boolean> => {
  const leaked = deployKeyLeaks(key, files);
  if (leaked === 0) {
    return false;
  }
  const logger = options.logger ?? silentLogger;
  logger.error(
    { task_id: stored.task.id, files: leaked },
    'the merge request adds the deploy key to the repository: the task is parked, and the key must be replaced (TD-028 decision 13b)',
  );
  await escalateTaskWithBrief(options, {
    taskId: stored.task.id,
    projectId: stored.task.projectId,
    causeEventId: null,
    reason: 'the merge request adds the deploy key to the repository',
    brief: (ticketKey) =>
      `The merge request for ${ticketKey} adds the project's SSH deploy key — the git integration's \`run_ssh_private_key\` — to the repository, in ${leaked} file${leaked === 1 ? '' : 's'}. ` +
      'A deploy key works until it is removed from the project. Replace it now: remove the deploy key from the project (Settings › Repository › Deploy keys), create a new one with `ssh-keygen -t ed25519 -N ""`, add it with write access, ' +
      're-seal it with POST /api/integrations/:id/secrets and update `run_ssh_public_key`. Then remove the key from the branch (and from its history) before this merge request goes anywhere. ' +
      'The key is not printed here or anywhere the platform writes.',
    what: 'dependency_gate',
  });
  return true;
};

/**
 * **A merge request that adds the static run token parks its task** (WP-137, TD-028 decision 13
 * item 5). A static run credential cannot be revoked per run and outlives the run, so a token the
 * agent pushed into the repository still works — the one exposure the platform can see, because it
 * already reads the merge request's added lines here. A hit escalates the task *Needs human* with a
 * brief that says **rotate the run token** and never prints it; nothing else of this gate runs, so
 * no record or question carries the line. Answers whether it parked.
 *
 * What it does not see, stated: an added line past the reader's per-file bound, a file past the
 * diff's file bound, an encoded or split token, and every place other than this merge request.
 */
const parkOnStaticRunTokenLeak = async (
  options: DependencyGateOptions,
  stored: StoredTask,
  fixed: StaticRunCredential | undefined,
  files: readonly { readonly new_path: string; readonly diff?: string | null }[],
): Promise<boolean> => {
  const leaked = staticRunTokenLeaks(fixed, files);
  if (leaked === 0) {
    return false;
  }
  const logger = options.logger ?? silentLogger;
  logger.error(
    { task_id: stored.task.id, files: leaked },
    'the merge request adds the static run token to the repository: the task is parked, and the token must be rotated (TD-028 decision 13)',
  );
  await escalateTaskWithBrief(options, {
    taskId: stored.task.id,
    projectId: stored.task.projectId,
    causeEventId: null,
    reason: 'the merge request adds the static run token to the repository',
    brief: (ticketKey) =>
      `The merge request for ${ticketKey} adds the project's static run token — the git integration's \`run_token\` — to the repository, in ${leaked} file${leaked === 1 ? '' : 's'}. ` +
      'A static run token is not revoked when a run ends, so it works until its declared expiry. Rotate the run token now: revoke it at the provider, create a new one for the same dedicated user, ' +
      're-seal it with POST /api/integrations/:id/secrets, and declare its new expiry. Then remove the value from the branch (and from its history) before this merge request goes anywhere. ' +
      'The token is not printed here or anywhere the platform writes.',
    what: 'dependency_gate',
  });
  return true;
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
 * A stop a **human** owns: `paused`, `needs_human`, `waiting_answers`, `waiting_approval`.
 *
 * Exactly the states `isRunnableTaskState` excludes minus the terminal pair — and exactly the
 * states the Task aggregate leaves with a `task.resumed` (`RESUMED_FROM`, read by `enterStage` and,
 * since WP-73, by the tail-stage entry too), which is what makes deferring to that event sound:
 * every task parked here comes back through it — or, paused at `ready_for_merge`, is merged on the
 * provider and comes back through the same event into `merged` (Q104).
 */
const isHumanOwnedStop = (state: TaskState): boolean =>
  !isRunnableTaskState(state) && !isTerminalTaskState(state);

/**
 * The stages a task is at once it has **passed review** — Q91's `ready_for_merge`, `merged`, `retro`,
 * as the stage ids a stopped task still carries in `current_stage`.
 *
 * Needed because a stop hides the state it was taken from (WP-67 review round 1): a task paused at
 * `ready_for_merge` is `paused`, and `resume` on it re-enters `ready_for_merge` — never `active`
 * (`paused → ready_for_merge`, WP-73, PROGRESS backlog 244). So a deferred `ask` there is not
 * deferred: Q91's answer is that a task past review is not asked at all, and the resume would not
 * make it `active` to ask it. A `block` at such a stop **is** deferred, and its resume performs it:
 * the entry into `ready_for_merge` emits `task.resumed`, and `ready_for_merge → returned` is an edge.
 */
const PAST_REVIEW_STAGES: ReadonlySet<string> = new Set([
  READY_FOR_MERGE_STAGE,
  MERGED_GATE_STAGE,
  RETROSPECTIVE_STAGE,
  LIBRARIAN_STAGE,
]);

const isPastReview = (stage: string | null): boolean =>
  stage !== null && PAST_REVIEW_STAGES.has(stage);

type GateScope = Parameters<Parameters<RebaseJobOptions['unitOfWork']['transaction']>[0]>[0];

/**
 * Reads the task **under its row lock**, or `null` when it no longer exists.
 *
 * `bumpVersion` is the store's one statement that takes the row lock without writing a column of
 * the aggregate (WP-59), and the second `load` after it reads what was committed by whoever held
 * the lock before — READ COMMITTED gives each statement a fresh snapshot. It is what makes a
 * deferral race-free (WP-67): a resume that is committing when the gate looks is waited out and
 * then seen as `active`, and a resume that starts after the gate took the lock meets the bumped
 * version at its own `save` and re-runs, after the deferral is committed — so its `task.resumed`
 * handler reads the deferral. Without the lock the gate could read `paused`, the resume commit and
 * find nothing deferred, and the gate then write a deferral nobody would ever perform.
 */
const loadLocked = async (
  options: DependencyGateOptions,
  scope: GateScope,
  taskId: Id,
): Promise<StoredTask | null> => {
  if ((await options.store.tasks.load(scope.tx, taskId)) === null) {
    return null;
  }
  await options.store.tasks.bumpVersion(scope.tx, taskId);
  return options.store.tasks.load(scope.tx, taskId);
};

/** The question an `ask` opens, built from the record so a deferred ask asks the same thing. */
const dependencyQuestionText = (record: TaskDependencies): string => {
  const lines = record.added
    .filter((entry) => entry.policy === 'ask')
    .map((entry) => `- ${describeDependency(entry)}`);
  return (
    `This change adds ${lines.length === 1 ? 'a third-party dependency' : `${lines.length} third-party dependencies`}. ` +
    `The project's dependency policy is "ask", so it needs your decision before the task goes on:\n${lines.join('\n')}\n` +
    'Answer "yes" to accept them, or say which to remove.'
  );
};

/** The return reason a `block` carries, built from the record for the same reason. */
const blockReasonOf = (record: TaskDependencies): string =>
  `the project's dependency policy blocks ${record.added
    .filter((entry) => entry.policy === 'block')
    .map((entry) => `${entry.ecosystem}:${entry.name}`)
    .join(', ')}`;

/**
 * Opens the question and records it, in the caller's transaction on an `active` task.
 *
 * The question, the task's move to `waiting_answers` and the record are written together, so a
 * crash cannot leave a record claiming `ask` with no question to answer — `question_id` is the link
 * the panel follows and a dangling one would be a screen pointing at nothing. The deferral, if there
 * was one, is cleared by the same write: this is what makes the resume trigger idempotent.
 */
const askNow = async (
  options: DependencyGateOptions,
  scope: GateScope,
  input: {
    readonly current: StoredTask;
    readonly record: TaskDependencies;
    readonly stage: string;
    readonly deadlineFrom: DeadlineRule;
    readonly logger: Logger;
  },
): Promise<void> => {
  const { current, record } = input;
  const context = commandContextFor(options, current.task.id);
  const question = openQuestion(
    {
      id: context.ids.next(),
      taskId: current.task.id,
      projectId: current.task.projectId,
      // The stage that added the package, so answering resumes *that* stage — the saga reads
      // `question.stage` — rather than whatever the task drifted to while CI was running.
      stage: input.stage,
      text: dependencyQuestionText(record),
      blocking: true,
      options: ['yes', 'no'],
      deadlineFrom: input.deadlineFrom,
    },
    context,
  );
  await options.store.questions.insert(scope.tx, question);
  const asked = askQuestion(current.task, { question: toQuestionRecord(question) }, context);
  await options.store.tasks.save(scope.tx, { ...current, task: asked.aggregate });
  await options.store.tasks.saveDependencies(
    scope.tx,
    current.task.id,
    taskDependenciesSchema.parse({ ...record, question_id: question.id, deferred_stage: null }),
  );
  await scope.events.append(asked.events);
  input.logger.info(
    { task_id: current.task.id, question_id: question.id, added: record.added.length },
    'dependency gate: the project’s policy is "ask", so the task is waiting for an answer',
  );
};

/**
 * Returns the task to the stage that added the package, in the caller's transaction.
 *
 * **`from` is read off the locked row rather than captured before the provider call**, and that is
 * the whole re-validation (TD-004). This job fires whenever the queue reaches it, so the task has
 * usually moved on from the stage that completed — measured on the e2e: the block lands at
 * `rebase_gate` or at `ready_for_merge` far more often than at the CI gate. Requiring the stage not
 * to have moved would make the gate fire almost never, which is the failure mode a re-validation is
 * most likely to hide. A task already back at that stage is left alone: another attempt is in
 * flight, or a human moved it, and there is nothing to count.
 */
const returnNow = async (
  options: DependencyGateOptions,
  scope: GateScope,
  input: { readonly current: StoredTask; readonly stage: string; readonly reason: string },
): Promise<{ readonly work: StageExecutionJob | null } | null> => {
  const { current } = input;
  const from = current.task.currentStage;
  if (from === null || from === input.stage) {
    return null;
  }
  const pipeline = compilePipeline(
    current.task.template,
    current.template,
    current.pipelineDial,
    current.qaStage,
  );
  const applied = await applyDecision({
    store: options.store,
    pipeline,
    tx: scope.tx,
    stored: current,
    decision: {
      kind: 'return',
      from,
      to: input.stage,
      loop: DEPENDENCY_POLICY_LOOP,
      reason: input.reason,
      escalationBrief:
        `${current.task.ticket.key} keeps adding a dependency this project's policy blocks (${input.reason}). ` +
        'Either allow-list the package in `.agentic/config.yml` or tell the task what to use instead, then hand it back.',
    },
    context: commandContextFor(options, current.task.id),
    causedByEventId: null,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  await scope.events.append(applied.events);
  return { work: applied.work ?? null };
};

/**
 * The **ask** ending: one blocking question on the existing gate.
 *
 * `askQuestion` needs an `active` task, and a task that is not one when the job fires takes one of
 * two endings — both **named, not silent** (standing rule 18), both with the record written so the
 * panel shows the packages:
 *
 *  - **a stop a human owns** (WP-67): the question is **deferred** — `deferred_stage` names the
 *    stage it belongs to, and {@link runDependencyGateResume} asks it when the task resumes;
 *  - **`ready_for_merge`, `merged`, `retro`** (Q91, answered): the question is **refused and the
 *    record kept**. A task that passed review is not interrupted with a question the platform could
 *    have asked earlier, and the panel says `not asked` with that reason.
 */
const askAboutDependencies = async (
  options: DependencyGateOptions,
  input: EndingInput,
  deadlineFrom: DeadlineRule,
): Promise<void> => {
  const { stored, record, logger } = input;
  await inTaskTransaction(
    options,
    stored.task.id,
    'asking about an added dependency',
    async (scope) => {
      const current = await loadLocked(options, scope, stored.task.id);
      if (current === null) {
        return;
      }
      if (current.task.state !== 'active') {
        const deferred =
          isHumanOwnedStop(current.task.state) && !isPastReview(current.task.currentStage);
        await options.store.tasks.saveDependencies(
          scope.tx,
          stored.task.id,
          taskDependenciesSchema.parse({
            ...record,
            deferred_stage: deferred ? input.producedBy : null,
          }),
        );
        logger.warn(
          { task_id: stored.task.id, state: current.task.state, added: record.added.length },
          deferred
            ? 'dependency gate: a person has stopped the task, so the dependency question is deferred until it resumes'
            : 'dependency gate: the task had passed review before the dependency question could be asked, so the packages are on the panel and nobody was asked (Q91)',
        );
        return;
      }
      await askNow(options, scope, {
        current,
        record,
        stage: input.producedBy,
        deadlineFrom,
        logger,
      });
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
 * A task at **a stop a human owns** is not returned — the pipeline may not move it — and the block
 * is **deferred** to its resume (WP-67): until then `ready_for_merge` was the one state it still
 * blocked in, and a package the policy blocks sat on the branch of any task a person had paused.
 * That includes a task paused at `ready_for_merge`, whose resume re-enters it (WP-73, backlog 244);
 * a merge made on the provider during that pause ends it instead (Q104), and the deferred block is
 * then dropped by {@link runDependencyGateResume}, because a merged task cannot be returned.
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
  const reason = input.redact(blockReasonOf(record));

  const outcome = await inTaskTransaction(
    options,
    stored.task.id,
    'returning a task for a blocked dependency',
    async (scope) => {
      const current = await loadLocked(options, scope, stored.task.id);
      if (current === null) {
        return null;
      }
      if (isHumanOwnedStop(current.task.state)) {
        await options.store.tasks.saveDependencies(
          scope.tx,
          stored.task.id,
          taskDependenciesSchema.parse({ ...record, deferred_stage: input.producedBy }),
        );
        return 'deferred' as const;
      }
      if (!isRunnableTaskState(current.task.state)) {
        return null;
      }
      return returnNow(options, scope, { current, stage: input.producedBy, reason });
    },
  );
  if (outcome === 'deferred') {
    logger.warn(
      { task_id: stored.task.id, to: input.producedBy, loop: DEPENDENCY_POLICY_LOOP },
      'dependency gate: the project’s policy blocks a package this change adds, and a person has stopped the task, so the return is deferred until it resumes',
    );
    return;
  }
  if (outcome === null) {
    return;
  }
  if (outcome.work !== null) {
    await enqueueStage(options.jobs, outcome.work);
  }
  logger.info(
    {
      task_id: stored.task.id,
      to: input.producedBy,
      loop: DEPENDENCY_POLICY_LOOP,
      blocked: record.added.filter((entry) => entry.policy === 'block').length,
    },
    'dependency gate: the project’s policy blocks a package this change adds, so the task went back to the stage that added it',
  );
};

/**
 * `pipeline.outbound` duty **dependency_gate_resume**: perform the ending a stop deferred (WP-67).
 *
 * Woken by {@link dependencyGateResumeHandler}; it calls **no provider** — the decision and its
 * packages are on the record, redacted when they were written — and it rides the outbound queue
 * only so that the ending is taken by the same job-shaped owner, with the same conflict bound and
 * escalation, as the gate's first attempt.
 *
 * **What it re-validates on fire** (TD-004), under the row lock:
 *
 *  - nothing deferred any more → nothing (a second resume, or the gate re-ran on a new diff);
 *  - the task is at a human-owned stop again → nothing, and the deferral stays for the next resume;
 *  - the merge request's head moved away from the revision the record was read at → the deferral
 *    is dropped: that diff is no longer the change, and the gate re-runs when the Developer stage
 *    that moved it completes;
 *  - a deferred `ask` on a task that is no longer `active` → dropped, Q91's answer;
 *  - a task that is `merged`, `retro` or `done` — a merge made on the provider ended its pause
 *    (Q104) → dropped, because a merged task cannot be returned;
 *  - otherwise the ending is performed, and the deferral cleared **in the same transaction** — the
 *    question insert and the record for `ask`, the return and the record for `block`.
 */
export const runDependencyGateResume = async (
  options: DependencyGateOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  if (taskId === undefined) {
    return;
  }
  const pending = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (pending === null || (pending.dependencies?.deferred_stage ?? null) === null) {
    return;
  }
  // Read outside every transaction, like the gate's own read (WP-56's deadline).
  const settings = await options.settings.forProject(pending.task.projectId);
  if (settings.configRefusal !== undefined) {
    // WP-106 review round 1: the deferred decision returns the task or asks with a deadline, and
    // both read the unreadable document. Parked by name instead.
    await parkForConfigRefusal(options, {
      taskId,
      refusal: settings.configRefusal,
      what: 'the deferred dependency decision',
    });
    return;
  }
  const deadlineFrom = questionDeadlineRule(options.calendar, settings);

  const outcome = await inTaskTransaction(
    options,
    taskId,
    'performing a deferred dependency decision',
    async (scope) => {
      const current = await loadLocked(options, scope, taskId);
      const record = current?.dependencies ?? null;
      const stage = record?.deferred_stage ?? null;
      if (current === null || record === null || stage === null) {
        return null;
      }
      const state = current.task.state;
      if (isHumanOwnedStop(state) || (isTerminalTaskState(state) && state !== 'done')) {
        return null;
      }
      const clear = async (why: string): Promise<null> => {
        await options.store.tasks.saveDependencies(
          scope.tx,
          taskId,
          taskDependenciesSchema.parse({ ...record, deferred_stage: null }),
        );
        logger.info({ task_id: taskId, state, decision: record.decision }, why);
        return null;
      };
      if (state === 'merged' || state === 'retro' || state === 'done') {
        // Q104: a merge made on the provider ended the pause (and the retrospective may already
        // have finished the task by the time this job fires). A merged task has no return edge, and
        // letting `applyDecision` fall back to its escalation would park a task whose work is on
        // the default branch — so the deferral is dropped, and the record keeps the packages.
        return clear(
          'dependency gate: the merge request was merged while the task was paused, so the deferred decision is dropped; the packages stay on the panel',
        );
      }
      const head = current.mr?.head_sha ?? null;
      if (record.head_sha !== null && head !== null && record.head_sha !== head) {
        return clear(
          'dependency gate: the merge request moved on from the revision the deferred decision was about, so it is dropped; the gate reads the new diff when the implementation completes',
        );
      }
      if (record.decision === 'ask' && record.question_id === null) {
        if (state !== 'active') {
          return clear(
            'dependency gate: the task had passed review before the deferred dependency question could be asked, so nobody was asked (Q91)',
          );
        }
        await askNow(options, scope, { current, record, stage, deadlineFrom, logger });
        return null;
      }
      if (record.decision === 'block') {
        await options.store.tasks.saveDependencies(
          scope.tx,
          taskId,
          taskDependenciesSchema.parse({ ...record, deferred_stage: null }),
        );
        // The names on the record were redacted before they were stored.
        return returnNow(options, scope, { current, stage, reason: blockReasonOf(record) });
      }
      return clear('dependency gate: nothing was left to perform for the deferred decision');
    },
  );
  if (outcome !== null && outcome.work !== null) {
    await enqueueStage(options.jobs, outcome.work);
    logger.info(
      { task_id: taskId, loop: DEPENDENCY_POLICY_LOOP },
      'dependency gate: the task resumed, so the deferred block sent it back to the stage that added the package',
    );
  }
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
