/**
 * **A task that went back says why, and what happens next** (S-25.11, product/10's Task detail
 * amendment of 2026-11-07): the three states — fixing, stopped, not recorded — in the words of
 * `./setback.ts`, and the callout that carries them. Each state is asserted from both sides
 * (standing rule 42): the sentence appears exactly when the row says so, and not otherwise.
 *
 * The callout is rendered directly: its escalation and fixing branches touch no command, query or
 * route, so no app is needed around it.
 */
import type {
  TaskDetailResponse,
  TaskListItem,
  TaskRecord,
  TaskReturn,
  TaskStop,
} from '@platform/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cardSetback, SetbackLine } from './board-card.js';
import {
  jobsPhrase,
  openReturn,
  returnWords,
  setbackShort,
  stopWords,
  timelineReturnLine,
} from './setback.js';
import { TaskCallout } from './task-callout.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const RETURNED_AT = '2026-11-07T10:00:00.000Z';
const ENTERED_AFTER = '2026-11-07T10:00:00.120Z';
const ENTERED_BEFORE = '2026-11-07T09:59:00.000Z';
const LIMITS = { ci_fix: 3, code_review: 3 };

const ciReturn = (over: Partial<TaskReturn> = {}): TaskReturn => ({
  from_stage: 'ci_gate',
  attempt: 2,
  to_stage: 'implementation',
  to_role: 'developer',
  at: RETURNED_AT,
  outcome: 'returned',
  reason_recorded: true,
  ci_failure: { status: 'failed', jobs: 'unit' },
  loop: 'ci_fix',
  ...over,
});

type StageRow = TaskDetailResponse['stages'][number];

const row = (stage: string, attempt: number, state: StageRow['state'], at: string): StageRow => ({
  stage,
  attempt,
  state,
  entered_at: at,
  exited_at: state === 'running' ? null : at,
  outcome: state === 'returned' ? 'returned' : null,
});

/** Implementation attempt 3, entered just after CI attempt 2 sent the task back. */
const FIXING_STAGES: StageRow[] = [
  row('implementation', 2, 'completed', '2026-11-07T09:30:00.000Z'),
  row('ci_gate', 2, 'returned', '2026-11-07T09:40:00.000Z'),
  row('implementation', 3, 'running', ENTERED_AFTER),
];

const TASK: TaskRecord = {
  id: '00000000-0000-4000-8000-0000000000b1',
  project_id: '00000000-0000-4000-8000-0000000000a1',
  ticket: { provider: 'jira', key: 'ACME-12', url: 'https://jira.example.test/browse/ACME-12' },
  ticket_title: 'Add VAT to invoices',
  template: 'feature',
  mode: 'normal',
  state: 'active',
  current_stage: 'implementation',
  size: null,
  branch: null,
  mr_ref: {
    provider: 'gitlab',
    project_path: 'acme/api',
    iid: 7,
    url: 'https://git.example.invalid/acme/api/-/merge_requests/7',
  },
  workpad_ref: null,
  iteration_counters: { ci_fix: 2 },
  risk_classes: [],
  coverage: null,
  review_threads: null,
  dependencies: null,
  conflict: null,
  required_reviewers: null,
  cost_actual_usd: 1.2,
  unmeasured_runs: 0,
  budget_cap_usd: 5,
  paused_reason: null,
  paused_budget_scope: null,
  paused_budget_figures: null,
  cost_estimated_usd: 0,
  estimate_usd: null,
  estimate_basis: null,
  estimate_samples: null,
  estimate_accuracy: null,
  requested_by_user_id: null,
  requested_by_identity: null,
  created_at: RETURNED_AT,
  updated_at: RETURNED_AT,
  completed_at: null,
  ticket_claim: null,
  qa_stage: false,
  tracker_assignee: null,
  owner: null,
  owner_source: null,
  unlinked_assignee: null,
  owner_writes_back: false,
  waiting: null,
};

const detail = (
  over: Partial<TaskDetailResponse> = {},
  task: Partial<TaskRecord> = {},
): TaskDetailResponse => ({
  task: { ...TASK, ...task },
  taken_over: null,
  can_raise_budget: false,
  can_export: false,
  can_pause: true,
  can_resume: true,
  can_cancel: true,
  can_return: true,
  can_rework: true,
  can_decide_approval: true,
  can_change_limits: false,
  can_retry_run: true,
  can_take_over: true,
  can_take: false,
  can_assign: false,
  can_unassign: false,
  take_writes_back: false,
  gate_feedback: null,
  returns: [ciReturn()],
  stop: null,
  gate_wait: null,
  last_gate_wait: null,
  escalation: null,
  loop_limits: LIMITS,
  human_time: {
    total_minutes: 0,
    by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
    by_user: null,
    entries: 0,
    withheld: { entries: 0, minutes: 0 },
  },
  stages: FIXING_STAGES,
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [],
  ...over,
});

const renderCallout = (value: TaskDetailResponse) =>
  render(
    <TaskCallout
      detail={value}
      projectKey={null}
      merged={false}
      hasStages
      breakdownWaiting={false}
      // Neither branch under test touches a command (see the module note).
      commands={{} as never}
      onOpen={() => {}}
    />,
  );

afterEach(() => {
  cleanup();
});

const stop = (over: Partial<TaskStop> = {}): TaskStop => ({
  stage: 'ci_gate',
  attempt: 4,
  cause: 'same_failure',
  loop: null,
  ci_failure: { status: 'failed', jobs: 'unit' },
  recorded: null,
  recorded_cut: false,
  ci_ending: null,
  ...over,
});

describe('fixing: the agent is on it', () => {
  it('says the cause, who acts and the round, in one sentence with no action', () => {
    renderCallout(detail());
    const sentence = document.querySelector('[data-setback="fixing"]');
    expect(sentence?.textContent).toBe(
      'CI failed on the merge request (job unit): the Developer is fixing it (round 2 of 3).',
    );
    expect(sentence?.getAttribute('data-setback-recorded')).toBe('yes');
    // Nothing is asked of the reader: no Needs-you callout and no button.
    expect(screen.queryByTestId('needs-you-callout')).toBeNull();
    expect(screen.getByTestId('setback-notice').querySelectorAll('button')).toHaveLength(0);
  });

  it('is not said once the target stage is no longer the one being worked on', () => {
    // The other side: the same return, the task moved on to code review.
    renderCallout(
      detail(
        {
          stages: [...FIXING_STAGES, row('code_review', 1, 'running', '2026-11-07T11:00:00.000Z')],
        },
        { current_stage: 'code_review' },
      ),
    );
    expect(screen.queryByTestId('setback-notice')).toBeNull();
  });

  it('needs the attempt to have been entered after the return, and the task to be active', () => {
    const latest = ciReturn();
    const task = { ...TASK };
    expect(openReturn(task, FIXING_STAGES, latest)).toBe(latest);
    const before = [row('implementation', 3, 'running', ENTERED_BEFORE)];
    expect(openReturn(task, before, latest)).toBeNull();
    expect(openReturn({ ...task, state: 'paused' }, FIXING_STAGES, latest)).toBeNull();
    expect(openReturn({ ...task, state: 'needs_human' }, FIXING_STAGES, latest)).toBeNull();
    expect(openReturn(task, FIXING_STAGES, null)).toBeNull();
  });

  it('says no round when the row does not prove which rounds it spent, and no ceiling it does not know', () => {
    const task = { ...TASK };
    expect(returnWords(ciReturn({ loop: null }), task, LIMITS).sentence).toBe(
      'CI failed on the merge request (job unit): the Developer is fixing it.',
    );
    expect(returnWords(ciReturn(), task, null).sentence).toBe(
      'CI failed on the merge request (job unit): the Developer is fixing it (round 2).',
    );
    // A counter a person's decision reset to zero is no round at all.
    expect(returnWords(ciReturn(), { ...task, iteration_counters: {} }, LIMITS).short).toBe(
      'CI failed · fixing',
    );
  });

  it('has the board card’s short form', () => {
    expect(returnWords(ciReturn(), TASK, LIMITS).short).toBe('CI failed · fixing, round 2/3');
    const card = {
      ...TASK,
      stages: FIXING_STAGES.map(({ stage, attempt, state, entered_at }) => ({
        stage,
        attempt,
        state,
        entered_at,
      })),
      open_questions: 0,
      pending_approvals: 0,
      loop_limits: LIMITS,
      gate_wait: null,
      latest_return: ciReturn(),
      stop: null,
      escalation_reason: null,
    } satisfies TaskListItem;
    expect(cardSetback(card)).toBe('CI failed · fixing, round 2/3');
    expect(cardSetback({ ...card, latest_return: null })).toBeNull();
    // The fixing line asks nothing, so it is muted on the card; a stop keeps the attention tone.
    render(<SetbackLine task={card} />);
    const fixing = document.querySelector('[data-card-setback]');
    expect(fixing?.getAttribute('data-card-setback')).toBe('fixing');
    expect(fixing?.className).toContain('text-fg-muted');
    cleanup();
    render(
      <SetbackLine
        task={{
          ...card,
          state: 'needs_human',
          current_stage: 'ci_gate',
          stop: stop({ cause: 'no_answer', ci_failure: null }),
        }}
      />,
    );
    const stopped = document.querySelector('[data-card-setback]');
    expect(stopped?.getAttribute('data-card-setback')).toBe('stopped');
    expect(stopped?.className).toContain('text-attention');
  });

  it('gives the board card the CI wait’s endings from the stop alone (S-25.12)', () => {
    // The board's item carries no CI read (BACKLOG 1300): the card says what `stop` holds.
    const card = {
      ...TASK,
      state: 'needs_human' as const,
      current_stage: 'ci_gate',
      stages: [],
      open_questions: 0,
      pending_approvals: 0,
      loop_limits: LIMITS,
      gate_wait: null,
      latest_return: null,
      stop: stop({ cause: 'no_answer', ci_failure: null, ci_ending: 'ci_held_unchanged' }),
      escalation_reason: null,
    } satisfies TaskListItem;
    expect(cardSetback(card)).toBe('CI held at a manual job');
    expect(
      cardSetback({
        ...card,
        stop: stop({ cause: 'no_answer', ci_failure: null, ci_ending: 'ci_timed_out' }),
      }),
    ).toBe('CI did not finish');
  });

  it('renders the job names the row recorded as text', () => {
    renderCallout(
      detail({ returns: [ciReturn({ ci_failure: { status: 'failed', jobs: HOSTILE } })] }),
    );
    const sentence = document.querySelector('[data-setback="fixing"]');
    expect(sentence?.textContent).toContain(HOSTILE);
    expect(sentence?.querySelector('img')).toBeNull();
  });

  it('words a review’s return and a protected-files return without a CI failure', () => {
    const review = ciReturn({ from_stage: 'code_review', ci_failure: null, loop: null });
    expect(returnWords(review, TASK, LIMITS).sentence).toBe(
      'Code review sent it back: the Developer is working on it.',
    );
    const tamper = ciReturn({ ci_failure: null, loop: null, outcome: 'protected_paths_changed' });
    expect(returnWords(tamper, TASK, LIMITS).short).toBe('Protected files changed · fixing');
  });
});

describe('not recorded: a return that says so rather than guessing', () => {
  it('says the reason was not recorded when the row holds none', () => {
    renderCallout(
      detail({
        returns: [ciReturn({ ci_failure: null, loop: null, reason_recorded: false })],
      }),
    );
    const sentence = document.querySelector('[data-setback="fixing"]');
    expect(sentence?.getAttribute('data-setback-recorded')).toBe('no');
    expect(sentence?.textContent).toBe(
      'It went back from CI; the reason was not recorded. The Developer is working on it.',
    );
  });

  it('says a returned attempt whose rounds were used up never went anywhere', () => {
    const spent = ciReturn({ attempt: 4 });
    const value = stop({ cause: 'tries_spent', attempt: 4, loop: 'ci_fix' });
    expect(timelineReturnLine(spent, value)).toBe(
      'CI failed on the merge request (job unit). It did not go back to Implementation: the rounds it is allowed were used up, so it stopped here for a person.',
    );
    // Another attempt, or another cause, still went back.
    expect(timelineReturnLine(ciReturn(), value)).toBe(
      'Sent back to Implementation: CI failed on the merge request (job unit).',
    );
    expect(timelineReturnLine(spent, { ...value, cause: 'same_failure' })).toBe(
      'Sent back to Implementation: CI failed on the merge request (job unit).',
    );
  });

  it('words a CI-red return production closes with the tamper check’s word as a CI failure', () => {
    // gates.ts' settlement closes a red pipeline's return `protected_paths_clean`, not `returned`.
    const clean = ciReturn({ outcome: 'protected_paths_clean' });
    expect(returnWords(clean, TASK, LIMITS).sentence).toBe(
      'CI failed on the merge request (job unit): the Developer is fixing it (round 2 of 3).',
    );
    expect(timelineReturnLine(clean)).toBe(
      'Sent back to Implementation: CI failed on the merge request (job unit).',
    );
  });

  it('says where to was not recorded on the timeline, and the cause where it was', () => {
    expect(timelineReturnLine(ciReturn({ to_stage: null }))).toBe(
      'Sent back; where to was not recorded.',
    );
    expect(timelineReturnLine(ciReturn())).toBe(
      'Sent back to Implementation: CI failed on the merge request (job unit).',
    );
    expect(
      timelineReturnLine(ciReturn({ ci_failure: null, loop: null, reason_recorded: false })),
    ).toBe('Sent back to Implementation; the reason was not recorded.');
  });

  it('names the jobs as the row joined them, and a failure that named none', () => {
    expect(jobsPhrase('unit')).toBe('job unit');
    expect(jobsPhrase('lint,unit')).toBe('jobs lint,unit');
    expect(jobsPhrase('')).toBe('no failing job was named');
  });
});

describe('stopped: why the agent stopped, and the one next step', () => {
  const stopped = (value: TaskStop) =>
    detail(
      { stop: value, stages: [...FIXING_STAGES, row('ci_gate', 4, 'failed', ENTERED_AFTER)] },
      { state: 'needs_human', current_stage: 'ci_gate' },
    );

  it('says the same failure came back three times, then Retry or work on it yourself', () => {
    renderCallout(stopped(stop()));
    expect(screen.getByTestId('needs-you-callout')).toBeTruthy();
    expect(document.querySelector('[data-stop="same_failure"]')).not.toBeNull();
    expect(document.querySelector('[data-stop-sentence]')?.textContent).toBe(
      'CI failed the same way three times in a row (job unit), so the agent stopped.',
    );
    expect(document.querySelector('[data-stop-next]')?.textContent).toContain(
      'retry the stage or work on it yourself',
    );
    // The merge request is linked through `safeHref`.
    const link = screen.getByRole('link', { name: 'Open the merge request' });
    expect(link.getAttribute('href')).toBe(TASK.mr_ref?.url);
    expect(screen.getByRole('button', { name: 'Retry stage…' })).toBeTruthy();
    // The row's own word is not said a second time beside it.
    expect(document.querySelector('[data-escalation-reason]')).toBeNull();
  });

  it('says the rounds are used up, with the ceiling it knows', () => {
    const words = stopWords(stop({ cause: 'tries_spent', loop: 'ci_fix' }), LIMITS);
    expect(words.sentence).toBe(
      'CI failed again (job unit), and all 3 rounds it is allowed are used, so the agent stopped.',
    );
    expect(words.short).toBe('CI failed · out of rounds');
    expect(stopWords(stop({ cause: 'tries_spent', loop: null }), LIMITS).sentence).toBe(
      'CI failed again (job unit), and the rounds it is allowed are used up, so the agent stopped.',
    );
  });

  it('says a timed-out check did not finish, never that it failed, with what the platform saw last', () => {
    const recorded = `the CI gate on a poll-only gitlab binding timed out: the merge request was still manual (pipeline 41) after 60 minutes; the last read: pipeline 41 is held at manual job "${HOSTILE}"`;
    renderCallout(stopped(stop({ cause: 'no_answer', ci_failure: null, recorded })));
    const sentence = document.querySelector('[data-stop-sentence]')?.textContent ?? '';
    expect(sentence).toBe(
      'CI did not finish in the time the platform waits for it. Nothing failed.',
    );
    expect(sentence).not.toContain('CI failed');
    const saw = document.querySelector('[data-stop-recorded]');
    expect(saw?.textContent).toBe(`What the platform saw last: ${recorded}`);
    expect(saw?.querySelector('img')).toBeNull();
    expect(document.querySelector('[data-stop-next]')?.textContent).toContain(
      'Start or finish it there, then retry the stage.',
    );
  });

  it('says what the platform saw last was not recorded when no sentence was written, and a cut', () => {
    renderCallout(stopped(stop({ cause: 'no_answer', ci_failure: null, recorded: null })));
    expect(document.querySelector('[data-stop-recorded]')?.textContent).toBe(
      'What the platform saw last was not recorded.',
    );
    cleanup();
    renderCallout(
      stopped(
        stop({
          cause: 'no_answer',
          ci_failure: null,
          recorded: 'pipeline 41 is',
          recorded_cut: true,
        }),
      ),
    );
    expect(document.querySelector('[data-stop-recorded]')?.textContent).toBe(
      'What the platform saw last: pipeline 41 is (shortened)',
    );
  });

  it('falls back to the row’s own word when the stop is not one it can word', () => {
    renderCallout(
      detail(
        {
          stop: null,
          stages: [{ ...row('ci_gate', 4, 'failed', ENTERED_AFTER), outcome: 'unsupported' }],
        },
        { state: 'needs_human', current_stage: 'ci_gate' },
      ),
    );
    expect(document.querySelector('[data-stop]')).toBeNull();
    expect(document.querySelector('[data-escalation-reason]')).not.toBeNull();
  });

  it('gives the header and the card the stopped short form only while the task waits for a person', () => {
    const value = stop({ cause: 'no_answer', ci_failure: null });
    expect(
      setbackShort(
        { ...TASK, state: 'needs_human', current_stage: 'ci_gate' },
        [],
        null,
        value,
        LIMITS,
      ),
    ).toBe('CI did not finish');
    expect(setbackShort({ ...TASK, state: 'active' }, [], null, value, LIMITS)).toBeNull();
  });
});

/**
 * S-25.12 (product/10's 2026-11-07 amendments): a waiting CI check in the callout's slot, from the
 * read's `gate_wait` and `last_gate_wait` — and the recorded sentence only for an attempt that has
 * no read (before the worker session's #89).
 */
describe('a waiting CI check, from its structured read (S-25.12)', () => {
  const JOB_URL = 'https://git.example.invalid/acme/api/-/jobs/977';
  const read = (
    over: Partial<NonNullable<TaskDetailResponse['gate_wait']>> = {},
  ): NonNullable<TaskDetailResponse['gate_wait']> => ({
    pipeline_id: '3038234623',
    pipeline_url: 'https://git.example.invalid/acme/api/-/pipelines/3038234623',
    status: 'manual',
    held_job: 'sentry-release-commit',
    held_job_url: JOB_URL,
    draft: true,
    checked_at: '2026-11-07T10:12:00.000Z',
    waiting_since: ENTERED_AFTER,
    timeout_minutes: 60,
    ...over,
  });
  const waiting = (wait: NonNullable<TaskDetailResponse['gate_wait']>) =>
    detail(
      { returns: [], gate_wait: wait, stages: [row('ci_gate', 1, 'running', ENTERED_AFTER)] },
      { state: 'active', current_stage: 'ci_gate' },
    );
  const parked = (value: TaskStop, last: TaskDetailResponse['last_gate_wait']) =>
    detail(
      {
        returns: [],
        stop: value,
        last_gate_wait: last,
        stages: [
          { ...row('ci_gate', value.attempt, 'failed', ENTERED_AFTER), outcome: 'undecided' },
        ],
      },
      { state: 'needs_human', current_stage: 'ci_gate' },
    );
  const timedOut = (over: Partial<TaskStop> = {}) =>
    stop({
      cause: 'no_answer',
      ci_failure: null,
      attempt: 1,
      ci_ending: 'ci_timed_out',
      recorded: 'the CI gate on a poll-only gitlab binding timed out',
      ...over,
    });

  it('says a running pipeline in the slot as information, with no action', () => {
    renderCallout(waiting(read({ status: 'running', held_job: null, held_job_url: null })));
    expect(screen.getByTestId('gate-wait-notice')).toBeTruthy();
    expect(document.querySelector('[data-gate-wait="running"]')?.textContent).toMatch(
      /^CI is running \(pipeline 3038234623, \d+ min so far; the task gives up after 60\)\.$/,
    );
    expect(screen.queryByTestId('needs-you-callout')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('puts a held manual job in the needs-you callout at once, with the job linked and the draft note', () => {
    renderCallout(waiting(read()));
    const callout = screen.getByTestId('needs-you-callout');
    expect(callout.textContent).toContain('CI is waiting for a person');
    expect(document.querySelector('[data-gate-wait-sentence]')?.textContent).toBe(
      'CI is waiting for someone to start the manual job sentry-release-commit in GitLab. Start it there and the task continues.',
    );
    expect(screen.getByRole('link', { name: 'sentry-release-commit' }).getAttribute('href')).toBe(
      JOB_URL,
    );
    expect(document.querySelector('[data-gate-wait-draft]')).not.toBeNull();
    // Nothing to retry while it waits: the way forward is the job.
    expect(screen.queryByRole('button', { name: 'Retry stage…' })).toBeNull();
  });

  it('words a timed-out wait from the read — held at the job — and quotes no recorded sentence', () => {
    renderCallout(parked(timedOut(), read()));
    expect(document.querySelector('[data-ci-ending="ci_timed_out"]')).not.toBeNull();
    expect(document.querySelector('[data-stop-sentence]')?.textContent).toBe(
      'CI did not finish within 60 minutes: pipeline 3038234623 was still held at the manual job sentry-release-commit.',
    );
    expect(document.querySelector('[data-stop-next]')?.textContent).toBe(
      'Start the job in GitLab, then Retry.',
    );
    expect(document.querySelector('[data-stop-recorded]')).toBeNull();
    expect(document.body.textContent).not.toContain('poll-only');
    expect(document.body.textContent).not.toMatch(/CI failed/);
    expect(screen.getByRole('button', { name: 'Retry stage…' })).toBeTruthy();
  });

  it('words a timed-out wait on a pipeline that was still running', () => {
    renderCallout(
      parked(timedOut(), read({ status: 'running', held_job: null, held_job_url: null })),
    );
    expect(document.querySelector('[data-stop-sentence]')?.textContent).toBe(
      'CI did not finish within 60 minutes: pipeline 3038234623 was still running.',
    );
  });

  it('says a Retry on the same held pipeline did not wait again', () => {
    renderCallout(parked(timedOut({ ci_ending: 'ci_held_unchanged', attempt: 2 }), read()));
    expect(document.querySelector('[data-ci-ending="ci_held_unchanged"]')).not.toBeNull();
    expect(document.querySelector('[data-stop-sentence]')?.textContent).toBe(
      'The pipeline is still held at the manual job sentry-release-commit, so Retry did not wait again.',
    );
    expect(document.querySelector('[data-stop-next]')?.textContent).toBe(
      'Start the job in GitLab, or change its rule, then Retry.',
    );
    const words = stopWords(timedOut({ ci_ending: 'ci_held_unchanged' }), LIMITS);
    expect(words.short).toBe('CI held at a manual job');
  });

  it('falls back to what the platform saw last only for an attempt with no read (before #89)', () => {
    const recorded = 'the CI gate on a poll-only gitlab binding timed out after 60 minutes';
    renderCallout(parked(timedOut({ ci_ending: null, recorded }), null));
    expect(document.querySelector('[data-ci-ending]')).toBeNull();
    expect(document.querySelector('[data-stop-sentence]')?.textContent).toBe(
      'CI did not finish in the time the platform waits for it. Nothing failed.',
    );
    expect(document.querySelector('[data-stop-recorded]')?.textContent).toBe(
      `What the platform saw last: ${recorded}`,
    );
  });
});

describe('the words', () => {
  // The census's own retired spellings are `vocabulary-census.test.ts`'s, over every source.
  it('use none of the internal terms (gate, loop, signature, try N)', () => {
    const task = { ...TASK };
    const said = [
      returnWords(ciReturn(), task, LIMITS),
      returnWords(ciReturn({ reason_recorded: false, ci_failure: null }), task, LIMITS),
      ...(['tries_spent', 'same_failure', 'no_answer'] as const).map((cause) =>
        stopWords(stop({ cause, loop: 'ci_fix' }), LIMITS),
      ),
      stopWords(stop({ cause: 'no_answer', ci_ending: 'ci_held_unchanged' }), LIMITS),
    ].flatMap((words) => Object.values(words).filter((value) => typeof value === 'string'));
    said.push(timelineReturnLine(ciReturn()), timelineReturnLine(ciReturn({ to_stage: null })));
    for (const text of said) {
      expect(text).not.toMatch(/\b(gate|loop|signature|iteration|escalat\w*|try \d|attempt \d)\b/i);
    }
  });
});

/**
 * S-27.2 (TD-036 decision 7; the UI session's review of #114): at Ready, over a pipeline GitLab still
 * shows blocked, the callout says so as information — the Ready block, never *Needs you* — and a
 * task whose pass left nothing unstarted shows no such block.
 */
describe('the Ready callout over a pipeline the provider still shows blocked (S-27.2)', () => {
  const NOT_RUN = {
    pipeline_id: '3038234623',
    pipeline_url: null,
    pipeline_status: 'manual' as const,
    jobs: [{ name: 'sentry-release-commit', stage: 'release', url: null }],
    checked_at: RETURNED_AT,
  };
  const ready = { state: 'ready_for_merge' as const, current_stage: 'ready_for_merge' };

  it('shows the Ready block, naming the pipeline and the job, and asks nothing', () => {
    renderCallout(detail({ returns: [], stages: [], ci_manual_not_run: NOT_RUN }, ready));
    const notice = screen.getByTestId('ready-blocked-notice');
    expect(notice.textContent).toContain(
      'GitLab shows pipeline 3038234623, the latest for this commit, as blocked at the manual job sentry-release-commit.',
    );
    expect(notice.textContent).not.toMatch(/can be merged/i);
    expect(screen.queryByTestId('needs-you-callout')).toBeNull();
    expect(notice.querySelectorAll('button')).toHaveLength(0);
  });

  it('shows none when the pipeline is no longer held, or the pass left nothing unstarted', () => {
    renderCallout(
      detail(
        { returns: [], stages: [], ci_manual_not_run: { ...NOT_RUN, pipeline_status: 'success' } },
        ready,
      ),
    );
    expect(screen.queryByTestId('ready-blocked-notice')).toBeNull();
    cleanup();
    renderCallout(detail({ returns: [], stages: [], ci_manual_not_run: null }, ready));
    expect(screen.queryByTestId('ready-blocked-notice')).toBeNull();
  });
});

/**
 * S-28.8: a card whose plan the low-risk rule let go ahead says so while it is implemented — muted,
 * because it asks nothing — and says nothing once a setback has something to say, or after
 * Implementation.
 */
describe('a plan that went ahead without approval, on the card (S-28.8)', () => {
  const card = {
    ...TASK,
    state: 'active' as const,
    current_stage: 'implementation',
    stages: [],
    open_questions: 0,
    pending_approvals: 0,
    plan_went_ahead: true,
    loop_limits: LIMITS,
    gate_wait: null,
    latest_return: null,
    stop: null,
    escalation_reason: null,
  } satisfies TaskListItem;

  it('says so, muted, while the task implements it', () => {
    render(<SetbackLine task={card} />);
    const line = document.querySelector('[data-card-went-ahead]');
    expect(line?.textContent).toBe('Plan went ahead without approval');
    expect(line?.className).toContain('text-fg-muted');
  });

  it('says nothing after Implementation, nor for a plan a person approved', () => {
    render(<SetbackLine task={{ ...card, current_stage: 'code_review' }} />);
    expect(document.querySelector('[data-card-went-ahead]')).toBeNull();
    cleanup();
    render(<SetbackLine task={{ ...card, plan_went_ahead: false }} />);
    expect(document.querySelector('[data-card-went-ahead]')).toBeNull();
  });
});
