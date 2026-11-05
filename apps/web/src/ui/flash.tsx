/**
 * Flash: a message that belongs to the page — an error, a warning, a confirmation (Primer's Flash).
 *
 * Icon, tinted ground and a word-bearing title, so the tone is never carried by colour alone.
 * `beacon` is what needs a person — the task page's needs-you callout — in `needs_you`'s colours.
 * `danger` is announced (`role="alert"`) because a failure that appears without the user doing
 * anything must reach a screen reader; the others are not live unless the caller asks (`live`).
 */
import { AlertIcon } from '@primer/octicons-react/AlertIcon';
import { BellFillIcon } from '@primer/octicons-react/BellFillIcon';
import { CheckCircleIcon } from '@primer/octicons-react/CheckCircleIcon';
import { InfoIcon } from '@primer/octicons-react/InfoIcon';
import { StopIcon } from '@primer/octicons-react/StopIcon';
import type { Icon } from '@primer/octicons-react/types';
import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

export type FlashTone = 'info' | 'warning' | 'danger' | 'success' | 'beacon';

const TONES: Record<
  FlashTone,
  { readonly box: string; readonly icon: string; readonly glyph: Icon }
> = {
  info: { box: 'border-link/50 bg-subtle', icon: 'text-link', glyph: InfoIcon },
  warning: { box: 'border-attention/40 bg-attention-bg', icon: 'text-attention', glyph: AlertIcon },
  danger: { box: 'border-danger/40 bg-danger-bg', icon: 'text-danger', glyph: StopIcon },
  success: {
    box: 'border-success/40 bg-success-bg',
    icon: 'text-success',
    glyph: CheckCircleIcon,
  },
  // What needs a person (S-23.9b, the task page's callout): the beacon, as `needs_you` draws it.
  beacon: { box: 'border-running/60 bg-running-bg', icon: 'text-running', glyph: BellFillIcon },
};

export const Flash = ({
  tone = 'info',
  title,
  children,
  action,
  live,
  className,
  ...data
}: {
  readonly tone?: FlashTone;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  /** Announce it: `alert` (assertive) is the default for `danger`, `status` (polite) on request. */
  readonly live?: 'alert' | 'status' | 'off';
  readonly className?: string;
  readonly 'data-testid'?: string;
}): ReactElement => {
  const look = TONES[tone];
  const Glyph = look.glyph;
  const role = live ?? (tone === 'danger' ? 'alert' : 'off');
  return (
    <div
      data-flash={tone}
      {...(role === 'off' ? {} : { role })}
      {...data}
      className={cx(
        'flex items-start gap-3 rounded-md border px-4 py-3 text-sm text-fg',
        look.box,
        className,
      )}
    >
      <span aria-hidden="true" className={cx('mt-0.5 inline-flex shrink-0', look.icon)}>
        <Glyph size={16} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title === undefined ? null : <p className="font-semibold">{title}</p>}
        {children === undefined ? null : <div className="text-fg-muted">{children}</div>}
      </div>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
};
