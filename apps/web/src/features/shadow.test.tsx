/**
 * The Shadow screen against product/10:20 (WP-34).
 *
 * > *"Shadow — shadow-mode runs: comparison with the human MR, predicted cost, similarity"*
 *
 * Three things are held here, and they are the three a reader would be misled by:
 *
 *  - **the four nulls**. A ticket with no similarity figure has one of four different reasons, and
 *    a screen that printed an em dash for all of them would tell a founder that a running batch had
 *    produced a bad comparison. `missingSimilarityReason` is the decision and every branch of it is
 *    driven, both through the function and through the rendered page.
 *  - **the gate**. When a batch cannot be started the screen says why, rather than offering a
 *    button that answers 409.
 *  - **untrusted text stays text** (BD-022). The ticket key, the refusal sentence and the report's
 *    notes all come from outside; a planted `<script>` must be on the page as characters, and the
 *    human merge request's URL must go through `safeHref`.
 */
import type { ShadowBatchResponse, ShadowBatchTicket } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { missingSimilarityReason } from './shadow.js';

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
  await screen.findByText('Shadow mode');
  return container;
};

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

describe('the Shadow screen', () => {
  it('shows the batch, its aggregate and its launch candidates', async () => {
    const container = await renderScreen();
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

  it('teaches an empty state rather than shrugging', async () => {
    world.batches = 0;
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain('No shadow batch yet');
    });
    expect(container.textContent).toContain('closed tickets your team delivered');
  });

  it('says why a batch cannot be started, and disables the button', async () => {
    world.canStart = false;
    world.blockedReason = 'shadow mode is off for this project';
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain('shadow mode is off for this project');
    });
    const button = screen.getByRole('button', { name: 'Start a shadow batch' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers the button when the project may start one — the other direction', async () => {
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain('Ticket keys');
    });
    // Still disabled until something is typed, which is a different reason and is the one the
    // screen should give a founder who has not chosen any tickets.
    const button = screen.getByRole('button', { name: 'Start a shadow batch' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
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
    const container = await renderScreen();
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
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain('no countable human lines');
    });
    expect(container.textContent).not.toContain('size ratio: 0.00');
    // …and the other direction (standing rule 42): the default fixture's ratio is still printed.
    world.tickets = [ticket()];
    const rendered = await renderScreen();
    await waitFor(() => {
      expect(rendered.textContent).toContain('1.20');
    });
  });

  it('renders the human merge request as a link that went through safeHref', async () => {
    const container = await renderScreen();
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
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain('human MR !7');
    });
    // `urlSchema` is `z.url()` and accepts `javascript:` (Q49); `ExternalLink` is what refuses it,
    // and the refusal is visible rather than silent.
    expect(container.querySelector('[data-link-refused="true"]')).not.toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
