/**
 * The held inbound connections of this process — Slack's Socket Mode, composed (WP-43, PROGRESS
 * backlog 78).
 *
 * `startRuntime` calls this once, **after** the webhook ingress is composed, and registers its
 * `stop` before anything that could fail after it — so a start-up that fails later still closes
 * every socket this opened ("either it returns a handle or it leaves nothing behind", standing
 * rules 51/54). The lifecycle and the refusals are `@platform/application`'s
 * `startInboundConnections`; which accounts, and how one is opened, is `@platform/integrations`'
 * `createHeldConnectionDirectory`. What is decided here is only the wiring, and one thing about it:
 *
 * **The process that holds a connection is the process that serves `/webhooks/*`** — it is handed
 * `ingress`, which `runtime.ts` composes exactly when `ROLE` serves the API, and a `null` ingress
 * holds nothing and names every account it is not holding. See `inbound-connections.ts` in the
 * application ring for the two-replica consequence.
 */
import type {
  HeldConnectionScheduler,
  InboundConnectionsHandle,
  Logger,
  WebhookIngress,
} from '@platform/application';
import { startInboundConnections } from '@platform/application';
import {
  redaction as redactionAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import { createHeldConnectionDirectory } from '@platform/integrations';
import type pg from 'pg';
import type { IntegrationStack } from './pipeline.js';

export interface ComposeInboundConnectionsOptions {
  readonly pool: pg.Pool;
  /** `APP_SECRET_KEY`, already validated by `config.ts`. */
  readonly secretKey: string;
  readonly stack: IntegrationStack;
  /** This process's webhook door, or `null` when `ROLE` serves no API. */
  readonly ingress: WebhookIngress | null;
  readonly role: string;
  readonly logger: Logger;
  /** Test seam: how often the account list is re-read. Production uses the module default. */
  readonly relistMs?: number;
}

/**
 * `setTimeout`, cancellable and **unref'd**: a pending re-list or retry must neither hold a
 * process open after `stop` (it is cancelled there) nor keep a test runner alive if a harness
 * forgets to stop.
 */
const processScheduler: HeldConnectionScheduler = {
  after: (ms, run) => {
    const handle = setTimeout(run, ms);
    handle.unref();
    return () => {
      clearTimeout(handle);
    };
  },
};

export const composeInboundConnections = async (
  options: ComposeInboundConnectionsOptions,
): Promise<InboundConnectionsHandle> =>
  startInboundConnections({
    directory: createHeldConnectionDirectory({
      repository: secretAdapters.createPostgresBindingRepository(options.pool),
      secrets: secretAdapters.createPostgresSecretStore({
        sql: options.pool,
        key: secretAdapters.deriveSecretKey(options.secretKey),
      }),
      registry: options.stack.registry,
      // TD-012 step 2, the same composition `composeWebhookIngress` gives the inbound loader.
      platformRedactor: redactionAdapters.patternRedactor(),
      executor: options.stack.executor,
      integrationIds: async () => secretAdapters.listIntegrationIds(options.pool),
    }),
    ingress: options.ingress,
    role: options.role,
    scheduler: processScheduler,
    logger: options.logger,
    ...(options.relistMs === undefined ? {} : { relistMs: options.relistMs }),
  });
