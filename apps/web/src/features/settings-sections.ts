/**
 * The settings pages' sections, as data (S-23.11b, research/19 § 5.2, TD-033 decision 1).
 *
 * Org settings and a project's settings are **sub-routes with a NavList**, GitHub's settings shape:
 * `/settings/<section>` and `/projects/$key/settings/<section>`. These two tables are the whole set —
 * the route tree validates a section against them (an unknown one is redirected to the first the
 * caller may open, so a stale link is never a router error), the NavList draws them in this order,
 * and `features/user-guide-census.test.ts` holds `docs/user-guide.md` § 11 to their labels.
 *
 * **The Operations group is shown only to the role that can act on it.** Its reads and the one
 * command in it (a dead letter's re-queue) are the administrator's on the server
 * (`org.dead_letters.manage`), so for anybody else the group is absent from the NavList and its
 * paths redirect. That is a convenience, as the authenticated route's guard is: the server refuses
 * every one of those reads to a non-admin regardless, and the sections still name that refusal.
 *
 * Plain data and no React, so the route tree (in the initial graph) imports it at no cost.
 */
import type { UserRole } from '@platform/contracts';

export interface SettingsSection<TId extends string = string> {
  readonly id: TId;
  readonly label: string;
}

export interface SettingsGroup<TId extends string = string> {
  readonly label: string;
  readonly sections: readonly SettingsSection<TId>[];
  /** Shown only to an administrator. */
  readonly adminOnly?: boolean;
}

export const ORG_SETTINGS_GROUPS = [
  {
    label: 'Personal',
    sections: [
      { id: 'appearance', label: 'Appearance' },
      { id: 'session', label: 'Session' },
    ],
  },
  {
    label: 'Organisation',
    sections: [
      { id: 'policies', label: 'Policies' },
      { id: 'notifications', label: 'Notifications' },
      { id: 'budgets', label: 'Budgets' },
    ],
  },
  {
    label: 'People',
    sections: [
      { id: 'users', label: 'Users' },
      { id: 'identities', label: 'Provider identities' },
    ],
  },
  {
    label: 'Operations',
    adminOnly: true,
    sections: [
      { id: 'dead-letters', label: 'Dead letters' },
      { id: 'failed-jobs', label: 'Failed jobs' },
      { id: 'instance', label: 'Instance' },
    ],
  },
] as const satisfies readonly SettingsGroup[];

export type OrgSettingsSectionId = (typeof ORG_SETTINGS_GROUPS)[number]['sections'][number]['id'];

export const PROJECT_SETTINGS_GROUPS = [
  {
    label: 'Setup',
    sections: [
      { id: 'connections', label: 'Connections' },
      { id: 'execution', label: 'Execution' },
      { id: 'default-branch', label: 'Default branch' },
    ],
  },
  {
    label: 'Discovery',
    sections: [
      { id: 'discovery', label: 'Discovery & readiness' },
      { id: 'business-context', label: 'Business context' },
      { id: 'history', label: 'History' },
    ],
  },
  {
    label: 'Configuration',
    sections: [
      { id: 'policies', label: 'Policies & WIP' },
      { id: 'repository', label: 'Repository configuration' },
      { id: 'prompts', label: 'Prompt files' },
      { id: 'knowledge', label: 'Knowledge' },
    ],
  },
] as const satisfies readonly SettingsGroup[];

export type ProjectSettingsSectionId =
  (typeof PROJECT_SETTINGS_GROUPS)[number]['sections'][number]['id'];

/** The groups a caller of `role` is shown; `undefined` (no session read yet) is shown no admin group. */
export const orgSettingsGroupsFor = (
  role: UserRole | undefined,
): readonly SettingsGroup<OrgSettingsSectionId>[] =>
  ORG_SETTINGS_GROUPS.filter(
    (group: SettingsGroup<OrgSettingsSectionId>) => group.adminOnly !== true || role === 'admin',
  );

/** Whether `section` is an org section a caller of `role` may open. */
export const isOrgSectionFor = (
  section: string,
  role: UserRole | undefined,
): section is OrgSettingsSectionId =>
  orgSettingsGroupsFor(role).some((group) => group.sections.some(({ id }) => id === section));

/** The section `/settings` opens: the first one the caller may see. */
export const firstOrgSection = (role: UserRole | undefined): OrgSettingsSectionId =>
  orgSettingsGroupsFor(role)[0]?.sections[0]?.id ?? 'appearance';

export const isProjectSection = (section: string): section is ProjectSettingsSectionId =>
  PROJECT_SETTINGS_GROUPS.some((group: SettingsGroup<ProjectSettingsSectionId>) =>
    group.sections.some(({ id }) => id === section),
  );

export const FIRST_PROJECT_SECTION: ProjectSettingsSectionId = 'connections';

/** A section's label, for the page title above it. */
export const sectionLabel = (groups: readonly SettingsGroup[], section: string): string =>
  groups.flatMap((group) => group.sections).find(({ id }) => id === section)?.label ?? section;
