/**
 * The organisation's navigation, as data (S-23.4; TD-033 § 1) — the UnderlineNav under the top bar
 * outside a project (`shell.tsx`), and the screens the command palette offers
 * (`command-palette.tsx`). A module of its own so the palette's lazy chunk can read it without
 * importing the shell that loads the chunk.
 */
import { DependabotIcon } from '@primer/octicons-react/DependabotIcon';
import { GearIcon } from '@primer/octicons-react/GearIcon';
import { GraphIcon } from '@primer/octicons-react/GraphIcon';
import { HomeIcon } from '@primer/octicons-react/HomeIcon';
import { InboxIcon } from '@primer/octicons-react/InboxIcon';
import { LogIcon } from '@primer/octicons-react/LogIcon';
import { PlugIcon } from '@primer/octicons-react/PlugIcon';
import { RepoIcon } from '@primer/octicons-react/RepoIcon';
import { ServerIcon } from '@primer/octicons-react/ServerIcon';
import type { Icon } from '@primer/octicons-react/types';
import type { NavBreakpoint } from '../ui/nav-item.js';

/** Which of the shell's three reads a navigation entry's counter comes from. */
export type NavCount = 'projects' | 'inbox' | 'running';

export interface NavEntry {
  readonly to:
    | '/'
    | '/projects'
    | '/inbox'
    | '/agents'
    | '/workers'
    | '/integrations'
    | '/stats'
    | '/audit'
    | '/settings';
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
  { to: '/workers', label: 'Workers', icon: ServerIcon, collapseBelow: 'md' },
  { to: '/integrations', label: 'Integrations', icon: PlugIcon, collapseBelow: 'md' },
  { to: '/stats', label: 'Statistics', icon: GraphIcon, collapseBelow: 'lg' },
  { to: '/audit', label: 'Audit log', icon: LogIcon, collapseBelow: 'lg' },
  { to: '/settings', label: 'Settings', icon: GearIcon, collapseBelow: 'lg' },
];

/** Whether `pathname` is inside a navigation entry's section (`/workers/approve` is Workers'). */
export const isCurrentSection = (to: NavEntry['to'], pathname: string): boolean =>
  to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);
