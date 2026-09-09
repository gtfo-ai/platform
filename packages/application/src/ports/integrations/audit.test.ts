/**
 * The audit mapping and the idempotency key composition.
 *
 * The event mapping is a table in `audit.ts`'s docblock, and this file is that table as
 * assertions — including the two statuses that must produce **no** event, which is where
 * technical/02's shadow invariant actually lives.
 *
 * The key composition gets a property test rather than examples, because the failure it guards
 * against is a *collision between two triples nobody thought to write down*: an integration id
 * that ends in a colon, an action name that contains one, a marker id that contains both.
 */
import { domainEventSchemasByType, type EventPayload } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type IdempotencyScope,
  type IntegrationActionEntry,
  idempotencyStorageKey,
  integrationActionEventDrafts,
} from './audit.js';

/**
 * Cap for the property test in this file (technical/10, and the CI timeout lesson recorded in
 * `packages/contracts/src/testing/property.ts`): a gate whose verdict depends on how fast the
 * machine is, is not a gate. The property here is pure string work, so this is far above the work.
 */
const PROPERTY_TEST_TIMEOUT_MS = 30_000;
const PROPERTY_RUNS = 500;

const entry = (overrides: Partial<IntegrationActionEntry> = {}): IntegrationActionEntry => ({
  integrationId: '00000000-0000-4000-8000-000000000001',
  provider: 'fake-task-management',
  projectId: '00000000-0000-4000-8000-0000000000b0',
  taskId: '00000000-0000-4000-8000-0000000000c0',
  direction: 'out',
  action: 'add_comment',
  mutating: true,
  status: 'ok',
  payload: { ticket_key: 'FAKE-1' },
  result: { comment_id: 'c-1' },
  error: null,
  durationMs: 12,
  occurredAt: '2026-06-01T09:00:00.000Z',
  redactionCount: 0,
  attempts: 1,
  ...overrides,
});

describe('integrationActionEventDrafts', () => {
  it('maps ok onto one performed event with a catalogue-legal payload', () => {
    const [draft, ...rest] = integrationActionEventDrafts(entry());
    expect(rest).toEqual([]);
    expect(draft?.type).toBe('integration.action.performed');
    const schema = domainEventSchemasByType['integration.action.performed'];
    const payload = schema.shape.payload.parse(
      draft?.payload,
    ) as EventPayload<'integration.action.performed'>;
    expect(payload.action).toBe('add_comment');
    expect(payload.payload_redacted).toEqual({ ticket_key: 'FAKE-1' });
    expect(payload.result).toEqual({ comment_id: 'c-1' });
    expect(payload.duration_ms).toBe(12);
  });

  it('maps failed onto one failed event carrying the recorded error', () => {
    const [draft] = integrationActionEventDrafts(
      entry({ status: 'failed', result: null, error: 'IntegrationError: gone' }),
    );
    expect(draft?.type).toBe('integration.action.failed');
    const schema = domainEventSchemasByType['integration.action.failed'];
    const payload = schema.shape.payload.parse(
      draft?.payload,
    ) as EventPayload<'integration.action.failed'>;
    expect(payload.error).toBe('IntegrationError: gone');
  });

  it('never names an error "unknown" when one was recorded, and never omits one', () => {
    const [draft] = integrationActionEventDrafts(
      entry({ status: 'failed', result: null, error: null }),
    );
    // The catalogue requires a non-empty error; a row that lost its message still produces a
    // legal event rather than a rejected append.
    const schema = domainEventSchemasByType['integration.action.failed'];
    const payload = schema.shape.payload.parse(
      draft?.payload,
    ) as EventPayload<'integration.action.failed'>;
    expect(payload.error).toBe('unknown error');
  });

  it('emits nothing for would_have — technical/02: shadow tasks perform no mutating action', () => {
    expect(integrationActionEventDrafts(entry({ status: 'would_have' }))).toEqual([]);
  });

  it('emits nothing for replayed, because the provider was never called', () => {
    expect(integrationActionEventDrafts(entry({ status: 'replayed' }))).toEqual([]);
  });

  it('carries an integration actor, never a user one', () => {
    const [draft] = integrationActionEventDrafts(entry());
    expect(draft?.actor).toEqual({
      kind: 'integration',
      integration_id: '00000000-0000-4000-8000-000000000001',
      provider: 'fake-task-management',
    });
  });
});

describe('idempotencyStorageKey', () => {
  it('separates the three parts', () => {
    expect(
      idempotencyStorageKey({ integrationId: 'i1', action: 'add_comment', key: 'marker' }),
    ).toBe('i1:add_comment:marker');
  });

  it(
    'never maps two different scopes onto one key',
    async () => {
      const part = fc.string({ minLength: 1, maxLength: 12 });
      const scope = fc
        .tuple(part, part, part)
        .map(([integrationId, action, key]): IdempotencyScope => ({ integrationId, action, key }));

      await fc.assert(
        fc.property(scope, scope, (left, right) => {
          const same =
            left.integrationId === right.integrationId &&
            left.action === right.action &&
            left.key === right.key;
          expect(idempotencyStorageKey(left) === idempotencyStorageKey(right)).toBe(same);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it('is not fooled by a colon inside a part', () => {
    const left = idempotencyStorageKey({ integrationId: 'a:b', action: 'c', key: 'd' });
    const right = idempotencyStorageKey({ integrationId: 'a', action: 'b:c', key: 'd' });
    expect(left).not.toBe(right);
  });
});
