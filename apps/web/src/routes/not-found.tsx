/**
 * **An unknown address, inside the frame** (S-23.22, the final UX audit's item 12).
 *
 * Before this the router had no not-found component and the root route was a bare `<Outlet/>`, so
 * `/projects/ACME/typo` showed TanStack's own "Not Found" with no navigation and no link: a dead
 * end. Now a splat route under the authenticated layout renders this inside the shell (so the
 * session is checked and the navigation stays), and the router's default not-found component is the
 * same screen for a `notFound()` a route throws. The path is printed as text — it is what the person
 * typed or followed, untrusted like any other URL text (BD-022).
 */
import { Link, useLocation } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Blankslate } from '../ui/blankslate.js';
import { buttonClassName } from '../ui/button.js';
import { UntrustedText } from '../ui/untrusted.js';

export const NotFoundScreen = (): ReactElement => {
  const { pathname } = useLocation();
  return (
    <div className="flex flex-col gap-2" data-not-found="">
      <Blankslate
        size="spacious"
        title="This page does not exist"
        hint="The address may be mistyped, or what it pointed to was removed or renamed."
        action={
          <Link to="/" className={buttonClassName('primary')}>
            Go to Home
          </Link>
        }
      />
      <p className="text-center text-xs text-fg-muted">
        <UntrustedText value={pathname} className="font-mono" />
      </p>
    </div>
  );
};
