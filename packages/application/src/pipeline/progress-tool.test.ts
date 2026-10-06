/**
 * `report_progress`'s platform half (PROGRESS backlog 496): the bound on the words, the per-run
 * rate bound and the sentence the model reads back. The runner's half — the row through the run's
 * own transcript door — is `packages/infrastructure/src/runner/claude-runner.test.ts`.
 */
import { PROGRESS_SUMMARY_MAX_CHARS } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RunProgressReceipt, RunProgressReport } from '../ports/runner.js';
import {
  boundProgressSummary,
  createProgressGate,
  PROGRESS_MAX_PER_RUN,
  PROGRESS_MIN_INTERVAL_MS,
  progressAcknowledgement,
  RunProgressUnavailableError,
  reportProgressTool,
} from './progress-tool.js';

describe('boundProgressSummary', () => {
  it('trims, keeps a short line whole and refuses a blank one', () => {
    expect(boundProgressSummary('  slice 1 pushed \n')).toEqual({
      summary: 'slice 1 pushed',
      truncated: false,
    });
    expect(boundProgressSummary(' \n\t ')).toBeNull();
  });

  it('cuts a long line to the bound and says so', () => {
    const bounded = boundProgressSummary('a'.repeat(PROGRESS_SUMMARY_MAX_CHARS + 1));
    expect(bounded).toEqual({ summary: 'a'.repeat(PROGRESS_SUMMARY_MAX_CHARS), truncated: true });
  });

  it('never splits a surrogate pair at the cut', () => {
    const line = `${'a'.repeat(PROGRESS_SUMMARY_MAX_CHARS - 1)}😀 and more`;
    const bounded = boundProgressSummary(line);
    expect(bounded?.truncated).toBe(true);
    expect(bounded?.summary).toBe('a'.repeat(PROGRESS_SUMMARY_MAX_CHARS - 1));
  });

  it('is always within the bound, never empty, and a prefix of the trimmed input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: PROGRESS_SUMMARY_MAX_CHARS * 2 }), (input) => {
        const bounded = boundProgressSummary(input);
        if (bounded === null) {
          expect(input.trim()).toBe('');
          return;
        }
        expect(bounded.summary.length).toBeGreaterThan(0);
        expect(bounded.summary.length).toBeLessThanOrEqual(PROGRESS_SUMMARY_MAX_CHARS);
        expect(input.trim().startsWith(bounded.summary)).toBe(true);
        expect(bounded.truncated).toBe(input.trim().length > PROGRESS_SUMMARY_MAX_CHARS);
      }),
    );
  });
});

describe('createProgressGate', () => {
  it('admits the first line, refuses one inside the interval, and admits again after it', () => {
    let now = 1_000;
    const gate = createProgressGate({ now: () => now });
    expect(gate.admit()).toEqual({ recorded: true });
    now += PROGRESS_MIN_INTERVAL_MS - 1;
    expect(gate.admit()).toEqual({ recorded: false, reason: 'too_soon', retryAfterMs: 1 });
    now += 1;
    expect(gate.admit()).toEqual({ recorded: true });
  });

  it('does not count a refused line against the interval or the cap', () => {
    let now = 0;
    const gate = createProgressGate({ now: () => now, minIntervalMs: 10, maxPerRun: 2 });
    expect(gate.admit().recorded).toBe(true);
    now = 5;
    expect(gate.admit().recorded).toBe(false);
    now = 10;
    // Ten after the admitted line, not after the refused one.
    expect(gate.admit().recorded).toBe(true);
    now = 1_000;
    expect(gate.admit()).toEqual({ recorded: false, reason: 'run_limit', limit: 2 });
  });

  it('records at most PROGRESS_MAX_PER_RUN lines in a run', () => {
    let now = 0;
    const gate = createProgressGate({ now: () => now });
    let recorded = 0;
    for (let call = 0; call < PROGRESS_MAX_PER_RUN + 10; call += 1) {
      now += PROGRESS_MIN_INTERVAL_MS;
      if (gate.admit().recorded) {
        recorded += 1;
      }
    }
    expect(recorded).toBe(PROGRESS_MAX_PER_RUN);
  });
});

describe('progressAcknowledgement', () => {
  it('answers in one short plain sentence, never as platform jargon (backlog 476)', () => {
    const answers = [
      progressAcknowledgement({ recorded: true }, false),
      progressAcknowledgement({ recorded: true }, true),
      progressAcknowledgement({ recorded: false, reason: 'too_soon', retryAfterMs: 12_300 }, false),
      progressAcknowledgement({ recorded: false, reason: 'run_limit', limit: 100 }, false),
    ];
    expect(answers).toEqual([
      'Progress recorded.',
      `Progress recorded, shortened to its first ${PROGRESS_SUMMARY_MAX_CHARS} characters.`,
      'Not recorded: this run reported progress moments ago. Carry on, and report again after your next step (at the earliest in 13 s).',
      'Not recorded: this run has already reported progress 100 times, the most it may. Carry on without it.',
    ]);
    for (const answer of answers) {
      expect(answer).not.toMatch(/transcript|seq|sink|WP-\d+|backlog/i);
    }
  });
});

describe('reportProgressTool', () => {
  const recorder = (receipt: RunProgressReceipt = { recorded: true }) => {
    const reports: RunProgressReport[] = [];
    return {
      reports,
      progress: {
        record: async (report: RunProgressReport) => {
          reports.push(report);
          return receipt;
        },
      },
    };
  };

  it('hands the bounded line and the percentage to the run’s recorder', async () => {
    const { reports, progress } = recorder();
    await expect(
      reportProgressTool({ summary: ' half way ', percent_complete: 50 }, { progress }),
    ).resolves.toBe('Progress recorded.');
    expect(reports).toEqual([{ summary: 'half way', percentComplete: 50, truncated: false }]);
  });

  it('records nothing for a blank line and says what to send instead', async () => {
    const { reports, progress } = recorder();
    await expect(reportProgressTool({ summary: '   ' }, { progress })).resolves.toMatch(
      /^Not recorded: the summary is empty\./,
    );
    expect(reports).toEqual([]);
  });

  it('passes a refusal on as a sentence, not an error', async () => {
    const { progress } = recorder({ recorded: false, reason: 'run_limit', limit: 100 });
    await expect(reportProgressTool({ summary: 'again' }, { progress })).resolves.toMatch(
      /^Not recorded: /,
    );
  });

  it('refuses in one plain sentence when the run has no progress door', async () => {
    await expect(reportProgressTool({ summary: 'x' }, {})).rejects.toThrow(
      RunProgressUnavailableError,
    );
    await expect(reportProgressTool({ summary: 'x' }, {})).rejects.toThrow(
      'Progress cannot be recorded for this run. Carry on without it.',
    );
  });
});
