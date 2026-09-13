/**
 * The onboarding wizard screen — product/06 (WP-21).
 *
 * Driven through `createApp` with a fake server, so what is asserted is the composition: the real
 * router, the real query client, the real endpoint parsers. Three things are worth a test here and
 * the rest is layout:
 *
 *  - a readiness evaluation **renders**, with the level, the criteria and product/17's three
 *    cheapest improvements;
 *  - the **evidence** is the Discovery agent's own words about somebody else's repository (BD-022),
 *    so it is rendered as text — a hostile string appears verbatim and creates no element;
 *  - the 409 a project with no evaluation gets is an **answer**, not a crash: the step says how to
 *    get one instead of showing an error.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';

const SESSION = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

/** A drafted-page quote with markup and a bidi override in it, from an untrusted repository. */
const HOSTILE_EVIDENCE = '<img src=x onerror=alert(1)> ‮detcetorp si hcnarb eht';

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

const READINESS = {
  level: 1,
  evaluated_at: '2026-09-13T04:00:00.000Z',
  source: 'discovery',
  criteria: [
    {
      id: 'R1',
      passed: true,
      evidence: HOSTILE_EVIDENCE,
      unlocks: 'Implementation self-check',
      detected_by: 'agent',
    },
    {
      id: 'R9',
      passed: false,
      evidence: 'the git provider reports the default branch as unprotected',
      unlocks: 'Human merge guarantee (BD-007)',
      detected_by: 'platform',
    },
  ],
  next_improvements: [
    { id: 'R5', title: 'Lint and formatter enforced in CI', unlocks: 'Reviewer skips style' },
  ],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (readiness: 'recorded' | 'absent') =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.includes('/api/projects/') && url.includes('/readiness')) {
      return readiness === 'recorded'
        ? json(READINESS)
        : json(
            {
              error: {
                code: 'readiness_not_evaluated',
                message: 'no readiness evaluation (0 readiness_evaluations rows)',
              },
            },
            409,
          );
    }
    if (url.includes('/api/projects/') && url.includes('/bindings')) return json({ items: [] });
    if (url.includes('/api/projects/') && url.includes('/config')) {
      return json({
        config: { version: 1, policies: { protected_paths: ['tests/**'] } },
        sources: { '*': 'project' },
        hash: 'deadbeef',
        computed_at: '2026-09-13T04:00:00.000Z',
      });
    }
    if (url.endsWith('/api/projects')) return json({ items: [PROJECT_ROW] });
    if (url.endsWith('/api/integrations')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/onboarding');
});

describe('the onboarding wizard', () => {
  it('shows every step, including the one that is honestly not built', async () => {
    render(createApp({ fetchImpl: fetchFor('absent'), realtime: false }).element);
    for (const title of [
      'Connect',
      'Technical discovery',
      'Business interview',
      'Operating mode',
      'Commit',
    ]) {
      expect(await screen.findByText(title), title).toBeTruthy();
    }
    // product/06 § "Step 3" is not implemented, and the screen says so rather than collecting
    // answers nobody reads.
    expect(await screen.findByText('Not built in this release')).toBeTruthy();
  });

  it('tells an operator a project with no evaluation needs a discovery run', async () => {
    render(createApp({ fetchImpl: fetchFor('absent'), realtime: false }).element);
    // The 409 is an answer. Nothing here is an error notice, and nothing crashed.
    expect(await screen.findByText(/No readiness evaluation yet/)).toBeTruthy();
    expect(screen.queryByTestId('error-fallback')).toBeNull();
  });

  it('renders the level, the criteria and the cheapest improvements when one exists', async () => {
    // The deployment has one project, so the wizard resumes it without being told — which is what
    // makes the readiness query fire at all (product/06: "resumable").
    render(createApp({ fetchImpl: fetchFor('recorded'), realtime: false }).element);
    expect(await screen.findByText('Readiness level 1')).toBeTruthy();
    // product/17 § "Onboarding wizard": the level *and* the three cheapest criteria to improve.
    expect(await screen.findByText(/Lint and formatter enforced in CI/)).toBeTruthy();
    // Both criteria, with the platform's `unlocks` beside the agent's evidence.
    expect(screen.getByText(/Implementation self-check/)).toBeTruthy();
    expect(screen.getByText(/Human merge guarantee/)).toBeTruthy();
  });

  it('renders untrusted evidence as text, never as markup', async () => {
    // The screen builds no markup from a string (CLAUDE.md: the web app never turns a string into
    // markup), so a page-wide check is enough and is the one that would fail if a later change
    // introduced a sanitiser-and-innerHTML pair.
    const { container } = render(
      createApp({ fetchImpl: fetchFor('recorded'), realtime: false }).element,
    );
    await screen.findByText('Readiness level 1');
    // No element was created from the string, and the serialised document carries the `<` escaped.
    // The escaped form still *contains* the characters `onerror=`, which is the point: they are
    // text. An assertion on the substring would fail on correct output, which is how a guard like
    // this ends up weakened into uselessness.
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('<img');
    expect(container.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // …and the bytes are still there, which a screen that dropped the field would also satisfy
    // (standing rule 42). `untrusted.tsx` neutralises the bidi override; the rest is verbatim.
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('the wizard’s step 4', () => {
  it('sends the stored document and its hash, not a fresh one', async () => {
    /**
     * `PUT …/config` **replaces** the whole `.agentic/config.yml`, so a screen that posted
     * `{ version: 1 }` discarded every other key the project had — which is what this one did until
     * WP-21's review round 2. `base_hash` is the endpoint's optimistic check: without it a
     * concurrent edit is a lost update rather than a 409.
     */
    const sent: { url: string; body: unknown }[] = [];
    const recording = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if ((init?.method ?? 'GET') !== 'GET') {
        sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
        return json({ hash: 'newhash', autonomy_level: 'supervised' });
      }
      return fetchFor('recorded')(input, init);
    }) as typeof fetch;

    render(createApp({ fetchImpl: recording, realtime: false }).element);
    // The button stays disabled until the stored document has been read — which is the fix: a
    // screen that could save before reading is a screen that saves something it made up.
    const save = await screen.findByRole('button', { name: 'Save operating mode' });
    await waitFor(() => {
      expect((save as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(save);

    await waitFor(() => {
      expect(sent.some((entry) => entry.url.includes('/config'))).toBe(true);
    });
    const body = sent.find((entry) => entry.url.includes('/config'))?.body as {
      config: { policies?: { protected_paths?: string[]; autonomy?: string } };
      base_hash?: string;
      autonomy_level?: string;
    };
    // The key the screen never knew about survives — the assertion a `{ version: 1 }` body fails.
    expect(body.config.policies?.protected_paths).toEqual(['tests/**']);
    expect(body.base_hash).toBe('deadbeef');
    expect(body.autonomy_level).toBe('supervised');
  });

  it('says why the command policy is not editable here', async () => {
    // A project may only narrow the organisation maximum (BD-025), so a `commands.allow` editor
    // would be an affordance that cannot do the thing an operator would expect of it.
    const { container } = render(
      createApp({ fetchImpl: fetchFor('recorded'), realtime: false }).element,
    );
    await screen.findByText('Operating mode');
    // The sentence spans an `<em>`, so it is read off the rendered text rather than matched against
    // one element.
    expect(container.textContent).toContain('may only narrow the organisation maximum');
  });
});
