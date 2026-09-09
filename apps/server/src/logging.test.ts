import { Writable } from 'node:stream';
import { exactSecretRedactor, redactErrorInPlace } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { asLoggerPort, createLogger, withLogContext } from './logging.js';

/** Collects the JSON lines pino writes, so the wire format itself can be asserted. */
const collector = (): { stream: Writable; lines: () => Record<string, unknown>[] } => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};

const logger = (level: 'info' | 'debug' = 'info') => {
  const sink = collector();
  return {
    sink,
    log: createLogger({ level, format: 'json', role: 'all', destination: sink.stream }),
  };
};

describe('createLogger', () => {
  it('writes structured JSON with the role and an ISO timestamp', () => {
    const { sink, log } = logger();
    log.info({ user_id: 'u1' }, 'hello');
    const [line] = sink.lines();
    expect(line).toMatchObject({ role: 'all', msg: 'hello', user_id: 'u1' });
    expect(String(line?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts the fields a secret actually arrives in', () => {
    const { sink, log } = logger();
    log.info(
      {
        password: 'hunter2',
        token: 'ghp_realish',
        headers: { authorization: 'Bearer abc', cookie: 'session=xyz' },
        nested: { secret: 'shh', apiKey: 'sk-123' },
        DATABASE_URL: 'postgres://user:password@host/db',
      },
      'wholesale',
    );
    const [line] = sink.lines();
    const text = JSON.stringify(line);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ghp_realish');
    expect(text).not.toContain('Bearer abc');
    expect(text).not.toContain('session=xyz');
    expect(text).not.toContain('sk-123');
    expect(text).not.toContain('postgres://user:password@host/db');
    // The key survives, so a reader still sees that the field was present.
    expect(line).toMatchObject({ password: '[Redacted]' });
  });

  it('attaches the correlation fields of the surrounding request to every line', () => {
    const { sink, log } = logger();
    withLogContext({ request_id: 'r-1', task_id: 't-1' }, () => {
      log.info({}, 'inside');
    });
    log.info({}, 'outside');

    const [inside, outside] = sink.lines();
    expect(inside).toMatchObject({ request_id: 'r-1', task_id: 't-1' });
    expect(outside).not.toHaveProperty('request_id');
  });

  it('keeps the context across an await, which is the only reason it is AsyncLocalStorage', async () => {
    const { sink, log } = logger();
    await withLogContext({ request_id: 'r-2' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.info({}, 'after the await');
    });
    expect(sink.lines()[0]).toMatchObject({ request_id: 'r-2' });
  });

  it('honours the level', () => {
    const { sink, log } = logger('info');
    log.debug({}, 'not written');
    log.warn({}, 'written');
    expect(sink.lines().map((line) => line.msg)).toEqual(['written']);
  });
});

describe('asLoggerPort', () => {
  it('binds pino to the application ring’s Logger with no adapter in between', () => {
    const { sink, log } = logger('debug');
    const port = asLoggerPort(log);
    port.debug({ a: 1 }, 'd');
    port.info({ b: 2 }, 'i');
    port.warn({ c: 3 }, 'w');
    port.error({ d: 4 }, 'e');

    expect(sink.lines().map((line) => [line.level, line.msg])).toEqual([
      [20, 'd'],
      [30, 'i'],
      [40, 'w'],
      [50, 'e'],
    ]);
  });
});

/**
 * The scrub in `@platform/application` against the serialiser that actually consumes it.
 *
 * `app.ts` logs an unexpected error as `{ err }`, and pino hands that to `pino-std-serializers`,
 * which emits the message and stack **with the whole cause chain appended**, an `AggregateError`'s
 * `errors[]`, and a copy of every key `for…in` reaches. `redactErrorInPlace`'s docblock claims to
 * cover exactly those routes; a claim about another package's behaviour is worth what the test
 * that runs it is worth, so this composes the two rather than describing them.
 *
 * The secret here is not one of `REDACTED_PATHS`: this must fail if the *scrub* regresses, not
 * pass because pino's own field list happened to catch it.
 */
describe('an integration error scrubbed by the application ring, through pino', () => {
  const SECRET = 'fake-provider-token-0123456789';
  const redactor = exactSecretRedactor([{ name: 'gitlab', value: SECRET }]);

  /** The shape an axios or undici failure has: config, response and a cause, all carrying it. */
  const providerFailure = () => {
    const wire = new Error(`socket wrote token ${SECRET}`);
    return Object.assign(new Error('request failed', { cause: wire }), {
      config: { headers: { Authorization: `Bearer ${SECRET}` } },
      response: { status: 401, body: { detail: [`token ${SECRET} was rejected`] } },
      cache: new Map([['authorization', `Bearer ${SECRET}`]]),
    });
  };

  it('writes no part of the injected secret to the log line', () => {
    const { sink, log } = logger();
    const error = providerFailure();

    const redaction = redactErrorInPlace(redactor, error);
    log.error({ err: error }, 'integration action failed');

    // Three, not four: V8 formats `Error.stack` lazily on first read, so scrubbing `message`
    // before anything has touched `stack` makes the stack format itself from the *redacted*
    // message and contribute nothing. An error something already logged or inspected has its
    // stack materialised with the secret in it, and then the scrub writes that one too. The leak
    // is closed either way, which is why the count is a floor and the log line is the assertion.
    expect(
      redaction.count,
      'cause message, request header, response body line',
    ).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(sink.lines()[0]);
    expect(text, 'the line pino actually wrote').not.toContain(SECRET);
    expect(text, 'and it is the scrub that removed it').toContain('[REDACTED:integration:gitlab]');
  });

  it('writes no part of an AggregateError’s children either', () => {
    const { sink, log } = logger();
    const error = new AggregateError(
      [new Error(`first ${SECRET}`), new Error(`second ${SECRET}`)],
      'batch failed',
    );

    redactErrorInPlace(redactor, error);
    log.error({ err: error }, 'integration action failed');

    const line = sink.lines()[0];
    expect(JSON.stringify(line), 'the line pino actually wrote').not.toContain(SECRET);
    expect(
      JSON.stringify((line?.err as { aggregateErrors?: unknown })?.aggregateErrors),
      'pino serialises the children, so the assertion is about them and not about the parent',
    ).toContain('[REDACTED:integration:gitlab]');
  });

  /**
   * The limitation `redactErrorInPlace` documents, priced here: a `Map` value is not walked, and
   * the reason that is tolerable is that pino's JSON renders a `Map` as `{}`. If that ever stops
   * being true, this test fails and the limitation has to be closed.
   */
  it('renders a Map — the one container the scrub does not walk — as an empty object', () => {
    const { sink, log } = logger();
    const error = providerFailure();

    redactErrorInPlace(redactor, error);
    log.error({ err: error }, 'integration action failed');

    const err = sink.lines()[0]?.err as { cache?: unknown };
    expect(err?.cache, 'pino JSON cannot see into a Map').toEqual({});
    expect(error.cache.get('authorization'), 'while the value itself is untouched').toContain(
      SECRET,
    );
  });
});
