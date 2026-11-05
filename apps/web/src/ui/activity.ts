/**
 * One vocabulary for "what is this agent doing" (TD-033 decision 6).
 *
 * `activityOf` maps what the client already receives — a run's status, the latest transcript entry,
 * the task's state, the open questions and approvals, the seat and its worker — onto exactly one of
 * nine activities, with a platform-written sub-label ("Reading files"). The board card, the Agents
 * and Inbox rows, the task header, every office seat and the worker's local page read the same
 * function, so the same run is never "running" in one place and "stuck" in another.
 *
 * **The rules, in the order they are asked** (the first that holds decides):
 *
 * 1. `needs_you` — an open question or approval, a task waiting for answers or an approval or
 *    `needs_human`, or a live run whose latest entry is a tool call waiting for permission. What
 *    needs a person comes first, everywhere (research/19 § 3 item 2).
 * 2. `paused` — the task is paused; or there is no live run and the seat's worker is paused or
 *    draining. A draining worker still finishes the run it holds, so a live run on one is read by
 *    the rules below rather than called paused.
 * 3. A run that ended: `completed` → `done`; `shutdown` and `rate_limited` handed the run back, so
 *    it is `idle` ("Handed back") — whether the stage is offered again is the stage's, not this old
 *    run's; `cancelled` → `idle` (nothing is happening, and nothing went wrong); every other ending
 *    → `failed`.
 * 4. A live run: `created`/`starting` → `waiting` (no seat yet). `running` → `stuck` when the lease
 *    is late, when the latest entry is older than {@link STUCK_AFTER_MS} — or, for a tool call still
 *    in flight, than {@link STUCK_TOOL_AFTER_MS}, because a test suite or a build is silent for
 *    minutes by design — or when there is no entry and the run started longer ago than
 *    `STUCK_AFTER_MS`; otherwise the latest entry decides — a tool call is
 *    `working` (sub-label by tool), thinking or assistant text is `thinking` ("Brainstorming" for
 *    the planning roles), anything else is `working`.
 * 5. No run: a free seat is `idle`; otherwise the task's state — merged or done → `done`, cancelled
 *    → `idle`, everything else → `waiting`.
 *
 * Pure and total: every input yields one activity, which a property test holds. Its runtime imports
 * are `./untrusted-text.js` (pure, dependency-free) and `./status.js`'s types, so `ui/` stays
 * dependency-free for the worker entry.
 *
 * **A tool name is the run's text, not the platform's.** The agents read bounds it to an identifier,
 * but the live transcript carries whatever name the model or an MCP server sent — so a sub-label
 * built from one (`Using …`, `Asking to use …`) goes through {@link toolWords}: the character filter
 * (bidi overrides, control characters), whitespace collapsed, at most
 * {@link TOOL_NAME_LABEL_MAX_CHARS} characters. It is still rendered as React text, never as markup.
 */
import type {
  AgentRole,
  PlatformToolName,
  RunStatus,
  RunTerminalReason,
  TaskState,
} from '@platform/contracts';
import type { TranscriptBlock } from '../transcript/blocks.js';
import type { Status } from './status.js';
import { sanitiseUntrusted } from './untrusted-text.js';

export const ACTIVITIES = [
  'working',
  'thinking',
  'needs_you',
  'waiting',
  'stuck',
  'idle',
  'paused',
  'done',
  'failed',
] as const;

export type Activity = (typeof ACTIVITIES)[number];

/** The office pose each activity is drawn in (research/18's recipe makes the sprites). */
export type Pose =
  | 'typing'
  | 'thinking'
  | 'raise_hand'
  | 'sipping'
  | 'confused'
  | 'sleeping'
  | 'cheer'
  | 'slumped';

/** The colour role, named as the semantic token family in `styles.css`. */
export type Tone = 'running' | 'attention' | 'success' | 'danger' | 'muted' | 'subtle';

export interface ActivityMeta {
  readonly label: string;
  /** The `StatusIcon` glyph; pass `label` as its accessible name, since the words differ. */
  readonly icon: Status;
  readonly tone: Tone;
  readonly pose: Pose;
}

export const ACTIVITY_META: Readonly<Record<Activity, ActivityMeta>> = {
  working: { label: 'Working', icon: 'running', tone: 'running', pose: 'typing' },
  thinking: { label: 'Thinking', icon: 'running', tone: 'running', pose: 'thinking' },
  needs_you: { label: 'Needs you', icon: 'needs_you', tone: 'running', pose: 'raise_hand' },
  waiting: { label: 'Waiting', icon: 'queued', tone: 'muted', pose: 'sipping' },
  stuck: { label: 'Stuck', icon: 'waiting', tone: 'attention', pose: 'confused' },
  idle: { label: 'Idle', icon: 'idle', tone: 'subtle', pose: 'sleeping' },
  paused: { label: 'Paused', icon: 'paused', tone: 'muted', pose: 'sipping' },
  done: { label: 'Done', icon: 'success', tone: 'success', pose: 'cheer' },
  failed: { label: 'Failed', icon: 'failure', tone: 'danger', pose: 'slumped' },
};

/** A running agent silent this long reads as stuck. */
export const STUCK_AFTER_MS = 5 * 60 * 1000;

/** …and this long while a tool call it made has not answered yet. */
export const STUCK_TOOL_AFTER_MS = 10 * 60 * 1000;

export type LatestEntryKind =
  | 'tool'
  | 'thinking'
  | 'text'
  | 'waiting_permission'
  | 'progress'
  | 'other';

export interface LatestEntry {
  readonly kind: LatestEntryKind;
  /** The tool's name for `tool` and `waiting_permission`; `null` otherwise. */
  readonly tool_name: string | null;
  /** ISO timestamp the entry was written (or last changed). */
  readonly at: string;
  /**
   * For `tool`: the call has not answered yet. Absent means `true`, since a tool call that is the
   * newest entry is one whose result has not arrived.
   */
  readonly pending?: boolean;
}

export interface ActivityInput {
  /** The run being shown, or `null` for a seat or a task with none. */
  readonly run: {
    readonly status: RunStatus;
    readonly terminal_reason?: RunTerminalReason | null;
    readonly started_at?: string | null;
  } | null;
  /** A worker seat is shown (the office, the fleet map, the worker's page). */
  readonly seat?: boolean;
  readonly latest?: LatestEntry | null;
  readonly role?: AgentRole | null;
  readonly task_state?: TaskState | null;
  /** Open questions plus pending approvals on the task. */
  readonly open_asks?: number;
  readonly worker?: 'active' | 'paused' | 'draining' | null;
  /** The run's lease heartbeat is overdue. */
  readonly lease_late?: boolean;
  /** Epoch milliseconds. */
  readonly now: number;
}

export interface ActivityResult {
  readonly activity: Activity;
  /** The sub-label ("Reading files"), platform text; `null` when the activity's word is enough. */
  readonly detail: string | null;
}

const TOOL_LABELS: readonly (readonly [readonly string[], string])[] = [
  [['Read', 'Grep', 'Glob', 'LS'], 'Reading files'],
  [['Edit', 'Write', 'MultiEdit', 'NotebookEdit'], 'Editing code'],
  [['Bash', 'BashOutput'], 'Running a command'],
  [['WebFetch', 'WebSearch'], 'Searching the web'],
  [['Task', 'Agent'], 'Delegating to a sub-agent'],
  [['TodoWrite'], 'Planning'],
];

/** The longest tool name a sub-label quotes; a longer one is cut with an ellipsis. */
export const TOOL_NAME_LABEL_MAX_CHARS = 64;

/**
 * A tool name as a sub-label may quote it: the character filter of `untrusted-text.ts` (Trojan-source
 * bidi controls replaced, control characters removed), whitespace collapsed, and bounded.
 */
export const toolWords = (name: string): string => {
  const flat = sanitiseUntrusted(name).replace(/\s+/g, ' ').trim();
  return flat.length > TOOL_NAME_LABEL_MAX_CHARS
    ? `${flat.slice(0, TOOL_NAME_LABEL_MAX_CHARS - 1)}…`
    : flat;
};

/** The prefix the runner serves the platform's own MCP tools under (`runner/hooks.ts`). */
export const PLATFORM_TOOL_PREFIX = 'mcp__platform__';

/** The platform's own tools in words — exhaustive, so a new platform tool needs its phrase. */
export const PLATFORM_TOOL_LABEL: Readonly<Record<PlatformToolName, string>> = {
  ask_human: 'Asking you a question',
  notify_human: 'Sending you a note',
  report_progress: 'Reporting progress',
  get_task_context: 'Reading the task',
  get_conversation: 'Reading the conversation',
  kb_search: 'Searching the knowledge base',
  add_ticket_comment: 'Commenting on the ticket',
  open_mr: 'Opening a merge request',
  update_mr_description: 'Updating the merge request',
  create_followup_ticket: 'Filing a follow-up ticket',
};

/**
 * "Reading files", "Editing code", a platform tool's own phrase, or "Using <tool>" with an MCP
 * server's prefix dropped.
 */
export const toolActivityLabel = (toolName: string): string => {
  for (const [names, label] of TOOL_LABELS) {
    if (names.includes(toolName)) {
      return label;
    }
  }
  if (toolName.startsWith(PLATFORM_TOOL_PREFIX)) {
    const name = toolName.slice(PLATFORM_TOOL_PREFIX.length);
    if (Object.hasOwn(PLATFORM_TOOL_LABEL, name)) {
      return PLATFORM_TOOL_LABEL[name as PlatformToolName];
    }
  }
  const bare = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(toolName)?.[1] ?? toolName;
  return `Using ${toolWords(bare)}`;
};

/** The roles whose thinking is planning rather than doing. */
const PLANNING_ROLES: ReadonlySet<AgentRole> = new Set([
  'triager',
  'product_manager',
  'architect',
  'facilitator',
]);

const NEEDS_YOU_STATES: ReadonlySet<TaskState> = new Set([
  'waiting_answers',
  'waiting_approval',
  'needs_human',
]);

const LIVE: ReadonlySet<RunStatus> = new Set(['created', 'starting', 'running']);

const minutesAgo = (ms: number): string => {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `No activity for ${minutes} min`;
};

const ageOf = (iso: string | null | undefined, now: number): number | null => {
  if (iso === null || iso === undefined) {
    return null;
  }
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : now - at;
};

const result = (activity: Activity, detail: string | null = null): ActivityResult => ({
  activity,
  detail,
});

export const activityOf = (input: ActivityInput): ActivityResult => {
  const { run, now } = input;
  const live = run !== null && LIVE.has(run.status);
  const latest = input.latest ?? null;

  // 1. What needs a person.
  if ((input.open_asks ?? 0) > 0) {
    return result('needs_you');
  }
  if (input.task_state !== null && input.task_state !== undefined) {
    if (NEEDS_YOU_STATES.has(input.task_state)) {
      return result('needs_you');
    }
  }
  if (live && run.status === 'running' && latest?.kind === 'waiting_permission') {
    return result(
      'needs_you',
      latest.tool_name === null
        ? 'Waiting for permission'
        : `Asking to use ${toolWords(latest.tool_name)}`,
    );
  }

  // 2. Paused.
  if (input.task_state === 'paused') {
    return result('paused');
  }
  if (!live && (input.worker === 'paused' || input.worker === 'draining')) {
    return result('paused', input.worker === 'draining' ? 'Draining' : null);
  }

  // 3. A run that ended.
  if (run !== null && !live) {
    const reason = run.terminal_reason ?? null;
    if (reason === 'shutdown' || reason === 'rate_limited') {
      return result('idle', 'Handed back');
    }
    if (run.status === 'completed') {
      return result('done');
    }
    if (run.status === 'cancelled') {
      return result('idle', 'Cancelled');
    }
    return result('failed');
  }

  // 4. A live run.
  if (run !== null) {
    if (run.status !== 'running') {
      return result('waiting', 'Starting');
    }
    if (input.lease_late === true) {
      return result('stuck', 'Its worker is late');
    }
    if (latest === null) {
      const started = ageOf(run.started_at, now);
      return started !== null && started > STUCK_AFTER_MS
        ? result('stuck', minutesAgo(started))
        : result('working', 'Starting up');
    }
    const silent = ageOf(latest.at, now);
    const inFlight = latest.kind === 'tool' && latest.pending !== false;
    if (silent !== null && silent > (inFlight ? STUCK_TOOL_AFTER_MS : STUCK_AFTER_MS)) {
      return result('stuck', minutesAgo(silent));
    }
    switch (latest.kind) {
      case 'tool':
        return result(
          'working',
          latest.tool_name === null ? null : toolActivityLabel(latest.tool_name),
        );
      case 'thinking':
      case 'text':
        return result(
          'thinking',
          input.role !== null && input.role !== undefined && PLANNING_ROLES.has(input.role)
            ? 'Brainstorming'
            : null,
        );
      case 'progress':
        return result('working', 'Reporting progress');
      default:
        return result('working');
    }
  }

  // 5. No run.
  if (input.seat === true) {
    return result('idle');
  }
  switch (input.task_state) {
    case 'merged':
    case 'done':
      return result('done');
    case 'cancelled':
      return result('idle', 'Cancelled');
    default:
      return result('waiting');
  }
};

interface Candidate {
  readonly block: TranscriptBlock;
  readonly order: number;
}

/** Every block in the tree, a tool's sub-agent children included, in reading order. */
const flatten = (blocks: readonly TranscriptBlock[], into: Candidate[]): void => {
  for (const block of blocks) {
    into.push({ block, order: into.length });
    if (block.kind === 'tool') {
      flatten(block.children, into);
    }
  }
};

const later = (left: Candidate, right: Candidate | null): boolean =>
  right === null ||
  left.block.seq > right.block.seq ||
  (left.block.seq === right.block.seq && left.order > right.order);

const latestTime = (left: string, right: string | null): string =>
  right === null || Number.isNaN(Date.parse(right)) || Date.parse(left) > Date.parse(right)
    ? left
    : right;

/** What a block says the agent is doing, or `null` for one that says nothing about it. */
type EntryKind = Pick<LatestEntry, 'kind' | 'tool_name' | 'pending'>;

const kindOf = (block: TranscriptBlock): EntryKind | null => {
  switch (block.kind) {
    case 'tool':
      return { kind: 'tool', tool_name: block.toolName, pending: block.result === null };
    case 'thinking':
      return { kind: 'thinking', tool_name: null };
    case 'text':
      return { kind: 'text', tool_name: null };
    case 'progress':
      return { kind: 'progress', tool_name: null };
    case 'hook':
      if (block.decision === 'ask') {
        return { kind: 'waiting_permission', tool_name: block.toolName };
      }
      // A tool's own Pre/PostToolUse hook is that tool call still: it keeps its sub-label, and
      // only the Post hook says the call has answered.
      return block.toolName === null
        ? null
        : { kind: 'tool', tool_name: block.toolName, pending: block.hook !== 'PostToolUse' };
    default:
      return null;
  }
};

/**
 * The latest entry of a run's live transcript (`transcript/blocks.ts`), for a run page subscribed to
 * `run:<id>`.
 *
 * - **What** the agent is doing is read off the latest block that says (highest `seq` anywhere in
 *   the tree — a sub-agent's tool call is what the run is doing — and, within one message, the last
 *   block of it). A system notice, a compaction, a steer, a result or a hook with no tool says
 *   nothing about it and is passed over, so a tool's Post hook does not erase "Reading files".
 * - **When** is the newest `at` of any block, so a run that wrote anything recently is not stuck.
 *
 * `null` for an empty transcript; kind `other` when no block says what the agent is doing.
 */
export const activityFromBlocks = (blocks: readonly TranscriptBlock[]): LatestEntry | null => {
  const all: Candidate[] = [];
  flatten(blocks, all);
  let informative: {
    readonly candidate: Candidate;
    readonly kind: EntryKind;
  } | null = null;
  let at: string | null = null;
  for (const candidate of all) {
    at = latestTime(candidate.block.at, at);
    const kind = kindOf(candidate.block);
    if (kind !== null && later(candidate, informative?.candidate ?? null)) {
      informative = { candidate, kind };
    }
  }
  if (at === null) {
    return null;
  }
  return { ...(informative?.kind ?? { kind: 'other', tool_name: null }), at };
};
