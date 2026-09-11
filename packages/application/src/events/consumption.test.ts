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
import { createPipelineHarness } from '../testing/pipeline-harness.js';
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

  /**
   * The same defect one level up, and the reason the predicate filters rather than counts.
   *
   * `handler.ts` blesses `eventTypes: 'all'` for audit and projections, and `handlersFor(type)`
   * merges a catch-all into **every** type's list — so a registry holding one satisfied all 21
   * declared types. WP-19's audit projection is the trigger: the gate would have read `ready` the
   * day it registered, with no pipeline behind it. Reverting the `eventTypes === 'all'` filter in
   * `sweepReadiness` kills both cases here by name.
   */
  it('does not let one catch-all handler stand in for every declared type', () => {
    const registry = new HandlerRegistry();
    registry.register({
      name: 'test.audit',
      priority: 0,
      eventTypes: 'all',
      handle: async () => {},
    });
    const readiness = sweepReadiness(registry);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual(HANDLED_EVENT_TYPES);
  });

  it('still refuses when a catch-all is registered beside one real handler', () => {
    const registry = new HandlerRegistry();
    registry.register({
      name: 'test.audit',
      priority: 0,
      eventTypes: 'all',
      handle: async () => {},
    });
    registry.register(handlerFor(['ticket.matched'], 'test.intake'));
    const readiness = sweepReadiness(registry);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).not.toContain('ticket.matched');
    expect(readiness.missing).toEqual(HANDLED_EVENT_TYPES.filter((t) => t !== 'ticket.matched'));
  });
});

/**
 * The table against the **real** registration, which is the half a synthetic registry cannot check.
 *
 * Every other case in this file builds the registry it then measures, so the table could drift from
 * the code in the direction that matters — a row left `unconsumed` after its work package lands, or
 * a row marked `handled` that nothing registers — and nothing would notice. This binds the two:
 * `createPipelineHarness` composes the same handlers `apps/server` registers.
 *
 * **It guards one direction, and the other is stated rather than built.** A row that stays
 * `unconsumed` after its consumer ships would need the test to know which work packages have landed
 * — a second hand-maintained list, which is rule 7's shape and would drift the same way. The cheap
 * half of it is here: every `unconsumed` row carries the work package that flips it, so the WP's own
 * definition of done is where the question gets asked. A mechanical version would have to read the
 * plan's status column, which is a guard reading a document nobody validates.
 */
describe('the declared table against the composed pipeline', () => {
  it('has a real handler for every type it declares handled', () => {
    const harness = createPipelineHarness({ runs: {} });
    const registry = new HandlerRegistry();
    for (const handler of harness.runtime.handlers) {
      registry.register(handler);
    }
    expect(sweepReadiness(registry)).toEqual({ ready: true, missing: [] });
  });

  it('declares handled exactly what the pipeline registers, so neither side drifts', () => {
    const harness = createPipelineHarness({ runs: {} });
    const registered = new Set<DomainEventType>();
    for (const handler of harness.runtime.handlers) {
      if (handler.eventTypes === 'all') {
        continue;
      }
      for (const type of handler.eventTypes) {
        registered.add(type);
      }
    }
    // Both directions: a type the pipeline handles but the table calls unconsumed would let a
    // partial consumer sweep; a type the table calls handled that nothing registers would stop every
    // sweep. The pipeline is this build's only registration, so the two sets are equal.
    expect([...registered].sort()).toEqual([...HANDLED_EVENT_TYPES].sort());
  });
});
