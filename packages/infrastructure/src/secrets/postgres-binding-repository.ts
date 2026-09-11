/**
 * `BindingRepository` on `bindings` joined to `integrations` (technical/03).
 *
 * One query, no transaction: composing a project's adapters is a read, and holding a connection
 * across the provider construction that follows would put a database connection inside every
 * provider call's critical path for no benefit (the pool arithmetic in `pipeline/runtime.ts` is
 * written on the assumption that nothing does this).
 *
 * The **order is stable and stated** — type, then provider, then name — because a project with two
 * git bindings has to resolve to the *same* one on every call, and "whatever PostgreSQL returned"
 * is not that. Which of two is chosen is the loader's decision to make and to say out loud; this
 * only guarantees it is asked the same question twice. Note that `type` is an enum, so it sorts by
 * the order migration 0002 declared its labels (`task_management` first), not alphabetically —
 * measured in `test/integration/secrets/bindings.integration.test.ts` rather than assumed.
 *
 * `bindings.config` is merged **over** `integrations.config` here rather than in the loader,
 * because the strictness of a provider's schema means the merged document is the only one that can
 * be validated at all (see the port's docblock).
 */
import type { BindingRepository, ProjectBinding } from '@platform/application';
import type { Id, IntegrationType, JsonObject } from '@platform/contracts';
import type { SqlExecutor } from '../events/sql.js';

interface BindingRow extends Record<string, unknown> {
  readonly binding_id: string;
  readonly integration_id: string;
  readonly type: string;
  readonly provider: string;
  readonly name: string;
  readonly integration_config: unknown;
  readonly binding_config: unknown;
  readonly secret_ids: string[] | null;
}

const asObject = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};

export const createPostgresBindingRepository = (sql: SqlExecutor): BindingRepository => ({
  forProject: async (projectId: Id): Promise<readonly ProjectBinding[]> => {
    const { rows } = await sql.query<BindingRow>(
      `select b.id            as binding_id,
              i.id            as integration_id,
              i.type          as type,
              i.provider      as provider,
              i.name          as name,
              i.config        as integration_config,
              b.config        as binding_config,
              i.secret_ids    as secret_ids
         from bindings b
         join integrations i on i.id = b.integration_id
        where b.project_id = $1
        order by i.type, i.provider, i.name`,
      [projectId],
    );

    return rows.map((row) => ({
      bindingId: row.binding_id as Id,
      integrationId: row.integration_id as Id,
      type: row.type as IntegrationType,
      provider: row.provider,
      name: row.name,
      config: { ...asObject(row.integration_config), ...asObject(row.binding_config) },
      secretIds: (row.secret_ids ?? []) as Id[],
    }));
  },
});
