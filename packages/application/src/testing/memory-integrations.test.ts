/**
 * The in-memory doubles, and the divergences their register claims.
 *
 * A register entry that nothing exercises is a comment, so each of the two *stricter* claims —
 * the audit log validating drafts against the catalogue, and the idempotency store refusing a
 * second write to one key — is asserted here. The virtual timer gets the same treatment: the claim
 * is that the clock moves to real deadlines rather than by the sum of concurrent sleeps.
 */
import { describe, expect, it } from 'vitest';
import type { IntegrationActionEntry } from '../ports/integrations/audit.js';
import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
  testIntegrationId,
} from './memory-integrations.js';

const entry = (overrides: Partial<IntegrationActionEntry> = {}): IntegrationActionEntry => ({
  integrationId: testIntegrationId(1),
  provider: 'fake',
  projectId: '00000000-0000-4000-8000-0000000000b0',
  taskId: null,
  direction: 'out',
  action: 'add_comment',
  mutating: true,
  status: 'ok',
  payload: {},
  result: {},
  error: null,
  durationMs: 1,
  occurredAt: '2026-06-01T09:00:00.000Z',
  redactionCount: 0,
  attempts: 1,
  ...overrides,
});

describe('createMemoryAuditLog', () => {
  it('records rows and derives their events', async () => {
    const log = createMemoryAuditLog();
    await log.record(entry());
    await log.record(entry({ action: 'transition', status: 'would_have' }));

    expect(log.entries.length).toBe(2);
    expect(log.entriesFor('transition').length).toBe(1);
    expect(log.events.map((event) => event.type)).toEqual(['integration.action.performed']);

    log.reset();
    expect(log.entries).toEqual([]);
  });

  it('rejects a row whose event payload the catalogue would reject (divergence 1)', async () => {
    const log = createMemoryAuditLog();
    await expect(
      log.record(entry({ projectId: 'not-a-uuid' as IntegrationActionEntry['projectId'] })),
    ).rejects.toThrow();
    // The row is recorded before the draft is validated; the point is that the *log* is loud.
    expect(log.events).toEqual([]);
  });

  it('fails exactly once when a failure is scripted (divergence 5)', async () => {
    const log = createMemoryAuditLog();
    log.failNext(new Error('database is down'));
    await expect(log.record(entry())).rejects.toThrow('database is down');
    await log.record(entry());
    expect(log.entries.length).toBe(1);
  });
});

describe('createMemoryIdempotencyStore', () => {
  const scope = { integrationId: testIntegrationId(1), action: 'add_comment', key: 'marker' };

  it('misses with undefined and can store a null result', async () => {
    const store = createMemoryIdempotencyStore();
    expect(await store.get(scope)).toBeUndefined();
    await store.put(scope, null);
    expect(await store.get(scope)).toBeNull();
    expect(store.size).toBe(1);
  });

  it('refuses a second write to one key (divergence 2)', async () => {
    const store = createMemoryIdempotencyStore();
    await store.put(scope, 'c-1');
    await expect(store.put(scope, 'c-2')).rejects.toThrow(/written twice/);
    expect(await store.get(scope)).toBe('c-1');
  });
});

describe('createVirtualTimer', () => {
  it('records every requested sleep and resolves it on advance', async () => {
    const timer = createVirtualTimer({ start: 1000 });
    let woken = false;
    const sleeping = timer.sleep(250).then(() => {
      woken = true;
    });

    expect(timer.sleeps).toEqual([250]);
    expect(timer.pending).toBe(1);
    expect(woken).toBe(false);

    await timer.advance(100);
    expect(woken).toBe(false);
    await timer.advance(150);
    await sleeping;
    expect(woken).toBe(true);
    expect(timer.now()).toBe(1250);
  });

  it('treats a zero sleep as already elapsed', async () => {
    const timer = createVirtualTimer();
    await timer.sleep(0);
    expect(timer.pending).toBe(0);
    expect(timer.now()).toBe(0);
  });

  it('rejects a negative duration', () => {
    const timer = createVirtualTimer();
    expect(() => timer.sleep(-1)).toThrow(TypeError);
  });

  it('auto-advances to the earliest deadline, not by the sum of concurrent sleeps', async () => {
    const timer = createVirtualTimer({ autoAdvance: true });
    await Promise.all([timer.sleep(1000), timer.sleep(400), timer.sleep(700)]);
    // Three concurrent sleeps of 1000, 400 and 700 ms end 1000 ms later, not 2100 ms later.
    expect(timer.now()).toBe(1000);
    expect(timer.sleeps).toEqual([1000, 400, 700]);
  });
});
