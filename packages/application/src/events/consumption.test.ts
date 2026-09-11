/**
 * The table is a hand-maintained list, so the thing under test is mostly **that it cannot drift**.
 *
 * Standing rule 7: a guard with a hand-maintained scope drifts, and the remedy is to ask the source
 * of truth rather than to carry a copy. The source here is `DOMAIN_EVENT_TYPES`, derived from the
 * catalogue union in `@platform/contracts`, so a new event type added without an entry is a failing
 * test rather than an `undefined` that reads as "not consumed" — which is the permissive direction
 * (standing rule 18) and would let a sweeper complete an event nobody decided about.
 *
 * The refusal is parameterised over the **declared** set rather than over a list written here
 * (standing rule 68): every type marked `handled` gets a case that removes exactly that handler and
 * asserts the sweep is refused *and* that the message names it.
 */
import { DOMAIN_EVENT_TYPES, type DomainEventType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { EVENT_CONSUMPTION, HANDLED_EVENT_TYPES, sweepReadiness } from './consumption.js';
import type { EventHandler } from './handler.js';
import { HandlerRegistry } from './handler.js';

const handlerFor = (types: readonly DomainEventType[], name: string): EventHandler => ({
  name,
  priority: 100,
  eventTypes: types,
  handle: async () => {},
});

/** A registry that can handle everything the build declares consumed, minus `without`. */
const registryHandling = (without: DomainEventType | null = null): HandlerRegistry => {
  const registry = new HandlerRegistry();
  const types = HANDLED_EVENT_TYPES.filter((type) => type !== without);
  if (types.length > 0) {
    registry.register(handlerFor(types, 'test.everything'));
  }
  return registry;
};

describe('the consumption table', () => {
  /**
   * The whole guarantee. Adding a member to the catalogue union without an entry here fails this,
   * which is what stops the table becoming the stale copy rule 7 warns about.
   */
  it('answers for every catalogue event type, and for no type that is not one', () => {
    expect(Object.keys(EVENT_CONSUMPTION).sort()).toEqual([...DOMAIN_EVENT_TYPES].sort());
  });

  it('declares each type exactly once, as handled or unconsumed', () => {
    for (const [type, consumption] of Object.entries(EVENT_CONSUMPTION)) {
      expect({ type, consumption }).toEqual({
        type,
        consumption: expect.stringMatching(/^(handled|unconsumed)$/),
      });
    }
  });

  it('declares something consumed, so the gate below is not vacuous', () => {
    // Standing rule 4: a sweep that reached nothing reports no failures either. If every type were
    // `unconsumed`, `sweepReadiness` would be `ready` for an empty registry and every case in this
    // file would pass while guarding nothing.
    expect(HANDLED_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(HANDLED_EVENT_TYPES).toContain('ticket.matched');
  });
});

describe('sweepReadiness', () => {
  it('lets a complete consumer sweep', () => {
    expect(sweepReadiness(registryHandling())).toEqual({ ready: true, missing: [] });
  });

  it('refuses an empty registry and names every type it cannot handle', () => {
    const readiness = sweepReadiness(new HandlerRegistry());
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual(HANDLED_EVENT_TYPES);
  });

  it('ignores a type the platform declares unconsumed', () => {
    const registry = registryHandling();
    // `knowledge.index.rebuilt` is `—` in technical/02: nothing is expected to handle it, and a
    // sweeper is not held to it. If this ever fails, the table and the catalogue have diverged.
    expect(EVENT_CONSUMPTION['knowledge.index.rebuilt']).toBe('unconsumed');
    expect(sweepReadiness(registry).ready).toBe(true);
  });

  /**
   * The refusal, over the declared set rather than over an example (rule 68). A partial consumer is
   * the defect this exists for: `event_dispatch` has one row per event for the whole deployment, so
   * a process missing one handler destroys that handler's work item for every process.
   */
  it.each(HANDLED_EVENT_TYPES.map((type) => [type] as const))(
    'refuses to sweep when nothing handles %s, and says so',
    (type) => {
      const readiness = sweepReadiness(registryHandling(type));
      expect(readiness.ready).toBe(false);
      expect(readiness.missing).toEqual([type]);
    },
  );

  it('does not count a handler registered for another type', () => {
    const registry = new HandlerRegistry();
    registry.register(handlerFor(['knowledge.index.rebuilt'], 'test.unrelated'));
    const readiness = sweepReadiness(registry);
    expect(readiness.ready).toBe(false);
    // The exact defect the architect measured at the bus: one handler for an unrelated type made a
    // whole-registry predicate say "ready", and the sweep then ate every other type.
    expect(readiness.missing).toEqual(HANDLED_EVENT_TYPES);
  });
});
