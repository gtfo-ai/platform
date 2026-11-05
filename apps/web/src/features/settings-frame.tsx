/**
 * The settings pages' shape (S-23.11b, TD-033 decision 1): a NavList of the sections on the left,
 * the current section on the right — GitHub's repository and account settings. The org settings and
 * a project's settings both use it; what differs is the table of sections and how a section's link
 * is made, which the caller passes.
 *
 * Each section is a page with its own title and, where it writes anything, **one** Save at its foot.
 * A section is never a long scroll of other sections' controls.
 */
import type { ReactElement, ReactNode } from 'react';
import type { NavLinkProps } from '../ui/nav-item.js';
import { NavList } from '../ui/nav-list.js';
import type { SettingsGroup } from './settings-sections.js';

export const SettingsFrame = <TId extends string>({
  label,
  groups,
  current,
  link,
  children,
}: {
  /** The NavList's accessible name. */
  readonly label: string;
  readonly groups: readonly SettingsGroup<TId>[];
  readonly current: TId;
  readonly link: (section: TId, props: NavLinkProps) => ReactElement;
  readonly children: ReactNode;
}): ReactElement => (
  <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
    <NavList
      label={label}
      groups={groups.map((group) => ({
        label: group.label,
        items: group.sections.map((section) => ({
          id: section.id,
          label: section.label,
          current: section.id === current,
          render: (props: NavLinkProps) => link(section.id, props),
        })),
      }))}
    />
    <div data-settings-section={current} className="flex min-w-0 flex-col gap-4">
      {children}
    </div>
  </div>
);

/** A section's title and the one sentence that says what it is for. */
export const SettingsSectionHeader = ({
  title,
  description,
}: {
  readonly title: string;
  readonly description?: ReactNode;
}): ReactElement => (
  <div className="flex flex-col gap-1 border-b border-line pb-3">
    <h2 className="text-lg font-semibold text-fg">{title}</h2>
    {description === undefined ? null : <p className="text-sm text-fg-muted">{description}</p>}
  </div>
);
