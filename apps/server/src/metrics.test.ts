import { describe, expect, it } from 'vitest';
import { createMetrics, routeLabel } from './metrics.js';

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
