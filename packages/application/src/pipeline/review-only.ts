/**
 * Review-only mode — product/18's *"The Reviewer stage on human-authored MRs (label, path or all
 * MRs), posting findings as discussion threads and a neutral summary that never blocks merge"*, and
 * product/04's *"the Code review stage alone, on human MRs"* (WP-24).
 *
 * ## The task shape, decided
 *
 * A review is **a task on the one-stage `REVIEW_ONLY_TEMPLATE`**, in `mode: 'normal'`, carrying a
 * platform-issued ticket reference built from the merge request. Three reasons, in the order they
 * bind:
 *
 *  1. `runs.task_id` is `not null` (migration 0004) and `RunSpec.taskId` is required, so a review
 *     run needs a task whatever else is decided — exactly the argument `onboarding/discovery.ts`
 *     makes, and this is the second use of it. Making it a *stage of a task* means the admission
 *     guard, the cost ledger, the transcript sink, the budget cap, the conflict retry, the
 *     `run:<id>` stream and the `needs_human` escalation are the ones every other run gets, with no
 *     second entry point.
 *  2. `tasks.mode` stays `('normal','shadow')`. technical/04's mode table makes `review_only` a
 *     **run** mode, and `run_mode` already has the value; `task_mode` is the shadow switch that
 *     `IntegrationActionExecutor` reads, and a third value there would be a new branch in a
 *     security guard for no gain. The planner maps the template to the run mode instead.
 *  3. There is no ticket, so the task carries {@link REVIEW_ONLY_TICKET_PROVIDER} and the key
 *     {@link reviewTicketKeyFor}. `unique (project_id, ticket_key, mode)` is then what makes the
 *     whole thing idempotent: a second `mr.opened` for the same merge request finds the row and
 *     creates nothing. This is `DISCOVERY_TICKET_KEY`'s trick with a per-merge-request key.
 *
 * **It deliberately does not set `tasks.mr_ref`.** `findByMergeRequest` answers *"which task's work
 * produced this merge request"* — it is how `mr.merged` advances a task and how `mr.review.comment`
 * opens BD-007's batch window — and a review-only task produced nothing. Writing the ref would put
 * this task in the way of both, and would make the *next* review-only check believe the merge
 * request already belongs to the pipeline. The merge request's identity lives in the ticket key, in
 * `ticket_url` and in `tasks.review_subject`, which is everything the posting duty needs.
 *
 * ## Three duties, and why each is one
 *
 * Everything that touches the provider happens in a `pipeline.outbound` job, outside every
 * transaction (WP-15d; `events/open-transaction.ts` refuses the alternative mechanically):
 *
 *  - **`review_only_check`** — read the merge request, apply the project's filter, and create the
 *    task. Shaped exactly like `runIntakeCheck`: read (dedup), call (two git reads), write (create
 *    and start, in one transaction), enqueue.
 *  - **`review_only_post`** — the findings and the neutral summary, after the stage completed.
 *  - **`review_only_observe`** — product/18's metric, once, when the merge request ends.
 *
 * ## What "neutral" is, and what is asserted about it
 *
 * product/18: *"a neutral summary that never blocks merge"*. On this build that is three concrete
 * things, and a test asserts each rather than asserting the model's words:
 *
 *  - the platform's own framing says, in the platform's voice, that the review is advisory and does
 *    not block the merge ({@link REVIEW_SUMMARY_PREAMBLE});
 *  - the `ReviewVerdict`'s `verdict` field is **not** posted and **not** turned into a provider
 *    approval or rejection — the port has no approve call and this module makes none;
 *  - the template sends both verdicts to `done`, so `request_changes` cannot park the task in
 *    `needs_human` (`REVIEW_ONLY_TEMPLATE`'s docblock has that argument).
 *
 * ## What a posted finding is redacted against, and what it is not
 *
 * A finding is model output on its way to a third party, so it goes through the **git binding's**
 * redactor at `reviewWrites.thread` — TD-012 step 1 over the binding's own credentials, then step
 * 2's pattern rules. This job runs after the run, so it holds no **run-scoped** secret set (Q55's
 * unfinished half) — and **a review-only run has none to hold**, which is measured rather than
 * assumed: the reviewer's tools are `['Read','Glob','Grep']`, so `runIsReadOnly` is true, the
 * workspace is read-only and `RunCredentialBroker.issue` answers `null` without calling the
 * credential source (BD-021), asserted end to end in
 * `packages/infrastructure/src/workspace/spec.test.ts` § "is none for a review-only run". The gap
 * opens only for a future role that both mints a credential and posts provider text. The model's own
 * key is covered whatever happens, because `sk-ant-…` is a pattern rule. `artifacts.data` still
 * stores the verdict unredacted (PROGRESS backlog 35), which this work package neither closes nor
 * widens: it adds no artifact-derived column, and the one place the text leaves the platform redacts
 * it.
 */
import type {
  Actor,
  Id,
  MergeRequestFileDiff,
  MergeRequestSnapshot,
  ReviewFinding,
  Severity,
  TicketRef,
} from '@platform/contracts';
import { mergeRequestSnapshotSchema } from '@platform/contracts';
import type { ReviewOnlySettings } from '@platform/domain';
import {
  buildEvent,
  compilePipeline,
  createTask,
  DEFAULT_MAX_REVIEW_FINDINGS,
  DEFAULT_REVIEW_SEVERITY_FLOOR,
  interpret,
  mergeRequestMatchesFilter,
  resolveIterationLimits,
  selectFindings,
} from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { FileDiff, MergeRequest } from '../ports/integrations/git-provider.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  reviewWrites,
} from './integrations.js';
import { enqueueOutbound, enqueueStage, type PipelineOutboundData } from './jobs.js';
import type { PipelineSagaOptions } from './saga.js';
import { priorityRankOf } from './saga.js';
import type { ProjectSettings } from './settings.js';
import { INITIAL_TASK_VERSION, PIPELINE_ACTOR, type StoredTask } from './store.js';
import { applyDecision } from './transitions.js';

/** The id `REVIEW_ONLY_TEMPLATE` is registered under in `SHIPPED_TEMPLATES`. */
export const REVIEW_ONLY_TEMPLATE_ID = 'review_only';

/** The one agent stage of that template. */
export const REVIEW_ONLY_STAGE = 'code_review';

/**
 * The ticket provider a review-only task carries.
 *
 * `platform` is not a provider this build registers — the same value `onboarding/discovery.ts`
 * uses, and deliberately so: nothing may resolve it to a task-management adapter and try to
 * transition a ticket that does not exist. It also means `ensureTicketSnapshot` leaves
 * `ticket_snapshot` null, which is the honest answer for a task with no ticket.
 *
 * **The refusal is by provider value, not by an absent binding** (corrected at WP-36; PROGRESS
 * backlog 62, standing rule 83). This sentence used to say the snapshot stayed null because
 * `ensureTicketSnapshot` *"finds no binding for it"*, which was true only for a project with no
 * task-management binding at all: for every project that has one, the binding was found and
 * `readTicket({provider: 'platform', key: 'mr!7'})` was made — one doomed round trip per agent
 * stage. `ticketReads.ticket` now answers `null` for a reference that names no provider ticket,
 * beside the three writes that already did.
 */
export const REVIEW_ONLY_TICKET_PROVIDER = 'platform';

/**
 * `mr!<iid>` — one review task per merge request, per project.
 *
 * The `!` is GitLab's own separator between a project and a merge-request iid (`acme/api!7`), so a
 * reader of the board recognises it; it cannot collide with a Jira or GitLab **issue** key, which
 * is what the other keys in this column are, because no provider issues a key containing `!`.
 */
export const reviewTicketKeyFor = (iid: number): string => `mr!${iid}`;

/**
 * The branch namespace the platform's own work lives in — BD-025's `push:agentic/*`, which is what
 * every minted push credential is scoped to (`gitlab/provider.ts`, `git/fake.ts`).
 *
 * A merge request opened from it is **not** human-authored, so review-only mode skips it. That is a
 * second guard rather than the first: the first is `findByMergeRequest`, which asks whether any task
 * already owns the merge request. The two are needed because the first has a **window** — the
 * platform learns its own merge request from the `ImplementationNotes` artifact when the
 * implementation stage completes, and the provider's `mr.opened` delivery can arrive before that
 * commit, in which case the lookup answers `null` for a merge request the platform opened seconds
 * earlier. The cost of the second guard is stated: a human who names a branch `agentic/...` is not
 * reviewed, which is the fail-closed direction — the platform reviews one merge request fewer rather
 * than reviewing its own work and posting findings to itself.
 */
export const AGENT_BRANCH_PREFIX = 'agentic/';

/**
 * The marker every **finding** thread carries, so the observation can tell its own threads from a
 * human's.
 *
 * BD-023's workpad marker in the same spirit, with the task id so two reviews of two merge requests
 * never read each other's threads. **A human can type it**, which is stated rather than implied:
 * a spoofed thread would be counted in the metric below. It costs a wrong number in a statistic and
 * nothing else — nothing branches on it — which is why an HMAC would be machinery bought for the
 * wrong risk.
 */
export const reviewMarkerFor = (taskId: Id): string => `<!-- agentic:review-only:${taskId} -->`;

/**
 * The marker the **summary** thread carries, and it is deliberately a different string (WP-24
 * review round 2).
 *
 * product/18:59 counts *findings* — "findings accepted (thread resolved with change) vs dismissed"
 * — and the summary is not one: it is the platform's own framing, posted un-anchored, and a human
 * resolving it has said nothing about any finding. While both threads carried
 * {@link reviewMarkerFor}, `threads_posted` was findings **plus one** for every review, measured as
 * `threads_posted: 2` for a single posted finding in `test/e2e/pipeline/review-only.e2e.test.ts`.
 *
 * It is a *distinct* string rather than a suffix a substring match would also accept:
 * `body.includes(reviewMarkerFor(id))` must be false for a summary, which `-summary:` before the id
 * gives. Anything that wants *everything* this mode posted — the e2e's own reader does — matches on
 * the shared `agentic:review-only` prefix.
 */
export const reviewSummaryMarkerFor = (taskId: Id): string =>
  `<!-- agentic:review-only-summary:${taskId} -->`;

/**
 * The idempotency key of the thread carrying the finding that stood at `index` in the artifact.
 *
 * **No part of it is model output** (WP-24 review round 2, and the same rule
 * `IntegrationActionExecutor.idempotencyScopeFor` states from the other side: a key is an identity,
 * so it is never redacted — and therefore never built out of text that might have to be). Round 1
 * used `finding.id`, which is `reviewFindingSchema.id`: any non-empty string the model wrote, with
 * no uniqueness asked for in `packages/prompts/roles/reviewer/prompt.md`. Two findings sharing an
 * id posted **one** thread — the second call replayed the first's answer — while the summary said
 * two were posted, which is a blocker silently dropped under a sentence claiming it was published.
 * A model cannot write an index, so the collision cannot be authored and this key cannot carry
 * anything an agent put in an artifact; `idempotencyScopeFor` has nothing to refuse, and the duty
 * cannot die half-way through the loop on a planted placeholder.
 *
 * **`revision` is the head sha the review was taken on** — the one part that is not the platform's
 * own text, and it is provider metadata rather than anybody's prose: it is read from the merge
 * request, bounded to {@link MAX_MR_REF_CHARS} and stored **already redacted** in
 * `tasks.review_subject`, so what reaches this function is a sha or a placeholder, and a placeholder
 * is inert (a redaction output is never re-redacted, which is why `idempotencyScopeFor` does not
 * refuse it). It makes the identity
 * *(this task, this revision, this position)*. Two consequences, both wanted: a redelivered wake-up
 * replays instead of posting a second copy, and a **re-run of the stage on the same revision**
 * replays too, rather than posting a second set of threads on somebody's merge request — the
 * fail-closed direction for a mutation (standing rule 20). What it costs is stated: if a re-run
 * produced *different* findings on an unchanged revision, the thread at each position keeps the
 * first run's text.
 */
export const reviewFindingIdempotencyKey = (taskId: Id, revision: string, index: number): string =>
  `review_only_finding:${taskId}:${revision}:${index}`;

/** The summary's key: one per task and revision, for the same reasons. */
export const reviewSummaryIdempotencyKey = (taskId: Id, revision: string): string =>
  `review_only_summary:${taskId}:${revision}`;

// ── The byte budget ──────────────────────────────────────────────────────────

/**
 * ## Where the numbers come from
 *
 * The same derivation as `ticket-snapshot.ts`, applied to a different document, and the sentence is
 * the same one: **the merge request is one document in the task block, so it is bounded like one.**
 *
 * | figure | value | where it comes from |
 * |---|---|---|
 * | the cap the prompt applies to one prior artifact | 20 000 characters | `MAX_ARTIFACT_CHARS` |
 * | the cap the ticket snapshot applies to a description | 20 000 characters | `MAX_TICKET_DESCRIPTION_CHARS` |
 * | the knowledge pack's budget | 12 000 tokens | `DEFAULT_CONTEXT_BUDGET_TOKENS` |
 *
 * The title and the description get exactly what a ticket's get. The **diff** is the new quantity
 * and it is bounded as *the rest of the document*: 40 files at 8 000 characters is 320 000, which
 * would dwarf everything else, so the diff carries its own ceiling as well —
 * {@link MAX_REVIEW_DIFF_CHARS}, one artifact's worth times four (80 000), because the diff **is**
 * the thing being reviewed and a reviewer given the ticket and not the change has nothing to do.
 * Files are taken in the order the provider returned them (which is path order on GitLab) and the
 * budget is spent in that order; what does not fit is dropped with `truncated` on the snapshot, so
 * the prompt says a file is missing rather than pretending the change was smaller.
 *
 * Worst case, every cap at its limit — the title, the description, the three branch-or-sha refs,
 * twenty labels and the whole diff: `512 + 20 000 + 3 × 256 + 20 × 256 + 80 000` = **106 400
 * characters** ({@link MERGE_REQUEST_SNAPSHOT_MAX_TEXT_CHARS}, *produced* by a test rather than
 * quoted, standing rule 39). At 4 UTF-8 bytes per character that is 425 600 bytes ≈ 416 KiB before
 * JSON escaping; for ASCII, `estimateTokens` reads it as about 26 600 tokens, so a review prompt is
 * roughly twice a knowledge pack — which is the trade this mode exists to make.
 *
 * Every cap is a cut with a marker, never a refusal: a merge request nobody can shorten must still
 * be reviewable (standing rule 20).
 */
export const MAX_MR_TITLE_CHARS = 512;
/** {@link MAX_MR_TITLE_CHARS} and friends: see the budget table above. */
export const MAX_MR_DESCRIPTION_CHARS = 20_000;
/** A branch name, a label and a sha are provider strings, so each is bounded. */
export const MAX_MR_REF_CHARS = 256;
export const MAX_MR_LABELS = 20;
export const MAX_MR_FILES = 40;
export const MAX_MR_FILE_DIFF_CHARS = 8_000;
/** The whole diff's ceiling, spent file by file in the provider's order. */
export const MAX_REVIEW_DIFF_CHARS = 80_000;

/** The sum of every text cap above — the figure the hostile-merge-request test pins. */
export const MERGE_REQUEST_SNAPSHOT_MAX_TEXT_CHARS =
  MAX_MR_TITLE_CHARS +
  MAX_MR_DESCRIPTION_CHARS +
  // `source_branch`, `target_branch` and `head_sha`.
  3 * MAX_MR_REF_CHARS +
  MAX_MR_LABELS * MAX_MR_REF_CHARS +
  MAX_REVIEW_DIFF_CHARS;

interface Cut {
  readonly text: string;
  readonly truncated: boolean;
}

const cut = (text: string, max: number): Cut =>
  text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };

interface Redacting {
  count: number;
}

/**
 * Redact **then** cut, in that order and never the other way round.
 *
 * The same argument `ticket-snapshot.ts` makes at its own `clean`: an exact-match redactor cannot
 * find a secret a cap has already halved. The residual is that a cut may land inside a
 * *placeholder*, which is harmless.
 */
const clean = (raw: string, max: number, redactor: SecretRedactor, tally: Redacting): Cut => {
  const redacted = redactor.redactText(raw);
  tally.count += redacted.count;
  return cut(redacted.value, max);
};

/**
 * The files, bounded twice: per file, and over the whole diff.
 *
 * The whole-diff budget is spent in the provider's own order rather than by picking "the most
 * interesting" files, because the platform has no basis for that ranking and inventing one would
 * silently decide what a review is about.
 */
const boundFiles = (
  files: readonly FileDiff[],
  redactor: SecretRedactor,
  tally: Redacting,
): { readonly files: readonly MergeRequestFileDiff[]; readonly truncated: boolean } => {
  const kept: MergeRequestFileDiff[] = [];
  let budget = MAX_REVIEW_DIFF_CHARS;
  let truncated = files.length > MAX_MR_FILES;
  for (const file of files.slice(0, MAX_MR_FILES)) {
    const path = clean(file.new_path, MAX_MR_REF_CHARS, redactor, tally);
    const allowance = Math.min(MAX_MR_FILE_DIFF_CHARS, budget);
    if (allowance <= 0) {
      truncated = true;
      break;
    }
    const patch = clean(file.diff ?? '', allowance, redactor, tally);
    budget -= patch.text.length;
    kept.push({
      path: path.text,
      diff: patch.text,
      truncated: path.truncated || patch.truncated,
      omitted: file.omitted,
    });
  }
  return { files: kept, truncated: truncated || kept.some((file) => file.truncated) };
};

/**
 * A `MergeRequest` and its diff as the task row stores them: bounded, redacted, honest about what
 * was dropped.
 *
 * Pure and total, like `boundTicketSnapshot`: there is no input for which this throws. The closing
 * `parse` holds the builder to the published shape.
 */
export const boundMergeRequestSnapshot = (
  mergeRequest: MergeRequest,
  files: readonly FileDiff[],
  redactor: SecretRedactor,
): MergeRequestSnapshot => {
  const tally: Redacting = { count: 0 };
  const title = clean(mergeRequest.title, MAX_MR_TITLE_CHARS, redactor, tally);
  const description = clean(mergeRequest.description, MAX_MR_DESCRIPTION_CHARS, redactor, tally);
  const labels = mergeRequest.labels
    .slice(0, MAX_MR_LABELS)
    .map((label) => clean(label, MAX_MR_REF_CHARS, redactor, tally).text);
  const bounded = boundFiles(files, redactor, tally);
  return mergeRequestSnapshotSchema.parse({
    title: title.text,
    description: description.text,
    source_branch: clean(mergeRequest.source_branch, MAX_MR_REF_CHARS, redactor, tally).text,
    target_branch: clean(mergeRequest.target_branch, MAX_MR_REF_CHARS, redactor, tally).text,
    head_sha: clean(mergeRequest.head_sha, MAX_MR_REF_CHARS, redactor, tally).text,
    labels,
    files: [...bounded.files],
    truncated:
      title.truncated ||
      description.truncated ||
      bounded.truncated ||
      mergeRequest.labels.length > labels.length,
    file_count: files.length,
    redaction_count: tally.count,
  } satisfies MergeRequestSnapshot);
};

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * The project's `features.review_only`, with every default filled in.
 *
 * The effective configuration already merges the shipped defaults, but this is the *pipeline's*
 * reader and the pipeline is handed `ConfigValues` from several composition roots (a unit harness
 * passes `{}`), so the defaults are applied here too rather than assumed. They are the same values
 * `PLATFORM_DEFAULT_CONFIG` carries; product/18 is the source of all five.
 */
export const resolveReviewOnlySettings = (settings: ProjectSettings): ReviewOnlySettings => {
  const configured = settings.config.features?.review_only;
  return {
    enabled: configured?.enabled ?? false,
    trigger: configured?.trigger ?? 'label',
    label: configured?.label ?? 'agentic-review',
    paths: configured?.paths ?? [],
    severityFloor: configured?.severity_floor ?? DEFAULT_REVIEW_SEVERITY_FLOOR,
    maxFindings: configured?.max_findings ?? DEFAULT_MAX_REVIEW_FINDINGS,
  };
};

// ── The posted text ──────────────────────────────────────────────────────────

/**
 * The platform's own words at the top of the summary thread — product/18's *"neutral … never blocks
 * merge"*, stated by the platform rather than by the model.
 *
 * It is a constant so a test can assert its presence without quoting a paragraph, and so the
 * sentence a reader of a merge request sees is reviewed here rather than produced per run.
 */
export const REVIEW_SUMMARY_PREAMBLE =
  'This is an automated review from the Agentic platform, running in **review-only** mode. ' +
  'It is advisory: it does not approve or reject this merge request and it does not block the merge. ' +
  'Resolve a thread when you have dealt with it, or when you disagree — both are useful signals.';

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  blocker: 'blocker',
  major: 'major',
  minor: 'minor',
  nit: 'nit',
};

/**
 * One finding as a thread body.
 *
 * The platform writes the heading and the marker; everything else is the model's. Nothing here
 * decides anything, so a model that wrote a heading of its own can confuse a reader and can do
 * nothing more — the same trade the prompt's data blocks make in the other direction.
 */
export const renderFinding = (taskId: Id, finding: ReviewFinding): string =>
  [
    reviewMarkerFor(taskId),
    `**${SEVERITY_LABEL[finding.severity]} · ${finding.category}**`,
    '',
    finding.explanation,
    ...(finding.suggestion == null || finding.suggestion === ''
      ? []
      : ['', '**Suggestion**', '', finding.suggestion]),
  ].join('\n');

/**
 * The neutral summary: the platform's framing, the counts it knows, then the model's paragraph.
 *
 * `posted` is **the number of threads that exist**, counted by the caller from what the provider
 * answered, and not the number of findings it walked over — the distinction is what
 * {@link reviewFindingIdempotencyKey} exists for, and the sentence here is the one a human reads
 * instead of counting.
 */
export const renderSummary = (input: {
  readonly taskId: Id;
  readonly summary: string;
  readonly posted: number;
  readonly belowFloor: number;
  readonly overFlow: number;
  readonly severityFloor: Severity;
}): string => {
  const notes: string[] = [];
  if (input.belowFloor > 0) {
    notes.push(
      `${input.belowFloor} finding(s) below the project's \`${input.severityFloor}\` severity floor were not posted.`,
    );
  }
  if (input.overFlow > 0) {
    notes.push(`${input.overFlow} further finding(s) were not posted: the per-merge-request cap.`);
  }
  return [
    reviewSummaryMarkerFor(input.taskId),
    '### Agentic review',
    '',
    REVIEW_SUMMARY_PREAMBLE,
    '',
    `${input.posted} finding(s) posted as threads.`,
    ...(notes.length === 0 ? [] : ['', ...notes.map((note) => `- ${note}`)]),
    '',
    '---',
    '',
    input.summary,
  ].join('\n');
};

// ── The handlers ─────────────────────────────────────────────────────────────

const actorFor = (): Actor => PIPELINE_ACTOR;

/**
 * The handlers need nothing the saga does not have; the **duties** need a transaction of their own,
 * because they run in a job rather than inside the dispatcher's.
 */
export interface ReviewOnlyOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
}

/**
 * `mr.opened` → consider a review.
 *
 * Priority 10, the core band, and it does **nothing but decide**: two cheap indexed reads inside
 * the dispatcher's transaction (is this merge request already the platform's own work; has it
 * already been reviewed) and an `afterCommit` enqueue. Whether the project has the feature on is a
 * *settings* read — I/O — so it belongs to the job, which is the same division `pipeline.intake`
 * makes and for the same measured reason (`saga.ts`'s intake docblock).
 *
 * `mr.opened` is GitLab's `open` **and** `reopen`. `mr.updated` is deliberately not subscribed to:
 * one review per merge request is what the ticket key expresses, and re-reviewing every push is a
 * cost nobody has asked for. Q74 records the question and this is its recommendation.
 */
export const reviewOnlyHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.review.only',
  priority: 10,
  eventTypes: ['mr.opened'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'mr.opened') {
      return;
    }
    const { payload } = event;
    const projectId = payload.project_id;
    const iid = payload.mr.iid;

    // The platform's own merge request: `ImplementationNotes` put the ref on a task, so this is
    // "some task produced it". Review-only tasks never write `mr_ref`, so they cannot match here.
    const authored = await options.store.tasks.findByMergeRequest(context.scope.tx, {
      projectId,
      iid,
    });
    if (authored !== null) {
      return;
    }
    const reviewed = await options.store.tasks.findByTicket(context.scope.tx, {
      projectId,
      provider: REVIEW_ONLY_TICKET_PROVIDER,
      ticketKey: reviewTicketKeyFor(iid),
      mode: 'normal',
    });
    if (reviewed !== null) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'review_only_check',
      project_id: projectId,
      cause_event_id: event.id,
      iid,
      mr_url: payload.mr.url,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/**
 * `task.stage.completed` → post the review.
 *
 * Priority **120**, the integrations band (TD-005), beside the workpad render: the stage executor
 * at 10 has already stored the artifact and moved the task, and posting is an outbound call that
 * must not run inside the core band's transaction. The consequence to know is the one WP-15d's
 * docblock states for the workpad: the ordering between this and the status mapping is the queue's.
 */
export const reviewOnlyPostHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.review.only.post',
  priority: 120,
  eventTypes: ['task.stage.completed'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.stage.completed' || event.payload.stage !== REVIEW_ONLY_STAGE) {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, event.payload.task_id);
    if (stored === null || stored.task.template !== REVIEW_ONLY_TEMPLATE_ID) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'review_only_post',
      project_id: stored.task.projectId,
      task_id: stored.task.id,
      cause_event_id: event.id,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/**
 * `mr.merged` / `mr.closed` → observe what happened to the findings (product/18's metric).
 *
 * ## What the platform can observe today, measured rather than assumed
 *
 * product/18 defines the metric as *"findings accepted (thread resolved with change) vs
 * dismissed"*. There is **no provider event for a resolution**: GitLab's merge-request hook
 * publishes `open`, `reopen`, `update`, `close`, `merge`, `approved`/`unapproved` and their
 * `approval` variants and nothing about discussions
 * (<https://docs.gitlab.com/user/project/integrations/webhook_events/>, retrieved 2026-09-13), and
 * its note hook fires on a **note**, which resolving a single thread does not create. So the
 * platform polls, and the honest moment to poll is the one where the answer stops changing: the
 * merge request ending. `listDiscussions` is already on the port and already returns `resolved`, so
 * nothing here needs a provider feature the port lacks.
 *
 * **"With a change" is read off the head commit**, which is the only evidence available without a
 * second diff read per thread: a thread resolved on a merge request whose head moved after the
 * review was posted is counted as *accepted*, and one resolved on an unchanged head as
 * *dismissed*. The residual is stated because it is real and unavoidable here: a human who resolves
 * a thread **and** pushes an unrelated commit is counted as having accepted it, and one who fixes a
 * finding in the same commit as the merge is counted correctly only because the head moved. The
 * event carries both shas, so a later consumer can disagree with this reading without re-reading
 * the provider.
 */
export const reviewOnlyObservationHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.review.only.observe',
  priority: 120,
  eventTypes: ['mr.merged', 'mr.closed'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'mr.merged' && event.type !== 'mr.closed') {
      return;
    }
    const { payload } = event;
    const stored = await options.store.tasks.findByTicket(context.scope.tx, {
      projectId: payload.project_id,
      provider: REVIEW_ONLY_TICKET_PROVIDER,
      ticketKey: reviewTicketKeyFor(payload.mr.iid),
      mode: 'normal',
    });
    if (stored === null || stored.reviewSubject === null) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'review_only_observe',
      project_id: stored.task.projectId,
      task_id: stored.task.id,
      cause_event_id: event.id,
      iid: payload.mr.iid,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

// ── The duties ───────────────────────────────────────────────────────────────

const refFor = (stored: StoredTask, iid: number) => ({
  iid,
  url: stored.task.ticket.url,
  ...(stored.reviewSubject === null
    ? {}
    : { branch: stored.reviewSubject.source_branch, head_sha: stored.reviewSubject.head_sha }),
});

/**
 * `pipeline.outbound` duty **review_only_check**: ask the provider, then create the task.
 *
 * It **re-validates on fire** (TD-004): a wake-up that arrives twice, or long after the event,
 * finds the task already created and returns. Every refusal is logged with its reason, because
 * "nothing happened" is the answer a non-matching merge request must produce and an operator still
 * has to be able to read why.
 *
 * A provider read that **throws** fails the job, which pg-boss retries. That is the fail-closed
 * direction and it is deliberate: unlike the ticket snapshot — which makes a prompt better and
 * whose absence is recoverable at the next stage — the diff *is* the input, and starting a review
 * run without it would spend a budget on a model that has nothing to review (standing rule 20:
 * this is a decision to spend, so it fails closed).
 */
export const runReviewOnlyCheck = async (
  options: ReviewOnlyOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const projectId = data.project_id as Id;
  const iid = Number(data.iid);
  const causeEventId = data.cause_event_id as Id;
  const ticket: TicketRef = {
    provider: REVIEW_ONLY_TICKET_PROVIDER,
    key: reviewTicketKeyFor(iid),
    url: String(data.mr_url ?? ''),
  };

  const settle = (reason: string): void => {
    logger.debug({ project_id: projectId, iid, reason }, 'review-only: nothing to do');
  };

  const existing = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.findByTicket(scope.tx, {
      projectId,
      provider: ticket.provider,
      ticketKey: ticket.key,
      mode: 'normal',
    }),
  );
  if (existing !== null) {
    settle('the merge request already has a review task');
    return;
  }

  const settings = await options.settings.forProject(projectId);
  const feature = resolveReviewOnlySettings(settings);
  if (!feature.enabled) {
    settle('review-only mode is not enabled for this project');
    return;
  }

  // Outside a run, so the call's scope holds no minted credential (Q55); outside every transaction,
  // which `integrationsForProject` refuses to be otherwise.
  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  const git = integrations.git;
  if (git === null) {
    settle('the project has no git binding');
    return;
  }
  const reads = gitReads(integrations);
  const context = { projectId, taskId: null };
  const mergeRequest = await reads.mergeRequest({ iid, url: ticket.url }, context);
  if (mergeRequest === null) {
    settle('the merge request could not be read');
    return;
  }
  if (mergeRequest.state !== 'opened') {
    settle(`the merge request is ${mergeRequest.state}`);
    return;
  }
  if (mergeRequest.source_branch.startsWith(AGENT_BRANCH_PREFIX)) {
    settle(`the merge request is on the platform's own branch namespace (${AGENT_BRANCH_PREFIX}*)`);
    return;
  }

  const files = await reads.mergeRequestDiff({ iid, url: ticket.url }, MAX_MR_FILES, context);
  const match = mergeRequestMatchesFilter(feature, {
    labels: mergeRequest.labels,
    changedPaths: files === null ? null : files.map((file) => file.new_path),
  });
  if (!match.matched) {
    settle(match.reason);
    return;
  }

  const snapshot = boundMergeRequestSnapshot(mergeRequest, files ?? [], git.redactor);

  const work = await options.unitOfWork.transaction(async (scope) => {
    const again = await options.store.tasks.findByTicket(scope.tx, {
      projectId,
      provider: ticket.provider,
      ticketKey: ticket.key,
      mode: 'normal',
    });
    if (again !== null) {
      return null;
    }
    const commandContext = {
      ids: options.ids,
      actor: actorFor(),
      clock: options.clock as never,
      correlationId: null,
      causeEventId,
    };
    const created = createTask(
      {
        id: options.ids.next(),
        projectId,
        ticket,
        template: REVIEW_ONLY_TEMPLATE_ID,
        mode: 'normal',
        limits: resolveIterationLimits(settings.config.pipeline?.limits),
      },
      commandContext,
    );
    const stored: StoredTask = {
      task: created.aggregate,
      template: settings.templates[REVIEW_ONLY_TEMPLATE_ID] as StoredTask['template'],
      priorityRank: priorityRankOf(null),
      createdAt: options.clock.now(),
      branch: null,
      // Deliberately not the merge request — see the module docblock.
      mr: null,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      estimateBasis: null,
      estimateSamples: null,
      version: INITIAL_TASK_VERSION,
      ticketSnapshot: null,
      ticketSnapshotAt: null,
      reviewSubject: snapshot,
      historySample: null,
      // A review-only task never opens a merge request of its own, so the `risk_route` duty never
      // runs for it and this list stays empty (WP-37).
      riskClasses: [],
      coverage: null,
      dependencies: null,
      requiredReviewers: null,
      requestedByUserId: null,
    };
    await options.store.tasks.insert(scope.tx, stored);

    /**
     * **No WIP admission and no protected-branch check**, and both are decisions.
     *
     * The branch check exists because the agent will be given a push credential with no branch
     * scoping (Q40); a review-only run pushes nothing, so refusing it would park a human's merge
     * request for a reason that cannot apply to it. The WIP limits bound *delivery* work in
     * progress (BD-010) and a queued review task has no producer to dequeue it — `schedulerHandler`
     * dequeues on `task.completed`, which would make a review wait behind a feature. What bounds
     * the spend is the budget guard the run goes through like every other, and product/18's own
     * `max_findings`. `onboarding/discovery.ts` made the same call for the same reason.
     */
    const pipeline = compilePipeline(stored.task.template, stored.template);
    const applied = await applyDecision({
      store: options.store,
      pipeline,
      tx: scope.tx,
      stored,
      decision: interpret(pipeline, { kind: 'start' }),
      context: { ...commandContext, correlationId: stored.task.id },
      causedByEventId: causeEventId,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    await scope.events.append([...created.events, ...applied.events]);
    return applied.work;
  });

  if (work !== null) {
    logger.info({ project_id: projectId, iid, reason: match.reason }, 'review-only: reviewing');
    await enqueueStage(options.jobs, work);
  }
};

/**
 * `pipeline.outbound` duty **review_only_post**: the findings, then the neutral summary.
 *
 * The verdict is read from the stored artifact rather than from the payload, because a job is a
 * wake-up and not a message (TD-004). Each thread carries {@link reviewFindingIdempotencyKey} — the
 * task, the revision that was reviewed and the finding's **position in the artifact**, none of
 * which the model wrote — so a redelivery of the same wake-up replays the provider's answer instead
 * of posting a second copy, and a *different* revision is a different key, which is the shape
 * product/18's "same MR revision" wording asks for.
 *
 * **The findings go up before the summary**, so the summary's counts describe threads that already
 * exist; a failure in the middle leaves findings without a summary, which is the harmless order.
 *
 * **What the summary counts is threads, not iterations.** The provider's answer is collected into a
 * set of discussion ids, so "N finding(s) posted as threads" is a statement about the merge request
 * a human is looking at rather than about this loop: two calls the provider answered with one
 * thread are one thread. Round 1 counted iterations (`posted += 1`), which is how a collision on
 * the idempotency key came to be reported as two threads when one existed.
 *
 * Its honest status is **defence, not the fix** (standing rule 86): with
 * {@link reviewFindingIdempotencyKey} the two spellings agree on every path this file can reach —
 * every call is a distinct key, and the one outcome that yields `null` (shadow mode, or a project
 * with no git binding) suppresses the summary as well, so nobody reads the number. What the set
 * buys is that the sentence stays true without depending on that argument. The case that separates
 * them is a collision, and the test that names one is
 * *"posts two threads for two findings the model gave the same id"*, which fails on the **key**.
 */
export const runReviewOnlyPost = async (
  options: ReviewOnlyOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id;
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null || stored.reviewSubject === null) {
    logger.debug({ task_id: taskId }, 'review-only: nothing to post');
    return;
  }
  const artifact = await options.unitOfWork.transaction(async (scope) =>
    options.store.artifacts.latest(scope.tx, taskId, 'ReviewVerdict'),
  );
  if (artifact === null) {
    logger.warn({ task_id: taskId }, 'review-only: the stage produced no ReviewVerdict');
    return;
  }
  const verdict = artifact.data as {
    findings?: readonly ReviewFinding[];
    summary?: string;
  };
  const settings = await options.settings.forProject(stored.task.projectId);
  const feature = resolveReviewOnlySettings(settings);
  const selected = selectFindings(verdict.findings ?? [], feature);

  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const writes = reviewWrites(integrations);
  const iid = Number(stored.task.ticket.key.slice('mr!'.length));
  const ref = refFor(stored, iid);
  const context = {
    projectId: stored.task.projectId,
    taskId: stored.task.id,
    mode: stored.task.mode,
  };
  const revision = stored.reviewSubject.head_sha;

  // The threads that exist, by the provider's own id for them — see the docblock. A set and not a
  // counter, so two calls the provider answered with one thread are one thread here too.
  const threads = new Set<string>();
  for (const { index, finding } of selected.posted) {
    // A finding with only one of `file`/`line` cannot be anchored, so it becomes a thread on the
    // merge request rather than being dropped: the port refuses the half-anchor, and a finding a
    // human never sees is worse than one they have to locate themselves.
    const anchored = finding.file != null && finding.line != null;
    const thread = await writes.thread(
      {
        ref,
        path: anchored ? (finding.file as string) : null,
        line: anchored ? (finding.line as number) : null,
        markdown: renderFinding(stored.task.id, finding),
        idempotencyKey: reviewFindingIdempotencyKey(stored.task.id, revision, index),
      },
      context,
    );
    if (thread !== null) {
      threads.add(thread.id);
    }
  }
  const posted = threads.size;

  await writes.thread(
    {
      ref,
      path: null,
      line: null,
      markdown: renderSummary({
        taskId: stored.task.id,
        summary: verdict.summary ?? '',
        posted,
        belowFloor: selected.belowFloor,
        overFlow: selected.overFlow,
        severityFloor: feature.severityFloor,
      }),
      idempotencyKey: reviewSummaryIdempotencyKey(stored.task.id, revision),
    },
    context,
  );
  logger.info(
    { task_id: stored.task.id, iid, posted, below_floor: selected.belowFloor },
    'review-only: review posted',
  );
};

/**
 * `pipeline.outbound` duty **review_only_observe**: read the threads back and record the metric.
 *
 * **It counts findings, and the summary is not one** (WP-24 review round 2). product/18:59 asks for
 * *"findings accepted (thread resolved with change) vs dismissed"*; the summary thread is the
 * platform's own framing, and a human who resolves it has said nothing about any finding. So the
 * threads are selected by {@link reviewMarkerFor}, which {@link reviewSummaryMarkerFor} is
 * deliberately not a substring of — while both carried one marker, every review reported one thread
 * more than it had posted.
 *
 * **The duplicate is the residual, and it is stated rather than guarded.** A job is at-least-once,
 * so a redelivered wake-up appends a second `mr.review.observed` with the same numbers. It creates
 * nothing and changes nothing — standing rule 20's fail-open direction for a notification — and the
 * event carries `task_id` and `head_sha`, so a consumer deduplicates on the pair. Guarding it would
 * need an event-log read inside the pipeline's job options, which is a dependency added for a
 * statistic.
 */
export const runReviewOnlyObservation = async (
  options: ReviewOnlyOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id;
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null || stored.reviewSubject === null) {
    return;
  }
  const iid = Number(data.iid);
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const reads = gitReads(integrations);
  const context = { projectId: stored.task.projectId, taskId: stored.task.id };
  const ref = refFor(stored, iid);
  const mergeRequest = await reads.mergeRequest(ref, context);
  const discussions = await reads.discussions(ref, context);

  // The finding marker, not the summary's: `threads_posted` is a count of findings (see above).
  const marker = reviewMarkerFor(stored.task.id);
  const ours = discussions.filter((discussion) =>
    discussion.notes.some((note) => note.body.includes(marker)),
  );
  const resolved = ours.filter((discussion) => discussion.resolved).length;
  const reviewedAt = stored.reviewSubject.head_sha;
  const headNow = mergeRequest?.head_sha ?? reviewedAt;
  const changed = headNow !== reviewedAt;

  await options.unitOfWork.transaction(async (scope) => {
    // Re-loaded inside the transaction: `task.sequence` is the next `stream_seq` and the log
    // refuses one that is not `last + 1`, so it has to be read where the append happens.
    const current = await options.store.tasks.load(scope.tx, taskId);
    if (current === null) {
      return;
    }
    await scope.events.append([
      buildEvent(
        'task.review.observed',
        {
          project_id: current.task.projectId,
          task_id: current.task.id,
          mr: {
            provider: mergeRequest?.ref.provider ?? null,
            project_path: mergeRequest?.ref.project_path ?? null,
            iid,
            url: current.task.ticket.url,
            branch: current.reviewSubject?.source_branch ?? null,
            head_sha: headNow,
          },
          head_sha_reviewed: reviewedAt,
          head_sha_now: headNow,
          threads_posted: ours.length,
          threads_resolved: resolved,
          threads_accepted: changed ? resolved : 0,
          threads_dismissed: changed ? 0 : resolved,
          threads_unresolved: ours.length - resolved,
        },
        {
          streamType: 'task',
          streamId: current.task.id,
          streamSeq: current.task.sequence,
        },
        {
          ids: options.ids,
          actor: actorFor(),
          clock: options.clock as never,
          correlationId: current.task.id,
          causeEventId: data.cause_event_id as Id,
        },
      ),
    ]);
  });
  logger.info(
    { task_id: stored.task.id, iid, threads: ours.length, resolved },
    'review-only: findings observed',
  );
};

/** Every handler this mode registers, in one place for the runtime to spread. */
export const reviewOnlyHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  reviewOnlyHandler(options),
  reviewOnlyPostHandler(options),
  reviewOnlyObservationHandler(options),
];
