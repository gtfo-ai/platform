/**
 * What UnderlineNav and NavList items share: how an item becomes a link without `ui/` knowing the
 * router (the worker's local page imports `ui/` and has no TanStack Router), and without `ui/`
 * writing an `href` (`no-html.test.ts` admits URL attributes in `untrusted.tsx` only).
 *
 * An item with `render` is drawn by the caller — `render: (props) => <Link to="/agents" {...props} />`
 * — with the class, the `aria-current` and the content this module decided. An item without one is
 * a `<button>` that calls `onSelect`.
 */
import type { ReactElement, ReactNode } from 'react';

export interface NavLinkProps {
  readonly className: string;
  readonly 'aria-current'?: 'page';
  readonly children: ReactNode;
}

export interface NavItem {
  readonly id: string;
  readonly label: string;
  /** An Octicon element; decorative. */
  readonly icon?: ReactNode;
  readonly counter?: number;
  readonly current?: boolean;
  readonly render?: (props: NavLinkProps) => ReactElement;
  readonly onSelect?: () => void;
  /**
   * UnderlineNav only: below this breakpoint the item leaves the row for the "More" menu (GitHub's
   * overflow). An item that collapses needs `onSelect`, which is what the menu calls.
   */
  readonly collapseBelow?: NavBreakpoint;
}

/** Tailwind's default breakpoints, in pixels: the CSS hides the row's item, the menu reads these. */
export type NavBreakpoint = 'sm' | 'md' | 'lg' | 'xl';

export const NAV_BREAKPOINT_PX: Readonly<Record<NavBreakpoint, number>> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
};
