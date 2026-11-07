/**
 * **Who a tracker assignee is, and who may own a task** — on PostgreSQL (S-26.1, TD-031's
 * 2026-11-06 amendment items 1 and 6; the port is `TaskOwnerDirectory` in
 * `packages/application/src/pipeline/store.ts`).
 *
 * Read in the caller's transaction and live: `user_identities` (migration 0003, `kind` since 0045),
 * the effective project role of an account that is not disabled ({@link userMayOwnInProjectSql}:
 * the higher of the organisation role and a membership, backlog 886) and the project's bindings' own accounts
 * (`bindings.account_identity`, migration 0090). Only by the provider-issued account id: never an
 * email, never a display name (BD-022, Q10).
 *
 * The order is the port's: a `person` linked to a member wins (a person's own token, Q118 (a), is
 * that person's), then a `machine`, then a binding's own account; anything else is a `person` the
 * platform cannot map.
 */
import type { TaskOwnerDirectory, Transaction } from '@platform/application';
import type { Id } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import { userMayOwnInProjectSql } from './running-role.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

const CLASSIFY_SQL = `select
    (select ui.kind from user_identities ui
      where ui.provider = $2 and ui.external_id = $3) as kind,
    (select ui.user_id from user_identities ui
      where ui.provider = $2 and ui.external_id = $3 and ui.kind = 'person'
        and ${userMayOwnInProjectSql('ui.user_id', '$1::uuid')}) as member_user_id,
    exists (select 1 from bindings b
             where b.project_id = $1::uuid
               and b.account_identity ->> 'provider' = $2
               and b.account_identity ->> 'external_id' = $3) as binding_account`;

export const createPostgresTaskOwnerDirectory = (): TaskOwnerDirectory => ({
  classifyAssignee: async (tx, input) => {
    const { rows } = await sqlOf(tx).query<{
      kind: string | null;
      member_user_id: string | null;
      binding_account: boolean;
    }>(CLASSIFY_SQL, [input.projectId, input.provider, input.externalId]);
    const row = rows[0];
    if (row?.member_user_id !== null && row?.member_user_id !== undefined) {
      return { kind: 'member', userId: row.member_user_id as Id };
    }
    if (row?.kind === 'machine' || row?.binding_account === true) {
      return { kind: 'platform' };
    }
    return { kind: 'person' };
  },
  mayOwn: async (tx, input) => {
    const { rows } = await sqlOf(tx).query<{ may: boolean }>(
      `select ${userMayOwnInProjectSql('$2::uuid', '$1::uuid')} as may`,
      [input.projectId, input.userId],
    );
    return rows[0]?.may === true;
  },
});
