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
 *
 * **A binding's copy of an account-only key is dropped on read** (WP-79, PROGRESS backlog 268).
 * WP-73b refused `socket_mode` in a binding **write** (`assertNoAccountOnlyFields`), but a row
 * stored before that refusal kept its key, and the merge above let it win — flipping Slack's
 * `clickCanArrive` for that project while the held transport stayed the account's. So the overlay
 * drops the provider's `accountOnlyFields` from `binding_config` first
 * ({@link overlayBindingConfig}): the account's value is the only one read, whoever wrote the row
 * and whenever. The list is the provider catalogue's, handed in by the composition root, because
 * this ring may not import `@platform/integrations`.
 */
import type {
  BindingRepository,
  IntegrationAccount,
  IntegrationBinding,
  ProjectBinding,
} from '@platform/application';
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
  readonly retired: boolean;
}

interface AccountRow extends Record<string, unknown> {
  readonly type: string;
  readonly provider: string;
  readonly name: string;
  readonly integration_config: unknown;
  readonly secret_ids: string[] | null;
  readonly binding_id: string | null;
  readonly project_id: string | null;
  readonly binding_config: unknown;
}

const asObject = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};

/**
 * The config keys only a provider's **account** may set — `accountOnlyFieldsOf` in
 * `@platform/integrations`' catalogue, `[]` for a provider that declares none (or that this build
 * does not ship, whose binding the loader refuses anyway).
 */
export type AccountOnlyFieldsLookup = (provider: string) => readonly string[];

/**
 * `binding` over `account`, **minus** the binding's copy of any account-only key (WP-79, backlog
 * 268). Pure, so the pre-WP-73b row is a unit case rather than a database fixture.
 */
export const overlayBindingConfig = (
  account: JsonObject,
  binding: JsonObject,
  accountOnly: readonly string[],
): JsonObject => {
  const overlay: JsonObject = {};
  for (const [key, value] of Object.entries(binding)) {
    if (!accountOnly.includes(key)) {
      overlay[key] = value;
    }
  }
  return { ...account, ...overlay };
};

/**
 * `accountOnlyFields` is required rather than defaulted (standing rule 31): an absent list is the
 * pre-WP-79 merge, which is the defect.
 */
export const createPostgresBindingRepository = (
  sql: SqlExecutor,
  accountOnlyFields: AccountOnlyFieldsLookup,
): BindingRepository => ({
  forProject: async (projectId: Id): Promise<readonly ProjectBinding[]> => {
    const { rows } = await sql.query<BindingRow>(
      `select b.id            as binding_id,
              i.id            as integration_id,
              i.type          as type,
              i.provider      as provider,
              i.name          as name,
              i.config        as integration_config,
              b.config        as binding_config,
              i.secret_ids    as secret_ids,
              i.retired_at is not null as retired
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
      config: overlayBindingConfig(
        asObject(row.integration_config),
        asObject(row.binding_config),
        accountOnlyFields(row.provider),
      ),
      secretIds: (row.secret_ids ?? []) as Id[],
      // Kept and flagged rather than filtered (WP-114): a binding of a retired integration is a
      // row written past the retire's refusal, and the loader refuses it by name — dropping it
      // here would make the project read as having no such binding (standing rule 20).
      retired: row.retired === true,
    }));
  },

  /**
   * The same join from the other end — one `left join`, so an integration nobody has bound is an
   * account with no bindings rather than no answer at all.
   *
   * That distinction is the whole reason this is not `forProject` run backwards: the webhook
   * endpoint has to tell "no such integration" (404, nothing written) from "an integration nobody
   * uses" (a verified delivery that is stored and performs nothing), and collapsing them would make
   * an unbound account look like a forged URL.
   *
   * Ordered by `project_id` so two calls agree, for the same reason `forProject` orders its rows.
   *
   * A **retired** integration (WP-114) answers `null`, the port's docblock says why.
   */
  forIntegration: async (integrationId: Id): Promise<IntegrationAccount | null> => {
    const { rows } = await sql.query<AccountRow>(
      `select i.type        as type,
              i.provider    as provider,
              i.name        as name,
              i.config      as integration_config,
              i.secret_ids  as secret_ids,
              b.id          as binding_id,
              b.project_id  as project_id,
              b.config      as binding_config
         from integrations i
         left join bindings b on b.integration_id = i.id
        where i.id = $1
          and i.retired_at is null
        order by b.project_id`,
      [integrationId],
    );
    const first = rows[0];
    if (first === undefined) {
      return null;
    }
    const account = asObject(first.integration_config);
    const accountOnly = accountOnlyFields(first.provider);
    const bindings: IntegrationBinding[] = rows
      .filter((row) => row.binding_id !== null && row.project_id !== null)
      .map((row) => ({
        bindingId: row.binding_id as Id,
        projectId: row.project_id as Id,
        config: overlayBindingConfig(account, asObject(row.binding_config), accountOnly),
      }));

    return {
      integrationId,
      type: first.type as IntegrationType,
      provider: first.provider,
      name: first.name,
      config: account,
      secretIds: (first.secret_ids ?? []) as Id[],
      bindings,
    };
  },
});

/**
 * Every `integrations.id`, oldest first — what WP-43's held-connection directory walks to find the
 * accounts that select a held inbound connection. Kept beside the repository rather than added to
 * the `BindingRepository` port: the pipeline never lists accounts, and a port method only one
 * composition calls is a method every double has to implement for nothing.
 */
export const listIntegrationIds = async (sql: SqlExecutor): Promise<readonly Id[]> => {
  const { rows } = await sql.query<{ id: string }>(
    // A retired integration (WP-114) holds no connection: its credentials are gone.
    'select id from integrations where retired_at is null order by created_at, id',
  );
  return rows.map((row) => row.id as Id);
};

/**
 * Every `communication` account of the organisation, oldest first, with **no binding overlay** —
 * what the organisation-scoped notification is built from (WP-65, PROGRESS backlog 80).
 *
 * `config` is the account's own document, because the question is *which channel did the
 * organisation choose*, and a binding's channel is a project's answer to a different one. Kept
 * **Single-tenant by design (BD-009)**: it lists every communication account in the database and does
 * **not** filter by `org_id`, because an instance serves one organisation. A multi-tenant build
 * would have to pass the organisation here, or an organisation's alarm could reach another's
 * channel.
 *
 * Kept beside {@link listIntegrationIds} rather than on the `BindingRepository` port for that function's
 * reason: the pipeline's project path never lists accounts. `bindings` is left empty — the
 * organisation's path does not read them, and filling it would be a join nothing uses.
 */
export const listCommunicationAccounts = async (
  sql: SqlExecutor,
): Promise<readonly IntegrationAccount[]> => {
  const { rows } = await sql.query<{
    id: string;
    provider: string;
    name: string;
    config: unknown;
    secret_ids: string[] | null;
  }>(
    `select id, provider, name, config, secret_ids
       from integrations
      where type = 'communication'
        and retired_at is null
      order by created_at, id`,
  );
  return rows.map((row) => ({
    integrationId: row.id as Id,
    type: 'communication' as IntegrationType,
    provider: row.provider,
    name: row.name,
    config: asObject(row.config),
    secretIds: (row.secret_ids ?? []) as Id[],
    bindings: [],
  }));
};
