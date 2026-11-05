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

/** The caller's link when it gave one, a button otherwise. */
export const renderNavItem = (item: NavItem, className: string): ReactElement => {
  const props: NavLinkProps = {
    className,
    ...(item.current === true ? { 'aria-current': 'page' as const } : {}),
    children: navItemContent(item),
  };
  if (item.render !== undefined) {
    return item.render(props);
  }
  return (
    <button
      type="button"
      className={props.className}
      aria-current={props['aria-current']}
      onClick={item.onSelect}
    >
      {props.children}
    </button>
  );
};
