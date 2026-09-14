/**
 * Which workspace volumes the retention sweep removes (technical/05 §5: 3 days by default, 14 for
 * a paused or taken-over task).
 *
 * A pure function over what the daemon reports, so the policy can be driven past every boundary
 * without a container and without waiting three days. `now` is a parameter: retention is a policy,
 * not a wall-clock reading (standing rule 2).
 *
 * ## The window can be *extended*, and that is a second object rather than a new label
 *
 * technical/05 §5's *"14 days for paused/taken-over"* is {@link RetentionHold} (WP-27): a Docker
 * volume's labels are immutable, so `WorkspaceProvider.extendRetention` writes a second labelled
 * volume and this module takes the later of the two instants.
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

/**
 * A **hold**: a second labelled volume that extends one workspace's window (WP-27).
 *
 * It exists because a Docker volume's labels cannot be changed, which is measured at
 * `retentionHoldVolumeName` rather than assumed here. To this module a hold is just a second
 * `keep_until` for the same run, and the rule is the one a reader would guess: the **later**
 * instant wins, because every producer of one is saying "keep this for longer".
 */
export interface RetentionHold {
  readonly runId: string;
  readonly volumeName: string;
  readonly keepUntil: string;
}

export interface RetentionDecision extends PurgedWorkspace {
  readonly action: 'remove' | 'keep';
  /** The hold volume to remove with this workspace, or `null` when there is none. */
  readonly holdVolume: string | null;
}

const parseInstant = (value: string | undefined): number | null => {
  if (value === undefined || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Decides one volume's fate. Exported for the tests that walk the boundary from both sides.
 *
 * `hold` is this run's retention hold, when it has one. The reported `keepUntil` is the
 * **effective** instant rather than the workspace's own label, so a report never shows the three
 * days a taken-over workspace was created with while it is being kept for fourteen: the report is
 * what an operator with a full disk reads, and the number they need is the one the sweep used.
 *
 * A hold whose instant this module cannot parse is **ignored** rather than treated as "unlabelled":
 * the workspace's own window still stands, which keeps the data for at least as long as it would
 * have had without the hold. The ambiguous direction stays the safe one, as everywhere else here.
 */
export const retentionDecision = (
  candidate: RetentionCandidate,
  now: Date,
  hold?: RetentionHold,
): RetentionDecision => {
  const runId = candidate.labels[WORKSPACE_LABELS.run] ?? '';
  const own = parseInstant(candidate.labels[WORKSPACE_LABELS.keepUntil] ?? '');
  const held = hold === undefined ? null : parseInstant(hold.keepUntil);
  const keepUntil = own === null ? null : held !== null && held > own ? held : own;
  const keepUntilRaw =
    keepUntil === null
      ? (candidate.labels[WORKSPACE_LABELS.keepUntil] ?? '')
      : new Date(keepUntil).toISOString();
  const holdVolume = hold?.volumeName ?? null;
  const base = {
    runId,
    volumeName: candidate.volumeName,
    keepUntil: keepUntilRaw,
    holdVolume,
  } as const;

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
  holds: readonly RetentionHold[] = [],
): readonly RetentionDecision[] => {
  const byRun = new Map(holds.map((hold) => [hold.runId, hold]));
  return candidates.map((candidate) => {
    const hold = byRun.get(candidate.labels[WORKSPACE_LABELS.run] ?? '');
    return retentionDecision(candidate, now, hold);
  });
};

/**
 * Holds whose workspace this sweep is not going to keep — the ones that may be removed too.
 *
 * Two situations, and both are "there is nothing left to hold": the workspace volume is being
 * removed in this pass, or it is not in the daemon's list at all (removed by an earlier sweep, or
 * by hand). Without this a hold would outlive its workspace for ever, which is a leak of the exact
 * kind standing rule 60 is about — an object nothing reaps because nothing looks for it.
 */
export const expiredHolds = (
  holds: readonly RetentionHold[],
  decisions: readonly RetentionDecision[],
): readonly RetentionHold[] => {
  const kept = new Set(
    decisions.filter((decision) => decision.action === 'keep').map((decision) => decision.runId),
  );
  return holds.filter((hold) => !kept.has(hold.runId));
};
