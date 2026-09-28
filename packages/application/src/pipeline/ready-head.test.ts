/**
 * WP-79, PROGRESS backlog 267 — the comparison that decides a human's way into Ready, and the gate
 * it re-enters, as pure functions. The duty itself is driven end to end through the pipeline
 * harness in `human-commands.test.ts` (*"a human’s way into Ready (WP-79)"*).
 */
import type { PipelineTemplate } from '@platform/contracts';
import { CHORE_TEMPLATE, compilePipeline, FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { gateToReenter, readyHeadVerdict } from './ready-head.js';

const JUDGED = 'b'.repeat(40);
const PUSHED = 'c'.repeat(40);

describe('readyHeadVerdict', () => {
  it('answers Ready for exactly the head the gates judged', () => {
    expect(readyHeadVerdict(JUDGED, { kind: 'read', sha: JUDGED })).toEqual({
      kind: 'ready',
      sha: JUDGED,
    });
  });

  it('judges again for a head that moved', () => {
    expect(readyHeadVerdict(JUDGED, { kind: 'read', sha: PUSHED })).toMatchObject({
      kind: 'judge_again',
      reason: expect.stringContaining('moved'),
    });
  });

  it('judges again when no head was recorded, whatever the branch says', () => {
    expect(readyHeadVerdict(null, { kind: 'read', sha: JUDGED })).toMatchObject({
      kind: 'judge_again',
      reason: expect.stringContaining('no gate recorded'),
    });
  });

  it('judges again when the head could not be read, even with a recorded head', () => {
    expect(
      readyHeadVerdict(JUDGED, { kind: 'unreadable', detail: 'the project has no git binding' }),
    ).toMatchObject({
      kind: 'judge_again',
      reason: expect.stringContaining('the project has no git binding'),
    });
  });
});

describe('gateToReenter', () => {
  it('is ci_gate on the shipped ticket templates', () => {
    expect(gateToReenter(compilePipeline('feature', FEATURE_TEMPLATE, null))).toBe('ci_gate');
    expect(gateToReenter(compilePipeline('chore', CHORE_TEMPLATE, null))).toBe('ci_gate');
  });

  const without = (template: PipelineTemplate, ids: readonly string[]): PipelineTemplate => ({
    ...template,
    stages: template.stages.map((stage) =>
      ids.includes(stage.id) ? { ...stage, enabled: false } : stage,
    ),
  });

  it('falls back to the rebase gate when a project disabled CI, and to none when it disabled both', () => {
    expect(
      gateToReenter(compilePipeline('feature', without(FEATURE_TEMPLATE, ['ci_gate']), null)),
    ).toBe('rebase_gate');
    expect(
      gateToReenter(
        compilePipeline('feature', without(FEATURE_TEMPLATE, ['ci_gate', 'rebase_gate']), null),
      ),
    ).toBeNull();
  });
});
