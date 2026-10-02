/**
 * A maintainer's re-evaluate — WP-94, PROGRESS backlog 230, Q107 (a).
 *
 * The claims held here: a re-evaluation is a **new** discovery task on the same template whose one
 * agent stage runs through the shared stage executor (so the admission guard and the ledger are the
 * first run's); the first run's task stands beside it; one discovery runs at a time; the key moves
 * with the latest evaluation and a run that records nothing spends one of a bounded number of
 * attempts; and the read gate answers exactly what the command would.
 */
import type { DiscoveryDraftData, Id, IsoDateTime } from '@platform/contracts';
import { DEFAULT_STAGE_RUN_BUDGET_USD, SHIPPED_TEMPLATES } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { staticProjectSettings } from '../pipeline/settings.js';
import { silentLogger } from '../ports/logger.js';
import { memoryReadinessStore } from '../testing/memory-readiness.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import {
  DISCOVERY_TEMPLATE_ID,
  DISCOVERY_TICKET_KEY,
  type StartDiscoveryOptions,
  startProjectDiscovery,
} from './discovery.js';
import type { ReadinessEvaluation } from './ports.js';
import {
  elapsedSince,
  isRediscoveryTicketKey,
  MAX_REDISCOVERY_ATTEMPTS,
  readRediscoveryGate,
  rediscoveryTicketKeyFor,
  startProjectRediscovery,
} from './rediscovery.js';

const USER = '00000000-0000-4000-8000-0000000000c2' as Id;

const DRAFT: DiscoveryDraftData = {
  documents: [],
  commands: [],
  linked_documents: [],
  questions: [],
  readiness: [{ id: 'R1', passed: true, evidence: 'ran the suite: green' }],
};

const setup = (
  options: {
    readonly templates?: Readonly<Record<string, (typeof SHIPPED_TEMPLATES)[string]>>;
    readonly failing?: boolean;
    readonly stageBudgetUsd?: number;
  } = {},
) => {
  const templates = options.templates ?? SHIPPED_TEMPLATES;
  const harness = createPipelineHarness({
    settings: { templates },
    runs: {
      discovery:
        options.failing === true
          ? { status: 'failed', terminalReason: 'error_during_execution', error: 'exit 1' }
          : { status: 'completed', terminalReason: 'success', structuredOutput: DRAFT as never },
    },
  });
  const readiness = memoryReadinessStore();
  const discovery: StartDiscoveryOptions = {
    unitOfWork: harness.memory,
    store: harness.store,
    settings: staticProjectSettings(() => ({
      ...harness.settings,
      templates,
      ...(options.stageBudgetUsd === undefined
        ? {}
        : {
            config: {
              ...harness.settings.config,
              stages: { discovery: { budget_usd: options.stageBudgetUsd } },
            } as never,
          }),
    })),
    jobs: harness.jobs,
    ids: harness.ids,
    clock: { now: () => harness.clock.now() },
    baseUrl: 'https://agentic.example.test',
    logger: silentLogger,
  };
  return {
    harness,
    readiness,
    discovery,
    rediscovery: { ...discovery, readiness },
    gate: { ...discovery, readiness },
    projectId: harness.projectId,
  };
};

const settle = async (harness: PipelineHarness): Promise<void> => {
  await harness.publish([]);
};

/** Records an evaluation, as the discovery recorder or a re-check would — a new basis. */
const recordEvaluation = async (
  readiness: ReturnType<typeof memoryReadinessStore>,
  projectId: Id,
  id: string,
  at: string,
): Promise<ReadinessEvaluation> => {
  const evaluation: ReadinessEvaluation = {
    id: id as Id,
    projectId,
    level: 0,
    criteria: [],
    evaluatedAt: at as IsoDateTime,
    source: 'discovery',
  };
  await readiness.record({} as never, evaluation);
  return evaluation;
};

describe('startProjectRediscovery', () => {
  it('opens a new discovery task beside the first and runs its one stage through the executor', async () => {
    const { harness, readiness, discovery, rediscovery, projectId } = setup();
    const first = await startProjectDiscovery(discovery, { projectId, requestedByUserId: USER });
    await settle(harness);
    const basis = await recordEvaluation(readiness, projectId, 'e1', '2026-09-20T04:00:00.000Z');

    const again = await startProjectRediscovery(rediscovery, {
      projectId,
      requestedByUserId: USER,
    });
    expect(again.status).toBe('started');
    await settle(harness);

    const tasks = harness.store.snapshot();
    expect(tasks).toHaveLength(2);
    // The first run's task stands, untouched.
    expect(tasks[0]?.task.id).toBe(first.status === 'started' ? first.taskId : 'none');
    expect(tasks[0]?.task.ticket.key).toBe(DISCOVERY_TICKET_KEY);
    const second = tasks[1];
    expect(second?.task.template).toBe(DISCOVERY_TEMPLATE_ID);
    expect(second?.task.ticket.key).toBe(rediscoveryTicketKeyFor(basis.id, 1));
    expect(isRediscoveryTicketKey(second?.task.ticket.key ?? '')).toBe(true);
    expect(second?.requestedByUserId).toBe(USER);
    // Two runs of the discovery role, each through the shared stage executor — the second is the
    // re-evaluation's, on its own task.
    expect(harness.specs.map((spec) => [spec.stage, spec.role])).toEqual([
      ['discovery', 'discovery'],
      ['discovery', 'discovery'],
    ]);
    expect(harness.specs[1]?.taskId).toBe(second?.task.id);
    expect(second?.task.state).toBe('done');
  });

  it('answers with the live discovery task and starts nothing while one runs', async () => {
    const { harness, discovery, rediscovery, projectId } = setup();
    const first = await startProjectDiscovery(discovery, { projectId, requestedByUserId: USER });
    // Not settled: the first discovery has not run yet.
    const again = await startProjectRediscovery(rediscovery, {
      projectId,
      requestedByUserId: USER,
    });
    expect(again).toMatchObject({
      status: 'in_flight',
      taskId: first.status === 'started' ? first.taskId : 'none',
    });
    expect(harness.store.snapshot()).toHaveLength(1);
  });

  it('says how long ago the live discovery task started, and names cancel as the way out (WP-108, backlog 320)', async () => {
    const { harness, discovery, rediscovery, gate, projectId } = setup();
    const first = await startProjectDiscovery(discovery, { projectId, requestedByUserId: USER });
    const taskId = first.status === 'started' ? first.taskId : 'none';
    // The stage job never runs: nothing settles, and three hours pass.
    harness.clock.advance(3 * 60 * 60_000 + 59_000);
    const again = await startProjectRediscovery(rediscovery, {
      projectId,
      requestedByUserId: USER,
    });
    expect(again.status).toBe('in_flight');
    expect(again.detail).toContain(`discovery task ${taskId} started 3 hours ago`);
    expect(again.detail).toContain(`cancel it there (POST /api/tasks/${taskId}/cancel)`);
    expect(again.detail).not.toContain('follow it rather than starting a second run');
    // The read gate says the same sentence, so the screen shows it on the disabled button.
    const read = await readRediscoveryGate(gate, projectId);
    expect(read.blocker).toMatchObject({ code: 'discovery_in_flight', detail: again.detail });
  });

  it('is blocked by a parked discovery task, and names it', async () => {
    const { harness, discovery, rediscovery, projectId } = setup({ failing: true });
    await startProjectDiscovery(discovery, { projectId, requestedByUserId: USER });
    await settle(harness);
    expect(harness.store.snapshot()[0]?.task.state).toBe('needs_human');
    const again = await startProjectRediscovery(rediscovery, {
      projectId,
      requestedByUserId: USER,
    });
    expect(again.status).toBe('in_flight');
    expect(again.detail).toContain('parked for a human');
    expect(harness.store.snapshot()).toHaveLength(1);
    expect(harness.specs).toHaveLength(1);
  });

  it('refuses a project that never ran discovery, and creates nothing', async () => {
    const { harness, rediscovery, projectId } = setup();
    const refused = await startProjectRediscovery(rediscovery, {
      projectId,
      requestedByUserId: USER,
    });
    expect(refused).toMatchObject({ status: 'refused', code: 'discovery_not_started' });
    expect(harness.store.snapshot()).toEqual([]);
  });

  it('refuses by name when the deployment has no discovery template', async () => {
    const { feature, bug, chore } = SHIPPED_TEMPLATES;
    const { harness, rediscovery, projectId } = setup({
      templates: { feature, bug, chore } as never,
    });
    const refused = await startProjectRediscovery(rediscovery, {
      projectId,
      requestedByUserId: USER,
    });
    expect(refused).toMatchObject({ status: 'refused', code: 'discovery_unavailable' });
    expect(harness.store.snapshot()).toEqual([]);
  });

  it('spends one attempt per run that records nothing, refuses past the bound, and a new evaluation opens a new round', async () => {
    const { harness, readiness, discovery, rediscovery, projectId } = setup();
    await startProjectDiscovery(discovery, { projectId, requestedByUserId: USER });
    await settle(harness);
    // Nothing is recorded in this harness (the recorder is not composed), so every re-evaluation
    // leaves the basis where it was: the "ran and recorded nothing" case.
    for (let attempt = 1; attempt <= MAX_REDISCOVERY_ATTEMPTS; attempt += 1) {
      const started = await startProjectRediscovery(rediscovery, {
        projectId,
        requestedByUserId: USER,
      });
      expect(started.status, `attempt ${attempt}`).toBe('started');
      await settle(harness);
      expect(harness.store.snapshot().at(-1)?.task.ticket.key).toBe(
        rediscoveryTicketKeyFor(null, attempt),
      );
    }
    const spent = await startProjectRediscovery(rediscovery, {
      projectId,
      requestedByUserId: USER,
    });
    expect(spent).toMatchObject({ status: 'refused', code: 'rediscovery_attempts_spent' });
    expect(harness.store.snapshot()).toHaveLength(1 + MAX_REDISCOVERY_ATTEMPTS);

    // An evaluation lands (a re-check after a merge, or a recorded run): a new basis, a new round.
    const basis = await recordEvaluation(readiness, projectId, 'e2', '2026-09-21T04:00:00.000Z');
    const reopened = await startProjectRediscovery(rediscovery, {
      projectId,
      requestedByUserId: USER,
    });
    expect(reopened.status).toBe('started');
    expect(harness.store.snapshot().at(-1)?.task.ticket.key).toBe(
      rediscoveryTicketKeyFor(basis.id, 1),
    );
  });
});

describe('readRediscoveryGate', () => {
  it('publishes the stage’s run budget as the ceiling, and what the last discovery cost', async () => {
    const { harness, discovery, gate, projectId } = setup();
    const before = await readRediscoveryGate(gate, projectId);
    expect(before).toMatchObject({
      ceilingUsd: DEFAULT_STAGE_RUN_BUDGET_USD.discovery,
      lastDiscovery: null,
      blocker: { code: 'discovery_not_started' },
      ticketKey: null,
    });
    await startProjectDiscovery(discovery, { projectId, requestedByUserId: USER });
    await settle(harness);
    const after = await readRediscoveryGate(gate, projectId);
    expect(after.blocker).toBeNull();
    expect(after.ticketKey).toBe(rediscoveryTicketKeyFor(null, 1));
    expect(after.lastDiscovery).toMatchObject({
      state: 'done',
      costUsd: harness.store.snapshot()[0]?.costActualUsd,
    });
    // Reading decides and creates nothing (rule 79: the effect is countable).
    expect(harness.store.snapshot()).toHaveLength(1);
  });

  it('carries the recovery’s ending for the last discovery task, asked of that task, and null without it (WP-124)', async () => {
    const { harness, discovery, gate, projectId } = setup();
    await startProjectDiscovery(discovery, { projectId, requestedByUserId: USER });
    await settle(harness);
    const asked: string[] = [];
    const lost = { at: '2026-10-02T10:00:00.000Z' as IsoDateTime, reason: 'never recorded' };
    const read = await readRediscoveryGate(
      {
        ...gate,
        findingsUnrecorded: async (taskId) => {
          asked.push(taskId);
          return lost;
        },
      },
      projectId,
    );
    expect(read.lastDiscovery?.findingsUnrecorded).toEqual(lost);
    expect(asked).toEqual([read.lastDiscovery?.taskId]);
    expect(
      (await readRediscoveryGate(gate, projectId)).lastDiscovery?.findingsUnrecorded,
    ).toBeNull();
  });

  it('reads the project’s own stage budget when it sets one', async () => {
    const { gate, projectId } = setup({ stageBudgetUsd: 3.5 });
    expect((await readRediscoveryGate(gate, projectId)).ceilingUsd).toBe(3.5);
  });

  it('answers the in-flight blocker the command would answer', async () => {
    const { discovery, gate, rediscovery, projectId } = setup();
    await startProjectDiscovery(discovery, { projectId, requestedByUserId: USER });
    const read = await readRediscoveryGate(gate, projectId);
    const command = await startProjectRediscovery(rediscovery, {
      projectId,
      requestedByUserId: USER,
    });
    expect(read.blocker?.code).toBe('discovery_in_flight');
    expect(command.status).toBe('in_flight');
    expect(read.blocker?.detail).toBe(command.detail);
  });
});

describe('elapsedSince (WP-108)', () => {
  it.each([
    ['2026-09-20T10:00:30.000Z', 'less than a minute'],
    ['2026-09-20T10:01:00.000Z', '1 minute'],
    ['2026-09-20T11:59:59.000Z', '119 minutes'],
    ['2026-09-20T12:00:00.000Z', '2 hours'],
    ['2026-09-22T09:59:59.000Z', '47 hours'],
    ['2026-09-22T10:00:00.000Z', '2 days'],
  ])('reads %s as %s after 10:00', (now, phrase) => {
    expect(elapsedSince('2026-09-20T10:00:00.000Z', now)).toBe(phrase);
  });
});
