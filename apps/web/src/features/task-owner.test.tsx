/**
 * **The owner on the task page** (S-26.8b, the M26 UX spec § 2), driven through `createApp` against
 * a fake server, as `task-page.test.tsx` is: the real router, query client and endpoint parsers, so
 * the owner fields are read through `taskDetailResponseSchema` and the command is asserted by what
 * the request carried.
 *
 * Per role, both directions (standing rule 42): a member is offered *Take it* on an unassigned task
 * and *Unassign* on their own, and nothing on somebody else's; a maintainer is offered both on
 * anybody's, with *Assign…* — each exactly as the read's `can_take` / `can_assign` /
 * `can_unassign` say, because the server holds the same rule. Taking somebody else's task asks
 * first and names them, and mentions the tracker only when *this reader's* take writes the
 * assignment back (`take_writes_back`, never `owner_writes_back`). *Assign…* reads its people from
 * `GET /api/projects/:id/owner-candidates?task_id=`, says what choosing one does, sends their id
 * and says what follows; its refusals are said in words. The owner control is never the page's
 * amber primary.
 */
import type { TaskDetailResponse, TaskRecord } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { primaryLabels } from '../ui/primary-census.js';
import { ownerOffers, takeConfirmFor } from './task-owner.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const ME = '00000000-0000-4000-8000-000000000001';
const VOJTECH = '00000000-0000-4000-8000-000000000009';
const PETRA = '00000000-0000-4000-8000-00000000000a';
const AT = '2026-09-13T04:00:00.000Z';
const HOSTILE = '<img src=x onerror=alert(1)>';

const session = (role: 'member' | 'maintainer' | 'admin'): SessionResponse => ({
  user: { id: ME, email: 'operator@example.invalid', name: 'Fake Operator', role },
  session: { id: '00000000-0000-4000-8000-000000000002' },
});

const TASK_ROW: TaskRecord = {
  id: TASK,
  project_id: PROJECT,
  ticket: {
    provider: 'jira-cloud',
    key: 'ACME-12',
    url: 'https://jira.example.test/browse/ACME-12',
  },
  ticket_title: 'Add VAT to invoices',
  template: 'feature',
  mode: 'normal',
  state: 'active',
  current_stage: 'implementation',
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
  cost_actual_usd: 1.2,
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
  owner: null,
  owner_source: null,
  unlinked_assignee: null,
  owner_writes_back: false,
  tracker_assignee: null,
};

const detail = (
  flags: Partial<
    Pick<TaskDetailResponse, 'can_take' | 'can_assign' | 'can_unassign' | 'take_writes_back'>
  >,
  task: Partial<TaskRecord> = {},
): TaskDetailResponse => ({
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
  can_take: false,
  can_assign: false,
  can_unassign: false,
  ...flags,
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
      state: 'running',
      entered_at: AT,
      exited_at: null,
      outcome: null,
    },
  ],
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [],
});

const OWNED_BY_VOJTECH = { owner: { user_id: VOJTECH, name: 'Vojtěch' } } as const;
const OWNED_BY_ME = { owner: { user_id: ME, name: 'Fake Operator' } } as const;

/** The tracker shows a person the platform cannot link: both fields, as the server sends them. */
const HELD_BY = (name: string) =>
  ({
    unlinked_assignee: { display_name: name },
    tracker_assignee: { display_name: name, user_id: null },
  }) as const;

/** The tracker shows Vojtěch, linked — whether or not he still owns the task. */
const JIRA_SHOWS_VOJTECH = {
  tracker_assignee: { display_name: 'Vojtěch', user_id: VOJTECH },
} as const;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly path: string;
  readonly body: unknown;
  readonly key: string | null;
}

/** The people `GET /api/projects/:id/owner-candidates` answers by default, by name. */
const CANDIDATES = {
  items: [
    { user_id: ME, name: 'Fake Operator', writes_back: false },
    { user_id: PETRA, name: 'Petra', writes_back: true },
    { user_id: VOJTECH, name: 'Vojtěch', writes_back: true },
  ],
};

const start = (
  task: TaskDetailResponse,
  role: 'member' | 'maintainer' | 'admin' = 'member',
  /** What the owner command answers; accepted by default. */
  ownerAnswer: () => Response = () =>
    json({ task_id: TASK, state: 'active', current_stage: 'implementation', performed: true }),
  /** What the owner candidates read answers. */
  candidatesAnswer: () => Response = () => json(CANDIDATES),
) => {
  const sent: Sent[] = [];
  /** The query string of every owner candidates read. */
  const candidateReads: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(session(role));
    if (init?.method === 'POST') {
      sent.push({
        path,
        body: JSON.parse(String(init.body ?? '{}')),
        key: new Headers(init.headers).get('idempotency-key'),
      });
      return path === `/api/tasks/${TASK}/owner`
        ? ownerAnswer()
        : json({ task_id: TASK, state: 'active', current_stage: null, performed: true });
    }
    if (path === `/api/tasks/${TASK}`) return json(task);
    if (path === `/api/projects/${PROJECT}/owner-candidates`) {
      candidateReads.push(new URL(url, 'http://localhost').search);
      return candidatesAnswer();
    }
    if (path === '/api/projects') return json({ items: [] });
    if (path === '/api/org/inbox') return json({ questions: [], approvals: [] });
    if (path === `/api/tasks/${TASK}/asks`) return json({ items: [] });
    if (path === `/api/tasks/${TASK}/pipeline`) {
      return json({ error: { code: 'not_found', message: 'no graph in this fake' } }, 404);
    }
    if (path.startsWith(`/api/tasks/${TASK}/`)) return json({ items: [], next_cursor: null });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  window.history.pushState({}, '', `/tasks/${TASK}`);
  const view = render(createApp({ fetchImpl, realtime: false }).element);
  return { view, sent, candidateReads };
};

/** The header's owner line, once the read and the session are in. */
const ownerLine = async (): Promise<HTMLElement> => {
  await screen.findByRole('heading', { level: 1 });
  let line: HTMLElement | null = null;
  await waitFor(() => {
    line = document.querySelector<HTMLElement>('[data-task-owner]');
    expect(line).not.toBeNull();
  });
  return line as unknown as HTMLElement;
};

/** The status line that says what an owner change did, once it is there. */
const ownerDone = async (): Promise<string> => {
  let text = '';
  await waitFor(() => {
    const done = document.querySelector('[data-owner-done]');
    expect(done?.getAttribute('role')).toBe('status');
    text = done?.textContent ?? '';
  });
  return text;
};

/** The refusal notice the owner control draws, by its title. */
const ownerRefusal = async (): Promise<string> => {
  const title = await screen.findByText('The owner was not changed.');
  return title.closest('[data-flash]')?.textContent ?? '';
};

/** The owner items the `···` menu offers. */
const menuOwnerItems = async (): Promise<string[]> => {
  await userEvent.setup().click(screen.getByRole('button', { name: 'Task actions' }));
  const menu = await screen.findByRole('menu');
  const items = within(menu)
    .getAllByRole('menuitem')
    .map((item) => (item.textContent ?? '').trim());
  await userEvent.setup().keyboard('{Escape}');
  return items.filter((label) => ['Take it', 'Assign…', 'Unassign'].includes(label));
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the owner line', () => {
  it('says Unassigned, muted, for a task nobody owns or holds', async () => {
    start(detail({}));
    const line = await ownerLine();
    expect(line.getAttribute('data-task-owner')).toBe('unassigned');
    expect(within(line).getByText('Unassigned').className).toContain('text-fg-muted');
  });

  it('names the owner beside their initials, and says (you) to the owner', async () => {
    start(detail({}, OWNED_BY_VOJTECH));
    let line = await ownerLine();
    expect(line.textContent).toContain('Owner: Vojtěch');
    expect(line.textContent).not.toContain('(you)');
    expect(line.querySelector('[data-avatar]')?.textContent).toBe('V');

    cleanup();
    start(detail({}, OWNED_BY_ME));
    line = await ownerLine();
    await waitFor(() => {
      expect(line.textContent).toContain('Owner: Fake Operator (you)');
    });
  });

  it('says who the tracker names when the platform cannot link them, as text', async () => {
    start(detail({}, { unlinked_assignee: { display_name: `Jan Novák ${HOSTILE}` } }));
    const line = await ownerLine();
    expect(line.getAttribute('data-task-owner')).toBe('unlinked');
    expect(line.textContent).toContain(
      `Assigned in Jira to Jan Novák ${HOSTILE} (not linked to a platform account)`,
    );
    expect(line.querySelector('img')).toBeNull();
  });

  it('says someone when the tracker gave no name', async () => {
    start(detail({}, { unlinked_assignee: { display_name: null } }));
    const line = await ownerLine();
    expect(line.textContent).toContain(
      'Assigned in Jira to someone (not linked to a platform account)',
    );
  });

  it('links an administrator to Linked accounts, and nobody who cannot open it', async () => {
    const unlinked = { unlinked_assignee: { display_name: 'Jan Novák' } };
    start(detail({}, unlinked), 'admin');
    let line = await ownerLine();
    const link = await within(line).findByRole('link', { name: 'Link account…' });
    expect(link.getAttribute('href')).toBe('/settings/identities');

    for (const role of ['maintainer', 'member'] as const) {
      cleanup();
      start(detail({}, unlinked), role);
      line = await ownerLine();
      // The session is read by then: the line has the reader's role.
      await screen.findByRole('button', { name: 'Task actions' });
      expect(within(line).queryByRole('link', { name: 'Link account…' })).toBeNull();
    }
  });
});

describe('what each role is offered (the read’s can_* flags)', () => {
  it('offers a member Take it on an unassigned task, and nothing else — no Assign…', async () => {
    start(detail({ can_take: true }));
    const line = await ownerLine();
    expect(await within(line).findByRole('button', { name: 'Take it' })).toBeTruthy();
    expect(within(line).queryByRole('button', { name: 'Unassign' })).toBeNull();
    expect(within(line).queryByRole('button', { name: 'Assign…' })).toBeNull();
    expect(await menuOwnerItems()).toEqual(['Take it']);
  });

  it('offers a member Unassign on their own task', async () => {
    start(detail({ can_unassign: true }, OWNED_BY_ME));
    const line = await ownerLine();
    expect(await within(line).findByRole('button', { name: 'Unassign' })).toBeTruthy();
    expect(within(line).queryByRole('button', { name: 'Take it' })).toBeNull();
    expect(await menuOwnerItems()).toEqual(['Unassign']);
  });

  it('offers a member nothing on somebody else’s task', async () => {
    start(detail({}, OWNED_BY_VOJTECH));
    const line = await ownerLine();
    await screen.findByRole('button', { name: 'Task actions' });
    expect(within(line).queryAllByRole('button')).toHaveLength(0);
    expect(await menuOwnerItems()).toEqual([]);
  });

  it('offers a maintainer Take it, Assign… and Unassign on somebody else’s task', async () => {
    start(
      detail({ can_take: true, can_assign: true, can_unassign: true }, OWNED_BY_VOJTECH),
      'maintainer',
    );
    const line = await ownerLine();
    // By the line: the first of Take it and Unassign that applies, and Assign… beside it.
    expect(await within(line).findByRole('button', { name: 'Take it' })).toBeTruthy();
    expect(
      within(line)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Take it', 'Assign…']);
    expect(await menuOwnerItems()).toEqual(['Take it', 'Assign…', 'Unassign']);
    // Never the page's amber primary.
    expect(primaryLabels(screen.getByRole('main'))).not.toContain('Assign…');
  });

  it('offers Assign… by itself where it is the only owner action', async () => {
    start(detail({ can_assign: true }), 'maintainer');
    const line = await ownerLine();
    expect(await within(line).findByRole('button', { name: 'Assign…' })).toBeTruthy();
    expect(within(line).getAllByRole('button')).toHaveLength(1);
    expect(await menuOwnerItems()).toEqual(['Assign…']);
  });

  it('never makes the owner control the page’s amber primary', async () => {
    start(detail({ can_take: true }));
    const line = await ownerLine();
    await within(line).findByRole('button', { name: 'Take it' });
    expect(primaryLabels(screen.getByRole('main'))).not.toContain('Take it');
  });

  it('reads the flags and nothing else: an absent flag offers nothing', () => {
    expect(ownerOffers({})).toEqual([]);
    expect(ownerOffers({ can_take: true, can_unassign: true })).toEqual(['take', 'unassign']);
    expect(ownerOffers({ can_take: false, can_unassign: true })).toEqual(['unassign']);
    expect(ownerOffers({ can_take: true, can_assign: true, can_unassign: true })).toEqual([
      'take',
      'assign',
      'unassign',
    ]);
    expect(ownerOffers({ can_assign: false })).toEqual([]);
  });
});

describe('taking a task', () => {
  it('takes an unassigned task at once, with a key, and says what follows', async () => {
    const { sent } = start(detail({ can_take: true }));
    const line = await ownerLine();
    await userEvent.setup().click(await within(line).findByRole('button', { name: 'Take it' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.path).toBe(`/api/tasks/${TASK}/owner`);
    expect(sent[0]?.body).toEqual({ user_id: ME });
    expect(sent[0]?.key).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await ownerDone()).toBe('Assigned to you. Your machine picks it up at the next stage.');
  });

  it('asks before taking somebody else’s task, names them, and says nothing of the tracker', async () => {
    const { sent } = start(
      detail({ can_take: true, can_assign: true, can_unassign: true }, OWNED_BY_VOJTECH),
      'maintainer',
    );
    const line = await ownerLine();
    const user = userEvent.setup();
    await user.click(await within(line).findByRole('button', { name: 'Take it' }));
    const dialog = await screen.findByRole(
      'dialog',
      { name: 'Take ACME-12 from Vojtěch?' },
      { timeout: 5000 },
    );
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Their machine stops getting it.',
    );
    expect(dialog.textContent).not.toContain('Jira');
    // Nothing is sent until the person confirms.
    expect(sent).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Take it from Vojtěch' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({ user_id: ME });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(await ownerDone()).toBe('Assigned to you. Your machine picks it up at the next stage.');
  });

  it('says the tracker is assigned too when this reader’s take writes it back', async () => {
    start(detail({ can_take: true, take_writes_back: true }, OWNED_BY_VOJTECH), 'maintainer');
    const line = await ownerLine();
    await userEvent.setup().click(await within(line).findByRole('button', { name: 'Take it' }));
    const dialog = await screen.findByRole(
      'dialog',
      { name: 'Take ACME-12 from Vojtěch?' },
      { timeout: 5000 },
    );
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Their machine stops getting it, and this also assigns ACME-12 in Jira.',
    );
  });

  it('says nothing of the tracker when the owner is written back but this reader’s take is not', async () => {
    // owner_writes_back is about Vojtěch; the reader has no linked account, so the take writes nothing.
    start(
      detail(
        { can_take: true, take_writes_back: false },
        { ...OWNED_BY_VOJTECH, ...HELD_BY('Jan Novák'), owner_writes_back: true },
      ),
      'maintainer',
    );
    const line = await ownerLine();
    await userEvent.setup().click(await within(line).findByRole('button', { name: 'Take it' }));
    const dialog = await screen.findByRole(
      'dialog',
      { name: 'Take ACME-12 from Vojtěch?' },
      { timeout: 5000 },
    );
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Their machine stops getting it.',
    );
    expect(dialog.textContent).not.toContain('Jira');
    expect(dialog.textContent).not.toContain('Jan Novák');
  });

  it('keeps the dialog open and Cancel sends nothing', async () => {
    const { sent } = start(detail({ can_take: true }, OWNED_BY_VOJTECH), 'maintainer');
    const line = await ownerLine();
    const user = userEvent.setup();
    await user.click(await within(line).findByRole('button', { name: 'Take it' }));
    const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(sent).toHaveLength(0);
  });

  it('confirms against an owner who is somebody else, and a held ticket only when the take writes back', () => {
    const none = { owner: null, unlinked_assignee: null, tracker_assignee: null };
    const jan = HELD_BY('Jan Novák');
    expect(takeConfirmFor(none, ME, false)).toBeNull();
    expect(takeConfirmFor(none, ME, true)).toBeNull();
    expect(
      takeConfirmFor({ ...none, owner: { user_id: ME, name: 'Fake Operator' } }, ME, true),
    ).toBeNull();
    expect(
      takeConfirmFor({ ...none, owner: { user_id: VOJTECH, name: 'Vojtěch' } }, ME, false),
    ).toEqual({ kind: 'owner', ownerName: 'Vojtěch', replacing: null });
    expect(takeConfirmFor({ ...none, owner: { user_id: VOJTECH, name: ' ' } }, ME, false)).toEqual({
      kind: 'owner',
      ownerName: 'a person with no name',
      replacing: null,
    });
    expect(
      takeConfirmFor({ owner: { user_id: VOJTECH, name: 'Vojtěch' }, ...jan }, ME, true),
    ).toEqual({
      kind: 'owner',
      ownerName: 'Vojtěch',
      replacing: { name: 'Jan Novák', userId: null },
    });
    // A written-back owner the tracker shows: the take replaces him there, by name.
    expect(
      takeConfirmFor(
        { ...none, owner: { user_id: VOJTECH, name: 'Vojtěch' }, ...JIRA_SHOWS_VOJTECH },
        ME,
        true,
      ),
    ).toEqual({
      kind: 'owner',
      ownerName: 'Vojtěch',
      replacing: { name: 'Vojtěch', userId: VOJTECH },
    });
    // Held only by the tracker's unlinked assignee: asked only when this reader's take writes back.
    expect(takeConfirmFor({ ...none, ...jan }, ME, false)).toBeNull();
    expect(takeConfirmFor({ ...none, ...jan }, ME, true)).toEqual({
      kind: 'held',
      assignee: 'Jan Novák',
    });
    // Vojtěch's released task: no owner, nobody unlinked, and Jira still shows him.
    expect(takeConfirmFor({ ...none, ...JIRA_SHOWS_VOJTECH }, ME, false)).toBeNull();
    expect(takeConfirmFor({ ...none, ...JIRA_SHOWS_VOJTECH }, ME, true)).toEqual({
      kind: 'held',
      assignee: 'Vojtěch',
    });
    // A nameless somebody is still somebody.
    expect(
      takeConfirmFor(
        { ...none, tracker_assignee: { display_name: null, user_id: null } },
        ME,
        true,
      ),
    ).toEqual({ kind: 'held', assignee: null });
    // The tracker already shows the reader: the take replaces nobody there, so it asks nothing.
    expect(
      takeConfirmFor(
        { ...none, tracker_assignee: { display_name: 'Me in Jira', user_id: ME } },
        ME,
        true,
      ),
    ).toBeNull();
  });

  it('asks before taking a task Vojtěch gave back while Jira still shows him, when the take writes back', async () => {
    const { sent } = start(
      detail({ can_take: true, take_writes_back: true }, JIRA_SHOWS_VOJTECH),
      'maintainer',
    );
    const line = await ownerLine();
    const user = userEvent.setup();
    await user.click(await within(line).findByRole('button', { name: 'Take it' }));
    const dialog = await screen.findByRole('dialog', { name: 'Take ACME-12?' }, { timeout: 5000 });
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'This also assigns ACME-12 in Jira to you, replacing Vojtěch.',
    );
    expect(sent).toHaveLength(0);

    // The same task where this reader's take writes nothing back: taken at once.
    cleanup();
    const again = start(
      detail({ can_take: true, take_writes_back: false }, JIRA_SHOWS_VOJTECH),
      'maintainer',
    );
    const line2 = await ownerLine();
    await userEvent.setup().click(await within(line2).findByRole('button', { name: 'Take it' }));
    await waitFor(() => {
      expect(again.sent).toHaveLength(1);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names a written-back owner the take replaces in the tracker', async () => {
    start(
      detail(
        { can_take: true, take_writes_back: true },
        { ...OWNED_BY_VOJTECH, ...JIRA_SHOWS_VOJTECH },
      ),
      'maintainer',
    );
    const line = await ownerLine();
    await userEvent.setup().click(await within(line).findByRole('button', { name: 'Take it' }));
    const dialog = await screen.findByRole(
      'dialog',
      { name: 'Take ACME-12 from Vojtěch?' },
      { timeout: 5000 },
    );
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Their machine stops getting it, and this also assigns ACME-12 in Jira, replacing Vojtěch.',
    );
  });

  it('asks before taking a ticket the tracker assigns to somebody, when the take writes back', async () => {
    // Nobody owns it, so owner_writes_back is false; the reader is linked, so the take writes back.
    const { sent } = start(
      detail(
        { can_take: true, take_writes_back: true },
        { ...HELD_BY(`Jan Novák ${HOSTILE}`), owner_writes_back: false },
      ),
      'maintainer',
    );
    const line = await ownerLine();
    const user = userEvent.setup();
    await user.click(await within(line).findByRole('button', { name: 'Take it' }));
    const dialog = await screen.findByRole('dialog', { name: 'Take ACME-12?' }, { timeout: 5000 });
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      `This also assigns ACME-12 in Jira to you, replacing Jan Novák ${HOSTILE}.`,
    );
    expect(dialog.querySelector('img')).toBeNull();
    expect(sent).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Take it and assign in Jira' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({ user_id: ME });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('takes a ticket the tracker assigns to somebody at once when the take writes nothing back', async () => {
    const { sent } = start(
      detail(
        { can_take: true, take_writes_back: false },
        // Even where the project writes owners back: this reader's take does not.
        { ...HELD_BY('Jan Novák'), owner_writes_back: true },
      ),
      'maintainer',
    );
    const line = await ownerLine();
    await userEvent.setup().click(await within(line).findByRole('button', { name: 'Take it' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await ownerDone()).toBe('Assigned to you. Your machine picks it up at the next stage.');
  });

  it('names the tracker assignee a take from an owner replaces, when the take writes back', async () => {
    start(
      detail(
        { can_take: true, take_writes_back: true },
        { ...OWNED_BY_VOJTECH, ...HELD_BY('Jan Novák'), owner_writes_back: false },
      ),
      'maintainer',
    );
    const line = await ownerLine();
    await userEvent.setup().click(await within(line).findByRole('button', { name: 'Take it' }));
    const dialog = await screen.findByRole(
      'dialog',
      { name: 'Take ACME-12 from Vojtěch?' },
      { timeout: 5000 },
    );
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Their machine stops getting it, and this also assigns ACME-12 in Jira, replacing Jan Novák.',
    );
  });
});

describe('unassigning, and a refusal', () => {
  it('unassigns with user_id null and says what follows', async () => {
    const { sent } = start(detail({ can_unassign: true }, OWNED_BY_ME));
    const line = await ownerLine();
    await userEvent.setup().click(await within(line).findByRole('button', { name: 'Unassign' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({ user_id: null });
    expect(sent[0]?.key).not.toBeNull();
    expect(await ownerDone()).toBe(
      'Unassigned. A machine that takes unassigned tasks picks it up at the next stage.',
    );
  });

  it('never claims a tracker change: it says the ticket stays assigned there when it writes back', async () => {
    start(detail({ can_unassign: true }, { ...OWNED_BY_ME, owner_writes_back: true }));
    let line = await ownerLine();
    await userEvent.setup().click(await within(line).findByRole('button', { name: 'Unassign' }));
    const written = await ownerDone();
    expect(written).toBe(
      'Unassigned. The ticket stays assigned in Jira. A machine that takes unassigned tasks picks it up at the next stage.',
    );
    // Unassign never writes to the tracker (TD-031 item 4): no word of a change made there.
    expect(written).not.toMatch(/\b(?:assigns|unassigns|unassigned in|removes|removed|cleared)\b/i);

    cleanup();
    start(detail({ can_unassign: true }, OWNED_BY_ME));
    line = await ownerLine();
    await userEvent.setup().click(await within(line).findByRole('button', { name: 'Unassign' }));
    expect(await ownerDone()).not.toContain('Jira');
  });

  it('says a 403 in words, and nothing was done', async () => {
    start(detail({ can_take: true }), 'member', () =>
      json(
        {
          error: { code: 'owner_change_not_permitted', message: 'the role may not set this owner' },
        },
        403,
      ),
    );
    const line = await ownerLine();
    await userEvent.setup().click(await within(line).findByRole('button', { name: 'Take it' }));
    expect(await ownerRefusal()).toContain(
      'Your role does not allow this change of owner. Reload to see who owns it now.',
    );
    expect(document.querySelector('[data-owner-done]')).toBeNull();
  });

  it('says a finished task’s 409 in words', async () => {
    start(detail({ can_unassign: true }, OWNED_BY_ME), 'member', () =>
      json({ error: { code: 'task_finished', message: 'task is done' } }, 409),
    );
    const line = await ownerLine();
    await userEvent.setup().click(await within(line).findByRole('button', { name: 'Unassign' }));
    expect(await ownerRefusal()).toContain(
      'The task has finished, so its owner no longer changes.',
    );
  });
});

/** Open *Assign…* from the owner line and answer the picker once its people are read. */
const openPicker = async (): Promise<HTMLElement> => {
  const line = await ownerLine();
  await userEvent.setup().click(await within(line).findByRole('button', { name: 'Assign…' }));
  return screen.findByRole('dialog', { name: 'Assign ACME-12' }, { timeout: 5000 });
};

/** Choose `userId` in the open picker and answer what it says will follow. */
const choose = async (dialog: HTMLElement, userId: string): Promise<string> => {
  const field = await within(dialog).findByLabelText('Person');
  await userEvent.setup().selectOptions(field, userId);
  return dialog.querySelector('[data-owner-assign-consequence]')?.textContent ?? '';
};

describe('assigning a task (Assign…)', () => {
  it('reads the people for this task, says what follows, sends their id and says it is done', async () => {
    const { sent, candidateReads } = start(
      detail(
        { can_take: true, can_assign: true, can_unassign: true },
        { ...OWNED_BY_VOJTECH, ...HELD_BY(`Jan Novák ${HOSTILE}`) },
      ),
      'maintainer',
    );
    const dialog = await openPicker();
    // Petra writes back: the tracker is reassigned to her, replacing who it shows.
    expect(await choose(dialog, PETRA)).toBe(
      `Assign ACME-12 to Petra? Vojtěch’s machine stops getting it. This also assigns ACME-12 in Jira to Petra, replacing Jan Novák ${HOSTILE}.`,
    );
    expect(dialog.querySelector('img')).toBeNull();
    expect(candidateReads).toEqual([`?task_id=${TASK}`]);
    // Nothing is sent until the person presses Assign.
    expect(sent).toHaveLength(0);
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Assign' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.path).toBe(`/api/tasks/${TASK}/owner`);
    expect(sent[0]?.body).toEqual({ user_id: PETRA });
    expect(sent[0]?.key).not.toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(await ownerDone()).toBe(
      'Assigned to Petra. Their machine picks it up at the next stage.',
    );
  });

  it('says the tracker still shows its assignee when the chosen person is not written back', async () => {
    start(
      detail(
        { can_assign: true },
        { ...OWNED_BY_VOJTECH, ...JIRA_SHOWS_VOJTECH, owner_source: 'tracker' },
      ),
      'maintainer',
      undefined,
      () => json({ items: [{ user_id: PETRA, name: 'Petra', writes_back: false }] }),
    );
    const dialog = await openPicker();
    const said = await choose(dialog, PETRA);
    expect(said).toBe(
      'Assign ACME-12 to Petra? Vojtěch’s machine stops getting it. Jira still shows Vojtěch.',
    );
    expect(said).not.toContain('assigns');
  });

  it('says nothing of the tracker when nobody owns it, nobody holds it and the person is not written back', async () => {
    start(detail({ can_assign: true }), 'maintainer', undefined, () =>
      json({ items: [{ user_id: PETRA, name: 'Petra', writes_back: false }] }),
    );
    const dialog = await openPicker();
    expect(await choose(dialog, PETRA)).toBe('Assign ACME-12 to Petra?');
  });

  it('says the reader’s own machine stops getting it when they own it now', async () => {
    const { sent } = start(
      detail({ can_assign: true, can_unassign: true }, OWNED_BY_ME),
      'maintainer',
    );
    const dialog = await openPicker();
    expect(await choose(dialog, PETRA)).toBe(
      'Assign ACME-12 to Petra? Your machine stops getting it. This also assigns ACME-12 in Jira to Petra.',
    );
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Assign' }));
    await waitFor(() => {
      expect(sent[0]?.body).toEqual({ user_id: PETRA });
    });
  });

  it('says why when nobody else in the project can own tasks', async () => {
    start(detail({ can_assign: true }, OWNED_BY_VOJTECH), 'maintainer', undefined, () =>
      json({ items: [{ user_id: VOJTECH, name: 'Vojtěch', writes_back: true }] }),
    );
    const dialog = await openPicker();
    await waitFor(() => {
      expect(dialog.querySelector('[data-owner-picker-empty]')?.textContent).toBe(
        'Nobody else in this project can own tasks: owning one takes the member role or above here.',
      );
    });
    expect(
      (within(dialog).getByRole('button', { name: 'Assign' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says so when the people could not be read', async () => {
    start(detail({ can_assign: true }), 'maintainer', undefined, () =>
      json({ error: { code: 'forbidden', message: 'not a maintainer here' } }, 403),
    );
    const dialog = await openPicker();
    expect(
      await within(dialog).findByText('The people who can own it could not be read.'),
    ).toBeTruthy();
    expect(within(dialog).queryByLabelText('Person')).toBeNull();
  });

  it('names Vojtěch, whom Jira still shows after he gave the task back, as the person replaced', async () => {
    start(detail({ can_assign: true }, JIRA_SHOWS_VOJTECH), 'maintainer');
    const dialog = await openPicker();
    // Nobody owns it, so no machine stops getting it; Petra writes back and replaces him in Jira.
    expect(await choose(dialog, PETRA)).toBe(
      'Assign ACME-12 to Petra? This also assigns ACME-12 in Jira to Petra, replacing Vojtěch.',
    );
  });

  it('says a written-back assignment replaces the person Jira shows who is not linked', async () => {
    start(detail({ can_assign: true }, HELD_BY('Jan Novák')), 'maintainer');
    const dialog = await openPicker();
    expect(await choose(dialog, PETRA)).toBe(
      'Assign ACME-12 to Petra? This also assigns ACME-12 in Jira to Petra, replacing Jan Novák.',
    );
  });

  it('reads the people again after a 422, so the person who may no longer own drops off', async () => {
    const { candidateReads } = start(detail({ can_assign: true }), 'maintainer', () =>
      json({ error: { code: 'owner_not_project_member', message: 'refused' } }, 422),
    );
    const dialog = await openPicker();
    await choose(dialog, PETRA);
    expect(candidateReads).toHaveLength(1);
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Assign' }));
    await within(dialog).findByText('The owner was not changed.');
    await waitFor(() => {
      expect(candidateReads).toHaveLength(2);
    });
  });

  it('says each refusal in words inside the picker, and nothing was done', async () => {
    const refusals = [
      [
        403,
        'owner_change_not_permitted',
        'Your role does not allow this change of owner. Reload to see who owns it now.',
      ],
      [409, 'task_finished', 'The task has finished, so its owner no longer changes.'],
      [
        422,
        'owner_not_project_member',
        'That person is not a member of this project, so they cannot own it.',
      ],
    ] as const;
    for (const [status, code, words] of refusals) {
      cleanup();
      start(detail({ can_assign: true }), 'maintainer', () =>
        json({ error: { code, message: 'refused' } }, status),
      );
      const dialog = await openPicker();
      await choose(dialog, PETRA);
      await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Assign' }));
      const title = await within(dialog).findByText('The owner was not changed.');
      expect(title.closest('[data-flash]')?.textContent).toContain(words);
      // The picker stays open with the refusal beside its button; no status line claims a change.
      expect(screen.getByRole('dialog', { name: 'Assign ACME-12' })).toBeTruthy();
      expect(document.querySelector('[data-owner-done]')).toBeNull();
    }
  });
});
