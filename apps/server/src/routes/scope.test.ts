/**
 * **The pairing `scope.ts` claims, enforced** — a route that resolves a project must also decide a
 * permission with it (WP-15h, review round 1).
 *
 * The docblock on `scopeToProject` said "every route that uses one is asserted to use both" and
 * nothing asserted it, which is standing rule 44 in its usual place: a claim about every other
 * registration, made in a comment. `client-census.test.ts` cannot close it — its probe is an
 * anonymous request, and **both** halves answer 401 to one, so a route that dropped
 * `requirePermission` and kept `scopeToProject` is indistinguishable from a correct one there.
 * That is the dangerous direction, too: without the guard the route serves any signed-in caller.
 *
 * ## What this check is, and what it is not
 *
 * It is **syntactic**: it reads the route modules off disk — tracked *and* untracked, so a file
 * that is not committed yet is still in scope (standing rule 85) — finds every `preHandler:` value
 * and asserts the two implications inside each one. It cannot see a preHandler assembled elsewhere,
 * a `project:` hook written inline as `(request) => request.scopedProjectId`, or a guard reached
 * through a variable. Those are the honest holes; what it does catch is the shape this repository
 * actually writes, which is rule 48's requirement of a syntactic guard.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const ROUTE_DIR = 'apps/server/src/routes';

/** Route modules git knows about, tracked and untracked alike; tests are not registrations. */
const routeModules = (): string[] => {
  const git = (args: readonly string[]): string[] =>
    execFileSync('git', [...args], { cwd: repositoryRoot, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.length > 0);
  return [
    ...new Set([
      ...git(['ls-files', '--', ROUTE_DIR]),
      ...git(['ls-files', '--others', '--exclude-standard', '--', ROUTE_DIR]),
    ]),
  ].filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'));
};

/**
 * Every `preHandler:` value in a module, as source text.
 *
 * Both spellings this repository uses: an array (`[scope, requirePermission(…)]`) and a bare call
 * (`requirePermission(…)`). The bare form is read to the end of its line, which is what `org.ts`
 * and `projects.ts` write.
 */
export const preHandlers = (source: string): string[] => {
  const found: string[] = [];
  const pattern = /preHandler:\s*(\[[\s\S]*?\]|[^\n]*)/g;
  for (const match of source.matchAll(pattern)) {
    const value = match[1];
    if (value !== undefined) {
      found.push(value);
    }
  }
  return found;
};

describe('the project-scope preHandler and the permission guard travel together', () => {
  it('reads every route module off disk, including one that is not committed yet', () => {
    // The scope, before anything is concluded from it (standing rule 4).
    const modules = routeModules();
    expect(modules).toContain('apps/server/src/routes/runs.ts');
    expect(modules).toContain('apps/server/src/routes/tasks.ts');
    expect(modules).toContain('apps/server/src/routes/org.ts');
    expect(modules.some((path) => path.endsWith('.test.ts'))).toBe(false);

    const sources = modules.map((path) => readFileSync(join(repositoryRoot, path), 'utf8'));
    // …and the extraction finds something in them, which a regex that silently matched nothing
    // would not.
    expect(sources.flatMap(preHandlers).length).toBeGreaterThanOrEqual(7);
  });

  it('never resolves a project without deciding a permission, and never the reverse', () => {
    const offences: string[] = [];
    for (const path of routeModules()) {
      const source = readFileSync(join(repositoryRoot, path), 'utf8');
      for (const handler of preHandlers(source)) {
        const resolves = /\bscope\b/.test(handler);
        const decides = /requirePermission\(/.test(handler);
        const scoped = /\bscopedProject\b/.test(handler);
        // The dangerous direction: a project is looked up and nobody asks what the caller may do.
        if (resolves && !decides) {
          offences.push(`${path}: ${handler.trim()} — resolves a project and decides nothing`);
        }
        // The other direction: the guard is told to scope by a value no preHandler set, so it
        // silently falls back to the organisation role (standing rule 18).
        if (scoped && !resolves) {
          offences.push(`${path}: ${handler.trim()} — scopes by a value nothing resolves`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
