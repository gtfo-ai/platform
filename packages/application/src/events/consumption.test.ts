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
import { readFileSync } from 'node:fs';
import { DOMAIN_EVENT_TYPES, type DomainEventType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { costHandlers } from '../cost/runtime.js';
import { humanTimeHandlers } from '../human-time/runtime.js';
import { notifyHandlers } from '../notify/handlers.js';
import { statsHandlers } from '../stats/runtime.js';
import { createMemoryCostStore } from '../testing/memory-cost.js';
import { createMemoryHumanTimeStore } from '../testing/memory-human-time.js';
import { createMemoryStatsStore } from '../testing/memory-stats.js';
import { createPipelineHarness } from '../testing/pipeline-harness.js';
import {
  EVENT_CONSUMPTION,
  HANDLED_EVENT_TYPES,
  sweepReadiness,
  UNCONSUMED_OWNERS,
  unconsumedRowsOwnedBy,
} from './consumption.js';
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
 * **The other direction since WP-73** (PROGRESS backlog 1): a row that stays `unconsumed` after the
 * work package it names has landed. Five rows did exactly that — they named WP-20 and WP-21 for
 * sessions after both were DONE — so the owner is data (`UNCONSUMED_OWNERS`), each flipping work
 * package asserts `unconsumedRowsOwnedBy` is empty for itself, and the last case in this block
 * refuses an owner the ledger's status column records as DONE. That column is the orchestrator's,
 * written at every commit; it is read rather than copied, so there is no second list to drift.
 */
describe('the declared table against the composed registrations', () => {
  /**
   * Every handler this build registers, from **all three** composition functions.
   *
   * It was the pipeline alone until WP-19; the cost ledger is the second, the human-time projector
   * (WP-29) the third and the statistics projector (WP-41) the fourth, and a reader who assumes one
   * registration will under-count (standing rule 83 — closing a gap falsifies the sentence that
   * described it). The list is what `apps/server/src/pipeline.ts` really registers, which is the
   * point: this file's equality is only an equality if both sides are read off the code.
   */
  const composedHandlers = () => [
    ...createPipelineHarness({ runs: {} }).runtime.handlers,
    ...costHandlers({
      store: createMemoryCostStore(),
      context: () => {
        throw new Error('the consumption test never runs a handler');
      },
    }),
    ...humanTimeHandlers({ store: createMemoryHumanTimeStore() }),
    ...statsHandlers({ store: createMemoryStatsStore() }),
  ];

  it('has a real handler for every type it declares handled', () => {
    const registry = new HandlerRegistry();
    for (const handler of composedHandlers()) {
      registry.register(handler);
    }
    expect(sweepReadiness(registry)).toEqual({ ready: true, missing: [] });
  });

  it('declares handled exactly what this build registers, so neither side drifts', () => {
    const registered = new Set<DomainEventType>();
    for (const handler of composedHandlers()) {
      if (handler.eventTypes === 'all') {
        continue;
      }
      for (const type of handler.eventTypes) {
        registered.add(type);
      }
    }
    // Both directions: a type something handles but the table calls unconsumed would let a partial
    // consumer sweep; a type the table calls handled that nothing registers would stop every sweep.
    expect([...registered].sort()).toEqual([...HANDLED_EVENT_TYPES].sort());
  });

  /**
   * **The assertion PROGRESS backlog 1 asks the flipping work package to make.**
   *
   * The table is derived from the implementation, so a row that stays `unconsumed` after its
   * consumer ships re-opens the hole silently — and guarding that direction globally would need a
   * list of landed work packages, which is rule 7's shape. The cheap, mechanical half is this: the
   * work package that registers a handler asserts that **every type its own handlers declare** is
   * `handled`, with the set read off the handlers rather than written out here. WP-19 is the first
   * to owe it; the next consumer copies these four lines.
   */
  it('has no type left unconsumed that the notification band itself handles (WP-32)', () => {
    // The four lines WP-19's case asked the next consumer to copy. The band is registered by
    // `createPipelineRuntime`, so this reads it off `notifyHandlers` directly rather than out of the
    // composed list: what is being asserted is that *these* types are declared, not that the
    // harness happened to include them.
    const owned = notifyHandlers({} as never).flatMap((handler) =>
      handler.eventTypes === 'all' ? [] : [...handler.eventTypes],
    );
    // Nine since WP-43, which added `task.approval.requested` once a button could be pressed; ten
    // since WP-65, whose second handler edits a settled approval's message on
    // `task.approval.decided` (already `handled` by the pipeline — a second consumer moves nothing).
    expect(owned.length).toBe(10);
    expect(unconsumedRowsOwnedBy('WP-32')).toEqual([]);
    for (const type of owned) {
      expect({ type, consumption: EVENT_CONSUMPTION[type] }).toEqual({
        type,
        consumption: 'handled',
      });
    }
  });

  it('has no type left unconsumed that the human-time projector itself handles (WP-29)', () => {
    // The same four lines WP-19's case asked the next consumer to copy. Four of the five types are
    // already handled by the pipeline — a second consumer does not move an entry — and the fifth,
    // `run.steered`, is the one this work package flipped.
    const owned = humanTimeHandlers({ store: createMemoryHumanTimeStore() }).flatMap((handler) =>
      handler.eventTypes === 'all' ? [] : [...handler.eventTypes],
    );
    expect(owned).toContain('run.steered');
    expect(unconsumedRowsOwnedBy('WP-29')).toEqual([]);
    for (const type of owned) {
      expect({ type, consumption: EVENT_CONSUMPTION[type] }).toEqual({
        type,
        consumption: 'handled',
      });
    }
  });

  it('has no type left unconsumed that the cost ledger itself handles (WP-19)', () => {
    const owned = costHandlers({
      store: createMemoryCostStore(),
      context: () => {
        throw new Error('the consumption test never runs a handler');
      },
    }).flatMap((handler) => (handler.eventTypes === 'all' ? [] : [...handler.eventTypes]));
    expect(owned.length).toBeGreaterThan(0);
    expect(unconsumedRowsOwnedBy('WP-19')).toEqual([]);
    for (const type of owned) {
      expect({ type, consumption: EVENT_CONSUMPTION[type] }).toEqual({
        type,
        consumption: 'handled',
      });
    }
  });

  /** Every `unconsumed` row has an owner entry, and no owner entry is for a `handled` row. */
  it('addresses every unconsumed row, and only those', () => {
    const unconsumed = Object.entries(EVENT_CONSUMPTION)
      .filter(([, consumption]) => consumption === 'unconsumed')
      .map(([type]) => type)
      .sort();
    expect(Object.keys(UNCONSUMED_OWNERS).sort()).toEqual(unconsumed);
  });

  it('names no owner the ledger records as DONE (PROGRESS backlog 1)', () => {
    const ledger = readFileSync(
      new URL('../../../../docs/technical/PROGRESS.md', import.meta.url),
      'utf8',
    );
    const done = doneWorkPackages(ledger);
    // Calibration (standing rule 44): the parse must find the ledger's DONE rows, or an empty set
    // would pass every owner. WP-19, WP-20 and WP-21 are three it must see.
    expect(done).toEqual(expect.arrayContaining(['WP-19', 'WP-20', 'WP-21']));
    expect(staleOwners(UNCONSUMED_OWNERS, done)).toEqual([]);
    // …and a planted owner that has landed is named, which is the refusal this case exists for.
    expect(staleOwners({ 'run.created': 'WP-20', 'config.changed': 'WP-999' }, done)).toEqual([
      'run.created → WP-20',
    ]);
  });
});

/** The work packages a status row of the ledger records as `DONE`, in either table layout. */
const doneWorkPackages = (ledger: string): string[] =>
  ledger.split('\n').flatMap((line) => {
    const cells = line.split('|').map((cell) => cell.trim());
    const id = cells[1] ?? '';
    // `DONE` may carry a qualifier in its cell — WP-15h reads `DONE (**parts 1 and 2** …)` (review
    // round 1), so a status cell counts when it *starts* with the word.
    return /^WP-\d+[a-z]?$/.test(id) && cells.slice(2).some((cell) => /^DONE\b/.test(cell))
      ? [id]
      : [];
  });

const staleOwners = (
  owners: Readonly<Partial<Record<string, string | null>>>,
  done: readonly string[],
): string[] =>
  Object.entries(owners)
    .filter(([, owner]) => owner !== null && owner !== undefined && done.includes(owner))
    .map(([type, owner]) => `${type} → ${owner}`);
