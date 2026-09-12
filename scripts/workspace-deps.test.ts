/**
 * Every `@platform/*` a package imports is a `@platform/*` that package **declares** (WP-22).
 *
 * ## The defect this is the guard for
 *
 * `packages/prompts/src/index.ts` imported `@platform/contracts` while
 * `packages/prompts/package.json` declared **no dependencies at all**. Nothing noticed for six work
 * packages, because in a developer checkout the resolution succeeds for a reason that has nothing
 * to do with the package: the repository *root* lists every workspace package in its
 * `devDependencies`, so `/repo/node_modules/@platform/contracts` exists, and Node's directory walk
 * finds it from anywhere in the tree.
 *
 * It fails the moment the tree is not a developer checkout. Measured at WP-22, in the product
 * image, where `pnpm install --prod --filter @platform/server...` correctly leaves the root's
 * **dev** dependencies out:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@platform/contracts'
 *     imported from /app/packages/prompts/src/index.ts
 *
 * — the container crash-looped on start, on an image whose every other layer was right. That is the
 * general shape of an undeclared dependency: it is not a missing file, it is a *coincidence* that
 * holds in one tree and not in another, and the tree it fails in is production.
 *
 * ## What this checks, and what it does not
 *
 * It reads every workspace `package.json`, walks that package's `src/`, and compares the
 * `@platform/*` specifiers it imports against the union of `dependencies` and `devDependencies`. A
 * subpath import (`@platform/infrastructure/runlet`) counts as its package.
 *
 * **Three spellings, because one of them was the whole defect class.** `from '…'` (including
 * `export … from`), a side-effect `import '…';`, and a dynamic `await import('…')`. The first
 * version of this census matched only `from`, which left the two spellings a package is most likely
 * to reach for when it wants something it has not declared invisible to it — standing rule 48's
 * shape, where a guard sees one syntax for the thing it forbids.
 *
 * What it still cannot see, stated rather than implied: a double-quoted specifier (biome formats
 * this repository to single quotes, so one would also be a lint failure), a specifier that is not a
 * literal (`import(name)`, `await import(`@platform/${x}`)`), a `require()` (no TypeScript source
 * here uses one), and anything outside a package's own `src/` — a `@platform/*` import from a
 * package's `scripts/` or config would not be counted.
 *
 * It does **not** check third-party specifiers, and deliberately: `zod` and `pino` are resolvable
 * from the root in every arrangement this repository ships, and a check that flagged them would be
 * a style rule rather than a defect finder. It also does not check the *direction* of a dependency
 * — that is `biome.json`'s `noRestrictedImports`, which is the dependency rule (technical/01) and a
 * different question from whether the manifest says what the code does.
 *
 * Scope is `git ls-files` rather than a hand-written list (standing rule 7), so a package added
 * later is covered the day it is added — and, per standing rule 85, tracked **and** untracked
 * files, because a guard over the tree that cannot see a new file is green until the commit lands.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tracked = (...args: readonly string[]): string[] =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);

/** Every file git knows about — committed or not — so a new package is in scope immediately. */
const files = (): string[] => [
  ...new Set([...tracked('ls-files'), ...tracked('ls-files', '--others', '--exclude-standard')]),
];

/**
 * `from '…'`, `import '…'` and `import('…')` — see the docblock for what it does not see.
 *
 * `(?:from|import)` then an optional `(`: that covers the static, side-effect and dynamic forms in
 * one pass, and `\s*` rather than `\s+` because `import('x')` has no space before the bracket.
 */
const IMPORT = /(?:from|import)\s*\(?\s*'(@platform\/[a-z][a-z-]*)(?:\/[^']*)?'/g;

interface WorkspacePackage {
  readonly dir: string;
  readonly name: string;
  readonly declared: ReadonlySet<string>;
  readonly imported: ReadonlySet<string>;
}

const workspacePackages = (): WorkspacePackage[] => {
  const all = files();
  const manifests = all.filter((file) => /^(packages|apps)\/[^/]+\/package\.json$/.test(file));
  return manifests.map((manifest) => {
    const dir = path.dirname(manifest);
    const parsed = JSON.parse(readFileSync(path.join(REPO, manifest), 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const imported = new Set<string>();
    for (const file of all.filter(
      (entry) => entry.startsWith(`${dir}/src/`) && /\.tsx?$/.test(entry),
    )) {
      const source = readFileSync(path.join(REPO, file), 'utf8');
      for (const match of source.matchAll(IMPORT)) {
        if (match[1] !== undefined && match[1] !== parsed.name) {
          imported.add(match[1]);
        }
      }
    }
    return {
      dir,
      name: parsed.name,
      declared: new Set([
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
      ]),
      imported,
    };
  });
};

describe('workspace package manifests', () => {
  const packages = workspacePackages();

  it('finds the workspace packages at all, so an empty run cannot pass', () => {
    // Standing rule 18's shape for a census: a check over nothing reports the same green as a check
    // over everything.
    expect(packages.length).toBeGreaterThanOrEqual(10);
    expect(packages.map((entry) => entry.name)).toContain('@platform/prompts');
  });

  it('declares every @platform/* package it imports', () => {
    const undeclared = packages.flatMap((entry) =>
      [...entry.imported]
        .filter((name) => !entry.declared.has(name))
        .map((name) => `${entry.dir} imports ${name} and does not declare it`),
    );
    expect(undeclared).toEqual([]);
  });

  it('sees the imports it is looking for, so the comparison is not vacuous', () => {
    // The other half of the census (standing rule 10): a regex that matched nothing would make the
    // assertion above pass for every package in the repository.
    const prompts = packages.find((entry) => entry.name === '@platform/prompts');
    expect([...(prompts?.imported ?? [])]).toContain('@platform/contracts');
    const server = packages.find((entry) => entry.name === '@platform/server');
    expect((server?.imported.size ?? 0) >= 4).toBe(true);
  });
});
