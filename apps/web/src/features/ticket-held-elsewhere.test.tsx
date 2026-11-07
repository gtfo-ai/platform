/**
 * **A ticket someone else holds** (S-25.14, product/10's Task detail amendment of 2026-11-07, the
 * owner's AUT-6676): the needs-you callout of a task stopped with `ticket_assigned_elsewhere` says
 * whose ticket it is and offers the ways out in the box.
 *
 * Driven through `createApp` against a fake server, as `task-owner.test.tsx` is: the real router,
 * query client and endpoint parsers, so the fields are read through `taskDetailResponseSchema`, the
 * owner control is the header's own, and a command is asserted by what the request carried.
 *
 * Covered: the sentence for a linked person, an unlinked one and a nameless one, from
 * `tracker_assignee` and never from the brief (the brief says something else on purpose); the
 * brief under a collapsed *Details*; the ways out per role, both directions; *Take it* as the page's
 * one amber primary only when the reader may take it, and the header's *Resume* giving way; *Take
 * it* with `take_writes_back` confirming once, through the shared control; *Give it back to the
 * agent* as soon as an owner is set (S-25.15 part B: the claim keeps the ticket for a platform
 * owner, TD-031 item 5) — with what Jira shows while it is still somebody else, and no warning that
 * the agent stops again; one *Take it* on the page (the header's owner line draws none while the box
 * does, and its `···` menu keeps the items); *Cancel task…* opening the existing confirmation.
 */
import type { TaskDetailResponse, TaskRecord } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { primaryLabels } from '../ui/primary-census.js';
import { taskPrimaryAction } from './page-primary.js';
import { heldElsewhereStop, heldElsewhereWords, ticketHolder } from './ticket-held-words.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const ME = '00000000-0000-4000-8000-000000000001';
const PETRA = '00000000-0000-4000-8000-00000000000a';
const AT = '2026-11-05T13:22:12.114Z';
const HOSTILE = '<img src=x onerror=alert(1)>';
const TICKET_URL = 'https://jira.example.test/browse/AUT-6676';
const VOJTECH = 'Vojtěch Kaizr';

type Role = 'member' | 'maintainer' | 'admin';

const session = (role: Role): SessionResponse => ({
  user: { id: ME, email: 'operator@example.invalid', name: 'Fake Operator', role },
  session: { id: '00000000-0000-4000-8000-000000000002' },
});

/**
 * The brief as the claim wrote it — deliberately naming nobody, so a sentence that names
 * Vojtěch can only have come from `tracker_assignee`.
 */
const BRIEF =
  'The platform did not start the "refinement" stage of AUT-6676: the ticket is assigned to ' +
  'somebody other than the account this project’s tracker binding uses.\n\nUnassign the ticket ' +
  'or assign it to the binding’s account, then hand the task back.';

const TASK_ROW: TaskRecord = {
  id: TASK,
  project_id: PROJECT,
  ticket: { provider: 'jira-cloud', key: 'AUT-6676', url: TICKET_URL },
  ticket_title: 'Export invoices as CSV',
  template: 'feature',
  mode: 'normal',
  state: 'needs_human',
  current_stage: 'refinement',
  size: null,
  branch: null,
  mr_ref: null,
  workpad_ref: null,
  iteration_counters: {},
  risk_classes: [],
  coverage: null,
  review_threads: null,
  dependencies: null,
  conflict: null,
  required_reviewers: null,
  cost_actual_usd: 0,
  unmeasured_runs: 0,
  budget_cap_usd: 5,
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
  ticket_claim: null,
  qa_stage: false,
  waiting: null,
  owner: null,
  owner_source: null,
  unlinked_assignee: { display_name: VOJTECH },
  owner_writes_back: false,
  tracker_assignee: { display_name: VOJTECH, user_id: null },
};

type Flags = Partial<
  Pick<
    TaskDetailResponse,
    | 'can_take'
    | 'can_assign'
    | 'can_unassign'
    | 'take_writes_back'
    | 'can_cancel'
    | 'can_resume'
    | 'escalation'
  >
>;

const detail = (flags: Flags = {}, task: Partial<TaskRecord> = {}): TaskDetailResponse => ({
  task: { ...TASK_ROW, ...task },
  taken_over: null,
  can_raise_budget: false,
  can_export: false,
  can_pause: true,
  can_resume: true,
  can_cancel: true,
  can_return: true,
  can_rework: true,
  can_decide_approval: true,
  take_writes_back: false,
  can_take: true,
  can_assign: true,
  can_unassign: false,
  gate_feedback: null,
  returns: [],
  stop: null,
  gate_wait: null,
  last_gate_wait: null,
  escalation: {
    at: AT,
    reason: 'ticket_assigned_elsewhere',
    brief: BRIEF,
    brief_original_chars: null,
  },
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
      stage: 'refinement',
      attempt: 1,
      state: 'failed',
      entered_at: AT,
      exited_at: AT,
      outcome: 'ticket_assigned_elsewhere',
    },
  ],
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [],
  ...flags,
});

/**
 * What each role is offered on this unassigned task the tracker gives to somebody else: the
 * server's `ownerChangePermitted` refuses a member's take of a task held elsewhere, so the read
 * sends a member `can_take: false` (`apps/server/src/routes/tasks.ts`).
 */
const AS: Readonly<Record<Role, Flags>> = {
  member: { can_take: false, can_assign: false, can_cancel: false, can_resume: false },
  maintainer: { can_take: true, can_assign: true, can_cancel: true, can_resume: true },
  admin: { can_take: true, can_assign: true, can_cancel: true, can_resume: true },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly path: string;
  readonly body: unknown;
}

const start = (task: TaskDetailResponse, role: Role = 'maintainer') => {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(session(role));
    if (init?.method === 'POST') {
      sent.push({ path, body: JSON.parse(String(init.body ?? '{}')) });
      return json({
        task_id: TASK,
        state: 'needs_human',
        current_stage: 'refinement',
        performed: true,
      });
    }
    if (path === `/api/tasks/${TASK}`) return json(task);
    if (path === `/api/projects/${PROJECT}/owner-candidates`) {
      return json({ items: [{ user_id: PETRA, name: 'Petra', writes_back: true }] });
    }
    if (path === '/api/projects') return json({ items: [] });
    if (path === '/api/org/inbox')
      return json({ questions: [], approvals: [], ci_held: [], escalated: [] });
    if (path === `/api/tasks/${TASK}/asks`) return json({ items: [] });
    if (path === `/api/tasks/${TASK}/pipeline`) {
      return json({ error: { code: 'not_found', message: 'no graph in this fake' } }, 404);
    }
    if (path.startsWith(`/api/tasks/${TASK}/`)) return json({ items: [], next_cursor: null });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  window.history.pushState({}, '', `/tasks/${TASK}`);
  render(createApp({ fetchImpl, realtime: false }).element);
  return { sent };
};

/** The callout's held-elsewhere body, once the read is in. */
const box = async (): Promise<HTMLElement> => {
  const callout = await screen.findByRole('region', { name: 'Needs you' });
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = callout.querySelector<HTMLElement>('[data-held-elsewhere]');
    expect(found).not.toBeNull();
  });
  return found as unknown as HTMLElement;
};

/** The box's steps, once the session is in (the owner control offers nothing before it). */
const steps = async (held: HTMLElement, first: string): Promise<string[]> => {
  await within(held).findByRole('button', { name: first });
  const row = held.querySelector('[data-held-steps]') as HTMLElement;
  return [...row.querySelectorAll('button, a, [data-link-refused]')].map((element) =>
    (element.textContent ?? '').trim(),
  );
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('whose ticket it is', () => {
  it('names an unlinked person, and says they aren’t a linked member of this project', async () => {
    start(detail());
    const held = await box();
    expect(held.getAttribute('data-held-elsewhere')).toBe('unlinked');
    expect(held.querySelector('[data-held-sentence]')?.textContent).toBe(
      `AUT-6676 is assigned in Jira to ${VOJTECH}, so no agent started on it. ${VOJTECH} isn’t a linked member of this project.`,
    );
  });

  it('names a linked person and adds nothing about an account', async () => {
    start(
      detail(
        {},
        { unlinked_assignee: null, tracker_assignee: { display_name: 'Petra', user_id: PETRA } },
      ),
    );
    const held = await box();
    expect(held.getAttribute('data-held-elsewhere')).toBe('linked');
    expect(held.querySelector('[data-held-sentence]')?.textContent).toBe(
      'AUT-6676 is assigned in Jira to Petra, so no agent started on it.',
    );
    expect(held.querySelector('[data-held-unlinked]')).toBeNull();
  });

  it('says someone else when the platform knows no name', async () => {
    start(
      detail(
        {},
        {
          unlinked_assignee: { display_name: null },
          tracker_assignee: { display_name: null, user_id: null },
        },
      ),
    );
    const held = await box();
    expect(held.getAttribute('data-held-elsewhere')).toBe('nameless');
    expect(held.querySelector('[data-held-sentence]')?.textContent).toBe(
      'AUT-6676 is assigned in Jira to someone else, so no agent started on it.',
    );
    expect(held.querySelector('[data-held-unlinked]')).toBeNull();
  });

  it('renders the name as text, never markup (BD-022)', async () => {
    const name = `Jan ${HOSTILE}`;
    start(
      detail(
        {},
        {
          unlinked_assignee: { display_name: name },
          tracker_assignee: { display_name: name, user_id: null },
        },
      ),
    );
    const held = await box();
    expect(held.querySelector('[data-held-sentence]')?.textContent).toContain(
      `to Jan ${HOSTILE}, so`,
    );
    expect(held.querySelector('img')).toBeNull();
  });

  it('keeps the brief under a collapsed Details, and leads with the sentence instead of it', async () => {
    start(detail());
    const held = await box();
    const callout = screen.getByRole('region', { name: 'Needs you' });
    expect(callout.querySelector('[data-escalation-brief]')).toBeNull();
    expect(callout.textContent).not.toContain('Why it stopped');
    expect(callout.querySelector('[data-escalation-reason]')).toBeNull();
    // The generic escalation sentence and its stage buttons are not the ways out here.
    expect(callout.textContent).not.toContain('This task is waiting for a person.');
    expect(within(callout).queryByRole('button', { name: 'Retry stage…' })).toBeNull();
    const details = held.querySelector<HTMLDetailsElement>('details[data-escalation-details]');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Details');
    expect(details?.querySelector('p.whitespace-pre-wrap')?.textContent).toBe(BRIEF);
    // The sentence is the first thing the box says.
    expect(held.firstElementChild?.hasAttribute('data-held-sentence')).toBe(true);
  });

  it('builds its words from the record, with the tracker’s own name', () => {
    const holder = ticketHolder({
      unlinked_assignee: null,
      tracker_assignee: { display_name: '  ', user_id: null },
    });
    expect(holder).toEqual({ name: null, unlinked: true });
    expect(
      ticketHolder({ unlinked_assignee: { display_name: 'Jan' }, tracker_assignee: null }),
    ).toEqual({ name: 'Jan', unlinked: true });
    expect(ticketHolder({ unlinked_assignee: null, tracker_assignee: null })).toEqual({
      name: null,
      unlinked: false,
    });
    const words = heldElsewhereWords('AUT-1', 'GitLab', { name: 'Jan', unlinked: false });
    expect(words.sentence).toEqual([
      { untrusted: 'AUT-1' },
      ' is assigned in GitLab to ',
      { untrusted: 'Jan' },
      ', so no agent started on it.',
    ]);
    expect(words.unlinked).toBeNull();
  });

  it('is the stop only for the reason key, and only while the task waits for a person', () => {
    const escalation = {
      at: AT,
      reason: 'ticket_assigned_elsewhere',
      brief: 'x',
      brief_original_chars: null,
    };
    expect(heldElsewhereStop({ task: { state: 'needs_human' }, escalation })).toBe(true);
    expect(heldElsewhereStop({ task: { state: 'active' }, escalation })).toBe(false);
    expect(
      heldElsewhereStop({
        task: { state: 'needs_human' },
        escalation: { ...escalation, reason: 'ticket_claim_failed' },
      }),
    ).toBe(false);
    // A brief that says "assigned elsewhere" is not the key.
    expect(
      heldElsewhereStop({
        task: { state: 'needs_human' },
        escalation: { ...escalation, reason: 'other', brief: 'ticket_assigned_elsewhere' },
      }),
    ).toBe(false);
    expect(heldElsewhereStop({ task: { state: 'needs_human' }, escalation: null })).toBe(false);
  });

  it('words a task stopped for another reason as before', async () => {
    start(
      detail({
        escalation: {
          at: AT,
          reason: 'ticket_claim_failed',
          brief: BRIEF,
          brief_original_chars: null,
        },
      }),
    );
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    await waitFor(() => {
      expect(callout.querySelector('[data-escalation-brief]')).not.toBeNull();
    });
    expect(callout.querySelector('[data-held-elsewhere]')).toBeNull();
  });
});

describe('the ways out, by role', () => {
  it('offers a member only Open in Jira, and no amber primary — no Resume either', async () => {
    start(detail(AS.member), 'member');
    const held = await box();
    await within(held).findByRole('link', { name: 'Open in Jira' });
    // `can_take` is false, so nothing is offered before the session is read or after it.
    const row = held.querySelector('[data-held-steps]') as HTMLElement;
    expect([...row.querySelectorAll('button, a')].map((element) => element.textContent)).toEqual([
      'Open in Jira',
    ]);
    expect(primaryLabels(screen.getByRole('main'))).toEqual([]);
  });

  it('offers a member Cancel task… beside it when the read allows it', async () => {
    start(detail({ ...AS.member, can_cancel: true }), 'member');
    const held = await box();
    expect(await steps(held, 'Cancel task…')).toEqual(['Open in Jira', 'Cancel task…']);
  });

  it('offers a maintainer Take it, Assign…, Open in Jira and Cancel task…, but no Link account…', async () => {
    start(detail(AS.maintainer), 'maintainer');
    const held = await box();
    expect(await steps(held, 'Take it')).toEqual([
      'Take it',
      'Assign…',
      'Open in Jira',
      'Cancel task…',
    ]);
    expect(primaryLabels(screen.getByRole('main'))).toEqual(['Take it']);
  });

  it('offers an administrator Link account… for a person who is not linked', async () => {
    start(detail(AS.admin), 'admin');
    const held = await box();
    expect(await steps(held, 'Take it')).toEqual([
      'Take it',
      'Assign…',
      'Link account…',
      'Open in Jira',
      'Cancel task…',
    ]);
    expect(within(held).getByRole('link', { name: 'Link account…' }).getAttribute('href')).toBe(
      '/settings/identities',
    );
  });

  it('offers no Link account… for a linked person, even to an administrator', async () => {
    start(
      detail(AS.admin, {
        unlinked_assignee: null,
        tracker_assignee: { display_name: 'Petra', user_id: PETRA },
      }),
      'admin',
    );
    const held = await box();
    expect(await steps(held, 'Take it')).not.toContain('Link account…');
  });

  it('links the ticket through safeHref, named for its tracker', async () => {
    start(detail(AS.member, {}), 'member');
    const held = await box();
    const open = within(held).getByRole('link', { name: 'Open in Jira' });
    expect(open.getAttribute('href')).toBe(TICKET_URL);
    expect(open.getAttribute('rel')).toContain('noopener');
  });

  it('draws no amber primary — and no Resume — for a maintainer who may not take it', async () => {
    start(detail({ ...AS.maintainer, can_take: false }), 'maintainer');
    const held = await box();
    expect(await steps(held, 'Assign…')).toEqual(['Assign…', 'Open in Jira', 'Cancel task…']);
    expect(primaryLabels(screen.getByRole('main'))).toEqual([]);
  });

  it('gives the header’s Resume way to the box: the stop is the only primary rule that changes', () => {
    const base = {
      state: 'needs_human' as const,
      canHandBack: false,
      openQuestions: 0,
      pendingApprovals: 0,
    };
    expect(taskPrimaryAction(base)).toBe('resume');
    expect(taskPrimaryAction({ ...base, heldElsewhere: true })).toBeNull();
    expect(taskPrimaryAction({ ...base, heldElsewhere: true, canTake: true })).toBe('take');
    // S-25.15 part B: once an owner is set, the box's hand-back — for a reader who may resume.
    expect(taskPrimaryAction({ ...base, heldElsewhere: true, owned: true })).toBe('give_back');
    expect(
      taskPrimaryAction({ ...base, heldElsewhere: true, owned: true, canResume: false }),
    ).toBeNull();
    // A take-over to hand back still comes first.
    expect(taskPrimaryAction({ ...base, canHandBack: true, heldElsewhere: true })).toBe(
      'hand_back',
    );
  });

  it('opens the existing cancel confirmation', async () => {
    const user = userEvent.setup();
    const { sent } = start(detail(AS.maintainer), 'maintainer');
    const held = await box();
    await user.click(await within(held).findByRole('button', { name: 'Cancel task…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this task?' });
    expect(sent).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel task' }));
    await waitFor(() => {
      expect(sent.map((entry) => entry.path)).toEqual([`/api/tasks/${TASK}/cancel`]);
    });
  });
});

describe('taking it, and what follows', () => {
  it('confirms a take that writes back once, through the header’s owner control', async () => {
    const user = userEvent.setup();
    const { sent } = start(detail({ ...AS.maintainer, take_writes_back: true }), 'maintainer');
    const held = await box();
    await user.click(await within(held).findByRole('button', { name: 'Take it' }));
    const dialog = await screen.findByRole('dialog', { name: 'Take AUT-6676?' }, { timeout: 5000 });
    // One confirmation, not a second copy of it.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      `This also assigns AUT-6676 in Jira to you, replacing ${VOJTECH}.`,
    );
    expect(sent).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Take it and assign in Jira' }));
    await waitFor(() => {
      expect(sent).toEqual([{ path: `/api/tasks/${TASK}/owner`, body: { user_id: ME } }]);
    });
    // The header's own status line says what follows: it is the same control.
    await waitFor(() => {
      expect(document.querySelector('[data-owner-done]')?.textContent).toBe(
        'Assigned to you. Your machine picks it up at the next stage.',
      );
    });
  });

  it('opens the header’s picker from Assign…', async () => {
    const user = userEvent.setup();
    start(detail(AS.maintainer), 'maintainer');
    const held = await box();
    await user.click(await within(held).findByRole('button', { name: 'Assign…' }));
    await screen.findByRole('dialog', { name: 'Assign AUT-6676' }, { timeout: 5000 });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  /** The task once the reader owns it and the write-back to Jira landed: nobody else holds it. */
  const OWNED_AND_WRITTEN_BACK = {
    owner: { user_id: ME, name: 'Fake Operator' },
    owner_writes_back: true,
    unlinked_assignee: null,
    tracker_assignee: { display_name: 'Fake Operator', user_id: ME },
  } as const;

  it('offers Give it back to the agent once nobody else holds the ticket, and sends the resume', async () => {
    const user = userEvent.setup();
    const { sent } = start(
      detail({ ...AS.maintainer, can_unassign: true }, OWNED_AND_WRITTEN_BACK),
      'maintainer',
    );
    const held = await box();
    expect(held.querySelector('[data-held-owned="ready"]')?.textContent).toBe(
      'It has an owner now. Give it back to the agent and it runs the stage it stopped at again.',
    );
    const back = await within(held).findByRole('button', { name: 'Give it back to the agent' });
    expect(within(held).queryByRole('button', { name: 'Take it' })).toBeNull();
    expect(within(held).queryByRole('button', { name: 'Assign…' })).toBeNull();
    // The page's one amber primary (S-25.15 part B), and the header's Resume gives way to it.
    expect(primaryLabels(screen.getByRole('main'))).toEqual(['Give it back to the agent']);
    await user.click(back);
    await waitFor(() => {
      expect(sent.map((entry) => entry.path)).toEqual([`/api/tasks/${TASK}/resume`]);
    });
  });

  it('offers no hand-back to a reader who may not resume', async () => {
    start(detail(AS.member, OWNED_AND_WRITTEN_BACK), 'member');
    const held = await box();
    await within(held).findByRole('link', { name: 'Open in Jira' });
    // Nothing amber at all: the hand-back is the primary only for a reader who may resume.
    expect(primaryLabels(screen.getByRole('main'))).toEqual([]);
    expect(held.querySelector('[data-held-owned="ready"]')).not.toBeNull();
    expect(within(held).queryByRole('button', { name: 'Give it back to the agent' })).toBeNull();
  });

  // S-25.15 part B: the claim keeps the ticket for an owner set on the platform (TD-031 item 5,
  // #117), so the hand-back no longer waits for the tracker — and the box no longer warns it would.
  it('offers the hand-back while the write-back is under way, and says only that', async () => {
    const user = userEvent.setup();
    const { sent } = start(
      detail(AS.maintainer, {
        owner: { user_id: ME, name: 'Fake Operator' },
        owner_writes_back: true,
      }),
      'maintainer',
    );
    const held = await box();
    const back = await within(held).findByRole('button', { name: 'Give it back to the agent' });
    expect(held.querySelector('[data-held-owned="writing_back"]')?.textContent).toBe(
      'It has an owner now. Give it back to the agent and it runs the stage it stopped at again. Jira is being assigned to Fake Operator.',
    );
    expect(held.textContent).not.toContain('once it is');
    await user.click(back);
    await waitFor(() => {
      expect(sent.map((entry) => entry.path)).toEqual([`/api/tasks/${TASK}/resume`]);
    });
  });

  it('offers the hand-back while Jira still shows somebody else, without the old warning', async () => {
    const user = userEvent.setup();
    const { sent } = start(
      detail(AS.maintainer, { owner: { user_id: PETRA, name: 'Petra' }, owner_writes_back: false }),
      'maintainer',
    );
    const held = await box();
    const back = await within(held).findByRole('button', { name: 'Give it back to the agent' });
    expect(held.querySelector('[data-held-owned="held"]')?.textContent).toBe(
      `It has an owner now. Give it back to the agent and it runs the stage it stopped at again. Jira still shows ${VOJTECH}, which doesn’t stop the agent.`,
    );
    expect(held.textContent).not.toContain('stops again');
    expect(held.textContent).not.toContain('there first');
    expect(within(held).queryByRole('button', { name: 'Take it' })).toBeNull();
    await user.click(back);
    await waitFor(() => {
      expect(sent.map((entry) => entry.path)).toEqual([`/api/tasks/${TASK}/resume`]);
    });
  });

  // The coordinator's decision on #120: once an owner is set, the hand-back is the amber primary.
  it.each([
    ['the write-back is under way', { owner_writes_back: true }],
    ['Jira still shows somebody else', { owner_writes_back: false }],
    ['nobody else holds the ticket', OWNED_AND_WRITTEN_BACK],
  ] as const)('draws exactly one amber button once the task is taken — %s', async (_name, over) => {
    start(
      detail(AS.maintainer, { owner: { user_id: ME, name: 'Fake Operator' }, ...over }),
      'maintainer',
    );
    const held = await box();
    const back = await within(held).findByRole('button', { name: 'Give it back to the agent' });
    await waitFor(() => {
      expect(primaryLabels(screen.getByRole('main'))).toEqual(['Give it back to the agent']);
    });
    expect(back.className).toContain('border-primary-line');
    // The header draws no Resume beside it: it is in the ··· menu.
    expect(within(screen.getByRole('main')).queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('offers no hand-back before anybody owns the task', async () => {
    start(detail(AS.maintainer), 'maintainer');
    const held = await box();
    await within(held).findByRole('button', { name: 'Take it' });
    expect(held.querySelector('[data-held-owned]')).toBeNull();
    expect(within(held).queryByRole('button', { name: 'Give it back to the agent' })).toBeNull();
  });
});

/**
 * S-25.15 part B: while the box offers *Take it* / *Assign…*, the header's owner line is
 * *Unassigned* alone — one *Take it* on the page — and the `···` menu keeps the owner items.
 */
describe('one Take it on the page', () => {
  const ownerLine = (): HTMLElement =>
    document.querySelector<HTMLElement>('[data-task-owner]') as HTMLElement;

  const menuOwnerItems = async (): Promise<string[]> => {
    await userEvent.setup().click(screen.getByRole('button', { name: 'Task actions' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((item) => (item.textContent ?? '').trim());
    await userEvent.setup().keyboard('{Escape}');
    return items.filter((label) => ['Take it', 'Assign…', 'Unassign'].includes(label));
  };

  it('draws the box’s Take it and Assign… only, with the owner line saying Unassigned', async () => {
    start(detail(AS.admin), 'admin');
    const held = await box();
    await within(held).findByRole('button', { name: 'Take it' });
    const main = screen.getByRole('main');
    expect(within(main).getAllByRole('button', { name: 'Take it' })).toHaveLength(1);
    expect(within(main).getAllByRole('button', { name: 'Assign…' })).toHaveLength(1);
    // The box's Link account… is the only one too, for an administrator.
    expect(within(main).getAllByRole('link', { name: 'Link account…' })).toHaveLength(1);
    const line = ownerLine();
    expect(line.getAttribute('data-owner-steps')).toBe('callout');
    expect(line.getAttribute('data-task-owner')).toBe('unassigned');
    expect(line.textContent).toBe('Unassigned');
    expect(within(line).queryAllByRole('button')).toHaveLength(0);
    expect(await menuOwnerItems()).toEqual(['Take it', 'Assign…']);
  });

  it('keeps the owner line’s own buttons once the box offers none (the control)', async () => {
    start(
      detail(
        { ...AS.maintainer, can_take: false, can_assign: true, can_unassign: true },
        { owner: { user_id: PETRA, name: 'Petra' } },
      ),
      'maintainer',
    );
    const held = await box();
    await within(held).findByRole('button', { name: 'Give it back to the agent' });
    const line = ownerLine();
    await within(line).findByRole('button', { name: 'Unassign' });
    expect(line.getAttribute('data-owner-steps')).toBe('line');
    expect(within(line).getByRole('button', { name: 'Assign…' })).toBeTruthy();
    expect(within(held).queryByRole('button', { name: 'Assign…' })).toBeNull();
  });

  it('keeps the owner line’s buttons on a task that is not stopped this way (the control)', async () => {
    start(detail({ ...AS.maintainer, escalation: null }, { state: 'active' }), 'maintainer');
    await screen.findByRole('heading', { level: 1 });
    const line = await waitFor(() => {
      const found = ownerLine();
      expect(within(found).getByRole('button', { name: 'Take it' })).toBeTruthy();
      return found;
    });
    expect(line.getAttribute('data-owner-steps')).toBe('line');
    expect(line.textContent).toContain(`Assigned in Jira to ${VOJTECH}`);
  });
});
