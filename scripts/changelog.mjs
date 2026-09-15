#!/usr/bin/env node
/**
 * The changelog and the release's upgrade note, both derived from git and the tree (TD-019).
 *
 *   pnpm changelog                  regenerate CHANGELOG.md for the unreleased range
 *   node scripts/changelog.mjs --stdout        print it instead of writing it
 *   node scripts/changelog.mjs --upgrade-note  print only the "Before you upgrade" block
 *
 * ## What this is for, and what it is not
 *
 * `release-please` (TD-019) writes the changelog and the release notes when a human merges the
 * release PR. That run happens on a cloud runner, against the GitHub API, with a token this
 * checkout does not have — so **nothing here can measure it**. What this script is, is the same
 * question asked offline: *which commits would the first release cover, and what would the notes
 * say about upgrading?* It reads release-please 17.6.0's own rules rather than inventing its own:
 *
 *  - the section table below is `DEFAULT_CHANGELOG_SECTIONS` from
 *    https://github.com/googleapis/release-please/blob/v17.6.0/src/util/filter-commits.ts —
 *    `feat`, `fix`, `perf` and `revert` are visible, the rest are hidden, and a breaking change is
 *    shown even when its type is hidden;
 *  - the version is read from `initial-version` in `release-please-config.json`, so there is one
 *    source for it rather than two (standing rule 7).
 *
 * The *rendering* is release-please's when it runs; a byte-for-byte match with what it will emit is
 * not claimed here and is not checkable from this checkout (standing rule 86: this docblock states
 * what was read, not what was observed to happen on a runner).
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
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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

/** The newest `vX.Y.Z` tag that is an ancestor of HEAD, or `null` before the first release. */
export const previousReleaseTag = (root = repositoryRoot) => {
  try {
    const out = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
};

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
export const exitCriteriaNote = (criteria = MVP_EXIT_CRITERIA) => {
  const lines = [
    '### What this release does not claim',
    '',
    'This is the first release of the **mechanism** — the images, the migrations, the changelog and',
    'the tags. It is not a claim that the MVP is finished. product/14’s exit criteria, each with',
    'what this repository can say about it:',
    '',
  ];
  for (const criterion of criteria) {
    lines.push(`- *“${criterion.quote}”* — **${criterion.status}**: ${criterion.note}`);
  }
  return `${lines.join('\n')}\n`;
};

/** The whole pre-release CHANGELOG.md. */
export const renderChangelog = ({ version, date, commits, unparsed, url, note, generatedAt }) => {
  const { breaking, sections } = groupBySection(commits);
  const shown = [...sections.values()].reduce((sum, list) => sum + list.length, 0);
  const lines = [
    '<!--',
    '  Generated by `pnpm changelog` from the conventional commits `pnpm run -s verify:commits`',
    '  enforces. Do not edit by hand.',
    '',
    `  Generated at ${generatedAt} on ${date}: ${commits.length + unparsed} commits in the range,`,
    `  ${shown} of them in the sections release-please 17.6.0 shows by default` +
      `${unparsed > 0 ? `, ${unparsed} not conventional commits` : ''}.`,
    '',
    '  The section below is a **preview**: release-please writes the real one when a human merges',
    '  the release PR (TD-019). Its updater inserts the released section above the first heading',
    '  matching /\\n###? v?[0-9[]/ — this one — so the release PR will show its own `0.1.0` section',
    '  directly above, and that PR is where this preview should be deleted.',
    '-->',
    '',
    '# Changelog',
    '',
    `## ${version} (unreleased)`,
    '',
    note.trimEnd(),
    '',
  ];

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
  return `${lines.join('\n').trimEnd()}\n`;
};

/** `initial-version` from the release-please config — the one place the first version is written. */
export const configuredVersion = (root = repositoryRoot) => {
  const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8'));
  const version = config['initial-version'];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('release-please-config.json has no usable "initial-version"');
  }
  return version;
};

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const isProgram =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);

if (isProgram) {
  try {
    const previousTag = previousReleaseTag();
    const verdict = migrationVerdict({
      shipped: shippedMigrations(),
      previous: previousTag === null ? [] : migrationsAt(previousTag),
      previousTag,
    });
    const note = `${upgradeNote({ verdict, measurement: modelMeasurement() })}\n${exitCriteriaNote()}`;

    if (process.argv.includes('--upgrade-note')) {
      process.stdout.write(`\n${note}`);
    } else {
      const range = previousTag === null ? null : `${previousTag}..HEAD`;
      const { commits, unparsed } = readCommits(range);
      if (commits.length === 0) fail('no commits in the range — nothing to write');
      const rendered = renderChangelog({
        version: configuredVersion(),
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
      if (process.argv.includes('--stdout')) {
        process.stdout.write(rendered);
      } else {
        const output = join(repositoryRoot, 'CHANGELOG.md');
        writeFileSync(output, rendered, 'utf8');
        process.stdout.write(
          `wrote ${output} (${commits.length} commits, ${unparsed} not conventional)\n`,
        );
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
