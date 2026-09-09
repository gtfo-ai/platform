/**
 * Catalogue events for tests, built the way an aggregate builds them.
 *
 * `buildEvent` comes from `@platform/domain`, so a fixture that drifts from technical/02 fails the
 * same way production code would — the alternative, hand-written object literals, would let a test
 * pass against an event shape the log will not accept.
 */
import type {
  DomainEventType,
  EventOfType,
  EventPayload,
  Id,
  IsoDateTime,
  StreamType,
} from '@platform/contracts';
import { buildEvent, sequentialIds } from '@platform/domain';

const ids = sequentialIds(0x1000);

export interface StreamPosition {
  readonly streamType: StreamType;
  readonly streamId: Id;
  readonly streamSeq: number;
}

export interface EventFixtureOverrides {
  readonly id?: Id;
  readonly occurredAt?: IsoDateTime;
  readonly correlationId?: Id | null;
  readonly causeEventId?: Id | null;
}

/** A `uuidv7`-shaped placeholder id; any UUID parses (`idSchema` is `z.uuid()`). */
export const testId = (): Id => ids.next();

export const makeEvent = <T extends DomainEventType>(
  type: T,
  payload: EventPayload<T>,
  stream: StreamPosition,
  overrides: EventFixtureOverrides = {},
): EventOfType<T> =>
  buildEvent(type, payload, stream, {
    ids: { next: () => overrides.id ?? ids.next() },
    actor: { kind: 'system', component: 'test' },
    // `occurred_at` defaults to now on purpose: the log has no past-month partition, so a
    // back-dated fixture would fail against a real database and pass against the fake.
    clock: { now: () => overrides.occurredAt ?? (new Date().toISOString() as IsoDateTime) },
    correlationId: overrides.correlationId ?? null,
    causeEventId: overrides.causeEventId ?? null,
  });

/** The simplest task-scoped event in the catalogue; used wherever the payload does not matter. */
export const taskQueued = (
  stream: StreamPosition,
  taskId: Id = stream.streamId,
  projectId: Id = '00000000-0000-4000-8000-0000000000ff',
): EventOfType<'task.queued'> =>
  makeEvent('task.queued', { project_id: projectId, task_id: taskId, reason: 'wip' }, stream);

/** A second type, so tests can prove a handler's `eventTypes` filter really filters. */
export const taskDequeued = (
  stream: StreamPosition,
  taskId: Id = stream.streamId,
  projectId: Id = '00000000-0000-4000-8000-0000000000ff',
): EventOfType<'task.dequeued'> =>
  makeEvent('task.dequeued', { project_id: projectId, task_id: taskId, reason: 'wip' }, stream);

/** A stream id shaped like the others, derived from a small integer for readable failures. */
export const streamId = (n: number): Id =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
