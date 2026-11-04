/** Types for `commit-range.mjs`, which stays plain JavaScript because `commits.mjs` runs it. */

import type { SpawnSyncReturns } from 'node:child_process';
import type { Environment } from './git-scratch-env.mjs';

export declare class CommitRangeError extends Error {
  constructor(message: string, code?: CommitRangeErrorCode);
  readonly code: CommitRangeErrorCode;
}

/** Why a range could not be determined; `no_upstream` is the local run with nothing to compare. */
export type CommitRangeErrorCode = 'unresolved' | 'usage' | 'missing_commit' | 'no_upstream';

export interface GitRunner {
  run(args: readonly string[]): SpawnSyncReturns<string>;
  out(args: readonly string[]): string;
}

export declare function gitRunner(cwd: string, env?: Environment): GitRunner;

export declare function isShallowCheckout(git: GitRunner): boolean;

export interface CommitRange {
  readonly label: string;
  /** What `git log` takes; `[]` when there is nothing to check (a branch deletion). */
  readonly revList: readonly string[];
  /** `{ from, to }` for a plain `from..to` range, `null` for a first push or an unrelated history. */
  readonly contiguous: { readonly from: string; readonly to: string } | null;
}

export declare function resolveCommitRange(
  git: GitRunner,
  options?: {
    readonly from?: string | null;
    readonly to?: string | null;
    readonly env?: Environment;
  },
): CommitRange;
