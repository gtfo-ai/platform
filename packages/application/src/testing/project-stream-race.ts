/**
 * A project stream that another writer keeps winning — the injection WP-109's cases share (PROGRESS
 * backlog 333 and 357).
 *
 * Since BACKLOG 971 every project-stream writer takes the stream's lock and reads its sequence in
 * its own transaction (`scope.events.lockStreamSequence`), so a writer that keeps to the rule
 * cannot be overtaken. What the retry still defends against is a writer that **bypassed** the lock,
 * and that is what this models: for the first `losses` sequence reads, a rival commits a
 * `knowledge.index.rebuilt` at the sequence the writer was about to get, and the writer is handed
 * that stale sequence — so its append meets migration 0005's guard exactly as the old
 * read-over-the-pool race did. The rival's events carry the actor component
 * {@link RIVAL_COMPONENT}, so a case can tell them from the writer's own.
 *
 * Hand {@link RacingProjectStream.unitOfWork} to the writer under test in place of the
 * `MemoryEventing`. It started as `racingOptions` in `pipeline/delivery-measures.test.ts` (WP-90).
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import type { EventStore } from '../ports/event-store.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import type { MemoryEventing } from './memory-eventing.js';

/** The actor component every rival append carries. */
export const RIVAL_COMPONENT = 'rival-project-writer';

export interface RacingProjectStream {
  /** Hand this to the writer under test in place of the `MemoryEventing` as its unit of work. */
  readonly unitOfWork: UnitOfWork;
  /** The plain read side, for a writer whose options still carry one. */
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
  /** How many races the rival has won so far. */
  readonly lost: () => number;
  /** How many sequence reads the writer made. */
  readonly reads: () => number;
}

let rivalEvents = 0;

const rivalEvent = (projectId: string, streamSeq: number): DomainEvent => {
  rivalEvents += 1;
  return domainEventSchemasByType['knowledge.index.rebuilt'].parse({
    id: `ffffffff-0000-4000-8000-${String(rivalEvents).padStart(12, '0')}`,
    stream_type: 'project',
    stream_id: projectId,
    stream_seq: streamSeq,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'system', component: RIVAL_COMPONENT },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'knowledge.index.rebuilt',
    payload: {
      project_id: projectId,
      commit_sha: 'feedface',
      documents: 0,
      chunks: 0,
      tokens: 0,
    },
  }) as DomainEvent;
};

/** What the rival commits at the sequence it takes; the default appends one rival event. */
export type ProjectStreamRival = (
  scope: TransactionScope,
  projectId: Id,
  streamSeq: number,
) => Promise<void>;

/** A stream on which a rival takes the next `losses` sequences the writer reads, one per read. */
export const racingProjectStream = (
  eventing: MemoryEventing,
  losses: number,
  rival: ProjectStreamRival = async (scope, projectId, streamSeq) => {
    await scope.events.append([rivalEvent(projectId, streamSeq)]);
  },
): RacingProjectStream => {
  let lost = 0;
  let reads = 0;
  return {
    lost: () => lost,
    reads: () => reads,
    eventStore: { nextStreamSequence: eventing.store.nextStreamSequence },
    unitOfWork: {
      transaction: (fn) =>
        eventing.transaction((scope) =>
          fn({
            ...scope,
            events: {
              append: (events, appendOptions) => scope.events.append(events, appendOptions),
              lockStreamSequence: async (streamType, streamId) => {
                reads += 1;
                if (streamType !== 'project' || lost >= losses) {
                  return scope.events.lockStreamSequence(streamType, streamId);
                }
                lost += 1;
                const stale = await eventing.store.nextStreamSequence(streamType, streamId);
                await eventing.transaction(async (rivalScope) =>
                  rival(rivalScope, streamId as Id, stale),
                );
                await scope.events.lockStreamSequence(streamType, streamId);
                return stale;
              },
            },
          }),
        ),
    },
  };
};
