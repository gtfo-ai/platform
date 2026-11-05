/**
 * Button and IconButton (TD-033; Primer's Button grammar in the brand's colours).
 *
 * - `primary` is the beacon: amber with night text, exactly the sign-in button — **one per view**
 *   (research/19 § 3.1), the thing to do.
 * - `default` is a quiet bordered button on the subtle ground.
 * - `danger` is an outline in red, as GitHub's *Cancel workflow*: destructive, never loud.
 * - `invisible` has no border or fill until hovered (toolbars, rows).
 * - **A toggle is `default` with `aria-pressed`**, never `primary` (S-23.23, the UX audit's § 2):
 *   a pressed state is not an action, and a page has one beacon.
 *
 * An explicit `type="button"` on every one: the default inside a form is `submit`, which is how a
 * "cancel" button comes to submit the form it sits in. A caller that wants a submit says so.
 */
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { Counter } from './counter.js';
import { cx, FOCUS_RING } from './cx.js';

export type ButtonTone = 'primary' | 'default' | 'danger' | 'invisible';
export type ButtonSize = 'sm' | 'md';

const TONES: Record<ButtonTone, string> = {
  primary:
    'border-primary-line bg-primary text-primary-fg hover:not-disabled:bg-primary-hover font-semibold',
  // A toggle is a `default` button with `aria-pressed` (S-23.23): pressed reads as a raised fill and a
  // link-coloured edge, never as the beacon — a state is not the thing to do.
  default:
    'border-line bg-subtle text-fg hover:not-disabled:bg-muted aria-pressed:border-link aria-pressed:bg-muted',
  danger:
    'border-line bg-subtle text-danger hover:not-disabled:border-danger hover:not-disabled:bg-danger-bg',
  invisible:
    'border-transparent bg-transparent text-fg-muted hover:not-disabled:bg-muted hover:not-disabled:text-fg',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-7 gap-1 px-2 py-0.5 text-xs',
  md: 'min-h-8 gap-1.5 px-3 py-1 text-sm',
};

export const buttonClassName = (tone: ButtonTone, size: ButtonSize = 'md'): string =>
  cx(
    'inline-flex shrink-0 items-center justify-center rounded-md border font-medium select-none',
    'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    FOCUS_RING,
    SIZES[size],
    TONES[tone],
  );

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: ButtonTone;
  readonly size?: ButtonSize;
  /** An icon before the label (an Octicon element); decorative, so hidden from assistive tech. */
  readonly leadingIcon?: ReactNode;
  /** A count after the label (GitHub's "Issues 12"). */
  readonly count?: number;
}

export const Button = ({
  tone = 'default',
  size = 'md',
  leadingIcon,
  count,
  className,
  children,
  ...rest
}: ButtonProps): ReactElement => (
  <button type="button" className={cx(buttonClassName(tone, size), className)} {...rest}>
    {leadingIcon === undefined ? null : (
      <span aria-hidden="true" className="inline-flex text-current opacity-80">
        {leadingIcon}
      </span>
    )}
    {children}
    {count === undefined ? null : <Counter count={count} />}
  </button>
);

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Required: an icon has no text, so this is the button's whole accessible name. */
  readonly 'aria-label': string;
  readonly icon: ReactNode;
  readonly tone?: ButtonTone;
  readonly size?: ButtonSize;
}

export const IconButton = ({
  icon,
  tone = 'invisible',
  size = 'md',
  className,
  ...rest
}: IconButtonProps): ReactElement => (
  <button
    type="button"
    className={cx(
      buttonClassName(tone, size),
      size === 'sm' ? 'size-7 px-0 py-0' : 'size-8 px-0 py-0',
      className,
    )}
    {...rest}
  >
    <span aria-hidden="true" className="inline-flex">
      {icon}
    </span>
  </button>
);
