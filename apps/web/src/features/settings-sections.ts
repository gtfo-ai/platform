/**
 * The settings pages' sections, as data (S-23.11b, research/19 § 5.2, TD-033 decision 1).
 *
 * Org settings and a project's settings are **sub-routes with a NavList**, GitHub's settings shape:
 * `/settings/<section>` and `/projects/$key/settings/<section>`. These two tables are the whole set —
 * the route tree validates a section against them (an unknown one is redirected to the first the
 * caller may open, so a stale link is never a router error), the NavList draws them in this order,
 * and `features/user-guide-census.test.ts` holds `docs/user-guide.md` § 11 to their labels.
 *
 * **A section only an administrator can use is shown only to an administrator.** *Dead letters* and
 * *Failed jobs* (`org.dead_letters.manage`) and *Provider identities* (`org.users.manage`) are the
 * administrator's on the server, so for anybody else they are absent from the NavList and their
 * paths redirect. *Instance* reads the public `GET /api/version` and is everybody's. The gating is
 * a convenience, as the authenticated route's guard is: the server refuses every one of those reads
 * to a non-admin regardless, and the sections still name that refusal.
 *
 * Plain data and no React, so the route tree (in the initial graph) imports it at no cost.
 */
import type { UserRole } from '@platform/contracts';

export interface SettingsSection<TId extends string = string> {
  readonly id: TId;
  readonly label: string;
  /** Shown only to an administrator: the server refuses its reads to anybody else. */
  readonly adminOnly?: boolean;
}

export interface SettingsGroup<TId extends string = string> {
  readonly label: string;
  readonly sections: readonly SettingsSection<TId>[];
}

export const ORG_SETTINGS_GROUPS = [
  {
    label: 'Personal',
    // No Appearance: one dark theme (TD-033's 2026-11-05 amendment), so `/settings/appearance`
    // is an unknown section and redirects to Session like any other. Session stays first: it is
    // what `/settings` opens.
    sections: [
      { id: 'session', label: 'Session' },
      { id: 'keyboard', label: 'Keyboard shortcuts' },
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
      { id: 'identities', label: 'Provider identities', adminOnly: true },
    ],
  },
  {
    label: 'Operations',
    sections: [
      { id: 'dead-letters', label: 'Dead letters', adminOnly: true },
      { id: 'failed-jobs', label: 'Failed jobs', adminOnly: true },
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

/**
 * The groups and sections a caller of `role` is shown — `undefined` (no session read yet) is shown
 * no administrator's section — with a group left empty dropped.
 */
export const orgSettingsGroupsFor = (
  role: UserRole | undefined,
): readonly SettingsGroup<OrgSettingsSectionId>[] =>
  ORG_SETTINGS_GROUPS.map((group: SettingsGroup<OrgSettingsSectionId>) => ({
    label: group.label,
    sections: group.sections.filter((section) => section.adminOnly !== true || role === 'admin'),
  })).filter((group) => group.sections.length > 0);

/** Whether `section` is an org section a caller of `role` may open. */
export const isOrgSectionFor = (
  section: string,
  role: UserRole | undefined,
): section is OrgSettingsSectionId =>
  orgSettingsGroupsFor(role).some((group) => group.sections.some(({ id }) => id === section));

/** The section `/settings` opens: the first one the caller may see. */
export const firstOrgSection = (role: UserRole | undefined): OrgSettingsSectionId =>
  orgSettingsGroupsFor(role)[0]?.sections[0]?.id ?? 'session';

export const isProjectSection = (section: string): section is ProjectSettingsSectionId =>
  PROJECT_SETTINGS_GROUPS.some((group: SettingsGroup<ProjectSettingsSectionId>) =>
    group.sections.some(({ id }) => id === section),
  );

export const FIRST_PROJECT_SECTION: ProjectSettingsSectionId = 'connections';

/** A section's label, for the page title above it. */
export const sectionLabel = (groups: readonly SettingsGroup[], section: string): string =>
  groups.flatMap((group) => group.sections).find(({ id }) => id === section)?.label ?? section;
