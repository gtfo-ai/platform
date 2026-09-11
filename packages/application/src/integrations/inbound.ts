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
 * 1 which binding?   loader.forIntegration(id)     → 404 when nobody has that id
 * 2 is it authentic? inbound.verify(delivery)      → 401, audited, and NO inbox row (see below)
 * 3 which delivery?  inbound.deliveryKey(delivery) → the dedup identity, then inbox.find
 * 4 what does it mean? normalise, per bound project → events, appended with the inbox row
 * ```
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
import type { NormalisedDelivery, WebhookDelivery } from '../ports/integrations/common.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type {
  InboundAuditLog,
  InboundDeliveryStatus,
  InboundIntegrationLoader,
  InboxDelivery,
  InboxStore,
  ResolvedInboundIntegration,
} from '../ports/integrations/inbox.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

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
  | { readonly kind: 'unknown_integration' };

/** The identity mappings of one provider, pre-loaded because `resolveUser` is synchronous. */
export interface InboundIdentityDirectory {
  /** `external_id` → platform user id, for every mapped identity of this provider. */
  forProvider(provider: string): Promise<ReadonlyMap<string, Id>>;
}

export interface WebhookIngressOptions {
  readonly loader: InboundIntegrationLoader;
  readonly inbox: InboxStore;
  readonly audit: InboundAuditLog;
  readonly identities: InboundIdentityDirectory;
  readonly unitOfWork: UnitOfWork;
  /** Read side, for `nextStreamSequence`; called outside the transaction, as the audit log does. */
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
  readonly ids: { next(): Id };
  readonly clock: { now(): IsoDateTime };
  /** Milliseconds, for the audit row's duration. Only differences are meaningful. */
  readonly timer: { now(): number };
  readonly logger?: Logger;
  readonly maxSequenceAttempts?: number;
}

export interface WebhookIngress {
  deliver(input: {
    readonly provider: string;
    readonly integrationId: Id;
    readonly delivery: WebhookDelivery;
  }): Promise<InboundDeliveryOutcome>;
}

/** `{reason: detail}` lines, redacted **then** cut. `null` when the delivery produced events. */
const errorTextOf = (
  normalised: readonly NormalisedDelivery[],
  redactor: SecretRedactor,
): { text: string | null; count: number } => {
  const lines = normalised.flatMap((result) =>
    result.ignored.map((entry) => `${entry.reason}: ${entry.detail}`),
  );
  if (lines.length === 0) {
    return { text: null, count: 0 };
  }
  const redacted = redactor.redactText(lines.join('\n'));
  return { text: redacted.value.slice(0, MAX_INBOX_ERROR_CHARS), count: redacted.count };
};

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
interface ProjectEvents {
  readonly projectId: Id;
  readonly drafts: readonly {
    readonly type: DomainEvent['type'];
    readonly payload: unknown;
    readonly actor: Actor;
  }[];
}

export const createWebhookIngress = (options: WebhookIngressOptions): WebhookIngress => {
  const logger = options.logger ?? silentLogger;
  const maxAttempts = options.maxSequenceAttempts ?? DEFAULT_INBOUND_SEQUENCE_ATTEMPTS;
  if (maxAttempts < 1) {
    throw new TypeError(`maxSequenceAttempts must be at least 1, got ${maxAttempts}`);
  }

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
    deliver: async ({ provider, integrationId, delivery }) => {
      const startedAt = options.timer.now();
      const resolved = await options.loader.forIntegration(integrationId);
      if (resolved === null) {
        // Nothing to attribute the delivery to, and `integration_actions.integration_id` has a
        // foreign key: there is no row that could be written. The log line is the record.
        logger.warn(
          { integration_id: integrationId, provider },
          'webhook for an unknown integration',
        );
        return { kind: 'unknown_integration' };
      }
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

      const normalised: NormalisedDelivery[] = [];
      const byProject: ProjectEvents[] = [];
      for (const binding of resolved.bindings) {
        const result = await binding.inbound.normalise(delivery, {
          projectId: binding.projectId,
          integrationId: resolved.ref.integrationId,
          resolveUser,
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
      const failure = errorTextOf(normalised, resolved.redactor);
      const redactionCount = headers.count + payload.count + failure.count;

      const row = (at: IsoDateTime): InboxDelivery => ({
        provider,
        deliveryId,
        integrationId: resolved.ref.integrationId,
        headers: headers.value,
        payload: payload.value,
        verified: true,
        redactionCount,
        error: failure.text,
        receivedAt: at,
        processedAt: at,
      });

      for (let attempt = 1; ; attempt += 1) {
        const at = options.clock.now();
        // Read before the transaction opens, exactly as `createPostgresIntegrationAuditLog` does:
        // the `events_enforce_stream_seq` trigger takes the row lock, so a stale sequence is a
        // `StreamConflictError` and never a silently mis-ordered stream.
        const sequences = new Map<Id, number>();
        for (const group of byProject) {
          sequences.set(
            group.projectId,
            await options.eventStore.nextStreamSequence('project', group.projectId),
          );
        }

        try {
          const inserted = await options.unitOfWork.transaction(async (scope) => {
            // The insert is the arbiter of "performs nothing twice": two racing deliveries both
            // normalise, and only the one whose row lands appends.
            const isNew = await options.inbox.record(scope.tx, row(at));
            if (!isNew) {
              return false;
            }
            const events: DomainEvent[] = [];
            for (const group of byProject) {
              let seq = sequences.get(group.projectId) ?? 1;
              for (const draft of group.drafts) {
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
            if (events.length > 0) {
              await scope.events.append(events);
            }
            return true;
          });

          if (!inserted) {
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

          const eventCount = byProject.reduce((total, group) => total + group.drafts.length, 0);
          await audit(resolved, {
            status: 'accepted',
            projectId: resolved.bindings[0]?.projectId ?? null,
            payload: {
              delivery_id: deliveryId,
              events: eventCount,
              bindings: resolved.bindings.length,
            },
            error: failure.text,
            redactionCount,
            startedAt,
          });
          return {
            kind: 'accepted',
            deliveryId,
            events: eventCount,
            ignored: normalised.reduce((total, result) => total + result.ignored.length, 0),
            redactionCount,
          };
        } catch (error) {
          if (!(error instanceof StreamConflictError) || attempt >= maxAttempts) {
            throw error;
          }
          logger.warn(
            { integration_id: resolved.ref.integrationId, attempt, max_attempts: maxAttempts },
            'another writer took the project stream sequence; re-reading it and retrying the delivery',
          );
        }
      }
    },
  };
};
