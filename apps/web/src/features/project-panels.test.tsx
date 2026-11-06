/**
 * The proposal queue, against the one thing a maintainer must be able to tell about a proposal
 * before deciding it: **where it came from** (WP-35 review round 2).
 *
 * `knowledge_proposal_source` gained `history` so that a page mined from merged merge requests is
 * distinguishable from one the Discovery agent drafted — the card carried `type`, `kind`,
 * `target_path`, `significance`, `delta`, `evidence` and `status`, and rendered the source
 * **nowhere**, so the column existed and the reader it exists for could not see it. Both directions
 * are driven here (standing rule 42): a `history` proposal and a `bootstrap` one, in one queue, each
 * showing its own label.
 *
 * The rest of the card is held to BD-022 in passing: the target path and the evidence lines come
 * from a model reading somebody else's merge requests, so a planted `<script>` must reach the page
 * as characters.
 */
import type { KbProposalsResponse, KnowledgeProposalRecord } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';

/** Planted so the assertion has something hostile to look for (standing rule 45). */
const HOSTILE_EVIDENCE =
  '<script>alert(1)</script> https://git.example.test/acme/api/-/merge_requests/7';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const proposal = (overrides: Partial<KnowledgeProposalRecord>): KnowledgeProposalRecord =>
  ({
    id: '00000000-0000-4000-8000-0000000000c1',
    project_id: PROJECT,
    task_id: null,
    run_id: null,
    source: 'history',
    kind: 'technical',
    type: 'rule',
    target_path: 'conventions.md',
    delta: 'Rounding happens once, at the boundary.',
    evidence: [HOSTILE_EVIDENCE],
    significance: 0.5,
    status: 'queued',
    decided_by_user_id: null,
    decided_at: null,
    applied_commit_sha: null,
    created_at: '2026-09-14T10:00:00.000Z',
    ...overrides,
  }) as KnowledgeProposalRecord;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let proposals: KbProposalsResponse;
/** What `GET …/kb/health` answers in the current case (WP-95): a status and a body. */
let health: { readonly status: number; readonly body: unknown };

const NOT_REPORTED = {
  status: 409,
  body: {
    error: {
      code: 'kb_health_not_reported',
      message: 'no knowledge health report for this project yet',
    },
  },
};

const report = (findings: readonly unknown[]) => ({
  status: 200,
  body: {
    id: '00000000-0000-4000-8000-0000000000e1',
    project_id: PROJECT,
    commit_sha: 'c'.repeat(40),
    documents: 12,
    findings,
    source: 'hygiene',
    created_at: '2026-09-29T02:00:00.000Z',
  },
});

/** The vault's files (`GET …/kb/tree`); empty unless a case plants some. */
let treePaths: readonly string[] = [];
/** Every decision posted, and what the server answers one with (S-23.11b). */
let decisions: { readonly url: string; readonly body: unknown }[] = [];
let decisionAnswer: { readonly status: number; readonly body: unknown } = {
  status: 200,
  body: { performed: true },
};

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.includes('/api/auth/get-session')) return json(SESSION);
  if (init?.method === 'POST' && url.includes('/kb/proposals/')) {
    decisions.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
    return json(decisionAnswer.body, decisionAnswer.status);
  }
  if (url.includes('/kb/doc')) {
    const path = new URL(url, 'http://localhost').searchParams.get('path') ?? '';
    return json({ path, commit_sha: null, frontmatter: {}, content: `The page at ${path}.` });
  }
  if (url.endsWith('/api/projects')) {
    return json({
      items: [
        {
          id: PROJECT,
          key: 'api',
          name: 'API',
          repo_url: 'https://git.example.test/acme/api.git',
          default_branch: 'main',
          agentic_dir: '.agentic',
          knowledge_dir: '.agentic/knowledge',
          autonomy_level: 'observe',
          readiness_level: 1,
          status: 'active',
          created_at: '2026-09-13T04:00:00.000Z',
          updated_at: '2026-09-13T04:00:00.000Z',
          open_tasks: 0,
          spent_usd_30d: 0,
        },
      ],
    });
  }
  if (url.includes('/kb/proposals')) return json(proposals);
  if (url.endsWith(`/api/projects/${PROJECT}/budgets`)) {
    return json({
      items: [
        {
          id: '00000000-0000-4000-8000-0000000000d1',
          scope: 'project',
          scope_id: PROJECT,
          window: 'month',
          limit_usd: 40,
          notify_pct: [50, 80],
          spent_usd: 3.25,
        },
      ],
    });
  }
  if (url.includes(`/api/projects/${PROJECT}/spend`)) {
    const window = new URL(url, 'http://app.example.invalid').searchParams.get('window') ?? '';
    spendWindows.push(window);
    return json(window === 'day' ? EMPTY_SPEND : { ...SPEND, window });
  }
  if (url.includes('/kb/health')) return json(health.body, health.status);
  if (url.includes('/kb/tree')) {
    return json({
      commit_sha: null,
      entries: treePaths.map((path) => ({ path, kind: 'file', tokens: null, updated_at: null })),
    });
  }
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

/** `GET …/spend` (S-25.7): the windows asked for, and what each answers. */
let spendWindows: string[] = [];

const SPEND = {
  window: 'month',
  window_start: '2026-09-01T00:00:00.000Z',
  usd: 3.3,
  estimated_usd: 0.25,
  stages: [
    { stage: 'implementation', usd: 2.5, estimated_usd: 0.25 },
    { stage: 'refinement', usd: 0.75, estimated_usd: 0 },
    // Spend outside a stage — an ask — is published with no stage (review of PR #86).
    { stage: null, usd: 0.05, estimated_usd: 0 },
  ],
  top_tasks: [
    {
      task_id: '00000000-0000-4000-8000-0000000000e1',
      ticket_key: 'ACME-7',
      // A ticket title is provider text: it must reach the row as characters.
      ticket_title: 'Checkout <img src=x>',
      mode: 'normal',
      usd: 2.5,
      estimated_usd: 0.25,
    },
    {
      task_id: '00000000-0000-4000-8000-0000000000e2',
      ticket_key: 'ACME-3',
      ticket_title: null,
      mode: 'shadow',
      usd: 0.75,
      estimated_usd: 0,
    },
  ],
};

const EMPTY_SPEND = {
  window: 'day',
  window_start: '2026-09-14T00:00:00.000Z',
  usd: 0,
  estimated_usd: 0,
  stages: [],
  top_tasks: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  health = NOT_REPORTED;
  spendWindows = [];
  treePaths = [];
  decisions = [];
  decisionAnswer = { status: 200, body: { performed: true } };
  proposals = {
    items: [
      proposal({ source: 'history' }),
      proposal({
        id: '00000000-0000-4000-8000-0000000000c2',
        source: 'bootstrap',
        type: 'doc-update',
        target_path: 'technical/architecture.md',
        delta: 'The invoice module owns rounding.',
        evidence: ['drafted from the repository at onboarding'],
      }),
    ],
    next_cursor: null,
  };
  window.history.pushState({}, '', '/projects/api/knowledge');
});

const renderScreen = async (): Promise<HTMLElement> => {
  const { container } = render(createApp({ fetchImpl, realtime: false }).element);
  await screen.findByText('Suggested edits');
  return container;
};

describe('the proposal queue', () => {
  it('says which proposal was mined from history and which was drafted at project setup', async () => {
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain('mined from merged history');
    });
    // The other direction, in the same queue: without it a screen that printed one label for
    // everything would pass (standing rule 42).
    expect(container.textContent).toContain('drafted at project setup');
    // …and the fields the card already carried are still there.
    expect(container.textContent).toContain('conventions.md');
    // S-25.5: the significance score is the Librarian's ranking, not a reader's fact (research/21 § 4).
    expect(container.textContent).not.toContain('significance');
  });

  it('says why an approved proposal failed to apply, as text, and offers to approve it again (WP-124)', async () => {
    proposals = {
      items: [
        proposal({
          status: 'apply_failed',
          decided_at: '2026-09-14T11:00:00.000Z',
          apply_failure_reason: `the platform could not commit this approved change ${HOSTILE_EVIDENCE}`,
        }),
      ],
      next_cursor: null,
    };
    const container = await renderScreen();
    const notice = await waitFor(() => {
      const found = container.querySelector('[data-apply-failed="true"]');
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(notice.textContent).toContain('apply failed');
    expect(notice.textContent).toContain('could not commit this approved change');
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve again' })).toBeTruthy();
  });

  it('draws no apply failure on a proposal that has none (the other side)', async () => {
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain('conventions.md');
    });
    expect(container.querySelector('[data-apply-failed="true"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve again' })).toBeNull();
  });

  it('says, as text, that an approved proposal waits for the open knowledge merge request that creates its page (WP-125)', async () => {
    proposals = {
      items: [
        proposal({
          status: 'queued',
          decided_at: '2026-09-14T11:00:00.000Z',
          apply_deferred_reason: `this approved change waits for knowledge merge request !4 ${HOSTILE_EVIDENCE}`,
        }),
      ],
      next_cursor: null,
    };
    const container = await renderScreen();
    const notice = await waitFor(() => {
      const found = container.querySelector('[data-apply-deferred="true"]');
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(notice.textContent).toContain('waits for a merge');
    expect(notice.textContent).toContain('knowledge merge request !4');
    expect(container.querySelector('script')).toBeNull();
  });

  it('draws no deferral on a proposal that waits for nothing (the other side)', async () => {
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain('conventions.md');
    });
    expect(container.querySelector('[data-apply-deferred="true"]')).toBeNull();
    expect(container.textContent).not.toContain('waits for a merge');
  });

  it('renders a mined citation as text, whatever the merge request it came from said', async () => {
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain(HOSTILE_EVIDENCE);
    });
    expect(container.querySelector('script')).toBeNull();
  });
});

/**
 * The knowledge health report (WP-95, PROGRESS backlog 37): three answers the panel keeps apart —
 * no report yet, a report with nothing wrong, and a report with findings (standing rule 18).
 */
describe('the knowledge health panel', () => {
  it('says no pass has reported yet on the read’s 409, rather than drawing a clean vault', async () => {
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain('No health report yet');
    });
    expect(container.querySelector('[data-kb-health]')).toBeNull();
  });

  it('lists the findings as text, naming a refused page as absent from every pack', async () => {
    const hostile = 'frontmatter key <img src=x onerror=alert(1)> is not allowed';
    health = report([
      { kind: 'invalid', path: 'technical/broken.md', detail: hostile },
      { kind: 'dangling', path: 'conventions.md', detail: 'links to [[nowhere]]' },
    ]);
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.querySelector('[data-kb-health="findings"]')).not.toBeNull();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('cannot be read — never given to agents');
    expect(text).toContain('technical/broken.md');
    expect(text).toContain(hostile);
    expect(text).toContain('dangling link');
    expect(text).toContain('12 documents indexed');
    expect(container.querySelector('img')).toBeNull();
  });

  it('says the last pass found nothing wrong for a report with no findings', async () => {
    health = report([]);
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.querySelector('[data-kb-health="clean"]')).not.toBeNull();
    });
    expect(container.textContent).not.toContain('No health report yet');
  });
});

/**
 * The knowledge screen in the new language (S-23.11b): the vault as a NavList tree, the document
 * beside it, and the proposals as a list box with *Approve* on each row and *Reject* in its menu —
 * each decision a command the server receives, and a refused one said rather than swallowed.
 */
describe('the knowledge screen’s files, document and decisions (S-23.11b)', () => {
  it('lists the vault as one NavList group per directory and opens a document as text', async () => {
    treePaths = ['conventions.md', 'technical/architecture.md', 'technical/<b>data</b>.md'];
    await renderScreen();
    const files = await screen.findByRole('navigation', { name: 'Knowledge files' });
    // The directory is the group's heading; the file is the item.
    expect(within(files).getByRole('heading', { name: 'technical' })).toBeTruthy();
    expect(within(files).getByRole('button', { name: 'conventions.md' })).toBeTruthy();
    expect(files.querySelector('b')).toBeNull();
    await userEvent.setup().click(within(files).getByRole('button', { name: 'architecture.md' }));
    expect(await screen.findByText('The page at technical/architecture.md.')).toBeTruthy();
    expect(
      within(files).getByRole('button', { name: 'architecture.md' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  /**
   * S-25.1 (research/21 F2): *Approve* sits beside the change, so the change is **open** on a row a
   * maintainer still decides — and collapsed once it is decided (the other side, rule 42).
   */
  it('shows a waiting proposal’s change open beside its Approve, and a decided one collapsed', async () => {
    proposals = {
      items: [
        proposal({}),
        proposal({
          id: '00000000-0000-4000-8000-0000000000c3',
          target_path: 'decided.md',
          status: 'applied',
          applied_commit_sha: 'a'.repeat(40),
        }),
      ],
      next_cursor: null,
    };
    await renderScreen();
    const list = await screen.findByRole('list', { name: 'Suggested edits' });
    const rows = within(list).getAllByRole('listitem');
    const waiting = rows.find((row) => row.textContent?.includes('conventions.md')) as HTMLElement;
    const decided = rows.find((row) => row.textContent?.includes('decided.md')) as HTMLElement;
    expect(within(waiting).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(waiting.querySelector('details')?.open).toBe(true);
    expect(waiting.textContent).toContain('Rounding happens once, at the boundary.');
    expect(decided.querySelector('details')?.open).toBe(false);
  });

  /**
   * S-25.7 (product/10's 2026-11-06 amendment, research/21 S14): the proposals waiting for the
   * reader come first — above the health pass, and above the decided ones in the list.
   */
  it('puts the waiting proposals first: above the health pass, and above the decided ones', async () => {
    health = report([]);
    proposals = {
      items: [
        proposal({
          id: '00000000-0000-4000-8000-0000000000c4',
          target_path: 'decided.md',
          status: 'rejected',
        }),
        proposal({ target_path: 'waiting.md' }),
      ],
      next_cursor: null,
    };
    const container = await renderScreen();
    const list = await screen.findByRole('list', { name: 'Suggested edits' });
    const panel = await waitFor(() => {
      const found = container.querySelector('[data-kb-health]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    // Document order: the queue precedes the health panel.
    expect(list.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The list's own rows: each row nests its evidence lines as list items of their own.
    const paths = within(list)
      .getAllByRole('listitem')
      .filter((row) => row.parentElement === list)
      .map((row) => (row.textContent?.includes('waiting.md') ? 'waiting' : 'decided'));
    expect(paths).toEqual(['waiting', 'decided']);
  });

  it('approves a proposal from its row and rejects one from the row’s menu', async () => {
    await renderScreen();
    const list = await screen.findByRole('list', { name: 'Suggested edits' });
    const user = userEvent.setup();
    await user.click(within(list).getAllByRole('button', { name: 'Approve' })[0] as HTMLElement);
    await waitFor(() => {
      expect(decisions.map((entry) => entry.url.split('/kb/proposals/')[1])).toEqual([
        '00000000-0000-4000-8000-0000000000c1/approve',
      ]);
    });
    await user.click(
      within(list).getByRole('button', { name: 'More for technical/architecture.md' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Reject…' }));
    // S-23.23: a reject asks first, says what it does, and sends the person's own reason — never
    // the canned "rejected from the UI" it used to.
    const dialog = await screen.findByRole('dialog', { name: 'Reject this suggested edit?' });
    expect(dialog.textContent).toContain('the suggestion is closed for good');
    expect(decisions).toHaveLength(1);
    await user.type(
      within(dialog).getByLabelText('Why (the Librarian learns from it)'),
      'duplicates conventions.md',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(decisions).toHaveLength(2);
    });
    expect(decisions[1]?.url).toContain('00000000-0000-4000-8000-0000000000c2/reject');
    expect(decisions[1]?.body).toEqual({
      decision: 'reject',
      reason: 'duplicates conventions.md',
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('keeps a proposal when the reject is not confirmed', async () => {
    await renderScreen();
    const list = await screen.findByRole('list', { name: 'Suggested edits' });
    const user = userEvent.setup();
    await user.click(
      within(list).getByRole('button', { name: 'More for technical/architecture.md' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Reject…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject this suggested edit?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(decisions).toHaveLength(0);
  });

  it('says a refused decision was not recorded, with the server’s reason', async () => {
    decisionAnswer = {
      status: 403,
      body: { error: { code: 'forbidden', message: 'role viewer may not perform kb.decide' } },
    };
    await renderScreen();
    const list = await screen.findByRole('list', { name: 'Suggested edits' });
    await userEvent
      .setup()
      .click(within(list).getAllByRole('button', { name: 'Approve' })[0] as HTMLElement);
    expect(await screen.findByText('The decision was not recorded.')).toBeTruthy();
    expect(document.body.textContent).toContain('role viewer may not perform kb.decide');
  });

  it('shows the health report as a notice, not as a card of its own', async () => {
    health = report([]);
    const container = await renderScreen();
    const clean = await waitFor(() => {
      const found = container.querySelector('[data-kb-health="clean"] [data-flash]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(clean.getAttribute('data-flash')).toBe('success');
  });
});

describe('the budgets screen (S-23.11b)', () => {
  it('draws each budget as spent of limit on a native meter, in words, with no inline style', async () => {
    window.history.pushState({}, '', '/projects/api/budgets');
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    const meter = await screen.findByLabelText('Cap used');
    expect(meter.tagName).toBe('METER');
    // The attributes, not the IDL properties: happy-dom's `HTMLMeterElement.value` clamps to 1.
    expect(meter.getAttribute('value')).toBe('3.25');
    expect(meter.getAttribute('max')).toBe('40');
    expect(meter.getAttribute('style')).toBeNull();
    const list = screen.getByRole('list', { name: 'Budgets' });
    expect(list.textContent).toContain('Per month');
    expect(list.textContent).toContain('$3.25 of $40.00');
    expect(list.textContent).toContain('8% used · notified at 50%, 80%');
    expect(container.querySelector('meter[style]')).toBeNull();
  });

  /**
   * S-25.7 (product/10's 2026-11-06 IA amendment, research/21 F8): the cap is set here — no link
   * out to the settings page — and the page's one primary action is the editor's Save.
   */
  it('sets the cap on the same page, with Save budgets as its one primary action', async () => {
    window.history.pushState({}, '', '/projects/api/budgets');
    render(createApp({ fetchImpl, realtime: false }).element);
    expect(await screen.findByRole('heading', { name: 'Project budgets' })).toBeTruthy();
    expect(screen.getByLabelText('Per month')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save budgets' });
    // The amber primary is the `border-primary-line` class (`ui/button.tsx`): one per view.
    expect(save.className).toContain('border-primary-line');
    const main = screen.getByRole('main');
    expect(main.querySelectorAll('.border-primary-line')).toHaveLength(1);
    expect(screen.queryByRole('link', { name: /project settings/i })).toBeNull();
  });

  it('shows the month’s spend per stage and its top tasks, an estimate labelled one', async () => {
    window.history.pushState({}, '', '/projects/api/budgets');
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    const stages = await screen.findByRole('list', { name: 'By stage' });
    expect(spendWindows).toEqual(['month']);
    const rows = within(stages).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // Most first, each in words, the priced part said as an estimate and only where there is one.
    expect(rows[0]?.textContent).toContain('Implementation');
    expect(rows[0]?.textContent).toContain('$2.50 ($0.25 estimated)');
    expect(rows[1]?.textContent).toContain('Refinement');
    expect(rows[1]?.textContent).not.toContain('estimated');
    expect(rows[2]?.textContent).toContain('Questions to an agent');
    expect(rows[2]?.textContent).toContain('$0.05');
    expect(
      screen.getByRole('heading', { name: 'Spent this month: $3.30 ($0.25 estimated)' }),
    ).toBeTruthy();
    const tasks = screen.getByRole('list', { name: 'Top tasks' });
    const link = within(tasks).getByRole('link', { name: /ACME-7/ });
    expect(link.getAttribute('href')).toBe(
      '/projects/api/tasks/00000000-0000-4000-8000-0000000000e1',
    );
    // The title is characters, never an element; a trial's task says so in words.
    expect(link.textContent).toContain('Checkout <img src=x>');
    expect(container.querySelector('img')).toBeNull();
    expect(within(tasks).getByText('Trial run')).toBeTruthy();
  });

  it('asks for the window chosen, and says nothing was spent rather than drawing empty lists', async () => {
    window.history.pushState({}, '', '/projects/api/budgets');
    render(createApp({ fetchImpl, realtime: false }).element);
    await screen.findByRole('list', { name: 'By stage' });
    await userEvent.setup().selectOptions(screen.getByLabelText('Window'), 'day');
    expect(await screen.findByText('Nothing was spent today')).toBeTruthy();
    expect(spendWindows).toEqual(['month', 'day']);
    expect(screen.queryByRole('list', { name: 'By stage' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Top tasks' })).toBeNull();
  });
});
