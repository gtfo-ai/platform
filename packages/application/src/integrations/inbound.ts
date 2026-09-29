/**
 * The webhook ingress — technical/06 § "Inbound: webhooks and polling", technical/08's
 * `POST /webhooks/:provider/:integrationId`, technical/03's `inbox` (WP-15c).
 *
 * Until this file existed **nothing in production emitted a domain event**: twenty-eight work
 * packages built a pipeline that walks a ticket from `ticket.matched` to `task.completed`, and the
 * only thing that ever produced the first event was a test harness. This is the door.
 *
 * ## The four questions, in order, and what each one may cost
 *
 * ```
 * 1 which binding?   loader.open(id)               → 404 when nobody has that id
 *   over its bucket? (HTTP door only, WP-87, Q60)  → 429, no credential read, nothing written
 *                    door.resolve()                → credentials decrypted, adapters built
 * 2 is it authentic? inbound.verify(delivery)      → 401, audited, and NO inbox row (see below)
 * 3 which delivery?  inbound.deliveryKey(delivery) → the dedup identity, then inbox.find
 * 4 what does it mean? normalise, per bound project → events, appended with the inbox row
 * ```
 *
 * Since WP-43 step 4 has one exception, and it is the one that matters most: a **human decision**
 * (`task.approval.decided`, `task.question.answered`) is not appended as the normaliser wrote it.
 * It is handed to the Approval or Question aggregate through `InboundDecisionApplier`, in the same
 * transaction as the inbox row, so `can()` decides whether this person may decide it and a refusal
 * is written on the row (`inbound-decisions.ts` has the argument). The same method is called by
 * the HTTP route and by the held Socket Mode connection (`inbound-connections.ts`), so both
 * transports go through all four questions.
 *
 * ## Why an unverified delivery leaves no row
 *
 * `inbox(provider, delivery_id)` is a **dedup** key: a row means "already performed, never again".
 * Writing one for an unverified delivery would hand anyone who can address the endpoint two things
 * — unbounded growth of an append-only-ish table, and, far worse, the ability to **poison a key**:
 * plant the id a genuine future delivery will carry, and the genuine one is silently taken for a
 * redelivery and dropped. So the refusal is recorded in the audit (`integration_actions`,
 * `direction = 'in'`, one row, no event) and nowhere else. `InboxStore`'s docblock and
 * migration 0014 carry the other half — what the row does store, and why the verdict is a field.
 *
 * ## Why this normalises in the request instead of enqueuing a job
 *
 * technical/06 says the endpoint "enqueues normalisation as a job … all work is asynchronous", and
 * this deviates. The document is amended beside the sentence; the reason is that the asynchronous
 * shape has **the defect backlog entry 20 is about, in its unrecoverable form**: the inbox row is
 * written, the enqueue is not in that transaction (TD-004: `Jobs.enqueue` does not join one), and a
 * crash between the two leaves a delivery that is *recorded as performed* and never performed —
 * which a redelivery cannot fix, because the row it would be deduplicated against is the one the
 * crash left behind. Normalising first and writing the row **in the same transaction as the events
 * it produced** removes the window: either both are committed or the sender retries.
 *
 * The cost is stated rather than hidden. The response now waits for normalisation, which is pure
 * for Jira and at most one discussions read for a GitLab *note* delivery, so the 2xx is still
 * inside any vendor's delivery timeout. The shape to adopt if a provider's `normalise` ever grows
 * expensive is not the job — it is the sweep `inbox_unprocessed_idx` already exists for, where the
 * row *is* the queue and nothing is lost when the wake-up is.
 *
 * ## Everything written here is redacted first
 *
 * A delivery carries the platform's own credential back: GitLab's legacy scheme sends the binding's
 * webhook secret as plain text in `X-Gitlab-Token`. Redaction happens **after** `verify` (which
 * needs the bytes as they were signed) and **after** the key (which the adapter redacts itself),
 * and the summed count goes on the row — see migration 0014.
 */
import type {
  Actor,
  DomainEvent,
  ExternalIdentity,
  Id,
  IsoDateTime,
  JsonObject,
} from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { StreamConflictError } from '../errors.js';
import type { EventStore } from '../ports/event-store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type {
  InboundThreadHandle,
  InboundThreadMatch,
  NormalisedDelivery,
  WebhookDelivery,
} from '../ports/integrations/common.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type {
  InboundAuditLog,
  InboundDeliveryStatus,
  InboundIntegrationLoader,
  InboxDelivery,
  InboxReasonCode,
  InboxStore,
  ResolvedInboundIntegration,
} from '../ports/integrations/inbox.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  type InboundDecisionApplier,
  type InboundDecisionRefusal,
  isInboundDecisionType,
} from './inbound-decisions.js';
import { createRateLimiter, type RateLimiter, type RateLimitPolicy } from './rate-limiter.js';

/**
 * How long an `inbox.error` may be. Redaction happens **before** the cut, never after: an
 * exact-match redactor cannot find a secret a cap has already halved (`IgnoredDelivery.detail`).
 */
export const MAX_INBOX_ERROR_CHARS = 2_000;

/** Retries of a `stream_seq` that another writer took first — the audit log's bound, and why. */
export const DEFAULT_INBOUND_SEQUENCE_ATTEMPTS = 4;

/** Why a delivery performed nothing. Each one is audited; none of them writes an inbox row. */
export type InboundRefusal =
  /** `verify` said no — a forged, replayed or unsigned delivery, or a binding with no secret. */
  | 'unverified'
  /** The URL's provider is not the provider of the integration it names. */
  | 'provider_mismatch'
  /** The provider has no inbound half at all — an observability binding, say. */
  | 'unsupported_provider'
  /** The body is not JSON, so there is nothing to store in a `jsonb` column and nothing to read. */
  | 'malformed_body'
  /** `deliveryKey` refused: the delivery carries nothing to deduplicate on. */
  | 'unkeyable';

export type InboundDeliveryOutcome =
  | {
      readonly kind: 'accepted';
      readonly deliveryId: string;
      readonly events: number;
      readonly ignored: number;
      readonly redactionCount: number;
    }
  | { readonly kind: 'duplicate'; readonly deliveryId: string }
  | { readonly kind: 'refused'; readonly reason: InboundRefusal; readonly detail: string }
  /**
   * Over this integration's webhook bucket (WP-87, Q60): nothing was verified, stored or audited,
   * and the sender is told when to come back. Only an `http` delivery can be limited.
   */
  | { readonly kind: 'rate_limited'; readonly retryAfterMs: number }
  | { readonly kind: 'unknown_integration' };

/**
 * Which door a delivery came through (WP-87). Only the **HTTP** door is rate-limited: it is the
 * platform's one unauthenticated endpoint, where anybody who knows an integration's id can knock. A
 * held connection's envelope arrives over a socket the platform opened to an allow-listed host, and
 * limiting it would drop a provider's notification the platform already acknowledged (rule 20).
 */
export type InboundTransport = 'http' | 'held_connection';

/**
 * The webhook door's token bucket, **per `integrations.id`** (WP-87, Q60's recommendation).
 *
 * Generous on purpose: a vendor that keeps receiving errors disables its webhook (rule 20), so the
 * bucket must admit a real burst — a bulk edit of a hundred tickets is a hundred deliveries in a few
 * seconds — and refuse only what no sender legitimately produces. `maxConcurrent` is not used: the
 * door takes a token without waiting for one (`RateLimiter.tryAcquire`).
 */
export const DEFAULT_WEBHOOK_RATE_LIMIT_POLICY: RateLimitPolicy = {
  capacity: 120,
  refillPerSecond: 10,
  maxConcurrent: 1,
};

export interface WebhookRateLimit {
  readonly policy: RateLimitPolicy;
  /** Told once per limited delivery — the composition root's counter (Q60: a metric, not a row). */
  readonly onLimited: (limited: { readonly provider: string; readonly integrationId: Id }) => void;
}

/** The identity mappings of one provider, pre-loaded because `resolveUser` is synchronous. */
export interface InboundIdentityDirectory {
  /** `external_id` → platform user id, for every mapped identity of this provider. */
  forProvider(provider: string): Promise<ReadonlyMap<string, Id>>;
}

/**
 * The longest channel or thread handle the ingress will look up (WP-88). Slack's are about a dozen
 * and seventeen characters; the bound is the `chat_threads` column's own check (migration 0062), so
 * a longer handle is one no row can hold and is answered `null` without a query.
 */
export const MAX_THREAD_HANDLE_CHARS = 255;

/**
 * Which task a provider thread belongs to, from the platform's own rows (WP-88, PROGRESS backlog
 * 195) — the durable half of `InboundContext.resolveThread`.
 *
 * Read **outside** every transaction, like {@link InboundIdentityDirectory}: normalisation happens
 * before the delivery's transaction opens, and what it answers is re-checked by the aggregate
 * inside it. Scoped by the binding (project **and** account), so a delivery normalised for one
 * project cannot resolve another project's thread in a channel both happen to use.
 */
export interface InboundThreadDirectory {
  find(input: {
    readonly projectId: Id;
    readonly integrationId: Id;
    readonly channel: string;
    readonly threadId: string;
  }): Promise<InboundThreadMatch | null>;
}

export interface WebhookIngressOptions {
  readonly loader: InboundIntegrationLoader;
  readonly inbox: InboxStore;
  readonly audit: InboundAuditLog;
  readonly identities: InboundIdentityDirectory;
  /** WP-88: the thread ↔ task map a chat reply is resolved through. Required (rule 31). */
  readonly threads: InboundThreadDirectory;
  /**
   * Where a **human decision** goes instead of the project stream (WP-43).
   *
   * Required rather than optional (standing rule 31): the alternative to it is the raw append this
   * option exists to replace, which moved a task without deciding its approval and without asking
   * `can()`. `inbound-decisions.ts` carries the argument.
   */
  readonly decisions: InboundDecisionApplier;
  readonly unitOfWork: UnitOfWork;
  /** Read side, for `nextStreamSequence`; called outside the transaction, as the audit log does. */
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
  readonly ids: { next(): Id };
  readonly clock: { now(): IsoDateTime };
  /** Milliseconds, for the audit row's duration. Only differences are meaningful. */
  readonly timer: { now(): number };
  readonly logger?: Logger;
  readonly maxSequenceAttempts?: number;
  /**
   * The HTTP door's bucket (WP-87, Q60), or `null` for none. **Required** rather than optional
   * (standing rule 31): a composition that forgot it would be the unlimited door Q60 is about, and
   * `null` makes that a choice somebody wrote down.
   */
  readonly rateLimit: WebhookRateLimit | null;
}

export interface WebhookIngress {
  deliver(input: {
    readonly provider: string;
    readonly integrationId: Id;
    readonly delivery: WebhookDelivery;
    /** Required, so a new caller decides whether it is the rate-limited door (WP-87). */
    readonly transport: InboundTransport;
  }): Promise<InboundDeliveryOutcome>;
}

/**
 * How often one integration's limiting is logged: once per window, with the count, because a line
 * per refused request during a flood is the amplification the limit exists to close.
 */
export const WEBHOOK_RATE_LIMIT_LOG_WINDOW_MS = 60_000;

/**
 * The distinct reason codes behind the row's `error`, sorted (WP-73b, PROGRESS backlog 206) — what
 * the refused-deliveries read filters on, so it need not parse the redacted, cut sentence.
 */
export const errorReasonsOf = (
  normalised: readonly NormalisedDelivery[],
  refusals: readonly { readonly reason: unknown }[] = [],
): InboxReasonCode[] =>
  [
    ...new Set<InboxReasonCode>([
      ...normalised.flatMap((result) => result.ignored.map((entry) => entry.reason)),
      ...(refusals.length > 0 ? (['decision_refused'] as const) : []),
    ]),
  ].toSorted();

/** `{reason: detail}` lines, redacted **then** cut. `null` when the delivery produced events. */
const errorTextOf = (
  normalised: readonly NormalisedDelivery[],
  redactor: SecretRedactor,
  refusals: readonly DecisionRefusalLine[] = [],
): { text: string | null; count: number } => {
  const lines = [
    ...normalised.flatMap((result) =>
      result.ignored.map((entry) => `${entry.reason}: ${entry.detail}`),
    ),
    // A decision the aggregate refused (WP-43): named like an ignored entry, and on the same row.
    ...refusals.map((entry) => `decision_refused: ${entry.reason}: ${entry.detail}`),
  ];
  if (lines.length === 0) {
    return { text: null, count: 0 };
  }
  const redacted = redactor.redactText(lines.join('\n'));
  return { text: redacted.value.slice(0, MAX_INBOX_ERROR_CHARS), count: redacted.count };
};

/**
 * The accounts a delivery was refused for as `unmapped_identity`, redacted and de-duplicated (WP-44,
 * PROGRESS backlog 198). An id the binding's redactor would change is **left out** rather than
 * stored as a placeholder: a placeholder is not an account anybody can map.
 */
export const unmappedIdentitiesOf = (
  normalised: readonly NormalisedDelivery[],
  redactor: SecretRedactor,
): { provider: string; external_id: string }[] => {
  const seen = new Map<string, { provider: string; external_id: string }>();
  for (const result of normalised) {
    for (const entry of result.ignored) {
      const identity = entry.identity;
      if (entry.reason !== 'unmapped_identity' || identity === undefined) {
        continue;
      }
      if (redactor.redactText(identity.external_id).value !== identity.external_id) {
        continue;
      }
      seen.set(`${identity.provider}\0${identity.external_id}`, {
        provider: identity.provider,
        external_id: identity.external_id,
      });
    }
  }
  return [...seen.values()];
};

/** One refused human decision, as the inbox row names it. */
interface DecisionRefusalLine {
  readonly reason: InboundDecisionRefusal;
  readonly detail: string;
}

/** Thrown inside the transaction to roll a lost race back: the other delivery's row landed. */
class DuplicateDeliveryRollback extends Error {
  override readonly name = 'DuplicateDeliveryRollback';
}

/**
 * The envelope the ingress puts around a `NormalisedEvent`.
 *
 * A normaliser stops at `{type, payload, actor}` on purpose — it cannot know where in a stream its
 * event lands — so somebody has to supply the rest, and here that somebody is the endpoint. The
 * stream is the **project**, not the integration: every event a delivery produces is about one
 * project's work, the pipeline's ordering is per project, and choosing the integration would
 * serialise two projects that share a Jira site behind each other.
 *
 * Parsed with the catalogue schema before it reaches `append`, so a draft the `events` table would
 * reject fails here rather than as a constraint violation three frames away.
 */
const envelope = (
  event: { readonly type: DomainEvent['type']; readonly payload: unknown; readonly actor: Actor },
  input: {
    readonly id: Id;
    readonly projectId: Id;
    readonly streamSeq: number;
    readonly at: string;
  },
): DomainEvent =>
  domainEventSchemasByType[event.type].parse({
    id: input.id,
    stream_type: 'project',
    stream_id: input.projectId,
    stream_seq: input.streamSeq,
    correlation_id: null,
    cause_event_id: null,
    actor: event.actor,
    occurred_at: input.at,
    type: event.type,
    payload: event.payload,
  }) as DomainEvent;

/** Events grouped by the project stream they belong to, in the order the bindings produced them. */
export interface InboundProjectEvents {
  readonly projectId: Id;
  readonly drafts: readonly {
    readonly type: DomainEvent['type'];
    readonly payload: unknown;
    readonly actor: Actor;
  }[];
}

/** What {@link recordNormalisedDelivery} writes with: the half of the ingress that touches the database. */
export interface InboundRecorderOptions {
  readonly inbox: InboxStore;
  readonly decisions: InboundDecisionApplier;
  readonly unitOfWork: UnitOfWork;
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
  readonly ids: { next(): Id };
  readonly clock: { now(): IsoDateTime };
  readonly logger?: Logger;
  readonly maxSequenceAttempts?: number;
}

/**
 * One normalised delivery, ready to be recorded: the dedup identity, what the row stores (already
 * redacted, with the counts), and the events per project stream.
 */
export interface NormalisedDeliveryRecord {
  readonly provider: string;
  /** Already redacted by whoever built it (`InboundNormaliser.deliveryKey`, or the poller's key). */
  readonly deliveryId: string;
  readonly integrationId: Id;
  readonly redactor: SecretRedactor;
  readonly headers: { readonly value: JsonObject; readonly count: number };
  readonly payload: { readonly value: JsonObject; readonly count: number };
  readonly normalised: readonly NormalisedDelivery[];
  readonly byProject: readonly InboundProjectEvents[];
}

export type NormalisedDeliveryRecordOutcome =
  | {
      readonly kind: 'recorded';
      readonly events: number;
      readonly refused: number;
      readonly failure: { readonly text: string | null; readonly count: number };
    }
  | { readonly kind: 'duplicate' };

/**
 * Writes the `inbox` row **and** the events it produced in one transaction — the arbiter of
 * "performs nothing twice" (WP-15c) — and is the one place that does, whichever door the delivery
 * came through: the webhook route, a held connection, or the ticket poller (WP-87), which records a
 * polled match through here on the **same** `inbox(provider, delivery_id)` key so that the two
 * doors share one dedup table and one redaction rule.
 *
 * A lost race is `duplicate` (the other writer's row landed, and the rollback took this attempt's
 * decision writes with it); a stale stream sequence is retried up to `maxSequenceAttempts`.
 */
export const recordNormalisedDelivery = async (
  options: InboundRecorderOptions,
  record: NormalisedDeliveryRecord,
): Promise<NormalisedDeliveryRecordOutcome> => {
  const logger = options.logger ?? silentLogger;
  const maxAttempts = options.maxSequenceAttempts ?? DEFAULT_INBOUND_SEQUENCE_ATTEMPTS;
  const row = (
    at: IsoDateTime,
    failure: { readonly text: string | null; readonly count: number },
    refusals: readonly DecisionRefusalLine[],
  ): InboxDelivery => ({
    provider: record.provider,
    deliveryId: record.deliveryId,
    integrationId: record.integrationId,
    headers: record.headers.value,
    payload: record.payload.value,
    verified: true,
    redactionCount: record.headers.count + record.payload.count + failure.count,
    error: failure.text,
    unmappedIdentities: unmappedIdentitiesOf(record.normalised, record.redactor),
    errorReasons: errorReasonsOf(record.normalised, refusals),
    receivedAt: at,
    processedAt: at,
  });

  for (let attempt = 1; ; attempt += 1) {
    const at = options.clock.now();
    // Read before the transaction opens, exactly as `createPostgresIntegrationAuditLog` does:
    // the `events_enforce_stream_seq` trigger takes the row lock, so a stale sequence is a
    // `StreamConflictError` and never a silently mis-ordered stream.
    const sequences = new Map<Id, number>();
    for (const group of record.byProject) {
      sequences.set(
        group.projectId,
        await options.eventStore.nextStreamSequence('project', group.projectId),
      );
    }

    try {
      return await options.unitOfWork.transaction(async (scope) => {
        const events: DomainEvent[] = [];
        const refusals: DecisionRefusalLine[] = [];
        for (const group of record.byProject) {
          let seq = sequences.get(group.projectId) ?? 1;
          for (const draft of group.drafts) {
            /**
             * A human decision is the aggregate's to make (WP-43, `inbound-decisions.ts`): it
             * lands on the approval's or the question's own stream, decided by `can()`, or it
             * is refused onto this row. It never reaches the project stream as provider text.
             */
            if (isInboundDecisionType(draft.type)) {
              const outcome = await options.decisions.apply(scope.tx, {
                projectId: group.projectId,
                draft: { type: draft.type, payload: draft.payload, actor: draft.actor },
                // Which door, for the decision's `human_actions` row (WP-88, backlog 199). The
                // delivery id is already redacted by whoever built it.
                delivery: {
                  provider: record.provider,
                  integrationId: record.integrationId,
                  deliveryId: record.deliveryId,
                },
              });
              if (outcome.kind === 'applied') {
                events.push(...outcome.events);
              } else {
                refusals.push({ reason: outcome.reason, detail: outcome.detail });
              }
              continue;
            }
            events.push(
              envelope(draft, {
                id: options.ids.next(),
                projectId: group.projectId,
                streamSeq: seq,
                at,
              }),
            );
            seq += 1;
          }
        }
        const failure = errorTextOf(record.normalised, record.redactor, refusals);
        // The insert is the arbiter of "performs nothing twice": two racing deliveries both
        // normalise, and only the one whose row lands appends. It comes **after** the
        // decisions because the row carries their refusals; a lost race throws, and the
        // rollback takes the decision writes with it.
        const isNew = await options.inbox.record(scope.tx, row(at, failure, refusals));
        if (!isNew) {
          throw new DuplicateDeliveryRollback();
        }
        if (events.length > 0) {
          await scope.events.append(events);
        }
        return {
          kind: 'recorded' as const,
          failure,
          events: events.length,
          refused: refusals.length,
        };
      });
    } catch (error) {
      if (error instanceof DuplicateDeliveryRollback) {
        return { kind: 'duplicate' };
      }
      if (!(error instanceof StreamConflictError) || attempt >= maxAttempts) {
        throw error;
      }
      logger.warn(
        { integration_id: record.integrationId, attempt, max_attempts: maxAttempts },
        'another writer took the project stream sequence; re-reading it and retrying the delivery',
      );
    }
  }
};

/** The per-integration buckets of the HTTP door, created on first use (WP-87, Q60). */
interface WebhookBuckets {
  /** `null` when the delivery may proceed; the wait the sender is told otherwise. */
  admit(integrationId: Id): number | null;
}

const webhookBuckets = (policy: RateLimitPolicy, timer: { now(): number }): WebhookBuckets => {
  // Keyed per `integrations.id` **after** the lookup found one, so the map is bounded by the rows an
  // operator configured and never by the ids a caller can invent (Q60: "per account, not global").
  const buckets = new Map<Id, RateLimiter>();
  const limiterTimer = {
    now: () => timer.now(),
    // `tryAcquire` never waits; a limiter asked to is a programming error, said loudly.
    sleep: async (): Promise<void> => {
      throw new Error('the webhook rate limiter never waits for a token');
    },
  };
  return {
    admit: (integrationId) => {
      let bucket = buckets.get(integrationId);
      if (bucket === undefined) {
        bucket = createRateLimiter(policy, limiterTimer);
        buckets.set(integrationId, bucket);
      }
      const taken = bucket.tryAcquire();
      return taken.ok ? null : taken.retryAfterMs;
    },
  };
};

export const createWebhookIngress = (options: WebhookIngressOptions): WebhookIngress => {
  const logger = options.logger ?? silentLogger;
  const maxAttempts = options.maxSequenceAttempts ?? DEFAULT_INBOUND_SEQUENCE_ATTEMPTS;
  if (maxAttempts < 1) {
    throw new TypeError(`maxSequenceAttempts must be at least 1, got ${maxAttempts}`);
  }
  const buckets =
    options.rateLimit === null ? null : webhookBuckets(options.rateLimit.policy, options.timer);
  /** Per integration: when the last "limited" line was written, and how many since. */
  const limitedLog = new Map<Id, { loggedAt: number; suppressed: number }>();

  const noteLimited = (provider: string, integrationId: Id, retryAfterMs: number): void => {
    options.rateLimit?.onLimited({ provider, integrationId });
    const now = options.timer.now();
    const previous = limitedLog.get(integrationId);
    if (previous !== undefined && now - previous.loggedAt < WEBHOOK_RATE_LIMIT_LOG_WINDOW_MS) {
      previous.suppressed += 1;
      return;
    }
    logger.warn(
      {
        integration_id: integrationId,
        provider,
        retry_after_ms: retryAfterMs,
        limited_since_last_line: previous?.suppressed ?? 0,
      },
      'webhook deliveries for this integration are over its rate limit and are answered 429 without being verified or stored (Q60)',
    );
    limitedLog.set(integrationId, { loggedAt: now, suppressed: 0 });
  };

  const audit = async (
    resolved: ResolvedInboundIntegration,
    entry: {
      readonly status: InboundDeliveryStatus;
      readonly projectId: Id | null;
      readonly payload: JsonObject;
      readonly error: string | null;
      readonly redactionCount: number;
      readonly startedAt: number;
    },
  ): Promise<void> => {
    await options.audit.record({
      integrationId: resolved.ref.integrationId,
      provider: resolved.ref.provider,
      projectId: entry.projectId,
      status: entry.status,
      payload: entry.payload,
      error: entry.error,
      redactionCount: entry.redactionCount,
      durationMs: Math.max(0, options.timer.now() - entry.startedAt),
      occurredAt: options.clock.now(),
    });
  };

  const refuse = async (
    resolved: ResolvedInboundIntegration,
    reason: InboundRefusal,
    detail: string,
    startedAt: number,
  ): Promise<InboundDeliveryOutcome> => {
    /**
     * **Two branches carry text this module did not write**, so the detail is redacted and counted
     * rather than asserted constant (review round 1: the sentence that used to be here claimed the
     * opposite, and a wrong sentence is what the next refusal branch would be written against —
     * standing rules 44 and 63).
     *
     *  - `unkeyable` forwards the adapter's `IntegrationError.message`, and GitLab and Slack
     *    interpolate provider text into theirs (`gitlab/webhook-verify.ts`'s `object_kind`,
     *    `slack/signature.ts`'s `type`), each cut to 32 characters **after** their own redaction;
     *  - `provider_mismatch` interpolates the URL's own provider segment.
     *
     * No leak is demonstrated for either — the adapter redacts its half, and the segment is the
     * caller's own string, now bounded by `webhookParamsSchema` to the registry's slug shape — and
     * that is precisely why this is a pass rather than an argument: the count stops being a claim
     * about *which* branches ran. Redacted **before** the cut, because an exact-match redactor
     * cannot find a secret a cap has already halved.
     */
    const redacted = resolved.redactor.redactText(detail);
    await audit(resolved, {
      status: 'refused',
      projectId: null,
      payload: { reason },
      error: redacted.value.slice(0, MAX_INBOX_ERROR_CHARS),
      redactionCount: redacted.count,
      startedAt,
    });
    logger.warn(
      { integration_id: resolved.ref.integrationId, provider: resolved.ref.provider, reason },
      'a webhook delivery was refused',
    );
    return { kind: 'refused', reason, detail: redacted.value };
  };

  return {
    deliver: async ({ provider, integrationId, delivery, transport }) => {
      const startedAt = options.timer.now();
      const door = await options.loader.open(integrationId);
      if (door === null) {
        // Nothing to attribute the delivery to, and `integration_actions.integration_id` has a
        // foreign key: there is no row that could be written. The log line is the record.
        logger.warn(
          { integration_id: integrationId, provider },
          'webhook for an unknown integration',
        );
        return { kind: 'unknown_integration' };
      }

      /**
       * The bucket (WP-87, Q60) — **after** the account row is read, so it is per account and the
       * map is bounded by configured rows, and **before** everything that costs more: reading and
       * decrypting the credentials and building the adapters (`door.resolve()`, review round 1),
       * the signature check, every audit row and every write. What a limited delivery still costs is
       * that one read — `integrations` left-joined to its `bindings`, by primary key — stated. It
       * leaves no `inbox` row (the answer an unverified one gets, so a flood cannot poison a key
       * either) and no `integration_actions` row (one row per refusal would re-open the
       * amplification the limit closes); it is counted and logged.
       */
      if (buckets !== null && transport === 'http') {
        const retryAfterMs = buckets.admit(door.integrationId);
        if (retryAfterMs !== null) {
          noteLimited(door.provider, door.integrationId, retryAfterMs);
          return { kind: 'rate_limited', retryAfterMs };
        }
      }

      const resolved = await door.resolve();
      if (resolved.ref.provider !== provider) {
        return refuse(
          resolved,
          'provider_mismatch',
          `the URL names provider "${provider}" and this integration is a "${resolved.ref.provider}" one`,
          startedAt,
        );
      }

      const inbound = resolved.inbound;
      if (inbound === null) {
        return refuse(
          resolved,
          'unsupported_provider',
          `provider "${resolved.ref.provider}" has no inbound half in this build, so it can receive no webhook`,
          startedAt,
        );
      }

      // 2 — authenticity, over the bytes exactly as they arrived. Nothing is redacted before this.
      if (!inbound.verify(delivery)) {
        return refuse(
          resolved,
          'unverified',
          'the delivery signature did not verify against this integration’s configured secret',
          startedAt,
        );
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(delivery.body) as unknown;
      } catch {
        // A constant message: `JSON.parse`'s own `SyntaxError` quotes the input it choked on, and a
        // fragment of a delivery is what no exact-match redactor can find afterwards.
        return refuse(resolved, 'malformed_body', 'the delivery body is not JSON', startedAt);
      }
      if (parsedBody === null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
        return refuse(
          resolved,
          'malformed_body',
          'the delivery body is not a JSON object',
          startedAt,
        );
      }

      // 3 — identity. The adapter redacts this string itself (`InboundNormaliser.deliveryKey`).
      let deliveryId: string;
      try {
        deliveryId = inbound.deliveryKey(delivery);
      } catch (error) {
        // Rule 20, and the reason it is not a 4xx at the route: both shipped providers refuse here
        // exactly for the kinds their normaliser would ignore anyway (a wiki hook, a release hook),
        // and answering a vendor with an error would eventually have it disable the whole webhook.
        const detail =
          error instanceof IntegrationError
            ? error.message
            : 'the delivery carries nothing to deduplicate on';
        return refuse(resolved, 'unkeyable', detail, startedAt);
      }

      const seen = await options.inbox.find(provider, deliveryId);
      if (seen !== null) {
        await audit(resolved, {
          status: 'duplicate',
          projectId: null,
          payload: { delivery_id: deliveryId },
          error: null,
          redactionCount: 0,
          startedAt,
        });
        return { kind: 'duplicate', deliveryId };
      }

      // 4 — meaning, once per bound project, outside every transaction.
      const directory = await options.identities.forProvider(provider);
      const resolveUser = (identity: ExternalIdentity): Id | null =>
        directory.get(identity.external_id) ?? null;

      const resolveThreadFor =
        (projectId: Id) =>
        async (thread: InboundThreadHandle): Promise<InboundThreadMatch | null> =>
          thread.channel.length === 0 ||
          thread.threadId.length === 0 ||
          thread.channel.length > MAX_THREAD_HANDLE_CHARS ||
          thread.threadId.length > MAX_THREAD_HANDLE_CHARS
            ? null
            : options.threads.find({
                projectId,
                integrationId: resolved.ref.integrationId,
                channel: thread.channel,
                threadId: thread.threadId,
              });

      const normalised: NormalisedDelivery[] = [];
      const byProject: InboundProjectEvents[] = [];
      for (const binding of resolved.bindings) {
        const result = await binding.inbound.normalise(delivery, {
          projectId: binding.projectId,
          integrationId: resolved.ref.integrationId,
          resolveUser,
          resolveThread: resolveThreadFor(binding.projectId),
        });
        normalised.push(result);
        if (result.events.length > 0) {
          byProject.push({ projectId: binding.projectId, drafts: result.events });
        }
      }
      if (resolved.bindings.length === 0) {
        // Not a refusal: the delivery is authentic and the platform simply has no project for it.
        // Recorded on the row rather than dropped, because "nobody is bound" is a configuration
        // fact an operator needs to see next to the delivery that found it.
        normalised.push({
          events: [],
          ignored: [
            {
              reason: 'not_for_this_project',
              detail: 'no project is bound to this integration, so the delivery was not normalised',
            },
          ],
        });
      }

      const headers = resolved.redactor.redactJson(delivery.headers as JsonObject);
      const payload = resolved.redactor.redactJson(parsedBody as JsonObject);

      const recorded = await recordNormalisedDelivery(
        {
          inbox: options.inbox,
          decisions: options.decisions,
          unitOfWork: options.unitOfWork,
          eventStore: options.eventStore,
          ids: options.ids,
          clock: options.clock,
          logger,
          maxSequenceAttempts: maxAttempts,
        },
        {
          provider,
          deliveryId,
          integrationId: resolved.ref.integrationId,
          redactor: resolved.redactor,
          headers,
          payload,
          normalised,
          byProject,
        },
      );
      if (recorded.kind === 'duplicate') {
        await audit(resolved, {
          status: 'duplicate',
          projectId: null,
          payload: { delivery_id: deliveryId },
          error: null,
          redactionCount: 0,
          startedAt,
        });
        return { kind: 'duplicate', deliveryId };
      }

      const redactionCount = headers.count + payload.count + recorded.failure.count;
      await audit(resolved, {
        status: 'accepted',
        projectId: resolved.bindings[0]?.projectId ?? null,
        payload: {
          delivery_id: deliveryId,
          events: recorded.events,
          bindings: resolved.bindings.length,
        },
        error: recorded.failure.text,
        redactionCount,
        startedAt,
      });
      return {
        kind: 'accepted',
        deliveryId,
        events: recorded.events,
        ignored:
          normalised.reduce((total, result) => total + result.ignored.length, 0) + recorded.refused,
        redactionCount,
      };
    },
  };
};
