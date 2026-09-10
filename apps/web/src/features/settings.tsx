/**
 * Org settings (product/10 § "Settings (org)").
 *
 * What is here is what the API answers today: the signed-in session, the theme, the instance
 * version and the user list with roles (`GET /api/org/users`, which needs `org.read`). Autonomy
 * defaults, provider mode, global budgets and feature flags need `GET/PATCH /api/org`, which no
 * work package has built — they are named as absent rather than drawn as empty controls that
 * silently do nothing.
 */
import type { ReactElement } from 'react';
import { useOrgUsers, useSession, useVersion } from '../app/queries.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  formatDateTime,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { useTheme } from '../ui/theme.js';
import { UntrustedText } from '../ui/untrusted.js';

export const SettingsScreen = (): ReactElement => {
  const session = useSession();
  const users = useOrgUsers();
  const version = useVersion();
  const { preference, resolved, setPreference } = useTheme();

  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionHeading>Appearance</SectionHeading>
        <Card className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            Theme
            <select
              aria-label="Theme preference"
              value={preference}
              onChange={(event) => {
                setPreference(event.target.value as 'light' | 'dark' | 'system');
              }}
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <Badge>{`resolved: ${resolved}`}</Badge>
        </Card>
      </section>

      <section>
        <SectionHeading>Session</SectionHeading>
        <Card className="flex flex-col gap-1 text-sm">
          {session.data === null || session.data === undefined ? (
            <p className="text-fg-muted">Not signed in.</p>
          ) : (
            <>
              <p>
                <UntrustedText value={session.data.user.email} />
              </p>
              <p className="text-xs text-fg-muted">Role: {session.data.user.role}</p>
            </>
          )}
        </Card>
      </section>

      <section>
        <SectionHeading>Users</SectionHeading>
        {users.isPending ? <Loading label="Loading users…" /> : null}
        {users.isError ? (
          <ErrorNotice
            title="The user list could not be loaded."
            detail="Reading the organisation needs the viewer role or above."
          />
        ) : null}
        {users.isSuccess && users.data.items.length === 0 ? (
          <EmptyState
            title="No users"
            hint="A fresh instance takes its first administrator from APP_BOOTSTRAP_ADMIN_EMAIL; everyone else is invited by an administrator."
          />
        ) : null}
        <ul className="flex flex-col gap-1">
          {(users.data?.items ?? []).map((user) => (
            <li key={user.id}>
              <Card className="flex items-center gap-2 text-sm">
                <UntrustedText value={user.email} />
                <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>{user.role}</Badge>
                <Badge tone={user.status === 'active' ? 'success' : 'warning'}>{user.status}</Badge>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <SectionHeading>Instance</SectionHeading>
        <Card className="flex flex-col gap-1 text-sm">
          {version.data === undefined ? (
            <p className="text-fg-muted">Version unavailable.</p>
          ) : (
            <>
              <p className="font-mono text-xs">
                <UntrustedText value={version.data.version} />
                {version.data.commit === null ? null : (
                  <>
                    {' · '}
                    <UntrustedText value={version.data.commit} />
                  </>
                )}
              </p>
              {version.data.built_at === null ? null : (
                <p className="text-xs text-fg-muted">
                  built {formatDateTime(version.data.built_at)}
                </p>
              )}
            </>
          )}
          <p className="pt-2 text-xs text-fg-muted">
            Autonomy defaults, the Claude provider mode, global budgets and feature flags are org
            settings that <code>GET/PATCH /api/org</code> will carry; no work package has built that
            endpoint yet, so they are not editable here.
          </p>
        </Card>
      </section>
    </div>
  );
};
