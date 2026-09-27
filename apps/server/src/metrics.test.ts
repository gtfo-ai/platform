import { describe, expect, it } from 'vitest';
import { createMetrics, routeLabel, STORAGE_TOTAL_COMPONENTS } from './metrics.js';

describe('createMetrics', () => {
  it('gives each server its own registry, so two instances do not collide', () => {
    // The library's global registry throws on a duplicate metric name; the e2e tier starts several
    // instances in one process, so a shared registry would make the second one fail to build.
    const first = createMetrics({ defaultMetrics: false });
    const second = createMetrics({ defaultMetrics: false });
    expect(first.registry).not.toBe(second.registry);
  });

  it('exposes the HTTP duration histogram TD-023 names, labelled by route pattern', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    metrics.httpRequestDuration.observe(
      { method: 'GET', route: '/api/projects/:project_id/config', status_code: '200' },
      0.012,
    );
    const text = await metrics.registry.metrics();
    expect(text).toContain('http_request_duration_seconds_bucket');
    expect(text).toContain('route="/api/projects/:project_id/config"');
  });

  it('samples the dispatch backlog on scrape rather than on every append', async () => {
    let calls = 0;
    const metrics = createMetrics({
      defaultMetrics: false,
      pendingDispatch: async () => {
        calls += 1;
        return 7;
      },
    });

    expect(calls).toBe(0);
    await metrics.collect();
    expect(calls).toBe(1);
    expect(await metrics.registry.metrics()).toMatch(/event_dispatch_pending 7/);
  });

  it('leaves the backlog gauge alone when this process runs no dispatcher', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    await expect(metrics.collect()).resolves.toBeUndefined();
    expect(await metrics.registry.metrics()).not.toMatch(/event_dispatch_pending \d/);
    expect(await metrics.registry.metrics()).not.toMatch(/event_dispatch_dead_lettered \d/);
  });

  it('publishes the dead letters beside the backlog, so a poisoned event is not a busy queue', async () => {
    // The gauge that answers the question WP-49's row asks: `event_dispatch_pending` reads the
    // same `1` for a burst and for an event nothing will ever dispatch. These two partition the
    // table — `countPendingDispatch` excludes exactly what `countDeadLettered` counts.
    let dead = 0;
    const metrics = createMetrics({
      defaultMetrics: false,
      pendingDispatch: async () => 3,
      deadLettered: async () => dead,
    });

    await metrics.collect();
    expect(await metrics.registry.metrics()).toMatch(/event_dispatch_dead_lettered 0/);

    dead = 1;
    await metrics.collect();
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/event_dispatch_pending 3/);
    expect(text).toMatch(/event_dispatch_dead_lettered 1/);
  });

  /**
   * WP-65 (PROGRESS backlog 81): the notifications nobody was told about — a metric, not a screen,
   * and absent where nothing samples it rather than a `0` that reads as a measurement.
   */
  it('publishes the undelivered notifications by plan, and nothing where nothing samples them', async () => {
    const metrics = createMetrics({
      defaultMetrics: false,
      pendingDispatch: async () => 0,
      undeliveredNotifications: async () => ({ immediate: 2, digest: 0 }),
    });
    await metrics.collect();
    const text = await metrics.registry.metrics();
    expect(text).toContain('notifications_undelivered{planned="immediate"} 2');
    expect(text).toContain('notifications_undelivered{planned="digest"} 0');

    const silent = createMetrics({ defaultMetrics: false });
    await silent.collect();
    expect(await silent.registry.metrics()).not.toContain('notifications_undelivered{');
  });

  it('publishes the stale command claims by action, drops a cleared one, and nothing where unsampled (backlog 241)', async () => {
    let claims = [
      { action: 'task.feedback', claims: 2 },
      { action: 'task.cancel', claims: 1 },
    ];
    const metrics = createMetrics({
      defaultMetrics: false,
      staleCommandClaims: async () => claims,
    });
    await metrics.collect();
    let text = await metrics.registry.metrics();
    expect(text).toContain('command_idempotency_claims_unknown{action="task.feedback"} 2');
    expect(text).toContain('command_idempotency_claims_unknown{action="task.cancel"} 1');

    claims = [{ action: 'task.feedback', claims: 2 }];
    await metrics.collect();
    text = await metrics.registry.metrics();
    expect(text).not.toContain('command_idempotency_claims_unknown{action="task.cancel"}');

    const silent = createMetrics({ defaultMetrics: false });
    await silent.collect();
    expect(await silent.registry.metrics()).not.toContain('command_idempotency_claims_unknown{');
  });

  /**
   * WP-65 (Q63): the storage gauge — database and mirrors as two lines under one total, the
   * mirrors per project, and **no** total where the mirrors cannot be measured.
   */
  it('reports database and mirror bytes as two lines under one total, the mirrors per project', async () => {
    let mirrors: { totalBytes: number; mirrors: { projectId: string; bytes: number }[] } | null = {
      totalBytes: 300,
      mirrors: [
        { projectId: 'p-1', bytes: 200 },
        { projectId: 'p-2', bytes: 100 },
      ],
    };
    const metrics = createMetrics({
      defaultMetrics: false,
      storage: { database: async () => 1000, mirrors: async () => mirrors },
    });
    await metrics.collect();
    let text = await metrics.registry.metrics();
    expect(text).toContain('platform_storage_bytes{component="database"} 1000');
    expect(text).toContain('platform_storage_bytes{component="knowledge_mirrors"} 300');
    expect(text).toContain(
      `platform_storage_total_bytes{components="${STORAGE_TOTAL_COMPONENTS}"} 1300`,
    );
    expect(text).toContain('knowledge_mirror_bytes{project_id="p-1"} 200');
    expect(text).toContain('knowledge_mirror_bytes{project_id="p-2"} 100');

    // An evicted mirror's line disappears; an unreadable root exports no mirror line and no total.
    mirrors = { totalBytes: 200, mirrors: [{ projectId: 'p-1', bytes: 200 }] };
    await metrics.collect();
    expect(await metrics.registry.metrics()).not.toContain('project_id="p-2"');
    mirrors = null;
    await metrics.collect();
    text = await metrics.registry.metrics();
    expect(text).toContain('platform_storage_bytes{component="database"} 1000');
    expect(text).not.toContain('component="knowledge_mirrors"');
    expect(text).not.toContain('platform_storage_total_bytes{');
    expect(text).not.toContain('knowledge_mirror_bytes{');
  });

  it('isolates a failing sampler: its gauges go absent and the dispatch backlog is still scraped', async () => {
    let fail = false;
    const reported: string[] = [];
    const metrics = createMetrics({
      defaultMetrics: false,
      onSamplerError: (sampler) => reported.push(sampler),
      pendingDispatch: async () => 4,
      undeliveredNotifications: async () => {
        if (fail) throw new Error('database unavailable');
        return { immediate: 1, digest: 0 };
      },
      storage: {
        database: async () => 10,
        mirrors: async () => {
          if (fail) throw new Error('EACCES');
          return { totalBytes: 5, mirrors: [{ projectId: 'p-1', bytes: 5 }] };
        },
      },
    });
    await metrics.collect();
    fail = true;
    expect(reported).toEqual([]);
    await expect(metrics.collect()).resolves.toBeUndefined();
    // Absent, and said so: an operator can tell a failed measurement from an unregistered gauge.
    expect(reported).toEqual(['undelivered_notifications', 'storage']);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/event_dispatch_pending 4/);
    expect(text).not.toContain('notifications_undelivered{');
    expect(text).not.toContain('platform_storage_bytes{');
    expect(text).not.toContain('platform_storage_total_bytes{');
    expect(text).not.toContain('knowledge_mirror_bytes{');
  });

  it('exports the database line alone, and no total, where no mirror root is configured', async () => {
    const metrics = createMetrics({
      defaultMetrics: false,
      storage: { database: async () => 5, mirrors: null },
    });
    await metrics.collect();
    const text = await metrics.registry.metrics();
    expect(text).toContain('platform_storage_bytes{component="database"} 5');
    expect(text).not.toContain('platform_storage_total_bytes');
    expect(text).not.toContain('knowledge_mirror_bytes');
  });

  it('counts SSE frames by kind', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    metrics.sseFramesSent.inc({ frame: 'replay' }, 3);
    metrics.sseConnections.set({ state: 'open' }, 2);
    const text = await metrics.registry.metrics();
    expect(text).toContain('sse_frames_sent_total{frame="replay"} 3');
    expect(text).toContain('sse_connections{state="open"} 2');
  });

  it('collects Node process metrics by default', async () => {
    const metrics = createMetrics();
    expect(await metrics.registry.metrics()).toContain('process_cpu_user_seconds_total');
  });
});

describe('routeLabel', () => {
  it('uses the route pattern, never the concrete path', () => {
    // One time series per project id would blow up the scrape.
    expect(routeLabel('/api/projects/:project_id/config')).toBe('/api/projects/:project_id/config');
  });

  it('labels an unmatched request `unknown` rather than with whatever a scanner sent', () => {
    expect(routeLabel(undefined)).toBe('unknown');
  });
});
