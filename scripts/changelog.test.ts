import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BREAKING_SECTION,
  CHANGELOG_SECTIONS,
  type ChangelogSection,
  exitCriteriaNote,
  groupBySection,
  MVP_EXIT_CRITERIA,
  migrationVerdict,
  modelMeasurement,
  type ParsedCommit,
  parseCommit,
  readCommits,
  renderChangelog,
  repositoryUrl,
  upgradeNote,
} from './changelog.mjs';

/**
 * `changelog.mjs` — the changelog preview and the release's upgrade note (WP-42, TD-019).
 *
 * The two things worth testing here are the two **derivations**, and both are tested from both
 * sides (standing rule 42): a note that always said "a migration is required" would pass the first
 * half of each pair, and one that never did would pass the second. That matters more than usual
 * because the wrong answer is not visible — nobody re-derives a release note, and an operator who
 * is told no migration is required does not take a dump.
 *
 * The commit parsing is held to release-please's own rules rather than to taste: the section table
 * is `DEFAULT_CHANGELOG_SECTIONS` at v17.6.0 and the hidden types stay hidden. Where this file
 * asserts an *output shape* it is asserting the property the release PR depends on — that
 * release-please's changelog updater will insert its released section above this preview rather
 * than rearranging the file around it.
 */
const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
  scratches.push(dir);
  return dir;
};

const commit = (overrides: Partial<ParsedCommit> = {}): ParsedCommit => ({
  sha: '0'.repeat(40),
  type: 'feat',
  scope: null,
  subject: 'a thing',
  breaking: false,
  ...overrides,
});

describe('parseCommit', () => {
  it('reads the conventional header commitlint already enforces', () => {
    expect(parseCommit({ sha: 'abc', subject: 'feat(domain): WP-01 the run aggregate' })).toEqual({
      sha: 'abc',
      type: 'feat',
      scope: 'domain',
      subject: 'WP-01 the run aggregate',
      breaking: false,
    });
    expect(parseCommit({ sha: 'abc', subject: 'docs: record TD-026' })?.scope).toBeNull();
  });

  it('reads a breaking change from the `!` and from the body', () => {
    expect(parseCommit({ sha: 'a', subject: 'feat(api)!: drop the v1 route' })?.breaking).toBe(
      true,
    );
    expect(
      parseCommit({ sha: 'a', subject: 'fix(api): drop it', body: 'BREAKING CHANGE: v1 is gone' })
        ?.breaking,
    ).toBe(true);
    expect(parseCommit({ sha: 'a', subject: 'fix(api): keep it', body: 'no note' })?.breaking).toBe(
      false,
    );
  });

  it('returns null for a subject that is not a conventional commit', () => {
    expect(parseCommit({ sha: 'a', subject: 'Merge branch main into fix/thing' })).toBeNull();
    expect(parseCommit({ sha: 'a', subject: 'FEAT: shouting' })).toBeNull();
  });
});

describe('groupBySection', () => {
  it('shows what release-please shows, in its order, and hides what it hides', () => {
    const commits = [
      commit({ type: 'docs', subject: 'a page' }),
      commit({ type: 'fix', subject: 'a fix' }),
      commit({ type: 'feat', subject: 'a feature' }),
      commit({ type: 'chore', subject: 'a chore' }),
    ];
    const { sections } = groupBySection(commits);
    expect([...sections.keys()]).toEqual(['Features', 'Bug Fixes']);
    expect(sections.get('Features')?.map((entry) => entry.subject)).toEqual(['a feature']);

    const hidden = CHANGELOG_SECTIONS.filter((section: ChangelogSection) => section.hidden).map(
      (section: ChangelogSection) => section.section,
    );
    for (const section of hidden) expect([...sections.keys()]).not.toContain(section);
  });

  it('collects breaking changes separately, including from a hidden type', () => {
    const { breaking } = groupBySection([
      commit({ type: 'refactor', subject: 'moved the world', breaking: true }),
      commit({ type: 'feat', subject: 'ordinary' }),
    ]);
    expect(breaking.map((entry) => entry.subject)).toEqual(['moved the world']);
    expect(BREAKING_SECTION).toContain('BREAKING CHANGES');
  });
});

/** A throwaway repository with exactly the history a test needs, newest commit last. */
const repositoryWith = (messages: readonly string[]): string => {
  const dir = scratch();
  const git = (...args: string[]): void => {
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        // A scratch repository must not run this machine's hooks, whatever `core.hooksPath` says.
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: dir, stdio: 'ignore' },
    );
  };
  git('init', '-q', '-b', 'main');
  for (const message of messages)
    git('commit', '--allow-empty', '--no-verify', '-q', '-m', message);
  return dir;
};

/**
 * `readCommits` against histories that are **built**, plus the one property the live history can
 * honestly be held to.
 *
 * The first version of this file pinned `unparsed === 0` over this repository's own log. That is
 * not a property the gates guarantee: commitlint's default ignores include a revert, so one
 * `git revert` with its default `Revert "…"` subject is a legitimately pushed commit that this
 * parser cannot read — and the pin would have failed `pnpm run -s verify` for everyone, at a commit
 * nobody could fix without rewriting the message. So the parser's behaviour is asserted on fixtures
 * (where a revert, a `BREAKING CHANGE:` footer and a non-conventional header can all be *made* to
 * exist), and the live history is asserted only for what the gates do guarantee: that every record
 * is accounted for and that the corpus the release renders is not empty.
 */
describe('readCommits', () => {
  it('parses a conventional history and counts, rather than drops, what it cannot parse', () => {
    const root = repositoryWith([
      'feat(server): a feature',
      'fix(db): a fix\n\nthe first paragraph\n\nBREAKING CHANGE: the column is gone',
      // What `git revert` writes by default, and what commitlint ignores by default: a commit that
      // is in a pushed range legitimately and that this parser cannot read.
      'Revert "feat(server): a feature"\n\nThis reverts commit 0000000.',
      'wip',
    ]);

    const { commits, unparsed, total } = readCommits(null, root);
    expect(total).toBe(4);
    expect(unparsed).toBe(2);
    // Nothing is dropped: every record is either a parsed commit or a counted one.
    expect(commits.length + unparsed).toBe(total);
    // Newest first, which is the order the changelog renders.
    expect(commits.map((entry) => entry.subject)).toEqual(['a fix', 'a feature']);
    // The footer is several lines into the body, so this also covers the field/record splitting.
    expect(commits[0]?.breaking).toBe(true);
    expect(commits[0]?.scope).toBe('db');
    expect(commits[1]?.breaking).toBe(false);
  });

  it('reads a range rather than the whole history when it is given one', () => {
    const root = repositoryWith(['feat: one', 'feat: two', 'feat: three']);
    const { commits } = readCommits('HEAD~2..HEAD', root);
    expect(commits.map((entry) => entry.subject)).toEqual(['three', 'two']);
  });

  it('accounts for every commit of this repository’s own history', () => {
    // A shallow clone has one commit and this test would then fail as "expected 1 to be greater
    // than 100" (ci.yml at 2788e9c), which names nothing; say what is wrong instead. CI's unit job
    // fetches the full history for this file and scripts/release.test.ts.
    expect(
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: join(import.meta.dirname, '..'),
        encoding: 'utf8',
      }).trim(),
      'this test reads the repository history and needs a full clone (ci.yml unit job: fetch-depth 0)',
    ).toBe('false');
    const { commits, unparsed, total } = readCommits(null);
    expect(total).toBeGreaterThan(100);
    // Vacuous here today — this history has no unparsed commit — which is why the fixture above
    // is what actually holds the accounting, and why this file says so rather than implying that
    // the live corpus tests it (standing rule 4).
    expect(commits.length + unparsed).toBe(total);
    expect(commits.every((entry) => entry.sha.length === 40)).toBe(true);
    // The release covers real work in both of the sections release-please shows by default; an
    // empty corpus is the failure this replaces `unparsed === 0` with.
    expect(commits.filter((entry) => entry.type === 'feat').length).toBeGreaterThan(0);
    expect(commits.filter((entry) => entry.type === 'fix').length).toBeGreaterThan(0);
  });
});

describe('migrationVerdict', () => {
  it('requires a migration when the build ships a file the previous release did not', () => {
    const verdict = migrationVerdict({
      shipped: ['0001_a.sql', '0002_b.sql'],
      previous: ['0001_a.sql'],
      previousTag: 'v0.1.0',
    });
    expect(verdict.required).toBe(true);
    expect(verdict.added).toEqual(['0002_b.sql']);
    expect(verdict.shippedCount).toBe(2);
  });

  it('requires none when the set is unchanged', () => {
    const verdict = migrationVerdict({
      shipped: ['0001_a.sql'],
      previous: ['0001_a.sql'],
      previousTag: 'v0.1.0',
    });
    expect(verdict.required).toBe(false);
    expect(verdict.added).toEqual([]);
  });

  it('treats a first release as all-new, which is also the truth for a fresh install', () => {
    const verdict = migrationVerdict({
      shipped: ['0001_a.sql', '0002_b.sql'],
      previous: [],
      previousTag: null,
    });
    expect(verdict.required).toBe(true);
    expect(verdict.added).toHaveLength(2);
  });
});

describe('modelMeasurement', () => {
  const withWorkflows = (names: string[]): string => {
    const root = scratch();
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    for (const name of names) writeFileSync(join(root, '.github/workflows', name), 'name: x\n');
    return root;
  };

  it('names the eval workflows that are missing (this build: both — WP-33)', () => {
    expect(modelMeasurement(withWorkflows(['ci.yml'])).missing).toEqual([
      'evals.yml',
      'nightly-llm.yml',
    ]);
    expect(modelMeasurement(withWorkflows(['ci.yml'])).measured).toBe(false);
  });

  it('retires itself when they exist, so the claim is about the tree and not a template', () => {
    const root = withWorkflows(['evals.yml', 'nightly-llm.yml']);
    expect(modelMeasurement(root)).toEqual({ missing: [], measured: true });
  });
});

describe('upgradeNote', () => {
  const measured = { missing: [], measured: true };
  const unmeasured = { missing: ['evals.yml', 'nightly-llm.yml'], measured: false };

  it('tells an operator to take a dump before a release that migrates', () => {
    const note = upgradeNote({
      verdict: {
        required: true,
        added: ['0034_statistics.sql'],
        shippedCount: 34,
        previousTag: 'v0.1.0',
      },
      measurement: measured,
    });
    expect(note).toContain('A migration is required.');
    expect(note).toContain('pg_dump');
    expect(note).toContain('docker compose run --rm migrate');
    expect(note).toContain('0034_statistics.sql');
    expect(note).not.toContain('never been run against a model');
  });

  it('says so plainly when nothing migrates, rather than repeating the warning', () => {
    const note = upgradeNote({
      verdict: { required: false, added: [], shippedCount: 34, previousTag: 'v0.1.0' },
      measurement: measured,
    });
    expect(note).toContain('No migration is required.');
    expect(note).not.toContain('pg_dump');
  });

  it('states that the prompts have not been measured against a model while WP-33 is open', () => {
    const note = upgradeNote({
      verdict: { required: true, added: ['0001_a.sql'], shippedCount: 1, previousTag: null },
      measurement: unmeasured,
    });
    expect(note).toContain('never been run against a model');
    expect(note).toContain('evals.yml, nightly-llm.yml');
    expect(note).toContain('WP-33');
  });
});

describe('renderChangelog', () => {
  const rendered = (): string =>
    renderChangelog({
      version: '0.1.0',
      date: '2026-09-15',
      commits: [
        commit({ sha: 'a'.repeat(40), type: 'feat', scope: 'server', subject: 'the thing' }),
        commit({ sha: 'b'.repeat(40), type: 'fix', subject: 'the other thing' }),
        commit({ sha: 'c'.repeat(40), type: 'docs', subject: 'a page nobody releases' }),
      ],
      unparsed: 0,
      url: 'https://github.test/owner/repo',
      note: '### Before you upgrade\n\nsomething\n',
      generatedAt: '1234567',
    });

  it('links every entry to its commit and scopes the ones that have a scope', () => {
    const changelog = rendered();
    expect(changelog).toContain(
      `* **server:** the thing ([aaaaaaa](https://github.test/owner/repo/commit/${'a'.repeat(40)}))`,
    );
    expect(changelog).toContain('* the other thing ([bbbbbbb]');
    expect(changelog).not.toContain('a page nobody releases');
  });

  /**
   * The property the release pull request depends on. release-please's changelog updater inserts
   * its released section **before** the first heading matching this regex and, when there is none,
   * demotes every heading in the file and puts its own section on top — so a preview without a
   * version heading would come back rearranged.
   */
  it('carries a heading release-please inserts above rather than rearranges around', () => {
    expect(/\n###? v?[0-9[]/s.test(rendered())).toBe(true);
    expect(rendered()).toContain('## 0.1.0 (unreleased)');
  });

  it('records what it was generated from, so the file is never read as hand-written', () => {
    expect(rendered()).toContain('Generated by `pnpm changelog`');
    expect(rendered()).toContain('Generated at 1234567 on 2026-09-15');
  });
});

describe('repositoryUrl', () => {
  it('prefers what Actions says, and parses an ssh remote otherwise', () => {
    expect(
      repositoryUrl({ GITHUB_SERVER_URL: 'https://github.test', GITHUB_REPOSITORY: 'o/r' }),
    ).toBe('https://github.test/o/r');
    // No Actions variables: falls through to `git remote get-url origin` in this checkout.
    expect(repositoryUrl({})).toMatch(/^https?:\/\/\S+\/\S+$/);
  });
});

describe('exitCriteriaNote', () => {
  it('states every one of product/14’s exit criteria against the release', () => {
    const note = exitCriteriaNote();
    expect(MVP_EXIT_CRITERIA).toHaveLength(8);
    for (const criterion of MVP_EXIT_CRITERIA) {
      expect(note).toContain(criterion.quote);
      expect(note).toContain(criterion.status);
    }
    expect(note).toContain('not a claim that the MVP is finished');
  });

  /**
   * A list where every entry says the same thing is a template, and a reader stops reading it
   * (standing rule 10, at the level of a document). One of the eight *is* different — no secret
   * has entered this repository, and gitleaks over the full history is what says so — and the
   * difference is the part that has to survive an edit.
   */
  it('does not mark them all alike, and says which one it can evidence', () => {
    const statuses = new Set(MVP_EXIT_CRITERIA.map((criterion) => criterion.status));
    expect(statuses.size).toBe(2);
    const evidenced = MVP_EXIT_CRITERIA.filter((criterion) => criterion.status !== 'not evidenced');
    expect(evidenced).toHaveLength(1);
    expect(evidenced[0]?.quote).toBe('zero secrets incidents');
    expect(evidenced[0]?.note).toContain('not about any installation');
  });
});
