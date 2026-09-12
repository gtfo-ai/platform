/**
 * Both branches of the composition decision, in one file, because they are each other's control.
 *
 * **The first describe is WP-15b's acceptance criterion.** `startRuntime()` with *no options at
 * all* — the call `main.ts:18` and `scripts/dev.mjs` make — composes the pipeline, builds a real
 * `IntegrationAuditLog` from its own pool, and answers `/readyz` **200** on `ROLE=all`. Until this
 * work package that was 503 for ever: `integration_actions` had no `project_id`, `redaction_count`
 * or `attempts` column, nothing implemented the port, and so no production process registered a
 * single handler. The instance here is started exactly as `auth.e2e.test.ts` and `sse.e2e.test.ts`
 * start theirs — `startInstance()` passes no `pipeline` — so the composition under test is the
 * production one and not an argument a harness supplied (standing rules 31 and 35).
 *
 * **The second describe is the state that used to be production**, kept because the gate it proves
 * is still the thing standing between a partial consumer and another process's work. It is now
 * reached through the labelled seam `pipeline: null` (see `StartRuntimeOptions.pipeline`), and it
 * is worse than "nothing" in two ways that review round 1 of WP-15a found:
 *
 *  1. **the ticket was eaten.** `EventBus.dispatch` treats "no handler matched" as a completed
 *     dispatch — it deletes the `event_dispatch` row and writes the `$dispatch` marker that makes a
 *     re-dispatch a deliberate no-op — so a `ticket.matched` arriving at such an instance was
 *     consumed and unreplayable. Standing rule 20's inbound half: being told something you cannot
 *     handle is not licence to forget it. The sweep is no longer started when the bus has no
 *     handlers, and the event stays queued for an instance that can act on it.
 *  2. **`/readyz` was green.** Database, migrations and queue were all `ok`, so an orchestrator was
 *     told a process was ready to serve a product that would never advance a ticket. A boot `warn`
 *     is not a readiness signal.
 *
 * Every negative below is anchored by something positive taken from the **live** instance over
 * HTTP, because "the row is still there" also passes against a process that never started
 * (standing rule 10): `/readyz` answers 503 naming the check, and `/metrics` reports the queued
 * event in `event_dispatch_pending`.
 */
import { PassThrough } from 'node:stream';
import type { Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { eventing as eventingAdapters } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../../integration/support/migrated.js';
import { createTestPool } from '../../integration/support/postgres.js';
import { type Instance, startInstance } from '../support/instance.js';
import { type PipelineE2E, seedWorld, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let instance: Instance | undefined;
let composed: PipelineE2E | undefined;
let database: MigratedDatabase | undefined;
let defaultInstance: Instance | undefined;

afterAll(async () => {
  await instance?.stop();
  await composed?.stop();
  await defaultInstance?.stop();
  await database?.drop();
  instance = undefined;
  composed = undefined;
  defaultInstance = undefined;
  database = undefined;
});

describe('an instance started the way main.ts starts one', () => {
  let logged: string[] = [];
  let readyStatus = 0;
  let readyz: { status: string; checks: Record<string, string> };

  beforeAll(async () => {
    const lines: string[] = [];
    const destination = new PassThrough();
    destination.on('data', (chunk: Buffer) => {
      lines.push(chunk.toString('utf8'));
    });

    // No `pipeline` argument of any kind — `startInstance` only forwards one when it is given one.
    defaultInstance = await startInstance({
      label: 'default-composition',
      logLevel: 'warn',
      logDestination: destination,
    });
    logged = lines.join('').split('\n');

    const ready = await defaultInstance.runtime.app.inject({ method: 'GET', url: '/readyz' });
    readyStatus = ready.statusCode;
    readyz = { ...(ready.json() as typeof readyz) };
  }, 180_000);

  it('reports /readyz ok on ROLE=all, dispatch check included', () => {
    // The line WP-15b exists to change. `dispatch` is `sweepReadiness(bus.registry).ready`, so a
    // 200 here says the process registered a handler, by name, for every type
    // `EVENT_CONSUMPTION` declares consumed — which nothing in production did before this.
    expect(readyStatus).toBe(200);
    expect(readyz).toMatchObject({
      status: 'ok',
      checks: { database: 'ok', migrations: 'ok', queue: 'ok', dispatch: 'ok' },
    });
  });

  it('names the agent runner as the one collaborator it still has no adapter for', () => {
    // And **not** the audit log: this assertion is the mutation guard for the composition change.
    // If `composePipeline` went back to taking an `IntegrationAuditLog` from its caller, a process
    // with no caller would log that it is missing one, and the second half of this would fail.
    const missing = logged.find((line) => line.includes('composed without an agent runner'));
    expect(missing).toBeDefined();
    expect(missing).toContain('Q52');
    expect(logged.join('\n')).not.toContain('IntegrationAuditLog');
    expect(logged.join('\n')).not.toContain('the pipeline is not composed');
  });
});

/**
 * One instance, three assertions, because **the two gates have to be observable apart**.
 *
 * `sweepReadiness` decides both whether the outbox worker starts and what `/readyz`'s `dispatch`
 * check answers, deliberately (standing rule 41). A single test asserting both in sequence hides
 * that: the first assertion fails and the second never runs, so a mutation that broke only one of
 * them would look the same as one that broke both. Split, mutating the predicate moves **both**
 * named tests, which is the property the pair exists to have.
 */
describe('an instance started with the pipeline disabled', () => {
  let logged: string[] = [];
  let readyz: { status: string; checks: Record<string, string> };
  let readyStatus = 0;
  let taskCount = '';
  let metricsBody = '';
  let projectId = '' as Id;

  beforeAll(async () => {
    const lines: string[] = [];
    const destination = new PassThrough();
    destination.on('data', (chunk: Buffer) => {
      lines.push(chunk.toString('utf8'));
    });

    database = await createMigratedDatabase('uncomposed');
    instance = await startInstance({
      database,
      logLevel: 'warn',
      logDestination: destination,
      // The labelled seam. `undefined` would compose the pipeline, which is the whole point of the
      // describe above; `null` is the only way to reach the incomplete-consumer state now.
      pipeline: null,
      env: { APP_DISPATCH_POLL_INTERVAL_MS: '25' },
    });
    logged = lines.join('').split('\n');

    const pool = createTestPool(instance.database.connectionString, { max: 4 });
    const inbound = eventingAdapters.createEventing({
      pool,
      connectionString: instance.database.connectionString,
      config: { maxConcurrency: 1 },
    });
    try {
      // The bindings the *second* instance will load, seeded now so the handover below tests only
      // what it means to test: whether the event survived.
      const seeded = await seedWorld(pool, {});
      projectId = seeded.projectId;

      await inbound.unitOfWork.transaction(async (scope) =>
        scope.events.append([
          domainEventSchemasByType['ticket.matched'].parse({
            id: '00000000-0000-4000-9000-00000000f001',
            stream_type: 'project',
            stream_id: projectId,
            stream_seq: 1,
            correlation_id: null,
            cause_event_id: null,
            actor: { kind: 'system', component: 'test' },
            occurred_at: new Date().toISOString(),
            type: 'ticket.matched',
            payload: {
              project_id: projectId,
              ticket: {
                provider: 'fake-task-management',
                key: 'ACME-1',
                url: 'https://tickets.example.test/browse/ACME-1',
              },
              rule: 'label:agentic',
              priority: 'High',
              issue_type: 'Story',
              epic: null,
              links: [],
            },
          }) as never,
        ]),
      );

      // No assertions in `beforeAll`: a throw here skips every test in the file, which would hide
      // *which* of the two gates a mutation moved — the exact thing this split exists to show.
      const ready = await instance.runtime.app.inject({ method: 'GET', url: '/readyz' });
      readyStatus = ready.statusCode;
      readyz = { ...(ready.json() as typeof readyz) };
      metricsBody = (await instance.runtime.app.inject({ method: 'GET', url: '/metrics' })).body;
      taskCount =
        (await pool.query<{ count: string }>('select count(*)::text as count from tasks')).rows[0]
          ?.count ?? 'no row';
    } finally {
      await inbound.stop();
      await pool.end();
    }
  }, 180_000);

  it('names the event types it cannot handle and does not start the outbox sweep', () => {
    const disabled = logged.find((line) => line.includes('the pipeline disabled'));
    expect(disabled).toBeDefined();

    const refused = logged.find((line) => line.includes('the outbox sweep is not started'));
    expect(refused).toBeDefined();
    expect(refused).toContain('ticket.matched');
  });

  it('reports /readyz down with the dispatch check named, however healthy the rest is', () => {
    // The other half of the pair `sweepReadiness` serves. Asserted in its own test so a mutation
    // that broke only this one is distinguishable from one that broke only the sweep gate.
    expect(readyStatus).toBe(503);
    expect(readyz).toMatchObject({
      status: 'down',
      checks: { database: 'ok', migrations: 'ok', queue: 'ok', dispatch: 'down' },
    });
    // The instance *sees* the event it is not dispatching, and says so on the gauge an operator
    // would alert on — a positive anchor for the negatives below (standing rule 10).
    expect(metricsBody).toMatch(/^event_dispatch_pending 1$/m);
  });

  it('leaves the ticket queued and replayable, and the next instance runs it', async () => {
    // **After** the shutdown, not before. Asserting the queue state while the instance was still up
    // is what made the first version of this test pass with the guard removed: a running sweep
    // simply had not got to the event yet. `runtime.stop()` drains the dispatcher, so this is the
    // one moment at which "the row is still here" means "nothing ever swept it" (standing rule 4).
    expect(taskCount).toBe('0');

    const handedOver = instance;
    instance = undefined;
    await handedOver?.stop();

    const after = new pg.Client({
      connectionString: (database as MigratedDatabase).connectionString,
    });
    await after.connect();
    try {
      const queued = await after.query<{ attempts: number }>('select attempts from event_dispatch');
      expect(queued.rows).toHaveLength(1);
      expect(queued.rows[0]?.attempts).toBe(0);

      // Still *replayable*: the `$dispatch` marker is what makes a re-dispatch a deliberate no-op,
      // so its absence is the difference between "not yet" and "gone".
      const markers = await after.query<{ count: string }>(
        "select count(*)::text as count from handler_executions where handler = '$dispatch'",
      );
      expect(markers.rows[0]?.count).toBe('0');
    } finally {
      await after.end();
    }

    /**
     * The handover, and the reason this test is not a wall-clock one: an instance that *was*
     * sweeping consumes the event as it drains on the way down, and a second instance with a
     * pipeline then finds nothing. So the assertion is a **positive** one about the product's
     * promise — the instance that could not act on the notification did not destroy it, and the
     * next one that can, does.
     */
    composed = await startPipeline({
      scenarios: featureScenarios,
      reuse: { database: database as MigratedDatabase, projectId },
      tickets: TICKETS,
    });
    const task = await composed.settle('ready_for_merge', (row) => row.state === 'ready_for_merge');
    expect(task.template).toBe('feature');
  }, 180_000);
});
