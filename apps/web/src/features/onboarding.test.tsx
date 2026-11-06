/**
 * The New project wizard — product/06 (WP-21), a real wizard since S-23.8 (TD-033 decision 9).
 *
 * Driven through `createApp` with a fake server, so what is asserted is the composition: the real
 * router (and its validated `?project=&step=`), the real query client, the real endpoint parsers.
 *
 *  - **the wizard's own rules**: every step is listed, a new project opens at Connect, done-ness is
 *    read off the server (bindings, readiness, the knowledge queue, the saved operating mode), the
 *    wizard resumes at the first step not done, *Continue* is refused past a required step that is
 *    not done (and says why), a deep link past one is refused too, a done step is revisitable, an
 *    optional step's *Skip for now* sends nothing, and the last step opens the board;
 *  - **the commands it sends**: the project create with its `Idempotency-Key`, discovery with its
 *    key, and step 4's writes (the step-4 block below);
 *  - **the readiness panel**: the level as a meter, the criteria by name with the ids behind
 *    *Details*, product/17's cheapest improvements, the CI-rules notices — and the **evidence**, the
 *    Discovery agent's words about somebody else's repository (BD-022), rendered as text;
 *  - the 409 a project with no evaluation gets is an **answer**, not a crash.
 */
import type {
  AutonomyResponse,
  KnowledgeProposalRecord,
  ProjectBindingSummary,
  ProjectSummary,
  ReadinessResponse,
} from '@platform/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { assertOnePrimaryAtMost, primaryLabels } from '../ui/primary-census.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000d1';

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

/** A drafted-page quote with markup and a bidi override in it, from an untrusted repository. */
const HOSTILE_EVIDENCE = '<img src=x onerror=alert(1)> ‮detcetorp si hcnarb eht';

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

const READINESS: ReadinessResponse = {
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
      not_checked: false,
    },
    // BD-026's 2026-10-06 amendment: the workspace could not run it — shown, but not as a fail.
    {
      id: 'R2',
      passed: false,
      evidence: 'not checked — the run workspace could not run it: no PHP in the run image',
      unlocks: 'Fast inner loop; fewer per-run timeouts',
      detected_by: 'agent',
      not_checked: true,
    },
    {
      id: 'R9',
      passed: false,
      evidence: 'the git provider reports the default branch as unprotected',
      unlocks: 'Human merge guarantee (BD-007)',
      detected_by: 'platform',
      not_checked: false,
    },
  ],
  next_improvements: [
    { id: 'R5', title: 'Lint and formatter enforced in CI', unlocks: 'Reviewer skips style' },
  ],
  // WP-143: the CI-rules warning, as the domain words it — the rule quoted from the CI file.
  notices: [
    {
      code: 'ci_rules_skip_agent_branch',
      severity: 'warning',
      message:
        '".gitlab-ci.yml" gives an agentic/ branch (agentic/X-1) no test job (stage test): a push pipeline runs no test job (stage test) — first, "codeception" rules[2] if: "$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^(feature|bugfix)\\//"; a merge-request pipeline runs no test job (stage test). Fix: admit agentic/ in that rule.',
    },
    {
      code: 'verification_mode_ci_suggested',
      severity: 'note',
      message:
        'R2 could not be checked: the run workspace could not run it. This project has a CI configuration: with verification.mode: ci, discovery reads it from the CI configuration instead of running it.',
    },
  ],
};

/** `GET /api/projects/:id/autonomy` — the dial as WP-30's projection publishes it. */
const AUTONOMY: AutonomyResponse = {
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
  organisation_maximum: null,
  level_in_force: 'supervised',
};

/**
 * `GET /api/projects/:id/history-bootstraps` — the gate, the estimate and one finished batch.
 *
 * `detail` is the platform's own sentence about a batch that found nothing, and it is rendered
 * through `ui/untrusted.tsx` like every other string on every other screen.
 */
const HISTORY_BOOTSTRAPS = {
  items: [
    {
      id: '00000000-0000-4000-8000-0000000000b9',
      project_id: PROJECT,
      status: 'completed',
      created_at: '2026-09-13T04:00:00.000Z',
      completed_at: '2026-09-13T05:00:00.000Z',
      merge_requests: 40,
      detail: null,
      cap_usd: 20,
      estimated_usd: 4,
      spent_usd: 1.25,
      chunks: 2,
      chunks_recorded: 2,
      proposals: 5,
      refused_proposals: 1,
      merge_requests_read_claimed: 37,
      merge_requests_read_of: 40,
    },
  ],
  can_start: true,
  blocked_reason: null,
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
};

const TRACKER_BINDING: ProjectBindingSummary = {
  integration_id: '00000000-0000-4000-8000-0000000000c1',
  type: 'task_management',
  provider: 'jira-cloud',
  name: 'Acme Jira',
  config: {},
};
const GIT_BINDING: ProjectBindingSummary = {
  integration_id: '00000000-0000-4000-8000-0000000000c2',
  type: 'git',
  provider: 'gitlab',
  name: 'Acme GitLab',
  config: {},
};

const proposal = (over: Partial<KnowledgeProposalRecord> = {}): KnowledgeProposalRecord => ({
  id: '00000000-0000-4000-8000-0000000000e1',
  project_id: PROJECT,
  source: 'bootstrap',
  kind: 'technical',
  type: 'doc-update',
  target_path: 'technical/architecture.md',
  delta: '# Architecture',
  evidence: ['drafted from the repository'],
  significance: 0.5,
  status: 'queued',
  created_at: '2026-09-13T04:00:00.000Z',
  ...over,
});

/** What the fake server holds; every case states the part it is about. */
interface World {
  readonly readiness: 'recorded' | 'absent';
  readonly bindings: readonly ProjectBindingSummary[];
  readonly proposals: readonly KnowledgeProposalRecord[];
  readonly materialised: boolean;
  /** Whether a history bootstrap batch exists (`HISTORY_BOOTSTRAPS` has one). */
  readonly historyStarted: boolean;
  readonly sent: { url: string; method: string; body: unknown; key: string | null }[];
}

const world = (over: Partial<World> = {}): World => ({
  readiness: 'absent',
  bindings: [TRACKER_BINDING, GIT_BINDING],
  proposals: [],
  materialised: true,
  historyStarted: true,
  sent: [],
  ...over,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (readiness: 'recorded' | 'absent', over: Partial<World> = {}) => {
  const state = world({ ...over, readiness });
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      state.sent.push({
        url,
        method,
        body: JSON.parse(String(init?.body ?? '{}')),
        key: new Headers(init?.headers).get('idempotency-key'),
      });
      if (url.endsWith('/discovery')) {
        return json({ task_id: TASK, started: true, detail: 'the Discovery agent is queued' }, 201);
      }
      return json({ error: { code: 'not_found', message: 'no such command' } }, 404);
    }
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
    if (url.includes('/api/projects/') && url.includes('/bindings')) {
      return json({ items: state.bindings });
    }
    // S-23.8: the wizard reads the knowledge queue for the business step and the finish.
    if (url.includes('/api/projects/') && url.includes('/kb/proposals')) {
      return json({ items: state.proposals, next_cursor: null });
    }
    // WP-155 (c): step 2 reads the discovery gate. No discovery has run in this world.
    if (url.includes('/api/projects/') && url.includes('/rediscovery')) {
      return json({
        can_start: false,
        blocker: {
          code: 'discovery_not_started',
          detail: 'this project has never run discovery',
          task_id: null,
        },
        ceiling_usd: 2,
        last_discovery: null,
      });
    }
    // WP-139: the stored default branch beside the provider's — no git binding in this world.
    if (url.includes('/api/projects/') && url.includes('/repository')) {
      return json({
        default_branch: 'main',
        provider: null,
        provider_unavailable:
          'this project has no git binding, so the platform cannot ask its provider',
        live_tasks: 0,
      });
    }
    if (url.includes('/api/projects/') && url.includes('/autonomy')) {
      return json({ ...AUTONOMY, materialised: state.materialised });
    }
    if (url.includes('/api/projects/') && url.includes('/budgets')) return json({ items: [] });
    if (url.includes('/api/projects/') && url.includes('/audit')) return json({ items: [] });
    if (url.includes('/api/projects/') && url.includes('/config')) {
      return json({
        config: { version: 1, policies: { protected_paths: ['tests/**'] } },
        // WP-63: the merged document and the repository reading that fed its `repo` layer.
        effective: { version: 1 },
        repository: {
          path: '.agentic/config.yml',
          status: 'unread',
          commit_sha: null,
          read_at: null,
          detail: null,
          not_applied: [],
          // WP-113: no reading holds a prompt directory yet.
          prompts: null,
          // WP-121: and none was withheld.
          prompts_withheld: null,
        },
        sources: { '*': 'project' },
        hash: 'deadbeef',
        computed_at: '2026-09-13T04:00:00.000Z',
        not_applied: [],
        last_export: null,
        // WP-54: nothing the project declared is outside every role's command baseline.
        ignored_allow_commands: [],
        // WP-113: which prompt file each stage would be given — none.
        stage_prompts: [],
        // WP-181: no lifecycle slot is mapped, so `status_mapping` applies.
        status_mapping_superseded: false,
        // WP-37: what the server offers for `policies.risk_classes`. The project has **none** and
        // the offer is not empty, which is the whole shape of "proposed, not applied".
        risk_class_proposal: {
          source: 'platform',
          classes: {
            data: { paths: ['**/migrations/**'], require: ['plan_approval'] },
            payments: {
              paths: ['**/billing/**'],
              require: ['plan_approval', 'checklist:payments'],
            },
          },
          // WP-45: the list accepting asks the operator to write — the platform ships no items.
          checklists: [
            {
              name: 'payments',
              required_by: ['payments'],
              purpose: 'product/19 §14 asks for a "stricter checklist" on payments (Q83)',
              defined: false,
            },
          ],
        },
      });
    }
    if (url.includes('/api/projects/') && url.includes('/history-bootstraps')) {
      return json(state.historyStarted ? HISTORY_BOOTSTRAPS : { ...HISTORY_BOOTSTRAPS, items: [] });
    }
    if (url.endsWith('/api/projects')) return json({ items: [PROJECT_ROW] });
    if (url.endsWith('/api/integrations')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
};

/** The fake and the world it answers from, for a case that reads what was sent. */
const serverFor = (readiness: 'recorded' | 'absent', over: Partial<World> = {}) => {
  const state = world({ ...over, readiness });
  return { state, fetchImpl: fetchFor(readiness, state) };
};

/**
 * WP-122 (PROGRESS backlog 388): a live and a retired integration, for the picker case. The retired
 * one's name is a sentence a test can search for, so its absence is a fact about this screen.
 */
const pickerIntegrations = {
  items: [
    {
      id: '00000000-0000-4000-8000-0000000000f1',
      type: 'communication',
      provider: 'slack',
      name: 'Live workspace',
      config: {},
      health: { status: 'unknown', checked_at: null, detail: null },
      config_refusal: null,
      retired_at: null,
      credentials_readable: null,
      credentials_consequence: null,
      activity: { last_call: null, last_delivery_at: null },
      current_health: { status: 'never_checked', basis: null, at: null },
      used_by: [],
    },
    {
      id: '00000000-0000-4000-8000-0000000000f2',
      type: 'communication',
      provider: 'slack',
      name: 'Retired workspace',
      config: {},
      health: { status: 'unknown', checked_at: null, detail: null },
      config_refusal: null,
      retired_at: '2026-09-30T09:00:00.000Z',
      credentials_readable: null,
      credentials_consequence: null,
      activity: { last_call: null, last_delivery_at: null },
      current_health: { status: 'never_checked', basis: null, at: null },
      used_by: [],
    },
  ],
};

/** The screen's own fake server, with `GET /api/integrations` answering the picker fixture. */
const withPickerIntegrations =
  (base: typeof fetch): typeof fetch =>
  async (input, init) =>
    String(input).endsWith('/api/integrations') ? json(pickerIntegrations) : base(input, init);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** The wizard at `path`, over `fetchImpl`. */
const openAt = (path: string, fetchImpl: typeof fetch) => {
  window.history.pushState({}, '', path);
  return render(createApp({ fetchImpl, realtime: false }).element);
};

/** `/onboarding?project=acme_api[&step=…]` — the fixture project's wizard. */
const wizardOf = (step?: string): string =>
  `/onboarding?project=${PROJECT_ROW.key}${step === undefined ? '' : `&step=${step}`}`;

/** The step the wizard is showing, once it shows one. */
const shownStep = async (): Promise<string | null> =>
  waitFor(() => {
    const step = document.querySelector('[data-wizard-step]');
    expect(step).not.toBeNull();
    return step?.getAttribute('data-wizard-step') ?? null;
  });

const stepList = (): HTMLElement => screen.getByRole('list', { name: 'Setup steps' });

/** Each step of the list as `label:state`, with `→` when it is a link. */
const stepStates = (): string[] =>
  within(stepList())
    .getAllByRole('listitem')
    .map(
      (item) =>
        `${item.querySelector('a, span.text-sm')?.textContent ?? ''}:${item.getAttribute('data-step-state')}${item.querySelector('a') === null ? '' : '→'}`,
    );

const continueButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /^Continue to / }) as HTMLButtonElement;

describe('the New project wizard', () => {
  it('opens a new project at Connect, lists every step, and opens none past it', async () => {
    openAt('/onboarding', fetchFor('absent'));
    expect(await screen.findByRole('heading', { level: 1, name: 'New project' })).toBeTruthy();
    expect(await shownStep()).toBe('connect');
    expect(stepStates()).toEqual([
      'Connect:current',
      'Technical discovery:upcoming',
      'Business context:upcoming',
      'History:upcoming',
      'How autonomous:upcoming',
      'Review and finish:upcoming',
    ]);
    // The two optional steps say so; the four required ones do not.
    const optional = within(stepList())
      .getAllByRole('listitem')
      .filter((item) => item.textContent?.includes('Optional'))
      .map((item) => item.getAttribute('data-step-state') ?? '');
    expect(optional).toHaveLength(2);
    expect(screen.getByLabelText('Key')).toBeTruthy();
    // Continue says where it goes, and is refused with the reason until the project exists.
    expect(continueButton().textContent).toBe('Continue to Technical discovery');
    expect(continueButton().disabled).toBe(true);
    expect(screen.getByText('Create the project first.')).toBeTruthy();
    // A new project is a new project: the one that exists is offered, never resumed unasked.
    expect(screen.getByText('Continue an existing project')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'ACME API' }).getAttribute('href')).toBe(
      '/onboarding?project=acme_api',
    );
  });

  it('shows every step, the business interview included', async () => {
    openAt(wizardOf('business'), fetchFor('recorded'));
    expect(await shownStep()).toBe('business');
    expect(stepStates().map((state) => state.split(':')[0])).toEqual([
      'Connect',
      'Technical discovery',
      // WP-155 (a): optional, like the history step.
      'Business context',
      // WP-35: product/06's own step 3b, the one step the wizard did not have.
      'History',
      'How autonomous',
      'Review and finish',
    ]);
    // product/06 § "Step 3" exists since WP-64: the question bank's eight sections, as a form whose
    // answers become proposals (`business-interview.test.tsx` drives it).
    expect(await screen.findByLabelText('Glossary')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Business context' })).toBeTruthy();
    expect(screen.queryByText('Not built in this release')).toBeNull();
  });

  it('says nothing the page shows is called onboarding, and Save and exit goes Home', async () => {
    const { container } = openAt(wizardOf('connect'), fetchFor('absent'));
    await shownStep();
    expect(screen.getByRole('link', { name: 'Save and exit' }).getAttribute('href')).toBe('/');
    expect(container.textContent).not.toMatch(/onboarding/i);
  });

  it('creates the project with an Idempotency-Key, then stays on Connect for it', async () => {
    const created = { ...PROJECT_ROW, id: '00000000-0000-4000-8000-0000000000a2', key: 'autix' };
    const sent: { url: string; body: unknown; key: string | null }[] = [];
    let projects: ProjectSummary[] = [PROJECT_ROW];
    const base = fetchFor('absent');
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/projects') && init?.method === 'POST') {
        sent.push({
          url,
          body: JSON.parse(String(init.body)),
          key: new Headers(init.headers).get('idempotency-key'),
        });
        projects = [PROJECT_ROW, created];
        const { open_tasks: _open, spent_usd_30d: _spent, ...record } = created;
        return json(record, 201);
      }
      if (url.endsWith('/api/projects')) return json({ items: projects });
      return base(input, init);
    }) as typeof fetch;
    openAt('/onboarding', fetchImpl);
    fireEvent.change(await screen.findByLabelText('Key'), { target: { value: 'autix' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Autix' } });
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://git.example.test/acme/autix.git' },
    });
    fireEvent.change(screen.getByLabelText('Default branch'), { target: { value: 'develop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => {
      expect(window.location.search).toBe('?project=autix&step=connect');
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.key).toMatch(/\S/);
    // The step now holds the created project: its integrations section replaces the hint.
    expect(await screen.findByText('Setting up')).toBeTruthy();
    expect(screen.queryByLabelText('Key')).toBeNull();
    expect(screen.queryByText('Available once the project is created.')).toBeNull();
  });

  it.each([
    ['nothing bound', { bindings: [] }, 'absent', 'connect'],
    ['bound, never evaluated', {}, 'absent', 'discovery'],
    [
      'evaluated, nothing else',
      { materialised: false, historyStarted: false },
      'recorded',
      'business',
    ],
    [
      'business proposed, no history yet',
      {
        materialised: false,
        historyStarted: false,
        proposals: [proposal({ kind: 'business', source: 'human' })],
      },
      'recorded',
      'history',
    ],
    // An optional step passed over counts as passed once a later step is done.
    ['business skipped, history started', { materialised: false }, 'recorded', 'autonomy'],
    ['operating mode saved, a page to review', { proposals: [proposal()] }, 'recorded', 'finish'],
  ] as const)(
    'resumes at the first step not done: %s',
    async (_name, over, readiness, expected) => {
      openAt(wizardOf(), fetchFor(readiness, over as Partial<World>));
      expect(await shownStep()).toBe(expected);
      // The step list agrees with the step shown, and marks it for assistive tech.
      const current = within(stepList())
        .getAllByRole('listitem')
        .filter((item) => item.getAttribute('aria-current') === 'step');
      expect(current).toHaveLength(1);
      expect(stepStates().filter((state) => state.endsWith(':current'))).toEqual([
        `${
          {
            connect: 'Connect',
            discovery: 'Technical discovery',
            business: 'Business context',
            history: 'History',
            autonomy: 'How autonomous',
            finish: 'Review and finish',
          }[expected]
        }:current`,
      ]);
    },
  );

  it('reads done-ness off the server: every step done shows a check, and an unknown step is ignored', async () => {
    // `step=nonsense` is dropped by the route's schema, so the wizard resumes rather than erring.
    openAt(`${wizardOf()}&step=nonsense`, fetchFor('recorded', { proposals: [] }));
    expect(await shownStep()).toBe('finish');
    await waitFor(() => {
      expect(stepStates()).toEqual([
        'Connect:done→',
        'Technical discovery:done→',
        'Business context:upcoming→',
        'History:done→',
        'How autonomous:done→',
        'Review and finish:current',
      ]);
    });
    expect(screen.queryByTestId('error-fallback')).toBeNull();
  });

  it('refuses Continue past Connect until a tracker and a git host are bound, and says which', async () => {
    openAt(wizardOf('connect'), fetchFor('absent', { bindings: [GIT_BINDING] }));
    await shownStep();
    await waitFor(() => {
      expect(screen.getByText('Bind a ticket tracker to continue.')).toBeTruthy();
    });
    expect(continueButton().disabled).toBe(true);
    expect(continueButton().getAttribute('aria-describedby')).toBe('wizard-continue-reason');
    // …and the step list does not let anybody jump past it either.
    expect(stepStates()[1]).toBe('Technical discovery:upcoming');
    cleanup();

    openAt(wizardOf('connect'), fetchFor('absent'));
    await shownStep();
    await waitFor(() => {
      expect(continueButton().disabled).toBe(false);
    });
    fireEvent.click(continueButton());
    expect(await screen.findByRole('heading', { name: 'Technical discovery' })).toBeTruthy();
    expect(window.location.search).toBe('?project=acme_api&step=discovery');
  });

  it('refuses Continue past discovery until a readiness evaluation exists', async () => {
    openAt(wizardOf('discovery'), fetchFor('absent'));
    expect(await shownStep()).toBe('discovery');
    await waitFor(() => {
      expect(
        screen.getByText('Continue opens once discovery has recorded a readiness evaluation.'),
      ).toBeTruthy();
    });
    expect(continueButton().textContent).toBe('Continue to Business context');
    expect(continueButton().disabled).toBe(true);
  });

  it('refuses a deep link past a required step that is not done, and points at it', async () => {
    openAt(wizardOf('autonomy'), fetchFor('absent'));
    expect(await screen.findByText('How autonomous is not open yet')).toBeTruthy();
    const go = screen.getByRole('link', { name: 'Go to Technical discovery' });
    expect(go.getAttribute('href')).toBe('/onboarding?project=acme_api&step=discovery');
    // The step's controls are not rendered, and there is no Continue to press.
    expect(screen.queryByText('Autonomy dial')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Continue to / })).toBeNull();
  });

  it('lets a done step be revisited from the step list and from Back', async () => {
    openAt(wizardOf('discovery'), fetchFor('recorded'));
    expect(await shownStep()).toBe('discovery');
    await waitFor(() => {
      expect(stepStates()[0]).toBe('Connect:done→');
    });
    const back = screen.getByRole('link', { name: 'Back to Connect' });
    expect(back.getAttribute('href')).toBe('/onboarding?project=acme_api&step=connect');
    fireEvent.click(within(stepList()).getByRole('link', { name: 'Connect' }));
    expect(await screen.findByRole('heading', { name: 'Connect' })).toBeTruthy();
    expect(await shownStep()).toBe('connect');
  });

  it('skips an optional step without sending anything', async () => {
    const { state, fetchImpl } = serverFor('recorded', { materialised: false });
    openAt(wizardOf('business'), fetchImpl);
    expect(await screen.findByLabelText('Glossary')).toBeTruthy();
    const step = document.querySelector('[data-wizard-step]') as HTMLElement;
    expect(step.textContent).toContain('the whole step can be skipped and answered later');
    expect(within(step).getByRole('link', { name: 'settings' }).getAttribute('href')).toBe(
      '/projects/acme_api/settings',
    );
    // An optional step never holds Continue.
    expect(continueButton().textContent).toBe('Continue to History');
    expect(continueButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByRole('heading', { name: 'History' })).toBeTruthy();
    expect(window.location.search).toBe('?project=acme_api&step=history');
    // Records nothing (rule 79), checked after a known command so the log is complete (rule 87).
    expect(await screen.findByText(/At most \$20\.00/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByRole('heading', { name: 'How autonomous' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Save operating mode' }));
    await waitFor(() => {
      expect(state.sent.length).toBeGreaterThan(0);
    });
    expect(state.sent.map((entry) => entry.url)).toEqual([
      expect.stringContaining(`/api/projects/${PROJECT}/autonomy`),
    ]);
  });

  it('holds Continue on How autonomous until the operating mode is saved', async () => {
    openAt(wizardOf('autonomy'), fetchFor('recorded', { materialised: false }));
    expect(await screen.findByText('Autonomy dial')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('Save the operating mode to continue.')).toBeTruthy();
    });
    expect(continueButton().textContent).toBe('Continue to Review and finish');
    expect(continueButton().disabled).toBe(true);
    cleanup();
    openAt(wizardOf('autonomy'), fetchFor('recorded'));
    await screen.findByText('Autonomy dial');
    await waitFor(() => {
      expect(continueButton().disabled).toBe(false);
    });
  });

  // S-23.23 (the UX audit's § 2): one beacon per step — the step's own action until the step is
  // done, then Continue. Before this, each of these drew both.
  it('draws one primary: the step’s own action until it is done, then Continue', async () => {
    openAt(wizardOf('autonomy'), fetchFor('recorded', { materialised: false }));
    expect(await screen.findByText('Autonomy dial')).toBeTruthy();
    await waitFor(() => {
      expect(primaryLabels()).toEqual(['Save operating mode']);
    });
    expect(continueButton().className).not.toContain('border-primary-line');
    cleanup();

    openAt(wizardOf('autonomy'), fetchFor('recorded'));
    await screen.findByText('Autonomy dial');
    await waitFor(() => {
      expect(primaryLabels()).toEqual(['Continue to Review and finish']);
    });
    cleanup();

    openAt(wizardOf('discovery'), fetchFor('absent'));
    await waitFor(() => {
      expect(primaryLabels()).toEqual([expect.stringMatching(/^Run discovery/)]);
    });
    cleanup();

    for (const step of ['business', 'history']) {
      openAt(wizardOf(step), fetchFor('recorded'));
      expect(await shownStep()).toBe(step);
      await waitFor(() => {
        expect(primaryLabels().length, step).toBeGreaterThan(0);
      });
      assertOnePrimaryAtMost(document, `the ${step} step`);
      cleanup();
    }
  });

  it('finishes with what was set, the two links, and Open the board', async () => {
    openAt(wizardOf('finish'), fetchFor('recorded', { proposals: [proposal()] }));
    expect(await screen.findByRole('heading', { name: 'Review and finish' })).toBeTruthy();
    const set = screen.getByLabelText('What was set');
    await waitFor(() => {
      expect(set.textContent).toContain('Acme Jira, Acme GitLab');
    });
    expect(set.textContent).toContain('Big plans need your OK (level 1, Basic)');
    expect(set.textContent).toContain('Supervised');
    expect(set.textContent).toContain('1 drafted page');
    expect(set.textContent).toContain('Skipped — it can be answered later from the settings');
    expect(
      screen.getByRole('link', { name: 'Review the drafted pages' }).getAttribute('href'),
    ).toBe('/projects/acme_api/knowledge');
    expect(
      screen
        .getByRole('link', { name: 'Propose the settings to the repository' })
        .getAttribute('href'),
    ).toBe('/projects/acme_api/settings');
    // A page waits for review, so the step is not done — and the ending is still the next action.
    expect(stepStates()[5]).toBe('Review and finish:current');
    const board = screen.getByRole('link', { name: 'Open the board' });
    expect(board.getAttribute('href')).toBe('/projects/acme_api');
    expect(screen.queryByRole('button', { name: /^Continue to / })).toBeNull();
    fireEvent.click(board);
    await waitFor(() => {
      expect(window.location.pathname).toBe('/projects/acme_api');
    });
  });

  it('says so for a project key the deployment does not have', async () => {
    openAt('/onboarding?project=nope', fetchFor('absent'));
    expect(await screen.findByText('No such project')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'New project' }).getAttribute('href')).toBe(
      '/onboarding',
    );
  });

  it('leaves a retired integration out of the binding picker (WP-122)', async () => {
    openAt(wizardOf('connect'), withPickerIntegrations(fetchFor('absent')));
    expect(await screen.findByText('Live workspace')).toBeTruthy();
    expect(screen.queryByText('Retired workspace')).toBeNull();
  });
});

describe('the wizard’s technical discovery', () => {
  it('starts discovery with its ceiling on the button and an Idempotency-Key', async () => {
    const { state, fetchImpl } = serverFor('absent');
    openAt(wizardOf('discovery'), fetchImpl);
    const run = await screen.findByRole('button', { name: 'Run discovery — up to $2.00' });
    fireEvent.click(run);
    expect(await screen.findByText('the Discovery agent is queued')).toBeTruthy();
    expect(state.sent.map((entry) => entry.url)).toEqual([
      expect.stringContaining(`/api/projects/${PROJECT}/discovery`),
    ]);
    expect(state.sent[0]?.key).toMatch(/\S/);
    // The purpose line names the same ceiling.
    expect(document.querySelector('[data-step-purpose]')?.textContent).toContain('at most $2.00');
  });

  it('tells an operator a project with no evaluation needs a discovery run', async () => {
    openAt(wizardOf('discovery'), fetchFor('absent'));
    // The 409 is an answer. Nothing here is an error notice, and nothing crashed.
    expect(await screen.findByText(/No readiness evaluation yet/)).toBeTruthy();
    expect(screen.queryByTestId('error-fallback')).toBeNull();
  });

  it('renders the level as a meter, the criteria by name and the cheapest improvements', async () => {
    openAt(wizardOf('discovery'), fetchFor('recorded'));
    expect(await screen.findByText('Readiness level 1')).toBeTruthy();
    const meter = screen.getByRole('meter', { name: 'Readiness level' });
    expect(meter.getAttribute('value')).toBe('1');
    expect(meter.getAttribute('min')).toBe('0');
    expect(meter.getAttribute('max')).toBe('4');
    // product/17 § "Onboarding wizard": the level *and* the three cheapest criteria to improve.
    expect(await screen.findByText(/Lint and formatter enforced in CI/)).toBeTruthy();
    // Each criterion by its human name, with the platform's `unlocks` beside it…
    const criteria = screen.getByRole('list', { name: 'Readiness criteria' });
    const r1 = criteria.querySelector('[data-criterion="R1"]') as HTMLElement;
    expect(within(r1).getByText('Tests run green')).toBeTruthy();
    expect(r1.textContent).toContain('Implementation self-check');
    expect(within(r1).getByRole('img', { name: 'Passed' })).toBeTruthy();
    const r9 = criteria.querySelector('[data-criterion="R9"]') as HTMLElement;
    expect(within(r9).getByText('Protected default branch')).toBeTruthy();
    expect(within(r9).getByRole('img', { name: 'Not met' })).toBeTruthy();
    expect(r9.textContent).toContain('Human merge guarantee');
    // …and the id only behind Details, never beside the name.
    const details = r1.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Criterion R1');
    expect(r1.firstElementChild?.textContent).not.toContain('R1');
  });

  it('shows the CI-rules warning on the readiness panel, with the rule that kept agentic/ out (WP-143)', async () => {
    openAt(wizardOf('discovery'), fetchFor('recorded'));
    await screen.findByText('Readiness level 1');
    const notices = screen.getByRole('list', { name: 'Readiness notices' });
    expect(notices.textContent).toContain('Warning');
    expect(notices.textContent).toContain('CI rules skip agentic/ branches');
    // The rule that decided, and the fix — as text.
    expect(notices.textContent).toContain('"codeception" rules[2]');
    expect(notices.textContent).toContain('(feature|bugfix)');
    expect(notices.textContent).toContain('admit agentic/');
    expect(screen.getByRole('alert').textContent).toContain('CI rules skip agentic/ branches');
  });

  it('marks a criterion the workspace could not run as not checked, and suggests verifying on CI (BD-026)', async () => {
    openAt(wizardOf('discovery'), fetchFor('recorded'));
    await screen.findByText('Readiness level 1');
    const r2 = screen.getByText(/Fast inner loop/).closest('li');
    expect(r2?.textContent).toContain('not checked');
    expect(within(r2 as HTMLElement).getByRole('img', { name: 'Not checked' })).toBeTruthy();
    // Only R2 carries the badge: R1 passed and R9 failed, and neither says "not checked".
    expect(screen.getAllByText('not checked')).toHaveLength(1);
    const notices = screen.getByRole('list', { name: 'Readiness notices' });
    expect(notices.textContent).toContain('Verify on CI?');
    expect(notices.textContent).toContain('verification.mode: ci');
  });

  it('renders untrusted evidence as text, never as markup', async () => {
    // The screen builds no markup from a string (CLAUDE.md: the web app never turns a string into
    // markup), so a page-wide check is enough and is the one that would fail if a later change
    // introduced a sanitiser-and-innerHTML pair.
    const { container } = openAt(wizardOf('discovery'), fetchFor('recorded'));
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

describe('the wizard’s step 4, How autonomous', () => {
  beforeEach(() => {
    window.history.pushState({}, '', wizardOf('autonomy'));
  });

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

  it('enables Save operating mode again as soon as the save resolves while the gate answers 503 (WP-168, backlog 527)', async () => {
    // The save awaits an invalidation of the project's prefix, which re-reads the discovery gate
    // the wizard keeps mounted on every step. A gate read that retried held the button about a second past the PUT.
    let gateReads = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((settle) => {
      release = settle;
    });
    const failingGate = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if ((init?.method ?? 'GET') !== 'GET' && url.includes('/autonomy')) {
        await held;
        return json({ level: 'supervised', preset_version: 1, performed: true });
      }
      if (url.includes('/api/projects/') && url.includes('/rediscovery')) {
        gateReads += 1;
        return json({ error: { code: 'onboarding_unavailable', message: 'cannot say' } }, 503);
      }
      return fetchFor('recorded')(input, init);
    }) as typeof fetch;

    const app = createApp({ fetchImpl: failingGate, realtime: false });
    render(app.element);
    // The wizard reads the gate on every step (the step list says when a discovery runs). Its first
    // read has failed (generous: the canary's retry takes ~1 s) — read off the query itself, since
    // this step does not print the gate's notice.
    await waitFor(
      () => {
        expect(app.queryClient.getQueryState(['project', PROJECT, 'rediscovery'])?.status).toBe(
          'error',
        );
      },
      { timeout: 4_000 },
    );
    const readsBefore = gateReads;
    const save = (await screen.findByRole('button', {
      name: 'Save operating mode',
    })) as HTMLButtonElement;
    fireEvent.click(save);
    await waitFor(() => {
      expect(save.disabled).toBe(true);
    });
    act(() => {
      release();
    });
    // Well under the ~1 s retry delay: the canary (the default retry) fails here.
    await waitFor(
      () => {
        expect(save.disabled).toBe(false);
      },
      { timeout: 400 },
    );
    // The invalidation did re-read the gate — otherwise the case would pass for the wrong reason.
    expect(gateReads).toBeGreaterThan(readsBefore);
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
    // The gap, in the words an operator reads — and the two that are no longer gaps. **Risk
    // classes stopped being one at WP-37**: the set is proposed, the offer is on the screen and
    // accepting it writes the configuration document (standing rule 83 again — the sentence this
    // test used to pin, *"proposing a set from the repository structure"*, described the gap that
    // work package closed).
    // Waited on rather than read synchronously: the offer arrives with the configuration query, and
    // a `textContent` assertion taken before it resolves passes for the wrong reason.
    await screen.findByRole('button', { name: 'Accept these classes' });
    expect(container.textContent).toContain('The platform’s suggested set');
    // …and the checklist the `payments` class needs is asked for by name, with what it is for —
    // on the screen, where the dropped half used to be written only in a docblock (backlog 91).
    expect(container.textContent).toContain('Checklists these classes need, in your words');
    expect(container.textContent).toContain('stricter checklist');
    expect(screen.getByRole('textbox', { name: 'Items for checklist payments' })).toBeTruthy();
    expect(container.textContent).not.toContain('Not proposed, and why');
    expect(container.textContent).not.toContain('A channel belongs to a chat integration');
  });

  it('accepts the proposed risk classes through the configuration write, and applies nothing until then', async () => {
    /**
     * Criterion 1 of WP-37, both ways (standing rule 42). Before the click the project has **no**
     * `policies.risk_classes` — the platform ships none, so a deploy gates nobody — and the click
     * sends the whole document with the proposal copied into `policies`, through the same
     * `PUT …/config` (and therefore the same `human_actions` row) every other control here uses.
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

    const { container } = render(createApp({ fetchImpl: recording, realtime: false }).element);
    const accept = await screen.findByRole('button', { name: 'Accept these classes' });
    // Nothing is applied yet: the configured set is empty while the offer is on the screen.
    expect(container.textContent).toContain('No risk classes configured');
    expect(sent).toEqual([]);

    // WP-45: the `payments` class names a checklist the project has not written, and the schema
    // refuses a class naming an undefined list — so the button waits for the items rather than
    // sending a document the server would refuse (or, worse, one it accepted and ignored).
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('Write at least one item for payments first');
    fireEvent.click(accept);
    expect(sent).toEqual([]);

    fireEvent.change(screen.getByRole('textbox', { name: 'Items for checklist payments' }), {
      target: { value: 'Amounts are integer minor units\n\n  Charges are idempotent  \n' },
    });
    await waitFor(() => {
      expect((accept as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(accept);
    await waitFor(() => {
      expect(sent.some((entry) => entry.url.includes('/config'))).toBe(true);
    });
    const body = sent.find((entry) => entry.url.includes('/config'))?.body as {
      config: {
        policies?: {
          risk_classes?: unknown;
          review_checklists?: unknown;
          protected_paths?: string[];
        };
      };
      base_hash?: string;
    };
    expect(body.config.policies?.risk_classes).toEqual({
      data: { paths: ['**/migrations/**'], require: ['plan_approval'] },
      payments: { paths: ['**/billing/**'], require: ['plan_approval', 'checklist:payments'] },
    });
    // One item per non-empty line, trimmed: the operator's words and nothing the platform added.
    expect(body.config.policies?.review_checklists).toEqual({
      payments: ['Amounts are integer minor units', 'Charges are idempotent'],
    });
    // The rest of the document survives, and the write is optimistic — the two properties the
    // feature toggle's own test pins, asserted here because this is a second writer of the document.
    expect(body.config.policies?.protected_paths).toEqual(['tests/**']);
    expect(body.base_hash).toBe('deadbeef');
  });

  // S-23.23 (the UX audit's item 8): replacing classes already in force asks first, and says what
  // happens to the ones that are there.
  it('replaces risk classes already in force only after a confirmation', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const recording = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if ((init?.method ?? 'GET') !== 'GET') {
        sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
        return json({ hash: 'newhash', autonomy_level: 'supervised' });
      }
      const answer = await fetchFor('recorded')(input, init);
      if (url.includes('/api/projects/') && url.includes('/config')) {
        const body = (await answer.json()) as {
          config: { policies: Record<string, unknown> };
        };
        body.config.policies.risk_classes = {
          auth: { paths: ['src/auth/**'], require: ['plan_approval'] },
        };
        return json(body);
      }
      return answer;
    }) as typeof fetch;

    render(createApp({ fetchImpl: recording, realtime: false }).element);
    const replace = await screen.findByRole('button', { name: 'Replace with these classes…' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Items for checklist payments' }), {
      target: { value: 'Charges are idempotent' },
    });
    await waitFor(() => {
      expect((replace as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(replace);
    const dialog = await screen.findByRole('dialog', { name: 'Replace the risk classes?' });
    expect(dialog.textContent).toContain('replaced by the 2 proposed here');
    expect(sent).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace the classes' }));
    await waitFor(() => {
      expect(sent.some((entry) => entry.url.includes('/config'))).toBe(true);
    });
  });

  it('says why the command policy is not editable here, behind Learn more', async () => {
    // A project may only narrow each role's shipped baseline (BD-025, WP-54), so a `commands.allow`
    // editor would be an affordance that can only take commands away.
    const { container } = render(
      createApp({ fetchImpl: fetchFor('recorded'), realtime: false }).element,
    );
    // Waited on the dial, not on the step's title: the title renders before the projects list
    // arrives, so a wait on it would assert against a screen that has not resumed a project yet.
    await screen.findByText('Autonomy dial');
    // The sentence spans an `<em>`, so it is read off the rendered text rather than matched against
    // one element.
    expect(container.textContent).toContain('may only narrow that baseline');
    // The jargon (the file name, the commands) is behind the disclosure, not in the step's text.
    const learnMore = screen
      .getByText('Learn more: the commands agents may run')
      .closest('details');
    expect(learnMore?.textContent).toContain('may only narrow that baseline');
    expect(learnMore?.open).toBe(false);
    // The sentence it replaced said a project's test command needed a widening nothing exposed —
    // false since WP-54, and asserted gone so it cannot come back with a copy-paste.
    expect(container.textContent).not.toContain('nothing in this build exposes');
  });
});
