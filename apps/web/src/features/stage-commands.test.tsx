/**
 * The stage commands on an **escalated** task (PROGRESS backlog 483).
 *
 * Found on the first local test: AUT-6820 escalated at `ci_gate` and the person handling it could
 * not send it back to `implementation` — the server answered `409 illegal_transition`. The server
 * half is `human-commands.test.ts`; this is the screen's: the controls are offered on a
 * `needs_human` task, say that they are the way out, and send the request the route accepts — the
 * stage, the person's words and a per-intent `Idempotency-Key`.
 *
 * Driven through `createApp` with a fake server, as `take-over.test.tsx` is.
 */
import type { TaskDetailResponse } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { retryOutcomeText } from './task-detail.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const AT = '2026-10-06T08:00:00.000Z';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'maintainer',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const stage = (
  name: string,
  attempt: number,
  state: TaskDetailResponse['stages'][number]['state'],
  outcome: TaskDetailResponse['stages'][number]['outcome'],
): TaskDetailResponse['stages'][number] => ({
  stage: name,
  attempt,
  state,
  entered_at: AT,
  exited_at: state === 'running' ? null : AT,
  outcome,
});

const escalatedAtCi = (state: TaskDetailResponse['task']['state']): TaskDetailResponse => ({
  task: {
    id: TASK,
    project_id: PROJECT,
    ticket: { provider: 'jira', key: 'AUT-1', url: 'https://jira.example.test/browse/AUT-1' },
    ticket_title: null,
    template: 'feature',
    mode: 'normal',
    state,
    current_stage: 'ci_gate',
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
    cost_actual_usd: 1.25,
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
    created_at: AT,
    updated_at: AT,
    completed_at: null,
  },
  taken_over: null,
  can_raise_budget: false,
  can_export: false,
  gate_feedback: null,
  human_time: {
    total_minutes: 0,
    by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
    by_user: null,
    entries: 0,
    withheld: { entries: 0, minutes: 0 },
  },
  stages: [
    stage('refinement', 1, 'completed', 'approve'),
    stage('implementation', 1, 'completed', 'approve'),
    stage('ci_gate', 1, 'failed', 'escalated'),
  ],
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [],
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly path: string;
  readonly body: unknown;
  readonly key: string | null;
}

const fetchFor = (task: TaskDetailResponse | (() => TaskDetailResponse), sent: Sent[]) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (init?.method === 'POST') {
      const path = new URL(url, 'http://localhost').pathname;
      sent.push({
        path,
        body: JSON.parse(String(init.body)),
        key: new Headers(init.headers).get('idempotency-key'),
      });
      if (path.endsWith('/retry-stage')) {
        // Backlog 494: a retry pressed while the stage's run was still in flight.
        return json({
          task_id: TASK,
          state: 'active',
          current_stage: 'ci_gate',
          performed: true,
          attempt: 2,
          stopped_run: {
            run_id: '00000000-0000-4000-8000-0000000000c1',
            command_id: '00000000-0000-4000-8000-0000000000c2',
          },
        });
      }
      return json({
        task_id: TASK,
        state: 'active',
        current_stage: 'implementation',
        performed: true,
      });
    }
    if (url.endsWith(`/api/tasks/${TASK}/asks`)) return json({ items: [] });
    if (url.endsWith(`/api/tasks/${TASK}/audit`)) return json({ items: [] });
    if (url.endsWith(`/api/tasks/${TASK}`)) return json(typeof task === 'function' ? task() : task);
    if (url.endsWith('/api/projects')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

const HINT = 'This task is waiting for a person';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', `/tasks/${TASK}`);
});

describe('the stage commands on an escalated task (backlog 483)', () => {
  it('offers return and rework, says they are the way out, and sends what the route accepts', async () => {
    const sent: Sent[] = [];
    const user = userEvent.setup();
    const { container } = render(
      createApp({ fetchImpl: fetchFor(escalatedAtCi('needs_human'), sent), realtime: false })
        .element,
    );
    await screen.findByRole('button', { name: 'Return to stage' });
    expect(container.textContent).toContain(HINT);

    await user.selectOptions(screen.getByLabelText('Stage'), 'implementation');
    await user.type(screen.getByLabelText('Reason'), 'no merge request was opened; open one');
    await user.click(screen.getByRole('button', { name: 'Return to stage' }));
    await waitFor(() => {
      expect(sent.some((entry) => entry.path.endsWith('/return-to-stage'))).toBe(true);
    });
    const returned = sent.find((entry) => entry.path.endsWith('/return-to-stage'));
    expect(returned?.path).toBe(`/api/tasks/${TASK}/return-to-stage`);
    expect(returned?.body).toEqual({
      stage: 'implementation',
      reason: 'no merge request was opened; open one',
    });
    expect(returned?.key).toMatch(/.+/);

    await user.type(screen.getByLabelText('Rework instructions'), 'open it from the tool');
    await user.click(screen.getByRole('button', { name: 'Rework' }));
    await waitFor(() => {
      expect(sent.some((entry) => entry.path.endsWith('/rework'))).toBe(true);
    });
    expect(sent.find((entry) => entry.path.endsWith('/rework'))?.body).toEqual({
      stage: 'implementation',
      instructions: 'open it from the tool',
    });
  });

  it('says a merged task finishes its retrospective rather than going back (WP-152)', async () => {
    const merged: TaskDetailResponse = {
      ...escalatedAtCi('needs_human'),
      stages: [
        stage('implementation', 1, 'completed', 'approve'),
        stage('merged_gate', 1, 'completed', 'pass'),
        stage('retrospective', 1, 'failed', 'escalated'),
      ],
    };
    const { container } = render(
      createApp({ fetchImpl: fetchFor(merged, []), realtime: false }).element,
    );
    await screen.findByRole('button', { name: 'Return to stage' });
    expect(container.textContent).toContain('This task was merged and is waiting for a person');
    expect(container.textContent).not.toContain('Send it back to a stage it has run');
  });

  it('says nothing about a person waiting on a task that is running', async () => {
    const { container } = render(
      createApp({ fetchImpl: fetchFor(escalatedAtCi('active'), []), realtime: false }).element,
    );
    await screen.findByRole('button', { name: 'Return to stage' });
    expect(container.textContent).not.toContain(HINT);
  });
});

/**
 * **The gate's last failure goes with the return** (WP-152, PROGRESS backlog 491). Out of an
 * escalation at a gate the dialog offers a box, ticked, that names the excerpt's length — and the
 * request says what the person chose. A task with nothing to attach gets no box and sends nothing,
 * so the server's own default and its `no_gate_feedback` refusal are never second-guessed here.
 */
describe('the box that attaches the gate’s last failure (WP-152)', () => {
  const withFeedback = (): TaskDetailResponse => ({
    ...escalatedAtCi('needs_human'),
    gate_feedback: { stage: 'ci_gate', attempt: 1, chars: 6_012, original_chars: 20_657 },
  });
  const BOX = /Attach the gate’s last failure/;

  it('offers the box ticked, with the excerpt’s length, and sends it ticked by default', async () => {
    const sent: Sent[] = [];
    const user = userEvent.setup();
    render(createApp({ fetchImpl: fetchFor(withFeedback(), sent), realtime: false }).element);
    const box = await screen.findByRole('checkbox', { name: BOX });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(box.closest('label')?.textContent).toContain('6,012 characters, cut from 20,657');

    await user.selectOptions(screen.getByLabelText('Stage'), 'implementation');
    await user.type(screen.getByLabelText('Reason'), 'fix both jobs');
    await user.click(screen.getByRole('button', { name: 'Return to stage' }));
    await waitFor(() => {
      expect(sent.some((entry) => entry.path.endsWith('/return-to-stage'))).toBe(true);
    });
    expect(sent.find((entry) => entry.path.endsWith('/return-to-stage'))?.body).toEqual({
      stage: 'implementation',
      reason: 'fix both jobs',
      attach_gate_feedback: true,
    });
  });

  it('sends the note alone when the person unticks it, for a rework too', async () => {
    const sent: Sent[] = [];
    const user = userEvent.setup();
    render(createApp({ fetchImpl: fetchFor(withFeedback(), sent), realtime: false }).element);
    await user.click(await screen.findByRole('checkbox', { name: BOX }));
    await user.selectOptions(screen.getByLabelText('Stage'), 'implementation');
    await user.type(screen.getByLabelText('Rework instructions'), 'start over');
    await user.click(screen.getByRole('button', { name: 'Rework' }));
    await waitFor(() => {
      expect(sent.some((entry) => entry.path.endsWith('/rework'))).toBe(true);
    });
    expect(sent.find((entry) => entry.path.endsWith('/rework'))?.body).toEqual({
      stage: 'implementation',
      instructions: 'start over',
      attach_gate_feedback: false,
    });
  });

  /**
   * Round 1: the box is ticked for every escalation. An untick belongs to the gate attempt it was
   * made on; when the task comes back parked at a later attempt, the box is offered ticked again.
   */
  it('offers the box ticked again for a later escalation, whatever was unticked before', async () => {
    const sent: Sent[] = [];
    const user = userEvent.setup();
    let current = withFeedback();
    render(createApp({ fetchImpl: fetchFor(() => current, sent), realtime: false }).element);
    await user.click(await screen.findByRole('checkbox', { name: BOX }));
    expect(((await screen.findByRole('checkbox', { name: BOX })) as HTMLInputElement).checked).toBe(
      false,
    );
    // The task is returned, runs, and parks at the gate again: a new attempt, a new failure.
    current = {
      ...withFeedback(),
      gate_feedback: { stage: 'ci_gate', attempt: 2, chars: 812, original_chars: null },
    };
    await user.selectOptions(screen.getByLabelText('Stage'), 'implementation');
    await user.type(screen.getByLabelText('Reason'), 'note');
    await user.click(screen.getByRole('button', { name: 'Return to stage' }));
    await waitFor(() => {
      const box = screen.getByRole('checkbox', { name: BOX });
      expect(box.closest('label')?.textContent).toContain('812 characters');
      expect((box as HTMLInputElement).checked).toBe(true);
    });
    expect(sent.find((entry) => entry.path.endsWith('/return-to-stage'))?.body).toMatchObject({
      attach_gate_feedback: false,
    });
  });

  it('offers no box, and sends no field, when there is nothing to attach', async () => {
    render(
      createApp({ fetchImpl: fetchFor(escalatedAtCi('needs_human'), []), realtime: false }).element,
    );
    await screen.findByRole('button', { name: 'Return to stage' });
    expect(screen.queryByRole('checkbox', { name: BOX })).toBeNull();
  });
});

describe('what a retry says it did (backlog 494)', () => {
  it('names the attempt, and that the run still in flight is being stopped first', async () => {
    const sent: Sent[] = [];
    const user = userEvent.setup();
    render(
      createApp({ fetchImpl: fetchFor(escalatedAtCi('active'), sent), realtime: false }).element,
    );
    await user.click(await screen.findByRole('button', { name: 'Retry stage' }));
    const said =
      'Attempt 2 of ci_gate is queued. The run still in flight is being stopped; the new attempt starts once it has ended.';
    // A live region, beside the connection indicator's: the answer is announced, not only drawn.
    const status = await screen.findByText(said);
    expect(status.getAttribute('role')).toBe('status');
    expect(sent.find((entry) => entry.path.endsWith('/retry-stage'))?.key).toMatch(/.+/);
  });

  it('says each of the four answers differently', () => {
    const base = {
      task_id: TASK,
      state: 'active',
      current_stage: 'refinement',
      performed: true,
    } as const;
    expect(retryOutcomeText({ ...base, attempt: 3, stopped_run: null })).toBe(
      'Attempt 3 of refinement is queued.',
    );
    expect(
      retryOutcomeText({
        ...base,
        attempt: 3,
        stopped_run: { run_id: '00000000-0000-4000-8000-0000000000c1', command_id: null },
      }),
    ).toContain('had no live process, so its record was ended');
    expect(retryOutcomeText({ ...base, attempt: null, stopped_run: null })).toContain(
      'Nothing was re-entered here',
    );
  });
});
