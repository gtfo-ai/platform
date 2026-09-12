/**
 * The production `PlatformToolPort`, over **every** name in `PLATFORM_TOOL_NAMES`.
 *
 * Parameterised over the set rather than over the tools somebody remembered (standing rule 68), and
 * asserted in **both** directions (rule 42): the eight that are not composed must refuse by name,
 * and the one that is must not — a port that threw for everything would pass the first half.
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
import { MUTATING_PLATFORM_TOOLS, PLATFORM_TOOL_NAMES, silentLogger } from '@platform/application';
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

describe('the production platform tools', () => {
  const tools = composePlatformTools({ pool: refusingPool, logger: silentLogger });

  it('implements exactly what it claims to implement', () => {
    expect([...IMPLEMENTED_PLATFORM_TOOLS]).toEqual(['kb_search']);
    expect(PLATFORM_TOOL_NAMES).toContain('kb_search');
  });

  it.each(PLATFORM_TOOL_NAMES.filter((name) => !IMPLEMENTED_PLATFORM_TOOLS.includes(name)))(
    'refuses %s by name rather than returning an empty answer',
    async (name) => {
      await expect(CALL[name](tools)).rejects.toThrow(PlatformToolUnavailableError);
      await expect(CALL[name](tools)).rejects.toThrow(JSON.stringify(name));
    },
  );

  it('does not refuse kb_search — it reaches the store, which is what fails here', async () => {
    // The other direction of the boundary: this call gets past the refusal and dies in the pool
    // double, so "every tool throws" cannot masquerade as "eight tools refuse".
    await expect(CALL.kb_search(tools)).rejects.toThrow('must not query at wiring time');
    await expect(CALL.kb_search(tools)).rejects.not.toThrow(PlatformToolUnavailableError);
  });

  it('refuses every mutating tool, so a run cannot reach a provider through this build', () => {
    for (const name of MUTATING_PLATFORM_TOOLS) {
      expect(IMPLEMENTED_PLATFORM_TOOLS).not.toContain(name);
    }
  });
});
