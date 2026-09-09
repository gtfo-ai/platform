/**
 * The **Communication** type port — technical/06 § "Communication", product/08 § "Communication".
 *
 * Slack in Socket Mode is the first provider (WP-10); Teams and Discord are the second ones this
 * contract is designed for. The agent never holds a Slack credential: `ask_human` and
 * `notify_human` go through the platform (product/08), so everything here is called by handlers in
 * the notification band (200–299, TD-005).
 *
 * The inbound half carries the platform's strictest identity rule. An answer or an approval that
 * arrives from chat is a *human decision*: it may only become `task.question.answered` or
 * `task.approval.decided` when the author maps to a platform user (BD-022, Q10). An unmapped
 * author is reported as `ignored` with reason `unmapped_identity` — recorded for the audit,
 * never acted on.
 */
import {
  type approvalRecordSchema,
  type Id,
  nonEmptyStringSchema,
  type questionRecordSchema,
  urlSchema,
} from '@platform/contracts';
import * as z from 'zod';
import type { ExternalIdentity, InboundNormaliser, IntegrationPort } from './common.js';

// ── Data ─────────────────────────────────────────────────────────────────────

/** One task thread (product/08: one channel per project, one thread per task). */
export const threadRefSchema = z.strictObject({
  provider: nonEmptyStringSchema,
  channel: nonEmptyStringSchema,
  /** Provider thread handle — Slack's `thread_ts`. */
  thread_id: nonEmptyStringSchema,
  url: urlSchema.nullish(),
});

export const messageRefSchema = z.strictObject({
  provider: nonEmptyStringSchema,
  channel: nonEmptyStringSchema,
  message_id: nonEmptyStringSchema,
  thread_id: nonEmptyStringSchema.nullish(),
  url: urlSchema.nullish(),
});

/** One line of the daily digest (product/08 § digest, WP-32). */
export const digestItemSchema = z.strictObject({
  task_id: nonEmptyStringSchema.nullish(),
  title: nonEmptyStringSchema,
  url: urlSchema.nullish(),
  state: nonEmptyStringSchema,
  detail: z.string().nullish(),
});

export type ThreadRef = z.infer<typeof threadRefSchema>;
export type MessageRef = z.infer<typeof messageRefSchema>;
export type DigestItem = z.infer<typeof digestItemSchema>;
export type QuestionPost = z.infer<typeof questionRecordSchema>;
export type ApprovalPost = z.infer<typeof approvalRecordSchema>;

/**
 * The message body.
 *
 * Providers render `markdown` and may additionally render `blocks` — Block Kit buttons for a
 * question's options, Approve / Request changes for an approval. `blocks` is an **opaque provider
 * payload**, one of the documented exceptions to the strict-schema rule (CLAUDE.md), so it is
 * `unknown` here and validated by the provider that understands it.
 */
export interface MessageBody {
  readonly markdown: string;
  readonly blocks?: unknown;
}

// ── Capabilities ─────────────────────────────────────────────────────────────

export interface CommunicationCapabilities {
  /** Threaded replies (a provider without threads posts everything in the channel). */
  readonly threads: boolean;
  /** Interactive buttons — without them, questions are answered by replying in the thread. */
  readonly buttons: boolean;
  /** Editing a posted message (`updateMessage`). */
  readonly messageUpdate: boolean;
  /** Socket Mode or an equivalent that needs no public URL (product/08). */
  readonly socketMode: boolean;
  readonly digest: boolean;
}

/** Catalogue events a communication delivery can produce (technical/02). */
export type CommunicationInboundEvent =
  | 'task.question.answered'
  | 'task.approval.decided'
  | 'feedback.received';

// ── The port ─────────────────────────────────────────────────────────────────

export interface CommunicationPort extends IntegrationPort<CommunicationCapabilities> {
  /**
   * Opens (or returns) the thread for a task.
   *
   * Idempotent by `taskId`: a second call for a task that already has a thread returns the same
   * `ThreadRef` instead of starting a second one, because a duplicated task thread splits the
   * conversation and the answers with it.
   *
   * @throws {IntegrationError} `not_found` for a channel the bot cannot post into. Slack answers
   * `200 { ok: false, error: "channel_not_found" }` rather than a 4xx, so the adapter maps the
   * *error string*, not the status — posting into the void would make a lost notification look
   * delivered.
   */
  postTaskThread(request: {
    readonly channel: string;
    readonly taskId: Id;
    readonly body: MessageBody;
  }): Promise<ThreadRef>;

  postQuestion(thread: ThreadRef, question: QuestionPost, body: MessageBody): Promise<MessageRef>;
  postApproval(thread: ThreadRef, approval: ApprovalPost, body: MessageBody): Promise<MessageRef>;
  /** A plain notification in the task thread: picked up, ready for merge, escalation, budget. */
  postMessage(thread: ThreadRef, body: MessageBody): Promise<MessageRef>;

  /**
   * Edits a message in place — an answered question becomes "answered by …", an expired approval
   * loses its buttons.
   *
   * @throws {IntegrationUnsupportedError} when `capabilities().messageUpdate` is false.
   */
  updateMessage(ref: MessageRef, body: MessageBody): Promise<MessageRef>;

  postDigest(channel: string, items: readonly DigestItem[]): Promise<MessageRef>;

  /** Maps a chat user onto a verified identity by email (product/08), or `null` when unknown. */
  resolveIdentity(query: {
    readonly providerUserId?: string;
    readonly email?: string;
  }): Promise<ExternalIdentity | null>;

  readonly inbound: InboundNormaliser<CommunicationInboundEvent>;
}
