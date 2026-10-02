import type { LogFields, Logger } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { createStderrLog, MAX_HELD_CHARS, MAX_LOGGED_CHARS } from './stderr-log.js';

const SECRET = 'FAKE-wp127-secret-not-a-credential';

const recording = () => {
  const lines: { level: string; fields: LogFields; message: string }[] = [];
  const at =
    (level: string) =>
    (fields: LogFields, message: string): void => {
      lines.push({ level, fields, message });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
  return { logger, lines };
};

const redactor = {
  redactText: (text: string) => ({
    value: text.split(SECRET).join('[REDACTED:FAKE]'),
    count: text.split(SECRET).length - 1,
  }),
};

describe('the CLI’s stderr (WP-127, backlog 344)', () => {
  it('writes one warn line, redacted, for a run that ends before its first stream message', () => {
    const { logger, lines } = recording();
    const log = createStderrLog({ runId: 'r1', logger, redactor });
    // Split across two frames: redacted as one string, so the credential does not slip through.
    log.accept(`error: auth ${SECRET.slice(0, 10)}`);
    log.accept(`${SECRET.slice(10)} refused\n`);
    expect(lines).toEqual([]);
    log.runEnded();
    log.runEnded();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      fields: {
        run_id: 'r1',
        stderr: 'error: auth [REDACTED:FAKE] refused\n',
        stderr_truncated: false,
      },
    });
  });

  it('writes it at debug once the stream has opened, including what was held', () => {
    const { logger, lines } = recording();
    const log = createStderrLog({ runId: 'r1', logger, redactor });
    log.accept('before\n');
    log.streamOpened();
    log.accept(`after ${SECRET}\n`);
    log.runEnded();
    expect(lines.map((line) => [line.level, line.fields['stderr']])).toEqual([
      ['debug', 'before\n'],
      ['debug', 'after [REDACTED:FAKE]\n'],
    ]);
  });

  it('writes nothing for a run that opened its stream or wrote nothing', () => {
    const { logger, lines } = recording();
    createStderrLog({ runId: 'r1', logger, redactor }).runEnded();
    const opened = createStderrLog({ runId: 'r2', logger, redactor });
    opened.streamOpened();
    opened.runEnded();
    expect(lines).toEqual([]);
  });

  it('keeps the newest text, cut only after redaction', () => {
    const { logger, lines } = recording();
    const log = createStderrLog({ runId: 'r1', logger, redactor });
    log.accept(`${SECRET}${'x'.repeat(MAX_HELD_CHARS)}`);
    log.accept(`tail ${SECRET}`);
    log.runEnded();
    const stderr = String(lines[0]?.fields['stderr']);
    expect(stderr.length).toBe(MAX_LOGGED_CHARS);
    expect(stderr.endsWith('tail [REDACTED:FAKE]')).toBe(true);
    expect(stderr).not.toContain('FAKE-wp127');
    expect(lines[0]?.fields['stderr_truncated']).toBe(true);
  });
});
