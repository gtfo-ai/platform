/**
 * Org settings (product/10 § "Settings (org)") — since S-23.11b GitHub's settings shape: a NavList
 * of sections (`features/settings-sections.ts`) and one section per page at `/settings/<section>`,
 * each with one Save where it writes anything (research/19 § 5.2):
 *
 *  - **Personal** — *Appearance* (the theme, this browser's own choice, applied as it is picked) and
 *    *Session* (who is signed in, with which role);
 *  - **Organisation** — *Policies* (the command, autonomy and WIP maximums) and *Notifications*
 *    (quiet hours, digest, the default chat account), the two halves of the organisation settings
 *    document (`features/org-settings.tsx`, `GET/PATCH /api/org`, WP-93), and *Budgets* — BD-010's
 *    organisation caps, `GET/PUT /api/org/budgets` (WP-30);
 *  - **People** — *Users* (`GET /api/org/users`, which needs `org.read`) and *Provider identities*
 *    (`features/identities.tsx`, WP-43), without which every decision arriving from Slack, Jira or
 *    GitLab is `unmapped_identity`;
 *  - **Operations**, the administrator's only — *Dead letters* (`features/dead-letters.tsx`, WP-95:
 *    the events the dispatcher gave up on, and the re-queue), *Failed jobs* (`features/failed-jobs.tsx`,
 *    WP-108) and *Instance* (the version and build).
 *
 * The budgets were the expensive absence once: `insert into budgets` occurred in exactly two files
 * and both were tests, so the organisation cap that is supposed to stop every new run everywhere was
 * a row no instance could have. What is *still* not here is the Claude provider mode (an environment
 * setting, `APP_PROVIDER_MODE`) and feature flags (a project's `features.*`): the document does not
 * carry them, and the Instance page says so rather than drawing controls that silently do nothing.
 *
 * A **project's** settings are `features/project-settings.tsx`, which mirrors the whole wizard.
 */
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { readErrorDetail } from '../api/read-error.js';
import {
  useOrgBudgets,
  useOrgUsers,
  useSession,
  useSettingsCommands,
  useVersion,
} from '../app/queries.js';
import { displayName } from '../auth/session.js';
import { Avatar } from '../ui/avatar.js';
import { Blankslate } from '../ui/blankslate.js';
import { USER_ROLE_LABEL, USER_STATUS_LABEL } from '../ui/humanize.js';
import { Badge, ErrorNotice, formatDateTime, Loading } from '../ui/kit.js';
import { ListBox, ListBoxHeader, ListRow } from '../ui/list-box.js';
import { PageHeader } from '../ui/page-header.js';
import { StatusIcon } from '../ui/status.js';
import { type ThemePreference, useTheme } from '../ui/theme.js';
import { UntrustedText } from '../ui/untrusted.js';
import { DeadLetters } from './dead-letters.js';
import { FailedJobs } from './failed-jobs.js';
import { IdentityMappings } from './identities.js';
import { Budgets } from './operating-mode.js';
import { OrganisationNotifications, OrganisationPolicies } from './org-settings.js';
import { SettingsFrame, SettingsSectionHeader } from './settings-frame.js';
import { type OrgSettingsSectionId, orgSettingsGroupsFor } from './settings-sections.js';

const THEME_LABEL: Readonly<Record<ThemePreference, string>> = {
  system: 'Same as the system',
  light: 'Light',
  dark: 'Dark',
};

const Appearance = (): ReactElement => {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <>
      <SettingsSectionHeader
        title="Appearance"
        description="How this application looks in this browser. A choice applies as you pick it, and is kept in this browser only."
      />
      <label className="flex w-fit flex-col gap-1 text-sm">
        Theme
        <select
          aria-label="Theme preference"
          value={preference}
          onChange={(event) => {
            setPreference(event.target.value as ThemePreference);
          }}
          className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
        >
          {(['system', 'light', 'dark'] as const).map((option) => (
            <option key={option} value={option}>
              {THEME_LABEL[option]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-fg-muted">
        {`Showing the ${resolved === 'dark' ? 'dark' : 'light'} theme.`}
      </p>
    </>
  );
};

const Session = (): ReactElement => {
  const session = useSession();
  const user = session.data?.user;
  return (
    <>
      <SettingsSectionHeader title="Session" description="Who is signed in, and with which role." />
      {user === undefined ? (
        <p className="text-sm text-fg-muted">Not signed in.</p>
      ) : (
        <div className="flex items-center gap-3 text-sm">
          <Avatar name={displayName(user)} size={40} decorative />
          <div className="flex flex-col">
            <span className="font-semibold">
              <UntrustedText value={displayName(user)} />
            </span>
            <span className="text-fg-muted">
              <UntrustedText value={user.email} />
            </span>
            <span className="text-xs text-fg-muted">{`Role: ${USER_ROLE_LABEL[user.role]}`}</span>
          </div>
        </div>
      )}
    </>
  );
};

const Users = (): ReactElement => {
  const users = useOrgUsers();
  const items = users.data?.items ?? [];
  return (
    <>
      <SettingsSectionHeader
        title="Users"
        description="Everybody with an account on this instance, and their role."
      />
      {users.isPending ? <Loading label="Loading users…" /> : null}
      {users.isError ? (
        <ErrorNotice
          title="The user list could not be loaded."
          error={users.error}
          detail={readErrorDetail(
            users.error,
            'Reading the organisation needs the viewer role or above.',
          )}
        />
      ) : null}
      {users.isSuccess && items.length === 0 ? (
        <Blankslate
          informational
          title="No users"
          hint="A fresh instance takes its first administrator from APP_BOOTSTRAP_ADMIN_EMAIL; everyone else is invited by an administrator."
        />
      ) : null}
      {items.length === 0 ? null : (
        <ListBox
          label="Users"
          header={
            <ListBoxHeader>
              <span className="font-semibold text-fg">
                {items.length === 1 ? '1 person' : `${items.length} people`}
              </span>
            </ListBoxHeader>
          }
        >
          {items.map((user) => (
            <ListRow
              key={user.id}
              leading={<Avatar name={user.name ?? user.email} decorative />}
              title={<UntrustedText value={user.name ?? user.email} />}
              meta={user.name === null ? undefined : <UntrustedText value={user.email} />}
              trailing={
                <>
                  <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>
                    {USER_ROLE_LABEL[user.role]}
                  </Badge>
                  <span className="inline-flex items-center gap-1">
                    <StatusIcon
                      status={user.status === 'active' ? 'success' : 'waiting'}
                      decorative
                      size={12}
                    />
                    {USER_STATUS_LABEL[user.status]}
                  </span>
                </>
              }
            />
          ))}
        </ListBox>
      )}
    </>
  );
};

const OrgBudgets = (): ReactElement => {
  const budgets = useOrgBudgets();
  const commands = useSettingsCommands();
  return (
    <>
      {/* The heading is the `Budgets` component's own — `Organisation budgets` — so this page
          does not repeat it: two elements with one string is a locator that cannot be written. */}
      {budgets.isPending ? <Loading label="Loading budgets…" /> : null}
      {budgets.isError ? (
        <ErrorNotice
          title="The organisation budgets could not be loaded."
          error={budgets.error}
          detail={readErrorDetail(
            budgets.error,
            'Reading a budget needs the viewer role; setting one needs maintainer.',
          )}
        />
      ) : null}
      <Budgets
        projectId={null}
        budgets={budgets.data?.items ?? []}
        scopeLabel="Organisation"
        primary
        onSave={(window, limitUsd) =>
          commands.setOrgBudget.mutateAsync({ window, limit_usd: limitUsd })
        }
      />
    </>
  );
};

const Instance = (): ReactElement => {
  const version = useVersion();
  return (
    <>
      <SettingsSectionHeader title="Instance" description="The release this server is running." />
      {version.data === undefined ? (
        <p className="text-sm text-fg-muted">Version unavailable.</p>
      ) : (
        <dl className="grid w-fit grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-fg-muted">Version</dt>
          <dd className="font-mono">
            <UntrustedText value={version.data.version} />
          </dd>
          {version.data.commit === null ? null : (
            <>
              <dt className="text-fg-muted">Commit</dt>
              <dd className="font-mono">
                <UntrustedText value={version.data.commit} />
              </dd>
            </>
          )}
          {version.data.built_at === null ? null : (
            <>
              <dt className="text-fg-muted">Built</dt>
              <dd>{formatDateTime(version.data.built_at)}</dd>
            </>
          )}
        </dl>
      )}
      <p className="text-xs text-fg-muted">
        The Claude provider mode is an environment setting and feature flags are a project’s, so
        neither is editable here. The organisation’s maximums are under Policies, and its budgets
        under Budgets.
      </p>
    </>
  );
};

const SECTION: Readonly<Record<OrgSettingsSectionId, () => ReactElement>> = {
  appearance: Appearance,
  session: Session,
  policies: () => (
    <>
      <SettingsSectionHeader
        title="Policies"
        description="The maximums every project is held to: the commands a run may use, the highest autonomy level and the work in progress."
      />
      <OrganisationPolicies />
    </>
  ),
  notifications: () => (
    <>
      <SettingsSectionHeader
        title="Notifications"
        description="When the organisation’s own messages are posted, and by which chat account."
      />
      <OrganisationNotifications />
    </>
  ),
  budgets: OrgBudgets,
  users: Users,
  identities: IdentityMappings,
  'dead-letters': DeadLetters,
  'failed-jobs': FailedJobs,
  instance: Instance,
};

export const SettingsScreen = ({
  section,
}: {
  readonly section: OrgSettingsSectionId;
}): ReactElement => {
  const session = useSession();
  const Section = SECTION[section];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Settings" />
      <SettingsFrame
        label="Settings"
        groups={orgSettingsGroupsFor(session.data?.user.role)}
        current={section}
        link={(id, props) => <Link to="/settings/$section" params={{ section: id }} {...props} />}
      >
        <Section />
      </SettingsFrame>
    </div>
  );
};
