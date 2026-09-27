#!/usr/bin/env node
/**
 * The changelog and a release's notes, both derived from git and the tree (TD-019, WP-71).
 *
 *   pnpm changelog                               print the preview of the next version (writes nothing)
 *   node scripts/changelog.mjs --stdout          the same; the flag is kept for the commands that name it
 *   node scripts/changelog.mjs --release-notes   print the body of a GitHub Release
 *   node scripts/changelog.mjs --upgrade-note    print only the "Before you upgrade" block
 *   … --version X.Y.Z                            the version to render (default: `FIRST_VERSION`)
 *
 * ## What this is for
 *
 * Every push to `main` is the release (TD-019's amendment, Q96), and once an administrator turns
 * versioning on, `image.yml`'s `release` job cuts a `vX.Y.Z` tag and a GitHub Release for every
 * push that carries a releasable commit. **The release body is where a version's notes live**:
 * that job runs `--release-notes --version X.Y.Z` and nothing commits the result, so there is no
 * bot commit on `main`. The default mode is the same rendering asked offline — *what would the next
 * version say?* — printed and **never written**: `CHANGELOG.md` is a hand-written pointer to the
 * Releases page with no version heading (Q105 (c), PROGRESS backlog 257), because a file listing
 * versions is stale after nearly every push under continuous deployment, and keeping it current
 * would need the bot commit on `main` Q96 (3) rejected.
 *
 * ## The version it renders, and the refusal (plan criterion 7, backlog 118)
 *
 * Every mode that renders a version **refuses** when a release tag exists and the version is not
 * ahead of it. Before WP-71 this script took its version from release-please's `initial-version`
 * and rendered `previousTag..HEAD` under it, so the first `pnpm changelog` typed after the first
 * release would have rewritten the released commits' notes under `## 0.1.0 (unreleased)` — the
 * wrong range under a released number. Refusing is the `pnpm eval` shape: a run that cannot be
 * right says so and exits 1 rather than writing something that looks right. The refusal names the
 * version `node scripts/version.mjs` would cut, which is what a human previewing the next release
 * wants to pass.
 *
 * The section table is release-please 17.6.0's `DEFAULT_CHANGELOG_SECTIONS`
 * (https://github.com/googleapis/release-please/blob/v17.6.0/src/util/filter-commits.ts) — `feat`,
 * `fix`, `perf` and `revert` are visible, the rest are hidden, and a breaking change is shown even
 * when its type is hidden. release-please itself is retired (WP-71 deleted its workflow and
 * configuration); its table is kept because it is a sensible, documented default and because
 * `version.mjs` reads the same table to decide which commits cut a version, so what the notes show
 * and what moves the number cannot disagree.
 *
 * ## The two derivations that are the point
 *
 * **Whether a migration is required** is read from `packages/infrastructure/src/db/migrations/`
 * and the previous release tag, never written by hand: a hand-maintained "this release needs a
 * migration" line is wrong the first time somebody adds a `.sql` file and forgets (rule 7).
 *
 * **Whether the prompts have been measured against a model** is read from `.github/workflows/`:
 * TD-016's evals and the nightly real-LLM smoke are `evals.yml` and `nightly-llm.yml`, they do not
 * exist in this build (WP-33, blocked on a model credential), and a release that did not say so
 * would be shipping prompts no tier has ever run against a model without mentioning it. When those
 * two files land, this paragraph retires itself — which is why it is a question about the tree
 * rather than a sentence in a template.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isProgram } from './is-program.mjs';
import {
  compareVersions,
  FIRST_VERSION,
  latestReleaseTag,
  parseVersion,
  releaseTags,
  tagVersion,
} from './semver.mjs';

const repositoryRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The two separators `git log --format` writes between fields and records.
 *
 * Both are written as **escapes** here and as git's own `%x1f`/`%x1e` tokens in the format string,
 * which is two lessons in one line. The first draft used a literal NUL as the record separator —
 * the byte standing rule 30 and `pnpm run -s nul:check` exist for, which would have made this file
 * binary to git; it failed nothing locally because the file was not tracked yet, which is standing
 * rule 85's second half exactly. It then failed at runtime for a different reason worth keeping:
 * Node refuses to spawn a process with a NUL inside an argument ("The argument 'args[2]' must be a
 * string without null bytes"), so the separator git is *asked* for is the token and never the byte.
 */
const FIELD = '\u001f';
const RECORD = '\u001e';
/** What git is *told*: plain ASCII, expanded by git itself into the two bytes above. */
const GIT_FORMAT = '%H%x1f%s%x1f%b%x1e';

/**
 * release-please's default section table (v17.6.0, `src/util/filter-commits.ts`).
 *
 * Kept in release-please's order, because that is the order it renders sections in.
 */
export const CHANGELOG_SECTIONS = [
  { type: 'feat', section: 'Features', hidden: false },
  { type: 'fix', section: 'Bug Fixes', hidden: false },
  { type: 'perf', section: 'Performance Improvements', hidden: false },
  { type: 'revert', section: 'Reverts', hidden: false },
  { type: 'chore', section: 'Miscellaneous Chores', hidden: true },
  { type: 'docs', section: 'Documentation', hidden: true },
  { type: 'style', section: 'Styles', hidden: true },
  { type: 'refactor', section: 'Code Refactoring', hidden: true },
  { type: 'test', section: 'Tests', hidden: true },
  { type: 'build', section: 'Build System', hidden: true },
  { type: 'ci', section: 'Continuous Integration', hidden: true },
];

export const BREAKING_SECTION = '⚠ BREAKING CHANGES';

/** `type(scope)!: subject` — the header commitlint already enforces on every pushed commit. */
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?: (?<subject>.+)$/;

/**
 * One commit, parsed.
 *
 * `null` for a subject that is not a conventional commit. The caller counts those rather than
 * dropping them silently: `verify:commitlint` gates every pushed range, so one appearing here is
 * either history from before that gate or a bug in this parser, and both are worth saying out loud.
 */
export const parseCommit = ({ sha, subject, body }) => {
  const match = HEADER.exec(subject);
  if (match === null || match.groups === undefined) return null;
  const { type, scope, breaking, subject: text } = match.groups;
  return {
    sha,
    type,
    scope: scope ?? null,
    subject: text,
    breaking: breaking === '!' || /^BREAKING[ -]CHANGE:/m.test(body ?? ''),
  };
};

/** The commits of a git range, newest first, already parsed. */
export const readCommits = (range, root = repositoryRoot) => {
  const out = execFileSync(
    'git',
    ['log', '--no-merges', `--format=${GIT_FORMAT}`, ...(range === null ? [] : [range])],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const records = out.split(RECORD).filter((record) => record.trim() !== '');
  const commits = [];
  let unparsed = 0;
  for (const record of records) {
    const [sha = '', subject = '', body = ''] = record.replace(/^\n/, '').split(FIELD);
    const parsed = parseCommit({ sha, subject, body });
    if (parsed === null) unparsed += 1;
    else commits.push(parsed);
  }
  return { commits, unparsed, total: records.length };
};

/** The commits release-please would show, grouped into its sections, in its order. */
export const groupBySection = (commits) => {
  const visible = new Map();
  const breaking = commits.filter((commit) => commit.breaking);
  for (const { type, section, hidden } of CHANGELOG_SECTIONS) {
    const inSection = commits.filter((commit) => commit.type === type);
    if (inSection.length === 0) continue;
    // A hidden type is shown only when the commit is breaking, and then only in the breaking
    // section — `filterCommits` in release-please v17.6.0.
    if (hidden) continue;
    visible.set(section, inSection);
  }
  return { breaking, sections: visible };
};

/** `git@github.com:owner/repo.git` / `https://…` / the Actions environment → a browse URL. */
export const repositoryUrl = (env = process.env, root = repositoryRoot) => {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY } = env;
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY) return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`;
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote);
  if (ssh !== null) return `https://${ssh[1]}/${ssh[2]}`;
  return remote.replace(/\.git$/, '');
};

const entry = (commit, url) =>
  `* ${commit.scope ? `**${commit.scope}:** ` : ''}${commit.subject} ` +
  `([${commit.sha.slice(0, 7)}](${url}/commit/${commit.sha}))`;

/** The migration files this build ships, in order. */
export const shippedMigrations = (root = repositoryRoot) =>
  readdirSync(join(root, 'packages/infrastructure/src/db/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();

/** The migration files a git ref carried; `[]` when there is no such ref. */
const migrationsAt = (ref, root = repositoryRoot) => {
  try {
    const out = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', ref, '--', 'packages/infrastructure/src/db/migrations'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out
      .split('\n')
      .filter((path) => path.endsWith('.sql'))
      .map((path) => path.slice(path.lastIndexOf('/') + 1))
      .sort();
  } catch {
    return [];
  }
};

/**
 * The highest strict `vX.Y.Z` tag `HEAD` contains, or `null` before the first release.
 *
 * It was `git describe --match 'v*'` until WP-71: the *nearest* tag by topology, accepting any tag
 * starting with `v`. `semver.mjs` has why that is the wrong question for a version, and this is now
 * the same answer `version.mjs` uses.
 */
export const previousReleaseTag = (root = repositoryRoot) => latestReleaseTag(releaseTags(root));

/**
 * Does upgrading to this build apply a migration?
 *
 * Forward-only (TD-019), so the question is only ever "which files are new since the last
 * release" — and before the first release every one of them is, which is the honest answer for a
 * fresh install as well as for 0.1.0.
 */
export const migrationVerdict = ({ shipped, previous, previousTag }) => {
  const previousSet = new Set(previous);
  const added = shipped.filter((name) => !previousSet.has(name));
  return {
    required: added.length > 0,
    added,
    shippedCount: shipped.length,
    previousTag: previousTag ?? null,
  };
};

/** TD-016's evals and the nightly real-LLM smoke — present, or not yet built (WP-33). */
export const modelMeasurement = (root = repositoryRoot) => {
  const missing = ['evals.yml', 'nightly-llm.yml'].filter(
    (name) => !existsSync(join(root, '.github/workflows', name)),
  );
  return { missing, measured: missing.length === 0 };
};

const CODE_FENCE = '```';

/**
 * The block the release notes carry above the commit list: what upgrading does to the database,
 * and what this build's prompts have and have not been measured against.
 */
export const upgradeNote = ({ verdict, measurement }) => {
  const lines = ['### Before you upgrade', ''];

  if (verdict.required) {
    const since =
      verdict.previousTag === null
        ? 'this is the first release, so every one of them is new'
        : `${verdict.added.length} of them new since ${verdict.previousTag}`;
    lines.push(
      `**A migration is required.** This build ships ${verdict.shippedCount} migration files ` +
        `(${since}), up to \`${verdict.added[verdict.added.length - 1]}\`. Migrations are ` +
        'forward-only and are applied by the `migrate` service under an advisory lock:',
      '',
      CODE_FENCE + 'bash',
      'docker compose exec -T db pg_dump -U app -Fc app > pre-upgrade-$(date +%F).dump',
      'docker compose run --rm migrate',
      'docker compose up -d',
      CODE_FENCE,
      '',
      '**Take the dump first.** A migration is forward-only, so there is no down-step if one goes ' +
        'wrong, and rolling the image back without rolling the database back is not supported: a ' +
        'build refuses to start against a database carrying a migration it does not know, and ' +
        'names it. See `docs/operator-guide.md` § 5 (upgrade) and § 6 (backup).',
    );
  } else {
    lines.push(
      `**No migration is required.** This build ships the same ${verdict.shippedCount} migration ` +
        `files as ${verdict.previousTag}; \`docker compose up -d\` is the whole upgrade, and the ` +
        '`migrate` service is a no-op that still runs and records that it found nothing pending.',
    );
  }

  lines.push('', '### What has not been measured', '');
  if (measurement.measured) {
    lines.push(
      'The role prompts are covered by the eval workflows in `.github/workflows/` ' +
        `(${['evals.yml', 'nightly-llm.yml'].join(', ')}); read their runs for this ref.`,
    );
  } else {
    lines.push(
      '**The prompts in this release have never been run against a model.** TD-016’s role ' +
        `evals and the nightly real-LLM smoke (${measurement.missing.join(', ')}) are not in ` +
        'this build: they need a model credential the repository does not have (WP-33). Every ' +
        'automated tier that gates this release is deterministic — the agent in them is a fake. ' +
        'The prompt assembly, the tool policy and the artifact schemas are tested; **what a model ' +
        'does with them is not.**',
    );
  }
  return `${lines.join('\n')}\n`;
};

/**
 * product/14 § "MVP exit criteria", quoted, with what this release can and cannot evidence.
 *
 * They are **dogfooding** facts — tickets delivered, merged, priced, proposals accepted — and a
 * release note that let a reader take CI's green ticks for them would be the largest unlabelled
 * hypothesis this project has published (standing rule 39). So each is stated with its status,
 * and seven of the eight say the same thing: *not evidenced by anything in this repository.*
 *
 * `quote` is a **substring of the product document**, and `scripts/release.test.ts` checks it is
 * still there: a criterion reworded upstream would otherwise be quoted here for years.
 */
export const MVP_EXIT_CRITERIA = [
  {
    quote: '20 real tickets across the 2 founder projects',
    status: 'not evidenced',
    note: 'no ticket has been delivered by an installation of this build; `/api/org/stats` is where the count comes from once one has.',
  },
  {
    quote: '≥ 60% merged',
    status: 'not evidenced',
    note: 'the statistics API computes it from delivered tasks; it has none.',
  },
  {
    quote: 'cost per merged feature measured',
    status: 'not evidenced',
    note: 'the cost ledger records a run’s reported spend, and no run of this build has been merged.',
  },
  {
    quote: '≥ 10 accepted KB proposals',
    status: 'not evidenced',
    note: 'nothing has been proposed or accepted; the queue exists.',
  },
  {
    quote: 'zero secrets incidents',
    status: 'evidenced for this repository only',
    note: 'gitleaks runs over the full history in CI and over every staged diff in the pre-commit hook, and has never reported a finding here. That is a statement about **this repository**, not about any installation — an incident in an instance is not something a release can evidence.',
  },
  {
    quote: 'a stranger can install from the README in < 1 hour',
    status: 'not evidenced',
    note: 'the operator guide was written against a dogfood install and every command in it was run, by the author of the software — which is not the measurement.',
  },
  {
    quote: 'shadow mode run on 10 closed tickets per project with a comparison report',
    status: 'not evidenced',
    note: 'shadow mode and its report ship in this build; no batch has been run on a real project.',
  },
  {
    quote: 'review-only used on ≥ 20 human MRs',
    status: 'not evidenced',
    note: 'review-only ships and is off by default; no project has enabled it.',
  },
];

/** The section that keeps the release from reading as a claim about the product's MVP. */
export const exitCriteriaNote = (criteria = MVP_EXIT_CRITERIA, { first = true } = {}) => {
  // "The first release of the mechanism" is true of exactly one version; every later one gets the
  // sentence that stays true (standing rule 83: a note rendered for years must not say "first").
  const opening = first
    ? [
        'This is the first release of the **mechanism** — the images, the migrations, the changelog and',
        'the tags. It is not a claim that the MVP is finished. product/14’s exit criteria, each with',
        'what this repository can say about it:',
      ]
    : [
        'A version is cut by every push to `main` that carries a releasable commit, so a version',
        'number is not a claim that the MVP is finished. product/14’s exit criteria, each with what',
        'this repository can say about it:',
      ];
  const lines = ['### What this release does not claim', '', ...opening, ''];
  for (const criterion of criteria) {
    lines.push(`- *“${criterion.quote}”* — **${criterion.status}**: ${criterion.note}`);
  }
  return `${lines.join('\n')}\n`;
};

/** The note, then the breaking changes, then the visible sections — the body of one version. */
const renderSections = ({ commits, url, note }) => {
  const { breaking, sections } = groupBySection(commits);
  const lines = [note.trimEnd(), ''];
  if (breaking.length > 0) {
    lines.push(`### ${BREAKING_SECTION}`, '');
    for (const commit of breaking) lines.push(entry(commit, url));
    lines.push('');
  }
  for (const [section, list] of sections) {
    lines.push(`### ${section}`, '');
    for (const commit of list) lines.push(entry(commit, url));
    lines.push('');
  }
  return lines;
};

/** The preview of the next version, rendered from a checkout — printed, never written (Q105). */
export const renderChangelog = ({ version, date, commits, unparsed, url, note, generatedAt }) => {
  const { sections } = groupBySection(commits);
  const shown = [...sections.values()].reduce((sum, list) => sum + list.length, 0);
  const lines = [
    '<!--',
    '  Generated by `pnpm changelog` from the conventional commits `pnpm run -s verify:commits`',
    '  enforces.',
    '',
    `  Generated at ${generatedAt} on ${date}: ${commits.length + unparsed} commits in the range,`,
    `  ${shown} of them in the sections release-please 17.6.0 shows by default` +
      `${unparsed > 0 ? `, ${unparsed} not conventional commits` : ''}.`,
    '',
    '  A **preview** of the next version, printed and never written to a file: every release',
    '  carries its own notes in its GitHub Release, rendered there by',
    '  `pnpm changelog --release-notes` (TD-019’s amendment, WP-71), and `CHANGELOG.md` only points',
    '  there (Q105). `pnpm changelog` refuses a version that is not ahead of the newest release tag.',
    '-->',
    '',
    '# Changelog',
    '',
    `## ${version} (unreleased)`,
    '',
    ...renderSections({ commits, url, note }),
  ];
  return `${lines.join('\n').trimEnd()}\n`;
};

/**
 * The body of one GitHub Release: no file header and no version heading — the release is titled
 * with its tag, so a heading inside it would be the version stated twice.
 */
export const renderReleaseNotes = ({ commits, url, note }) =>
  `${renderSections({ commits, url, note }).join('\n').trimEnd()}\n`;

/**
 * Why `version` may not be rendered as the next release after `previousTag`, or `null` when it may.
 *
 * Plan criterion 7 / backlog 118's second symptom: once a release exists, rendering a version at or
 * below it puts released commits under a number that is already taken.
 */
export const versionRefusal = ({ version, previousTag }) => {
  if (parseVersion(version) === null) return `not a MAJOR.MINOR.PATCH version: ${version}`;
  if (previousTag === null) return null;
  const previous = tagVersion(previousTag);
  if (previous === null) return `not a release tag: ${previousTag}`;
  if (compareVersions(version, previous) > 0) return null;
  return (
    `${previousTag} is released and the version to render, ${version}, is not ahead of it — ` +
    'rendering would put the commits since that release under a number that is already taken. ' +
    'Each release carries its own notes in its GitHub Release; to preview the next one, pass the ' +
    'version it would cut: node scripts/changelog.mjs --stdout --version "$(node scripts/version.mjs)"'
  );
};

/**
 * A version heading of a changelog: ours (`## 0.1.0 (unreleased)`, `## 0.1.0 (2026-09-27)`) and
 * the linked form release-please and most generators write (`## [0.1.0](…) (2026-09-27)`).
 */
const VERSION_HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?(?:\([^)]*\))?\s*\(([^)]*)\)\s*$/;

/**
 * What is structurally wrong with a changelog's version headings (plan criterion 6, backlog 118's
 * first symptom) — pure parsing, no history, so it holds on a shallow clone and needs no tag.
 *
 * Two shapes: an `(unreleased)` heading **below** a released one (the preview that survived a
 * release, which is what release-please's insert-above rule produced), and **two headings for one
 * version** (the same release rendered twice). Returns one sentence per problem; `[]` is clean.
 */
export const changelogHeadingProblems = (text) => {
  const problems = [];
  const seen = new Map();
  let released = null;
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const match = VERSION_HEADING.exec(line);
    if (match === null) continue;
    const [, version = '', qualifier = ''] = match;
    const at = index + 1;
    if (seen.has(version)) {
      problems.push(
        `line ${at}: a second heading for ${version} (the first is line ${seen.get(version)})`,
      );
    } else {
      seen.set(version, at);
    }
    if (qualifier.trim().toLowerCase() === 'unreleased') {
      if (released !== null) {
        problems.push(
          `line ${at}: ${version} is marked unreleased below ${released.version}, a released version (line ${released.at})`,
        );
      }
    } else if (released === null) {
      released = { version, at };
    }
  }
  return problems;
};

/** The value after `--version`, or `FIRST_VERSION` when the flag is absent. */
export const requestedVersion = (argv) => {
  const index = argv.indexOf('--version');
  if (index === -1) return FIRST_VERSION;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--') || value === '') {
    throw new Error('--version needs a value: MAJOR.MINOR.PATCH');
  }
  return value;
};

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

/** The preview, printed. Nothing writes `CHANGELOG.md` any more (Q105 (c), backlog 257). */
const printPreview = ({ version, commits, unparsed, note }) => {
  const rendered = renderChangelog({
    version,
    date: new Date().toISOString().slice(0, 10),
    commits,
    unparsed,
    url: repositoryUrl(),
    note,
    generatedAt: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim(),
  });
  process.stdout.write(rendered);
};

// Real paths on both sides, so a run through a symlinked path is still the program (backlog 258).
if (isProgram(import.meta.url)) {
  try {
    const previousTag = previousReleaseTag();
    const verdict = migrationVerdict({
      shipped: shippedMigrations(),
      previous: previousTag === null ? [] : migrationsAt(previousTag),
      previousTag,
    });
    const note =
      `${upgradeNote({ verdict, measurement: modelMeasurement() })}\n` +
      exitCriteriaNote(MVP_EXIT_CRITERIA, { first: previousTag === null });

    if (process.argv.includes('--upgrade-note')) {
      process.stdout.write(`\n${note}`);
    } else {
      const version = requestedVersion(process.argv);
      const refusal = versionRefusal({ version, previousTag });
      if (refusal !== null) fail(`pnpm changelog: refusing. ${refusal}`);
      const range = previousTag === null ? null : `${previousTag}..HEAD`;
      const { commits, unparsed } = readCommits(range);
      if (commits.length === 0) fail('no commits in the range — nothing to write');
      if (process.argv.includes('--release-notes')) {
        // No `process.exit` after this write: on a pipe (the workflow redirects it) a write can be
        // asynchronous, and exiting would truncate the release body.
        process.stdout.write(renderReleaseNotes({ commits, url: repositoryUrl(), note }));
      } else {
        printPreview({ version, commits, unparsed, note });
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
