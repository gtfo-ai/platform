/**
 * The in-memory human-time store's own divergences, as **assertions** rather than as warnings.
 *
 * Standing rule 12: the place a fake is most permissive is the place a later work package leans
 * hardest, so each entry in its register gets a test that says so out loud.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createMemoryHumanTimeStore, HumanTimeStoreError } from './memory-human-time.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const TX = { adapter: 'memory' } as never;
const AT = '2026-06-01T09:00:00.000Z' as IsoDateTime;

const entry = (startedAt: string) => ({
  taskId: TASK,
  kind: 'review' as const,
  userId: null,
  externalAuthor: 'gitlab:ada',
  startedAt: startedAt as IsoDateTime,
  endedAt: startedAt as IsoDateTime,
  minutes: 0,
});

describe('the memory human-time store', () => {
  it('divergence 1: a transaction handle is accepted and ignored, so writes survive a rollback', async () => {
    // Stated as a test rather than as a warning, because it is the reason the same contract suite
    // runs against PostgreSQL: nothing in this file can fail the way a real transaction can.
    const store = createMemoryHumanTimeStore();
    await store.appendEntry(TX, entry(AT));
    expect(store.entries).toHaveLength(1);
  });

  it('divergence 2: it accepts a task no task row has, which PostgreSQL refuses', async () => {
    const store = createMemoryHumanTimeStore();
    await store.appendEntry(TX, {
      ...entry(AT),
      taskId: '00000000-0000-4000-8000-00000000dead' as Id,
    });
    expect(store.entries).toHaveLength(1);
  });

  it('divergence 3: review entries come back newest activity first', async () => {
    const store = createMemoryHumanTimeStore();
    await store.appendEntry(TX, entry('2026-06-01T09:00:00.000Z'));
    await store.appendEntry(TX, entry('2026-06-01T11:00:00.000Z'));
    expect((await store.reviewEntries(TX, TASK)).map((row) => row.startedAt)).toEqual([
      '2026-06-01T11:00:00.000Z',
      '2026-06-01T09:00:00.000Z',
    ]);
  });

  it('divergence 4: it hands out clones, so a caller cannot mutate what it read', async () => {
    const store = createMemoryHumanTimeStore();
    await store.appendEntry(TX, entry(AT));
    const [read] = await store.reviewEntries(TX, TASK);
    (read as { minutes: number }).minutes = 999;
    expect((await store.reviewEntries(TX, TASK))[0]?.minutes).toBe(0);
  });

  it('divergence 5: extending a row that does not exist throws, as the SQL adapter does', async () => {
    const store = createMemoryHumanTimeStore();
    await expect(
      store.extendEntry(TX, '00000000-0000-4000-8000-00000000dead' as Id, {
        endedAt: AT,
        minutes: 5,
      }),
    ).rejects.toBeInstanceOf(HumanTimeStoreError);
  });

  it('answers null for an unmapped account and for a project with no zone', async () => {
    const store = createMemoryHumanTimeStore();
    expect(await store.resolveUser(TX, { provider: 'gitlab', externalId: 'ada' })).toBeNull();
    expect(await store.organisationTimezone(TX, PROJECT)).toBeNull();
    // The two seams the pipeline harness uses are absent by default and answer null, rather than
    // throwing at a caller that has nothing to seed.
    expect(await store.taskForMergeRequest(TX, { projectId: PROJECT, iid: 7 })).toBeNull();
    expect(await store.questionAskedAt(TX, TASK)).toBeNull();
  });
});
