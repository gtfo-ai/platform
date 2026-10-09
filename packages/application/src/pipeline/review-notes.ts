/**
 * **The notes the platform posts on a merge request for a review** — the finding renderer and every
 * review marker, in one module that review-only mode (WP-24) and the pipeline's review conversation
 * (WP-179, TD-029 decision 10) both use. TD-029 decision 10 says the rendering is *"shared with
 * review-only, never copied"*; until WP-179 the renderer and the two review-only markers lived in
 * `review-only.ts`, which still re-exports them so its callers are unchanged.
 *
 * ## Every marker opens its body, and has one shape
 *
 * `<!-- agentic:<kind>:<id> -->` at the start of the body is how the platform recognises its own
 * note (`isPlatformMergeRequestNote`, TD-029 decision 6), so every builder here returns that shape
 * and every renderer puts it on the first line. `platform-marker-census.test.ts` holds every
 * renderer that writes to a merge request or a ticket to it.
 *
 * ## What is the model's and what is the platform's
 *
 * A finding's heading, the marker and every line the platform adds (a location the provider would
 * not anchor, the verdict's sentence, a `needs_person` statement) are platform text; the
 * explanation, the suggestion, the summary and a reply's words are the model's. Nothing here
 * decides anything, so a model that wrote a heading of its own can confuse a reader and nothing
 * more. Redaction happens where the text leaves the platform — `reviewWrites.thread`/`reply` and
 * `ticketWrites.replyComment` — never here.
 */
import type { Id, ReviewFinding, Severity } from '@platform/contracts';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { collapseLines } from './verdicts.js';

// ── Review-only's markers (WP-24) ────────────────────────────────────────────

/**
 * The marker every review-only **finding** thread carries, so the observation can tell its own
 * threads from a human's.
 *
 * BD-023's workpad marker in the same spirit, with the task id so two reviews of two merge requests
 * never read each other's threads. **A human can type it**, which is stated rather than implied:
 * a spoofed thread would be counted in the metric below. It costs a wrong number in a statistic and
 * nothing else — nothing branches on it — which is why an HMAC would be machinery bought for the
 * wrong risk.
 */
export const reviewMarkerFor = (taskId: Id): string => `<!-- agentic:review-only:${taskId} -->`;

/**
 * The marker review-only's **summary** thread carries, and it is deliberately a different string
 * (WP-24 review round 2).
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

// ── The pipeline review's markers (WP-179, TD-029 decision 10) ───────────────

/** The alphabet and length a model's finding id must have to appear in a marker (decision 10). */
const FINDING_ID = /^[A-Za-z0-9._-]{1,40}$/;

/**
 * The marker of one finding thread of the pipeline's `code_review` stage —
 * `<!-- agentic:review-finding:<task>.<run>.<finding> -->`. `finding` is {@link findingKeysOf}'s
 * answer, never a raw model id.
 */
export const reviewFindingMarkerFor = (taskId: Id, runId: string, finding: string): string =>
  `<!-- agentic:review-finding:${taskId}.${runId}.${finding} -->`;

/**
 * The prefix every finding thread **of this task** opens with, whichever run posted it — what the
 * resolution duty asks of a thread before it resolves it (decision 10: *"only a named thread whose
 * first note opens with this task's `review-finding` marker"*).
 */
export const reviewFindingMarkerPrefixFor = (taskId: Id): string =>
  `<!-- agentic:review-finding:${taskId}.`;

/** The summary note of one `code_review` run — `<!-- agentic:review-summary:<task>.<run> -->`. */
export const reviewFindingSummaryMarkerFor = (taskId: Id, runId: string): string =>
  `<!-- agentic:review-summary:${taskId}.${runId} -->`;

/**
 * The marker **id** of one reply the Developer asked for — `agentic:reply:<task>.<run>.<n>`, `n`
 * the entry's position in `thread_replies`. A merge-request reply opens with it inside an HTML
 * comment ({@link conversationReplyNoteMarker}); a ticket reply opens with it bare, which is how
 * `opensWithPlatformCommentMarker` reads a ticket comment (`PLATFORM_COMMENT_MARKERS` names
 * `agentic:reply:` since WP-174), and passes it as the port's `markerId` as well.
 */
export const conversationReplyMarkerId = (taskId: Id, runId: string, index: number): string =>
  `agentic:reply:${taskId}.${runId}.${String(index)}`;

/** {@link conversationReplyMarkerId} as a merge-request note opens with it. */
export const conversationReplyNoteMarker = (taskId: Id, runId: string, index: number): string =>
  `<!-- ${conversationReplyMarkerId(taskId, runId, index)} -->`;

/** The executor's idempotency keys (decision 10). Platform ids only, and the sanitised finding key. */
export const reviewFindingIdempotencyKeyFor = (
  taskId: Id,
  runId: string,
  finding: string,
): string => `review_finding:${taskId}:${runId}:${finding}`;
export const reviewFindingSummaryIdempotencyKeyFor = (taskId: Id, runId: string): string =>
  `review_summary:${taskId}:${runId}`;
export const conversationReplyIdempotencyKeyFor = (
  taskId: Id,
  runId: string,
  index: number,
): string => `conversation_reply:${taskId}:${runId}:${String(index)}`;

/**
 * Each finding's key in the marker and in the idempotency key — decision 10's *"a finding id
 * outside `[A-Za-z0-9._-]{1,40}` is replaced by its index"*, with two refinements that keep it an
 * identity:
 *
 *  - **a repeated id is replaced too**, from its second occurrence. Two findings sharing an id would
 *    otherwise share a key, and the second call would replay the first's thread — the defect
 *    review-only's round 2 measured (`reviewFindingIdempotencyKey`'s docblock);
 *  - **an id the git binding's redactor would change is replaced**, because the executor refuses an
 *    idempotency key that needs redacting (`idempotencyScopeFor`) and a planted token in an id would
 *    otherwise kill the duty half-way through its loop.
 *
 * The replacement is the index, spelt `_<index>` so it cannot be read as an id of the model's
 * `"<index>"`; on the impossible-in-practice chance the model wrote that exact string too, another
 * `_` is added until the key is free. The answer is in the artifact's order.
 */
export const findingKeysOf = (
  findings: readonly Pick<ReviewFinding, 'id'>[],
  redactor: SecretRedactor,
): readonly string[] => {
  const usable = (id: string): boolean =>
    FINDING_ID.test(id) && redactor.redactText(id).count === 0;
  const taken = new Set<string>();
  const keys: (string | null)[] = findings.map((finding) => {
    if (!usable(finding.id) || taken.has(finding.id)) {
      return null;
    }
    taken.add(finding.id);
    return finding.id;
  });
  return keys.map((key, index) => {
    if (key !== null) return key;
    let replacement = `_${String(index)}`;
    while (taken.has(replacement)) {
      replacement = `_${replacement}`;
    }
    taken.add(replacement);
    return replacement;
  });
};

// ── The finding, rendered ────────────────────────────────────────────────────

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  blocker: 'blocker',
  major: 'major',
  minor: 'minor',
  nit: 'nit',
};

/**
 * One finding as a thread body, under the marker the caller chose — the one renderer both callers
 * share (decision 10, *"never copied"*).
 *
 * The platform writes the marker, the heading and, when the provider would not anchor the finding
 * to the diff, the location line (decision 10, WP-179 (c)): a finding re-posted at merge-request
 * level still says where it is. `location` is the model's `file` and `line`, collapsed to one line
 * so it cannot open a heading of its own. Everything else is the model's.
 */
export const renderFindingWith = (
  marker: string,
  finding: ReviewFinding,
  location: { readonly file: string; readonly line: number | null } | null = null,
): string =>
  [
    marker,
    `**${SEVERITY_LABEL[finding.severity]} · ${finding.category}**`,
    ...(location === null
      ? []
      : [
          `In \`${collapseLines(location.file)}\`${location.line === null ? '' : ` at line ${String(location.line)}`} (the merge request would not take this note on the diff line).`,
        ]),
    '',
    finding.explanation,
    ...(finding.suggestion == null || finding.suggestion === ''
      ? []
      : ['', '**Suggestion**', '', finding.suggestion]),
  ].join('\n');

/**
 * Review-only's finding (WP-24): {@link renderFindingWith} under {@link reviewMarkerFor}, byte for
 * byte what review-only posted before the extraction.
 */
export const renderFinding = (taskId: Id, finding: ReviewFinding): string =>
  renderFindingWith(reviewMarkerFor(taskId), finding);

// ── The pipeline review's summary and replies (WP-179) ───────────────────────

/**
 * The summary note of a pipeline `code_review` run: the marker, the platform's sentence about the
 * verdict and the thread count, then the model's paragraph. Unlike review-only's neutral summary
 * this review **is** a gate of the platform's own pipeline, so its verdict is stated — in the
 * platform's words, never as a provider approval (the port has none).
 */
export const renderReviewSummary = (input: {
  readonly taskId: Id;
  readonly runId: string;
  readonly verdict: 'approve' | 'request_changes';
  readonly posted: number;
  readonly summary: string;
}): string =>
  [
    reviewFindingSummaryMarkerFor(input.taskId, input.runId),
    '### Agentic code review',
    '',
    input.verdict === 'approve'
      ? 'The reviewer approved this change.'
      : 'The reviewer asked for changes; the agent will answer each finding on its thread.',
    `${String(input.posted)} finding(s) posted as threads.`,
    '',
    '---',
    '',
    input.summary,
  ].join('\n');

/** The kinds of reply `ImplementationNotes.thread_replies` carries. */
export type ConversationReplyKind = 'fixed' | 'documented' | 'needs_person' | 'not_changed';

const REPLY_HEADING: Readonly<Record<Exclude<ConversationReplyKind, 'needs_person'>, string>> = {
  fixed: '**Fixed.**',
  documented: '**Answered in the documentation.**',
  not_changed: '**Not changed.**',
};

/**
 * One reply's body: the marker the caller chose, then platform text for the kind, then the model's
 * words, collapsed to one line where they could otherwise forge a line of the platform's.
 *
 * A **`needs_person`** reply opens with platform text naming the person the model named and saying
 * the platform has **not** done the action (BD-031 ruling 6, decision 10): *never claimed done*. The
 * person's name is the model's, collapsed to one line; with none named, the text says so rather
 * than inventing one.
 */
export const renderConversationReply = (input: {
  readonly marker: string;
  readonly kind: ConversationReplyKind;
  readonly reply: string;
  readonly person: string | null;
}): string => {
  const heading =
    input.kind === 'needs_person'
      ? input.person === null || input.person.trim() === ''
        ? '**A person must act on this.** The agent has not done it and cannot: it needs somebody with access the agent does not have.'
        : `**${collapseLines(input.person.trim())} must act on this.** The agent has not done it and cannot.`
      : REPLY_HEADING[input.kind];
  return [input.marker, heading, '', input.reply].join('\n');
};
