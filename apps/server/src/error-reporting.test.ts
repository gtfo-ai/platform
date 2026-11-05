/**
 * **What a reported error carries, through the real SDK** — WP-295 criteria (1), (2), (4).
 *
 * A real `@sentry/node` `NodeClient`, built by `sentryClientFactory` exactly as the worker and the
 * core build it, with the SDK's own transport hook (`createTransport`) recording each envelope
 * instead of sending it — no network. The assertions read the **serialised envelope**, the bytes
 * that would have left the process, so nothing the SDK adds after `beforeSend` escapes them.
 *
 * - Each secret kind — the worker's (the Claude token, a run's token and credential, the page's
 *   token, the `wkr_` credential) and the core's (`APP_SECRET_KEY`, the database password, the
 *   launcher token) — is planted into a thrown error's message **and** its stack, and into a
 *   breadcrumb on the SDK's own isolation scope, and is found nowhere in the envelope.
 * - A credential the process never held is removed by TD-012's patterns.
 * - The event is the allow-list: no host name, no contexts, no breadcrumbs, no extra tag.
 * - A reporter pointed at a second DSN sends the next event there and nothing to the first.
 * - The logger's `error` line is the feed; a `warn` line is not.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exactSecretRedactor, type SecretRedactor } from '@platform/application';
import { errorReporting } from '@platform/infrastructure';
import { createTransport, getIsolationScope } from '@sentry/node';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadServerConfig } from './config.js';
import {
  coreReportingSecrets,
  ErrorReportingTestError,
  type ReportingTransport,
  reportingLogHook,
  sentryClientFactory,
} from './error-reporting.js';
import { createLogger } from './logging.js';
import { WORKER_SECRET_NAMES } from './remote-worker/run-session.js';

// A DSN's public key, built at run time so the source holds no key-shaped literal.
const DSN_PUBLIC = '0123456789abcdef'.repeat(2);
const DSN_A = `https://${DSN_PUBLIC}@a.sentry.example.test/1`;
const DSN_B = `https://${DSN_PUBLIC}@b.sentry.example.test/2`;

/** The worker's secret kinds, as the worker names them (`runtime.ts`'s `rememberSecret`). */
const WORKER_SECRETS = [
  { name: `${WORKER_SECRET_NAMES.claudeToken}_1`, value: 'FAKE-claude-oauth-token-wp295-000001' },
  { name: `${WORKER_SECRET_NAMES.runToken}_1_00000000`, value: 'FAKE-run-token-wp295-0000000002' },
  {
    name: `${WORKER_SECRET_NAMES.runCredential}_1_00000000`,
    value: 'FAKE-run-credential-wp295-00003',
  },
  { name: 'worker_ui_token_2', value: 'FAKE-ui-token-wp295-000000000004' },
  // `wkr_<26 base32>_<43 base64url>`, built here so the source holds no credential-shaped literal.
  { name: 'worker_credential_3', value: `wkr_${'a'.repeat(26)}_FAKE${'0'.repeat(39)}` },
] as const;

/** The core's three named kinds, through the function the core composes them with. */
const CORE_CONFIG = {
  secretKey: 'FAKE-app-secret-key-wp295-at-least-32-characters',
  database: { url: 'postgres://app:FAKE-db-password-wp295@db:5432/app' },
  launcherToken: 'FAKE-launcher-token-wp295-000000000000000',
  modelApiKey: null,
  modelOauthToken: null,
  metricsPassword: null,
  bootstrapAdminPassword: null,
};
const CORE_SECRETS = [
  CORE_CONFIG.secretKey,
  'FAKE-db-password-wp295',
  CORE_CONFIG.launcherToken,
] as const;

/** A credential no exact value covers: TD-012's GitLab pattern removes it. */
const PATTERN_ONLY = `glpat-FAKE${'0'.repeat(15)}`;

/** The SDK's transport hook, recording each serialised envelope and the endpoint it was for. */
const recordingTransport = () => {
  const sent: { readonly host: string; readonly body: string }[] = [];
  const transport: ReportingTransport = (options) =>
    createTransport(options, async (request) => {
      sent.push({
        host: new URL(options.url).host,
        body:
          typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body),
      });
      return { statusCode: 200 };
    });
  return { sent, transport };
};

/** The event item of a recorded envelope (header line, item header line, event line). */
const eventOf = (body: string): Record<string, unknown> =>
  JSON.parse(body.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;

const reporters: errorReporting.ErrorReporter[] = [];
const reporterOver = (secrets: SecretRedactor, transport: ReportingTransport) => {
  const reporter = errorReporting.createErrorReporter({
    createClient: sentryClientFactory({ secrets: () => secrets, transport }),
  });
  reporters.push(reporter);
  return reporter;
};

afterEach(async () => {
  await Promise.all(reporters.splice(0).map((reporter) => reporter.close()));
  getIsolationScope().clearBreadcrumbs();
});

/** An error whose message and stack both carry every value in `planted`. */
const plantedError = (planted: readonly string[]): Error => {
  const error = new Error(`the call was refused: ${planted.join(' ')} ${PATTERN_ONLY}`);
  error.stack = [
    `Error: the call was refused: ${planted.join(' ')}`,
    '    at runCycle (/app/apps/server/src/remote-worker/runtime.ts:12:3)',
    ...planted.map(
      (value, index) => `    at fn_${index} (/app/${value}/runtime.ts:${index + 1}:1)`,
    ),
  ].join('\n');
  return error;
};

const TAGS = {
  role: 'remote-worker',
  worker_id: '00000000-0000-4000-8000-000000000295',
  core_url: 'https://core.example.test',
  version: '0.4.0',
  commit: 'abcdef1',
  run_id: '00000000-0000-4000-8000-0000000002a1',
} as const;

describe.each([
  {
    side: 'the worker',
    redactor: exactSecretRedactor([...WORKER_SECRETS]),
    planted: WORKER_SECRETS.map((secret) => secret.value),
  },
  {
    side: 'the core',
    redactor: exactSecretRedactor(coreReportingSecrets(CORE_CONFIG)),
    planted: [...CORE_SECRETS],
  },
])('a reported error from $side carries no secret (WP-295 (2))', ({ redactor, planted }) => {
  it.each(planted)(
    'finds none of %s in the envelope — message, stack or breadcrumb',
    async (value) => {
      const recorder = recordingTransport();
      const reporter = reporterOver(redactor, recorder.transport);
      await reporter.configure(DSN_A);
      // A breadcrumb on the SDK's own isolation scope — merged into every event by the SDK, and
      // added here around `beforeBreadcrumb`, the worst case.
      getIsolationScope().addBreadcrumb({
        message: `a breadcrumb that carries ${value}`,
        data: { value },
      });
      const id = reporter.report({ error: plantedError([value]), message: 'x', tags: TAGS });
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(await reporter.flush()).toBe(true);

      expect(recorder.sent).toHaveLength(1);
      const body = recorder.sent[0]?.body ?? '';
      expect(body).not.toContain(value);
      expect(body).not.toContain(PATTERN_ONLY);
      // The event was sent and redacted, not dropped: its type, its frame and a placeholder are there.
      expect(body).toContain('[REDACTED:integration:');
      expect(body).toContain('[REDACTED sha256:');
      expect(body).toContain('runCycle');
      expect(body).not.toContain('a breadcrumb that carries');
    },
  );
});

describe('the event is the allow-list (WP-295 (1))', () => {
  it('carries the type, the bounded message, the stack and the six tags — and nothing else', async () => {
    const recorder = recordingTransport();
    const reporter = reporterOver(exactSecretRedactor([]), recorder.transport);
    await reporter.configure(DSN_A);
    getIsolationScope().setTag('project', 'ACME');
    getIsolationScope().setExtra('ticket_text', 'what the customer wrote');
    getIsolationScope().setUser({ id: 'u1', email: 'alice@example.test' });
    try {
      reporter.report({
        error: new ErrorReportingTestError('a test'),
        message: 'x',
        tags: { ...TAGS, ...({ ticket_key: 'ACME-7' } as object) },
      });
      await reporter.flush();
    } finally {
      getIsolationScope().clear();
    }
    const event = eventOf(recorder.sent[0]?.body ?? '');
    // `sdk` is the SDK's name and version, which it writes into the envelope after `beforeSend`.
    expect(Object.keys(event).sort()).toEqual(
      ['event_id', 'exception', 'level', 'platform', 'sdk', 'tags', 'timestamp'].sort(),
    );
    expect(event.tags).toEqual(TAGS);
    const [exception] = (event.exception as { values: Record<string, unknown>[] }).values;
    expect(exception?.type).toBe('ErrorReportingTestError');
    expect(exception?.value).toBe('a test error sent from a test to check error reporting');
    const body = recorder.sent[0]?.body ?? '';
    for (const gone of ['ACME', 'what the customer wrote', 'alice@example.test', 'server_name']) {
      expect(body).not.toContain(gone);
    }
  });

  it('reports a log line with no error as its message, bounded', async () => {
    const recorder = recordingTransport();
    const reporter = reporterOver(exactSecretRedactor([]), recorder.transport);
    await reporter.configure(DSN_A);
    reporter.report({ error: null, message: 'x'.repeat(5_000), tags: { role: 'all' } });
    await reporter.flush();
    const event = eventOf(recorder.sent[0]?.body ?? '');
    expect(Buffer.byteLength(String(event.message))).toBeLessThanOrEqual(
      errorReporting.ERROR_MESSAGE_MAX_BYTES,
    );
    expect(event.exception).toBeUndefined();
    expect(event.tags).toEqual({ role: 'all' });
  });
});

describe('a change of DSN applies without a restart (WP-295 (3))', () => {
  it('sends the next event to the second DSN and nothing more to the first', async () => {
    const recorder = recordingTransport();
    const reporter = reporterOver(exactSecretRedactor([]), recorder.transport);
    await reporter.configure(DSN_A);
    reporter.report({ error: new Error('first'), message: 'first', tags: {} });
    await reporter.flush();
    await reporter.configure(DSN_B);
    reporter.report({ error: new Error('second'), message: 'second', tags: {} });
    await reporter.flush();
    expect(recorder.sent.map((entry) => entry.host)).toEqual([
      'a.sentry.example.test',
      'b.sentry.example.test',
    ]);
    await reporter.configure(null);
    expect(reporter.report({ error: new Error('third'), message: 'third', tags: {} })).toBeNull();
    expect(recorder.sent).toHaveLength(2);
  });
});

describe('the logger is the feed (WP-295 (1))', () => {
  it('reports an error line with its run id and tags, and never a warning', async () => {
    const recorder = recordingTransport();
    const reporter = reporterOver(
      exactSecretRedactor([{ name: 'planted', value: 'FAKE-planted-wp295-0000000001' }]),
      recorder.transport,
    );
    await reporter.configure(DSN_A);
    const logger = createLogger({
      level: 'info',
      format: 'json',
      role: 'all',
      destination: { write: () => undefined },
      onError: reportingLogHook(reporter, () => ({ role: 'all', core_url: TAGS.core_url })),
    });
    logger.warn({ err: new Error('only a warning') }, 'a warning');
    await reporter.flush();
    expect(recorder.sent).toHaveLength(0);
    logger.error(
      {
        err: new Error('refused FAKE-planted-wp295-0000000001'),
        run_id: TAGS.run_id,
        title: 'Fix the login page',
      },
      'the run failed',
    );
    await reporter.flush();
    expect(recorder.sent).toHaveLength(1);
    const event = eventOf(recorder.sent[0]?.body ?? '');
    expect(event.tags).toEqual({ role: 'all', core_url: TAGS.core_url, run_id: TAGS.run_id });
    const body = recorder.sent[0]?.body ?? '';
    expect(body).toContain('refused [REDACTED:integration:planted]');
    expect(body).not.toContain('Fix the login page');
  });
});

describe('SENTRY_DSN on the core (WP-295 (4))', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'sentry-dsn-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const base = {
    DATABASE_URL: 'postgres://app:app@db:5432/app',
    APP_SECRET_KEY: 'FAKE-app-secret-key-wp295-at-least-32-characters',
  };

  it('is off when unset, canonical when set, read from its _FILE, and refused malformed without echoing it', () => {
    expect(loadServerConfig(base).sentryDsn).toBeNull();
    expect(loadServerConfig({ ...base, SENTRY_DSN: ` ${DSN_A} ` }).sentryDsn).toBe(DSN_A);
    const file = path.join(scratch, 'dsn');
    writeFileSync(file, `${DSN_B}\n`);
    expect(loadServerConfig({ ...base, SENTRY_DSN_FILE: file }).sentryDsn).toBe(DSN_B);
    const refused = `http://${DSN_PUBLIC}@sentry.example.test/1`;
    expect(() => loadServerConfig({ ...base, SENTRY_DSN: refused })).toThrow(
      /SENTRY_DSN must be a Sentry DSN/,
    );
    try {
      loadServerConfig({ ...base, SENTRY_DSN: refused });
    } catch (error) {
      expect((error as Error).message).not.toContain(DSN_PUBLIC);
    }
  });

  it('redacts the core’s secrets by value, and leaves one too short to the patterns', () => {
    expect(coreReportingSecrets(CORE_CONFIG).map((secret) => secret.name)).toEqual([
      'app_secret_key',
      'database_password',
      'launcher_token',
    ]);
    // The stock development password (`app`) cannot be an exact value: it would erase ordinary words.
    expect(
      coreReportingSecrets({ ...CORE_CONFIG, database: { url: base.DATABASE_URL } }).map(
        (secret) => secret.name,
      ),
    ).toEqual(['app_secret_key', 'launcher_token']);
  });
});
