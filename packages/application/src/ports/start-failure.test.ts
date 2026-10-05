/**
 * What a run that never started records about why — `runStartFailureOf` and the bound under it,
 * `boundOutputTail` (PROGRESS backlog 453).
 *
 * The pipeline tier (`pipeline/stage-executor.test.ts`, `ask/ask-pipeline.test.ts`) drives these
 * through an executor; this file holds the properties that need many inputs rather than one: every
 * result fits its schema's bound, a cut is always announced, and a planted secret never survives —
 * wherever the cut falls relative to it.
 */
import { RUN_START_FAILURE_DETAIL_MAX_CHARS, runStartFailureSchema } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { RunStartError, runStartFailureOf } from './runner.js';
import { boundOutputTail, WORKSPACE_ERROR_OUTPUT_MAX_CHARS, WorkspaceError } from './workspace.js';

const SECRET = 'FAKE-PLANTED-secret-453-abcdefghij';
const redactor = exactSecretRedactor([{ name: 'PLANTED_TOKEN', value: SECRET }]);
const failureOf = (error: unknown, retryable = false) =>
  runStartFailureOf(error, { redactor, attempt: 1, retryable });

/** Text made of words and line breaks — what a helper's log looks like. */
const logText = fc
  .array(fc.oneof(fc.stringMatching(/^[a-z:'/.-]{1,12}$/), fc.constant('\n')), {
    maxLength: 900,
  })
  .map((words) => words.join(' '));

describe('boundOutputTail', () => {
  it('keeps text within the bound whole, and says nothing was cut', () => {
    expect(boundOutputTail('  short output \n')).toEqual({ text: 'short output', cut: false });
  });

  it('keeps a suffix within the bound, drops the partial token at its front, and says so', () => {
    fc.assert(
      fc.property(logText, fc.integer({ min: 1, max: 300 }), (text, max) => {
        const bounded = boundOutputTail(text, max);
        expect(bounded.text.length).toBeLessThanOrEqual(max);
        expect(text.trim().endsWith(bounded.text)).toBe(true);
        expect(bounded.cut).toBe(text.trim().length > max);
        if (bounded.cut && bounded.text !== '') {
          // What is kept starts at a token boundary of the original.
          const start = text.trim().length - bounded.text.length;
          expect(/\s/.test(text.trim().charAt(start - 1))).toBe(true);
        }
      }),
    );
  });
});

describe('runStartFailureOf', () => {
  it('carries the workspace’s message and output, and the diagnosis in platform words', () => {
    const failure = failureOf(
      new RunStartError('provisioning failed: words that stay in the log', {
        retryable: true,
        cause: new WorkspaceError('engine_unavailable', 'Docker engine request timed out', {
          detail: 'POST /containers/create',
        }),
      }),
      true,
    );
    expect(failure).toEqual({
      kind: 'not_started',
      diagnosis: 'RunStartError: engine_unavailable',
      detail: 'Docker engine request timed out',
      truncated: false,
      attempt: 1,
      retryable: true,
    });
  });

  it('carries no words for a failure that is not a workspace’s', () => {
    for (const error of [
      new RunStartError(`refused ${SECRET}`, { retryable: false }),
      new Error(`boom ${SECRET}`),
      'not even an error',
    ]) {
      const failure = failureOf(error);
      expect(failure.detail).toBeNull();
      expect(JSON.stringify(failure)).not.toContain(SECRET);
    }
  });

  it('always fits its schema, announces every cut, and never keeps a planted secret', () => {
    fc.assert(
      fc.property(
        logText,
        logText,
        fc.nat({ max: 3 }),
        fc.boolean(),
        (before, after, copies, inMessage) => {
          const planted = `${before} ${Array.from({ length: copies }, () => SECRET).join(' ')} ${after}`;
          const output = `${before}${'\n'.repeat(3)}${planted}`;
          const workspace = new WorkspaceError(
            'workspace_failed',
            inMessage ? `helper exited 1 (${SECRET})` : 'helper exited 1',
            { output },
          );
          const failure = failureOf(new RunStartError('x', { retryable: false, cause: workspace }));
          expect(runStartFailureSchema.safeParse(failure).success).toBe(true);
          expect(failure.detail?.length ?? 0).toBeLessThanOrEqual(
            RUN_START_FAILURE_DETAIL_MAX_CHARS,
          );
          // Every cut is announced: the launcher's, or the runner's after a placeholder lengthened
          // the text. And nothing announced as whole is missing a word.
          if (output.trim().length > WORKSPACE_ERROR_OUTPUT_MAX_CHARS) {
            expect(failure.truncated).toBe(true);
          }
          if (!failure.truncated) {
            expect(failure.detail?.endsWith(redactor.redactText(output.trim()).value)).toBe(true);
          }
          // Not the whole secret, and not its tail either — the part a cut through it would keep.
          expect(failure.detail ?? '').not.toContain(SECRET.slice(-10));
        },
      ),
    );
  });
});
