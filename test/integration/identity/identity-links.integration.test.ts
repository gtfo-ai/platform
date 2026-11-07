/**
 * A person links their own account, proven by the provider — against a real PostgreSQL 18 (S-26.6,
 * TD-031's 2026-11-06 amendment item 9).
 *
 * Production code from the webhook door to the table: `createWebhookIngress` (verify, dedupe,
 * normalise, the `inbox` row and the matches in one transaction), the **Jira adapter's own
 * normaliser** over the fixtures in `test/fixtures/http/jira-cloud/webhook-comment-link-code*.json`
 * (signed by the replay harness, its `/myself` answered by the replay), the recorder and the
 * confirmation in `identity/identity-links.ts`, and `createPostgresIdentityLinkStore` with migration
 * 0105's locks and partial unique indexes. *I wrote it on …* is driven through the executor over the
 * fake task-management and git providers.
 *
 * One named case per actor of the threat model: **a JSM customer**, **a guest**, **a comment
 * editor** (*Edit All Comments*) and **the platform's own account** — each fails to link its
 * account to the code's owner.
 */
import { randomUUID } from 'node:crypto';
import {
  adoptOwnersOnLink,
  allowAnyIntegrationHost,
  createIdentityLinks,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  createWebhookIngress,
  eagerInboundLoader,
  exactSecretRedactor,
  type IdentityLinks,
  INITIAL_TASK_VERSION,
  type InboundNormaliser,
  noSecretsRedactor,
  type ResolvedInboundIntegration,
  readLinkThread,
  type StoredTask,
  staticPipelineIntegrations,
  type WebhookDelivery,
} from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { FEATURE_TEMPLATE, SHIPPED_TEMPLATES, UNOWNED } from '@platform/domain';
import {
  db,
  eventing as eventingAdapters,
  integrations as integrationAdapters,
  pipeline as pipelineAdapters,
} from '@platform/infrastructure';
import { createFakeGitProvider, createFakeTaskManagement } from '@platform/integrations';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listIdentityCandidates } from '../../../apps/server/src/queries/identity-queries.js';
import {
  createJiraBinding,
  JIRA_INTEGRATION_ID,
  type JiraBinding,
} from '../../contract/support/integrations/jira-cloud-harness.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

/** The code every fixture carries, and the one the issuing below draws. */
const CODE_SUFFIX = '7K3Q9VDM2X';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DEV_ONE = '557058:00000000-0000-4000-8000-00000000d0c1';
const PM_TWO = '557058:00000000-0000-4000-8000-00000000d0c2';
const BOT = '557058:00000000-0000-4000-8000-0000000b0701';
const CUSTOMER = 'qm:00000000-0000-4000-8000-00000000c0c1:00000000-0000-4000-8000-00000000c0c2';
const GUEST = '557058:00000000-0000-4000-8000-00000000d0c9';
const FAKE_TM_INTEGRATION = '00000000-0000-4000-8000-0000000000f1' as Id;
const FAKE_GIT_INTEGRATION = '00000000-0000-4000-8000-0000000000f2' as Id;

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let projectId: Id;
let alice: Id;
let bob: Id;

/**
 * The clock both the issuing and the recorder read, so a test can let a code expire. Each read is a
 * millisecond later than the last, so rows ordered by `created_at` are in the order they were made.
 */
let now = Date.now();
let tick = 0;
const clock = {
  now: () => {
    tick += 1;
    return new Date(now + tick).toISOString() as IsoDateTime;
  },
};
const ids = { next: () => randomUUID() as Id };
/** The next code `issue` draws; each byte's low five bits pick a character. */
let nextCode = CODE_SUFFIX;
const draw = (size: number): Uint8Array =>
  Uint8Array.from(nextCode.slice(0, size).split(''), (character) => ALPHABET.indexOf(character));

let links: IdentityLinks;
let jira: JiraBinding;

const store = () => integrationAdapters.createPostgresIdentityLinkStore({ sql: pool });

const ingress = () => {
  const resolved: ResolvedInboundIntegration = {
    ref: {
      integrationId: JIRA_INTEGRATION_ID,
      provider: 'jira-cloud',
      type: 'task_management',
      host: null,
    },
    inbound: jira.port.inbound as InboundNormaliser,
    bindings: [
      {
        bindingId: randomUUID() as Id,
        projectId,
        defaultBranch: 'main',
        inbound: jira.port.inbound as InboundNormaliser,
      },
    ],
    redactor: noSecretsRedactor(),
  };
  return createWebhookIngress({
    loader: eagerInboundLoader(async (id) => (id === JIRA_INTEGRATION_ID ? resolved : null)),
    inbox: integrationAdapters.createPostgresInboxStore({ sql: pool }),
    audit: integrationAdapters.createPostgresInboundAuditLog({ sql: pool }),
    identities: integrationAdapters.createPostgresIdentityDirectory({ sql: pool }),
    threads: integrationAdapters.createPostgresThreadDirectory({ sql: pool }),
    decisions: {
      apply: async () => {
        throw new Error('a comment produced a human decision');
      },
    },
    unitOfWork: eventing.unitOfWork,
    mergeRequests: integrationAdapters.createPostgresMergeRequestLifecycle({ sql: pool }),
    ids,
    clock,
    timer: { now: () => Date.now() },
    rateLimit: null,
    jobs: null,
    identityLinks: links.recorder,
  });
};

let deliveries = 0;
/** A fixture delivery under a fresh identifier, so the inbox does not deduplicate it. */
const delivery = (
  fixture: string,
  options: { readonly patch?: (body: Record<string, unknown>) => void; readonly id?: string } = {},
): WebhookDelivery => {
  deliveries += 1;
  return jira.replay.delivery(fixture, {
    deliveryId:
      options.id ?? `00000000-0000-4000-8000-${String(900_000 + deliveries).padStart(12, '0')}`,
    ...(options.patch === undefined ? {} : { patch: options.patch }),
  });
};

const deliver = async (input: WebhookDelivery) =>
  ingress().deliver({
    provider: 'jira-cloud',
    integrationId: JIRA_INTEGRATION_ID,
    delivery: input,
    transport: 'http',
  });

/** Rewrites a fixture's comment: its author (and editor), its id, its text. */
const comment =
  (input: { readonly author?: string; readonly id?: string; readonly text?: string }) =>
  (body: Record<string, unknown>) => {
    const target = body.comment as Record<string, unknown>;
    if (input.author !== undefined) {
      const account = { accountId: input.author, accountType: 'atlassian', displayName: 'Dev One' };
      target.author = account;
      target.updateAuthor = account;
      body.user = account;
    }
    if (input.id !== undefined) {
      target.id = input.id;
    }
    if (input.text !== undefined) {
      target.body = {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: input.text }] }],
      };
    }
  };

const rows = async () => {
  const matches = await pool.query<{
    outcome: string;
    external_id: string;
    comment_id: string;
    display_name: string | null;
    id: string;
  }>(
    'select id, outcome, external_id, comment_id, display_name from identity_link_matches order by created_at, id',
  );
  const codes = await pool.query<{
    void_reason: string | null;
    consumed_at: Date | null;
    code_hash: string;
  }>('select void_reason, consumed_at, code_hash from identity_link_codes order by created_at, id');
  const identities = await pool.query<{
    external_id: string;
    user_id: string | null;
    kind: string;
  }>('select external_id, user_id, kind from user_identities order by external_id');
  return { matches: matches.rows, codes: codes.rows, identities: identities.rows };
};

const issue = async (userId: Id = alice, suffix = CODE_SUFFIX) => {
  nextCode = suffix;
  const issued = await links.issue(userId);
  if (issued.kind !== 'issued') {
    throw new Error(`expected a code, got ${issued.kind}`);
  }
  return issued;
};

beforeAll(async () => {
  database = await createMigratedDatabase('identity-links');
  pool = createTestPool(database.connectionString, { max: 6 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('links') returning id",
  );
  const orgId = org.rows[0]?.id as string;
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
       values ($1, 'aut', 'Autix', 'https://git.example.test/acme/api.git') returning id`,
    [orgId],
  );
  projectId = project.rows[0]?.id as Id;
  const user = async (email: string, name: string): Promise<Id> =>
    (
      await pool.query<{ id: string }>(
        'insert into users (email, name) values ($1, $2) returning id',
        [email, name],
      )
    ).rows[0]?.id as Id;
  alice = await user('alice@example.test', 'Alice');
  bob = await user('bob@example.test', 'Bob');
  for (const [id, type, provider] of [
    [JIRA_INTEGRATION_ID, 'task_management', 'jira-cloud'],
    [FAKE_TM_INTEGRATION, 'task_management', 'fake-task-management'],
    [FAKE_GIT_INTEGRATION, 'git', 'fake-git'],
  ] as const) {
    await pool.query(
      `insert into integrations (id, org_id, type, provider, name)
         values ($1, $2, $3::integration_type, $4, $4)`,
      [id, orgId, type, provider],
    );
  }
}, 180_000);

afterAll(async () => {
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  await pool.query(
    `truncate identity_link_matches, identity_link_codes, user_identities, bindings, inbox,
              integration_actions, events, event_dispatch, event_streams, tasks cascade`,
  );
  now = Date.now();
  tick = 0;
  jira = createJiraBinding();
  links = createIdentityLinks({
    store: store(),
    unitOfWork: eventing.unitOfWork,
    ids,
    clock,
    draw,
  });
});

describe('the code (acceptance 1)', () => {
  it('is stored as its SHA-256 only, with one open code per user and the previous one replaced', async () => {
    const first = await issue();
    expect(first.code).toBe(`agentic-link-${CODE_SUFFIX}`);
    await issue(alice, '0123456789');
    const { codes } = await rows();
    expect(codes.map((code) => code.void_reason)).toEqual(['replaced', null]);
    expect(JSON.stringify(codes)).not.toContain(CODE_SUFFIX);
    expect(codes[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    const lifetimes = await pool.query<{ seconds: string }>(
      'select extract(epoch from expires_at - created_at)::text as seconds from identity_link_codes',
    );
    expect(lifetimes.rows.map((row) => Number(row.seconds))).toEqual([1_800, 1_800]);
  });

  it('keeps one open code per user when two issues race (the lock and the partial unique index)', async () => {
    const suffixes = ['AAAAAAAAAA', 'BBBBBBBBBB'];
    let index = 0;
    const racing = createIdentityLinks({
      store: store(),
      unitOfWork: eventing.unitOfWork,
      ids,
      clock,
      draw: (size) => {
        const suffix = suffixes[index] as string;
        index += 1;
        return Uint8Array.from(suffix.slice(0, size).split(''), (c) => ALPHABET.indexOf(c));
      },
    });
    const both = await Promise.all([racing.issue(alice), racing.issue(alice)]);
    expect(both.map((answer) => answer.kind)).toEqual(['issued', 'issued']);
    const open = await pool.query(
      'select 1 from identity_link_codes where user_id = $1 and consumed_at is null and voided_at is null',
      [alice],
    );
    expect(open.rowCount).toBe(1);
  });

  it('issues at most five per user per hour', async () => {
    for (let index = 0; index < 5; index += 1) {
      await issue(alice, `${'ABCDE'[index]}000000000`);
    }
    nextCode = 'F000000000';
    expect((await links.issue(alice)).kind).toBe('rate_limited');
    nextCode = 'G000000000';
    expect((await links.issue(bob)).kind).toBe('issued');
  });

  it('is single use: once a match is confirmed, the code matches nothing more', async () => {
    await issue();
    await deliver(delivery('webhook-comment-link-code.json'));
    const [match] = (await rows()).matches;
    expect((await links.confirm(alice, match?.id as Id)).kind).toBe('linked');
    // The same comment again (a new delivery id) is a miss now, and links nobody twice.
    await deliver(delivery('webhook-comment-link-code.json', { patch: comment({ id: '10299' }) }));
    const after = await rows();
    expect(after.matches.map((row) => row.outcome)).toEqual(['match', 'miss']);
    expect(after.identities).toHaveLength(1);
  });
});

describe('a verified comment carrying the code (acceptance 2)', () => {
  it('(a) records a match and writes no user_identities row; only the confirmation links', async () => {
    await issue();
    expect((await deliver(delivery('webhook-comment-link-code.json'))).kind).toBe('accepted');
    const recorded = await rows();
    expect(recorded.matches).toEqual([
      expect.objectContaining({
        outcome: 'match',
        external_id: DEV_ONE,
        comment_id: '10201',
        display_name: 'Dev One',
      }),
    ]);
    expect(recorded.identities).toEqual([]);

    const confirmed = await links.confirm(alice, recorded.matches[0]?.id as Id);
    expect(confirmed).toMatchObject({ kind: 'linked', externalId: DEV_ONE, replayed: false });
    const linked = await rows();
    expect(linked.identities).toEqual([{ external_id: DEV_ONE, user_id: alice, kind: 'person' }]);
    expect(linked.codes[0]?.consumed_at).not.toBeNull();
  });

  it('stores nothing of the comment but its id and author (BD-022, acceptance 6)', async () => {
    await issue();
    await deliver(
      delivery('webhook-comment-link-code.json', {
        patch: comment({ text: `secret plan FAKE-words-0123 agentic-link-${CODE_SUFFIX}` }),
      }),
    );
    const stored = await pool.query('select * from identity_link_matches');
    expect(JSON.stringify(stored.rows)).not.toContain('secret plan');
    expect(JSON.stringify(stored.rows)).not.toContain(CODE_SUFFIX);
  });

  it('lets an unconfirmed match expire with its code', async () => {
    await issue();
    await deliver(delivery('webhook-comment-link-code.json'));
    const [match] = (await rows()).matches;
    now += 30 * 60_000 + 1;
    expect(await links.confirm(alice, match?.id as Id)).toEqual({
      kind: 'refused',
      reason: 'code_expired',
    });
    expect((await rows()).identities).toEqual([]);
  });

  it('records one match for a redelivery: the inbox row deduplicates it', async () => {
    await issue();
    const once = delivery('webhook-comment-link-code.json');
    await deliver(once);
    expect((await deliver(once)).kind).toBe('duplicate');
    expect((await rows()).matches).toHaveLength(1);
  });
});

describe('what records no match (acceptance 3, one case each)', () => {
  it('(b) a JSM customer who copied the code: their match is voided by the owner’s own comment', async () => {
    await issue();
    await deliver(delivery('webhook-comment-link-code-customer.json'));
    const customer = (await rows()).matches;
    expect(customer).toEqual([
      expect.objectContaining({ outcome: 'match', external_id: CUSTOMER }),
    ]);
    // The owner writes the code too: two distinct authors, so the code is no evidence of anyone.
    await deliver(delivery('webhook-comment-link-code.json'));
    const after = await rows();
    expect(after.codes[0]?.void_reason).toBe('second_author');
    expect(after.matches).toHaveLength(1);
    expect(await links.confirm(alice, customer[0]?.id as Id)).toEqual({
      kind: 'refused',
      reason: 'code_voided',
      voidReason: 'second_author',
    });
    expect(after.identities).toEqual([]);
  });

  it('(b) a guest who posted the copied code after the owner voids it, and the owner’s confirmation is refused', async () => {
    await issue();
    await deliver(delivery('webhook-comment-link-code.json'));
    const [owner] = (await rows()).matches;
    await deliver(
      delivery('webhook-comment-link-code.json', {
        patch: comment({ author: GUEST, id: '10290' }),
      }),
    );
    expect((await rows()).codes[0]?.void_reason).toBe('second_author');
    expect(await links.confirm(alice, owner?.id as Id)).toMatchObject({
      kind: 'refused',
      reason: 'code_voided',
    });
    expect((await rows()).identities).toEqual([]);
  });

  it('(c) an edited comment', async () => {
    await issue();
    await deliver(delivery('webhook-comment-link-code-edited.json'));
    expect((await rows()).matches).toEqual([]);
  });

  it('(c) a comment editor — an Edit All Comments holder who put the code into Dev One’s comment', async () => {
    await issue();
    await deliver(delivery('webhook-comment-link-code-edit-all.json'));
    // Neither the editor (PM Two) nor the comment's author is matched.
    const recorded = await rows();
    expect(recorded.matches).toEqual([]);
    expect(JSON.stringify(recorded)).not.toContain(PM_TWO);
  });

  it('an unverified delivery', async () => {
    await issue();
    const forged = jira.replay.delivery('webhook-comment-link-code.json', {
      deliveryId: '00000000-0000-4000-8000-0000000f0f0f',
      secret: 'FAKE-not-the-binding-secret-0000',
    });
    expect((await deliver(forged)).kind).toBe('refused');
    expect((await rows()).matches).toEqual([]);
    expect((await pool.query('select 1 from inbox')).rowCount).toBe(0);
  });

  it('the platform’s own account — the binding’s, read live and stored', async () => {
    await issue();
    await deliver(delivery('webhook-comment-link-code.json', { patch: comment({ author: BOT }) }));
    expect((await rows()).matches).toEqual([]);
    // Another binding's stored account (`bindings.account_identity`) is refused the same way.
    await pool.query(
      `insert into bindings (project_id, integration_id, account_identity)
         values ($1, $2, $3::jsonb)`,
      [
        projectId,
        FAKE_TM_INTEGRATION,
        JSON.stringify({ provider: 'jira-cloud', external_id: GUEST }),
      ],
    );
    await deliver(
      delivery('webhook-comment-link-code.json', {
        patch: comment({ author: GUEST, id: '10291' }),
      }),
    );
    expect((await rows()).matches).toEqual([]);
  });

  it('a machine identity', async () => {
    await issue();
    await pool.query(
      "insert into user_identities (provider, external_id, user_id, kind) values ('jira-cloud', $1, null, 'machine')",
      [DEV_ONE],
    );
    await deliver(delivery('webhook-comment-link-code.json'));
    expect((await rows()).matches).toEqual([]);
  });

  it('a comment with a platform marker', async () => {
    await issue();
    await deliver(
      delivery('webhook-comment-link-code.json', {
        patch: comment({ text: `agentic:task:0000 the agent wrote agentic-link-${CODE_SUFFIX}` }),
      }),
    );
    expect((await rows()).matches).toEqual([]);
  });

  it('an author linked to someone else voids the code (identity_linked_elsewhere)', async () => {
    await issue();
    await pool.query(
      "insert into user_identities (provider, external_id, user_id, kind) values ('jira-cloud', $1, $2, 'person')",
      [DEV_ONE, bob],
    );
    await deliver(delivery('webhook-comment-link-code.json'));
    const after = await rows();
    expect(after.matches).toEqual([]);
    expect(after.codes[0]?.void_reason).toBe('identity_linked_elsewhere');
  });

  it('five misses in 24 h make the author ignored for the day, with one audit row', async () => {
    for (let index = 1; index <= 5; index += 1) {
      await deliver(
        delivery('webhook-comment-link-code.json', {
          patch: comment({ id: `1030${index}`, text: `guess agentic-link-ZZZZZZZZZ${index}` }),
        }),
      );
    }
    const outcomes = (await rows()).matches.map((row) => row.outcome);
    expect(outcomes.filter((outcome) => outcome === 'miss')).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome === 'ignored')).toHaveLength(1);
    // The owner's real code, from the ignored author, is not matched.
    await issue();
    await deliver(delivery('webhook-comment-link-code.json'));
    expect((await rows()).matches.filter((row) => row.outcome === 'match')).toEqual([]);
  });
});

describe('I wrote it on … — the thread read through the executor (acceptance 4, fake providers)', () => {
  const executorWith = () => {
    const audit = createMemoryAuditLog();
    const executor = createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog: audit,
      redactor: exactSecretRedactor([]),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock,
    });
    return { audit, executor };
  };

  it('reads a ticket’s comments through the executor and records the author’s match once', async () => {
    const created = new Date(now - 60_000).toISOString();
    const tickets = createFakeTaskManagement({
      integrationId: FAKE_TM_INTEGRATION,
      tickets: [
        {
          key: 'AUT-1',
          title: 'Show the totals',
          comments: [
            {
              authorId: 'dev-7',
              body: `linking agentic-link-${CODE_SUFFIX}`,
              createdAt: created,
              updatedAt: created,
              updateAuthorId: 'dev-7',
            },
            { authorId: 'pm-2', body: 'please rebase', createdAt: created },
          ],
        },
      ],
    });
    const { audit, executor } = executorWith();
    const integrations = staticPipelineIntegrations({
      executor,
      git: null,
      taskManagement: { port: tickets, ref: tickets.ref, redactor: noSecretsRedactor() },
      communication: null,
    });
    await issue();
    const read = () =>
      readLinkThread(
        { integrations, recorder: links.recorder, unitOfWork: eventing.unitOfWork },
        {
          projectId,
          target: {
            kind: 'ticket',
            ticket: {
              provider: 'fake-task-management',
              key: 'AUT-1',
              url: 'https://tickets.example.test/AUT-1',
            },
          },
        },
      );
    expect(await read()).toMatchObject({ kind: 'read', comments: 2, claims: 1 });
    expect(await read()).toMatchObject({ kind: 'read', claims: 1 });
    const recorded = await rows();
    expect(recorded.matches).toEqual([
      expect.objectContaining({ outcome: 'match', external_id: 'dev-7' }),
    ]);
    expect(recorded.identities).toEqual([]);
    const actions = audit.entries.map((entry) => entry.action);
    expect(actions).toContain('list_comments');
    expect(actions).toContain('self_identity');
  });

  it('applies the same rules to a thread: an unstated or edited comment records nothing', async () => {
    const created = new Date(now - 60_000).toISOString();
    const tickets = createFakeTaskManagement({
      integrationId: FAKE_TM_INTEGRATION,
      tickets: [
        {
          key: 'AUT-2',
          title: 'Edited',
          comments: [
            {
              authorId: 'dev-7',
              body: `agentic-link-${CODE_SUFFIX}`,
              createdAt: created,
              updatedAt: new Date(now).toISOString(),
            },
            // Divergence 18: a seed that states no edit is refused, never kinder than Jira.
            { authorId: 'dev-8', body: `agentic-link-${CODE_SUFFIX}`, createdAt: created },
          ],
        },
      ],
    });
    const { executor } = executorWith();
    await issue();
    const outcome = await readLinkThread(
      {
        integrations: staticPipelineIntegrations({
          executor,
          git: null,
          taskManagement: { port: tickets, ref: tickets.ref, redactor: noSecretsRedactor() },
          communication: null,
        }),
        recorder: links.recorder,
        unitOfWork: eventing.unitOfWork,
      },
      {
        projectId,
        target: {
          kind: 'ticket',
          ticket: {
            provider: 'fake-task-management',
            key: 'AUT-2',
            url: 'https://tickets.example.test/AUT-2',
          },
        },
      },
    );
    // Newest first, and the two share an instant: the order of the refusals is the provider's.
    expect(outcome).toMatchObject({ kind: 'read', claims: 2, recorded: { matched: 0 } });
    expect(outcome.kind === 'read' ? [...outcome.recorded.refused].sort() : null).toEqual([
      'edit_state_unknown',
      'edited',
    ]);
    expect((await rows()).matches).toEqual([]);
  });

  it('reads a merge request’s notes the same way, and skips its system notes', async () => {
    const git = createFakeGitProvider({
      integrationId: FAKE_GIT_INTEGRATION,
      projects: [{ path: 'acme/api', defaultBranch: 'main' }],
    });
    const mr = await git.openMergeRequest({
      project: 'acme/api',
      branch: 'agentic/aut-1',
      target: 'main',
      title: 'Totals',
      description: '',
      draft: true,
      labels: [],
      reviewers: [],
      remove_source_branch: true,
    });
    const at = new Date(now - 60_000).toISOString();
    git.addHumanDiscussion({
      project: 'acme/api',
      iid: mr.ref.iid,
      authorId: 'dana',
      text: `my link agentic-link-${CODE_SUFFIX}`,
      createdAt: at,
      updatedAt: at,
    });
    git.addHumanDiscussion({
      project: 'acme/api',
      iid: mr.ref.iid,
      authorId: 'dana',
      text: `agentic-link-${CODE_SUFFIX}`,
      createdAt: at,
      updatedAt: at,
      system: true,
    });
    const { audit, executor } = executorWith();
    await issue();
    const outcome = await readLinkThread(
      {
        integrations: staticPipelineIntegrations({
          executor,
          git: { port: git, ref: git.ref, project: 'acme/api', redactor: noSecretsRedactor() },
          taskManagement: null,
          communication: null,
        }),
        recorder: links.recorder,
        unitOfWork: eventing.unitOfWork,
      },
      { projectId, target: { kind: 'merge_request', mergeRequest: mr.ref } },
    );
    expect(outcome).toMatchObject({ kind: 'read', claims: 1, recorded: { matched: 1 } });
    expect((await rows()).matches).toEqual([
      expect.objectContaining({ outcome: 'match', external_id: 'dana' }),
    ]);
    const actions = audit.entries.map((entry) => entry.action);
    expect(actions).toContain('list_discussions');
    expect(actions).toContain('authenticated_user');
  });

  it('counts no miss for a re-read, however often: copied codes cannot get an author ignored', async () => {
    const created = new Date(now - 60_000).toISOString();
    const tickets = createFakeTaskManagement({
      integrationId: FAKE_TM_INTEGRATION,
      tickets: [
        {
          key: 'AUT-3',
          title: 'Copied codes',
          // The victim's own old comments, carrying codes that are no longer live.
          comments: [1, 2, 3, 4, 5, 6].map((index) => ({
            authorId: 'victim-1',
            body: `agentic-link-ZZZZZZZZZ${index}`,
            createdAt: created,
            updatedAt: created,
            updateAuthorId: 'victim-1',
          })),
        },
      ],
    });
    const { executor } = executorWith();
    const integrations = staticPipelineIntegrations({
      executor,
      git: null,
      taskManagement: { port: tickets, ref: tickets.ref, redactor: noSecretsRedactor() },
      communication: null,
    });
    for (let read = 0; read < 6; read += 1) {
      const outcome = await readLinkThread(
        { integrations, recorder: links.recorder, unitOfWork: eventing.unitOfWork },
        {
          projectId,
          target: {
            kind: 'ticket',
            ticket: {
              provider: 'fake-task-management',
              key: 'AUT-3',
              url: 'https://tickets.example.test/AUT-3',
            },
          },
        },
      );
      expect(outcome).toMatchObject({
        kind: 'read',
        claims: 6,
        recorded: { missed: 6, ignored: [] },
      });
    }
    expect((await rows()).matches).toEqual([]);
  });

  it('answers no binding for a project whose binding of that kind is absent', async () => {
    const { executor } = executorWith();
    const outcome = await readLinkThread(
      {
        integrations: staticPipelineIntegrations({
          executor,
          git: null,
          taskManagement: null,
          communication: null,
        }),
        recorder: links.recorder,
        unitOfWork: eventing.unitOfWork,
      },
      {
        projectId,
        target: {
          kind: 'ticket',
          ticket: {
            provider: 'fake-task-management',
            key: 'AUT-1',
            url: 'https://tickets.example.test/AUT-1',
          },
        },
      },
    );
    expect(outcome).toEqual({ kind: 'no_binding' });
  });
});

/**
 * Acceptance 5's first half and the candidates (S-26.1's columns, migration 0104): a confirmed link
 * adopts the owner on the live tasks nobody owns whose stored tracker assignee is the account
 * (`adoptOwnersOnLink`, `via: link`), and an unlinked assignee is offered to the admin mapping.
 */
describe('a confirmed link adopts the owner, and unlinked assignees are candidates (acceptance 5)', () => {
  const pipelineStore = () =>
    pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  let tasks = 0;

  /** A committed live task of the project, its tracker assignee set as S-26.1's sync stores it. */
  const assignedTask = async (
    assignee: { readonly externalId: string; readonly platform?: boolean },
    state: 'active' | 'done' = 'active',
  ): Promise<Id> => {
    tasks += 1;
    const taskId = randomUUID() as Id;
    const stored = {
      task: {
        id: taskId,
        projectId,
        ticket: {
          provider: 'jira-cloud',
          key: `ACME-${900 + tasks}`,
          url: `https://acme-example.atlassian.net/browse/ACME-${900 + tasks}`,
        },
        template: 'feature',
        mode: 'normal',
        // The state is the fixture's, written by the insert (no second writer of `tasks.state`).
        state,
        currentStage: 'implementation' as Slug,
        stageAttempts: { implementation: 1 },
        iterationCounters: {},
        limits: {
          code_review: 3,
          business_review: 2,
          ci_fix: 3,
          human_rounds: 3,
          refinement_questions: 2,
          architecture_revisions: 2,
          rebase: 2,
          rebase_rechecks: 10,
          dependency_policy: 2,
        },
        sequence: 1,
      },
      template: FEATURE_TEMPLATE,
      pipelineDial: null,
      qaStage: false,
      priorityRank: 2,
      createdAt: new Date(now).toISOString(),
      branch: null,
      mr: null,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      estimateBasis: null,
      estimateSamples: null,
      ticketSnapshot: null,
      ticketSnapshotAt: null,
      ticketSignalAt: null,
      reviewSubject: null,
      historySample: null,
      riskClasses: [],
      coverage: null,
      dependencies: null,
      requiredReviewers: null,
      reviewThreads: null,
      readyHeadSha: null,
      ciHeadSha: null,
      ciExcusedPaths: [],
      requestedByUserId: null,
      version: INITIAL_TASK_VERSION,
    } as unknown as StoredTask;
    // The assignee as S-26.1's sync stores it, through the column's one writer (`saveOwner`, a
    // compare-and-set from the unowned row) — never a second `update tasks`.
    await eventing.unitOfWork.transaction(async ({ tx }) => {
      const tasksStore = pipelineStore().tasks;
      await tasksStore.insert(tx, stored);
      const written = await tasksStore.saveOwner(tx, taskId, {
        expected: { ownerUserId: null, ticketAssignee: null },
        next: {
          ...UNOWNED,
          ticketAssignee: {
            provider: 'jira-cloud',
            external_id: assignee.externalId,
            display_name: 'Dev One',
            platform: assignee.platform ?? false,
          },
        },
      });
      if (!written) {
        throw new Error('the fixture task already had an assignee');
      }
    });
    return taskId;
  };

  it('makes the person the owner of the live, unowned tasks assigned to the account they confirmed', async () => {
    const live = await assignedTask({ externalId: DEV_ONE });
    const finished = await assignedTask({ externalId: DEV_ONE }, 'done');
    const someoneElse = await assignedTask({ externalId: GUEST });
    await issue();
    await deliver(delivery('webhook-comment-link-code.json'));
    const [match] = (await rows()).matches;
    expect((await links.confirm(alice, match?.id as Id)).kind).toBe('linked');

    const adopted = await adoptOwnersOnLink(
      { unitOfWork: eventing.unitOfWork, store: pipelineStore(), ids, clock },
      { userId: alice, provider: 'jira-cloud', externalId: DEV_ONE },
    );
    expect(adopted).toEqual([live]);
    const owners = await pool.query<{ id: string; owner_user_id: string | null }>(
      'select id, owner_user_id from tasks where id = any($1::uuid[])',
      [[live, finished, someoneElse]],
    );
    const ownerOf = new Map(owners.rows.map((row) => [row.id, row.owner_user_id]));
    expect(ownerOf.get(live)).toBe(alice);
    expect(ownerOf.get(finished)).toBeNull();
    expect(ownerOf.get(someoneElse)).toBeNull();
    const changed = await pool.query<{ payload: { via: string; owner_user_id: string } }>(
      "select payload from events where type = 'task.owner.changed' and stream_id = $1",
      [live],
    );
    expect(changed.rows.map((row) => row.payload.via)).toEqual(['link']);
  });

  it('adopts nothing for an account that is not linked to that person', async () => {
    const live = await assignedTask({ externalId: DEV_ONE });
    expect(
      await adoptOwnersOnLink(
        { unitOfWork: eventing.unitOfWork, store: pipelineStore(), ids, clock },
        { userId: alice, provider: 'jira-cloud', externalId: DEV_ONE },
      ),
    ).toEqual([]);
    const owner = await pool.query('select owner_user_id from tasks where id = $1', [live]);
    expect(owner.rows[0]?.owner_user_id).toBeNull();
  });

  it('offers unlinked live-task assignees as candidates, never the platform’s account or a finished task’s', async () => {
    await assignedTask({ externalId: GUEST });
    await assignedTask({ externalId: GUEST });
    await assignedTask({ externalId: BOT, platform: true });
    await assignedTask({ externalId: PM_TWO }, 'done');
    const drizzled = drizzle(pool, { schema: db.schema });
    const candidates = await listIdentityCandidates(drizzled);
    expect(candidates).toEqual([
      expect.objectContaining({
        provider: 'jira-cloud',
        external_id: GUEST,
        deliveries: 0,
        assigned_tasks: 2,
        display_name: 'Dev One',
      }),
    ]);
    // Once linked, the account is no candidate.
    await pool.query(
      "insert into user_identities (provider, external_id, user_id, kind) values ('jira-cloud', $1, $2, 'person')",
      [GUEST, bob],
    );
    expect(await listIdentityCandidates(drizzled)).toEqual([]);
  });
});
