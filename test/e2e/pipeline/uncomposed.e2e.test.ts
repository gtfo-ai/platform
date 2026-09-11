/**
 * The other branch of WP-15a's composition decision: an instance that was **not** given a pipeline.
 *
 * `apps/server` cannot compose the pipeline on its own in this build — there is no transport to the
 * launcher for a `ClaudeRunner` (Q52) and no adapter for `IntegrationAuditLog` — so `startRuntime`
 * takes them as an argument and a process without them runs without a pipeline. Standing rule 18
 * says the absent case must not be the permissive one, and standing rule 10 says a test must assert
 * *which* branch ran: the companion file proves a ticket walks to `task.completed` when the
 * composition is supplied, and this one proves the same ticket moves **nothing** when it is not, and
 * that the process said so.
 *
 * Deleting the `if (options.pipeline === undefined)` warning in `runtime.ts` kills the first
 * assertion; composing a pipeline unconditionally would kill the second.
 */
import { PassThrough } from 'node:stream';
import { domainEventSchemasByType } from '@platform/contracts';
import { eventing as eventingAdapters } from '@platform/infrastructure';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { type Instance, startInstance } from '../support/instance.js';

let instance: Instance | undefined;

afterEach(async () => {
  await instance?.stop();
  instance = undefined;
});

describe('an instance started without a pipeline composition', () => {
  it('names what is missing and leaves a matched ticket where it found it', async () => {
    const lines: string[] = [];
    const destination = new PassThrough();
    destination.on('data', (chunk: Buffer) => {
      lines.push(chunk.toString('utf8'));
    });

    instance = await startInstance({
      label: 'uncomposed',
      logLevel: 'warn',
      logDestination: destination,
      env: { APP_DISPATCH_POLL_INTERVAL_MS: '25' },
    });

    const warning = lines
      .join('')
      .split('\n')
      .find((line) => line.includes('the pipeline is not composed'));
    expect(warning).toBeDefined();
    expect(warning).toContain('Q52');
    expect(warning).toContain('IntegrationAuditLog');

    const pool = new pg.Pool({ connectionString: instance.database.connectionString, max: 4 });
    const inbound = eventingAdapters.createEventing({
      pool,
      connectionString: instance.database.connectionString,
      config: { maxConcurrency: 1 },
    });
    try {
      const project = await pool.query<{ id: string }>(
        `with org as (insert into organizations (name) values ('uncomposed') returning id)
         insert into projects (org_id, key, name, repo_url)
         select id, 'api', 'API', 'https://git.example.test/acme/api.git' from org returning id`,
      );
      const projectId = project.rows[0]?.id as string;

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

      // The dispatcher runs on its own timer; wait for the event to leave the queue, which is the
      // positive fact this can assert — "it dispatched, and no task exists" rather than "nothing
      // happened yet", which would also pass against a process that had not started.
      const deadline = Date.now() + 20_000;
      for (;;) {
        const pending = await pool.query<{ count: string }>(
          'select count(*)::text as count from event_dispatch',
        );
        if (pending.rows[0]?.count === '0') {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error('the event never left the dispatch queue');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const tasks = await pool.query<{ count: string }>(
        'select count(*)::text as count from tasks',
      );
      expect(tasks.rows[0]?.count).toBe('0');
    } finally {
      await inbound.stop();
      await pool.end();
    }
  });
});
