/**
 * What a stage card opens (TD-033 decision 8 (a)): a Base UI `Dialog` with the stage's run — or,
 * on a template, the stage's configuration.
 *
 * **For a task's stage with a run:** the header says the stage, its state, the model, the cost and
 * how long the run has gone; a **"Live activity"** list (time · status dot · what the agent did,
 * `activity-rows.ts`) sits beside a **log** — a terminal-like tail of the same run, following its
 * end until the reader scrolls up, and following again from *Follow the end*. Both read the run's
 * transcript blocks: the page of history `useRunMessages` loads, and the `run:<id>` frames this
 * dialog subscribes to **while it is open**, which the realtime provider writes into the same store.
 * So the list and the log move while the agent works, and a frame replayed on reconnect changes
 * nothing (the store merges by `seq`). A watch-only note says where the agent runs; steering and
 * stopping are the run page's (*Open run*). *Open artifact* opens the newest artifact of the type
 * the stage writes, on the task page.
 *
 * **Who holds the topic, stated because no test can tell the two apart today.** On the task page
 * `TaskFlow` already retains the live run's `run:<id>` for as long as it is mounted, and a run that
 * has ended publishes nothing, so the dialog's own `useTopics` adds nothing there: the frames the
 * tests drive arrive through `TaskFlow`'s retain. It is kept so the dialog stays live wherever it is
 * opened without a `TaskFlow` beside it (the fleet map of S-23.6 reuses it); the provider counts
 * retains, so the second one costs no subscription.
 *
 * **For a template's stage** (no task, no run): the role, the model and effort, what it writes,
 * the loops it may spend and where each of its outcomes goes.
 *
 * Everything the run wrote — commands, paths, tool output, the model's text, a worker's name — is
 * untrusted (BD-022) and goes through `ui/untrusted.tsx` (`TerminalLines`, `UntrustedText`).
 */
import type { AgentsResponse, TaskDetailResponse } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRunMessages } from '../../app/queries.js';
import { useServices } from '../../app/services.js';
import { useTopics } from '../../realtime/provider.js';
import { ACTIVITY_META } from '../../ui/activity.js';
import { Button } from '../../ui/button.js';
import { Dialog } from '../../ui/dialog.js';
import {
  ARTIFACT_TYPE_LABEL,
  eventPhrase,
  LOOP_DEFINITION,
  loopLabel,
  ROLE_LABEL,
  stageLabel,
} from '../../ui/humanize.js';
import { formatElapsed, formatRunCost } from '../../ui/kit.js';
import { StateLabel, type Status } from '../../ui/status.js';
import { TerminalLines, UntrustedText } from '../../ui/untrusted.js';
import { ActivityList } from './activity-list.js';
import { activityRows, logLines } from './activity-rows.js';
import type { FlowGraph, FlowNode, FlowState } from './model.js';
import { cardBody, KIND_LOOK, modelChip, statusWord } from './stage-card.js';

type Seat = AgentsResponse['items'][number]['seat'];

const LIVE = ['created', 'starting', 'running'];

/** The state as a `StateLabel` status (the dialog's header pill). */
const STATE_STATUS: Readonly<Record<FlowState, Status>> = {
  done: 'success',
  current: 'running',
  upcoming: 'queued',
  returned: 'waiting',
  failed: 'failure',
  skipped: 'skipped',
  disabled: 'cancelled',
};

/** How an outcome of the stage reads in words. */
const OUTCOME_WORD: Readonly<Record<FlowGraph['edges'][number]['kind'], string>> = {
  next: 'Then',
  approve: 'Approved',
  return: 'Changes requested',
  pass: 'Passed',
  fail: 'Failed',
  on: 'When',
};

/** "mr.merged" → "mr merged": an event type in words, for "When mr merged → Done". */

/** One line per outgoing edge: "Approved → Code review", "Failed → Implementation (CI fixes ≤3)". */
export const outcomesOf = (graph: FlowGraph, id: string): readonly string[] =>
  graph.edges
    .filter((edge) => edge.from === id)
    .map((edge) => {
      const when =
        edge.kind === 'on' && edge.onEvent !== null
          ? `When ${eventPhrase(edge.onEvent)}`
          : OUTCOME_WORD[edge.kind];
      return `${when} → ${stageLabel(edge.to)}${edge.pill === null ? '' : ` (${edge.pill})`}`;
    });

/** Where the agent runs, in words; `null` for a seat the read does not name. */
const SeatNote = ({ live, seat }: { readonly live: boolean; readonly seat: Seat | undefined }) => (
  <p data-watch-only="" className="text-xs text-fg-muted">
    {!live ? (
      'Watch-only — this run has ended.'
    ) : seat === undefined ? (
      'Watch-only.'
    ) : seat === null ? (
      'Watch-only — the agent has no seat yet; it starts when the server or a worker picks it up.'
    ) : seat.kind === 'server' ? (
      'Watch-only — the agent runs on the platform’s server.'
    ) : (
      <>
        {'Watch-only — the agent runs on '}
        {seat.worker_name === null ? (
          'a worker'
        ) : (
          <UntrustedText value={seat.worker_name} className="font-medium text-fg" />
        )}
        .
      </>
    )}{' '}
    Message or stop it from the run page.
  </p>
);

/**
 * Follows the end of a scroller until the reader scrolls up; `follow()` resumes. Keyed on the
 * **newest line's key**, not on the count: past `LOG_LINE_LIMIT` the count stops changing while
 * lines still arrive, and a count-keyed follow would stop following exactly when a run is busiest.
 */
const useFollowTail = (newest: string | null) => {
  const ref = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    if (!following || newest === null) {
      return;
    }
    const element = ref.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [newest, following]);
  const onScroll = (): void => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
  };
  return { ref, following, onScroll, follow: () => setFollowing(true) };
};

/** The run's live activity and log, while the dialog is open. */
const RunPanels = ({ runId, live }: { readonly runId: string; readonly live: boolean }) => {
  useTopics([`run:${runId}`]);
  const { transcripts } = useServices();
  const messages = useRunMessages(runId);
  const snapshot = useSyncExternalStore(
    (listener) => transcripts.subscribe(runId, listener),
    () => transcripts.snapshot(runId),
    () => transcripts.snapshot(runId),
  );
  const rows = activityRows(snapshot.blocks, { live });
  const lines = logLines(snapshot.blocks);
  const tail = useFollowTail(lines.at(-1)?.key ?? null);
  return (
    <div className="grid min-h-0 gap-4 md:grid-cols-[15rem_1fr]">
      <section aria-labelledby={`activity-${runId}`} className="flex min-h-0 flex-col gap-2">
        <h3 id={`activity-${runId}`} className="text-sm font-semibold">
          Live activity
        </h3>
        <div className="max-h-[22rem] overflow-y-auto">
          <ActivityList rows={rows} />
        </div>
      </section>
      <section aria-labelledby={`log-${runId}`} className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 id={`log-${runId}`} className="text-sm font-semibold">
            Log
          </h3>
          {tail.following ? (
            <span className="text-xs text-fg-muted">following the end</span>
          ) : (
            <Button size="sm" onClick={tail.follow}>
              Follow the end
            </Button>
          )}
        </div>
        {messages.isError ? (
          <p className="text-xs text-fg-muted">
            What the run wrote before this dialog opened could not be loaded; new lines still arrive
            live.
          </p>
        ) : null}
        <div
          ref={tail.ref}
          onScroll={tail.onScroll}
          data-testid="stage-log"
          className="h-[22rem] overflow-y-auto rounded-md bg-[oklch(0.18_0.01_260)] p-3"
        >
          {lines.length === 0 ? (
            <p className="font-mono text-xs text-[oklch(0.72_0.03_280)]">
              {messages.isPending ? 'Loading the log…' : 'No output yet.'}
            </p>
          ) : (
            <TerminalLines lines={lines} />
          )}
        </div>
      </section>
    </div>
  );
};

/** The configuration a stage runs with: the template's dialog, and a task stage with no run. */
const StageConfiguration = ({
  graph,
  node,
}: {
  readonly graph: FlowGraph;
  readonly node: FlowNode;
}): ReactElement => {
  const outcomes = outcomesOf(graph, node.id);
  const loops = graph.edges.filter((edge) => edge.from === node.id && edge.loop !== null);
  const rows: [string, string][] = [
    [
      'Kind',
      `${KIND_LOOK[node.kind].word}${node.advisory ? ' (for information only: it never sends the task back)' : ''}`,
    ],
    ...(node.role === null ? [] : [['Role', ROLE_LABEL[node.role]] as [string, string]]),
    ...(node.kind === 'agent'
      ? [
          ['Model', modelChip(node) ?? 'not stated — the project’s settings could not be read'] as [
            string,
            string,
          ],
        ]
      : []),
    ...(node.kind === 'agent'
      ? [
          [
            'Writes',
            node.produces === null ? 'no artifact' : ARTIFACT_TYPE_LABEL[node.produces],
          ] as [string, string],
        ]
      : []),
    [
      'Runs',
      node.enabled
        ? 'on every task of this template'
        : 'never — the pipeline walks over this stage',
    ],
    ...loops.map((edge): [string, string] => [
      loopLabel(edge.loop ?? ''),
      edge.loopLimit === null
        ? `back to ${stageLabel(edge.to)}`
        : `back to ${stageLabel(edge.to)}, at most ${edge.loopLimit} time${edge.loopLimit === 1 ? '' : 's'}${edge.loopUsed === null ? '' : ` (used ${edge.loopUsed})`}`,
    ]),
  ];
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-fg-muted">{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {loops.length === 0 ? null : <p className="text-xs text-fg-muted">{LOOP_DEFINITION}</p>}
      {outcomes.length === 0 ? null : (
        <div>
          <h3 className="text-sm font-semibold">Where it goes next</h3>
          <ul className="mt-1 flex flex-col gap-0.5 text-sm">
            {outcomes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

/** The newest of the task's artifacts of the type the stage writes. */
const artifactFor = (
  node: FlowNode,
  artifacts: TaskDetailResponse['artifacts'] | undefined,
): TaskDetailResponse['artifacts'][number] | null =>
  node.produces === null || artifacts === undefined
    ? null
    : artifacts
        .filter((artifact) => artifact.artifact_type === node.produces)
        .reduce<TaskDetailResponse['artifacts'][number] | null>(
          (latest, artifact) =>
            latest === null || artifact.version > latest.version ? artifact : latest,
          null,
        );

export const StageDialog = ({
  graph,
  open,
  node,
  onClose,
  artifacts,
  seat,
  taskId,
}: {
  readonly graph: FlowGraph;
  readonly open: boolean;
  /**
   * The stage shown — the last one opened, kept while the dialog closes so its content does not
   * vanish under the closing transition; `null` before any was opened.
   */
  readonly node: FlowNode | null;
  readonly onClose: () => void;
  /** Task mode: the task's artifacts, for *Open artifact*. */
  readonly artifacts?: TaskDetailResponse['artifacts'];
  /** Task mode: the live run's seat off the agents read. */
  readonly seat?: Seat;
  /**
   * The run's task, for an *Open task* link — where the dialog is opened away from the task's page
   * (the Agents page's fleet, S-23.6). Absent on the task page itself.
   */
  readonly taskId?: string;
}): ReactElement | null => {
  const { now } = useServices();
  if (node === null) {
    return null;
  }
  const run = node.run;
  const live = run !== null && LIVE.includes(run.status);
  const artifact = artifactFor(node, artifacts);
  const word = statusWord(node);
  const header = (
    <span className="flex flex-wrap items-center gap-2">
      {node.state === null || word === null ? null : (
        <StateLabel
          status={
            node.state === 'current' && node.activity !== null
              ? ACTIVITY_META[node.activity.activity].icon
              : STATE_STATUS[node.state]
          }
          size="sm"
        >
          {word}
        </StateLabel>
      )}
      <span>{cardBody(node)}</span>
      {run === null ? null : (
        <>
          <span className="font-mono text-xs">{`${run.model} · ${run.effort}`}</span>
          <span>{formatRunCost(run.cost, { estimate: true })}</span>
          <span>
            {run.started_at === null || run.started_at === undefined
              ? 'not started yet'
              : live
                ? `for ${formatElapsed(run.started_at, now())}`
                : `took ${formatElapsed(run.started_at, Date.parse(run.ended_at ?? run.started_at))}`}
          </span>
        </>
      )}
      {node.activity?.detail === null || node.activity?.detail === undefined ? null : (
        <span className="text-running">{`Now: ${node.activity.detail}`}</span>
      )}
    </span>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      size={run === null ? 'md' : 'lg'}
      title={node.label}
      description={header}
      footer={
        graph.mode === 'task' ? (
          <>
            {artifact === null ? null : (
              <Link
                to="."
                search={(previous: Record<string, unknown>) => ({
                  ...previous,
                  artifact: artifact.id,
                })}
                onClick={onClose}
                className="text-sm text-accent underline"
              >
                {`Open artifact (${ARTIFACT_TYPE_LABEL[artifact.artifact_type]} v${artifact.version})`}
              </Link>
            )}
            {taskId === undefined ? null : (
              <Link
                to="/tasks/$taskId"
                params={{ taskId }}
                className="text-sm text-accent underline"
              >
                Open task
              </Link>
            )}
            {run === null ? null : (
              <Link
                to="/runs/$runId"
                params={{ runId: run.id }}
                className="text-sm text-accent underline"
              >
                Open run
              </Link>
            )}
          </>
        ) : undefined
      }
    >
      {run === null ? (
        <div className="flex flex-col gap-3">
          {graph.mode === 'task' ? (
            <p className="text-sm text-fg-muted">
              {node.kind === 'agent'
                ? 'No agent has run this stage on this task yet.'
                : 'No agent runs this stage: it is settled by the platform or by a person.'}
            </p>
          ) : null}
          <StageConfiguration graph={graph} node={node} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <SeatNote live={live} seat={seat} />
          <RunPanels runId={run.id} live={live} />
        </div>
      )}
    </Dialog>
  );
};
