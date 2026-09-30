/**
 * Org settings (product/10 § "Settings (org)").
 *
 * What is here is what the API answers today: the signed-in session, the theme, the instance
 * version, the user list with roles (`GET /api/org/users`, which needs `org.read`), — since
 * WP-30 — **BD-010's organisation budgets**, which `GET/PUT /api/org/budgets` now serve, and —
 * since WP-43 — the **provider identities** (`features/identities.tsx`), without which every
 * decision arriving from Slack, Jira or GitLab is `unmapped_identity`.
 *
 * The budgets were in this file's "named as absent" list until that work package, and they were the
 * expensive absence: `insert into budgets` occurred in exactly two files and both were tests, so the
 * organisation cap that is supposed to stop every new run everywhere was a row no instance could
 * have. Since WP-93 the **organisation settings document** is here too (`features/org-settings.tsx`,
 * `GET/PATCH /api/org`): the command, autonomy and WIP maximums, quiet hours and the default chat
 * account. Since WP-95 the **dead letters** are here as well (`features/dead-letters.tsx`, `GET
 * /api/org/dead-letters` and its re-queue) — an operator's instrument, admin only, on the page an
 * administrator already opens. What is *still* absent is the rest of that list — the Claude provider mode (an
 * environment setting, `APP_PROVIDER_MODE`) and feature flags (a project's `features.*`) — which
 * the document does not carry; they stay named rather than drawn as controls that silently do
 * nothing.
 *
 * A **project's** settings are `features/project-settings.tsx`, which mirrors the whole wizard.
 */
import type { ReactElement } from 'react';
import {
  useOrgBudgets,
  useOrgUsers,
  useSession,
  useSettingsCommands,
  useVersion,
} from '../app/queries.js';
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
import { DeadLetters } from './dead-letters.js';
import { IdentityMappings } from './identities.js';
import { Budgets } from './operating-mode.js';
import { OrganisationSettingsPanel } from './org-settings.js';

export const SettingsScreen = (): ReactElement => {
  const session = useSession();
  const users = useOrgUsers();
  const version = useVersion();
  const budgets = useOrgBudgets();
  const commands = useSettingsCommands();
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

      {/* WP-43: the screen `POST /api/org/identities` never had, so a decision from chat or a
          ticket resolves to a person instead of `unmapped_identity`. */}
      <IdentityMappings />

      {/* WP-93: the organisation settings document — the writer the organisation layer never had. */}
      <OrganisationSettingsPanel />

      {/* WP-95, backlog 126: the events the dispatcher gave up on, and the re-queue that serves one
          again — the operator guide's hand-typed `update`, made a product action. Admin only. */}
      <DeadLetters />

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
            The Claude provider mode is an environment setting and feature flags are a project’s, so
            neither is editable here. The organisation’s maximums are — above — and so are its
            budgets, below.
          </p>
        </Card>
      </section>
      <section>
        {/* The heading is the `Budgets` component's own — `Organisation budgets` — so this section
            does not repeat it: two elements with one string is a locator that cannot be written. */}
        {budgets.isPending ? <Loading label="Loading budgets…" /> : null}
        {budgets.isError ? (
          <ErrorNotice
            title="The organisation budgets could not be loaded."
            detail="Reading a budget needs the viewer role; setting one needs maintainer."
          />
        ) : null}
        <Budgets
          projectId={null}
          budgets={budgets.data?.items ?? []}
          pending={commands.setOrgBudget.isPending}
          error={commands.setOrgBudget.error}
          scopeLabel="Organisation"
          onSave={(window, limitUsd) => {
            commands.setOrgBudget.mutate({ window, limit_usd: limitUsd });
          }}
        />
      </section>
    </div>
  );
};
