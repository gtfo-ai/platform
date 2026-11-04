/**
 * TD-031 §8's offer timestamps (WP-278 criterion 5): a table of mode × prefer × assignee-online,
 * and the property that `server_only` never sets `workers_from`.
 */
import type { ExecutionMode, ExecutionPreference, Id, IsoDateTime } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  DEFAULT_EXECUTION_SETTINGS,
  type ExecutionSettings,
  effectiveFallbackAfterSeconds,
  executionNotice,
  routeOffer,
} from './execution-routing.js';

const NOW = '2026-11-04T10:00:00.000Z' as IsoDateTime;
const ASSIGNEE = '00000000-0000-4000-8000-0000000000a1' as Id;
const at = (seconds: number): IsoDateTime =>
  new Date(Date.parse(NOW) + seconds * 1000).toISOString() as IsoDateTime;

const settings = (
  mode: ExecutionMode,
  prefer: ExecutionPreference,
  fallbackAfterSeconds: number | null = null,
): ExecutionSettings => ({ ...DEFAULT_EXECUTION_SETTINGS, mode, prefer, fallbackAfterSeconds });

describe('routeOffer — the table (mode × prefer × assignee online)', () => {
  // [mode, prefer, assignee online, assignee_until, server_from, workers_from] in seconds from now;
  // `null` is "never" (or no head start). Defaults: window 120 s, fallback 15 s / 300 s.
  const rows: readonly [
    ExecutionMode,
    ExecutionPreference,
    boolean,
    number | null,
    number | null,
    number | null,
  ][] = [
    ['hybrid', 'server', false, null, 0, 15],
    ['hybrid', 'server', true, 120, 120, 135],
    ['hybrid', 'workers', false, null, 300, 0],
    ['hybrid', 'workers', true, 120, 420, 120],
    ['workers_only', 'server', false, null, null, 0],
    ['workers_only', 'server', true, 120, null, 120],
    ['workers_only', 'workers', false, null, null, 0],
    ['workers_only', 'workers', true, 120, null, 120],
    ['server_only', 'server', false, null, 0, null],
    ['server_only', 'server', true, null, 0, null],
    ['server_only', 'workers', false, null, 0, null],
    ['server_only', 'workers', true, null, 0, null],
  ];
  it.each(rows)(
    '%s, prefer %s, assignee online %s',
    (mode, prefer, online, until, server, workers) => {
      const routed = routeOffer({
        settings: settings(mode, prefer),
        now: NOW,
        onlineAssigneeUserId: online ? ASSIGNEE : null,
        serverClaimant: true,
      });
      expect(routed).toEqual({
        assigneeUserId: until === null ? null : ASSIGNEE,
        assigneeUntil: until === null ? null : at(until),
        serverFrom: server === null ? null : at(server),
        workersFrom: workers === null ? null : at(workers),
        expiresAt: at(86_400),
      });
    },
  );

  it('a stored fallback replaces the preference’s default', () => {
    const routed = routeOffer({
      settings: settings('hybrid', 'server', 42),
      now: NOW,
      onlineAssigneeUserId: null,
      serverClaimant: true,
    });
    expect(routed.workersFrom).toBe(at(42));
  });

  it('a zero assignee window gives no head start and names no assignee', () => {
    const routed = routeOffer({
      settings: { ...settings('hybrid', 'server'), assigneeWindowSeconds: 0 },
      now: NOW,
      onlineAssigneeUserId: ASSIGNEE,
      serverClaimant: true,
    });
    expect(routed).toMatchObject({ assigneeUserId: null, assigneeUntil: null, serverFrom: NOW });
  });

  it('the offer expires offer_timeout after it was offered', () => {
    const routed = routeOffer({
      settings: { ...settings('workers_only', 'server'), offerTimeoutSeconds: 3_600 },
      now: NOW,
      onlineAssigneeUserId: null,
      serverClaimant: true,
    });
    expect(routed.expiresAt).toBe(at(3_600));
  });
});

describe('routeOffer — a core with no server claimant', () => {
  it('opens a hybrid project to workers at once and keeps the server’s own start', () => {
    const preferServer = routeOffer({
      settings: settings('hybrid', 'server'),
      now: NOW,
      onlineAssigneeUserId: null,
      serverClaimant: false,
    });
    expect(preferServer).toMatchObject({ workersFrom: NOW, serverFrom: NOW });
    const preferWorkers = routeOffer({
      settings: settings('hybrid', 'workers'),
      now: NOW,
      onlineAssigneeUserId: null,
      serverClaimant: false,
    });
    expect(preferWorkers).toMatchObject({ workersFrom: NOW, serverFrom: at(300) });
  });

  it('never widens server_only to workers', () => {
    const routed = routeOffer({
      settings: settings('server_only', 'server'),
      now: NOW,
      onlineAssigneeUserId: ASSIGNEE,
      serverClaimant: false,
    });
    expect(routed).toMatchObject({ workersFrom: null, serverFrom: NOW, assigneeUserId: null });
  });

  it('says so for hybrid and server_only, and not for workers_only', () => {
    expect(executionNotice('hybrid', false)).toMatch(/treated as workers only/);
    expect(executionNotice('server_only', false)).toMatch(/wait for one/);
    expect(executionNotice('workers_only', false)).toBeNull();
    expect(executionNotice('hybrid', true)).toBeNull();
  });
});

describe('routeOffer — properties', () => {
  const settingsArbitrary = fc.record({
    mode: fc.constantFrom<ExecutionMode>('server_only', 'workers_only', 'hybrid'),
    prefer: fc.constantFrom<ExecutionPreference>('server', 'workers'),
    fallbackAfterSeconds: fc.option(fc.integer({ min: 0, max: 86_400 }), { nil: null }),
    assigneeWindowSeconds: fc.integer({ min: 0, max: 3_600 }),
    offerTimeoutSeconds: fc.integer({ min: 60, max: 2_592_000 }),
  });
  const inputArbitrary = fc.record({
    settings: settingsArbitrary,
    online: fc.boolean(),
    serverClaimant: fc.boolean(),
  });
  const route = (input: {
    settings: ExecutionSettings;
    online: boolean;
    serverClaimant: boolean;
  }) =>
    routeOffer({
      settings: input.settings,
      now: NOW,
      onlineAssigneeUserId: input.online ? ASSIGNEE : null,
      serverClaimant: input.serverClaimant,
    });

  it(
    'server_only never sets workers_from',
    () => {
      fc.assert(
        fc.property(inputArbitrary, (input) => {
          const routed = route({ ...input, settings: { ...input.settings, mode: 'server_only' } });
          expect(routed.workersFrom).toBeNull();
          expect(routed.serverFrom).toBe(NOW);
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it(
    'workers_only never sets server_from, and some side may always claim',
    () => {
      fc.assert(
        fc.property(inputArbitrary, (input) => {
          const routed = route(input);
          if (input.settings.mode === 'workers_only') expect(routed.serverFrom).toBeNull();
          expect(routed.serverFrom !== null || routed.workersFrom !== null).toBe(true);
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it(
    'no side claims before now, a head start ends before either side, a server_from is never lost, and the fallback is the gap',
    () => {
      fc.assert(
        fc.property(inputArbitrary, (input) => {
          const routed = route(input);
          for (const from of [routed.serverFrom, routed.workersFrom]) {
            if (from !== null) expect(Date.parse(from)).toBeGreaterThanOrEqual(Date.parse(NOW));
          }
          if (routed.assigneeUntil !== null) {
            expect(routed.assigneeUserId).toBe(ASSIGNEE);
            for (const from of [routed.serverFrom, routed.workersFrom]) {
              if (from !== null)
                expect(Date.parse(from)).toBeGreaterThanOrEqual(Date.parse(routed.assigneeUntil));
            }
          }
          if (input.settings.mode !== 'workers_only') expect(routed.serverFrom).not.toBeNull();
          if (input.settings.mode === 'hybrid' && input.serverClaimant) {
            const gap = Math.abs(
              Date.parse(routed.serverFrom as string) - Date.parse(routed.workersFrom as string),
            );
            expect(gap).toBe(effectiveFallbackAfterSeconds(input.settings) * 1000);
          }
          expect(Date.parse(routed.expiresAt) - Date.parse(NOW)).toBe(
            input.settings.offerTimeoutSeconds * 1000,
          );
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});
