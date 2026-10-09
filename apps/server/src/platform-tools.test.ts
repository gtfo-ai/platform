/**
 * The production `PlatformToolPort`, over **every** name in `PLATFORM_TOOL_NAMES`.
 *
 * Parameterised over the set rather than over the tools somebody remembered (standing rule 68), and
 * asserted in **both** directions (rule 42): the four that are not composed must refuse by name,
 * and the six that are must not — a port that threw for everything would pass the first half.
 *
 * It also keeps {@link IMPLEMENTED_PLATFORM_TOOLS} honest, which matters because that constant is a
 * *claim about this file* and standing rule 11 is about justifications that name something which
 * does not hold.
 */

import type {
  PlatformToolContext,
  PlatformToolName,
  PlatformToolPort,
  RunProgressRecorder,
  RunProgressReport,
} from '@platform/application';
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  exactSecretRedactor,
  IntegrationError,
  MUTATING_PLATFORM_TOOLS,
  PLATFORM_TOOL_NAMES,
  RunProgressUnavailableError,
  silentLogger,
  staticPipelineIntegrations,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { PROGRESS_SUMMARY_MAX_CHARS } from '@platform/contracts';
import { runner as runnerAdapters } from '@platform/infrastructure';
import { createFakeGitProvider, createFakeTaskManagement } from '@platform/integrations';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  ConversationUnavailableError,
  composePlatformTools,
  IMPLEMENTED_PLATFORM_TOOLS,
  PlatformToolUnavailableError,
} from './platform-tools.js';
import { readSource, withoutComments } from './routes/web-sources.js';

const CONTEXT: PlatformToolContext = {
  runId: '00000000-0000-4000-8000-0000000000d1' as Id,
  taskId: '00000000-0000-4000-8000-0000000000d2' as Id,
  projectId: '00000000-0000-4000-8000-0000000000d3' as Id,
  mode: 'normal',
  signal: new AbortController().signal,
};

/** The tool call each name makes, so the table below can be driven from `PLATFORM_TOOL_NAMES`. */
const CALL: Readonly<Record<PlatformToolName, (tools: PlatformToolPort) => Promise<unknown>>> = {
  ask_human: (tools) =>
    tools.askHuman({ question: 'which branch?', blocker_brief: 'two candidates' }, CONTEXT),
  notify_human: (tools) => tools.notifyHuman({ message: 'hello', severity: 'info' }, CONTEXT),
  report_progress: (tools) => tools.reportProgress({ summary: 'half way' }, CONTEXT),
  get_task_context: (tools) => tools.getTaskContext({ include: ['ticket'] }, CONTEXT),
  get_conversation: (tools) => tools.getConversation({}, CONTEXT),
  kb_search: (tools) => tools.kbSearch({ query: 'session service' }, CONTEXT),
  add_ticket_comment: (tools) => tools.addTicketComment({ body: 'done' }, CONTEXT),
  open_mr: (tools) =>
    tools.openMergeRequest(
      {
        title: 'Draft: x',
        description: 'y',
        source_branch: 'agentic/acme-1',
        target_branch: 'main',
        draft: true,
      },
      CONTEXT,
    ),
  update_mr_description: (tools) => tools.updateMrDescription({ description: 'y' }, CONTEXT),
  create_followup_ticket: (tools) =>
    tools.createFollowupTicket({ title: 'x', description: 'y' }, CONTEXT),
};

/**
 * A pool that refuses to be used.
 *
 * `composePlatformTools` must not touch the database at composition time — a process that opened a
 * connection while wiring would fail to boot against a database that is merely slow. The one tool
 * that *is* composed is asserted through the real store in
 * `test/e2e/pipeline/context-pack.e2e.test.ts`, which is where a claim about SQL belongs.
 */
const refusingPool = {
  query: () => {
    throw new Error('the composition must not query at wiring time');
  },
} as unknown as pg.Pool;

/** A unit of work that refuses too: the merge-request tools' first step is a short transaction. */
const refusingUnitOfWork = {
  transaction: async () => {
    throw new Error('the merge-request tool reached its task read');
  },
};

describe('the production platform tools', () => {
  const tools = composePlatformTools({
    pool: refusingPool,
    logger: silentLogger,
    conversation: {
      integrations: staticPipelineIntegrations({
        executor: { execute: async () => Promise.reject(new Error('unreachable')) },
        git: null,
        taskManagement: null,
        communication: null,
      }),
    },
    mergeRequests: {
      unitOfWork: refusingUnitOfWork,
      tasks: {
        recordMergeRequest: async () => {
          throw new Error('unreachable: the task read refuses first');
        },
      },
      integrations: staticPipelineIntegrations({
        executor: { execute: async () => Promise.reject(new Error('unreachable')) },
        git: null,
        taskManagement: null,
        communication: null,
      }),
      runScopedSecrets: () => [],
    },
  });

  it('implements exactly what it claims to implement', () => {
    expect([...IMPLEMENTED_PLATFORM_TOOLS]).toEqual([
      'report_progress',
      'kb_search',
      'get_task_context',
      'open_mr',
      'update_mr_description',
      'get_conversation',
    ]);
    expect(PLATFORM_TOOL_NAMES).toContain('kb_search');
    expect(PLATFORM_TOOL_NAMES).toContain('get_task_context');
  });

  it.each(
    PLATFORM_TOOL_NAMES.filter(
      (name) => !(IMPLEMENTED_PLATFORM_TOOLS as readonly PlatformToolName[]).includes(name),
    ),
  )('refuses %s by name rather than returning an empty answer', async (name) => {
    await expect(CALL[name](tools)).rejects.toThrow(PlatformToolUnavailableError);
    await expect(CALL[name](tools)).rejects.toThrow(JSON.stringify(name));
  });

  /**
   * Backlog 476: the refusal is what the model reads back, so it is one short plain sentence; the
   * platform's own account of what is missing goes to the run log, on `missing`.
   */
  it('refuses in one short plain sentence, and keeps the detail for the log', async () => {
    const failure = (await CALL.notify_human(tools).catch((error: unknown) => error)) as
      | PlatformToolUnavailableError
      | undefined;
    expect(failure).toBeInstanceOf(PlatformToolUnavailableError);
    expect(failure?.message).toBe(
      '"notify_human" is not available in this build. Continue without it, and say in your artifact what you would have used it for.',
    );
    expect(failure?.message).not.toMatch(/SSE|aggregate|WP-\d+|sink/);
    expect(failure?.missing).toContain('SSE hub');
  });

  /**
   * Backlog 496: `report_progress` is composed. It writes through the progress door the runner puts
   * on the context — the run's own transcript door — and answers the model in one plain sentence.
   * Without a door (a composition with no runner behind it) it refuses in one plain sentence too.
   */
  it('records report_progress through the run’s own progress door, bounded, and answers in a sentence', async () => {
    const reports: RunProgressReport[] = [];
    const progress: RunProgressRecorder = {
      record: async (report) => {
        reports.push(report);
        return { recorded: true };
      },
    };
    await expect(
      tools.reportProgress(
        { summary: '  slice 1 pushed; writing the migration  ', percent_complete: 40 },
        { ...CONTEXT, progress },
      ),
    ).resolves.toBe('Progress recorded.');
    await expect(
      tools.reportProgress(
        { summary: 'x'.repeat(PROGRESS_SUMMARY_MAX_CHARS + 50) },
        {
          ...CONTEXT,
          progress,
        },
      ),
    ).resolves.toBe(
      `Progress recorded, shortened to its first ${PROGRESS_SUMMARY_MAX_CHARS} characters.`,
    );
    expect(reports).toEqual([
      { summary: 'slice 1 pushed; writing the migration', percentComplete: 40, truncated: false },
      { summary: 'x'.repeat(PROGRESS_SUMMARY_MAX_CHARS), percentComplete: null, truncated: true },
    ]);
    await expect(CALL.report_progress(tools)).rejects.toThrow(RunProgressUnavailableError);
    await expect(CALL.report_progress(tools)).rejects.not.toThrow(PlatformToolUnavailableError);
  });

  it('does not refuse kb_search — it reaches the store, which is what fails here', async () => {
    // The other direction of the boundary: this call gets past the refusal and dies in the pool
    // double, so "every tool throws" cannot masquerade as "five tools refuse".
    await expect(CALL.kb_search(tools)).rejects.toThrow('must not query at wiring time');
    await expect(CALL.kb_search(tools)).rejects.not.toThrow(PlatformToolUnavailableError);
  });

  /**
   * WP-54 (PROGRESS backlog 83): `get_task_context` is no longer a refusal. Like `kb_search`, it
   * gets past the refusal and dies in the pool double — its SQL, and that it answers **this**
   * task's rows and not another's, is `test/integration/server/task-context.integration.test.ts`.
   */
  it('does not refuse get_task_context — it reaches the projections', async () => {
    // drizzle wraps the pool's error: the message names the projection's own query on `tasks`, and
    // the cause is the pool double's refusal.
    const failure = await CALL.get_task_context(tools).catch((error: unknown) => error);
    expect(String((failure as Error).message)).toMatch(/^Failed query: select .* from "tasks"/);
    expect(((failure as Error).cause as Error).message).toContain('must not query at wiring time');
    await expect(CALL.get_task_context(tools)).rejects.not.toThrow(PlatformToolUnavailableError);
  });

  /**
   * WP-138: the two merge-request tools are composed, and they are the **only** mutating ones — a
   * ticket comment and a follow-up ticket from inside a run are still refused by name. Their
   * behaviour (the executor, the branch, the record) is `merge-request-tool.test.ts`'s.
   */
  it('composes exactly the two merge-request tools among the mutating ones', () => {
    expect(
      MUTATING_PLATFORM_TOOLS.filter((name) =>
        (IMPLEMENTED_PLATFORM_TOOLS as readonly PlatformToolName[]).includes(name),
      ),
    ).toEqual(['open_mr', 'update_mr_description']);
  });

  /**
   * The optional halves of the two composed reads reach their callee too (backlog 474): what the
   * prompt already holds and the artifact types asked for are passed to the projection, and an
   * explicit `draft` to the merge-request tool. Each still dies where the doubles refuse, which is
   * the proof the call got past the composition with the field in hand.
   */
  it('passes get_task_context’s prompt holdings and artifact types, and open_mr’s draft flag, through', async () => {
    const context: PlatformToolContext = {
      ...CONTEXT,
      promptHolds: {
        ticket: true,
        artifacts: [{ artifact_type: 'ImplementationPlan', version: 2 }],
      },
    };
    const failure = await tools
      .getTaskContext({ include: ['artifacts'], artifact_types: ['ImplementationPlan'] }, context)
      .catch((error: unknown) => error);
    expect(((failure as Error).cause as Error).message).toContain('must not query at wiring time');
    await expect(
      tools.openMergeRequest(
        { title: 'x', description: 'y', draft: false },
        { ...CONTEXT, redactor: exactSecretRedactor([]) },
      ),
    ).rejects.toThrow('the merge-request tool reached its task read');
  });

  it.each(['open_mr', 'update_mr_description'] as const)(
    'does not refuse %s — it reaches its task read',
    async (name) => {
      const context = { ...CONTEXT, redactor: exactSecretRedactor([]) };
      const call =
        name === 'open_mr'
          ? tools.openMergeRequest({ title: 'x', description: 'y' }, context)
          : tools.updateMrDescription({ description: 'y' }, context);
      await expect(call).rejects.toThrow('the merge-request tool reached its task read');
    },
  );
});

/**
 * **No production run is offered a tool this build refuses** (backlog 476; WP-180 review round 1).
 *
 * Since WP-181 the tool list is fixed by the production planners themselves (`run-planners.ts`),
 * and `run-planners.test.ts` plans a run through each and asserts the spec's `platformTools` — the
 * behaviour WP-180's review asked for. What is left to text is only that the composition root
 * builds its planners through those two functions and through nothing else: a direct
 * `createStageRunPlanner(`/`createAskRunPlanner(` call in `pipeline.ts` (comments stripped) would be
 * a planner whose tool list nobody fixed. An alias of either factory is not seen.
 */
describe('the composition root builds its planners only through the production planners', () => {
  const source = withoutComments(readSource('apps/server/src/pipeline.ts'));
  const count = (call: string): number => source.split(`${call}(`).length - 1;

  it.each([
    ['createProductionStagePlanner', 'createStageRunPlanner'],
    ['createProductionAskPlanner', 'createAskRunPlanner'],
  ])('composes %s once and never calls %s directly', (production, direct) => {
    expect(count(production)).toBe(1);
    expect(count(direct)).toBe(0);
  });
});

/**
 * WP-181 criterion (4), review round 1: `get_conversation` **through the MCP registration a run is
 * given** (`platformToolDefinitions`, the handler the SDK calls), over the **real** reader the tools
 * build (`createConversationReader`) and the fake tracker and fake git — no reader is injected, so a
 * composition that wired the tool to anything else fails here. The subject is the run's own task,
 * read off its row scoped to the run's project. A credential planted in a note and in a comment is
 * redacted by each binding's own redactor: the MCP runtime's redactor here is empty on purpose, so
 * nothing downstream of the reader can be what removed it.
 */
describe('get_conversation through the MCP registration (WP-181)', () => {
  const PLANTED = 'FAKE-planted-binding-token-0181';
  const GIT_PROJECT = 'acme/api';
  const NOTE_AT = '2026-10-08T09:00:00.000Z';
  const bindingRedactor = () => exactSecretRedactor([{ name: 'tracker_token', value: PLANTED }]);
  const noIntegrations = () =>
    staticPipelineIntegrations({
      executor: { execute: async () => Promise.reject(new Error('unreachable')) },
      git: null,
      taskManagement: null,
      communication: null,
    });

  const world = async (options: { readonly gitFails?: boolean } = {}) => {
    const git = createFakeGitProvider({
      integrationId: '00000000-0000-4000-8000-0000000001a1' as Id,
      projects: [{ path: GIT_PROJECT }],
    });
    const mr = await git.openMergeRequest({
      project: GIT_PROJECT,
      branch: 'agentic/fake-1',
      target: 'main',
      title: 'Draft: totals',
      description: '',
      draft: true,
      labels: [],
      reviewers: [],
      remove_source_branch: true,
    });
    git.addHumanDiscussion({
      project: GIT_PROJECT,
      iid: mr.ref.iid,
      authorId: 'user-1',
      text: `Please rotate ${PLANTED} before merging.`,
      createdAt: NOTE_AT,
    });
    const tracker = createFakeTaskManagement({
      integrationId: '00000000-0000-4000-8000-0000000001a2' as Id,
      tickets: [
        {
          key: 'FAKE-1',
          title: 'Totals are wrong',
          comments: [{ authorId: 'user-1', body: `The token was ${PLANTED}.`, createdAt: NOTE_AT }],
        },
      ],
    });
    const gitPort = options.gitFails
      ? ({
          ...git,
          listDiscussions: async () => {
            throw new IntegrationError('unavailable', 'fake-git', 'connection refused', {
              action: 'list_discussions',
            });
          },
        } as unknown as typeof git)
      : git;
    const integrations = staticPipelineIntegrations({
      executor: createIntegrationActionExecutor({
        egress: allowAnyIntegrationHost(),
        auditLog: createMemoryAuditLog(),
        redactor: exactSecretRedactor([]),
        timer: createVirtualTimer({ autoAdvance: true }),
        clock: { now: () => '2026-10-09T09:00:00.000Z' as IsoDateTime },
      }),
      git: { port: gitPort, ref: git.ref, project: GIT_PROJECT, redactor: bindingRedactor() },
      taskManagement: { port: tracker, ref: tracker.ref, redactor: bindingRedactor() },
      communication: null,
    });
    const queries: { text: string; values: unknown[] }[] = [];
    const pool = {
      query: async (text: string, values: unknown[]) => {
        queries.push({ text, values });
        return {
          rows: [
            {
              ticket_provider: tracker.ref.provider,
              ticket_key: 'FAKE-1',
              ticket_url: 'https://tickets.example.test/browse/FAKE-1',
              ticket_id: null,
              mr_ref: mr.ref,
            },
          ],
        };
      },
    } as unknown as pg.Pool;
    const tools = composePlatformTools({
      pool,
      logger: silentLogger,
      conversation: { integrations },
      mergeRequests: {
        unitOfWork: refusingUnitOfWork,
        tasks: { recordMergeRequest: async () => Promise.reject(new Error('unreachable')) },
        integrations,
        runScopedSecrets: () => [],
      },
    });
    const [definition] = runnerAdapters.platformToolDefinitions(
      { tools, context: CONTEXT, redactor: exactSecretRedactor([]), onCall: () => {} },
      ['get_conversation'],
    ) as unknown as {
      name: string;
      handler: (args: unknown, extra: unknown) => Promise<unknown>;
    }[];
    const call = async () => {
      const result = (await definition?.handler({}, {})) as {
        content: { text: string }[];
        isError?: boolean;
      };
      return { text: result.content.map((item) => item.text).join('\n'), isError: result.isError };
    };
    return { call, queries };
  };

  it('(4) answers the merge request’s note and the ticket’s comment, with the planted secret redacted', async () => {
    const { call, queries } = await world();
    const answer = await call();
    expect(answer.isError).not.toBe(true);
    expect(queries[0]?.values).toEqual([CONTEXT.taskId, CONTEXT.projectId]);
    expect(queries[0]?.text).toMatch(/where id = \$1 and project_id = \$2/);
    expect(answer.text).not.toContain(PLANTED);
    const body = JSON.parse(answer.text) as {
      available: boolean;
      entries: { source: string; body: string }[];
    };
    expect(body.available).toBe(true);
    expect(body.entries.map((entry) => entry.source).sort()).toEqual(['mr', 'ticket']);
    for (const entry of body.entries) {
      expect(entry.body).toContain('[REDACTED:integration:tracker_token]');
    }
  });

  it('answers a failed provider read in one plain sentence, never the provider’s detail', async () => {
    const { call } = await world({ gitFails: true });
    const answer = await call();
    expect(answer.isError).toBe(true);
    expect(answer.text).toBe(
      'get_conversation failed: The conversation could not be read just now. Use the conversation blocks in your prompt, and say in your artifact that the tool failed.',
    );
  });

  it('refuses a task outside the run’s project rather than reading another project’s conversation', async () => {
    const tools = composePlatformTools({
      pool: { query: async () => ({ rows: [] }) } as unknown as pg.Pool,
      logger: silentLogger,
      conversation: { integrations: noIntegrations() },
      mergeRequests: {
        unitOfWork: refusingUnitOfWork,
        tasks: { recordMergeRequest: async () => Promise.reject(new Error('unreachable')) },
        integrations: noIntegrations(),
        runScopedSecrets: () => [],
      },
    });
    const failure = await tools.getConversation({}, CONTEXT).catch((error: unknown) => error);
    expect((failure as Error).message).toMatch(/the run's own task is the only one it reads/);
    expect(failure).not.toBeInstanceOf(ConversationUnavailableError);
  });
});
