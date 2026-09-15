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
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  if (url.includes('/kb/proposals')) return json(proposals);
  if (url.includes('/kb/tree')) return json({ commit_sha: null, entries: [] });
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
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
  await screen.findByText('Proposals');
  return container;
};

describe('the proposal queue', () => {
  it('says which proposal was mined from history and which was drafted at onboarding', async () => {
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain('mined from merged history');
    });
    // The other direction, in the same queue: without it a screen that printed one label for
    // everything would pass (standing rule 42).
    expect(container.textContent).toContain('drafted at onboarding');
    // …and the fields the card already carried are still there.
    expect(container.textContent).toContain('conventions.md');
    expect(container.textContent).toContain('significance 0.50');
  });

  it('renders a mined citation as text, whatever the merge request it came from said', async () => {
    const container = await renderScreen();
    await waitFor(() => {
      expect(container.textContent).toContain(HOSTILE_EVIDENCE);
    });
    expect(container.querySelector('script')).toBeNull();
  });
});
