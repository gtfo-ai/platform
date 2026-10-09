/**
 * The composition root's two decisions that are not wiring.
 *
 * `composePipeline` itself is exercised by the `e2e-fake-claude` tier against a real instance —
 * that is the only place a pg-boss worker, an outbox sweep and a `bindings` row can all be present
 * at once, and a unit test of it would be a test of a mock. What is unit-testable is what it
 * *decides*: where a git binding's repository path comes from, and what a project's settings are.
 */
import type { RunSpec } from '@platform/application';
import {
  allowAnyIntegrationHost,
  autonomyPresetFor,
  commandBaselineFor,
  countingStartHooks,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  exactSecretRedactor,
  pipelineDialFor,
  settingsAdmission,
  silentLogger,
  staticPipelineIntegrations,
  TransactionOpenError,
  withOpenTransaction,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { materialiseAutonomy, runCommandPolicy } from '@platform/domain';
import { createFakeTaskManagement } from '@platform/integrations';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  composePipelinePlatformTools,
  createProjectSettingsPort,
  RunnerUnavailableError,
  repositoryPathOf,
  unavailableClaudeRunner,
} from './pipeline.js';

describe('unavailableClaudeRunner', () => {
  /**
   * The runner a process that is **configured to run no agent** gets, and the reason it is a
   * *refusal* rather than a null object.
   *
   * Since WP-53 that is a narrower set than "every production process": a worker with
   * `APP_LAUNCHER_URL` and `APP_LAUNCHER_TOKEN` composes the real one. It is also a set that should
   * not reach this throw at all — such a process no longer subscribes `stage.execute` (TD-028
   * decision 5) — and the refusal stays for the paths that bypass the queue and for the
   * half-configured instance a future edit could produce.
   *
   * A runner that returned a handle whose outcome resolved to a failed `RunOutcome` would be
   * kinder and much worse: the stage executor would record `run.failed` and the interpreter would
   * transition on a verdict for a run that was never attempted — a fabricated fact, and the
   * fail-open direction of standing rule 20. Throwing keeps the failure inside the
   * `stage.execute` job that asked for it.
   */
  it('throws, naming the stage and the missing configuration, instead of faking an outcome', () => {
    const runner = unavailableClaudeRunner();
    let thrown: unknown;
    try {
      runner.start({ stage: 'implementation' } as RunSpec, countingStartHooks());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RunnerUnavailableError);
    expect((thrown as Error).message).toContain('implementation');
    expect((thrown as Error).message).toContain('APP_LAUNCHER_URL');
  });

  it('still names the failure when the spec has no stage', () => {
    expect(() => unavailableClaudeRunner().start({} as RunSpec, countingStartHooks())).toThrow(
      RunnerUnavailableError,
    );
  });
});

describe('repositoryPathOf', () => {
  it('reads the path a provider addresses a repository by, from every spelling of the url', () => {
    expect(repositoryPathOf('https://git.example.test/acme/api.git')).toBe('acme/api');
    expect(repositoryPathOf('https://git.example.test/acme/api')).toBe('acme/api');
    expect(repositoryPathOf('https://git.example.test/acme/team/api.git')).toBe('acme/team/api');
    expect(repositoryPathOf('git@git.example.test:acme/api.git')).toBe('acme/api');
    expect(repositoryPathOf('ssh://git@git.example.test:2222/acme/api.git')).toBe('acme/api');
    expect(repositoryPathOf('https://git.example.test/acme/api/')).toBe('acme/api');
  });

  /**
   * Rule 18: the empty case must not be the permissive one. A `repo_url` with no path would
   * otherwise resolve to `''`, and the pipeline would ask the provider about a project named
   * nothing — a 404 four stages later instead of a refusal at the binding.
   */
  it('refuses a url with no repository path rather than addressing an empty project', () => {
    expect(() => repositoryPathOf('https://git.example.test')).toThrow(
      /has no repository path; the git binding cannot be addressed/,
    );
    expect(() => repositoryPathOf('https://git.example.test/')).toThrow(/has no repository path/);
    expect(() => repositoryPathOf('https://git.example.test/.git')).toThrow(
      /has no repository path/,
    );
  });
});

describe('the project settings port', () => {
  const poolOf = (
    rows: { config: unknown; autonomy_policies?: unknown; org_settings?: unknown }[],
  ) => ({ query: vi.fn(async () => ({ rows, rowCount: rows.length })) }) as never;

  it('reads the effective configuration off the project row', async () => {
    const settings = await createProjectSettingsPort(
      poolOf([{ config: { version: 1, status_mapping: { refinement: 'Doing' } } }]),
    ).forProject('00000000-0000-4000-8000-0000000000b1' as never);
    expect(settings.config.status_mapping).toEqual({ refinement: 'Doing' });
    // The shipped seven since WP-35 added `history_bootstrap` beside WP-25's `ticket_lint`,
    // WP-24's `review_only` and WP-21's `discovery`; a project's own `.agentic/pipeline.yml` needs
    // a workspace to read.
    expect(Object.keys(settings.templates).sort()).toEqual([
      'bug',
      'chore',
      'discovery',
      // WP-40's opt-in variant. It is in the map for every project, which is what makes turning the
      // feature on a *settings* change rather than a deployment one; `templateForIssueType` is what
      // decides whether an epic ever reaches it.
      'epic_split',
      'feature',
      'history_bootstrap',
      'review_only',
      'spike',
      'ticket_lint',
    ]);
  });

  /**
   * WP-178 criterion (11): `human_returns.acknowledgements` saved through the settings write
   * (`PUT /api/projects/:id/config`, the `projects.config` column) reaches the pipeline as
   * `config.human_returns`, where the human-return window reads it (`jobs.ts`). Until WP-178 the
   * key was accepted and read by nothing.
   */
  it('reads human_returns.acknowledgements off the project row, for the human-return window', async () => {
    const settings = await createProjectSettingsPort(
      poolOf([{ config: { version: 1, human_returns: { acknowledgements: ['díky', 'super'] } } }]),
    ).forProject('00000000-0000-4000-8000-0000000000b1' as never);
    expect(settings.config.human_returns?.acknowledgements).toEqual(['díky', 'super']);
  });

  /**
   * WP-73, PROGRESS backlogs 19 and 221: the read runs on the caller's transaction when it is
   * handed one, and a read with **no** transaction is refused while one is open — the borrow that
   * made a dispatch's peak three connections is a failure rather than a sentence.
   */
  it('reads on the caller’s transaction, and refuses to borrow from the pool inside one', async () => {
    const pool = poolOf([{ config: {} }]) as unknown as { query: ReturnType<typeof vi.fn> };
    const client = { query: vi.fn(async () => ({ rows: [{ config: {} }], rowCount: 1 })) };
    const port = createProjectSettingsPort(pool as never);
    const project = '00000000-0000-4000-8000-0000000000b1' as never;

    await port.forProject(project, { adapter: 'postgres', client } as never);
    // Two reads, both on the caller's connection: the project row, and since WP-177 the
    // task-management binding's lifecycle block (`readTicketLifecycle`).
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(pool.query).not.toHaveBeenCalled();

    await expect(withOpenTransaction(async () => port.forProject(project))).rejects.toThrow(
      TransactionOpenError,
    );
    expect(pool.query).not.toHaveBeenCalled();
    // Outside every transaction the pool is the right connection, and it is used.
    await port.forProject(project);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  /**
   * WP-177 (TD-029 decision 1): the task-management binding's `lifecycle` block reaches the
   * pipeline as `ticketLifecycle`, the binding over the account and `pickup_status` beside it; no
   * block, two bindings or a block that fails its schema is `null` — the pre-M10 behaviour.
   */
  it('reads the task-management binding’s lifecycle block into ticketLifecycle', async () => {
    const project = '00000000-0000-4000-8000-0000000000b1' as never;
    const portOver = (bindingRows: unknown[]) =>
      createProjectSettingsPort({
        query: vi.fn(async (text: string) =>
          text.includes('from bindings')
            ? { rows: bindingRows, rowCount: bindingRows.length }
            : { rows: [{ config: {} }], rowCount: 1 },
        ),
      } as never);
    const binding = (bindingConfig: unknown, integrationConfig: unknown = {}) => ({
      provider: 'fake-task-management',
      integration_config: integrationConfig,
      binding_config: bindingConfig,
    });

    const mapped = await portOver([
      binding(
        { pickup_status: 'Ready for the agent', lifecycle: { in_progress: 'Doing' } },
        { lifecycle: { in_progress: 'Account default' } },
      ),
    ]).forProject(project);
    expect(mapped.ticketLifecycle).toEqual({
      pickUpFrom: 'Ready for the agent',
      slots: { in_progress: 'Doing' },
    });

    expect((await portOver([]).forProject(project)).ticketLifecycle).toBeNull();
    expect((await portOver([binding({})]).forProject(project)).ticketLifecycle).toBeNull();
    expect(
      (await portOver([binding({}), binding({})]).forProject(project)).ticketLifecycle,
    ).toBeNull();
    expect(
      (
        await portOver([binding({ lifecycle: { in_progress: 'Doing', qa: 'doing' } })]).forProject(
          project,
        )
      ).ticketLifecycle,
    ).toBeNull();
  });

  /**
   * WP-91 criterion 4 (backlog 224): `pipeline.wip` is read by the settings port into the limits
   * admission uses — the project's value, BD-010's where it states none, and never above the
   * organisation's maximum; a maximum that does not parse is refused rather than read as none.
   */
  it('reads pipeline.wip into the admission limits, bounded by the organisation', async () => {
    const project = '00000000-0000-4000-8000-0000000000b1' as never;
    const read = async (config: unknown, org_settings: unknown = {}) =>
      (await createProjectSettingsPort(poolOf([{ config, org_settings }])).forProject(project)).wip;
    expect(await read({})).toEqual({
      maxParallelTasks: 2,
      maxTasksInPipeline: 5,
      maxParallelRuns: 4,
    });
    expect(await read({ version: 1, pipeline: { wip: { max_parallel_tasks: 1 } } })).toMatchObject({
      maxParallelTasks: 1,
      maxTasksInPipeline: 5,
    });
    expect(
      await read(
        { version: 1, pipeline: { wip: { max_parallel_tasks: 4 } } },
        { pipeline: { wip: { max_parallel_tasks: 3 } } },
      ),
    ).toMatchObject({ maxParallelTasks: 3 });
    // A maximum that does not parse is not read as none: it is the read's named refusal, which
    // every run's admission refuses on (WP-106, backlog 354 — answered rather than thrown).
    expect(
      (
        await createProjectSettingsPort(
          poolOf([{ config: {}, org_settings: { pipeline: { wip: { max_parallel_tasks: 0 } } } }]),
        ).forProject(project)
      ).configRefusal,
    ).toMatch(/organizations\.settings does not parse \(pipeline\.wip\.max_parallel_tasks: 0\)/);
  });

  /**
   * WP-93 criterion 2's read half: the organisation's `autonomy.maximum` caps the dial **at this
   * read** — the live policies and the dial a task freezes at start (`pipelineDialFor`) — and never
   * rewrites the project's choice; a document that does not parse refuses the read.
   */
  /**
   * WP-93 review round 1: the organisation's command maximum reaches the run policy through this
   * port. The port hands `organisationCommands` over, and the planner's composition
   * (`runCommandPolicy` over the role baseline) intersects every verb with it before the project
   * narrows — so a project's `allow` cannot re-grant what the organisation left out.
   */
  it('hands the organisation’s command maximum to the run policy, which intersects the baseline with it', async () => {
    const project = '00000000-0000-4000-8000-0000000000b1' as never;
    const read = async (org_settings: unknown) =>
      createProjectSettingsPort(
        poolOf([
          {
            config: { version: 1, commands: { allow: ['git push *', 'git status'] } },
            org_settings,
          },
        ]),
      ).forProject(project);
    const policyOf = (settings: Awaited<ReturnType<typeof read>>) =>
      runCommandPolicy(
        commandBaselineFor('developer', 'implementation' as never, []),
        settings.organisationCommands,
        settings.config.commands,
        settings.repositoryCommands,
      );

    const unbounded = await read({});
    expect(unbounded.organisationCommands).toBeUndefined();
    expect(policyOf(unbounded).policy.allow).toContain('git status');
    expect(policyOf(unbounded).policy.allow.length).toBeGreaterThan(1);

    const bounded = await read({ commands: { allow: ['git status'], block: ['curl *'] } });
    expect(bounded.organisationCommands).toEqual({ allow: ['git status'], block: ['curl *'] });
    const run = policyOf(bounded);
    expect(run.policy.allow).toEqual(['git status']);
    expect(run.policy.block).toContain('curl *');
    expect(run.removedByOrganisation.length).toBeGreaterThan(0);
  });

  it('caps the materialised dial at the organisation’s autonomy maximum, at the read', async () => {
    const project = '00000000-0000-4000-8000-0000000000b1' as never;
    const stored = materialiseAutonomy({
      level: 'supervised',
      at: '2026-09-14T10:00:00.000Z' as never,
      appliedBy: null,
    });
    const read = async (org_settings: unknown) =>
      createProjectSettingsPort(
        poolOf([{ config: {}, autonomy_policies: stored, org_settings }]),
      ).forProject(project);

    const uncapped = await read({});
    expect(uncapped.autonomy).toEqual(stored);
    expect(uncapped.organisationAutonomyMaximum).toBeUndefined();
    expect(pipelineDialFor(uncapped)).toMatchObject({ level: 'supervised', business_review: true });

    const capped = await read({ autonomy: { maximum: 'assist' } });
    expect(capped.autonomy?.level).toBe('assist');
    expect(capped.organisationAutonomyMaximum).toBe('assist');
    // The dial a task started now would freeze: Assist's scoping-only halt, no business review.
    expect(pipelineDialFor(capped)).toMatchObject({
      level: 'assist',
      business_review: false,
      stop_after_stage: 'architecture',
    });
    expect(autonomyPresetFor(capped)?.planApproval).toBe('always');

    // At or above the chosen level, nothing moves.
    expect((await read({ autonomy: { maximum: 'autonomous' } })).autonomy).toEqual(stored);

    // WP-94 review round 1: a maximum of Observe hands the maintenance scheduler an Observe dial —
    // the level its Q100 skip reads (`scheduler.test.ts` › "pauses at an organisation maximum of
    // Observe, though the project chose Supervised").
    expect((await read({ autonomy: { maximum: 'observe' } })).autonomy?.level).toBe('observe');

    // A document that does not parse — an unknown key — is the read's named refusal (WP-106).
    expect((await read({ autonomy: { maximum: 'assist' }, quiet: true })).configRefusal).toMatch(
      /organizations\.settings does not parse \(\(root\) \(Unrecognized key: "quiet"\)\)/,
    );
  });

  /**
   * WP-106 (PROGRESS backlogs 311 and 354): `projects.config` is **parsed**, never cast. A stored
   * `pipeline.wip` the schema refuses (above its 50) used to reach admission as 500 parallel tasks.
   * It is now the read's **named refusal** (`configRefusal`: the key path, the value and the `PUT`
   * that fixes it, a pasted credential redacted out), which every run's admission refuses on; the
   * layer contributes nothing, so no reader acts on the 500, and nothing throws, so no reader loses
   * a ticket or a notification over it (rule 20).
   */
  it('answers a stored pipeline.wip the schema refuses as a named refusal, never as the value', async () => {
    const project = '00000000-0000-4000-8000-0000000000b1' as never;
    const read = async (config: unknown) =>
      createProjectSettingsPort(poolOf([{ config, org_settings: {} }])).forProject(project);

    const refused = await read({ version: 1, pipeline: { wip: { max_parallel_tasks: 500 } } });
    expect(refused.configRefusal).toMatch(/pipeline\.wip\.max_parallel_tasks: 500/);
    expect(refused.configRefusal).toMatch(
      /PUT \/api\/projects\/00000000-0000-4000-8000-0000000000b1\/config/,
    );
    expect(refused.config).toEqual({});
    // The schema's floor, never BD-010's defaults (2 and 5): no valid document could allow fewer.
    expect(refused.wip).toMatchObject({ maxParallelTasks: 1, maxTasksInPipeline: 1 });
    expect(settingsAdmission(refused)).toMatchObject({
      kind: 'refused',
      word: 'settings_config_invalid',
    });

    // A secret-shaped value in an unknown key is replaced before it is quoted.
    const token = 'glpat-FAKE-wp106-not-a-real-token';
    const planted = await read({ version: 1, notes: token });
    expect(planted.configRefusal).toMatch(/notes/);
    expect(planted.configRefusal).not.toContain(token);

    // Both sides of the boundary (rule 42): the schema's own maximum reads, and `{}` is the
    // never-configured project, which composes exactly what it did before.
    const admitted = await read({ version: 1, pipeline: { wip: { max_parallel_tasks: 50 } } });
    expect(admitted.wip).toMatchObject({ maxParallelTasks: 50 });
    expect(admitted.configRefusal).toBeUndefined();
    expect((await read({})).config).toEqual({});
  });

  it('refuses a project that has no row instead of settling defaults for a task it cannot place', async () => {
    await expect(
      createProjectSettingsPort(poolOf([])).forProject(
        '00000000-0000-4000-8000-0000000000b9' as never,
      ),
    ).rejects.toThrow(/has no row; the pipeline cannot settle its settings/);
  });

  /**
   * `projects.autonomy_policies` — the column the plan-approval gate reads (WP-30, BD-027:14).
   *
   * Parsed and never cast: this document decides whether a plan waits for a human, so one that does
   * not match the current schema must not be read as one that does. It is `null` and **logged**
   * rather than thrown, because a throw here fails the `stage.execute` job into a retry loop over a
   * configuration problem no retry can fix.
   */
  it('parses the materialised dial, and reads an unparseable one as absent with a named log line', async () => {
    const stored = materialiseAutonomy({
      level: 'autonomous',
      at: '2026-09-14T10:00:00.000Z' as never,
      appliedBy: null,
    });
    const project = '00000000-0000-4000-8000-0000000000b1' as never;
    const settings = await createProjectSettingsPort(
      poolOf([{ config: {}, autonomy_policies: stored }]),
    ).forProject(project);
    expect(settings.autonomy).toEqual(stored);
    // …and the domain reads the effective preset off it rather than off the level.
    expect(autonomyPresetFor(settings)?.planApproval).toBe('never');

    const warnings: { message: string }[] = [];
    const logger = {
      ...silentLogger,
      warn: (_fields: unknown, message: string) => warnings.push({ message }),
    } as never;
    const broken = await createProjectSettingsPort(
      poolOf([{ config: {}, autonomy_policies: { level: 'autonomous' } }]),
      logger,
    ).forProject(project);
    expect(broken.autonomy).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('re-apply the preset');

    // A row with no document at all is the same answer and is **not** a warning: migration 0021
    // backfilled every row that existed, so `null` here is a harness's row rather than a fault.
    const quiet: { message: string }[] = [];
    const absent = await createProjectSettingsPort(
      poolOf([{ config: {}, autonomy_policies: null }]),
      {
        ...silentLogger,
        warn: (_fields: unknown, message: string) => quiet.push({ message }),
      } as never,
    ).forProject(project);
    expect(absent.autonomy).toBeNull();
    expect(quiet).toEqual([]);
  });
});

/**
 * WP-181 review round 2: the platform tools the pipeline composes read `get_conversation` through
 * the pipeline's own integrations port — called here over fake integrations, so handing either half
 * of `composePipelinePlatformTools` another port fails by name.
 */
describe('the composed get_conversation', () => {
  it('answers the ticket’s comments through the integrations port it is given, redacted', async () => {
    const PLANTED = 'FAKE-planted-pipeline-token-0181';
    const tracker = createFakeTaskManagement({
      integrationId: '00000000-0000-4000-8000-0000000001b2' as Id,
      tickets: [
        {
          key: 'FAKE-9',
          title: 'Totals',
          comments: [
            {
              authorId: 'user-1',
              body: `Rotate ${PLANTED}, please.`,
              createdAt: '2026-10-08T09:00:00.000Z',
            },
          ],
        },
      ],
    });
    const integrations = staticPipelineIntegrations({
      executor: createIntegrationActionExecutor({
        egress: allowAnyIntegrationHost(),
        auditLog: createMemoryAuditLog(),
        redactor: exactSecretRedactor([]),
        timer: createVirtualTimer({ autoAdvance: true }),
        clock: { now: () => '2026-10-09T09:00:00.000Z' as IsoDateTime },
      }),
      git: null,
      taskManagement: {
        port: tracker,
        ref: tracker.ref,
        redactor: exactSecretRedactor([{ name: 'tracker_token', value: PLANTED }]),
      },
      communication: null,
    });
    const pool = {
      query: async () => ({
        rows: [
          {
            ticket_provider: tracker.ref.provider,
            ticket_key: 'FAKE-9',
            ticket_url: 'https://tickets.example.test/browse/FAKE-9',
            ticket_id: null,
            mr_ref: null,
          },
        ],
      }),
    } as unknown as pg.Pool;
    const tools = composePipelinePlatformTools({
      pool,
      logger: silentLogger,
      unitOfWork: { transaction: async () => Promise.reject(new Error('unreachable')) },
      tasks: { recordMergeRequest: async () => Promise.reject(new Error('unreachable')) },
      integrations,
      agent: {} as Parameters<typeof composePipelinePlatformTools>[0]['agent'],
    });
    const answer = (await tools.getConversation(
      {},
      {
        runId: '00000000-0000-4000-8000-0000000001b3' as Id,
        taskId: '00000000-0000-4000-8000-0000000001b4' as Id,
        projectId: '00000000-0000-4000-8000-0000000001b5' as Id,
        mode: 'normal',
        signal: new AbortController().signal,
      },
    )) as { available: boolean; entries: { source: string; body: string }[] };
    expect(answer.available).toBe(true);
    expect(answer.entries.map((entry) => entry.source)).toEqual(['ticket']);
    expect(answer.entries[0]?.body).toBe('Rotate [REDACTED:integration:tracker_token], please.');
    expect(JSON.stringify(answer)).not.toContain(PLANTED);
  });
});
