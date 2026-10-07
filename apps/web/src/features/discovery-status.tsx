/**
 * Where the project's discovery is **now** — the wizard's step 2, on load and live (WP-155 ruling
 * (c), PROGRESS backlog 452).
 *
 * Until WP-155 the step showed the click's own answer (*"the Discovery agent is queued"*) and nothing
 * else, so a refresh during a running discovery showed a step that had never been pressed. The task
 * is read back instead:
 *
 * - **which task** — `GET /api/projects/:id/rediscovery`, the gate the settings page's re-evaluate
 *   button already reads (`useRediscoveryGate`): the `discovery_in_flight` blocker's `task_id` when
 *   one is live, else `last_discovery.task_id`. Nothing here searches the board for it;
 * - **its state** — the task itself (`useTask`), kept current by retaining its `task:<id>` topic:
 *   the realtime bridge invalidates the task, and — because every task event carries its
 *   `project_id` — the gate and the readiness read under the project's prefix as well;
 * - **what the state means** — queued (no run has started), running (with a link to the run's live
 *   transcript), needs a person (the escalation's reason and brief, from the gate's
 *   `last_discovery.escalation`), paused (why), done (the readiness level it recorded), or cancelled.
 *
 * The click's own answer stays where it was, as the immediate feedback: this panel is what the page
 * says after it.
 *
 * Everything the server wrote is rendered as text through `ui/untrusted.tsx` (BD-022): the brief
 * quotes runs and providers.
 */
import type { RunRecord, TaskState } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useProjectReadiness, useRediscoveryGate, useTask } from '../app/queries.js';
import { useTopics } from '../realtime/provider.js';
import { Badge, type BadgeTone, formatDateTime } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';
import { liveStageRun } from './live-stage.js';

/** The step's six answers — the task's state, read for what a person on the wizard needs. */
export type DiscoveryPhase = 'queued' | 'running' | 'needs_human' | 'paused' | 'done' | 'cancelled';

/**
 * The phase of a discovery task: `queued` until a stage run exists that has not ended, `running`
 * while one does. Every other open state (a returned or waiting task — discovery has one stage, so
 * they are transient) reads as running, because something is still to happen without a person.
 */
export const discoveryPhaseOf = (state: TaskState, runs: readonly RunRecord[]): DiscoveryPhase => {
  switch (state) {
    case 'needs_human':
    case 'paused':
    case 'cancelled':
      return state;
    case 'done':
    case 'merged':
    case 'retro':
    case 'ready_for_merge':
      return 'done';
    case 'queued':
      return 'queued';
    default:
      return liveStageRun(runs) === null ? 'queued' : 'running';
  }
};

const PHASE: Record<DiscoveryPhase, { readonly label: string; readonly tone: BadgeTone }> = {
  queued: { label: 'queued', tone: 'neutral' },
  running: { label: 'running', tone: 'accent' },
  needs_human: { label: 'needs a person', tone: 'warning' },
  paused: { label: 'paused', tone: 'warning' },
  done: { label: 'done', tone: 'success' },
  cancelled: { label: 'cancelled', tone: 'neutral' },
};

export const DiscoveryStatus = ({
  projectId,
  projectKey,
}: {
  readonly projectId: string;
  readonly projectKey: string;
}): ReactElement | null => {
  const gate = useRediscoveryGate(projectId);
  const blocker = gate.data?.blocker ?? null;
  const last = gate.data?.last_discovery ?? null;
  const taskId =
    (blocker?.code === 'discovery_in_flight' ? blocker.task_id : null) ?? last?.task_id ?? null;
  useTopics(taskId === null ? [] : [`task:${taskId}`]);
  const task = useTask(taskId ?? '', taskId !== null);
  const readiness = useProjectReadiness(projectId);

  if (gate.isError) {
    return (
      <p className="text-xs text-fg-muted" data-discovery-phase="unknown">
        Where the last discovery is could not be read: <UntrustedText value={String(gate.error)} />
      </p>
    );
  }
  if (taskId === null) {
    // Before the first discovery (or on a project with no discovery template): nothing to follow.
    return null;
  }
  // The task's own state once it is read; the gate's until then (same row, an instant earlier).
  const state = task.data?.task.state ?? (last?.task_id === taskId ? last.state : null);
  if (state === null) {
    return null;
  }
  const runs = task.data?.runs ?? [];
  const phase = discoveryPhaseOf(state, runs);
  const live = liveStageRun(runs);
  const escalation = last?.task_id === taskId ? last.escalation : null;
  return (
    <div
      className="flex flex-col gap-1 text-xs"
      data-testid="discovery-status"
      data-discovery-phase={phase}
      role="status"
      aria-live="polite"
    >
      <p className="flex flex-wrap items-center gap-2">
        <span>Discovery</span>
        <Badge tone={PHASE[phase].tone}>{PHASE[phase].label}</Badge>
        <Link
          to="/projects/$key/tasks/$taskId"
          params={{ key: projectKey, taskId }}
          className="text-accent underline"
        >
          Open its task
        </Link>
      </p>
      {phase === 'queued' ? <p className="text-fg-muted">Waiting for its run to start.</p> : null}
      {phase === 'running' && live !== null ? (
        <p>
          The Discovery agent is working.{' '}
          <Link to="/runs/$runId" params={{ runId: live.id }} className="text-accent underline">
            Watch its live transcript
          </Link>
        </p>
      ) : null}
      {phase === 'needs_human' ? (
        escalation === null || escalation === undefined ? (
          <p>
            It is waiting for a person.{' '}
            {blocker === null ? null : <UntrustedText value={blocker.detail} />}
          </p>
        ) : (
          <p>
            It is waiting for a person since {formatDateTime(escalation.at)}:{' '}
            <Badge tone="warning">{escalation.reason}</Badge>{' '}
            <UntrustedText value={escalation.brief} />
          </p>
        )
      ) : null}
      {phase === 'paused' ? (
        <p>
          It is paused
          {task.data?.task.paused_reason == null ? '' : ` (${task.data.task.paused_reason})`}. Its
          task page has the controls that resume it.
        </p>
      ) : null}
      {phase === 'done' ? (
        readiness.isSuccess ? (
          <p>Finished: the project is at readiness level {readiness.data.level}.</p>
        ) : readiness.isError ? (
          <p className="text-fg-muted">Finished, and no readiness evaluation is recorded.</p>
        ) : (
          <p className="text-fg-muted">Finished.</p>
        )
      ) : null}
      {phase === 'cancelled' ? (
        <p className="text-fg-muted">
          It was cancelled. <em>Re-evaluate readiness</em> on the project&rsquo;s settings page
          starts a new one.
        </p>
      ) : null}
    </div>
  );
};
