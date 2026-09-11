/**
 * `IntegrationActionExecutor` — the single door every outbound provider call goes through
 * (technical/06 § "Outbound: actions").
 *
 * > Every action call goes through an `IntegrationActionExecutor` that: checks shadow mode
 * > (mutating actions are no-ops recorded as `would_have`), applies rate-limit/backoff per
 * > provider (429 + `Retry-After`), enforces idempotency (marker ids for comments, "only
 * > transition if not already there"), records `integration.action.performed|failed` with
 * > redacted payload, and updates health.
 *
 * Those five duties are the five sections below, in the order the executor performs them. The
 * pipeline never calls a provider directly: handlers in the integration priority band (100–199,
 * TD-005) call this, so shadow mode, the audit and the rate limit cannot be forgotten at a call
 * site.
 *
 * ## What the type system enforces, and what the runtime enforces after it
 *
 * A **mutating** request must supply `mode`, `shadowResult` and `describeResult`. All three are
 * omissions that a reviewer cannot see: a mutation with no `shadowResult` would have to fail (or
 * lie) the first time a shadow task reached it, and one with no `describeResult` would write an
 * audit row with no evidence of what the provider actually did (BD-003). Making them required is
 * why `IntegrationActionRequest` is a union rather than one optional-heavy interface.
 *
 * `mode` is the same argument, harder. It gates a *side effect*: a call site that forgets it —
 * WP-15's stage handlers are the ones that will make these calls — would, under a default, get a
 * real comment on a real ticket where shadow mode was intended. A safety guard whose default
 * guesses "not guarded" fails open, so there is no default: a mutating request states the task's
 * mode or does not compile.
 *
 * A type, however, is a compile-time fact, and `execute` is a **boundary**: an untyped call site,
 * an `as` cast, a plugin or a value that came through `JSON.parse` all reach it with the types
 * erased, and there a missing `mode` — or `'SHADOW'` instead of `'shadow'` — falls straight
 * through a `=== 'shadow'` comparison into a real provider call. So the mode of a mutating request
 * is *parsed* with `taskModeSchema` before the guard reads it (zod at every boundary, CLAUDE.md),
 * and an unparseable one is `invalid_request` with nothing performed and no audit row, exactly as
 * a malformed action name is. Reads keep `mode` optional and unparsed, because a read is performed
 * in every mode and a health probe or a poll has no task to take a mode from.
 *
 * ## What leaves the executor, and what has been scrubbed first
 *
 * A provider's text — an error message, a result, an id read back out of a comment — is untrusted
 * and may quote back a credential the platform injected (TD-012, BD-002). Four things carry it out
 * of this file, and each is redacted — except the one that cannot be, which is refused instead:
 *
 *  - the audit row (`buildEntry`), where payload, result and error are redacted and counted;
 *  - the **idempotency record**, whose two halves get *different* answers because only one of them
 *    is an identity: the stored **value** is redacted and counted onto the row that reports the
 *    action (`redactStoredJson`, because `encode` is often the identity over provider text), while
 *    a **key** that needs redacting is **refused** (`idempotencyScopeFor`) — redacting a key
 *    collapses two different calls into one slot, which answers the second with the first one's
 *    result. Checked once, where the scope is built, so `get` and `put` cannot disagree;
 *  - the log line written when the audit row cannot be persisted — it logs the *row's* `error`, so
 *    the two can never diverge;
 *  - **every** error thrown out of `execute`, scrubbed by `redactErrorInPlace` in the single
 *    `catch` wrapped around the whole body.
 *
 * The list was "three things" until a reviewer measured the second one and found it storing a
 * provider's `message_id` verbatim — the *fourth* instance of one class (Jira's, GitLab's and
 * Slack's delivery keys were the first three, one branch earlier), and the second time a sentence
 * in this docblock outlived the code it described (standing rules 49 and 63). The count is
 * therefore checkable on purpose: everything a reader can reach from this file that writes
 * provider text to a log, a row or a store is in the list above.
 *
 * The last one is a choke point rather than a rule to remember, because "the redaction is on one
 * branch and not the other" was found three times in this one file over two review rounds (the
 * audit-failure log line, the rethrown provider error, and `throw auditError` one line away from
 * a scrubbed sibling). A branch cannot forget the scrub when it has no way out except through it —
 * and there are more ways out than the two `throw`s: a failing `idempotencyStore.get`/`put`, a
 * failing audit write on the **success** path, a `describeResult` that throws, a redactor that
 * breaks its own contract, and the request guards themselves all leave the same way.
 *
 * ### What `redactErrorInPlace` covers, exactly
 *
 * The consumer sets the scope. `apps/server` logs an unexpected error as `{ err }` and pino
 * serialises it with `pino-std-serializers` (`lib/err.js`), which emits `message` and `stack`
 * **with the whole cause chain appended**, the `errors[]` of an `AggregateError`, and a copy of
 * every key its `for…in` reaches. So the scrub walks:
 *
 *  - `message` and `stack` of the error and of every error in its `cause` chain, to any depth,
 *    because pino's chain walk has no depth bound either (`lib/err-helpers.js`). A cycle
 *    terminates on the same kind of `seen` set pino uses, and the walk is iterative, so a long
 *    chain cannot overflow the stack;
 *  - `errors[]` of an `AggregateError` — non-enumerable, so no property walk would reach it;
 *  - every enumerable property `for…in` reaches, recursively through plain objects and arrays.
 *    That is the axios/undici shape WP-08…WP-11 will throw (`error.config.headers.Authorization`,
 *    `error.response.body`), and it is also what `JSON.stringify` and `util.inspect` print.
 *
 * What it does **not** cover — each asserted as a limitation in `action-executor.test.ts` rather
 * than assumed away, so a change that makes one coverable is noticed:
 *
 *  - an object that refuses the write: a frozen or sealed error, or a getter with no setter. Those
 *    replacements are counted as `blocked` and the executor logs that count (never the text),
 *    because the alternative is a silent leak. `String(frozenError)` still yields the original;
 *  - a `cause` that is a *function* (VError style, which pino calls). Scrubbing it would mean
 *    calling an arbitrary function; nothing in this repository throws that shape;
 *  - values inside a `Map`, a `Set` or a symbol-keyed property. pino renders a `Map` as `{}` in
 *    JSON so it is not a pino leak, but `util.inspect` would still print it;
 *  - a secret the platform never injected. `exactSecretRedactor` matches the values it was handed
 *    (TD-012 step 1); nothing here is a pattern scanner.
 *
 * ## Ordering, and what a crash between two steps costs
 *
 * On success the idempotency key is stored **before** the audit row is written. The alternative
 * loses more: with the row first, a crash in between makes the next attempt call the provider
 * again — a second comment, a second merge request. With the key first, the next attempt replays
 * and writes a `replayed` row, so the audit keeps a record of the action and only its *status* is
 * less precise. Neither order is atomic; this one degrades into a duplicate row rather than a
 * duplicate side effect.
 *
 * A replay therefore returns the **redacted** result, not the one the provider sent: the store is
 * persistent state and is written once, so redaction has to happen before the write or not at all
 * (BD-003). That is only visible for a result that carried an injected secret, and a caller that
 * needs such a value back must not carry an idempotency key at all — the same decision the
 * `IdempotencyPlan` docblock already asks of a result that cannot be JSON.
 *
 * The key half gets the other answer — refusal — and `idempotencyScopeFor` is where that argument
 * lives, because the asymmetry is the part a reader will not guess.
 */
import {
  type Id,
  type JsonObject,
  type JsonValue,
  type TaskMode,
  taskModeSchema,
} from '@platform/contracts';
import type { Clock } from '@platform/domain';
import type {
  IdempotencyScope,
  IdempotencyStore,
  IntegrationActionEntry,
  IntegrationActionStatus,
  IntegrationAuditLog,
  IntegrationTimer,
  RedactionOutcome,
  SecretRedactor,
} from '../ports/integrations/audit.js';
import {
  IntegrationError,
  IntegrationRateLimitedError,
  type IntegrationRef,
} from '../ports/integrations/common.js';
import { type LogFields, type Logger, silentLogger } from '../ports/logger.js';
import {
  createRateLimiter,
  DEFAULT_RATE_LIMIT_POLICY,
  type RateLimiter,
  type RateLimitPolicy,
} from './rate-limiter.js';

// ── The request ──────────────────────────────────────────────────────────────

/** What the executor tells `perform` about the attempt it is making. */
export interface AttemptContext {
  /** 1 for the first call, 2 for the first retry, … */
  readonly attempt: number;
  readonly action: string;
}

/**
 * How a result survives a replay.
 *
 * The stored form must be JSON — it goes to a database — so the caller states how to get there
 * and back. An action whose result cannot be JSON (a minted credential, a stream) must not carry
 * an idempotency key; that is a decision the caller makes by not writing one.
 *
 * The store is persistent state (TD-012, BD-002), and the executor handles the two halves
 * differently because only one of them is an identity:
 *
 *  - whatever `encode` returns is **redacted** before the write, so `decode` may be handed a value
 *    carrying `[REDACTED:integration:…]` where the provider had put an injected secret. An action
 *    that cannot tolerate that must not carry an idempotency key — the same decision this docblock
 *    already asks of a result that cannot be JSON;
 *  - a `key` that carries an injected secret is **refused**, not redacted: `invalid_request`, with
 *    nothing performed and nothing stored. Redacting it would make two keys that differ only
 *    inside a secret into one, and the losing call is told its own result is the winner's. A key
 *    must therefore be composed of things the platform is willing to store — ids, slugs, dates —
 *    and never of credential material. `idempotencyScopeFor` carries the full reasoning.
 *
 * Neither `encode` nor any call site redacts a second time: one guard each, mutation-checked in
 * `action-executor.test.ts`.
 */
export interface IdempotencyPlan<TResult> {
  /** Marker id, `Idempotency-Key` header value, or any string stable across retries. */
  readonly key: string;
  encode(result: TResult): JsonValue;
  decode(stored: JsonValue): TResult;
}

interface BaseActionRequest<TResult> {
  readonly integration: IntegrationRef;
  /** Stable snake_case name recorded in the audit: `add_comment`, `transition`, `open_mr`. */
  readonly action: string;
  /** Recorded as `integration_actions.payload`, after redaction. */
  readonly payload: JsonObject;
  readonly projectId?: Id | null;
  readonly taskId?: Id | null;
  readonly idempotency?: IdempotencyPlan<TResult>;
  perform(attempt: AttemptContext): Promise<TResult>;
}

/**
 * A read. Safe in shadow mode, so it needs no shadow substitute.
 *
 * **`mutating: false` is a claim the executor cannot check, and it is load-bearing.** A write
 * labelled as a read skips the shadow guard entirely: it is performed against the provider in
 * shadow mode and recorded `ok` rather than `would_have`. Nothing here can tell the difference —
 * the executor sees a `perform` lambda and a name — and a guess from the action name would be a
 * hand-maintained verb list that drifts silently in the dangerous direction (standing rule 7). So
 * the obligation lands on whoever writes the adapter: **WP-08…WP-11, in the provider's contract
 * suite** — a port method that changes provider state must be asserted to reach the executor as a
 * `MutatingActionRequest`, by running it in shadow mode and asserting the provider was not
 * entered, as `test/contract/integrations/action-executor.contract.test.ts` already does for the
 * four mutating cases it covers.
 */
export interface ReadActionRequest<TResult> extends BaseActionRequest<TResult> {
  readonly mutating: false;
  /**
   * `tasks.mode` (technical/03), when the caller has a task.
   *
   * Optional here and only here: a read is performed in every mode, so the value changes nothing.
   * `testConnection` and the polling fallback have no task at all.
   */
  readonly mode?: TaskMode;
  /** Optional for reads: a ticket body in the audit row is noise, not evidence. */
  describeResult?(result: TResult): JsonObject | null;
}

/** A write. All three extra members are required — see the docblock. */
export interface MutatingActionRequest<TResult> extends BaseActionRequest<TResult> {
  readonly mutating: true;
  /**
   * `tasks.mode` (technical/03). Required, never defaulted: it is what stops a shadow task from
   * reaching a provider, and a guard that defaults to `normal` fails open.
   */
  readonly mode: TaskMode;
  /** What a shadow task gets instead of performing the action (technical/04 § shadow mode). */
  shadowResult(): TResult;
  /** The evidence recorded in the audit row (BD-003). Must contain no secret. */
  describeResult(result: TResult): JsonObject | null;
}

export type IntegrationActionRequest<TResult> =
  | ReadActionRequest<TResult>
  | MutatingActionRequest<TResult>;

export interface IntegrationActionOutcome<TResult> {
  /** `failed` never appears here: a failure is thrown, after the audit row is written. */
  readonly status: Exclude<IntegrationActionStatus, 'failed'>;
  readonly result: TResult;
  /** Provider calls made. 0 for `would_have` and `replayed`. */
  readonly attempts: number;
  readonly durationMs: number;
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface RetryPolicy {
  /** Including the first call. 1 disables retries. */
  readonly maxAttempts: number;
  /** First backoff step; doubled per attempt, capped at `maxDelayMs`. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/**
 * Three attempts over ~1.5 s of backoff.
 *
 * Deliberately without jitter: a fixed delay is never *shorter* than the jittered one a real
 * client would use, so a test that asserts "not yet retried at t" cannot pass here and fail in
 * production. The cost is a thundering herd after a shared outage, which the per-integration
 * concurrency cap already bounds.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

export interface IntegrationActionExecutorOptions {
  readonly auditLog: IntegrationAuditLog;
  /** Required, never defaulted: a no-op redactor looks exactly like a working one (TD-012). */
  readonly redactor: SecretRedactor;
  readonly timer: IntegrationTimer;
  /** Supplies `occurred_at` for the audit row, in the platform's wire format. */
  readonly clock: Clock;
  readonly idempotencyStore?: IdempotencyStore;
  readonly logger?: Logger;
  /** Per-integration policy. A function lets a provider declare its own budget (WP-08…WP-11). */
  readonly rateLimits?: RateLimitPolicy | ((ref: IntegrationRef) => RateLimitPolicy);
  readonly retry?: RetryPolicy;
}

export interface IntegrationActionExecutor {
  execute<TResult>(
    request: IntegrationActionRequest<TResult>,
  ): Promise<IntegrationActionOutcome<TResult>>;
}

const ACTION_NAME = /^[a-z][a-z0-9_]*$/;

const assertActionName = (request: { action: string; integration: IntegrationRef }): void => {
  if (!ACTION_NAME.test(request.action) || request.action.length > 64) {
    throw new IntegrationError(
      'invalid_request',
      request.integration.provider,
      `"${request.action}" is not a snake_case action name`,
      { action: request.action },
    );
  }
};

/**
 * The runtime half of the shadow guard: the mode a mutating request states, parsed.
 *
 * `MutatingActionRequest.mode` is required, and that is a fact about `tsc`, not about the process.
 * The values that actually arrive here at run time come from `tasks.mode` by way of a handler, and
 * anything between them — an untyped call site, an `as` cast, a plugin, a `JSON.parse`d request —
 * can produce `undefined` or `'SHADOW'`. Both compare unequal to `'shadow'`, so without this the
 * guard would fall through to a **real** side effect on a provider (found live at WP-07 review
 * round 2 by calling `execute` from JavaScript).
 *
 * Refusing before anything is recorded matches `assertActionName`: a request this malformed never
 * reached a provider, so it has no provider-facing existence to audit.
 *
 * @throws {IntegrationError} `invalid_request`, never carrying more than a truncated echo.
 */
const requireMutatingMode = <TResult>(request: MutatingActionRequest<TResult>): TaskMode => {
  const parsed = taskModeSchema.safeParse(request.mode);
  if (parsed.success) {
    return parsed.data;
  }
  throw new IntegrationError(
    'invalid_request',
    request.integration?.provider,
    `mutating action "${request.action}" must state the task's mode ('normal' or 'shadow'), ` +
      `got ${JSON.stringify(String(request.mode).slice(0, 32))}`,
    { action: request.action },
  );
};

const describe = <TResult>(
  request: IntegrationActionRequest<TResult>,
  result: TResult,
): JsonObject | null => (request.describeResult ? request.describeResult(result) : null);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * What one scrub did, and what it could not do.
 *
 * `blocked` is the honest half. A frozen error, or a value behind a getter with no setter, keeps
 * its text; counting those refusals is what turns "the secret is still in there" from a silent
 * outcome into a logged one. It counts *replacements*, like `count`, so the two are the same unit.
 */
export interface ErrorRedaction {
  /** Replacements actually written. */
  readonly count: number;
  /** Replacements the object refused, and therefore secrets the value still carries. */
  readonly blocked: number;
}

/**
 * pino's own test for "this is an error" (`pino-std-serializers/lib/err-helpers.js`), copied
 * deliberately rather than narrowed to `instanceof Error`: the walk below has to cover exactly
 * what the consumer serialises, and pino serialises anything with a string `message` — a
 * cross-realm error, or a rejected value that merely looks like one.
 */
const isErrorLike = (value: object): value is { message: string } =>
  typeof (value as { message?: unknown }).message === 'string';

/** Reads a property that may be a throwing getter. pino reads the same ones. */
const readProperty = (target: object, property: string): unknown => {
  try {
    return (target as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
};

/**
 * Writes `value`, or reports `false` when the object refuses it. Never throws.
 *
 * The write is read back: an assignment to a frozen property throws in a module (ESM is strict),
 * but an inherited setter that ignores its argument does not, and "wrote nothing and said it
 * worked" is the one outcome this must never report.
 */
const overwrite = (target: object, property: string, value: string): boolean => {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  if (descriptor !== undefined && descriptor.writable !== true && descriptor.set === undefined) {
    return false;
  }
  try {
    (target as Record<string, unknown>)[property] = value;
    return readProperty(target, property) === value;
  } catch {
    // A frozen or exotic error object keeps its text; the audit row is redacted either way.
    return false;
  }
};

/** Redacts one string property in place, crediting the write or the refusal. */
const scrubProperty = (
  redactor: SecretRedactor,
  target: object,
  property: string,
  current: string,
  tally: { count: number; blocked: number },
): void => {
  const redacted = redactor.redactText(current);
  if (redacted.count === 0) {
    return;
  }
  if (overwrite(target, property, redacted.value)) {
    tally.count += redacted.count;
  } else {
    tally.blocked += redacted.count;
  }
};

/** The one-key document `redactStoredJson` walks a bare `JsonValue` inside. */
const STORED_WRAPPER_KEY = 'value';

/**
 * Redacts **any** `JsonValue` on its way into persistent state (TD-012, BD-002).
 *
 * `SecretRedactor` speaks `JsonObject` and `string`, and an encoded idempotency result is neither
 * in general: `slack/digest.ts` stores an object, `add_comment` a bare string, and nothing stops a
 * plan from encoding an array. So the value is walked inside a one-key document rather than
 * branched on by type — one path, with no per-shape branch that could be the unredacted one.
 *
 * A redactor that did not return the key it was handed has broken the port's contract (the walk
 * preserves the document's shape; only string leaves change). That is a `TypeError` rather than a
 * silent `null`, because the alternative is storing something that is not what `encode` produced
 * and handing it to `decode` on the replay. It leaves through `execute`'s scrub like every other
 * failure of the store, and costs the same thing a failing `put` costs: the action is reported
 * failed after the provider performed it, and the retry replays nothing.
 */
const redactStoredJson = (
  redactor: SecretRedactor,
  value: JsonValue,
): RedactionOutcome<JsonValue> => {
  const redacted = redactor.redactJson({ [STORED_WRAPPER_KEY]: value });
  const unwrapped = redacted.value[STORED_WRAPPER_KEY];
  if (unwrapped === undefined) {
    throw new TypeError(
      'the redactor dropped a key from the document it was given; ' +
        'redactJson must preserve the shape of what it walks (TD-012)',
    );
  }
  return { value: unwrapped, count: redacted.count };
};

/**
 * Scrubs a thrown value **in place** before it leaves the executor (TD-012, BD-002).
 *
 * In place rather than by wrapping, because identity is load-bearing: a handler matches on
 * `instanceof IntegrationError` and on `code`, and a copy would either lose the subclass or need
 * one clone per subclass. `stack` is scrubbed alongside `message` because V8 bakes the message
 * into it at construction, so redacting only `message` leaves the secret in the field pino logs
 * next.
 *
 * The walk is deliberately the consumer's walk — cause chain, `AggregateError.errors`, and every
 * `for…in` property, recursively — and the module docblock lists what it covers and what it
 * cannot. It is iterative with a `seen` set, so cycles terminate and depth costs heap rather than
 * stack.
 */
export const redactErrorInPlace = (redactor: SecretRedactor, error: unknown): ErrorRedaction => {
  const tally = { count: 0, blocked: 0 };
  const seen = new Set<object>();
  const pending: unknown[] = [error];

  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue;
    }
    seen.add(node);

    if (isErrorLike(node)) {
      scrubProperty(redactor, node, 'message', node.message, tally);
      const stack = readProperty(node, 'stack');
      if (typeof stack === 'string') {
        scrubProperty(redactor, node, 'stack', stack, tally);
      }
      // Both are invisible to `for…in`: `cause` and `errors` are defined non-enumerable by the
      // language, and pino reaches them by name. So does this.
      pending.push(readProperty(node, 'cause'));
      const aggregated = readProperty(node, 'errors');
      if (Array.isArray(aggregated)) {
        pending.push(aggregated);
      }
    }

    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const item: unknown = node[index];
        if (typeof item === 'string') {
          scrubProperty(redactor, node, String(index), item, tally);
        } else {
          pending.push(item);
        }
      }
      continue;
    }

    // `for…in`, the walk `pino-std-serializers` performs over an error's own and inherited
    // enumerable keys (`lib/err.js`). An axios error's `config.headers.Authorization` lives here.
    for (const key in node) {
      const value = readProperty(node, key);
      if (typeof value === 'string') {
        scrubProperty(redactor, node, key, value, tally);
      } else {
        pending.push(value);
      }
    }
  }

  return { count: tally.count, blocked: tally.blocked };
};

export const createIntegrationActionExecutor = (
  options: IntegrationActionExecutorOptions,
): IntegrationActionExecutor => {
  const logger = options.logger ?? silentLogger;
  const retry = options.retry ?? DEFAULT_RETRY_POLICY;
  if (retry.maxAttempts < 1) {
    throw new TypeError(`retry.maxAttempts must be at least 1, got ${retry.maxAttempts}`);
  }

  const policyFor = (ref: IntegrationRef): RateLimitPolicy =>
    typeof options.rateLimits === 'function'
      ? options.rateLimits(ref)
      : (options.rateLimits ?? DEFAULT_RATE_LIMIT_POLICY);

  // One limiter per `integrations.id`. See rate-limiter.ts for why the budget is not shared
  // across bindings of one provider by default.
  const limiters = new Map<Id, RateLimiter>();
  const limiterFor = (ref: IntegrationRef): RateLimiter => {
    const existing = limiters.get(ref.integrationId);
    if (existing !== undefined) {
      return existing;
    }
    const created = createRateLimiter(policyFor(ref), options.timer);
    limiters.set(ref.integrationId, created);
    return created;
  };

  const record = async (entry: IntegrationActionEntry): Promise<void> => {
    await options.auditLog.record(entry);
  };

  /** Builds the row, redacting payload, result and error in the one place before the write. */
  const buildEntry = <TResult>(
    request: IntegrationActionRequest<TResult>,
    fields: {
      readonly status: IntegrationActionStatus;
      readonly result: JsonObject | null;
      readonly error: string | null;
      readonly durationMs: number;
      readonly attempts: number;
      /**
       * Replacements this action made **outside** the row, and so with nowhere else to be counted:
       * today only the idempotency record's value, which is persistent state written by this
       * action and has no row of its own. Carried here rather than dropped because a scrub that
       * reports nothing is indistinguishable from one that ran on a clean document — the very
       * thing `redactionCount` exists to make visible.
       */
      readonly extraRedactions?: number;
    },
  ): IntegrationActionEntry => {
    const payload = options.redactor.redactJson(request.payload);
    const result = fields.result === null ? null : options.redactor.redactJson(fields.result);
    const error = fields.error === null ? null : options.redactor.redactText(fields.error);
    return {
      integrationId: request.integration.integrationId,
      provider: request.integration.provider,
      projectId: request.projectId ?? null,
      taskId: request.taskId ?? null,
      direction: 'out',
      action: request.action,
      mutating: request.mutating,
      status: fields.status,
      payload: payload.value,
      result: result === null ? null : result.value,
      error: error === null ? null : error.value,
      durationMs: fields.durationMs,
      occurredAt: options.clock.now(),
      redactionCount:
        payload.count + (result?.count ?? 0) + (error?.count ?? 0) + (fields.extraRedactions ?? 0),
      attempts: fields.attempts,
    };
  };

  /** How long to wait before attempt `attempt + 1`, or `null` when there must not be one. */
  const retryDelayMs = (error: unknown, attempt: number): number | null => {
    if (attempt >= retry.maxAttempts) {
      return null;
    }
    if (!(error instanceof IntegrationError) || !error.retryable) {
      return null;
    }
    const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
    if (error instanceof IntegrationRateLimitedError && error.retryAfterMs !== null) {
      // The provider's own instruction wins over our schedule — in both directions. A short
      // `Retry-After` is honoured because the provider knows when its window resets, and a long
      // one because ignoring it is how an app gets its quota cut (product/08).
      return error.retryAfterMs;
    }
    return backoff;
  };

  /**
   * Identifying fields for a log line, built so that a malformed request cannot make the *logging*
   * throw and replace the error the caller was about to receive.
   */
  const logFieldsOf = (request: IntegrationActionRequest<unknown>): LogFields => {
    const shape = request as Partial<BaseActionRequest<unknown>> | null | undefined;
    return {
      integration_id: shape?.integration?.integrationId ?? null,
      action: typeof shape?.action === 'string' ? shape.action : null,
    };
  };

  /**
   * The scope an idempotency key is looked up and stored under — or a refusal (TD-012, BD-002).
   *
   * **An idempotency key is an identity, redaction is not injective, and a key that needs
   * redacting is therefore refused rather than laundered.** Round 2 of this branch redacted it
   * instead. That removed the leak and left a collision: two keys differing only inside a secret
   * became one key, so the second call was answered `replayed` carrying the **first** call's
   * result while its own `perform` never ran. Handing a caller another request's answer and
   * telling it the answer is its own is worse than the leak the redaction fixed. Refusing keeps
   * both properties at once — no injected secret reaches the store through the key (the string
   * the store receives is *proved* free of one, not merely placeheld), and distinct keys stay
   * distinct.
   *
   * That is the opposite trade from the audit row two functions below, deliberately. BD-003 says
   * an action nobody recorded is an action nobody can audit, so the row **must** be written and
   * pays the fidelity loss; a key carries no such obligation — it is a lookup, and a lookup that
   * collides returns the wrong answer rather than a less precise one.
   *
   * **It is also the opposite answer from the platform's other stored identity, and that is
   * decided rather than accidental.** Every provider's `InboundNormaliser.deliveryKey` applies the
   * same many-to-one transform to a string that becomes `inbox(provider, delivery_id)`'s primary
   * key — it *redacts* where this *refuses*. Rule 20 is what points the two apart, and it is the
   * whole of the reason:
   *
   *  - this request is a **mutation the platform is about to make**, so refusing costs exactly one
   *    action, loudly, before anything reaches the provider — fail closed;
   *  - a delivery is a **notification the platform has already been told about**, so refusing one
   *    drops it, and the event never reaches the pipeline — the stuck-queue failure rule 20 was
   *    written from (WP-09's `mapPipelineStatus`). Fail open.
   *
   * Neither side is free. `InboundNormaliser.deliveryKey` states the residual its answer keeps
   * (rule 38: when two deliveries collapse onto one key the **first** survives and the later one
   * is silently deduped away) and the third option neither answer takes — a one-way digest, which
   * is distinct *and* carries no secret — with the measurement that filed it rather than doing it.
   *
   * It also makes a **forged placeholder** inert, which is the second half of the same finding.
   * All external text is untrusted (BD-022), so an actor who can write a ticket comment or an MR
   * note can write `[REDACTED:integration:jira]` verbatim; while keys were redacted, that literal
   * string matched the stored key of a real call and replayed its result (measured: `replayed`,
   * one key in the store, the forged `perform` never invoked). Now no stored key is ever a
   * redaction output, so a forged one can collide with nothing but a literal copy of itself. What
   * is left is the property every idempotency scheme has — whoever controls the key controls the
   * slot — bounded by `(integration, action)` as `IdempotencyScope` describes.
   *
   * **Reachability, measured before the decision.** The repository ships exactly one
   * `IdempotencyPlan`: `slack/digest.ts`'s `slack:digest:<channel>:<day>`, whose parts are binding
   * configuration and the clock in the schedule's zone. Neither half of the finding was reachable
   * through it, or through anything else on disk. The guard is here for the plan technical/06
   * actually describes — "marker ids for comments", text the platform reads back out of a
   * provider's comment body — which is the first key an outsider gets to influence, and which a
   * later WP will write without re-deriving this argument.
   *
   * Refusing before anything is recorded matches `assertActionName` and `requireMutatingMode`: a
   * request this malformed never reached a provider, so it has no provider-facing existence to
   * audit. The cost is stated rather than hidden — an action whose key genuinely carries an
   * injected secret now fails on every attempt instead of quietly answering with another call's
   * result, and an actor who plants the literal placeholder can **deny** one action rather than
   * **read** its answer. Both are the fail-closed direction on a mutation (rule 20).
   *
   * @throws {IntegrationError} `invalid_request`, never echoing the key it refuses.
   */
  const idempotencyScopeFor = <TResult>(
    request: IntegrationActionRequest<TResult>,
  ): IdempotencyScope | null => {
    if (!request.idempotency || !options.idempotencyStore) {
      return null;
    }
    const key = options.redactor.redactText(request.idempotency.key);
    if (key.count > 0) {
      // Operability, not audit (rule 20's second half). The absent row is correct — nothing
      // provider-facing happened, so there is nothing to audit — and the absent echo of the key
      // is correct too, which together left a refused action with *nothing anywhere* to diagnose
      // it by: measured as 0 audit rows and 0 log lines. Every other data-dependent failure in
      // this file writes a `failed` row and can be found in one; this one has only this line.
      // `logFieldsOf` and not the key: the identity of the request is what an operator needs, and
      // the key is the one thing that must not be written down.
      logger.warn(
        logFieldsOf(request),
        'refused an idempotency key carrying an injected secret; the action was not performed',
      );
      throw new IntegrationError(
        'invalid_request',
        request.integration.provider,
        `the idempotency key of "${request.action}" contains a secret the platform injected; a ` +
          'key is an identity, and redacting it would collapse two different calls into one ' +
          '(TD-012)',
        { action: request.action },
      );
    }
    return {
      integrationId: request.integration.integrationId,
      action: request.action,
      // `count` is 0 by the guard above, so this is `request.idempotency.key` unchanged. Spelled
      // as the redactor's own output anyway, so there is no expression on this path that reaches
      // the store without having been through the check (rule 41: one guard, and it is this one).
      // This is the file's one `RedactionOutcome` whose `count` is not carried to the audit row,
      // and it is the one that cannot be: a non-zero count here is a refusal, not a redaction, so
      // the number a row could report is always the same zero.
      key: key.value,
    };
  };

  const run = async <TResult>(
    request: IntegrationActionRequest<TResult>,
  ): Promise<IntegrationActionOutcome<TResult>> => {
    assertActionName(request);
    const startedAt = options.timer.now();

    // 1 — Shadow mode. A shadow task reads freely and never writes (technical/02: "shadow tasks
    //     never produce integration.action.performed for mutating actions"). The mode is read off
    //     the request, never defaulted — `MutatingActionRequest` makes it required — and then
    //     *parsed*, so that neither an omission nor a mis-spelling at an untyped call site can
    //     skip this branch.
    if (request.mutating && requireMutatingMode(request) === 'shadow') {
      const result = request.shadowResult();
      await record(
        buildEntry(request, {
          status: 'would_have',
          result: describe(request, result),
          error: null,
          durationMs: 0,
          attempts: 0,
        }),
      );
      return { status: 'would_have', result, attempts: 0, durationMs: 0 };
    }

    // 2 — Idempotency. The key is scoped to (integration, action, key); nothing is shared across
    //     bindings or across actions (see `idempotencyStorageKey`). The key is checked **once**,
    //     before the scope exists, so the `get` below and the `put` on the success path cannot
    //     disagree about what they are looking for — and a key made of secret material is refused
    //     rather than redacted, because a key is an identity. `idempotencyScopeFor` holds the
    //     whole argument, including what an attacker would have to do and what it costs them.
    const scope: IdempotencyScope | null = idempotencyScopeFor(request);

    if (scope !== null && request.idempotency && options.idempotencyStore) {
      const stored = await options.idempotencyStore.get(scope);
      if (stored !== undefined) {
        const result = request.idempotency.decode(stored);
        await record(
          buildEntry(request, {
            status: 'replayed',
            result: describe(request, result),
            error: null,
            durationMs: 0,
            attempts: 0,
          }),
        );
        return { status: 'replayed', result, attempts: 0, durationMs: 0 };
      }
    }

    // 3 — Attempts, through the rate limiter, with backoff on 429 and on transient failures.
    const limiter = limiterFor(request.integration);
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const lease = await limiter.acquire();
      let result: TResult;
      try {
        result = await request.perform({ attempt, action: request.action });
      } catch (error) {
        lease.release();
        const delay = retryDelayMs(error, attempt);
        if (delay === null) {
          // 4 — Audit before the throw: an action nobody recorded is an action nobody can audit.
          const durationMs = options.timer.now() - startedAt;
          // Built before anything is logged or thrown, because it is where the provider's message
          // is redacted and counted; every other copy of that text comes from `entry.error`.
          const entry = buildEntry(request, {
            status: 'failed',
            result: null,
            error: errorMessage(error),
            durationMs,
            attempts: attempt,
          });
          try {
            await record(entry);
          } catch (auditError) {
            logger.error(
              {
                ...logFieldsOf(request),
                // The row's own redacted text, so the log and the audit cannot diverge.
                err: entry.error,
              },
              'integration action failed and its audit row could not be written',
            );
            // Unscrubbed here on purpose: `execute` scrubs everything that leaves, including this
            // one and the provider error below. Redacting on one branch and not the other is the
            // defect this choke point exists to make impossible.
            throw auditError;
          }
          throw error;
        }
        if (error instanceof IntegrationRateLimitedError) {
          limiter.penalise(delay);
        }
        logger.warn(
          { ...logFieldsOf(request), attempt, delay_ms: delay },
          'integration action failed; retrying',
        );
        await options.timer.sleep(delay);
        continue;
      }
      lease.release();

      // 5 — Success: remember it, then record it. See the docblock for why in that order.
      //     The stored value is redacted first, for the reason the audit row is: it is persistent
      //     state, written once, and `encode` is frequently the identity over provider text
      //     (`slack/digest.ts`). Redacted *here* rather than in `encode`, so a call site cannot
      //     forget it and there is exactly one guard to mutate (standing rule 41).
      let storedRedactions = 0;
      if (scope !== null && request.idempotency && options.idempotencyStore) {
        const stored = redactStoredJson(options.redactor, request.idempotency.encode(result));
        storedRedactions = stored.count;
        await options.idempotencyStore.put(scope, stored.value);
      }
      const durationMs = options.timer.now() - startedAt;
      await record(
        buildEntry(request, {
          status: 'ok',
          result: describe(request, result),
          error: null,
          durationMs,
          attempts: attempt,
          // Counted, not discarded: this file's theme is "redacted *and* counted", and the store
          // write is the one scrub that happens outside the row it is reported on.
          extraRedactions: storedRedactions,
        }),
      );
      return { status: 'ok', result, attempts: attempt, durationMs };
    }
  };

  /**
   * The one door out (TD-012, BD-002).
   *
   * Everything `run` can throw — the request guards, a provider error, a failed audit write on
   * either the failure *or* the success path, a failing idempotency store, a `describeResult` that
   * throws — leaves through this `catch` and is scrubbed on the way. Nothing downstream redacts
   * any more: `apps/server` logs an unexpected error as `{ err }` and pino serialises message,
   * stack, cause chain, `AggregateError.errors` and every enumerable property.
   *
   * It stays a *separate* mechanism from the audit row's redaction in `buildEntry`, even though
   * both scrub the same provider text: two mechanisms that cannot fail independently cannot be
   * mutation-checked independently either.
   */
  const execute = async <TResult>(
    request: IntegrationActionRequest<TResult>,
  ): Promise<IntegrationActionOutcome<TResult>> => {
    try {
      return await run(request);
    } catch (error) {
      const redaction = redactErrorInPlace(options.redactor, error);
      if (redaction.blocked > 0) {
        // The error is leaving with a secret still in it because the object refused the write
        // (frozen, or a getter with no setter). Logged as a count and never as the text: silence
        // here would make the one case the scrub cannot cover indistinguishable from success.
        logger.warn(
          { ...logFieldsOf(request), redaction_blocked: redaction.blocked },
          'an error left the integration executor still carrying an injected secret',
        );
      }
      throw error;
    }
  };

  return { execute };
};
