import { WORKSPACE_LABELS } from '@platform/application';
import { describe, expect, it } from 'vitest';
import {
  expiredHolds,
  type RetentionCandidate,
  type RetentionHold,
  retentionDecision,
  retentionDecisions,
} from './retention.js';

const RUN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const NOW = new Date('2026-09-10T12:00:00.000Z');

const candidate = (overrides: Partial<RetentionCandidate> = {}): RetentionCandidate => {
  const { labels, ...rest } = overrides;
  return {
    volumeName: `ws-${RUN}`,
    inUse: false,
    ...rest,
    labels: {
      [WORKSPACE_LABELS.run]: RUN,
      [WORKSPACE_LABELS.keepUntil]: '2026-09-13T00:00:00.000Z',
      ...labels,
    },
  };
};

describe('retention policy', () => {
  it('keeps a volume whose window has not closed', () => {
    expect(retentionDecision(candidate(), NOW)).toMatchObject({
      action: 'keep',
      keptReason: 'not_expired',
    });
  });

  it('removes a volume whose window has closed', () => {
    expect(retentionDecision(candidate(), new Date('2026-09-14T00:00:00.000Z'))).toMatchObject({
      action: 'remove',
      keptReason: null,
    });
  });

  /**
   * Standing rule 42: a boundary asserted from one side is half a test. One millisecond before the
   * instant is kept and the instant itself is removed — without both, a policy that removed
   * everything and a policy that kept everything each pass one half.
   */
  it('treats the keep_until instant itself as the end of the window', () => {
    const keepUntil = '2026-09-13T00:00:00.000Z';
    const at = new Date(keepUntil);
    const oneMsBefore = new Date(at.getTime() - 1);
    expect(
      retentionDecision(
        candidate({ labels: { [WORKSPACE_LABELS.keepUntil]: keepUntil } }),
        oneMsBefore,
      ),
    ).toMatchObject({
      action: 'keep',
      keptReason: 'not_expired',
    });
    expect(
      retentionDecision(candidate({ labels: { [WORKSPACE_LABELS.keepUntil]: keepUntil } }), at),
    ).toMatchObject({
      action: 'remove',
    });
  });

  it('keeps an expired volume a container still references, and says why', () => {
    const decision = retentionDecision(
      candidate({
        inUse: true,
        labels: { [WORKSPACE_LABELS.keepUntil]: '2020-01-01T00:00:00.000Z' },
      }),
      NOW,
    );
    expect(decision).toMatchObject({ action: 'keep', keptReason: 'in_use' });
  });

  /**
   * Every ambiguous case keeps the data. The two directions are not symmetric: an early delete
   * destroys the only copy of an interrupted run's work, a late one costs disk and shows on the
   * storage gauge.
   */
  it.each([
    ['no keep_until label at all', { [WORKSPACE_LABELS.run]: RUN }],
    ['an empty keep_until', { [WORKSPACE_LABELS.run]: RUN, [WORKSPACE_LABELS.keepUntil]: '' }],
    [
      'an unparseable keep_until',
      { [WORKSPACE_LABELS.run]: RUN, [WORKSPACE_LABELS.keepUntil]: 'yesterday' },
    ],
    ['no run label', { [WORKSPACE_LABELS.keepUntil]: '2020-01-01T00:00:00.000Z' }],
  ])('keeps a volume with %s', (_label, labels) => {
    expect(retentionDecision({ volumeName: 'ws-x', labels, inUse: false }, NOW)).toMatchObject({
      action: 'keep',
      keptReason: 'unlabelled',
    });
  });

  it('decides each candidate independently', () => {
    const decisions = retentionDecisions(
      [
        candidate({
          volumeName: 'a',
          labels: { [WORKSPACE_LABELS.keepUntil]: '2020-01-01T00:00:00.000Z' },
        }),
        candidate({ volumeName: 'b' }),
      ],
      NOW,
    );
    expect(decisions.map((decision) => `${decision.volumeName}:${decision.action}`)).toEqual([
      'a:remove',
      'b:keep',
    ]);
  });

  // ── The fourteen-day window (WP-27, technical/05 §5) ──────────────────────

  /** A hold for this run, as `extendRetention` writes one. */
  const hold = (keepUntil: string, runId = RUN): RetentionHold => ({
    runId,
    volumeName: `hold-${runId}`,
    keepUntil,
  });

  it('keeps a held volume past its own window, and reports the instant it used', () => {
    const decision = retentionDecision(
      candidate(),
      new Date('2026-09-20T00:00:00.000Z'),
      hold('2026-09-27T00:00:00.000Z'),
    );
    // Day 7 of a three-day window: this is the purge backlog 7 describes, and the hold is what
    // stops it.
    expect(decision).toMatchObject({ action: 'keep', keptReason: 'not_expired' });
    // The **effective** instant, not the label on the volume: the report is what an operator with a
    // full disk reads, and the three-day figure would be the wrong number to give them.
    expect(decision.keepUntil).toBe('2026-09-27T00:00:00.000Z');
    expect(decision.holdVolume).toBe(`hold-${RUN}`);
  });

  it('removes a held volume once the hold’s own instant has passed', () => {
    expect(
      retentionDecision(
        candidate(),
        new Date('2026-09-28T00:00:00.000Z'),
        hold('2026-09-27T00:00:00.000Z'),
      ),
    ).toMatchObject({ action: 'remove', keptReason: null });
  });

  it('ignores a hold that is earlier than the window the volume already has', () => {
    // Nothing in the product asks for a *shorter* window, so the later instant wins whichever side
    // it is on — and the volume's own label is what is reported when it is the later one.
    const decision = retentionDecision(candidate(), NOW, hold('2026-09-11T00:00:00.000Z'));
    expect(decision.keepUntil).toBe('2026-09-13T00:00:00.000Z');
  });

  it('ignores a hold it cannot parse, leaving the volume’s own window standing', () => {
    const decision = retentionDecision(candidate(), NOW, hold('the day after tomorrow'));
    expect(decision).toMatchObject({ action: 'keep', keptReason: 'not_expired' });
    expect(decision.keepUntil).toBe('2026-09-13T00:00:00.000Z');
  });

  it('matches a hold to its own run and to no other', () => {
    const other = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
    const decisions = retentionDecisions(
      [
        candidate({ volumeName: `ws-${RUN}` }),
        candidate({
          volumeName: `ws-${other}`,
          labels: { [WORKSPACE_LABELS.run]: other },
        }),
      ],
      new Date('2026-09-20T00:00:00.000Z'),
      [hold('2026-09-27T00:00:00.000Z')],
    );
    expect(decisions.map((decision) => `${decision.volumeName}:${decision.action}`)).toEqual([
      `ws-${RUN}:keep`,
      `ws-${other}:remove`,
    ]);
  });

  describe('the holds a sweep may remove with the workspaces', () => {
    it('removes the hold of a workspace this sweep removed', () => {
      const decisions = retentionDecisions([candidate()], new Date('2026-09-28T00:00:00.000Z'), [
        hold('2026-09-27T00:00:00.000Z'),
      ]);
      expect(expiredHolds([hold('2026-09-27T00:00:00.000Z')], decisions)).toEqual([
        hold('2026-09-27T00:00:00.000Z'),
      ]);
    });

    it('removes a hold whose workspace volume is not there at all', () => {
      // The leak standing rule 60 is about: an object nothing reaps because nothing looks for it.
      expect(expiredHolds([hold('2099-01-01T00:00:00.000Z')], [])).toHaveLength(1);
    });

    it('keeps the hold of a workspace this sweep kept', () => {
      const decisions = retentionDecisions([candidate()], new Date('2026-09-20T00:00:00.000Z'), [
        hold('2026-09-27T00:00:00.000Z'),
      ]);
      expect(expiredHolds([hold('2026-09-27T00:00:00.000Z')], decisions)).toEqual([]);
    });
  });
});
