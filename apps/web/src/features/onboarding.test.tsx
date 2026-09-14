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

/** `GET /api/projects/:id/autonomy` — the dial as WP-30's projection publishes it. */
const AUTONOMY = {
  level: 'supervised',
  materialised: true,
  preset_version: 1,
  current_preset_version: 1,
  preset_outdated: false,
  applied_at: '2026-09-13T04:00:00.000Z',
  applied_by: null,
  policies: {
    picks_up_new_tickets: true,
    stop_after_stage: null,
    plan_approval: 'above_size',
    plan_approval_size_threshold: 'L',
    plan_approval_for_risk_classes: true,
    probation: true,
    probation_tasks: 5,
    business_review: true,
    question_timeout: '1 working day',
    human_mr_rounds: 3,
    knowledge_auto_apply: false,
    budget_approval_threshold_usd: 50,
    review_only: false,
    shadow_mode: false,
    suggested_readiness_min: 1,
  },
  is_custom: false,
  overrides: [],
  readiness_level: 1,
  suggested_cap: 'supervised',
  above_suggested_cap: false,
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
    if (url.includes('/api/projects/') && url.includes('/autonomy')) return json(AUTONOMY);
    if (url.includes('/api/projects/') && url.includes('/budgets')) return json({ items: [] });
    if (url.includes('/api/projects/') && url.includes('/audit')) return json({ items: [] });
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
      'Operating mode and features',
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
  it('sends the stored document and its hash when a feature is toggled, not a fresh one', async () => {
    /**
     * `PUT …/config` **replaces** the whole `.agentic/config.yml`, so a screen that posted
     * `{ version: 1 }` discarded every other key the project had — which is what this one did until
     * WP-21's review round 2. `base_hash` is the endpoint's optimistic check: without it a
     * concurrent edit is a lost update rather than a 409.
     *
     * Since WP-30 the **dial** no longer writes the document at all (it has its own command), so
     * the caller that carries this property is a feature toggle — which is also the write BD-028
     * cares about: an opt-in that discarded the rest of a project's configuration would be a very
     * expensive checkbox.
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
    // The checkbox stays disabled until the stored document has been read — which is the fix: a
    // screen that could save before reading is a screen that saves something it made up.
    const toggle = await screen.findByRole('checkbox', { name: /Review-only mode/ });
    await waitFor(() => {
      expect((toggle as HTMLInputElement).disabled).toBe(false);
    });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(sent.some((entry) => entry.url.includes('/config'))).toBe(true);
    });
    const body = sent.find((entry) => entry.url.includes('/config'))?.body as {
      config: {
        policies?: { protected_paths?: string[] };
        features?: { review_only?: { enabled?: boolean } };
      };
      base_hash?: string;
      autonomy_level?: string;
    };
    // The key the screen never knew about survives — the assertion a `{ version: 1 }` body fails.
    expect(body.config.policies?.protected_paths).toEqual(['tests/**']);
    expect(body.base_hash).toBe('deadbeef');
    expect(body.config.features?.review_only?.enabled).toBe(true);
    // …and the dial is **not** restated on a write that did not touch it: sending it would
    // re-materialise the preset, which is the opposite of BD-027:14.
    expect(body.autonomy_level).toBeUndefined();
  });

  it('saves the dial through its own command, and re-apply sends the level already in force', async () => {
    const sent: { url: string; method: string; body: unknown }[] = [];
    const recording = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, body: JSON.parse(String(init?.body ?? '{}')) });
        return json({ level: 'supervised', preset_version: 1, performed: true });
      }
      return fetchFor('recorded')(input, init);
    }) as typeof fetch;

    render(createApp({ fetchImpl: recording, realtime: false }).element);
    fireEvent.click(await screen.findByRole('button', { name: 'Save operating mode' }));
    await waitFor(() => {
      expect(sent.some((entry) => entry.url.includes('/autonomy'))).toBe(true);
    });
    const saved = sent.find((entry) => entry.url.includes('/autonomy'));
    expect(saved?.method).toBe('PUT');
    expect(saved?.body).toEqual({ autonomy: 'supervised' });

    // "Re-apply preset" is the same command with the position the project already has — BD-027's
    // materialisation *is* the selection, so a second route would be a second name for one write.
    fireEvent.click(screen.getByRole('button', { name: 'Re-apply preset' }));
    await waitFor(() => {
      expect(sent.filter((entry) => entry.url.includes('/autonomy'))).toHaveLength(2);
    });
    expect(sent.at(-1)?.body).toEqual({ autonomy: 'supervised' });
  });

  it('carries all five of the step’s items, and names the one it cannot honestly build', async () => {
    // product/18:50-54. A control that silently did nothing would be worse than an absent one, so
    // the gap is on the screen (standing rule 18: the absent case must not be the quiet one).
    //
    // It was **two** until WP-32: the notification channel was named as a gap because nothing could
    // read one, and the work package that built the notification band replaced that panel with the
    // control (standing rule 83 — closing a gap falsifies the sentence that described it).
    const { container } = render(
      createApp({ fetchImpl: fetchFor('recorded'), realtime: false }).element,
    );
    await screen.findByText('Autonomy dial');
    for (const heading of ['Features', 'Risk classes', 'Project budgets', 'Notifications']) {
      expect(screen.getByText(heading), heading).toBeTruthy();
    }
    // product/19 §124's five card fields, on a card whose behaviour is shipped (WP-24).
    expect(container.textContent).toContain('Default: off · Cost: ~$1–3 per merge request');
    expect(container.textContent).toContain('Touches: posts discussion threads on merge requests');
    // The gap, in the words an operator reads — and the one that is no longer a gap.
    expect(container.textContent).toContain('proposing a set from the repository structure');
    expect(container.textContent).not.toContain('A channel belongs to a chat integration');
  });

  it('says why the command policy is not editable here', async () => {
    // A project may only narrow the organisation maximum (BD-025), so a `commands.allow` editor
    // would be an affordance that cannot do the thing an operator would expect of it.
    const { container } = render(
      createApp({ fetchImpl: fetchFor('recorded'), realtime: false }).element,
    );
    // Waited on the dial, not on the step's title: the title renders before the projects list
    // arrives, so a wait on it would assert against a screen that has not resumed a project yet.
    await screen.findByText('Autonomy dial');
    // The sentence spans an `<em>`, so it is read off the rendered text rather than matched against
    // one element.
    expect(container.textContent).toContain('may only narrow the organisation maximum');
  });
});
