/**
 * An in-memory event store, dispatch queue, handler-execution log and broadcast.
 *
 * technical/10 treats fakes as first-class code, and this one exists for a specific reason: the
 * acceptance criterion of WP-04 is a *property* — at-least-once delivery plus idempotent handlers
 * gives exactly-once effects, and events of one stream take effect in order. Proving a property
 * needs thousands of runs with adversarial interleavings and crashes at chosen instants, which a
 * container cannot give at that speed. So this fake reproduces the four behaviours the proof rests
 * on, and the integration tier then proves the Postgres adapter really has them:
 *
 * 1. **Atomic commit.** A transaction's writes — the handler's effect, its `handler_executions`
 *    row, the events it emitted — land together or not at all.
 * 2. **Row locks.** `dispatchQueue.claim` is `FOR UPDATE SKIP LOCKED`: a second transaction gets
 *    `busy`, never a second copy of the work.
 * 3. **The stream-sequence guard.** An append with the wrong `stream_seq`, or a concurrent append
 *    to the same stream, is a `StreamConflictError` — what migration 0005's trigger raises.
 * 4. **Crashes.** `MemoryFaults` can kill a transaction just before or just after its commit,
 *    which is the only interesting window: the one where the effect and the bookkeeping could
 *    disagree.
 *
 * It is not a database. There is no MVCC: a transaction reads committed state plus its own
 * uncommitted writes, and contention is reported immediately instead of blocking, because a fake
 * that blocks in a single-threaded test just deadlocks it.
 */
import type { DomainEvent, Id, StreamType } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { CorruptEventError, StreamConflictError } from '../errors.js';
import {
  assertTopic,
  type Broadcast,
  type BroadcastListener,
  type BroadcastMessage,
  BroadcastMessageTooLargeError,
  type BroadcastSubscription,
  EVENTS_APPENDED_TOPIC,
  MAX_BROADCAST_BYTES,
} from '../ports/broadcast.js';
import type {
  DispatchClaim,
  DispatchQueue,
  DispatchQueueEntry,
  RetryBackoff,
} from '../ports/dispatch-queue.js';
import type {
  AppendOptions,
  EventAppender,
  EventStore,
  PendingDispatchRequest,
  ReadRangeRequest,
  ReadStreamOptions,
  StoredEvent,
} from '../ports/event-store.js';
import {
  type HandlerExecutionReader,
  type HandlerExecutionRecord,
  type HandlerExecutionStatus,
  type HandlerExecutionWriter,
  type HandlerRef,
  TERMINAL_HANDLER_STATUSES,
} from '../ports/handler-executions.js';
import type { Transaction } from '../ports/transaction.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';

export const MEMORY_ADAPTER = 'memory';

/** The process died at a chosen instant. Distinct so tests can tell it from a handler bug. */
export class SimulatedCrashError extends Error {
  readonly when: 'before-commit' | 'after-commit';

  constructor(when: 'before-commit' | 'after-commit', index: number) {
    super(`simulated crash ${when} on transaction ${index}`);
    this.name = 'SimulatedCrashError';
    this.when = when;
  }
}

/** Two transactions wanted the same `handler_executions` row; PostgreSQL would have blocked. */
export class MemoryLockConflictError extends Error {
  constructor(key: string) {
    super(`another transaction holds ${key}`);
    this.name = 'MemoryLockConflictError';
  }
}

export type CommitFault = 'none' | 'before-commit' | 'after-commit';

/** Decides, per transaction, whether the process survives its commit. */
export interface MemoryFaults {
  /** Called once per commit attempt with a 1-based counter. */
  onCommit(index: number): CommitFault;
}

export const noFaults: MemoryFaults = { onCommit: () => 'none' };

/** Fails the listed commits; everything else survives. */
export const faultsAt = (
  before: readonly number[] = [],
  after: readonly number[] = [],
): MemoryFaults => ({
  onCommit: (index) =>
    before.includes(index) ? 'before-commit' : after.includes(index) ? 'after-commit' : 'none',
});

interface EventRow {
  readonly position: number;
  readonly causeEventPosition: number | null;
  readonly event: DomainEvent;
}

interface QueueRow {
  readonly eventPosition: number;
  readonly streamType: string;
  readonly streamId: string;
  readonly streamSeq: number;
  readonly attempts: number;
  readonly error: string | null;
  readonly availableAtMs: number;
}

/** A staged append: the log row and the queue row the trigger would have written with it. */
interface StagedAppend {
  readonly event: DomainEvent;
  readonly position: number;
  readonly causeEventPosition: number | null;
  readonly queue: QueueRow;
}

interface ExecutionRow {
  readonly eventPosition: number;
  readonly handler: string;
  readonly priority: number;
  readonly status: HandlerExecutionStatus;
  readonly attempts: number;
  readonly error: string | null;
}

const executionKey = (position: number, handler: string): string => `${position}:${handler}`;
const streamKey = (streamType: string, streamId: string): string => `${streamType}/${streamId}`;

export interface MemoryEventingOptions {
  readonly faults?: MemoryFaults;
  /** Monotonic clock in milliseconds; the retry backoff is measured against it. */
  readonly now?: () => number;
}

/**
 * The whole fake: a `UnitOfWork`, the read side of the store, the execution log and a broadcast,
 * over one shared state.
 */
export class MemoryEventing implements UnitOfWork {
  readonly #events: EventRow[] = [];
  readonly #queue = new Map<number, QueueRow>();
  readonly #executions = new Map<string, ExecutionRow>();
  readonly #queueLocks = new Map<number, MemoryTransaction>();
  readonly #executionLocks = new Map<string, MemoryTransaction>();
  readonly #streamLocks = new Map<string, MemoryTransaction>();
  readonly #listeners = new Map<BroadcastListener, ReadonlySet<string>>();
  readonly #faults: MemoryFaults;
  readonly #now: () => number;
  #nextPosition = 1;
  #commits = 0;

  constructor(options: MemoryEventingOptions = {}) {
    this.#faults = options.faults ?? noFaults;
    this.#now = options.now ?? Date.now;
  }

  // ── UnitOfWork ─────────────────────────────────────────────────────────────

  async transaction<T>(fn: (scope: TransactionScope) => Promise<T>): Promise<T> {
    const tx = new MemoryTransaction(this);
    let result: T;
    try {
      result = await fn(tx.scope);
    } catch (error) {
      tx.rollback();
      throw error;
    }
    this.#commits += 1;
    const fault = this.#faults.onCommit(this.#commits);
    if (fault === 'before-commit') {
      tx.rollback();
      throw new SimulatedCrashError('before-commit', this.#commits);
    }
    tx.commit();
    if (fault === 'after-commit') {
      throw new SimulatedCrashError('after-commit', this.#commits);
    }
    return result;
  }

  // ── Read side (EventStore + HandlerExecutionReader) ────────────────────────

  get store(): EventStore & HandlerExecutionReader {
    return {
      readStream: async (streamType, streamId, options) =>
        this.#readStream(streamType, streamId, options),
      nextStreamSequence: async (streamType, streamId) => this.#lastSeq(streamType, streamId) + 1,
      readAt: async (position) => toStoredEvent(this.#events.find((r) => r.position === position)),
      readRange: async (request) => this.#readRange(request),
      readPendingDispatch: async (request) => this.#readPendingDispatch(request),
      countPendingDispatch: async () => this.#queue.size,
      read: async (position) =>
        [...this.#executions.values()]
          .filter((row) => row.eventPosition === position)
          .map(toExecutionRecord)
          .sort((a, b) => a.priority - b.priority || (a.handler < b.handler ? -1 : 1)),
    };
  }

  /** Non-transactional publish/subscribe, for a worker's wake-up subscription. */
  get broadcast(): Broadcast {
    return {
      publish: async (message) => {
        this.#deliver(assertMessage(message));
      },
      subscribe: async (topics, listener) => this.#subscribe(topics, listener),
      close: async () => {
        this.#listeners.clear();
      },
    };
  }

  /** Every queued event, for assertions. */
  get pending(): readonly DispatchQueueEntry[] {
    return [...this.#queue.values()]
      .map((row) => ({
        eventPosition: row.eventPosition,
        streamType: row.streamType,
        streamId: row.streamId,
        streamSeq: row.streamSeq,
        attempts: row.attempts,
        error: row.error,
        availableAt: new Date(row.availableAtMs).toISOString(),
      }))
      .sort((a, b) => a.eventPosition - b.eventPosition);
  }

  /** Every committed event, in log order. */
  get log(): readonly StoredEvent[] {
    return this.#events.map((row) => ({
      position: row.position,
      causeEventPosition: row.causeEventPosition,
      event: row.event,
    }));
  }

  get executions(): readonly HandlerExecutionRecord[] {
    return [...this.#executions.values()].map(toExecutionRecord);
  }

  #readStream(
    streamType: StreamType,
    streamId: Id,
    options: ReadStreamOptions | undefined,
  ): readonly StoredEvent[] {
    const fromSeq = options?.fromSeq ?? 1;
    const rows = this.#events
      .filter(
        (row) =>
          row.event.stream_type === streamType &&
          row.event.stream_id === streamId &&
          row.event.stream_seq >= fromSeq,
      )
      .sort((a, b) => a.event.stream_seq - b.event.stream_seq);
    const limited = options?.limit === undefined ? rows : rows.slice(0, options.limit);
    return limited.map((row) => ({
      position: row.position,
      causeEventPosition: row.causeEventPosition,
      event: row.event,
    }));
  }

  /** A window of the log, from the log itself — never from the queue (see the port's docblock). */
  #readRange(request: ReadRangeRequest): readonly StoredEvent[] {
    const types = request.types === undefined ? null : new Set<string>(request.types);
    return this.#events
      .filter(
        (row) =>
          row.position > request.fromPosition &&
          (request.toPosition === undefined || row.position <= request.toPosition) &&
          (types === null || types.has(row.event.type)),
      )
      .sort((a, b) => a.position - b.position)
      .slice(0, request.limit)
      .map((row) => ({
        position: row.position,
        causeEventPosition: row.causeEventPosition,
        event: row.event,
      }));
  }

  /**
   * The earliest due event of each stream, in position order — the same shape the SQL sweep
   * returns, and the reason two workers can never take two events of one stream at once.
   */
  #readPendingDispatch(request: PendingDispatchRequest): readonly StoredEvent[] {
    const now = this.#now();
    const heads = new Map<string, QueueRow>();
    for (const row of this.#queue.values()) {
      const key = streamKey(row.streamType, row.streamId);
      const head = heads.get(key);
      if (head === undefined || row.streamSeq < head.streamSeq) {
        heads.set(key, row);
      }
    }
    // The head is picked before the due filter, not after: a stream whose earliest event is
    // waiting out a retry backoff yields nothing at all, rather than offering its second event to
    // a dispatcher that would only refuse it.
    return [...heads.values()]
      .filter((row) => row.availableAtMs <= now)
      .sort((a, b) => a.eventPosition - b.eventPosition)
      .slice(0, request.limit)
      .map((row) => {
        const event = this.#events.find((candidate) => candidate.position === row.eventPosition);
        if (event === undefined) {
          throw new CorruptEventError(row.eventPosition, 'queued event is not in the log');
        }
        return {
          position: event.position,
          causeEventPosition: event.causeEventPosition,
          event: event.event,
        };
      });
  }

  #lastSeq(streamType: string, streamId: string): number {
    let last = 0;
    for (const row of this.#events) {
      if (row.event.stream_type === streamType && row.event.stream_id === streamId) {
        last = Math.max(last, row.event.stream_seq);
      }
    }
    return last;
  }

  #subscribe(topics: readonly string[], listener: BroadcastListener): BroadcastSubscription {
    this.#listeners.set(listener, new Set(topics.map(assertTopic)));
    return {
      close: async () => {
        this.#listeners.delete(listener);
      },
    };
  }

  #deliver(message: BroadcastMessage): void {
    for (const [listener, topics] of this.#listeners) {
      if (topics.has(message.topic)) {
        listener(message);
      }
    }
  }

  // ── Internals used by MemoryTransaction ────────────────────────────────────

  /** @internal */
  _commit(tx: MemoryTransaction): void {
    for (const row of tx.appended) {
      this.#events.push({
        position: row.position,
        causeEventPosition: row.causeEventPosition,
        event: row.event,
      });
      this.#queue.set(row.position, row.queue);
    }
    for (const position of tx.queueDeletes) {
      this.#queue.delete(position);
    }
    for (const [position, row] of tx.queueWrites) {
      if (!tx.queueDeletes.has(position)) {
        this.#queue.set(position, row);
      }
    }
    for (const [key, row] of tx.executionWrites) {
      this.#executions.set(key, row);
    }
    for (const message of tx.broadcasts) {
      this.#deliver(message);
    }
    this._release(tx);
  }

  /** @internal */
  _release(tx: MemoryTransaction): void {
    for (const [position, owner] of this.#queueLocks) {
      if (owner === tx) {
        this.#queueLocks.delete(position);
      }
    }
    for (const [key, owner] of this.#executionLocks) {
      if (owner === tx) {
        this.#executionLocks.delete(key);
      }
    }
    for (const [key, owner] of this.#streamLocks) {
      if (owner === tx) {
        this.#streamLocks.delete(key);
      }
    }
  }

  /** @internal */
  _nextPosition(): number {
    const position = this.#nextPosition;
    this.#nextPosition += 1;
    return position;
  }

  /** @internal */
  _nowMs(): number {
    return this.#now();
  }

  /** @internal */
  _lockStream(tx: MemoryTransaction, streamType: string, streamId: string): void {
    const key = streamKey(streamType, streamId);
    const owner = this.#streamLocks.get(key);
    if (owner !== undefined && owner !== tx) {
      // PostgreSQL would block here and then raise 23505 when the winner commits; the loser's
      // outcome is the same either way.
      throw new StreamConflictError(streamType, streamId, this.#lastSeq(streamType, streamId) + 1);
    }
    this.#streamLocks.set(key, tx);
  }

  /** @internal */
  _committedLastSeq(streamType: string, streamId: string): number {
    return this.#lastSeq(streamType, streamId);
  }

  /** @internal */
  _queueRow(position: number): QueueRow | undefined {
    return this.#queue.get(position);
  }

  /** @internal */
  _queueRows(): readonly QueueRow[] {
    return [...this.#queue.values()];
  }

  /** @internal */
  _lockQueueRow(tx: MemoryTransaction, position: number): DispatchClaim {
    if (!this.#queue.has(position)) {
      return 'completed';
    }
    const owner = this.#queueLocks.get(position);
    if (owner !== undefined && owner !== tx) {
      return 'busy';
    }
    this.#queueLocks.set(position, tx);
    return 'claimed';
  }

  /** @internal */
  _lockExecution(tx: MemoryTransaction, key: string): void {
    const owner = this.#executionLocks.get(key);
    if (owner !== undefined && owner !== tx) {
      throw new MemoryLockConflictError(key);
    }
    this.#executionLocks.set(key, tx);
  }

  /** @internal */
  _execution(key: string): ExecutionRow | undefined {
    return this.#executions.get(key);
  }
}

/** One transaction's staged writes; nothing here is visible until `commit`. */
class MemoryTransaction {
  readonly appended: StagedAppend[] = [];
  readonly queueDeletes = new Set<number>();
  readonly queueWrites = new Map<number, QueueRow>();
  readonly executionWrites = new Map<string, ExecutionRow>();
  readonly broadcasts: BroadcastMessage[] = [];
  readonly scope: TransactionScope;
  readonly #owner: MemoryEventing;

  constructor(owner: MemoryEventing) {
    this.#owner = owner;
    const handle: Transaction = { adapter: MEMORY_ADAPTER };
    this.scope = {
      tx: handle,
      events: this.#appender(),
      dispatchQueue: this.#dispatchQueue(),
      handlerExecutions: this.#handlerExecutions(),
      broadcast: {
        publish: async (message) => {
          this.broadcasts.push(assertMessage(message));
        },
      },
    };
  }

  commit(): void {
    this.#owner._commit(this);
  }

  rollback(): void {
    this.#owner._release(this);
  }

  #appender(): EventAppender {
    return {
      append: async (events: readonly DomainEvent[], options?: AppendOptions) => {
        const appended: StoredEvent[] = [];
        for (const event of events) {
          appended.push(this.#appendOne(event, options?.causeEventPosition ?? null));
        }
        if (appended.length > 0) {
          // One hint per transaction, exactly as Postgres collapses identical NOTIFYs (TD-005).
          this.broadcasts.push({ topic: EVENTS_APPENDED_TOPIC, payload: {} });
        }
        return appended;
      },
    };
  }

  #appendOne(event: DomainEvent, causeEventPosition: number | null): StoredEvent {
    const schema = domainEventSchemasByType[event.type];
    const parsed = schema.safeParse(event);
    if (!parsed.success) {
      throw new CorruptEventError(
        0,
        `append rejected ${event.type}: ${parsed.error.issues[0]?.message ?? 'invalid event'}`,
      );
    }
    const { stream_type: streamType, stream_id: streamId, stream_seq: streamSeq } = event;
    this.#owner._lockStream(this, streamType, streamId);

    const staged = this.appended.filter(
      (row) => row.event.stream_type === streamType && row.event.stream_id === streamId,
    );
    const last = staged.reduce(
      (highest, row) => Math.max(highest, row.event.stream_seq),
      this.#owner._committedLastSeq(streamType, streamId),
    );
    if (streamSeq !== last + 1) {
      throw new StreamConflictError(streamType, streamId, streamSeq);
    }

    const position = this.#owner._nextPosition();
    this.appended.push({
      position,
      event,
      causeEventPosition,
      queue: {
        eventPosition: position,
        streamType,
        streamId,
        streamSeq,
        attempts: 0,
        error: null,
        availableAtMs: this.#owner._nowMs(),
      },
    });
    return { position, causeEventPosition, event };
  }

  #dispatchQueue(): DispatchQueue {
    return {
      claim: async (position) => {
        if (this.queueDeletes.has(position)) {
          return 'completed';
        }
        return this.#owner._lockQueueRow(this, position);
      },
      complete: async (position) => {
        this.queueDeletes.add(position);
      },
      retryLater: async (position, error, backoff: RetryBackoff) => {
        const row = this.queueWrites.get(position) ?? this.#owner._queueRow(position);
        if (row === undefined) {
          return;
        }
        const attempts = row.attempts + 1;
        const delay = Math.min(backoff.baseMs * 2 ** Math.min(row.attempts, 10), backoff.maxMs);
        this.queueWrites.set(position, {
          ...row,
          attempts,
          error,
          availableAtMs: this.#owner._nowMs() + delay,
        });
      },
      hasEarlierPending: async (streamType, streamId, streamSeq) =>
        this.#owner
          ._queueRows()
          .some(
            (row) =>
              row.streamType === streamType &&
              row.streamId === streamId &&
              row.streamSeq < streamSeq &&
              !this.queueDeletes.has(row.eventPosition),
          ),
    };
  }

  #handlerExecutions(): HandlerExecutionWriter {
    const read = (position: number, handler: string): ExecutionRow | undefined => {
      const key = executionKey(position, handler);
      return this.executionWrites.get(key) ?? this.#owner._execution(key);
    };

    return {
      claim: async (position, handler: HandlerRef) => {
        const key = executionKey(position, handler.handler);
        this.#owner._lockExecution(this, key);
        const existing = read(position, handler.handler);
        if (existing !== undefined && TERMINAL_HANDLER_STATUSES.includes(existing.status)) {
          return false;
        }
        this.executionWrites.set(key, {
          eventPosition: position,
          handler: handler.handler,
          priority: handler.priority,
          status: 'running',
          attempts: (existing?.attempts ?? 0) + 1,
          error: null,
        });
        return true;
      },
      complete: async (position, handler: HandlerRef) => {
        const key = executionKey(position, handler.handler);
        const existing = read(position, handler.handler);
        this.executionWrites.set(key, {
          eventPosition: position,
          handler: handler.handler,
          priority: handler.priority,
          status: 'succeeded',
          attempts: existing?.attempts ?? 1,
          error: null,
        });
      },
      recordFailure: async (position, handler: HandlerRef, error) => {
        const key = executionKey(position, handler.handler);
        const existing = read(position, handler.handler);
        // Never overwrite a terminal status: a handler that committed and *then* met a crash is
        // succeeded, whatever the caller observed.
        if (existing !== undefined && TERMINAL_HANDLER_STATUSES.includes(existing.status)) {
          return;
        }
        this.executionWrites.set(key, {
          eventPosition: position,
          handler: handler.handler,
          priority: handler.priority,
          status: 'failed',
          attempts: (existing?.attempts ?? 0) + 1,
          error,
        });
      },
      markStopped: async (position, remaining, reason) => {
        for (const handler of remaining) {
          const key = executionKey(position, handler.handler);
          const existing = read(position, handler.handler);
          if (existing !== undefined && TERMINAL_HANDLER_STATUSES.includes(existing.status)) {
            continue;
          }
          this.executionWrites.set(key, {
            eventPosition: position,
            handler: handler.handler,
            priority: handler.priority,
            status: 'stopped',
            attempts: existing?.attempts ?? 0,
            error: reason,
          });
        }
      },
    };
  }
}

const toStoredEvent = (row: EventRow | undefined): StoredEvent | null =>
  row === undefined
    ? null
    : { position: row.position, causeEventPosition: row.causeEventPosition, event: row.event };

const toExecutionRecord = (row: ExecutionRow): HandlerExecutionRecord => ({
  eventPosition: row.eventPosition,
  handler: row.handler,
  priority: row.priority,
  status: row.status,
  attempts: row.attempts,
  error: row.error,
});

const assertMessage = (message: BroadcastMessage): BroadcastMessage => {
  assertTopic(message.topic);
  const bytes = new TextEncoder().encode(JSON.stringify(message)).length;
  if (bytes > MAX_BROADCAST_BYTES) {
    throw new BroadcastMessageTooLargeError(message.topic, bytes);
  }
  return message;
};
