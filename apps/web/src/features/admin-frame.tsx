/**
 * The frame of the org settings' **Admin** screens — Integrations, Workers and the Audit log
 * (product/10's 2026-11-06 IA amendment, Q-UX-1, S-25.6).
 *
 * They left the top row for Settings' NavList, but each keeps its own URL (`/integrations`,
 * `/workers`, `/audit` and everything under them — the device flow's `/workers/approve?code=…` and
 * the wizard's `/workers/new?step=ready` are printed by installed workers and resolve for ever). So
 * the route tree puts those routes under one pathless layout that draws this: the settings NavList
 * on the left, with the screen's Admin entry current, and the screen itself on the right, unchanged
 * — it keeps its own `<h1>`. The reader sees they are in *Settings → Admin*, and every other
 * section is one press away.
 *
 * In the initial graph, as the project's layout is (`routes/tree.tsx` says why it is not a chunk);
 * the screens inside it stay lazy.
 */
import { Link, Outlet, useLocation } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { isCurrentSection } from '../app/nav.js';
import { useSession } from '../app/queries.js';
import type { NavLinkProps } from '../ui/nav-item.js';
import { SettingsFrame } from './settings-frame.js';
import { ORG_ADMIN_LINKS, type OrgAdminLinkId, orgSettingsGroupsFor } from './settings-sections.js';

/** The Admin entry a pathname is under (`/workers/approve` is Workers'), or `null`. */
export const adminEntryOf = (pathname: string): OrgAdminLinkId | null =>
  ORG_ADMIN_LINKS.find(({ to }) => isCurrentSection(to, pathname))?.id ?? null;

export const AdminFrame = (): ReactElement => {
  const session = useSession();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SettingsFrame
      label="Settings"
      groups={orgSettingsGroupsFor(session.data?.user.role)}
      current={adminEntryOf(pathname) ?? ''}
      // Every page section is a `/settings/<id>` link; the Admin entries carry their own `to`.
      link={(id, props) => <SettingsLink section={id} {...props} />}
    >
      <Outlet />
    </SettingsFrame>
  );
};

/** A page section's link, as the settings screen draws it. */
const SettingsLink = ({
  section,
  ...props
}: NavLinkProps & { readonly section: string }): ReactElement => (
  <Link to="/settings/$section" params={{ section }} {...props} />
);
