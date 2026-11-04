/**
 * Which commits a push brings — the one answer `verify:commits` (`commits.mjs`) and
 * `migrations:check` (`check-migrations.ts`, WP-271) share.
 *
 * The range is resolved in this order:
 *   1. `--from <rev>` / `--to <rev>`, or `COMMIT_RANGE_FROM` / `COMMIT_RANGE_TO`
 *   2. the GitHub event payload at `$GITHUB_EVENT_PATH` — push, pull_request, merge_group
 *   3. `@{upstream}..HEAD`, for a local run
 *
 * A range that cannot be determined is an error ({@link CommitRangeError}), never an empty range:
 * both commit gates once carried `if: github.event_name == 'pull_request'` while the project pushed
 * straight to `main`, so they reported success on every push without ever running. The one
 * legitimate empty range is a branch deletion.
 *
 * Moved here from `commits.mjs` at WP-271 so the migration check reads the push's base the same
 * way the commit gates do, rather than through a second resolution; `commits.mjs` turns the error
 * into its `FAIL:` line exactly as before. Plain JavaScript because `commits.mjs` runs with no
 * TypeScript resolver; `commit-range.d.mts` carries the types.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

/** git's null object id: "there is no such commit" in a push payload (40 hex, 64 under sha256). */
const NULL_OID = /^0{40,64}$/;

/** The range could not be determined. `code` names why, for a caller that has a fallback. */
export class CommitRangeError extends Error {
  constructor(message, code = 'unresolved') {
    super(message);
    this.name = 'CommitRangeError';
    this.code = code;
  }
}

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 9) : String(sha));

/**
 * A git runner bound to `cwd` and `env`: `run(args)` is the raw result, `out(args)` the stdout of a
 * command that must succeed.
 */
export function gitRunner(cwd, env = process.env) {
  const run = (args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  const out = (args) => {
    const result = run(args);
    if (result.error) throw new CommitRangeError(`git ${args.join(' ')}: ${result.error.message}`);
    if (result.status !== 0) {
      throw new CommitRangeError(
        `git ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`,
      );
    }
    return result.stdout.trimEnd();
  };
  return { run, out };
}

/** Whether the checkout is shallow — then no pushed range is knowable. */
export function isShallowCheckout(git) {
  return git.out(['rev-parse', '--is-shallow-repository']) === 'true';
}

/**
 * The range a push, pull request or merge group brings, or the local upstream's.
 *
 * `from`/`to` are the explicit bounds (`--from`/`--to`); `env` is read for `COMMIT_RANGE_*`,
 * `GITHUB_EVENT_NAME` and `GITHUB_EVENT_PATH`. The answer is `{ label, revList, contiguous }`:
 * `contiguous` is `{ from, to }` when the range is a plain `from..to`, `null` otherwise, and
 * `revList` is what `git log` takes (`[]` for nothing to check).
 */
export function resolveCommitRange(git, { from = null, to = null, env = process.env } = {}) {
  const commitExists = (rev) => git.run(['cat-file', '-e', `${rev}^{commit}`]).status === 0;
  const isAncestor = (a, b) => git.run(['merge-base', '--is-ancestor', a, b]).status === 0;
  const mergeBase = (a, b) => {
    const result = git.run(['merge-base', a, b]);
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const requireCommit = (rev, what) => {
    if (!commitExists(rev)) {
      throw new CommitRangeError(
        `${what} ${rev} is not in this checkout. The check needs the full history — ` +
          'use `actions/checkout` with `fetch-depth: 0`.',
        'missing_commit',
      );
    }
    return rev;
  };
  const contiguousRange = (base, head, label) => {
    requireCommit(base, 'base commit');
    requireCommit(head, 'head commit');
    return { label, revList: [`${base}..${head}`], contiguous: { from: base, to: head } };
  };
  const emptyRange = (label) => ({ label, revList: [], contiguous: null });

  // Everything reachable from `head` but from no other ref: the honest answer for the first push
  // to a branch (`before` is the null oid) and for a force-push whose previous head is gone.
  // Needs the other refs to be present, which `fetch-depth: 0` guarantees.
  const newHistoryRange = (head, label) => {
    requireCommit(head, 'head commit');
    const refs = git.out(['for-each-ref', '--format=%(objectname)']).split('\n').filter(Boolean);
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
    const file = env.GITHUB_EVENT_PATH;
    if (!file) {
      throw new CommitRangeError(
        'GITHUB_EVENT_NAME is set but GITHUB_EVENT_PATH is not; cannot determine the commit range',
      );
    }
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (cause) {
      throw new CommitRangeError(`cannot read the event payload ${file}: ${cause.message}`);
    }
  };

  const pushRange = (event) => {
    const before = typeof event.before === 'string' ? event.before : '';
    const after = typeof event.after === 'string' ? event.after : '';
    if (!after || NULL_OID.test(after)) {
      if (event.deleted === true) return emptyRange('branch deleted, no commits to check');
      throw new CommitRangeError('push payload has no head commit (`after`) and is not a deletion');
    }
    if (before && !NULL_OID.test(before) && commitExists(before)) {
      if (isAncestor(before, after))
        return contiguousRange(before, after, `push ${short(before)}..${short(after)}`);
      const base = mergeBase(before, after);
      if (base)
        return contiguousRange(base, after, `force-push, from the merge base ${short(base)}`);
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

  const fromBound = from || env.COMMIT_RANGE_FROM || null;
  const toBound = to || env.COMMIT_RANGE_TO || null;
  if (fromBound || toBound) {
    if (!fromBound) {
      throw new CommitRangeError(
        '--to needs a --from; there is no default base for an explicit range',
        'usage',
      );
    }
    return contiguousRange(
      fromBound,
      toBound ?? 'HEAD',
      `explicit range ${fromBound}..${toBound ?? 'HEAD'}`,
    );
  }

  const eventName = env.GITHUB_EVENT_NAME;
  if (!eventName) {
    const upstream = git.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    if (upstream.status !== 0) {
      throw new CommitRangeError(
        'no commit range: this branch has no upstream, so there is nothing to compare against. ' +
          'Pass --from <rev> (see CONTRIBUTING "Commits").',
        'no_upstream',
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
      if (!base || !head)
        throw new CommitRangeError('pull_request payload carries no base/head sha');
      return contiguousRange(
        base,
        head,
        `pull request #${event.number} ${short(base)}..${short(head)}`,
      );
    }
    case 'merge_group': {
      const base = event.merge_group?.base_sha;
      const head = event.merge_group?.head_sha;
      if (!base || !head)
        throw new CommitRangeError('merge_group payload carries no base/head sha');
      return contiguousRange(base, head, `merge group ${short(base)}..${short(head)}`);
    }
    default:
      throw new CommitRangeError(
        `event ${eventName} carries no commit range; the commit gates run on push, ` +
          'pull_request and merge_group only',
      );
  }
}
