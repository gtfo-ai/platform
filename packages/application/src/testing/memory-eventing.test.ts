/**
 * The fake's own contract.
 *
 * A property test is only as good as the model it runs against, so the four behaviours the
 * dispatcher's proof rests on are pinned here — and each is re-proved against a real PostgreSQL in
 * `test/integration/events/`.
 */

import type { DomainEvent } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { CorruptEventError, StreamConflictError } from '../errors.js';
import { BroadcastMessageTooLargeError } from '../ports/broadcast.js';
import { streamId, taskQueued } from './fixtures.js';
import {
  faultsAt,
  MemoryEventing,
  MemoryLockConflictError,
  SimulatedCrashError,
} from './memory-eventing.js';

const stream = { streamType: 'task', streamId: streamId(1), streamSeq: 1 } as const;

describe('MemoryEventing', () => {
  it('appends with a gapless per-stream sequence and rejects anything else', async () => {
    const memory = new MemoryEventing();
    await memory.transaction(async (scope) => scope.events.append([taskQueued(stream)]));
    expect(await memory.store.nextStreamSequence('task', stream.streamId)).toBe(2);

    await expect(
      memory.transaction(async (scope) => scope.events.append([taskQueued(stream)])),
    ).rejects.toBeInstanceOf(StreamConflictError);
    await expect(
      memory.transaction(async (scope) =>
        scope.events.append([taskQueued({ ...stream, streamSeq: 5 })]),
      ),
    ).rejects.toBeInstanceOf(StreamConflictError);
  });

  it('keeps sequences independent per stream', async () => {
    const memory = new MemoryEventing();
    await memory.transaction(async (scope) => {
      await scope.events.append([taskQueued(stream)]);
      await scope.events.append([
        taskQueued({ streamType: 'task', streamId: streamId(2), streamSeq: 1 }),
      ]);
      return scope.events.append([taskQueued({ ...stream, streamSeq: 2 })]);
    });
    expect(await memory.store.nextStreamSequence('task', stream.streamId)).toBe(3);
    expect(await memory.store.nextStreamSequence('task', streamId(2))).toBe(2);
  });

  it('reports a concurrent append to one stream as a conflict', async () => {
    const memory = new MemoryEventing();
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = memory.transaction(async (scope) => {
      await scope.events.append([taskQueued(stream)]);
      await blocked;
    });
    await Promise.resolve();
    await expect(
      memory.transaction(async (scope) => scope.events.append([taskQueued(stream)])),
    ).rejects.toBeInstanceOf(StreamConflictError);
    release();
    await first;
  });

  it('rolls an append back with its transaction', async () => {
    const memory = new MemoryEventing();
    await expect(
      memory.transaction(async (scope) => {
        await scope.events.append([taskQueued(stream)]);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(memory.log).toEqual([]);
    expect(memory.pending).toEqual([]);
    expect(await memory.store.nextStreamSequence('task', stream.streamId)).toBe(1);
  });

  it('crashes before or after the commit exactly where it was told to', async () => {
    const before = new MemoryEventing({ faults: faultsAt([1]) });
    await expect(
      before.transaction(async (scope) => scope.events.append([taskQueued(stream)])),
    ).rejects.toBeInstanceOf(SimulatedCrashError);
    expect(before.log).toEqual([]);

    const after = new MemoryEventing({ faults: faultsAt([], [1]) });
    await expect(
      after.transaction(async (scope) => scope.events.append([taskQueued(stream)])),
    ).rejects.toBeInstanceOf(SimulatedCrashError);
    expect(after.log).toHaveLength(1);
  });

  it('hands a queue row to one transaction at a time (SKIP LOCKED)', async () => {
    const memory = new MemoryEventing();
    const [stored] = await memory.transaction(async (scope) =>
      scope.events.append([taskQueued(stream)]),
    );
    const position = stored?.position ?? 0;

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = memory.transaction(async (scope) => {
      expect(await scope.dispatchQueue.claim(position)).toBe('claimed');
      await held;
    });
    await Promise.resolve();

    await memory.transaction(async (scope) => {
      expect(await scope.dispatchQueue.claim(position)).toBe('busy');
    });
    release();
    await holder;

    // Once the row is gone, a claim says so rather than pretending it is available.
    await memory.transaction(async (scope) => {
      await scope.dispatchQueue.claim(position);
      await scope.dispatchQueue.complete(position);
    });
    await memory.transaction(async (scope) => {
      expect(await scope.dispatchQueue.claim(position)).toBe('completed');
    });
  });

  it('reports contention on one handler_executions row instead of deadlocking', async () => {
    const memory = new MemoryEventing();
    const [stored] = await memory.transaction(async (scope) =>
      scope.events.append([taskQueued(stream)]),
    );
    const position = stored?.position ?? 0;
    const ref = { handler: 'core.a', priority: 10 };

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = memory.transaction(async (scope) => {
      await scope.handlerExecutions.claim(position, ref);
      await held;
    });
    await Promise.resolve();

    await expect(
      memory.transaction(async (scope) => scope.handlerExecutions.claim(position, ref)),
    ).rejects.toBeInstanceOf(MemoryLockConflictError);
    release();
    await holder;
  });

  it('never lets recordFailure overwrite a terminal status', async () => {
    const memory = new MemoryEventing();
    const [stored] = await memory.transaction(async (scope) =>
      scope.events.append([taskQueued(stream)]),
    );
    const position = stored?.position ?? 0;
    const ref = { handler: 'core.a', priority: 10 };

    await memory.transaction(async (scope) => scope.handlerExecutions.complete(position, ref));
    await memory.transaction(async (scope) =>
      scope.handlerExecutions.recordFailure(position, ref, 'late failure'),
    );
    expect(memory.executions.find((row) => row.handler === 'core.a')?.status).toBe('succeeded');
  });

  it('returns the head of each stream, and only what is due', async () => {
    let now = 1_000;
    const memory = new MemoryEventing({ now: () => now });
    await memory.transaction(async (scope) => {
      await scope.events.append([taskQueued(stream)]);
      await scope.events.append([taskQueued({ ...stream, streamSeq: 2 })]);
      return scope.events.append([
        taskQueued({ streamType: 'task', streamId: streamId(2), streamSeq: 1 }),
      ]);
    });

    const head = await memory.store.readPendingDispatch({ limit: 10 });
    expect(head.map((event) => event.position)).toEqual([1, 3]);

    await memory.transaction(async (scope) => {
      await scope.dispatchQueue.claim(1);
      await scope.dispatchQueue.retryLater(1, 'boom', { baseMs: 100, maxMs: 1000 });
    });
    // Position 2 is next on that stream, but it stays behind the deferred head.
    expect((await memory.store.readPendingDispatch({ limit: 10 })).map((e) => e.position)).toEqual([
      3,
    ]);
    now += 200;
    expect((await memory.store.readPendingDispatch({ limit: 10 })).map((e) => e.position)).toEqual([
      1, 3,
    ]);
  });

  it('reads a stream back, filtered and limited', async () => {
    const memory = new MemoryEventing();
    await memory.transaction(async (scope) => {
      await scope.events.append([taskQueued(stream)]);
      await scope.events.append([taskQueued({ ...stream, streamSeq: 2 })]);
      return scope.events.append([taskQueued({ ...stream, streamSeq: 3 })]);
    });

    expect(await memory.store.readStream('task', stream.streamId)).toHaveLength(3);
    expect(
      (await memory.store.readStream('task', stream.streamId, { fromSeq: 2 })).map(
        (event) => event.event.stream_seq,
      ),
    ).toEqual([2, 3]);
    expect(await memory.store.readStream('task', stream.streamId, { limit: 1 })).toHaveLength(1);
    expect(await memory.store.readAt(2)).not.toBeNull();
    expect(await memory.store.readAt(99)).toBeNull();
    expect(await memory.store.countPendingDispatch()).toBe(3);
  });

  it('refuses an event that does not match the catalogue', async () => {
    const memory = new MemoryEventing();
    const broken = { ...taskQueued(stream), payload: {} } as unknown as DomainEvent;
    await expect(
      memory.transaction(async (scope) => scope.events.append([broken])),
    ).rejects.toBeInstanceOf(CorruptEventError);
  });

  it('delivers a broadcast only to the topics a listener asked for, and only on commit', async () => {
    const memory = new MemoryEventing();
    const seen: string[] = [];
    const subscription = await memory.broadcast.subscribe(['task:abc'], (message) => {
      seen.push(message.topic);
    });

    await expect(
      memory.transaction(async (scope) => {
        await scope.broadcast.publish({ topic: 'task:abc', payload: {} });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(seen).toEqual([]);

    await memory.transaction(async (scope) => {
      await scope.broadcast.publish({ topic: 'task:abc', payload: {} });
      await scope.broadcast.publish({ topic: 'org', payload: {} });
    });
    expect(seen).toEqual(['task:abc']);

    await subscription.close();
    await memory.broadcast.publish({ topic: 'task:abc', payload: {} });
    expect(seen).toEqual(['task:abc']);
  });

  it('refuses a broadcast larger than the transport can carry', async () => {
    const memory = new MemoryEventing();
    await expect(
      memory.broadcast.publish({ topic: 'org', payload: { blob: 'x'.repeat(8000) } }),
    ).rejects.toBeInstanceOf(BroadcastMessageTooLargeError);
  });

  it('refuses a malformed topic', async () => {
    const memory = new MemoryEventing();
    await expect(memory.broadcast.publish({ topic: 'Task:1', payload: {} })).rejects.toThrow(
      /not a broadcast topic/,
    );
  });
});
