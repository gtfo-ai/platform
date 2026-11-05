/**
 * StatusIcon and StateLabel: one status vocabulary for runs, stages, checks, tasks, integrations
 * and jobs (TD-033, research/19 § 3.3).
 *
 * **Icon + colour + word, never colour alone** (WCAG 1.4.1). Every status has a distinct glyph, a
 * colour token that `contrast.test.ts` holds at ≥ 4.5:1 on the page and on a box header, and a
 * human word. The record is exhaustive (`Record<Status, …>`), so a new status fails `typecheck`
 * until all three exist. A `StatusIcon` shown on its own carries the word as its accessible name; one
 * drawn beside the word (as `StateLabel` does) is decorative so the word is not read twice.
 *
 * `running` is the beacon, animated: a slow pulse that `prefers-reduced-motion` stops on its first
 * frame (the rule is in `styles.css`, beside the keyframes).
 */
import { BellFillIcon } from '@primer/octicons-react/BellFillIcon';
import { CheckCircleFillIcon } from '@primer/octicons-react/CheckCircleFillIcon';
import { CircleIcon } from '@primer/octicons-react/CircleIcon';
import { CircleSlashIcon } from '@primer/octicons-react/CircleSlashIcon';
import { ClockIcon } from '@primer/octicons-react/ClockIcon';
import { DotFillIcon } from '@primer/octicons-react/DotFillIcon';
import { MoonIcon } from '@primer/octicons-react/MoonIcon';
import { PauseIcon } from '@primer/octicons-react/PauseIcon';
import { SkipIcon } from '@primer/octicons-react/SkipIcon';
import type { Icon } from '@primer/octicons-react/types';
import { XCircleFillIcon } from '@primer/octicons-react/XCircleFillIcon';
import type { ReactElement } from 'react';
import { cx } from './cx.js';

export const STATUSES = [
  'queued',
  'running',
  'success',
  'failure',
  'cancelled',
  'skipped',
  'needs_you',
  'waiting',
  'paused',
  'idle',
] as const;

export type Status = (typeof STATUSES)[number];

interface StatusLook {
  readonly icon: Icon;
  /** The text colour utility (the icon takes `currentColor`). */
  readonly fg: string;
  /** The StateLabel's tinted ground and border. */
  readonly pill: string;
  readonly word: string;
}

const NEUTRAL_PILL = 'bg-subtle border-line';

export const STATUS_LOOK: Readonly<Record<Status, StatusLook>> = {
  queued: { icon: CircleIcon, fg: 'text-fg-muted', pill: NEUTRAL_PILL, word: 'Queued' },
  running: {
    icon: DotFillIcon,
    fg: 'text-running',
    pill: 'bg-running-bg border-running/40',
    word: 'Running',
  },
  success: {
    icon: CheckCircleFillIcon,
    fg: 'text-success',
    pill: 'bg-success-bg border-success/40',
    word: 'Succeeded',
  },
  failure: {
    icon: XCircleFillIcon,
    fg: 'text-danger',
    pill: 'bg-danger-bg border-danger/40',
    word: 'Failed',
  },
  cancelled: { icon: CircleSlashIcon, fg: 'text-fg-muted', pill: NEUTRAL_PILL, word: 'Cancelled' },
  skipped: { icon: SkipIcon, fg: 'text-fg-muted', pill: NEUTRAL_PILL, word: 'Skipped' },
  needs_you: {
    icon: BellFillIcon,
    fg: 'text-running',
    pill: 'bg-running-bg border-running/60',
    word: 'Needs you',
  },
  waiting: {
    icon: ClockIcon,
    fg: 'text-attention',
    pill: 'bg-attention-bg border-attention/40',
    word: 'Waiting',
  },
  paused: { icon: PauseIcon, fg: 'text-fg-muted', pill: NEUTRAL_PILL, word: 'Paused' },
  idle: { icon: MoonIcon, fg: 'text-fg-subtle', pill: NEUTRAL_PILL, word: 'Idle' },
};

export const StatusIcon = ({
  status,
  label,
  decorative = false,
  size = 16,
  className,
}: {
  readonly status: Status;
  /** The accessible name; the status word by default. */
  readonly label?: string;
  /** Beside its own word: hidden from assistive tech so the word is not read twice. */
  readonly decorative?: boolean;
  readonly size?: 12 | 16 | 24;
  readonly className?: string;
}): ReactElement => {
  const look = STATUS_LOOK[status];
  const Glyph = look.icon;
  return (
    <span
      data-status={status}
      className={cx(
        'inline-flex shrink-0 items-center',
        look.fg,
        status === 'running' ? 'status-running' : null,
        className,
      )}
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': label ?? look.word })}
    >
      <Glyph size={size} />
    </span>
  );
};

/** The status as a pill: icon and word together (Primer's StateLabel). */
export const StateLabel = ({
  status,
  children,
  size = 'md',
}: {
  readonly status: Status;
  /** The word, when the screen's is more precise than the vocabulary's ("Review 2"). */
  readonly children?: string;
  readonly size?: 'sm' | 'md';
}): ReactElement => {
  const look = STATUS_LOOK[status];
  return (
    <span
      data-state-label={status}
      className={cx(
        'inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap',
        size === 'sm' ? 'px-1.5 py-px text-xs' : 'px-2.5 py-0.5 text-sm',
        look.pill,
        look.fg,
      )}
    >
      <StatusIcon status={status} decorative size={size === 'sm' ? 12 : 16} />
      <span>{children ?? look.word}</span>
    </span>
  );
};
