/**
 * product/19:138's precedence, and the `CODEOWNERS` matcher under it (WP-37).
 *
 * The three steps are asserted **separately** rather than through one fixture that happens to
 * exercise them in order: the document fixes an order, and a test that only ever supplies one input
 * cannot tell "CODEOWNERS won" from "there was nothing else".
 */
import { describe, expect, it } from 'vitest';
import { codeownersFor, resolveReviewerRouting } from './reviewer-routing.js';

const rules = (lines: readonly [string, string[]][]) => ({
  rules: lines.map(([pattern, owners]) => ({ pattern, owners })),
});

describe('codeownersFor', () => {
  it('matches a directory rule against the paths under it', () => {
    expect(
      codeownersFor(rules([['src/billing/', ['@finance']]]), ['src/billing/totals.ts']),
    ).toEqual(['@finance']);
  });

  it('anchors a leading slash at the repository root rather than failing to match', () => {
    expect(codeownersFor(rules([['/docs/**', ['@docs']]]), ['docs/readme.md'])).toEqual(['@docs']);
  });

  it('lets the last matching rule win, which is GitLab’s documented precedence', () => {
    const owners = codeownersFor(
      rules([
        ['*', ['@everyone']],
        ['src/auth/**', ['@security']],
      ]),
      ['src/auth/session.ts'],
    );
    expect(owners).toEqual(['@security']);
  });

  it('routes to the owners of every changed area, not only the first path’s', () => {
    const owners = codeownersFor(
      rules([
        ['src/auth/**', ['@security']],
        ['db/migrations/**', ['@dba']],
      ]),
      ['src/auth/session.ts', 'db/migrations/0001.sql'],
    );
    expect(owners).toEqual(['@security', '@dba']);
  });

  it('answers nothing for a repository with no CODEOWNERS, and for a path nobody owns', () => {
    expect(codeownersFor(null, ['src/auth/session.ts'])).toEqual([]);
    expect(codeownersFor(rules([['src/auth/**', ['@security']]]), ['README.md'])).toEqual([]);
  });

  it('drops a `!` exclusion instead of routing by it (the stated narrowing)', () => {
    // Nothing is named `!docs/**`, so the rule matches no path — which is what an exclusion means.
    expect(codeownersFor(rules([['!docs/**', ['@docs']]]), ['docs/readme.md'])).toEqual([]);
  });
});

describe('resolveReviewerRouting', () => {
  const base = { codeowners: [], configured: [], requester: null, classReviewers: [], limit: 8 };

  it('takes CODEOWNERS first, even when the project configures reviewers', () => {
    const routing = resolveReviewerRouting({
      ...base,
      codeowners: ['@security'],
      configured: ['@default-reviewer'],
      requester: 'user-99',
    });
    expect(routing.source).toBe('codeowners');
    expect(routing.handles).toEqual(['@security']);
  });

  it('takes the project’s reviewers when CODEOWNERS matched nothing', () => {
    const routing = resolveReviewerRouting({
      ...base,
      configured: ['@default-reviewer'],
      requester: 'user-99',
    });
    expect(routing.source).toBe('project_config');
    expect(routing.handles).toEqual(['@default-reviewer']);
  });

  it('falls back to the requesting human when neither of the first two answered', () => {
    const routing = resolveReviewerRouting({ ...base, requester: 'user-99' });
    expect(routing.source).toBe('requester');
    expect(routing.handles).toEqual(['user-99']);
  });

  it('says so by name when the fallback resolves to nobody', () => {
    const routing = resolveReviewerRouting(base);
    // `none` rather than an empty list with no explanation: the caller logs the difference between
    // "nobody was mapped" and "nobody was routed" (PROGRESS backlog 79).
    expect(routing.source).toBe('none');
    expect(routing.handles).toEqual([]);
  });

  it('adds a class’s reviewers rather than replacing what the precedence chose', () => {
    const routing = resolveReviewerRouting({
      ...base,
      codeowners: ['@platform'],
      classReviewers: ['@security'],
    });
    // product/19:138: *"risk classes add required reviewers rather than replace"*. The two disagree
    // on purpose here — a CODEOWNERS entry and a class requirement naming different people — and
    // both are on the merge request.
    expect(routing.source).toBe('codeowners');
    expect(routing.base).toEqual(['@platform']);
    expect(routing.required).toEqual(['@security']);
    expect(routing.handles).toEqual(['@platform', '@security']);
  });

  it('adds a class’s reviewers even when nothing else routed at all', () => {
    const routing = resolveReviewerRouting({ ...base, classReviewers: ['@security'] });
    expect(routing.source).toBe('none');
    expect(routing.handles).toEqual(['@security']);
  });

  it('never names the same handle twice', () => {
    const routing = resolveReviewerRouting({
      ...base,
      codeowners: ['@security', '@security'],
      classReviewers: ['@security'],
    });
    expect(routing.handles).toEqual(['@security']);
  });

  it('cuts at the limit and says it cut, in both directions (standing rule 42)', () => {
    const three = ['@a', '@b', '@c'];
    expect(resolveReviewerRouting({ ...base, codeowners: three, limit: 3 })).toMatchObject({
      handles: three,
      truncated: false,
    });
    expect(resolveReviewerRouting({ ...base, codeowners: three, limit: 2 })).toMatchObject({
      handles: ['@a', '@b'],
      truncated: true,
    });
  });
});
