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
  organisation_maximum: null,
  level_in_force: 'supervised',
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
    /** WP-63: the export and the re-read, with the headers so the key can be asserted. */
    readonly onPost?: (url: string, body: unknown, headers: Headers) => Response | undefined;
    /** WP-91: fields of `GET …/config` a test replaces (the WIP limits, a last export). */
    readonly config?: Record<string, unknown>;
  } = {},
) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (init?.method === 'POST' && url.includes('/config/')) {
      const answered = options.onPost?.(
        url,
        JSON.parse(String(init.body ?? '{}')),
        new Headers(init.headers),
      );
      if (answered !== undefined) return answered;
    }
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
        config: { version: 1 },
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
        risk_class_proposal: { source: 'platform', classes: {}, checklists: [] },
        ...options.config,
      });
    }
    if (url.endsWith('/api/projects')) return json({ items: [PROJECT_ROW] });
    if (url.endsWith('/api/integrations')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

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
  window.history.pushState({}, '', '/projects/acme_api/settings');
});

/**
 * WP-63, Q94 (c): the export is a button that stays on this page, and what it sends is the
 * command's contract — an `Idempotency-Key` and the hash of the configuration the operator saw.
 */
describe('the repository configuration card', () => {
  it('proposes the settings with a key and the hash that was read, and shows the merge request', async () => {
    const posts: { url: string; body: unknown; key: string | null }[] = [];
    render(
      createApp({
        fetchImpl: fetchFor(
          {},
          {
            onPost: (url, body, headers) => {
              posts.push({ url, body, key: headers.get('idempotency-key') });
              return url.endsWith('/config/export')
                ? json({
                    status: 'exported',
                    performed: true,
                    config_hash: 'deadbeef',
                    branch: 'agentic/config/deadbeef0000-0123456789ab',
                    commit_sha: 'abc1234',
                    merge_request_url: 'https://git.example.test/acme/api/-/merge_requests/9',
                    paths: ['.agentic/config.yml', 'CLAUDE.md'],
                    notes: [],
                  })
                : undefined;
            },
          },
        ),
        realtime: false,
      }).element,
    );
    expect(await screen.findByText('Repository configuration')).toBeTruthy();
    await waitFor(() => {
      expect(document.body.textContent).toContain('.agentic/config.yml: unread');
    });
    await userEvent.click(screen.getByText('Propose these settings to the repository'));
    await waitFor(() => {
      expect(document.body.textContent).toContain('agentic/config/deadbeef0000-0123456789ab');
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain(`/api/projects/${PROJECT}/config/export`);
    expect(posts[0]?.body).toEqual({ base_hash: 'deadbeef' });
    expect(posts[0]?.key).toMatch(/.+/);
    expect(screen.getByText('open the merge request').getAttribute('href')).toBe(
      'https://git.example.test/acme/api/-/merge_requests/9',
    );
  });

  it('shows the key paths when the re-read finds a file that does not parse', async () => {
    render(
      createApp({
        fetchImpl: fetchFor(
          {},
          {
            onPost: (url) =>
              url.endsWith('/config/refresh')
                ? json({
                    repository: {
                      path: '.agentic/config.yml',
                      status: 'invalid',
                      commit_sha: 'e'.repeat(40),
                      read_at: '2026-09-13T04:00:00.000Z',
                      detail: 'stages.refinement.max_turns (expected number)',
                      not_applied: [],
                      prompts: null,
                      prompts_withheld: null,
                    },
                  })
                : undefined,
          },
        ),
        realtime: false,
      }).element,
    );
    await userEvent.click(await screen.findByText('Re-read the repository'));
    await waitFor(() => {
      expect(document.body.textContent).toContain('stages.refinement.max_turns');
    });
    expect(document.body.textContent).toContain('no run starts until it does');
  });
});

/**
 * WP-91: the export's merge request survives a reload (backlog 225), a second press with one open
 * says it opened none, and the WIP limits and the unread keys come from the server's answer.
 */
describe('the configuration the server reports (WP-91)', () => {
  it('lists the last export after a reload, as recorded, with its merge request', async () => {
    render(
      createApp({
        fetchImpl: fetchFor(
          {},
          {
            config: {
              last_export: {
                status: 'exported',
                config_hash: 'deadbeef',
                branch: 'agentic/config/deadbeef0000-0123456789ab',
                merge_request_url: 'https://git.example.test/acme/api/-/merge_requests/9',
                exported_at: '2026-09-13T04:00:00.000Z',
              },
            },
          },
        ),
        realtime: false,
      }).element,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain('Last export');
    });
    expect(document.body.textContent).toContain('agentic/config/deadbeef0000-0123456789ab');
    expect(screen.getByText('open the merge request').getAttribute('href')).toBe(
      'https://git.example.test/acme/api/-/merge_requests/9',
    );
  });

  it('shows no last export when the project was never exported', async () => {
    render(createApp({ fetchImpl: fetchFor({}), realtime: false }).element);
    await waitFor(() => {
      expect(document.body.textContent).toContain('.agentic/config.yml: unread');
    });
    expect(document.body.textContent).not.toContain('Last export');
  });

  it('says a second press opened nothing when the previous merge request is still open', async () => {
    render(
      createApp({
        fetchImpl: fetchFor(
          {},
          {
            onPost: (url) =>
              url.endsWith('/config/export')
                ? json({
                    status: 'open',
                    performed: false,
                    config_hash: 'deadbeef',
                    branch: 'agentic/config/deadbeef0000-0123456789ab',
                    commit_sha: null,
                    merge_request_url: 'https://git.example.test/acme/api/-/merge_requests/9',
                    paths: [],
                    notes: [
                      'merge request !9 already proposes this configuration and is still open',
                    ],
                  })
                : undefined,
          },
        ),
        realtime: false,
      }).element,
    );
    await userEvent.click(await screen.findByText('Propose these settings to the repository'));
    await waitFor(() => {
      expect(document.body.textContent).toContain('no second one was opened');
    });
    expect(document.body.textContent).toContain('!9 already proposes this configuration');
  });

  it('shows the WIP limits the server answers, their source, and the unread keys', async () => {
    render(
      createApp({
        fetchImpl: fetchFor(
          {},
          {
            config: {
              effective: {
                version: 1,
                pipeline: { wip: { max_parallel_tasks: 1, max_tasks_in_pipeline: 5 } },
              },
              sources: {
                'pipeline.wip.max_parallel_tasks': 'project',
                'pipeline.wip.max_tasks_in_pipeline': 'default',
              },
              not_applied: [
                {
                  key: 'pipeline.template_overrides.feature.stages.business_review.enabled',
                  reason: 'switching a stage off is not applied on this build',
                },
              ],
            },
          },
        ),
        realtime: false,
      }).element,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain('Max parallel tasks 1 (project)');
    });
    expect(document.body.textContent).toContain('max tasks in pipeline 5 (default)');
    expect(document.body.textContent).toContain(
      'pipeline.template_overrides.feature.stages.business_review.enabled',
    );
  });
});

/**
 * WP-113 (PROGRESS backlog 315 (b)): the project's prompt files are visible before a run — what the
 * last reading holds (never the text), at which commit, what each stage would be given, and a
 * *Re-read now* on the existing refresh.
 */
describe('the project prompt files card (WP-113)', () => {
  const SHA = 'f00dfeed'.repeat(5);
  const READING = {
    path: '.agentic/config.yml',
    status: 'absent',
    commit_sha: SHA,
    read_at: '2026-10-01T09:00:00.000Z',
    detail: null,
    not_applied: [],
    prompts: {
      directory: '.agentic/prompts',
      cut_at_chars: 8_000,
      truncated: false,
      files: [
        {
          path: '.agentic/prompts/big.md',
          status: 'oversized',
          chars: null,
          bytes: 20_480,
          cut: false,
        },
        {
          path: '.agentic/prompts/implementation.md',
          status: 'file',
          chars: 9_120,
          bytes: null,
          cut: true,
        },
      ],
    },
    prompts_withheld: null,
  };
  const STAGES = [
    {
      stage: 'implementation',
      key: 'prompt',
      path: '.agentic/prompts/implementation.md',
      declared: false,
      status: 'read',
      given: true,
      cut: true,
    },
    {
      stage: 'implementation',
      key: 'prompt_append',
      path: '.agentic/prompts/implementation.append.md',
      declared: false,
      status: 'absent',
      given: false,
      cut: false,
    },
    {
      stage: 'refinement',
      key: 'prompt',
      path: '.agentic/prompts/pm.md',
      declared: true,
      status: 'absent',
      given: true,
      cut: false,
    },
  ];

  it('shows the reading’s commit, each file’s length and cut, what each stage is given, and re-reads on the existing refresh', async () => {
    const posts: { url: string; key: string | null }[] = [];
    render(
      createApp({
        fetchImpl: fetchFor(
          {},
          {
            config: { repository: READING, stage_prompts: STAGES },
            onPost: (url, _body, headers) => {
              if (!url.endsWith('/config/refresh')) return undefined;
              posts.push({ url, key: headers.get('idempotency-key') });
              return json({
                repository: { ...READING, prompts: null },
                prompts_withheld:
                  'the credentials of integration GitLab cannot be decrypted, so the prompt files cannot be redacted against them',
              });
            },
          },
        ),
        realtime: false,
      }).element,
    );
    expect(await screen.findByText('Project prompt files')).toBeTruthy();
    const files = await screen.findByRole('list', { name: 'Prompt files in the last reading' });
    expect(files.textContent).toContain('.agentic/prompts/implementation.md');
    expect(files.textContent).toContain('9,120 characters — a stage gets the first 8,000');
    expect(files.textContent).toContain('20,480 bytes — over 16 KiB, not read');
    expect(document.body.textContent).toContain('Last reading at f00dfeedf00d');
    expect(document.body.textContent).toContain('never at the merge');

    // Given or named only: the convention append file nobody wrote is not listed.
    const stages = screen.getByRole('list', { name: 'What each stage is given' });
    expect(stages.textContent).toContain('.agentic/prompts/implementation.md');
    expect(stages.textContent).toContain('by its conventional name — given');
    expect(stages.textContent).toContain(
      'named by the configuration — named, and not on the default branch — the stage runs without it',
    );
    expect(stages.textContent).not.toContain('implementation.append.md');

    await userEvent.click(screen.getByText('Re-read now'));
    await waitFor(() => {
      expect(document.body.textContent).toContain('the prompt files were not');
    });
    expect(document.body.textContent).toContain('integration GitLab cannot be decrypted');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain(`/api/projects/${PROJECT}/config/refresh`);
  });

  it('says a reading that holds no prompt directory holds none, rather than showing an empty list as a fact', async () => {
    render(createApp({ fetchImpl: fetchFor({}), realtime: false }).element);
    expect(await screen.findByText('Project prompt files')).toBeTruthy();
    await waitFor(() => {
      expect(document.body.textContent).toContain('This reading holds no prompt files');
    });
    expect(document.body.textContent).toContain('The repository has not been read yet.');
    expect(document.body.textContent).toContain('No stage is given a project prompt file.');
    expect(screen.queryByRole('list', { name: 'Prompt files in the last reading' })).toBeNull();
  });

  /**
   * WP-121 (PROGRESS backlog 363): the stored reading records why it serves no prompt text, so the
   * screen says so without a re-read — the integrations whose credentials could not be read, each
   * with the store's reason, every string as text (BD-022).
   */
  it('shows the integrations a reading withheld its prompt files for, from the stored reading (WP-121)', async () => {
    const HOSTILE_NAME =
      'integration "<img src=x onerror=alert(1)>" (sentry, 00000000-0000-4000-8000-00000000a358)';
    render(
      createApp({
        fetchImpl: fetchFor(
          {},
          {
            config: {
              repository: {
                ...READING,
                prompts: null,
                prompts_withheld: {
                  reason:
                    'the credentials of the Sentry integration cannot be decrypted, so the prompt files cannot be redacted against them',
                  integrations: [
                    { integration: HOSTILE_NAME, reason: 'secret … is sealed under key "v1:old"' },
                  ],
                },
              },
              stage_prompts: [],
            },
          },
        ),
        realtime: false,
      }).element,
    );
    const note = await screen.findByRole('note', { name: 'Prompt files withheld' });
    expect(note.textContent).toContain('The prompt files of this reading are withheld.');
    expect(note.textContent).toContain('the Sentry integration cannot be decrypted');
    const integrations = screen.getByRole('list', {
      name: 'Integrations whose credentials could not be read',
    });
    expect(integrations.textContent).toContain(HOSTILE_NAME);
    expect(integrations.textContent).toContain('sealed under key "v1:old"');
    // Text, never markup.
    expect(note.querySelector('img')).toBeNull();
    expect(document.body.textContent).not.toContain('This reading holds no prompt files');
  });
});

describe('the project settings page', () => {
  it('leaves a retired integration out of the binding picker (WP-122)', async () => {
    render(createApp({ fetchImpl: withPickerIntegrations(fetchFor({})), realtime: false }).element);
    expect(await screen.findByText('Live workspace')).toBeTruthy();
    expect(screen.queryByText('Retired workspace')).toBeNull();
  });

  /**
   * WP-122 (PROGRESS backlog 385): the settings audit named every failure *"needs the maintainer
   * role"*. A 503 is shown as what the server said; only a 403 keeps the role sentence.
   */
  it('does not name a 503 on the settings audit a permission problem, and keeps the sentence for a 403', async () => {
    const failing =
      (status: number, code: string, message: string): typeof fetch =>
      async (input, init) =>
        String(input).endsWith(`/api/projects/${PROJECT}/audit`)
          ? json({ error: { code, message } }, status)
          : fetchFor({})(input, init);
    render(
      createApp({
        fetchImpl: failing(503, 'audit_unavailable', 'the audit store is not reachable'),
        realtime: false,
      }).element,
    );
    // The client retries a failed read once (`retry: 1`), so the notice arrives after that retry.
    expect(
      await screen.findByText('The settings audit could not be loaded.', {}, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain('the audit store is not reachable');
    expect(document.body.textContent).not.toContain('needs the maintainer role');
    cleanup();
    render(
      createApp({
        fetchImpl: failing(403, 'forbidden', 'role member may not perform org.audit.read'),
        realtime: false,
      }).element,
    );
    expect(
      await screen.findByText('The settings audit could not be loaded.', {}, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain('Reading it needs the maintainer role.');
  });

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

/**
 * Q100 per its recommendation (WP-94): the maintenance card says it is paused when the level in
 * force is Observe and the feature is on — the state the nightly pass logs by name — and says
 * nothing of the kind at Assist.
 */
describe('the maintenance card and the dial (Q100)', () => {
  const maintenanceOn = { config: { version: 1, features: { maintenance: { enabled: true } } } };

  it('says “paused at Observe” when the dial in force is Observe', async () => {
    render(
      createApp({
        fetchImpl: fetchFor(
          { level: 'observe', level_in_force: 'observe' },
          { config: maintenanceOn },
        ),
        realtime: false,
      }).element,
    );
    expect(await screen.findByText(/Paused at Observe/)).toBeTruthy();
  });

  it('says nothing of the kind at Assist, where chores still run', async () => {
    render(
      createApp({
        fetchImpl: fetchFor(
          { level: 'assist', level_in_force: 'assist' },
          { config: maintenanceOn },
        ),
        realtime: false,
      }).element,
    );
    expect(await screen.findByText('Maintenance pipeline')).toBeTruthy();
    await waitFor(() => {
      expect(document.body.textContent).toContain('at Observe no chore is created');
    });
    expect(screen.queryByText(/Paused at Observe/)).toBeNull();
  });
});
