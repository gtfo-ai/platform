/**
 * `FakeObservabilityLogs` beyond the contract suite: the selector grammar, the caps and the
 * append path the bug pre-fetch uses.
 */
import { IntegrationUnsupportedError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { createFakeObservabilityLogs, FAKE_MAX_LABEL_BYTES } from './fake.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a5';
const FROM = '2026-06-01T09:00:00.000Z';
const TO = '2026-06-01T10:00:00.000Z';

type Options = Parameters<typeof createFakeObservabilityLogs>[0];

const build = (options: Partial<Options> = {}) =>
  createFakeObservabilityLogs({
    integrationId: INTEGRATION_ID,
    streams: [
      {
        labels: { app: 'api', env: 'production' },
        lines: [
          { timestamp: '2026-06-01T09:10:00.000Z', line: 'first' },
          { timestamp: '2026-06-01T09:20:00.000Z', line: 'second' },
        ],
      },
    ],
    ...options,
  });

const query = (overrides: Record<string, unknown> = {}) => ({
  selector: '{app="api"}',
  from: FROM,
  to: TO,
  limit: 10,
  ...overrides,
});

describe('FakeObservabilityLogs selectors', () => {
  it('refuses a selector without braces and a matcher that is not label="value"', async () => {
    const port = build();
    await expect(port.queryRange(query({ selector: 'app="api"' }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(port.queryRange(query({ selector: '{}' }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(port.queryRange(query({ selector: '{app=~"api.*"}' }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('requires every matcher to hold', async () => {
    const port = build();
    const both = await port.queryRange(query({ selector: '{app="api", env="production"}' }));
    expect(both.line_count).toBe(2);
    const wrong = await port.queryRange(query({ selector: '{app="api", env="staging"}' }));
    expect(wrong.line_count).toBe(0);
  });

  it('orders forward when asked to', async () => {
    const port = build();
    const result = await port.queryRange(query({ direction: 'forward' }));
    const lines = result.streams.flatMap((stream) => stream.lines.map((line) => line.line));
    expect(lines).toEqual(['first', 'second']);
  });

  it('excludes the upper bound of the window', async () => {
    const port = build();
    const result = await port.queryRange(
      query({ from: '2026-06-01T09:10:00.000Z', to: '2026-06-01T09:20:00.000Z' }),
    );
    expect(result.line_count).toBe(1);
  });

  it('refuses a non-integer limit and an unparsable instant', async () => {
    const port = build();
    await expect(port.queryRange(query({ limit: 1.5 }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(port.queryRange(query({ from: 'yesterday' }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('FakeObservabilityLogs discovery', () => {
  it('reports label and series discovery as unsupported when switched off', async () => {
    const port = build({ capabilities: { labels: false, series: false } });
    await expect(port.labels()).rejects.toBeInstanceOf(IntegrationUnsupportedError);
    await expect(port.series('{app="api"}', FROM)).rejects.toBeInstanceOf(
      IntegrationUnsupportedError,
    );
  });

  it('refuses a series query with an unparsable instant', async () => {
    const port = build();
    await expect(port.series('{app="api"}', 'yesterday')).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('returns no series when nothing was logged since the instant', async () => {
    const port = build();
    expect(await port.series('{app="api"}', '2030-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('reports an empty value list for a label nothing carries', async () => {
    const port = build();
    expect(await port.labels('region')).toEqual({ name: 'region', values: [] });
  });

  /**
   * Divergence 6, asserted positively rather than written down (standing rule 12: a fake's kindest
   * divergence is where a later WP leans hardest, and this one was kinder than the adapter —
   * `LabelValues.name` is the caller's argument echoed back, so a fake that accepts a 128 KiB name
   * emits a 128 KiB string where Loki answers `invalid_request`). The shared suite carries the same
   * obligation, so it binds every logs provider and not only this file (standing rule 23).
   */
  it('refuses a label name past the cap instead of echoing it back', async () => {
    const port = build();
    await expect(port.labels('L'.repeat(FAKE_MAX_LABEL_BYTES + 1))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    // Stricter than the adapter is allowed; kinder is not. A name at the bound still answers, so
    // the refusal is a bound and not a broken method.
    const atTheBound = 'L'.repeat(FAKE_MAX_LABEL_BYTES);
    expect((await port.labels(atTheBound)).name).toBe(atTheBound);
  });
});

describe('FakeObservabilityLogs seeding', () => {
  it('appends to an existing stream and creates a new one when the labels differ', async () => {
    const port = build();
    port.appendLine({ app: 'api', env: 'production' }, '2026-06-01T09:30:00.000Z', 'third');
    port.appendLine({ app: 'worker', env: 'production' }, '2026-06-01T09:31:00.000Z', 'job done');

    expect((await port.queryRange(query())).line_count).toBe(3);
    const worker = await port.queryRange(query({ selector: '{app="worker"}' }));
    expect(worker.line_count).toBe(1);
    expect((await port.labels('app')).values).toEqual(['api', 'worker']);
  });
});
