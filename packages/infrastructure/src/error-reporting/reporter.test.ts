/**
 * The error reporter's SDK-free half (WP-295, TD-023's 2026-11-05 amendment): the DSN rule, the
 * event's allow-list, redaction before the bound, hooks that never throw, the log call's report and
 * the swap of one client for the next. The SDK itself is driven in `apps/server`'s tests.
 */
import { exactSecretRedactor, type SecretRedactor } from '@platform/application';
import { describe, expect, it } from 'vitest';
import {
  boundUtf8,
  createErrorReporter,
  ERROR_MESSAGE_MAX_BYTES,
  type ErrorReport,
  type ErrorReportingClient,
  parseErrorReportingDsn,
  REPORT_TAG_NAMES,
  reportOfLogCall,
  shapeBreadcrumb,
  shapeEnvelope,
  shapeReportedEvent,
} from './reporter.js';

// A DSN's public key, built at run time so the source holds no key-shaped literal.
const DSN_PUBLIC = '0123456789abcdef'.repeat(2);
const SECRET = 'FAKE-error-reporting-secret-0001';
const redactor = exactSecretRedactor([{ name: 'planted', value: SECRET }]);

describe('a DSN this platform sends to', () => {
  it.each([
    [
      `https://${DSN_PUBLIC}@o0.ingest.sentry.io/42`,
      `https://${DSN_PUBLIC}@o0.ingest.sentry.io/42`,
      'o0.ingest.sentry.io',
    ],
    [
      `  https://${DSN_PUBLIC}@sentry.example.test:8443/7 `,
      `https://${DSN_PUBLIC}@sentry.example.test:8443/7`,
      'sentry.example.test:8443',
    ],
    [
      `http://${DSN_PUBLIC}@localhost:9000/1`,
      `http://${DSN_PUBLIC}@localhost:9000/1`,
      'localhost:9000',
    ],
    [`http://${DSN_PUBLIC}@127.0.0.1/1`, `http://${DSN_PUBLIC}@127.0.0.1/1`, '127.0.0.1'],
    [`http://${DSN_PUBLIC}@[::1]:9000/1`, `http://${DSN_PUBLIC}@[::1]:9000/1`, '[::1]:9000'],
  ])('accepts %s', (input, dsn, host) => {
    expect(parseErrorReportingDsn(input)).toEqual({ ok: true, dsn, host });
  });

  it.each([
    ['empty', ''],
    ['not a URL', 'sentry please'],
    ['another scheme', `ftp://${DSN_PUBLIC}@sentry.example.test/1`],
    ['http to another host', `http://${DSN_PUBLIC}@sentry.example.test/1`],
    ['http to the host machine through Docker', `http://${DSN_PUBLIC}@host.docker.internal/1`],
    ['no key', 'https://sentry.example.test/1'],
    ['a legacy secret key', `https://${DSN_PUBLIC}:${DSN_PUBLIC}@sentry.example.test/1`],
    ['no project id', `https://${DSN_PUBLIC}@sentry.example.test/`],
    ['a path prefix', `https://${DSN_PUBLIC}@sentry.example.test/sentry/1`],
    ['a non-numeric project', `https://${DSN_PUBLIC}@sentry.example.test/web`],
    ['a query', `https://${DSN_PUBLIC}@sentry.example.test/1?x=1`],
    ['a fragment', `https://${DSN_PUBLIC}@sentry.example.test/1#x`],
    ['a key with a symbol', `https://ab%2Fcd@sentry.example.test/1`],
    ['too long', `https://${DSN_PUBLIC}@${'a'.repeat(2_100)}.test/1`],
  ])('refuses %s, without echoing the value', (_name, input) => {
    const verdict = parseErrorReportingDsn(input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok && input.length > 0) expect(verdict.reason).not.toContain(DSN_PUBLIC);
  });
});

describe('the event that leaves the process (beforeSend)', () => {
  const sdkEvent = (overrides: Record<string, unknown> = {}) => ({
    event_id: 'ab'.repeat(16),
    timestamp: 1_762_337_100.5,
    level: 'error',
    platform: 'node',
    server_name: 'alice-laptop.local',
    environment: 'production',
    release: 'platform@0.4.0',
    contexts: { runtime: { name: 'node' }, os: { name: 'darwin' } },
    extra: { ticket_text: 'the customer wrote this' },
    user: { id: 'u1', ip_address: '10.0.0.1' },
    request: { url: 'https://core.example.test/api/tasks' },
    breadcrumbs: [{ message: 'a prompt' }],
    sdkProcessingMetadata: { dynamicSamplingContext: { trace_id: 'x' } },
    fingerprint: ['x'],
    tags: {
      role: 'remote-worker',
      worker_id: '00000000-0000-4000-8000-000000000295',
      core_url: 'https://core.example.test',
      version: '0.4.0',
      commit: 'abcdef1',
      run_id: '00000000-0000-4000-8000-0000000002a1',
      project: 'ACME',
      ticket_key: 'ACME-7',
    },
    exception: {
      values: [
        {
          type: 'CoreCallError',
          value: `the core refused ${SECRET}`,
          mechanism: { type: 'generic', handled: true, data: { prompt: 'x' } },
          stacktrace: {
            frames: [
              {
                filename: '/app/apps/server/src/remote-worker/runtime.ts',
                function: 'runCycle',
                lineno: 12,
                colno: 3,
                in_app: true,
                module: 'remote-worker.runtime',
                vars: { token: SECRET },
                context_line: `const token = '${SECRET}'`,
                pre_context: ['x'],
              },
            ],
          },
        },
      ],
    },
    ...overrides,
  });

  it('rebuilds the event from the allow-list: every other field is dropped', () => {
    const shaped = shapeReportedEvent(sdkEvent(), redactor);
    expect(shaped).not.toBeNull();
    expect(Object.keys(shaped ?? {}).sort()).toEqual(
      ['event_id', 'exception', 'level', 'platform', 'tags', 'timestamp'].sort(),
    );
    expect(Object.keys((shaped?.tags ?? {}) as object).sort()).toEqual(
      [...REPORT_TAG_NAMES].sort(),
    );
    const [value] = (shaped as { exception: { values: Record<string, unknown>[] } }).exception
      .values;
    expect(Object.keys(value ?? {}).sort()).toEqual(['stacktrace', 'type', 'value']);
    const [frame] = (value as { stacktrace: { frames: Record<string, unknown>[] } }).stacktrace
      .frames;
    expect(frame).toEqual({
      filename: '/app/apps/server/src/remote-worker/runtime.ts',
      function: 'runCycle',
      lineno: 12,
      colno: 3,
    });
    const text = JSON.stringify(shaped);
    for (const gone of ['alice-laptop', 'the customer wrote', '10.0.0.1', 'a prompt', 'ACME']) {
      expect(text).not.toContain(gone);
    }
  });

  it('redacts the whole rebuilt event before it is sent', () => {
    const text = JSON.stringify(shapeReportedEvent(sdkEvent(), redactor));
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[REDACTED:integration:planted]');
  });

  it('bounds the message at 1 KiB **after** redaction, so a cut never leaves half a secret', () => {
    // The secret straddles the cut: bounding first would keep its first ten characters in clear.
    const message = `${'x'.repeat(ERROR_MESSAGE_MAX_BYTES - 20)}${SECRET} and more`;
    const shaped = shapeReportedEvent(
      sdkEvent({ exception: { values: [{ type: 'Error', value: message }] } }),
      redactor,
    );
    const value =
      (shaped as { exception: { values: { value: string }[] } }).exception.values[0]?.value ?? '';
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_BYTES);
    expect(value).toMatch(/ … \[cut]$/);
    expect(value).not.toContain(SECRET.slice(0, 8));
    expect(value).toContain('[REDACTED:');
    // A message event (a log line with no error) is bounded the same way.
    const logged = shapeReportedEvent(
      { ...sdkEvent({ exception: undefined }), message: 'é'.repeat(2_000) },
      redactor,
    );
    expect(Buffer.byteLength(String(logged?.message))).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_BYTES);
    expect(String(logged?.message)).not.toContain('�');
  });

  it('sends nothing for an event with neither an error nor a message, and never throws', () => {
    expect(shapeReportedEvent(sdkEvent({ exception: undefined }), redactor)).toBeNull();
    expect(shapeReportedEvent('not an event', redactor)).toBeNull();
    const throwing: SecretRedactor = {
      redactText: () => {
        throw new Error('broken');
      },
      redactJson: () => {
        throw new Error('broken');
      },
    };
    // A throwing hook would be captured by the SDK as an internal exception that skips the hook.
    expect(shapeReportedEvent(sdkEvent(), throwing)).toBeNull();
    expect(shapeBreadcrumb({ message: SECRET }, throwing)).toBeNull();
  });
});

describe('every bound is applied after redaction (review of PR #60)', () => {
  it('cuts a type, a frame’s file and function and a tag only once the secret is a placeholder', () => {
    // Each secret straddles its field's bound: cut first, its first eight characters would stay.
    const at = (max: number) => `${'x'.repeat(max - 8)}${SECRET}`;
    const shaped = shapeReportedEvent(
      {
        exception: {
          values: [
            {
              type: at(128),
              value: 'boom',
              stacktrace: { frames: [{ filename: at(512), function: at(512), lineno: 1 }] },
            },
          ],
        },
        tags: { core_url: at(256) },
      },
      redactor,
    );
    const text = JSON.stringify(shaped);
    expect(text).not.toContain(SECRET.slice(0, 8));
    // Each placeholder was cut too, past its first eight characters — never the secret.
    expect(text.match(/\[REDACTE/g)?.length).toBe(4);
    const [value] = (shaped as { exception: { values: Record<string, unknown>[] } }).exception
      .values;
    expect(String(value?.type)).toMatch(/ … \[cut]$/);
  });
});

describe('the envelope that leaves the process (the transport’s gate)', () => {
  const event = {
    event_id: 'cd'.repeat(16),
    server_name: 'alice-laptop.local',
    contexts: { os: { name: 'darwin' } },
    exception: { values: [{ type: 'Error', value: `internal: ${SECRET}` }] },
  };
  it('keeps only event items, each through the allow-list and the redactor, under a rebuilt header', () => {
    const shaped = shapeEnvelope(
      [
        {
          event_id: 'cd'.repeat(16),
          sent_at: '2026-11-05T10:00:00.000Z',
          sdk: { name: 'sentry.javascript.node', version: '10.78.0', packages: [{ name: 'x' }] },
          trace: { trace_id: 'ab', public_key: 'k', release: SECRET },
          dsn: `https://k@${SECRET}.test/1`,
        },
        [
          [{ type: 'event' }, event],
          [{ type: 'session' }, { sid: SECRET }],
          [{ type: 'attachment', filename: 'a.txt' }, new Uint8Array([1, 2])],
          [{ type: 'client_report' }, { discarded_events: [] }],
        ],
      ],
      redactor,
    );
    expect(shaped?.[0]).toEqual({
      event_id: 'cd'.repeat(16),
      sent_at: '2026-11-05T10:00:00.000Z',
      sdk: { name: 'sentry.javascript.node', version: '10.78.0' },
    });
    const items = shaped?.[1] as [Record<string, unknown>, Record<string, unknown>][];
    expect(items.map(([header]) => header)).toEqual([{ type: 'event' }]);
    const text = JSON.stringify(shaped);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('alice-laptop');
    expect(text).toContain('internal: [REDACTED:integration:planted]');
  });

  it('sends nothing when no event survives, or the envelope is not one', () => {
    expect(shapeEnvelope([{}, [[{ type: 'session' }, { sid: 'x' }]]], redactor)).toBeNull();
    expect(shapeEnvelope([{}, [[{ type: 'event' }, { contexts: {} }]]], redactor)).toBeNull();
    expect(shapeEnvelope('not an envelope', redactor)).toBeNull();
    expect(shapeEnvelope([{}, 'items'], redactor)).toBeNull();
  });
});

describe('a breadcrumb (beforeBreadcrumb)', () => {
  it('keeps the time, category, level and message only, redacted', () => {
    const crumb = shapeBreadcrumb(
      {
        timestamp: 1,
        category: 'http',
        level: 'info',
        message: `GET ${SECRET}`,
        data: { url: `https://x.test/?token=${SECRET}` },
        type: 'http',
      },
      redactor,
    );
    expect(crumb).toEqual({
      timestamp: 1,
      category: 'http',
      level: 'info',
      message: 'GET [REDACTED:integration:planted]',
    });
  });
});

describe('a log call’s report', () => {
  it('reports the error, its run id when it is one, and no other field', () => {
    const err = new Error('boom');
    const report = reportOfLogCall(
      {
        err,
        run_id: '00000000-0000-4000-8000-0000000002a1',
        title: 'Fix the login page',
        prompt: 'secret instructions',
      },
      'the run failed',
      { role: 'all', core_url: 'https://core.example.test' },
    );
    expect(report).toEqual({
      error: err,
      message: 'the run failed',
      tags: {
        role: 'all',
        core_url: 'https://core.example.test',
        run_id: '00000000-0000-4000-8000-0000000002a1',
      },
    });
    // A run id that is not one is not a tag; a line with no error reports its own message.
    expect(reportOfLogCall({ run_id: 'ACME-7' }, 'stopped', {})).toEqual({
      error: null,
      message: 'stopped',
      tags: {},
    });
    expect(reportOfLogCall({ err: 'a string' }, undefined, {}).error).toBeNull();
  });
});

describe('boundUtf8', () => {
  it('cuts on a code point boundary and leaves a short text alone', () => {
    expect(boundUtf8('short', 10)).toBe('short');
    const cut = boundUtf8('😀'.repeat(100), 64);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(64);
    expect(cut).not.toContain('�');
  });
});

describe('the reporter: one client at a time, swapped without a restart', () => {
  const recordingFactory = () => {
    const sent: { dsn: string; report: ErrorReport }[] = [];
    const closed: string[] = [];
    const createClient = async (dsn: string): Promise<ErrorReportingClient> => ({
      capture: (report) => {
        sent.push({ dsn, report });
        return `${sent.length}`.padStart(32, '0');
      },
      flush: async () => true,
      close: async () => {
        closed.push(dsn);
        return true;
      },
    });
    return { sent, closed, createClient };
  };
  const report = (message: string): ErrorReport => ({ error: null, message, tags: {} });

  it('is off until configured, sends to the current DSN only, and closes the old client', async () => {
    const factory = recordingFactory();
    const reporter = createErrorReporter({ createClient: factory.createClient });
    expect(reporter.report(report('before'))).toBeNull();
    expect(await reporter.flush()).toBe(false);

    await reporter.configure('dsn-a');
    expect(reporter.report(report('one'))).not.toBeNull();
    await reporter.configure('dsn-b');
    expect(factory.closed).toEqual(['dsn-a']);
    reporter.report(report('two'));
    expect(factory.sent.map((entry) => [entry.dsn, entry.report.message])).toEqual([
      ['dsn-a', 'one'],
      ['dsn-b', 'two'],
    ]);

    await reporter.configure(null);
    expect(reporter.dsn()).toBeNull();
    expect(reporter.report(report('three'))).toBeNull();
    expect(factory.sent).toHaveLength(2);
    expect(factory.closed).toEqual(['dsn-a', 'dsn-b']);
  });

  it('serialises two changes, and a capture that throws is heard, never thrown', async () => {
    const failures: unknown[] = [];
    const factory = recordingFactory();
    const reporter = createErrorReporter({
      createClient: async (dsn) => ({
        ...(await factory.createClient(dsn)),
        capture: () => {
          throw new Error('transport down');
        },
      }),
      onFailure: (error) => failures.push(error),
    });
    await Promise.all([reporter.configure('dsn-a'), reporter.configure('dsn-b')]);
    expect(reporter.dsn()).toBe('dsn-b');
    expect(factory.closed).toEqual(['dsn-a']);
    expect(reporter.report(report('x'))).toBeNull();
    expect(failures).toHaveLength(1);
    await reporter.close();
    expect(reporter.dsn()).toBeNull();
    expect(factory.closed).toEqual(['dsn-a', 'dsn-b']);
  });
});
