/**
 * Which screens are lazy chunks (S-23.4, TD-013's budget on the initial graph).
 *
 * The claim in `tree.tsx` is that every screen except the frame, the sign-in page and Home is a
 * lazy route component — one whose `preload` the router calls while it resolves the match — so a
 * screen added with a static import is a red test here rather than a bundle that quietly grows
 * until `bundle:check` fails for somebody else. Read off the live route tree, both directions: the
 * eager set is exactly the ones named, and every other route that renders something is lazy. The
 * not-found screen (S-23.22) is eager too: it is also the router's `defaultNotFoundComponent`.
 */
import { QueryClient } from '@tanstack/react-query';
import type { AnyRoute } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import type { Services } from '../app/services.js';
import { createAppRouter } from './tree.js';

// A router is what gives every route its id; nothing here renders or asks the services anything.
const router = createAppRouter({
  queryClient: new QueryClient(),
  services: {} as unknown as Services,
});

interface Preloadable {
  readonly preload?: () => Promise<void> | undefined;
}

const rendering = (Object.values(router.routesById) as AnyRoute[]).filter(
  (route) => route.options.component !== undefined,
);

const isLazy = (route: AnyRoute): boolean =>
  typeof (route.options.component as Preloadable).preload === 'function';

/** The frame (root, shell, project layout), the sign-in page, Home and the not-found screen. */
const EAGER = [
  '/authenticated/$',
  '__root__',
  '/sign-in',
  '/authenticated',
  '/authenticated/',
  '/authenticated/projects/$key',
];

describe('the lazy screens', () => {
  it('finds the routes it judges (scope before verdict)', () => {
    expect(rendering.length).toBeGreaterThan(15);
    expect(rendering.map((route) => route.id)).toContain(
      '/authenticated/projects/$key/tasks/$taskId',
    );
  });

  it('keeps exactly the frame, sign-in, Home and the not-found screen eager', () => {
    expect(
      rendering
        .filter((route) => !isLazy(route))
        .map((route) => route.id)
        .sort(),
    ).toEqual([...EAGER].sort());
  });

  it('makes every other screen a chunk the router can preload', async () => {
    const lazy = rendering.filter(isLazy);
    expect(lazy.map((route) => route.id)).toContain('/authenticated/projects');
    expect(lazy.map((route) => route.id)).toContain('/authenticated/projects/$key/');
    // The preload resolves: the chunk's module loads and its export is there to render.
    await Promise.all(lazy.map((route) => (route.options.component as Preloadable).preload?.()));
  });
});
