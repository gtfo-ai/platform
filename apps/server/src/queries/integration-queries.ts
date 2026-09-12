/**
 * The reads behind `GET /api/integrations` and `GET /api/integrations/:id/setup-guide` (WP-15h
 * part 2).
 *
 * ## The row is the operator's, not the platform's
 *
 * **Nothing in this build writes `integrations`.** `POST /api/integrations` and
 * `PATCH /api/integrations/:id` are on technical/08's table and belong to the work package that
 * gives the settings screen a write surface; today a row arrives by provisioning. So unlike every
 * other read in this directory, this one is not a projection of something the pipeline produced —
 * it is a projection of configuration the platform *consumes*, on every webhook delivery and every
 * binding load. That is why it is asserted against a provisioned row and says so.
 *
 * ## What is removed on the way out, and why it is removed here
 *
 * `integrations.config` is meant to hold non-secret configuration, with credentials in `secrets` and
 * merged in at load. But `bindings/loader.ts` merges `{...config, ...secrets}` and every provider's
 * schema accepts its credential from either side, so a binding whose token was pasted into `config`
 * works — and would then be served over HTTP to anyone holding `integration.read`. The projection
 * therefore drops exactly the keys the provider declares as secret
 * ({@link ProviderCatalogueEntry.secretFields}), which makes the DTO's own claim — *"Non-secret
 * configuration only; secret values never leave the server"* — enforced by the code that produces it
 * rather than decoration (standing rule 44).
 *
 * For a provider this build does not ship, the projection **cannot tell configuration from
 * credential**, so it publishes no configuration at all and says which row it did that to. Fail
 * closed: the alternative is a guess about a field list nobody here has.
 *
 * ## `integrations.health` has no writer either, and `unknown` is not an invention
 *
 * `POST /api/integrations/:id/test` — the thing that would write it — does not exist, so the column
 * is `{}` for every row. The published enum has a spelling for exactly this: `status: 'unknown'`
 * with `checked_at: null` says *nobody has checked*, which is true. A stored value that is not the
 * published shape is refused by name rather than coerced.
 */
import type { Id, IntegrationSummary, IntegrationType, JsonObject } from '@platform/contracts';
import { integrationSummarySchema } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import type { ProviderCatalogueEntry } from '@platform/integrations';
import { asc, eq } from 'drizzle-orm';
import { UnprojectableRowError } from './pipeline-queries.js';

const { integrations } = dbAdapters.schema;

export type Database = dbAdapters.Database;

/** One `integrations` row, as this module reads it. */
export interface IntegrationRow {
  readonly id: string;
  readonly type: IntegrationType;
  readonly provider: string;
  readonly name: string;
  readonly config: JsonObject;
  readonly health: JsonObject;
}

const columns = {
  id: integrations.id,
  type: integrations.type,
  provider: integrations.provider,
  name: integrations.name,
  config: integrations.config,
  health: integrations.health,
} as const;

export const listIntegrationRows = async (database: Database): Promise<IntegrationRow[]> =>
  database.select(columns).from(integrations).orderBy(asc(integrations.name));

export const findIntegrationRow = async (
  database: Database,
  integrationId: string,
): Promise<IntegrationRow | undefined> => {
  const rows = await database
    .select(columns)
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .limit(1);
  return rows[0];
};

/** The health shape the DTO publishes, as the column would have to hold it. */
const healthSchema = integrationSummarySchema.shape.health;

/**
 * The health block for a row, or the honest `unknown` when the column has never been written.
 *
 * A column holding something that is *not* the published shape is a row this projection does not
 * understand, and reporting it as `unknown` would make a broken writer look like an unchecked
 * integration — so it is refused by name instead (standing rule 20: fail closed when the answer
 * would otherwise be the reassuring one).
 */
export const healthOf = (row: IntegrationRow): IntegrationSummary['health'] => {
  if (Object.keys(row.health).length === 0) {
    return { status: 'unknown', checked_at: null, detail: null };
  }
  const parsed = healthSchema.safeParse(row.health);
  if (!parsed.success) {
    throw new UnprojectableRowError(
      `integration ${row.id}`,
      `its stored health does not match the published shape at ${parsed.error.issues
        .map((issue) => issue.path.join('.') || '(root)')
        .join(', ')}`,
    );
  }
  return parsed.data;
};

/**
 * The row's configuration with the provider's declared credential fields removed.
 *
 * `undefined` for `provider` means this build does not ship it; the answer is then `{}` rather than
 * a filtered document, because the filter would be a guess.
 */
export const publishableConfig = (
  config: JsonObject,
  provider: ProviderCatalogueEntry | undefined,
): JsonObject => {
  if (provider === undefined) {
    return {};
  }
  const secret = new Set(provider.secretFields);
  return Object.fromEntries(Object.entries(config).filter(([key]) => !secret.has(key)));
};

export const toIntegrationSummary = (
  row: IntegrationRow,
  provider: ProviderCatalogueEntry | undefined,
): IntegrationSummary => ({
  id: row.id as Id,
  type: row.type,
  provider: row.provider,
  name: row.name,
  config: publishableConfig(row.config, provider),
  health: healthOf(row),
});
