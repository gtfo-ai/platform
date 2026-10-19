/**
 * WP-220 (e), backlog 610: every paginated read of the GitLab client says what a cut list means.
 *
 * `paginate` reports `truncated` when the walk stopped at the binding's `max_pages` (WP-209 (c)).
 * Six reads once took `.items` and dropped it, and one of them answered "nobody pushes" off a cut
 * list. So each `http.paginate(` call in `client.ts` must either read `truncated` in its member's
 * body (and hand it to a caller that decides) or carry, in the member's interface docblock, the
 * declared sentence `A cut list is kept:` followed by what the cut costs its caller. A call that
 * does neither fails here by member name.
 *
 * What it cannot see: a member that reads `truncated` and then ignores it, and a sentence that is
 * there but wrong. The first is held by the adapter's own refusals and their tests
 * (`gitlab-cut-lists.contract.test.ts`), the second by review.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CLIENT = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');
const DECLARED = 'A cut list is kept:';

/** The implementation members (`    name: async`) that call `http.paginate(`, in source order. */
const paginatingMembers = (source: string): { name: string; body: string }[] => {
  const starts = [...source.matchAll(/^ {4}(\w+): async\b/gm)].map((match) => ({
    name: match[1] as string,
    at: match.index,
  }));
  return starts
    .map((start, index) => ({
      name: start.name,
      body: source.slice(start.at, starts[index + 1]?.at ?? source.length),
    }))
    .filter((member) => member.body.includes('http.paginate('));
};

/** The interface docblock directly above `  name(`, or `''`. */
const docblockOf = (source: string, name: string): string =>
  new RegExp(`/\\*\\*((?:(?!\\*/)[\\s\\S])*)\\*/\\s*\\n {2}${name}\\(`).exec(source)?.[1] ?? '';

/** The members whose paginated read neither reads `truncated` nor declares the cut it keeps. */
const undeclaredCuts = (source: string): string[] =>
  paginatingMembers(source)
    .filter(
      (member) =>
        !/\.truncated\b/.test(member.body) &&
        !docblockOf(source, member.name)
          .replace(/\s*\*\s*/g, ' ')
          .includes(DECLARED),
    )
    .map((member) => member.name);

/** `client.ts` with one more paginated member, declared or not. */
const planted = (docblock: string): string =>
  CLIENT.replace(
    /^export interface GitLabClient \{\n/m,
    `export interface GitLabClient {\n  ${docblock}\n  tags(project: string): Promise<unknown[]>;\n`,
  ).replace(
    /^ {4}deployKeys: async/m,
    `    tags: async (project) =>\n      (await http.paginate({ method: 'GET', path: \`/projects/\${project}/repository/tags\`, action: 'list_tags' }, 100)).items,\n\n    deployKeys: async`,
  );

describe('every paginated GitLab read says what a cut list means (WP-220)', () => {
  it('finds the paginated reads, and each reads the flag or declares the cut it keeps', () => {
    expect(paginatingMembers(CLIENT).map((member) => member.name)).toEqual([
      'deployKeys',
      'protectedBranches',
      'listCommits',
      'pollMergeRequests',
      'listMergeRequests',
      'listDiscussions',
      'pipelineJobs',
    ]);
    expect(undeclaredCuts(CLIENT)).toEqual([]);
  });

  it('fails by name on a planted paginated read that drops the flag', () => {
    expect(undeclaredCuts(planted('/** § "List repository tags". */'))).toEqual(['tags']);
  });

  it('accepts the same planted read once its docblock declares the cut it keeps', () => {
    expect(
      undeclaredCuts(
        planted(
          '/**\n   * § "List repository tags".\n   *\n   * A cut list is kept: a test of the census.\n   */',
        ),
      ),
    ).toEqual([]);
  });
});
