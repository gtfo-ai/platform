/**
 * Blankslate: an empty state that teaches (research/19 § 3.5, product/10 "Empty states teach").
 *
 * It says nothing is there (`title`), what will appear and how (`hint`), and offers the button that
 * goes there (`action`). The action is **required** unless the state is `informational` — an empty
 * audit log has nothing to offer, an empty board does — and the type says so, so a blankslate
 * without a next step is a decision somebody wrote rather than a prop somebody forgot.
 *
 * The title is one of the three places the brand's black weight is used (research/19 § 4.1).
 */
import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

interface Common {
  readonly title: string;
  readonly hint: string;
  /** An Octicon or the peek-bot; decorative. */
  readonly icon?: ReactNode;
  /** A secondary link under the action ("Learn more"). */
  readonly secondary?: ReactNode;
  /** `spacious` for a whole screen, `compact` inside a box. */
  readonly size?: 'compact' | 'spacious';
  /**
   * Drawn inside a card (S-25.10b): no border and no ground of its own, so a card never holds a
   * second bordered box — the card is the blankslate's box.
   */
  readonly inset?: boolean;
  readonly className?: string;
}

export type BlankslateProps =
  | (Common & { readonly action: ReactNode; readonly informational?: false })
  | (Common & { readonly informational: true; readonly action?: ReactNode });

export const Blankslate = (props: BlankslateProps): ReactElement => {
  const {
    title,
    hint,
    icon,
    secondary,
    size = 'compact',
    inset = false,
    className,
    action,
  } = props;
  return (
    <div
      data-blankslate={props.informational === true ? 'informational' : 'actionable'}
      className={cx(
        'flex flex-col items-center gap-2 text-center',
        inset ? null : 'rounded-md border border-line bg-default',
        size === 'spacious' ? 'px-6 py-16' : inset ? 'px-4 py-4' : 'px-6 py-8',
        className,
      )}
    >
      {icon === undefined ? null : (
        <div aria-hidden="true" className="pb-1 text-fg-muted">
          {icon}
        </div>
      )}
      <h3
        className={cx(
          'font-black tracking-[-0.02em] text-balance text-fg',
          size === 'spacious' ? 'text-2xl' : 'text-lg',
        )}
      >
        {title}
      </h3>
      <p className="max-w-prose text-sm text-pretty text-fg-muted">{hint}</p>
      {action === undefined || action === null ? null : <div className="pt-2">{action}</div>}
      {secondary === undefined ? null : <div className="text-sm">{secondary}</div>}
    </div>
  );
};
