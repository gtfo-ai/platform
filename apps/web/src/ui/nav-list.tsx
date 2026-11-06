/**
 * NavList: the left column of a screen — sub-sections, filters or a job list (TD-033 § 1).
 *
 * Groups take an optional heading. The current item carries `aria-current="page"`, a subtle fill and
 * a bar in the link colour on its leading edge, as GitHub's settings sidebar does.
 *
 * **On a narrow screen it is a disclosure** (S-23.13a): below `stackBelow` — the breakpoint at which
 * the caller's grid stacks the column above the content — the same list sits inside a `<details>`
 * whose summary names the current item, so a phone sees the section it is on and one line, not
 * thirteen links before the content. The width is read through `matchMedia` (as UnderlineNav's
 * overflow is) and only one of the two shapes is rendered, so there is one landmark either way; the
 * disclosure is keyed by the current item, so choosing one closes it.
 */
import { ChevronDownIcon } from '@primer/octicons-react/ChevronDownIcon';
import type { ReactElement } from 'react';
import { useCallback, useId, useSyncExternalStore } from 'react';
import { cx, FOCUS_RING } from './cx.js';
import { NAV_BREAKPOINT_PX, type NavBreakpoint, type NavItem } from './nav-item.js';
import { renderNavItem } from './nav-render.js';

export interface NavListGroup {
  readonly label?: string;
  readonly items: readonly NavItem[];
}

const Group = ({ group }: { readonly group: NavListGroup }): ReactElement => {
  const headingId = useId();
  return (
    <div className="flex flex-col gap-0.5 pb-2">
      {group.label === undefined ? null : (
        <h3 id={headingId} className="px-2 pt-2 pb-1 text-xs font-semibold text-fg-muted">
          {group.label}
        </h3>
      )}
      <ul
        className="flex flex-col gap-0.5"
        {...(group.label === undefined ? {} : { 'aria-labelledby': headingId })}
      >
        {group.items.map((item) => (
          <li key={item.id} className="relative">
            {item.current === true ? (
              <span
                aria-hidden="true"
                data-selected-bar=""
                className="absolute top-1.5 bottom-1.5 -left-2 w-1 rounded-full bg-link"
              />
            ) : null}
            {renderNavItem(
              item,
              cx(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                FOCUS_RING,
                item.current === true
                  ? 'bg-muted font-semibold text-fg'
                  : 'text-fg hover:bg-subtle',
              ),
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

const minWidthQuery = (breakpoint: NavBreakpoint): string =>
  `(min-width: ${NAV_BREAKPOINT_PX[breakpoint]}px)`;

/** Whether the viewport has reached `breakpoint`; `true` where there is no `matchMedia`. */
const useReached = (breakpoint: NavBreakpoint): boolean => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => undefined;
      }
      const list = window.matchMedia(minWidthQuery(breakpoint));
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    [breakpoint],
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window === 'undefined' || typeof window.matchMedia !== 'function'
        ? true
        : window.matchMedia(minWidthQuery(breakpoint)).matches,
    () => true,
  );
};

export const NavList = ({
  label,
  groups,
  className,
  stackBelow = 'md',
}: {
  readonly label: string;
  readonly groups: readonly NavListGroup[];
  readonly className?: string;
  /** Where the caller's layout stacks this column above the content: a disclosure below it. */
  readonly stackBelow?: NavBreakpoint;
}): ReactElement => {
  const wide = useReached(stackBelow);
  const list = groups.map((group, index) => <Group key={group.label ?? index} group={group} />);
  if (wide) {
    return (
      <nav aria-label={label} className={cx('pl-2', className)}>
        {list}
      </nav>
    );
  }
  const current = groups.flatMap((group) => group.items).find((item) => item.current === true);
  return (
    <nav
      aria-label={label}
      data-nav-list="disclosure"
      className={cx('rounded-md border border-line bg-default', className)}
    >
      <details key={current?.id ?? ''} className="group">
        <summary
          className={cx(
            'flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2 text-sm [&::-webkit-details-marker]:hidden',
            FOCUS_RING,
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            <span className="text-fg-muted">{label}: </span>
            <span className="font-semibold text-fg">{current?.label ?? 'choose'}</span>
          </span>
          <span aria-hidden="true" className="inline-flex text-fg-muted group-open:rotate-180">
            <ChevronDownIcon size={16} />
          </span>
        </summary>
        <div className="border-t border-line py-1 pr-2 pl-4">{list}</div>
      </details>
    </nav>
  );
};
