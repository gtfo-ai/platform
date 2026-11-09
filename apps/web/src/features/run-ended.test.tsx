/**
 * **Why this run ended** (S-25.19): the run page's *Ended* panel for every terminal reason a started
 * run can have — what it means, what the platform did next, the next step for a reader who may take
 * it, and *Jump to the last lines*.
 *
 * Driven through `createApp` with a fake server, as `run-page.test.tsx` is: the real router, query
 * client and endpoint parsers (`runReadResponseSchema`, `taskDetailResponseSchema`), so a fixture the
 * client cannot parse fails here rather than reading as a page with no panel.
 */

import type {
  RunReadResponse,
  RunRecord,
  RunTerminalReason,
  TaskDetailResponse,
  TranscriptEvent,
} from '@platform/contracts';
import { runTerminalReasonSchema } from '@platform/contracts';
import { PERMISSION_REQUIREMENTS } from '@platform/domain';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { TERMINAL_REASON_LABEL, TERMINAL_REASON_MEANING } from '../ui/humanize.js';
import { primaryLabels } from '../ui/primary-census.js';
import { endedFollowUp, endedPanelReason } from './run-ended.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const RUN = '00000000-0000-4000-8000-0000000000c1';
const LATER = '00000000-0000-4000-8000-0000000000c2';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

/** The run status each terminal reason is recorded with. */
const STATUS_OF: Readonly<Record<RunTerminalReason, RunRecord['status']>> = {
  success: 'completed',
  error_max_turns: 'failed',
  error_max_budget_usd: 'budget_exceeded',
  error_max_structured_output_retries: 'failed',
  error_during_execution: 'failed',
  permission_denied: 'failed',
  cancelled: 'cancelled',
  stalled: 'stalled',
  timed_out: 'timed_out',
  crash: 'failed',
  lease_expired: 'failed',
  shutdown: 'failed', // WP-144: a hand-back ends `failed`, not `cancelled`
  rate_limited: 'failed',
};

const runOf = (reason: RunTerminalReason | null, over: Partial<RunRecord> = {}): RunRecord => ({
  id: RUN,
  task_id: TASK,
  project_id: PROJECT,
  stage: 'implementation',
  role: 'developer',
  mode: 'normal',
  attempt: 1,
  session_id: null,
  model: 'claude-test',
  effort: 'high',
  provider_mode: 'api',
  prompt_version: 'developer@9.9.9',
  status: reason === null ? 'running' : STATUS_OF[reason],
  terminal_reason: reason,
  started_at: '2026-11-05T10:00:00.000Z',
  ended_at: reason === null ? null : '2026-11-05T10:05:00.000Z',
  last_output_at: null,
  num_turns: 4,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  model_usage: [],
  cost: { usd: 0.2, is_estimate: false, price_list_id: null },
  wall_ms: 1_000,
  redaction_count: 0,
  settings_hash: null,
  start_failure: null,
  saved_work: null,
  stop_reason: null,
  latest_progress: null,
  ...over,
});

const detail = (
  over: Partial<TaskDetailResponse> = {},
  state: TaskDetailResponse['task']['state'] = 'active',
): TaskDetailResponse => ({
  task: {
    id: TASK,
    project_id: PROJECT,
    ticket: { provider: 'jira', key: 'ACME-12', url: 'https://jira.example.test/browse/ACME-12' },
    ticket_title: 'Add VAT',
    template: 'feature',
    mode: 'normal',
    state,
    current_stage: 'implementation',
    size: null,
    branch: null,
    mr_ref: null,
    workpad_ref: null,
    iteration_counters: {},
    risk_classes: [],
    coverage: null,
    dependencies: null,
    required_reviewers: null,
    review_threads: null,
    conflict: null,
    cost_actual_usd: 0.2,
    unmeasured_runs: 0,
    budget_cap_usd: 50,
    paused_reason: null,
    paused_budget_scope: null,
    cost_estimated_usd: 0,
    estimate_usd: null,
    estimate_basis: null,
    estimate_samples: null,
    estimate_accuracy: null,
    requested_by_user_id: null,
    requested_by_identity: null,
    created_at: '2026-11-05T07:00:00.000Z',
    updated_at: '2026-11-05T07:00:00.000Z',
    completed_at: null,
    ticket_claim: null,
    qa_stage: false,
    tracker_assignee: null,
    owner: null,
    owner_source: null,
    unlinked_assignee: null,
    owner_writes_back: false,
    waiting: null,
  },
  taken_over: null,
  can_raise_budget: false,
  can_export: false,
  can_pause: true,
  can_resume: true,
  can_cancel: true,
  can_return: true,
  can_rework: true,
  can_decide_approval: true,
  can_take: false,
  can_change_limits: false,
  can_retry_run: true,
  can_take_over: true,
  can_assign: false,
  can_unassign: false,
  take_writes_back: false,
  gate_feedback: null,
  returns: [],
  stop: null,
  gate_wait: null,
  last_gate_wait: null,
  escalation: null,
  loop_limits: null,
  human_time: {
    total_minutes: 0,
    by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
    by_user: null,
    entries: 0,
    withheld: { entries: 0, minutes: 0 },
  },
  stages: [
    {
      stage: 'implementation',
      attempt: 1,
      state: 'completed',
      entered_at: '2026-11-05T09:45:00.000Z',
      exited_at: null,
      outcome: null,
    },
  ],
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [],
  ...over,
});

const envelope = { run_id: RUN, parent_tool_use_id: null, redaction_count: 0 } as const;

/** A Bash call the run never answered, then the platform's own stop. */
const lastLines = (stopReason: string | null = null): TranscriptEvent[] =>
  [
    {
      ...envelope,
      kind: 'assistant',
      seq: 1,
      created_at: '2026-11-05T10:00:01.000Z',
      model: 'claude-test',
      content: [
        {
          type: 'tool_use',
          tool_use_id: 'bash-1',
          tool_name: 'Bash',
          input: { command: 'pnpm test invoice' },
        },
      ],
    },
    ...(stopReason === null
      ? []
      : [
          {
            ...envelope,
            kind: 'system',
            seq: 2,
            created_at: '2026-11-05T10:04:00.000Z',
            subtype: 'run_stopped',
            session_id: null,
            model: null,
            data: { reason: stopReason },
          },
        ]),
  ] as TranscriptEvent[];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const asRead = (record: RunRecord): RunReadResponse => ({
  ...record,
  retry_defaults: record.stage === null ? null : { model: record.model, effort: record.effort },
});

interface World {
  readonly run: RunRecord;
  readonly task: TaskDetailResponse;
  readonly messages: TranscriptEvent[];
  readonly retries: unknown[];
}

const fetchFor = (world: World) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (init?.method === 'POST' && path === `/api/runs/${RUN}/retry`) {
      world.retries.push(JSON.parse(String(init.body)));
      return json({
        run_id: RUN,
        task_id: TASK,
        status: world.run.status,
        task_state: 'active',
        performed: true,
      });
    }
    if (path === `/api/runs/${RUN}/messages`)
      return json({ items: world.messages, next_seq: null });
    if (path === `/api/runs/${RUN}/commands`) return json({ items: [] });
    if (path === `/api/runs/${RUN}`) return json(asRead(world.run));
    if (path === `/api/tasks/${TASK}`) return json(world.task);
    if (path === '/api/projects') return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

const open = (
  run: RunRecord,
  task: TaskDetailResponse = detail(),
  messages: TranscriptEvent[] = lastLines(),
): World => {
  const world: World = { run, task: { ...task, runs: [run, ...task.runs] }, messages, retries: [] };
  window.history.pushState({}, '', `/runs/${RUN}`);
  render(createApp({ fetchImpl: fetchFor(world), realtime: false }).element);
  return world;
};

const panel = () => screen.findByRole('region', { name: 'Why this run ended' });

/** The panel once the task read has answered (its follow-up line is drawn from it). */
const settledPanel = async (): Promise<HTMLElement> => {
  const region = await panel();
  await waitFor(() => {
    expect(region.querySelector('[data-run-ended-next]')).not.toBeNull();
  });
  return region;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const ENDINGS = runTerminalReasonSchema.options.filter((reason) => reason !== 'success');

describe('the Ended panel, per terminal reason', () => {
  it.each(ENDINGS)('says what %s means, in words, with the next steps', async (reason) => {
    open(runOf(reason));
    const region = await settledPanel();
    expect(within(region).getByRole('heading', { level: 2 }).textContent).toBe(
      `This run ended: ${TERMINAL_REASON_LABEL[reason]}`,
    );
    expect(region.textContent).toContain(TERMINAL_REASON_MEANING[reason]);
    // Plain words: no raw enum (a snake_case reason's own spelling) reaches the panel.
    expect(region.textContent).not.toMatch(/[a-z]_[a-z]/);
    expect(within(region).getByRole('link', { name: 'Open the task' }).getAttribute('href')).toBe(
      `/tasks/${TASK}`,
    );
    expect(within(region).getByRole('button', { name: 'Re-run as configured' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Work on it yourself…' })).toBeTruthy();
    expect(
      await within(region).findByRole('button', { name: 'Jump to the last lines' }),
    ).toBeTruthy();
    // A neutral box for an ending nothing went wrong in, the danger box otherwise.
    expect(region.className.includes('border-danger')).toBe(
      !['cancelled', 'shutdown', 'rate_limited'].includes(reason),
    );
    // Every button is a secondary: the header's Re-run stays the page's one primary.
    expect(primaryLabels(region)).toEqual([]);
  });

  it('covers every ending but success, and nothing else', () => {
    for (const reason of runTerminalReasonSchema.options) {
      expect(endedPanelReason(runOf(reason)), reason).toBe(reason === 'success' ? null : reason);
    }
  });

  it('is not shown for a live run, a success, a run that never started, or a completed one past its cap', () => {
    expect(endedPanelReason(runOf(null))).toBeNull();
    expect(endedPanelReason(runOf('success'))).toBeNull();
    expect(
      endedPanelReason(
        runOf('error_during_execution', {
          start_failure: {
            kind: 'not_started',
            diagnosis: 'RunStartError: workspace_failed',
            detail: null,
            truncated: false,
            attempt: 1,
            retryable: false,
          },
        }),
      ),
    ).toBeNull();
    expect(endedPanelReason(runOf('error_max_budget_usd', { status: 'completed' }))).toBeNull();
    expect(endedPanelReason(runOf('crash', { terminal_reason: null }))).toBeNull();
  });

  it('shows no panel on the page of a run that succeeded', async () => {
    open(runOf('success'));
    expect(await screen.findByTestId('transcript-scroller')).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Why this run ended' })).toBeNull();
  });
});

describe('what the platform did next', () => {
  it('links the newer attempt of the same stage', async () => {
    const later = runOf('success', { id: LATER, attempt: 2 });
    open(runOf('lease_expired'), detail({ runs: [later] }));
    const region = await settledPanel();
    expect(region.querySelector('[data-run-ended-next]')?.getAttribute('data-run-ended-next')).toBe(
      'ran_again',
    );
    expect(region.textContent).toContain('The stage was run again: attempt 2, completed.');
    expect(within(region).getByRole('link', { name: 'Open attempt 2' }).getAttribute('href')).toBe(
      `/runs/${LATER}`,
    );
  });

  /**
   * The review of #125: `settleRun` re-runs a hand-back at shutdown and a usage limit's re-plan as
   * the **same** attempt (`enqueueFollowOn`, `attempt: run.attempt`), so a higher attempt alone
   * missed exactly those, said *Nothing else has happened since* beside a live replacement and still
   * offered *Re-run*.
   */
  it.each(['shutdown', 'rate_limited'] as const)(
    'links the same attempt started again after %s, and offers no Re-run while it is live',
    async (reason) => {
      const again = runOf(null, { id: LATER, attempt: 1, started_at: '2026-11-05T10:06:00.000Z' });
      open(runOf(reason), detail({ runs: [again] }));
      const region = await settledPanel();
      expect(
        region.querySelector('[data-run-ended-next]')?.getAttribute('data-run-ended-next'),
      ).toBe('ran_again');
      expect(region.textContent).toContain('The stage was started again and is running.');
      expect(region.textContent).not.toContain('attempt 1');
      expect(region.textContent).not.toContain('Nothing else has happened since');
      expect(
        within(region).getByRole('link', { name: 'Open the new run' }).getAttribute('href'),
      ).toBe(`/runs/${LATER}`);
      expect(within(region).queryByRole('button', { name: 'Re-run as configured' })).toBeNull();
    },
  );

  it('offers Re-run again once the same attempt’s re-run has ended too', async () => {
    const again = runOf('shutdown', {
      id: LATER,
      attempt: 1,
      started_at: '2026-11-05T10:06:00.000Z',
    });
    open(runOf('shutdown'), detail({ runs: [again] }));
    const region = await settledPanel();
    expect(region.textContent).toContain('The stage was started again: failed.');
    expect(within(region).getByRole('button', { name: 'Re-run as configured' })).toBeTruthy();
  });

  it('counts a run of the same stage only when it started after this one', () => {
    const run = runOf('shutdown');
    const same = (over: Partial<RunRecord>) =>
      endedFollowUp(run, detail({ runs: [runOf('crash', { id: LATER, attempt: 1, ...over })] }))
        ?.kind;
    expect(same({ started_at: '2026-11-05T10:06:00.000Z' })).toBe('ran_again');
    // The same attempt started earlier — the run this one replaced — is not "again".
    expect(same({ started_at: '2026-11-05T09:00:00.000Z' })).toBe('nothing');
    // Not started yet: again only while it is live (an offer nobody claimed).
    expect(same({ started_at: null, status: 'created', terminal_reason: null })).toBe('ran_again');
    expect(same({ started_at: null })).toBe('nothing');
    // Another stage's run never is.
    expect(same({ stage: 'review', started_at: '2026-11-05T10:06:00.000Z' })).toBe('nothing');
  });

  it('names the stage the task is at when it is no longer this run’s', async () => {
    const moved = detail({}, 'needs_human');
    open(runOf('crash'), { ...moved, task: { ...moved.task, current_stage: 'code_review' } });
    const region = await settledPanel();
    expect(region.textContent).toContain(
      'The task has since moved on to Code review, and stopped for a person there.',
    );
    expect(region.textContent).not.toContain('The task stopped for a person:');
  });

  it('says the task stopped for a person, or that nothing has happened since', async () => {
    open(runOf('crash'), detail({}, 'needs_human'));
    expect((await settledPanel()).textContent).toContain('The task stopped for a person');
    cleanup();

    open(runOf('crash'));
    expect((await settledPanel()).textContent).toContain('Nothing else has happened since');
  });

  it('reads the task, never the reason', () => {
    const task = detail();
    const run = runOf('stalled');
    expect(endedFollowUp(run, undefined)).toBeNull();
    expect(endedFollowUp({ ...run, stage: null }, task)?.kind).toBe('ask');
    expect(endedFollowUp(run, detail({}, 'paused'))?.kind).toBe('paused');
    expect(endedFollowUp(run, detail({}, 'done'))?.kind).toBe('finished');
    // An earlier attempt, or another stage's run, is not "ran again".
    const earlier = runOf('success', { id: LATER, attempt: 1, stage: 'refinement' });
    expect(endedFollowUp({ ...run, attempt: 2 }, detail({ runs: [earlier] }))?.kind).toBe(
      'nothing',
    );
  });
});

describe('the next step, only for a reader who may take it', () => {
  it('offers Re-run and Work on it yourself to a member, and they do what they say', async () => {
    const user = userEvent.setup();
    const world = open(runOf('stalled'));
    const region = await settledPanel();
    await user.click(within(region).getByRole('button', { name: 'Re-run as configured' }));
    // The same command as the header's *Re-run as configured*: an empty body, the stage's configuration.
    await waitFor(() => {
      expect(world.retries).toEqual([{}]);
    });
    await user.click(within(region).getByRole('button', { name: 'Work on it yourself…' }));
    expect(await screen.findByRole('dialog', { name: 'Work on this task yourself' })).toBeTruthy();
  });

  it('offers neither to a viewer, whose role may not, and still opens the task', async () => {
    // S-25.21: the read's own facts for the two commands, with `can_pause` left true so the panel
    // is shown not to read it any more.
    open(runOf('stalled'), detail({ can_retry_run: false, can_take_over: false }));
    const region = await settledPanel();
    expect(within(region).queryByRole('button', { name: 'Re-run as configured' })).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Work on it yourself…' })).toBeNull();
    expect(within(region).getByRole('link', { name: 'Open the task' })).toBeTruthy();
  });

  it('reads each command’s own fact: a re-run without the take-over, and the take-over alone', async () => {
    open(runOf('stalled'), detail({ can_retry_run: true, can_take_over: false }));
    let region = await settledPanel();
    expect(within(region).getByRole('button', { name: 'Re-run as configured' })).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Work on it yourself…' })).toBeNull();
    cleanup();
    open(runOf('stalled'), detail({ can_retry_run: false, can_take_over: true }));
    region = await settledPanel();
    expect(within(region).queryByRole('button', { name: 'Re-run as configured' })).toBeNull();
    expect(within(region).getByRole('button', { name: 'Work on it yourself…' })).toBeTruthy();
  });

  it('offers no Work on it yourself while a person already is, nor on a finished task', async () => {
    open(runOf('stalled'), detail({}, 'done'));
    const region = await settledPanel();
    expect(within(region).queryByRole('button', { name: 'Work on it yourself…' })).toBeNull();
    expect(within(region).getByRole('button', { name: 'Re-run as configured' })).toBeTruthy();
  });

  it('offers no Re-run for an ask, which has no stage to run again', async () => {
    open(runOf('crash', { stage: null, role: 'ask' }));
    const region = await settledPanel();
    expect(region.textContent).toContain('answered a question about the task');
    expect(within(region).queryByRole('button', { name: 'Re-run as configured' })).toBeNull();
  });

  /**
   * The run page's `···` *resume / give back…* (a task a person holds) rides on `can_take_over`,
   * because the read carries no fact for `task.hand_back` — honest only while the two need the same
   * role (S-25.21).
   */
  it('gates the give-back on a fact whose role is the hand-back’s', () => {
    expect(PERMISSION_REQUIREMENTS['task.hand_back']).toBe(
      PERMISSION_REQUIREMENTS['task.take_over'],
    );
  });
});

describe('the transcript’s own evidence', () => {
  it('names the tool a permission_denied run was refused, and opens its Settings tab', async () => {
    const user = userEvent.setup();
    const denied: TranscriptEvent = {
      ...envelope,
      kind: 'system',
      seq: 3,
      created_at: '2026-11-05T10:04:30.000Z',
      subtype: 'permission_denied',
      session_id: null,
      model: null,
      data: { tool_name: 'WebFetch\u202E<b>', message: 'not allowed' },
    } as TranscriptEvent;
    open(runOf('permission_denied'), detail(), [...lastLines(), denied]);
    const region = await settledPanel();
    await waitFor(() => {
      expect(region.textContent).toContain('The tool it was refused: WebFetch\uFFFD<b>.');
    });
    expect(region.querySelector('b')).toBeNull();
    await user.click(within(region).getByRole('button', { name: 'See the run’s settings' }));
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('says so when the transcript does not record the refused tool', async () => {
    open(runOf('permission_denied'));
    expect((await settledPanel()).textContent).toContain(
      'The transcript does not record which tool it was.',
    );
  });

  it('reads a budget stop the runner called cost_unreported as the fault it is', async () => {
    open(runOf('error_max_budget_usd'), detail(), lastLines('cost_unreported'));
    const region = await settledPanel();
    await waitFor(() => {
      expect(region.textContent).toContain('cost could not be measured');
    });
    expect(region.textContent).not.toContain(TERMINAL_REASON_MEANING.error_max_budget_usd);
  });

  it('jumps to the last lines: the transcript tab, its search cleared, the log focused', async () => {
    const user = userEvent.setup();
    open(runOf('crash'));
    const region = await settledPanel();
    // The unanswered Bash call reads *no result*, never *running* (S-25.19 (4)).
    await waitFor(() => {
      expect(document.querySelector('[data-step-timing]')?.textContent).toBe('no result');
    });
    await user.type(screen.getByRole('searchbox', { name: 'Search transcript' }), 'zzz');
    await user.click(await within(region).findByRole('button', { name: 'Jump to the last lines' }));
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(screen.getByTestId('transcript-scroller'));
  });
});
