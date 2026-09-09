/**
 * The audit, idempotency, redaction and timing ports the `IntegrationActionExecutor` stands on —
 * technical/06 § "Outbound: actions", BD-003, TD-012.
 *
 * BD-003 is the reason this file exists at all: *every* outbound integration action is stored with
 * its payload and its result, append-only, so that "who changed this ticket, with what, and did it
 * work" is answerable after the fact. technical/03 gives it a table (`integration_actions`,
 * partitioned, `REVOKE UPDATE, DELETE`), and technical/02 gives the successful ones an event pair
 * (`integration.action.performed` / `.failed`).
 *
 * ## Which statuses produce an event, and why two of them do not
 *
 * technical/02 states the invariant "shadow tasks never produce `integration.action.performed` for
 * mutating actions", while technical/06 says shadow mode records the call as `would_have`. Both
 * hold at once because the *row* and the *event* answer different questions: the row records what
 * the platform decided, the event records what the provider was made to do. So:
 *
 * | status | row | event | meaning |
 * |---|---|---|---|
 * | `ok` | yes | `integration.action.performed` | the provider was called and succeeded |
 * | `failed` | yes | `integration.action.failed` | the provider was called and failed |
 * | `would_have` | yes | — | shadow mode: nothing was sent (technical/02 invariant) |
 * | `replayed` | yes | — | an idempotency key matched; nothing was sent |
 *
 * `integrationActionEventDrafts` is that table as code. Every adapter of `IntegrationAuditLog`
 * must use it rather than deciding for itself, which is what the port's contract suite checks.
 */
import type { Id, IsoDateTime, JsonObject, JsonValue } from '@platform/contracts';
import type { NormalisedEvent } from './common.js';

/** Direction of a recorded call (`integration_actions.direction`, technical/03). */
export type IntegrationActionDirection = 'in' | 'out';

/** `integration_actions.status`. See the table in this file's docblock. */
export type IntegrationActionStatus = 'ok' | 'failed' | 'would_have' | 'replayed';

/**
 * One append-only audit row.
 *
 * `payload`, `result` and `error` arrive **already redacted** (TD-012: redaction happens in the
 * single persistence path, before the write, because an append-only row cannot be fixed later).
 * `redactionCount` is what the redactor reported, so a row that should have hidden something and
 * did not is visible as a zero.
 */
export interface IntegrationActionEntry {
  readonly integrationId: Id;
  readonly provider: string;
  readonly projectId: Id | null;
  readonly taskId: Id | null;
  readonly direction: IntegrationActionDirection;
  /** Stable snake_case action name: `add_comment`, `transition`, `open_merge_request`. */
  readonly action: string;
  /** Whether the call changes provider state. Only mutating actions are skipped in shadow mode. */
  readonly mutating: boolean;
  readonly status: IntegrationActionStatus;
  readonly payload: JsonObject;
  readonly result: JsonObject | null;
  /** Redacted error message, `null` unless `status` is `failed`. */
  readonly error: string | null;
  readonly durationMs: number;
  readonly occurredAt: IsoDateTime;
  readonly redactionCount: number;
  /** How many provider attempts this action took, including the successful one. */
  readonly attempts: number;
}

/**
 * The append-only audit sink.
 *
 * The adapter writes the `integration_actions` row *and* appends the events from
 * `integrationActionEventDrafts` in one transaction, so the audit and the log can never disagree.
 * A failure to record is a failure of the action: the executor lets it propagate rather than
 * quietly performing unrecorded work (BD-003).
 */
export interface IntegrationAuditLog {
  record(entry: IntegrationActionEntry): Promise<void>;
}

/** The catalogue events an entry produces. See this file's docblock for the mapping. */
export const integrationActionEventDrafts = (
  entry: IntegrationActionEntry,
): readonly NormalisedEvent<'integration.action.performed' | 'integration.action.failed'>[] => {
  const actor = {
    kind: 'integration',
    integration_id: entry.integrationId,
    provider: entry.provider,
  } as const;

  if (entry.status === 'ok') {
    return [
      {
        type: 'integration.action.performed',
        payload: {
          project_id: entry.projectId,
          task_id: entry.taskId,
          integration_id: entry.integrationId,
          action: entry.action,
          payload_redacted: entry.payload,
          result: entry.result ?? {},
          duration_ms: entry.durationMs,
        },
        actor,
      },
    ];
  }

  if (entry.status === 'failed') {
    return [
      {
        type: 'integration.action.failed',
        payload: {
          project_id: entry.projectId,
          task_id: entry.taskId,
          integration_id: entry.integrationId,
          action: entry.action,
          payload_redacted: entry.payload,
          error: entry.error ?? 'unknown error',
          duration_ms: entry.durationMs,
        },
        actor,
      },
    ];
  }

  // `would_have` (technical/02 invariant) and `replayed`: the provider was never called.
  return [];
};

// ── Idempotency ──────────────────────────────────────────────────────────────

/**
 * What an idempotency key is scoped to.
 *
 * All three parts matter. Two integrations of the same provider are different accounts, and the
 * same key on two *actions* means two different calls — "comment on PROJ-1" and "transition
 * PROJ-1" would otherwise share a slot and the second would return the first one's result.
 */
export interface IdempotencyScope {
  readonly integrationId: Id;
  readonly action: string;
  readonly key: string;
}

/**
 * The single composition of a scope into a storage key, so no adapter invents its own.
 *
 * `encodeURIComponent` escapes `:`, so no combination of parts can produce the same string as a
 * different combination — a property test asserts exactly that.
 */
export const idempotencyStorageKey = (scope: IdempotencyScope): string =>
  [scope.integrationId, scope.action, scope.key].map(encodeURIComponent).join(':');

/**
 * Remembers the result of a mutating action so a retry — of the job, of the handler, of the whole
 * process — does not perform it twice (product/08 § "Idempotency").
 *
 * `undefined` means "never seen"; a stored `null` is a legitimate remembered result, which is why
 * the miss is `undefined` rather than `null`.
 */
export interface IdempotencyStore {
  get(scope: IdempotencyScope): Promise<JsonValue | undefined>;
  put(scope: IdempotencyScope, result: JsonValue): Promise<void>;
}

// ── Redaction (TD-012) ───────────────────────────────────────────────────────

export interface RedactionOutcome<T> {
  readonly value: T;
  /** How many replacements were made. Stored on the row as `redaction_count`. */
  readonly count: number;
}

/**
 * Removes secrets before anything is written (TD-012).
 *
 * The port is deliberately required, with no default implementation in the executor: a redactor
 * that defaults to "do nothing" is indistinguishable, at the call site, from one that works.
 */
export interface SecretRedactor {
  redactJson(value: JsonObject): RedactionOutcome<JsonObject>;
  redactText(text: string): RedactionOutcome<string>;
}

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * The clock and the sleep the executor uses for backoff and rate limiting.
 *
 * Separate from `@platform/domain`'s `Clock` (which speaks ISO-8601 for payloads) because
 * backoff arithmetic is milliseconds, and because a test must be able to make time pass without
 * any passing: a wall-clock assertion is a hardware assertion, not a correctness one.
 */
export interface IntegrationTimer {
  /** Monotonic-ish milliseconds; only differences are meaningful. */
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}
