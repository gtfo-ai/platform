/**
 * The stage dialog's two views of one run (TD-033 decision 8 (a)): a **"Live activity"** list —
 * time · status dot · what the agent did, one row per tool call, per thinking burst and per burst of
 * text — and a **log**: a terminal-like tail of the same run.
 *
 * Pure, over the transcript's render blocks (`transcript/blocks.ts`), so the rows the dialog draws
 * are the rows the unit tier holds, and the dialog is live because the blocks are (the `run:<id>`
 * frames land in the transcript store).
 *
 * **What is platform text and what is not.** A row's `label` comes from the activity vocabulary
 * (`toolActivityLabel` — "Reading files", "Running a command"); for a tool the vocabulary does not
 * name it quotes the tool's name ("Using …"), and the name is the run's text, so it is filtered and
 * bounded there (`toolWords` in `ui/activity.ts`). A log line's `prefix` is the platform's alone, a
 * fixed glyph (`$ `, `› `, `▸ progress: `) that nothing the run wrote reaches; its `text` is the
 * run's — the tool's name and its argument summary, a tool's output, the model's words — and is
 * untrusted (BD-022): the dialog renders it through `ui/untrusted.tsx`'s `TerminalLines`, which
 * strips ANSI and applies the character filter.
 */
import type { TranscriptBlock } from '../../transcript/blocks.js';
import { type Activity, toolActivityLabel } from '../../ui/activity.js';

export type RowState = 'current' | 'done' | 'error' | 'needs_you';

export interface ActivityRow {
  readonly key: string;
  readonly at: string;
  readonly activity: Activity;
  /** The vocabulary's words; a quoted tool name in it is filtered and bounded (`toolWords`). */
  readonly label: string;
  readonly state: RowState;
}

/** The newest rows the dialog keeps. */
export const ACTIVITY_ROW_LIMIT = 100;
/** The newest log lines the dialog keeps. */
export const LOG_LINE_LIMIT = 400;
/** A tool's output is shown as its last lines only: the run page has the whole of it. */
export const OUTPUT_TAIL_LINES = 8;
/** An argument summary longer than this is cut, with an ellipsis. */
export const ARGUMENT_SUMMARY_CHARS = 160;
/** One paragraph of the model's text is shown as its last lines. */
export const TEXT_TAIL_LINES = 12;

/** Every block in reading order, a sub-agent's blocks after the tool call that started them. */
const flatten = (blocks: readonly TranscriptBlock[], into: TranscriptBlock[] = []) => {
  for (const block of blocks) {
    into.push(block);
    if (block.kind === 'tool') {
      flatten(block.children, into);
    }
  }
  return into;
};

type Draft = Omit<ActivityRow, 'state'> & { readonly state: RowState; readonly burst: boolean };

/**
 * The "Live activity" rows, oldest first, the newest {@link ACTIVITY_ROW_LIMIT}.
 *
 * - A tool call is one row, labelled by the vocabulary; it is `error` when its result says so, and
 *   `done` once a result arrived.
 * - Consecutive thinking blocks are one "Thinking" row, consecutive text one "Writing" row — a
 *   burst, timed at its first block.
 * - A `report_progress` line is "Reporting progress"; a hook that asked a person is "Waiting for
 *   permission" (`needs_you`). Everything else (system notices, results, steers, compactions)
 *   says nothing about what the agent did and is passed over.
 * - While the run is `live`, its newest row is `current` unless it already failed: that is what
 *   the agent is doing now.
 */
export const activityRows = (
  blocks: readonly TranscriptBlock[],
  options: { readonly live: boolean },
): readonly ActivityRow[] => {
  const rows: Draft[] = [];
  const push = (draft: Draft): void => {
    const last = rows.at(-1);
    if (draft.burst && last?.burst === true && last.label === draft.label) {
      return;
    }
    rows.push(draft);
  };
  for (const block of flatten(blocks)) {
    switch (block.kind) {
      case 'tool':
        push({
          key: block.id,
          at: block.at,
          activity: 'working',
          label: toolActivityLabel(block.toolName),
          state: block.result?.isError === true ? 'error' : 'done',
          burst: false,
        });
        break;
      case 'thinking':
        push({
          key: block.id,
          at: block.at,
          activity: 'thinking',
          label: 'Thinking',
          state: 'done',
          burst: true,
        });
        break;
      case 'text':
        push({
          key: block.id,
          at: block.at,
          activity: 'thinking',
          label: 'Writing',
          state: 'done',
          burst: true,
        });
        break;
      case 'progress':
        push({
          key: block.id,
          at: block.at,
          activity: 'working',
          label: 'Reporting progress',
          state: 'done',
          burst: false,
        });
        break;
      case 'hook':
        if (block.decision === 'ask') {
          push({
            key: block.id,
            at: block.at,
            activity: 'needs_you',
            label: 'Waiting for permission',
            state: 'needs_you',
            burst: false,
          });
        }
        break;
      default:
        break;
    }
  }
  const kept = rows.slice(-ACTIVITY_ROW_LIMIT);
  return kept.map(({ burst: _burst, ...row }, index) =>
    options.live && index === kept.length - 1 && row.state === 'done'
      ? { ...row, state: 'current' as const }
      : row,
  );
};

export type LogTone = 'command' | 'output' | 'error' | 'text' | 'note';

export interface LogLine {
  readonly key: string;
  readonly tone: LogTone;
  /** Platform text only, a fixed glyph: `$ `, `› `, `▸ progress: `. */
  readonly prefix: string;
  /** The run's own text — untrusted. */
  readonly text: string;
}

/** The input keys a tool's call is best summarised by, in the order they are looked for. */
const SUMMARY_KEYS = [
  'command',
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
];

const oneLine = (value: string): string => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > ARGUMENT_SUMMARY_CHARS
    ? `${flat.slice(0, ARGUMENT_SUMMARY_CHARS - 1)}…`
    : flat;
};

/** A tool call in one line: its command, its path, its pattern … or its input as JSON. */
export const argumentSummary = (input: Readonly<Record<string, unknown>>): string => {
  for (const key of SUMMARY_KEYS) {
    const value = Object.hasOwn(input, key) ? input[key] : undefined;
    if (typeof value === 'string' && value.trim() !== '') {
      return oneLine(value);
    }
  }
  const json = JSON.stringify(input);
  return json === '{}' ? '' : oneLine(json);
};

const tail = (value: string, lines: number): string[] => {
  const all = value.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  return all.slice(-lines);
};

/**
 * The log: each tool call on one line with its argument summary (`$ pnpm test`, `› Read
 * src/retry.ts` — the prefix `› `, the tool's name in the text), the last {@link OUTPUT_TAIL_LINES} lines of its output beneath it, the model's text
 * as its last lines, a progress line, a steer — the newest {@link LOG_LINE_LIMIT}. A thinking block
 * shows only that the model thought, not what: the run page has the whole transcript.
 */
export const logLines = (blocks: readonly TranscriptBlock[]): readonly LogLine[] => {
  const lines: LogLine[] = [];
  for (const block of flatten(blocks)) {
    switch (block.kind) {
      case 'tool': {
        const bash = block.toolName === 'Bash' || block.toolName === 'BashOutput';
        const summary = argumentSummary(block.input);
        lines.push({
          key: `${block.id}:call`,
          tone: 'command',
          prefix: bash ? '$ ' : '› ',
          // The tool's name is the run's text like its arguments: in `text`, never in `prefix`.
          text: bash ? summary : summary === '' ? block.toolName : `${block.toolName} ${summary}`,
        });
        if (block.result !== null && block.result.content !== '') {
          const tone: LogTone = block.result.isError ? 'error' : 'output';
          tail(block.result.content, OUTPUT_TAIL_LINES).forEach((text, index) => {
            lines.push({ key: `${block.id}:out:${index}`, tone, prefix: '  ', text });
          });
        }
        break;
      }
      case 'text':
        tail(block.text, TEXT_TAIL_LINES).forEach((text, index) => {
          lines.push({ key: `${block.id}:text:${index}`, tone: 'text', prefix: '', text });
        });
        break;
      case 'thinking':
        lines.push({ key: block.id, tone: 'note', prefix: '… thinking', text: '' });
        break;
      case 'progress':
        lines.push({ key: block.id, tone: 'note', prefix: '▸ progress: ', text: block.summary });
        break;
      case 'steer':
        lines.push({ key: block.id, tone: 'note', prefix: '» steer: ', text: block.message });
        break;
      case 'result':
        lines.push({ key: block.id, tone: 'note', prefix: '— the run ended', text: '' });
        break;
      default:
        break;
    }
  }
  return lines.slice(-LOG_LINE_LIMIT);
};

/** "4:39 PM": the activity row's time, in the reader's locale-independent English (technical/09). */
export const clockTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ''
    : new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(at);
};
