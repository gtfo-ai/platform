/**
 * WP-79, PROGRESS backlog 267 — the comparison that decides a human's way into Ready, and the gate
 * it re-enters, as pure functions. The duty itself is driven end to end through the pipeline
 * harness in `human-commands.test.ts` (*"a human’s way into Ready (WP-79)"*).
 */
import type { PipelineTemplate } from '@platform/contracts';
import { CHORE_TEMPLATE, compilePipeline, FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  gateToReenter,
  REBASE_RECHECK_REASON,
  readyEntryFor,
  readyHeadVerdict,
} from './ready-head.js';

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

const without = (template: PipelineTemplate, ids: readonly string[]): PipelineTemplate => ({
  ...template,
  stages: template.stages.map((stage) =>
    ids.includes(stage.id) ? { ...stage, enabled: false } : stage,
  ),
});

describe('gateToReenter', () => {
  it('is ci_gate on the shipped ticket templates', () => {
    expect(gateToReenter(compilePipeline('feature', FEATURE_TEMPLATE, null, false))).toBe(
      'ci_gate',
    );
    expect(gateToReenter(compilePipeline('chore', CHORE_TEMPLATE, null, false))).toBe('ci_gate');
  });

  it('falls back to the rebase gate when a project disabled CI, and to none when it disabled both', () => {
    expect(
      gateToReenter(
        compilePipeline('feature', without(FEATURE_TEMPLATE, ['ci_gate']), null, false),
      ),
    ).toBe('rebase_gate');
    expect(
      gateToReenter(
        compilePipeline(
          'feature',
          without(FEATURE_TEMPLATE, ['ci_gate', 'rebase_gate']),
          null,
          false,
        ),
      ),
    ).toBeNull();
  });
});

/**
 * WP-105 (PROGRESS backlogs 274 and 337, ruled option (c)): an unmoved head re-enters the rebase
 * gate on every template that runs it; Ready directly only where there is no rebase gate to re-read.
 */
describe('readyEntryFor', () => {
  const feature = compilePipeline('feature', FEATURE_TEMPLATE, null, false);
  const ready = { kind: 'ready', sha: JUDGED } as const;
  const again = { kind: 'judge_again', reason: 'the branch head moved' } as const;

  it('sends the head the gates judged through the rebase gate, with the platform’s reason', () => {
    expect(readyEntryFor(feature, ready)).toEqual({
      stage: 'rebase_gate',
      gate: true,
      reason: REBASE_RECHECK_REASON,
    });
    expect(readyEntryFor(compilePipeline('chore', CHORE_TEMPLATE, null, false), ready).stage).toBe(
      'rebase_gate',
    );
  });

  it('sends a head to judge again to the first gate, with the verdict’s reason', () => {
    expect(readyEntryFor(feature, again)).toEqual({
      stage: 'ci_gate',
      gate: true,
      reason: 'the branch head moved',
    });
  });

  it('enters Ready directly only on a template that runs no rebase gate (backlog 338’s shape)', () => {
    // Since WP-120 the shape 338 named — `ci_gate` enabled, `rebase_gate` not — is refused when the
    // pipeline is compiled (`assertValidTemplate`), so the only template that runs no rebase gate
    // is one that runs no CI gate either, and nothing on it excused a path to confirm.
    expect(() =>
      compilePipeline('feature', without(FEATURE_TEMPLATE, ['rebase_gate']), null, false),
    ).toThrow(/"rebase_gate" is disabled while "ci_gate" is enabled/);
    const neither = compilePipeline(
      'feature',
      without(FEATURE_TEMPLATE, ['ci_gate', 'rebase_gate']),
      null,
      false,
    );
    expect(readyEntryFor(neither, ready)).toEqual({
      stage: 'ready_for_merge',
      gate: false,
      reason: null,
    });
    expect(readyEntryFor(neither, again)).toEqual({
      stage: 'ready_for_merge',
      gate: false,
      reason: null,
    });
  });
});
