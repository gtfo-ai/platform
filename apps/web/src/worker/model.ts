/**
 * The worker's local page, as data (WP-292): what each desk shows, in the shared vocabulary.
 *
 * Pure: a `WorkerLocalState` and the clock in, the page's words out — so the rules are tested
 * without a DOM. **The activity is the platform's one vocabulary** (`ui/activity.ts`'s
 * `activityOf`, read off the run's transcript tail with `activityFromBlocks`), so a run is never
 * "working" here and "stuck" on the Agents page. A free desk sleeps; on a paused or draining worker
 * it sips its coffee.
 *
 * Every string a person, a tracker or an agent wrote (a ticket title, a transcript line, a log
 * line) is returned **as a string** and rendered as a React text node by the page — never markup
 * (BD-022).
 */
import type {
  AgentRole,
  RunStatus,
  TranscriptEvent,
  WorkerLocalRun,
  WorkerLocalState,
} from '@platform/contracts';
import { type TranscriptBlock, toBlocks } from '../transcript/blocks.js';
import {
  ACTIVITY_META,
  type Activity,
  type ActivityMeta,
  activityFromBlocks,
  activityOf,
  toolActivityLabel,
} from '../ui/activity.js';
import type { BotPhase } from '../ui/bot/bot.js';
import { ROLE_LABEL, stageLabel } from '../ui/humanize.js';

/** The worker's own state, in a person's words. */
export type WorkerMode = 'claiming' | 'paused' | 'usage_paused' | 'draining' | 'drained';

export const workerModeOf = (state: WorkerLocalState, nowMs: number): WorkerMode => {
  if (state.draining) return state.runs.length === 0 ? 'drained' : 'draining';
  if (state.manually_paused_at !== null) return 'paused';
  if (state.usage_paused_until !== null && Date.parse(state.usage_paused_until) > nowMs) {
    return 'usage_paused';
  }
  return 'claiming';
};

export const WORKER_MODE_WORDS: Readonly<Record<WorkerMode, string>> = {
  claiming: 'Taking work',
  paused: 'Paused by you — it takes no new work',
  usage_paused: 'Paused: your Claude usage limit was reached',
  draining: 'Draining — finishing what runs, taking nothing new',
  drained: 'Drained — nothing runs and it takes nothing new; resume it, or stop the worker',
};

/** The connection, in a person's words. */
export const CONNECTION_WORDS: Readonly<Record<WorkerLocalState['connection'], string>> = {
  logging_in: 'Waiting for you to approve this machine on the platform',
  handshaking: 'Connecting to the platform',
  connected: 'Connected',
  revoked:
    'The platform no longer accepts this worker — it was removed, or its owner can no longer act',
  upgrade_required: 'The platform needs another version of this worker — update it',
  stopped: 'Stopped',
};

/** The run's phase on this machine, as the activity reads a run's status. */
const STATUS_OF: Readonly<Record<WorkerLocalRun['phase'], RunStatus>> = {
  provisioning: 'starting',
  running: 'running',
  finishing: 'running',
  ended: 'completed',
};

/** A stable animation offset from an id, so a room of bots does not move in lockstep. */
export const botPhaseOf = (id: string): BotPhase => {
  let sum = 0;
  for (const char of id) sum = (sum + char.charCodeAt(0)) % 4;
  return sum as BotPhase;
};

export interface DeskView {
  readonly runId: string;
  readonly activity: Activity;
  readonly meta: ActivityMeta;
  /** "Now: Reading files", or the activity's word. Platform text. */
  readonly bubble: string;
  /** "ACME-7 · Code review" — the ticket key is the tracker's text. */
  readonly nameplate: string;
  readonly detail: string | null;
  readonly phase: BotPhase;
}

export interface FreeDeskView {
  readonly key: string;
  readonly pose: 'sleeping' | 'sipping';
  readonly words: string;
  readonly phase: BotPhase;
}

/** What the run is doing now, read off its tail with the shared rules. */
export const deskOf = (run: WorkerLocalRun, state: WorkerLocalState, nowMs: number): DeskView => {
  const blocks = toBlocks(run.transcript as TranscriptEvent[]);
  const mode = workerModeOf(state, nowMs);
  const { activity, detail } = activityOf({
    run: { status: STATUS_OF[run.phase], started_at: run.started_at },
    seat: true,
    latest: activityFromBlocks(blocks),
    role: run.role,
    worker:
      mode === 'claiming'
        ? 'active'
        : mode === 'paused' || mode === 'usage_paused'
          ? 'paused'
          : 'draining',
    now: nowMs,
  });
  const meta = ACTIVITY_META[activity];
  const stage = run.stage === null ? ROLE_LABEL[run.role as AgentRole] : stageLabel(run.stage);
  return {
    runId: run.run_id,
    activity,
    meta,
    detail,
    bubble: run.cancel_requested ? 'Stopping…' : detail === null ? meta.label : `Now: ${detail}`,
    nameplate: run.ticket_key === null ? stage : `${run.ticket_key} · ${stage}`,
    phase: botPhaseOf(run.run_id),
  };
};

/** The free desks: one per slot no run holds. */
export const freeDesksOf = (state: WorkerLocalState, nowMs: number): FreeDeskView[] => {
  const mode = workerModeOf(state, nowMs);
  const resting = mode !== 'claiming';
  return Array.from({ length: Math.max(0, state.concurrency - state.runs.length) }, (_, index) => ({
    key: `free-${index}`,
    pose: resting ? 'sipping' : 'sleeping',
    words: resting ? 'Paused' : 'Free desk',
    phase: botPhaseOf(`${state.worker_id ?? 'worker'}:${index}`),
  }));
};

/** "1 of 2 busy". */
export const slotsWords = (state: WorkerLocalState): string =>
  `${state.runs.length} of ${state.concurrency} busy`;

/** "4m 12s" — how long a run has been on this machine. */
export const elapsedWords = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** Reported tokens and cost, or the words that say nothing was reported yet (BD-011). */
export const spendWords = (run: WorkerLocalRun): { tokens: string; cost: string } => ({
  tokens: run.tokens === null ? 'not reported yet' : new Intl.NumberFormat('en').format(run.tokens),
  cost: run.cost_usd === null ? 'not reported yet' : `$${run.cost_usd.toFixed(2)}`,
});

export interface TailLine {
  readonly id: string;
  /** Platform text: what kind of entry it is. */
  readonly label: string;
  /** The run's own text — untrusted, rendered as text. */
  readonly text: string;
}

const flatten = (blocks: readonly TranscriptBlock[], into: TranscriptBlock[]): void => {
  for (const block of blocks) {
    into.push(block);
    if (block.kind === 'tool') flatten(block.children, into);
  }
};

/** The transcript tail as lines: the newest `limit`, oldest first. */
export const tailLinesOf = (run: WorkerLocalRun, limit = 12): TailLine[] => {
  const all: TranscriptBlock[] = [];
  flatten(toBlocks(run.transcript as TranscriptEvent[]), all);
  const lines: TailLine[] = [];
  for (const block of all) {
    switch (block.kind) {
      case 'text':
        lines.push({ id: block.id, label: 'Said', text: block.text });
        break;
      case 'thinking':
        lines.push({ id: block.id, label: 'Thought', text: block.text });
        break;
      case 'tool':
        lines.push({
          id: block.id,
          label: toolActivityLabel(block.toolName),
          text: JSON.stringify(block.input).slice(0, 240),
        });
        break;
      case 'progress':
        lines.push({ id: block.id, label: 'Progress', text: block.summary });
        break;
      case 'steer':
        lines.push({ id: block.id, label: 'A person said', text: block.message });
        break;
      case 'result':
        lines.push({ id: block.id, label: 'Finished', text: '' });
        break;
      default:
        break;
    }
  }
  return lines.slice(-limit);
};

/** One log line: `10:04:12  the message`, or the line itself when it is not the worker's JSON. */
export const logLineWords = (line: string): string => {
  try {
    const parsed = JSON.parse(line) as { time?: unknown; msg?: unknown };
    if (typeof parsed.msg === 'string') {
      const time =
        typeof parsed.time === 'number' ? new Date(parsed.time).toISOString().slice(11, 19) : '';
      return `${time}  ${parsed.msg}`.trim();
    }
  } catch {
    // Not JSON: shown as it is.
  }
  return line;
};

/** The core's page for a run — steer and take-over live there (amendment §4). */
export const coreRunUrl = (coreUrl: string, runId: string): string =>
  `${coreUrl.replace(/\/+$/, '')}/runs/${encodeURIComponent(runId)}`;
