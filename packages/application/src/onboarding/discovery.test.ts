/**
 * Starting a discovery run — WP-21.
 *
 * The claims worth holding: the task is a **real pipeline task** on the discovery template, its one
 * agent stage is enqueued on `stage.execute` (so everything downstream is the shared executor, not
 * a second path), the command is idempotent on the project, and a deployment without the template
 * says so by name instead of falling back to a delivery pipeline.
 */
import type { DiscoveryDraftData, Id } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { staticProjectSettings } from '../pipeline/settings.js';
import { silentLogger } from '../ports/logger.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import {
  DISCOVERY_TEMPLATE_ID,
  DISCOVERY_TICKET_KEY,
  DISCOVERY_TICKET_PROVIDER,
  type StartDiscoveryOptions,
  startProjectDiscovery,
} from './discovery.js';

const USER = '00000000-0000-4000-8000-0000000000a2' as Id;

const DRAFT: DiscoveryDraftData = {
  documents: [
    {
      path: 'technical/overview.md',
      title: 'Overview',
      markdown: '# Overview\n',
      confidence: 'medium',
    },
  ],
  commands: [],
  linked_documents: [],
  questions: [],
  readiness: [{ id: 'R1', passed: true, evidence: 'ran the suite: green' }],
};

/**
 * The **whole** pipeline, not a stub of it.
 *
 * `startProjectDiscovery` enters the template's `intake` — a system stage that completes in the
 * same transaction — so the *agent* stage is enqueued by the saga on `task.stage.completed`, one
 * dispatch later. A harness that only held a store would therefore assert the command wrote a row
 * and could never see whether a run happened, which is the half that matters (standing rule 82's
 * shape: ask what the double does with the thing under test).
 */
const setup = (
  templates: Readonly<Record<string, (typeof SHIPPED_TEMPLATES)[string]>> = SHIPPED_TEMPLATES,
) => {
  const harness = createPipelineHarness({
    settings: { templates },
    runs: {
      discovery: {
        status: 'completed',
        terminalReason: 'success',
        structuredOutput: DRAFT as never,
      },
    },
  });
  const options: StartDiscoveryOptions = {
    unitOfWork: harness.memory,
    store: harness.store,
    settings: staticProjectSettings(() => ({ ...harness.settings, templates })),
    jobs: harness.jobs,
    ids: harness.ids,
    clock: { now: () => harness.clock.now() },
    baseUrl: 'https://agentic.example.test/',
    logger: silentLogger,
  };
  return { harness, options, projectId: harness.projectId };
};

/** Dispatches whatever the command queued, the way the composition root's bus would. */
const settle = async (harness: PipelineHarness): Promise<void> => {
  await harness.publish([]);
};

describe('startProjectDiscovery', () => {
  it('creates a task on the discovery template and runs its one agent stage', async () => {
    const { harness, options, projectId } = setup();
    const result = await startProjectDiscovery(options, {
      projectId,
      requestedByUserId: USER,
    });

    expect(result.status).toBe('started');
    const [created] = harness.store.snapshot();
    expect(created?.task.template).toBe(DISCOVERY_TEMPLATE_ID);
    expect(created?.task.projectId).toBe(projectId);
    // The ticket the platform issued for a project that has none. The trailing slash of the base
    // URL is dropped, so the URL is not `…test//projects/…`.
    expect(created?.task.ticket).toEqual({
      provider: DISCOVERY_TICKET_PROVIDER,
      key: DISCOVERY_TICKET_KEY,
      url: `https://agentic.example.test/projects/${projectId}`,
    });
    const firstEvent = (await harness.memory.store.readStream('task', created?.task.id as Id))[0];
    expect(firstEvent?.event.actor).toEqual({ kind: 'user', user_id: USER });
    // Nothing ever asks a provider about this key, so there is no snapshot — and `null` is what
    // `ensureTicketSnapshot` already reads as "the platform has not read this ticket".
    expect(created?.ticketSnapshot).toBeNull();

    await settle(harness);

    // The whole point of the decision: the run went through the shared stage executor, with the
    // role and the artifact type the template declares.
    expect(harness.specs.map((spec) => [spec.stage, spec.role])).toEqual([
      ['discovery', 'discovery'],
    ]);
    expect(harness.specs[0]?.artifactType).toBe('DiscoveryDraft');
    expect(harness.specs[0]?.taskId).toBe(created?.task.id);
    // …and the task finished, because the template's last stage is `done`.
    expect(harness.store.snapshot()[0]?.task.state).toBe('done');
    expect(harness.types()).toContain('artifact.created');
  });

  it('emits task.created and enters the template’s first stage', async () => {
    const { harness, options, projectId } = setup();
    await startProjectDiscovery(options, { projectId, requestedByUserId: USER });
    const [created] = harness.store.snapshot();
    const stream = await harness.memory.store.readStream('task', created?.task.id as Id);
    // `intake` is a system stage: it is entered and completed inside the command's own
    // transaction, and the *agent* stage is enqueued by the saga on the next dispatch. This is the
    // assertion that says so, so a reader does not have to infer it from the absence of a job.
    expect(stream.map((entry) => entry.event.type)).toEqual([
      'task.created',
      'task.dequeued',
      'task.stage.entered',
      'task.stage.completed',
    ]);
  });

  it('is idempotent on the project: a second call starts nothing', async () => {
    const { harness, options, projectId } = setup();
    const first = await startProjectDiscovery(options, { projectId, requestedByUserId: USER });
    await settle(harness);
    const runsAfterFirst = harness.specs.length;

    const second = await startProjectDiscovery(options, { projectId, requestedByUserId: USER });
    await settle(harness);

    expect(second.status).toBe('already_started');
    expect(second.status === 'already_started' ? second.taskId : null).toBe(
      first.status === 'started' ? first.taskId : 'other',
    );
    expect(harness.store.snapshot()).toHaveLength(1);
    // No second run, and therefore no second budget — which is the reason the command is
    // idempotent rather than merely tidy.
    expect(harness.specs).toHaveLength(runsAfterFirst);
    expect(runsAfterFirst).toBe(1);
  });

  it('refuses by name when the deployment has no discovery template', async () => {
    // Standing rule 20: fail closed on a mutation. Falling back to `feature` would run a whole
    // delivery pipeline — architecture, implementation, a merge request — on a project with no
    // ticket, which is the expensive way to be silent.
    const { feature, bug, chore } = SHIPPED_TEMPLATES;
    const { harness, options, projectId } = setup({ feature, bug, chore } as never);
    const result = await startProjectDiscovery(options, { projectId, requestedByUserId: USER });
    expect(result.status).toBe('unavailable');
    expect(result.detail).toContain('discovery');
    expect(harness.store.snapshot()).toEqual([]);
    expect(harness.specs).toEqual([]);
  });

  it('stamps the pipeline actor when nobody asked for it', async () => {
    // The other branch of `contextFor` (rule 10). A discovery run started by the platform rather
    // than by a human — a re-check, a recovery — must not attribute its events to a user id it
    // does not have, and `task.created` is where that shows.
    const { harness, options, projectId } = setup();
    await startProjectDiscovery(options, { projectId, requestedByUserId: null });
    const [created] = harness.store.snapshot();
    const stream = await harness.memory.store.readStream('task', created?.task.id as Id);
    expect(stream[0]?.event.actor).toEqual({ kind: 'system', component: 'pipeline' });
  });

  it('starts one discovery task per project, not one per deployment', async () => {
    const OTHER = '00000000-0000-4000-8000-0000000000a3' as Id;
    const { harness, options, projectId } = setup();
    await startProjectDiscovery(options, { projectId, requestedByUserId: USER });
    const second = await startProjectDiscovery(options, {
      projectId: OTHER,
      requestedByUserId: USER,
    });
    // The ticket key is the same string for both, so this is the case that fails if the idempotency
    // ever stops being scoped by project (`unique (project_id, ticket_key, mode)`).
    expect(second.status).toBe('started');
    expect(harness.store.snapshot()).toHaveLength(2);
  });
});
