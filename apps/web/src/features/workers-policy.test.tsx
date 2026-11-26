/**
 * **What this machine takes, on the Workers screen** (S-26.8a, the M26 UX spec § 1), driven through
 * `createApp` with a fake server so the real router, query client and endpoint parsers are in the
 * path: per role (the owner changes it, an administrator reads somebody else's with their name, a
 * member is offered nothing on somebody else's), the save's request and its refusals in words, the
 * muted *Skipped …* line, and the consequence line — its evidence, the owner's
 * `GET /api/workers/:id/claim-scope` (BD-035), one read per owned machine, and the line said only
 * where it is known to be true. Since BD-035 the owner's card offers what that read lists, so a
 * project the person does not see is still theirs to choose (S-30.1 acceptance 4).
 */
import type {
  ProjectSummary,
  UserRole,
  WorkerClaimPolicy,
  WorkerSummary,
} from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { MACHINE_TAKES_WORDS } from '../ui/humanize.js';
import { WORKERS_POLICY_WORDS } from '../ui/words/workers-policy.js';
import { USER_ID, workerFixture } from './worker.test-fixture.js';
import { claimPolicySaveRefusal, storedClaimPolicyOf } from './workers.js';

const OTHER_USER = '00000000-0000-4000-8000-0000000000f1';
const AUTIX = '00000000-0000-4000-8000-0000000000e1';
const FONTAI = '00000000-0000-4000-8000-0000000000e2';
const MINE = '00000000-0000-4000-8000-000000000a01';
const THEIRS = '00000000-0000-4000-8000-000000000a02';

const session = (role: UserRole): SessionResponse => ({
  user: { id: USER_ID, email: 'jan@example.invalid', name: 'Jan', role },
  session: { id: '00000000-0000-4000-8000-000000000002' },
});

const project = (id: string, key: string, name: string): ProjectSummary => ({
  id,
  key,
  name,
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
});

// Keys are `slugSchema` (lower_snake_case): an upper-case key fails the projects read's parse, which
// is retried and stays pending (CI on #109, where every row then stayed on Loading).
const PROJECTS = [project(AUTIX, 'autix_key', 'Autix'), project(FONTAI, 'fontai_key', 'Fontai')];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World {
  role: UserRole;
  workers: WorkerSummary[];
  /** Per project id: the claim-scope read's `unassigned_has_taker`; `undefined` leaves it out. */
  othersTake: Record<string, boolean | undefined>;
  /** Projects `GET /api/projects` leaves out (BD-035): the claim-scope read still lists them. */
  hidden: string[];
  /** What the claim-policy PUT answers; by default it stores the body and answers 200. */
  refuse: { status: number; code: string } | null;
  puts: {
    url: string;
    body: { claim_policy: WorkerClaimPolicy; claim_project_ids: string[] | null };
  }[];
  /** Every claim-scope read, by the machine it was asked for. */
  scopeReads: string[];
  /** The claim-scope read answers this status instead (the card falls back, the line unknown). */
  scopeFails: number | null;
  /** `GET /api/projects` and the claim-scope read answer once this settles (names arrive late). */
  projectsGate: Promise<void> | null;
}

const world = (overrides: Partial<World> = {}): World => ({
  role: 'member',
  workers: [workerFixture({ id: MINE, claim_policy: 'mine_and_unassigned' })],
  othersTake: { [AUTIX]: false, [FONTAI]: true },
  hidden: [],
  refuse: null,
  puts: [],
  scopeReads: [],
  scopeFails: null,
  projectsGate: null,
  ...overrides,
});

const server = (state: World): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/auth/get-session')) return json(session(state.role));
    const policy = /\/api\/workers\/([^/]+)\/claim-policy$/.exec(url);
    if (policy !== null && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as World['puts'][number]['body'];
      state.puts.push({ url, body });
      if (state.refuse !== null) {
        return json(
          { error: { code: state.refuse.code, message: `refused ${policy[1]} with ids` } },
          state.refuse.status,
        );
      }
      // Stored, so the list read again says the new setting.
      state.workers = state.workers.map((item) =>
        item.id === policy[1]
          ? {
              ...item,
              claim_policy: body.claim_policy,
              claim_projects:
                body.claim_project_ids?.map((id) => ({
                  id,
                  key: PROJECTS.find((entry) => entry.id === id)?.key ?? null,
                })) ?? null,
            }
          : item,
      );
      return json({
        worker_id: policy[1],
        claim_policy: body.claim_policy,
        claim_project_ids: body.claim_project_ids,
        performed: true,
      });
    }
    if (url.endsWith('/api/workers')) {
      return json({
        items: state.workers,
        scope: state.role === 'admin' ? 'all' : 'own',
        timezone: 'UTC',
      });
    }
    const scope = /\/api\/workers\/([^/]+)\/claim-scope$/.exec(url);
    if (scope !== null && method === 'GET') {
      const workerId = scope[1] ?? '';
      state.scopeReads.push(workerId);
      if (state.projectsGate !== null) await state.projectsGate;
      if (state.scopeFails !== null) {
        return json({ error: { code: 'not_found', message: 'no such worker' } }, state.scopeFails);
      }
      const stored = state.workers.find((item) => item.id === workerId);
      return json({
        worker_id: workerId,
        claim_policy: stored?.claim_policy ?? 'everything',
        claim_project_ids: stored?.claim_projects?.map((entry) => entry.id) ?? null,
        // Every project the owner may run in — the hidden ones included (BD-035).
        projects: PROJECTS.map((entry) => ({
          id: entry.id,
          key: entry.key,
          name: entry.name,
          execution: { mode: 'hybrid', notice: null },
        })),
        unassigned_has_taker: Object.fromEntries(
          Object.entries(state.othersTake).filter(([, value]) => value !== undefined),
        ),
      });
    }
    if (url.endsWith('/api/projects')) {
      if (state.projectsGate !== null) await state.projectsGate;
      return json({
        items: PROJECTS.filter((entry) => !state.hidden.includes(entry.id)),
        can_create: false,
      });
    }
    if (url.endsWith('/api/version')) {
      return json({ version: '0.0.0-dev', commit: null, built_at: null });
    }
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

const renderWorkers = (state: World) => {
  window.history.pushState({}, '', '/workers');
  return render(createApp({ fetchImpl: server(state), realtime: false }).element);
};

/**
 * A row's *What this machine takes*, once its sentence is on screen. Both lookups are asserted
 * non-null: an optional chain over a missing row is `undefined`, which `not.toBeNull()` admits.
 */
const policyOf = async (workerId: string): Promise<HTMLElement> =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      `[data-worker="${workerId}"] [data-worker-policy]`,
    );
    expect(found).not.toBeNull();
    expect(found?.querySelector('[data-claim-policy-sentence]') ?? null).not.toBeNull();
    return found as HTMLElement;
  });

const sentenceIn = (element: HTMLElement): string =>
  element.querySelector('[data-claim-policy-sentence]')?.textContent ?? '';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('what this machine takes, per role (S-26.8a)', () => {
  it('lets the machine’s owner change it: the request, Saved, and the sentence from the stored answer', async () => {
    const state = world();
    renderWorkers(state);
    const card = await policyOf(MINE);
    expect(sentenceIn(card)).toBe(
      'This machine takes your tasks and unassigned ones, in all your projects.',
    );
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.change }));
    await user.click(within(card).getByRole('radio', { name: 'Only my tasks' }));
    await user.click(within(card).getByRole('radio', { name: 'Only these:' }));
    await user.click(within(card).getByRole('checkbox', { name: 'Fontai' }));
    await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.save }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(state.puts[0]?.url).toContain(`/api/workers/${MINE}/claim-policy`);
    expect(state.puts[0]?.body).toEqual({ claim_policy: 'mine', claim_project_ids: [FONTAI] });
    expect(await within(card).findByText(MACHINE_TAKES_WORDS.saved)).toBeTruthy();
    await waitFor(() => {
      expect(sentenceIn(card)).toBe('This machine takes only your tasks, in Fontai.');
    });
  });

  it('shows an administrator somebody else’s machine read only, with its owner’s name', async () => {
    const state = world({
      role: 'admin',
      workers: [
        workerFixture({
          id: THEIRS,
          name: 'vojta-mbp',
          user: { id: OTHER_USER, email: 'vojtech@example.invalid', name: 'Vojtěch' },
          claim_policy: 'mine',
        }),
        workerFixture({
          id: '00000000-0000-4000-8000-000000000a03',
          name: 'eva-mbp',
          user: {
            id: '00000000-0000-4000-8000-0000000000f2',
            email: 'eva@example.invalid',
            name: null,
          },
          claim_policy: 'mine_and_unassigned',
          claim_projects: [{ id: AUTIX, key: 'autix_key' }],
        }),
      ],
    });
    renderWorkers(state);
    const card = await policyOf(THEIRS);
    expect(sentenceIn(card)).toBe(
      'This machine takes only Vojtěch’s tasks, in all their projects.',
    );
    expect(within(card).queryByRole('button', { name: MACHINE_TAKES_WORDS.change })).toBeNull();
    // A person with no name is named by their address.
    expect(sentenceIn(await policyOf('00000000-0000-4000-8000-000000000a03'))).toBe(
      'This machine takes eva@example.invalid’s tasks and unassigned ones, in Autix.',
    );
    // Read only: nothing asks what somebody else's machine may offer, and nothing is written.
    expect(state.scopeReads).toEqual([]);
    expect(state.puts).toEqual([]);
  });

  it('offers a member no Change on somebody else’s machine, and Change on their own', async () => {
    const state = world({
      workers: [
        workerFixture({ id: MINE, claim_policy: 'everything' }),
        workerFixture({
          id: THEIRS,
          name: 'vojta-mbp',
          user: { id: OTHER_USER, email: 'vojtech@example.invalid', name: 'Vojtěch' },
          claim_policy: 'pick_only',
        }),
      ],
    });
    renderWorkers(state);
    const theirs = await policyOf(THEIRS);
    expect(within(theirs).queryByRole('button', { name: MACHINE_TAKES_WORDS.change })).toBeNull();
    expect(sentenceIn(theirs)).toBe(
      'This machine takes nothing by itself. Vojtěch picks runs on its page.',
    );
    const mine = await policyOf(MINE);
    expect(within(mine).getByRole('button', { name: MACHINE_TAKES_WORDS.change })).toBeTruthy();
  });
});

describe('before the project names are known (CI on #109)', () => {
  it('says Loading, never a project’s key, until the projects read answers', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = world({
      role: 'admin',
      projectsGate: gate,
      workers: [
        workerFixture({ id: MINE, claim_policy: 'mine' }),
        workerFixture({
          id: THEIRS,
          name: 'vojta-mbp',
          user: { id: OTHER_USER, email: 'vojtech@example.invalid', name: 'Vojtěch' },
          claim_policy: 'mine',
          claim_projects: [{ id: AUTIX, key: 'autix_key' }],
        }),
      ],
    });
    renderWorkers(state);
    const loading = await waitFor(() => {
      const found = document.querySelectorAll(`[data-worker-policy-loading]`);
      expect(found).toHaveLength(2);
      return found;
    });
    for (const row of loading) {
      expect(row.textContent).toBe(WORKERS_POLICY_WORDS.loading);
    }
    // No sentence to take back, no Change that would offer no project and ask nothing.
    expect(document.querySelector('[data-claim-policy-sentence]')).toBeNull();
    expect(document.body.textContent).not.toContain('in autix_key');
    expect(screen.queryByRole('button', { name: MACHINE_TAKES_WORDS.change })).toBeNull();
    release();
    expect(sentenceIn(await policyOf(THEIRS))).toBe(
      'This machine takes only Vojtěch’s tasks, in Autix.',
    );
    expect(document.querySelector('[data-worker-policy-loading]')).toBeNull();
    // The administrator's own machine asked what it may offer; somebody else's asked nothing.
    expect(new Set(state.scopeReads)).toEqual(new Set([MINE]));
  });
});

describe('a refused save, in words (S-26.8a)', () => {
  it.each([
    { status: 422, code: 'claim_scope_empty', words: WORKERS_POLICY_WORDS.refusedEmpty },
    { status: 403, code: 'claim_policy_owner_only', words: MACHINE_TAKES_WORDS.refusedOwner },
    { status: 404, code: 'not_found', words: MACHINE_TAKES_WORDS.refusedGone },
    { status: 422, code: 'project_not_eligible', words: MACHINE_TAKES_WORDS.refusedProject },
    { status: 500, code: 'internal', words: WORKERS_POLICY_WORDS.refusedOther },
  ])(
    'says $status $code as its words, never the server’s text',
    async ({ status, code, words }) => {
      const state = world({ refuse: { status, code } });
      renderWorkers(state);
      const card = await policyOf(MINE);
      const user = userEvent.setup();
      await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.change }));
      await user.click(within(card).getByRole('radio', { name: 'Everything' }));
      await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.save }));
      expect(await within(card).findByText(words)).toBeTruthy();
      expect(card.textContent).not.toContain('refused');
      expect(within(card).queryByText(MACHINE_TAKES_WORDS.saved)).toBeNull();
      // The stored setting is still what the sentence says.
      expect(sentenceIn(card)).toBe(
        'This machine takes your tasks and unassigned ones, in all your projects.',
      );
    },
  );

  it('maps every refusal without reading the error’s message', () => {
    const error = (status: number, code: string) =>
      Object.assign(new Error('the list names 1 project(s): 00000000-…'), { status, code });
    expect(claimPolicySaveRefusal(new Error('boom'))).toBe(WORKERS_POLICY_WORDS.refusedOther);
    expect(claimPolicySaveRefusal(error(403, 'claim_policy_owner_only'))).toBe(
      MACHINE_TAKES_WORDS.refusedOwner,
    );
  });
});

describe('the runs a policy leaves for others (S-26.8a)', () => {
  it.each([
    { skipped: 3, line: 'Skipped 3 runs this machine doesn’t take' },
    { skipped: 1, line: 'Skipped 1 run this machine doesn’t take' },
    { skipped: 0, line: null },
    { skipped: null, line: null },
    { skipped: undefined, line: null },
  ])('says $skipped as a muted line only above zero', async ({ skipped, line }) => {
    const state = world({
      workers: [
        workerFixture({
          id: MINE,
          claim_policy: 'mine',
          ...(skipped === undefined ? {} : { policy_skipped_offers: skipped }),
        }),
      ],
    });
    renderWorkers(state);
    const card = await policyOf(MINE);
    expect(card.querySelector('[data-policy-skipped]')?.textContent ?? null).toBe(line);
  });
});

describe('the consequence line on the Workers screen (S-26.8a)', () => {
  /** Opens *Change* on a row and chooses *Only my tasks*. */
  const chooseOnlyMine = async (card: HTMLElement): Promise<void> => {
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.change }));
    await user.click(within(card).getByRole('radio', { name: 'Only my tasks' }));
  };

  it('reads what this machine may offer once, and names the one nobody else takes', async () => {
    const state = world();
    renderWorkers(state);
    const card = await policyOf(MINE);
    // One read, for this machine, so the owner's other machines still count.
    expect(state.scopeReads).toEqual([MINE]);
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.change }));
    // The default policy says nothing; *Only my tasks* names Autix (false), not Fontai (true).
    expect(card.textContent).not.toContain('nowhere to run');
    await user.click(within(card).getByRole('radio', { name: 'Only my tasks' }));
    expect(
      await within(card).findByText('Unassigned tasks in Autix have nowhere to run.'),
    ).toBeTruthy();
    // Closing and opening again asks nothing more: the answer is cached per machine.
    await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.cancel }));
    await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.change }));
    expect(state.scopeReads).toEqual([MINE]);
  });

  it('says nothing for a project somebody else takes, beside one nobody takes', async () => {
    // Fontai's `false` is the control: once its line shows, Autix's `true` has been read too.
    const state = world({ othersTake: { [AUTIX]: true, [FONTAI]: false } });
    renderWorkers(state);
    const card = await policyOf(MINE);
    await chooseOnlyMine(card);
    expect(
      await within(card).findByText('Unassigned tasks in Fontai have nowhere to run.'),
    ).toBeTruthy();
    expect(card.textContent).not.toContain('Autix have');
    expect(card.textContent).not.toContain('Autix and Fontai');
  });

  it.each([404, 500])(
    'offers the projects the person sees when the read answers %s, says nothing, and does not ask again',
    async (status) => {
      const state = world({
        othersTake: { [AUTIX]: false, [FONTAI]: false },
        scopeFails: status,
      });
      renderWorkers(state);
      const card = await policyOf(MINE);
      await chooseOnlyMine(card);
      // The fallback still offers both projects by name …
      expect(within(card).getByRole('radio', { name: 'Only these:' })).toBeTruthy();
      // … and nothing is known of other takers, so the line says nothing.
      expect(card.textContent).not.toContain('nowhere to run');
      expect(state.scopeReads).toEqual([MINE]);
    },
  );

  it('says nothing for a project the answer does not name', async () => {
    const state = world({ othersTake: { [AUTIX]: undefined, [FONTAI]: false } });
    renderWorkers(state);
    const card = await policyOf(MINE);
    await chooseOnlyMine(card);
    expect(
      await within(card).findByText('Unassigned tasks in Fontai have nowhere to run.'),
    ).toBeTruthy();
    expect(card.textContent).not.toContain('Autix');
  });

  it('asks nothing for a read-only card, even for a stored Only my tasks', async () => {
    const state = world({
      role: 'admin',
      workers: [
        workerFixture({
          id: THEIRS,
          name: 'vojta-mbp',
          user: { id: OTHER_USER, email: 'vojtech@example.invalid', name: 'Vojtěch' },
          claim_policy: 'mine',
        }),
      ],
    });
    renderWorkers(state);
    await policyOf(THEIRS);
    expect(screen.queryByText(/nowhere to run/)).toBeNull();
    expect(state.scopeReads).toEqual([]);
  });
});

describe('choosing is not seeing (BD-035, S-30.1)', () => {
  it('widens a machine from [Autix] to [Autix, Fontai] although Fontai is not a project the person sees', async () => {
    const state = world({
      hidden: [FONTAI],
      workers: [
        workerFixture({
          id: MINE,
          claim_policy: 'mine',
          claim_projects: [{ id: AUTIX, key: 'autix_key' }],
        }),
      ],
    });
    renderWorkers(state);
    const card = await policyOf(MINE);
    expect(sentenceIn(card)).toBe('This machine takes only your tasks, in Autix.');
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.change }));
    const fontai = within(card).getByRole('checkbox', { name: 'Fontai' }) as HTMLInputElement;
    expect(fontai.checked).toBe(false);
    await user.click(fontai);
    await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.save }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(state.puts[0]?.body.claim_policy).toBe('mine');
    expect([...(state.puts[0]?.body.claim_project_ids ?? [])].sort()).toEqual([AUTIX, FONTAI]);
  });
});

describe('the stored setting a row reads', () => {
  it('reads a missing policy as the server does, and a legacy [] scope as every project', () => {
    expect(storedClaimPolicyOf(workerFixture())).toEqual({
      policy: 'everything',
      projectIds: null,
    });
    expect(storedClaimPolicyOf(workerFixture({ claim_projects: [] }))).toEqual({
      policy: 'pick_only',
      projectIds: null,
    });
    expect(
      storedClaimPolicyOf(
        workerFixture({ claim_policy: 'mine', claim_projects: [{ id: AUTIX, key: 'autix_key' }] }),
      ),
    ).toEqual({ policy: 'mine', projectIds: [AUTIX] });
  });
});
