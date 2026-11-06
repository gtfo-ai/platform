/**
 * The two projections that decide what leaves the server on `GET /api/integrations`.
 *
 * `publishableConfig` is a **security** guard, not a tidy-up: `bindings/loader.ts` merges
 * `{...config, ...secrets}` and every provider's schema accepts its credential from either side, so
 * a binding whose token was pasted into `integrations.config` works — and, without this, would be
 * served over HTTP to anyone holding `integration.read`. The test plants a credential and asserts
 * **both** directions (standing rules 35 and 42): the secret is gone *and* the configuration beside
 * it survived, because a filter that removed everything would pass a one-sided check.
 *
 * `healthOf` is the other half: nothing in this build writes `integrations.health`, and `unknown` is
 * the enum's own spelling for "nobody has checked" rather than a value this projection made up.
 */
import type { JsonObject } from '@platform/contracts';
import { findShippedProvider } from '@platform/integrations';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  currentHealthOf,
  factsOf,
  healthOf,
  type IntegrationRow,
  type IntegrationTraffic,
  NO_TRAFFIC,
  publishableConfig,
  refusedDeliveryFilter,
  toIntegrationSummary,
} from './integration-queries.js';
import { UnprojectableRowError } from './pipeline-queries.js';

const PLANTED_TOKEN = 'FAKE-gitlab-token-DO-NOT-USE-0123456789';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const HOUR = 3_600_000;
/** An instant `hours` before {@link NOW}. */
const ago = (hours: number): number => NOW - hours * HOUR;
const isoAgo = (hours: number): string => new Date(ago(hours)).toISOString();

const traffic = (over: Partial<IntegrationTraffic>): IntegrationTraffic => ({
  ...NO_TRAFFIC,
  ...over,
});

const row = (overrides: Partial<IntegrationRow> = {}): IntegrationRow => ({
  id: '0199aa11-2b3c-7d4e-8f90-000000000001',
  type: 'git',
  provider: 'gitlab',
  name: 'acme gitlab',
  config: {},
  health: {},
  retiredAt: null,
  ...overrides,
});

describe('publishableConfig', () => {
  it('removes the provider’s credential fields and keeps everything else', () => {
    const gitlab = findShippedProvider('gitlab');
    expect(gitlab, 'the catalogue must know gitlab, or this test asserts nothing').toBeDefined();

    const config: JsonObject = {
      base_url: 'https://gitlab.example.test',
      project: 'acme/api',
      token: PLANTED_TOKEN,
      webhook_secret_token: 'FAKE-gitlab-webhook-secret',
      max_pages: 10,
    };
    const published = publishableConfig(config, gitlab);

    // Direction 1: the credential is gone, by value as well as by key — a filter that renamed the
    // key and kept the value would satisfy a key-only assertion.
    expect(Object.keys(published)).not.toContain('token');
    expect(JSON.stringify(published)).not.toContain(PLANTED_TOKEN);
    expect(JSON.stringify(published)).not.toContain('FAKE-gitlab-webhook-secret');
    // Direction 2: the configuration survived. Without this, "remove everything" passes.
    expect(published).toEqual({
      base_url: 'https://gitlab.example.test',
      project: 'acme/api',
      max_pages: 10,
    });
  });

  it('publishes nothing for a provider this build does not ship', () => {
    // Fail closed: the platform cannot tell configuration from credential without the provider's
    // own field list, and guessing is the failure this whole function exists to prevent. The e2e
    // world's `fake-git` binding is exactly this case.
    expect(findShippedProvider('fake-git')).toBeUndefined();
    expect(
      publishableConfig(
        { project: 'acme/api', token: PLANTED_TOKEN },
        findShippedProvider('fake-git'),
      ),
    ).toEqual({});
  });
});

/**
 * WP-100, criterion 4: the list publishes a stored configuration's refusal on the item rather than
 * failing the read — one broken row must not hide the others — and publishes `null` beside a row
 * that parses (standing rule 42), with the credential strip unchanged.
 */
describe('toIntegrationSummary and a stored configuration', () => {
  it('names the refused paths and the PATCH for a row the provider’s schema refuses', () => {
    const broken = row({ config: { host: 'https://gitlab.example.test', token: PLANTED_TOKEN } });
    const summary = toIntegrationSummary(
      broken,
      findShippedProvider('gitlab'),
      null,
      factsOf(broken, NO_TRAFFIC, [], NOW),
    );
    expect(summary.config_refusal?.paths.sort()).toEqual(['base_url', 'host']);
    expect(summary.config_refusal?.message).toContain(`PATCH /api/integrations/${broken.id}`);
    expect(JSON.stringify(summary)).not.toContain(PLANTED_TOKEN);
  });

  it('publishes null for a row that parses and for a provider this build does not ship', () => {
    expect(
      toIntegrationSummary(
        row({ config: { base_url: 'https://gitlab.example.test' } }),
        findShippedProvider('gitlab'),
        null,
        factsOf(row(), NO_TRAFFIC, [], NOW),
      ).config_refusal,
    ).toBeNull();
    expect(
      toIntegrationSummary(
        row({ provider: 'fake-git' }),
        undefined,
        null,
        factsOf(row(), NO_TRAFFIC, [], NOW),
      ).config_refusal,
    ).toBeNull();
  });
});

describe('healthOf', () => {
  it('reports an unwritten column as unknown and never checked', () => {
    // Nothing writes `integrations.health` in this build — `POST /api/integrations/:id/test` is the
    // endpoint that would — so this is the branch every row takes today, and `unknown` is a
    // published enum member rather than an invented value.
    expect(healthOf(row())).toEqual({ status: 'unknown', checked_at: null, detail: null });
  });

  it('serves a stored health block that matches the published shape', () => {
    expect(
      healthOf(
        row({
          health: { status: 'degraded', checked_at: '2026-09-13T00:00:00.000Z', detail: 'slow' },
        }),
      ),
    ).toEqual({ status: 'degraded', checked_at: '2026-09-13T00:00:00.000Z', detail: 'slow' });
  });

  it('refuses a stored health block it does not understand, naming the field', () => {
    // Not `unknown`: a broken writer must not be indistinguishable from an unchecked integration.
    try {
      healthOf(row({ health: { status: 'fine', checked_at: null, detail: null } }));
      expect.unreachable('a health block with an unpublished status must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(UnprojectableRowError);
      expect((error as UnprojectableRowError).message).toContain('status');
      // The path, never the value — the same rule the transcript projection follows (BD-022).
      expect((error as UnprojectableRowError).message).not.toContain('fine');
    }
  });
});

/**
 * WP-73b, PROGRESS backlog 206 (review round 1): the refused-deliveries filter at the unit tier —
 * rendered as the SQL PostgreSQL receives, so dropping the code overlap, or the pre-0055 branch,
 * fails here and not only in the integration case.
 */
describe('refusedDeliveryFilter', () => {
  const rendered = new PgDialect().sqlToQuery(refusedDeliveryFilter() ?? expect.fail('no filter'));

  it('overlaps the stored codes with exactly the refusal codes, and serves a row with none', () => {
    expect(rendered.sql).toContain('"error_reasons" is null');
    expect(rendered.sql).toMatch(/"error_reasons" && \$\d+::text\[\]/);
    expect(rendered.params).toEqual([
      ['decision_refused', 'malformed_payload', 'unmapped_identity'],
    ]);
    // The noise the filter exists to drop is not among them.
    expect(JSON.stringify(rendered.params)).not.toContain('unsupported_event');
  });
});

/**
 * S-25.3, product/08's 2026-11-06 amendment: health is read from traffic, the probe is one data
 * point, and nothing older than the 24-hour bound reads `working`. Each case names the branch it
 * reaches, and the bound is tested from both sides.
 */
describe('currentHealthOf', () => {
  const unprobed = { status: 'unknown' as const, checked_at: null, detail: null };
  const probe = (status: 'ok' | 'down' | 'degraded', hours: number) => ({
    status,
    checked_at: isoAgo(hours),
    detail: null,
  });

  it('is never_checked with no call, no delivery and no probe', () => {
    expect(currentHealthOf(unprobed, NO_TRAFFIC, NOW)).toEqual({
      status: 'never_checked',
      basis: null,
      at: null,
    });
  });

  it('reads a passed probe older than the bound as not checked recently, never working', () => {
    // The owner's row: "Healthy · checked 32 d ago".
    expect(currentHealthOf(probe('ok', 32 * 24), NO_TRAFFIC, NOW)).toEqual({
      status: 'not_checked_recently',
      basis: 'probe',
      at: isoAgo(32 * 24),
    });
  });

  it('holds the 24-hour bound from both sides', () => {
    expect(currentHealthOf(probe('ok', 23.9), NO_TRAFFIC, NOW).status).toBe('working');
    expect(currentHealthOf(probe('ok', 24), NO_TRAFFIC, NOW).status).toBe('not_checked_recently');
  });

  it('reads a recent successful call as working, whatever the old probe said', () => {
    const health = currentHealthOf(
      probe('down', 30 * 24),
      traffic({ lastCall: { atMs: ago(1), ok: true }, lastOkInWindowMs: ago(1) }),
      NOW,
    );
    expect(health).toEqual({ status: 'working', basis: 'call', at: isoAgo(1) });
  });

  it('reads a recent verified delivery as working when no outbound call failed', () => {
    expect(currentHealthOf(unprobed, traffic({ lastDeliveryMs: ago(2) }), NOW)).toEqual({
      status: 'working',
      basis: 'delivery',
      at: isoAgo(2),
    });
  });

  it('reads failed calls with no success inside the bound as failing, a delivery notwithstanding', () => {
    const health = currentHealthOf(
      unprobed,
      traffic({
        lastCall: { atMs: ago(1), ok: false },
        lastFailedInWindowMs: ago(1),
        // A webhook still arriving does not hide an outbound credential the provider refuses.
        lastDeliveryMs: ago(0.5),
      }),
      NOW,
    );
    expect(health).toEqual({ status: 'failing', basis: 'call', at: isoAgo(1) });
  });

  it('reads a failure after a success inside the bound as degraded, and a success after it as working', () => {
    expect(
      currentHealthOf(
        unprobed,
        traffic({ lastOkInWindowMs: ago(3), lastFailedInWindowMs: ago(1) }),
        NOW,
      ),
    ).toEqual({ status: 'degraded', basis: 'call', at: isoAgo(1) });
    expect(
      currentHealthOf(
        unprobed,
        traffic({ lastOkInWindowMs: ago(1), lastFailedInWindowMs: ago(3) }),
        NOW,
      ),
    ).toEqual({ status: 'working', basis: 'call', at: isoAgo(1) });
  });

  it('counts a recent failed probe as an outbound failure, and a degraded probe as a pass', () => {
    expect(currentHealthOf(probe('down', 1), NO_TRAFFIC, NOW)).toEqual({
      status: 'failing',
      basis: 'probe',
      at: isoAgo(1),
    });
    // Review of PR #75: *Passed with warnings* on the page is a pass on the row, never Failing.
    expect(currentHealthOf(probe('degraded', 1), NO_TRAFFIC, NOW)).toEqual({
      status: 'working',
      basis: 'probe',
      at: isoAgo(1),
    });
    expect(
      currentHealthOf(probe('degraded', 0.5), traffic({ lastFailedInWindowMs: ago(2) }), NOW)
        .status,
    ).toBe('working');
    // A passed probe after the failed call is the newest outbound evidence.
    expect(
      currentHealthOf(probe('ok', 0.5), traffic({ lastFailedInWindowMs: ago(2) }), NOW),
    ).toEqual({ status: 'working', basis: 'probe', at: isoAgo(0.5) });
  });

  it('names the newest evidence of any age when nothing is recent', () => {
    expect(
      currentHealthOf(
        probe('ok', 30 * 24),
        traffic({ lastCall: { atMs: ago(5 * 24), ok: false }, lastDeliveryMs: ago(10 * 24) }),
        NOW,
      ),
    ).toEqual({ status: 'not_checked_recently', basis: 'call', at: isoAgo(5 * 24) });
  });
});

describe('factsOf', () => {
  it('publishes the newest call and delivery as instants, and none as null', () => {
    const facts = factsOf(
      row(),
      traffic({ lastCall: { atMs: ago(1), ok: false }, lastDeliveryMs: ago(2) }),
      [],
      NOW,
    );
    expect(facts.activity).toEqual({
      last_call: { at: isoAgo(1), ok: false },
      last_delivery_at: isoAgo(2),
    });
    expect(factsOf(row(), NO_TRAFFIC, [], NOW).activity).toEqual({
      last_call: null,
      last_delivery_at: null,
    });
  });
});
