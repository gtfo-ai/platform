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
  WorkerClaimBlocker,
  WorkerLocalCoreFailure,
  WorkerLocalRun,
  WorkerLocalSignInFailure,
  WorkerLocalSignInPhase,
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
import { ROLE_LABEL, stageLabel, WORKER_CLAIM_BLOCKER_WORDS } from '../ui/humanize.js';
import type { Status } from '../ui/status.js';
import { usagePauseWords } from '../ui/usage-pause.js';

/**
 * The worker's own state, in a person's words. `blocked` (S-22.19) is a connected worker that is
 * not held and still takes nothing — its launcher, its images, its connection — so *Taking work*
 * is said only when the worker's `claim_blockers` are empty.
 */
export type WorkerMode =
  | 'claiming'
  | 'blocked'
  | 'stopped'
  | 'paused'
  | 'usage_paused'
  | 'draining'
  | 'drained';

/** The blockers that are a hold, which the page's hold line and controls already say. */
const HOLDS: ReadonlySet<WorkerClaimBlocker> = new Set(['paused', 'draining', 'usage_limited']);

/** The first reason this worker takes no work that is not a hold, or `null` (S-22.19). */
export const claimBlockerOf = (state: WorkerLocalState): WorkerClaimBlocker | null =>
  state.claim_blockers.find((blocker) => !HOLDS.has(blocker)) ?? null;

/** A blocker's row word as the middle of a sentence: its first letter lower-cased. */
const inSentence = (word: string): string =>
  word === '' ? word : `${word.charAt(0).toLowerCase()}${word.slice(1)}`;

export const workerModeOf = (state: WorkerLocalState, nowMs: number): WorkerMode => {
  if (state.draining) return state.runs.length === 0 ? 'drained' : 'draining';
  if (state.manually_paused_at !== null) return 'paused';
  if (state.usage_paused_until !== null && Date.parse(state.usage_paused_until) > nowMs) {
    return 'usage_paused';
  }
  // A stopping worker is not "connected, but not taking work" (review of PR #54): it is stopping.
  if (state.connection === 'stopped') return 'stopped';
  if (claimBlockerOf(state) !== null) return 'blocked';
  return 'claiming';
};

export const WORKER_MODE_WORDS: Readonly<Record<WorkerMode, string>> = {
  claiming: 'Taking work',
  blocked: 'Connected, but not taking work',
  stopped: 'Stopping — it takes no new work',
  paused: 'Paused by you — it takes no new work',
  usage_paused: 'Paused — your Claude usage limit was reached',
  draining: 'Draining — finishing what runs, taking nothing new',
  drained: 'Drained — nothing runs and it takes nothing new; resume it, or stop the worker',
};

/**
 * The worker's state as its badge says it — a usage pause with **when it ends** (WP-285): *Paused —
 * usage limit until 14:00*, in this machine's own zone (the browser's), *until about* when the limit
 * named no reset and the instant is the worker's default pause. When the instant passes the mode is
 * `claiming` again by itself.
 */
export const workerModeWords = (state: WorkerLocalState, nowMs: number): string => {
  const mode = workerModeOf(state, nowMs);
  if (mode === 'usage_paused' && state.usage_paused_until !== null) {
    return usagePauseWords(
      { until: state.usage_paused_until, estimated: state.usage_paused_estimated },
      nowMs,
    );
  }
  return WORKER_MODE_WORDS[mode];
};

/**
 * What *Pause*, *Resume* and *Drain* do, under each button (the owner's request on PR #42). Held to
 * TD-031's 2026-11-05 drain rules: a pause is the owner's and survives a restart; a drain finishes
 * what runs, takes nothing new and stays up, and its hold is cleared by the next start or a resume.
 */
export const CONTROL_HINTS: Readonly<Record<'pause' | 'resume' | 'drain', string>> = {
  pause: 'Stops taking new runs. A run already going keeps going. Resume to take work again.',
  resume: 'Takes new runs again.',
  drain:
    'Finishes the current run, then takes nothing new, until the worker restarts or you resume. Use it before updating or switching off.',
};

/**
 * The hold line under the page's header (S-22.19, R-L5): the worker's current state as one
 * sentence with its status, and the one action that changes it — *Resume* while it is held,
 * *Try now* while its launcher (or its images) is what keeps it from work — or none.
 */
export interface HoldLine {
  readonly status: Status;
  readonly text: string;
  readonly action: 'resume' | 'try_now' | null;
}

/** Blockers *Try now* can clear: it asks the launcher again (`POST /api/local/retry`). */
const RETRYABLE: ReadonlySet<WorkerClaimBlocker> = new Set([
  'launcher_unreachable',
  'images_missing',
]);

export const holdLineOf = (state: WorkerLocalState, nowMs: number): HoldLine => {
  const mode = workerModeOf(state, nowMs);
  const runs = state.runs.length;
  switch (mode) {
    case 'drained':
      return {
        status: 'paused',
        text: 'Drained: nothing runs, and it takes nothing new until you resume or restart the worker.',
        action: 'resume',
      };
    case 'draining':
      return {
        status: 'paused',
        text: `Draining: finishing ${runs} run${runs === 1 ? '' : 's'}, then taking nothing new until you resume or restart the worker.`,
        action: 'resume',
      };
    case 'paused':
      return {
        status: 'paused',
        text: 'Paused by you: it takes no new work until you resume it. A run already going keeps going.',
        action: 'resume',
      };
    case 'usage_paused':
      return {
        status: 'paused',
        text: `${workerModeWords(state, nowMs)}. It resumes by itself.`,
        action: null,
      };
    case 'blocked': {
      const blocker = claimBlockerOf(state) as WorkerClaimBlocker;
      const words = WORKER_CLAIM_BLOCKER_WORDS[blocker];
      return {
        status: 'needs_you',
        text: `Connected, but not taking work: ${inSentence(words.word)}. ${words.fix}`,
        action: RETRYABLE.has(blocker) ? 'try_now' : null,
      };
    }
    case 'stopped':
      return {
        status: 'idle',
        text: 'Stopping: the worker is shutting down and takes no new work.',
        action: null,
      };
    case 'claiming':
      return { status: 'success', text: 'Taking work', action: null };
  }
};

/**
 * Why the list of waiting runs is empty (S-22.19, R-L7): the core lists nothing to a worker that
 * cannot take work, for the same reason it claims nothing — or, when nothing blocks it, where runs
 * that never reach a worker wait.
 */
export const emptyOffersWords = (state: WorkerLocalState): string => {
  const first = state.claim_blockers[0];
  return first === undefined
    ? 'No run is waiting for a worker. On projects that prefer the platform server, a run reaches workers only after the server’s head start; each project’s settings on the platform say which.'
    : `Nothing is listed because this worker can’t take work: ${inSentence(WORKER_CLAIM_BLOCKER_WORDS[first].word)}.`;
};

/** What the page says when the platform runs a newer build (S-22.19, R-L8): no manual procedure. */
export const UPDATE_PENDING_WORDS =
  'The platform runs a newer build. This worker updates itself after its current run, within about 5 minutes. A worker set up without its updater: download the compose file again and run docker compose up -d.';

/** The connection's status icon (S-22.19, R-L6): a failure is never drawn as a wait. */
export const CONNECTION_STATUS: Readonly<Record<WorkerLocalState['connection'], Status>> = {
  needs_platform: 'needs_you',
  needs_claude: 'needs_you',
  logging_in: 'waiting',
  handshaking: 'waiting',
  connected: 'success',
  revoked: 'failure',
  upgrade_required: 'needs_you',
  core_unreachable: 'failure',
  stopped: 'idle',
};

/** The platform's wizard, where this worker's setup ends (S-22.19, R-L10). */
export const platformWizardUrl = (coreUrl: string): string =>
  `${coreUrl.replace(/\/+$/, '')}/workers/new?step=ready`;

/** The connection, in a person's words. */
export const CONNECTION_WORDS: Readonly<Record<WorkerLocalState['connection'], string>> = {
  needs_platform: 'Not connected to a platform yet',
  needs_claude: 'Waiting for you to sign in to Claude',
  logging_in: 'Waiting for you to approve this machine on the platform',
  handshaking: 'Connecting to the platform',
  connected: 'Connected',
  revoked:
    'The platform no longer accepts this worker — it was removed, or its owner can no longer act',
  upgrade_required: 'The platform needs another version of this worker — update it',
  core_unreachable: 'The platform is not answering',
  stopped: 'Stopped',
};

// ── The first-run wizard (WP-294, TD-031's 2026-11-05 first-run amendment §2) ─────────────────

/** The wizard's three steps, in order. */
export type WizardStepId = 'platform' | 'claude' | 'approve';

export const WIZARD_STEP_WORDS: Readonly<Record<WizardStepId, string>> = {
  platform: 'Connect to a platform',
  claude: 'Sign in to Claude',
  approve: 'Approve this machine',
};

/** Why a platform address was not taken, or why the platform is not answering. */
export const CORE_FAILURE_WORDS: Readonly<Record<WorkerLocalCoreFailure, string>> = {
  address_refused:
    'Use an https address, or http only for this machine (localhost), with no user name or password in it.',
  no_answer: 'Nothing answered at that address.',
  not_a_platform: 'Something answered, but it is not the platform.',
  certificate: 'The address’s certificate is not trusted.',
  needs_other_version:
    'The platform needs another version of this worker. Download its compose file again and run docker compose up -d.',
};

/** Where the Claude sign-in is. */
export const SIGN_IN_PHASE_WORDS: Readonly<Record<WorkerLocalSignInPhase, string>> = {
  idle: 'Not started',
  starting: 'Starting Claude’s sign-in…',
  waiting_for_code: 'Waiting for the code from Claude',
  checking: 'Checking with Claude…',
  failed: 'The sign-in did not finish',
};

/** Why a sign-in did not finish, and what to do. */
export const SIGN_IN_FAILURE_WORDS: Readonly<Record<WorkerLocalSignInFailure, string>> = {
  cli_unavailable:
    'Claude’s sign-in could not start on this worker. Paste a token instead, or run docker compose up -d again.',
  cli_ended: 'Claude’s sign-in stopped before it finished. Start it again.',
  code_refused: 'Claude did not accept that code. Start again and paste the newest code.',
  token_rejected: 'Claude did not accept this sign-in. Sign in again.',
  check_failed:
    'The sign-in could not be checked with Claude. Check that this machine reaches api.anthropic.com, then paste the token again.',
  timed_out: 'The sign-in took longer than ten minutes. Start it again.',
  no_token_after_code:
    'Claude’s sign-in did not hand this worker a token within a minute of the code. Paste a token instead: run claude setup-token in a terminal and paste the token it prints.',
};

/**
 * The shape of a token `claude setup-token` prints, and a paste with every whitespace removed — the
 * contract's `CLAUDE_OAUTH_TOKEN_SHAPE` and `normaliseClaudeToken`, copied because a value import
 * of `@platform/contracts` brings zod into this page's 120 kB bundle; `model.test.ts` holds them
 * equal.
 */
export const PASTED_TOKEN_SHAPE = /^sk-ant-oat01-[A-Za-z0-9_-]{40,400}$/;
export const normalisePastedToken = (pasted: string): string => pasted.replace(/\s+/g, '');

/** A pasted token the page refuses before anything runs (the worker refuses it too, `400`). */
export const TOKEN_SHAPE_WORDS =
  'That isn’t a Claude token: it starts with sk-ant-oat01-. Copy the whole line claude setup-token printed.';

/** Why the worker refused a pasted token, by its answer's code. */
export const TOKEN_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  invalid_token: TOKEN_SHAPE_WORDS,
  token_check_running:
    'Claude is still checking a token. Wait for it, or cancel the sign-in and paste again.',
};

export interface WizardView {
  readonly steps: readonly {
    readonly id: WizardStepId;
    readonly label: string;
    readonly state: 'done' | 'current' | 'upcoming';
    readonly hint?: string;
  }[];
  readonly current: WizardStepId;
}

/** The host of an origin, for "Connected to <host>" — or the text itself when it does not parse. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * The wizard, or `null` when the worker is connected and the page is the room. Each step is done
 * when its value is there; the current one is the first that is not; the approval step also holds
 * the waits that follow it (connecting, the platform not answering, revoked, update needed).
 */
export const wizardOf = (state: WorkerLocalState): WizardView | null => {
  if (state.connection === 'connected' || state.connection === 'stopped') return null;
  const current: WizardStepId =
    state.connection === 'needs_platform'
      ? 'platform'
      : state.connection === 'needs_claude'
        ? 'claude'
        : 'approve';
  const order: readonly WizardStepId[] = ['platform', 'claude', 'approve'];
  const at = order.indexOf(current);
  return {
    current,
    steps: order.map((id, index) => ({
      id,
      label: WIZARD_STEP_WORDS[id],
      state: index < at ? 'done' : index === at ? 'current' : 'upcoming',
      // The platform's host is named before the Claude step (TD-031's no-bearer amendment §3).
      ...(id === 'platform' && state.core_url !== null ? { hint: hostOf(state.core_url) } : {}),
    })),
  };
};

/** Whole seconds until `iso`, never negative. */
export const secondsUntil = (iso: string, nowMs: number): number =>
  Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / 1000));

/** "9:41" — a countdown's minutes and seconds. */
export const countdownWords = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** The approval link, only when it is on the platform's own origin (amendment §5). */
export const approvalLinkOf = (state: WorkerLocalState): string | null => {
  const url = state.setup.device?.approve_url ?? null;
  if (url === null || state.core_url === null) return null;
  try {
    return new URL(url).origin === new URL(state.core_url).origin ? url : null;
  } catch {
    return null;
  }
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
  /**
   * The nameplate's two lines: the ticket key (the tracker's text, `null` without one) above the
   * stage's name — two lines rather than one joined line, which a desk's width cut short
   * ("AUT-1234 · Implementati…", the UI-redesign review of PR #30).
   */
  readonly nameplate: { readonly ticket: string | null; readonly stage: string };
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
      mode === 'claiming' || mode === 'blocked' || mode === 'stopped'
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
    nameplate: { ticket: run.ticket_key, stage },
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
    words:
      mode === 'blocked'
        ? 'Not taking work'
        : mode === 'stopped'
          ? 'Stopping'
          : resting
            ? 'Paused'
            : 'Free desk',
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

/** Whether the run's figures are still moving: before its `result`, `tokens` counts turns so far. */
const live = (run: WorkerLocalRun): boolean =>
  run.phase === 'provisioning' || run.phase === 'running';

/**
 * Reported tokens and cost, or the words that say nothing was reported yet (BD-011). A live run's
 * tokens are the turns the CLI has reported **so far** (backlog 772), and say so.
 */
export const spendWords = (run: WorkerLocalRun): { tokens: string; cost: string } => ({
  tokens:
    run.tokens === null
      ? 'not reported yet'
      : `${new Intl.NumberFormat('en').format(run.tokens)}${live(run) ? ' so far' : ''}`,
  cost: run.cost_usd === null ? 'not reported yet' : `$${run.cost_usd.toFixed(2)}`,
});

/** The input fields that say what a tool call is about, in the order they are asked. */
const SUMMARY_FIELDS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description'];

/**
 * What a tool call is about, as plain text: its path, its command or its query — never the raw
 * JSON of its input (the UI-redesign review of PR #30). The first named field that holds a
 * string, else the input's first string value, else nothing; one line, at most 160 characters.
 * Deliberately not `viz/flow`'s `argumentSummary`: that module is lazy and stays out of this entry.
 */
export const argumentSummaryOf = (input: Readonly<Record<string, unknown>>): string => {
  const named = SUMMARY_FIELDS.map((field) => input[field]).find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  const any = Object.values(input).find((value): value is string => typeof value === 'string');
  const text = (named ?? any ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
};

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
          text: argumentSummaryOf(block.input),
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
export const coreRunUrl = (coreUrl: string | null, runId: string): string =>
  `${(coreUrl ?? '').replace(/\/+$/, '')}/runs/${encodeURIComponent(runId)}`;
