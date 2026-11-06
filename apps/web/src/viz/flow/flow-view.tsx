/**
 * The flow canvas on a screen (TD-033 decision 8 (a)): `PipelineFlow` on the project's Pipeline tab
 * (a template, read-only) and `TaskFlow` at the top of a task's page (its progress, live).
 *
 * Both are `FlowView`: the canvas — loaded **lazily**, so `@xyflow/react` is a chunk of its own
 * that a screen without a canvas never fetches — or, below 768 px or when the reader picks
 * *List*, the same stages as an ordered list (`FlowList`). Beside the canvas the list is still
 * rendered for screen readers (`sr-only`). A card opens the `StageDialog`.
 *
 * **A screen may bring its own list mode** (`listMode`, S-25.4, product/10's Stages amendment): the task
 * page's is its **stage timeline** — the attempts newest first, each with its time, its cost and its
 * run — so the page draws the pipeline once, as the canvas or as the timeline, never both stacked.
 * The screen's list is handed an opener per stage id, so a timeline entry opens the same
 * `StageDialog` a card does; the screen-reader copy beside the canvas stays `FlowList`.
 *
 * `TaskFlow` is self-contained on purpose (S-23.9 moves the task page into tabs and takes it as a
 * piece): it reads the task, its frozen graph and the agents list itself — the first two are the
 * task page's own queries, so the page pays nothing twice — and retains the live run's `run:<id>`
 * topic while it is mounted, so the current card's "Now: …" moves with the transcript. Until the
 * transcript has delivered anything, the agents read's newest-entry kind stands in for it.
 */
import type { PipelineGraph, RunActivity } from '@platform/contracts';
import { ListUnorderedIcon } from '@primer/octicons-react/ListUnorderedIcon';
import { ScreenFullIcon } from '@primer/octicons-react/ScreenFullIcon';
import { ScreenNormalIcon } from '@primer/octicons-react/ScreenNormalIcon';
import { WorkflowIcon } from '@primer/octicons-react/WorkflowIcon';
import {
  lazy,
  type ReactElement,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from 'react';
import { useAgents, useProjectPipelines, useTask, useTaskPipeline } from '../../app/queries.js';
import { useServices } from '../../app/services.js';
import { liveStageRun } from '../../features/live-stage.js';
import { useTopics } from '../../realtime/provider.js';
import type { TranscriptSnapshot } from '../../transcript/store.js';
import { activityFromBlocks, type LatestEntry } from '../../ui/activity.js';
import { Button } from '../../ui/button.js';
import { cx } from '../../ui/cx.js';
import { titleCase } from '../../ui/humanize.js';
import { ErrorNotice, Loading } from '../../ui/kit.js';
import { Skeleton } from '../../ui/skeleton.js';
import { FlowList } from './flow-list.js';
import { type FlowGraph, taskFlow, templateFlow } from './model.js';
import { StageDialog } from './stage-dialog.js';

/** The canvas's own chunk (see the module note). */
const FlowCanvas = lazy(() => import('./flow-canvas.js'));

/** Below this width the list replaces the canvas. */
export const FLOW_CANVAS_MIN_WIDTH_PX = 768;

const WIDE_QUERY = `(min-width: ${FLOW_CANVAS_MIN_WIDTH_PX}px)`;

const subscribeWide = (onChange: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const list = window.matchMedia(WIDE_QUERY);
  list.addEventListener('change', onChange);
  return () => {
    list.removeEventListener('change', onChange);
  };
};

const readWide = (): boolean =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? true
    : window.matchMedia(WIDE_QUERY).matches;

/** Whether the viewport is wide enough for the canvas. */
export const useWideViewport = (): boolean =>
  useSyncExternalStore(subscribeWide, readWide, () => true);

type DialogExtras = Omit<Parameters<typeof StageDialog>[0], 'graph' | 'open' | 'node' | 'onClose'>;

/**
 * A screen's own list mode: given the opener of a stage's dialog — `null` for a stage id the graph
 * has no card for — it draws what *List* shows instead of {@link FlowList}.
 */
export type FlowListMode = (openerFor: (stageId: string) => (() => void) | null) => ReactNode;

export const FlowView = ({
  graph,
  label,
  toolbar,
  dialog,
  canvasClassName = 'h-[380px]',
  listMode,
}: {
  readonly graph: FlowGraph;
  /** What *List* (and a narrow screen) shows instead of the stage cards. */
  readonly listMode?: FlowListMode;
  /** The canvas's and the list's accessible name ("Feature pipeline"). */
  readonly label: string;
  /** What the screen puts before the view's own buttons (a template picker). */
  readonly toolbar?: ReactNode;
  readonly dialog?: DialogExtras;
  readonly canvasClassName?: string;
}): ReactElement => {
  const wide = useWideViewport();
  const [list, setList] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const onOpen = useCallback((id: string) => {
    setOpenId(id);
    setLastId(id);
  }, []);
  const showCanvas = wide && !list;
  const full = expanded && showCanvas;

  useEffect(() => {
    if (!full || openId !== null) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [full, openId]);

  return (
    <div
      data-flow-view={showCanvas ? 'canvas' : 'list'}
      className={cx(
        'flex min-w-0 flex-col gap-2',
        full ? 'fixed inset-0 z-30 bg-canvas p-4' : null,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        <div className="ml-auto flex items-center gap-2">
          {wide ? (
            <Button
              size="sm"
              aria-pressed={list}
              leadingIcon={<ListUnorderedIcon size={16} />}
              onClick={() => {
                setList((current) => !current);
              }}
            >
              List
            </Button>
          ) : null}
          {showCanvas ? (
            <Button
              size="sm"
              aria-pressed={full}
              leadingIcon={full ? <ScreenNormalIcon size={16} /> : <ScreenFullIcon size={16} />}
              onClick={() => {
                setExpanded((current) => !current);
              }}
            >
              {full ? 'Exit full screen' : 'Full screen'}
            </Button>
          ) : null}
        </div>
      </div>
      {showCanvas ? (
        <div
          data-testid="flow-canvas-frame"
          className={cx(
            'min-h-0 overflow-hidden rounded-lg border border-line',
            full ? 'flex-1' : canvasClassName,
          )}
        >
          <Suspense fallback={<Skeleton label="Drawing the pipeline…" className="h-full w-full" />}>
            <FlowCanvas graph={graph} onOpen={onOpen} label={label} />
          </Suspense>
        </div>
      ) : null}
      {listMode === undefined || showCanvas ? (
        <FlowList graph={graph} onOpen={onOpen} label={`${label} as a list`} hidden={showCanvas} />
      ) : (
        listMode((stageId) =>
          graph.nodes.some((node) => node.id === stageId)
            ? () => {
                onOpen(stageId);
              }
            : null,
        )
      )}
      <StageDialog
        graph={graph}
        open={openId !== null}
        node={graph.nodes.find((node) => node.id === lastId) ?? null}
        onClose={() => {
          setOpenId(null);
        }}
        {...dialog}
      />
    </div>
  );
};

const templateName = (template: string): string => `${titleCase(template)} pipeline`;

/** The Pipeline tab: the project's enabled templates, one at a time, as a read-only canvas. */
export const PipelineFlow = ({ projectId }: { readonly projectId: string | null }) => {
  const pipelines = useProjectPipelines(projectId);
  const [chosen, setChosen] = useState<string | null>(null);
  const pickerId = useId();
  if (projectId === null || pipelines.isPending) {
    return <Loading label="Loading the pipeline…" />;
  }
  if (pipelines.isError) {
    return <ErrorNotice title="The pipeline could not be drawn." error={pipelines.error} />;
  }
  const items = pipelines.data.items;
  const selected: PipelineGraph | undefined =
    items.find((item) => item.template === chosen) ?? items[0];
  if (selected === undefined) {
    return <p className="text-sm text-fg-muted">This project has no enabled template.</p>;
  }
  return (
    <FlowView
      graph={templateFlow(selected)}
      label={templateName(selected.template)}
      // Taller than a task's (S-23.13a): the tab is the canvas, and the return curves under the row
      // need the room at a legible zoom.
      canvasClassName="h-[600px]"
      toolbar={
        <label htmlFor={pickerId} className="flex items-center gap-2 text-sm">
          <span className="font-medium">Template</span>
          <select
            id={pickerId}
            value={selected.template}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
            className="rounded-md border border-line-input bg-inset px-2 py-1 text-sm"
          >
            {items.map((item) => (
              <option key={item.template} value={item.template}>
                {titleCase(item.template)}
              </option>
            ))}
          </select>
        </label>
      }
    />
  );
};

const EMPTY_SNAPSHOT: Pick<TranscriptSnapshot, 'blocks'> = { blocks: [] };

/** The agents read's newest-entry kind as the activity vocabulary's input. */
const latestOf = (activity: RunActivity | null | undefined): LatestEntry | null =>
  activity === null || activity === undefined
    ? null
    : { kind: activity.kind, tool_name: activity.tool_name, at: activity.at };

/**
 * The task page's Flow section: the task's frozen graph and its progress, live — and, as its list
 * mode, the screen's `listMode` (the stage timeline). A graph that could not be read still shows the
 * list under the refusal, with no stage to open, so the attempts and their runs stay reachable.
 */
export const TaskFlow = ({
  taskId,
  listMode,
}: {
  readonly taskId: string;
  readonly listMode?: FlowListMode;
}): ReactElement => {
  const detail = useTask(taskId);
  const pipeline = useTaskPipeline(taskId);
  const agents = useAgents();
  const { transcripts, now } = useServices();
  const liveRun = detail.data === undefined ? null : liveStageRun(detail.data.runs);
  const liveId = liveRun?.id ?? null;
  useTopics(liveId === null ? [] : [`run:${liveId}`]);
  const subscribe = useCallback(
    (listener: () => void) =>
      liveId === null ? () => undefined : transcripts.subscribe(liveId, listener),
    [liveId, transcripts],
  );
  const read = useCallback(
    () => (liveId === null ? EMPTY_SNAPSHOT : transcripts.snapshot(liveId)),
    [liveId, transcripts],
  );
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const agent = agents.data?.items.find((item) => item.run.id === liveId);
  const latest = activityFromBlocks(snapshot.blocks) ?? latestOf(agent?.activity);
  const current = now();

  // Re-derived on every render: a frame of the live run re-renders this section, and the clock it
  // reads (a run silent too long is "Stuck") moves with it.
  const graph =
    detail.data === undefined || pipeline.data === undefined
      ? null
      : taskFlow({ graph: pipeline.data, detail: detail.data, latest, now: current });

  const heading = (
    <h2 id={`flow-${taskId}`} className="flex items-center gap-2 text-base font-semibold">
      <span aria-hidden="true" className="inline-flex text-fg-muted">
        <WorkflowIcon size={16} />
      </span>
      Flow
    </h2>
  );
  return (
    <section
      aria-labelledby={`flow-${taskId}`}
      data-testid="task-flow"
      className="flex flex-col gap-2"
    >
      {graph === null ? heading : null}
      {pipeline.isError ? (
        <>
          <ErrorNotice title="The task’s pipeline could not be drawn." error={pipeline.error} />
          {listMode?.(() => null)}
        </>
      ) : graph === null ? (
        detail.isError ? null : (
          <Loading label="Loading the flow…" />
        )
      ) : (
        <FlowView
          graph={graph}
          label={templateName(graph.template)}
          toolbar={heading}
          dialog={{
            artifacts: detail.data?.artifacts ?? [],
            // `undefined` when the agents read has no row for the run: the note then names no seat.
            ...(agent === undefined ? {} : { seat: agent.seat }),
          }}
          {...(listMode === undefined ? {} : { listMode })}
        />
      )}
    </section>
  );
};
