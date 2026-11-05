/**
 * Dialog, on Base UI (TD-033 § 5): modal, focus-trapped, Escape and the close button dismiss it,
 * focus returns to what opened it.
 *
 * **Only for a human's destructive or multi-field action** — retire, cancel, take over, return to a
 * stage (research/19 § 3.9) — never for something an agent is doing: product/10 says agent activity
 * never blocks the page. The one place besides menus with a shadow (soft, purple-tinted).
 */
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { XIcon } from '@primer/octicons-react/XIcon';
import type { ReactElement, ReactNode } from 'react';
import { IconButton } from './button.js';

export const Dialog = ({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
}: {
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** The element that opens it (uncontrolled use); it must accept a ref and spread props. */
  readonly trigger?: ReactElement;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  /** The buttons, right-aligned; the primary one last. */
  readonly footer?: ReactNode;
}): ReactElement => (
  <BaseDialog.Root
    {...(open === undefined ? {} : { open })}
    {...(onOpenChange === undefined
      ? {}
      : {
          onOpenChange: (next: boolean) => {
            onOpenChange(next);
          },
        })}
  >
    {trigger === undefined ? null : <BaseDialog.Trigger render={trigger} />}
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-header/70 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <BaseDialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-4rem)] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-canvas text-fg shadow-overlay outline-none">
        <div className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <BaseDialog.Title className="text-base font-semibold">{title}</BaseDialog.Title>
            {description === undefined ? null : (
              <BaseDialog.Description className="text-sm text-fg-muted">
                {description}
              </BaseDialog.Description>
            )}
          </div>
          <BaseDialog.Close
            render={<IconButton aria-label="Close" size="sm" icon={<XIcon size={16} />} />}
          />
        </div>
        {children === undefined ? null : (
          <div className="min-h-0 overflow-y-auto px-4 py-4 text-sm">{children}</div>
        )}
        {footer === undefined ? null : (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
            {footer}
          </div>
        )}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>
);
