import { Writable } from 'node:stream';
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
