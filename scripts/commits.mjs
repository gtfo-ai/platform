#!/usr/bin/env node
/**
 * Commit gates — the two checks every commit that reaches `main` has to pass
 * (CONTRIBUTING "Commits", technical/11, TD-019):
 *
 *   pnpm run -s verify:dco         every commit in the range carries a `Signed-off-by`
 *                                  trailer whose e-mail is the commit author's (DCO)
 *   pnpm run -s verify:commitlint  every commit message in the range is a conventional
 *                                  commit, per `commitlint.config.js`
 *   pnpm run -s verify:commits     both of the above
 *
 * Each target prints exactly one `PASS: <target>` / `FAIL: <target>` line on **stdout**
 * (technical/14 verification contract); everything the checks have to say goes to stderr.
 *
 * The range is resolved by `commit-range.mjs`, in this order:
 *   1. `--from <rev>` / `--to <rev>`, or `COMMIT_RANGE_FROM` / `COMMIT_RANGE_TO`
 *   2. the GitHub event payload at `$GITHUB_EVENT_PATH` — push, pull_request, merge_group
 *   3. `@{upstream}..HEAD`, for a local run
 *
 * A range that cannot be determined is a FAIL, never a pass. That is the whole point of this
 * file: both jobs used to carry `if: github.event_name == 'pull_request'` while the project
 * pushed straight to `main`, so they reported success on every push without ever running.
 * A gate that cannot fail is not a gate.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  CommitRangeError,
  gitRunner,
  isShallowCheckout,
  resolveCommitRange,
} from './commit-range.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inActions = process.env.GITHUB_ACTIONS === 'true';

// ── CLI ────────────────────────────────────────────────────────────────────────────────────

const USAGE = 'usage: node scripts/commits.mjs [dco] [commitlint] [--from <rev>] [--to <rev>]';
const argv = process.argv.slice(2);
const checks = [];
// `COMMIT_RANGE_FROM` / `COMMIT_RANGE_TO` are read by `resolveCommitRange` when these stay null.
let fromArg = null;
let toArg = null;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--from' || arg === '--to') {
    const value = argv[++i];
    if (value === undefined) usageError(`${arg} needs a value`);
    if (arg === '--from') fromArg = value;
    else toArg = value;
  } else if (arg.startsWith('--from=')) fromArg = arg.slice('--from='.length);
  else if (arg.startsWith('--to=')) toArg = arg.slice('--to='.length);
  else if (arg === 'dco' || arg === 'commitlint') {
    if (!checks.includes(arg)) checks.push(arg);
  } else usageError(`unexpected argument ${JSON.stringify(arg)}`);
}

if (checks.length === 0) checks.push('dco', 'commitlint');
const target = checks.length === 1 ? `verify:${checks[0]}` : 'verify:commits';

function usageError(message) {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.stdout.write('FAIL: verify:commits\n');
  process.exit(2);
}

/** Fail loudly: the reason on stderr, one FAIL line on stdout, non-zero exit. */
function die(message) {
  error(message);
  process.stdout.write(`FAIL: ${target}\n`);
  process.exit(1);
}

function error(message) {
  process.stderr.write(inActions ? `::error::${message}\n` : `${message}\n`);
}

function note(message) {
  process.stderr.write(`${message}\n`);
}

// ── git helpers ────────────────────────────────────────────────────────────────────────────

const git = gitRunner(repoRoot);

/** stdout of a git command that must succeed. */
const gitOut = (args) => {
  try {
    return git.out(args);
  } catch (cause) {
    return die(cause.message);
  }
};

// ── range resolution ───────────────────────────────────────────────────────────────────────
// `commit-range.mjs` (moved there at WP-271, so `migrations:check` shares it).

/** @returns {import('./commit-range.mjs').CommitRange} */
const resolveRange = () => {
  try {
    return resolveCommitRange(git, { from: fromArg, to: toArg });
  } catch (cause) {
    if (cause instanceof CommitRangeError && cause.code === 'usage')
      return usageError(cause.message);
    if (cause instanceof CommitRangeError) return die(cause.message);
    throw cause;
  }
};

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 9) : String(sha));

// ── commits ────────────────────────────────────────────────────────────────────────────────

const FIELD = '\x1f';
const TRAILER = '\x1e';
const FORMAT = `%H${'%x1f'}%P${'%x1f'}%an${'%x1f'}%ae${'%x1f'}%s${'%x1f'}%(trailers:key=Signed-off-by,valueonly,unfold,separator=%x1e)%x00`;

/** Oldest first, so failures read in the order the commits were written. */
const listCommits = (range) => {
  if (range.revList === null || range.revList.length === 0) return [];
  const out = gitOut(['log', '--no-decorate', `--format=${FORMAT}`, ...range.revList]);
  return out
    .split('\0')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha, parents, authorName, authorEmail, subject, trailers = ''] = record.split(FIELD);
      return {
        sha,
        parents: parents.split(' ').filter(Boolean),
        authorName,
        authorEmail,
        subject,
        signoffs: trailers
          .split(TRAILER)
          .map((value) => value.trim())
          .filter(Boolean),
      };
    })
    .reverse();
};

// ── the DCO check ──────────────────────────────────────────────────────────────────────────

/** `Name <email>` — anything else is not a usable sign-off. */
const parseIdentity = (value) => {
  const match = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(value);
  if (!match) return null;
  const [, name, email] = match;
  return name.trim() ? { name: name.trim(), email } : null;
};

const checkDco = (commits) => {
  const problems = [];
  let merges = 0;

  for (const commit of commits) {
    // A merge commit introduces no authorship of its own: the commits it brings in are part of
    // this same range and are each checked below, and GitHub's own merge commits carry no
    // trailer. Skipping it loses no coverage.
    if (commit.parents.length > 1) {
      merges++;
      continue;
    }
    if (commit.signoffs.length === 0) {
      problems.push([commit, 'no Signed-off-by trailer']);
      continue;
    }
    const identities = commit.signoffs.map(parseIdentity).filter(Boolean);
    if (identities.length === 0) {
      problems.push([
        commit,
        `no usable "Name <email>" sign-off (found: ${commit.signoffs.join('; ')})`,
      ]);
      continue;
    }
    const author = commit.authorEmail.toLowerCase();
    if (!identities.some((identity) => identity.email.toLowerCase() === author)) {
      problems.push([
        commit,
        `signed off by ${identities.map((i) => i.email).join(', ')} but authored by ${commit.authorEmail}`,
      ]);
    }
  }

  for (const [commit, why] of problems) {
    error(`${short(commit.sha)} ${commit.subject} — ${why}`);
  }
  if (problems.length > 0) {
    note('Sign your commits: `git commit -s`, or `git rebase --signoff <base>` (CONTRIBUTING.md).');
    return false;
  }
  note(
    `dco: ${commits.length - merges} commit(s) signed off by their author` +
      (merges > 0 ? `, ${merges} merge commit(s) skipped` : ''),
  );
  return true;
};

// ── the commitlint check ───────────────────────────────────────────────────────────────────

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/** Child stdout is redirected onto our stderr: only the PASS/FAIL verdict may reach stdout. */
const runCommitlint = (args, input) =>
  spawnSync(pnpm, ['exec', 'commitlint', ...args], {
    cwd: repoRoot,
    stdio: [input === undefined ? 'inherit' : 'pipe', 2, 'inherit'],
    input,
    env: process.env,
  });

const checkCommitlint = (commits, range) => {
  if (range.contiguous) {
    const { from, to } = range.contiguous;
    const result = runCommitlint(['--from', from, '--to', to, '--verbose']);
    if (result.error) return die(`commitlint: ${result.error.message}`);
    if (result.status !== 0) {
      error(`commitlint rejected a commit message in ${short(from)}..${short(to)}`);
      return false;
    }
    note(`commitlint: ${commits.length} commit message(s) are conventional commits`);
    return true;
  }

  // No `from..to` to hand commitlint (a first push, or a force-push onto an unrelated history):
  // lint each commit message on stdin instead, so exactly the new commits are checked.
  let failures = 0;
  for (const commit of commits) {
    const message = gitOut(['show', '-s', '--format=%B', commit.sha]);
    const result = runCommitlint(['--verbose'], `${message}\n`);
    if (result.error) return die(`commitlint: ${result.error.message}`);
    if (result.status !== 0) {
      error(`${short(commit.sha)} ${commit.subject} — not a conventional commit`);
      failures++;
    }
  }
  if (failures > 0) return false;
  note(`commitlint: ${commits.length} commit message(s) are conventional commits`);
  return true;
};

// ── main ───────────────────────────────────────────────────────────────────────────────────

let shallow = false;
try {
  shallow = isShallowCheckout(git);
} catch (cause) {
  die(cause.message);
}
if (shallow) {
  die('this checkout is shallow, so the pushed range is unknowable — use `fetch-depth: 0`.');
}

const range = resolveRange();
const commits = listCommits(range);
note(`── ${target} › ${range.label} — ${commits.length} commit(s)`);

let ok = true;
if (commits.length === 0) {
  note('no commits in range; nothing to check');
} else {
  for (const check of checks) {
    ok = (check === 'dco' ? checkDco(commits) : checkCommitlint(commits, range)) && ok;
  }
}

process.stdout.write(`${ok ? 'PASS' : 'FAIL'}: ${target}\n`);
process.exit(ok ? 0 : 1);
