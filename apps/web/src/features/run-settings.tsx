/**
 * The configuration a run was planned with, on the run screen (WP-112, PROGRESS backlog 309).
 *
 * Two pieces, and they answer two questions. **The line under the header** answers *"was this run
 * planned with the same settings as the one before it?"* from `RunRecord.settings_hash` alone — the
 * hash is on the record (`run.read`), so a viewer sees whether the settings moved between two
 * stages without seeing what they say. **The Settings tab** answers *"what were they?"* from
 * `GET /api/runs/:id/settings`, which is `transcript.read` because the document carries text an
 * operator typed; it is fetched only when the tab is opened.
 *
 * Nothing here is inferred. `null` on the record is *"created before WP-91 recorded it"* and is
 * said in those words, never as "no settings"; a previous run with no hash makes the comparison
 * unanswerable rather than "changed"; and a run the task's list does not contain is compared with
 * nothing.
 */
import type { RunRecord, RunSettingsResponse } from '@platform/contracts';
import type { ReactElement } from 'react';
import { ApiError } from '../api/http.js';
import { Badge, ErrorNotice, Loading, SectionHeading } from '../ui/kit.js';
import { CodeText } from '../ui/untrusted.js';

type Comparable = Pick<RunRecord, 'id' | 'stage' | 'attempt' | 'settings_hash'>;

/** How this run's settings compare with the task's previous run — see the module note. */
export type SettingsChange =
  | { readonly kind: 'not_recorded' }
  | { readonly kind: 'not_in_task' }
  | { readonly kind: 'first' }
  | { readonly kind: 'previous_not_recorded'; readonly previous: Comparable }
  | { readonly kind: 'same'; readonly previous: Comparable }
  | { readonly kind: 'changed'; readonly previous: Comparable };

/**
 * Compares `run` with the run immediately before it in `runs` — the task's runs in the order the
 * task read publishes them, which is creation order (`findTaskDetail`).
 */
export const settingsChangeOf = (run: Comparable, runs: readonly Comparable[]): SettingsChange => {
  if (run.settings_hash === null) {
    return { kind: 'not_recorded' };
  }
  const index = runs.findIndex((entry) => entry.id === run.id);
  if (index < 0) {
    return { kind: 'not_in_task' };
  }
  const previous = runs[index - 1];
  if (previous === undefined) {
    return { kind: 'first' };
  }
  if (previous.settings_hash === null) {
    return { kind: 'previous_not_recorded', previous };
  }
  return previous.settings_hash === run.settings_hash
    ? { kind: 'same', previous }
    : { kind: 'changed', previous };
};

// A run with no stage (an ask or a discovery run) is named as such, never `null (attempt n)`.
const runName = (run: Comparable): string =>
  `${run.stage ?? 'a run with no stage'} (attempt ${run.attempt})`;

/** The comparison in words; `null` when there is nothing to compare with. */
export const settingsChangeText = (change: SettingsChange): string | null => {
  switch (change.kind) {
    case 'not_recorded':
      return 'Not recorded: this run was created before the platform recorded the settings a run is planned with.';
    case 'not_in_task':
      return null;
    case 'first':
      return 'The first run of this task.';
    case 'previous_not_recorded':
      return `The previous run, ${runName(change.previous)}, predates the record, so whether the settings changed cannot be said.`;
    case 'same':
      return `Same settings as the previous run, ${runName(change.previous)}.`;
    default:
      return `Changed since the previous run, ${runName(change.previous)}.`;
  }
};

/** The first twelve hex characters, for the header; the full hash is in the Settings tab. */
export const shortHash = (hash: string): string => hash.slice(0, 12);

export const RunSettingsLine = ({
  run,
  runs,
}: {
  readonly run: Comparable;
  /** The task's runs, or `undefined` while the task is loading. */
  readonly runs: readonly Comparable[] | undefined;
}): ReactElement => {
  const change = runs === undefined ? null : settingsChangeOf(run, runs);
  const text = change === null ? null : settingsChangeText(change);
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted" data-run-settings="line">
      <span>Settings</span>
      {run.settings_hash === null ? null : (
        <span className="font-mono" title={run.settings_hash}>
          {shortHash(run.settings_hash)}
        </span>
      )}
      {change?.kind === 'changed' ? <Badge tone="warning">changed</Badge> : null}
      {text === null ? null : <span>{text}</span>}
    </p>
  );
};

const isNotRecorded = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'settings_not_recorded';

const isMarker = (snapshot: RunSettingsResponse['snapshot']): boolean =>
  snapshot.truncated === true;

export const RunSettingsPanel = ({
  query,
}: {
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error: unknown;
    readonly data: RunSettingsResponse | undefined;
  };
}): ReactElement => (
  <div className="flex flex-col gap-3">
    <SectionHeading>Settings snapshot</SectionHeading>
    {query.isError && isNotRecorded(query.error) ? (
      <p className="text-sm text-fg-muted">
        This run was created before the platform recorded the settings a run is planned with, so
        there is no snapshot to show. Today’s project settings are not shown in its place: they are
        not the ones this run was planned with.
      </p>
    ) : query.isError ? (
      <ErrorNotice title="The settings could not be loaded." detail={String(query.error)} />
    ) : query.isPending || query.data === undefined ? (
      <Loading label="Loading settings…" />
    ) : (
      <>
        <p className="font-mono text-xs text-fg-muted">sha256 {query.data.settings_hash}</p>
        {isMarker(query.data.snapshot) ? (
          <p className="text-sm text-fg-muted">
            The document was larger than the platform stores whole, so only its hash and size were
            kept.
          </p>
        ) : null}
        {/* Operator-typed text — checklist items, reviewer handles — is somebody else's words. */}
        <CodeText value={JSON.stringify(query.data.snapshot, null, 2)} />
        <p className="text-xs text-fg-muted">
          Redacted when it was recorded: a credential an operator pasted into the settings reads as
          a placeholder.
        </p>
      </>
    )}
  </div>
);
