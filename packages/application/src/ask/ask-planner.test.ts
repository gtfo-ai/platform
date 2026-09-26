/**
 * The `RunSpec` an ask is started with (WP-31).
 *
 * `ask.test.ts` drives the planner through the composed pipeline, which is where "an ask is a run
 * with no stage" is a claim about the product. This file drives it **directly**, because three of
 * its decisions are not observable from there: what the prompt says when the knowledge base has
 * never been indexed (a different sentence from an empty pack — the distinction `kb_search` and
 * `ContextPackResult` already draw), what the record blocks look like when the task has no runs and
 * no human actions, and which model and cap the project's own `features.ask` chooses.
 */
import type { AgentRole, Id, IsoDateTime } from '@platform/contracts';
import { DEFAULT_ASK_BUDGET_USD, DEFAULT_ASK_MODEL, readDataBlocks } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { ContextPackAssembler } from '../knowledge/context-pack.js';
import { defaultProjectSettings } from '../pipeline/settings.js';
import type { StoredArtifact, StoredTask } from '../pipeline/store.js';
import { createAskRunPlanner } from './planner.js';
import type { AskAuditLine, AskRunLine, StoredAsk } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const RUN = '00000000-0000-4000-8000-0000000000d1' as Id;
const NONCE = '0123456789abcdef0123456789abcdef';

const prompts = Object.fromEntries(
  ['ask'].map((role) => [role, { role, version: '1', text: 'You are the Ask agent.' }]),
) as Readonly<Record<AgentRole, { role: string; version: string; text: string }>>;

/** `SKILLS_BY_ROLE.ask` is `['kb']`; the planner refuses a catalogue that cannot answer a name. */
const skills = { kb: { name: 'kb', version: '1', text: '# kb\n' } };

const notIndexed: ContextPackAssembler = {
  assemble: async () => ({ status: 'not_indexed' }) as never,
};

const task = (): StoredTask =>
  ({
    task: {
      id: TASK,
      projectId: PROJECT,
      ticket: { provider: 'jira', key: 'ACME-1', url: 'https://jira.example.test/browse/ACME-1' },
      template: 'feature',
      mode: 'normal',
      state: 'active',
      currentStage: 'implementation',
      stageAttempts: {},
      iterationCounters: {},
      sequence: 1,
    },
    template: { id: 'feature', stages: [] },
    priorityRank: 1,
    createdAt: '2026-06-01T09:00:00.000Z',
    branch: null,
    mr: null,
    workpad: null,
    costActualUsd: 0,
    estimateUsd: null,
    estimateBasis: null,
    estimateSamples: null,
    ticketSnapshot: null,
    ticketSnapshotAt: null,
    reviewSubject: null,
    historySample: null,
    version: 1,
  }) as unknown as StoredTask;

const ask = (question = 'why a column?'): StoredAsk =>
  ({
    id: '00000000-0000-4000-8000-0000000000e1',
    taskId: TASK,
    projectId: PROJECT,
    source: 'ui',
    askedByUserId: '00000000-0000-4000-8000-0000000000f1',
    askedByIdentity: null,
    ticketCommentId: null,
    question,
    runId: null,
    status: 'pending',
    answer: null,
    citations: [],
    droppedCitations: 0,
    answerArtifactId: null,
    refusalReason: null,
    redactionCount: 0,
    mirroredAt: null,
    createdAt: '2026-06-01T09:00:00.000Z',
    answeredAt: null,
  }) as unknown as StoredAsk;

const plan = async (input: {
  readonly config?: Record<string, unknown>;
  readonly runs?: readonly AskRunLine[];
  readonly audit?: readonly AskAuditLine[];
  readonly artifacts?: readonly StoredArtifact[];
  readonly question?: string;
}) => {
  const planner = createAskRunPlanner({
    workspacePath: (taskId: Id) => `/workspaces/${taskId}`,
    prompts: prompts as never,
    skills,
    nonce: { next: () => NONCE },
    contextPacks: notIndexed,
    headPaths: async () => null,
    clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
  });
  return planner.plan({
    runId: RUN,
    ask: ask(input.question),
    task: task(),
    settings: defaultProjectSettings(PROJECT, {
      config: (input.config ?? {}) as never,
    }),
    artifacts: input.artifacts ?? [],
    runs: input.runs ?? [],
    audit: input.audit ?? [],
    askedByLabel: 'ada-lovelace',
  });
};

describe('the ask run plan', () => {
  it('belongs to no stage, runs the ask role and must return an AskAnswer', async () => {
    const { spec } = await plan({});
    expect(spec.stage).toBeNull();
    expect(spec.role).toBe('ask');
    expect(spec.mode).toBe('ask');
    expect(spec.attempt).toBe(1);
    expect(spec.artifactType).toBe('AskAnswer');
    expect(spec.tools).toEqual([]);
    expect(spec.platformTools).toEqual(['get_task_context', 'kb_search']);
    expect(spec.skills).toEqual(['agentic:kb']);
  });

  it('takes the model and the cap from the project, and the platform defaults when it chose none', async () => {
    const shipped = await plan({});
    expect(shipped.spec.model).toBe(DEFAULT_ASK_MODEL);
    expect(shipped.spec.limits.maxBudgetUsd).toBe(DEFAULT_ASK_BUDGET_USD);

    const chosen = await plan({
      config: { features: { ask: { model: 'claude-opus-5', budget_usd: 1.25 } } },
    });
    expect(chosen.spec.model).toBe('claude-opus-5');
    expect(chosen.spec.limits.maxBudgetUsd).toBe(1.25);
  });

  it('says the knowledge base has not been indexed, which is not the same as an empty pack', async () => {
    // A model told "no knowledge" concludes the project has none; one told "the index has not been
    // built" can say so to the human who asked.
    const { spec, contextPack } = await plan({});
    expect(spec.userPrompt).toContain('has **not been indexed**');
    expect(spec.contextPack).toEqual([]);
    expect(contextPack.tier0).toEqual([]);
    expect(contextPack.total_tokens).toBe(0);
  });

  it('renders the record it was given, and says so when there is none', async () => {
    const empty = readDataBlocks((await plan({})).spec.userPrompt).blocks.filter(
      (block) => block.kind === 'record',
    );
    expect(empty.map((block) => [block.attributes.record, block.body])).toEqual([
      ['runs', '(this task has no runs)'],
      ['human_actions', '(no human action has been recorded on this task)'],
    ]);

    const filled = readDataBlocks(
      (
        await plan({
          runs: [
            {
              runId: RUN,
              stage: 'architecture',
              role: 'architect',
              mode: 'normal',
              attempt: 2,
              model: 'claude-opus-5',
              status: 'completed',
              terminalReason: 'success',
              costUsd: 0.42,
              createdAt: '2026-06-01T08:00:00.000Z' as IsoDateTime,
            },
            {
              runId: '00000000-0000-4000-8000-0000000000d2' as Id,
              // The stage-less run this feature creates — rendered as `(none)` rather than blank.
              stage: null,
              role: 'ask',
              mode: 'ask',
              attempt: 1,
              model: 'claude-sonnet-5',
              status: 'failed',
              terminalReason: null,
              costUsd: 0,
              createdAt: '2026-06-01T08:30:00.000Z' as IsoDateTime,
            },
          ],
          audit: [
            {
              id: '00000000-0000-4000-8000-0000000000f2' as Id,
              action: 'task.pause',
              userId: '00000000-0000-4000-8000-0000000000f1' as Id,
              params: { reason: 'waiting on the API team' },
              createdAt: '2026-06-01T08:45:00.000Z' as IsoDateTime,
            },
            {
              id: '00000000-0000-4000-8000-0000000000f3' as Id,
              action: 'task.resume',
              // A row whose actor is gone (`on delete set null`) — named, never blank.
              userId: null,
              params: {},
              createdAt: '2026-06-01T08:50:00.000Z' as IsoDateTime,
            },
          ],
        })
      ).spec.userPrompt,
    ).blocks.filter((block) => block.kind === 'record');

    expect(filled[0]?.attributes.rows).toBe('2');
    expect(filled[0]?.body).toContain('stage: architecture');
    expect(filled[0]?.body).toContain('(success)');
    expect(filled[0]?.body).toContain('stage: (none)');
    // A terminal reason the run does not have leaves no empty parenthesis behind.
    expect(filled[0]?.body).not.toContain('()');
    expect(filled[1]?.attributes.rows).toBe('2');
    expect(filled[1]?.body).toContain('waiting on the API team');
    expect(filled[1]?.body).toContain('(unknown)');
  });

  it('puts the question in a block and never in the platform’s own voice', async () => {
    const { spec } = await plan({ question: 'why did you skip the rebase?' });
    const reading = readDataBlocks(spec.userPrompt);
    expect(reading.blocks.find((block) => block.kind === 'ask_question')?.body).toBe(
      'why did you skip the rebase?',
    );
    expect(reading.platformVoice.join('\n')).not.toContain('why did you skip the rebase?');
    expect(reading.unterminated).toBe(0);
  });

  it('carries the artifacts the answer may cite, minus the ones a prompt never carries', async () => {
    const artifacts = [
      {
        id: '00000000-0000-4000-8000-000000000101' as Id,
        taskId: TASK,
        type: 'ImplementationPlan' as const,
        version: 2,
        markdown: null,
        data: { approach: 'a column' },
        schemaVersion: '1',
        producedByRunId: RUN,
        createdAt: '2026-06-01T08:00:00.000Z' as IsoDateTime,
      },
      {
        id: '00000000-0000-4000-8000-000000000102' as Id,
        taskId: TASK,
        // A previous ask's answer: excluded here for the same reason it is excluded from a stage's
        // prompt (`PROMPT_EXCLUDED_ARTIFACT_TYPES`).
        type: 'AskAnswer' as const,
        version: 1,
        markdown: null,
        data: { answer: 'an earlier answer' },
        schemaVersion: '1',
        producedByRunId: RUN,
        createdAt: '2026-06-01T08:10:00.000Z' as IsoDateTime,
      },
    ] as unknown as readonly StoredArtifact[];
    const blocks = readDataBlocks((await plan({ artifacts })).spec.userPrompt).blocks.filter(
      (block) => block.kind === 'artifact',
    );
    expect(blocks.map((block) => block.attributes.artifact_type)).toEqual(['ImplementationPlan']);
  });

  it('bounds the run to one question: a turn limit and the per-question cap', async () => {
    const { spec } = await plan({});
    expect(spec.limits.maxTurns).toBe(12);
    expect(spec.effort).toBe('medium');
    expect(spec.resumeSessionId).toBeNull();
    expect(spec.protectedPaths).toEqual([]);
    expect(spec.providerMode).toBe('api');
  });
});
