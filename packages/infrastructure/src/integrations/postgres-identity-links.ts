/**
 * `IdentityLinkStore` on PostgreSQL — migration 0105's `identity_link_codes` and
 * `identity_link_matches`, and the one `user_identities` insert a person's confirmation makes
 * (S-26.6, TD-031's 2026-11-06 amendment item 9).
 *
 * Every deciding method runs on the **caller's** transaction (`postgresTransaction(tx).client`): an
 * inbound delivery records its matches beside its `inbox` row, and a confirmation re-checks and
 * links in one. Two locks make the decisions safe under READ COMMITTED:
 *
 *  - `lockUser` is a transaction-scoped advisory lock keyed by the user, so two issues of one user
 *    count the hour and void the open code one after the other;
 *  - `lockCode`/`lockCodeByHash` are `for update`, so a second author's delivery waits for the
 *    first's commit and then reads its match (each statement re-reads after the lock).
 *
 * `linkIdentity` **never overwrites**: `insert … on conflict do nothing`, then the row that exists
 * is read and answered — a person, the same user (`already_linked`), another user
 * (`linked_elsewhere`) or a machine. The admin mapping (`POST /api/org/identities`) is the upsert
 * that may move an account; a self-service link can only claim one nobody holds.
 */
import type {
  IdentityLinkStore,
  IdentityLinkWrite,
  LinkCodeState,
  LinkCodeVoidReason,
  StoredLinkCode,
  StoredLinkMatch,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

interface CodeRow extends Record<string, unknown> {
  readonly id: string;
  readonly user_id: string;
  readonly code_hash: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly consumed_match_id: string | null;
  readonly voided_at: Date | null;
  readonly void_reason: LinkCodeVoidReason | null;
}

interface MatchRow extends Record<string, unknown> {
  readonly id: string;
  readonly code_id: string;
  readonly integration_id: string;
  readonly provider: string;
  readonly external_id: string;
  readonly display_name: string | null;
  readonly comment_id: string;
  readonly created_at: Date;
  readonly confirmed_at: Date | null;
}

const iso = (value: Date): IsoDateTime => value.toISOString() as IsoDateTime;
const isoOrNull = (value: Date | null): IsoDateTime | null => (value === null ? null : iso(value));

const CODE_COLUMNS = `id, user_id, code_hash, created_at, expires_at, consumed_at, consumed_match_id,
  voided_at, void_reason`;
const MATCH_COLUMNS = `id, code_id, integration_id, provider, external_id, display_name, comment_id,
  created_at, confirmed_at`;

const toCode = (row: CodeRow): StoredLinkCode => ({
  id: row.id as Id,
  userId: row.user_id as Id,
  codeHash: row.code_hash,
  createdAt: iso(row.created_at),
  expiresAt: iso(row.expires_at),
  consumedAt: isoOrNull(row.consumed_at),
  consumedMatchId: (row.consumed_match_id ?? null) as Id | null,
  voidedAt: isoOrNull(row.voided_at),
  voidReason: row.void_reason,
});

const toMatch = (row: MatchRow): StoredLinkMatch => ({
  id: row.id as Id,
  codeId: row.code_id as Id,
  integrationId: row.integration_id as Id,
  provider: row.provider,
  externalId: row.external_id,
  displayName: row.display_name,
  commentId: row.comment_id,
  createdAt: iso(row.created_at),
  confirmedAt: isoOrNull(row.confirmed_at),
});

const clientOf = (tx: Transaction) => postgresTransaction(tx).client;

export const createPostgresIdentityLinkStore = (options: {
  readonly sql: SqlExecutor;
}): IdentityLinkStore => ({
  lockUser: async (tx, userId) => {
    await clientOf(tx).query(
      "select pg_advisory_xact_lock(hashtextextended('identity_link_codes:' || $1, 0))",
      [userId],
    );
  },

  countIssuedSince: async (tx, userId, since) => {
    const { rows } = await clientOf(tx).query<{ count: string; oldest: Date | null }>(
      `select count(*) as count, min(created_at) as oldest
         from identity_link_codes
        where user_id = $1 and created_at >= $2`,
      [userId, since],
    );
    const row = rows[0];
    return { count: Number(row?.count ?? 0), oldest: isoOrNull(row?.oldest ?? null) };
  },

  voidOpen: async (tx, userId, at, reason) => {
    const result = await clientOf(tx).query(
      `update identity_link_codes set voided_at = $2, void_reason = $3
        where user_id = $1 and consumed_at is null and voided_at is null`,
      [userId, at, reason],
    );
    return result.rowCount ?? 0;
  },

  insertCode: async (tx, code) => {
    await clientOf(tx).query(
      `insert into identity_link_codes (id, user_id, code_hash, created_at, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [code.id, code.userId, code.codeHash, code.createdAt, code.expiresAt],
    );
  },

  lockCodeByHash: async (tx, codeHash) => {
    const { rows } = await clientOf(tx).query<CodeRow>(
      `select ${CODE_COLUMNS} from identity_link_codes where code_hash = $1 for update`,
      [codeHash],
    );
    const row = rows[0];
    return row === undefined ? null : toCode(row);
  },

  lockCode: async (tx, codeId) => {
    const { rows } = await clientOf(tx).query<CodeRow>(
      `select ${CODE_COLUMNS} from identity_link_codes where id = $1 for update`,
      [codeId],
    );
    const row = rows[0];
    return row === undefined ? null : toCode(row);
  },

  voidCode: async (tx, codeId, at, reason) => {
    await clientOf(tx).query(
      `update identity_link_codes set voided_at = $2, void_reason = $3
        where id = $1 and consumed_at is null and voided_at is null`,
      [codeId, at, reason],
    );
  },

  consume: async (tx, codeId, matchId, at) => {
    const client = clientOf(tx);
    await client.query(
      `update identity_link_codes set consumed_at = $3, consumed_match_id = $2
        where id = $1 and consumed_at is null and voided_at is null`,
      [codeId, matchId, at],
    );
    await client.query(
      `update identity_link_matches set confirmed_at = $2 where id = $1 and outcome = 'match'`,
      [matchId, at],
    );
  },

  matchesOf: async (tx, codeId) => {
    const { rows } = await clientOf(tx).query<MatchRow>(
      `select ${MATCH_COLUMNS} from identity_link_matches
        where code_id = $1 and outcome = 'match' order by created_at, id`,
      [codeId],
    );
    return rows.map(toMatch);
  },

  findMatch: async (tx, matchId) => {
    const { rows } = await clientOf(tx).query<MatchRow>(
      `select ${MATCH_COLUMNS} from identity_link_matches where id = $1 and outcome = 'match'`,
      [matchId],
    );
    const row = rows[0];
    return row === undefined ? null : toMatch(row);
  },

  insertMatch: async (tx, match) => {
    const result = await clientOf(tx).query(
      `insert into identity_link_matches
         (id, outcome, code_id, integration_id, provider, external_id, display_name, comment_id,
          created_at)
       values ($1, 'match', $2, $3, $4, $5, $6, $7, $8)
       on conflict (code_id, provider, external_id) where outcome = 'match' do nothing`,
      [
        match.id,
        match.codeId,
        match.integrationId,
        match.provider,
        match.externalId,
        match.displayName,
        match.commentId,
        match.createdAt,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  },

  insertMiss: async (tx, entry) => {
    const result = await clientOf(tx).query(
      `insert into identity_link_matches
         (id, outcome, code_id, integration_id, provider, external_id, display_name, comment_id,
          created_at)
       values ($1, 'miss', null, $2, $3, $4, $5, $6, $7)
       on conflict (provider, external_id, comment_id) where outcome = 'miss' do nothing`,
      [
        entry.id,
        entry.integrationId,
        entry.provider,
        entry.externalId,
        entry.displayName,
        entry.commentId,
        entry.at,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  },

  insertIgnored: async (tx, entry) => {
    await clientOf(tx).query(
      `insert into identity_link_matches
         (id, outcome, code_id, integration_id, provider, external_id, display_name, comment_id,
          created_at)
       values ($1, 'ignored', null, $2, $3, $4, $5, $6, $7)`,
      [
        entry.id,
        entry.integrationId,
        entry.provider,
        entry.externalId,
        entry.displayName,
        entry.commentId,
        entry.at,
      ],
    );
  },

  countMissesSince: async (tx, author, since) => {
    const { rows } = await clientOf(tx).query<{ count: string }>(
      `select count(*) as count from identity_link_matches
        where provider = $1 and external_id = $2 and outcome = 'miss' and created_at >= $3`,
      [author.provider, author.externalId, since],
    );
    return Number(rows[0]?.count ?? 0);
  },

  ignoredSince: async (tx, author, since) => {
    const { rows } = await clientOf(tx).query(
      `select 1 from identity_link_matches
        where provider = $1 and external_id = $2 and outcome = 'ignored' and created_at >= $3
        limit 1`,
      [author.provider, author.externalId, since],
    );
    return rows.length > 0;
  },

  identityOf: async (tx, author) => {
    const { rows } = await clientOf(tx).query<{
      kind: 'person' | 'machine';
      user_id: string | null;
    }>('select kind, user_id from user_identities where provider = $1 and external_id = $2', [
      author.provider,
      author.externalId,
    ]);
    const row = rows[0];
    return row === undefined
      ? null
      : { kind: row.kind, userId: (row.user_id ?? null) as Id | null };
  },

  isBindingAccount: async (tx, author) => {
    const { rows } = await clientOf(tx).query(
      `select 1 from bindings
        where account_identity ->> 'provider' = $1 and account_identity ->> 'external_id' = $2
        limit 1`,
      [author.provider, author.externalId],
    );
    return rows.length > 0;
  },

  linkIdentity: async (tx, input): Promise<IdentityLinkWrite> => {
    const client = clientOf(tx);
    const inserted = await client.query(
      `insert into user_identities (provider, external_id, user_id, kind, display_name)
       values ($1, $2, $3, 'person', $4)
       on conflict (provider, external_id) do nothing`,
      [input.provider, input.externalId, input.userId, input.displayName],
    );
    if ((inserted.rowCount ?? 0) > 0) {
      return 'linked';
    }
    const { rows } = await client.query<{ kind: 'person' | 'machine'; user_id: string | null }>(
      'select kind, user_id from user_identities where provider = $1 and external_id = $2',
      [input.provider, input.externalId],
    );
    const row = rows[0];
    if (row === undefined || row.kind === 'machine') {
      return 'machine';
    }
    return row.user_id === input.userId ? 'already_linked' : 'linked_elsewhere';
  },

  readState: async (userId): Promise<LinkCodeState> => {
    const codes = await options.sql.query<CodeRow>(
      `select ${CODE_COLUMNS} from identity_link_codes
        where user_id = $1 order by created_at desc, id desc limit 1`,
      [userId],
    );
    const newest = codes.rows[0];
    const code = newest === undefined ? null : toCode(newest);
    if (code === null) {
      return { code: null, matches: [] };
    }
    const matches = await options.sql.query<MatchRow & { integration_name: string | null }>(
      `select m.id, m.code_id, m.integration_id, m.provider, m.external_id, m.display_name,
              m.comment_id, m.created_at, m.confirmed_at, i.name as integration_name
         from identity_link_matches m
         left join integrations i on i.id = m.integration_id
        where m.code_id = $1 and m.outcome = 'match'
        order by m.created_at, m.id`,
      [code.id],
    );
    return {
      code,
      matches: matches.rows.map((row) => ({
        ...toMatch(row),
        integrationName: row.integration_name ?? null,
      })),
    };
  },
});
