/**
 * **Every refusal says why, and what to do next** (S-25.18). `errorSentence`'s table holds one
 * sentence per server code (`error-code-census.test.ts` keeps it whole); these cases hold what each
 * says — through `ErrorNotice`, the way a screen shows it — and the sentences built from `details`:
 * the projects that still use an integration, the organisation's maximum, the state a task is in and
 * the command it refused, the policy that refused, and the request id of the platform's own failure.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorNotice } from '../ui/kit.js';
import { CODE_SENTENCE } from './error-sentences.js';
import { ApiError } from './http.js';
import { errorSentence } from './read-error.js';

afterEach(() => {
  cleanup();
});

/** What the notice says outside its collapsed *Technical details*. */
const visible = (error: unknown): string => {
  const { container } = render(<ErrorNotice title="It was refused." error={error} />);
  const copy = container.cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll('details')) {
    details.remove();
  }
  const text = copy.textContent ?? '';
  cleanup();
  return text;
};

const SERVER_TEXT = 'a diagnostic naming row 00000000-0000-4000-8000-00000000a100';

const refusal = (
  status: number,
  code: string,
  details: readonly { readonly path: string; readonly message: string }[] = [],
): ApiError => new ApiError(status, code, SERVER_TEXT, details);

describe('every code’s sentence is what the notice shows (S-25.18)', () => {
  it.each(Object.keys(CODE_SENTENCE).filter((code) => code !== 'idempotency_attempt_unknown'))(
    '%s',
    (code) => {
      const error = refusal(409, code);
      const said = CODE_SENTENCE[code];
      const sentence = typeof said === 'string' ? said : (said as (e: ApiError) => string)(error);
      const text = visible(error);
      expect(text).toContain(sentence);
      expect(text).not.toContain(SERVER_TEXT);
      // Never the old fallback, which offered a reload that fixed nothing.
      expect(text).not.toContain('Reload to see where it stands');
    },
  );
});

describe('the sentences built from details (S-25.18)', () => {
  it.each([
    [
      'integration_bound, one project',
      refusal(409, 'integration_bound', [{ path: 'projects', message: 'ACME' }]),
      'ACME still uses this integration. Remove it from that project’s connections first, then retire it.',
    ],
    [
      'integration_bound, three projects',
      refusal(409, 'integration_bound', [
        { path: 'projects', message: 'ACME' },
        { path: 'projects', message: 'BILL' },
        { path: 'projects', message: 'CORE' },
      ]),
      'ACME, BILL and CORE still use this integration. Remove it from those projects’ connections first',
    ],
    [
      'integration_bound, an older server with no details',
      refusal(409, 'integration_bound'),
      'A project still uses this integration.',
    ],
    [
      'integration_has_live_credential',
      refusal(409, 'integration_has_live_credential', [
        { path: 'live_credentials', message: '2' },
        { path: 'latest_expiry', message: '2026-11-10T14:05:00.000Z' },
      ]),
      'It issued 2 run credentials that have not expired or been revoked',
    ],
    [
      'integration_is_organisation_default',
      refusal(409, 'integration_is_organisation_default'),
      'This is the organisation’s chat account for notifications. Choose another chat account under Settings',
    ],
    [
      'autonomy_above_organisation',
      refusal(409, 'autonomy_above_organisation', [
        { path: 'organisation_maximum', message: 'supervised' },
        { path: 'autonomy', message: 'autonomous' },
      ]),
      'The organisation allows agents at most Supervised. Choose Supervised or lower, or ask an administrator to raise the organisation’s maximum.',
    ],
    [
      'wip_above_organisation',
      refusal(409, 'wip_above_organisation', [
        { path: 'limit', message: 'max_parallel_tasks' },
        { path: 'value', message: '9' },
        { path: 'organisation_maximum', message: '4' },
      ]),
      'The organisation allows at most 4 parallel tasks, so this project cannot go above that. Choose 4 or fewer',
    ],
    [
      'config_conflict',
      refusal(409, 'config_conflict'),
      'The project’s settings changed since you opened them. Reload the page to see the new settings, then try again.',
    ],
    [
      'run_credential_refused, naming the fields',
      refusal(400, 'run_credential_refused', [
        { path: 'run_token', message: 'required' },
        { path: 'run_token_expires_at', message: 'more than 90 days ahead' },
      ]),
      'The run credential is refused: Run token, Run token expires at.',
    ],
    [
      'probe_busy',
      refusal(429, 'probe_busy'),
      'The connection test is queued behind other calls to the same provider. It finishes by itself',
    ],
    [
      'event_already_dispatched',
      refusal(409, 'event_already_dispatched'),
      'That event was already handled, so there is nothing to try again.',
    ],
    [
      'breakdown_refused',
      refusal(409, 'breakdown_refused'),
      'This breakdown can no longer be decided',
    ],
  ])('%s', (_name, error, sentence) => {
    expect(visible(error)).toContain(sentence);
  });
});

describe('a move the state machine does not have names the state and the way on (S-25.18)', () => {
  const transition = (aggregate: string, from: string, command?: string): ApiError =>
    refusal(409, 'illegal_transition', [
      { path: 'aggregate', message: aggregate },
      { path: 'from', message: from },
      { path: 'to', message: 'active' },
      ...(command === undefined ? [] : [{ path: 'command', message: command }]),
    ]);

  it.each([
    [
      'Task',
      'paused',
      'task.retry_stage',
      'This task is paused, so it cannot be retried — resume it first.',
    ],
    [
      'Task',
      'needs_human',
      'task.cancel',
      'This task is waiting for you, so it cannot be cancelled — open it and choose one of the ways on that it offers.',
    ],
    [
      'Task',
      'done',
      'task.resume',
      'This task is done, so it cannot be resumed — it has finished, so nothing changes it any more.',
    ],
    [
      'task',
      'waiting_approval',
      'task.hand_back',
      'This task is waiting for approval, so it cannot be given back to the agent — approve or reject its pending approval first.',
    ],
    [
      'Run',
      'completed',
      'run.cancel',
      'This run is completed, so it cannot be cancelled — it has ended; re-run it from the task page if it is still needed.',
    ],
    [
      'Question',
      'answered',
      'task.question.answer',
      'This question is answered, so it cannot be answered — it is already settled; reload the page to see how.',
    ],
    [
      'Approval',
      'approved',
      'task.approval.decide',
      'This approval is approved, so it cannot be decided — it is already decided; reload the page to see the decision.',
    ],
  ])('%s %s refusing %s', (aggregate, from, command, sentence) => {
    expect(errorSentence(transition(aggregate, from, command)).sentence).toBe(sentence);
  });

  it('says a command aimed at the state the task is already in as just that', () => {
    const paused = refusal(409, 'illegal_transition', [
      { path: 'aggregate', message: 'Task' },
      { path: 'from', message: 'paused' },
      { path: 'to', message: 'paused' },
      { path: 'command', message: 'task.pause' },
    ]);
    expect(errorSentence(paused).sentence).toBe('This task is already paused.');
    // The other side: a different target still names the command and the way on.
    expect(errorSentence(transition('Task', 'paused', 'task.retry_stage')).sentence).toContain(
      'so it cannot be retried',
    );
  });

  it('says "this cannot be done to it" for a command it has no word for, or none', () => {
    expect(errorSentence(transition('Task', 'paused')).sentence).toBe(
      'This task is paused, so this cannot be done to it — resume it first.',
    );
    expect(errorSentence(transition('Task', 'paused', 'task.something_new')).sentence).toBe(
      'This task is paused, so this cannot be done to it — resume it first.',
    );
  });

  it('never prints a state or an aggregate it has no word for', () => {
    for (const error of [
      transition('Task', 'hibernating', 'task.resume'),
      transition('Widget', 'paused', 'task.resume'),
      transition('constructor', 'paused', 'task.resume'),
      refusal(409, 'illegal_transition'),
    ]) {
      const { sentence } = errorSentence(error);
      expect(sentence).toBe(
        'This cannot be done in the state it is in now. Open it to see where it stands and what it needs.',
      );
      expect(sentence).not.toMatch(/hibernating|Widget|constructor/);
    }
  });

  it('keeps the server’s message behind Technical details', () => {
    expect(errorSentence(transition('Task', 'paused', 'task.retry_stage')).technical).toContain(
      SERVER_TEXT,
    );
  });
});

describe('a policy refusal names the policy (S-25.18)', () => {
  const policy = (key?: string): ApiError =>
    refusal(409, 'policy_violation', key === undefined ? [] : [{ path: 'policy', message: key }]);

  it.each([
    [
      'budget.exhausted',
      'A budget has run out, so this cannot start. Raise the budget under Budgets',
    ],
    ['command.policy', 'The project’s command rules do not allow this command.'],
    ['pipeline.template', 'The project’s pipeline template is refused'],
    ['review.max_rounds', 'A project rule (Review › Max rounds) does not allow this.'],
  ])('%s', (key, sentence) => {
    expect(errorSentence(policy(key)).sentence).toContain(sentence);
  });

  it('says a project rule refused when the policy is not named', () => {
    expect(errorSentence(policy()).sentence).toBe(
      'A project rule does not allow this. Check the project’s Rules & limits.',
    );
  });
});

describe('the platform’s own failure quotes its request id (S-25.18)', () => {
  it('shows the request id in the visible sentence', () => {
    const error = new ApiError(
      500,
      'internal_error',
      'the request failed; quote request id req-7f3a when reporting it',
      [{ path: 'request_id', message: 'req-7f3a' }],
    );
    expect(visible(error)).toContain(
      'The server failed while doing this. Try again in a moment; if it keeps failing, quote request id req-7f3a when you report this.',
    );
  });

  it('asks for the time when the server named no id', () => {
    expect(
      visible(new ApiError(500, 'internal_error', 'the organisation row was not created')),
    ).toContain('report it with the time it happened.');
  });
});

/** Review of #123: the table is a lazy chunk; a notice drawn first says the status, then the code. */
describe('a notice drawn before its sentence table has loaded (S-25.18)', () => {
  it('says the status sentence first, and the code’s own once the table arrives', async () => {
    vi.resetModules();
    const http = await import('./http.js');
    const kit = await import('../ui/kit.js');
    const fresh = await import('./read-error.js');
    const error = new http.ApiError(409, 'config_conflict', SERVER_TEXT);
    // Before anything loaded it: the status's sentence, which never offers a reload as the fix.
    expect(fresh.errorSentence(error).sentence).toBe(
      'This cannot be done in the state it is in now. Open it to see where it stands and what it needs.',
    );
    const { container } = render(<kit.ErrorNotice title="Not saved." error={error} />);
    await waitFor(() => {
      expect(container.textContent).toContain(
        'The project’s settings changed since you opened them.',
      );
    });
    expect(fresh.errorSentence(error).sentence).toContain(
      'Reload the page to see the new settings',
    );
  });
});
