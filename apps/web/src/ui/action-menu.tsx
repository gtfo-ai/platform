/**
 * ActionMenu, on Base UI's Menu (TD-033 § 5): the `···` overflow of a header or a row, and the
 * avatar menu in the top bar.
 *
 * Base UI gives it the APG menu-button behaviour — `aria-haspopup`/`aria-expanded` on the trigger,
 * `role="menu"` with roving focus on the arrow keys, typeahead, Escape returns focus to the
 * trigger — so nothing of it is hand-written. Items are `role="menuitem"` (or `menuitemradio`),
 * which the pointer-cursor rule in `styles.css` covers.
 */
import { Menu } from '@base-ui/react/menu';
import { CheckIcon } from '@primer/octicons-react/CheckIcon';
import { KebabHorizontalIcon } from '@primer/octicons-react/KebabHorizontalIcon';
import type { ReactElement, ReactNode } from 'react';
import { IconButton } from './button.js';
import { cx } from './cx.js';

/**
 * Either the default `···` trigger, named by `label`, or the caller's own `trigger`, which carries
 * its own name — never both, so a name given here is a name that is shown.
 */
export type ActionMenuProps = {
  readonly children: ReactNode;
  readonly align?: 'start' | 'center' | 'end';
} & (
  | { readonly label: string; readonly trigger?: undefined }
  | {
      /** A custom trigger; it must accept a ref and spread props, and carry its own name. */
      readonly trigger: ReactElement;
      readonly label?: undefined;
    }
);

export const ActionMenu = (props: ActionMenuProps): ReactElement => (
  <Menu.Root>
    <Menu.Trigger
      render={
        props.trigger === undefined ? (
          <IconButton
            aria-label={props.label}
            icon={<KebabHorizontalIcon size={16} />}
            tone="invisible"
          />
        ) : (
          props.trigger
        )
      }
    />
    <Menu.Portal>
      <Menu.Positioner sideOffset={6} align={props.align ?? 'end'} className="z-50 outline-none">
        <Menu.Popup className="min-w-52 rounded-lg border border-line bg-canvas py-1 text-sm text-fg shadow-overlay outline-none transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0">
          {props.children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
);

const ITEM =
  'mx-1 flex items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-disabled:opacity-50 data-highlighted:bg-muted';

export const ActionMenuItem = ({
  children,
  onSelect,
  leadingIcon,
  tone = 'default',
  disabled,
}: {
  readonly children: ReactNode;
  readonly onSelect?: () => void;
  readonly leadingIcon?: ReactNode;
  readonly tone?: 'default' | 'danger';
  readonly disabled?: boolean;
}): ReactElement => (
  <Menu.Item
    className={cx(ITEM, tone === 'danger' ? 'text-danger' : null)}
    {...(disabled === undefined ? {} : { disabled })}
    {...(onSelect === undefined
      ? {}
      : {
          onClick: () => {
            onSelect();
          },
        })}
  >
    {leadingIcon === undefined ? null : (
      <span aria-hidden="true" className="inline-flex w-4 text-fg-muted">
        {leadingIcon}
      </span>
    )}
    {children}
  </Menu.Item>
);

/** A labelled radio group of items (the theme choice). */
export const ActionMenuRadioGroup = <Value extends string>({
  label,
  value,
  onValueChange,
  children,
}: {
  readonly label: string;
  readonly value: Value;
  readonly onValueChange: (value: Value) => void;
  readonly children: ReactNode;
}): ReactElement => (
  <Menu.RadioGroup
    value={value}
    onValueChange={(next: unknown) => {
      onValueChange(next as Value);
    }}
  >
    <Menu.GroupLabel className="px-3 pt-1.5 pb-1 text-xs font-semibold text-fg-muted">
      {label}
    </Menu.GroupLabel>
    {children}
  </Menu.RadioGroup>
);

export const ActionMenuRadioItem = ({
  value,
  children,
  leadingIcon,
}: {
  readonly value: string;
  readonly children: ReactNode;
  readonly leadingIcon?: ReactNode;
}): ReactElement => (
  <Menu.RadioItem value={value} closeOnClick={false} className={ITEM}>
    <span aria-hidden="true" className="inline-flex w-4 text-link">
      <Menu.RadioItemIndicator className="inline-flex">
        <CheckIcon size={16} />
      </Menu.RadioItemIndicator>
    </span>
    {leadingIcon === undefined ? null : (
      <span aria-hidden="true" className="inline-flex w-4 text-fg-muted">
        {leadingIcon}
      </span>
    )}
    {children}
  </Menu.RadioItem>
);

export const ActionMenuSeparator = (): ReactElement => (
  <Menu.Separator className="my-1 h-px bg-line" />
);

/** Non-interactive text at the top of a menu ("Signed in as …"). */
export const ActionMenuHeader = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <div className="px-3 pt-1.5 pb-2 text-xs text-fg-muted">{children}</div>
);
