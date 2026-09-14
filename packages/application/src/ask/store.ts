/**
 * `AskStore` — the ask-the-task thread, and the two projections an answer is built from (WP-31).
 *
 * Transaction-bound like `PipelineStore`, and for the same reason: an ask's row, the run it is
 * answered by and the events that announce the run all commit together, so a reader can never see
 * an ask pointing at a run nobody created.
 *
 * ## Why the record's projections are here rather than on `PipelineStore`
 *
 * {@link AskStore.runsForTask} and {@link AskStore.auditForTask} are reads of `runs` and
 * `human_actions`, which are not this feature's tables. They are on this port anyway because what
 * they return is the **ask's** reading of the record — a line per run, a line per human action,
 * each bounded and shaped for a prompt and for the task page — rather than the pipeline's. Putting
 * them on `PipelineStore` would give the executor and the saga two methods they have no use for,
 * and would make the shape of a prompt block a decision of the pipeline's persistence port.
 *
 * `auditForTask` is also PROGRESS backlog **52**'s remaining half and this row's criterion 10: WP-30
 * shipped `GET /api/projects/:id/audit` on the predicate `params->>'project_id'`, which a *task*
 * command's row never matches because `human_actions` has no `project_id` column. It is served to
 * the ask (as a data block) and to `GET /api/tasks/:task_id/audit` (as a DTO) from this one method,
 * which is what the plan row asked for when it said *"both need the same projection"*.
 */
import type {
  AskAnswerCitation,
  Id,
  IsoDateTime,
  JsonObject,
  RunStatus,
  Slug,
} from '@platform/contracts';
import type { Transaction } from '../ports/transaction.js';

/** Where an ask came from: the task page's thread, or a comment in the provider's ticket thread. */
export type AskSource = 'ui' | 'ticket';

/**
 * An ask's life, as the column records it.
 *
 * `pending` → `answered` is the ordinary path. `refused` is the platform declining *before* a run
 * exists (a spent budget, a project that turned the feature off) and `failed` is a run that started
 * and produced nothing usable. The two are distinct because the remedies are: one is a cap to
 * raise, the other is a question to ask again.
 */
export type AskStatus = 'pending' | 'answered' | 'refused' | 'failed';

export interface StoredAsk {
  readonly id: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly source: AskSource;
  readonly askedByUserId: Id;
  /**
   * The provider account a `ticket` ask came from; `null` for a `ui` ask.
   *
   * `display_name` inside it is **bounded and redacted** on the way in, like `question`
   * (`askIdentityForStorage`): it is unbounded untrusted text out of a webhook. `provider` and
   * `external_id` are not — the first is a platform literal and the second is the key the identity
   * map was resolved through (standing rule 70).
   */
  readonly askedByIdentity: JsonObject | null;
  readonly ticketCommentId: string | null;
  /** Bounded and redacted before it was stored (`MAX_ASK_QUESTION_CHARS`, TD-012). */
  readonly question: string;
  readonly runId: Id | null;
  readonly status: AskStatus;
  readonly answer: string | null;
  /** Only the citations that resolve inside this task; see {@link StoredAsk.droppedCitations}. */
  readonly citations: readonly AskAnswerCitation[];
  /** How many the model wrote that named another task's or another project's row (product/11:30). */
  readonly droppedCitations: number;
  readonly answerArtifactId: Id | null;
  readonly refusalReason: string | null;
  /**
   * How many replacements TD-012 made across **every** untrusted string on this row.
   *
   * Summed, not per field: the question and the asker's label at insert, and the answer, every
   * citation `detail`, every citation `reference` and every `unanswered` line at recording. It is
   * the only signal a redactor that stopped working would leave (migration 0024's note), so a count
   * that named one field would read as *"nothing else needed redacting"*.
   */
  readonly redactionCount: number;
  readonly mirroredAt: IsoDateTime | null;
  readonly createdAt: IsoDateTime;
  readonly answeredAt: IsoDateTime | null;
}

export interface NewAsk {
  readonly id: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly source: AskSource;
  readonly askedByUserId: Id;
  readonly askedByIdentity: JsonObject | null;
  readonly ticketCommentId: string | null;
  readonly question: string;
  readonly redactionCount: number;
  readonly createdAt: IsoDateTime;
}

/** One of this task's runs, as the ask's prompt and the citation check see it. */
export interface AskRunLine {
  readonly runId: Id;
  readonly stage: Slug | null;
  readonly role: string;
  readonly mode: string;
  readonly attempt: number;
  readonly model: string;
  readonly status: RunStatus;
  readonly terminalReason: string | null;
  readonly costUsd: number;
  readonly createdAt: IsoDateTime;
}

/**
 * One `human_actions` row of this task.
 *
 * `params` is **client-supplied JSON** — it carries the caller's own `Idempotency-Key` and whatever
 * a command chose to record — so it is untrusted at every reader (BD-022): the prompt puts it in a
 * data block and the SPA renders it through the untrusted path.
 */
export interface AskAuditLine {
  readonly id: Id;
  readonly action: string;
  readonly userId: Id | null;
  readonly params: JsonObject;
  readonly createdAt: IsoDateTime;
}

export interface AskStore {
  /**
   * Records a new question.
   *
   * Answers `'duplicate'` rather than throwing when the ticket comment already produced an ask
   * (`task_asks_ticket_comment_unique`), because a redelivered webhook is the ordinary case and
   * not a fault — the same answer `inbox` gives a redelivered delivery. A `ui` ask carries no
   * comment id and therefore never collides.
   */
  insert(tx: Transaction, ask: NewAsk): Promise<'inserted' | 'duplicate'>;
  load(tx: Transaction, askId: Id): Promise<StoredAsk | null>;
  /** Attaches the run that will answer it. Written in the same transaction that creates the run. */
  attachRun(tx: Transaction, askId: Id, runId: Id): Promise<void>;
  recordAnswer(
    tx: Transaction,
    input: {
      readonly askId: Id;
      readonly answer: string;
      readonly citations: readonly AskAnswerCitation[];
      readonly droppedCitations: number;
      readonly answerArtifactId: Id | null;
      readonly redactionCount: number;
      readonly answeredAt: IsoDateTime;
    },
  ): Promise<void>;
  /** `refused` (no run was started) or `failed` (a run produced nothing usable). */
  recordRefusal(
    tx: Transaction,
    input: {
      readonly askId: Id;
      readonly status: Extract<AskStatus, 'refused' | 'failed'>;
      readonly reason: string;
    },
  ): Promise<void>;
  /** Stamped by the `ask_answer` outbound duty once the ticket comment has actually been posted. */
  markMirrored(tx: Transaction, askId: Id, at: IsoDateTime): Promise<void>;
  /** The thread, newest first. */
  listForTask(tx: Transaction, taskId: Id, limit: number): Promise<readonly StoredAsk[]>;
  /** This task's runs, newest first — the record an answer cites and is checked against. */
  runsForTask(tx: Transaction, taskId: Id, limit: number): Promise<readonly AskRunLine[]>;
  /** This task's `human_actions`, newest first (criterion 10, PROGRESS backlog 52). */
  auditForTask(tx: Transaction, taskId: Id, limit: number): Promise<readonly AskAuditLine[]>;
}
