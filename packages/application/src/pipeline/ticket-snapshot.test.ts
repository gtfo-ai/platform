/**
 * WP-15f — the ticket's own words, from the provider's answer to the assembled prompt.
 *
 * The acceptance criteria are asserted **against the assembled prompt and the stored row**, never
 * through the runner: `FakeClaudeRunner` picks its scenario from `spec.stage` and never reads the
 * prompt, so a test that drove it would assert nothing about the thing this work package produces
 * (standing rule 82, earned by exactly this gap).
 */
import type { Id, TicketSnapshot } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { TransactionOpenError, withOpenTransaction } from '../events/open-transaction.js';
import { exactSecretRedactor, noSecretsRedactor } from '../integrations/redaction.js';
import type { Ticket, TicketComment } from '../ports/integrations/task-management.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { PipelineIntegrations } from './integrations.js';
import { staticPipelineIntegrations } from './integrations.js';
import type { StoredTask } from './store.js';
import {
  boundTicketSnapshot,
  type EnsureTicketSnapshotOptions,
  ensureTicketSnapshot,
  MAX_TICKET_AUTHOR_CHARS,
  MAX_TICKET_COMMENT_CHARS,
  MAX_TICKET_COMMENT_ID_CHARS,
  MAX_TICKET_COMMENTS,
  MAX_TICKET_DESCRIPTION_CHARS,
  MAX_TICKET_TITLE_CHARS,
  readTicketSnapshot,
  TICKET_SNAPSHOT_MAX_TEXT_CHARS,
} from './ticket-snapshot.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const REF = {
  provider: 'fake-jira',
  key: 'ACME-1',
  url: 'https://jira.example.test/browse/ACME-1',
};

const comment = (overrides: Partial<TicketComment> = {}): TicketComment => ({
  id: 'comment-1',
  author: {
    provider: 'fake-jira',
    external_id: 'u1',
    email: null,
    display_name: 'Dana',
    verified: true,
  },
  body: 'the migration leaves sessions behind',
  created_at: '2026-06-01T09:00:00.000Z',
  updated_at: null,
  marker_id: null,
  url: null,
  ...overrides,
});

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  ref: REF,
  issue_type: 'Bug',
  title: 'rollback sessions after a failed migration',
  description: 'When a migration fails halfway the session table keeps the half-written rows.',
  status: 'To Do',
  priority: 'High',
  labels: ['agentic'],
  comments: [],
  links: [],
  epic: null,
  siblings: [],
  attachments_text: [],
  assignee: null,
  reporter: null,
  updated_at: '2026-06-02T09:00:00.000Z',
  ...overrides,
});

describe('the snapshot a ticket is bounded into', () => {
  it('keeps the ticket’s own words, and says nothing was cut when nothing was', () => {
    const snapshot = boundTicketSnapshot(ticket(), noSecretsRedactor());
    expect(snapshot.title).toBe('rollback sessions after a failed migration');
    expect(snapshot.description).toContain('session table');
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.comment_count).toBe(0);
    expect(snapshot.redaction_count).toBe(0);
    expect(snapshot.ticket_updated_at).toBe('2026-06-02T09:00:00.000Z');
  });

  it('cuts the title at its cap and declares it', () => {
    const snapshot = boundTicketSnapshot(
      ticket({ title: 'x'.repeat(MAX_TICKET_TITLE_CHARS + 1) }),
      noSecretsRedactor(),
    );
    expect(snapshot.title).toHaveLength(MAX_TICKET_TITLE_CHARS);
    expect(snapshot.truncated).toBe(true);
  });

  it('cuts the description at its cap and declares it', () => {
    const snapshot = boundTicketSnapshot(
      ticket({ description: 'y'.repeat(MAX_TICKET_DESCRIPTION_CHARS + 1) }),
      noSecretsRedactor(),
    );
    expect(snapshot.description).toHaveLength(MAX_TICKET_DESCRIPTION_CHARS);
    expect(snapshot.truncated).toBe(true);
  });

  it('cuts one comment without claiming the thread was shortened', () => {
    const snapshot = boundTicketSnapshot(
      ticket({ comments: [comment({ body: 'z'.repeat(MAX_TICKET_COMMENT_CHARS + 1) })] }),
      noSecretsRedactor(),
    );
    expect(snapshot.comments[0]?.body).toHaveLength(MAX_TICKET_COMMENT_CHARS);
    expect(snapshot.comments[0]?.truncated).toBe(true);
    // Per comment *and* on the snapshot: a reader of either knows something was cut.
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.comment_count).toBe(1);
  });

  it('keeps the newest comments, reads them forwards, and says how many there were', () => {
    const comments = Array.from({ length: MAX_TICKET_COMMENTS + 5 }, (_unused, index) =>
      comment({
        id: `comment-${index}`,
        body: `body ${index}`,
        // Oldest first on the way in, so the selection cannot be "the first twenty".
        created_at: new Date(Date.UTC(2026, 5, 1, index)).toISOString(),
      }),
    );
    const snapshot = boundTicketSnapshot(ticket({ comments }), noSecretsRedactor());
    expect(snapshot.comments).toHaveLength(MAX_TICKET_COMMENTS);
    expect(snapshot.comment_count).toBe(MAX_TICKET_COMMENTS + 5);
    expect(snapshot.truncated).toBe(true);
    // The newest twenty…
    expect(snapshot.comments.map((entry) => entry.id)).toContain('comment-24');
    expect(snapshot.comments.map((entry) => entry.id)).not.toContain('comment-0');
    // …in the order a human reads a thread.
    expect(snapshot.comments[0]?.id).toBe('comment-5');
    expect(snapshot.comments.at(-1)?.id).toBe('comment-24');
  });

  it('leaves out the platform’s own workpad comment', () => {
    const snapshot = boundTicketSnapshot(
      ticket({
        comments: [
          comment({ id: 'human', body: 'a human wrote this' }),
          comment({ id: 'workpad', body: '**ACME-1** — active', marker_id: 'agentic:task:1' }),
        ],
      }),
      noSecretsRedactor(),
    );
    expect(snapshot.comments.map((entry) => entry.id)).toEqual(['human']);
    // The platform's own comment is not a comment that was *dropped*: the count is of the thread
    // a human wrote, so `truncated` stays false.
    expect(snapshot.comment_count).toBe(1);
    expect(snapshot.truncated).toBe(false);
  });

  it('answers null for a timestamp it cannot read, rather than inventing one', () => {
    const snapshot = boundTicketSnapshot(
      ticket({
        comments: [comment({ created_at: 'yesterday' as never })],
        updated_at: 'soon' as never,
      }),
      noSecretsRedactor(),
    );
    expect(snapshot.comments[0]?.created_at).toBeNull();
    expect(snapshot.ticket_updated_at).toBeNull();
  });

  it('bounds the provider’s comment id and the author’s display name', () => {
    const snapshot = boundTicketSnapshot(
      ticket({
        comments: [
          comment({
            id: 'i'.repeat(MAX_TICKET_COMMENT_ID_CHARS + 10),
            author: {
              provider: 'fake-jira',
              external_id: 'u1',
              email: null,
              display_name: 'n'.repeat(MAX_TICKET_AUTHOR_CHARS + 10),
              verified: true,
            },
          }),
        ],
      }),
      noSecretsRedactor(),
    );
    expect(snapshot.comments[0]?.id).toHaveLength(MAX_TICKET_COMMENT_ID_CHARS);
    expect(snapshot.comments[0]?.author).toHaveLength(MAX_TICKET_AUTHOR_CHARS);
  });

  /**
   * The figure this work package owns, produced rather than quoted (standing rule 39).
   *
   * Q54 measured one unbounded `readTicket` at **53 284 565 bytes**. The same shape here is a
   * megabyte per field and 500 comments; what comes out is the budget and nothing more.
   */
  it('turns a ticket nobody could read into a snapshot of a stated size', () => {
    const hostile = ticket({
      title: 'T'.repeat(1_000_000),
      description: 'D'.repeat(1_000_000),
      comments: Array.from({ length: 500 }, (_unused, index) =>
        comment({
          id: 'I'.repeat(1_000),
          body: 'B'.repeat(100_000),
          created_at: new Date(Date.UTC(2026, 5, 1, 0, index)).toISOString(),
          author: {
            provider: 'fake-jira',
            external_id: 'u1',
            email: null,
            display_name: 'A'.repeat(1_000),
            verified: true,
          },
        }),
      ),
    });
    const snapshot = boundTicketSnapshot(hostile, noSecretsRedactor());
    const textChars =
      snapshot.title.length +
      snapshot.description.length +
      snapshot.comments.reduce(
        (total, entry) => total + entry.id.length + entry.author.length + entry.body.length,
        0,
      );
    expect(TICKET_SNAPSHOT_MAX_TEXT_CHARS).toBe(45_632);
    expect(textChars).toBe(TICKET_SNAPSHOT_MAX_TEXT_CHARS);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.comment_count).toBe(500);
    // What actually lands in `tasks.ticket_snapshot`, ASCII, envelope included.
    expect(JSON.stringify(snapshot).length).toBeLessThan(50_000);
  });
});

describe('the binding’s redactor, applied where the platform stores provider text', () => {
  const SECRET = 'glpat-notarealtokenatall';
  const redactor = () => exactSecretRedactor([{ name: 'fake_jira_token', value: SECRET }]);

  it('replaces a credential a human pasted into the ticket, and counts it', () => {
    const snapshot = boundTicketSnapshot(
      ticket({
        description: `use ${SECRET} to reproduce`,
        comments: [comment({ body: `and ${SECRET} again` })],
      }),
      redactor(),
    );
    expect(snapshot.description).not.toContain(SECRET);
    expect(snapshot.comments[0]?.body).not.toContain(SECRET);
    expect(snapshot.description).toContain('[REDACTED:integration:fake_jira_token]');
    expect(snapshot.redaction_count).toBe(2);
  });

  /**
   * **Redact, then cut** — the ordering, asserted from the side that can tell them apart.
   *
   * A secret sitting past the cap is only found by a redactor that ran *first*: `inbound.ts` makes
   * the same argument, because an exact-match redactor cannot find a secret a cap has halved.
   * Swapping the two statements in `clean` leaves `redaction_count` at 0 and this test dies.
   */
  it('finds a credential past the description cap, because it redacts before it cuts', () => {
    const snapshot = boundTicketSnapshot(
      ticket({ description: `${'d'.repeat(MAX_TICKET_DESCRIPTION_CHARS)}${SECRET}` }),
      redactor(),
    );
    expect(snapshot.redaction_count).toBe(1);
    expect(snapshot.description).not.toContain(SECRET);
    expect(snapshot.description).toHaveLength(MAX_TICKET_DESCRIPTION_CHARS);
  });
});

const integrationsWith = (
  readTicket: () => Promise<Ticket>,
  present = true,
): PipelineIntegrations => ({
  executor: {
    execute: async (request: { perform: () => Promise<unknown> }) => ({
      status: 'ok' as const,
      result: await request.perform(),
    }),
  } as unknown as PipelineIntegrations['executor'],
  git: null,
  taskManagement: present
    ? {
        port: { readTicket } as unknown as NonNullable<
          PipelineIntegrations['taskManagement']
        >['port'],
        ref: {
          integrationId: PROJECT,
          provider: 'fake-jira',
          type: 'task_management' as const,
        },
        redactor: noSecretsRedactor(),
      }
    : null,
});

/** Just enough `StoredTask` for {@link ensureTicketSnapshot}, which reads three fields. */
const storedWith = (ticketSnapshot: TicketSnapshot | null): StoredTask =>
  ({
    task: { id: TASK, projectId: PROJECT, ticket: REF },
    ticketSnapshot,
    ticketSnapshotAt: ticketSnapshot === null ? null : '2026-06-01T09:00:00.000Z',
  }) as unknown as StoredTask;

describe('reading the ticket', () => {
  const options = (integrations: PipelineIntegrations) => ({
    integrations: staticPipelineIntegrations(integrations),
    clock: { now: () => '2026-06-01T09:00:00.000Z' },
    logger: silentLogger,
  });

  it('returns the bounded snapshot when the provider answers', async () => {
    const snapshot = await readTicketSnapshot(options(integrationsWith(async () => ticket())), {
      projectId: PROJECT,
      taskId: TASK,
      ticket: REF,
    });
    expect(snapshot?.title).toBe('rollback sessions after a failed migration');
  });

  /**
   * Standing rule 20, on the side this call is on: refusing a *read* costs the agent the ticket's
   * text; refusing to create the task costs the work. So the failure is `null` and the next stage
   * asks again — and `null` is not how a ticket with no description is spelled, which is what makes
   * "the platform never read this" recoverable rather than invisible (standing rule 18).
   */
  it('answers null when the provider refuses, rather than failing the task', async () => {
    const snapshot = await readTicketSnapshot(
      options(
        integrationsWith(async () => {
          throw new Error('jira is down');
        }),
      ),
      { projectId: PROJECT, taskId: TASK, ticket: REF },
    );
    expect(snapshot).toBeNull();
  });

  /**
   * **The one failure that must not fail open**, and nothing noticed before review round 1.
   *
   * The blanket `catch` swallowed `TransactionOpenError` on both call sites — probed, it answered
   * `{threw: false, value: null}` inside `withOpenTransaction` — so WP-15d's guard was disarmed
   * exactly where this work package added two new provider calls, and a later move of either
   * inside a transaction would have held a pooled connection across a provider round trip *and*
   * silently dropped the ticket text. `open-transaction.ts` says there is no retry and no fallback
   * for it; this asserts that the fallback beside it does not become one.
   *
   * Both directions (standing rule 42): refused inside a transaction, performed outside one.
   */
  it('rethrows the open-transaction refusal instead of absorbing it as a failed read', async () => {
    const integrations = integrationsWith(async () => ticket());
    await expect(
      withOpenTransaction(async () =>
        readTicketSnapshot(options(integrations), {
          projectId: PROJECT,
          taskId: TASK,
          ticket: REF,
        }),
      ),
    ).rejects.toThrow(TransactionOpenError);
    // …and the same call outside one answers, so the refusal is the transaction and not the double.
    expect(
      (
        await readTicketSnapshot(options(integrations), {
          projectId: PROJECT,
          taskId: TASK,
          ticket: REF,
        })
      )?.title,
    ).toBe('rollback sessions after a failed migration');
  });

  /**
   * The refusal fires at the **call** too, not only at the door: a caller that resolved the
   * bindings before opening its transaction walks past `integrationsForProject` and is stopped by
   * `read()` (`integrations.ts`, the two refusals that are not one guard bounded twice).
   */
  it('rethrows it for a caller that had already resolved the bindings', async () => {
    const integrations = integrationsWith(async () => ticket());
    await expect(
      withOpenTransaction(async () =>
        readTicketSnapshot(
          options(integrations),
          { projectId: PROJECT, taskId: TASK, ticket: REF },
          integrations,
        ),
      ),
    ).rejects.toThrow(TransactionOpenError);
  });

  /**
   * The ordinary path is **one already-loaded field**, and the sentence in `jobs.ts` says so — so
   * it is pinned rather than asserted in prose (review round 1 measured the opposite: a second
   * transaction per agent stage, re-reading the row the handler had just discarded).
   */
  it('opens no transaction and makes no provider call for a task that has its snapshot', async () => {
    const refuse: UnitOfWork = {
      transaction: async () => {
        throw new Error('the ordinary path must not open a transaction');
      },
    };
    let reads = 0;
    const integrations = integrationsWith(async () => {
      reads += 1;
      return ticket();
    });
    await ensureTicketSnapshot(
      {
        ...options(integrations),
        unitOfWork: refuse,
        store: {
          tasks: {
            load: async () => {
              throw new Error('the ordinary path must not re-load the task');
            },
          },
        } as unknown as EnsureTicketSnapshotOptions['store'],
      },
      storedWith(boundTicketSnapshot(ticket(), noSecretsRedactor())),
    );
    expect(reads).toBe(0);
  });

  it('answers null for a project with no task-management binding', async () => {
    const snapshot = await readTicketSnapshot(
      options(integrationsWith(async () => ticket(), false)),
      { projectId: PROJECT, taskId: TASK, ticket: REF },
    );
    expect(snapshot).toBeNull();
  });
});
