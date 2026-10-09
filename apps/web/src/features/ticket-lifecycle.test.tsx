/**
 * The ticket lifecycle's pick lists (WP-182 ruling (a), criterion (1)), and the readiness notes they
 * answer (ruling (b)).
 *
 * Driven through `createApp` with a fake server, so the real router, query client and endpoint
 * parsers are in the path, and asserted on the **request** the save sends — the slot a person left
 * empty must not be in it. Every status name here is invented for this file (BD-031 ruling 1).
 */
import type {
  IntegrationSummary,
  ProjectBindingsResponse,
  ProjectSummary,
  ReadinessResponse,
  TicketStatus,
} from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { ReadinessNotices } from './readiness-notices.js';
import { lifecycleDraftOf, lifecycleOverlayOf, slotOfDetailPath } from './ticket-lifecycle.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const TRACKER = '00000000-0000-4000-8000-0000000000b2';
const CHAT = '00000000-0000-4000-8000-0000000000b3';
/** A second tracker integration, for the case that rebinds the project to it. */
const OTHER_TRACKER = '00000000-0000-4000-8000-0000000000b4';

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
  key: 'demo_service',
  name: 'Demo service',
  repo_url: 'https://git.example.test/demo/service.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 1,
  status: 'active',
  created_at: '2026-10-08T04:00:00.000Z',
  updated_at: '2026-10-08T04:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
};

/** The tracker's statuses, invented: what the pick lists may offer and nothing else. */
const STATUSES: readonly TicketStatus[] = [
  { id: 's1', name: 'Doing', category: 'in_progress', raw_category: 'indeterminate' },
  { id: 's2', name: 'Waiting for review', category: 'in_progress', raw_category: 'indeterminate' },
  { id: 's3', name: 'Testing', category: 'in_progress', raw_category: null },
  { id: 's4', name: 'Sent back', category: 'todo', raw_category: 'new' },
  { id: 's5', name: 'Finished', category: 'done', raw_category: 'done' },
];

/** The second tracker's statuses, invented and disjoint from {@link STATUSES} by name. */
const OTHER_STATUSES: readonly TicketStatus[] = [
  { id: 'o1', name: 'Queued', category: 'todo', raw_category: 'new' },
  { id: 'o2', name: 'Under scrutiny', category: 'in_progress', raw_category: null },
  { id: 'o3', name: 'Checking', category: 'in_progress', raw_category: null },
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const trackerIntegration = (
  config: Record<string, unknown> = {},
  id: string = TRACKER,
): IntegrationSummary => ({
  id,
  type: 'task_management',
  provider: 'jira-cloud',
  name: 'Tracker (fake)',
  config: { site_url: 'https://tracker.example.invalid', ...config },
  health: { status: 'ok', checked_at: null, detail: null },
  config_refusal: null,
  retired_at: null,
  credentials_readable: null,
  credentials_consequence: null,
});

const bindingsWith = (
  trackerOverlay: Record<string, unknown>,
): ProjectBindingsResponse['items'] => [
  {
    integration_id: TRACKER,
    type: 'task_management',
    provider: 'jira-cloud',
    name: 'Tracker (fake)',
    config: trackerOverlay,
  },
  {
    integration_id: CHAT,
    type: 'communication',
    provider: 'slack',
    name: 'Chat (fake)',
    config: { channel: '#delivery' },
  },
];

interface World {
  bindings: ProjectBindingsResponse['items'];
  account: Record<string, unknown>;
  /** What `GET …/ticket-statuses` answers. */
  statuses: (trackerId: string | null) => Response;
  /** What `PUT …/bindings` answers; the body is recorded in `puts` first. */
  put: (body: unknown) => Response;
  puts: unknown[];
  statusReads: number;
  /** `GET …/config`'s `status_mapping_superseded`, or no configuration read at all. */
  superseded: boolean | null;
}

const world = (overrides: Partial<World> = {}): World => ({
  bindings: bindingsWith({}),
  account: {},
  // Like the server: the statuses of whichever tracker the project binds now.
  statuses: (trackerId) => json({ items: trackerId === OTHER_TRACKER ? OTHER_STATUSES : STATUSES }),
  put: () => json({ items: [] }),
  puts: [],
  statusReads: 0,
  superseded: null,
  ...overrides,
});

const server = (state: World): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (method === 'PUT' && url.endsWith(`/api/projects/${PROJECT}/bindings`)) {
      const body: unknown = JSON.parse(String(init?.body));
      state.puts.push(body);
      return state.put(body);
    }
    if (url.endsWith(`/api/projects/${PROJECT}/ticket-statuses`)) {
      state.statusReads += 1;
      return state.statuses(
        state.bindings.find((item) => item.type === 'task_management')?.integration_id ?? null,
      );
    }
    if (url.endsWith(`/api/projects/${PROJECT}/bindings`)) return json({ items: state.bindings });
    if (url.endsWith(`/api/projects/${PROJECT}/config`) && state.superseded !== null) {
      return json(effectiveConfig(state.superseded));
    }
    if (url.endsWith('/api/projects')) return json({ items: [PROJECT_ROW] });
    if (url.endsWith('/api/integrations')) {
      return json({
        items: [trackerIntegration(state.account), trackerIntegration({}, OTHER_TRACKER)],
      });
    }
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

/** `GET …/config` with a `status_mapping` key from the project layer (WP-181's flag under test). */
const effectiveConfig = (superseded: boolean) => ({
  config: { version: 1, status_mapping: { implementation: 'Doing' } },
  effective: { version: 1, status_mapping: { implementation: 'Doing' } },
  repository: {
    path: '.agentic/config.yml',
    status: 'unread',
    commit_sha: null,
    read_at: null,
    detail: null,
    not_applied: [],
    prompts: null,
    prompts_withheld: null,
  },
  sources: { version: 'project', 'status_mapping.implementation': 'project' },
  hash: 'deadbeef',
  computed_at: '2026-10-08T04:00:00.000Z',
  not_applied: [],
  last_export: null,
  ignored_allow_commands: [],
  stage_prompts: [],
  status_mapping_superseded: superseded,
  risk_class_proposal: { source: 'platform', classes: {}, checklists: [] },
});

const renderSettings = (state: World) => {
  window.history.pushState({}, '', `/projects/${PROJECT_ROW.key}/settings`);
  render(createApp({ fetchImpl: server(state), realtime: false }).element);
};

/** The lifecycle card, once its pick lists are on screen. */
const lifecycleCard = async (): Promise<HTMLElement> => {
  const card = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-ticket-lifecycle="${TRACKER}"]`);
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  return card;
};

const slotSelect = (card: HTMLElement, label: string): HTMLSelectElement =>
  within(card).getByLabelText(label) as HTMLSelectElement;

const trackerConfigOf = (body: unknown): Record<string, unknown> => {
  const items = (body as { items: { integration_id: string; config?: Record<string, unknown> }[] })
    .items;
  return items.find((item) => item.integration_id === TRACKER)?.config ?? {};
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the ticket lifecycle pick lists (WP-182 criterion (1))', () => {
  it('offers only the loaded names, each with its category, in every slot', async () => {
    const state = world();
    renderSettings(state);
    const card = await lifecycleCard();
    const loaded = STATUSES.map((status) => status.name);
    for (const label of ['Pick up from', 'In progress', 'In review', 'Approved', 'QA', 'Done']) {
      const options = Array.from(slotSelect(card, label).options);
      expect(
        options.map((option) => option.value),
        label,
      ).toEqual(['', ...loaded]);
      expect(options[0]?.textContent).toBe('Not mapped');
    }
    const returned = Array.from(slotSelect(card, 'Returned').options);
    expect(returned.map((option) => option.value)).toEqual(loaded);
    expect(within(card).getAllByText('Testing (in progress)').length).toBeGreaterThan(0);
    expect(within(card).getAllByText('Finished (done)').length).toBeGreaterThan(0);
    // One read of the tracker for the whole card, not one per select.
    expect(state.statusReads).toBe(1);
  });

  it('sends an empty selection as absent, and every other binding as it was', async () => {
    const state = world();
    renderSettings(state);
    const card = await lifecycleCard();
    const user = userEvent.setup();
    await user.selectOptions(slotSelect(card, 'In review'), 'Waiting for review');
    await user.selectOptions(slotSelect(card, 'Returned'), ['Sent back']);
    await user.click(within(card).getByRole('button', { name: 'Save the ticket lifecycle' }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    const config = trackerConfigOf(state.puts[0]);
    expect(config).toEqual({
      lifecycle: {
        in_review: 'Waiting for review',
        returned: ['Sent back'],
        claim: true,
        take_assigned_tickets: false,
      },
    });
    // No `pickup_status`, no empty strings, no empty list: the empty slots are not in the request.
    expect('pickup_status' in config).toBe(false);
    const items = (state.puts[0] as { items: { integration_id: string; config?: unknown }[] })
      .items;
    expect(items.find((item) => item.integration_id === CHAT)?.config).toEqual({
      channel: '#delivery',
    });
  });

  it('sends an emptied pick-up slot as null when the integration itself names one', async () => {
    const state = world({
      account: { pickup_status: 'Sent back' },
      bindings: bindingsWith({ lifecycle: { qa: 'Testing', claim: false } }),
    });
    renderSettings(state);
    const card = await lifecycleCard();
    expect(slotSelect(card, 'Pick up from').value).toBe('Sent back');
    expect(slotSelect(card, 'QA').value).toBe('Testing');
    const claim = within(card).getByRole('checkbox', { name: /Claim the ticket/ });
    expect((claim as HTMLInputElement).checked).toBe(false);
    const user = userEvent.setup();
    await user.selectOptions(slotSelect(card, 'Pick up from'), '');
    await user.click(within(card).getByRole('button', { name: 'Save the ticket lifecycle' }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(trackerConfigOf(state.puts[0])).toEqual({
      pickup_status: null,
      lifecycle: { qa: 'Testing', claim: false, take_assigned_tickets: false },
    });
  });

  it('marks the slot a 422 names, and only that slot', async () => {
    const state = world({
      put: () =>
        json(
          {
            error: {
              code: 'lifecycle_status_unknown',
              message: 'lifecycle.in_review: not listed; nothing was saved',
              details: [
                {
                  path: 'lifecycle.in_review',
                  message:
                    'the in review slot names "Waiting for review", which "Tracker (fake)" does not list among its statuses',
                },
              ],
            },
          },
          422,
        ),
    });
    renderSettings(state);
    const card = await lifecycleCard();
    const user = userEvent.setup();
    await user.selectOptions(slotSelect(card, 'In review'), 'Waiting for review');
    await user.click(within(card).getByRole('button', { name: 'Save the ticket lifecycle' }));
    await waitFor(() =>
      expect(slotSelect(card, 'In review').getAttribute('aria-invalid')).toBe('true'),
    );
    const slot = card.querySelector<HTMLElement>('[data-lifecycle-slot="in_review"]');
    expect(within(slot as HTMLElement).getByText(/does not list among its statuses/)).toBeTruthy();
    for (const label of ['Pick up from', 'In progress', 'Approved', 'QA', 'Done', 'Returned']) {
      expect(slotSelect(card, label).getAttribute('aria-invalid'), label).toBeNull();
    }
    expect(
      within(card).getByText('Nothing was saved: a slot names a status the tracker does not list.'),
    ).toBeTruthy();
  });

  it('renders the 503 notice on a save and keeps the form as it was', async () => {
    const state = world({
      put: () =>
        json(
          {
            error: {
              code: 'lifecycle_statuses_unavailable',
              message: 'the statuses could not be read; nothing was saved',
            },
          },
          503,
        ),
    });
    renderSettings(state);
    const card = await lifecycleCard();
    const user = userEvent.setup();
    await user.selectOptions(slotSelect(card, 'Done'), 'Finished');
    await user.click(within(card).getByRole('checkbox', { name: /already assigned to a person/ }));
    await user.click(within(card).getByRole('button', { name: 'Save the ticket lifecycle' }));
    expect(
      await within(card).findByText(
        'The tracker’s statuses could not be loaded, so nothing was saved.',
      ),
    ).toBeTruthy();
    expect(slotSelect(card, 'Done').value).toBe('Finished');
    expect(
      (
        within(card).getByRole('checkbox', {
          name: /already assigned to a person/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    // Pressed again, the same draft is sent: nothing was reset.
    await user.click(within(card).getByRole('button', { name: 'Save the ticket lifecycle' }));
    await waitFor(() => expect(state.puts).toHaveLength(2));
    expect(trackerConfigOf(state.puts[1])).toEqual(trackerConfigOf(state.puts[0]));
  });

  it('says the statuses could not be loaded when the read answers 503, and offers no pick list', async () => {
    const state = world({
      statuses: () =>
        json(
          {
            error: {
              code: 'lifecycle_statuses_unavailable',
              message: 'the tracker did not answer',
            },
          },
          503,
        ),
    });
    renderSettings(state);
    expect(
      await screen.findByText(
        'The tracker’s statuses could not be loaded, so the slots cannot be picked yet.',
      ),
    ).toBeTruthy();
    expect(document.querySelector('[data-ticket-lifecycle]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save the ticket lifecycle' })).toBeNull();
  });

  it('names a stored status the tracker no longer lists, and leaves its slot empty', async () => {
    const state = world({ bindings: bindingsWith({ lifecycle: { approved: 'Signed off' } }) });
    renderSettings(state);
    const card = await lifecycleCard();
    expect(slotSelect(card, 'Approved').value).toBe('');
    const note = card.querySelector<HTMLElement>('[data-lifecycle-dropped="approved"]');
    expect(note?.textContent).toContain('Signed off');
  });

  it('asks for no statuses and offers no slot when no tracker is bound', async () => {
    const state = world({
      bindings: bindingsWith({}).filter((item) => item.type !== 'task_management'),
    });
    renderSettings(state);
    expect(await screen.findByText(/Bind a ticket tracker first/)).toBeTruthy();
    expect(state.statusReads).toBe(0);
  });

  it('is the wizard’s step 1 too — the same component', async () => {
    const state = world();
    window.history.pushState({}, '', '/onboarding');
    render(createApp({ fetchImpl: server(state), realtime: false }).element);
    const card = await lifecycleCard();
    expect(slotSelect(card, 'QA')).toBeTruthy();
  });
});

describe('the lifecycle form, review round 1', () => {
  it('saves an untouched form as a block with every slot empty and the claim on, after saying so', async () => {
    // TD-029 decision 1: a saved block claims by default; the card says it before anything is sent.
    const state = world();
    renderSettings(state);
    const card = await lifecycleCard();
    const warning = card.querySelector<HTMLElement>('[data-lifecycle="not-saved"]');
    expect(warning?.textContent).toContain('starts the claim unless you switch it off');
    expect(state.puts).toHaveLength(0);
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: 'Save the ticket lifecycle' }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(trackerConfigOf(state.puts[0])).toEqual({
      lifecycle: { claim: true, take_assigned_tickets: false },
    });
  });

  it('offers the new tracker its own names when only the bindings are read again (review round 2)', async () => {
    // Another administrator rebinds the project to another tracker; this page reads the bindings
    // again and nothing else. A statuses answer cached for the project, not for the tracker, would
    // then seed the new tracker's form from the first tracker's names.
    window.history.pushState({}, '', `/projects/${PROJECT_ROW.key}/settings`);
    const state = world();
    const app = createApp({ fetchImpl: server(state), realtime: false });
    render(app.element);
    await lifecycleCard();
    state.bindings = [
      {
        integration_id: OTHER_TRACKER,
        type: 'task_management',
        provider: 'jira-cloud',
        name: 'Other tracker (fake)',
        config: { lifecycle: { qa: 'Checking' } },
      },
    ];
    await app.queryClient.invalidateQueries({ queryKey: ['project', PROJECT, 'bindings'] });
    const other = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        `[data-ticket-lifecycle="${OTHER_TRACKER}"]`,
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    const offered = Array.from(slotSelect(other, 'QA').options, (option) => option.value);
    expect(offered).toEqual(['', ...OTHER_STATUSES.map((status) => status.name)]);
    for (const status of STATUSES) {
      expect(offered, status.name).not.toContain(status.name);
    }
    expect(slotSelect(other, 'QA').value).toBe('Checking');
    expect(other.querySelector('[data-lifecycle-dropped]')).toBeNull();
  });

  it('seeds the form again when the tracker binding changes on the same page', async () => {
    const state = world({
      // The save rebinds the project to another tracker, whose overlay maps only QA.
      put: () => {
        state.bindings = [
          {
            integration_id: OTHER_TRACKER,
            type: 'task_management',
            provider: 'jira-cloud',
            name: 'Other tracker (fake)',
            config: { lifecycle: { qa: 'Checking' } },
          },
        ];
        return json({ items: state.bindings });
      },
    });
    renderSettings(state);
    const card = await lifecycleCard();
    const user = userEvent.setup();
    await user.selectOptions(slotSelect(card, 'In review'), 'Waiting for review');
    await user.click(within(card).getByRole('button', { name: 'Save the ticket lifecycle' }));
    const other = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        `[data-ticket-lifecycle="${OTHER_TRACKER}"]`,
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    // The new tracker's own block, not the draft made for the first one.
    expect(slotSelect(other, 'QA').value).toBe('Checking');
    expect(slotSelect(other, 'In review').value).toBe('');
    // Its pick lists are its own tracker's names, and none of the first tracker's.
    const offered = Array.from(slotSelect(other, 'In review').options, (option) => option.value);
    expect(offered).toEqual(['', ...OTHER_STATUSES.map((status) => status.name)]);
    for (const status of STATUSES) {
      expect(offered, status.name).not.toContain(status.name);
    }
    // Its statuses were read for it (the save's invalidation also re-reads the first tracker's,
    // which was still on screen when it fired).
    expect(state.statusReads).toBeGreaterThanOrEqual(2);
  });
});

describe('the wizard writes the default block for a tracker it binds (backlog 552)', () => {
  const openWizard = (state: World) => {
    window.history.pushState({}, '', '/onboarding');
    render(createApp({ fetchImpl: server(state), realtime: false }).element);
  };

  it('(a) sends the block, claim on, with the first bind of a tracker, and says so before', async () => {
    const state = world({ bindings: [] });
    openWizard(state);
    const user = userEvent.setup();
    await user.click(
      within(
        await waitFor(() => {
          const row = document.querySelector<HTMLElement>(`[data-integration-row="${TRACKER}"]`);
          expect(row).not.toBeNull();
          return row as HTMLElement;
        }),
      ).getByRole('checkbox'),
    );
    expect(document.querySelector('[data-lifecycle="wizard-default"]')?.textContent).toContain(
      'the claim on',
    );
    expect(state.puts).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Bind 1 integration' }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(trackerConfigOf(state.puts[0])).toEqual({
      lifecycle: { claim: true, take_assigned_tickets: false },
    });
  });

  it('(b) keeps a stored block as it is: a claim switched off stays off', async () => {
    const state = world({ bindings: bindingsWith({ lifecycle: { claim: false } }) });
    openWizard(state);
    const user = userEvent.setup();
    await user.click(
      within(
        await waitFor(() => {
          const row = document.querySelector<HTMLElement>(`[data-integration-row="${TRACKER}"]`);
          expect(row).not.toBeNull();
          return row as HTMLElement;
        }),
      ).getByRole('checkbox'),
    );
    expect(document.querySelector('[data-lifecycle="wizard-default"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Bind 1 integration' }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(trackerConfigOf(state.puts[0])).toEqual({ lifecycle: { claim: false } });
  });

  it('(c) adds nothing on the settings page’s re-save of a binding with no block', async () => {
    const state = world();
    renderSettings(state);
    await lifecycleCard();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save bindings' }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(trackerConfigOf(state.puts[0])).toEqual({});
  });
});

describe('status_mapping superseded (WP-181’s flag, TD-029 decision 3)', () => {
  it('warns on the lifecycle card and beside the key on the pipeline screen, only when superseded', async () => {
    const state = world({ superseded: true });
    renderSettings(state);
    await lifecycleCard();
    await waitFor(() =>
      expect(document.querySelector('[data-lifecycle="status-mapping-superseded"]')).not.toBeNull(),
    );
    cleanup();
    window.history.pushState({}, '', `/projects/${PROJECT_ROW.key}/pipeline`);
    render(createApp({ fetchImpl: server(state), realtime: false }).element);
    expect(
      await screen.findByText('not applied — the ticket lifecycle maps the statuses'),
    ).toBeTruthy();
    expect(document.querySelector('[data-status-mapping="superseded"]')).not.toBeNull();
  });

  it('says nothing of the kind when status_mapping applies', async () => {
    const state = world({ superseded: false });
    window.history.pushState({}, '', `/projects/${PROJECT_ROW.key}/pipeline`);
    render(createApp({ fetchImpl: server(state), realtime: false }).element);
    expect(await screen.findByText('status_mapping.implementation')).toBeTruthy();
    expect(screen.queryByText(/the ticket lifecycle maps the statuses/)).toBeNull();
    expect(document.querySelector('[data-status-mapping]')).toBeNull();
  });
});

describe('the lifecycle helpers', () => {
  it('matches stored names case-insensitively onto the loaded spelling', () => {
    const { draft, dropped } = lifecycleDraftOf(
      { pickup_status: ' sent back ', lifecycle: { in_progress: 'DOING', returned: ['testing'] } },
      STATUSES,
    );
    expect(draft.names.pick_up_from).toBe('Sent back');
    expect(draft.names.in_progress).toBe('Doing');
    expect(draft.returned).toEqual(['Testing']);
    expect(dropped).toEqual([]);
    // No block: the claim switch shows what saving one puts in force.
    expect(lifecycleDraftOf({}, STATUSES).draft.claim).toBe(true);
  });

  it('keeps the rest of the overlay and drops only the two keys it owns', () => {
    const { draft } = lifecycleDraftOf({}, STATUSES);
    expect(lifecycleOverlayOf({ poll_enabled: true, pickup_status: 'Doing' }, draft, null)).toEqual(
      { poll_enabled: true, lifecycle: { claim: true, take_assigned_tickets: false } },
    );
  });

  it('maps each 422 detail path onto its slot', () => {
    expect(slotOfDetailPath('pickup_status')).toBe('pick_up_from');
    expect(slotOfDetailPath('lifecycle.qa')).toBe('qa');
    expect(slotOfDetailPath('lifecycle.returned[3]')).toBe('returned');
    expect(slotOfDetailPath('lifecycle.claim')).toBeNull();
    expect(slotOfDetailPath('project_keys')).toBeNull();
  });
});

describe('the readiness notes of the lifecycle (WP-182 ruling (b))', () => {
  const notices: ReadinessResponse['notices'] = [
    {
      code: 'lifecycle_slot_unmapped',
      severity: 'note',
      message: 'the qa slot is not mapped, so no human QA stage runs',
    },
    {
      code: 'lifecycle_slot_unmapped',
      severity: 'note',
      message: 'the done slot is not mapped, so a merge moves no ticket',
    },
  ];

  it('renders every unmapped slot as a note, never as a failure', () => {
    render(<ReadinessNotices notices={notices} />);
    const list = screen.getByRole('list', { name: 'Readiness notices' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getAllByText('Note')).toHaveLength(2);
    expect(within(list).queryByText('Warning')).toBeNull();
    expect(within(list).queryByRole('alert')).toBeNull();
  });
});
