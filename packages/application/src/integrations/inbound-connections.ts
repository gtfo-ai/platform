/**
 * Holding the inbound connections a process owns — open at composition, closed at shutdown, and
 * loud when it cannot (WP-43, PROGRESS backlog 78).
 *
 * The shipped Slack manifest selects Socket Mode, and until this module no process opened a socket:
 * every button click and every thread reply reached no door, on every instance, silently. The
 * envelope parser, the signature, the normaliser and the ingress were all built; what was missing
 * was a **composition, a lifecycle and a `ROLE` decision**, and this is the first two.
 *
 * ## Which process holds the connection (the `ROLE` decision)
 *
 * **The process that serves `/webhooks/*`** — `ROLE=api` or `ROLE=all` — and it is decided by
 * construction rather than by a flag: the caller hands this module the process's
 * `WebhookIngress`, which `runtime.ts` composes exactly when the process serves the API, and a
 * process with no ingress opens nothing. A held connection *is* an inbound door; putting it
 * anywhere else would make "which container receives Slack" differ from "which container receives
 * GitLab" for no reason an operator could guess (TD-028's topology; the amendment text is in
 * PROGRESS under WP-43).
 *
 * **Two `api` replicas hold two connections, and that is correct.** Slack keeps up to ten per app
 * and "each payload may be sent to *any* of the connections"
 * (<https://docs.slack.dev/apis/events-api/using-socket-mode>, retrieved 2026-09-26), so a click
 * reaches exactly one replica — and a **redelivered** envelope (unacked, or a retry) may reach the
 * other. The backstop is the one every transport already has: `inbox (provider, delivery_id)` is
 * unique and Slack's dedup key is built from the payload (`slackDeliveryKey`), not from the
 * connection, so the second copy is `duplicate` and performs nothing. An eleventh replica is
 * refused by Slack; its start fails, is retried, and says so by name.
 *
 * ## Refusals are named, never swallowed (criterion 4)
 *
 * Every account that selects a held connection is named in the log when this process will not hold
 * it — because it serves no `/webhooks/*`, because the account cannot hold one (no app-level
 * token), because its configuration cannot be read, or because the provider refused the connection
 * in a way no retry fixes. A failure a retry can fix (the provider unreachable at boot) is retried
 * on a bounded backoff, so a network blip at start-up does not cost the process its chat for the
 * rest of its life.
 *
 * ## The directory is re-read, so an integration created later is held without a restart
 *
 * The onboarding wizard creates a Slack integration on a running instance, and a list read once at
 * start-up would make that integration the silent absence this module exists to end. So the list
 * is read again every `relistMs`: an account that appeared is opened, one that disappeared or
 * stopped selecting a held connection is closed. What it does **not** notice is a *changed*
 * credential on an account it already holds — a rotated app-level token needs a restart, stated in
 * the setup guide rather than implied here.
 */
import type { Id } from '@platform/contracts';
import { IntegrationError } from '../ports/integrations/common.js';
import type {
  BrokenHeldConnectionAccount,
  HeldConnectionAccount,
  HeldConnectionDirectory,
  InboundConnection,
} from '../ports/integrations/inbound-connection.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { WebhookIngress } from './inbound.js';

/** Re-read the account list this often. */
export const DEFAULT_HELD_CONNECTION_RELIST_MS = 60_000;
/** First retry of a start that failed in a way a retry can fix; doubled per attempt. */
export const DEFAULT_HELD_CONNECTION_RETRY_BASE_MS = 5_000;
export const DEFAULT_HELD_CONNECTION_RETRY_MAX_MS = 300_000;

/** A timer that can be cancelled, because shutdown must not wait for a five-minute backoff. */
export interface HeldConnectionScheduler {
  after(ms: number, run: () => void): () => void;
}

/**
 * Where one account's connection is. Not a boolean (standing rule 56): "not open yet" and "will
 * never open" are different facts, and only one of them is somebody's to fix.
 */
export type HeldConnectionState =
  /** `start` is in flight. */
  | 'opening'
  /**
   * `start` resolved: the provider issued the connection and it was opened. A provider's own
   * greeting (Slack's `hello`) and a later drop are the connection's to handle — it reconnects on
   * its own backoff — so this is "held", not "healthy this second".
   */
  | 'open'
  /** `start` failed in a way a retry can fix; the next attempt is scheduled. */
  | 'retrying'
  /** It cannot be held by this build as configured; named in the log, not retried. */
  | 'refused';

export interface HeldConnectionStatus {
  readonly integrationId: Id;
  readonly provider: string;
  readonly name: string;
  readonly state: HeldConnectionState;
}

export interface InboundConnectionsOptions {
  readonly directory: HeldConnectionDirectory;
  /**
   * The process's webhook door, or `null` for a process that serves no `/webhooks/*` — which then
   * holds nothing and names every account it is not holding.
   */
  readonly ingress: WebhookIngress | null;
  /** `ROLE`, for the sentence that tells an operator where the connection lives instead. */
  readonly role: string;
  readonly scheduler: HeldConnectionScheduler;
  readonly logger?: Logger;
  readonly relistMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
}

export interface InboundConnectionsHandle {
  /** Every account this process knows selects a held connection, with where it is. */
  status(): readonly HeldConnectionStatus[];
  /** Reads the directory again now, as the interval does. For tests and for the first pass. */
  relist(): Promise<void>;
  /** Stops re-reading, cancels every scheduled retry and closes every connection it opened. */
  stop(): Promise<void>;
}

interface Held {
  readonly account: HeldConnectionAccount | BrokenHeldConnectionAccount;
  state: HeldConnectionState;
  connection: InboundConnection | null;
  attempt: number;
  cancelRetry: (() => void) | null;
  /** The start in flight, so `stop` waits for it rather than closing under it. */
  starting: Promise<void> | null;
}

const accountFields = (account: {
  readonly integrationId: Id;
  provider: string;
  name: string;
}) => ({
  integration_id: account.integrationId,
  provider: account.provider,
  integration: account.name,
});

/** Whether a failed `start` is worth trying again. A plain `Error` is a transport's, so yes. */
const isRetryable = (error: unknown): boolean =>
  error instanceof IntegrationError ? error.retryable : true;

export const startInboundConnections = async (
  options: InboundConnectionsOptions,
): Promise<InboundConnectionsHandle> => {
  const logger = options.logger ?? silentLogger;
  const relistMs = options.relistMs ?? DEFAULT_HELD_CONNECTION_RELIST_MS;
  const baseMs = options.retryBaseMs ?? DEFAULT_HELD_CONNECTION_RETRY_BASE_MS;
  const maxMs = options.retryMaxMs ?? DEFAULT_HELD_CONNECTION_RETRY_MAX_MS;
  const held = new Map<Id, Held>();
  /** Accounts already named as "not held by this process", so a relist does not repeat them. */
  const named = new Set<Id>();
  let stopping = false;
  let cancelRelist: (() => void) | null = null;
  let relisting: Promise<void> | null = null;

  const deliveryHandler =
    (ingress: WebhookIngress, account: HeldConnectionAccount) =>
    async (delivery: Parameters<WebhookIngress['deliver']>[0]['delivery']): Promise<void> => {
      // A throw here is "not acknowledged", so the provider redelivers: the ingress only throws
      // for what it could not record (a database fault). Every refusal is an outcome, and the
      // envelope is acknowledged — a forged or malformed one must not be redelivered for ever.
      const outcome = await ingress.deliver({
        provider: account.provider,
        integrationId: account.integrationId,
        delivery,
      });
      logger.info(
        {
          ...accountFields(account),
          transport: 'held_connection',
          outcome: outcome.kind,
          ...(outcome.kind === 'refused' ? { reason: outcome.reason } : {}),
          ...(outcome.kind === 'accepted'
            ? { events: outcome.events, ignored: outcome.ignored }
            : {}),
        },
        'held-connection delivery handled',
      );
    };

  const attemptStart = (entry: Held): void => {
    const connection = entry.connection;
    if (connection === null || stopping) {
      return;
    }
    entry.state = 'opening';
    entry.starting = connection
      .start()
      .then(() => {
        entry.state = 'open';
        entry.attempt = 0;
        logger.info(
          { ...accountFields(entry.account) },
          'held inbound connection open: provider deliveries reach this process',
        );
      })
      .catch((error: unknown) => {
        if (stopping) {
          return;
        }
        if (!isRetryable(error)) {
          entry.state = 'refused';
          logger.error(
            { ...accountFields(entry.account), err: error },
            'the provider refused the held inbound connection and no retry can fix it: no click or reply from this integration reaches the platform until its credentials or its egress are corrected and the process restarts',
          );
          return;
        }
        entry.state = 'retrying';
        const delayMs = Math.min(maxMs, baseMs * 2 ** entry.attempt);
        entry.attempt += 1;
        logger.warn(
          { ...accountFields(entry.account), err: error, retry_in_ms: delayMs },
          'the held inbound connection could not be opened; retrying',
        );
        entry.cancelRetry = options.scheduler.after(delayMs, () => {
          entry.cancelRetry = null;
          attemptStart(entry);
        });
      })
      .finally(() => {
        entry.starting = null;
      });
  };

  const close = async (entry: Held): Promise<void> => {
    entry.cancelRetry?.();
    entry.cancelRetry = null;
    await entry.starting;
    await entry.connection?.stop();
  };

  const open = (
    ingress: WebhookIngress,
    account: HeldConnectionAccount | BrokenHeldConnectionAccount,
  ): void => {
    const entry: Held = {
      account,
      state: 'refused',
      connection: null,
      attempt: 0,
      cancelRetry: null,
      starting: null,
    };
    held.set(account.integrationId, entry);
    if (account.kind === 'broken') {
      logger.error(
        { ...accountFields(account), detail: account.detail },
        'an integration configured for a held inbound connection cannot be read, so this process holds none for it: no click or reply from it reaches the platform',
      );
      return;
    }
    try {
      entry.connection = account.open(deliveryHandler(ingress, account));
    } catch (error) {
      logger.error(
        { ...accountFields(account), err: error },
        'an integration configured for a held inbound connection cannot hold one as configured, so no click or reply from it reaches the platform',
      );
      return;
    }
    attemptStart(entry);
  };

  const relist = async (): Promise<void> => {
    const accounts = await options.directory.list();
    const ingress = options.ingress;
    if (ingress === null) {
      /**
       * Criterion 4: a binding configured for a held connection in a process that opens none says
       * so **by name**, the way `startRuntime` names the runner piece it lacks. On a split
       * deployment this is expected on every worker, and it is still worth one line per account:
       * it is the sentence an operator reads when no replica serves the API.
       */
      for (const account of accounts) {
        if (named.has(account.integrationId)) {
          continue;
        }
        named.add(account.integrationId);
        logger.warn(
          { ...accountFields(account), role: options.role },
          `this integration is configured for a held inbound connection (Slack Socket Mode) and ROLE=${options.role} serves no /webhooks/*, so this process opens none: the connection is held by the process that serves the API (ROLE=api or ROLE=all), and with none running no click or reply reaches the platform`,
        );
      }
      return;
    }
    const listed = new Set(accounts.map((account) => account.integrationId));
    for (const [integrationId, entry] of held) {
      if (!listed.has(integrationId)) {
        held.delete(integrationId);
        logger.info(
          { ...accountFields(entry.account) },
          'an integration no longer selects a held inbound connection; closing it',
        );
        await close(entry);
      }
    }
    for (const account of accounts) {
      if (!held.has(account.integrationId) && !stopping) {
        open(ingress, account);
      }
    }
  };

  const scheduleRelist = (): void => {
    if (stopping) {
      return;
    }
    cancelRelist = options.scheduler.after(relistMs, () => {
      cancelRelist = null;
      relisting = relist()
        .catch((error: unknown) => {
          // Rule 20's direction: a failed re-read keeps what is open and tries again next time.
          logger.warn({ err: error }, 'the held inbound connections could not be re-listed');
        })
        .finally(() => {
          relisting = null;
          scheduleRelist();
        });
    });
  };

  await relist();
  scheduleRelist();

  return {
    status: () =>
      [...held.values()].map((entry) => ({
        integrationId: entry.account.integrationId,
        provider: entry.account.provider,
        name: entry.account.name,
        state: entry.state,
      })),
    relist,
    stop: async () => {
      stopping = true;
      cancelRelist?.();
      cancelRelist = null;
      await relisting;
      const entries = [...held.values()];
      held.clear();
      for (const entry of entries) {
        await close(entry);
      }
    },
  };
};
