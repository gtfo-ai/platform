/**
 * **The production planners offer a run exactly the tools this build performs** — a behaviour, not
 * a spelling (WP-180's review, built at WP-181).
 *
 * Each case plans a real run through `createProductionStagePlanner` / `createProductionAskPlanner`
 * with the shipped role prompts and skills, and reads the tools off the `RunSpec` the runner would
 * register. The expected list is the role's `PLATFORM_TOOLS_BY_ROLE` row intersected with
 * `IMPLEMENTED_PLATFORM_TOOLS`, and the four this build refuses are asserted absent by name, so a
 * production planner that lost its tool list — through a spread, a renamed variable or a deleted
 * line — offers `ask_human` and fails here. `platform-tools.test.ts` holds that `pipeline.ts` builds
 * its planners only through these two.
 */
import type {
  ContextPackAssembler,
  PlatformToolName,
  StageRunRequest,
  StoredAsk,
  StoredTask,
} from '@platform/application';
import {
  defaultProjectSettings,
  PLATFORM_TOOLS_BY_ROLE,
  silentLogger,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { PLATFORM_SKILLS, ROLE_PROMPTS } from '@platform/prompts';
import { describe, expect, it } from 'vitest';
import { IMPLEMENTED_PLATFORM_TOOLS } from './platform-tools.js';
import { createProductionAskPlanner, createProductionStagePlanner } from './run-planners.js';

const PROJECT = '00000000-0000-4000-8000-0000000001b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000001c1' as Id;
const RUN = '00000000-0000-4000-8000-0000000001d1' as Id;
const NOW = '2026-10-09T09:00:00.000Z' as IsoDateTime;
const TICKET = {
  provider: 'jira-cloud',
  key: 'ACME-1',
  url: 'https://tickets.example.test/browse/ACME-1',
};

/** The four this build refuses: never offered to a production run. */
const REFUSED: readonly PlatformToolName[] = [
  'ask_human',
  'notify_human',
  'add_ticket_comment',
  'create_followup_ticket',
];

const notIndexed: ContextPackAssembler = {
  assemble: async () => ({ status: 'not_indexed' }) as never,
};

const shared = {
  workspacePath: (taskId: Id) => `/workspaces/${taskId}`,
  prompts: ROLE_PROMPTS,
  skills: PLATFORM_SKILLS,
  nonce: { next: () => '0123456789abcdef0123456789abcdef' },
  contextPacks: notIndexed,
  headPaths: async () => null,
  clock: { now: () => NOW },
  logger: silentLogger,
};

const expectedFor = (row: readonly PlatformToolName[]): PlatformToolName[] =>
  row.filter((tool) => (IMPLEMENTED_PLATFORM_TOOLS as readonly PlatformToolName[]).includes(tool));

describe('the production planners offer only the tools this build performs (WP-181)', () => {
  it('a developer stage run is offered its row minus the refused four, get_conversation included', async () => {
    const planner = createProductionStagePlanner({
      ...shared,
      boundSkills: async () => [],
      ciConfigLocation: async () => null,
      readConversation: async () => null,
    });
    const { spec } = await planner.plan({
      runId: RUN,
      stage: {
        id: 'implementation',
        kind: 'agent',
        role: 'developer',
        produces: 'ImplementationNotes',
      },
      attempt: 1,
      task: {
        task: { id: TASK, projectId: PROJECT, mode: 'normal', ticket: TICKET },
        ticketSnapshot: null,
        mr: null,
        branch: null,
      },
      artifacts: [],
      settings: { projectId: PROJECT, config: {} },
      returnFeedback: null,
    } as unknown as StageRunRequest);
    expect([...spec.platformTools]).toEqual(expectedFor(PLATFORM_TOOLS_BY_ROLE.developer));
    expect(spec.platformTools).toContain('get_conversation');
    for (const tool of REFUSED) {
      expect(spec.platformTools).not.toContain(tool);
    }
  });

  it('an ask is offered get_task_context, get_conversation and kb_search, and nothing refused', async () => {
    const planner = createProductionAskPlanner(shared);
    const { spec } = await planner.plan({
      runId: RUN,
      ask: {
        id: '00000000-0000-4000-8000-0000000001e1',
        taskId: TASK,
        projectId: PROJECT,
        source: 'ui',
        question: 'why a column?',
        status: 'pending',
        createdAt: NOW,
      } as unknown as StoredAsk,
      task: {
        task: {
          id: TASK,
          projectId: PROJECT,
          ticket: TICKET,
          template: 'feature',
          mode: 'normal',
          state: 'active',
          currentStage: 'implementation',
          stageAttempts: {},
          iterationCounters: {},
          sequence: 1,
        },
        template: { id: 'feature', stages: [] },
        branch: null,
        mr: null,
        ticketSnapshot: null,
      } as unknown as StoredTask,
      settings: defaultProjectSettings(PROJECT, { config: {} as never }),
      artifacts: [],
      runs: [],
      audit: [],
      askedByLabel: 'ada-lovelace',
    });
    expect([...spec.platformTools].sort()).toEqual(expectedFor(PLATFORM_TOOLS_BY_ROLE.ask).sort());
    expect([...spec.platformTools].sort()).toEqual([
      'get_conversation',
      'get_task_context',
      'kb_search',
    ]);
    for (const tool of REFUSED) {
      expect(spec.platformTools).not.toContain(tool);
    }
  });
});
