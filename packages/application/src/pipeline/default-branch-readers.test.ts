/**
 * **Who may ask the git provider which branch is the default** (WP-142, backlog 441).
 *
 * Before WP-142 half the platform read the stored `projects.default_branch` (checkout, the merge
 * request's target, the mirror) and half read the provider's own default through
 * `getDefaultBranchHead(project)` (the intake protection check, the poll's default-branch move,
 * coverage's baseline, risk routing's `CODEOWNERS`, readiness R9). While the two agree nothing shows;
 * during a move (`develop` → `main`) the halves split. The ruling: the stored branch is the one
 * answer, and the provider's default is read only by the wizard's prefill and the mismatch notice.
 *
 * So the port member that answered "which branch" is gone (`getBranchHead(project, branch)` takes
 * the branch from the caller), and the one member left that carries the provider's default —
 * `repositorySettings` — is held here to its callers:
 *
 *  - `gitReads.repositorySettings` (the provider's whole answer, default branch included) is called
 *    from `apps/server/src/project-config.ts` alone — the read behind `GET …/repository`, which is
 *    the prefill and the notice;
 *  - `gitReads.ciConfigLocation` drops the default branch, so the CI gate cannot follow it;
 *  - `git.port.repositorySettings(` is called only inside those two wrappers.
 *
 * A text census over every source git knows about, tracked or untracked (standing rule 85), with the
 * test tier excluded. What it cannot see: a member reached through a variable (`const read =
 * reads.repositorySettings`), or a computed property name — stated rather than implied.
 *
 * **Out of its reach, and recorded as a residual under WP-142**: GitLab's push webhook names the
 * provider's default (`hook.project.default_branch`, `gitlab/inbound.ts`) in `default_branch.moved`;
 * the saga's handler ignores a move whose branch is not the stored one, so it re-checks nothing.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

const sources = (): string[] => censusPaths(REPO_ROOT, { pathspecs: ['*.ts', '*.tsx'] });

const isTestTier = (file: string): boolean =>
  file.startsWith('test/') ||
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) ||
  /(?:^|\/)(?:testing|fixtures)\.ts$/.test(file) ||
  file.includes('/src/testing/');

const census = (pattern: RegExp): Record<string, number> => {
  const found: Record<string, number> = {};
  for (const file of sources()) {
    if (isTestTier(file)) {
      continue;
    }
    const hits = withoutComments(censusText(REPO_ROOT, file)).match(pattern)?.length ?? 0;
    if (hits > 0) {
      found[file] = hits;
    }
  }
  return found;
};

describe('the provider’s default branch is read by the prefill and the notice only (WP-142)', () => {
  it('calls the provider’s whole repository answer from the read behind GET …/repository alone', () => {
    expect(census(/\)\s*\.\s*repositorySettings\s*\(/g)).toEqual({
      'apps/server/src/project-config.ts': 1,
    });
  });

  it('reaches the port member only inside the two gitReads wrappers', () => {
    expect(census(/\bport\s*\.\s*repositorySettings\s*\(/g)).toEqual({
      'packages/application/src/pipeline/integrations.ts': 2,
    });
  });

  it('has no member left that answers “which branch” on the provider’s behalf', () => {
    expect(census(/\bgetDefaultBranchHead\b/g)).toEqual({});
    // The pipeline's default-branch head is asked by name, from these two readers only.
    expect(census(/\.\s*branchHead\s*\(/g)).toEqual({
      'packages/application/src/pipeline/coverage.ts': 1,
      'packages/application/src/pipeline/mr-poll.ts': 1,
    });
  });
});
