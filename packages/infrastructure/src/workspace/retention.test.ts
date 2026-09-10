import { WORKSPACE_LABELS } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { type RetentionCandidate, retentionDecision, retentionDecisions } from './retention.js';

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
});
