/**
 * The reads behind `GET /api/integrations` and `GET /api/integrations/:id/setup-guide` (WP-15h
 * part 2).
 *
 * ## The row is the operator's, not the platform's
 *
 * The row's writers are the operator's commands — `POST /api/integrations` (WP-21),
 * `PATCH /api/integrations/:id` (WP-100), and the re-seal and the retire (WP-114), all in
 * `queries/onboarding-queries.ts` — and provisioning with `psql`. So unlike every other read in this directory, this one is not a projection of
 * something the pipeline produced — it is a projection of configuration the platform *consumes*, on
 * every webhook delivery and every binding load.
 *
 * ## A stored configuration that would not load is reported, not hidden (WP-100)
 *
 * Both commands parse `config` with the provider's schema since WP-100, but a row written before
 * that — every create from the *Add an integration* form sent `config: {}` (PROGRESS backlog 328) —
 * or with `psql` can still fail at every binding load. {@link storedConfigRefusal} asks the
 * catalogue the loader's question and publishes the answer as `config_refusal`: the key paths and
 * the `PATCH` that repairs them. The list itself is still served — one broken row must not hide
 * the others, nor the screen the operator repairs it from.
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
 * ## A retired integration is listed, and says so (WP-114)
 *
 * `DELETE /api/integrations/:id` keeps the row for the audit and destroys its credential; the list
 * still serves it, with `retired_at`, because an operator reading the audit of an old call needs
 * the name it was made under — and a row that vanished from the list would read as deleted.
 *
 * ## `integrations.health` has a writer since WP-21, and `unknown` is still not an invention
 *
 * `POST /api/integrations/:id/test` writes it (`queries/onboarding-queries.ts`), so a row somebody
 * has probed carries `ok` or `down` with the instant it was checked. A row **nobody** has probed is
 * `{}`, and the published enum has a spelling for exactly that: `status: 'unknown'` with
 * `checked_at: null` says *nobody has checked*, which is true. A stored value that is not the
 * published shape is refused by name rather than coerced.
 *
 * ## Health is read from traffic, and the probe is one data point (S-25.3)
 *
 * The probe alone made a row read "Healthy · checked 32 d ago": a month-old opinion. Since S-25.3
 * the row also carries `activity` — the newest outbound call that **reached the provider**
 * (`integration_actions`, `ok` or `failed`) and the newest **verified** inbound delivery (`inbox`)
 * — and `current_health`, which {@link currentHealthOf} derives from both and the probe against
 * `INTEGRATION_HEALTH_STALE_AFTER_HOURS`. Nothing newer than the bound is `not_checked_recently`,
 * never `working`. No table is added: {@link readIntegrationTraffic} is one statement over existing
 * rows, three `lateral` probes per listed integration, each bounded by an index and a window —
 * `integration_actions_integration_idx (integration_id, created_at desc)` for the newest call (a
 * backward scan of the last {@link LAST_CALL_LOOKBACK_DAYS} days only, so an integration whose rows
 * are all shadow `would_have` scans those days' partitions and no older ones, stopped at the first
 * `ok`/`failed` row) and for the window's newest success and failure (a range scan of the last
 * 24 hours only), and `inbox_verified_integration_idx` (migration 0102) for the newest delivery:
 * before it, `inbox` had no index that led with `integration_id` but the partial one over
 * refusals. A call older than the lookback is published as none — it could only ever have read
 * `not_checked_recently`, which the probe or a delivery still says when there is one.
 *
 * **The probe's own calls are not traffic** (review of PR #75). `createIntegrationProber` records
 * every *Test connection* through the executor, and a probe the provider answered `ok: false` is
 * an `ok` row — a successful test reporting a failed connection — written a moment after
 * `integrations.health.checked_at`. Counted, it would be a newer outbound success than the failed
 * probe, and a failing integration would read `working`. So both outbound laterals leave out
 * `PROBE_ACTIONS` (declared beside the prober, which names every call through it), and the probe's
 * verdict is read from `integrations.health` alone.
 *
 * **A residual, stated.** `integration_actions` stores no error code, so a `failed` row is any
 * provider call that failed after its retries — a ticket that is not there (`not_found`) as much as
 * a revoked token (`unauthorised`). One request's fault after a success therefore reads `degraded`
 * rather than `failing`, and the next successful call clears it (BACKLOG 1220).
 *
 * **A failed last call says what failed** (S-25.20): `last_call.error` is the message of **that
 * call's** `integration.action.failed` event — the audit log appends it in the row's transaction
 * with the row's own instant as `occurred_at`, so the fourth lateral matches the chosen row by
 * instant and action (review of #126) — written **already redacted** and bounded by the executor,
 * so nothing here reads provider text again. Run only when the newest call failed.
 */

import { REFUSED_DELIVERY_REASONS } from '@platform/application';
import type {
  Id,
  IntegrationCurrentHealth,
  IntegrationSummary,
  IntegrationType,
  IntegrationUser,
  IsoDateTime,
  JsonObject,
  RefusedDelivery,
} from '@platform/contracts';
import {
  INTEGRATION_HEALTH_STALE_AFTER_HOURS,
  integrationSummarySchema,
  MAX_INTEGRATION_CALL_ERROR_CHARS,
  MAX_REFUSED_DELIVERIES,
} from '@platform/contracts';
import { db as dbAdapters, secrets as secretAdapters } from '@platform/infrastructure';
import type { ConfigIssue, ProviderCatalogueEntry } from '@platform/integrations';
import {
  accountOnlyFieldsOf,
  configIssuesOf,
  findShippedProvider,
  PROBE_ACTIONS,
  usesOf,
} from '@platform/integrations';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { UnprojectableRowError } from './pipeline-queries.js';

const { bindings, inbox, integrations, projects } = dbAdapters.schema;

export type Database = dbAdapters.Database;

/** One `integrations` row, as this module reads it. */
export interface IntegrationRow {
  readonly id: string;
  readonly type: IntegrationType;
  readonly provider: string;
  readonly name: string;
  readonly config: JsonObject;
  readonly health: JsonObject;
  /** `DELETE /api/integrations/:id` (WP-114); `null` while live. */
  readonly retiredAt: Date | null;
}

const columns = {
  id: integrations.id,
  type: integrations.type,
  provider: integrations.provider,
  name: integrations.name,
  config: integrations.config,
  health: integrations.health,
  retiredAt: integrations.retiredAt,
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
 *
 * **It is the second layer, not the only one** (standing rule 22). Since WP-21's review round 2 the
 * *write* refuses a `config` key that names a credential field
 * (`queries/onboarding-queries.ts` → `assertNoCredentialInConfig`), so a row created through the
 * API cannot carry one. This strip still matters for the rows that did not come through it: one
 * written before that check existed, or one an operator wrote with `psql`. A guard whose only layer
 * is the one that *hides* the value is how the leak stayed invisible from the API in the first
 * place.
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

/**
 * The key paths a refusal names, rendered once for the 400 at a write and the 409 at a read.
 *
 * Paths and the schema's own messages only — `configIssuesOf` never quotes a value, because a
 * config document is a place somebody may have pasted a credential and these strings reach an HTTP
 * response and a log line.
 */
export const describeConfigIssues = (issues: readonly ConfigIssue[]): string =>
  issues.map((issue) => `${issue.path} (${issue.message})`).join(', ');

/**
 * The refusal a **stored** row that no longer parses answers at read (WP-100, criterion 4) — the
 * WP-30 / WP-83 / WP-93 shape: the key paths, and the command that repairs them, never a 500 and
 * never a row published as if it would load. `null` when the row parses, and for a provider this
 * build does not ship, whose schema is unknown here (`GET /api/integrations` logs those by id).
 */
export const storedConfigRefusal = (
  integrationId: string,
  config: JsonObject,
  provider: ProviderCatalogueEntry | undefined,
): {
  readonly code: 'invalid_integration_config';
  readonly message: string;
  readonly paths: string[];
} | null => {
  if (provider === undefined) {
    return null;
  }
  const issues = configIssuesOf(provider, config);
  if (issues.length === 0) {
    return null;
  }
  return {
    code: 'invalid_integration_config',
    message: `integration ${integrationId} has configuration that provider "${provider.id}"'s schema refuses at: ${describeConfigIssues(issues)}. Every binding load and connection test of it fails until it is corrected with PATCH /api/integrations/${integrationId}`,
    paths: issues.map((issue) => issue.path),
  };
};

/**
 * What `credentials_readable: false` costs, in platform text (WP-157 (a), PROGRESS backlog 413).
 *
 * **It is shown to people as it is** (the Integrations row, Home's banner), so it is plain words:
 * no variable, row, path or id (S-23.22) — `user-facing-copy.test.ts` holds it to that. Why the
 * credentials cannot be read (a changed `APP_SECRET_KEY`, a damaged `secrets` row) is the operator
 * guide's, and the withheld directory is `.agentic/prompts/`.
 *
 * `createProjectBindingSecrets` adds every live communication account to every project's
 * exact-value set, so the repository reading of **every** project stores its configuration and
 * withholds its prompt files (`withheldPrompts` in `packages/application/src/config/repository-config.ts`).
 */
export const ORGANISATION_ACCOUNT_UNREADABLE_CONSEQUENCE =
  'Until they are replaced or the integration is retired, no project’s runs are given the project’s prompt files, because those files cannot be checked for these credentials.';

/**
 * Whether each live organisation communication account decrypts, by id — the answer of
 * `createOrganisationAccountCredentialCheck`, or `null` for a process that composed no check.
 */
export type OrganisationCredentialStates = ReadonlyMap<string, boolean> | null;

/** What {@link readIntegrationFacts} adds to a row: its traffic, its health now, its projects. */
export type IntegrationFacts = Pick<IntegrationSummary, 'activity' | 'current_health' | 'used_by'>;

export const toIntegrationSummary = (
  row: IntegrationRow,
  provider: ProviderCatalogueEntry | undefined,
  credentials: OrganisationCredentialStates,
  facts: IntegrationFacts,
): IntegrationSummary => {
  // A retired row is never read by the loader (its credentials are destroyed), so it is unchecked.
  const readable = row.retiredAt === null ? (credentials?.get(row.id) ?? null) : null;
  return {
    ...summaryOf(row, provider),
    credentials_readable: readable,
    credentials_consequence:
      readable === false ? ORGANISATION_ACCOUNT_UNREADABLE_CONSEQUENCE : null,
    ...facts,
  };
};

/**
 * Every listed row as the API publishes it — the projection plus {@link readIntegrationFacts} —
 * for the list read and for every command that answers with the row it changed, so a command's
 * answer carries the same health and projects the list would (S-25.3).
 */
export const integrationSummaries = async (
  database: Database,
  rows: readonly IntegrationRow[],
  credentials: OrganisationCredentialStates,
  now: Date,
): Promise<IntegrationSummary[]> => {
  const facts = await readIntegrationFacts(database, rows, now);
  return rows.map((row) =>
    toIntegrationSummary(
      row,
      findShippedProvider(row.provider),
      credentials,
      facts.get(row.id) ?? factsOf(row, NO_TRAFFIC, [], now.getTime()),
    ),
  );
};

/** One row as {@link integrationSummaries} publishes it — a command's answer. */
export const integrationSummaryOf = async (
  database: Database,
  row: IntegrationRow,
  credentials: OrganisationCredentialStates,
  now: Date,
): Promise<IntegrationSummary> => {
  const facts = await readIntegrationFacts(database, [row], now);
  return toIntegrationSummary(
    row,
    findShippedProvider(row.provider),
    credentials,
    facts.get(row.id) ?? factsOf(row, NO_TRAFFIC, [], now.getTime()),
  );
};

// ── Health from traffic (S-25.3) ─────────────────────────────────────────────

const STALE_AFTER_MS = INTEGRATION_HEALTH_STALE_AFTER_HOURS * 3_600_000;

/**
 * How far back the newest-call read looks (review of PR #75): 90 days, about three monthly
 * partitions of `integration_actions`. A bound rather than "ever", so a shadow-only integration —
 * every row `would_have`, none of them evidence — costs those days' rows and not the table's.
 */
export const LAST_CALL_LOOKBACK_DAYS = 90;

/** One integration's traffic, as {@link readIntegrationTraffic} reads it; instants in epoch ms. */
export interface IntegrationTraffic {
  /**
   * The newest outbound call that reached the provider, of any age; `error` is the newest failed
   * call's redacted message (its `integration.action.failed` event), kept only when it failed.
   */
  readonly lastCall: {
    readonly atMs: number;
    readonly ok: boolean;
    readonly error?: string | null;
  } | null;
  /** Inside the stale bound only: the newest `ok` call and the newest `failed` one. */
  readonly lastOkInWindowMs: number | null;
  readonly lastFailedInWindowMs: number | null;
  /** The newest verified inbound delivery, of any age. */
  readonly lastDeliveryMs: number | null;
}

export const NO_TRAFFIC: IntegrationTraffic = {
  lastCall: null,
  lastOkInWindowMs: null,
  lastFailedInWindowMs: null,
  lastDeliveryMs: null,
};

interface Evidence {
  readonly basis: NonNullable<IntegrationCurrentHealth['basis']>;
  readonly atMs: number;
}

const newest = (items: readonly (Evidence | null)[]): Evidence | null =>
  items.reduce<Evidence | null>(
    (best, item) => (item !== null && (best === null || item.atMs > best.atMs) ? item : best),
    null,
  );

const evidence = (basis: Evidence['basis'], atMs: number | null): Evidence | null =>
  atMs === null || !Number.isFinite(atMs) ? null : { basis, atMs };

const iso = (atMs: number): IsoDateTime => new Date(atMs).toISOString() as IsoDateTime;

/**
 * The integration's health **now** (S-25.3, product/08's 2026-11-06 amendment) — pure, so every
 * branch is a unit case. The rules, in order:
 *
 * 1. Only evidence newer than `now − INTEGRATION_HEALTH_STALE_AFTER_HOURS` decides a verdict.
 * 2. **Outbound first.** If the newest outbound evidence inside the bound — a call or a probe — is a
 *    failure, the integration is `failing`, or `degraded` when an outbound success inside the bound
 *    came before it. A webhook that still arrives does not hide a token the provider refuses: the
 *    two directions are different credentials and different doors.
 * 3. Otherwise any success inside the bound — an outbound call, a probe, a verified delivery — is
 *    `working`, its basis the newest of them.
 * 4. Otherwise anything at all on record is `not_checked_recently`, at the newest of it; nothing is
 *    `never_checked`. A month-old *passed* probe is the first of these, never `working`.
 *
 * A probe that reads `down` is a failure; `degraded` — *Passed with warnings* on the page — is a
 * pass, so it never reads failing on the row while the page says it passed; `unknown` is no
 * evidence.
 */
export const currentHealthOf = (
  probe: IntegrationSummary['health'],
  traffic: IntegrationTraffic,
  nowMs: number,
): IntegrationCurrentHealth => {
  const since = nowMs - STALE_AFTER_MS;
  const recent = (item: Evidence | null): Evidence | null =>
    item !== null && item.atMs > since ? item : null;
  const probed =
    probe.status === 'unknown' || probe.checked_at === null
      ? null
      : evidence('probe', Date.parse(probe.checked_at));
  const probeOk = probe.status === 'ok' || probe.status === 'degraded' ? probed : null;
  const probeFailed = probe.status === 'down' ? probed : null;

  const outboundSuccess = newest([
    recent(evidence('call', traffic.lastOkInWindowMs)),
    recent(probeOk),
  ]);
  const outboundFailure = newest([
    recent(evidence('call', traffic.lastFailedInWindowMs)),
    recent(probeFailed),
  ]);
  if (
    outboundFailure !== null &&
    (outboundSuccess === null || outboundFailure.atMs > outboundSuccess.atMs)
  ) {
    return {
      status: outboundSuccess === null ? 'failing' : 'degraded',
      basis: outboundFailure.basis,
      at: iso(outboundFailure.atMs),
    };
  }
  const success = newest([outboundSuccess, recent(evidence('delivery', traffic.lastDeliveryMs))]);
  if (success !== null) {
    return { status: 'working', basis: success.basis, at: iso(success.atMs) };
  }
  const anything = newest([
    traffic.lastCall === null ? null : evidence('call', traffic.lastCall.atMs),
    evidence('delivery', traffic.lastDeliveryMs),
    probed,
  ]);
  return anything === null
    ? { status: 'never_checked', basis: null, at: null }
    : { status: 'not_checked_recently', basis: anything.basis, at: iso(anything.atMs) };
};

/** One row's {@link IntegrationFacts} out of its traffic and its projects. */
export const factsOf = (
  row: IntegrationRow,
  traffic: IntegrationTraffic,
  users: IntegrationUser[],
  nowMs: number,
): IntegrationFacts => ({
  activity: {
    last_call:
      traffic.lastCall === null
        ? null
        : {
            at: iso(traffic.lastCall.atMs),
            ok: traffic.lastCall.ok,
            error: callErrorOf(traffic.lastCall),
          },
    last_delivery_at: traffic.lastDeliveryMs === null ? null : iso(traffic.lastDeliveryMs),
  },
  current_health: currentHealthOf(healthOf(row), traffic, nowMs),
  used_by: users,
});

/**
 * What a failed last call published (S-25.20): the executor's own redacted message, cut at
 * {@link MAX_INTEGRATION_CALL_ERROR_CHARS}. `null` for a success, or a failure with no message.
 */
export const callErrorOf = (call: {
  readonly ok: boolean;
  readonly error?: string | null;
}): { readonly message: string; readonly message_cut: boolean } | null => {
  const message = call.error?.trim() ?? '';
  if (call.ok || message === '') {
    return null;
  }
  return {
    message: message.slice(0, MAX_INTEGRATION_CALL_ERROR_CHARS),
    message_cut: message.length > MAX_INTEGRATION_CALL_ERROR_CHARS,
  };
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
 * Each listed integration's traffic, read in **one** statement (S-25.3).
 *
 * Instants are selected as epoch milliseconds rather than as `timestamptz`: on the raw `execute`
 * path drizzle hands a timestamp back unparsed (`identity-queries.ts` measured it), and a number
 * needs no second parser. The three `lateral` probes and the index each one rides are this
 * module's docblock.
 */
export const readIntegrationTraffic = async (
  database: Pick<Database, 'execute'>,
  integrationIds: readonly string[],
  now: Date,
): Promise<ReadonlyMap<string, IntegrationTraffic>> => {
  if (integrationIds.length === 0) {
    return new Map();
  }
  const since = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const lookback = new Date(now.getTime() - LAST_CALL_LOOKBACK_DAYS * 86_400_000).toISOString();
  const probeActions = sql.param([...PROBE_ACTIONS]);
  const result = await database.execute<{
    integration_id: string;
    last_call_ms: unknown;
    last_call_status: string | null;
    failed_error: unknown;
    ok_ms: unknown;
    failed_ms: unknown;
    delivery_ms: unknown;
  }>(sql`
    select i.id as integration_id,
           (extract(epoch from c.created_at) * 1000)::float8 as last_call_ms,
           c.status as last_call_status,
           f.error as failed_error,
           (extract(epoch from w.ok_at) * 1000)::float8 as ok_ms,
           (extract(epoch from w.failed_at) * 1000)::float8 as failed_ms,
           (extract(epoch from d.received_at) * 1000)::float8 as delivery_ms
      from integrations i
      left join lateral (
        select a.created_at, a.status, a.action
          from integration_actions a
         where a.integration_id = i.id
           and a.direction = 'out'
           and a.status in ('ok', 'failed')
           and a.created_at > ${lookback}::timestamptz
           and a.action <> all(${probeActions}::text[])
         order by a.created_at desc
         limit 1
      ) c on true
      left join lateral (
        select max(a.created_at) filter (where a.status = 'ok') as ok_at,
               max(a.created_at) filter (where a.status = 'failed') as failed_at
          from integration_actions a
         where a.integration_id = i.id
           and a.direction = 'out'
           and a.created_at > ${since}::timestamptz
           and a.action <> all(${probeActions}::text[])
      ) w on true
      left join lateral (
        -- S-25.20: the failed call's own message, as the executor wrote it (redacted, bounded)
        -- into the event the audit log appends with that very row: the envelope's occurred_at
        -- is the entry's instant, the row's created_at (review of #126), and the action matches.
        select e.payload ->> 'error' as error
          from events e
         where c.status = 'failed'
           and e.occurred_at = c.created_at
           and e.stream_type = 'integration'
           and e.stream_id = i.id
           and e.type = 'integration.action.failed'
           and e.payload ->> 'action' = c.action
         order by e.position desc
         limit 1
      ) f on true
      left join lateral (
        select b.received_at
          from inbox b
         where b.integration_id = i.id
           and b.verified
         order by b.received_at desc
         limit 1
      ) d on true
     where i.id = any(${sql.param([...integrationIds])}::uuid[])`);
  return new Map(
    result.rows.map((row) => {
      const lastCallMs = msOf(row.last_call_ms);
      return [
        row.integration_id,
        {
          lastCall:
            lastCallMs === null
              ? null
              : {
                  atMs: lastCallMs,
                  ok: row.last_call_status === 'ok',
                  error: typeof row.failed_error === 'string' ? row.failed_error : null,
                },
          lastOkInWindowMs: msOf(row.ok_ms),
          lastFailedInWindowMs: msOf(row.failed_ms),
          lastDeliveryMs: msOf(row.delivery_ms),
        },
      ] as const;
    }),
  );
};

/**
 * The projects that bind each listed integration, by key, with what each uses it for (S-25.3) —
 * the binding's **effective** configuration (the account's document with the binding's overlay,
 * account-only keys dropped, as the loader reads it: `overlayBindingConfig`) through the
 * catalogue's {@link usesOf}. `bindings_integration_id_idx` serves the read.
 */
export const readIntegrationUsers = async (
  database: Database,
  rows: readonly IntegrationRow[],
): Promise<ReadonlyMap<string, IntegrationUser[]>> => {
  if (rows.length === 0) {
    return new Map();
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const bound = await database
    .select({
      integrationId: bindings.integrationId,
      projectId: projects.id,
      key: projects.key,
      name: projects.name,
      config: bindings.config,
    })
    .from(bindings)
    .innerJoin(projects, eq(projects.id, bindings.projectId))
    .where(inArray(bindings.integrationId, [...byId.keys()]))
    .orderBy(asc(projects.key));
  const users = new Map<string, IntegrationUser[]>();
  for (const binding of bound) {
    const row = byId.get(binding.integrationId);
    if (row === undefined) {
      continue;
    }
    const effective = secretAdapters.overlayBindingConfig(
      row.config,
      binding.config,
      accountOnlyFieldsOf(row.provider),
    );
    users.set(row.id, [
      ...(users.get(row.id) ?? []),
      {
        project_id: binding.projectId as Id,
        project_key: binding.key,
        project_name: binding.name,
        uses: [...usesOf(findShippedProvider(row.provider), effective)],
      },
    ]);
  }
  return users;
};

/** {@link IntegrationFacts} for every listed row: its traffic and its projects, two reads. */
export const readIntegrationFacts = async (
  database: Database,
  rows: readonly IntegrationRow[],
  now: Date,
): Promise<ReadonlyMap<string, IntegrationFacts>> => {
  const [traffic, users] = await Promise.all([
    readIntegrationTraffic(
      database,
      rows.map((row) => row.id),
      now,
    ),
    readIntegrationUsers(database, rows),
  ]);
  return new Map(
    rows.map(
      (row) =>
        [
          row.id,
          factsOf(row, traffic.get(row.id) ?? NO_TRAFFIC, users.get(row.id) ?? [], now.getTime()),
        ] as const,
    ),
  );
};

const summaryOf = (
  row: IntegrationRow,
  provider: ProviderCatalogueEntry | undefined,
): Omit<
  IntegrationSummary,
  'credentials_readable' | 'credentials_consequence' | keyof IntegrationFacts
> => ({
  id: row.id as Id,
  type: row.type,
  provider: row.provider,
  name: row.name,
  config: publishableConfig(row.config, provider),
  health: healthOf(row),
  // A retired row (WP-114) is never loaded and refuses the `PATCH` the refusal would point at, so
  // it has nothing to repair: `null`, and `retired_at` is what the card says instead.
  config_refusal: row.retiredAt === null ? storedConfigRefusal(row.id, row.config, provider) : null,
  retired_at: row.retiredAt === null ? null : (row.retiredAt.toISOString() as IsoDateTime),
});

/**
 * WP-73b, backlog 206: refusals only, on the stored codes — `&&` is array overlap with
 * `REFUSED_DELIVERY_REASONS` — and a pre-0055 row, which has none and is served because it cannot
 * be told apart. Exported so the unit tier can render it.
 */
export const refusedDeliveryFilter = () =>
  or(
    isNull(inbox.errorReasons),
    sql`${inbox.errorReasons} && ${sql.param([...REFUSED_DELIVERY_REASONS])}::text[]`,
  );

/**
 * The newest inbound deliveries of one integration that the platform **refused**, and why (WP-44,
 * PROGRESS backlog 198) — since WP-73b (backlog 206) filtered on `inbox.error_reasons` to the codes
 * `REFUSED_DELIVERY_REASONS` names, so an ordinary ignore no longer pushes a refusal out of the
 * newest fifty.
 *
 * Until this read, a chat click refused as `unmapped_identity` or `decision_refused: not_permitted`
 * was visible only in SQL and in the API process's log. Everything served here was redacted at the
 * write — the error by the binding's redactor, the account ids too (`unmappedIdentitiesOf`) — and is
 * still provider-derived text (BD-022). `unmapped` is `null` for a row from before migration 0047.
 */
export const listRefusedDeliveries = async (
  database: Database,
  integrationId: string,
): Promise<RefusedDelivery[]> => {
  const rows = await database
    .select({
      deliveryId: inbox.deliveryId,
      receivedAt: inbox.receivedAt,
      error: inbox.error,
      unmapped: inbox.unmappedIdentities,
      reasons: inbox.errorReasons,
    })
    .from(inbox)
    .where(
      and(eq(inbox.integrationId, integrationId), isNotNull(inbox.error), refusedDeliveryFilter()),
    )
    .orderBy(desc(inbox.receivedAt))
    .limit(MAX_REFUSED_DELIVERIES);
  return rows.map((row) => ({
    delivery_id: row.deliveryId,
    received_at: row.receivedAt.toISOString(),
    error: row.error ?? '',
    reasons: row.reasons === null ? null : [...row.reasons],
    unmapped:
      row.unmapped === null
        ? null
        : row.unmapped.filter(
            (entry) =>
              typeof entry?.provider === 'string' &&
              entry.provider.length > 0 &&
              typeof entry.external_id === 'string' &&
              entry.external_id.length > 0,
          ),
  }));
};
