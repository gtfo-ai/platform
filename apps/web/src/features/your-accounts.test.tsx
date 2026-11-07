/**
 * *Settings → Your accounts* (S-26.8a over S-26.6's routes; the M26 UX spec § 5).
 *
 * Driven through `createApp` with a fake server, so the real router, the lazy section, the query
 * client and the endpoint parsers are what is asserted: the page issues a code and shows it once,
 * asks the code's state again while it is live and shows the match the provider proved, links only
 * on the person's *Link this account* (with an `Idempotency-Key`), says what follows — the tasks the
 * link made theirs — and says why a code stopped (voided, expired) or was refused (429). The person
 * unlinks their own account behind a confirmation. No field asks for an account id, and every
 * provider string is text (BD-022).
 */
import type {
  IdentityLinkMatch,
  IdentityLinkState,
  MyIdentity,
  UserRole,
} from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http.js';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { primaryLabels } from '../ui/primary-census.js';
import { linkRefusal, viewOf } from './your-accounts.js';

const USER = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const CODE_ID = '00000000-0000-4000-8000-0000000000c1';
const MATCH_ID = '00000000-0000-4000-8000-0000000000e1';
const INTEGRATION = '00000000-0000-4000-8000-0000000000f1';
const ACCOUNT = '5b10ac8d82e05b22cc7d4ef5';

const session = (role: UserRole): SessionResponse => ({
  user: { id: USER, email: 'jan@example.invalid', name: 'Jan', role },
  session: { id: '00000000-0000-4000-8000-000000000002' },
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, code: string, details?: unknown): Response =>
  json({ error: { code, message: `the fake server refused: ${code}`, details } }, status);

/** Far enough ahead that no test sees the code expire on its own. */
const LATER = '2099-01-01T10:30:00.000Z';

const MATCH: IdentityLinkMatch = {
  id: MATCH_ID,
  provider: 'jira-cloud',
  external_id: ACCOUNT,
  display_name: 'Jan <b>Novák</b>',
  integration_id: INTEGRATION,
  integration_name: 'Jira <i>cloud</i>',
  matched_at: '2026-11-07T10:05:00.000Z',
  confirmed_at: null,
};

type LinkCode = NonNullable<IdentityLinkState['code']>;

const LIVE_CODE: LinkCode = {
  id: CODE_ID,
  created_at: '2026-11-07T10:00:00.000Z',
  expires_at: LATER,
  status: 'live',
  void_reason: null,
};

const liveState = (matches: IdentityLinkMatch[] = []): IdentityLinkState => ({
  code: LIVE_CODE,
  matches,
});

interface World {
  role: UserRole;
  /** What `GET /api/me/identity-links` answers now. */
  state: IdentityLinkState;
  /** What `POST /api/me/identity-links` answers. */
  issue: () => Response;
  confirm: () => Response;
  read: () => Response;
  mine: MyIdentity[];
  requests: { method: string; path: string; body: unknown; key: string | null }[];
}

let world: World;

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const path = new URL(url, 'http://localhost').pathname;
  const method = init?.method ?? 'GET';
  if (url.includes('/api/auth/get-session')) return json(session(world.role));
  if (path.startsWith('/api/me/') || (path.startsWith('/api/org/identities') && method !== 'GET')) {
    world.requests.push({
      method,
      path,
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      key: new Headers(init?.headers).get('idempotency-key'),
    });
  }
  if (path === '/api/me/identity-links' && method === 'POST') {
    const answer = world.issue();
    if (answer.ok) {
      world.state = liveState();
    }
    return answer;
  }
  if (path === '/api/me/identity-links') return json(world.state);
  if (path === '/api/me/identity-links/read' && method === 'POST') return world.read();
  if (path === `/api/me/identity-links/matches/${MATCH_ID}/confirm` && method === 'POST') {
    return world.confirm();
  }
  if (path === '/api/me/identities') return json({ items: world.mine });
  const mine = /^\/api\/me\/identities\/([^/]+)\/([^/]+)$/.exec(path);
  if (mine !== null && method === 'DELETE') {
    const provider = decodeURIComponent(mine[1] ?? '');
    const externalId = decodeURIComponent(mine[2] ?? '');
    world.mine = world.mine.filter(
      (row) => !(row.provider === provider && row.external_id === externalId),
    );
    return json({ provider, external_id: externalId });
  }
  if (path === '/api/projects') {
    return json({
      items: [
        {
          id: PROJECT,
          key: 'autix',
          name: 'Autix',
          repo_url: 'https://git.example.test/acme/autix.git',
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
        },
      ],
    });
  }
  if (path === '/api/version') return json({ version: '0.0.0-dev', commit: null, built_at: null });
  if (path === '/api/org/identities' || path === '/api/org/identities/candidates') {
    return json({ items: [] });
  }
  if (path === '/api/org/users' || path === '/api/integrations') return json({ items: [] });
  return problem(404, 'not_found');
}) as typeof fetch;

const ISSUED = {
  id: CODE_ID,
  code: 'agentic-link-7K3Q9VDM2X',
  expires_at: LATER,
};

const CONFIRMED = {
  provider: 'jira-cloud',
  external_id: ACCOUNT,
  display_name: 'Jan <b>Novák</b>',
  user_id: USER,
  performed: true,
  adopted_task_ids: [
    '00000000-0000-4000-8000-0000000000d1',
    '00000000-0000-4000-8000-0000000000d2',
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  world = {
    role: 'member',
    state: { code: null, matches: [] },
    issue: () => json(ISSUED, 201),
    confirm: () => json(CONFIRMED),
    read: () => {
      // The read records the match, so the next poll of the state carries it too.
      world.state = liveState([MATCH]);
      return json({ comments: 3, carried_code: 1, matched: 1, state: world.state });
    },
    mine: [],
    requests: [],
  };
});

const open = (path = '/settings/accounts'): void => {
  window.history.pushState({}, '', path);
  render(createApp({ fetchImpl, realtime: false }).element);
};

/** The section has drawn (it is a lazy chunk), with its link flow's card. */
const flow = async (): Promise<void> => {
  await screen.findByRole('heading', { name: 'Your accounts' });
  await screen.findByText('Link an account', { selector: 'div' });
};

describe('Your accounts: who sees it', () => {
  it.each([
    ['member', false],
    ['viewer', false],
    ['admin', true],
  ] as const)(
    'a %s sees Your accounts in the Personal group; Linked accounts only an admin',
    async (role, admin) => {
      world.role = role;
      open();
      const nav = await screen.findByRole('navigation', { name: 'Settings' });
      expect(
        within(nav).getByRole('link', { name: 'Your accounts' }).getAttribute('aria-current'),
      ).toBe('page');
      expect(within(nav).queryByRole('link', { name: 'Linked accounts' }) !== null).toBe(admin);
      expect(await screen.findByRole('heading', { name: 'Your accounts' })).toBeTruthy();
      expect(window.location.pathname).toBe('/settings/accounts');
    },
  );
});

describe('Your accounts: link an account', () => {
  it('issues a code, shows it once with its expiry, polls for the match, and links only on confirm', async () => {
    const user = userEvent.setup();
    open();
    await flow();
    expect(await screen.findByText('No account is linked to you yet')).toBeTruthy();
    // Idle: the one primary is the start.
    await waitFor(() => {
      expect(primaryLabels()).toEqual(['Link an account']);
    });
    await user.click(screen.getByRole('button', { name: 'Link an account' }));

    const code = (await screen.findByLabelText('Your link code')) as HTMLInputElement;
    expect(code.value).toBe('agentic-link-7K3Q9VDM2X');
    expect(document.body.textContent).toContain('Valid until');
    expect(document.body.textContent).toContain(
      'Write this code as a comment on any ticket of a project you are in (Jira), from your own account.',
    );
    expect(
      await screen.findByText('Waiting for your comment… This page updates by itself.'),
    ).toBeTruthy();
    // Waiting for a comment is not a thing to press here.
    expect(primaryLabels()).toEqual([]);

    // The provider proves a comment: the next read of the live code carries the match.
    world.state = liveState([MATCH]);
    const question = await screen.findByRole(
      'heading',
      { name: 'Link Jira account Jan <b>Novák</b>?' },
      { timeout: 6_000 },
    );
    const match = question.closest('[data-link-match]') as HTMLElement;
    // The provider and the account id beside the untrusted name, all of it as text.
    expect(match.textContent).toContain(ACCOUNT);
    expect(match.textContent).toContain('Jira <i>cloud</i>');
    expect(match.querySelector('b, i')).toBeNull();
    expect(primaryLabels()).toEqual(['Link this account']);
    // Nothing was confirmed by showing it.
    expect(world.requests.filter((request) => request.path.endsWith('/confirm'))).toEqual([]);

    world.mine = [
      {
        provider: 'jira-cloud',
        external_id: ACCOUNT,
        display_name: 'Jan <b>Novák</b>',
        created_at: '2026-11-07T10:06:00.000Z',
      },
    ];
    world.state = {
      ...liveState([{ ...MATCH, confirmed_at: '2026-11-07T10:06:00.000Z' }]),
      code: { ...LIVE_CODE, status: 'consumed' },
    };
    await user.click(within(match).getByRole('button', { name: 'Link this account' }));

    expect(await screen.findByText('You now own 2 tasks assigned to you in Jira.')).toBeTruthy();
    expect(document.body.textContent).toContain('Linked: Jira account Jan <b>Novák</b>.');
    expect(document.body.textContent).toContain('You can delete the comment with the code now.');
    expect(document.body.textContent).toContain(
      'Questions you answer and plans you approve from this account in Jira now count as yours.',
    );
    const confirms = world.requests.filter((request) => request.path.endsWith('/confirm'));
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.key).toMatch(/.+/);
    // The list reads the new link.
    const list = await screen.findByRole('list', { name: 'Your linked accounts' });
    expect(list.textContent).toContain(ACCOUNT);
  }, 15_000);

  it('reads a named ticket on “I wrote it on …” and shows the match it answered', async () => {
    const user = userEvent.setup();
    world.state = liveState();
    open();
    await flow();
    // A reload: the code is live but was shown only once.
    expect(
      await screen.findByText(/It was shown only once: if you no longer have it/),
    ).toBeTruthy();
    await user.click(screen.getByText('I wrote it on …', { selector: 'summary' }));
    await user.selectOptions(screen.getByLabelText('Project'), PROJECT);
    await user.type(screen.getByLabelText('Ticket key'), 'AUT-6639');
    await user.click(screen.getByRole('button', { name: 'Read the comments' }));
    expect(await screen.findByText('Read 3 comments; 1 carries your code.')).toBeTruthy();
    expect(
      await screen.findByRole('heading', { name: 'Link Jira account Jan <b>Novák</b>?' }),
    ).toBeTruthy();
    expect(world.requests.filter((request) => request.path.endsWith('/read'))).toEqual([
      {
        method: 'POST',
        path: '/api/me/identity-links/read',
        body: { project_id: PROJECT, ticket_key: 'AUT-6639' },
        key: null,
      },
    ]);
    // One beacon: the match's Link, not the new-code button beside it.
    expect(primaryLabels()).toEqual(['Link this account']);
  });

  it('sends a merge request number on “I wrote it on …”, and says a refusal in words', async () => {
    const user = userEvent.setup();
    world.state = liveState();
    world.read = () => problem(403, 'identity_link_read_not_permitted');
    open();
    await flow();
    await user.click(await screen.findByText('I wrote it on …', { selector: 'summary' }));
    await user.selectOptions(screen.getByLabelText('Project'), PROJECT);
    await user.click(screen.getByLabelText('A merge request'));
    await user.type(screen.getByLabelText('Merge request number'), '!42');
    await user.click(screen.getByRole('button', { name: 'Read the comments' }));
    expect(
      await screen.findByText(
        'The platform reads a ticket for you only in a project where you are a member or above.',
      ),
    ).toBeTruthy();
    expect(world.requests.find((request) => request.path.endsWith('/read'))?.body).toEqual({
      project_id: PROJECT,
      merge_request_iid: 42,
    });
  });

  it('never offers a field for an account id or an email', async () => {
    world.state = liveState();
    open();
    await flow();
    await screen.findByText('I wrote it on …', { selector: 'summary' });
    expect(screen.queryByLabelText(/account id/i)).toBeNull();
    expect(screen.queryByLabelText(/e-?mail/i)).toBeNull();
  });
});

describe('Your accounts: a code that stopped, and refusals', () => {
  it('says that someone else used the code, and offers a new one', async () => {
    const user = userEvent.setup();
    world.state = {
      code: { ...LIVE_CODE, status: 'voided', void_reason: 'second_author' },
      matches: [MATCH, { ...MATCH, id: '00000000-0000-4000-8000-0000000000e2', external_id: 'x' }],
    };
    open();
    await flow();
    expect(
      await screen.findByText(
        'Someone else wrote this code too, so it links nobody. Get a new code and write it where fewer people can see it.',
      ),
    ).toBeTruthy();
    // A voided code's matches are not offered for confirmation.
    expect(screen.queryByRole('button', { name: 'Link this account' })).toBeNull();
    expect(primaryLabels()).toEqual(['Get a new code']);
    await user.click(screen.getByRole('button', { name: 'Get a new code' }));
    expect(((await screen.findByLabelText('Your link code')) as HTMLInputElement).value).toBe(
      'agentic-link-7K3Q9VDM2X',
    );
  });

  it('says when an expired code ran out, and offers a new one', async () => {
    world.state = {
      code: { ...LIVE_CODE, status: 'expired', expires_at: '2026-11-07T10:30:00.000Z' },
      matches: [],
    };
    open();
    await flow();
    expect(
      await screen.findByText(/This code expired at .* without linking an account\./),
    ).toBeTruthy();
    expect(primaryLabels()).toEqual(['Get a new code']);
  });

  it('says a 429 in words, not as a status line', async () => {
    const user = userEvent.setup();
    world.issue = () => problem(429, 'link_code_rate_limited');
    open();
    await flow();
    await user.click(await screen.findByRole('button', { name: 'Link an account' }));
    expect(
      await screen.findByText(
        'You have asked for five codes in the last hour. Use the newest one, or try again later.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Your link code')).toBeNull();
  });

  it('says a confirmation voided by a second author by its reason', async () => {
    const user = userEvent.setup();
    world.state = liveState([MATCH]);
    world.confirm = () =>
      problem(409, 'link_code_voided', [{ path: 'void_reason', message: 'second_author' }]);
    open();
    await flow();
    await user.click(await screen.findByRole('button', { name: 'Link this account' }));
    expect(await screen.findByText('The account was not linked.')).toBeTruthy();
    expect(document.body.textContent).toContain('Someone else wrote this code too');
  });
});

describe('Your accounts: unlink your own', () => {
  it('asks first, says what stops, then unlinks and re-reads the list', async () => {
    const user = userEvent.setup();
    world.mine = [
      {
        provider: 'jira-cloud',
        external_id: ACCOUNT,
        display_name: 'Jan <b>Novák</b>',
        created_at: '2026-11-07T10:06:00.000Z',
      },
    ];
    open();
    const list = await screen.findByRole('list', { name: 'Your linked accounts' });
    expect(list.textContent).toContain('Jan <b>Novák</b>');
    expect(list.querySelector('b')).toBeNull();
    await user.click(within(list).getByRole('button', { name: 'Unlink' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Unlink Jira account Jan <b>Novák</b>?',
    });
    expect(dialog.textContent).toContain(
      'Answers and approvals from this Jira account stop counting as yours.',
    );
    expect(world.requests.filter((request) => request.method === 'DELETE')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => {
      expect(world.requests.filter((request) => request.method === 'DELETE')).toEqual([
        {
          method: 'DELETE',
          path: `/api/me/identities/jira-cloud/${ACCOUNT}`,
          body: {},
          key: null,
        },
      ]);
    });
    expect(await screen.findByText('No account is linked to you yet')).toBeTruthy();
    expect(document.body.textContent).toContain('Unlinked.');
  });
});

describe('the page’s pure halves', () => {
  it('reads a code issued here as live before the state read catches up', () => {
    expect(viewOf({ code: null, matches: [] }, ISSUED, null).kind).toBe('live');
    expect(viewOf({ code: null, matches: [] }, null, null).kind).toBe('idle');
    expect(viewOf(liveState([{ ...MATCH, confirmed_at: LATER }]), ISSUED, null)).toMatchObject({
      kind: 'live',
      matches: [],
    });
  });

  it('says a voided refusal by its reason and an unknown code not at all', () => {
    expect(
      linkRefusal(
        new ApiError(409, 'link_code_voided', 'x', [
          { path: 'void_reason', message: 'identity_linked_elsewhere' },
        ]),
      ),
    ).toContain('linked to another person');
    expect(linkRefusal(new ApiError(500, 'internal', 'x'))).toBeUndefined();
  });
});
