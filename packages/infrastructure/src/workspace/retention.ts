/**
 * Which workspace volumes the retention sweep removes (technical/05 §5: 3 days by default, 14 for
 * a paused or taken-over task).
 *
 * A pure function over what the daemon reports, so the policy can be driven past every boundary
 * without a container and without waiting three days. `now` is a parameter: retention is a policy,
 * not a wall-clock reading (standing rule 2).
 *
 * ## Every ambiguous case keeps the data
 *
 * A volume with no `keep_until` label, or one this module cannot parse, is **kept**. Deleting a
 * workspace early destroys the only copy of an interrupted run's work; keeping one costs disk and
 * shows up on the storage gauge (Q13-b). The two failure directions are not symmetric, and the
 * `keptReason` says which rule kept it so an operator with a full disk can see the difference
 * between "not due yet" and "I could not tell".
 *
 * ## `in_use` is not an optimisation
 *
 * The daemon refuses to remove a volume a container still references, so a sweep that tried anyway
 * would merely get a 409. It is checked here because the *reason* is worth reporting: a volume
 * whose `keep_until` passed while its run is still going means a run outlived its own retention
 * window, which is a scheduling fault rather than a storage one.
 */
import { type PurgedWorkspace, WORKSPACE_LABELS } from '@platform/application';

export interface RetentionCandidate {
  readonly volumeName: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Whether a container (running or not) still references this volume. */
  readonly inUse: boolean;
}

export interface RetentionDecision extends PurgedWorkspace {
  readonly action: 'remove' | 'keep';
}

const parseInstant = (value: string | undefined): number | null => {
  if (value === undefined || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Decides one volume's fate. Exported for the tests that walk the boundary from both sides. */
export const retentionDecision = (candidate: RetentionCandidate, now: Date): RetentionDecision => {
  const runId = candidate.labels[WORKSPACE_LABELS.run] ?? '';
  const keepUntilRaw = candidate.labels[WORKSPACE_LABELS.keepUntil] ?? '';
  const keepUntil = parseInstant(keepUntilRaw);
  const base = { runId, volumeName: candidate.volumeName, keepUntil: keepUntilRaw } as const;

  if (runId.length === 0 || keepUntil === null) {
    return { ...base, action: 'keep', removed: false, keptReason: 'unlabelled' };
  }
  if (candidate.inUse) {
    return { ...base, action: 'keep', removed: false, keptReason: 'in_use' };
  }
  // `>` and not `>=`: a volume whose `keep_until` is exactly now has reached the end of its window.
  // The boundary is asserted from both sides in `retention.test.ts` (standing rule 42).
  if (keepUntil > now.getTime()) {
    return { ...base, action: 'keep', removed: false, keptReason: 'not_expired' };
  }
  return { ...base, action: 'remove', removed: false, keptReason: null };
};

export const retentionDecisions = (
  candidates: readonly RetentionCandidate[],
  now: Date,
): readonly RetentionDecision[] => candidates.map((candidate) => retentionDecision(candidate, now));
