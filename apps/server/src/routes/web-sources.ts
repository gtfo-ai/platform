/**
 * Reading `apps/web/src` off disk, for the two censuses that compare the SPA against something.
 *
 * `client-census.test.ts` compares the client's `/api/*` paths against this server's router;
 * `settings-mirror.test.ts` compares the wizard's command set against the settings screens'. Both
 * need the same two things — which files git knows about, and a source with its prose removed — and
 * a second copy of either is a second thing to keep right (standing rule 41 applied to a helper).
 *
 * It is a plain module rather than an export of a test file on purpose: importing one test file
 * from another puts its `describe`s into the importer's module graph and runs them twice.
 *
 * **Tracked *and* untracked-but-not-ignored** is standing rule 85, paid for by a rejected push: a
 * guard that reads only `git ls-files` is green on a file its author has not committed, so a census
 * would pass locally and fail on CI with the author's own new screen in it. Since WP-68 the list
 * and the read are `scripts/census-files.mjs`'s, shared with every census in the repository: a
 * path that vanished after the listing reads as nothing, and one that exists and cannot be read
 * throws naming it rather than crashing on the first `ENOENT` (backlog 10's second column).
 */
import { fileURLToPath } from 'node:url';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';

export const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** The SPA's sources, relative to the repository root. */
export const WEB_SOURCES = 'apps/web/src';

/**
 * Every source file git knows about under `directory` — tracked **and** untracked-but-not-ignored.
 *
 * Rule 85, and the reason it is a parameter since WP-48: the jobs-seam census reads
 * `apps/server/src` the same way this one reads `apps/web/src`, and a second copy of the two `git`
 * invocations is a second place for the untracked half to be forgotten.
 */
export const sourceFilesUnder = (directory: string): string[] =>
  censusPaths(repositoryRoot, {
    pathspecs: [directory],
    include: (path) =>
      (path.endsWith('.ts') || path.endsWith('.tsx')) &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('.test.tsx'),
  });

/**
 * One listed source's text. A path that vanished since it was listed reads as the empty string —
 * it is no longer part of the tree — and one that exists and cannot be read throws, naming it.
 */
export const readSource = (path: string): string => censusText(repositoryRoot, path);

export const webSourceFiles = (): string[] => sourceFilesUnder(WEB_SOURCES);

/**
 * The comment stripper, re-exported: it lives in `scripts/source-scanner.mjs` since WP-96 so the
 * application ring's censuses read the same one (PROGRESS backlog 269).
 */
export { withoutComments } from '../../../../scripts/source-scanner.mjs';
