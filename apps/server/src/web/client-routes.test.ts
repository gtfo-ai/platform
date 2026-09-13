/**
 * The server's allow-list against the SPA's own route tree (WP-15j).
 *
 * `CLIENT_ROUTE_SEGMENTS` decides which paths get `index.html`, and it is the one list in this
 * change that a human wrote. So it is held to the file that defines the screens:
 * `apps/web/src/routes/tree.tsx`, read off disk and compared in **both** directions — a screen
 * added to the app without a segment here is a deep link that 404s in production, and a segment
 * here that no screen claims is a path the server answers with the shell for no reason. Standing
 * rule 7 (ask the source, do not carry a list) and the census shape
 * `routes/client-census.test.ts` uses, one layer down.
 *
 * `apps/server` cannot import `apps/web` — the dependency rule forbids it and the built bundle
 * carries no route manifest — so the tree is parsed rather than executed. What that cannot see is
 * stated rather than implied: a path this file builds at runtime from pieces, and a route declared
 * in some other file. Both would show up as a red census the first time a user opened the screen;
 * neither exists today, and the scope assertion below fails if the parse stops finding routes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIENT_ROUTE_SEGMENTS, isClientRoute } from './client-routes.js';

const TREE = fileURLToPath(new URL('../../../web/src/routes/tree.tsx', import.meta.url));

/** A quoted literal beginning with `/`, outside a block comment — the census's own regex. */
const ROUTE_PATH = /(['"`])(\/[^'"`]*)\1/g;

const declaredPaths = (): string[] => {
  const source = readFileSync(TREE, 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return [...new Set([...source.matchAll(ROUTE_PATH)].map(([, , path]) => path ?? ''))].sort();
};

/** `/projects/$key/tasks/$taskId` → `projects`; `/` → nothing. */
const firstSegments = (paths: readonly string[]): string[] =>
  [
    ...new Set(paths.map((path) => path.split('/')[1] ?? '').filter((segment) => segment !== '')),
  ].sort();

describe('the SPA’s route tree against the server’s allow-list', () => {
  it('finds the routes on disk', () => {
    // The scope, asserted before anything is concluded from it (standing rule 4): a parse that
    // found nothing would report a perfectly clean comparison.
    const paths = declaredPaths();
    expect(paths).toContain('/projects/$key/tasks/$taskId');
    expect(paths).toContain('/sign-in');
    expect(paths).toContain('/');
    expect(paths.length).toBeGreaterThan(10);
  });

  it('allows exactly the first segments the client declares', () => {
    expect(firstSegments(declaredPaths())).toEqual([...CLIENT_ROUTE_SEGMENTS].sort());
  });

  it('answers for the root and for a path under every allowed segment, and for nothing else', () => {
    expect(isClientRoute([])).toBe(true);
    for (const segment of CLIENT_ROUTE_SEGMENTS) {
      expect(isClientRoute([segment]), segment).toBe(true);
      expect(isClientRoute([segment, 'deeper', 'still']), segment).toBe(true);
    }
    // The prefixes the server owns, and the noise every public instance gets.
    for (const segment of ['api', 'events', 'webhooks', 'healthz', 'metrics', 'wp-login.php']) {
      expect(isClientRoute([segment]), segment).toBe(false);
    }
  });
});
