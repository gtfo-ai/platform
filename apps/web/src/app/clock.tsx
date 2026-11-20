/**
 * **The organisation's clock, put where every formatter reads it** (S-28.21, BACKLOG 1608).
 *
 * `ui/time.ts` formats every date and time on the clock in force, `24h` until somebody says
 * otherwise. This reads the organisation settings document (`GET /api/org`, `org.read` — every
 * signed-in role) and sets `display.clock` there: absent, unreadable or still loading is the
 * default, so a failed read never turns the screens to a clock nobody chose.
 *
 * A formatter is a plain function called from text builders as well as components, so a change of
 * clock cannot reach them through a context. The subtree is **remounted once** when the clock in
 * force changes instead — on the first read of an organisation that chose `12h`, and when an
 * administrator saves a new clock — which re-renders every time it shows. The query cache is
 * outside it, so nothing is fetched again. It sits inside the signed-in shell, so the sign-in page
 * never asks for a document it may not read.
 */
import { Fragment, type ReactElement, type ReactNode } from 'react';
import { clockOf, setClock } from '../ui/time.js';
import { useOrgSettings } from './queries.js';

export const ClockFromOrganisation = ({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement => {
  const document = useOrgSettings();
  const clock = clockOf(document.data?.settings.display?.clock);
  // Set during render, before the children render with it: an idempotent assignment of the value
  // this render keys the subtree by, so a repeated (strict-mode) render sets the same clock.
  setClock(clock);
  return <Fragment key={clock}>{children}</Fragment>;
};
