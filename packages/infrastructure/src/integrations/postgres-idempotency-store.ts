/**
 * `IdempotencyStore` on PostgreSQL — "do not perform this mutation twice" across process restarts
 * (product/08 § "Idempotency", technical/06 § "Outbound: actions", WP-15b).
 *
 * Three properties of the port decide every line below.
 *
 *  1. **A miss is `undefined`; a stored JSON `null` is a value.** So the column is `jsonb not null`
 *     and the absence of the row is the only miss. Reading a SQL NULL back would make the two
 *     indistinguishable, which is the port's stated reason for not using `null` as the miss.
 *  2. **The key is composed by the port, never by an adapter.** `idempotencyStorageKey(scope)` is
 *     the single composition of `(integrationId, action, key)`, and it escapes each part so no two
 *     scopes can produce one string. The parts go in their own columns as well — for an operator
 *     reading the table, not for lookup.
 *  3. **Both halves arrive safe to store.** The value is already redacted and the key is already
 *     *proved* free of an injected secret (the executor refuses one rather than redacting it, since
 *     redaction is many-to-one and a key is an identity). This adapter writes what it is handed and
 *     adds no redaction of its own; adding one here would be the collision rule 70 names.
 *
 * `put` is `on conflict do nothing`, not `do update`. The executor only ever writes a key it has
 * just missed, so a conflict means two callers raced through the same slot — and the first result
 * is the one every later `get` must keep answering, or the "replay returns the first call's result"
 * promise would depend on who committed last. The memory fake is *stricter* and throws on the same
 * race (its divergence register records that), which is the allowed direction.
 */
import {
  type IdempotencyScope,
  type IdempotencyStore,
  idempotencyStorageKey,
} from '@platform/application';
import type { JsonValue } from '@platform/contracts';
import type { SqlExecutor } from '../events/sql.js';

export interface PostgresIdempotencyStoreOptions {
  /** A pool or a client; every statement here is a single round trip. */
  readonly sql: SqlExecutor;
}

export const createPostgresIdempotencyStore = (
  options: PostgresIdempotencyStoreOptions,
): IdempotencyStore => ({
  get: async (scope: IdempotencyScope): Promise<JsonValue | undefined> => {
    const { rows } = await options.sql.query<{ result: JsonValue }>(
      'select result from integration_idempotency where storage_key = $1',
      [idempotencyStorageKey(scope)],
    );
    const row = rows[0];
    // `row === undefined` is the miss. `row.result === null` is a remembered JSON null, and the
    // two must not collapse: `hasOwn` rather than a truthiness test, because the column is
    // `not null` and therefore the only `null` that can arrive is a legitimate value.
    return row === undefined ? undefined : row.result;
  },

  put: async (scope: IdempotencyScope, result: JsonValue): Promise<void> => {
    await options.sql.query(
      `insert into integration_idempotency (storage_key, integration_id, action, result)
         values ($1, $2, $3, $4::jsonb)
       on conflict (storage_key) do nothing`,
      [
        idempotencyStorageKey(scope),
        scope.integrationId,
        scope.action,
        // `JSON.stringify(null)` is the string `'null'`, which casts to a jsonb null rather than to
        // a SQL NULL — which is what keeps property 1 above true.
        JSON.stringify(result),
      ],
    );
  },
});
