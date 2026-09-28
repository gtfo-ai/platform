/**
 * **The ceiling on what one `integration_actions` row may hold** — WP-83, Q54's second
 * sub-decision (*"whether `integration_actions.payload` needs a hard byte ceiling of its own"*).
 *
 * The row is written by `buildEntry` in `action-executor.ts`, after redaction and in exactly one
 * place, and three of its fields carry text the platform did not bound: `payload` (whatever the
 * caller describes the call with), `result` (whatever `describeResult` returns) and `error` (the
 * provider's error, name and message). Every other field is the platform's own — ids, an action
 * name held to `^[a-z][a-z0-9_]*$`, a status word, integers. So those three, and only those, are
 * bounded here (standing rule 37: the sweep is of the fields the row *emits*, listed off
 * `IntegrationActionEntry`, not of the call sites someone remembered).
 *
 * ## The two bounds and where they come from
 *
 * - **`payload` and `result`: {@link MAX_AUDIT_JSON_BYTES} = 64 KiB of serialised JSON each.** The
 *   row is a *description* of a call, never a copy of its body — `add_comment`, `commit_files`,
 *   `create_discussion`, `post_task_thread` and `create_ticket` all say so at the call and record
 *   identifiers, paths or a title. The widest shape a caller builds is a list of identifiers
 *   (`commit_files`' paths, `set_reviewers`' ids), and 64 KiB is 256 of them at
 *   `MAX_MR_REF_CHARS` (256 characters) each. No shipped caller is known to come near it — it is a
 *   **backstop**, sized so that the row cannot become what Q54 measured one merge request to be
 *   (1 180 338 bytes, `unbounded-emission.test.ts`) if a future caller describes a call with the
 *   object it read, which is the defect this exists to make visible rather than expensive.
 * - **`error`: {@link MAX_AUDIT_ERROR_CHARS} = 2 000 characters**, which is
 *   `MAX_INBOX_ERROR_CHARS` — the cap the inbound twin of this row already applies to the same kind
 *   of text (a provider's refusal, redacted first).
 *
 * ## What a cut looks like, and why it is safe to apply once
 *
 * A JSON value over the ceiling is **replaced** by `{ "truncated": true, "original_bytes": n,
 * "head": "<the serialised value's first characters>" }` whose own serialisation is at most the
 * ceiling — so the row stays valid `jsonb`, says it was cut and by how much, and keeps the part a
 * reader most likely wants. An error over its cap keeps its head and ends in
 * ` [truncated: n chars]`, the whole at most the cap. Both are **idempotent**: a value already at
 * or under the ceiling is returned as it came, and the replacement is under it — so the
 * marker-bearing cap of standing rule 36 cannot disagree with itself if applied twice. The cut
 * comes **after** redaction, never before (an exact-match redactor cannot find a secret a cap has
 * already halved — `inbound.ts` makes the same argument), so `redaction_count` still counts the
 * secret a cut removed.
 *
 * **What it does not bound**: the idempotency record's stored value (`integration_idempotency.
 * result`). That is the answer a replayed call is handed back, so cutting it would hand a caller a
 * different result than the one the provider gave — fidelity there is the contract, and its size is
 * the caller's `encode`. Stated so that "every JSON column this executor writes is bounded" is not
 * read into this module.
 */
import type { JsonObject } from '@platform/contracts';

/** See the module docblock: 256 identifiers of 256 characters, a backstop rather than a budget. */
export const MAX_AUDIT_JSON_BYTES = 64 * 1_024;

/** `MAX_INBOX_ERROR_CHARS`, the cap the inbound twin of this row applies to the same text. */
export const MAX_AUDIT_ERROR_CHARS = 2_000;

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;

/** A prefix that does not end half-way through a surrogate pair. */
const prefix = (text: string, length: number): string => {
  const cut = text.slice(0, length);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/**
 * A JSON object as the audit row may hold it: itself when its serialisation is at most `maxBytes`,
 * otherwise the stated replacement, whose serialisation is at most `maxBytes`.
 */
export const boundAuditJson = (
  value: JsonObject,
  maxBytes: number = MAX_AUDIT_JSON_BYTES,
): JsonObject => {
  const serialised = JSON.stringify(value);
  const originalBytes = bytesOf(serialised);
  if (originalBytes <= maxBytes) {
    return value;
  }
  const wrapped = (head: string): JsonObject => ({
    truncated: true,
    original_bytes: originalBytes,
    head,
  });
  // The longest head whose *wrapped* serialisation fits: escaping can grow a character to six
  // bytes (`\u0000`), so the fit is searched rather than computed.
  let low = 0;
  let high = serialised.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytesOf(JSON.stringify(wrapped(prefix(serialised, middle)))) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return wrapped(prefix(serialised, low));
};

/**
 * An error's text as the audit row may hold it: itself when at most `maxChars`, otherwise its head
 * and ` [truncated: n chars]`, the whole at most `maxChars`.
 */
export const boundAuditError = (text: string, maxChars: number = MAX_AUDIT_ERROR_CHARS): string => {
  if (text.length <= maxChars) {
    return text;
  }
  const notice = ` [truncated: ${String(text.length)} chars]`;
  return `${prefix(text, Math.max(0, maxChars - notice.length))}${notice}`;
};
