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
import { describe, expect, it } from 'vitest';
import { healthOf, type IntegrationRow, publishableConfig } from './integration-queries.js';
import { UnprojectableRowError } from './pipeline-queries.js';

const PLANTED_TOKEN = 'FAKE-gitlab-token-DO-NOT-USE-0123456789';

const row = (overrides: Partial<IntegrationRow> = {}): IntegrationRow => ({
  id: '0199aa11-2b3c-7d4e-8f90-000000000001',
  type: 'git',
  provider: 'gitlab',
  name: 'acme gitlab',
  config: {},
  health: {},
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
