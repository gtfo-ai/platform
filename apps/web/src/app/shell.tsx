/**
 * The application shell: navigation, connection status, and the account menu (theme, sign-out).
 *
 * The top bar is **night in both themes** (TD-033 § 2, the brand anchor the wordmark lives on): it
 * is a `data-theme="dark"` scope, so everything drawn in it — the badge, the links, the focus
 * ring — reads the dark tokens whatever the page's theme is. The account menu is Base UI's
 * (`ui/action-menu.tsx`); it replaced a theme `<select>` and a bare sign-out button, and its popup is
 * portalled to `<body>`, so the menu itself is drawn in the page's theme.
 *
 * The connection badge is not decoration. This app never polls (see `queries.ts`), so a stream
 * that has stopped delivering is a screen that has silently stopped updating — the failure product
 * /10 cares about most ("live updates everywhere, no refresh"). The badge is the one place that
 * says whether the promise is being kept, and it is `aria-live` so it is announced rather than only
 * shown.
 */

import { DeviceDesktopIcon } from '@primer/octicons-react/DeviceDesktopIcon';
import { MoonIcon } from '@primer/octicons-react/MoonIcon';
import { SignOutIcon } from '@primer/octicons-react/SignOutIcon';
import { SunIcon } from '@primer/octicons-react/SunIcon';
import { TriangleDownIcon } from '@primer/octicons-react/TriangleDownIcon';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { type ReactElement, useSyncExternalStore } from 'react';
import { displayName, type SessionUser } from '../auth/session.js';
import { useRealtime } from '../realtime/provider.js';
import {
  ActionMenu,
  ActionMenuHeader,
  ActionMenuItem,
  ActionMenuRadioGroup,
  ActionMenuRadioItem,
  ActionMenuSeparator,
} from '../ui/action-menu.js';
import { Avatar } from '../ui/avatar.js';
import { FOCUS_RING } from '../ui/cx.js';
import { Flash } from '../ui/flash.js';
import { Badge, type BadgeTone, Button, cx } from '../ui/kit.js';
import { Logo } from '../ui/logo.js';
import { type ThemePreference, useTheme } from '../ui/theme.js';
import { useSession } from './queries.js';
import { useServices } from './services.js';

/**
 * The top navigation, in order. `docs/user-guide.md` § "The top navigation" lists the same labels;
 * `features/user-guide-census.test.ts` holds the two together (WP-129).
 */
export const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/agents', label: 'Agents' },
  { to: '/inbox', label: 'Inbox' },
  { to: '/integrations', label: 'Integrations' },
  { to: '/onboarding', label: 'Onboarding' },
  { to: '/stats', label: 'Statistics' },
  { to: '/audit', label: 'Audit log' },
  { to: '/workers', label: 'Workers' },
  { to: '/settings', label: 'Settings' },
] as const;

/** Status → what a human is told, and in which colour. Pure, so it is asserted directly. */
export const connectionLabel = (
  status: string,
): { readonly text: string; readonly tone: BadgeTone } => {
  switch (status) {
    case 'open':
      return { text: 'Live', tone: 'success' };
    case 'connecting':
      return { text: 'Connecting', tone: 'neutral' };
    case 'reconnecting':
      return { text: 'Reconnecting', tone: 'warning' };
    case 'server_shutdown':
      return { text: 'Server restarting', tone: 'warning' };
    case 'closed':
      return { text: 'Disconnected', tone: 'danger' };
    default:
      return { text: 'Idle', tone: 'neutral' };
  }
};

/** The three choices, in the order the menu offers them. */
export const THEME_CHOICES: readonly {
  readonly value: ThemePreference;
  readonly label: string;
  readonly icon: ReactElement;
}[] = [
  { value: 'dark', label: 'Dark', icon: <MoonIcon size={16} /> },
  { value: 'light', label: 'Light', icon: <SunIcon size={16} /> },
  { value: 'system', label: 'System', icon: <DeviceDesktopIcon size={16} /> },
];

/**
 * The avatar menu: who is signed in, the theme (a radio group named "Theme"), and "Sign out". The
 * trigger is named "Account menu"; the theme and sign-out keep the names they had as a `<select>`
 * and a button, one "open the menu" step further in.
 */
const AccountMenu = ({
  user,
  onSignOut,
}: {
  readonly user: SessionUser | null;
  readonly onSignOut: () => void;
}): ReactElement => {
  const { preference, setPreference } = useTheme();
  const name = user === null ? 'Not signed in' : displayName(user);
  return (
    <ActionMenu
      trigger={
        <button
          type="button"
          aria-label="Account menu"
          className={cx(
            'inline-flex items-center gap-1 rounded-full p-0.5 pr-1 text-fg-muted hover:text-fg',
            FOCUS_RING,
          )}
        >
          <Avatar name={name} size={24} decorative />
          <TriangleDownIcon size={16} />
        </button>
      }
    >
      <ActionMenuHeader>
        {user === null ? (
          'Not signed in'
        ) : (
          <>
            Signed in as <span className="font-semibold text-fg">{name}</span>
            <span className="block">{`Role: ${user.role}`}</span>
          </>
        )}
      </ActionMenuHeader>
      <ActionMenuSeparator />
      <ActionMenuRadioGroup label="Theme" value={preference} onValueChange={setPreference}>
        {THEME_CHOICES.map((choice) => (
          <ActionMenuRadioItem key={choice.value} value={choice.value} leadingIcon={choice.icon}>
            {choice.label}
          </ActionMenuRadioItem>
        ))}
      </ActionMenuRadioGroup>
      {user === null ? null : (
        <>
          <ActionMenuSeparator />
          <ActionMenuItem leadingIcon={<SignOutIcon size={16} />} onSelect={onSignOut}>
            Sign out
          </ActionMenuItem>
        </>
      )}
    </ActionMenu>
  );
};

/**
 * **"The platform was updated — reload this page"** (WP-154 (d), PROGRESS backlog 487): shown once
 * the server answers `/api/version` with a different build from this bundle's
 * (`platform-version.ts`). A screen whose read was refused for it shows nothing of its own
 * (`ErrorNotice`), so this banner is the one place the page says it — instead of a schema error that
 * reads as a server fault.
 */
export const PlatformUpdatedBanner = (): ReactElement | null => {
  const { platform } = useServices();
  const updated = useSyncExternalStore(platform.subscribe, platform.updated, platform.updated);
  if (!updated) {
    return null;
  }
  return (
    <Flash
      tone="info"
      live="alert"
      data-testid="platform-updated"
      className="rounded-none border-x-0 border-t-0"
      title="The platform was updated — reload this page."
      action={
        <Button
          tone="primary"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </Button>
      }
    >
      This tab still runs the previous version, which cannot read the new server's answers.
    </Flash>
  );
};

export const AppShell = (): ReactElement => {
  const session = useSession();
  const { auth } = useServices();
  const { status } = useRealtime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const connection = connectionLabel(status);
  const user = session.data?.user ?? null;

  return (
    <div className="flex min-h-full flex-col">
      <header
        data-theme="dark"
        className="flex flex-wrap items-center gap-3 border-b border-line bg-header px-4 py-2 text-fg"
      >
        <Link to="/" className={cx('rounded-sm py-1', FOCUS_RING)}>
          <Logo label="Agentic" className="w-20" />
        </Link>
        <nav aria-label="Primary" className="flex flex-wrap gap-1">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cx(
                'rounded-md px-2 py-1 text-sm text-fg-muted hover:bg-subtle hover:text-fg',
                FOCUS_RING,
              )}
              activeProps={{ className: 'bg-subtle font-semibold text-fg' }}
              activeOptions={{ exact: item.to === '/' }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span data-testid="connection-status" role="status" aria-live="polite">
            <Badge tone={connection.tone}>{connection.text}</Badge>
          </span>
          <AccountMenu
            user={user}
            onSignOut={() => {
              void auth.signOut().then(async () => {
                // The whole cache, not just the session: what is in it belongs to the account
                // that is signing out, and the next person at this browser is not that account.
                queryClient.clear();
                await navigate({ to: '/sign-in', search: {} });
              });
            }}
          />
        </div>
      </header>
      <PlatformUpdatedBanner />
      {/* A screen that throws is contained here rather than taking the header with it: every
          route match carries `defaultErrorComponent` (`routes/tree.tsx`), which is the boundary
          the router puts *inside* this outlet. A second boundary wrapped around the outlet would
          sit behind that one and could never fire (standing rule 22), so the backstop is one ring
          further out instead — `ErrorBoundary` in `app/app.tsx`, which catches what the router
          cannot see. `ui/error-boundary.tsx` records the measurement behind that split. */}
      <main className="min-h-0 flex-1 px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
};
