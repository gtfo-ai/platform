/**
 * The one word table of how a run ended (S-25.19): every terminal reason the contract has is worded
 * in all three columns — the `Record` types refuse a missing key at compile time, and this census
 * refuses an empty, raw or unfinished entry at run time, read off the contract's own enum so a reason
 * added there is checked the moment it exists.
 */
import { runStatusSchema, runTerminalReasonSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { TERMINAL_REASON_MEANING } from './terminal-reason-meanings.js';
import {
  DID_NOT_START,
  runEndedShort,
  TERMINAL_REASON_LABEL,
  TERMINAL_REASON_SHORT,
} from './terminal-reasons.js';

const FAILURE = { kind: 'not_started' } as const;

describe('the terminal-reason word table', () => {
  it.each(runTerminalReasonSchema.options)('words %s in every column, in plain words', (reason) => {
    for (const words of [
      TERMINAL_REASON_LABEL[reason],
      TERMINAL_REASON_SHORT[reason],
      TERMINAL_REASON_MEANING[reason],
    ]) {
      expect(words.trim(), reason).not.toBe('');
      // No raw enum on screen: no snake_case word.
      expect(words, reason).not.toMatch(/[a-z]_[a-z]/);
    }
    expect(TERMINAL_REASON_MEANING[reason], reason).toMatch(/^[A-Z].*\.$/);
    expect(TERMINAL_REASON_SHORT[reason], reason).toMatch(/^[A-Z][^.]*$/);
  });

  it('names exactly the contract’s reasons, no more', () => {
    const reasons = [...runTerminalReasonSchema.options].sort();
    for (const table of [TERMINAL_REASON_LABEL, TERMINAL_REASON_SHORT, TERMINAL_REASON_MEANING]) {
      expect(Object.keys(table).sort()).toEqual(reasons);
    }
  });

  it('never says a lost lease is the agent’s failure', () => {
    expect(TERMINAL_REASON_MEANING.lease_expired).toContain('stopped checking in');
    expect(TERMINAL_REASON_MEANING.lease_expired).toContain(
      'says nothing about whether the agent itself failed',
    );
  });
});

describe('runEndedShort — the short form beside a listed run’s status', () => {
  it('is nothing for a live run, whatever it carries', () => {
    for (const status of ['created', 'starting', 'running'] as const) {
      expect(
        runEndedShort({ status, terminal_reason: 'crash', start_failure: FAILURE }),
      ).toBeNull();
    }
  });

  it.each([
    ['failed', 'lease_expired', 'Lost its worker'],
    ['failed', 'error_during_execution', 'Error while running'],
    ['failed', 'permission_denied', 'Permission denied'],
    ['stalled', 'stalled', 'Stalled'],
    ['budget_exceeded', 'error_max_budget_usd', 'Hit its budget'],
    ['failed', 'shutdown', 'Handed back on shutdown'],
    ['failed', 'rate_limited', 'Hit a usage limit'],
  ] as const)('reads %s / %s as %j', (status, reason, words) => {
    expect(runEndedShort({ status, terminal_reason: reason, start_failure: null })).toBe(words);
  });

  it('adds nothing to a success, a cancel, or a run with no recorded reason', () => {
    expect(runEndedShort({ status: 'completed', terminal_reason: 'success' })).toBeNull();
    expect(runEndedShort({ status: 'cancelled', terminal_reason: 'cancelled' })).toBeNull();
    expect(runEndedShort({ status: 'failed', terminal_reason: null })).toBeNull();
    expect(runEndedShort({ status: 'failed' })).toBeNull();
  });

  it('says Did not start for a workspace never created, not for a stop before the CLI started', () => {
    expect(
      runEndedShort({
        status: 'failed',
        terminal_reason: 'error_during_execution',
        start_failure: FAILURE,
      }),
    ).toBe(DID_NOT_START);
    expect(
      runEndedShort({ status: 'cancelled', terminal_reason: 'cancelled', start_failure: FAILURE }),
    ).toBeNull();
    expect(
      runEndedShort({ status: 'failed', terminal_reason: 'shutdown', start_failure: FAILURE }),
    ).toBe('Handed back on shutdown');
  });

  it('is total over every status and reason', () => {
    for (const status of runStatusSchema.options) {
      for (const reason of [...runTerminalReasonSchema.options, null]) {
        const words = runEndedShort({ status, terminal_reason: reason });
        expect(words === null || words.length > 0).toBe(true);
      }
    }
  });
});
