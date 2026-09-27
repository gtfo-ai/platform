/**
 * A **held** inbound connection — the transport a provider opens *to* the platform's side and keeps
 * open, instead of calling a public URL (WP-43). Slack's Socket Mode is the one this build ships.
 *
 * It is a port rather than Slack's own type because the composition that holds it — which process,
 * when it opens, when it closes, what it says when it cannot — is provider-neutral (BD-017): a
 * second provider with the same shape (a Teams or Discord gateway) registers one and nothing in
 * `apps/server` changes.
 *
 * Every delivery a connection produces is handed to the **same** `WebhookIngress.deliver` the HTTP
 * route calls, so authenticity, deduplication and normalisation have one implementation on either
 * transport; `providers/slack/socket.ts` says how a Socket Mode envelope becomes a signed delivery.
 */
import type { Id } from '@platform/contracts';
import type { WebhookDelivery } from './common.js';

export interface InboundConnection {
  /**
   * Opens the connection. Resolves once the provider has accepted it; rejects with an
   * `IntegrationError` whose `retryable` says whether trying again later could help.
   */
  start(): Promise<void>;
  /**
   * Closes it and waits for every delivery already received to be handled. After it resolves, no
   * reconnect is scheduled and no delivery reaches the ingress (standing rules 51 and 85: a
   * resolved `stop` must mean the connection is gone, not that closing was requested).
   */
  stop(): Promise<void>;
}

/** One account whose configuration selects a held connection, ready to be opened. */
export interface HeldConnectionAccount {
  readonly kind: 'selected';
  readonly integrationId: Id;
  readonly provider: string;
  /** `integrations.name`, so a log line names what an operator named. */
  readonly name: string;
  /** {@link HeldConnectionFingerprint}. */
  readonly fingerprint: HeldConnectionFingerprint;
  /**
   * Builds the connection over this account's credentials. Opens nothing.
   *
   * @throws when the account cannot hold one at all — no app-level token, no signing secret —
   * which no retry fixes.
   */
  open(onDelivery: (delivery: WebhookDelivery) => Promise<void>): InboundConnection;
}

/**
 * An account that selects a held connection and could not even be read — a credential that will
 * not decrypt, a configuration that fails its schema. Listed rather than skipped, so the process
 * says which one by name (a binding that fails to load must not become one that is not there).
 */
export interface BrokenHeldConnectionAccount {
  readonly kind: 'broken';
  readonly integrationId: Id;
  readonly provider: string;
  readonly name: string;
  readonly detail: string;
  /** {@link HeldConnectionFingerprint} — so an operator's fix re-opens it without a restart. */
  readonly fingerprint: HeldConnectionFingerprint;
}

/**
 * A digest of what an account's connection was built from — `integrations.config` and the **ids**
 * in `integrations.secret_ids`, never a credential value (WP-73b, PROGRESS backlog 197). The
 * supervisor compares it at every re-list and re-opens an account whose fingerprint moved, so a
 * changed configuration, a re-sealed credential under a new secret id, or a broken account an
 * operator fixed is picked up without restarting the process. A value rotated **in place** under
 * the same secret id does not move it; this build has no such write (`secrets` rows are sealed at
 * the integration's creation and never updated), which is why the ids are enough.
 */
export type HeldConnectionFingerprint = string;

export interface HeldConnectionDirectory {
  /** Every account whose configuration selects a held inbound connection, in a stable order. */
  list(): Promise<readonly (HeldConnectionAccount | BrokenHeldConnectionAccount)[]>;
}

/**
 * Whether **any** process is holding an account's inbound connection now — WP-72, PROGRESS backlog
 * 200 (migration 0054).
 *
 * A binding's configuration answers "*could* a click arrive?" (`capabilities().buttons`); only a
 * process holding the socket answers "*will* it?". The holder renews a per-account row while it
 * holds the connection and the notify duty reads it before it posts buttons, so a deployment with
 * no process serving `/webhooks/*` posts text naming the task page instead of a dead control.
 *
 * Every instant is the **database's**: `renew` writes `expires_at = now() + ttl` and `isHeld`
 * compares with `now()`, so two processes whose clocks disagree cannot disagree about a holder.
 */
export interface HeldConnectionLiveness {
  /** Writes or extends the account's row: held by `holder` until `ttlMs` past the database's now. */
  renew(integrationId: Id, holder: string, ttlMs: number): Promise<void>;
  /** Deletes the row, but only while `holder` is still the one named in it. */
  release(integrationId: Id, holder: string): Promise<void>;
  /** True while some holder's last renewal has not expired. */
  isHeld(integrationId: Id): Promise<boolean>;
}
