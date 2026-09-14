/**
 * The coverage delta — product/18:38, product/10:38's Checks item, BD-030 (WP-39).
 *
 * *"Test coverage change of the MR shown in Checks when the project's CI reports coverage"*, default
 * *"on when available"*, configuration *"coverage source"*. Three schemas have carried the **head**
 * number since WP-09 and nothing stored the **base**, so there was no delta; the work is the base,
 * its cache and its staleness rule, and not an integration — both provider reads already existed.
 *
 * A handler that decides and a `pipeline.outbound` duty that calls, which is the shape WP-15d
 * requires of anything that reaches a provider.
 *
 * ## Both numbers come from the same instrument, and that is the decision here
 *
 * `ci.pipeline.finished` carries a `coverage_pct` field and **this duty does not read it**. Two
 * reasons, in order of weight:
 *
 *  1. **A delta is only meaningful between two measurements of the same kind.** The base can only
 *     come from `getPipelineStatus`, because no webhook arrives for a commit nobody is watching. So
 *     the head is read the same way, and the subtraction is between two answers of one API rather
 *     than between a webhook's number and an API's.
 *  2. **The only adapter this build ships publishes no coverage on that event.** GitLab's documented
 *     Pipeline Hook carries `coverage` on neither `object_attributes` nor `builds[]`, so
 *     `gitlab/inbound.ts` fills the payload field with `null` and says so at the line. A duty that
 *     trusted the event would render *"not reported"* on every GitLab project — the exact failure
 *     this row's criterion 2 exists to prevent, arriving through the back door. `FakeGitProvider`
 *     *does* publish it (its divergence 13), which is precisely the kindness standing rule 1 warns
 *     about: an e2e driven off that field would be green on a build that cannot work.
 *
 * ## What one `ci.pipeline.finished` costs a provider
 *
 * Bounded, and in this order: the pipeline for the event's **head sha** (one read), the project's
 * **default branch** (one read), and that branch's pipeline (**one read, cached** — see below). So
 * **two or three reads**, and **zero** for a project whose `policies.coverage_source` is `'none'` or
 * whose pipeline reported no coverage at all: the base is never asked for when there is nothing to
 * subtract it from.
 *
 * ## The cache, its key and its lifetime
 *
 * **The cache is the task's own row.** `tasks.coverage` already has to store `base_sha` and
 * `base_pct` for the panel to name its base, so the next wake-up can read them back: if the default
 * branch has not moved since the last measurement and the stored base is a **number**, that number
 * is reused and no `get_pipeline_status` is made for it.
 *
 *  - **key**: `(task_id, base_sha)` — the row, and the sha recorded in it.
 *  - **lifetime**: the life of the task row. It is invalidated by exactly one thing, the default
 *    branch moving. The one case that is not: a base pipeline **re-run on the same sha** reporting a
 *    different number — the stored base is kept, deliberately, because a re-run does not move the
 *    branch and the row is the platform's record of what the delta was measured against.
 *  - **not** an in-process map, deliberately: a `Map` would be per process, would need a TTL nobody
 *    can derive, and would be empty after every deploy. The row survives a restart and is the same
 *    value the panel renders, so the cache cannot disagree with what a maintainer is looking at.
 *
 * **One deviation from "at most once per task per base sha", stated rather than hidden**: a base
 * whose stored `base_pct` is `null` **is** read again on the next pipeline event. A `null` there
 * means the default branch's pipeline had not reported a number *yet* — it may still have been
 * running — and caching that would pin *"no base"* for the whole life of the branch, which is a
 * wrong answer kept alive by an optimisation. The retry is bounded by the number of pipelines that
 * finish on this merge request, which is a handful.
 *
 * The **head** is never cached: a pipeline can be re-run on the same revision and report a different
 * number, and the whole point of the record is to be the last thing the CI said.
 *
 * ## What this build cannot do
 *
 * One percentage point for the whole change. Per-file coverage needs the coverage *artifact*
 * (`GitProviderCapabilities.coverageArtifacts`) and nothing downloads one — see
 * `packages/domain/src/policies/coverage.ts`, which states the same limit beside the arithmetic, and
 * `policies.coverage_source`, which has no `'artifact'` value to promise otherwise.
 */
import type { Id, TaskCoverage } from '@platform/contracts';
import { taskCoverageSchema } from '@platform/contracts';
import { coverageDeltaPoints, coverageSourceOf } from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { gitReads, integrationsForProject, noRunScopedSecrets } from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData } from './jobs.js';
import type { RebaseJobOptions } from './rebase.js';
import type { PipelineSagaOptions } from './saga.js';
import type { StoredTask } from './store.js';

export type CoverageOptions = RebaseJobOptions;

/**
 * `ci.pipeline.finished` → decide to measure, and let the job call.
 *
 * Priority **120**, the integrations band, beside the conflict warning and the reviewer routing:
 * this tells the outside world nothing, but it *asks* the outside world something, and the core
 * band's own consumer of this event — `pipeline.ci` at priority 10, the CI gate — must settle the
 * gate first. It does not depend on that settlement in any way; it is the band the rule puts a
 * provider call in.
 *
 * The task is found the way the CI gate finds it, by the event's merge request, because
 * `ci.pipeline.finished.task_id` is `null` on every delivery a provider normalises: a webhook knows
 * a merge request and not a platform task.
 */
const coverageHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.coverage',
  priority: 120,
  eventTypes: ['ci.pipeline.finished'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'ci.pipeline.finished') {
      return;
    }
    const iid = event.payload.mr?.iid;
    if (iid === undefined || iid === null) {
      // A pipeline on a branch with no merge request — a push to the default branch, most often.
      // It is the *base* of somebody else's delta and is read when that task's own pipeline
      // finishes; there is no task to record it on here.
      return;
    }
    const stored = await options.store.tasks.findByMergeRequest(context.scope.tx, {
      projectId: event.payload.project_id,
      iid,
    });
    if (stored === null || stored.task.state === 'done' || stored.task.state === 'cancelled') {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'coverage',
      project_id: event.payload.project_id,
      task_id: stored.task.id,
      cause_event_id: event.id,
      // The revision the pipeline ran on, which is the event's and not the task row's: a merge
      // request whose head moved while the pipeline ran must not have the old pipeline's number
      // filed under the new revision.
      head_sha: event.payload.head_sha,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/** Every handler this module registers, for the runtime to spread. */
export const coverageHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  coverageHandler(options),
];

/**
 * The base this measurement reuses, or `null` when it has to be read.
 *
 * The whole cache, and it is four lines because the state it reads is the record the panel already
 * shows. See the module docblock for the key, the lifetime and the one case it deliberately does
 * not cache.
 */
export const cachedBasePct = (stored: StoredTask, baseSha: string): number | null => {
  const previous = stored.coverage;
  if (previous === null || previous.base_sha !== baseSha) {
    return null;
  }
  return previous.base_pct;
};

/**
 * `pipeline.outbound` duty **coverage**: what the CI said about this revision, against the default
 * branch.
 *
 * **What it re-validates on fire** (TD-004): the task still exists and is not terminal. It does not
 * require the task to be at any particular stage — a pipeline finishes when it finishes, and the
 * number belongs on the row whatever the task is doing.
 */
export const runCoverage = async (
  options: CoverageOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  const headSha = typeof data.head_sha === 'string' ? data.head_sha : null;
  if (taskId === undefined || headSha === null) {
    return;
  }
  const stored = await options.unitOfWork.transaction(async (scope) => {
    const loaded = await options.store.tasks.load(scope.tx, taskId);
    if (loaded === null || loaded.task.state === 'done' || loaded.task.state === 'cancelled') {
      return null;
    }
    return loaded;
  });
  if (stored === null) {
    return;
  }

  const settings = await options.settings.forProject(stored.task.projectId);
  const source = coverageSourceOf(settings.config.policies);
  if (source === 'none') {
    // product/18:38's key, doing the one thing it can do. Nothing is read and nothing is stored, so
    // a task page shows "not measured" — which is what the definition beside it says this means.
    logger.info(
      { task_id: stored.task.id, coverage_source: source },
      'coverage: this project has turned the coverage source off, so nothing was read',
    );
    return;
  }

  // Outside every transaction (WP-15d), and outside a run, so the call's scope holds no minted
  // credential (Q55).
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  if (integrations.git === null) {
    // A project whose git integration was removed keeps running (standing rule 20). It is checked
    // by identity rather than by a `null` status, because `gitReads.pipelineStatus` answers `null`
    // for *"no binding"* and for *"no pipeline for this commit"* and those are different facts —
    // the asymmetry `gates.ts` states for the CI gate, where collapsing them was a fail-open.
    logger.info(
      { task_id: stored.task.id },
      'coverage: this project has no git binding, so there is nothing to read a pipeline from',
    );
    return;
  }
  const reads = gitReads(integrations);
  const context = { projectId: stored.task.projectId, taskId: stored.task.id };

  const head = await reads.pipelineStatus(headSha, context);
  const headPct = head?.coverage_pct ?? null;
  if (headPct === null) {
    // **Missing, never zero** (standing rule 16). The record is still written — *"the pipeline
    // finished and reported no coverage"* is a fact about this project's CI and is what the panel
    // prints — and the base is **not** read, because there is nothing to subtract it from.
    await save(options, stored.task.id, {
      head_sha: headSha,
      head_pct: null,
      base_branch: null,
      base_sha: null,
      base_pct: null,
      delta_pct: null,
      measured_at: options.clock.now(),
    });
    logger.info(
      { task_id: stored.task.id, head_sha: headSha },
      head === null
        ? 'coverage: the provider has no pipeline for this revision, so there is no coverage to report'
        : 'coverage: this project’s pipeline reports no coverage, so the panel says so rather than showing a zero',
    );
    return;
  }

  const target = await reads.defaultBranch(context);
  if (target === null) {
    // Unreachable behind the binding check above, and kept for the reason `gates.ts` keeps its
    // twin (standing rule 22): the type still admits `null`, and a `??`-shaped shortcut here would
    // invent a base branch. The head number is recorded on its own, which is honest — a delta
    // needs a base and there is none.
    await save(options, stored.task.id, {
      head_sha: headSha,
      head_pct: headPct,
      base_branch: null,
      base_sha: null,
      base_pct: null,
      delta_pct: null,
      measured_at: options.clock.now(),
    });
    return;
  }

  const cached = cachedBasePct(stored, target.sha);
  const basePct = cached ?? (await reads.pipelineStatus(target.sha, context))?.coverage_pct ?? null;
  const record: TaskCoverage = {
    head_sha: headSha,
    head_pct: headPct,
    base_branch: target.branch,
    base_sha: target.sha,
    base_pct: basePct,
    delta_pct: coverageDeltaPoints(headPct, basePct),
    measured_at: options.clock.now(),
  };
  await save(options, stored.task.id, record);
  logger.info(
    {
      task_id: stored.task.id,
      head_sha: headSha,
      head_pct: headPct,
      base_branch: target.branch,
      base_sha: target.sha,
      base_pct: basePct,
      delta_pct: record.delta_pct,
      base_from_cache: cached !== null,
    },
    basePct === null
      ? 'coverage: the default branch’s pipeline reports no coverage, so there is a head number and no delta'
      : 'coverage: measured against the default branch',
  );
};

/**
 * The narrow write, in a transaction of its own.
 *
 * Never `save`: this job runs beside the stage executor's transactions, so a whole-row write would
 * put back the state, the stage and the cost as they were when the job started (standing rule 79).
 * The record is parsed by the store on the way in, which is where a shape the panel cannot render
 * is refused (WP-15h).
 */
const save = async (
  options: CoverageOptions,
  taskId: Id,
  coverage: TaskCoverage,
): Promise<void> => {
  await options.unitOfWork.transaction(async (scope) => {
    await options.store.tasks.saveCoverage(scope.tx, taskId, taskCoverageSchema.parse(coverage));
  });
};
