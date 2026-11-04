/**
 * **The run plan, stored and read back; the run's lifecycle on the offer** — WP-275a criteria 2–4
 * and WP-275b criteria 1 and 5, through the `stage.execute` job (TD-031's 2026-11-04 amendment).
 *
 * - the session runs the spec the planner returned, **read back** from `run_plans` — the model
 *   credential and a planted pattern-shaped value reach it byte-identical, while the readable
 *   record (`runs.user_prompt`) stores them redacted and counts them;
 * - a plan that cannot be read back is a terminal `not_started` naming why, never a run;
 * - a run's events follow the offer: `run.created`, `run.offered`, `run.claimed`, then `run.started`
 *   only at the CLI spawn marker — a launcher refusal and a stop before the marker have none.
 *
 * The harness's step-2 redactor is `exactSecretRedactor(commandSecrets)`, production's
 * `patternRedactor()` stand-in: the planted value is a commandSecret here so the redactor that
 * writes `runs.user_prompt` replaces it exactly as a gitleaks rule would, and the ticket is where it
 * is planted — untrusted text that reaches the prompt unredacted (the binding's own redactor here
 * knows nothing of it), which is the path a KB page and a prior artifact take too.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { RunPlanSealer } from '../ports/run-plan-sealer.js';
import { RunStartError } from '../ports/runner.js';
import { PROCEEDING_REFINED_SPEC } from '../testing/artifact-fixtures.js';
import {
  cannotStart,
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import { createTestRunPlanSealer } from '../testing/run-plans.js';
import type { NewRun } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';
/** Shaped past a real key's pattern with a hyphen after `FAKE` (engineering checklist 14). */
const MODEL_KEY = 'sk-ant-FAKE-model-credential-0123456789abcdef';
const PLANTED = 'FAKE-PLANTED-pattern-value-0123456789abcdef';

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000001',
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: {
        provider: 'fake-jira',
        key: 'ACME-1',
        url: 'https://jira.example.test/browse/ACME-1',
      },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

const ENVIRONMENT = {
  env: { ANTHROPIC_API_KEY: MODEL_KEY },
  secretEnvNames: ['ANTHROPIC_API_KEY'],
};

const harnessWith = (options: HarnessOptions = {}): PipelineHarness =>
  createPipelineHarness({
    projectId: PROJECT,
    runs: {
      refinement: {
        status: 'completed',
        terminalReason: 'success',
        costUsd: 0.2,
        structuredOutput: PROCEEDING_REFINED_SPEC,
      },
      architecture: cannotStart('the case is the refinement run'),
    },
    runEnvironment: ENVIRONMENT,
    commandSecrets: [{ name: 'planted_pattern', value: PLANTED }],
    taskManagement: {
      readTicket: async (ref) => ({
        ref,
        issue_type: 'Story',
        title: 'Show the totals in the invoice footer',
        description: `The footer sums the visible rows. The staging token is ${PLANTED} — do not ship it.`,
        status: 'To Do',
        priority: null,
        labels: [],
        comments: [],
        links: [],
        epic: null,
        siblings: [],
        attachments_text: [],
        assignee: null,
        reporter: null,
        updated_at: '2026-06-01T09:00:00.000Z',
      }),
    },
    ...options,
  });

/** The `runs.insert` rows, captured — the prompt columns are write-only on the port. */
const capturingInserts = (harness: PipelineHarness): NewRun[] => {
  const inserted: NewRun[] = [];
  const repository = harness.store.runs as { insert: typeof harness.store.runs.insert };
  const original = repository.insert.bind(harness.store.runs);
  repository.insert = async (tx, run) => {
    inserted.push(run);
    await original(tx, run);
  };
  return inserted;
};

const runEventsOf = (harness: PipelineHarness, runId: string): string[] =>
  harness
    .events()
    .filter((entry) => (entry.payload as { run_id?: string }).run_id === runId)
    .map((entry) => entry.type);

const firstRunId = (harness: PipelineHarness): Id =>
  harness.events().find((entry) => entry.type === 'run.created')?.payload.run_id as Id;

describe('the session runs from the stored plan (WP-275a criterion 3)', () => {
  it('hands the session the planned spec byte-identical — the credential and a planted value too', async () => {
    const harness = harnessWith();
    const inserted = capturingInserts(harness);
    await harness.publish([ticketMatched()]);

    const [ran] = harness.specs;
    const planned = harness.plannedSpecs.find((spec) => spec.runId === ran?.runId);
    expect(ran).toBeDefined();
    expect(ran).toEqual(planned);
    // The model credential re-attached from the process's environment, byte-identical …
    expect(ran?.env.ANTHROPIC_API_KEY).toBe(MODEL_KEY);
    // … and the planted value reached the session's prompt unchanged — no false-positive damage.
    expect(ran?.userPrompt).toContain(PLANTED);
    expect(ran?.userPrompt).toBe(planned?.userPrompt);

    // The readable record is unchanged by the plan: redacted, and the replacement counted.
    const row = inserted.find((run) => run.id === ran?.runId);
    expect(row?.userPrompt).not.toContain(PLANTED);
    expect(row?.userPrompt).toContain('[REDACTED:integration:planted_pattern]');
    expect(row?.redactionCount).toBeGreaterThanOrEqual(1);
    // The plan's readable columns, and its seal cleared by the run's ending.
    const plan = await harness.memory.transaction(async (scope) =>
      harness.store.runPlans.load(scope.tx, ran?.runId as Id),
    );
    expect(plan?.secretEnvNames).toEqual(['ANTHROPIC_API_KEY']);
    expect(plan?.sealedSpec).toBeNull();
    // Nothing of either value reached the log.
    expect(JSON.stringify(harness.events())).not.toContain(MODEL_KEY);
    expect(JSON.stringify(harness.events())).not.toContain(PLANTED);
  });

  it('seals a plan with the secret value removed and the planted value kept, per run', async () => {
    const sealer = createTestRunPlanSealer();
    const seen: { runId: string; plaintext: string }[] = [];
    const recording: RunPlanSealer = {
      seal: (runId, plaintext) => {
        seen.push({ runId, plaintext });
        return sealer.seal(runId, plaintext);
      },
      open: sealer.open,
    };
    const harness = harnessWith({ runPlanSealer: recording });
    await harness.publish([ticketMatched()]);
    // One per run created: the refinement's, and the architecture run the case declares unstarted.
    expect(seen.map((entry) => entry.runId)).toEqual(
      harness
        .events()
        .filter((entry) => entry.type === 'run.created')
        .map((entry) => entry.payload.run_id),
    );
    expect(seen[0]?.plaintext).not.toContain(MODEL_KEY);
    expect(seen[0]?.plaintext).toContain(PLANTED);
    expect(JSON.parse(seen[0]?.plaintext ?? '{}')).toMatchObject({
      env: {},
      secretEnvNames: ['ANTHROPIC_API_KEY'],
    });
  });
});

describe('a plan that cannot be read back is a terminal not_started (WP-275a criterion 3)', () => {
  const refusedWith = async (options: HarnessOptions, reason: string) => {
    const harness = harnessWith({
      runs: { refinement: cannotStart('the plan cannot be read back, so no session starts') },
      ...options,
    });
    // `cannotStart` is asserted reached by the harness; it is the stage the plan refuses before.
    harness.script('refinement', { status: 'completed', terminalReason: 'success' });
    await harness.publish([ticketMatched()]);
    const runId = firstRunId(harness);
    const failed = harness.events().find((entry) => entry.type === 'run.failed');
    expect(failed?.payload).toMatchObject({
      terminal_reason: 'error_during_execution',
      start_failure: { kind: 'not_started', retryable: false },
    });
    const diagnosis = (failed?.payload as { start_failure?: { diagnosis?: string } } | undefined)
      ?.start_failure?.diagnosis;
    expect(diagnosis).toContain(reason);
    expect(harness.specs).toEqual([]);
    expect(runEventsOf(harness, runId)).toEqual([
      'run.created',
      'run.offered',
      'run.claimed',
      'run.failed',
    ]);
    expect(harness.types()).toContain('task.escalated');
  };

  it('is credential_unavailable when the claiming process has no value for a named secret', async () => {
    await refusedWith(
      { plannerEnvironment: ENVIRONMENT, runEnvironment: { env: {}, secretEnvNames: [] } },
      'credential_unavailable',
    );
  });

  it('is run_plan_unreadable when the seal does not open under this process’s key', async () => {
    const sealedUnderOld = createTestRunPlanSealer('test:run-plan:old');
    const holdingNew = createTestRunPlanSealer('test:run-plan:new');
    await refusedWith(
      { runPlanSealer: { seal: sealedUnderOld.seal, open: holdingNew.open } },
      'run_plan_unreadable',
    );
  });
});

describe('the run’s lifecycle follows the offer (WP-275b criteria 1 and 5)', () => {
  it('appends run.started only at the CLI spawn marker, after the claim', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    const runId = firstRunId(harness);
    expect(runEventsOf(harness, runId)).toEqual([
      'run.created',
      'run.offered',
      'run.claimed',
      'run.started',
      'run.finished',
    ]);
    const run = await harness.memory.transaction(async (scope) =>
      harness.store.runs.load(scope.tx, runId),
    );
    // `started_at` is the marker's instant, written with it.
    expect(run?.startedAt).toBe(run?.cliSpawnRequestedAt);
  });

  it('leaves a launcher refusal failed with no run.started and no started_at', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          throwsOnStart: new RunStartError('the launcher refused this spec', { retryable: false }),
        },
      },
    });
    await harness.publish([ticketMatched()]);
    const runId = firstRunId(harness);
    expect(runEventsOf(harness, runId)).toEqual([
      'run.created',
      'run.offered',
      'run.claimed',
      'run.failed',
    ]);
    const run = await harness.memory.transaction(async (scope) =>
      harness.store.runs.load(scope.tx, runId),
    );
    expect(run?.status).toBe('failed');
    expect(run?.startedAt).toBeNull();
  });

  it('leaves a run stopped before its marker (WP-154) with no run.started', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'cancelled',
          terminalReason: 'cancelled',
          reachesCli: false,
          stopReason: 'cancelled',
        },
      },
    });
    await harness.publish([ticketMatched()]);
    const runId = firstRunId(harness);
    expect(runEventsOf(harness, runId)).not.toContain('run.started');
    const ending = harness
      .events()
      .find((entry) => entry.type === 'run.finished' || entry.type === 'run.failed');
    expect(ending?.payload).toMatchObject({ status: 'cancelled' });
    const run = await harness.memory.transaction(async (scope) =>
      harness.store.runs.load(scope.tx, runId),
    );
    expect(run?.startedAt).toBeNull();
  });
});
