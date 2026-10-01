/**
 * Reading `minted_credential_shapes` into the process's redaction rules — TD-012's M5 amendment,
 * WP-80, PROGRESS backlog 259; and since WP-107 (TD-012's M6 amendment (1), backlog 276) on the
 * commit that records a shape, in every process.
 *
 * The minting process writes a shape in the transaction of the mint's audit row
 * (`../integrations/postgres-audit-log.ts`) and, in the same transaction, publishes
 * {@link MINTED_CREDENTIAL_SHAPES_TOPIC} through the transactional broadcast — a hint delivered
 * only if the row commits. **Every** product process, whatever its `ROLE`, subscribes that topic
 * and re-reads the unexpired shapes when it arrives, compiling one step-2 rule per shape
 * (`installMintedCredentialShapes`). The timer stays: a notification is not delivered to a
 * listening connection that was reconnecting, so the hint is latency and the
 * {@link MINTED_CREDENTIAL_SHAPE_REFRESH_MS} poll is the guarantee (TD-028 decision 9's argument,
 * WP-85's heartbeat poll).
 *
 * A read at start **fails the start** when it cannot be made. A later read that fails **keeps the
 * last rules** — a transient database error must not take a process's rules away — and is logged
 * at `warn`; after {@link MINTED_CREDENTIAL_SHAPE_FAILURE_BOUND} consecutive failures the process
 * says once, at `error`, that its rules are stale, and the next success says it recovered.
 *
 * **The window, stated rather than implied.** A shape reaches another process when that process
 * receives the commit's notification — the time `NOTIFY` takes to cross the database — or, when the
 * notification was lost to a reconnecting listener, at the next timer read, at most one interval
 * later. A value quoted into text that the second process stores inside that window is covered by
 * the `glpat-` pattern rule and nothing else. The subscription is made **before** the first read,
 * so a shape committed while a process starts is either in the first read or announced after it.
 */
import type {
  Broadcast,
  BroadcastSubscription,
  Logger,
  MintedCredentialShape,
} from '@platform/application';
import {
  MINTED_CREDENTIAL_SHAPES_TOPIC,
  mintedCredentialShapeSchema,
  silentLogger,
} from '@platform/application';
import type { SqlExecutor } from '../events/sql.js';
import { installMintedCredentialShapes } from './pattern-redaction.js';

/** How often a process re-reads the shapes. Small, because the table is a handful of rows. */
export const MINTED_CREDENTIAL_SHAPE_REFRESH_MS = 5_000;

/**
 * Consecutive failed background reads after which the process reports at `error`: twelve, which is
 * one minute at the default interval — long enough that a database restart or a failover is a run
 * of warnings, short enough that a process whose rules have been stale for a minute says so at the
 * level an operator alerts on. Reported once per run of failures, never once per interval.
 */
export const MINTED_CREDENTIAL_SHAPE_FAILURE_BOUND = 12;

interface ShapeRow extends Record<string, unknown> {
  readonly prefix: string;
  readonly charset: string;
  readonly length: number;
}

/**
 * The distinct unexpired shapes. `now()` is the database's, as every freshness comparison on the
 * platform's own tables is. A row that fails the schema — which the table's checks make
 * unreachable — is dropped here and counted by the caller's install.
 */
export const readMintedCredentialShapes = async (
  sql: SqlExecutor,
): Promise<readonly MintedCredentialShape[]> => {
  const { rows } = await sql.query<ShapeRow>(
    `select distinct prefix, charset, length
       from minted_credential_shapes
      where expires_at > now()
      order by prefix, charset, length`,
  );
  const shapes: MintedCredentialShape[] = [];
  for (const row of rows) {
    const parsed = mintedCredentialShapeSchema.safeParse({
      prefix: row.prefix,
      charset: row.charset,
      length: Number(row.length),
    });
    if (parsed.success) {
      shapes.push(parsed.data);
    }
  }
  return shapes;
};

/** What a refresher has done, for the per-`ROLE` census and the tests — counters, never rules. */
export interface MintedCredentialShapeRefreshStatus {
  /** True from the moment the shape topic is subscribed until `stop`. */
  readonly subscribed: boolean;
  /** Background reads that a commit's notification started. */
  readonly notifiedReads: number;
  /** Background reads that the timer started. */
  readonly timedReads: number;
  /** Failed background reads since the last success. */
  readonly consecutiveFailures: number;
}

export interface MintedCredentialShapeRefresh {
  /** Reads and installs now; resolves to how many rules the process holds after it. */
  refresh(): Promise<number>;
  status(): MintedCredentialShapeRefreshStatus;
  /** Closes the subscription and the timer. The broadcast itself is its owner's to close. */
  stop(): Promise<void>;
}

/**
 * Subscribes the shape topic, loads the shapes once — **throwing** if it cannot, so a process never
 * starts serving with fewer rules than the database says it needs — then re-reads them on every
 * notification and on an unref'd interval until stopped.
 *
 * `broadcast` is required (standing rule 31): a refresher without it is the five-second window
 * TD-012's M6 amendment closed.
 */
export const startMintedCredentialShapeRefresh = async (options: {
  readonly sql: SqlExecutor;
  readonly broadcast: Pick<Broadcast, 'subscribe'>;
  readonly logger?: Logger;
  readonly intervalMs?: number;
  readonly failureBound?: number;
}): Promise<MintedCredentialShapeRefresh> => {
  const logger = options.logger ?? silentLogger;
  const failureBound = options.failureBound ?? MINTED_CREDENTIAL_SHAPE_FAILURE_BOUND;
  let subscribed = false;
  let notifiedReads = 0;
  let timedReads = 0;
  let consecutiveFailures = 0;

  const refresh = async (): Promise<number> => {
    const shapes = await readMintedCredentialShapes(options.sql);
    const { installed, refused } = installMintedCredentialShapes(shapes);
    if (refused > 0) {
      logger.error(
        { installed, refused },
        'a minted-credential shape could not be compiled into a redaction rule and was skipped; a run credential of that shape is redacted in this process only by the exact-value step of the process that minted it (PROGRESS backlog 259)',
      );
    }
    return installed;
  };

  const background = async (trigger: 'notification' | 'timer'): Promise<void> => {
    if (trigger === 'notification') {
      notifiedReads += 1;
    } else {
      timedReads += 1;
    }
    try {
      await refresh();
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures === failureBound) {
        logger.error(
          { err: error, consecutive_failures: consecutiveFailures, trigger },
          'the minted-credential shape refresh has failed repeatedly; this process keeps the rules it last read, so a run credential minted since then under a prefix no other rule knows is stored unredacted here until a read succeeds (TD-012, PROGRESS backlog 276)',
        );
      } else {
        // Below the bound a failure is a warning each time; past it the one `error` line above has
        // said it, and repeating it every interval would bury it, so the rest go to `debug`.
        const fields = { err: error, consecutive_failures: consecutiveFailures, trigger };
        const message =
          'the minted-credential shape refresh failed; this process keeps the rules it had (PROGRESS backlog 259)';
        if (consecutiveFailures < failureBound) {
          logger.warn(fields, message);
        } else {
          logger.debug(fields, message);
        }
      }
      return;
    }
    if (consecutiveFailures >= failureBound) {
      logger.info(
        { failed_reads: consecutiveFailures },
        'the minted-credential shape refresh succeeded again after repeated failures; this process holds the current rules',
      );
    }
    consecutiveFailures = 0;
  };

  /**
   * One read at a time. A notification that arrives during a read asks for one more read after it,
   * never a queue of them: the read is of the whole table, so any later read answers every earlier
   * request.
   */
  let inFlight: Promise<void> | null = null;
  let again: 'notification' | 'timer' | null = null;
  const schedule = (trigger: 'notification' | 'timer'): Promise<void> => {
    if (inFlight !== null) {
      again ??= trigger;
      return inFlight;
    }
    inFlight = (async () => {
      let next: 'notification' | 'timer' | null = trigger;
      while (next !== null) {
        again = null;
        await background(next);
        next = again;
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  // Subscribed before the first read: a shape committed between the two is then either in the read
  // or announced after it, never in neither.
  const subscription: BroadcastSubscription = await options.broadcast.subscribe(
    [MINTED_CREDENTIAL_SHAPES_TOPIC],
    () => {
      void schedule('notification');
    },
  );
  subscribed = true;
  let installed: number;
  try {
    installed = await refresh();
  } catch (error) {
    subscribed = false;
    await subscription.close();
    throw error;
  }
  logger.info(
    { rules: installed },
    'minted-credential shape rules loaded: a run credential minted by any process is redacted by its shape in this one, re-read on every recorded shape and on a timer (TD-012, WP-80, WP-107)',
  );
  const timer = setInterval(() => {
    void schedule('timer');
  }, options.intervalMs ?? MINTED_CREDENTIAL_SHAPE_REFRESH_MS);
  timer.unref();
  return {
    refresh,
    status: () => ({ subscribed, notifiedReads, timedReads, consecutiveFailures }),
    stop: async () => {
      clearInterval(timer);
      subscribed = false;
      await subscription.close();
      await inFlight;
    },
  };
};
