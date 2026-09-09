/**
 * `UnitOfWork` on a `pg.Pool`: one connection, one `BEGIN … COMMIT`, one `TransactionScope`.
 *
 * The scope is what makes TD-005's transactional outbox real — the events, the dispatch queue row
 * and the `handler_executions` row a caller writes all run on the same connection, so they commit
 * together. `tx` carries that connection so later work packages' repositories can join in without
 * `application` ever naming `pg`.
 */
import type { Transaction, TransactionScope, UnitOfWork } from '@platform/application';
import { ForeignTransactionError } from '@platform/application';
import type pg from 'pg';
import {
  DEFAULT_BROADCAST_CHANNEL,
  transactionalBroadcast,
} from '../broadcast/postgres-broadcast.js';
import {
  PostgresDispatchQueue,
  PostgresEventAppender,
  PostgresHandlerExecutions,
} from './postgres-event-store.js';
import type { SqlExecutor } from './sql.js';

export const POSTGRES_ADAPTER = 'postgres';

/** The opaque handle of `@platform/application`, with the connection an adapter needs back. */
export interface PostgresTransaction extends Transaction {
  readonly adapter: typeof POSTGRES_ADAPTER;
  readonly client: SqlExecutor;
}

/** Narrows a handle back to this adapter, refusing one another adapter created. */
export const postgresTransaction = (tx: Transaction): PostgresTransaction => {
  if (tx.adapter !== POSTGRES_ADAPTER) {
    throw new ForeignTransactionError(POSTGRES_ADAPTER, tx.adapter);
  }
  return tx as PostgresTransaction;
};

export interface PostgresUnitOfWorkOptions {
  readonly pool: pg.Pool;
  /** `NOTIFY` channel the transactional broadcast publishes on. */
  readonly broadcastChannel?: string;
}

export class PostgresUnitOfWork implements UnitOfWork {
  readonly #pool: pg.Pool;
  readonly #channel: string;

  constructor(options: PostgresUnitOfWorkOptions) {
    this.#pool = options.pool;
    this.#channel = options.broadcastChannel ?? DEFAULT_BROADCAST_CHANNEL;
  }

  async transaction<T>(fn: (scope: TransactionScope) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    // A connection whose ROLLBACK or COMMIT failed may still be inside a transaction. Handing it
    // back to the pool would leak that state into the next borrower, so it is destroyed instead.
    let broken = false;
    try {
      await client.query('begin');
      let result: T;
      try {
        result = await fn(this.#scopeFor(client));
      } catch (error) {
        // The original error is what the caller needs; a failing rollback only decides the fate of
        // the connection.
        await client.query('rollback').catch(() => {
          broken = true;
        });
        throw error;
      }
      try {
        await client.query('commit');
      } catch (error) {
        broken = true;
        throw error;
      }
      return result;
    } finally {
      client.release(broken);
    }
  }

  #scopeFor(client: pg.PoolClient): TransactionScope {
    const sql = client as unknown as SqlExecutor;
    const broadcast = transactionalBroadcast(sql, this.#channel);
    const tx: PostgresTransaction = { adapter: POSTGRES_ADAPTER, client: sql };
    return {
      tx,
      events: new PostgresEventAppender(sql, broadcast),
      dispatchQueue: new PostgresDispatchQueue(sql),
      handlerExecutions: new PostgresHandlerExecutions(sql),
      broadcast,
    };
  }
}
