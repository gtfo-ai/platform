/**
 * The Trial screen (the Shadow screen until S-25.7) against product/10:20 (WP-34).
 *
 * > *"Shadow — shadow-mode runs: comparison with the human MR, predicted cost, similarity"*
 *
 * Three things are held here, and they are the three a reader would be misled by:
 *
 *  - **the four nulls**. A ticket with no similarity figure has one of four different reasons, and
 *    a screen that printed an em dash for all of them would tell a founder that a running batch had
 *    produced a bad comparison. `missingSimilarityReason` is the decision and every branch of it is
 *    driven, both through the function and through the rendered page.
 *  - **the gate, one state at a time** (S-25.7, research/21 F7). When a trial cannot be started the
 *    screen says why, as a sentence, rather than offering a button that answers 409 — and never
 *    beside an error or an empty state: pending, failed, blocked and ready are four pages.
 *  - **untrusted text stays text** (BD-022). The ticket key, the refusal sentence and the report's
 *    notes all come from outside; a planted `<script>` must be on the page as characters, and the
 *    human merge request's URL must go through `safeHref`.
 */
import type { ShadowBatchResponse, ShadowBatchTicket } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { HumanSideOfReport, missingSimilarityReason, trialBlockedSentence } from './shadow.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const BATCH = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';

/** Planted so the assertion has something hostile to look for (standing rule 45). */
const HOSTILE_KEY = '<script>alert(1)</script>';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const ticket = (overrides: Partial<ShadowBatchTicket> = {}): ShadowBatchTicket =>
  ({
    ticket_key: 'ACME-1',
    task_id: TASK,
    task_state: 'ready_for_merge',
    refused_reason: null,
    base_sha: 'b'.repeat(40),
    human_mr: {
      provider: 'fake-git',
      project_path: 'acme/api',
      iid: 7,
      url: 'https://git.example.test/acme/api/-/merge_requests/7',
      branch: 'feature/acme-1',
      head_sha: 'a'.repeat(40),
    },
    human_mr_source: 'title_scan',
    size: 'M',
    cost_usd: 4.25,
    predicted_cost_usd: 6,
    similarity: 0.75,
    report: {
      ticket: 'ACME-1',
      human_mr: null,
      agent_diff_stats: { files_changed: 2, insertions: 10, deletions: 1 },
      overlap: {
        files_jaccard: 0.75,
        size_ratio: 1.2,
        tests_added_ratio: 0.5,
        agent_test_files: 1,
        human_test_files: 2,
      },
      agent_review_of_human_mr: null,
      predicted_cost: 6,
      shadow_cost: 4.25,
      reviewer_minutes_estimate: 25,
      notes: 'both diffs are taken against bbbb',
    },
    ...overrides,
  }) as ShadowBatchTicket;

const batch = (tickets: readonly ShadowBatchTicket[]): ShadowBatchResponse =>
  ({
    batch: {
      id: BATCH,
      project_id: PROJECT,
      created_at: '2026-09-14T10:00:00.000Z',
      completed_at: null,
      budget_usd: 50,
      spent_usd: 4.25,
      tickets: tickets.length,
      refused: tickets.filter((entry) => entry.refused_reason !== null).length,
    },
    tickets,
    aggregate: {
      cost_by_size: [
        { size: 'M', tickets: 1, median_cost_usd: 4.25, median_predicted_cost_usd: 6 },
      ],
      similarity_distribution: [
        { from: 0, to: 0.2, tickets: 0 },
        { from: 0.2, to: 0.4, tickets: 0 },
        { from: 0.4, to: 0.6, tickets: 0 },
        { from: 0.6, to: 0.8, tickets: 1 },
        { from: 0.8, to: 1, tickets: 0 },
      ],
      launch_candidates: [
        { ticket_key: 'ACME-1', task_id: TASK, similarity: 0.75, cost_usd: 4.25 },
      ],
      reported: 1,
      compared: 1,
    },
  }) as ShadowBatchResponse;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World {
  canStart: boolean;
  blockedReason: string | null;
  tickets: readonly ShadowBatchTicket[];
  batches: number;
  /** The batches read answers 500 (S-25.7's error state). */
  failBatches?: boolean;
}

let world: World;

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes('/api/auth/get-session')) return json(SESSION);
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
  if (url.includes('/api/shadow-batches/')) return json(batch(world.tickets));
  if (url.endsWith('/shadow-batches')) {
    if (world.failBatches === true) {
      return json({ error: { code: 'internal', message: 'the read failed' } }, 500);
    }
    return json({
      items:
        world.batches === 0
          ? []
          : [
              {
                id: BATCH,
                project_id: PROJECT,
                created_at: '2026-09-14T10:00:00.000Z',
                completed_at: null,
                budget_usd: 50,
                spent_usd: 4.25,
                tickets: world.tickets.length,
                refused: 0,
              },
            ],
      can_start: world.canStart,
      blocked_reason: world.blockedReason,
    });
  }
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  world = { canStart: true, blockedReason: null, tickets: [ticket()], batches: 1 };
  window.history.pushState({}, '', '/projects/api/shadow');
});

const renderScreen = async (): Promise<HTMLElement> => {
  const { container } = render(createApp({ fetchImpl, realtime: false }).element);
  await screen.findByText('Trial run');
  return container;
};

/** One batch's page — `?batch=<id>` since S-23.11b — which carries the aggregate and the tickets. */
const renderBatch = async (): Promise<HTMLElement> => {
  window.history.pushState({}, '', `/projects/api/shadow?batch=${BATCH}`);
  const { container } = render(createApp({ fetchImpl, realtime: false }).element);
  await screen.findByRole('region', { name: 'This trial in figures' });
  return container;
};

describe('trialBlockedSentence (S-25.7)', () => {
  it('says the server’s clause as a sentence, and says something when there is none', () => {
    expect(trialBlockedSentence('trial runs are off for this project')).toBe(
      'Trial runs are off for this project.',
    );
    expect(trialBlockedSentence('Already a sentence.')).toBe('Already a sentence.');
    expect(trialBlockedSentence(null)).toBe('A trial cannot be started for this project.');
    expect(trialBlockedSentence('  ')).toBe('A trial cannot be started for this project.');
  });
});

describe('missingSimilarityReason', () => {
  it('names each of the four reasons a figure is absent, and says nothing when there is one', () => {
    expect(missingSimilarityReason(ticket())).toBeNull();
    expect(
      missingSimilarityReason(
        ticket({ task_id: null, refused_reason: 'no merge base', similarity: null, report: null }),
      ),
    ).toBe('not run');
    expect(missingSimilarityReason(ticket({ similarity: null, report: null }))).toBe(
      'still running',
    );
    expect(missingSimilarityReason(ticket({ similarity: null, human_mr: null }))).toContain(
      'no human merge request',
    );
    expect(
      missingSimilarityReason(
        ticket({ similarity: null, report: { ...ticket().report, overlap: null } as never }),
      ),
    ).toContain('produced no merge request');
  });
});

describe('the Trial screen', () => {
  it('says a batch id the project’s batches do not name is not this project’s, and reads nothing by it', async () => {
    // Review of PR #25: the id is compared with this project's batches before the batch is read,
    // so another project's batch is never drawn under this project's tab.
    const requested: string[] = [];
    window.history.pushState(
      {},
      '',
      '/projects/api/shadow?batch=00000000-0000-4000-8000-00000000ffff',
    );
    render(
      createApp({
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          requested.push(String(input));
          return fetchImpl(input, init);
        }) as typeof fetch,
        realtime: false,
      }).element,
    );
    expect(await screen.findByText('No such trial in this project')).toBeTruthy();
    expect(requested.some((url) => url.includes('/shadow-batches/'))).toBe(false);
    expect(screen.queryByRole('region', { name: 'This trial in figures' })).toBeNull();
    // …and the other direction: the project's own batch id is read and drawn.
    cleanup();
    await renderBatch();
    expect(screen.queryByText('No such trial in this project')).toBeNull();
  });

  it('lists each batch as a row that opens its page, and draws no aggregate on the list', async () => {
    const container = await renderScreen();
    const list = await screen.findByRole('list', { name: 'Trials' });
    const link = within(list).getByRole('link', { name: /^Trial of / });
    // The URL is the old one (S-25.7 renamed the words, not the route).
    expect(link.getAttribute('href')).toBe(`/projects/api/shadow?batch=${BATCH}`);
    expect(container.textContent).not.toContain('Launch candidates');
    await userEvent.setup().click(link);
    expect(await screen.findByRole('region', { name: 'This trial in figures' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '← All trials' })).toBeTruthy();
  });

  it('shows the batch, its aggregate and its launch candidates', async () => {
    const container = await renderBatch();
    await waitFor(() => {
      expect(container.textContent).toContain('Launch candidates');
    });
    expect(container.textContent).toContain('Cost per ticket by size');
    expect(container.textContent).toContain('Similarity distribution');
    // The comparison itself, as a percentage rather than as `0.75`.
    expect(container.textContent).toContain('75 %');
    expect(container.textContent).toContain('reviewer minutes (estimate)');
    // …and which of Q82 (b)'s two lookups found the merge request.
    expect(container.textContent).toContain('found by a title scan');
  });

  it('teaches the first trial in the form itself, with no separate empty state (S-25.7)', async () => {
    world.batches = 0;
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.querySelector('[data-trial-state="ready"]')).not.toBeNull();
    });
    expect(container.textContent).toContain('closed tickets your team delivered');
    expect(screen.queryByRole('list', { name: 'Trials' })).toBeNull();
    expect(container.querySelectorAll('[data-trial-state]')).toHaveLength(1);
  });

  it('says why a trial cannot start, as a sentence, and nothing else — no form, no empty state (S-25.7, F7)', async () => {
    world.canStart = false;
    world.batches = 0;
    world.blockedReason = 'trial runs are off for this project';
    const container = await renderScreen();
    const blocked = await waitFor(() => {
      const found = container.querySelector('[data-trial-state="blocked"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    // The server's clause, in words: capitalised and ended.
    expect(blocked.textContent).toContain('Trial runs are off for this project.');
    expect(container.querySelectorAll('[data-trial-state]')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Start a trial run' })).toBeNull();
    expect(screen.queryByLabelText('Ticket keys')).toBeNull();
    expect(container.textContent).not.toContain('closed tickets your team delivered');
    expect(container.textContent).not.toContain('could not be loaded');
  });

  it('shows a failed read as the error alone, never beside the notice or the form (S-25.7, F7)', async () => {
    world.failBatches = true;
    world.canStart = false;
    render(createApp({ fetchImpl, realtime: false }).element);
    // The app's client retries a failed read once (about a second), so the wait allows for it.
    const failed = await screen.findByText('Trials could not be loaded.', {}, { timeout: 5_000 });
    expect(failed).toBeTruthy();
    expect(document.querySelectorAll('[data-trial-state]')).toHaveLength(1);
    expect(document.querySelector('[data-trial-state="error"]')).not.toBeNull();
    expect(screen.queryByText('A trial cannot start yet')).toBeNull();
    expect(screen.queryByLabelText('Ticket keys')).toBeNull();
  });

  it('offers the button when the project may start one — the other direction', async () => {
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain('Ticket keys');
    });
    // Still disabled until something is typed, which is a different reason and is the one the
    // screen should give a founder who has not chosen any tickets.
    const button = screen.getByRole('button', { name: 'Start a trial run' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[data-trial-state="blocked"]')).toBeNull();
  });

  it('renders a refused ticket’s reason as text, and prints "not run" for its similarity', async () => {
    world.tickets = [
      ticket({
        ticket_key: HOSTILE_KEY,
        task_id: null,
        task_state: null,
        refused_reason: 'the human merge request publishes no merge base',
        similarity: null,
        report: null,
        human_mr: null,
        human_mr_source: null,
        size: null,
        cost_usd: 0,
        predicted_cost_usd: null,
      }),
    ];
    const container = await renderBatch();
    await waitFor(() => {
      expect(container.textContent).toContain('publishes no merge base');
    });
    expect(container.textContent).toContain('not run');
    expect(container.textContent).toContain('no human merge request');
    // BD-022: the hostile key is on the page as **characters**, and no element came from it.
    expect(container.textContent).toContain(HOSTILE_KEY);
    expect(container.querySelector('script')).toBeNull();
  });

  it('says the human diff had no countable line rather than printing "size ratio: 0.00"', async () => {
    // Round 2's major finding, at the place a founder reads it: a provider that rendered no patch
    // makes the human side zero lines, and `compareShadowDiffs` answers `null` — which this screen
    // must not `toFixed(2)` into a number that reads as *"the agent changed nothing"*.
    world.tickets = [
      ticket({
        report: {
          ...ticket().report,
          overlap: { ...ticket().report?.overlap, size_ratio: null },
          notes: 'the provider rendered no patch for 2 of the human merge request’s 2 files',
        } as never,
      }),
    ];
    const container = await renderBatch();
    await waitFor(() => {
      expect(container.textContent).toContain('no countable human lines');
    });
    expect(container.textContent).not.toContain('size ratio: 0.00');
    // …and the other direction (standing rule 42): the default fixture's ratio is still printed.
    world.tickets = [ticket()];
    cleanup();
    const rendered = await renderBatch();
    await waitFor(() => {
      expect(rendered.textContent).toContain('1.20');
    });
  });

  it('renders the human merge request as a link that went through safeHref', async () => {
    const container = await renderBatch();
    await waitFor(() => {
      expect(container.textContent).toContain('human MR !7');
    });
    const link = container.querySelector('a[href*="merge_requests/7"]');
    expect(link).not.toBeNull();
  });

  it('refuses to link a merge request whose URL is not http(s)', async () => {
    world.tickets = [
      ticket({
        human_mr: { iid: 7, url: 'javascript:alert(1)' } as never,
      }),
    ];
    const container = await renderBatch();
    await waitFor(() => {
      expect(container.textContent).toContain('human MR !7');
    });
    // `urlSchema` is `z.url()` and accepts `javascript:` (Q49); `ExternalLink` is what refuses it,
    // and the refusal is visible rather than silent.
    expect(container.querySelector('[data-link-refused="true"]')).not.toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});

/**
 * WP-45 criterion 7: whose criteria are the yardstick is **on the screen, before the count**, and a
 * comparison the report withheld draws nothing at all (the notes say why).
 */
describe('the human side of a shadow report (WP-45)', () => {
  const report = (overrides: Record<string, unknown>) =>
    ({ ...(ticket().report as object), ...overrides }) as NonNullable<ShadowBatchTicket['report']>;

  it('labels the comparison as the agent’s own criteria before it prints a number', () => {
    const { container } = render(
      <HumanSideOfReport
        report={report({
          agent_review_of_human_mr: [
            {
              id: 'h1',
              severity: 'major',
              category: 'tests',
              file: null,
              line: null,
              explanation: 'x',
              suggestion: null,
            },
          ],
          criteria_comparison: {
            yardstick: 'agent_refined_spec',
            judged_by: { agent: 'acceptance_tester', human: 'reviewer' },
            criteria: [
              { id: 'ac1', agent: 'met', human: 'not_met' },
              { id: HOSTILE_KEY, agent: 'met', human: 'met' },
            ],
          },
        })}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('1 finding(s) it would have raised — stored here, posted nowhere');
    const label = text.indexOf('measured against the agent’s own specification');
    const count = text.indexOf('human MR met 1 of 2');
    expect(label).toBeGreaterThanOrEqual(0);
    expect(count).toBeGreaterThan(label);
    expect(text).toContain('(of the agent’s criteria)');
    expect(text).toContain('judged by its Acceptance Tester');
    // Never the unlabelled sentence the row forbids.
    expect(text).not.toMatch(/human missed/i);
    // A criterion id is model text: it is characters on the page, never markup.
    expect(text).toContain(HOSTILE_KEY);
    expect(container.querySelector('script')).toBeNull();
  });

  it('draws nothing when no reviewer verdict and no comparison exist', () => {
    const { container } = render(
      <HumanSideOfReport
        report={report({ agent_review_of_human_mr: null, criteria_comparison: null })}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('draws the findings alone when the comparison was withheld', () => {
    const { container } = render(
      <HumanSideOfReport
        report={report({ agent_review_of_human_mr: [], criteria_comparison: null })}
      />,
    );
    expect(container.textContent).toContain('0 finding(s)');
    expect(container.textContent).not.toContain('Acceptance criteria');
  });
});
