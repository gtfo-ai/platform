/**
 * Event handlers and the registry that orders them (TD-005, technical/02).
 *
 * A handler declares the event types it wants and a **priority**; the dispatcher runs the matching
 * handlers sequentially, lowest priority first. The bands are fixed by TD-005:
 *
 * | band | range | who |
 * |---|---|---|
 * | core | 0–99 | platform: intake, pipeline transitions, cost ledger, gates |
 * | integrations | 100–199 | ticket/workpad/MR writes |
 * | notifications | 200–299 | Slack, UI |
 * | custom | 300–999 | project handlers registered by a template |
 *
 * A handler may emit further events (`context.emit`) — appended in its own transaction and
 * dispatched after the current event's handlers — and a policy handler at the top of the order may
 * `context.stop()` to keep the rest from running at all.
 */
import {
  type DomainEvent,
  type DomainEventType,
  domainEventTypeSchema,
  HANDLER_PRIORITY_BANDS,
  handlerPrioritySchema,
} from '@platform/contracts';
import { HandlerRegistrationError } from '../errors.js';
import type { StoredEvent } from '../ports/event-store.js';
import { DISPATCH_MARKER } from '../ports/handler-executions.js';
import type { TransactionScope } from '../ports/unit-of-work.js';

/**
 * Handler names are stored in `handler_executions.handler`, which is the idempotency key, so they
 * are constrained rather than free text: a renamed handler re-runs against every past event, and a
 * name that could collide with `$dispatch` would forge a completed dispatch.
 */
export const HANDLER_NAME_PATTERN = /^[a-z][a-z0-9]*([._:-][a-z0-9]+)*$/;
export const MAX_HANDLER_NAME_LENGTH = 100;

export interface HandlerContext {
  /** The transaction this handler's writes belong to. */
  readonly scope: TransactionScope;
  /** The event being handled, with its position in the log. */
  readonly event: StoredEvent;
  /**
   * Appends events in this handler's transaction and queues them for dispatch after the current
   * event's handlers finish (TD-005 chaining). `cause_event_position` is filled in from the event
   * being handled.
   */
  emit(events: readonly DomainEvent[]): Promise<readonly StoredEvent[]>;
  /**
   * Stops the remaining handlers of this event — durably: the skip is written inside this
   * handler's transaction, so a redelivery cannot let them through.
   */
  stop(reason: string): void;
  /**
   * Runs `callback` **after** this handler's transaction has committed, and only then.
   *
   * It exists for one thing: enqueuing a job. `Jobs.enqueue` does not join this transaction — it
   * is another connection, and pg-boss commits on its own — so an enqueue written inline is
   * durable even when the handler that decided on it rolls back, which is a job whose reason for
   * existing never happened. Deferring it until the commit makes the ordering the honest one:
   * the state the job will re-read is already there when the job exists.
   *
   * **What it does not buy.** A crash between the commit and the callback loses the callback, so
   * a wake-up is *at-most-once* while the state change is exactly-once. Every job the platform
   * enqueues therefore re-validates when it fires (TD-004) and tolerates finding nothing to do,
   * and no invariant may depend on a callback having run. A callback that throws is logged and
   * does **not** fail the handler: the effect is already committed, and re-running the handler to
   * retry a notification would replay the effect.
   *
   * Callbacks run in the order they were registered.
   */
  afterCommit(callback: () => Promise<void> | void): void;
}

export interface EventHandler {
  /** Stable identity; also the idempotency key in `handler_executions`. */
  readonly name: string;
  /** TD-005 band. Lower runs first; ties break on the name, so the order is total. */
  readonly priority: number;
  /** Catalogue types this handler wants, or `'all'` for every event (audit, projections). */
  readonly eventTypes: readonly DomainEventType[] | 'all';
  handle(context: HandlerContext): Promise<void>;
}

/** Which TD-005 band a priority falls into, for logs and for the settings UI later. */
export const priorityBand = (priority: number): keyof typeof HANDLER_PRIORITY_BANDS | 'unknown' => {
  for (const [band, range] of Object.entries(HANDLER_PRIORITY_BANDS)) {
    if (priority >= range.from && priority <= range.to) {
      return band as keyof typeof HANDLER_PRIORITY_BANDS;
    }
  }
  return 'unknown';
};

/**
 * The registered handlers, indexed by event type and kept in dispatch order.
 *
 * Registration validates eagerly: a bad priority, a duplicate name or an unknown event type is a
 * composition-root bug, and it is far cheaper to fail at start-up than to discover at 03:00 that
 * an event has been silently unhandled.
 */
export class HandlerRegistry {
  readonly #byName = new Map<string, EventHandler>();
  readonly #byType = new Map<DomainEventType, EventHandler[]>();
  #catchAll: EventHandler[] = [];

  register(handler: EventHandler): this {
    this.#validate(handler);
    this.#byName.set(handler.name, handler);

    if (handler.eventTypes === 'all') {
      this.#catchAll = sortHandlers([...this.#catchAll, handler]);
      for (const [type, handlers] of this.#byType) {
        this.#byType.set(type, sortHandlers([...handlers, handler]));
      }
      return this;
    }

    for (const type of handler.eventTypes) {
      const existing = this.#byType.get(type) ?? [...this.#catchAll];
      this.#byType.set(type, sortHandlers([...existing, handler]));
    }
    return this;
  }

  registerAll(handlers: Iterable<EventHandler>): this {
    for (const handler of handlers) {
      this.register(handler);
    }
    return this;
  }

  /** The handlers for `type`, in dispatch order. */
  handlersFor(type: DomainEventType): readonly EventHandler[] {
    return this.#byType.get(type) ?? this.#catchAll;
  }

  get size(): number {
    return this.#byName.size;
  }

  names(): readonly string[] {
    return [...this.#byName.keys()].sort();
  }

  #validate(handler: EventHandler): void {
    const { name, priority, eventTypes } = handler;
    if (name === DISPATCH_MARKER || !HANDLER_NAME_PATTERN.test(name)) {
      throw new HandlerRegistrationError(
        name,
        `name must match ${String(HANDLER_NAME_PATTERN)} and must not be the reserved "${DISPATCH_MARKER}" marker`,
      );
    }
    if (name.length > MAX_HANDLER_NAME_LENGTH) {
      throw new HandlerRegistrationError(name, `name is longer than ${MAX_HANDLER_NAME_LENGTH}`);
    }
    if (this.#byName.has(name)) {
      throw new HandlerRegistrationError(name, 'is already registered');
    }
    if (!handlerPrioritySchema.safeParse(priority).success) {
      throw new HandlerRegistrationError(
        name,
        `priority ${String(priority)} is not an integer in 0…999 (TD-005 bands)`,
      );
    }
    if (eventTypes !== 'all') {
      if (eventTypes.length === 0) {
        throw new HandlerRegistrationError(name, 'declares no event types');
      }
      for (const type of eventTypes) {
        if (!domainEventTypeSchema.safeParse(type).success) {
          throw new HandlerRegistrationError(name, `"${type}" is not a catalogue event type`);
        }
      }
    }
  }
}

/** Priority first, then name: two handlers in the same band always run in the same order. */
const sortHandlers = (handlers: readonly EventHandler[]): EventHandler[] =>
  [...handlers].sort((a, b) => a.priority - b.priority || (a.name < b.name ? -1 : 1));
