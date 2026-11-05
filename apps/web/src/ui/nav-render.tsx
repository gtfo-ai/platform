import type { ReactElement, ReactNode } from 'react';
import { Counter } from './counter.js';
import type { NavItem, NavLinkProps } from './nav-item.js';

/** The item's content: icon, label, counter — in that order, as GitHub draws them. */
export const navItemContent = (item: NavItem): ReactNode => (
  <>
    {item.icon === undefined ? null : (
      <span aria-hidden="true" className="inline-flex text-fg-muted">
        {item.icon}
      </span>
    )}
    <span>{item.label}</span>
    {item.counter === undefined ? null : <Counter count={item.counter} />}
  </>
);

/**
 * The caller's link when it gave one (marked `aria-current="page"` when current), a button
 * otherwise (marked `aria-pressed`).
 */
export const renderNavItem = (item: NavItem, className: string): ReactElement => {
  const props: NavLinkProps = {
    className,
    ...(item.current === true ? { 'aria-current': 'page' as const } : {}),
    children: navItemContent(item),
  };
  if (item.render !== undefined) {
    return item.render(props);
  }
  // Without a link the item is a toggle among views on the same page, not a page: it says it is
  // the selected one with `aria-pressed`, which is what a button's state is (APG button pattern).
  return (
    <button
      type="button"
      className={props.className}
      aria-pressed={item.current === true}
      onClick={item.onSelect}
    >
      {props.children}
    </button>
  );
};
