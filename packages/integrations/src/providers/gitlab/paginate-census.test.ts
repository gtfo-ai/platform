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
 *
 * WP-234 (d), backlog 627: the census also records which calls bound their own walk — a `pages`
 * argument other than `http.maxPages`, or an `enough` stop — and every other call must carry, in
 * its member's docblock, the declared sentence `Every page is read:` followed by why no earlier
 * page can answer. The arguments are counted at bracket depth, so a comma or bracket inside a
 * string argument would miscount; none of the calls has one.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CLIENT = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');
const DECLARED = 'A cut list is kept:';
const EVERY_PAGE = 'Every page is read:';

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

/** The top-level arguments of the member's `http.paginate(` call, split at bracket depth. */
const paginateArguments = (body: string): string[] => {
  const args = [''];
  let depth = 0;
  for (const char of body.slice(body.indexOf('http.paginate(') + 'http.paginate('.length)) {
    if (')]}'.includes(char) && depth === 0) {
      break;
    }
    if (char === ',' && depth === 0) {
      args.push('');
      continue;
    }
    depth += '([{'.includes(char) ? 1 : ')]}'.includes(char) ? -1 : 0;
    args[args.length - 1] += char;
  }
  // A trailing comma leaves an empty last argument.
  return args.map((arg) => arg.trim()).filter((arg) => arg !== '');
};

/** The members whose paginated read bounds its walk (`pages` short of `max_pages`, or `enough`). */
const boundedMembers = (source: string): string[] =>
  paginatingMembers(source)
    .filter((member) => {
      const args = paginateArguments(member.body);
      return args.length >= 4 || (args.length === 3 && args[2] !== 'http.maxPages');
    })
    .map((member) => member.name);

/** The members that read every page without saying why no earlier page can answer. */
const undeclaredWalks = (source: string): string[] => {
  const bounded = new Set(boundedMembers(source));
  return paginatingMembers(source)
    .filter(
      (member) =>
        !bounded.has(member.name) &&
        !docblockOf(source, member.name)
          .replace(/\s*\*\s*/g, ' ')
          .includes(EVERY_PAGE),
    )
    .map((member) => member.name);
};

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
const planted = (docblock: string, pages = ''): string =>
  CLIENT.replace(
    /^export interface GitLabClient \{\n/m,
    `export interface GitLabClient {\n  ${docblock}\n  tags(project: string): Promise<unknown[]>;\n`,
  ).replace(
    /^ {4}deployKeys: async/m,
    `    tags: async (project) =>\n      (await http.paginate({ method: 'GET', path: \`/projects/\${project}/repository/tags\`, action: 'list_tags' }, 100${pages})).items,\n\n    deployKeys: async`,
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

  it('records which reads bound their walk, and each other read declares why it reads every page (WP-234)', () => {
    expect(boundedMembers(CLIENT)).toEqual([
      'listCommits',
      'pollMergeRequests',
      'listMergeRequests',
    ]);
    expect(undeclaredWalks(CLIENT)).toEqual([]);
  });

  it('fails by name on a planted paginated read with no pages and no declaration (WP-234)', () => {
    expect(undeclaredWalks(planted('/** § "List repository tags". */'))).toEqual(['tags']);
    expect(
      undeclaredWalks(planted('/** § "List repository tags". */', ', http.maxPages')),
      '`max_pages` passed alone bounds nothing',
    ).toEqual(['tags']);
    expect(undeclaredWalks(planted('/** § "List repository tags". */', ', 2'))).toEqual([]);
    expect(
      undeclaredWalks(
        planted(
          '/**\n   * § "List repository tags".\n   *\n   * Every page is read: a test of the census.\n   */',
        ),
      ),
    ).toEqual([]);
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
