/**
 * The application shell: navigation, theme control, connection status, sign-out.
 *
 * The connection badge is not decoration. This app never polls (see `queries.ts`), so a stream
 * that has stopped delivering is a screen that has silently stopped updating — the failure product
 * /10 cares about most ("live updates everywhere, no refresh"). The badge is the one place that
 * says whether the promise is being kept, and it is `aria-live` so it is announced rather than only
 * shown.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { displayName } from '../auth/session.js';
import { useRealtime } from '../realtime/provider.js';
import { Badge, type BadgeTone, Button, cx } from '../ui/kit.js';
import { type ThemePreference, useTheme } from '../ui/theme.js';
import { useSession } from './queries.js';
import { useServices } from './services.js';

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/agents', label: 'Agents' },
  { to: '/inbox', label: 'Inbox' },
  { to: '/integrations', label: 'Integrations' },
  { to: '/stats', label: 'Statistics' },
  { to: '/audit', label: 'Audit log' },
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

const ThemeControl = (): ReactElement => {
  const { preference, setPreference } = useTheme();
  return (
    <label className="flex items-center gap-1 text-xs text-fg-muted">
      Theme
      <select
        aria-label="Theme"
        value={preference}
        onChange={(event) => {
          setPreference(event.target.value as ThemePreference);
        }}
        className="rounded-md border border-line bg-surface px-1.5 py-1 text-xs"
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
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
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2">
        <Link to="/" className="text-sm font-semibold">
          Agentic
        </Link>
        <nav aria-label="Primary" className="flex flex-wrap gap-1">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cx('rounded-md px-2 py-1 text-sm text-fg-muted hover:bg-surface-muted')}
              activeProps={{ className: 'bg-surface-muted text-fg' }}
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
          <ThemeControl />
          {user === null ? null : (
            <>
              <span className="text-xs text-fg-muted">{displayName(user)}</span>
              <Button
                tone="ghost"
                onClick={() => {
                  void auth.signOut().then(async () => {
                    // The whole cache, not just the session: what is in it belongs to the account
                    // that is signing out, and the next person at this browser is not that account.
                    queryClient.clear();
                    await navigate({ to: '/sign-in', search: {} });
                  });
                }}
              >
                Sign out
              </Button>
            </>
          )}
        </div>
      </header>
      {/* A screen that throws is contained here rather than taking the header with it: every
          route match carries `defaultErrorComponent` (`routes/tree.tsx`), which is the boundary
          the router puts *inside* this outlet. A second boundary wrapped around the outlet would
          sit behind that one and could never fire (standing rule 22), so the backstop is one ring
          further out instead — `ErrorBoundary` in `app/app.tsx`, which catches what the router
          cannot see. `ui/error-boundary.tsx` records the measurement behind that split. */}
      <main className="min-h-0 flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
};
