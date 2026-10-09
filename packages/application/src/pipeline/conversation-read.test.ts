/**
 * **The conversation in every agent stage's prompt, and `get_conversation`'s answer** (WP-180,
 * TD-029 decision 11, BD-031 ruling 6).
 *
 * The planner is driven over the **real** reader (`createConversationReader`), the real executor and
 * the real prompt assembler, with port doubles that answer the shapes the git and task-management
 * ports declare; what the run would read is parsed back out of `spec.userPrompt` with
 * `readDataBlocks`. Every name, id and text below is invented.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { agentRoleSchema } from '@platform/contracts';
import {
  conversationBlocks,
  type RolePromptDefinition,
  readDataBlocks,
  type SkillDefinition,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { TransactionOpenError } from '../events/open-transaction.js';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { createContextPackAssembler } from '../knowledge/context-pack.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { IntegrationError, type IntegrationRef } from '../ports/integrations/common.js';
import type { Discussion, GitProviderPort } from '../ports/integrations/git-provider.js';
import type {
  CommentPage,
  TaskManagementPort,
  TicketComment,
} from '../ports/integrations/task-management.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { PlatformToolName } from '../ports/runner.js';
import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
} from '../testing/memory-integrations.js';
import { indexedFixtureVault } from '../testing/memory-knowledge.js';
import {
  CONVERSATION_MAX_CHARS,
  CONVERSATION_MAX_ENTRIES,
  type ConversationReader,
  conversationFrom,
  conversationToolAnswer,
  createConversationReader,
  cutAtCodePoint,
} from './conversation-read.js';
import { staticPipelineIntegrations } from './integrations.js';
import { createStageRunPlanner, PLATFORM_TOOLS_BY_ROLE, SKILLS_BY_ROLE } from './planner.js';
import type { StageRunRequest } from './stage-executor.js';

const PROJECT = '00000000-0000-4000-8000-00000000f1c7' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c2' as Id;
const RUN = '00000000-0000-4000-8000-0000000000c3' as Id;
const NONCE = 'abcdef1234567890abcdef1234567890';
const NOW = '2026-10-08T09:00:00.000Z' as IsoDateTime;

const GIT_REF: IntegrationRef = {
  integrationId: '00000000-0000-4000-8000-00000000a001' as Id,
  provider: 'fake-git',
  type: 'git',
  host: null,
};
const TICKET_REF: IntegrationRef = {
  integrationId: '00000000-0000-4000-8000-00000000a002' as Id,
  provider: 'fake-jira',
  type: 'task_management',
  host: null,
};

const THREAD_DIFF = '3f2a9c1e0b7d4a6f8e5c2b1a0d9f8e7c6b5a4d3e';
const THREAD_BOT = '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d';
const THREAD_SYSTEM = '1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a';
/** Two Jira accounts with the same display name (the canary of criterion (6)). */
const JANE_ONE = '557058:1b2c3d4e-0000-4000-8000-00000000abcd';
const JANE_TWO = '557058:9f8e7d6c-0000-4000-8000-00000000dcba';
const SECRET = 'glpat-FAKE-not-a-real-token-0001';
const JIRA_SECRET = 'ATATT-FAKE-not-a-real-token-0002';

const person = (provider: string, externalId: string, displayName: string | null) => ({
  provider,
  external_id: externalId,
  email: null,
  display_name: displayName,
  verified: true,
});

const discussions = (body = 'Please rename the helper before merging.'): Discussion[] => [
  {
    id: THREAD_DIFF,
    resolvable: true,
    resolved: false,
    notes: [
      {
        id: '501',
        author: person('fake-git', '1201', 'Sam Reviewer'),
        body,
        created_at: '2026-10-02T10:00:00.000Z',
        path: 'docs/a b.md',
        line: 3,
        system: false,
      },
    ],
  },
  {
    id: THREAD_BOT,
    resolvable: false,
    resolved: false,
    notes: [
      {
        id: '502',
        author: person('fake-git', '77', 'platform-bot'),
        body: '<!-- agentic:review-finding:t.r.1 -->\nThe export misses a header.',
        created_at: '2026-10-03T10:00:00.000Z',
        path: null,
        line: null,
        system: false,
      },
    ],
  },
  {
    id: THREAD_SYSTEM,
    resolvable: false,
    resolved: false,
    notes: [
      {
        id: '503',
        author: person('fake-git', '1201', 'Sam Reviewer'),
        body: 'changed the description',
        created_at: '2026-10-03T11:00:00.000Z',
        path: null,
        line: null,
        system: true,
      },
    ],
  },
];

const comment = (
  id: string,
  accountId: string,
  displayName: string,
  body: string,
  createdAt: string,
  markerId: string | null = null,
): TicketComment => ({
  id,
  author: person('fake-jira', accountId, displayName),
  body,
  created_at: createdAt,
  updated_at: null,
  marker_id: markerId,
  url: null,
});

const comments = (): CommentPage => ({
  // Newest first, as `listComments` answers.
  comments: [
    comment('10003', 'bot-account', 'Agentic', 'Workpad', '2026-10-04T08:00:00.000Z', 'workpad'),
    comment(
      '10002',
      JANE_TWO,
      'Jane Doe',
      'Totals per currency, please.',
      '2026-10-01T12:00:00.000Z',
    ),
    comment(
      '10001',
      JANE_ONE,
      'Jane Doe',
      'Could the export include totals?',
      '2026-10-01T09:00:00.000Z',
    ),
  ],
  total: 3,
});

interface Doubles {
  readonly listDiscussions?: () => Promise<readonly Discussion[]>;
  readonly listComments?: () => Promise<CommentPage>;
  readonly commentsRead?: boolean;
  readonly gitRedactor?: SecretRedactor;
  readonly ticketRedactor?: SecretRedactor;
  readonly git?: boolean;
}

const integrationsWith = (doubles: Doubles = {}) => {
  const audit = createMemoryAuditLog();
  const executor = createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog: audit,
    redactor: exactSecretRedactor([]),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: { now: () => NOW },
    idempotencyStore: createMemoryIdempotencyStore(),
  });
  const gitPort = {
    ref: GIT_REF,
    capabilities: () => ({}),
    listDiscussions: doubles.listDiscussions ?? (async () => discussions()),
  } as unknown as GitProviderPort;
  const ticketPort = {
    ref: TICKET_REF,
    capabilities: () => ({ commentsRead: doubles.commentsRead ?? true }),
    listComments: doubles.listComments ?? (async () => comments()),
  } as unknown as TaskManagementPort;
  return {
    audit,
    port: staticPipelineIntegrations({
      executor,
      git:
        doubles.git === false
          ? null
          : {
              port: gitPort,
              ref: GIT_REF,
              project: 'acme/api',
              redactor: doubles.gitRedactor ?? exactSecretRedactor([]),
            },
      taskManagement: {
        port: ticketPort,
        ref: TICKET_REF,
        redactor: doubles.ticketRedactor ?? exactSecretRedactor([]),
      },
      communication: null,
    }),
  };
};

const SUBJECT = {
  projectId: PROJECT,
  taskId: TASK,
  ticket: {
    provider: 'fake-jira',
    key: 'ACME-7',
    url: 'https://jira.example.test/browse/ACME-7',
  },
  mr: { iid: 12, url: 'https://gitlab.example.test/acme/api/-/merge_requests/12' },
};

const prompts = Object.fromEntries(
  agentRoleSchema.options.map((role) => [
    role,
    { role, version: '1', text: `You are the ${role}.` } satisfies RolePromptDefinition,
  ]),
) as Readonly<Record<string, RolePromptDefinition>>;

const skills: Readonly<Record<string, SkillDefinition>> = Object.fromEntries(
  [...new Set(Object.values(SKILLS_BY_ROLE).flat())].map((name) => [
    name,
    { name, version: '1', text: `# ${name}\n` },
  ]),
);

const request = (mr: typeof SUBJECT.mr | null = SUBJECT.mr): StageRunRequest =>
  ({
    runId: RUN,
    stage: {
      id: 'implementation',
      kind: 'agent',
      role: 'developer',
      produces: 'ImplementationNotes',
    },
    attempt: 1,
    task: {
      task: { id: TASK, projectId: PROJECT, mode: 'normal', ticket: SUBJECT.ticket },
      ticketSnapshot: null,
      mr,
      branch: null,
    },
    artifacts: [],
    settings: { projectId: PROJECT, config: {} },
    returnFeedback: null,
  }) as unknown as StageRunRequest;

interface LogLine {
  readonly level: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

const recordingLogger = (lines: LogLine[]): Logger => ({
  debug: (fields, message) => lines.push({ level: 'debug', fields, message }),
  info: (fields, message) => lines.push({ level: 'info', fields, message }),
  warn: (fields, message) => lines.push({ level: 'warn', fields, message }),
  error: (fields, message) => lines.push({ level: 'error', fields, message }),
});

const planWith = async (
  readConversation: ConversationReader,
  logger: Logger = silentLogger,
  mr: typeof SUBJECT.mr | null = SUBJECT.mr,
  available?: readonly PlatformToolName[],
) => {
  const { store } = await indexedFixtureVault();
  const planner = createStageRunPlanner({
    ...(available === undefined ? {} : { availablePlatformTools: available }),
    workspacePath: (taskId) => `/workspaces/${taskId}`,
    prompts: prompts as never,
    skills,
    boundSkills: async () => [],
    ciConfigLocation: async () => null,
    readConversation,
    nonce: { next: () => NONCE },
    contextPacks: createContextPackAssembler({ store, logger: silentLogger }),
    headPaths: (projectId) => store.readPathWitnesses(projectId),
    clock: { now: () => NOW },
    logger,
  });
  return planner.plan(request(mr));
};

const blocksOf = (prompt: string, kind: string) =>
  readDataBlocks(prompt).blocks.filter((block) => block.kind === kind);

describe('the conversation in every agent stage’s prompt (WP-180)', () => {
  it('(1) holds entries from the merge request and the ticket, the platform’s notes labelled, system notes left out', async () => {
    const { port } = integrationsWith();
    const plan = await planWith(createConversationReader({ integrations: port }));
    const entries = blocksOf(plan.spec.userPrompt, 'conversation');
    expect(entries.map((block) => block.attributes.source)).toEqual([
      'ticket',
      'ticket',
      'mr',
      'mr',
      'ticket',
    ]);
    // Oldest first.
    expect(
      entries.map((block) => block.attributes.thread_id ?? block.attributes.comment_id),
    ).toEqual(['10001', '10002', THREAD_DIFF, THREAD_BOT, '10003']);
    expect(entries.map((block) => block.attributes.platform)).toEqual([
      'false',
      'false',
      'false',
      'true',
      'true',
    ]);
    expect(entries.map((block) => block.body)).not.toContain('changed the description');
    for (const block of entries) {
      expect(block.attributes.omitted).toBe('0');
      expect(block.attributes.entries).toBe('5');
      expect(block.attributes.truncated).toBeUndefined();
    }
    expect(plan.spec.userPrompt).toContain('`conversation` blocks below');
  });

  it('(6) passes the stable handle and the display name separately: two people named alike keep two refs, and a path with a space reaches the prompt', async () => {
    const { port } = integrationsWith();
    const plan = await planWith(createConversationReader({ integrations: port }));
    const entries = blocksOf(plan.spec.userPrompt, 'conversation');
    const one = entries.find((block) => block.attributes.comment_id === '10001');
    const two = entries.find((block) => block.attributes.comment_id === '10002');
    expect(one?.attributes.author_ref).toMatch(/^a-[0-9a-f]{16}$/);
    expect(two?.attributes.author_ref).toMatch(/^a-[0-9a-f]{16}$/);
    // The canary: a ref derived from the display name would collapse the two onto one.
    expect(one?.attributes.author_ref).not.toBe(two?.attributes.author_ref);
    const authors = blocksOf(plan.spec.userPrompt, 'conversation_author');
    expect(
      authors
        .filter((block) => block.body === 'Jane Doe')
        .map((block) => block.attributes.author_ref),
    ).toEqual([one?.attributes.author_ref, two?.attributes.author_ref]);
    const diff = entries.find((block) => block.attributes.thread_id === THREAD_DIFF);
    expect(diff?.attributes.line).toBe('3');
    const paths = blocksOf(plan.spec.userPrompt, 'conversation_path');
    expect(paths.map((block) => [block.attributes.path_ref, block.body])).toEqual([
      [diff?.attributes.path_ref, 'docs/a b.md'],
    ]);
  });

  it('(2) a failed read gives a run without the block, and a named warning', async () => {
    const lines: LogLine[] = [];
    const { port } = integrationsWith({
      listComments: async () => {
        throw new IntegrationError('forbidden', 'fake-jira', 'the token may not read comments');
      },
    });
    const plan = await planWith(
      createConversationReader({ integrations: port }),
      recordingLogger(lines),
    );
    for (const kind of ['conversation', 'conversation_author', 'conversation_path']) {
      expect(blocksOf(plan.spec.userPrompt, kind), kind).toEqual([]);
    }
    expect(plan.spec.userPrompt).not.toContain('`conversation` blocks below');
    const warning = lines.find(
      (line) => line.level === 'warn' && line.message.includes('without its conversation blocks'),
    );
    expect(warning?.fields).toMatchObject({
      task_id: TASK,
      run_id: RUN,
      stage: 'implementation',
      source: 'ticket',
      error: 'IntegrationError',
    });
    // The warning names the read that failed (review round 1).
    expect(warning?.message).toContain("the ticket's comments could not be read");
  });

  it('(2) names the merge request when its discussions are the read that failed', async () => {
    const lines: LogLine[] = [];
    const { port } = integrationsWith({
      listDiscussions: async () => {
        throw new IntegrationError('unavailable', 'fake-git', 'the provider is down');
      },
    });
    await planWith(createConversationReader({ integrations: port }), recordingLogger(lines));
    const warning = lines.find((line) => line.level === 'warn' && line.fields.source !== undefined);
    expect(warning?.fields.source).toBe('mr');
    expect(warning?.message).toContain("the merge request's discussions could not be read");
  });

  it('(2) rethrows a read moved inside a transaction rather than swallowing it', async () => {
    await expect(
      planWith(async () => {
        throw new TransactionOpenError('the provider read "list_discussions"');
      }),
    ).rejects.toThrow(TransactionOpenError);
  });

  it('gives no block to a task with no merge request and no comment-reading binding', async () => {
    const { port, audit } = integrationsWith({ commentsRead: false });
    const plan = await planWith(
      createConversationReader({ integrations: port }),
      silentLogger,
      null,
    );
    expect(blocksOf(plan.spec.userPrompt, 'conversation')).toEqual([]);
    // Neither read was asked: the flag was, and there was no merge request.
    expect(audit.entries).toEqual([]);
  });

  it('(3) redacts a secret planted in a note, a name and a comment with each binding’s redactor', async () => {
    const { port } = integrationsWith({
      listDiscussions: async () => discussions(`token ${SECRET} leaked here`),
      listComments: async () => ({
        comments: [
          comment(
            '10009',
            JANE_ONE,
            `Jane ${JIRA_SECRET}`,
            `see ${JIRA_SECRET}`,
            '2026-10-01T09:00:00.000Z',
          ),
        ],
        total: 1,
      }),
      gitRedactor: exactSecretRedactor([{ name: 'gitlab_token', value: SECRET }]),
      ticketRedactor: exactSecretRedactor([{ name: 'jira_token', value: JIRA_SECRET }]),
    });
    const plan = await planWith(createConversationReader({ integrations: port }));
    expect(plan.spec.userPrompt).not.toContain(SECRET);
    expect(plan.spec.userPrompt).not.toContain(JIRA_SECRET);
    const bodies = blocksOf(plan.spec.userPrompt, 'conversation').map((block) => block.body);
    expect(bodies.some((body) => body.includes('[REDACTED') && body.includes('leaked here'))).toBe(
      true,
    );
    expect(bodies.some((body) => body.startsWith('see [REDACTED'))).toBe(true);
  });
});

describe('the bounds (WP-180 ruling (a), criterion (3))', () => {
  const redactor = exactSecretRedactor([]);
  const many = (count: number, body = 'x'): CommentPage => ({
    comments: Array.from({ length: count }, (_, index) =>
      comment(
        String(20_000 + index),
        `acct-${index}`,
        `Person ${index}`,
        `${body}${index}`,
        new Date(Date.parse('2026-09-01T00:00:00.000Z') + (count - index) * 60_000).toISOString(),
      ),
    ),
    total: count,
  });

  it(`keeps the newest ${CONVERSATION_MAX_ENTRIES} entries, oldest first, and says it cut`, () => {
    const conversation = conversationFrom({
      discussions: null,
      comments: { page: many(CONVERSATION_MAX_ENTRIES + 5), redactor },
    });
    expect(conversation?.entries).toHaveLength(CONVERSATION_MAX_ENTRIES);
    expect(conversation?.truncated).toBe(true);
    const ids =
      conversation?.entries.map((entry) => (entry.source === 'ticket' ? entry.commentId : '')) ??
      [];
    // The newest comment is index 0; the oldest kept is index 39, presented first.
    expect(ids[0]).toBe(String(20_000 + CONVERSATION_MAX_ENTRIES - 1));
    expect(ids.at(-1)).toBe('20000');
  });

  it(`keeps at most ${CONVERSATION_MAX_CHARS} characters of note text, cutting the first note that does not fit`, () => {
    const page: CommentPage = {
      comments: [
        comment('1', 'a', 'A', 'n'.repeat(20_000), '2026-10-02T00:00:00.000Z'),
        comment('2', 'b', 'B', 'o'.repeat(10_000), '2026-10-01T00:00:00.000Z'),
        comment('3', 'c', 'C', 'p'.repeat(10), '2026-09-30T00:00:00.000Z'),
      ],
      total: 3,
    };
    const conversation = conversationFrom({ discussions: null, comments: { page, redactor } });
    const lengths = conversation?.entries.map((entry) => entry.body.length);
    expect(lengths).toEqual([CONVERSATION_MAX_CHARS - 20_000, 20_000]);
    expect(conversation?.truncated).toBe(true);
  });

  it('is not truncated when everything fits, and is when the provider says the ticket holds more', () => {
    expect(
      conversationFrom({ discussions: null, comments: { page: many(3), redactor } })?.truncated,
    ).toBe(false);
    expect(
      conversationFrom({
        discussions: null,
        comments: { page: { ...many(3), total: 9 }, redactor },
      })?.truncated,
    ).toBe(true);
    expect(
      conversationFrom({
        discussions: null,
        comments: { page: { ...many(3), total: null }, redactor },
      })?.truncated,
    ).toBe(true);
  });

  it('answers null when no source was read, and an empty conversation when one was', () => {
    expect(conversationFrom({ discussions: null, comments: null })).toBeNull();
    expect(conversationFrom({ discussions: { items: [], redactor }, comments: null })).toEqual({
      entries: [],
      truncated: false,
    });
  });
});

describe('`get_conversation` answers the same entries as the block (criterion (4))', () => {
  it('in the same order, with the raw author, handle and path', async () => {
    const { port } = integrationsWith();
    const reader = createConversationReader({ integrations: port });
    const plan = await planWith(reader);
    const answer = conversationToolAnswer(await reader(SUBJECT));
    const blocks = blocksOf(plan.spec.userPrompt, 'conversation');
    expect(answer.available).toBe(true);
    expect(
      answer.entries.map((entry) => ('thread_id' in entry ? entry.thread_id : entry.comment_id)),
    ).toEqual(blocks.map((block) => block.attributes.thread_id ?? block.attributes.comment_id));
    expect(answer.entries.map((entry) => entry.body)).toEqual(blocks.map((block) => block.body));
    expect(answer.entries.map((entry) => entry.platform)).toEqual(
      blocks.map((block) => block.attributes.platform === 'true'),
    );
    const jane = answer.entries.find(
      (entry) => 'comment_id' in entry && entry.comment_id === '10001',
    );
    expect(jane).toMatchObject({ author: 'Jane Doe', author_handle: JANE_ONE, path: null });
    const diff = answer.entries.find(
      (entry) => 'thread_id' in entry && entry.thread_id === THREAD_DIFF,
    );
    expect(diff).toMatchObject({
      author: 'Sam Reviewer',
      author_handle: '1201',
      path: 'docs/a b.md',
      line: 3,
    });
  });

  it('says unavailable, with no entries, for a task with nothing to read', () => {
    expect(conversationToolAnswer(null)).toEqual({
      available: false,
      entries: [],
      truncated: false,
    });
  });
});

describe('`get_conversation` is every role’s (ruling (c))', () => {
  it.each(agentRoleSchema.options)('%s is given it', (role) => {
    expect(PLATFORM_TOOLS_BY_ROLE[role]).toContain('get_conversation');
  });
});

describe('review round 1', () => {
  it('(3) omits and counts an entry whose id carries a planted secret, rather than quoting a redacted id', async () => {
    const planted = discussions();
    const bad = { ...planted[0], id: SECRET } as Discussion;
    const { port } = integrationsWith({
      listDiscussions: async () => [bad, ...planted.slice(1)],
      gitRedactor: exactSecretRedactor([{ name: 'gitlab_token', value: SECRET }]),
    });
    const plan = await planWith(createConversationReader({ integrations: port }));
    expect(plan.spec.userPrompt).not.toContain(SECRET);
    const entries = blocksOf(plan.spec.userPrompt, 'conversation');
    expect(entries.map((block) => block.attributes.thread_id).filter(Boolean)).toEqual([
      THREAD_BOT,
    ]);
    for (const block of entries) {
      expect(block.attributes.omitted).toBe('1');
    }
  });

  it('(3) omits and counts a ticket comment whose id carries a planted secret (review round 2)', () => {
    const page: CommentPage = {
      comments: [
        comment(SECRET, 'a', 'A', 'please rename it', '2026-10-02T00:00:00.000Z'),
        comment('2', 'b', 'B', 'and the docs too', '2026-10-01T00:00:00.000Z'),
      ],
      total: 2,
    };
    const conversation = conversationFrom({
      discussions: null,
      comments: {
        page,
        redactor: exactSecretRedactor([{ name: 'jira_token', value: SECRET }]),
      },
    });
    // The reader redacts the id; the domain then refuses the redacted id at the marker and counts
    // it, so the comment is left out rather than quoted under a placeholder.
    expect(JSON.stringify(conversation)).not.toContain(SECRET);
    if (conversation === null) throw new Error('expected a conversation');
    const blocks = conversationBlocks(conversation).filter(
      (block) => block.kind === 'conversation',
    );
    expect(blocks.map((block) => block.body)).toEqual(['and the docs too']);
    for (const block of blocks) {
      expect(block.attributes?.omitted).toBe(1);
    }
  });

  it('(5) never splits a surrogate pair at the character bound', () => {
    expect(cutAtCodePoint('ab\u{1F600}', 3)).toBe('ab');
    expect(cutAtCodePoint('ab\u{1F600}', 4)).toBe('ab\u{1F600}');
    expect(cutAtCodePoint('abc', 0)).toBe('');
    const page: CommentPage = {
      comments: [
        comment('1', 'a', 'A', 'n'.repeat(20_000), '2026-10-02T00:00:00.000Z'),
        comment(
          '2',
          'b',
          'B',
          `${'o'.repeat(CONVERSATION_MAX_CHARS - 20_001)}\u{1F600}tail`,
          '2026-10-01T00:00:00.000Z',
        ),
      ],
      total: 2,
    };
    const conversation = conversationFrom({
      discussions: null,
      comments: { page, redactor: exactSecretRedactor([]) },
    });
    const cut = conversation?.entries[0]?.body ?? '';
    expect(cut).toHaveLength(CONVERSATION_MAX_CHARS - 20_001);
    expect(cut.endsWith('o')).toBe(true);
  });

  it('a stage run whose build does not perform get_conversation is not given it, and still gets the blocks', async () => {
    const { port } = integrationsWith();
    const plan = await planWith(
      createConversationReader({ integrations: port }),
      silentLogger,
      SUBJECT.mr,
      ['report_progress', 'kb_search', 'get_task_context', 'open_mr', 'update_mr_description'],
    );
    expect(plan.spec.platformTools).not.toContain('get_conversation');
    // The blocks still reach the prompt: the conversation is read for the prompt, not the tool.
    expect(blocksOf(plan.spec.userPrompt, 'conversation').length).toBeGreaterThan(0);
  });
});
