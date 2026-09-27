/**
 * The command idempotency record — `command_idempotency` (migration 0053, WP-67, PROGRESS backlog
 * 47). The migration's header carries the table's argument; this module is its three statements.
 *
 * - {@link claimCommandAttempt} — the claim a command takes **before** it performs. A committed
 *   row is what a second request under the same key meets, so two requests that arrive together no
 *   longer both read "no attempt": the second one's insert finds the first one's row.
 * - {@link completeCommandAttempt} — the mark that the command performed, written by the same
 *   statement set as its `human_actions` row (`insertHumanAction` calls it), so "the key performed
 *   this command" and "the audit says so" cannot disagree.
 * - {@link releaseCommandAttempt} — gives the key back when the request ended without performing
 *   (a refusal, a 404, an `already_started`). It deletes only an **uncompleted** row, so calling it
 *   after the command completed is a no-op, which is what lets a route call it unconditionally.
 *
 * Scope `(user_id, action, idempotency_key)`, the table's primary key — `routes/idempotency.ts`
 * carries the argument for it.
 */
import type { JsonObject } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';

const { commandIdempotency, humanActions } = dbAdapters.schema;

export interface AttemptQuery {
  readonly userId: string;
  readonly action: string;
  readonly key: string;
}

/** What a request under a key meets. */
export type CommandAttemptClaim =
  /** Nobody used this key for this command: this request holds it now and must perform or release. */
  | { readonly status: 'claimed' }
  /** A request under this key performed the command; `params` is what its audit row recorded. */
  | {
      readonly status: 'performed';
      readonly bodyDigest: string | null;
      readonly params: JsonObject;
    }
  /** A request under this key claimed it and has not completed — still running, or it died. */
  | {
      readonly status: 'in_flight';
      readonly bodyDigest: string | null;
      readonly claimedAt: string;
    };

const whereKey = (query: AttemptQuery) =>
  and(
    eq(commandIdempotency.userId, query.userId),
    eq(commandIdempotency.action, query.action),
    eq(commandIdempotency.idempotencyKey, query.key),
  );

/** The recorded state of a key, or `null` when nobody used it. */
export const findCommandAttempt = async (
  database: Database,
  query: AttemptQuery,
): Promise<Exclude<CommandAttemptClaim, { status: 'claimed' }> | null> => {
  const rows = await database
    .select({
      bodyDigest: commandIdempotency.bodyDigest,
      claimedAt: commandIdempotency.claimedAt,
      completedAt: commandIdempotency.completedAt,
      params: humanActions.params,
    })
    .from(commandIdempotency)
    .leftJoin(humanActions, eq(humanActions.id, commandIdempotency.humanActionId))
    .where(whereKey(query))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  if (row.completedAt === null) {
    return { status: 'in_flight', bodyDigest: row.bodyDigest, claimedAt: toIso(row.claimedAt) };
  }
  // A completed key whose audit row went with its task (`on delete set null`) is still performed;
  // it answers with nothing recorded, and a route that needs a field refuses rather than invents.
  return { status: 'performed', bodyDigest: row.bodyDigest, params: row.params ?? {} };
};

/**
 * Claims the key for this request, or answers what already holds it.
 *
 * `insert … on conflict do nothing` rather than a read and then an insert, for the reason
 * `createProject` gives: the primary key decides, and the read afterwards turns the loser into an
 * answer. It runs in **its own** statement, committed before the command starts — that is the
 * ordering WP-67 chose (`routes/idempotency.ts`, "The write ordering"), and it is the whole
 * difference from the lookup it replaces.
 *
 * The loop is bounded at two: a claim released between this request's insert and its read leaves
 * nothing to read, and the second insert then takes it. A third miss would mean a key claimed and
 * released twice inside one request's two statements, which is a request storm rather than a race,
 * and is refused by name rather than looped on.
 */
export const claimCommandAttempt = async (
  database: Database,
  query: AttemptQuery & { readonly digest: string },
): Promise<CommandAttemptClaim> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inserted = await database
      .insert(commandIdempotency)
      .values({
        userId: query.userId,
        action: query.action,
        idempotencyKey: query.key,
        bodyDigest: query.digest,
      })
      .onConflictDoNothing()
      .returning({ claimedAt: commandIdempotency.claimedAt });
    if (inserted[0] !== undefined) {
      return { status: 'claimed' };
    }
    const existing = await findCommandAttempt(database, query);
    if (existing !== null) {
      return existing;
    }
  }
  throw new Error(
    `the Idempotency-Key for ${query.action} was claimed and released twice while this request read it`,
  );
};

/** Gives an uncompleted claim back; a completed one is left exactly as it is. */
export const releaseCommandAttempt = async (
  database: Database,
  query: AttemptQuery,
): Promise<void> => {
  await database
    .delete(commandIdempotency)
    .where(and(whereKey(query), isNull(commandIdempotency.completedAt)));
};

/**
 * Marks the key performed and names the audit row — **on the executor the audit row was written
 * with**, so inside a command's transaction the two commit together.
 *
 * An upsert rather than an update: a keyed `human_actions` row written by a path that took no
 * claim (the wizard's two creates, which are idempotent on their natural key instead, and any
 * writer this build has not met) still lands in the record, so the table stays a complete index of
 * the keys the audit holds. A row that is **already** completed is left alone — the first attempt
 * is the one a replay answers with (criterion (1)).
 */
export const completeCommandAttempt = async (
  executor: Pick<Database, 'insert'>,
  input: AttemptQuery & { readonly digest: string | null; readonly humanActionId: string },
): Promise<void> => {
  await executor
    .insert(commandIdempotency)
    .values({
      userId: input.userId,
      action: input.action,
      idempotencyKey: input.key,
      bodyDigest: input.digest,
      completedAt: sql`now()`,
      humanActionId: input.humanActionId,
    })
    .onConflictDoUpdate({
      target: [
        commandIdempotency.userId,
        commandIdempotency.action,
        commandIdempotency.idempotencyKey,
      ],
      set: {
        // `greatest`: the claim was taken on another connection, whose `now()` may be later than
        // this transaction's by a clock tick — the check constraint wants completed ≥ claimed.
        completedAt: sql`greatest(now(), ${commandIdempotency.claimedAt})`,
        humanActionId: input.humanActionId,
      },
      setWhere: isNull(commandIdempotency.completedAt),
    });
};

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * The claims nobody completed that are older than `before`, counted by `action` — the
 * `command_idempotency_claims_unknown` gauge's reading (WP-73, PROGRESS backlog 241).
 *
 * A claim past `CLAIM_IN_FLIGHT_MS` is the residue of a process that died between the claim and the
 * audit row: its key answers `409 idempotency_attempt_unknown` for good, because nothing can tell
 * whether the command ran. Counted by `action` only — never by key or user, because a key is caller
 * text and a user label would put who-did-what into a metrics scrape.
 */
export const countStaleCommandClaims = async (
  database: Database,
  before: Date,
): Promise<readonly { readonly action: string; readonly claims: number }[]> => {
  const rows = await database
    .select({ action: commandIdempotency.action, claims: sql<string>`count(*)` })
    .from(commandIdempotency)
    .where(and(isNull(commandIdempotency.completedAt), lt(commandIdempotency.claimedAt, before)))
    .groupBy(commandIdempotency.action);
  return rows.map((row) => ({ action: row.action, claims: Number(row.claims) }));
};
