/**
 * A transcript system row says what happened, and why, on the row (S-25.19) — and what it builds
 * from the row's data is filtered, one line, bounded, and absent when the field is not the type the
 * row's producer documents.
 */
import { RUN_STOPPED_REASONS } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { RUN_STOPPED_WORDS, SYSTEM_DETAIL_MAX_CHARS, systemWords } from './system-words.js';

const row = (subtype: string, data: Record<string, unknown>, model: string | null = null) => ({
  subtype,
  data,
  model,
});

describe('systemWords', () => {
  it.each(RUN_STOPPED_REASONS)('words the platform’s stop %s with its reason inline', (reason) => {
    const words = systemWords(row('run_stopped', { reason }));
    expect(words.label).toBe('The platform stopped the run');
    expect(words.detail).toBe(RUN_STOPPED_WORDS[reason]);
    expect(words.detail).not.toMatch(/[a-z]_[a-z]/);
  });

  it('keeps a stop reason it has no word for as the runner wrote it, filtered', () => {
    expect(systemWords(row('run_stopped', { reason: 'odd\u202Ereason' })).detail).toBe(
      'odd\uFFFDreason',
    );
    expect(systemWords(row('run_stopped', { reason: 7 })).detail).toBeNull();
  });

  it('words an API retry: the attempt, the cause, the status and the wait', () => {
    expect(
      systemWords(
        row('api_retry', {
          attempt: 2,
          max_retries: 10,
          retry_delay_ms: 4_200,
          error_status: 529,
          error: 'overloaded',
        }),
      ),
    ).toEqual({
      label: 'The model API failed; retrying',
      detail: 'attempt 2 of 10 · the API was overloaded · HTTP 529 · next try in 4 s',
    });
    // A cause it does not name is spaced out rather than printed raw; a field of the wrong type is absent.
    expect(
      systemWords(row('api_retry', { attempt: '2', error: 'brand_new_error', error_status: null }))
        .detail,
    ).toBe('brand new error');
  });

  it('puts the CLI’s stderr on the row, one line and bounded', () => {
    const long = `fatal: ${'x'.repeat(400)}\nsecond line`;
    const words = systemWords(row('stderr', { text: long }));
    expect(words.label).toBe('The CLI reported an error');
    expect(words.detail?.length).toBe(SYSTEM_DETAIL_MAX_CHARS);
    expect(words.detail?.endsWith('…')).toBe(true);
    expect(words.detail).not.toContain('\n');
    expect(systemWords(row('stderr', { text: '   ' })).detail).toBeNull();
  });

  it('names a refused tool and the session start', () => {
    expect(
      systemWords(row('permission_denied', { tool_name: 'Bash', message: 'not allowed here' })),
    ).toEqual({ label: 'A tool was refused', detail: 'Bash · not allowed here' });
    expect(systemWords(row('init', {}, 'claude-test'))).toEqual({
      label: 'The session started',
      detail: 'claude-test',
    });
  });

  it('keeps a subtype it does not know as a notice, filtered, inventing no meaning', () => {
    expect(systemWords(row('hook_started', { anything: 1 }))).toEqual({
      label: 'System notice · hook_started',
      detail: null,
    });
  });
});
