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
}

export interface HeldConnectionDirectory {
  /** Every account whose configuration selects a held inbound connection, in a stable order. */
  list(): Promise<readonly (HeldConnectionAccount | BrokenHeldConnectionAccount)[]>;
}
