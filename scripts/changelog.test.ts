import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BREAKING_SECTION,
  CHANGELOG_SECTIONS,
  type ChangelogSection,
  changelogHeadingProblems,
  exitCriteriaNote,
  groupBySection,
  MVP_EXIT_CRITERIA,
  migrationVerdict,
  modelMeasurement,
  type ParsedCommit,
  parseCommit,
  readCommits,
  renderChangelog,
  renderReleaseNotes,
  repositoryUrl,
  requestedVersion,
  upgradeNote,
  versionRefusal,
} from './changelog.mjs';

/**
 * `changelog.mjs` — the changelog preview and a release's notes (WP-42, WP-71, TD-019).
 *
 * The two things worth testing here are the two **derivations**, and both are tested from both
 * sides (standing rule 42): a note that always said "a migration is required" would pass the first
 * half of each pair, and one that never did would pass the second. That matters more than usual
 * because the wrong answer is not visible — nobody re-derives a release note, and an operator who
 * is told no migration is required does not take a dump.
 *
 * The commit parsing is held to release-please's own rules rather than to taste: the section table
 * is `DEFAULT_CHANGELOG_SECTIONS` at v17.6.0 and the hidden types stay hidden. release-please itself
 * is retired (WP-71); what replaced its insert-above behaviour is two checks this file holds — the
 * heading parse (`changelogHeadingProblems`, plan criterion 6) and the refusal to render a version
 * that is not ahead of the newest release (`versionRefusal` and the CLI, criterion 7).
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

  it('heads the preview with the version it was asked for, marked unreleased, and nothing else', () => {
    expect(rendered()).toContain('\n## 0.1.0 (unreleased)\n');
    expect(changelogHeadingProblems(rendered())).toEqual([]);
    // The header states who writes this file — nobody but a human running this script.
    expect(rendered()).toContain('No workflow writes this file');
  });

  it('records what it was generated from, so the file is never read as hand-written', () => {
    expect(rendered()).toContain('Generated by `pnpm changelog`');
    expect(rendered()).toContain('Generated at 1234567 on 2026-09-15');
  });
});

describe('renderReleaseNotes', () => {
  const notes = renderReleaseNotes({
    commits: [
      commit({ sha: 'a'.repeat(40), type: 'feat', subject: 'the thing' }),
      commit({ sha: 'b'.repeat(40), type: 'chore', subject: 'a chore nobody releases' }),
    ],
    url: 'https://github.test/owner/repo',
    note: '### Before you upgrade\n\nsomething\n',
  });

  /**
   * A GitHub Release is titled with its tag, so the body carries no version heading of its own, no
   * file header and no `# Changelog` title — the same version stated twice is two things to keep
   * equal.
   */
  it('is the body of one release: the note and the sections, with no heading of its own', () => {
    expect(notes.startsWith('### Before you upgrade')).toBe(true);
    expect(notes).toContain('### Features');
    expect(notes).toContain('the thing');
    expect(notes).not.toContain('a chore nobody releases');
    expect(notes).not.toMatch(/^## /m);
    expect(notes).not.toContain('# Changelog');
    expect(notes).not.toContain('<!--');
  });
});

/**
 * Plan criterion 6 (backlog 118's first symptom): pure parsing, no history. Each shape is asserted
 * as a defect **and** its neighbour as clean (standing rule 42), because a parser that reported
 * every file, or none, would pass half of these.
 */
describe('changelogHeadingProblems', () => {
  const file = (...headings: string[]): string =>
    ['# Changelog', '', ...headings.flatMap((heading) => [heading, '', '* an entry', ''])].join(
      '\n',
    );

  it('finds an unreleased heading below a released one — the preview that survived a release', () => {
    const problems = changelogHeadingProblems(
      file('## 0.2.0 (2026-10-01)', '## 0.1.0 (unreleased)'),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/0\.1\.0 is marked unreleased below 0\.2\.0/);
  });

  it('accepts an unreleased heading above the released ones', () => {
    expect(
      changelogHeadingProblems(file('## 0.3.0 (unreleased)', '## 0.2.0 (2026-10-01)')),
    ).toEqual([]);
  });

  it('finds two headings for one version, released or not', () => {
    const twice = changelogHeadingProblems(
      file(
        '## [0.1.0](https://github.test/compare/v0.0.9...v0.1.0) (2026-10-01)',
        '## 0.1.0 (unreleased)',
      ),
    );
    // Both shapes at once: a duplicate *and* an unreleased heading under a released one.
    expect(twice).toHaveLength(2);
    expect(twice.some((problem) => /a second heading for 0\.1\.0/.test(problem))).toBe(true);
    expect(
      changelogHeadingProblems(file('## 0.2.0 (2026-10-02)', '## 0.2.0 (2026-10-01)')),
    ).toEqual([expect.stringMatching(/a second heading for 0\.2\.0 \(the first is line 3\)/)]);
  });

  it('reads nothing into headings that are not version headings', () => {
    expect(
      changelogHeadingProblems(file('### Features', '### Bug Fixes', '## Notes (unreleased)')),
    ).toEqual([]);
    expect(changelogHeadingProblems('')).toEqual([]);
  });
});

describe('versionRefusal', () => {
  it('lets any well-formed version through before the first release', () => {
    expect(versionRefusal({ version: '0.1.0', previousTag: null })).toBeNull();
  });

  it('refuses a version at or below the newest release, and names the way out', () => {
    for (const version of ['0.1.0', '0.0.9']) {
      const refusal = versionRefusal({ version, previousTag: 'v0.1.0' });
      expect(refusal).toContain('v0.1.0 is released');
      expect(refusal).toContain('node scripts/version.mjs');
    }
    expect(versionRefusal({ version: '0.1.1', previousTag: 'v0.1.0' })).toBeNull();
  });

  it('refuses a version it cannot read rather than rendering it', () => {
    expect(versionRefusal({ version: 'next', previousTag: null })).toMatch(/not a MAJOR/);
  });
});

describe('requestedVersion', () => {
  it('is FIRST_VERSION when not given, and the value when given', () => {
    expect(requestedVersion(['node', 'changelog.mjs'])).toBe('0.1.0');
    expect(requestedVersion(['node', 'changelog.mjs', '--version', '0.4.0'])).toBe('0.4.0');
  });

  it('refuses a flag with no value — `--version "$(…)"` when the command printed nothing', () => {
    expect(() => requestedVersion(['node', 'changelog.mjs', '--version'])).toThrow(/needs a value/);
    expect(() => requestedVersion(['node', 'changelog.mjs', '--version', ''])).toThrow(
      /needs a value/,
    );
    expect(() => requestedVersion(['node', 'changelog.mjs', '--version', '--stdout'])).toThrow(
      /needs a value/,
    );
  });
});

/**
 * Plan criterion 7, run as a program against a repository whose release tag exists only in a
 * temporary directory: `pnpm changelog` **refuses** when a release tag exists and the version it
 * would render is not ahead of it. This is the canary the row asked for, kept as a test — before
 * WP-71 the same command overwrote the file with the released range under `## 0.1.0 (unreleased)`.
 */
describe('pnpm changelog, as a program, around the first release', () => {
  const scriptsDirectory = import.meta.dirname;

  /** A repository that carries this script, one migration, and the given history. */
  const checkout = (steps: readonly string[]): string => {
    // The real path: macOS's temporary directory is behind a symlink, and the script's own
    // "am I the program?" check compares its resolved URL with `argv[1]`, so a symlinked path would
    // make it do nothing and exit 0 — which is how the first run of this case failed.
    const root = realpathSync(scratch());
    mkdirSync(join(root, 'scripts'));
    for (const name of ['changelog.mjs', 'semver.mjs'])
      copyFileSync(join(scriptsDirectory, name), join(root, 'scripts', name));
    mkdirSync(join(root, 'packages/infrastructure/src/db/migrations'), { recursive: true });
    writeFileSync(
      join(root, 'packages/infrastructure/src/db/migrations/0001_a.sql'),
      'select 1;\n',
    );
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
          '-c',
          'tag.gpgsign=false',
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ],
        { cwd: root, stdio: 'ignore' },
      );
    };
    git('init', '-q', '-b', 'main');
    git('remote', 'add', 'origin', 'https://github.test/owner/repo.git');
    git('add', '-A');
    for (const step of steps) {
      if (step.startsWith('tag:')) git('tag', step.slice(4));
      else git('commit', '--allow-empty', '--no-verify', '-q', '-m', step);
    }
    return root;
  };

  const run = (root: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(root, 'scripts/changelog.mjs'), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });

  it('writes the preview under FIRST_VERSION before any release exists', () => {
    const root = checkout(['feat: one', 'fix: two']);
    const result = run(root);
    expect(`${result.status}: ${result.stderr}`).toBe('0: ');
    const written = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(written).toContain('## 0.1.0 (unreleased)');
    expect(changelogHeadingProblems(written)).toEqual([]);
  });

  it('refuses once a tag exists at the configured version, and writes nothing', () => {
    const root = checkout(['feat: one', 'tag:v0.1.0', 'fix: two']);
    for (const args of [[], ['--stdout'], ['--release-notes'], ['--version', '0.1.0']]) {
      const result = run(root, ...args);
      expect(result.status, `pnpm changelog ${args.join(' ')}`).toBe(1);
      expect(result.stderr).toContain('refusing');
      expect(result.stderr).toContain('v0.1.0 is released');
      expect(result.stdout).toBe('');
    }
    expect(() => readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toThrow(/ENOENT/);
  });

  it('renders the range since the release under a version ahead of it', () => {
    const root = checkout(['feat: one', 'tag:v0.1.0', 'fix: two']);
    const notes = run(root, '--release-notes', '--version', '0.1.1');
    expect(`${notes.status}: ${notes.stderr}`).toBe('0: ');
    expect(notes.stdout).toContain('* two (');
    // The commit the previous release already carried is not in this one's notes.
    expect(notes.stdout).not.toContain('* one (');
    expect(notes.stdout).not.toContain('first release of the **mechanism**');
    expect(notes.stdout).toContain('No migration is required.');
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
    expect(note).toContain('first release of the **mechanism**');
  });

  it('says “first” for the first release only', () => {
    const later = exitCriteriaNote(MVP_EXIT_CRITERIA, { first: false });
    expect(later).not.toContain('first release');
    expect(later).toContain('not a claim that the MVP is finished');
    for (const criterion of MVP_EXIT_CRITERIA) expect(later).toContain(criterion.quote);
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
