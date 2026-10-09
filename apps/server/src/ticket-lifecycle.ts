/**
 * **One reading of a project's ticket lifecycle**, for every reader in this process (WP-181).
 *
 * The slots live on the project's task-management binding (TD-029 decision 1): `bindings.config`
 * over `integrations.config`, the overlay the binding repository makes (`overlayBindingConfig`,
 * account-only keys dropped), read through `bindingLifecycleOf`. Three readers ask:
 *
 *  - the pipeline's settings port (`ProjectSettings.ticketLifecycle`, WP-177), which decides
 *    whether `status_mapping` is applied and what the claim and the lifecycle duty do;
 *  - `GET …/config`'s `status_mapping_superseded` (WP-181 ruling (c)), which must say exactly what
 *    the first reader decided — a screen that warned of a superseded mapping the pipeline still
 *    applies would be the second spelling of one rule (standing rule 9);
 *  - `GET …/readiness`'s lifecycle notes (WP-181 ruling (d)).
 *
 * So the classification is here, once, over the rows {@link ticketLifecycleBindingsQuery} selects:
 * no live task-management binding, two of them (the loader refuses that project's every call), a
 * binding with no block, a block that fails its schema (the loader refuses that binding too), or a
 * lifecycle. Each reader decides what the first four mean for it; the pipeline reads all four as
 * *no lifecycle*, and so does the superseded flag.
 */
import { type BindingLifecycle, bindingLifecycleOf } from '@platform/application';
import type { JsonValue } from '@platform/contracts';
import { secrets as secretAdapters } from '@platform/infrastructure';
import { accountOnlyFieldsOf } from '@platform/integrations';
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The project's live task-management bindings, the account's configuration and the binding's
 * overlay — one drizzle `sql` template, the project id a bound parameter. The routes' drizzle
 * `execute` runs it as it is; the pipeline's `pg` executor runs the same statement rendered by
 * {@link ticketLifecycleBindingsStatement} (review round 1: never a string split and `sql.raw`).
 */
export const ticketLifecycleBindingsQuery = (projectId: string): SQL =>
  sql`select i.provider, i.config as integration_config, b.config as binding_config
        from bindings b
        join integrations i on i.id = b.integration_id
       where b.project_id = ${projectId} and i.type = 'task_management' and i.retired_at is null`;

const dialect = new PgDialect();

/** {@link ticketLifecycleBindingsQuery} as `pg` text and values (`$1` is the project id). */
export const ticketLifecycleBindingsStatement = (
  projectId: string,
): { readonly text: string; readonly values: unknown[] } => {
  const rendered = dialect.sqlToQuery(ticketLifecycleBindingsQuery(projectId));
  return { text: rendered.sql, values: rendered.params };
};

/** One row of {@link ticketLifecycleBindingsQuery}. */
export interface TicketLifecycleBindingRow {
  readonly provider: string;
  readonly integration_config: unknown;
  readonly binding_config: unknown;
}

/** What the project's task-management binding says about the ticket lifecycle. */
export type ProjectTicketLifecycle =
  | { readonly kind: 'no_binding' }
  | { readonly kind: 'ambiguous'; readonly bindings: number }
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly detail: string }
  | { readonly kind: 'lifecycle'; readonly lifecycle: BindingLifecycle };

const asObject = (value: unknown): Record<string, JsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};

/** The classification of {@link TICKET_LIFECYCLE_BINDINGS_SQL}'s rows. Pure. */
export const ticketLifecycleOfRows = (
  rows: readonly TicketLifecycleBindingRow[],
): ProjectTicketLifecycle => {
  if (rows.length === 0) {
    return { kind: 'no_binding' };
  }
  if (rows.length > 1) {
    return { kind: 'ambiguous', bindings: rows.length };
  }
  const row = rows[0] as TicketLifecycleBindingRow;
  const reading = bindingLifecycleOf(
    secretAdapters.overlayBindingConfig(
      asObject(row.integration_config),
      asObject(row.binding_config),
      accountOnlyFieldsOf(row.provider),
    ),
  );
  return reading;
};

/** The lifecycle the pipeline applies: a parsed block, or `null` for every other reading. */
export const appliedTicketLifecycle = (reading: ProjectTicketLifecycle): BindingLifecycle | null =>
  reading.kind === 'lifecycle' ? reading.lifecycle : null;
