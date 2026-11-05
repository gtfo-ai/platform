/**
 * **The production redactor of a remote run** (WP-282, backlog 745, review of PR #22): the composition
 * `worker-run-calls.ts` and `worker-protocol.ts` build — `projectBindingRedactor` over the project's
 * bindings, `createRemoteRunRedactors` for transcript ingest, `remoteSettleRedactorFor` for the settle —
 * driven over `staticPipelineIntegrations` whose bindings each hold a planted secret no other redactor
 * in the world knows. The unit tests of `remote-run-calls.ts` stub `redactors.forRun`; these do not.
 */
import {
  createMemoryRemoteRunCallStore,
  createRemoteRunCalls,
  createTestRunPlanSealer,
  exactSecretRedactor,
  type IntegrationActionExecutor,
  MemoryEventing,
  type PipelineIntegrationsPort,
  type PipelineStore,
  type RunSettlement,
  silentLogger,
  staticPipelineIntegrations,
  workerLeaseOwner,
} from '@platform/application';
import type { Id, JsonObject } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { remoteSettleRedactorFor } from './worker-protocol.js';
import {
  createRemoteRunRedactors,
  projectBindingRedactor,
  runDisplayOf,
} from './worker-run-calls.js';

const RUN = '00000000-0000-4000-8000-000000282101' as Id;
const TASK = '00000000-0000-4000-8000-000000282102' as Id;
const PROJECT = '00000000-0000-4000-8000-000000282103' as Id;
const WORKER = '00000000-0000-4000-8000-000000282104' as Id;
/** Sealed secrets of three bindings, each shaped past a real token pattern (rule 93). */
const GIT_SECRET = 'FAKE-git-binding-secret-0282-dddddddddd';
const TRACKER_SECRET = 'FAKE-tracker-binding-secret-0282-eeeeee';
const ERRORS_SECRET = 'FAKE-errors-binding-secret-0282-ffffffff';
const MODEL_KEY = 'FAKE-model-api-key-0282-gggggggggggggggg';

const bindings = (): PipelineIntegrationsPort =>
  staticPipelineIntegrations(
    {
      executor: {} as IntegrationActionExecutor,
      git: {
        port: {} as never,
        ref: { integrationId: 'git', provider: 'fake-git', type: 'git' } as never,
        project: 'acme/api',
        redactor: exactSecretRedactor([{ name: 'git_token', value: GIT_SECRET }]),
      },
      taskManagement: {
        port: {} as never,
        ref: { integrationId: 'jira', provider: 'fake-jira', type: 'task_management' } as never,
        redactor: exactSecretRedactor([{ name: 'jira_token', value: TRACKER_SECRET }]),
      } as never,
      communication: null,
    },
    {
      errors: {
        port: {} as never,
        ref: { integrationId: 'sentry', provider: 'fake-sentry', type: 'errors' } as never,
        redactor: exactSecretRedactor([{ name: 'sentry_token', value: ERRORS_SECRET }]),
      },
    },
  );

/** The process's own rules: nothing a binding holds. */
const platformRedactor = exactSecretRedactor([]);

const redactors = () =>
  createRemoteRunRedactors({
    integrations: bindings(),
    stack: { platformRedactor },
    agent: { providerMode: 'api', modelApiKey: MODEL_KEY, modelOauthToken: null },
    logger: silentLogger,
  });

const planted = `git ${GIT_SECRET} tracker ${TRACKER_SECRET} errors ${ERRORS_SECRET} model ${MODEL_KEY} kept`;

describe('the remote run’s redactor, rebuilt from stored state (backlog 745)', () => {
  it('projectBindingRedactor composes every binding’s sealed secrets, observability included', async () => {
    const redactor = await projectBindingRedactor(bindings(), PROJECT, platformRedactor);
    const out = redactor.redactText(planted);
    expect(out.value).not.toContain(GIT_SECRET);
    expect(out.value).not.toContain(TRACKER_SECRET);
    expect(out.value).not.toContain(ERRORS_SECRET);
    expect(out.value).toContain('kept');
    expect(out.count).toBe(3);
  });

  it('transcript ingest stores a planted binding secret redacted, through createRemoteRunRedactors', async () => {
    const memory = new MemoryEventing();
    const store = createMemoryRemoteRunCallStore({ fenceHolds: async () => true });
    const pipeline = {
      runs: {
        lockSettlement: async (): Promise<RunSettlement> => ({
          runId: RUN,
          status: 'running',
          terminalReason: null,
          leaseEpoch: 1,
          leaseOwner: workerLeaseOwner(WORKER),
        }),
        load: async () => ({ id: RUN, taskId: TASK, projectId: PROJECT }),
      },
      runPlans: { load: async () => null },
    } as unknown as Pick<PipelineStore, 'runs' | 'runPlans'>;
    const calls = createRemoteRunCalls({
      unitOfWork: memory,
      store,
      pipeline,
      runPlans: createTestRunPlanSealer(),
      redactors: redactors(),
      tools: {} as never,
      approvals: {} as never,
      deployKeys: { forRun: async () => null },
      maxSignatures: 128,
    });
    const event: JsonObject = {
      run_id: RUN,
      seq: 0,
      created_at: new Date().toISOString(),
      redaction_count: 0,
      kind: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: planted }],
    };
    expect(
      await calls.transcript({
        runId: RUN,
        workerId: WORKER,
        epoch: 1,
        entries: [{ seq: 0, event }],
      }),
    ).toEqual({ kind: 'stored', stored: 1, refusedSeqs: [] });
    const stored = JSON.stringify(store.transcriptRows(RUN));
    for (const secret of [GIT_SECRET, TRACKER_SECRET, ERRORS_SECRET, MODEL_KEY]) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).toContain('kept');
    expect(store.transcriptRows(RUN)[0]?.redaction_count).toBe(4);
  });

  it('the settle redacts with the run’s project bindings, and falls back to the platform’s rules when they cannot be loaded', async () => {
    const pool = { query: async () => ({ rows: [{ project_id: PROJECT }] }) } as never;
    const settle = remoteSettleRedactorFor({
      pool,
      platformRedactor,
      runRedactors: redactors(),
      logger: silentLogger,
    });
    const redacted = (await settle(RUN)).redactText(planted).value;
    expect(redacted).not.toContain(GIT_SECRET);
    expect(redacted).not.toContain(TRACKER_SECRET);
    expect(redacted).not.toContain(ERRORS_SECRET);

    const failing = remoteSettleRedactorFor({
      pool,
      platformRedactor,
      runRedactors: {
        baseFor: async () => {
          throw new Error('a binding failed to load');
        },
      },
      logger: silentLogger,
    });
    expect(await failing(RUN)).toBe(platformRedactor);
    const without = remoteSettleRedactorFor({
      pool,
      platformRedactor,
      runRedactors: undefined,
      logger: silentLogger,
    });
    expect(await without(RUN)).toBe(platformRedactor);
  });
});

describe('the local page’s names for a run (WP-292)', () => {
  const poolOf = (rows: unknown[]) =>
    ({ query: async () => ({ rows }) }) as unknown as Parameters<typeof runDisplayOf>[0];

  it('names the project, the ticket and the snapshot’s title, cut to the block’s bound', async () => {
    expect(
      await runDisplayOf(
        poolOf([
          {
            project_key: 'ACME',
            ticket_key: 'ACME-7',
            ticket_snapshot: { title: `Fix the login ${'x'.repeat(600)}` },
          },
        ]),
      )('task'),
    ).toEqual({
      projectKey: 'ACME',
      ticketKey: 'ACME-7',
      title: `Fix the login ${'x'.repeat(486)}`,
    });
  });

  it('answers a null title for no snapshot, and nothing for a task that is gone', async () => {
    expect(
      await runDisplayOf(
        poolOf([{ project_key: 'ACME', ticket_key: 'ACME-7', ticket_snapshot: null }]),
      )('task'),
    ).toEqual({ projectKey: 'ACME', ticketKey: 'ACME-7', title: null });
    expect(await runDisplayOf(poolOf([]))('task')).toBeNull();
  });
});
