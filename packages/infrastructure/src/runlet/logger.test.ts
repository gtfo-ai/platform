import { describe, expect, it } from 'vitest';
import { createRunletLogger } from './logger.js';

const capture = (level?: 'debug' | 'info' | 'warn' | 'error' | 'silent') => {
  const lines: string[] = [];
  const logger = createRunletLogger({
    ...(level === undefined ? {} : { level }),
    now: () => 1_700_000_000_000,
    write: (line) => lines.push(line),
  });
  return { logger, lines };
};

describe('the run shim logger', () => {
  it('writes one NDJSON object per line in pino shape', () => {
    const { logger, lines } = capture();
    logger.info({ run_id: 'r1' }, 'runlet listening');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0] as string)).toEqual({
      level: 30,
      time: 1_700_000_000_000,
      name: 'agentic-runlet',
      run_id: 'r1',
      msg: 'runlet listening',
    });
  });

  it('drops everything below the level, and everything at silent', () => {
    const warn = capture('warn');
    warn.logger.debug({}, 'no');
    warn.logger.info({}, 'no');
    warn.logger.warn({}, 'yes');
    warn.logger.error({}, 'yes');
    expect(warn.lines).toHaveLength(2);

    const silent = capture('silent');
    silent.logger.error({}, 'not even this');
    expect(silent.lines).toHaveLength(0);
  });

  it('cannot be talked into overwriting the message field', () => {
    const { logger, lines } = capture();
    logger.warn({ msg: 'from the field' }, 'the real message');
    expect(JSON.parse(lines[0] as string).msg).toBe('the real message');
  });
});
