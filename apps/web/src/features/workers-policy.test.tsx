/**
 * **What this machine takes, on the Workers screen** (S-26.8a, the M26 UX spec § 1), driven through
 * `createApp` with a fake server so the real router, query client and endpoint parsers are in the
 * path: per role (the owner changes it, an administrator reads somebody else's with their name, a
 * member is offered nothing on somebody else's), the save's request and its refusals in words, the
 * muted *Skipped …* line, and the consequence line — its evidence, one execution read per project
 * asked for this machine (`?worker_id=`), read only once *Change* opens the controls, and the line
 * said only where it is known to be true.
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
import { MACHINE_TAKES_WORDS, WORKERS_POLICY_WORDS } from '../ui/humanize.js';
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

const PROJECTS = [project(AUTIX, 'AUT', 'Autix'), project(FONTAI, 'FON', 'Fontai')];

/** `GET …/execution`, with `others_take_unassigned` only when the case knows it. */
const execution = (othersTakeUnassigned: boolean | undefined) => ({
  mode: 'hybrid',
  prefer: 'server',
  fallback_after_seconds: null,
  assignee_window_seconds: 120,
  offer_timeout_seconds: 86_400,
  effective_fallback_after_seconds: 15,
  stored: false,
  server_claimant: 'none',
  notice: null,
  workers: [],
  waiting: {
    open: 0,
    closed_to_workers: { credential_refused: 0, server_only: 0, server_first: 0 },
  },
  ...(othersTakeUnassigned === undefined ? {} : { others_take_unassigned: othersTakeUnassigned }),
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World {
  role: UserRole;
  workers: WorkerSummary[];
  /** Per project id: what its execution read says of `others_take_unassigned`. */
  othersTake: Record<string, boolean | undefined>;
  /** What the claim-policy PUT answers; by default it stores the body and answers 200. */
  refuse: { status: number; code: string } | null;
  puts: {
    url: string;
    body: { claim_policy: WorkerClaimPolicy; claim_project_ids: string[] | null };
  }[];
  /** Every execution read, with the machine it was asked for (`?worker_id=`, `null` without). */
  executionReads: { project: string; workerId: string | null }[];
  /** Per project id: the execution read answers this status instead (its line must stay hidden). */
  executionFails: Record<string, number>;
}

const world = (overrides: Partial<World> = {}): World => ({
  role: 'member',
  workers: [workerFixture({ id: MINE, claim_policy: 'mine_and_unassigned' })],
  othersTake: { [AUTIX]: false, [FONTAI]: true },
  refuse: null,
  puts: [],
  executionReads: [],
  executionFails: {},
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
    const read = /\/api\/projects\/([^/?]+)\/execution(\?.*)?$/.exec(url);
    if (read !== null) {
      const workerId = new URLSearchParams(read[2] ?? '').get('worker_id');
      state.executionReads.push({ project: read[1] ?? '', workerId });
      const fails = state.executionFails[read[1] ?? ''];
      if (fails !== undefined) {
        return json({ error: { code: 'not_found', message: 'no such worker' } }, fails);
      }
      return json(execution(state.othersTake[read[1] ?? '']));
    }
    if (url.endsWith('/api/projects')) return json({ items: PROJECTS, can_create: false });
    if (url.endsWith('/api/version')) {
      return json({ version: '0.0.0-dev', commit: null, built_at: null });
    }
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

const renderWorkers = (state: World) => {
  window.history.pushState({}, '', '/workers');
  return render(createApp({ fetchImpl: server(state), realtime: false }).element);
};

/** A row's *What this machine takes*, once its sentence is on screen. */
const policyOf = async (workerId: string): Promise<HTMLElement> =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      `[data-worker="${workerId}"] [data-worker-policy]`,
    );
    expect(found?.querySelector('[data-claim-policy-sentence]')).not.toBeNull();
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
          claim_projects: [{ id: AUTIX, key: 'AUT' }],
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
    // Read only: nothing asks the projects' execution, and nothing is written.
    expect(state.executionReads).toEqual([]);
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

  it('asks nothing on load, then each project for this machine once Change opens, and names the one nobody else takes', async () => {
    const state = world();
    renderWorkers(state);
    const card = await policyOf(MINE);
    // The page's load asks no project anything.
    expect(state.executionReads).toEqual([]);
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.change }));
    await waitFor(() => expect(state.executionReads).toHaveLength(2));
    // Every read carries this machine, so the owner's other machines still count.
    expect([...state.executionReads].sort((a, b) => a.project.localeCompare(b.project))).toEqual([
      { project: AUTIX, workerId: MINE },
      { project: FONTAI, workerId: MINE },
    ]);
    // The default policy says nothing; *Only my tasks* names Autix (false), not Fontai (true).
    expect(card.textContent).not.toContain('nowhere to run');
    await user.click(within(card).getByRole('radio', { name: 'Only my tasks' }));
    expect(
      await within(card).findByText('Unassigned tasks in Autix have nowhere to run.'),
    ).toBeTruthy();
    // Closing and opening again asks nothing more: the answers are cached per (project, machine).
    await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.cancel }));
    await user.click(within(card).getByRole('button', { name: MACHINE_TAKES_WORDS.change }));
    expect(state.executionReads).toHaveLength(2);
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
    'says nothing for a project whose read answers %s, and does not ask it again',
    async (status) => {
      const state = world({
        othersTake: { [AUTIX]: false, [FONTAI]: false },
        executionFails: { [AUTIX]: status },
      });
      renderWorkers(state);
      const card = await policyOf(MINE);
      await chooseOnlyMine(card);
      // Fontai is known and named; Autix's refusal leaves it unknown, so it is not.
      expect(
        await within(card).findByText('Unassigned tasks in Fontai have nowhere to run.'),
      ).toBeTruthy();
      expect(card.textContent).not.toContain('Autix');
      expect(state.executionReads.filter((entry) => entry.project === AUTIX)).toHaveLength(1);
    },
  );

  it('says nothing for a project whose read carries no answer', async () => {
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
    expect(state.executionReads).toEqual([]);
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
        workerFixture({ claim_policy: 'mine', claim_projects: [{ id: AUTIX, key: 'AUT' }] }),
      ),
    ).toEqual({ policy: 'mine', projectIds: [AUTIX] });
  });
});
