/**
 * The fleet, live (TD-033 decision 8 (b)/(c)): the reads `fleetOf` is built from, kept current.
 *
 * - **The `org` topic** refreshes the agents, workers and inbox reads: the query bridge invalidates
 *   them for any event naming a run, a worker, a question or an approval (S-23.14).
 * - **A 15 s tick** re-renders the page so *elapsed* and *stuck* (silent past `STUCK_AFTER_MS`) move
 *   with the clock between events — the clock is read through `services.now`, never directly.
 * - **The `run:<id>` topics of at most {@link FLEET_LIVE_RUN_LIMIT} runs** — the first in attention
 *   order — so their "Now: …" follows the transcript between two agents reads; each topic is
 *   released when the run leaves the screen or the page unmounts (`useTopics`).
 * - **A run that leaves the agents list** while the page watches is read once (`GET /api/runs/:id`)
 *   and kept at its desk for {@link ENDING_SHOWN_MS}, cheering or slumped by how it ended — then
 *   the desk is free again. Nothing is shown before that read answers: a run that left the list is
 *   not assumed to have succeeded.
 * - **Each run's task** is read (`GET /api/tasks/:id`, the task page's own key, so opening it reads
 *   nothing twice) for its ticket key, title, state and stage rows, and its frozen pipeline (`GET
 *   /api/tasks/:id/pipeline`) for the whole `PhaseTrack`: the agents read carries none of them
 *   (BACKLOG 816's shape, here per run on screen).
 */
import type { RunRecord, SseTopic } from '@platform/contracts';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { queryKeys } from '../../api/keys.js';
import {
  useAgents,
  useInbox,
  useProjects,
  useTaskPipelines,
  useTasks,
  useWorkers,
} from '../../app/queries.js';
import { useServices } from '../../app/services.js';
import { useTopics } from '../../realtime/provider.js';
import { activityFromBlocks, type LatestEntry } from '../../ui/activity.js';
import {
  type AgentItem,
  type Fleet,
  type FleetEnding,
  type FleetTaskFacts,
  fleetOf,
} from './model.js';

/** How many runs' transcripts the page follows live at once. */
export const FLEET_LIVE_RUN_LIMIT = 12;

/** How often the page re-reads the clock between events. */
export const FLEET_TICK_MS = 15_000;

/** How long a run that ended stays at its desk. */
export const ENDING_SHOWN_MS = 20_000;

/** Re-renders every `ms`; returns nothing — the caller reads `services.now`. */
const useTick = (ms: number): void => {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((tick) => tick + 1);
    }, ms);
    return () => {
      clearInterval(timer);
    };
  }, [ms]);
};

interface Departure {
  readonly entry: AgentItem;
  readonly at: number;
}

/** Runs that left the agents list while the page watched, each read once for how it ended. */
const useEndings = (items: readonly AgentItem[] | undefined, nowMs: number): FleetEnding[] => {
  const { endpoints, now } = useServices();
  const seen = useRef<ReadonlyMap<string, AgentItem> | null>(null);
  const [departed, setDeparted] = useState<readonly Departure[]>([]);
  useEffect(() => {
    if (items === undefined) {
      return;
    }
    const current = new Map(items.map((item) => [item.run.id, item]));
    const previous = seen.current;
    seen.current = current;
    if (previous === null) {
      return;
    }
    const gone = [...previous.values()].filter((item) => !current.has(item.run.id));
    if (gone.length === 0) {
      return;
    }
    const at = now();
    setDeparted((list) => [
      ...list.filter((departure) => !current.has(departure.entry.run.id)),
      ...gone.map((entry) => ({ entry, at })),
    ]);
  }, [items, now]);
  const shown = departed.filter((departure) => nowMs - departure.at < ENDING_SHOWN_MS);
  const reads = useQueries({
    queries: shown.map((departure) => ({
      queryKey: queryKeys.run(departure.entry.run.id),
      queryFn: () => endpoints.run(departure.entry.run.id),
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  return shown.flatMap((departure, index) => {
    const run: RunRecord | undefined = reads[index]?.data;
    return run === undefined ? [] : [{ entry: departure.entry, run }];
  });
};

/** The live transcript's newest entry for each run, re-rendering when any of them moves. */
const useLatestEntries = (runIds: readonly string[]): ReadonlyMap<string, LatestEntry> => {
  const { transcripts } = useServices();
  const [version, setVersion] = useState(0);
  const key = runIds.join(',');
  useEffect(() => {
    if (key === '') {
      return;
    }
    const release = key.split(',').map((runId) =>
      transcripts.subscribe(runId, () => {
        setVersion((value) => value + 1);
      }),
    );
    return () => {
      for (const done of release) {
        done();
      }
    };
  }, [key, transcripts]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the store's change signal.
  return useMemo(() => {
    const latest = new Map<string, LatestEntry>();
    for (const runId of key === '' ? [] : key.split(',')) {
      const entry = activityFromBlocks(transcripts.snapshot(runId).blocks);
      if (entry !== null) {
        latest.set(runId, entry);
      }
    }
    return latest;
  }, [key, transcripts, version]);
};

export interface FleetState {
  readonly fleet: Fleet;
  readonly now: number;
  readonly agents: ReturnType<typeof useAgents>;
  readonly workers: ReturnType<typeof useWorkers>;
  readonly inbox: ReturnType<typeof useInbox>;
  /** The runs whose `run:<id>` the page follows (attention order, at most the limit). */
  readonly followed: readonly string[];
}

export const useFleet = (): FleetState => {
  useTick(FLEET_TICK_MS);
  const { now } = useServices();
  const nowMs = now();
  const agents = useAgents();
  const workers = useWorkers();
  const inbox = useInbox();
  const projects = useProjects();
  const items = agents.data?.items;
  const endings = useEndings(items, nowMs);

  const taskIds = [
    ...new Set([
      ...(items ?? []).map((item) => item.task_id),
      ...endings.map((ending) => ending.entry.task_id),
      ...(inbox.data?.questions ?? []).map((question) => question.task_id),
      ...(inbox.data?.approvals ?? []).map((approval) => approval.task_id),
    ]),
  ];
  const taskReads = useTasks(taskIds);
  // The frozen pipelines only of tasks with a run on screen: an inbox item draws no strip.
  const runTaskIds = [
    ...new Set([
      ...(items ?? []).map((item) => item.task_id),
      ...endings.map((ending) => ending.entry.task_id),
    ]),
  ];
  const pipelineReads = useTaskPipelines(runTaskIds);
  const tasks = new Map<string, FleetTaskFacts>();
  taskIds.forEach((taskId, index) => {
    const detail = taskReads[index]?.data;
    const pipeline = pipelineReads[runTaskIds.indexOf(taskId)]?.data;
    if (detail !== undefined) {
      tasks.set(taskId, {
        projectId: detail.task.project_id,
        ticketKey: detail.task.ticket.key,
        title: detail.task.ticket_title,
        state: detail.task.state,
        currentStage: detail.task.current_stage ?? null,
        stages: detail.stages,
        templateStages: pipeline?.nodes ?? null,
      });
    }
  });
  const projectKeys = new Map(
    (projects.data?.items ?? []).map((project) => [project.id, project.key]),
  );

  // Which runs to follow is decided from the reads alone, so following one cannot reorder the set.
  const base = fleetOf({
    agents: items ?? [],
    workers: workers.data?.items ?? null,
    inbox: inbox.data ?? null,
    now: nowMs,
    tasks,
    projectKeys,
  });
  const followed = base.runs.slice(0, FLEET_LIVE_RUN_LIMIT).map((run) => run.id);
  useTopics(['org', ...followed.map((runId): SseTopic => `run:${runId}`)]);
  const latest = useLatestEntries(followed);

  const fleet = fleetOf({
    agents: items ?? [],
    workers: workers.data?.items ?? null,
    inbox: inbox.data ?? null,
    now: nowMs,
    tasks,
    projectKeys,
    latest,
    endings,
  });
  return { fleet, now: nowMs, agents, workers, inbox, followed };
};
