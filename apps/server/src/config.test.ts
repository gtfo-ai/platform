import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadServerConfig,
  POOL_RESERVATIONS,
  requiredPoolConnections,
  SERVER_CONFIG_DEFAULTS,
  type ServerConfig,
  UndersizedPoolError,
} from './config.js';

/** The smallest environment that parses. Everything else in these tests is an override. */
const MINIMAL = {
  DATABASE_URL: 'postgres://app:app@db:5432/app',
  APP_SECRET_KEY: 'x'.repeat(40),
} as const;

const load = (overrides: Record<string, string | undefined> = {}): ServerConfig =>
  loadServerConfig({ ...MINIMAL, ...overrides });

describe('loadServerConfig', () => {
  it('applies the documented defaults', () => {
    const config = load();
    expect(config.role).toBe('all');
    expect(config.port).toBe(SERVER_CONFIG_DEFAULTS.port);
    expect(config.baseUrl).toBe(SERVER_CONFIG_DEFAULTS.baseUrl);
    expect(config.logFormat).toBe('json');
    expect(config.timezone).toBe('UTC');
    expect(config.ssePingIntervalMs).toBe(20_000);
    expect(config.sseRetryMs).toBe(1_000);
    // Open registration is off unless an operator asks for it.
    expect(config.allowSignUp).toBe(false);
    // And no environment variable is readable as an integration credential until an operator
    // declares one: the name is caller-chosen, so the empty default is the security property
    // (`queries/onboarding-queries.ts` carries the argument).
    expect(config.integrationSecretEnv).toEqual([]);
    // …and no host is dialable until an operator declares one, for the same reason one ring out:
    // the `base_url` is caller-chosen too, so an empty list is the closed one (WP-51, rule 18).
    expect(config.integrationHosts).toEqual([]);
  });

  it('reads the provider host allow-list as a list, keeping the wildcard and dropping a non-host', () => {
    expect(
      load({ APP_INTEGRATION_HOSTS: ' GitLab.com , acme.atlassian.net ,gitlab.com' })
        .integrationHosts,
    ).toEqual(['gitlab.com', 'acme.atlassian.net']);
    // `*` is a legal entry **here** — it is how an operator declares the list open — and the two
    // parsers differ on exactly that: an `APP_INTEGRATION_SECRET_ENV` entry of `*` is dropped
    // (asserted below), because "read any variable" is not a posture the platform offers.
    expect(load({ APP_INTEGRATION_HOSTS: '*' }).integrationHosts).toEqual(['*']);
    // A value that is not a host is dropped rather than admitted: admitting `https://gitlab.com/`
    // as a host name would make the comparison never match, which reads as "the provider is down".
    expect(
      load({ APP_INTEGRATION_HOSTS: 'gitlab.com,https://evil.test/,not a host, ' })
        .integrationHosts,
    ).toEqual(['gitlab.com']);
  });

  it('reads the integration credential allow-list as a list, and drops what cannot be a name', () => {
    expect(
      load({ APP_INTEGRATION_SECRET_ENV: ' GITLAB_TOKEN , JIRA_API_TOKEN ,GITLAB_TOKEN' })
        .integrationSecretEnv,
    ).toEqual(['GITLAB_TOKEN', 'JIRA_API_TOKEN']);
    // An entry that cannot be an environment variable name is dropped rather than admitted: this
    // is an allow-list, so the failure direction that matters is letting something in.
    expect(
      load({ APP_INTEGRATION_SECRET_ENV: 'GITLAB_TOKEN,not a name,*,' }).integrationSecretEnv,
    ).toEqual(['GITLAB_TOKEN']);
  });

  it('refuses a missing secret rather than inventing one', () => {
    expect(() => loadServerConfig({ DATABASE_URL: MINIMAL.DATABASE_URL })).toThrow(
      /APP_SECRET_KEY.*at least 32 characters/s,
    );
  });

  it('refuses a short secret', () => {
    expect(() => load({ APP_SECRET_KEY: 'too-short' })).toThrow(/APP_SECRET_KEY/);
  });

  it('reads a secret from its _FILE variant, the Docker secrets convention', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp06-config-'));
    const file = join(directory, 'secret');
    writeFileSync(file, `${'y'.repeat(40)}\n`);
    const config = loadServerConfig({
      DATABASE_URL: MINIMAL.DATABASE_URL,
      APP_SECRET_KEY_FILE: file,
    });
    // The trailing newline an operator's editor adds is not part of the secret.
    expect(config.secretKey).toBe('y'.repeat(40));
  });

  it('reports every offending variable in one error, not the first one', () => {
    let message = '';
    try {
      load({ ROLE: 'wizard', PORT: 'eighty', LOG_FORMAT: 'yaml' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('ROLE');
    expect(message).toContain('PORT');
    expect(message).toContain('LOG_FORMAT');
  });

  it('names the sub-loader’s variable when the database configuration is wrong', () => {
    expect(() => load({ APP_DB_POOL_MAX: 'lots' })).toThrow(/APP_DB_POOL_MAX/);
  });

  it('reads a boolean the way an operator writes one, and rejects a typo', () => {
    expect(load({ APP_ALLOW_SIGNUP: 'TRUE' }).allowSignUp).toBe(true);
    expect(load({ APP_ALLOW_SIGNUP: 'on' }).allowSignUp).toBe(true);
    expect(load({ APP_ALLOW_SIGNUP: 'no' }).allowSignUp).toBe(false);
    // A typo in a security flag must not quietly read as "off".
    expect(() => load({ APP_ALLOW_SIGNUP: 'ture' })).toThrow(/APP_ALLOW_SIGNUP/);
  });

  it('needs both halves of the metrics credential or neither', () => {
    expect(() => load({ APP_METRICS_USERNAME: 'prom' })).toThrow(/APP_METRICS_PASSWORD/);
    expect(() => load({ APP_METRICS_PASSWORD: 'fake' })).toThrow(/APP_METRICS_USERNAME/);
    expect(load({ APP_METRICS_USERNAME: 'prom', APP_METRICS_PASSWORD: 'fake' })).toMatchObject({
      metricsUsername: 'prom',
      metricsPassword: 'fake',
    });
    expect(load().metricsUsername).toBeNull();
  });

  it('needs a password for the bootstrap administrator it is asked to create', () => {
    expect(() => load({ APP_BOOTSTRAP_ADMIN_EMAIL: 'op@example.test' })).toThrow(
      /APP_BOOTSTRAP_ADMIN_PASSWORD/,
    );
    expect(
      load({
        APP_BOOTSTRAP_ADMIN_EMAIL: 'op@example.test',
        APP_BOOTSTRAP_ADMIN_PASSWORD: 'a-fake-password-1234',
      }).bootstrapAdminEmail,
    ).toBe('op@example.test');
  });

  it('refuses an SSE drain that does not fit inside the shutdown budget', () => {
    // Both bounds accept up to 600 000 on their own, so nothing stopped the step from being given
    // the whole budget its own container is bounded by — and then the dispatcher drain, pg-boss
    // and the pool behind it get nothing at all.
    expect(() =>
      load({ APP_SSE_SHUTDOWN_DRAIN_MS: '30000', APP_SHUTDOWN_TIMEOUT_MS: '30000' }),
    ).toThrow(/APP_SSE_SHUTDOWN_DRAIN_MS must be less than APP_SHUTDOWN_TIMEOUT_MS/);
    expect(() =>
      load({ APP_SSE_SHUTDOWN_DRAIN_MS: '60000', APP_SHUTDOWN_TIMEOUT_MS: '30000' }),
    ).toThrow(/APP_SSE_SHUTDOWN_DRAIN_MS must be less than APP_SHUTDOWN_TIMEOUT_MS/);
    expect(
      load({ APP_SSE_SHUTDOWN_DRAIN_MS: '29999', APP_SHUTDOWN_TIMEOUT_MS: '30000' })
        .sseShutdownDrainMs,
    ).toBe(29_999);
    // The shipped defaults have to satisfy their own rule.
    expect(SERVER_CONFIG_DEFAULTS.sseShutdownDrainMs).toBeLessThan(
      SERVER_CONFIG_DEFAULTS.shutdownTimeoutMs,
    );
  });

  it('rejects an APP_BASE_URL that is not a URL', () => {
    expect(() => load({ APP_BASE_URL: 'localhost:8080' })).toThrow(/APP_BASE_URL/);
  });
});

/**
 * The three fields WP-15g added, and the rule-18 claim their docblocks make.
 *
 * A claim in a comment is not evidence it holds (standing rule 3), and this one is about a credential:
 * *an empty credential is not a credential* (rule 18). The absent case and the empty case must not be
 * spelled the same way either — an empty `ANTHROPIC_API_KEY` would otherwise build a redactor over
 * `''`, which `exactSecretRedactor` refuses at `MIN_SECRET_LENGTH`, and hand the CLI a key that fails
 * authentication for a reason nobody can trace back to configuration.
 */
describe('the agent run’s provider configuration', () => {
  it('defaults to api mode with no credential and no binary', () => {
    const config = load();
    expect(config.providerMode).toBe('api');
    // `null`, not `''`: the runner composition asks "is there a credential", and empty is not one.
    expect(config.modelApiKey).toBeNull();
    expect(config.claudeBinary).toBeNull();
  });

  it('reads a blank or whitespace-only credential as absent rather than as empty', () => {
    expect(load({ ANTHROPIC_API_KEY: '' }).modelApiKey).toBeNull();
    expect(load({ ANTHROPIC_API_KEY: '   ' }).modelApiKey).toBeNull();
    expect(load({ APP_CLAUDE_BINARY: '' }).claudeBinary).toBeNull();
  });

  it('refuses a credential too short to be one, naming the variable', () => {
    // Not clamped and not accepted: `min(8)` is the same floor the redactor applies, so a value this
    // short could not be redacted out of a transcript even if it did authenticate.
    expect(() => load({ ANTHROPIC_API_KEY: 'short' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('reads the credential from its _FILE variant, and drops the editor’s newline', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp15g-config-'));
    const file = join(directory, 'anthropic');
    writeFileSync(file, 'FAKE-anthropic-key-not-a-real-secret-000\n');
    expect(load({ ANTHROPIC_API_KEY_FILE: file }).modelApiKey).toBe(
      'FAKE-anthropic-key-not-a-real-secret-000',
    );
  });

  it('refuses a provider mode that is not one of BD-004’s two', () => {
    expect(() => load({ APP_PROVIDER_MODE: 'bedrock' })).toThrow(/APP_PROVIDER_MODE/);
    expect(load({ APP_PROVIDER_MODE: 'local' }).providerMode).toBe('local');
  });
});

describe('pool sizing', () => {
  it('adds the composition root’s own floor to the dispatcher’s', () => {
    const config = load({ APP_DISPATCH_MAX_CONCURRENCY: '2', APP_DB_POOL_MAX: '24' });
    // 2 × 2 + 1 for dispatch — the dispatcher's own transaction and the handler's — plus pg-boss,
    // the pipeline's job workers, HTTP and maintenance. Every term is symbolic on purpose: the
    // count of pipeline workers belongs to `POOL_RESERVATIONS`, and this comment saying "three"
    // while the constant said four is PROGRESS backlog 22's seventh site.
    expect(requiredPoolConnections(config)).toBe(
      5 +
        POOL_RESERVATIONS.jobs +
        POOL_RESERVATIONS.pipeline +
        POOL_RESERVATIONS.knowledge +
        POOL_RESERVATIONS.onboarding +
        POOL_RESERVATIONS.bootstrap +
        POOL_RESERVATIONS.http +
        POOL_RESERVATIONS.maintenance,
    );
  });

  it('costs two connections per added dispatch, not three, because no handler calls a provider', () => {
    // The shape of the term, not its value. Until WP-15d a handler called a provider inside its
    // transaction and the audit row (BD-003) opened a second one inside *that*, so every added
    // dispatch cost three connections; the call is made from `pipeline.outbound` now, so it costs
    // two. `POOL_RESERVATIONS.auditPerDispatch` back at 1 fails this and nothing else, which is
    // what makes it the receipt rather than a comment.
    const one = load({ APP_DISPATCH_MAX_CONCURRENCY: '1', APP_DB_POOL_MAX: '30' });
    const three = load({ APP_DISPATCH_MAX_CONCURRENCY: '3', APP_DB_POOL_MAX: '30' });
    expect(requiredPoolConnections(three) - requiredPoolConnections(one)).toBe(4);
    expect(POOL_RESERVATIONS.auditPerDispatch).toBe(0);
  });

  it('asks for less when the role runs fewer workloads', () => {
    const api = load({ ROLE: 'api' });
    const worker = load({ ROLE: 'worker' });
    expect(requiredPoolConnections(api)).toBe(
      POOL_RESERVATIONS.http + POOL_RESERVATIONS.maintenance,
    );
    expect(requiredPoolConnections(worker)).toBeGreaterThan(requiredPoolConnections(api));
  });

  it('refuses a pool that only satisfies the dispatcher’s own floor', () => {
    // `createEventing` would accept 2 × 1 + 1 = 3 and then stall the first time a request and a
    // sweep both want a connection: it says in its own message that 3 is "the floor for the
    // dispatcher alone". This is the composition root refusing that arrangement at boot.
    let thrown: unknown;
    try {
      load({ APP_DISPATCH_MAX_CONCURRENCY: '1', APP_DB_POOL_MAX: '3' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UndersizedPoolError);
    // Twenty-two since WP-56: twenty-one (WP-15c's fourth pipeline worker, WP-18a's
    // `knowledge.index`, WP-18b's three Librarian queues, WP-21's `onboarding.discovery`, WP-32's
    // digest tick, WP-31's `task.ask`, WP-35's `bootstrap.history` and WP-36's
    // `maintenance.schedule`) plus `deadline.sweep` — **one** worker for the question, approval and
    // take-over deadlines, which is the architect's ruling and the reason this moved by exactly one.
    expect((thrown as UndersizedPoolError).required).toBe(22);
    expect((thrown as Error).message).toMatch(/APP_DB_POOL_MAX/);
    // PROGRESS backlog 22's **site 3**, derived rather than spelled since WP-31 round 2. The
    // message used to say "the pipeline's five job workers" beside a `POOL_RESERVATIONS.pipeline`
    // of 6 — the first time the class reached an *error message*, and the one sentence an operator
    // reads at the moment the program refuses to start. Comparing it against the constant is the
    // point: a word written back in fails here.
    expect((thrown as Error).message).toContain(
      `the pipeline's ${POOL_RESERVATIONS.pipeline} job workers`,
    );
    expect((thrown as Error).message).toContain(
      `the knowledge base's ${POOL_RESERVATIONS.knowledge}`,
    );
  });

  /**
   * The value `.env.example` ships, read out of the file (PROGRESS backlog 22).
   *
   * The test this replaces commented *".env.example ships APP_DB_POOL_MAX=14"* and then called
   * `load()` with nothing — which exercises the **code** default (13), so the sentence about the
   * file was decoration and the two shipped defaults for one knob were free to disagree. They did:
   * 13 in `packages/infrastructure/src/db/config.ts` and 14 in `.env.example`, with nothing holding
   * the second. `git grep` over `*.ts`/`*.mjs` found four files mentioning `.env.example` and none
   * reading it.
   *
   * So this reads the file. It deliberately adds **no** prose about the arithmetic — that is the
   * defect, not the remedy; the floor is `requiredPoolConnections`, and both shipped values are
   * compared against it rather than against a number written down an eighth time.
   */
  const envExampleValue = (name: string): string => {
    const text = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const line = text.split('\n').find((entry) => entry.startsWith(`${name}=`));
    if (line === undefined) {
      throw new Error(`.env.example does not set ${name}`);
    }
    return line.slice(name.length + 1).trim();
  };

  it('starts on the pool size .env.example documents, and that value is at or above the floor', () => {
    const documented = envExampleValue('APP_DB_POOL_MAX');
    const concurrency = envExampleValue('APP_DISPATCH_MAX_CONCURRENCY');
    const config = load({ APP_DB_POOL_MAX: documented, APP_DISPATCH_MAX_CONCURRENCY: concurrency });
    expect(config.database.poolMax).toBe(Number(documented));
    expect(Number(documented)).toBeGreaterThanOrEqual(requiredPoolConnections(config));
  });

  it('starts on the code default too, so the two shipped values cannot drift apart unnoticed', () => {
    // The other half: `load()` with nothing set goes through `db.loadDatabaseConfig`'s own default,
    // which is a *second* value for the same knob. Both must clear the floor; when one stops
    // doing so, this names which.
    const config = load();
    expect(config.database.poolMax).toBeGreaterThanOrEqual(requiredPoolConnections(config));
    expect(Number(envExampleValue('APP_DB_POOL_MAX'))).toBeGreaterThanOrEqual(
      config.database.poolMax,
    );
  });
});

/**
 * The intake reconciliation's one knob (WP-15c, PROGRESS backlog 20).
 *
 * Standing rule 18 twice over: the **absent** case and the **off** case must not be spelled the
 * same way, and an unparseable value must not silently become the default — an operator who set a
 * number and got another one has no way to find out.
 */
/**
 * The working calendar (WP-56): `APP_WORKING_DAYS`, `APP_WORKING_HOURS` and `APP_HOLIDAYS`, read
 * in `TZ` — shipped in `.env.example` from WP-05 and parsed by nothing until this row.
 */
describe('the working calendar', () => {
  it('is the documented default when nothing is set, and blank means absent', () => {
    const defaults = {
      timezone: 'UTC',
      working_weekdays: [1, 2, 3, 4, 5],
      working_hours: { start: '09:00', end: '17:00' },
      holidays: [],
    };
    expect(load().workingCalendar).toEqual(defaults);
    // `.env.example` ships `APP_HOLIDAYS=` empty, and an operator who blanks the other two gets
    // the default rather than an empty calendar nothing could ever advance on (WP-53's rule).
    expect(
      load({ APP_WORKING_DAYS: '', APP_WORKING_HOURS: '  ', APP_HOLIDAYS: '' }).workingCalendar,
    ).toEqual(defaults);
  });

  it('reads all four variables', () => {
    expect(
      load({
        TZ: 'Europe/Prague',
        APP_WORKING_DAYS: '1,2,3,4',
        APP_WORKING_HOURS: '08:30-16:30',
        APP_HOLIDAYS: '2026-12-24,2026-12-25',
      }).workingCalendar,
    ).toEqual({
      timezone: 'Europe/Prague',
      working_weekdays: [1, 2, 3, 4],
      working_hours: { start: '08:30', end: '16:30' },
      holidays: ['2026-12-24', '2026-12-25'],
    });
  });

  it.each([
    ['APP_WORKING_DAYS', 'monday'],
    ['APP_WORKING_DAYS', '1,,2'],
    ['APP_WORKING_HOURS', '9-17'],
    ['APP_WORKING_HOURS', '17:00-09:00'],
    ['APP_HOLIDAYS', 'christmas'],
  ])('refuses to start on a malformed %s, naming it', (variable, value) => {
    expect(() => load({ [variable]: value })).toThrow(
      new RegExp(`invalid server configuration: .*${variable}`),
    );
  });

  it('refuses a zone the runtime does not know, naming TZ', () => {
    expect(() => load({ TZ: 'Europe/New_Yrok' })).toThrow(/TZ/);
  });

  it('reports a calendar mistake beside the others instead of one at a time', () => {
    let thrown: unknown;
    try {
      load({ APP_WORKING_HOURS: '9-17', PORT: 'eighty' });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toMatch(/APP_WORKING_HOURS/);
    expect((thrown as Error).message).toMatch(/PORT/);
  });
});

describe('the intake reconciliation interval', () => {
  it('defaults to a minute when nothing is set', () => {
    expect(load().intakeReconcileIntervalMs).toBe(60_000);
  });

  it('reads a whole number of milliseconds', () => {
    expect(load({ APP_INTAKE_RECONCILE_INTERVAL_MS: '1000' }).intakeReconcileIntervalMs).toBe(
      1_000,
    );
    expect(load({ APP_INTAKE_RECONCILE_INTERVAL_MS: '300000' }).intakeReconcileIntervalMs).toBe(
      300_000,
    );
  });

  it('accepts 0 as "off", which is a different answer from "unset"', () => {
    // `composePipeline` logs which of the two it did; the parse only has to keep them distinct.
    expect(load({ APP_INTAKE_RECONCILE_INTERVAL_MS: '0' }).intakeReconcileIntervalMs).toBe(0);
  });

  it.each([
    ['a sub-second interval, which costs more than the loss it recovers', '999'],
    ['longer than an hour', '3600001'],
    ['a number with a unit', '60s'],
    ['a negative number', '-1'],
    ['prose', 'often'],
  ])('refuses %s rather than falling back to the default', (_name, value) => {
    expect(() => load({ APP_INTAKE_RECONCILE_INTERVAL_MS: value })).toThrow(
      /intakeReconcileIntervalMs/,
    );
  });
});
