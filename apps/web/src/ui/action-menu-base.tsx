/**
 * ActionMenu's Base UI half (TD-033 § 5): the menu itself — Base UI's Menu, its popup, its items.
 *
 * **A chunk of its own** (S-25.13): Base UI's Menu, with the focus manager, list navigation and
 * typeahead under it, was the largest single contributor to the SPA's initial graph (21.4 kB of
 * the 297.3 kB TD-013 budgets, `bundle:check`, measured), and no first paint opens a menu. So only
 * `ui/action-menu.tsx` — the API every screen imports — is eager: it loads this module with
 * `import()` and renders the components below, or a plain trigger it swaps for this one on a press
 * (its docblock has the two shapes). Nothing but `action-menu.tsx` imports this file, which
 * `bundle:check` holds by refusing Base UI's Menu in any initial asset (`LAZY_ONLY` in
 * `scripts/bundle-budget.mjs`).
 *
 * Base UI gives it the APG menu-button behaviour — `aria-haspopup`/`aria-expanded` on the trigger,
 * `role="menu"` with roving focus on the arrow keys, typeahead, Escape returns focus to the
 * trigger — so nothing of it is hand-written. Items are `role="menuitem"` (or `menuitemradio`),
 * which the pointer-cursor rule in `styles.css` covers.
 */
import { Menu } from '@base-ui/react/menu';
import { CheckIcon } from '@primer/octicons-react/CheckIcon';
import type { ReactElement, ReactNode, Ref } from 'react';
import { cx } from './cx.js';
import { ExternalAnchor } from './untrusted.js';

/**
 * The menu around a trigger `action-menu.tsx` has already drawn — the `···` default or the
 * caller's own, so the element is the same whichever module renders it. `triggerRef` is how
 * `action-menu.tsx` hands on a press its own button took before this module had loaded.
 */
export const ActionMenu = (props: {
  readonly trigger: ReactElement;
  readonly align: 'start' | 'center' | 'end';
  readonly triggerRef: Ref<HTMLButtonElement>;
  readonly children: ReactNode;
}): ReactElement => (
  <Menu.Root>
    <Menu.Trigger ref={props.triggerRef} render={props.trigger} />
    <Menu.Portal>
      <Menu.Positioner sideOffset={6} align={props.align} className="z-50 outline-none">
        <Menu.Popup className="min-w-52 rounded-lg border border-line bg-default py-1 text-sm text-fg shadow-overlay outline-none transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0">
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

/**
 * An item that is a link to a URL a provider sent (*Open ticket*, *Open MR*): Base UI's link item
 * rendered as `untrusted.tsx`'s {@link ExternalAnchor}, so the `href` is `safeHref`'s and a refused
 * URL stays in the menu as its struck-through label. It opens in a new tab and closes the menu.
 */
export const ActionMenuLinkItem = ({
  url,
  label,
}: {
  readonly url: string;
  readonly label: string;
}): ReactElement => (
  <Menu.LinkItem
    className={ITEM}
    closeOnClick
    label={label}
    render={<ExternalAnchor url={url} label={label} />}
  />
);

/**
 * An item that is a same-origin download: Base UI's `Menu.LinkItem` drawn **as the caller's element**, which must
 * spread props and accept a ref — `ui/untrusted.tsx`'s `DownloadLink`, so the one module that may
 * write a URL attribute still writes this one (`no-html.test.ts`). The task page's *Download JSON*.
 */
export const ActionMenuDownloadItem = ({
  render,
}: {
  readonly render: ReactElement<Record<string, unknown>>;
}): ReactElement => <Menu.LinkItem render={render} className={ITEM} closeOnClick />;

/** A labelled radio group of items (the project switcher's). */
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
  closeOnClick = false,
}: {
  readonly value: string;
  readonly children: ReactNode;
  readonly leadingIcon?: ReactNode;
  /**
   * `false` (the default) keeps the menu open, so a choice can be tried on; `true` for a choice that
   * leaves the page, as the project switcher's does.
   */
  readonly closeOnClick?: boolean;
}): ReactElement => (
  <Menu.RadioItem value={value} closeOnClick={closeOnClick} className={ITEM}>
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
