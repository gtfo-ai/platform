/**
 * The activity vocabulary (TD-033 decision 6): one activity per input, by the rules in
 * `activity.ts`'s docblock, asked in that order — each row below names the rule it exercises, and
 * the boundary rows sit on both sides of `STUCK_AFTER_MS`.
 */
import {
  agentRoleSchema,
  runStatusSchema,
  runTerminalReasonSchema,
  taskStateSchema,
} from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TranscriptBlock } from '../transcript/blocks.js';
import {
  ACTIVITIES,
  ACTIVITY_META,
  type ActivityInput,
  activityFromBlocks,
  activityOf,
  type LatestEntry,
  STUCK_AFTER_MS,
  toolActivityLabel,
} from './activity.js';
import { STATUS_LOOK } from './status.js';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const entry = (kind: LatestEntry['kind'], toolName: string | null = null, age = 1_000) => ({
  kind,
  tool_name: toolName,
  at: ago(age),
});
const running = { status: 'running', terminal_reason: null, started_at: ago(60_000) } as const;

const CASES: readonly (readonly [string, ActivityInput, string, string | null])[] = [
  // 1. needs you
  [
    'an open question',
    { run: running, latest: entry('tool', 'Read'), open_asks: 1, now: NOW },
    'needs_you',
    null,
  ],
  [
    'waiting for answers',
    { run: null, task_state: 'waiting_answers', now: NOW },
    'needs_you',
    null,
  ],
  [
    'waiting for approval',
    { run: null, task_state: 'waiting_approval', now: NOW },
    'needs_you',
    null,
  ],
  [
    'needs a person',
    { run: { status: 'failed' }, task_state: 'needs_human', now: NOW },
    'needs_you',
    null,
  ],
  [
    'a tool waiting for permission, however old',
    { run: running, latest: entry('waiting_permission', 'Bash', STUCK_AFTER_MS * 3), now: NOW },
    'needs_you',
    'Asking to use Bash',
  ],
  // 2. paused
  ['a paused task', { run: null, task_state: 'paused', now: NOW }, 'paused', null],
  [
    'a free seat on a paused worker',
    { run: null, seat: true, worker: 'paused', now: NOW },
    'paused',
    null,
  ],
  [
    'a free seat on a draining worker',
    { run: null, seat: true, worker: 'draining', now: NOW },
    'paused',
    'Draining',
  ],
  [
    'a live run on a draining worker still works',
    { run: running, latest: entry('tool', 'Edit'), worker: 'draining', now: NOW },
    'working',
    'Editing code',
  ],
  // 3. ended
  [
    'a completed run',
    { run: { status: 'completed', terminal_reason: 'success' }, now: NOW },
    'done',
    null,
  ],
  [
    'a failed run',
    { run: { status: 'failed', terminal_reason: 'crash' }, now: NOW },
    'failed',
    null,
  ],
  ['a run over budget', { run: { status: 'budget_exceeded' }, now: NOW }, 'failed', null],
  ['a timed-out run', { run: { status: 'timed_out' }, now: NOW }, 'failed', null],
  [
    'a cancelled run',
    { run: { status: 'cancelled', terminal_reason: 'cancelled' }, now: NOW },
    'idle',
    'Cancelled',
  ],
  [
    'a run handed back on shutdown',
    { run: { status: 'cancelled', terminal_reason: 'shutdown' }, now: NOW },
    'waiting',
    'Will be offered again',
  ],
  [
    'a run a usage limit ended',
    { run: { status: 'failed', terminal_reason: 'rate_limited' }, now: NOW },
    'waiting',
    'Will be offered again',
  ],
  // 4. live
  ['a created run', { run: { status: 'created' }, now: NOW }, 'waiting', 'Starting'],
  ['a starting run', { run: { status: 'starting' }, now: NOW }, 'waiting', 'Starting'],
  [
    'a late lease',
    { run: running, latest: entry('tool', 'Read'), lease_late: true, now: NOW },
    'stuck',
    'Its worker is late',
  ],
  ['a fresh run with no entry', { run: running, latest: null, now: NOW }, 'working', 'Starting up'],
  [
    'a run silent since it started',
    {
      run: { status: 'running', started_at: ago(STUCK_AFTER_MS + 60_000) },
      latest: null,
      now: NOW,
    },
    'stuck',
    'No activity for 6 min',
  ],
  [
    'a run with no start time and no entry',
    { run: { status: 'running', started_at: null }, latest: null, now: NOW },
    'working',
    'Starting up',
  ],
  [
    'an entry just past the threshold',
    { run: running, latest: entry('tool', 'Read', STUCK_AFTER_MS + 1), now: NOW },
    'stuck',
    'No activity for 5 min',
  ],
  [
    'an entry exactly at the threshold',
    { run: running, latest: entry('tool', 'Read', STUCK_AFTER_MS), now: NOW },
    'working',
    'Reading files',
  ],
  [
    'a tool call',
    { run: running, latest: entry('tool', 'Grep'), now: NOW },
    'working',
    'Reading files',
  ],
  [
    'thinking',
    { run: running, latest: entry('thinking'), role: 'developer', now: NOW },
    'thinking',
    null,
  ],
  [
    'a planning role thinking',
    { run: running, latest: entry('thinking'), role: 'product_manager', now: NOW },
    'thinking',
    'Brainstorming',
  ],
  [
    'assistant text',
    { run: running, latest: entry('text'), role: 'architect', now: NOW },
    'thinking',
    'Brainstorming',
  ],
  [
    'a progress report',
    { run: running, latest: entry('progress'), now: NOW },
    'working',
    'Reporting progress',
  ],
  ['something else', { run: running, latest: entry('other'), now: NOW }, 'working', null],
  // 5. no run
  ['a free seat', { run: null, seat: true, now: NOW }, 'idle', null],
  ['a queued task', { run: null, task_state: 'queued', now: NOW }, 'waiting', null],
  [
    'a task ready to merge',
    { run: null, task_state: 'ready_for_merge', now: NOW },
    'waiting',
    null,
  ],
  ['a merged task', { run: null, task_state: 'merged', now: NOW }, 'done', null],
  ['a done task', { run: null, task_state: 'done', now: NOW }, 'done', null],
  ['a cancelled task', { run: null, task_state: 'cancelled', now: NOW }, 'idle', 'Cancelled'],
  ['nothing at all', { run: null, now: NOW }, 'waiting', null],
];

describe('activityOf', () => {
  it.each(CASES)('%s', (_name, input, activity, detail) => {
    expect(activityOf(input)).toEqual({ activity, detail });
  });

  it('is total: every input yields exactly one of the nine activities', () => {
    const iso = fc.integer({ min: 0, max: 30 * 60_000 }).map(ago);
    const arbitrary = fc.record(
      {
        run: fc.option(
          fc.record({
            status: fc.constantFrom(...runStatusSchema.options),
            terminal_reason: fc.option(fc.constantFrom(...runTerminalReasonSchema.options)),
            started_at: fc.option(fc.oneof(iso, fc.constant('not a date'))),
          }),
        ),
        seat: fc.boolean(),
        latest: fc.option(
          fc.record({
            kind: fc.constantFrom(
              'tool',
              'thinking',
              'text',
              'waiting_permission',
              'progress',
              'other',
            ),
            tool_name: fc.option(fc.string({ maxLength: 40 })),
            at: fc.oneof(iso, fc.constant('')),
          }),
        ),
        role: fc.option(fc.constantFrom(...agentRoleSchema.options)),
        task_state: fc.option(fc.constantFrom(...taskStateSchema.options)),
        open_asks: fc.nat({ max: 3 }),
        worker: fc.option(
          fc.constantFrom('active', 'paused', 'draining') as fc.Arbitrary<
            'active' | 'paused' | 'draining'
          >,
        ),
        lease_late: fc.boolean(),
        now: fc.constant(NOW),
      },
      { requiredKeys: ['run', 'now'] },
    );
    fc.assert(
      fc.property(arbitrary, (input) => {
        const { activity, detail } = activityOf(input as ActivityInput);
        expect(ACTIVITIES).toContain(activity);
        expect(detail === null || (typeof detail === 'string' && detail.length > 0)).toBe(true);
      }),
    );
  });
});

describe('toolActivityLabel', () => {
  it.each([
    ['Read', 'Reading files'],
    ['Grep', 'Reading files'],
    ['Glob', 'Reading files'],
    ['LS', 'Reading files'],
    ['Edit', 'Editing code'],
    ['Write', 'Editing code'],
    ['MultiEdit', 'Editing code'],
    ['NotebookEdit', 'Editing code'],
    ['Bash', 'Running a command'],
    ['BashOutput', 'Running a command'],
    ['WebFetch', 'Searching the web'],
    ['WebSearch', 'Searching the web'],
    ['Task', 'Delegating to a sub-agent'],
    ['Agent', 'Delegating to a sub-agent'],
    ['TodoWrite', 'Planning'],
    ['mcp__agentic__kb_search', 'Searching the knowledge base'],
    ['mcp__agentic__report_progress', 'Reporting progress'],
    ['mcp__agentic__get_task_context', 'Using get_task_context'],
    ['mcp__my_server__open_mr', 'Using open_mr'],
    ['SlashCommand', 'Using SlashCommand'],
    // Exact names only: a prefix or a different case is some other tool.
    ['read', 'Using read'],
    ['Reader', 'Using Reader'],
  ])('%s → %s', (name, label) => {
    expect(toolActivityLabel(name)).toBe(label);
  });
});

describe('ACTIVITY_META', () => {
  it('gives every activity a word, a known icon and a pose, and no two the same word', () => {
    expect(Object.keys(ACTIVITY_META)).toEqual([...ACTIVITIES]);
    for (const activity of ACTIVITIES) {
      const meta = ACTIVITY_META[activity];
      expect(Object.hasOwn(STATUS_LOOK, meta.icon)).toBe(true);
      expect(meta.label.length).toBeGreaterThan(0);
    }
    expect(new Set(ACTIVITIES.map((activity) => ACTIVITY_META[activity].label)).size).toBe(
      ACTIVITIES.length,
    );
    expect(ACTIVITY_META.needs_you.pose).toBe('raise_hand');
    expect(ACTIVITY_META.stuck.pose).toBe('confused');
  });
});

const AT = (minute: number): string => `2026-11-05T12:${String(minute).padStart(2, '0')}:00.000Z`;
const base = (seq: number, minute: number) => ({ id: `${seq}`, seq, at: AT(minute) });
const tool = (seq: number, minute: number, toolName: string, children: TranscriptBlock[] = []) =>
  ({
    ...base(seq, minute),
    kind: 'tool',
    toolUseId: `toolu_${seq}`,
    toolName,
    input: {},
    result: null,
    children,
  }) as TranscriptBlock;
const thinking = (seq: number, minute: number) =>
  ({ ...base(seq, minute), kind: 'thinking', text: 'hmm', streaming: false }) as TranscriptBlock;
const hook = (seq: number, minute: number, toolName: string | null, decision: string | null) =>
  ({
    ...base(seq, minute),
    kind: 'hook',
    hook: 'PreToolUse',
    toolName,
    decision,
    reason: null,
    questionId: null,
  }) as TranscriptBlock;
const system = (seq: number, minute: number) =>
  ({
    ...base(seq, minute),
    kind: 'system',
    subtype: 'init',
    model: null,
    data: {},
  }) as TranscriptBlock;

describe('activityFromBlocks', () => {
  it('is null for an empty transcript', () => {
    expect(activityFromBlocks([])).toBeNull();
  });

  it('reads the latest block by seq', () => {
    expect(activityFromBlocks([thinking(1, 0), tool(2, 1, 'Read')])).toEqual({
      kind: 'tool',
      tool_name: 'Read',
      at: AT(1),
    });
    expect(activityFromBlocks([tool(1, 0, 'Read'), thinking(2, 1)])).toEqual({
      kind: 'thinking',
      tool_name: null,
      at: AT(1),
    });
  });

  it('reads the last block of one message', () => {
    const sameMessage = [thinking(3, 2), tool(3, 2, 'Edit')];
    expect(activityFromBlocks(sameMessage)?.tool_name).toBe('Edit');
  });

  it('reads a sub-agent’s latest call inside the tool that started it', () => {
    const blocks = [tool(1, 0, 'Task', [tool(2, 1, 'Grep'), tool(4, 3, 'Bash')]), thinking(3, 2)];
    expect(activityFromBlocks(blocks)).toEqual({ kind: 'tool', tool_name: 'Bash', at: AT(3) });
  });

  it('turns a permission ask into waiting_permission, and keeps a tool’s own hook that tool', () => {
    expect(activityFromBlocks([tool(1, 0, 'Bash'), hook(2, 1, 'Bash', 'ask')])).toEqual({
      kind: 'waiting_permission',
      tool_name: 'Bash',
      at: AT(1),
    });
    expect(activityFromBlocks([thinking(1, 0), hook(2, 1, 'Read', 'allow')])).toEqual({
      kind: 'tool',
      tool_name: 'Read',
      at: AT(1),
    });
  });

  it('passes over blocks that say nothing, but dates the entry by the newest block', () => {
    expect(activityFromBlocks([tool(1, 0, 'Read'), hook(2, 4, null, null), system(3, 7)])).toEqual({
      kind: 'tool',
      tool_name: 'Read',
      at: AT(7),
    });
    expect(activityFromBlocks([system(1, 2)])).toEqual({
      kind: 'other',
      tool_name: null,
      at: AT(2),
    });
  });

  it('feeds activityOf: a sub-agent reading files is working, a silent one is stuck', () => {
    const blocks = [tool(1, 0, 'Task', [tool(2, 1, 'Grep')])];
    const latest = activityFromBlocks(blocks);
    const at = (minute: number) => Date.parse(AT(minute));
    expect(activityOf({ run: running, latest, now: at(3) })).toEqual({
      activity: 'working',
      detail: 'Reading files',
    });
    expect(activityOf({ run: running, latest, now: at(7) }).activity).toBe('stuck');
  });
});
