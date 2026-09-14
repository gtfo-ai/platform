/**
 * The project settings page and the operating-mode component it shares with the wizard (WP-30).
 *
 * Driven through `createApp` with a fake server, so what is asserted is the composition: the real
 * router, the real query client, the real endpoint parsers. Four things are worth a test here:
 *
 *  - the page is the **mirror** — all five wizard steps are on it (product/18:55);
 *  - *Custom* is rendered from the **stored** preset, both ways (standing rule 42);
 *  - a project whose dial was never materialised says so rather than showing defaults as facts;
 *  - the audit of who changed a toggle is **visible**, which is what product/18:5 asks for and what
 *    PROGRESS backlog 52 records as missing.
 */
import type {
  AutonomyPolicies,
  AutonomyResponse,
  ProjectAuditResponse,
  ProjectBindingsResponse,
  ProjectSummary,
} from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';

/** Annotated rather than bare — PROGRESS backlog 93, closed by WP-38. */
const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const PROJECT_ROW: ProjectSummary = {
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

const POLICIES: AutonomyPolicies = {
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
};

const autonomy = (overrides: Partial<AutonomyResponse> = {}): AutonomyResponse => ({
  level: 'supervised',
  materialised: true,
  preset_version: 1,
  current_preset_version: 1,
  preset_outdated: false,
  applied_at: '2026-09-13T04:00:00.000Z',
  applied_by: null,
  policies: POLICIES,
  is_custom: false,
  overrides: [],
  readiness_level: 1,
  suggested_cap: 'supervised',
  above_suggested_cap: false,
  ...overrides,
});

/** A settings change made by somebody else — the audit row product/18:5 wants visible. */
const AUDIT: ProjectAuditResponse = {
  items: [
    {
      id: '00000000-0000-4000-8000-0000000000c1',
      action: 'project.autonomy.write',
      user_id: SESSION.user.id,
      user_email: 'someone@example.invalid',
      params: { project_id: PROJECT, before_level: 'observe', after_level: 'supervised' },
      created_at: '2026-09-13T05:00:00.000Z',
    },
  ],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The two bindings a project with a chat integration has (WP-32). */
const CHAT_BINDINGS: ProjectBindingsResponse['items'] = [
  {
    integration_id: '00000000-0000-4000-8000-0000000000e1',
    type: 'git',
    provider: 'gitlab',
    name: 'GitLab',
    config: { mint_credentials: false },
  },
  {
    integration_id: '00000000-0000-4000-8000-0000000000e2',
    type: 'communication',
    provider: 'slack',
    name: 'Slack',
    config: { channel: '#agentic' },
  },
];

const fetchFor = (
  dial: Partial<AutonomyResponse>,
  options: {
    readonly bindings?: ProjectBindingsResponse['items'];
    readonly onPut?: (url: string, body: unknown) => void;
  } = {},
) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (init?.method === 'PUT' && url.includes('/bindings')) {
      options.onPut?.(url, JSON.parse(String(init.body)));
      return json({ items: options.bindings ?? [] });
    }
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.includes('/autonomy')) return json(autonomy(dial));
    if (url.includes('/audit')) return json(AUDIT);
    if (url.includes('/budgets')) return json({ items: [] });
    if (url.includes('/readiness')) {
      return json({
        level: 1,
        evaluated_at: '2026-09-13T04:00:00.000Z',
        source: 'discovery',
        criteria: [],
        next_improvements: [],
      });
    }
    if (url.includes('/bindings')) return json({ items: options.bindings ?? [] });
    if (url.includes('/config')) {
      return json({
        config: { version: 1, pipeline: { wip: { max_parallel_tasks: 3 } } },
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
  window.history.pushState({}, '', '/projects/acme_api/settings');
});

describe('the project settings page', () => {
  it('mirrors all five wizard steps and shows the audit of who changed what', async () => {
    // product/18:55 — *"nothing is only reachable during onboarding"*. The headings are the five
    // steps, plus the audit product/18:5 requires and PROGRESS backlog 52 records as unread.
    render(createApp({ fetchImpl: fetchFor({}), realtime: false }).element);
    expect(await screen.findByText('Connections')).toBeTruthy();
    for (const heading of [
      'Technical discovery and readiness',
      'Business context',
      'Autonomy dial',
      'Features',
      'Risk classes',
      'Project budgets',
      'Notifications',
      'WIP limits and policies',
      'Knowledge',
      'Who changed what',
    ]) {
      expect(screen.getByText(heading), heading).toBeTruthy();
    }
    // The audit is *read*, not merely present: the row's actor and action reach the screen. Read
    // off the rendered text because `UntrustedText` may split a string across nodes.
    await waitFor(() => {
      expect(document.body.textContent).toContain('someone@example.invalid');
    });
    expect(document.body.textContent).toContain('project.autonomy.write');
    expect(document.body.textContent).toContain('before_level');
  });

  it('renders the policies the dial actually set, from the stored preset', async () => {
    const { container } = render(createApp({ fetchImpl: fetchFor({}), realtime: false }).element);
    await screen.findByText('Autonomy dial');
    // The number a re-derivation would have had to invent: it comes from `policies`, not `level`.
    await waitFor(() => {
      expect(container.textContent).toContain('probation_tasks');
    });
    expect(container.textContent).toContain('preset v1');
  });

  it('does not call a project Custom when nothing is overridden', async () => {
    // Standing rule 42's first half, and the one a badge that always rendered would fail.
    render(createApp({ fetchImpl: fetchFor({}), realtime: false }).element);
    await screen.findByText('Autonomy dial');
    expect(screen.queryByText('Custom')).toBeNull();
    expect(screen.queryByText('never applied')).toBeNull();
    expect(screen.queryByText('preset out of date')).toBeNull();
  });

  it('calls it Custom and lists the differences when one is', async () => {
    render(
      createApp({
        fetchImpl: fetchFor({
          is_custom: true,
          overrides: [{ policy: 'probationTasks', preset: 5, effective: 2 }],
        }),
        realtime: false,
      }).element,
    );
    expect(await screen.findByText('Custom')).toBeTruthy();
    // The *differences*, which is what BD-027 asks the UI to show — not just the word.
    expect(document.body.textContent).toContain('probationTasks');
    expect(document.body.textContent).toContain('preset 5, in force 2');
  });

  it('says a dial that was never materialised was never applied', async () => {
    // Standing rule 16: the absent case is not the quiet one. A screen that rendered the defaults
    // as though they had been chosen would be the whole defect BD-027:14 is about, in a badge.
    render(
      createApp({
        fetchImpl: fetchFor({ materialised: false, applied_at: null, preset_outdated: false }),
        realtime: false,
      }).element,
    );
    expect(await screen.findByText('never applied')).toBeTruthy();
    expect(screen.getByText(/not applied in this release/)).toBeTruthy();
  });

  it('offers re-apply when the stored preset is out of date', async () => {
    render(
      createApp({
        fetchImpl: fetchFor({ preset_outdated: true, preset_version: 1 }),
        realtime: false,
      }).element,
    );
    expect(await screen.findByText('preset out of date')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Re-apply preset' })).toBeTruthy();
    });
  });

  it('offers the notification channel of the project’s chat binding, and saves the whole set', async () => {
    // WP-32's criterion 11. The gap panel is gone, and what replaces it writes
    // `bindings.config.channel` — with every *other* binding's configuration sent back untouched,
    // because `PUT …/bindings` replaces the set and losing a key is how a channel disappears.
    const puts: { url: string; body: unknown }[] = [];
    const user = userEvent.setup();
    render(
      createApp({
        fetchImpl: fetchFor(
          {},
          { bindings: CHAT_BINDINGS, onPut: (url, body) => puts.push({ url, body }) },
        ),
        realtime: false,
      }).element,
    );
    await screen.findByText('Notifications');
    const channel = await screen.findByLabelText('Channel');
    await waitFor(() => {
      expect((channel as HTMLInputElement).value).toBe('#agentic');
    });
    await user.clear(channel);
    await user.type(channel, '#deliveries');
    await user.click(screen.getByRole('button', { name: 'Save channel' }));

    await waitFor(() => {
      expect(puts).toHaveLength(1);
    });
    expect(puts[0]?.body).toEqual({
      items: [
        {
          integration_id: CHAT_BINDINGS[0]?.integration_id,
          config: { mint_credentials: false },
        },
        {
          integration_id: CHAT_BINDINGS[1]?.integration_id,
          config: { channel: '#deliveries' },
        },
      ],
    });
    // The gap panel is gone with the gap (standing rule 83). The assertion names the *channel's*
    // sentence rather than the words "not built": the risk-class gap is still on this screen and
    // still true, so a broader predicate would fail for the wrong reason.
    expect(document.body.textContent).not.toContain('A channel belongs to a chat integration');
  });

  it('says so when no chat integration is bound, instead of offering a channel', async () => {
    render(createApp({ fetchImpl: fetchFor({}), realtime: false }).element);
    await screen.findByText('Notifications');
    await waitFor(() => {
      expect(document.body.textContent).toContain('No chat integration is bound');
    });
    expect(screen.queryByLabelText('Channel')).toBeNull();
  });

  it('says readiness only suggests, and asks why when the choice is above the suggestion', async () => {
    // product/18 and Q21: the cap is a **suggestion**. The screen says so, and an override asks for
    // a reason rather than refusing — which is the behaviour criterion 8 is about.
    render(
      createApp({
        fetchImpl: fetchFor({
          level: 'autonomous',
          readiness_level: 0,
          suggested_cap: 'assist',
          above_suggested_cap: true,
        }),
        realtime: false,
      }).element,
    );
    await screen.findByText('Autonomy dial');
    await waitFor(() => {
      expect(document.body.textContent).toContain('A suggestion is all it is');
    });
    expect(screen.getByLabelText(/Why above the suggested cap/)).toBeTruthy();
  });
});
