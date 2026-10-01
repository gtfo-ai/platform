/**
 * A project stream that another writer keeps winning — the injection WP-109's cases share (PROGRESS
 * backlog 333 and 357).
 *
 * `nextStreamSequence` answers the sequence it read and, for the first `losses` reads, has a rival
 * append a `knowledge.index.rebuilt` at that very sequence before the caller's transaction opens:
 * exactly the interleaving the backlog entries describe (a read over the pool, another writer's
 * commit, then the append), so the caller's append meets the sequence guard as it would in
 * PostgreSQL. The rival's events carry the actor component {@link RIVAL_COMPONENT}, so a case can
 * tell them from the writer's own.
 *
 * It started as `racingOptions` in `pipeline/delivery-measures.test.ts` (WP-90) and is shared now
 * because five writers needed the same twenty lines.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import type { EventStore } from '../ports/event-store.js';
import type { MemoryEventing } from './memory-eventing.js';

/** The actor component every rival append carries. */
export const RIVAL_COMPONENT = 'rival-project-writer';

export interface RacingProjectStream {
  /** Hand this to the writer under test in place of `eventing.store`. */
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

/** A stream on which a rival takes the next `losses` sequences the writer reads, one per read. */
export const racingProjectStream = (
  eventing: MemoryEventing,
  losses: number,
): RacingProjectStream => {
  let lost = 0;
  let reads = 0;
  return {
    lost: () => lost,
    reads: () => reads,
    eventStore: {
      nextStreamSequence: async (streamType, streamId) => {
        reads += 1;
        const seq = await eventing.store.nextStreamSequence(streamType, streamId);
        if (streamType === 'project' && lost < losses) {
          lost += 1;
          await eventing.transaction(async (scope) => {
            await scope.events.append([rivalEvent(streamId as Id, seq)]);
          });
        }
        return seq;
      },
    },
  };
};
