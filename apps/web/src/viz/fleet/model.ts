/**
 * The fleet (TD-033 decisions 8 (b) and (c)): what every seat — the platform server's own claimant
 * and each worker machine — is doing now, which runs wait for a seat, and what waits for a person.
 * Pure: no React, no clock, no I/O. The Agents page's three views (the map, the office, the list)
 * read one `Fleet`, so the same run is never "working" in one view and "waiting" in another.
 *
 * ## What it is built from
 *
 * - `GET /api/org/agents` — every run that has not ended, each with its **seat** (`null`: not claimed
 *   yet, so it is in the **queue**) and its newest transcript entry's kind;
 * - `GET /api/workers` — the machines the caller may see (their own, or every one for an
 *   administrator), with their concurrency, pause and the runs each holds;
 * - `GET /api/org/inbox` — the open questions and pending approvals (**needs you**);
 * - optionally, per run, the live transcript's newest entry (`latest`, newer than the DTO's), each
 *   task's ticket key, title, state and stage rows (`tasks`), the projects' keys, and the runs that
 *   ended while the page watched (`endings`), so a desk can cheer or slump for a moment.
 *
 * ## What it refuses to invent
 *
 * - **The platform server's capacity.** No read reports how many runs the server's claimant takes,
 *   so its seat has `concurrency: null` and `free: null` — never a guessed number — and the free
 *   seats count is the workers' alone.
 * - **A worker the caller cannot see.** A run held by a machine outside the caller's `GET
 *   /api/workers` (a member sees only their own) gets a seat built from the run's own seat — its
 *   name, no owner, no concurrency.
 * - **Draining.** `WorkerSummary` carries a pause (`paused_until`) and a revocation, not a drain, so
 *   no seat here is draining; `activityOf` still knows the word for when one is reported.
 * - **An escalated task with no question.** The inbox lists questions and approvals; a task at
 *   `needs_human` with neither is Home's to list (it reads each project's tasks), not this read's.
 *
 * Every string the platform did not write — a ticket title, a ticket key, a worker's name, an
 * owner's name, a question — stays as it came and is marked untrusted where it is carried; the views
 * render it as text (BD-022).
 */
import type {
  AgentRole,
  AgentsResponse,
  InboxResponse,
  RunRecord,
  TaskState,
  WorkerSummary,
} from '@platform/contracts';
import {
  ACTIVITY_META,
  type Activity,
  type ActivityMeta,
  type ActivityResult,
  activityOf,
  type LatestEntry,
} from '../../ui/activity.js';
import { APPROVAL_KIND_LABEL, ROLE_LABEL, stageLabel } from '../../ui/humanize.js';
import { type PhaseStage, phaseStagesFor, type StageRowLike } from '../../ui/phase-track.js';
import { sanitiseUntrusted } from '../../ui/untrusted-text.js';

export type AgentItem = AgentsResponse['items'][number];

/** What the page knows of a run's task, from `GET /api/tasks/:id`. */
export interface FleetTaskFacts {
  readonly projectId: string;
  /** Untrusted (the tracker's key). */
  readonly ticketKey: string;
  /** Untrusted (the ticket's title); `null` when the platform has not read the ticket. */
  readonly title: string | null;
  readonly state: TaskState;
  readonly currentStage: string | null;
  readonly stages: readonly StageRowLike[];
  /** The task's frozen pipeline's stages in order, or `null` until that read answers. */
  readonly templateStages: readonly { readonly id: string }[] | null;
}

/** A run that left the agents list while the page watched, with how it ended. */
export interface FleetEnding {
  /** The agents item as it was last seen: its seat is where the desk is. */
  readonly entry: AgentItem;
  /** The run as `GET /api/runs/:id` answered after it ended. */
  readonly run: RunRecord;
}

export interface FleetInput {
  readonly agents: readonly AgentItem[];
  /** `null` when the workers read is not available (pending, refused, failed). */
  readonly workers: readonly WorkerSummary[] | null;
  /** `null` when the inbox read is not available. */
  readonly inbox: InboxResponse | null;
  /** Epoch milliseconds. */
  readonly now: number;
  /** Ticket key, title, state and stage rows per task id, for the tasks read so far. */
  readonly tasks?: ReadonlyMap<string, FleetTaskFacts>;
  /** Project id → key. */
  readonly projectKeys?: ReadonlyMap<string, string>;
  /** Run id → the live transcript's newest entry; used when newer than the agents read's. */
  readonly latest?: ReadonlyMap<string, LatestEntry>;
  readonly endings?: readonly FleetEnding[];
}

export type SeatState = 'active' | 'paused' | 'revoked';

export interface FleetRun {
  readonly id: string;
  readonly run: RunRecord;
  readonly entry: AgentItem;
  readonly taskId: string;
  readonly projectId: string;
  /** Untrusted; `null` until the projects read answers. */
  readonly projectKey: string | null;
  /** Untrusted; `null` until the task read answers. */
  readonly ticketKey: string | null;
  /** Untrusted; `null` until the task read answers, or when the ticket was never read. */
  readonly title: string | null;
  readonly role: AgentRole;
  /** The stage's human name, or the role's for a run with no stage (a question to the task). */
  readonly stageName: string;
  readonly activity: ActivityResult;
  readonly meta: ActivityMeta;
  /** The task's stages for `PhaseTrack`; empty until the task read answers. */
  readonly phases: readonly PhaseStage[];
  /** The seat holding it (`FleetSeat.id`), or `null` for a run in the queue. */
  readonly seatId: string | null;
  /** Which of four animation offsets its bot takes, from its id: neighbours do not move together. */
  readonly botPhase: 0 | 1 | 2 | 3;
  /** It ended while the page watched (a cheer or a slump, for a moment). */
  readonly ended: boolean;
}

export interface FleetSeat {
  /** `server`, or `worker:<id>`. */
  readonly id: string;
  readonly kind: 'server' | 'worker';
  readonly workerId: string | null;
  /** Untrusted (the machine's name its owner chose); `null` for the server or an unnamed worker. */
  readonly name: string | null;
  /** Untrusted (the owner's name or email); `null` when not known. */
  readonly owner: string | null;
  /** `null` when no read reports it (the server; a worker outside the caller's list). */
  readonly concurrency: number | null;
  readonly state: SeatState;
  readonly pausedUntil: string | null;
  /** The live runs it holds, in a stable order (oldest first). */
  readonly runs: readonly FleetRun[];
  /** Runs it held that ended while the page watched. */
  readonly endings: readonly FleetRun[];
  /** How many runs it holds: its placed runs and the ids its worker read names, together. */
  readonly busy: number;
  /** Slots left (`concurrency − busy`, at least 0), or `null` when the concurrency is unknown. */
  readonly free: number | null;
}

export type NeedKind = 'question' | 'approval' | 'permission';

export interface FleetNeed {
  readonly id: string;
  readonly kind: NeedKind;
  readonly taskId: string;
  readonly runId: string | null;
  readonly stage: string | null;
  /** What to show; untrusted when {@link FleetNeed.untrusted} (a question's first line). */
  readonly text: string;
  readonly untrusted: boolean;
  readonly at: string;
  readonly ticketKey: string | null;
  readonly projectKey: string | null;
}

export interface FleetCounts {
  /** Live runs that are working or thinking. */
  readonly working: number;
  readonly stuck: number;
  /** Open questions, pending approvals and runs asking for a permission. */
  readonly needsYou: number;
  /** Live runs with no seat yet or still starting. */
  readonly waiting: number;
  /** Free slots on active, unpaused workers whose concurrency is known. */
  readonly freeSeats: number;
  readonly live: number;
}

export interface Fleet {
  readonly seats: readonly FleetSeat[];
  /** Live runs no seat holds yet, oldest first. */
  readonly queue: readonly FleetRun[];
  readonly needs: readonly FleetNeed[];
  /** Every live run, what needs a person first (`ATTENTION_ORDER`), then oldest first. */
  readonly runs: readonly FleetRun[];
  readonly counts: FleetCounts;
}

export const SERVER_SEAT_ID = 'server';

const LIVE: ReadonlySet<RunRecord['status']> = new Set(['created', 'starting', 'running']);

/** The order the list (and the live subscriptions) take: what needs a person first. */
export const ATTENTION_ORDER: Readonly<Record<Activity, number>> = {
  needs_you: 0,
  stuck: 1,
  failed: 2,
  working: 3,
  thinking: 4,
  waiting: 5,
  paused: 6,
  done: 7,
  idle: 8,
};

/** FNV-1a over the id, folded onto the four phases. */
export const botPhaseOf = (id: string): 0 | 1 | 2 | 3 => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 4) as 0 | 1 | 2 | 3;
};

/** The newer of two latest entries (by `at`); the transcript's wins a tie. */
const newer = (dto: LatestEntry | null, live: LatestEntry | undefined): LatestEntry | null => {
  if (live === undefined) {
    return dto;
  }
  if (dto === null) {
    return live;
  }
  return Date.parse(live.at) >= Date.parse(dto.at) ? live : dto;
};

const latestOfEntry = (entry: AgentItem): LatestEntry | null =>
  entry.activity === null
    ? null
    : { kind: entry.activity.kind, tool_name: entry.activity.tool_name, at: entry.activity.at };

const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? text;

const isPaused = (worker: WorkerSummary, now: number): boolean =>
  worker.paused_until !== null && Date.parse(worker.paused_until) > now;

const seatIdOf = (seat: AgentItem['seat']): string | null => {
  if (seat === null) {
    return null;
  }
  if (seat.kind === 'server') {
    return SERVER_SEAT_ID;
  }
  return seat.worker_id === null ? 'worker:unknown' : `worker:${seat.worker_id}`;
};

const byStart = (left: FleetRun, right: FleetRun): number => {
  const a = left.run.started_at ?? left.run.ended_at ?? '';
  const b = right.run.started_at ?? right.run.ended_at ?? '';
  return a === b ? left.id.localeCompare(right.id) : a.localeCompare(b);
};

export const fleetOf = (input: FleetInput): Fleet => {
  const { now } = input;
  const tasks = input.tasks ?? new Map<string, FleetTaskFacts>();
  const projectKeys = input.projectKeys ?? new Map<string, string>();
  const workers = input.workers ?? [];
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));

  const openAsks = new Map<string, number>();
  for (const question of input.inbox?.questions ?? []) {
    if (question.status === 'open') {
      openAsks.set(question.task_id, (openAsks.get(question.task_id) ?? 0) + 1);
    }
  }
  for (const approval of input.inbox?.approvals ?? []) {
    if (approval.status === 'pending') {
      openAsks.set(approval.task_id, (openAsks.get(approval.task_id) ?? 0) + 1);
    }
  }

  const workerStateOf = (seatId: string | null): 'active' | 'paused' | null => {
    if (seatId === null || !seatId.startsWith('worker:')) {
      return null;
    }
    const worker = workerById.get(seatId.slice('worker:'.length));
    return worker !== undefined && isPaused(worker, now) ? 'paused' : 'active';
  };

  const toRun = (entry: AgentItem, run: RunRecord, ended: boolean): FleetRun => {
    const facts = tasks.get(entry.task_id);
    const seatId = seatIdOf(entry.seat);
    // BACKLOG 814: the task's asks and state describe the task's *current* run. A live stage run is
    // that run; a question to the task (no stage) runs beside the pipeline, and a run that already
    // ended is not the one a person is waiting on — neither is read as "needs you" for the task.
    const current = !ended && run.stage !== null;
    const activity = activityOf({
      run: {
        status: run.status,
        terminal_reason: run.terminal_reason ?? null,
        started_at: run.started_at ?? null,
      },
      seat: entry.seat !== null,
      latest: ended ? null : newer(latestOfEntry(entry), input.latest?.get(run.id)),
      role: entry.role,
      task_state: current ? (facts?.state ?? null) : null,
      open_asks: current ? (openAsks.get(entry.task_id) ?? 0) : 0,
      // A run that ended is read by how it ended, not by its worker's pause since.
      worker: ended ? null : workerStateOf(seatId),
      lease_late: false,
      now,
    });
    return {
      id: run.id,
      run,
      entry,
      taskId: entry.task_id,
      projectId: entry.project_id,
      projectKey: projectKeys.get(entry.project_id) ?? null,
      ticketKey: facts?.ticketKey ?? null,
      title: facts?.title ?? null,
      role: entry.role,
      stageName: run.stage === null ? ROLE_LABEL[entry.role] : stageLabel(run.stage),
      activity,
      meta: ACTIVITY_META[activity.activity],
      phases:
        facts === undefined
          ? []
          : phaseStagesFor(facts.templateStages, facts.stages, facts.currentStage ?? null),
      seatId,
      botPhase: botPhaseOf(run.id),
      ended,
    };
  };

  const live = input.agents
    .filter((entry) => LIVE.has(entry.run.status))
    .map((entry) => toRun(entry, entry.run, false));
  const liveIds = new Set(live.map((run) => run.id));
  const endings = (input.endings ?? [])
    .filter((ending) => !liveIds.has(ending.run.id) && !LIVE.has(ending.run.status))
    .map((ending) => toRun(ending.entry, ending.run, true));

  // The seats: the server first, then every worker the caller can see that is active (or revoked
  // and still holding a run), then any worker a run names that the list does not.
  interface SeatDraft {
    readonly seat: Omit<FleetSeat, 'runs' | 'endings' | 'busy' | 'free'>;
    readonly heldIds: ReadonlySet<string>;
  }
  const drafts = new Map<string, SeatDraft>();
  drafts.set(SERVER_SEAT_ID, {
    seat: {
      id: SERVER_SEAT_ID,
      kind: 'server',
      workerId: null,
      name: null,
      owner: null,
      concurrency: null,
      state: 'active',
      pausedUntil: null,
    },
    heldIds: new Set(),
  });
  const holding = new Set(live.map((run) => run.seatId));
  for (const worker of [...workers].sort((a, b) => a.name.localeCompare(b.name))) {
    const id = `worker:${worker.id}`;
    if (worker.state === 'revoked' && !holding.has(id)) {
      continue;
    }
    drafts.set(id, {
      seat: {
        id,
        kind: 'worker',
        workerId: worker.id,
        name: worker.name,
        owner: worker.user.name ?? worker.user.email,
        concurrency: worker.concurrency,
        state: worker.state === 'revoked' ? 'revoked' : isPaused(worker, now) ? 'paused' : 'active',
        pausedUntil: worker.paused_until,
      },
      heldIds: new Set(worker.running.map((held) => held.run_id)),
    });
  }
  for (const run of [...live, ...endings]) {
    const seat = run.entry.seat;
    if (run.seatId === null || seat === null || drafts.has(run.seatId)) {
      continue;
    }
    drafts.set(run.seatId, {
      seat: {
        id: run.seatId,
        kind: 'worker',
        workerId: seat.worker_id,
        name: seat.worker_name,
        owner: null,
        concurrency: null,
        state: 'active',
        pausedUntil: null,
      },
      heldIds: new Set(),
    });
  }

  const seats: FleetSeat[] = [...drafts.values()].map(({ seat, heldIds }) => {
    const runs = live.filter((run) => run.seatId === seat.id).sort(byStart);
    const held = new Set([...heldIds, ...runs.map((run) => run.id)]);
    return {
      ...seat,
      runs,
      endings: endings.filter((run) => run.seatId === seat.id).sort(byStart),
      busy: held.size,
      free: seat.concurrency === null ? null : Math.max(0, seat.concurrency - held.size),
    };
  });

  const queue = live.filter((run) => run.seatId === null).sort(byStart);

  const needs: FleetNeed[] = [
    ...(input.inbox?.questions ?? [])
      .filter((question) => question.status === 'open')
      .map(
        (question): FleetNeed => ({
          id: `question:${question.id}`,
          kind: 'question',
          taskId: question.task_id,
          runId: question.run_id ?? null,
          stage: question.stage,
          text: firstLine(question.text),
          untrusted: true,
          at: question.asked_at,
          ticketKey: tasks.get(question.task_id)?.ticketKey ?? null,
          projectKey: null,
        }),
      ),
    ...(input.inbox?.approvals ?? [])
      .filter((approval) => approval.status === 'pending')
      .map(
        (approval): FleetNeed => ({
          id: `approval:${approval.id}`,
          kind: 'approval',
          taskId: approval.task_id,
          runId: null,
          stage: null,
          text: `${APPROVAL_KIND_LABEL[approval.kind]} is waiting for you`,
          untrusted: false,
          at: approval.requested_at,
          ticketKey: tasks.get(approval.task_id)?.ticketKey ?? null,
          projectKey: null,
        }),
      ),
    ...live
      .filter(
        // A permission ask is the one "needs you" with a sub-label (`activityOf` rule 1): the
        // task's questions and approvals are listed above, from the inbox, once each.
        (run) => run.activity.activity === 'needs_you' && run.activity.detail !== null,
      )
      .map(
        (run): FleetNeed => ({
          id: `permission:${run.id}`,
          kind: 'permission',
          taskId: run.taskId,
          runId: run.id,
          stage: run.run.stage,
          // Platform words around a tool name already bounded and filtered by `toolWords`.
          text: run.activity.detail ?? 'Waiting for permission',
          untrusted: false,
          at: run.entry.activity?.at ?? run.run.started_at ?? '',
          ticketKey: run.ticketKey,
          projectKey: run.projectKey,
        }),
      ),
  ]
    .map((need) => {
      const projectId =
        tasks.get(need.taskId)?.projectId ??
        live.find((run) => run.taskId === need.taskId)?.projectId;
      return need.projectKey !== null || projectId === undefined
        ? need
        : { ...need, projectKey: projectKeys.get(projectId) ?? null };
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const runs = [...live].sort(
    (a, b) =>
      ATTENTION_ORDER[a.activity.activity] - ATTENTION_ORDER[b.activity.activity] || byStart(a, b),
  );

  const count = (activities: readonly Activity[]): number =>
    live.filter((run) => activities.includes(run.activity.activity)).length;

  return {
    seats,
    queue,
    needs,
    runs,
    counts: {
      working: count(['working', 'thinking']),
      stuck: count(['stuck']),
      needsYou: needs.length,
      waiting: count(['waiting']),
      freeSeats: seats.reduce(
        (total, seat) =>
          seat.kind === 'worker' && seat.state === 'active' && seat.free !== null
            ? total + seat.free
            : total,
        0,
      ),
      live: live.length,
    },
  };
};

/** "worker jan-mbp", "the platform server", "no seat yet" — the seat in words (name sanitised). */
export const seatWords = (seat: Pick<FleetSeat, 'kind' | 'name'> | null): string => {
  if (seat === null) {
    return 'no seat yet';
  }
  if (seat.kind === 'server') {
    return 'the platform server';
  }
  return seat.name === null ? 'a worker' : `worker ${sanitiseUntrusted(seat.name)}`;
};

/** A seat's room or node title: the worker's name (untrusted, sanitised) or the server's. */
export const seatTitle = (seat: Pick<FleetSeat, 'kind' | 'name'>): string =>
  seat.kind === 'server'
    ? 'Platform server'
    : seat.name === null
      ? 'Unnamed worker'
      : sanitiseUntrusted(seat.name);

/** "2 of 3 slots busy", or "2 running" when the capacity is unknown. */
export const slotsWords = (seat: Pick<FleetSeat, 'busy' | 'concurrency'>): string =>
  seat.concurrency === null
    ? `${seat.busy} running`
    : `${seat.busy} of ${seat.concurrency} slot${seat.concurrency === 1 ? '' : 's'} busy`;

/** "working: Reading files", "needs you" — the activity in words for a sentence. */
export const activityWords = (run: Pick<FleetRun, 'activity' | 'meta'>): string =>
  `${run.meta.label.toLowerCase()}${run.activity.detail === null ? '' : `: ${run.activity.detail}`}`;

/**
 * A run's whole state in one line — the desk's and the card's accessible name, opening with the
 * ticket key and title a card shows (WCAG 2.5.3): "DEMO-1 · Checkout flow · Code review · working:
 * Reading files · worker jan-mbp". The title is left out until the task's read answers, or when the
 * platform never read the ticket. Untrusted parts sanitised.
 */
export const runSentence = (run: FleetRun, seat: Pick<FleetSeat, 'kind' | 'name'> | null): string =>
  [
    run.ticketKey === null ? 'A task' : sanitiseUntrusted(run.ticketKey),
    ...(run.title === null ? [] : [sanitiseUntrusted(run.title)]),
    run.stageName,
    run.ended
      ? run.activity.activity === 'done'
        ? 'just finished'
        : `just ended: ${activityWords(run)}`
      : activityWords(run),
    seatWords(seat),
  ].join(' · ');
