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
 * The range is resolved in this order:
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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inActions = process.env.GITHUB_ACTIONS === 'true';
/** git's null object id: "there is no such commit" in a push payload (40 hex, 64 under sha256). */
const NULL_OID = /^0{40,64}$/;

// ── CLI ────────────────────────────────────────────────────────────────────────────────────

const USAGE = 'usage: node scripts/commits.mjs [dco] [commitlint] [--from <rev>] [--to <rev>]';
const argv = process.argv.slice(2);
const checks = [];
let fromArg = process.env.COMMIT_RANGE_FROM || null;
let toArg = process.env.COMMIT_RANGE_TO || null;

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

const git = (args, options = {}) =>
  spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...options });

/** stdout of a git command that must succeed. */
const gitOut = (args) => {
  const result = git(args);
  if (result.error) die(`git ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0)
    die(`git ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`);
  return result.stdout.trimEnd();
};

const commitExists = (rev) => git(['cat-file', '-e', `${rev}^{commit}`]).status === 0;
const isAncestor = (a, b) => git(['merge-base', '--is-ancestor', a, b]).status === 0;

const mergeBase = (a, b) => {
  const result = git(['merge-base', a, b]);
  return result.status === 0 ? result.stdout.trim() : null;
};

const requireCommit = (rev, what) => {
  if (!commitExists(rev)) {
    die(
      `${what} ${rev} is not in this checkout. The commit gates need the full history — ` +
        'use `actions/checkout` with `fetch-depth: 0`.',
    );
  }
  return rev;
};

// ── range resolution ───────────────────────────────────────────────────────────────────────

/** @typedef {{ label: string, revList: string[] | null, contiguous: {from: string, to: string} | null }} Range */

/** @returns {Range} a plain `from..to` range. */
const contiguousRange = (from, to, label) => {
  requireCommit(from, 'base commit');
  requireCommit(to, 'head commit');
  return { label, revList: [`${from}..${to}`], contiguous: { from, to } };
};

/** Nothing to check — an empty range is a legitimate pass (a branch deletion, a re-push). */
const emptyRange = (label) => ({ label, revList: [], contiguous: null });

/**
 * Everything reachable from `head` but from no other ref: the honest answer for the first push
 * to a branch (`before` is the null oid) and for a force-push whose previous head is gone.
 * Needs the other refs to be present, which `fetch-depth: 0` guarantees.
 */
const newHistoryRange = (head, label) => {
  requireCommit(head, 'head commit');
  const refs = gitOut(['for-each-ref', '--format=%(objectname)']).split('\n').filter(Boolean);
  const exclude = [...new Set(refs)].filter((sha) => sha !== head);
  if (exclude.length === 0) {
    return {
      label: `${label}; no other ref, so the whole history is new`,
      revList: [head],
      contiguous: null,
    };
  }
  return { label, revList: [head, '--not', ...exclude], contiguous: null };
};

const readEvent = () => {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file)
    die(`GITHUB_EVENT_NAME is set but GITHUB_EVENT_PATH is not; cannot determine the commit range`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    return die(`cannot read the event payload ${file}: ${cause.message}`);
  }
};

/** @returns {Range} */
const pushRange = (event) => {
  const before = typeof event.before === 'string' ? event.before : '';
  const after = typeof event.after === 'string' ? event.after : '';
  if (!after || NULL_OID.test(after)) {
    if (event.deleted === true) return emptyRange('branch deleted, no commits to check');
    return die('push payload has no head commit (`after`) and is not a deletion');
  }
  if (before && !NULL_OID.test(before) && commitExists(before)) {
    if (isAncestor(before, after))
      return contiguousRange(before, after, `push ${short(before)}..${short(after)}`);
    const base = mergeBase(before, after);
    if (base) return contiguousRange(base, after, `force-push, from the merge base ${short(base)}`);
    return newHistoryRange(after, 'force-push onto an unrelated history');
  }
  if (event.created === true || !before || NULL_OID.test(before)) {
    return newHistoryRange(after, 'first push of this ref');
  }
  // A force-push that dropped the previous head: the object is not in this checkout, so
  // `before..after` cannot be computed. Fall back to what is new to the repository.
  return newHistoryRange(
    after,
    `force-push; the previous head ${short(before)} is no longer in the repository`,
  );
};

/** @returns {Range} */
const resolveRange = () => {
  if (fromArg || toArg) {
    if (!fromArg) usageError('--to needs a --from; there is no default base for an explicit range');
    return contiguousRange(
      fromArg,
      toArg ?? 'HEAD',
      `explicit range ${fromArg}..${toArg ?? 'HEAD'}`,
    );
  }

  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventName) {
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    if (upstream.status !== 0) {
      return die(
        'no commit range: this branch has no upstream, so there is nothing to compare against. ' +
          'Pass --from <rev> (see CONTRIBUTING "Commits").',
      );
    }
    const name = upstream.stdout.trim();
    return contiguousRange(name, 'HEAD', `${name}..HEAD`);
  }

  const event = readEvent();
  switch (eventName) {
    case 'push':
      return pushRange(event);
    case 'pull_request':
    case 'pull_request_target': {
      const base = event.pull_request?.base?.sha;
      const head = event.pull_request?.head?.sha;
      if (!base || !head) return die('pull_request payload carries no base/head sha');
      return contiguousRange(
        base,
        head,
        `pull request #${event.number} ${short(base)}..${short(head)}`,
      );
    }
    case 'merge_group': {
      const base = event.merge_group?.base_sha;
      const head = event.merge_group?.head_sha;
      if (!base || !head) return die('merge_group payload carries no base/head sha');
      return contiguousRange(base, head, `merge group ${short(base)}..${short(head)}`);
    }
    default:
      return die(
        `event ${eventName} carries no commit range; the commit gates run on push, ` +
          'pull_request and merge_group only',
      );
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

if (gitOut(['rev-parse', '--is-shallow-repository']) === 'true') {
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
