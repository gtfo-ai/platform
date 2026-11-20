/**
 * **Does a binding hear its provider by webhook?** (BACKLOG 1610) — the read behind
 * `ProjectBindingSummary.inbound`.
 *
 * Measured on a live install: a Jira binding with no `webhook_secret` had 434 poll rows in `inbox`
 * and no webhook row, so a person's status or assignee change in Jira reached the platform at the
 * next poll, or not at all for a field the poll does not re-read. Nothing on the project's screen
 * said so. Two facts answer it, and neither needs the provider:
 *
 *  - **whether a webhook could be verified**: one of the provider's declared
 *    `webhookSecretFields` is set — sealed in `secrets` (the field name travels inside the sealed
 *    document, so the rows are opened here and only the **names** are kept; a value never leaves
 *    this function), or pasted into the account's or the binding's `config` (the loader merges
 *    `{...config, ...secrets}`, so it would verify). A sealed row that cannot be opened makes the
 *    answer `unreadable` unless another source already says `configured`: a failed open is not
 *    "absent" here, because "not configured" would tell a person to set a secret that may be set.
 *  - **when the last webhook delivery arrived**: the newest **verified** `inbox` row of the
 *    integration whose `delivery_id` is not a poll's (`<provider>:poll:…`, `ticket-poll.ts` and
 *    `mr-poll.ts`), inside {@link BINDING_WEBHOOK_LOOKBACK_DAYS} days — bounded, because a poll-only
 *    binding's rows are all poll rows and an unbounded search would walk every one of them.
 *    `inbox_verified_integration_idx (integration_id, received_at desc) where verified` serves it.
 *
 * An integration is the account, not the binding: two projects bound to one Jira account read the
 * same answer, which is true — the webhook and its secret are the account's.
 */
import type { IsoDateTime, JsonObject, ProjectBindingInbound } from '@platform/contracts';
import { BINDING_WEBHOOK_LOOKBACK_DAYS } from '@platform/contracts';
import { db as dbAdapters, secrets as secretAdapters } from '@platform/infrastructure';
import type { ProviderCatalogueEntry } from '@platform/integrations';
import { inArray, sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';

const { integrations, secrets } = dbAdapters.schema;

/** What the sealed credentials of one integration said: the fields they hold, and any failed open. */
export interface SealedFieldNames {
  readonly fields: ReadonlySet<string>;
  readonly unreadable: boolean;
}

const setIn = (config: JsonObject | null | undefined, field: string): boolean => {
  const value = config?.[field];
  return typeof value === 'string' && value.length > 0;
};

/**
 * The webhook secret's state for one binding — pure, so every branch is a unit case. `null` for a
 * provider that declares no webhook secret fields (the DTO then carries no `inbound`).
 */
export const webhookSecretStateOf = (
  provider: Pick<ProviderCatalogueEntry, 'webhookSecretFields'> | undefined,
  accountConfig: JsonObject,
  bindingConfig: JsonObject,
  sealed: SealedFieldNames,
): ProjectBindingInbound['webhook_secret'] | null => {
  const fields = provider?.webhookSecretFields ?? [];
  if (fields.length === 0) {
    return null;
  }
  const configured = fields.some(
    (field) =>
      sealed.fields.has(field) || setIn(accountConfig, field) || setIn(bindingConfig, field),
  );
  if (configured) {
    return 'configured';
  }
  return sealed.unreadable ? 'unreadable' : 'not_configured';
};

/**
 * The names of the non-empty fields each integration's sealed credentials hold, by integration id.
 * Opened with the process's key; a row that does not open — a changed `APP_SECRET_KEY`, a damaged
 * row — sets `unreadable` and is otherwise skipped, and neither its text nor the error's is kept.
 */
export const readSealedFieldNames = async (
  database: Pick<Database, 'select'>,
  key: secretAdapters.SecretKey,
  integrationIds: readonly string[],
): Promise<ReadonlyMap<string, SealedFieldNames>> => {
  if (integrationIds.length === 0) {
    return new Map();
  }
  const owners = await database
    .select({ id: integrations.id, secretIds: integrations.secretIds })
    .from(integrations)
    .where(inArray(integrations.id, [...integrationIds]));
  const ownerOf = new Map<string, string>();
  for (const owner of owners) {
    for (const secretId of owner.secretIds) {
      ownerOf.set(secretId, owner.id);
    }
  }
  const found = new Map<string, { fields: Set<string>; unreadable: boolean }>(
    owners.map((owner) => [owner.id, { fields: new Set<string>(), unreadable: false }]),
  );
  if (ownerOf.size === 0) {
    return found;
  }
  const rows = await database
    .select({ id: secrets.id, ciphertext: secrets.ciphertext })
    .from(secrets)
    .where(inArray(secrets.id, [...ownerOf.keys()]));
  for (const row of rows) {
    const entry = found.get(ownerOf.get(row.id) ?? '');
    if (entry === undefined) {
      continue;
    }
    try {
      const document = secretAdapters.secretDocumentSchema.parse(
        JSON.parse(secretAdapters.openSecret(key, row.ciphertext, row.id)),
      );
      if (document.value.length > 0) {
        entry.fields.add(document.field);
      }
    } catch {
      // Never the plaintext and never the error's text: the answer becomes `unreadable`.
      entry.unreadable = true;
    }
  }
  return found;
};

/** A `float8` epoch-milliseconds column as a number, `null` kept (pg may hand a string back). */
const msOf = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * The newest verified **webhook** delivery of each integration inside the lookback, by integration
 * id — a poll's `inbox` row is not one. An integration with none is absent from the map.
 */
export const readLastWebhookDeliveries = async (
  database: Pick<Database, 'execute'>,
  integrationIds: readonly string[],
  now: Date,
): Promise<ReadonlyMap<string, IsoDateTime>> => {
  if (integrationIds.length === 0) {
    return new Map();
  }
  const since = new Date(now.getTime() - BINDING_WEBHOOK_LOOKBACK_DAYS * 86_400_000).toISOString();
  const result = await database.execute<{ integration_id: string; delivery_ms: unknown }>(sql`
    select i.id as integration_id,
           (extract(epoch from d.received_at) * 1000)::float8 as delivery_ms
      from integrations i
      join lateral (
        select b.received_at
          from inbox b
         where b.integration_id = i.id
           and b.verified
           and b.received_at > ${since}::timestamptz
           and not starts_with(b.delivery_id, b.provider || ':poll:')
         order by b.received_at desc
         limit 1
      ) d on true
     where i.id = any(${sql.param([...integrationIds])}::uuid[])`);
  const answer = new Map<string, IsoDateTime>();
  for (const row of result.rows) {
    const ms = msOf(row.delivery_ms);
    if (ms !== null) {
      answer.set(row.integration_id, new Date(ms).toISOString() as IsoDateTime);
    }
  }
  return answer;
};

/** One bound integration, as {@link readBindingInbound} needs it. */
export interface BindingInboundSubject {
  readonly integrationId: string;
  readonly provider: ProviderCatalogueEntry | undefined;
  readonly accountConfig: JsonObject;
  readonly bindingConfig: JsonObject;
}

/**
 * Each binding's `inbound`, by integration id — absent for a provider that declares no webhook
 * secret fields. Two statements for the secrets and one for the deliveries, whatever the count.
 */
export const readBindingInbound = async (
  database: Pick<Database, 'select' | 'execute'>,
  key: secretAdapters.SecretKey,
  subjects: readonly BindingInboundSubject[],
  now: Date,
): Promise<ReadonlyMap<string, ProjectBindingInbound>> => {
  const asked = subjects.filter(
    (subject) => (subject.provider?.webhookSecretFields ?? []).length > 0,
  );
  const ids = [...new Set(asked.map((subject) => subject.integrationId))];
  const [sealed, deliveries] = await Promise.all([
    readSealedFieldNames(database, key, ids),
    readLastWebhookDeliveries(database, ids, now),
  ]);
  const answer = new Map<string, ProjectBindingInbound>();
  for (const subject of asked) {
    const state = webhookSecretStateOf(
      subject.provider,
      subject.accountConfig,
      subject.bindingConfig,
      sealed.get(subject.integrationId) ?? { fields: new Set(), unreadable: false },
    );
    if (state === null) {
      continue;
    }
    answer.set(subject.integrationId, {
      webhook_secret: state,
      last_webhook_at: deliveries.get(subject.integrationId) ?? null,
    });
  }
  return answer;
};
