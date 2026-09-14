/**
 * Risk classes from the merge request's own diff, and the reviewers they route to — product/19 §14
 * and product/19:138, BD-030 (WP-37).
 *
 * A handler that decides and a `pipeline.outbound` duty that calls, which is the shape WP-15d
 * requires of anything that reaches a provider. It closes the two halves PROGRESS backlog 73 named:
 * `tasks.risk_classes` had no writer and the task page rendered it empty on every task, and
 * `readCodeowners` had been built at WP-09 and called by nothing.
 *
 * ## When, and why this is the rebase gate rather than the merge request opening
 *
 * On `task.stage.entered` for the rebase gate — the same trigger WP-26's conflict warning uses, and
 * for the same two reasons: the gate is entered once before Ready and again on every
 * `default_branch.moved` that finds the task waiting, so the classes are computed from the diff as
 * it stands each time the merge request is about to be looked at by a human. A trigger on
 * `mr.opened` would classify the first push and never the fifth.
 *
 * It is a **second duty rather than a branch inside `conflict_warn`**, and the cost of that is
 * stated rather than hidden: this duty reads the merge request's changed paths again, so a gate
 * entry now makes one more `get_merge_request_diff` than it did. The alternative was one duty doing
 * two unrelated things whose early returns are not the same — `conflict_warn` gives up when the
 * project has no peer task, which is exactly the ordinary case in which a task still needs its
 * classes and its reviewers. Sharing the read would have meant the commonest task on the commonest
 * project silently getting neither.
 *
 * ## What one gate entry costs a provider
 *
 * Bounded, and in this order: the merge request's **changed files**, the project's **default
 * branch**, that branch's **`CODEOWNERS`** — three reads, made on every gate entry, because they
 * are what "is there anything to route" is answered *from* — then one `resolve_user_id` per routed
 * handle up to {@link MAX_ROUTED_REVIEWERS}, and finally `set_reviewers`, which re-reads the merge
 * request because the union with whoever is already assigned is computed where the call is made
 * (standing rule 44). A project with no classes, no `CODEOWNERS` and no configured reviewers
 * therefore pays **three reads and no write**: nothing is looked up and nothing is assigned.
 *
 * The merge request itself is deliberately **not** read for its `target_branch`: the platform opens
 * every merge request it routes against the default branch (BD-025's namespace targets it), and
 * `CODEOWNERS` has to be read from a branch the change cannot edit anyway — so the default branch
 * answers both questions for one read instead of two.
 *
 * ## Everything here is untrusted text (BD-022)
 *
 * A repository path, a `CODEOWNERS` line and a handle are all written by whoever can push to the
 * repository — in a fork workflow, by a contributor. So: paths are redacted through the binding's
 * redactor before they are compared or stored, exactly as `conflict-warning.ts` does and for the
 * same reason (an exact-match redactor cannot find a secret a cap has already halved); a handle is
 * never interpolated into a provider request by this module — it goes through the port's own
 * `resolveUserId`, which answers a provider-issued id or `null`; and the classes written to the row
 * are **the project's own class names**, never a string the repository chose.
 */
import type { Id, RiskClass } from '@platform/contracts';
import { MAX_ROUTED_REVIEWERS } from '@platform/contracts';
import {
  codeownersFor,
  resolveReviewerRouting,
  reviewersRequiredByClasses,
  riskClassesForPaths,
} from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { InboundIdentityDirectory } from '../integrations/inbound.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { MAX_CONFLICT_FILES } from './conflict-warning.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  reviewWrites,
} from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData } from './jobs.js';
import { REBASE_GATE_STAGE, type RebaseJobOptions } from './rebase.js';
import type { PipelineSagaOptions } from './saga.js';
import type { StoredTask } from './store.js';

export interface RiskRoutingOptions extends RebaseJobOptions {
  /**
   * The provider-account ↔ platform-user map, read in the **other** direction from the inbound
   * path's (WP-37).
   *
   * It is the same collaborator the ask handler is given rather than a second port, because the
   * mapping is one table and `forProvider` already answers with the whole of it for a provider —
   * inverting a map of a handful of rows is cheaper than a second query somebody has to keep in
   * step. The cost is stated: a large organisation loads every mapped identity of the provider to
   * answer one question, which is the same cost the inbound normaliser already pays per delivery.
   */
  readonly identities: InboundIdentityDirectory;
}

/**
 * The idempotency key of one reviewer assignment.
 *
 * **No part of it is provider prose** (the rule WP-24 round 2 set): the task id and the merge
 * request's head sha. So a second gate entry on an unchanged revision replays instead of assigning
 * again, and a revision that moved is a new assignment — which is right, because the files may now
 * fall into different classes and route to different people.
 */
export const reviewerRoutingIdempotencyKey = (taskId: Id, headSha: string): string =>
  `set_reviewers:${taskId}:${headSha}`;

/**
 * `task.stage.entered` at the rebase gate → decide to route, and let the job call.
 *
 * Priority **120**, the integrations band, beside the conflict warning it shares a trigger with:
 * both tell the outside world about a transition the core band has already decided. The two run in
 * queue order rather than in TD-005 order once they are enqueued, which is the property WP-15d
 * states for every outbound duty — nothing here depends on the other having run.
 */
const riskRoutingHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.risk.routing',
  priority: 120,
  eventTypes: ['task.stage.entered'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.stage.entered' || event.payload.stage !== REBASE_GATE_STAGE) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'risk_route',
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
export const riskRoutingHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  riskRoutingHandler(options),
];

/**
 * The provider account of the human who asked for this task, or `null`.
 *
 * Step three of product/19:138, and **it resolves to nobody on this build** — twice over, which is
 * why both halves are named here rather than in one sentence. `tasks.requested_by_user_id` has no
 * writer at all (`StoredTask.requestedByUserId`), and `user_identities` is empty until an operator
 * fills it through `POST /api/org/identities` (PROGRESS backlog 79). The caller logs which of the
 * two it hit, because *"the fallback found nobody"* and *"there is no fallback"* are different
 * things to an operator deciding whether to map an identity.
 */
const requesterAccount = async (
  options: RiskRoutingOptions,
  provider: string,
  userId: Id | null,
): Promise<string | null> => {
  if (userId === null) {
    return null;
  }
  const map = await options.identities.forProvider(provider);
  for (const [externalId, mapped] of map) {
    if (mapped === userId) {
      return externalId;
    }
  }
  return null;
};

/**
 * `pipeline.outbound` duty **risk_route**: classify this task's merge request and route its
 * reviewers.
 *
 * **What it re-validates on fire** (TD-004): the task still exists, is not terminal, and still has
 * a merge request. It does *not* require the task to still be sitting at the rebase gate — the gate
 * is evaluated by a `stage.execute` job that routinely settles before this one runs, so that
 * condition would be a classification that almost never happens (the same reading `conflict_warn`
 * states).
 */
export const runRiskRouting = async (
  options: RiskRoutingOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  if (taskId === undefined) {
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
  // Outside every transaction (WP-15d), and outside a run, so the call's scope holds no minted
  // credential (Q55).
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const reads = gitReads(integrations);
  const writes = reviewWrites(integrations);
  const redactor = integrations.git?.redactor ?? null;
  const redact = (value: string): string =>
    redactor === null ? value : redactor.redactText(value).value;
  const context = { projectId: stored.task.projectId, taskId: stored.task.id };

  const files = await reads.mergeRequestDiff(stored.mr, MAX_CONFLICT_FILES, context);
  if (files === null) {
    // No git binding: nothing to classify and nobody to assign. A project whose integration was
    // removed keeps running (standing rule 20).
    return;
  }
  // Redacted **before** anything compares or stores them, for `changedPathsOf`'s stated reason.
  const paths = files.map((file) => redact(file.new_path));

  const classes = settings.config.policies?.risk_classes as
    | Readonly<Record<string, RiskClass>>
    | undefined;
  const matched = riskClassesForPaths(classes, paths);
  await options.unitOfWork.transaction(async (scope) => {
    // Narrow, never `save`: this job runs beside the stage executor's transactions (rule 79).
    await options.store.tasks.saveRiskClasses(scope.tx, stored.task.id, matched);
  });
  logger.info(
    {
      task_id: stored.task.id,
      files: files.length,
      declared_classes: classes === undefined ? 0 : Object.keys(classes).length,
      risk_classes: matched,
    },
    classes === undefined
      ? 'risk routing: this project declares no risk classes, so nothing was classified'
      : 'risk routing: the merge request’s changed paths were classified',
  );

  await routeReviewers(options, {
    stored,
    paths,
    matched,
    classes,
    /**
     * `policies.reviewers` — step two, bounded here as well as at the schema.
     *
     * The schema caps the key at {@link MAX_ROUTED_REVIEWERS}; a document stored before that cap
     * existed is not re-validated on its way out of the row, and this is where the provider calls
     * are made, so the cut is applied at the spend as well as at the write.
     */
    configured: (settings.config.policies?.reviewers ?? []).slice(0, MAX_ROUTED_REVIEWERS),
    reads,
    writes,
    redact,
    logger,
  });
};

interface RoutingInput {
  readonly stored: StoredTask;
  readonly paths: readonly string[];
  readonly matched: readonly string[];
  readonly classes: Readonly<Record<string, RiskClass>> | undefined;
  readonly configured: readonly string[];
  readonly reads: ReturnType<typeof gitReads>;
  readonly writes: ReturnType<typeof reviewWrites>;
  readonly redact: (value: string) => string;
  readonly logger: Logger;
}

/** product/19:138's three steps, the classes' additions, and the one call that follows. */
const routeReviewers = async (options: RiskRoutingOptions, input: RoutingInput): Promise<void> => {
  const { stored, logger } = input;
  const context = { projectId: stored.task.projectId, taskId: stored.task.id };
  const ref = stored.mr;
  if (ref === null) {
    return;
  }
  const provider = ref.provider ?? null;

  /**
   * **`CODEOWNERS` is read at the default branch, never inside the change** — and that is a
   * security property rather than a convenience.
   *
   * A merge request may edit `CODEOWNERS` itself, so routing by the version *in* the change would
   * let whoever wrote the change appoint their own reviewer (BD-022: in a fork workflow that is a
   * contributor). The default branch is also the branch the platform opens every merge request
   * against — BD-025's branch namespace targets it — so it is the merge request's target as well as
   * the trusted copy. A merge request the platform did not open never reaches this duty: a
   * review-only task carries its merge request in `review_subject` and has no `mr` at all.
   *
   * **And it is asserted rather than stated** (standing rule 3), at three levels, because round 1
   * shipped this paragraph with no test behind it and the reviewer measured a build that read the
   * file from `stored.mr.branch` passing every tier: the unit double answers a *different* file per
   * ref and records the refs it was asked for, `FakeGitProvider` keeps `CODEOWNERS` per ref (its
   * divergence 12) so the shared contract suite can hold every adapter to it, and the e2e plants a
   * hostile file on the branch under review and reads the production audit row's `ref` back.
   */
  const target = await input.reads.defaultBranch(context);
  const rules = target === null ? null : await input.reads.codeowners(target.branch, context);
  const routing = resolveReviewerRouting({
    codeowners: codeownersFor(rules, input.paths).map(input.redact),
    configured: input.configured,
    requester:
      provider === null
        ? null
        : await requesterAccount(options, provider, stored.requestedByUserId),
    classReviewers: reviewersRequiredByClasses(input.classes, input.matched),
    limit: MAX_ROUTED_REVIEWERS,
  });

  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const handle of routing.handles) {
    const externalId = await input.reads.userId(handle, context);
    if (externalId === null) {
      unresolved.push(handle);
      continue;
    }
    if (!resolved.includes(externalId)) {
      resolved.push(externalId);
    }
  }

  if (unresolved.length > 0) {
    // **Named, never silent** (standing rule 18, and PROGRESS backlog 79). A `CODEOWNERS` naming a
    // group, a team or somebody who has left is the ordinary state of a real repository, and the
    // platform's answer is to say whose review it could not ask for.
    logger.info(
      { task_id: stored.task.id, source: routing.source, unresolved },
      'risk routing: these reviewer handles resolve to no account on this provider, so nobody was assigned for them',
    );
  }
  if (routing.truncated) {
    logger.warn(
      { task_id: stored.task.id, limit: MAX_ROUTED_REVIEWERS },
      'risk routing: more reviewers were routed than one merge request may carry; the rest were dropped',
    );
  }
  if (resolved.length === 0) {
    logger.info(
      { task_id: stored.task.id, source: routing.source, routed: routing.handles.length },
      routing.source === 'none'
        ? 'risk routing: no CODEOWNERS match, no project reviewers and no mapped requester, so this merge request is assigned to nobody'
        : 'risk routing: nothing the precedence chose could be resolved to an account, so this merge request is assigned to nobody',
    );
    return;
  }

  /**
   * **No revision, no assignment** — the answer `conflict_warn` gives for its own key, and the same
   * reason. `MergeRequestRef.head_sha` is nullish, and the sha is what makes the idempotency key an
   * *identity*: keying on the task alone would assign once for the life of the merge request however
   * many times its files changed, and keying on a placeholder would do the same under a name that
   * reads like a revision. It costs one assignment and says so.
   */
  const headSha = ref.head_sha ?? null;
  if (headSha === null) {
    logger.info(
      { task_id: stored.task.id, iid: ref.iid },
      'risk routing: no head commit on the merge request, so no reviewers were assigned',
    );
    return;
  }
  await input.writes.reviewers(
    {
      ref,
      externalIds: resolved,
      idempotencyKey: reviewerRoutingIdempotencyKey(stored.task.id, headSha),
    },
    { ...context, mode: stored.task.mode },
  );
  logger.info(
    {
      task_id: stored.task.id,
      source: routing.source,
      required_by_class: routing.required,
      assigned: resolved.length,
    },
    'risk routing: reviewers assigned',
  );
};
