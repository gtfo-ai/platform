/**
 * Starting a history bootstrap — product/06 step 3b, product/18:27, product/19 §18 (WP-35).
 *
 * > *"Offer to mine the last N merged MRs (default 200) with their review comments and closed
 * > tickets for conventions, pitfalls and recurring reviewer requests. Results are KB proposals with
 * > provenance (MR links) in the proposal queue, never applied silently. Shows an estimated cost
 * > before running."*
 *
 * ## What this command does, and what it deliberately does not
 *
 * It **records the intent and hands over**: one `history_bootstrap_batches` row carrying what the
 * operator asked for and what they were shown, then a `bootstrap.history` job. It makes **no
 * provider call at all**, which is the difference between this command and `startShadowBatch`, and
 * the reason is arithmetic rather than taste: a shadow batch reads one merge-request listing and one
 * ticket per key, at most 26 requests; a bootstrap at the default N reads **1 + 200 + 1 + 1 + 5 per
 * chunk** — the listing, one discussion fetch per merge request (`MergedMergeRequest` carries a
 * *count* and not the comments, so *"with their review comments"* is a fan-out the port cannot
 * avoid), the commit list, the closed-ticket match and one `readTicket` per ticket kept. That is
 * **253 provider reads at N = 200**, stated here because PROGRESS backlog 64 asks for the number to
 * be in the change, and it is not something to do inside an HTTP request that a browser is waiting
 * on.
 *
 * The **volume is bounded and the bound is the rate limiter's**: every one of those reads goes
 * through `IntegrationActionExecutor`, which takes the account's rate-limit budget and delays rather
 * than refusing, so a bootstrap is slow on a busy account rather than a burst somebody else pays
 * for. Backlog 64's remedy — *"ask for the fields you need"* — is **considered and unavailable
 * here**: GitLab publishes a merge request's discussions only on its own endpoint (there is no
 * `include=discussions` on the list), which is the same finding that entry records for the diffs
 * endpoint, so the fan-out is the port's shape rather than this caller's choice.
 *
 * ## The three refusals, and which question each answers
 *
 *  - `feature_disabled` — BD-028's opt-in (`features.history_bootstrap.enabled`), which product/18
 *    ships **off**: *"off (offered in wizard)"*. It is published by the read endpoint so the wizard
 *    states the reason instead of offering a button that answers 409.
 *  - `no_git_binding` — there is no repository to mine. Refused rather than started and found empty,
 *    because "this project has no git integration" is a thing an operator can fix and "the batch
 *    found nothing" is not.
 *  - `already_running` — the project has a batch that has not finished. A second one would re-read
 *    the same history, create a second set of tasks and spend a second cap for an answer the first
 *    is already producing. The unique index `history_bootstrap_batches_one_live` is what decides a
 *    race; this read is what turns the loser into an answer rather than a constraint violation —
 *    **and the write below catches the one case the read cannot**, two commands that both read
 *    before either inserts, by answering `LiveHistoryBootstrapError` with the same refusal. Until
 *    that mapping existed the loser of a genuine race got an unmapped `23505`, which the route
 *    turns into a 500 for a caller whose honest answer is "you already have one in flight"
 *    (WP-35 review round 2).
 *
 * and one that is about the request rather than the project: `merge_requests_out_of_range`, which is
 * product/19's *"default 200, max 1 000"*. It is checked **here** as well as in the request schema
 * because N has two sources — the caller's body and the project's own
 * `features.history_bootstrap.merge_requests` — and a bound that only the wire checks is not a bound
 * on the other path (standing rule 14).
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  BOOTSTRAP_BATCH_SIZE,
  DEFAULT_BOOTSTRAP_BUDGET_USD,
  DEFAULT_BOOTSTRAP_DAYS,
  DEFAULT_BOOTSTRAP_MERGE_REQUESTS,
  MAX_BOOTSTRAP_DAYS,
  MAX_BOOTSTRAP_MERGE_REQUESTS,
} from '@platform/contracts';
import {
  DEFAULT_STAGE_RUN_BUDGET_USD,
  estimateHistoryBootstrap,
  HISTORY_BOOTSTRAP_TEMPLATE_ID,
} from '@platform/domain';
import type { ProjectSettings, ProjectSettingsPort } from '../pipeline/settings.js';
import type { Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { HistoryBootstrapStore } from './ports.js';
import { LiveHistoryBootstrapError } from './ports.js';

/** The stage a mining run is; `DEFAULT_STAGE_RUN_BUDGET_USD` keys the per-run cap by it. */
export const HISTORY_MINING_STAGE = 'history_mining';

export type HistoryBootstrapBlocker =
  | 'feature_disabled'
  | 'no_git_binding'
  | 'already_running'
  | 'merge_requests_out_of_range';

export const HISTORY_BOOTSTRAP_BLOCKED_DETAIL: Readonly<Record<HistoryBootstrapBlocker, string>> = {
  feature_disabled:
    'the history bootstrap is off for this project; turn it on in settings (features.history_bootstrap.enabled) before starting one',
  no_git_binding:
    'this project has no git integration bound, so there is no merged history to mine; bind one first',
  already_running:
    'this project already has a history bootstrap that has not finished; a second one would re-read the same history and spend a second cap',
  merge_requests_out_of_range: `the number of merge requests must be between 1 and ${MAX_BOOTSTRAP_MERGE_REQUESTS} (product/19 §18)`,
};

/** The estimate the wizard is shown before start, and the batch records. */
export interface HistoryBootstrapEstimateResult {
  readonly mergeRequests: number;
  readonly batchSize: number;
  readonly batches: number;
  readonly estimatedUsd: number;
  readonly capUsd: number;
  readonly stopsAtCap: boolean;
  readonly days: number;
}

/** `features.history_bootstrap`, with every default applied. */
export interface HistoryBootstrapSettings {
  readonly enabled: boolean;
  readonly mergeRequests: number;
  readonly days: number;
  readonly capUsd: number;
}

const featureOf = (settings: ProjectSettings) =>
  (
    settings.config.features as
      | {
          readonly history_bootstrap?: {
            readonly enabled?: boolean;
            readonly merge_requests?: number;
            readonly days?: number;
            readonly budget_usd?: number;
          };
        }
      | undefined
  )?.history_bootstrap;

/**
 * The project's bootstrap configuration with product/19's defaults applied.
 *
 * Exported because the **read** endpoint publishes the estimate it feeds, and a screen that
 * re-derived the defaults would be the second spelling of one rule (standing rule 9).
 */
export const historyBootstrapSettings = (settings: ProjectSettings): HistoryBootstrapSettings => {
  const feature = featureOf(settings);
  const configured = feature?.merge_requests;
  const days = feature?.days;
  const cap = feature?.budget_usd;
  return {
    enabled: feature?.enabled === true,
    mergeRequests:
      typeof configured === 'number' && Number.isInteger(configured) && configured > 0
        ? configured
        : DEFAULT_BOOTSTRAP_MERGE_REQUESTS,
    days:
      typeof days === 'number' && Number.isInteger(days) && days > 0 && days <= MAX_BOOTSTRAP_DAYS
        ? days
        : DEFAULT_BOOTSTRAP_DAYS,
    capUsd:
      typeof cap === 'number' && Number.isFinite(cap) && cap > 0
        ? cap
        : DEFAULT_BOOTSTRAP_BUDGET_USD,
  };
};

/**
 * What a batch of `mergeRequests` would cost, at the per-run ceiling.
 *
 * The arithmetic is `estimateHistoryBootstrap`'s and the per-run figure is
 * `DEFAULT_STAGE_RUN_BUDGET_USD.history_mining` — the *cap* a mining run is given, not a prediction
 * of what it spends. product/19's $20 default is exactly what the default N costs this way, which is
 * why the estimate and the cap can be the same number without either being invented.
 */
export const estimateFor = (
  settings: ProjectSettings,
  mergeRequests: number,
): HistoryBootstrapEstimateResult => {
  const resolved = historyBootstrapSettings(settings);
  const runBudgetUsd =
    settings.config.stages?.[HISTORY_MINING_STAGE]?.budget_usd ??
    DEFAULT_STAGE_RUN_BUDGET_USD[HISTORY_MINING_STAGE] ??
    2;
  const estimate = estimateHistoryBootstrap({
    mergeRequests,
    batchSize: BOOTSTRAP_BATCH_SIZE,
    capUsd: resolved.capUsd,
    runBudgetUsd,
  });
  return {
    mergeRequests,
    batchSize: BOOTSTRAP_BATCH_SIZE,
    batches: estimate.batches,
    estimatedUsd: estimate.estimatedUsd,
    capUsd: resolved.capUsd,
    stopsAtCap: estimate.stopsAtCap,
    days: resolved.days,
  };
};

/**
 * Whether this project may start a bootstrap, and the sentence to say when it may not.
 *
 * Exported because the read endpoint publishes it: a screen that offered a button and then showed a
 * 409 would be telling a maintainer the answer twice, once uselessly (`shadowBatchBlocker`'s rule).
 * The two facts it cannot read off the settings — whether a git binding exists and whether a batch
 * is live — arrive as arguments, so this stays a pure function of what the caller has already read.
 */
export const historyBootstrapBlocker = (
  settings: ProjectSettings,
  world: { readonly hasGitBinding: boolean; readonly liveBatch: boolean },
): HistoryBootstrapBlocker | null => {
  if (!historyBootstrapSettings(settings).enabled) {
    return 'feature_disabled';
  }
  if (!world.hasGitBinding) {
    return 'no_git_binding';
  }
  if (world.liveBatch) {
    return 'already_running';
  }
  return null;
};

export interface StartHistoryBootstrapOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: HistoryBootstrapStore;
  readonly settings: ProjectSettingsPort;
  readonly jobs: Jobs;
  readonly ids: { next(): Id };
  readonly clock: { now(): IsoDateTime };
  /**
   * Whether the project has a git binding — read without decrypting a credential.
   *
   * A function rather than the resolved bindings, because this command makes **no provider call**:
   * resolving would decrypt the account's token to answer a question a row already answers, on the
   * one path a browser waits for.
   */
  readonly hasGitBinding: (projectId: Id) => Promise<boolean>;
  readonly logger?: Logger;
}

export type StartHistoryBootstrapResult =
  | {
      readonly status: 'started';
      readonly batchId: Id;
      readonly estimate: HistoryBootstrapEstimateResult;
    }
  | {
      readonly status: 'blocked';
      readonly blocker: HistoryBootstrapBlocker;
      readonly detail: string;
    };

/** What the collect half of `bootstrap.history` is woken with. */
export interface HistoryCollectJobData {
  readonly kind: 'collect';
  readonly batch_id: string;
  readonly project_id: string;
  readonly [key: string]: unknown;
}

export const startHistoryBootstrap = async (
  options: StartHistoryBootstrapOptions,
  input: {
    readonly projectId: Id;
    readonly mergeRequests: number | null;
    readonly requestedByUserId: Id | null;
  },
): Promise<StartHistoryBootstrapResult> => {
  const logger = options.logger ?? silentLogger;
  const { projectId } = input;
  const settings = await options.settings.forProject(projectId);
  const configured = historyBootstrapSettings(settings);
  const mergeRequests = input.mergeRequests ?? configured.mergeRequests;

  if (
    !Number.isInteger(mergeRequests) ||
    mergeRequests < 1 ||
    mergeRequests > MAX_BOOTSTRAP_MERGE_REQUESTS
  ) {
    return {
      status: 'blocked',
      blocker: 'merge_requests_out_of_range',
      detail: HISTORY_BOOTSTRAP_BLOCKED_DETAIL.merge_requests_out_of_range,
    };
  }

  const hasGitBinding = await options.hasGitBinding(projectId);
  const live = await options.unitOfWork.transaction(async (scope) =>
    options.store.liveBatch(scope.tx, projectId),
  );
  const blocker = historyBootstrapBlocker(settings, {
    hasGitBinding,
    liveBatch: live !== null,
  });
  if (blocker !== null) {
    return {
      status: 'blocked',
      blocker,
      detail: HISTORY_BOOTSTRAP_BLOCKED_DETAIL[blocker],
    };
  }

  const estimate = estimateFor(settings, mergeRequests);
  const batchId = options.ids.next();
  try {
    await options.unitOfWork.transaction(async (scope) => {
      await options.store.createBatch(scope.tx, {
        id: batchId,
        projectId,
        requestedBy: input.requestedByUserId,
        mergeRequests,
        batchSize: estimate.batchSize,
        days: estimate.days,
        capUsd: estimate.capUsd,
        estimatedUsd: estimate.estimatedUsd,
      });
    });
  } catch (error) {
    if (!(error instanceof LiveHistoryBootstrapError)) {
      throw error;
    }
    // The race the `liveBatch` read above cannot close: both commands read no live batch, and the
    // partial unique index decided between them. The loser is told exactly what the read tells a
    // later caller, so the two paths give one answer rather than two (standing rule 9), and the
    // transaction rolled back — there is no half-created batch and no job was enqueued.
    logger.info(
      { project_id: projectId, batch_id: batchId },
      'a history bootstrap lost the race for this project’s one live batch; refused as already_running',
    );
    return {
      status: 'blocked',
      blocker: 'already_running',
      detail: HISTORY_BOOTSTRAP_BLOCKED_DETAIL.already_running,
    };
  }

  /**
   * After the commit, because `Jobs.enqueue` does not join the transaction (TD-004).
   *
   * **The residual, stated rather than implied** (standing rule 78 — a recovery claim is a claim
   * about code that exists): a process that dies in this window leaves a batch sitting at
   * `collecting` for ever, and because the unique index admits one live batch per project, every
   * later attempt answers `already_running`. Nothing reconciles it on this build — the wizard shows
   * a bootstrap that never starts, and an operator's way out is to delete the row. It is the shape
   * `startProjectDiscovery` records for its own enqueue and is in `PROGRESS.md` under discovered
   * work with that one so both can be scheduled rather than remembered.
   */
  const data: HistoryCollectJobData = {
    kind: 'collect',
    batch_id: batchId,
    project_id: projectId,
  };
  await options.jobs.enqueue({ queue: JOB_QUEUES.historyBootstrap, data });

  logger.info(
    {
      project_id: projectId,
      batch_id: batchId,
      merge_requests: mergeRequests,
      batches: estimate.batches,
      estimated_usd: estimate.estimatedUsd,
      cap_usd: estimate.capUsd,
      template: HISTORY_BOOTSTRAP_TEMPLATE_ID,
    },
    'a history bootstrap was started',
  );
  return { status: 'started', batchId, estimate };
};
