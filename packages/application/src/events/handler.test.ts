import { HANDLER_PRIORITY_BANDS } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { HandlerRegistrationError } from '../errors.js';
import { DISPATCH_MARKER } from '../ports/handler-executions.js';
import { type EventHandler, HandlerRegistry, priorityBand } from './handler.js';

const handler = (overrides: Partial<EventHandler> = {}): EventHandler => ({
  name: 'core.intake',
  priority: 10,
  eventTypes: ['task.queued'],
  handle: async () => {},
  ...overrides,
});

describe('HandlerRegistry', () => {
  it('orders handlers by priority, then by name', () => {
    const registry = new HandlerRegistry()
      .register(handler({ name: 'ui.board', priority: 220 }))
      .register(handler({ name: 'core.intake', priority: 10 }))
      .register(handler({ name: 'core.audit', priority: 10 }))
      .register(handler({ name: 'jira.workpad', priority: 110 }));

    expect(registry.handlersFor('task.queued').map((entry) => entry.name)).toEqual([
      'core.audit',
      'core.intake',
      'jira.workpad',
      'ui.board',
    ]);
  });

  it('gives a catch-all handler its place in every type it did not name, whenever it registered', () => {
    const before = new HandlerRegistry()
      .register(handler({ name: 'audit', priority: 0, eventTypes: 'all' }))
      .register(handler({ name: 'intake', priority: 10 }));
    const after = new HandlerRegistry()
      .register(handler({ name: 'intake', priority: 10 }))
      .register(handler({ name: 'audit', priority: 0, eventTypes: 'all' }));

    for (const registry of [before, after]) {
      expect(registry.handlersFor('task.queued').map((entry) => entry.name)).toEqual([
        'audit',
        'intake',
      ]);
      // A type nobody named still gets the catch-all.
      expect(registry.handlersFor('run.started').map((entry) => entry.name)).toEqual(['audit']);
    }
  });

  it('returns nothing for an event type no handler wants', () => {
    const registry = new HandlerRegistry().register(handler());
    expect(registry.handlersFor('mr.merged')).toEqual([]);
  });

  it('refuses a duplicate name, because the name is the idempotency key', () => {
    const registry = new HandlerRegistry().register(handler());
    expect(() => registry.register(handler())).toThrow(HandlerRegistrationError);
  });

  it('refuses the reserved $dispatch marker', () => {
    expect(() => new HandlerRegistry().register(handler({ name: DISPATCH_MARKER }))).toThrow(
      /reserved/,
    );
  });

  it.each([
    ['Intake', 'upper case'],
    ['9intake', 'leading digit'],
    ['intake..core', 'empty segment'],
    ['intake-', 'trailing separator'],
    ['', 'empty'],
  ])('refuses the malformed name %j (%s)', (name) => {
    expect(() => new HandlerRegistry().register(handler({ name }))).toThrow(
      HandlerRegistrationError,
    );
  });

  it('refuses a name longer than the limit', () => {
    const name = `a${'b'.repeat(120)}`;
    expect(() => new HandlerRegistry().register(handler({ name }))).toThrow(/longer than/);
  });

  it.each([-1, 1000, 1.5, Number.NaN])('refuses the priority %s (TD-005 bands)', (priority) => {
    expect(() => new HandlerRegistry().register(handler({ priority }))).toThrow(/priority/);
  });

  it('refuses an empty or unknown event type list', () => {
    expect(() => new HandlerRegistry().register(handler({ eventTypes: [] }))).toThrow(
      /no event types/,
    );
    expect(() =>
      new HandlerRegistry().register(
        handler({ eventTypes: ['task.invented'] as unknown as EventHandler['eventTypes'] }),
      ),
    ).toThrow(/catalogue event type/);
  });

  it('registers many at once and reports its names', () => {
    const registry = new HandlerRegistry().registerAll([
      handler({ name: 'b' }),
      handler({ name: 'a' }),
    ]);
    expect(registry.size).toBe(2);
    expect(registry.names()).toEqual(['a', 'b']);
  });
});

describe('priorityBand', () => {
  it.each([
    [0, 'core'],
    [99, 'core'],
    [100, 'integrations'],
    [200, 'notifications'],
    [999, 'custom'],
    [1000, 'unknown'],
  ])('maps %i to %s', (priority, band) => {
    expect(priorityBand(priority)).toBe(band);
  });

  it('covers every band the contracts declare', () => {
    for (const [name, range] of Object.entries(HANDLER_PRIORITY_BANDS)) {
      expect(priorityBand(range.from)).toBe(name);
      expect(priorityBand(range.to)).toBe(name);
    }
  });
});
