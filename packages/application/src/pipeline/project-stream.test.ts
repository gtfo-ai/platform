/**
 * `appendOnProjectWithRetry` — the one in-place retry of a lost project-stream race (WP-109, PROGRESS
 * backlog 333 and 357). Each writer's own cases are beside the writer; these pin the loop itself:
 * the bound from both sides, which conflicts it retries, and that a rolled-back attempt leaves
 * nothing behind.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { StreamConflictError } from '../errors.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { RIVAL_COMPONENT, racingProjectStream } from '../testing/project-stream-race.js';
import { appendOnProjectWithRetry, PROJECT_STREAM_APPEND_ATTEMPTS } from './project-stream.js';

const PROJECT = '00000000-0000-4000-8000-0000000001a1' as Id;
const OTHER = '00000000-0000-4000-8000-0000000001a2' as Id;

let ids = 0;
const rebuilt = (projectId: Id, streamSeq: number): DomainEvent => {
  ids += 1;
  return domainEventSchemasByType['knowledge.index.rebuilt'].parse({
    id: `00000000-0000-4000-8000-${String(0x1b0000 + ids).padStart(12, '0')}`,
    stream_type: 'project',
    stream_id: projectId,
    stream_seq: streamSeq,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'system', component: 'writer-under-test' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'knowledge.index.rebuilt',
    payload: { project_id: projectId, commit_sha: 'abc1234', documents: 1, chunks: 1, tokens: 1 },
  }) as DomainEvent;
};

const own = async (eventing: MemoryEventing, projectId: Id) =>
  (await eventing.store.readStream('project', projectId)).filter(
    (stored) =>
      stored.event.actor.kind === 'system' && stored.event.actor.component !== RIVAL_COMPONENT,
  );

describe('appendOnProjectWithRetry', () => {
  it('lands on the last attempt the bound allows, with the work run once per attempt', async () => {
    const eventing = new MemoryEventing();
    const race = racingProjectStream(eventing, PROJECT_STREAM_APPEND_ATTEMPTS - 1);
    let attempts = 0;
    const answer = await appendOnProjectWithRetry(
      { unitOfWork: eventing, eventStore: race.eventStore },
      { projectId: PROJECT, writer: 'test' },
      async (scope, streamSeq) => {
        attempts += 1;
        await scope.events.append([rebuilt(PROJECT, streamSeq)]);
        return streamSeq;
      },
    );
    expect(attempts).toBe(PROJECT_STREAM_APPEND_ATTEMPTS);
    expect(answer).toBe(PROJECT_STREAM_APPEND_ATTEMPTS);
    expect(await own(eventing, PROJECT)).toHaveLength(1);
  });

  it('throws the conflict once every attempt has lost, and appends nothing of its own', async () => {
    const eventing = new MemoryEventing();
    const race = racingProjectStream(eventing, PROJECT_STREAM_APPEND_ATTEMPTS);
    let attempts = 0;
    await expect(
      appendOnProjectWithRetry(
        { unitOfWork: eventing, eventStore: race.eventStore },
        { projectId: PROJECT, writer: 'test' },
        async (scope, streamSeq) => {
          attempts += 1;
          await scope.events.append([rebuilt(PROJECT, streamSeq)]);
        },
      ),
    ).rejects.toBeInstanceOf(StreamConflictError);
    expect(attempts).toBe(PROJECT_STREAM_APPEND_ATTEMPTS);
    expect(await own(eventing, PROJECT)).toEqual([]);
  });

  it('rethrows a conflict on another stream on the first attempt', async () => {
    const eventing = new MemoryEventing();
    let attempts = 0;
    await expect(
      appendOnProjectWithRetry(
        { unitOfWork: eventing, eventStore: eventing.store },
        { projectId: PROJECT, writer: 'test' },
        async () => {
          attempts += 1;
          throw new StreamConflictError('project', OTHER, 1);
        },
      ),
    ).rejects.toBeInstanceOf(StreamConflictError);
    expect(attempts).toBe(1);
  });

  it('rethrows anything that is not a conflict on the first attempt', async () => {
    const eventing = new MemoryEventing();
    let attempts = 0;
    await expect(
      appendOnProjectWithRetry(
        { unitOfWork: eventing, eventStore: eventing.store },
        { projectId: PROJECT, writer: 'test' },
        async () => {
          attempts += 1;
          throw new Error('not a race');
        },
      ),
    ).rejects.toThrow('not a race');
    expect(attempts).toBe(1);
  });

  it('lands two concurrent writers on one stream, one after the other', async () => {
    const eventing = new MemoryEventing();
    const write = () =>
      appendOnProjectWithRetry(
        { unitOfWork: eventing, eventStore: eventing.store },
        { projectId: PROJECT, writer: 'test' },
        async (scope, streamSeq) => {
          await scope.events.append([rebuilt(PROJECT, streamSeq)]);
          return streamSeq;
        },
      );
    const seqs = await Promise.all([write(), write()]);
    expect([...seqs].sort()).toEqual([1, 2]);
  });
});
