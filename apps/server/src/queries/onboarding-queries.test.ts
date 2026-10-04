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

import { readFileSync } from 'node:fs';
import { createIntegrationEgressPolicy } from '@platform/application';
import type { JsonObject } from '@platform/contracts';
import type { ProviderCatalogueEntry } from '@platform/integrations';
import { SHIPPED_PROVIDERS } from '@platform/integrations';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../errors.js';
import { storedConfigRefusal } from './integration-queries.js';
import {
  assertBindingConfigsParse,
  assertConfigParses,
  assertHostIsDeclared,
  assertNoAccountOnlyFields,
  assertNoCredentialInConfig,
  assertStaticIntegrationBindable,
  createIntegration,
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

/**
 * **The two allow-list refusals say recreate, and the operator guide quotes them as they are** —
 * WP-132, PROGRESS backlog 428.
 *
 * Both settings are read at start-up, and under compose `docker compose restart` keeps a container's
 * old environment (measured, the `RECREATE_TO_APPLY_SETTING` docblock), so a refusal that said
 * "restart the process" sent an operator round the loop once more. The guide quotes each message
 * (§ 4); the comparison is whitespace-normalised, because the guide wraps a long quotation.
 */
describe('the allow-list refusals and the guide that quotes them (WP-132)', () => {
  const guide = readFileSync(
    new URL('../../../../docs/operator-guide.md', import.meta.url),
    'utf8',
  ).replace(/\s+/g, ' ');
  const tailOf = (message: string): string => {
    const at = message.indexOf('Add it to');
    expect(at, message).toBeGreaterThan(0);
    return message.slice(at).replace(/\s+/g, ' ');
  };

  it('the credential-name refusal says recreate, and the guide quotes it verbatim', async () => {
    const refusal = await sourceFor({}, {}, [])
      .read('GITLAB_TOKEN')
      .then(
        () => null,
        (error: unknown) => (error as Error).message,
      );
    const tail = tailOf(refusal ?? '');
    expect(tail).toContain('recreate');
    expect(tail).toContain('docker compose up -d');
    expect(tail).not.toContain('restart the process');
    expect(guide).toContain(tail);
  });

  it('the host refusal says recreate, and the guide quotes it verbatim', () => {
    const verdict = createIntegrationEgressPolicy([]).check('https://gitlab.example.com');
    expect(verdict.allowed).toBe(false);
    const tail = tailOf(verdict.allowed ? '' : verdict.message);
    expect(tail).toContain('recreate');
    expect(tail).not.toContain('restart the process');
    expect(guide).toContain(tail);
  });

  it('the guide no longer tells an operator to restart for either setting', () => {
    expect(guide).not.toContain('and restart the process');
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

/**
 * WP-73b, PROGRESS backlog 201: a key only the account decides is refused on a binding, by name —
 * Slack's `socket_mode`, which the held connection reads off `integrations.config` alone.
 */
describe('assertNoAccountOnlyFields', () => {
  const SLACK_ID = '00000000-0000-4000-8000-0000000000e1';
  const known = [{ id: SLACK_ID, provider: 'slack' }];

  it('refuses socket_mode on a Slack binding, naming the field and where it lives', () => {
    expect(() =>
      assertNoAccountOnlyFields(
        [{ integrationId: SLACK_ID, config: { socket_mode: false } }],
        known,
      ),
    ).toThrow(/socket_mode is set on the slack integration .* never on a project's binding/);
  });

  it('accepts a Slack binding that leaves it to the account, and a provider with no such field', () => {
    expect(() =>
      assertNoAccountOnlyFields(
        [{ integrationId: SLACK_ID, config: { channel: 'C0FAKE' } }, { integrationId: SLACK_ID }],
        known,
      ),
    ).not.toThrow();
    expect(() =>
      assertNoAccountOnlyFields(
        [{ integrationId: 'gitlab-1', config: { socket_mode: false } }],
        [{ id: 'gitlab-1', provider: 'gitlab' }],
      ),
    ).not.toThrow();
  });

  /** WP-137 (TD-028 decision 13 item 1): a static run credential is the integration's, never a binding's. */
  it('refuses run_credential on a GitLab binding, so no project switches its account to static', () => {
    expect(() =>
      assertNoAccountOnlyFields(
        [{ integrationId: 'gitlab-1', config: { run_credential: 'static' } }],
        [{ id: 'gitlab-1', provider: 'gitlab' }],
      ),
    ).toThrow(/run_credential is set on the gitlab integration .* never on a project's binding/);
  });
});

/**
 * WP-73b, PROGRESS backlog 245 (review round 1): the write-time default sweep at the unit tier. The
 * host guard runs before the create touches the database, so a database that answers nothing is
 * enough — a create that got past the guard would fail on it, which is a different error.
 */
describe('createIntegration and a provider’s defaulted base_url', () => {
  const defaulted = SHIPPED_PROVIDERS.filter(
    (entry) => entry.id === 'sentry' || entry.id === 'slack',
  );

  it('has the two providers whose base_url has a default, so the cases below run', () => {
    expect(defaulted.map((entry) => entry.id).toSorted()).toEqual(['sentry', 'slack']);
  });

  it.each(defaulted.map((entry) => [entry.id, entry] as const))(
    'refuses a %s body with no base_url when only another host is declared',
    async (id, provider) => {
      const failure = await createIntegration({} as never, {
        orgId: 'org-1',
        integration: {
          type: provider.type,
          provider: id,
          name: `${id} defaulted`,
          config: {},
          secretRefs: {},
        },
        provider,
        egress: createIntegrationEgressPolicy([`${id}.example.test`]),
        secretSource: { read: async () => 'unused' } as never,
        secretKey: {} as never,
        newId: () => 'id-1',
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(HttpError);
      expect((failure as HttpError).code).toBe('integration_host_not_permitted');
    },
  );
});

/**
 * WP-100, PROGRESS backlog 328, criterion 1 at the unit tier: the create parses `config` with the
 * provider's schema **before** it touches the database — the database here answers nothing, so a
 * create that got past the parse would fail on it with a different error. One case per shipped
 * provider, read off the catalogue, so a sixth provider is covered the day it exists; the smallest
 * valid document is the control (standing rule 42).
 */
const VALID_CONFIG: Readonly<Record<string, JsonObject>> = {
  gitlab: { base_url: 'https://gitlab.example.test' },
  'jira-cloud': { site_url: 'https://acme.atlassian.example.test', user_email: 'ops@example.test' },
  loki: { base_url: 'https://loki.example.test' },
  sentry: { organization: 'acme', base_url: 'https://sentry.example.test' },
  slack: { channel: '#agentic', base_url: 'https://slack.example.test' },
};

describe('createIntegration and the provider’s schema (backlog 328)', () => {
  const create = (provider: ProviderCatalogueEntry, config: JsonObject) =>
    createIntegration({} as never, {
      orgId: 'org-1',
      integration: {
        type: provider.type,
        provider: provider.id,
        name: 'x',
        config,
        secretRefs: {},
      },
      provider,
      egress: createIntegrationEgressPolicy(['*']),
      secretSource: { read: async () => 'unused' } as never,
      secretKey: {} as never,
      newId: () => 'id-1',
    }).catch((error: unknown) => error);

  it('has a valid document for every shipped provider', () => {
    expect(Object.keys(VALID_CONFIG).sort()).toEqual(SHIPPED_PROVIDERS.map((entry) => entry.id));
  });

  it.each(SHIPPED_PROVIDERS.map((entry) => [entry.id, entry] as const))(
    'refuses a %s create with config {} as 400 naming each required path, before any write',
    async (_id, provider) => {
      const failure = await create(provider, {});
      expect(failure).toBeInstanceOf(HttpError);
      const error = failure as HttpError;
      expect(`${error.statusCode} ${error.code}`).toBe('400 invalid_integration_config');
      const required = provider.configFields.filter((f) => f.required).map((f) => f.name);
      expect(required.length).toBeGreaterThan(0);
      expect(error.details?.map((detail) => detail.path)).toEqual(required);
      for (const path of required) {
        expect(error.message).toContain(path);
      }
    },
  );

  it.each(SHIPPED_PROVIDERS.map((entry) => [entry.id, entry] as const))(
    'passes a valid %s document on to the database',
    async (id, provider) => {
      // Past the parse, the empty database is the next thing the create meets.
      const failure = await create(provider, VALID_CONFIG[id] as JsonObject);
      expect(failure).not.toBeInstanceOf(HttpError);
      expect(failure).toBeInstanceOf(TypeError);
    },
  );

  it('names an undeclared key, and never quotes a value', () => {
    const gitlab = SHIPPED_PROVIDERS.find(
      (entry) => entry.id === 'gitlab',
    ) as ProviderCatalogueEntry;
    try {
      assertConfigParses({ host: 'https://FAKE-value-never-quoted.example.test' }, gitlab);
      expect.unreachable('the operator guide’s old body must be refused');
    } catch (error) {
      expect((error as HttpError).details?.map((detail) => detail.path).sort()).toEqual([
        'base_url',
        'host',
      ]);
      expect((error as HttpError).message).not.toContain('FAKE-value-never-quoted');
    }
  });
});

describe('a binding’s effective configuration (WP-100)', () => {
  const SENTRY_ID = '00000000-0000-4000-8000-0000000000e2';
  const egress = createIntegrationEgressPolicy(['sentry.example.test']);
  const account = (config: JsonObject) => [{ id: SENTRY_ID, provider: 'sentry', config }];

  it('accepts an overlay over an account that parses', () => {
    expect(() =>
      assertBindingConfigsParse(
        [{ integrationId: SENTRY_ID, config: { max_issues: 5 } }],
        account(VALID_CONFIG.sentry as JsonObject),
        egress,
      ),
    ).not.toThrow();
  });

  it('refuses an overlay the schema refuses, naming the path', () => {
    try {
      assertBindingConfigsParse(
        [{ integrationId: SENTRY_ID, config: { organization: 'Not A Slug' } }],
        account(VALID_CONFIG.sentry as JsonObject),
        egress,
      );
      expect.unreachable('a slug the schema refuses must be refused at the write');
    } catch (error) {
      expect(`${(error as HttpError).statusCode} ${(error as HttpError).code}`).toBe(
        '400 invalid_binding_config',
      );
      expect((error as HttpError).details?.map((detail) => detail.path)).toEqual(['organization']);
    }
  });

  it('refuses a credential field in an overlay by its name, never its value (backlog 330)', () => {
    const token = 'sntrys_FAKE-binding-overlay-token-0001';
    try {
      assertBindingConfigsParse(
        [{ integrationId: SENTRY_ID, config: { auth_token: token } }],
        account(VALID_CONFIG.sentry as JsonObject),
        egress,
      );
      expect.unreachable('a credential in a binding overlay must be refused');
    } catch (error) {
      expect(`${(error as HttpError).statusCode} ${(error as HttpError).code}`).toBe(
        '400 credential_in_config',
      );
      expect((error as HttpError).message).toContain('auth_token');
      expect((error as HttpError).message).not.toContain(token);
    }
  });

  it('refuses an overlay URL on an undeclared host', () => {
    expect(() =>
      assertBindingConfigsParse(
        [{ integrationId: SENTRY_ID, config: { base_url: 'https://evil.example.test' } }],
        account(VALID_CONFIG.sentry as JsonObject),
        egress,
      ),
    ).toThrow(expect.objectContaining({ code: 'integration_host_not_permitted' }));
  });

  it('names the account, and its PATCH, when the account is what no longer parses', () => {
    expect(() =>
      assertBindingConfigsParse([{ integrationId: SENTRY_ID }], account({}), egress),
    ).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: 'invalid_integration_config',
        message: expect.stringContaining(`PATCH /api/integrations/${SENTRY_ID}`),
      }),
    );
  });

  it('leaves a provider this build does not ship alone', () => {
    expect(() =>
      assertBindingConfigsParse(
        [{ integrationId: 'fake-1', config: { anything: true } }],
        [{ id: 'fake-1', provider: 'fake-git', config: {} }],
        egress,
      ),
    ).not.toThrow();
  });
});

describe('storedConfigRefusal (WP-100, criterion 4)', () => {
  const sentry = SHIPPED_PROVIDERS.find((entry) => entry.id === 'sentry') as ProviderCatalogueEntry;
  const ID = '00000000-0000-4000-8000-0000000000e3';

  it('names the paths and the PATCH for a row written before the create parsed', () => {
    // The wizard e2e's old body (backlog 328): British `organisation`.
    const refusal = storedConfigRefusal(ID, { organisation: 'acme' }, sentry);
    expect(refusal?.code).toBe('invalid_integration_config');
    expect(refusal?.paths.sort()).toEqual(['organisation', 'organization']);
    expect(refusal?.message).toContain(`PATCH /api/integrations/${ID}`);
  });

  it('is null for a row that parses and for a provider this build does not ship', () => {
    expect(storedConfigRefusal(ID, VALID_CONFIG.sentry as JsonObject, sentry)).toBeNull();
    expect(storedConfigRefusal(ID, {}, undefined)).toBeNull();
  });
});

/**
 * WP-137 (TD-028 decision 13 item 1) at the unit tier: a create that declares a static run
 * credential is refused, by name, **before** the database — which answers nothing here — when the
 * run token is missing, is the API token, or has an expiry passed or too far ahead; a valid
 * declaration gets past the check (and then fails on the absent database, a different error).
 */
describe('createIntegration and a static run credential (WP-137)', () => {
  const gitlab = SHIPPED_PROVIDERS.find((entry) => entry.id === 'gitlab') as ProviderCatalogueEntry;
  const VALUES: Readonly<Record<string, string>> = {
    API: 'glpat-FAKE-unit-api-token-not-real-000',
    RUN: 'glpat-FAKE-unit-run-token-not-real-000',
  };
  // The `(org, type, name)` lookup finds nothing; the transaction after the check does not exist.
  const database = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  } as never;
  const create = (config: JsonObject, secretRefs: Readonly<Record<string, string>>) =>
    createIntegration(database, {
      orgId: 'org-1',
      integration: { type: 'git', provider: 'gitlab', name: 'static', config, secretRefs },
      provider: gitlab,
      egress: createIntegrationEgressPolicy(['gitlab.example.test']),
      secretSource: { read: async (name: string) => VALUES[name] ?? '' } as never,
      secretKey: { keyId: 'k1', key: Buffer.alloc(32, 1) } as never,
      newId: () => '00000000-0000-4000-8000-000000000001',
      now: new Date('2026-10-03T12:00:00.000Z'),
    }).catch((error: unknown) => error);
  const STATIC: JsonObject = {
    base_url: 'https://gitlab.example.test',
    run_credential: 'static',
    run_token_username: 'agentic-runner',
    run_token_expires_at: '2026-12-01',
  };

  it.each([
    ['no run token', STATIC, { token: 'API' }, /needs the run token itself/],
    ['the API token as the run token', STATIC, { token: 'API', run_token: 'API' }, /own API token/],
    [
      'an expiry passed',
      { ...STATIC, run_token_expires_at: '2026-10-02' },
      { token: 'API', run_token: 'RUN' },
      /has passed/,
    ],
    [
      'an expiry too far',
      { ...STATIC, run_token_expires_at: '2027-02-01' },
      { token: 'API', run_token: 'RUN' },
      /more than 90 days/,
    ],
  ])('refuses %s before the database, naming the field', async (_case, config, refs, message) => {
    const failure = await create(config as JsonObject, refs);
    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).code).toBe('run_credential_refused');
    expect((failure as HttpError).message).toMatch(message);
    expect(JSON.stringify(failure)).not.toContain(VALUES.API);
  });

  it('lets a valid declaration past the check, and a minted one is never asked', async () => {
    for (const config of [STATIC, { base_url: 'https://gitlab.example.test' }]) {
      const failure = await create(config, { token: 'API', run_token: 'RUN' });
      expect((failure as HttpError).code).not.toBe('run_credential_refused');
    }
  });
});

/**
 * WP-137 (TD-028 decision 13 item 1): a static integration is bound by one project. The statement
 * order is asserted — the advisory lock first, then the read — and the count decides.
 */
describe('assertStaticIntegrationBindable (WP-137)', () => {
  const txWith = (bound: readonly string[]) => {
    const statements: number[] = [];
    const tx = {
      execute: async () => {
        statements.push(statements.length);
        return { rows: statements.length === 1 ? [] : bound.map((project_id) => ({ project_id })) };
      },
    } as never;
    return { tx, statements };
  };

  it('admits the first binding and a re-submission of the same project', async () => {
    const { tx, statements } = txWith([]);
    await expect(assertStaticIntegrationBindable(tx, 'i-1', 'p-1', 1)).resolves.toBeUndefined();
    expect(statements).toHaveLength(2);
  });

  it('refuses a second project, naming the one that binds it', async () => {
    const failure = await assertStaticIntegrationBindable(
      txWith(['p-1']).tx,
      'i-1',
      'p-2',
      1,
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ statusCode: 409, code: 'static_run_credential_shared' });
    expect((failure as HttpError).message).toContain('p-1');
  });

  it('refuses a PATCH into static of an integration two projects bind, and admits one', async () => {
    await expect(
      assertStaticIntegrationBindable(txWith(['p-1', 'p-2']).tx, 'i-1', null, 0),
    ).rejects.toMatchObject({ code: 'static_run_credential_shared' });
    await expect(
      assertStaticIntegrationBindable(txWith(['p-1']).tx, 'i-1', null, 0),
    ).resolves.toBeUndefined();
  });
});
