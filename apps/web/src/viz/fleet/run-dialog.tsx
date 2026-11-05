/**
 * The dialog a run opens from any of the Agents page's three views: the flow canvas's
 * `StageDialog` (S-23.5) — its live activity, its log, the watch-only note naming the seat, *Open
 * run* — for one run, plus *Open task*. The fleet has no graph of its own, so the run is given to
 * the dialog as a one-card graph: its stage, its run, its activity.
 */
import type { ReactElement } from 'react';
import { sanitiseUntrusted } from '../../ui/untrusted-text.js';
import type { FlowGraph, FlowNode } from '../flow/model.js';
import { StageDialog } from '../flow/stage-dialog.js';
import type { FleetRun } from './model.js';

/** The run as the stage card the dialog reads. */
export const fleetRunNode = (run: FleetRun): FlowNode => ({
  id: run.run.stage ?? `ask:${run.id}`,
  // Away from the task's page the stage alone does not say which task: "DEMO-1 · Implementation".
  label:
    run.ticketKey === null
      ? run.stageName
      : `${sanitiseUntrusted(run.ticketKey)} · ${run.stageName}`,
  kind: 'agent',
  role: run.role,
  enabled: true,
  advisory: false,
  model: run.run.model,
  effort: run.run.effort,
  produces: null,
  state: run.ended ? (run.activity.activity === 'done' ? 'done' : 'failed') : 'current',
  attempt: run.run.attempt,
  run: run.run,
  durationMs: null,
  activity: run.activity,
});

export const FleetRunDialog = ({
  run,
  open,
  onClose,
}: {
  /** The run shown — the last one opened, kept while the dialog closes. */
  readonly run: FleetRun | null;
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactElement | null => {
  if (run === null) {
    return null;
  }
  const node = fleetRunNode(run);
  const graph: FlowGraph = { mode: 'task', template: '', nodes: [node], edges: [] };
  return (
    <StageDialog
      graph={graph}
      open={open}
      node={node}
      onClose={onClose}
      seat={run.entry.seat}
      taskId={run.taskId}
    />
  );
};
