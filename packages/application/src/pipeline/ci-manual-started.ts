/**
 * **One attempt's `ci_manual_started`, with one more entry** (S-28.7, TD-036's 2026-11-10 amendment
 * decision 6) — the pure half both stores apply, so the bound is one rule.
 *
 * One entry per job id: a later entry for the same id replaces it. The column holds at most
 * `MAX_CI_MANUAL_STARTED_JOBS`; at the bound the **oldest `started`** entries are dropped first — a
 * played job is no longer `manual`, so it is not offered again, and a replay of its play is the
 * executor's (`ci_play:<task>:<pipeline>:<job>` answers its first result). A `refused` or
 * `unsupported` entry is what keeps a job from being offered on every poll and what the wait's
 * words are built from, so it is kept; with no `started` entry left to drop the answer is `null` —
 * the write is skipped (never a throw after a play that already happened).
 */
import {
  type CiManualStarted,
  type CiManualStartedJob,
  MAX_CI_MANUAL_STARTED_JOBS,
} from '@platform/contracts';

export const withCiManualStartedEntry = (
  stored: CiManualStarted | null,
  job: CiManualStartedJob,
): CiManualStarted | null => {
  const next = [...(stored ?? []).filter((entry) => entry.job_id !== job.job_id), job];
  while (next.length > MAX_CI_MANUAL_STARTED_JOBS) {
    const oldest = next.findIndex((entry) => entry.outcome === 'started' && entry !== job);
    if (oldest < 0) return null;
    next.splice(oldest, 1);
  }
  return next as CiManualStarted;
};
