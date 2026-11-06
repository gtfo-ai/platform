/**
 * The organisation's navigation, as data (S-23.4; TD-033 § 1) — the UnderlineNav under the top bar
 * outside a project (`shell.tsx`), and the screens the command palette offers
 * (`command-palette.tsx`). A module of its own so the palette's lazy chunk can read it without
 * importing the shell that loads the chunk.
 *
 * **The row is the five daily screens** (product/10's 2026-11-06 IA amendment, Q-UX-1, S-25.6):
 * Home, Projects, Inbox, Agents and Statistics. Integrations, Workers and the Audit log are the
 * *Admin* group of org Settings (`features/settings-sections.ts`), at the URLs they always had, and
 * Settings itself is the account menu's (`shell.tsx`), as GitHub's is. The palette still offers
 * every one of them by name (`PALETTE_SCREENS`).
 */
import { DependabotIcon } from '@primer/octicons-react/DependabotIcon';
import { GraphIcon } from '@primer/octicons-react/GraphIcon';
import { HomeIcon } from '@primer/octicons-react/HomeIcon';
import { InboxIcon } from '@primer/octicons-react/InboxIcon';
import { RepoIcon } from '@primer/octicons-react/RepoIcon';
import type { Icon } from '@primer/octicons-react/types';
import { ORG_ADMIN_LINKS, type OrgAdminPath } from '../features/settings-sections.js';
import type { NavBreakpoint } from '../ui/nav-item.js';

/** Which of the shell's three reads a navigation entry's counter comes from. */
export type NavCount = 'projects' | 'inbox' | 'running';

export interface NavEntry {
  readonly to: '/' | '/projects' | '/inbox' | '/agents' | '/stats';
  readonly label: string;
  readonly icon: Icon;
  readonly count?: NavCount;
  readonly collapseBelow?: NavBreakpoint;
}

/**
 * The organisation's navigation, in order — the UnderlineNav under the top bar outside a project
 * (TD-033 § 1; inside one, the project's tabs take its place). `docs/user-guide.md` § "The top
 * navigation" lists the same labels; `features/user-guide-census.test.ts` holds the two together
 * (WP-129). *Onboarding* is not here: it is done once per project, so it is **New project** — in
 * the `+` menu and on the Projects page (research/19 § 5.1).
 */
export const NAV: readonly NavEntry[] = [
  { to: '/', label: 'Home', icon: HomeIcon },
  { to: '/projects', label: 'Projects', icon: RepoIcon, count: 'projects' },
  { to: '/inbox', label: 'Inbox', icon: InboxIcon, count: 'inbox' },
  { to: '/agents', label: 'Agents', icon: DependabotIcon, count: 'running', collapseBelow: 'sm' },
  { to: '/stats', label: 'Statistics', icon: GraphIcon, collapseBelow: 'md' },
];

/** A screen the palette may jump to: the row's, Settings, and Settings' Admin screens. */
export type ScreenPath = NavEntry['to'] | '/settings' | OrgAdminPath;

/** Every organisation screen by name, in the palette's order (S-25.6: the moved ones too). */
export const PALETTE_SCREENS: readonly { readonly to: ScreenPath; readonly label: string }[] = [
  ...NAV.map(({ to, label }) => ({ to, label })),
  { to: '/settings', label: 'Settings' },
  ...ORG_ADMIN_LINKS.map(({ to, label }) => ({ to, label })),
];

/** Whether `pathname` is inside a screen's section (`/workers/approve` is Workers'). */
export const isCurrentSection = (to: ScreenPath, pathname: string): boolean =>
  to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);
