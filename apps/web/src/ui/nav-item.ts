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
}
