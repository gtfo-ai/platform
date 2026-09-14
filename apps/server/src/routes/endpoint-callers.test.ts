/**
 * **Every client command has a control, and every client read has a screen** — PROGRESS backlog 55.
 *
 * `POST /api/integrations` was served by WP-21, exported by `api/endpoints.ts`, wrapped by
 * `app/queries.ts` — and called by **no component**. Every check in this repository was green, and
 * the implementer's own words are the general form worth keeping: *"a client that carries a call no
 * component makes passes every check in this repository"*. `client-census.test.ts` compares the
 * paths the client **names** against the router and is right to; `verify:ui` renders components;
 * `verify:web-e2e` drives the built bundle against a backend that answers whatever is asked. None of
 * them asks whether an exported endpoint has a caller.
 *
 * This does. Two halves, because a command and a read are wired differently:
 *
 * - **A mutation** (`x: useMutation({…})` in `app/queries.ts`) must be **fired** somewhere —
 *   `something.x.mutate(` — which is what a button a person can press compiles to.
 * - **A read hook** (`export const useX` in `app/queries.ts`) must be **called** somewhere outside
 *   that file.
 *
 * ## What it cannot see, stated rather than implied
 *
 * A mutation fired through a variable (`const fire = commands.pause.mutate; fire()`), a hook called
 * through indirection, and a caller that exists only in a test — test files are out of scope by
 * suffix, which is deliberate: a control that only a test presses is the defect, not the fix. It
 * also says nothing about whether the control is **reachable** by a user; the route tree decides
 * that, and `settings-mirror.test.ts` is what compares two particular screens.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryRoot, webSourceFiles, withoutComments } from './web-sources.js';

const QUERIES = 'apps/web/src/app/queries.ts';

/** `    createIntegration: useMutation({` — a command the client can fire. */
const MUTATION_DECLARATION = /^\s*([A-Za-z][A-Za-z0-9_]*):\s*useMutation\(/gm;
/** `export const useProjects = ` — a read hook a screen can call. */
const READ_HOOK_DECLARATION = /^export const (use[A-Za-z0-9_]*)\s*=/gm;

/**
 * A declaration with no caller, and the reason it is admitted.
 *
 * An **admitted-gap list, not a filter**: both directions are asserted below, so an entry that
 * gains a caller fails and one that was never a declaration fails too (standing rule 7's
 * corollary).
 */
const ADMITTED_GAPS: Readonly<Record<string, string>> = {
  // Empty, and it is meant to stay that way. `createIntegration` was the entry this file was
  // written for and WP-30 gave it the control on the Integrations screen instead.
};

const sourcesExcept = (excluded: readonly string[]): { path: string; source: string }[] =>
  webSourceFiles()
    .filter((path) => !excluded.includes(path))
    .map((path) => ({
      path,
      source: withoutComments(readFileSync(join(repositoryRoot, path), 'utf8')),
    }));

const declarationsIn = (pattern: RegExp): string[] => {
  const source = withoutComments(readFileSync(join(repositoryRoot, QUERIES), 'utf8'));
  return [...source.matchAll(pattern)].flatMap(([, name]) => (name === undefined ? [] : [name]));
};

describe('every client command has a control', () => {
  it('finds the mutations and the hooks to check', () => {
    // The scope, asserted before anything is concluded from it (standing rule 4).
    const mutations = declarationsIn(MUTATION_DECLARATION);
    expect(mutations.length).toBeGreaterThan(10);
    expect(mutations).toContain('createIntegration');
    const hooks = declarationsIn(READ_HOOK_DECLARATION);
    expect(hooks).toContain('useProjectAutonomy');
  });

  it('fires every mutation `app/queries.ts` declares from somewhere outside it', () => {
    const fired = new Set(
      sourcesExcept([QUERIES]).flatMap(({ source }) =>
        [...source.matchAll(/\.([A-Za-z][A-Za-z0-9_]*)\.mutate\(/g)].flatMap(([, name]) =>
          name === undefined ? [] : [name],
        ),
      ),
    );
    const declared = declarationsIn(MUTATION_DECLARATION);

    // Direction 1 — a command the client carries that no component fires. This is backlog 55.
    const unfired = declared.filter((name) => !fired.has(name)).sort();
    expect(unfired.filter((name) => ADMITTED_GAPS[name] === undefined)).toEqual([]);

    // Direction 2 — an admitted gap that is no longer one, or was never a declaration.
    expect(
      Object.keys(ADMITTED_GAPS).filter((name) => fired.has(name) || !declared.includes(name)),
    ).toEqual([]);
  });

  it('calls every read hook `app/queries.ts` exports from somewhere outside it', () => {
    const used = sourcesExcept([QUERIES])
      .map(({ source }) => source)
      .join('\n');
    const uncalled = declarationsIn(READ_HOOK_DECLARATION)
      .filter((name) => !new RegExp(`\\b${name}\\(`).test(used))
      .sort();
    expect(uncalled.filter((name) => ADMITTED_GAPS[name] === undefined)).toEqual([]);
  });
});
