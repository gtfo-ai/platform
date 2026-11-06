/**
 * The settings pages' sections, as data (S-23.11b, research/19 § 5.2, TD-033 decision 1).
 *
 * Org settings and a project's settings are **sub-routes with a NavList**, GitHub's settings shape:
 * `/settings/<section>` and `/projects/$key/settings/<section>`. These two tables are the whole set —
 * the route tree validates a section against them (an unknown one is redirected to the section the
 * caller lands on, so a stale link is never a router error), the NavList draws them in this order,
 * and `features/user-guide-census.test.ts` holds `docs/user-guide.md` § 11 to their labels.
 *
 * **The Admin group is three screens with URLs of their own** (product/10's 2026-11-06 IA amendment,
 * Q-UX-1, S-25.6): Integrations, Workers and the Audit log left the top row and are reached from
 * here, but they stay at `/integrations`, `/workers` and `/audit` — the device flow's
 * `/workers/approve?code=…` and the wizard's `/workers/new?step=ready` are links installed workers
 * print, and must resolve for ever. An entry with a `to` is such a link: it is never a
 * `/settings/<section>` page (`/settings/integrations` redirects to `/integrations`), and the route
 * tree draws those screens inside this NavList with their entry current (`features/admin-frame.tsx`).
 *
 * **A section is shown only to a role that can use it** (`minRole`). *Stuck events* and *Failed
 * background jobs* (`org.dead_letters.manage`) and *Linked accounts* (`org.users.manage`) are the
 * administrator's on the server, *Integrations* (`integration.read`) and the *Audit log*
 * (`org.audit.read`) a maintainer's, so for anybody below they are absent from the NavList and
 * their settings paths redirect. *Instance* reads the public `GET /api/version` and *Workers* lists
 * the caller's own machines, so both are everybody's. The gating is a convenience, as the
 * authenticated route's guard is: the server refuses every one of those reads to a lower role
 * regardless, and the screens still name that refusal.
 *
 * **`/settings` lands on the first section the role may change** (research/21 S13, F14), not on
 * *Session*: `changeableFrom` is the lowest role whose changes a section accepts, from the server's
 * permission table (`packages/domain/src/permissions.ts`) — an administrator lands on *Policies*, a
 * maintainer on *Budgets*, anybody else on *Keyboard shortcuts* (this browser's own choice). The
 * Personal group is therefore last: it is what nobody but a member or a viewer lands on.
 *
 * Plain data and no React, so the route tree (in the initial graph) imports it at no cost.
 */
import type { UserRole } from '@platform/contracts';

/** A screen outside `/settings/*` that the org settings' NavList links to (the Admin group). */
export type OrgAdminPath = '/integrations' | '/workers' | '/audit';

export interface SettingsSection<TId extends string = string> {
  readonly id: TId;
  readonly label: string;
  /** Shown only to this role and above: the server refuses its reads to anybody below. */
  readonly minRole?: UserRole;
  /** The lowest role whose changes the section accepts; absent for a section that only reads. */
  readonly changeableFrom?: UserRole;
  /** A screen of its own, linked to rather than drawn at `/settings/<id>` (the Admin group). */
  readonly to?: OrgAdminPath;
}

export interface SettingsGroup<TId extends string = string> {
  readonly label: string;
  readonly sections: readonly SettingsSection<TId>[];
}

export const ORG_SETTINGS_GROUPS = [
  {
    label: 'Organisation',
    sections: [
      { id: 'policies', label: 'Policies', changeableFrom: 'admin' },
      { id: 'notifications', label: 'Notifications', changeableFrom: 'admin' },
      { id: 'budgets', label: 'Budgets', changeableFrom: 'maintainer' },
    ],
  },
  {
    label: 'People',
    sections: [
      { id: 'users', label: 'Users' },
      { id: 'identities', label: 'Linked accounts', minRole: 'admin', changeableFrom: 'admin' },
    ],
  },
  {
    label: 'Admin',
    sections: [
      { id: 'integrations', label: 'Integrations', minRole: 'maintainer', to: '/integrations' },
      { id: 'workers', label: 'Workers', to: '/workers' },
      { id: 'audit', label: 'Audit log', minRole: 'maintainer', to: '/audit' },
    ],
  },
  {
    label: 'Operations',
    sections: [
      { id: 'dead-letters', label: 'Stuck events', minRole: 'admin', changeableFrom: 'admin' },
      { id: 'failed-jobs', label: 'Failed background jobs', minRole: 'admin' },
      { id: 'instance', label: 'Instance' },
    ],
  },
  {
    label: 'Personal',
    // No Appearance: one dark theme (TD-033's 2026-11-05 amendment), so `/settings/appearance`
    // is an unknown section and redirects like any other.
    sections: [
      { id: 'session', label: 'Session' },
      { id: 'keyboard', label: 'Keyboard shortcuts', changeableFrom: 'viewer' },
    ],
  },
] as const satisfies readonly SettingsGroup[];

type OrgEntry = (typeof ORG_SETTINGS_GROUPS)[number]['sections'][number];

/** A section drawn at `/settings/<id>`. */
export type OrgSettingsSectionId = Exclude<OrgEntry, { readonly to: string }>['id'];

/** An Admin entry: a screen of its own, at its own URL. */
export type OrgAdminLinkId = Extract<OrgEntry, { readonly to: string }>['id'];

/** The Admin entries, in the NavList's order — also the command palette's (`app/nav.ts`). */
export const ORG_ADMIN_LINKS: readonly {
  readonly id: OrgAdminLinkId;
  readonly label: string;
  readonly to: OrgAdminPath;
}[] = ORG_SETTINGS_GROUPS.flatMap((group: SettingsGroup) => group.sections).flatMap((section) =>
  section.to === undefined
    ? []
    : [{ id: section.id as OrgAdminLinkId, label: section.label, to: section.to }],
);

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
      { id: 'policies', label: 'Rules & limits' },
      { id: 'repository', label: 'Repository configuration' },
      { id: 'prompts', label: 'Prompt files' },
      { id: 'knowledge', label: 'Knowledge' },
    ],
  },
] as const satisfies readonly SettingsGroup[];

export type ProjectSettingsSectionId =
  (typeof PROJECT_SETTINGS_GROUPS)[number]['sections'][number]['id'];

const ROLE_LEVEL: Readonly<Record<UserRole, number>> = {
  viewer: 10,
  member: 20,
  maintainer: 30,
  admin: 40,
};

/** Whether `role` reaches `minimum`; no session read yet reaches nothing. */
const reaches = (role: UserRole | undefined, minimum: UserRole): boolean =>
  role !== undefined && ROLE_LEVEL[role] >= ROLE_LEVEL[minimum];

/**
 * The groups and entries a caller of `role` is shown — `undefined` (no session read yet) is shown
 * no section with a `minRole` — with a group left empty dropped.
 */
export const orgSettingsGroupsFor = (role: UserRole | undefined): readonly SettingsGroup[] =>
  ORG_SETTINGS_GROUPS.map((group: SettingsGroup) => ({
    label: group.label,
    sections: group.sections.filter(
      (section) => section.minRole === undefined || reaches(role, section.minRole),
    ),
  })).filter((group) => group.sections.length > 0);

const shownTo = (role: UserRole | undefined): readonly SettingsSection[] =>
  orgSettingsGroupsFor(role).flatMap((group) => group.sections);

/** Whether `section` is an org page (never an Admin link) a caller of `role` may open. */
export const isOrgSectionFor = (
  section: string,
  role: UserRole | undefined,
): section is OrgSettingsSectionId =>
  shownTo(role).some(({ id, to }) => id === section && to === undefined);

/** The Admin entry `section` names, if any — `/settings/integrations` goes to `/integrations`. */
export const orgAdminPathOf = (section: string): OrgAdminPath | null =>
  ORG_ADMIN_LINKS.find(({ id }) => id === section)?.to ?? null;

/**
 * The section `/settings` opens: the first page the caller's role may change something on, else the
 * first page it may see (research/21 S13).
 */
export const firstOrgSection = (role: UserRole | undefined): OrgSettingsSectionId => {
  const pages = shownTo(role).filter(
    (section): section is SettingsSection<OrgSettingsSectionId> => section.to === undefined,
  );
  const changeable = pages.find(
    (section) => section.changeableFrom !== undefined && reaches(role, section.changeableFrom),
  );
  return changeable?.id ?? pages[0]?.id ?? 'policies';
};

export const isProjectSection = (section: string): section is ProjectSettingsSectionId =>
  PROJECT_SETTINGS_GROUPS.some((group: SettingsGroup<ProjectSettingsSectionId>) =>
    group.sections.some(({ id }) => id === section),
  );

export const FIRST_PROJECT_SECTION: ProjectSettingsSectionId = 'connections';

/** A section's label, for the page title above it. */
export const sectionLabel = (groups: readonly SettingsGroup[], section: string): string =>
  groups.flatMap((group) => group.sections).find(({ id }) => id === section)?.label ?? section;
