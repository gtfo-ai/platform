/**
 * The stage executor's endings.
 *
 * The happy one is asserted by `saga.test.ts`, which walks a whole template through it. These are
 * the ones a template never reaches by itself: a run that overspends, a run whose cost the platform
 * could not read, a run that produced no artifact, and a job that arrives after the task has moved.
 */
import type { DomainEvent, Id, IsoDateTime, Slug } from '@platform/contracts';
import { domainEventSchemasByType, MAX_CONTEXT_BUDGET_TOKENS } from '@platform/contracts';
import { materialiseAutonomy, resolveIterationLimits } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { NO_HOLD } from '../cost/pending.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { describeStartFailure, RunStartError } from '../ports/runner.js';
import { WorkspaceError } from '../ports/workspace.js';
import { askingRefinedSpec, PROCEEDING_REFINED_SPEC } from '../testing/artifact-fixtures.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import {
  raiseTaskBudgetCommand,
  resumeTaskCommand,
  retryStageCommand,
  TaskBudgetNotRaisedError,
  TaskNotPausedByItsCapError,
} from './commands.js';
import { RUN_START_RETRY_MS } from './jobs.js';
import {
  COST_UNREPORTED,
  MAX_RUN_START_ATTEMPTS,
  REFREEZE_PENDING_SENTENCE,
  runBudgetUsd,
  taskBudgetDetail,
  taskBudgetExhausted,
  withPlatformReviewRecord,
} from './stage-executor.js';
import { type NewRun, TaskConcurrentModificationError } from './store.js';
import { MAX_TASK_CONFLICT_ATTEMPTS } from './task-conflict.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';

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

const DEFAULT_LIMITS = resolveIterationLimits();

const harnessWith = (options: HarnessOptions): PipelineHarness =>
  createPipelineHarness({ projectId: PROJECT, ...options });

const taskOf = (harness: PipelineHarness) => {
  const [stored] = harness.store.snapshot();
  if (stored === undefined) {
    throw new Error('no task was created');
  }
  return stored;
};

const escalationOf = (harness: PipelineHarness) =>
  harness.events().find((entry) => entry.type === 'task.escalated') as
    | Extract<DomainEvent, { type: 'task.escalated' }>
    | undefined;

/**
 * **TD-012's identifier refusal, at its ending rather than at the walker** (WP-52 round 2).
 *
 * `redactArtifactData`'s refusal is covered by `artifacts/redaction.test.ts`; what had **no** test
 * anywhere was what the executor *does* with it. The reviewer measured the hole: replacing the
 * catch below with a fail-open `redacted = { data: outcome.structuredOutput, count: 0 }` — the exact
 * defect this work package exists to close — left 2167 tests in 148 files green. So these two cases
 * are about the ending: nothing is stored, the run is recorded, the task escalates, and the brief a
 * human reads names the **field** and never the value.
 *
 * The planted secret goes in `kb_citations[].path`, which is a `RefinedSpec` identifier because the
 * platform resolves it against the project's vault — and `refinement` is the first stage, so the
 * case is one run long rather than a walk.
 */
describe('an artifact whose identifier carries a secret', () => {
  const SECRET = 'glpat-FAKEFAKEFAKEFAKEFAKE';

  const refusingHarness = (): PipelineHarness =>
    harnessWith({
      commandSecrets: [{ name: 'GIT_TOKEN', value: SECRET }],
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: {
            ...PROCEEDING_REFINED_SPEC,
            goal: 'ship the footer',
            kb_citations: [{ path: `knowledge/${SECRET}.md`, reason: 'the page' }],
          },
        },
      },
    });

  it('stores no artifact, records the run and escalates the task', async () => {
    const harness = refusingHarness();
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    expect(task.task.state).toBe('needs_human');
    // Nothing was written: `artifacts` is append-only, so a half-redacted row could not be fixed.
    const stored = await harness.memory.transaction(async (scope) =>
      harness.store.artifacts.listFor(scope.tx, task.task.id),
    );
    expect(stored).toEqual([]);
    expect(harness.types()).not.toContain('artifact.created');
    // `intake_check` completes before the agent stage is entered, so the assertion is on **this**
    // stage rather than on the event type (standing rule 10 — say which branch ran).
    expect(
      harness
        .events()
        .filter((entry) => entry.type === 'task.stage.completed')
        .map((entry) => (entry.payload as { stage: string }).stage),
    ).not.toContain('refinement');
    expect(task.task.currentStage).toBe('refinement');
    // …but the run is recorded, because it happened and it cost money.
    expect(harness.types()).toContain('run.finished');
    expect(task.costActualUsd).toBeGreaterThan(0);
  });

  it('names the field in the brief a human reads, and never the value', async () => {
    const harness = refusingHarness();
    await harness.publish([ticketMatched()]);

    const escalation = escalationOf(harness);
    expect(escalation?.payload.reason).toContain('kb_citations[].path');
    // Both directions (standing rule 42): the path is there **and** the credential is not — this
    // string reaches `events.payload` and the blocker brief, neither of which passes a redactor.
    const brief = JSON.stringify(escalation?.payload);
    expect(brief).not.toContain(SECRET);
  });

  it('is the identifier that refuses, not the artifact: the same secret in prose is redacted', async () => {
    // Standing rule 10 — assert which branch ran. Without this, "the task escalated" would be
    // satisfied by an executor that refused every artifact carrying a credential anywhere.
    // `decision: 'ask'` parks the task after this one stage, so the walk stops here rather than
    // reaching a stage with no script.
    const harness = harnessWith({
      commandSecrets: [{ name: 'GIT_TOKEN', value: SECRET }],
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: askingRefinedSpec(undefined, {
            goal: `ship the footer with ${SECRET}`,
            kb_citations: [{ path: 'knowledge/footer.md', reason: 'the page' }],
          }),
        },
      },
    });
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    expect(task.task.state).not.toBe('needs_human');
    const stored = await harness.memory.transaction(async (scope) =>
      harness.store.artifacts.listFor(scope.tx, task.task.id),
    );
    const data = JSON.stringify(stored[0]?.data);
    expect(data).not.toContain(SECRET);
    expect(data).toContain('[REDACTED:integration:GIT_TOKEN]');
    // The count is the row's own, and 0 would be the reading a redactor that never ran produces.
    expect(stored[0]?.redactionCount).toBe(1);
  });
});

/**
 * **The two prompt columns and the count beside them** (Q64, WP-52 round 2).
 *
 * The e2e asserts that the columns carry the bytes the CLI received; what it cannot assert is the
 * *arithmetic*, because on that tier every input to the prompt has already been redacted at its own
 * write and the honest count is therefore **0**. These cases drive the real planner and the real
 * executor and capture what `runs.insert` was handed, so both directions of criterion (2) are
 * asserted where a positive value is reachable.
 */
describe('the prompt a run was started with', () => {
  const capturedRun = (harness: PipelineHarness): Promise<NewRun[]> => {
    const rows: NewRun[] = [];
    const repository = harness.store.runs as { insert: typeof harness.store.runs.insert };
    const original = repository.insert.bind(harness.store.runs);
    repository.insert = async (tx, run) => {
      rows.push(run);
      await original(tx, run);
    };
    return harness.publish([ticketMatched()]).then(() => rows);
  };

  const scripted = {
    refinement: {
      status: 'completed' as const,
      terminalReason: 'success' as const,
      structuredOutput: askingRefinedSpec(undefined, { goal: 'ship the footer' }),
    },
  };

  it('stores the bytes the runner was handed, never a re-derivation', async () => {
    const harness = harnessWith({ runs: scripted });
    const rows = await capturedRun(harness);
    const spec = harness.specs[0];
    expect(spec, 'no run was started').toBeDefined();
    // **Identity with the spec, not merely similarity**: the delimiter nonce is drawn per prompt
    // and the pack is a point-in-time read, so a re-assembled prompt is a different document.
    expect(rows[0]?.systemPrompt).toBe(spec?.systemPromptAppend);
    expect(rows[0]?.userPrompt).toBe(spec?.userPrompt);
  });

  /**
   * **The pack is handed to the row's own insert, and it is the record `run.started` carries**
   * (WP-57, PROGRESS backlog 31). The SQL half — that the rows and the header land and read back —
   * is `test/integration/server/read-api.integration.test.ts` and the planner-built pack over HTTP is
   * `test/e2e/pipeline/context-pack.e2e.test.ts`; this case pins the seam between them: the
   * executor passes the plan's record, not `null` and not a re-assembly.
   */
  it('hands runs.insert the context pack run.started carries', async () => {
    const harness = harnessWith({ runs: scripted });
    const rows = await capturedRun(harness);
    const started = harness.events().find((entry) => entry.type === 'run.started') as
      | { payload: { run_id: string; context_pack: unknown } }
      | undefined;
    expect(started, 'no run.started').toBeDefined();
    expect(rows[0]?.id).toBe(started?.payload.run_id);
    expect(rows[0]?.contextPack).not.toBeNull();
    expect(rows[0]?.contextPack).toEqual(started?.payload.context_pack);
  });

  it('counts what it replaced, and 0 means the redactor ran and found nothing', async () => {
    // Criterion (2)'s first direction. Exact rather than `>= 0`, which a non-negative integer
    // column satisfies vacuously: a writer that double-counted would fail here.
    const clean = harnessWith({ runs: scripted });
    const cleanRows = await capturedRun(clean);
    expect(cleanRows[0]?.redactionCount).toBe(0);

    /**
     * The other direction, and the only way to reach it: something in the prompt that **no earlier
     * write has already redacted**. Every ordinary input is redacted upstream — the ticket snapshot
     * at WP-15f, a prior artifact at this very work package — so the planted value here is the
     * ticket's own **URL**, which `assemblePrompt` puts in the task block verbatim. Registering a
     * URL as a credential is artificial and is the point: it is the mechanism under test, driven
     * through the real planner, and nothing else in a first-stage prompt is un-redacted text the
     * platform can plant.
     */
    const planted = harnessWith({
      runs: scripted,
      commandSecrets: [{ name: 'GIT_TOKEN', value: 'https://jira.example.test/browse/ACME-1' }],
    });
    const plantedRows = await capturedRun(planted);
    expect(plantedRows[0]?.redactionCount).toBeGreaterThan(0);
    const both = `${plantedRows[0]?.systemPrompt ?? ''}\n${plantedRows[0]?.userPrompt ?? ''}`;
    // Both sides (standing rule 42): the value is gone **and** the placeholder is there.
    expect(both).not.toContain('https://jira.example.test/browse/ACME-1');
    expect(both).toContain('[REDACTED:integration:GIT_TOKEN]');
  });
});

describe('a run the platform stopped', () => {
  it('pauses the task when the run really did overspend', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'budget_exceeded',
          terminalReason: 'error_max_budget_usd',
          costUsd: 2.5,
          error: 'the platform stopped the run: budget_exceeded',
        },
      },
    });
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    expect(task.task.state).toBe('paused');
    expect(harness.types()).toContain('task.paused');
    // The spend is real, so it is counted.
    expect(task.costActualUsd).toBeCloseTo(2.5, 6);
    expect(escalationOf(harness)).toBeUndefined();
  });

  it('escalates when the platform could not tell what the run cost', async () => {
    // WP-12 publishes this fault *as* `budget_exceeded` / `error_max_budget_usd`, because the
    // terminal-reason enum has no name for it. Branching on the status alone would pause the task
    // and tell a human to raise a cap that was never reached.
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'budget_exceeded',
          terminalReason: 'error_max_budget_usd',
          costUsd: 0,
          stopReason: COST_UNREPORTED,
          error: 'the platform stopped the run: cost_unreported — …',
        },
      },
    });
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    expect(task.task.state).toBe('needs_human');
    expect(harness.types()).not.toContain('task.paused');
    const escalation = escalationOf(harness);
    expect(escalation?.payload.reason).toContain('could not tell what the run cost');
  });

  it('tells the two apart by the transcript row, not by the status', async () => {
    // Rule 10 as an experiment: the only difference between these two harnesses is the
    // `run_stopped` row, and the endings differ.
    const spec = {
      status: 'budget_exceeded' as const,
      terminalReason: 'error_max_budget_usd' as const,
      costUsd: 1,
    };
    const overspent = harnessWith({ runs: { refinement: spec } });
    const blind = harnessWith({ runs: { refinement: { ...spec, stopReason: COST_UNREPORTED } } });
    await overspent.publish([ticketMatched()]);
    await blind.publish([ticketMatched()]);
    expect(taskOf(overspent).task.state).toBe('paused');
    expect(taskOf(blind).task.state).toBe('needs_human');
  });

  it('escalates a run that failed, and does not retry it', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'failed',
          terminalReason: 'error_during_execution',
          error: 'the CLI exited with 1',
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(harness.specs).toHaveLength(1);
    expect(harness.types()).toContain('run.failed');
  });

  it('escalates a completed run that produced no artifact', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: null,
          deliberatelyInvalid: 'the executor escalates a missing artifact behind the runner',
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(escalationOf(harness)?.payload.reason).toContain('produced no artifact');
  });

  it('escalates a completed run whose artifact carries no verdict the platform knows', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: { ...PROCEEDING_REFINED_SPEC, decision: 'ship it' },
          deliberatelyInvalid:
            'the executor escalates a verdict it does not know behind the runner',
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(escalationOf(harness)?.payload.reason).toContain('"ship it"');
  });
});

/**
 * WP-63 criterion 4, the run half: an invalid repository `.agentic/config.yml` **refuses the run**
 * and parks the task, naming the key path — never runs on the settings alone. Both directions
 * (standing rule 42): the same settings with a `valid` or an `absent` reading run.
 */
describe('an invalid repository configuration', () => {
  it('refuses the run before it exists and escalates, naming the key path', async () => {
    const harness = harnessWith({
      settings: {
        repository: {
          status: 'invalid',
          commitSha: 'e'.repeat(40),
          detail: 'stages.refinement.max_turns (Invalid input: expected number, received string)',
        },
      },
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: askingRefinedSpec(),
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(harness.specs).toHaveLength(0);
    expect(taskOf(harness).task.state).toBe('needs_human');
    const reason = escalationOf(harness)?.payload.reason ?? '';
    expect(reason).toContain('stages.refinement.max_turns');
    expect(reason).toContain('.agentic/config.yml');
    expect(reason).toContain('e'.repeat(40));
  });

  it('runs on a valid or an absent reading', async () => {
    for (const status of ['valid', 'absent', 'unread'] as const) {
      const harness = harnessWith({
        settings: { repository: { status, commitSha: null, detail: null } },
        runs: {
          refinement: {
            status: 'completed',
            terminalReason: 'success',
            structuredOutput: askingRefinedSpec(),
          },
        },
      });
      await harness.publish([ticketMatched()]);
      expect(harness.specs.length, status).toBeGreaterThan(0);
    }
  });
});

/**
 * WP-106 (PROGRESS backlogs 311 and 354): the project's **stored** settings are parsed at every
 * read, and a document this release refuses **refuses the run by name at admission** — the key path,
 * the value and the `PUT` that fixes it, with its own outcome word — never planned on. WP-83's
 * context-budget ceiling (backlog 173) is folded into the same refusal.
 *
 * The harness parses the document at **every** reader, as production does, and a refused document
 * is answered (`configRefusal`) rather than thrown: so a ticket that arrives while the document is
 * broken still becomes a task (intake is an inbound notification, rule 20), and that task ends at
 * the named refusal instead of being lost (backlog 354). Both sides of each boundary (rule 42).
 */
describe('stored settings this release cannot parse', () => {
  const USER = '00000000-0000-4000-8000-0000000000e9' as Id;
  const refinementAsks = {
    refinement: {
      status: 'completed',
      terminalReason: 'success',
      structuredOutput: askingRefinedSpec(),
    },
  } as const;

  /**
   * The document is broken for the **stage executor's** read only, so what is observed is the
   * admission itself; the other readers' answers are the cases further down.
   */
  const admittedUnder = async (document: unknown) => {
    const harness = harnessWith({
      storedSettings: ({ job }) => (job === JOB_QUEUES.stageExecute ? document : { version: 1 }),
      runs: refinementAsks,
    });
    await harness.publish([ticketMatched()]);
    return harness;
  };

  it('refuses the run at admission by name, naming pipeline.wip and the PUT', async () => {
    const harness = await admittedUnder({
      version: 1,
      pipeline: { wip: { max_parallel_tasks: 500 } },
    });
    expect(harness.specs).toHaveLength(0);
    expect(taskOf(harness).task.state).toBe('needs_human');
    const reason = escalationOf(harness)?.payload.reason ?? '';
    expect(reason).toContain('pipeline.wip.max_parallel_tasks: 500');
    expect(reason).toContain('projects.config');
    expect(reason).toContain(`PUT /api/projects/${PROJECT}/config`);
    expect(harness.store.stageRows.find((row) => row.stage === 'refinement')?.outcome).toBe(
      'settings_config_invalid',
    );
  });

  it('refuses a context budget above the ceiling the same way, under the same word', async () => {
    const harness = await admittedUnder({
      version: 1,
      project: { context_budget_tokens: MAX_CONTEXT_BUDGET_TOKENS + 1 },
    });
    expect(harness.specs).toHaveLength(0);
    expect(escalationOf(harness)?.payload.reason).toContain(
      `project.context_budget_tokens: ${MAX_CONTEXT_BUDGET_TOKENS + 1}`,
    );
    expect(harness.store.stageRows.find((row) => row.stage === 'refinement')?.outcome).toBe(
      'settings_config_invalid',
    );
  });

  it('runs at exactly the ceiling and at a WIP limit the schema admits', async () => {
    for (const document of [
      { version: 1, project: { context_budget_tokens: MAX_CONTEXT_BUDGET_TOKENS } },
      { version: 1, pipeline: { wip: { max_parallel_tasks: 50 } } },
    ]) {
      const harness = await admittedUnder(document);
      expect(harness.specs, JSON.stringify(document)).toHaveLength(1);
      expect(escalationOf(harness)).toBeUndefined();
    }
  });

  /**
   * Backlog 354: with **every** reader meeting the broken document, as in production, the ticket
   * still becomes a task (intake fails open), marked to re-take its frozen values, and the first
   * step that would decide its next transition — intake's own completion — parks it by name.
   * Nothing is lost and nothing runs.
   */
  it('makes the ticket a task and parks it by name at intake when every reader meets the broken document', async () => {
    const harness = harnessWith({
      storedSettings: () => ({ version: 1, pipeline: { wip: { max_parallel_tasks: 500 } } }),
      runs: refinementAsks,
    });
    await harness.publish([ticketMatched()]);
    expect(harness.store.snapshot()).toHaveLength(1);
    expect(harness.specs).toHaveLength(0);
    const parked = taskOf(harness);
    expect(parked.task.state).toBe('needs_human');
    expect(parked.task.currentStage).toBe('intake');
    expect(parked.settingsRefreezePending).toBe(true);
    const escalated = escalationOf(harness);
    expect(escalated?.payload.reason).toContain('pipeline.wip.max_parallel_tasks: 500');
    expect(escalated?.payload.blocker_brief).toContain(`PUT /api/projects/${PROJECT}/config`);
    expect(escalated?.payload.blocker_brief).toContain(REFREEZE_PENDING_SENTENCE);
  });

  /**
   * WP-106 (migration 0066): the task created under the broken document froze the defaults'
   * iteration limits and dial. After the fix and a resume, the run's limits, the dial and the
   * stage's budget cap are the parsed document's, never the defaults.
   */
  it('re-takes the frozen limits and dial from the fixed document before the first run, and never runs on the defaults', async () => {
    const at = '2026-06-01T08:00:00.000Z' as IsoDateTime;
    // The dial the port answers: uncapped while the organisation document cannot be read, and
    // capped at Assist once it can (the production port's cap, `storedAutonomy`).
    let dial = materialiseAutonomy({ level: 'supervised', at, appliedBy: null });
    let document: unknown = { version: 1, pipeline: { wip: { max_parallel_tasks: 500 } } };
    const harness = harnessWith({
      storedSettings: () => document,
      storedAutonomy: () => dial,
      runs: refinementAsks,
    });
    await harness.publish([ticketMatched()]);
    const parked = taskOf(harness);
    expect(harness.specs).toHaveLength(0);
    expect(parked.settingsRefreezePending).toBe(true);
    expect(parked.task.limits.code_review).toBe(DEFAULT_LIMITS.code_review);
    expect(parked.pipelineDial?.level).toBe('supervised');

    // The operator fixes the document (and the organisation's cap reads again); a person resumes.
    document = {
      version: 1,
      pipeline: { limits: { code_review_iterations: 1, human_rounds: 1 } },
      stages: { refinement: { budget_usd: 1.5 } },
    };
    dial = materialiseAutonomy({ level: 'assist', at, appliedBy: null });
    await retryStageCommand(harness.humanCommands, {
      taskId: parked.task.id,
      userId: USER,
      stage: 'intake' as Slug,
    });
    await harness.drain();

    expect(harness.specs).toHaveLength(1);
    const resumed = taskOf(harness);
    expect(resumed.settingsRefreezePending).toBe(false);
    expect(resumed.task.limits.code_review).toBe(1);
    expect(resumed.task.limits.human_rounds).toBe(1);
    expect(resumed.pipelineDial).toMatchObject({
      level: 'assist',
      business_review: false,
      stop_after_stage: 'architecture',
    });
    expect(harness.specs[0]?.limits.maxBudgetUsd).toBe(1.5);
  });
});

describe('the task budget', () => {
  it('pauses before the run rather than after it', async () => {
    const harness = harnessWith({
      // Refinement's default cap is 2 USD (product/04's table), so a 1 USD task budget cannot
      // afford it and nothing is spent at all.
      settings: { taskBudgetUsd: 1 },
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: askingRefinedSpec(),
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('paused');
    expect(harness.specs).toHaveLength(0);
    expect(taskOf(harness).costActualUsd).toBe(0);
  });

  it('counts what this run may spend, not only what the task has spent', () => {
    const settings = { config: {}, taskBudgetUsd: 10 } as never;
    const stored = { costActualUsd: 9 } as never;
    // 9 spent + refinement's 2 USD cap is over 10, even though 9 is under it.
    expect(taskBudgetExhausted(stored, settings, 'refinement', NO_HOLD)).toBe(true);
    expect(
      taskBudgetExhausted({ costActualUsd: 7 } as never, settings, 'refinement', NO_HOLD),
    ).toBe(false);
  });

  it('takes the per-run cap from the project when it sets one', () => {
    const withOverride = {
      config: { stages: { refinement: { budget_usd: 0.5 } } },
      taskBudgetUsd: 50,
    } as never;
    expect(runBudgetUsd(withOverride, 'refinement')).toBe(0.5);
    expect(runBudgetUsd({ config: {} } as never, 'refinement')).toBe(2);
    // A stage product/04's table does not name still gets a cap rather than none.
    expect(runBudgetUsd({ config: {} } as never, 'security_scan')).toBe(5);
  });
});

/**
 * **A run that was created and could not be started** — WP-15c's Q52/Q60 decision.
 *
 * The production runner of every build until Q52 is answered throws from `start`
 * (`apps/server/src/pipeline.ts`'s `unavailableClaudeRunner`), and the day a webhook can reach the
 * pipeline is the day a real ticket meets it. Before this branch existed, the throw escaped both of
 * the executor's endings: transaction 1 had already written the `runs` row and emitted
 * `run.created`/`run.started`, so the run stayed `running` for ever, the task sat at its stage, and
 * the `stage.execute` job retried into pg-boss where no screen showed it (until WP-108).
 *
 * The answer is **no new task state**: `escalated` already means *a human must act*, and it is what
 * the executor does for every other run that ends without a usable result.
 */
describe('a run that could not be started', () => {
  class RunnerUnavailableForTest extends Error {
    override readonly name = 'RunnerUnavailableError';
  }

  const harnessThatCannotStart = (): PipelineHarness =>
    harnessWith({
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          throwsOnStart: new RunnerUnavailableForTest(
            'no ClaudeRunner is composed in this build (Q52) — FAKE-PLANTED-secret-0123456789',
          ),
        },
      },
    });

  it('escalates the task instead of leaving it at a stage nothing will move', async () => {
    const harness = harnessThatCannotStart();
    await harness.publish([ticketMatched()]);

    // `needs_human` is the task state `escalateTask` produces (technical/02's state machine); the
    // point of the decision is that it is an **existing** one, not a new "cannot start" state.
    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(escalationOf(harness)?.payload.reason).toContain('could not be started');
  });

  it('records the run it had already created as failed, rather than leaving it running', async () => {
    const harness = harnessThatCannotStart();
    await harness.publish([ticketMatched()]);

    const failed = harness.events().find((entry) => entry.type === 'run.failed');
    expect(
      failed,
      'the run row exists because transaction 1 wrote it; its failure is the honest record',
    ).toBeDefined();
    expect((failed as Extract<DomainEvent, { type: 'run.failed' }>).payload.terminal_reason).toBe(
      'error_during_execution',
    );
    // Nothing ran, so nothing was spent — and `is_estimate: false`, because "nothing" is measured.
    expect(taskOf(harness).costActualUsd).toBe(0);
  });

  /**
   * The **class name, never the message** (BD-022, TD-012): this string is written to
   * `events.payload` (`run.failed`) and into the escalation's blocker brief, and an error thrown out
   * of a runner may quote a provider, a URL or a credential. The executor holds no redactor, so the
   * only safe thing to carry is the name.
   */
  it('names the error class and carries no word of its message into the event log', async () => {
    const harness = harnessThatCannotStart();
    await harness.publish([ticketMatched()]);

    const serialised = JSON.stringify(harness.events());
    expect(serialised).toContain('RunnerUnavailableError');
    expect(serialised).not.toContain('FAKE-PLANTED-secret-0123456789');
    expect(serialised).not.toContain('no ClaudeRunner is composed');
  });
});

/**
 * **A start that failed for a *transport* reason** — Q59(a), decided on WP-15g.
 *
 * The section above is the terminal case and is unchanged. This is the other half: the runner reaches
 * its workspace over a Unix socket on a shared volume (TD-025 §2), so a launcher restarting is a
 * condition that is over in seconds — while escalation happens on the *first* failure, so a flapping
 * transport would park one task and need one human per flap.
 *
 * Both directions are asserted, because "it retries" and "the retry is bounded" are different claims
 * and a build with only the first is a build that hides a dead launcher (standing rule 42).
 */
describe('a run whose start failed for a transport reason', () => {
  const transportFailure = () =>
    new RunStartError(
      'the run shim did not answer on /run/agentic/ctl/<run>/ctl.sock — FAKE-PLANTED-secret-0123456789',
      { retryable: true },
    );

  const harnessThatFlaps = (): PipelineHarness =>
    harnessWith({
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          throwsOnStart: transportFailure(),
        },
      },
    });

  it('leaves the task at its stage and re-enqueues the stage on a timer', async () => {
    const harness = harnessThatFlaps();
    await harness.publish([ticketMatched()]);

    // Still running, still at refinement, still on attempt 1: exactly the state `revalidate` admits,
    // which is what makes the re-enqueue below a wake-up rather than a no-op.
    expect(taskOf(harness).task.state).toBe('active');
    expect(taskOf(harness).task.currentStage).toBe('refinement');
    expect(escalationOf(harness)).toBeUndefined();
    // The run really was created, so its failure is recorded rather than left `running` (WP-15c).
    expect(harness.types()).toContain('run.failed');

    const queued = harness.jobs.enqueued.filter((request) => request.queue === 'stage.execute');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.data).toMatchObject({ stage: 'refinement', start_attempts: 1 });
    // A delay, not a spin: `drain` ran every job whose timer had come and this one had not.
    expect(queued[0]?.startAfter?.getTime()).toBe(harness.clock.epochMs + RUN_START_RETRY_MS);
  });

  it('escalates once the attempts are spent, and not before', async () => {
    const harness = harnessThatFlaps();
    await harness.publish([ticketMatched()]);

    const attempts: string[] = [taskOf(harness).task.state];
    for (let round = 0; round < MAX_RUN_START_ATTEMPTS; round += 1) {
      harness.clock.advance(RUN_START_RETRY_MS);
      await harness.drain();
      attempts.push(taskOf(harness).task.state);
    }

    // Two retries after the first failure, then the third failure escalates: the bound is
    // `MAX_RUN_START_ATTEMPTS`, and the states show it rather than a single end assertion (rule 10).
    expect(attempts).toEqual(['active', 'active', 'needs_human', 'needs_human']);
    expect(escalationOf(harness)?.payload.reason).toContain('could not be started');
    // One failed `runs` row per flap — the signal an operator reads, and the reason the bound exists.
    expect(harness.types().filter((type) => type === 'run.failed')).toHaveLength(
      MAX_RUN_START_ATTEMPTS,
    );
    // Nothing is queued after the escalation: an unbounded retry would hide the dead launcher. Read
    // on the history, because the loop's last `drain` runs any retry that was due and takes it off
    // `enqueued` (WP-128, backlog 352): one stage job per start attempt — the first and its
    // retries — and none for the escalation.
    expect(
      harness.jobs.history.filter((request) => request.queue === 'stage.execute'),
    ).toHaveLength(MAX_RUN_START_ATTEMPTS);
  });

  it('treats a failure it cannot classify as terminal, and carries no message into the log', async () => {
    // The fail-closed default: only a `RunStartError` with `retryable: true` retries. A plain error
    // — a programming fault, a bad spec — escalates on the first failure.
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
    expect(taskOf(harness).task.state).toBe('needs_human');

    const flapping = harnessThatFlaps();
    await flapping.publish([ticketMatched()]);
    const serialised = JSON.stringify(flapping.events());
    expect(serialised).toContain('RunStartError');
    expect(serialised).not.toContain('FAKE-PLANTED-secret-0123456789');
    expect(serialised).not.toContain('ctl.sock');
  });
});

/**
 * **A start failure says why, in platform words** — WP-127, PROGRESS backlog 351.
 *
 * Before WP-127 a terminal `invalid_spec` — since WP-105, a shadow base missing from the mirror —
 * escalated as *"the run could not be started (RunStartError)"*, and the provider's comment that
 * the task escalates "with this sentence" was false. The ruling: the escalation carries the
 * workspace's error **kind** and a platform-chosen **reason code**, the commit only through
 * `shaSchema`, and the message stays in the log — so a planted secret in the message is absent.
 */
describe('a run refused by its workspace names the kind and the reason (WP-127)', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const PLANTED = 'FAKE-PLANTED-secret-wp127-0123456789';
  const refusal = (options: { readonly commit?: string } = {}) =>
    new RunStartError(`the run workspace could not be provisioned: WorkspaceError: ${PLANTED}`, {
      retryable: false,
      cause: new WorkspaceError(
        'invalid_spec',
        `the commit ${options.commit ?? SHA} this run must start from is not in the project's mirror — ${PLANTED}`,
        {
          reason: 'checkout_commit_missing',
          commit: options.commit ?? SHA,
          detail: PLANTED,
        },
      ),
    });

  const harnessRefusedWith = (error: Error): PipelineHarness =>
    harnessWith({
      runs: {
        refinement: { status: 'completed', terminalReason: 'success', throwsOnStart: error },
      },
    });

  it('escalates a terminal invalid_spec naming its kind, its reason code and the commit', async () => {
    const harness = harnessRefusedWith(refusal());
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).task.state).toBe('needs_human');
    const escalation = escalationOf(harness);
    const cause = `RunStartError: invalid_spec, checkout_commit_missing, commit ${SHA}`;
    expect(escalation?.payload.reason).toBe(
      `stage "refinement": the run could not be started (${cause})`,
    );
    expect(escalation?.payload.blocker_brief).toContain(cause);
    const failed = harness.events().find((entry) => entry.type === 'run.failed') as
      | Extract<DomainEvent, { type: 'run.failed' }>
      | undefined;
    expect(failed?.payload.error).toBe(`the run could not be started (${cause})`);
  });

  it('carries no word of the message or the detail, with a secret planted in both', async () => {
    const harness = harnessRefusedWith(refusal());
    await harness.publish([ticketMatched()]);

    const serialised = JSON.stringify(harness.events());
    expect(serialised).toContain('checkout_commit_missing');
    expect(serialised).not.toContain(PLANTED);
    expect(serialised).not.toContain('must start from');
  });

  /**
   * The canary for the sha rule: a "commit" that is not one is dropped at the constructor, so the
   * planted text never reaches the escalation even though the reason does.
   */
  it('drops a commit that is not a sha rather than carrying it', async () => {
    const harness = harnessRefusedWith(refusal({ commit: `${PLANTED} ; rm -rf /` }));
    await harness.publish([ticketMatched()]);

    expect(escalationOf(harness)?.payload.reason).toBe(
      'stage "refinement": the run could not be started (RunStartError: invalid_spec, checkout_commit_missing)',
    );
    expect(JSON.stringify(harness.events())).not.toContain(PLANTED);
  });

  it('re-reads a forged diagnosis through its schemas, so only closed vocabulary is written', () => {
    const forged = new RunStartError('x', {
      retryable: false,
      diagnosis: {
        kind: PLANTED as never,
        reason: PLANTED as never,
        commit: PLANTED,
      },
    });
    expect(describeStartFailure(forged)).toBe('RunStartError');
    expect(describeStartFailure(new WorkspaceError('engine_unavailable', PLANTED))).toBe(
      'WorkspaceError: engine_unavailable',
    );
    expect(describeStartFailure(new Error(PLANTED))).toBe('Error');
    expect(describeStartFailure(PLANTED)).toBe('unknown error');
  });
});

/**
 * **A write that lost every race** — WP-15e, criterion 4.
 *
 * `save` refuses a snapshot another transaction has moved, which is the whole of backlog 18's fix,
 * and a refusal with no ending is the same lost update wearing a stack trace. The executor owns its
 * transactions, so it owns the retry; when the bound is spent the task is parked for a human rather
 * than left at a stage whose run has already been paid for.
 *
 * The conflict is planted at the one site that raises `cost_actual` — transaction 2 — because that
 * is the write whose loss was measured (2.40 where 2.80 was owed) and because it leaves the
 * escalation's own save, which reads a task at cost 0, free to succeed.
 */
describe('a stage write that lost every race with another writer', () => {
  const harnessThatAlwaysConflicts = (): { harness: PipelineHarness; conflicts: () => number } => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          costUsd: 0.4,
          structuredOutput: askingRefinedSpec(),
        },
      },
    });
    /**
     * The in-memory store does not roll back (its divergence 4), and since WP-15i the executor's
     * `runs.finish` is **conditional on the run still being live** — so on the second attempt the
     * fake would answer "somebody else ended it" for a write this same transaction made and then
     * abandoned. A real database rolls that write back with the transaction; here the harness does
     * it, which is what keeps this case about the bound rather than about the fake. The conditional
     * write's own behaviour is asserted in `pipeline-store-concurrency-suite.ts`, against both.
     */
    const runRepository = harness.store.runs as { finish: typeof harness.store.runs.finish };
    const realFinish = runRepository.finish.bind(harness.store.runs);
    runRepository.finish = async (tx, outcome) => {
      await realFinish(tx, outcome);
      return true;
    };
    const repository = harness.store.tasks as {
      save: typeof harness.store.tasks.save;
    };
    const real = repository.save.bind(harness.store.tasks);
    let conflicts = 0;
    repository.save = async (tx, stored) => {
      /**
       * Every save carrying a run's spend, until the bound is spent — and then none.
       *
       * `costActualUsd > 0` alone was the discriminator until WP-31, because the *only* save that
       * carried spend was the executor's transaction 2 and the conflict escalation's own save read
       * a row whose `cost_actual` was still zero. That is no longer true: `addSpend` writes the
       * column in its own statement and the in-memory store does not roll one back (its divergence
       * 1), so the escalation would conflict for ever against a fake that never stopped. Bounding
       * the fake by the same constant the code is bounded by is what lets the escalation land, and
       * it keeps both halves of this pair assertable: the loop retried exactly `MAX` times rather
       * than giving up after one, and the ending it reached says *another writer won*.
       */
      if (conflicts < MAX_TASK_CONFLICT_ATTEMPTS && stored.costActualUsd > 0) {
        conflicts += 1;
        throw new TaskConcurrentModificationError(
          stored.task.id,
          stored.version,
          stored.version + 1,
        );
      }
      return real(tx, stored);
    };
    return { harness, conflicts: () => conflicts };
  };

  it('re-reads and re-decides exactly as many times as the bound allows', async () => {
    const { harness, conflicts } = harnessThatAlwaysConflicts();
    await harness.publish([ticketMatched()]);
    expect(conflicts()).toBe(MAX_TASK_CONFLICT_ATTEMPTS);
  });

  it('parks the task for a human instead of dropping the run it could not record', async () => {
    const { harness } = harnessThatAlwaysConflicts();
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(escalationOf(harness)?.payload.reason).toContain('another writer won');
    /**
     * Nothing was written **from the stale snapshot**: the stage the losing transaction was about
     * to complete is not completed, and the task is parked instead.
     *
     * This used to read `expect(taskOf(harness).costActualUsd).toBe(0)`, and that assertion moved
     * with WP-31 rather than being dropped. `cost_actual` left `save`'s column list and is written
     * by `addSpend`, a separate statement in the same transaction — which a real database rolls
     * back with everything else and the in-memory store does not (its divergence 1). So the
     * *rollback* is asserted where a rollback means something, in
     * `test/integration/pipeline/pipeline-store-concurrency.integration.test.ts`, and what is
     * asserted here is the thing this tier can see: the stage did not complete.
     */
    expect(
      harness
        .events()
        .filter((event) => event.type === 'task.stage.completed')
        .map((event) => (event.payload as { stage: string }).stage),
    ).toEqual(['intake']);
  });
});

/**
 * A human command landing **while a run is in flight** (WP-15i).
 *
 * Both cases patch `runs.insert` — the write that marks the moment the run starts — and make the
 * human's write from inside that same transaction. That is the window under test, expressed as an
 * ordering rather than as load (standing rule 76): a wall-clock race would reproduce it rarely and
 * on somebody else's machine.
 */
describe('a task a human stopped while its stage was running', () => {
  const harnessThatStopsMidRun = (
    stop: (
      harness: PipelineHarness,
      tx: Parameters<PipelineHarness['store']['tasks']['save']>[0],
      runId: string,
    ) => Promise<void>,
    options: {
      readonly cost?: boolean;
      readonly outcome?: NonNullable<HarnessOptions['runs']>[string];
    } = {},
  ): PipelineHarness => {
    const harness = harnessWith({
      runs: {
        refinement: options.outcome ?? {
          status: 'completed',
          terminalReason: 'success',
          costUsd: 0.4,
          structuredOutput: askingRefinedSpec(),
        },
      },
      ...(options.cost === true ? { cost: true } : {}),
    });
    const repository = harness.store.runs as { insert: typeof harness.store.runs.insert };
    const real = repository.insert.bind(harness.store.runs);
    repository.insert = async (tx, run) => {
      await real(tx, run);
      await stop(harness, tx, run.id);
    };
    return harness;
  };

  /** Which stages emitted `task.stage.completed` — `intake` always does; it is a system stage. */
  const completedStages = (harness: PipelineHarness): string[] =>
    harness
      .events()
      .filter((event) => event.type === 'task.stage.completed')
      .map((event) => (event.payload as { stage: string }).stage);

  it('records the run and its spend, and does not complete the stage', async () => {
    const harness = harnessThatStopsMidRun(async (instance, tx) => {
      const [stored] = instance.store.snapshot();
      if (stored === undefined || stored.task.state !== 'active') {
        return;
      }
      // What `POST /api/tasks/:id/pause` writes, in the one window that used to break the job:
      // `completeStage` throws for a paused task, which failed the job into pg-boss's retry.
      await instance.store.tasks.save(tx, {
        ...stored,
        task: { ...stored.task, state: 'paused' },
      });
    });
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    expect(task.task.state).toBe('paused');
    expect(task.task.currentStage).toBe('refinement');
    // The run is recorded, so the money is accounted for…
    expect(task.costActualUsd).toBeCloseTo(0.4, 6);
    expect(harness.types()).toContain('run.finished');
    // …and the stage is not completed, so the pipeline does not advance past the human. `intake`
    // is in the list because it is a system stage that completes the moment it is entered.
    expect(completedStages(harness)).toEqual(['intake']);
  });

  it('writes nothing at all when the run was ended by somebody else first', async () => {
    let cancelled: string | null = null;
    const harness = harnessThatStopsMidRun(async (instance, tx, runId) => {
      // What `POST /api/runs/:id/cancel` writes: the row moves to a terminal status, which is the
      // predicate `RunRepository.finish` carries. The executor must then discard its own outcome
      // rather than overwriting the human's decision with it.
      cancelled = runId;
      await instance.store.runs.finish(tx, {
        runId,
        status: 'cancelled',
        terminalReason: 'cancelled',
        sessionId: null,
        numTurns: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        cost: { usd: 0, is_estimate: true, price_list_id: null },
        wallMs: 0,
      });
    });
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    // The task is untouched: still active at the stage, with no spend from a run it did not own.
    expect(task.task.currentStage).toBe('refinement');
    expect(task.costActualUsd).toBe(0);
    expect(completedStages(harness)).toEqual(['intake']);
    // And the human's terminal status survived (the executor's `completed` never landed).
    const run = await harness.memory.transaction(async (scope) =>
      harness.store.runs.load(scope.tx, cancelled as unknown as string),
    );
    expect(run?.status).toBe('cancelled');
  });

  /**
   * **The money a cancelled run burned reaches the ledger** — WP-47, Q70 (b), backlog 50.
   *
   * The assertion is the one standing rule 79 asks for and the one WP-19's own invariant cannot
   * make: a sum over the ledger compared with **what the runner reported**, which is a number from
   * outside the ledger. `sum(cost_entries) = sum(cost_rollup_daily)` is true and blind here — both
   * sides are written from one derivation, so a run that contributes nothing to one contributes
   * nothing to the other and the equality holds while the money is lost.
   *
   * Before this work package all four of these were zero: the cancel wrote `{ usd: 0 }`, the
   * ledger took its `no_spend` branch, and no entry, no rollup delta and no budget window moved.
   */
  it('charges a cancelled run’s spend to the ledger, the rollup and the budget', async () => {
    const harness = harnessThatStopsMidRun(
      async (instance, tx, runId) => {
        await instance.store.runs.finish(tx, {
          runId,
          status: 'cancelled',
          terminalReason: 'cancelled',
          sessionId: null,
          numTurns: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            cache_read_tokens: 0,
          },
          // What `cancelRunCommand` stores since WP-47: **no figure**, because the request has no way
          // to reach the session and no way to know what it had spent. The `{ usd: 0 }` it used to
          // write was the one thing that stopped the process that *does* know from writing it.
          cost: null,
          wallMs: 0,
        });
      },
      { cost: true },
    );
    const ledger = harness.cost;
    if (ledger === null) {
      throw new Error('the harness was asked for the ledger and composed none');
    }
    // A cap the charge can move: without a `budgets` row the third assertion below would be
    // vacuously true, which is exactly the shape of the defect (nothing moved, and nothing said so).
    ledger.seedBudget({
      id: '00000000-0000-4000-8000-0000000000c9' as Id,
      scope: 'project',
      scopeId: PROJECT,
      projectId: PROJECT,
      window: 'day',
      limitUsd: 100,
    });
    await harness.publish([ticketMatched()]);
    const reported = 0.4;
    const charged = ledger.entries.reduce((sum, entry) => sum + entry.usd, 0);
    expect(charged).toBeCloseTo(reported, 6);
    expect(ledger.rollups.reduce((sum, delta) => sum + delta.usd, 0)).toBeCloseTo(reported, 6);
    // The third table, and the one backlog 50 called a governance statement rather than an
    // accounting one: a run cancelled at 90 % of a daily cap used to leave the cap untouched.
    expect(ledger.windows.reduce((sum, window) => sum + window.spentUsd, 0)).toBeCloseTo(
      reported,
      6,
    );
    // Labelled, not merged: this charge was made after the row was already terminal.
    expect(ledger.entries.every((entry) => entry.late)).toBe(true);
  });

  /**
   * WP-101 review round 1 (standing rule 16): a cancel applied by the holder whose interrupted turn
   * sent no `result` inside the grace measured **nothing**. The row's cost stays `null` — never a
   * `usd_reported = 0` a later reader takes for a free run — and the ledger writes no row, as for a
   * run the lease sweep ended. The measured branch is the topology e2e's (`0.13`, not late).
   */
  it('writes no figure and no ledger row for a cancelled run whose stop measured nothing (WP-101)', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'cancelled',
          terminalReason: 'cancelled',
          costUnmeasured: true,
          error: 'the platform stopped the run: cancelled',
        },
      },
      cost: true,
    });
    await harness.publish([ticketMatched()]);
    const ledger = harness.cost;
    if (ledger === null) {
      throw new Error('the harness was asked for the ledger and composed none');
    }
    const runId = harness.specs.at(-1)?.runId as Id;
    const run = await harness.memory.transaction(async (scope) =>
      harness.store.runs.load(scope.tx, runId),
    );
    expect(run?.status).toBe('cancelled');
    expect(run?.cost).toBeNull();
    expect(ledger.entries).toEqual([]);
    expect(taskOf(harness).costActualUsd).toBe(0);
  });

  /**
   * The same rule on the late path (WP-101 review round 2): a run another writer ended, whose own stop
   * then measured nothing, has no figure to be late with — `lostTheRun` records no late charge rather
   * than a zero the ledger would take for a free run (rule 16).
   */
  it('records no late charge for a run ended by another writer whose stop measured nothing (WP-101)', async () => {
    const harness = harnessThatStopsMidRun(
      async (instance, tx, runId) => {
        await instance.store.runs.finish(tx, {
          runId,
          status: 'cancelled',
          terminalReason: 'cancelled',
          sessionId: null,
          numTurns: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            cache_read_tokens: 0,
          },
          cost: null,
          wallMs: 0,
        });
      },
      {
        cost: true,
        outcome: {
          status: 'cancelled',
          terminalReason: 'cancelled',
          costUnmeasured: true,
          error: 'the platform stopped the run: cancelled',
        },
      },
    );
    await harness.publish([ticketMatched()]);
    const ledger = harness.cost;
    if (ledger === null) {
      throw new Error('the harness was asked for the ledger and composed none');
    }
    expect(ledger.entries).toEqual([]);
    expect(taskOf(harness).costActualUsd).toBe(0);
    const runId = harness.specs.at(-1)?.runId as Id;
    const run = await harness.memory.transaction(async (scope) =>
      harness.store.runs.load(scope.tx, runId),
    );
    // The row the human's cancel wrote with no figure keeps no figure: a late `recordCost` of the
    // outcome's zero would be the claim rule 16 forbids.
    expect(run?.cost).toBeNull();
  });

  /**
   * WP-131 review round 1 (backlog 407 on the late path): a run another writer ended, whose own stop
   * was `cost_unreported`, carries the runner's floor `usd: 0`. Written late as a plain measured
   * zero it would read as a free run, and the task cap would release the hold for it. The late write
   * says it is a floor, so the row keeps the WP-119 figure and the hold stands. Canary: the
   * `costIsFloor` argument dropped from `lostTheRun` releases the hold (`{0, 0}`).
   */
  it('keeps the hold on a run ended by another writer whose own stop was cost_unreported (WP-131)', async () => {
    const zeroUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_read_tokens: 0,
    };
    const harness = harnessThatStopsMidRun(
      async (instance, tx, runId) => {
        await instance.store.runs.finish(tx, {
          runId,
          status: 'cancelled',
          terminalReason: 'cancelled',
          sessionId: null,
          numTurns: 0,
          usage: zeroUsage,
          cost: null,
          wallMs: 0,
        });
      },
      {
        cost: true,
        outcome: {
          status: 'budget_exceeded',
          terminalReason: 'error_max_budget_usd',
          costUsd: 0,
          stopReason: COST_UNREPORTED,
          error: 'the platform stopped the run: cost_unreported — …',
        },
      },
    );
    await harness.publish([ticketMatched()]);
    const runId = harness.specs.at(-1)?.runId as Id;
    const run = await harness.memory.transaction(async (scope) =>
      harness.store.runs.load(scope.tx, runId),
    );
    // The late write happened — the row now carries the floor, as WP-119 writes it…
    expect(run?.cost?.usd).toBe(0);
    // …and the run is still held at the reservation it was admitted at (refinement's 2).
    const held = await harness.memory.transaction(async (scope) =>
      harness.store.runs.heldFor(scope.tx, run?.taskId as Id, 99),
    );
    expect(held).toEqual({ heldUsd: 2, heldRuns: 1 });
    expect(taskOf(harness).costActualUsd).toBe(0);
  });

  it('claims a lease on the run it starts, so a sweep can tell it apart from one nobody is driving', async () => {
    let started: string | null = null;
    const harness = harnessThatStopsMidRun(async (_instance, _tx, runId) => {
      started = runId;
    });
    await harness.publish([ticketMatched()]);

    expect(started).not.toBeNull();
    // Claimed in the **same transaction as the insert**: a `running` row with no lease is exactly
    // the row the sweep's wall-clock backstop takes an hour to reach.
    expect(harness.store.leaseOf(started as unknown as Id)?.owner).toBe('harness');
  });
});

/**
 * WP-45 criterion 4: *which checklist was applied* is the platform's record, stamped over the
 * model's. The walk through the executor is `review-only.test.ts`; these are the three answers.
 */
describe('the platform’s record on a review verdict', () => {
  const MODEL = { verdict: 'approve', checklists_applied: [{ name: 'forged', item_count: 9 }] };

  it('replaces the model’s claim with what the planner put in the prompt', () => {
    const applied = [
      { name: 'payments', item_count: 2, required_by: ['payments'], truncated: false },
    ];
    expect(withPlatformReviewRecord('ReviewVerdict', MODEL, applied)).toEqual({
      verdict: 'approve',
      checklists_applied: applied,
    });
  });

  it('records "not recorded" as null when the planner said nothing — never the model’s value', () => {
    expect(withPlatformReviewRecord('ReviewVerdict', MODEL, null)).toEqual({
      verdict: 'approve',
      checklists_applied: null,
    });
  });

  it('leaves every other artifact type exactly as the model wrote it', () => {
    expect(withPlatformReviewRecord('AcceptanceVerdict', MODEL, [])).toBe(MODEL);
  });
});

describe('the task budget holds a run nobody measured (WP-131, backlog 402)', () => {
  const USER = '00000000-0000-4000-8000-00000000a131' as Id;
  /** A 20 USD task whose refinement stage may spend 15 — the row's figures. */
  const settings = {
    taskBudgetUsd: 20,
    config: { stages: { refinement: { budget_usd: 15 } } },
  } as HarnessOptions['settings'];

  /**
   * Criterion (3): `cost_actual` 0, one ended refinement run nobody measured (a wall-clock stop that
   * read no `result`, WP-119) admitted at 15, a cap of 20, and the next 15 USD stage. Until WP-131
   * the cap read `0 + 15 <= 20` and admitted every retry; the hold reads `0 + 15 + 15 > 20`.
   *
   * The hold is read off the **store's own rows** (`RunRepository.heldFor` over the run the harness
   * really inserted, with the `reserve_usd` the executor really wrote) — never seeded — so the case
   * holds the insert, the predicate and the comparison together.
   */
  it('pauses the next 15 USD stage of a task at cost_actual 0 that holds one unmeasured 15 USD run against a cap of 20', async () => {
    const harness = harnessWith({
      settings,
      runs: {
        refinement: {
          status: 'timed_out',
          terminalReason: 'timed_out',
          costUnmeasured: true,
          error: 'the platform stopped the run: timed_out',
        },
      },
    });
    await harness.publish([ticketMatched()]);
    const first = taskOf(harness);
    expect(harness.specs).toHaveLength(1);
    expect(first.costActualUsd).toBe(0);
    const held = await harness.memory.transaction(async (scope) =>
      harness.store.runs.heldFor(scope.tx, first.task.id, 2),
    );
    // Its **own** reservation (15), not the 2 the caller offered for a row that recorded none.
    expect(held).toEqual({ heldUsd: 15, heldRuns: 1 });

    await retryStageCommand(harness.humanCommands, {
      taskId: first.task.id,
      userId: USER,
      stage: 'refinement' as Slug,
    });
    await harness.drain();

    // Refused before a second run: no new spec, the task paused for a human to raise the cap.
    expect(harness.specs).toHaveLength(1);
    const paused = taskOf(harness);
    expect(paused.task.state).toBe('paused');
    expect(harness.types()).toContain('task.paused');
    // **Held, never spent**: the reservation is not written into `cost_actual` (standing rule 16).
    expect(paused.costActualUsd).toBe(0);
  });

  /**
   * WP-131 review round 1 (the orchestrator's ruling): the way out of a hold is a **bigger cap**, set
   * by a person. The task above, paused at 0 spent + 15 held + 15 reserve > 20, is raised to 40 and
   * resumed: `0 + 15 + 15 <= 40` admits the stage, the hold still counted (it is never released),
   * and `cost_actual` still 0. Canary: the executor reading the default instead of the override
   * leaves the task paused.
   */
  it('admits the held task after a maintainer raises its cap, without releasing the hold (WP-131)', async () => {
    const harness = harnessWith({
      settings,
      runs: {
        refinement: {
          status: 'timed_out',
          terminalReason: 'timed_out',
          costUnmeasured: true,
          error: 'the platform stopped the run: timed_out',
        },
      },
    });
    // The settings snapshot each run is inserted with (write-only on the row, so read at the door).
    const snapshots: unknown[] = [];
    const repository = harness.store.runs as { insert: typeof harness.store.runs.insert };
    const real = repository.insert.bind(harness.store.runs);
    repository.insert = async (tx, run) => {
      snapshots.push(run.settings?.snapshot);
      await real(tx, run);
    };
    await harness.publish([ticketMatched()]);
    const taskId = taskOf(harness).task.id;
    await retryStageCommand(harness.humanCommands, {
      taskId,
      userId: USER,
      stage: 'refinement' as Slug,
    });
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('paused');
    expect(harness.specs).toHaveLength(1);
    // The pause names its cap (WP-131 review round 2): this one is the task's own.
    expect(
      harness
        .events()
        .filter((event) => event.type === 'task.paused')
        .map((event) => (event.payload as { budget_scope?: string }).budget_scope),
    ).toEqual(['task']);

    // A figure not above the cap in force (20, this task's default) is refused and moves nothing…
    await expect(
      raiseTaskBudgetCommand(harness.humanCommands, { taskId, userId: USER, capUsd: 20 }),
    ).rejects.toBeInstanceOf(TaskBudgetNotRaisedError);
    // …a raise answers the cap it replaced…
    await expect(
      raiseTaskBudgetCommand(harness.humanCommands, { taskId, userId: USER, capUsd: 40 }),
    ).resolves.toEqual({ capUsd: 40, previousCapUsd: 20 });
    // …and the next one is compared against the raised cap, not the default: nothing lowers it.
    await expect(
      raiseTaskBudgetCommand(harness.humanCommands, { taskId, userId: USER, capUsd: 30 }),
    ).rejects.toBeInstanceOf(TaskBudgetNotRaisedError);

    await resumeTaskCommand(harness.humanCommands, { taskId, userId: USER });
    await harness.drain();
    // Admitted: a second refinement run was started under the raised cap…
    expect(harness.specs).toHaveLength(2);
    // …and it **records** that cap, not the default (review round 2); the first ran under 20.
    expect(
      snapshots.map((snapshot) => (snapshot as { task_budget_usd?: number }).task_budget_usd),
    ).toEqual([20, 40]);
    // …and the task is not paused by its cap any more, so a further raise is refused (round 2):
    // a raise is for a task its own cap paused, and only that.
    await expect(
      raiseTaskBudgetCommand(harness.humanCommands, { taskId, userId: USER, capUsd: 90 }),
    ).rejects.toBeInstanceOf(TaskNotPausedByItsCapError);
    const held = await harness.memory.transaction(async (scope) =>
      harness.store.runs.heldFor(scope.tx, taskId, 2),
    );
    // Both runs ended unmeasured and both are held: the raise released nothing.
    expect(held).toEqual({ heldUsd: 30, heldRuns: 2 });
    expect(taskOf(harness).costActualUsd).toBe(0);
  });

  /**
   * Backlog 407 (the pre-review round): a `cost_unreported` stop is written with the runner's
   * **floor** — `usd_reported = 0`, which WP-119 kept and this does not change — and until now the
   * task cap read that floor as a measured zero and admitted every retry. It is held at its
   * reservation like a run nobody measured. Canary: `costIsFloorOf` answering `false` leaves the
   * run unheld, and the retry is admitted.
   */
  it('holds a cost_unreported run at its reservation and pauses the next 15 USD stage, though its row reads 0 (407)', async () => {
    const harness = harnessWith({
      settings,
      runs: {
        refinement: {
          status: 'budget_exceeded',
          terminalReason: 'error_max_budget_usd',
          costUsd: 0,
          stopReason: COST_UNREPORTED,
          error: 'the platform stopped the run: cost_unreported — …',
        },
      },
    });
    await harness.publish([ticketMatched()]);
    const first = taskOf(harness);
    expect(first.task.state).toBe('needs_human');
    const runId = harness.specs.at(-1)?.runId as Id;
    const row = await harness.memory.transaction(async (scope) =>
      harness.store.runs.load(scope.tx, runId),
    );
    // The row is what WP-119 writes: the floor, as a figure.
    expect(row?.cost?.usd).toBe(0);
    const held = await harness.memory.transaction(async (scope) =>
      harness.store.runs.heldFor(scope.tx, first.task.id, 2),
    );
    expect(held).toEqual({ heldUsd: 15, heldRuns: 1 });

    await retryStageCommand(harness.humanCommands, {
      taskId: first.task.id,
      userId: USER,
      stage: 'refinement' as Slug,
    });
    await harness.drain();
    expect(harness.specs).toHaveLength(1);
    expect(taskOf(harness).task.state).toBe('paused');
    expect(taskOf(harness).costActualUsd).toBe(0);
  });

  /**
   * WP-131 review round 1 (canary (e)): the hold is counted **once**. A cap of 35, one run held at 15
   * and a 15 USD stage: `0 + 15 + 15 = 30 <= 35` admits, where a comparison that added the hold
   * twice would read `45 > 35` and refuse — both sides, so either mistake fails here.
   */
  it('counts the hold once: a cap of 35 holding 15 admits the next 15 USD stage (WP-131)', () => {
    const at35 = { ...(settings as object), taskBudgetUsd: 35 } as never;
    const held = { heldUsd: 15, heldRuns: 1 };
    expect(taskBudgetExhausted({ costActualUsd: 0 } as never, at35, 'refinement', held)).toBe(
      false,
    );
    // …and one more held run is past it: the hold is a sum over the runs, not a flag.
    expect(
      taskBudgetExhausted({ costActualUsd: 0 } as never, at35, 'refinement', {
        heldUsd: 30,
        heldRuns: 2,
      }),
    ).toBe(true);
  });

  it('names the hold apart from the spend in the pause', () => {
    const detail = taskBudgetDetail(
      { costActualUsd: 0 } as never,
      settings as never,
      'refinement' as Slug,
      { heldUsd: 15, heldRuns: 1 },
    );
    expect(detail).toBe(
      'the task has spent 0 USD of its 20 USD cap, with 1 run nobody measured, held at its cap: ' +
        '15 USD, and "refinement" may spend 15 more',
    );
    expect(
      taskBudgetDetail(
        { costActualUsd: 4 } as never,
        settings as never,
        'refinement' as Slug,
        NO_HOLD,
      ),
    ).toBe('the task has spent 4 USD of its 20 USD cap and "refinement" may spend 15 more');
  });

  it('admits the same stage when the hold is absent, so the pause is the hold’s', () => {
    // The canary in arithmetic: 0 + 15 <= 20 admits, 0 + 15 + 15 > 20 refuses.
    expect(
      taskBudgetExhausted({ costActualUsd: 0 } as never, settings as never, 'refinement', NO_HOLD),
    ).toBe(false);
    expect(
      taskBudgetExhausted({ costActualUsd: 0 } as never, settings as never, 'refinement', {
        heldUsd: 15,
        heldRuns: 1,
      }),
    ).toBe(true);
  });
});

describe('a stop that measured nothing (WP-119, backlog 334)', () => {
  /**
   * WP-119 (PROGRESS backlog 334): the event half. A stop that measured nothing — a human's, and
   * now the platform's stall and wall clock — leaves `null` cost columns, no ledger row **and a
   * terminal event that says so**: `run.finished.cost` is `null` (it stated `{ usd: 0 }` until now,
   * while the row said `null`), and a stalled run's `run.failed` carries neither usage nor cost, the
   * lease sweep's shape. The canary is the event built from `outcome.cost` again. The last row is a
   * crash with no `result` (WP-119 pre-review round): the same unmeasured ending.
   */
  it.each([
    { status: 'cancelled', terminalReason: 'cancelled', event: 'run.finished' },
    { status: 'timed_out', terminalReason: 'timed_out', event: 'run.finished' },
    { status: 'stalled', terminalReason: 'stalled', event: 'run.failed' },
    { status: 'failed', terminalReason: 'crash', event: 'run.failed' },
  ] as const)(
    'records a $status stop that measured nothing as unmeasured on the row, the ledger and the $event event (WP-119)',
    async ({ status, terminalReason, event }) => {
      const harness = harnessWith({
        runs: {
          refinement: {
            status,
            terminalReason,
            costUnmeasured: true,
            error: `the platform stopped the run: ${status}`,
          },
        },
        cost: true,
      });
      await harness.publish([ticketMatched()]);
      const ledger = harness.cost;
      if (ledger === null) {
        throw new Error('the harness was asked for the ledger and composed none');
      }
      const runId = harness.specs.at(-1)?.runId as Id;
      const run = await harness.memory.transaction(async (scope) =>
        harness.store.runs.load(scope.tx, runId),
      );
      expect(run?.status).toBe(status);
      expect(run?.cost).toBeNull();
      expect(ledger.entries).toEqual([]);
      expect(taskOf(harness).costActualUsd).toBe(0);

      const terminal = harness
        .events()
        .filter((entry) => entry.type === 'run.finished' || entry.type === 'run.failed');
      expect(terminal.map((entry) => entry.type)).toEqual([event]);
      const payload = terminal[0]?.payload as { cost?: unknown; usage?: unknown };
      expect(payload.cost).toBeNull();
      if (event === 'run.failed') {
        expect(payload.usage).toBeNull();
      }
      // The event is the stored contract: it still parses, `null` and all.
      expect(domainEventSchemasByType[event].safeParse(terminal[0]).success).toBe(true);
    },
  );
});
