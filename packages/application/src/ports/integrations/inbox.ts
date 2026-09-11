/**
 * The ports the webhook ingress stands on — technical/06 § "Inbound: webhooks and polling",
 * technical/03's `inbox` table, technical/08's `POST /webhooks/:provider/:integrationId` (WP-15c).
 *
 * Three things the endpoint needs and cannot have: a way to turn `integrations.id` into the
 * provider's inbound half (that reads rows and decrypts credentials), a place to remember which
 * deliveries it has already performed, and an audit row for the ones it refused. None of them may
 * name a database or a provider library from this ring, so all three are here.
 *
 * ## Everything stored is redacted, and the count says so
 *
 * A delivery is untrusted text (BD-022) *and* it carries the platform's own credential back:
 * GitLab's legacy scheme sends the binding's webhook secret as plain text in `X-Gitlab-Token`. So
 * `headers` and `payload` reach {@link InboxStore.record} already redacted, together with the
 * summed count of what that cost — the ingress redacts, this port only stores. See migration 0014.
 *
 * ## Why the verdict is a field and not a recomputation
 *
 * Every scheme in TD-024 signs the delivery's **bytes**, and the bytes are gone once the payload is
 * stored redacted. A reader that wanted to know whether a stored delivery was authentic therefore
 * cannot find out, which is why `verified` is written rather than derived.
 */
import type { Id, IsoDateTime, JsonObject } from '@platform/contracts';
import type { Transaction } from '../transaction.js';
import type { SecretRedactor } from './audit.js';
import type { InboundNormaliser, IntegrationRef } from './common.js';

// ── The inbox ────────────────────────────────────────────────────────────────

/** One row of `inbox` as the ingress writes it (technical/03, migration 0014). */
export interface InboxDelivery {
  /** Registered provider id — `jira-cloud`, `gitlab`. Half of the primary key. */
  readonly provider: string;
  /** `InboundNormaliser.deliveryKey`, verbatim: the adapter has already redacted it. */
  readonly deliveryId: string;
  readonly integrationId: Id;
  /** Redacted (TD-012). Header names are lower-cased by the transport. */
  readonly headers: JsonObject;
  /** Redacted (TD-012). The parsed delivery body, never the raw bytes. */
  readonly payload: JsonObject;
  /** The signature verdict at the time of receipt. */
  readonly verified: boolean;
  /** Sum of the redactions the ingress made on this row: headers, payload, detail. */
  readonly redactionCount: number;
  /** Why the delivery produced no event, redacted — or `null` when it produced some. */
  readonly error: string | null;
  readonly receivedAt: IsoDateTime;
  /** When normalisation finished. Written at insert while the ingress normalises in-request. */
  readonly processedAt: IsoDateTime | null;
}

/**
 * `inbox(provider, delivery_id)` — the dedup half of technical/06's inbound rule.
 *
 * `record` is **insert-if-absent** and reports which happened, because that answer is the arbiter
 * of "performs nothing twice": two deliveries racing each other both normalise, and the one whose
 * insert lands is the one whose events are appended. A caller that asked `exists?` first and
 * inserted afterwards would have a window between the two.
 */
export interface InboxStore {
  /**
   * Insert-if-absent, **in the caller's transaction**, so the row and the events the delivery
   * produced commit together. True when this row is new.
   */
  record(tx: Transaction, delivery: InboxDelivery): Promise<boolean>;
  /** The cheap "have I seen this?" read, outside any transaction. */
  find(provider: string, deliveryId: string): Promise<InboxDelivery | null>;
}

// ── The inbound audit row ────────────────────────────────────────────────────

/**
 * What happened to one delivery, for `integration_actions` with `direction = 'in'`.
 *
 * `accepted`, `duplicate` and `refused` map onto the three statuses the table already has
 * (`ok`, `replayed`, `failed`) so that an operator reading the audit does not meet a fourth
 * vocabulary.
 */
export type InboundDeliveryStatus = 'accepted' | 'duplicate' | 'refused';

export interface InboundDeliveryRecord {
  readonly integrationId: Id;
  readonly provider: string;
  /** The project the delivery was attributed to, or `null` when it was refused or unattributed. */
  readonly projectId: Id | null;
  readonly status: InboundDeliveryStatus;
  /** Redacted, and deliberately small: identifiers and counts, never the delivery body. */
  readonly payload: JsonObject;
  /** Redacted refusal message, `null` unless `status` is `refused`. */
  readonly error: string | null;
  readonly redactionCount: number;
  readonly durationMs: number;
  readonly occurredAt: IsoDateTime;
}

/**
 * The inbound half of BD-003's audit — **a row and no event**, which is the one place it differs
 * from {@link import('./audit.js').IntegrationAuditLog}.
 *
 * `integration.action.performed` / `.failed` are about an action *the platform performed*
 * (technical/02). A delivery is something the platform was told, and — the load-bearing half — the
 * refusal path is reachable by anyone who can address the endpoint. Appending a catalogue event
 * there would let an unauthenticated caller grow the append-only event log and the dispatch queue
 * one row per request. So the inbound audit writes the `integration_actions` row, and the events
 * this delivery produced are the normalised ones or none.
 */
export interface InboundAuditLog {
  record(entry: InboundDeliveryRecord): Promise<void>;
}

// ── Resolving `integrations.id` into an adapter ──────────────────────────────

/** One project this integration is bound to, with the normaliser built for that project. */
export interface InboundBinding {
  readonly bindingId: Id;
  readonly projectId: Id;
  /** Built from `integrations.config` with this binding's `bindings.config` merged over it. */
  readonly inbound: InboundNormaliser;
}

/**
 * An integration as the ingress needs it: one adapter to answer *is this authentic and which
 * delivery is it*, and one per bound project to answer *what does it mean*.
 *
 * The split is not cosmetic. Authenticity and identity are properties of the **integration** — the
 * URL names it, the credential belongs to it, and `inbox(provider, delivery_id)` has no project
 * column — while a pick-up rule is a property of a **project's** use of it, which is exactly what
 * `bindings.config` exists to override (`ProjectBinding`'s docblock).
 */
export interface ResolvedInboundIntegration {
  readonly ref: IntegrationRef;
  /**
   * Built from `integrations.config` alone: the delivery is addressed to the account.
   *
   * `null` when this provider's port has **no** inbound half — Loki and Sentry today. Asked of the
   * built object rather than of its type, because what a new provider gets wrong is the object
   * (standing rule 7, and `delivery-key-redaction.test.ts` asks the same way). The endpoint refuses
   * such a delivery and audits it; {@link bindings} is empty whenever this is `null`.
   */
  readonly inbound: InboundNormaliser | null;
  /** Every project bound to this integration, in a stable order. May be empty. */
  readonly bindings: readonly InboundBinding[];
  /**
   * TD-012 over this delivery: the binding's own credentials plus the platform's pattern rules.
   *
   * It is the **integration's**, which is what closes the `X-Gitlab-Token` hole: the header carries
   * the very secret this redactor was built from, so an exact match finds it.
   */
  readonly redactor: SecretRedactor;
}

/**
 * Turns `integrations.id` into the objects above, or reports that it cannot.
 *
 * Absent and broken are different facts, exactly as they are for the project loader: an integration
 * id nobody has is `null` (the endpoint answers 404 and writes nothing), while an integration that
 * exists and whose adapter cannot be built **throws** — a binding that fails to load must not look
 * like a project with no integrations (standing rule 20 applies to the *mutation* direction of
 * configuration, not to the delivery).
 */
export interface InboundIntegrationLoader {
  forIntegration(integrationId: Id): Promise<ResolvedInboundIntegration | null>;
}
