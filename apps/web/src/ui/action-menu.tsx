/**
 * ActionMenu (TD-033 § 5): the `···` overflow of a header or a row, and the avatar menu in the top
 * bar — the API every screen imports.
 *
 * **The menu is a lazy chunk; the trigger is not** (S-25.13). Base UI's Menu — with the focus
 * manager, the list navigation and the typeahead under it — was the largest single contributor to
 * the SPA's initial graph (21.4 kB of the 297.3 kB TD-013 budgets, `bundle:check`, measured), and
 * no first paint opens a menu. So the menu lives in `action-menu-base.tsx`, loaded with `import()`,
 * and this module decides which of two shapes a menu has, once, when it first renders:
 *
 * - **the module is already there** — every menu a screen draws after the first paint, since the
 *   frame's menus fetch it as they mount: Base UI's Menu, exactly as when the import was static;
 * - **it is not** — the frame's own menus on the first paint: a plain trigger, **the same element**
 *   (the `···` {@link IconButton} or the caller's own) with the closed menu button's
 *   `aria-haspopup="menu"` and `aria-expanded="false"`, which fetches the module as it mounts and
 *   swaps only when it is **pressed** — a click, Enter, Space, or the ArrowDown and ArrowUp Base UI's
 *   trigger opens on by itself: Base UI's trigger then replaces it, the focus is put back on it if
 *   the button had it, and the press is **replayed** on the new trigger — the key's `keydown`, then
 *   the `click()` an Enter, a Space or a pointer made — so the menu opens, focuses (the first item,
 *   or the last for ArrowUp) and closes by Base UI's own code. Never a swap when the module merely
 *   arrives: that would replace the element under a press already on its way, the defect
 *   `features/readiness-label.tsx` measured on CI for its popover (#83), whose pattern this is. A
 *   caller's own `onClick` runs once, on the replayed press.
 *
 * **What it trades, accepted in the review of #116:** a *pointer* press on a plain trigger is
 * replayed as a bare `click()`, the path a keyboard's activation takes, so that first opening may
 * put the focus on the first item as a keyboard opening does — once per menu, for the frame's
 * menus only, in a session's first moments.
 *
 * Items render only inside an open menu, so they meet a loaded module. A failed load is forgotten,
 * so the next press tries again, and {@link MENU_LOAD_FAILED} is said beside the trigger in an
 * `alert` region — seen and heard, not a `title` only a pointer finds. `loadActionMenu` is exported
 * for the ui tier's setup file (`test/support/web-lazy-chunks.ts`), which loads the module before a
 * test file renders, so a test meets Base UI's Menu as it did when the import was static.
 */
import { KebabHorizontalIcon } from '@primer/octicons-react/KebabHorizontalIcon';
import {
  cloneElement,
  type MouseEvent,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type * as Base from './action-menu-base.js';
import { IconButton } from './button.js';

type MenuModule = typeof Base;

let menuModule: MenuModule | null = null;
let loading: Promise<MenuModule> | null = null;
const listeners = new Set<() => void>();

/** The menu's module, imported once; a failed import is forgotten so the next caller retries. */
export const loadActionMenu = (): Promise<MenuModule> => {
  loading ??= import('./action-menu-base.js').then(
    (loaded) => {
      menuModule = loaded;
      for (const listener of listeners) listener();
      return loaded;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const currentModule = (): MenuModule | null => menuModule;

/** For the items, which render only inside an open menu: the module, once it is there. */
const useMenuModule = (): MenuModule | null =>
  useSyncExternalStore(subscribe, currentModule, currentModule);

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

/** A press the plain trigger took: whether it had the focus, the key it came by, and its click. */
interface HandOn {
  readonly refocus: boolean;
  readonly key: string | null;
  readonly click: boolean;
}

/** Said beside the trigger when the menu's module could not be loaded; the next press retries. */
export const MENU_LOAD_FAILED = 'Couldn’t open the menu. Try again.';

export const ActionMenu = (props: ActionMenuProps): ReactElement => {
  // The module when this menu first rendered, or the one a press asked for — never a swap of its own.
  const [menu, setMenu] = useState<MenuModule | null>(currentModule);
  const [failed, setFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // A press the plain trigger took, to hand on once Base UI's trigger has replaced it.
  const handOn = useRef<HandOn | null>(null);
  // Enter or Space on the plain trigger: the click the browser makes of it is that key's press.
  const activationKey = useRef<string | null>(null);
  const plain = menu === null;
  useEffect(() => {
    if (plain) {
      // Fetched ahead, and nothing else: a failure here is the press's to say, which tries again.
      loadActionMenu().catch(() => undefined);
    }
  }, [plain]);
  useEffect(() => {
    const press = handOn.current;
    if (menu === null || press === null) {
      return;
    }
    handOn.current = null;
    const trigger = triggerRef.current;
    if (trigger === null) {
      return;
    }
    if (press.refocus) {
      trigger.focus();
    }
    // The press replayed on Base UI's trigger as the browser delivered it: the key first — which
    // Base UI reads to decide the item an opening focuses (an arrow key opens the menu itself) —
    // then the click an Enter, a Space or a pointer made.
    if (press.key !== null) {
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: press.key, bubbles: true, cancelable: true }),
      );
    }
    if (press.click) {
      trigger.click();
    }
  }, [menu]);

  const trigger =
    props.trigger ??
    ((
      <IconButton
        aria-label={props.label}
        icon={<KebabHorizontalIcon size={16} />}
        tone="invisible"
      />
    ) as ReactElement);
  if (menu !== null) {
    return (
      <menu.ActionMenu trigger={trigger} align={props.align ?? 'end'} triggerRef={triggerRef}>
        {props.children}
      </menu.ActionMenu>
    );
  }
  const press = (target: EventTarget, key: string | null, click: boolean): void => {
    const refocus = document.activeElement === target;
    setFailed(false);
    loadActionMenu().then(
      (loaded) => {
        handOn.current = { refocus, key, click };
        setMenu(loaded);
      },
      () => {
        setFailed(true);
      },
    );
  };
  // Base UI's closed trigger's own attributes, so nothing a reader or a test sees changes on arrival.
  return (
    <>
      {cloneElement(trigger as ReactElement<Record<string, unknown>>, {
        'aria-haspopup': 'menu',
        'aria-expanded': false,
        onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            // Base UI's trigger opens on these itself (`openOnArrowKeyDown`), with no click.
            event.preventDefault();
            press(event.currentTarget, event.key, false);
            return;
          }
          activationKey.current = event.key === 'Enter' || event.key === ' ' ? event.key : null;
        },
        onClick: (event: MouseEvent<HTMLElement>) => {
          const key = activationKey.current;
          activationKey.current = null;
          press(event.currentTarget, key, true);
        },
      })}
      {failed ? (
        <span role="alert" className="text-xs text-danger">
          {MENU_LOAD_FAILED}
        </span>
      ) : null}
    </>
  );
};

type ItemProps = Parameters<MenuModule['ActionMenuItem']>[0];
type LinkItemProps = Parameters<MenuModule['ActionMenuLinkItem']>[0];
type DownloadItemProps = Parameters<MenuModule['ActionMenuDownloadItem']>[0];
type RadioItemProps = Parameters<MenuModule['ActionMenuRadioItem']>[0];

export const ActionMenuItem = (props: ItemProps): ReactElement | null => {
  const menu = useMenuModule();
  return menu === null ? null : <menu.ActionMenuItem {...props} />;
};

/**
 * An item that is a link to a URL a provider sent (*Open ticket*, *Open MR*): the menu's link item
 * drawn as `untrusted.tsx`'s `ExternalAnchor` (`action-menu-base.tsx`), so the `href` is
 * `safeHref`'s.
 */
export const ActionMenuLinkItem = (props: LinkItemProps): ReactElement | null => {
  const menu = useMenuModule();
  return menu === null ? null : <menu.ActionMenuLinkItem {...props} />;
};

/** A same-origin download drawn as the caller's element (`action-menu-base.tsx`). */
export const ActionMenuDownloadItem = (props: DownloadItemProps): ReactElement | null => {
  const menu = useMenuModule();
  return menu === null ? null : <menu.ActionMenuDownloadItem {...props} />;
};

/** A labelled radio group of items (the project switcher's). */
export const ActionMenuRadioGroup = <Value extends string>(props: {
  readonly label: string;
  readonly value: Value;
  readonly onValueChange: (value: Value) => void;
  readonly children: ReactNode;
}): ReactElement | null => {
  const menu = useMenuModule();
  return menu === null ? null : <menu.ActionMenuRadioGroup<Value> {...props} />;
};

export const ActionMenuRadioItem = (props: RadioItemProps): ReactElement | null => {
  const menu = useMenuModule();
  return menu === null ? null : <menu.ActionMenuRadioItem {...props} />;
};

export const ActionMenuSeparator = (): ReactElement | null => {
  const menu = useMenuModule();
  return menu === null ? null : <menu.ActionMenuSeparator />;
};

/** Non-interactive text at the top of a menu ("Signed in as …"). */
export const ActionMenuHeader = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <div className="px-3 pt-1.5 pb-2 text-xs text-fg-muted">{children}</div>
);
