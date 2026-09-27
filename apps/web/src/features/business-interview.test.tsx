/**
 * The business interview's form — product/06 step 3 (WP-64).
 *
 * Driven through `createApp` with a fake server, so the real router, query client and endpoint
 * parsers are in the path. Asserted:
 *
 *  - the **request** the form makes — a skipped section is absent, a not-applicable one is marked,
 *    and the command carries an `Idempotency-Key` (it creates proposals);
 *  - the answer is **proposed, not committed** — the screen lists queued pages and links to the
 *    queue;
 *  - what the server answers is rendered as **text** (BD-022).
 */
import { BUSINESS_INTERVIEW_SECTION_IDS } from '@platform/contracts';
import { BUSINESS_INTERVIEW_SECTIONS } from '@platform/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { answersOf, INTERVIEW_QUESTIONS } from './business-interview.js';

const PROJECT = '00000000-0000-4000-8000-0000000000c1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const PROJECT_ROW = {
  id: PROJECT,
  key: 'acme_api',
  name: 'ACME API',
  repo_url: 'https://git.example.test/acme/api.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 1,
  status: 'active',
  created_at: '2026-09-13T04:00:00.000Z',
  updated_at: '2026-09-13T04:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
};

/** A path the server answered with, carrying markup: it must arrive as text. */
const HOSTILE_PATH = '.agentic/knowledge/business/<img src=x onerror=alert(1)>.md';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let sent: { body: unknown; key: string | null }[];

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.includes('/api/auth/get-session')) return json(SESSION);
  if (url.includes('/interview') && init?.method === 'POST') {
    sent.push({
      body: JSON.parse(String(init.body ?? '{}')),
      key: new Headers(init.headers).get('idempotency-key'),
    });
    return json(
      {
        performed: true,
        pages: [
          {
            proposal_id: '00000000-0000-4000-8000-0000000000c2',
            section: 'glossary',
            target_path: HOSTILE_PATH,
            status: 'queued',
            truncated: false,
          },
        ],
      },
      201,
    );
  }
  if (url.includes('/readiness')) {
    return json({ error: { code: 'readiness_not_evaluated', message: 'none' } }, 409);
  }
  if (url.includes('/history-bootstraps')) {
    return json({
      items: [],
      can_start: false,
      blocked_reason: 'off',
      estimate: {
        merge_requests: 200,
        batch_size: 20,
        batches: 10,
        estimated_usd: 20,
        cap_usd: 20,
        stops_at_cap: false,
        days: 183,
      },
      max_merge_requests: 1000,
    });
  }
  if (url.includes('/api/projects/') && url.includes('/bindings')) return json({ items: [] });
  if (url.endsWith('/api/projects')) return json({ items: [PROJECT_ROW] });
  if (url.endsWith('/api/integrations')) return json({ items: [] });
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  sent = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/onboarding');
});

describe('the form’s copy of the question bank', () => {
  it('asks what the platform heads the page with, section by section', () => {
    // Restated in the web app to keep the domain ring out of the bundle, so held here (rule 41).
    expect(Object.keys(INTERVIEW_QUESTIONS)).toEqual([...BUSINESS_INTERVIEW_SECTION_IDS]);
    for (const section of BUSINESS_INTERVIEW_SECTIONS) {
      expect(INTERVIEW_QUESTIONS[section.id].title, section.id).toBe(section.title);
      expect(INTERVIEW_QUESTIONS[section.id].ask.startsWith(section.questions), section.id).toBe(
        true,
      );
    }
  });
});

describe('answersOf', () => {
  it('skips an empty section, marks a not-applicable one, and keeps an answer verbatim', () => {
    expect(
      answersOf({
        product: { text: '  Invoicing.  ', notApplicable: false },
        users: { text: '', notApplicable: true },
        glossary: { text: '   ', notApplicable: false },
        direction: { text: 'No roadmap yet.', notApplicable: true },
      }),
    ).toEqual({
      product: { status: 'answered', text: '  Invoicing.  ' },
      users: { status: 'not_applicable' },
      direction: { status: 'not_applicable', reason: 'No roadmap yet.' },
    });
  });
});

describe('the business interview', () => {
  it('asks product/19 §8’s eight sections', async () => {
    render(createApp({ fetchImpl, realtime: false }).element);
    for (const title of [
      'Product',
      'Users',
      'Business rules',
      'Glossary',
      'Direction',
      'Quality bar',
      'Review expectations',
      'Communication',
    ]) {
      expect(await screen.findByLabelText(title), title).toBeTruthy();
    }
    expect(BUSINESS_INTERVIEW_SECTION_IDS).toHaveLength(8);
    // Nothing answered, nothing to propose.
    const submit = screen.getByRole('button', { name: /Propose/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('proposes the answered sections with an Idempotency-Key, and shows them queued', async () => {
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    fireEvent.change(await screen.findByLabelText('Glossary'), {
      target: { value: 'Ledger — the book of record.' },
    });
    fireEvent.click(screen.getAllByLabelText('Not applicable to this project')[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Propose 2 pages' }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({
      answers: {
        users: { status: 'not_applicable' },
        glossary: { status: 'answered', text: 'Ledger — the book of record.' },
      },
    });
    expect(sent[0]?.key).toBeTruthy();

    expect(await screen.findByText('Proposed, and waiting in the queue:')).toBeTruthy();
    expect(screen.getByText('Review the proposed pages')).toBeTruthy();
    // The server's path is text: no element was built from it.
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
