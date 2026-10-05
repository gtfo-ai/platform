/**
 * The production `PlatformToolPort`, over **every** name in `PLATFORM_TOOL_NAMES`.
 *
 * Parameterised over the set rather than over the tools somebody remembered (standing rule 68), and
 * asserted in **both** directions (rule 42): the five that are not composed must refuse by name,
 * and the four that are must not — a port that threw for everything would pass the first half.
 *
 * It also keeps {@link IMPLEMENTED_PLATFORM_TOOLS} honest, which matters because that constant is a
 * *claim about this file* and standing rule 11 is about justifications that name something which
 * does not hold.
 */

import type {
  PlatformToolContext,
  PlatformToolName,
  PlatformToolPort,
} from '@platform/application';
import {
  exactSecretRedactor,
  MUTATING_PLATFORM_TOOLS,
  PLATFORM_TOOL_NAMES,
  silentLogger,
  staticPipelineIntegrations,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  composePlatformTools,
  IMPLEMENTED_PLATFORM_TOOLS,
  PlatformToolUnavailableError,
} from './platform-tools.js';

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
      'kb_search',
      'get_task_context',
      'open_mr',
      'update_mr_description',
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
    const failure = (await CALL.report_progress(tools).catch((error: unknown) => error)) as
      | PlatformToolUnavailableError
      | undefined;
    expect(failure).toBeInstanceOf(PlatformToolUnavailableError);
    expect(failure?.message).toBe(
      '"report_progress" is not available in this build. Continue without it, and say in your artifact what you would have used it for.',
    );
    expect(failure?.message).not.toMatch(/TranscriptEvent|aggregate|WP-\d+|sink/);
    expect(failure?.missing).toContain('TranscriptEvent');
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
