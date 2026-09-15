/**
 * Reading an integration's credential out of the process environment — TD-020's `_FILE` convention
 * (WP-21).
 *
 * The rest of this module writes rows and is asserted against a real PostgreSQL 18
 * (`test/integration/server/onboarding.integration.test.ts`); this part takes an environment and a
 * file reader as arguments precisely so the decisions in it can be held to a test without one.
 *
 * The decisions, and why each is a decision:
 *
 *  - **`_FILE` wins over the plain variable.** Docker's secrets convention mounts the file and
 *    leaves the plain name unset; a build that preferred the plain one would silently read a stale
 *    value in a deployment that set both.
 *  - **An empty value is a refusal.** Standing rule 18: an unset credential that produces a
 *    permissive result — here, an integration sealed with an empty token — is the defect.
 *  - **The refusal names the variable and never its value.** The name is the operator's own
 *    configuration and is what they have to fix; the message reaches a log and an HTTP response.
 */

import { createIntegrationEgressPolicy } from '@platform/application';
import type { JsonObject } from '@platform/contracts';
import type { ProviderCatalogueEntry } from '@platform/integrations';
import { SHIPPED_PROVIDERS } from '@platform/integrations';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../errors.js';
import {
  assertHostIsDeclared,
  assertNoCredentialInConfig,
  environmentSecretSource,
  ForbiddenSecretNameError,
  MissingSecretError,
} from './onboarding-queries.js';

/** Obviously fake (BD-002). */
const TOKEN = 'FAKE-token-not-a-real-secret-000001';

/** Declares whatever the environment names, so the allow-list is not the subject of these cases. */
const sourceFor = (
  env: NodeJS.ProcessEnv,
  files: Readonly<Record<string, string>> = {},
  allowed: readonly string[] = ['GITLAB_TOKEN'],
) =>
  environmentSecretSource(
    env,
    async (path) => {
      const value = files[path];
      if (value === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      return value;
    },
    allowed,
  );

describe('environmentSecretSource', () => {
  it('reads a plain environment variable', async () => {
    expect(await sourceFor({ GITLAB_TOKEN: TOKEN }).read('GITLAB_TOKEN')).toBe(TOKEN);
  });

  it('prefers the `_FILE` companion, which is how Docker secrets arrive', async () => {
    const source = sourceFor(
      { GITLAB_TOKEN: 'stale', GITLAB_TOKEN_FILE: '/run/secrets/gitlab' },
      { '/run/secrets/gitlab': `${TOKEN}\n` },
    );
    // …and the trailing newline a mounted file carries is trimmed, because a credential with one
    // is a credential every provider rejects.
    expect(await source.read('GITLAB_TOKEN')).toBe(TOKEN);
  });

  it('ignores an empty `_FILE` path and falls back to the plain variable', async () => {
    // An empty string is how a compose file spells "not set"; treating it as a path would make the
    // read fail on a deployment that only set the plain one.
    expect(
      await sourceFor({ GITLAB_TOKEN: TOKEN, GITLAB_TOKEN_FILE: '' }).read('GITLAB_TOKEN'),
    ).toBe(TOKEN);
  });

  it('refuses a `_FILE` that points at an empty file', async () => {
    const source = sourceFor(
      { GITLAB_TOKEN_FILE: '/run/secrets/gitlab' },
      {
        '/run/secrets/gitlab': '   \n',
      },
    );
    await expect(source.read('GITLAB_TOKEN')).rejects.toBeInstanceOf(MissingSecretError);
    await expect(source.read('GITLAB_TOKEN')).rejects.toThrow(/nothing in it/);
  });

  it('refuses an absent variable, naming it and both spellings', async () => {
    const source = sourceFor({});
    await expect(source.read('GITLAB_TOKEN')).rejects.toBeInstanceOf(MissingSecretError);
    await expect(source.read('GITLAB_TOKEN')).rejects.toThrow(/GITLAB_TOKEN_FILE/);
  });

  it('refuses an empty variable, because an empty credential is not a credential', async () => {
    await expect(sourceFor({ GITLAB_TOKEN: '' }).read('GITLAB_TOKEN')).rejects.toBeInstanceOf(
      MissingSecretError,
    );
  });

  it('never puts the value in the refusal', async () => {
    // The message reaches a log and an HTTP response. A refusal quoting what it read would be the
    // leak the whole `secret_refs` design exists to avoid.
    const source = sourceFor({ GITLAB_TOKEN_FILE: '/missing' });
    await expect(source.read('GITLAB_TOKEN')).rejects.toThrow();
    try {
      await sourceFor({ GITLAB_TOKEN: '' }).read('GITLAB_TOKEN');
    } catch (error) {
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  it('refuses a name the operator has not declared, whatever the environment holds', async () => {
    /**
     * The finding this parameter exists for: `secret_refs` names come from an HTTP body written by
     * an `integration.write` caller, so without an allow-list that caller can have the platform
     * seal **its own** secret into a row a provider adapter is then built with — and a provider's
     * `base_url` is caller-chosen too.
     *
     * All three platform names are planted **with values**, so a source that read the environment
     * before checking the list would return them and fail here (standing rule 3: mutation-check the
     * guard — deleting the check makes this case fail by name).
     */
    const planted = {
      APP_SECRET_KEY: 'FAKE-envelope-key-not-a-real-secret-0000',
      DATABASE_URL: 'postgres://app:FAKE-not-a-real-password@db:5432/app',
      ANTHROPIC_API_KEY: 'FAKE-model-credential-not-a-real-secret',
      GITLAB_TOKEN: TOKEN,
    };
    const source = sourceFor(planted, {}, ['GITLAB_TOKEN']);
    for (const name of ['APP_SECRET_KEY', 'DATABASE_URL', 'ANTHROPIC_API_KEY']) {
      await expect(source.read(name), name).rejects.toBeInstanceOf(ForbiddenSecretNameError);
    }
    // The other direction (rule 42): the declared name still works, so the guard is not "refuse
    // everything".
    expect(await source.read('GITLAB_TOKEN')).toBe(TOKEN);
  });

  it('refuses everything when the operator declared nothing, which is the default', async () => {
    const source = sourceFor({ GITLAB_TOKEN: TOKEN }, {}, []);
    await expect(source.read('GITLAB_TOKEN')).rejects.toBeInstanceOf(ForbiddenSecretNameError);
    await expect(source.read('GITLAB_TOKEN')).rejects.toThrow(/APP_INTEGRATION_SECRET_ENV/);
  });

  it('does not say whether an undeclared variable exists', async () => {
    // The refusal must not be an oracle for the process's environment: a caller that could tell
    // "not declared" from "declared but unset" could walk names and learn what the platform holds.
    const withValue = sourceFor({ APP_SECRET_KEY: 'FAKE-value' }, {}, []);
    const without = sourceFor({}, {}, []);
    const message = async (source: ReturnType<typeof sourceFor>): Promise<string> => {
      try {
        await source.read('APP_SECRET_KEY');
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('expected a refusal');
    };
    expect(await message(withValue)).toBe(await message(without));
    expect(await message(withValue)).not.toContain('FAKE-value');
  });

  it('permits the `_FILE` companion of a declared name and not of an undeclared one', async () => {
    // TD-020's convention applies to the **declared** name, so `APP_SECRET_KEY_FILE` is unreadable
    // unless an operator declares `APP_SECRET_KEY` — which they would have to type on purpose.
    const source = sourceFor(
      { GITLAB_TOKEN_FILE: '/run/secrets/gitlab', APP_SECRET_KEY_FILE: '/run/secrets/app' },
      { '/run/secrets/gitlab': TOKEN, '/run/secrets/app': 'FAKE-envelope-key' },
      ['GITLAB_TOKEN'],
    );
    expect(await source.read('GITLAB_TOKEN')).toBe(TOKEN);
    await expect(source.read('APP_SECRET_KEY')).rejects.toBeInstanceOf(ForbiddenSecretNameError);
    await expect(source.read('APP_SECRET_KEY_FILE')).rejects.toBeInstanceOf(
      ForbiddenSecretNameError,
    );
  });
});

describe('assertNoCredentialInConfig', () => {
  /**
   * Every shipped provider, not one of them (standing rule 68: the rule is parameterised over
   * `secretFields`, so the test is parameterised over the same set). A provider whose credential
   * fields change is covered the moment its registration does.
   */
  const shipped = SHIPPED_PROVIDERS.filter((entry) => entry.secretFields.length > 0);

  it('covers every shipped provider that declares a credential field', () => {
    // The scope, asserted before anything is concluded from it (standing rule 4).
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.map((entry) => entry.id)).toContain('gitlab');
  });

  it.each(shipped.map((entry) => [entry.id, entry] as const))(
    'refuses %s’s credential field in `config`',
    (_id, provider: ProviderCatalogueEntry) => {
      for (const field of provider.secretFields) {
        try {
          assertNoCredentialInConfig({ [field]: TOKEN }, provider);
          expect.unreachable(`${provider.id}.${field} must not be storable in config`);
        } catch (error) {
          expect(error).toBeInstanceOf(HttpError);
          expect((error as HttpError).statusCode).toBe(400);
          expect((error as HttpError).code).toBe('credential_in_config');
          // The key names, never the value the caller sent.
          expect((error as HttpError).message).toContain(field);
          expect((error as HttpError).message).not.toContain(TOKEN);
          // …and it names where the value belongs instead.
          expect((error as HttpError).message).toContain('secret_refs');
        }
      }
    },
  );

  it.each(shipped.map((entry) => [entry.id, entry] as const))(
    'accepts %s’s non-secret configuration, including the same value under another key',
    (_id, provider: ProviderCatalogueEntry) => {
      // The other direction (rule 42): a guard that refused every config would pass the cases
      // above. The *value* is identical — what is refused is the key, not what it looks like.
      expect(() =>
        assertNoCredentialInConfig({ base_url: 'https://example.test', project: TOKEN }, provider),
      ).not.toThrow();
      expect(() => assertNoCredentialInConfig({}, provider)).not.toThrow();
    },
  );

  it('names every offending key at once rather than the first', () => {
    const provider = shipped.find((entry) => entry.secretFields.length > 1);
    if (provider === undefined) {
      // GitLab declares three today; if no provider declares two the case has nothing to say.
      return;
    }
    const config = Object.fromEntries(provider.secretFields.map((field) => [field, TOKEN]));
    try {
      assertNoCredentialInConfig(config, provider);
      expect.unreachable('a config of nothing but credentials must be refused');
    } catch (error) {
      for (const field of provider.secretFields) {
        expect((error as HttpError).message).toContain(field);
      }
    }
  });
});

/**
 * **The write-time half of the egress allow-list** (WP-51, PROGRESS backlog 48).
 *
 * The call-time half is `IntegrationActionExecutor`'s and is asserted there and on the integration
 * tier; this is the refusal an operator meets at the moment they configure the binding, with the
 * host and the setting in it.
 *
 * Rule 43 chooses the negatives: `evil.example.com` is refused by every candidate implementation,
 * so the cases that carry weight are the adjacent ones. Rule 14 chooses the last two: the body
 * reaches this function as `jsonObjectSchema`, so a value that `tsc` would never allow — a number,
 * a nested document — is exactly what a JavaScript-shaped request can carry, and the guard is a
 * runtime walk rather than a type.
 */
describe('assertHostIsDeclared', () => {
  const declared = createIntegrationEgressPolicy(['gitlab.example.com']);
  const refuse = (config: JsonObject, policy = declared): HttpError | null => {
    try {
      assertHostIsDeclared(config, policy);
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      return error as HttpError;
    }
  };

  it('accepts a config whose URL names a declared host', () => {
    expect(refuse({ base_url: 'https://gitlab.example.com', project: 'acme/api' })).toBeNull();
  });

  it.each([
    ['a hyphen-prefixed neighbour', 'https://evil-gitlab.example.com'],
    ['a suffixed neighbour', 'https://gitlab.example.com.evil.test'],
    ['a prefixed neighbour', 'https://xgitlab.example.com'],
    ['an unrelated host', 'https://evil.example.com'],
  ])('refuses %s with 403 integration_host_not_permitted', (_name, url) => {
    const error = refuse({ base_url: url });

    expect(error?.statusCode).toBe(403);
    expect(error?.code).toBe('integration_host_not_permitted');
  });

  it('names the host and the setting, so the operator knows what to change', () => {
    const error = refuse({ base_url: 'https://evil-gitlab.example.com' });

    expect(error?.message).toContain('evil-gitlab.example.com');
    expect(error?.message).toContain('APP_INTEGRATION_HOSTS');
  });

  it('refuses every host when nothing is declared, which is the shipped default', () => {
    // Rule 18: the empty list is the closed one. If this passes, a stock instance admits any host.
    expect(
      refuse({ base_url: 'https://gitlab.example.com' }, createIntegrationEgressPolicy([])),
    ).not.toBeNull();
  });

  it('accepts everything when an operator declared the list open', () => {
    expect(
      refuse({ base_url: 'https://anywhere.example.test' }, createIntegrationEgressPolicy(['*'])),
    ).toBeNull();
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,x'],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['file', 'file:///etc/passwd'],
  ])('refuses the %s scheme even under an open list (Q49)', (_name, url) => {
    // This route never runs the provider's own schema over `config`, so `httpUrlSchema` is not the
    // guard here — measured, not assumed (rule 47). Without this check the row would be stored and
    // the refusal would arrive at the binding loader, screens later.
    const error = refuse({ base_url: url }, createIntegrationEgressPolicy(['*']));

    expect(error?.statusCode).toBe(403);
  });

  it('leaves alone every config string that is not a URL', () => {
    // The five shipped schemas' other string fields, measured: none parses as an absolute URL, so
    // the sweep costs no false refusal. A guard that fires on legitimate content gets switched off.
    expect(
      refuse({
        project: 'acme/api',
        organization: 'acme-example',
        channel: '#agentic',
        team_id: 'T0FAKETEAM',
        user_email: 'bot@example.test',
        pickup_label: 'agentic',
        tenant_id: 'tenant-1',
      }),
    ).toBeNull();
  });

  it('walks nested objects and arrays, because `config` is an opaque JSON document', () => {
    expect(refuse({ nested: { base_url: 'https://evil.example.com' } })).not.toBeNull();
    expect(
      refuse({ mirrors: ['https://gitlab.example.com', 'https://evil.example.com'] }),
    ).not.toBeNull();
    expect(refuse({ mirrors: ['https://gitlab.example.com'] })).toBeNull();
  });

  it('ignores non-string values rather than throwing on them', () => {
    // A JavaScript-shaped body carries whatever JSON allows; the guard is about URLs and must not
    // turn a number into a 500 on the way to the schema that will refuse it properly.
    expect(refuse({ max_pages: 10, mint_credentials: false, project: null })).toBeNull();
  });
});
