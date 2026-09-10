/**
 * GitLab's vocabulary translated into the GitProvider port's.
 *
 * Pure functions, no I/O: everything here is unit-testable without a transport, which is why the
 * three-state mergeability rule — the one WP-26's rebase gate depends on — is a function rather
 * than a branch buried in a request handler.
 */
import {
  IntegrationError,
  type MergeRequestState,
  type PipelineStatusValue,
} from '@platform/application';
import { GITLAB_PROVIDER_ID } from './http.js';

/**
 * How mergeable a merge request is, in the port's three states.
 *
 * The documentation is explicit and it is the whole reason this is not a boolean
 * (<https://docs.gitlab.com/api/merge_requests/#single-merge-request-response-notes>, retrieved
 * 2026-09-10):
 *
 * > The mergeability (`merge_status`) of each merge request is checked **asynchronously** when a
 * > request is made to this endpoint. Poll this API endpoint to get the updated status. This
 * > affects the `has_conflicts` property, as it depends on the `merge_status`. It returns `false`
 * > unless `merge_status` is `cannot_be_merged`.
 *
 * Two consequences the adapter must not soften:
 *
 *  - `merge_status: 'unchecked' | 'checking' | 'cannot_be_merged_recheck'` is **not computed yet**,
 *    so `mergeable` is `null` — "ask again", never "conflicted".
 *  - while it is not computed, GitLab's `has_conflicts` is `false` *by construction*, and that
 *    `false` is not evidence of anything. Reporting it would be the adapter being kinder than the
 *    provider, so `has_conflicts` is `null` in exactly the states `mergeable` is.
 *
 * `detailed_merge_status` is used only where it is *more* specific than `merge_status`, never to
 * override it. It answers "may GitLab merge this right now", which folds in CI, approvals and
 * draft status — a merge request whose branch merges cleanly but whose pipeline is red is
 * `ci_must_pass`, and calling that `mergeable: false` would send WP-26's rebase gate rebasing a
 * branch that has no conflict. So: `conflict` decides both flags, `checking`/`unchecked`/
 * `preparing` force "not computed yet", and every other value is left to `merge_status`.
 *
 * **When the two fields disagree, the pessimistic answer wins** (WP-09 review round 1).
 * `merge_status: 'can_be_merged'` beside `detailed_merge_status: 'conflict'` used to produce
 * `{ mergeable: true, hasConflicts: true }` — a result that contradicts itself and errs optimistic,
 * which is the wrong direction for a gate. `merge_status` was deprecated in 15.6 and
 * `detailed_merge_status` is its successor, so on a disagreement the successor is believed: a
 * `conflict` is `{ mergeable: false, hasConflicts: true }` whatever `merge_status` still says.
 */
export interface Mergeability {
  readonly mergeable: boolean | null;
  readonly hasConflicts: boolean | null;
}

const NOT_COMPUTED_DETAILED = new Set(['checking', 'unchecked', 'preparing']);

export const mapMergeability = (input: {
  readonly mergeStatus: string | null | undefined;
  readonly detailedMergeStatus: string | null | undefined;
  readonly hasConflicts: boolean | null | undefined;
}): Mergeability => {
  const detailed = input.detailedMergeStatus ?? null;
  if (detailed !== null && NOT_COMPUTED_DETAILED.has(detailed)) {
    return { mergeable: null, hasConflicts: null };
  }

  // The successor field wins the moment it names a conflict, whatever the deprecated one says.
  if (detailed === 'conflict') {
    return { mergeable: false, hasConflicts: true };
  }

  switch (input.mergeStatus) {
    case 'can_be_merged':
      return { mergeable: true, hasConflicts: false };
    case 'cannot_be_merged':
      // `has_conflicts` is meaningful only here, and an instance that does not publish it leaves
      // the question open: `null` is "unknown", never "no conflicts".
      return { mergeable: false, hasConflicts: input.hasConflicts ?? null };
    case 'unchecked':
    case 'checking':
    case 'cannot_be_merged_recheck':
      return { mergeable: null, hasConflicts: null };
    default:
      break;
  }

  // `merge_status` was deprecated in GitLab 15.6 and the docs keep a "do not remove until the
  // field is actually removed" marker on it, so an instance that has dropped it is a question of
  // when. `detailed_merge_status` alone then has to answer, and only two of its values are about
  // the merge itself (`conflict` was decided above).
  if (detailed === 'mergeable') {
    return { mergeable: true, hasConflicts: false };
  }
  // Every other detailed status is a *blocking reason* (approvals, CI, draft), which says nothing
  // about whether the branches merge. Unknown is `null`, never `false`.
  return { mergeable: null, hasConflicts: null };
};

/**
 * GitLab's thirteen pipeline/job statuses mapped onto the seven the port publishes
 * (<https://docs.gitlab.com/api/pipelines/>, <https://docs.gitlab.com/api/jobs/>, 2026-09-10).
 *
 * `canceling` maps to `running`, not to `canceled`: the job is still executing, and a CI gate that
 * read it as terminal would report a result the pipeline has not produced.
 */
const PIPELINE_STATUSES: Readonly<Record<string, PipelineStatusValue>> = {
  created: 'pending',
  waiting_for_resource: 'pending',
  preparing: 'pending',
  waiting_for_callback: 'pending',
  scheduled: 'pending',
  pending: 'pending',
  running: 'running',
  canceling: 'running',
  manual: 'manual',
  success: 'success',
  failed: 'failed',
  canceled: 'canceled',
  skipped: 'skipped',
};

/**
 * The same table without an opinion about what an unknown value means: `null` is "GitLab said
 * something this adapter has never heard of".
 *
 * It exists because the two callers deserve opposite answers, and that difference is the whole of
 * WP-09 review round 1's second finding. A **read** the platform asked for (`getPipelineStatus`)
 * must fail loudly rather than invent a state; an **inbound notification** must not, because a
 * status GitLab adds next release would then turn every such delivery into a permanently failing
 * job. Fail closed on what the platform initiates; ignore-with-a-reason on what the vendor pushes.
 */
export const pipelineStatusOrNull = (status: string): PipelineStatusValue | null =>
  PIPELINE_STATUSES[status] ?? null;

/**
 * @throws {IntegrationError} `invalid_response` for a status GitLab has added since this table was
 * transcribed. Loud on purpose: the alternative is a default, and the only safe default here
 * ("failed") would report a green pipeline as red the day GitLab ships a new state. Inbound
 * normalisation uses `pipelineStatusOrNull` instead — see its docblock.
 */
export const mapPipelineStatus = (status: string, action: string): PipelineStatusValue => {
  const mapped = pipelineStatusOrNull(status);
  if (mapped === null) {
    throw new IntegrationError(
      'invalid_response',
      GITLAB_PROVIDER_ID,
      `unknown pipeline status ${JSON.stringify(status.slice(0, 32))}`,
      { action },
    );
  }
  return mapped;
};

/** The four terminal outcomes `ci.pipeline.finished` may carry, or `null` while in flight. */
export const terminalCiStatus = (
  status: PipelineStatusValue,
): 'success' | 'failed' | 'canceled' | 'skipped' | null =>
  status === 'success' || status === 'failed' || status === 'canceled' || status === 'skipped'
    ? status
    : null;

export const mapMergeRequestState = (state: string): MergeRequestState => {
  if (state === 'opened' || state === 'closed' || state === 'merged' || state === 'locked') {
    return state;
  }
  throw new IntegrationError(
    'invalid_response',
    GITLAB_PROVIDER_ID,
    `unknown merge request state ${JSON.stringify(state.slice(0, 32))}`,
    { action: 'get_merge_request' },
  );
};

/**
 * The three draft prefixes GitLab documents
 * (<https://docs.gitlab.com/user/project/merge_requests/drafts/>, 2026-09-10):
 *
 * > Add `[Draft]`, `Draft:` or `(Draft)` to the beginning of the merge request's title.
 *
 * This matters because **neither `POST` nor `PUT /merge_requests` has a `draft` parameter** — the
 * attribute tables in <https://docs.gitlab.com/api/merge_requests/> list none — so the port's
 * `draft` flag is set and cleared by rewriting the title, and nothing else.
 */
const DRAFT_PREFIX = /^\s*(\[Draft\]|Draft:|\(Draft\))\s*/i;

export const isDraftTitle = (title: string): boolean => DRAFT_PREFIX.test(title);

export const withDraftPrefix = (title: string): string =>
  isDraftTitle(title) ? title : `Draft: ${title}`;

export const withoutDraftPrefix = (title: string): string => {
  let result = title;
  while (DRAFT_PREFIX.test(result)) {
    result = result.replace(DRAFT_PREFIX, '');
  }
  return result;
};

/**
 * A GitLab timestamp as the platform's ISO-8601.
 *
 * Webhook payloads use `"2015-05-17 18:21:36 UTC"` while the REST API uses
 * `"2018-03-03T21:54:39.668Z"`; both appear in the published examples, and `isoDateTimeSchema`
 * accepts only the second.
 */
export const toIsoDateTime = (value: string, action: string): string => {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) {
    return new Date(direct).toISOString();
  }
  const spaced = Date.parse(value.replace(' UTC', 'Z').replace(' ', 'T'));
  if (!Number.isNaN(spaced)) {
    return new Date(spaced).toISOString();
  }
  throw new IntegrationError(
    'invalid_response',
    GITLAB_PROVIDER_ID,
    `unparseable timestamp ${JSON.stringify(value.slice(0, 32))}`,
    { action },
  );
};

export const toIsoDateTimeOrNull = (
  value: string | null | undefined,
  action: string,
): string | null => (value === null || value === undefined ? null : toIsoDateTime(value, action));
