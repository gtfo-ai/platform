/**
 * Popover, on Base UI (TD-033 § 5): a definition one press away (product/10: every number and term
 * has its definition one hover or keypress away). Unlike a {@link Tooltip} it is opened by a
 * **click or a key press** on its trigger (Enter or Space on a `<button>`), it may hold links, it is
 * a `role="dialog"` named by its title, and Escape or a press outside closes it with the focus back
 * on the trigger.
 *
 * Positioned by Floating UI through CSSOM writes, the same mechanism as the menu and the tooltip:
 * `script-src 'self'` governs it and the production `style-src 'self'` does not
 * (`test/web-e2e/csp.spec.ts` opens one under the policy).
 *
 * The trigger is the caller's element, which must accept a ref and spread props (a `<button>`).
 * The popup is portalled to the body, so a trigger inside a whole-row link (`row-link.ts`) opens it
 * without the row's stretched link covering it; a `<button>` in such a row is lifted above the link
 * by the stylesheet, so a press on it opens the popover rather than the row.
 */
import { Popover as BasePopover } from '@base-ui/react/popover';
import type { ReactElement, ReactNode } from 'react';

export const Popover = ({
  trigger,
  title,
  children,
  onOpenChange,
  side = 'bottom',
  align = 'start',
}: {
  /** The element that opens it; it must accept a ref and spread props, and carry its own name. */
  readonly trigger: ReactElement;
  /** The popup's heading and its accessible name. */
  readonly title: ReactNode;
  readonly children?: ReactNode;
  /** Told when it opens or closes (a caller that reads something only once it is open). */
  readonly onOpenChange?: (open: boolean) => void;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
  readonly align?: 'start' | 'center' | 'end';
}): ReactElement => (
  <BasePopover.Root
    {...(onOpenChange === undefined ? {} : { onOpenChange: (open: boolean) => onOpenChange(open) })}
  >
    <BasePopover.Trigger render={trigger} />
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align={align} sideOffset={6} className="z-50">
        <BasePopover.Popup
          data-popover=""
          className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-line bg-default p-3 text-sm text-fg shadow-overlay outline-none transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0"
        >
          <BasePopover.Title className="text-sm font-semibold">{title}</BasePopover.Title>
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  </BasePopover.Root>
);
