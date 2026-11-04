/**
 * **What a release may undo** — the one rule both stores apply (WP-281, TD-031 decision 6 and its
 * 2026-11-04 amendment §4), read off the offer and run rows the release locked.
 *
 * - A **repeat** — the offer is `open` again at the presented epoch, a release is recorded, and the
 *   token's epoch and last claimant are the caller's — answers `already_released` and writes nothing,
 *   so a worker that re-sends its release after a lost answer is told the same thing twice.
 * - The run must be **live under the caller's claim**: the offer `claimed`, the run's
 *   `lease_epoch`/`lease_owner` the caller's. Anything else — a newer claim, a terminal row, a lease
 *   the sweep or a cancel took — is `lease_lost`.
 * - The run must not have asked for its CLI: a written marker (or a run past `starting`) is
 *   `run_started` — a started run ends through `finish`, never a release.
 */
import type { IsoDateTime } from '@platform/contracts';
import { isActiveRunStatus } from '@platform/domain';

/** The locked rows' columns the decision reads. */
export interface ReleaseRowState {
  readonly offerState: string;
  readonly offerEpoch: number;
  /** `run_offers.run_token_epoch`: the epoch the last remote claim's token was minted for. */
  readonly tokenEpoch: number | null;
  /** A release is recorded on the offer (`released_at` set). */
  readonly released: boolean;
  /** `worker:<run_offers.worker_id>`, or `null` — the last remote claimant. */
  readonly offerOwner: string | null;
  readonly runStatus: string;
  readonly runEpoch: number;
  readonly leaseOwner: string | null;
  /** `runs.cli_spawn_requested_at` is written. */
  readonly marked: boolean;
}

export type ReleaseDecision = 'release' | 'already_released' | 'run_started' | 'lease_lost';

export const decideRelease = (
  row: ReleaseRowState,
  input: { readonly epoch: number; readonly owner: string; readonly now?: IsoDateTime },
): ReleaseDecision => {
  if (
    row.offerState === 'open' &&
    row.offerEpoch === input.epoch &&
    row.tokenEpoch === input.epoch &&
    row.released &&
    row.offerOwner === input.owner
  ) {
    return 'already_released';
  }
  const live = isActiveRunStatus(row.runStatus as Parameters<typeof isActiveRunStatus>[0]);
  if (
    row.offerState !== 'claimed' ||
    !live ||
    row.runEpoch !== input.epoch ||
    row.leaseOwner !== input.owner
  ) {
    return 'lease_lost';
  }
  if (row.marked || row.runStatus !== 'starting') {
    return 'run_started';
  }
  return 'release';
};
