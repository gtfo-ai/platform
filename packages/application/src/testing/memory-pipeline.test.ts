/**
 * The in-memory `PipelineStore`'s own divergences.
 *
 * Its *behaviour* is asserted by the shared contract suite, which runs against PostgreSQL as well
 * (`test/contract/pipeline-store.contract.test.ts`). What is left here is the register: standing
 * rule 12 says the kindest divergence needs a positive assertion rather than a warning, so the one
 * that matters — no transaction isolation — is asserted as a fact of this store.
 */
import { FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { StoredTask } from '../pipeline/store.js';
import { createMemoryPipelineStore } from './memory-pipeline.js';

const TX = { adapter: 'memory' } as never;
const PROJECT = '00000000-0000-4000-8000-0000000000b1';

const task = (id: string, key = 'ACME-1'): StoredTask => ({
  task: {
    id,
    projectId: PROJECT,
    ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/${key}` },
    template: 'feature',
    mode: 'normal',
    state: 'queued',
    currentStage: null,
    stageAttempts: {},
    iterationCounters: {},
    limits: {
      code_review: 3,
      business_review: 2,
      ci_fix: 3,
      human_rounds: 3,
      refinement_questions: 2,
      architecture_revisions: 2,
      rebase: 2,
    },
    sequence: 1,
  },
  template: FEATURE_TEMPLATE,
  priorityRank: 2,
  createdAt: '2026-06-01T09:00:00.000Z',
  branch: null,
  mr: null,
  workpad: null,
  costActualUsd: 0,
  estimateUsd: null,
});

describe('the divergence register', () => {
  it('keeps writes a "rolled-back" scope made, which PostgreSQL does not (divergence 4)', async () => {
    // The kindest divergence, asserted rather than warned about: the `Transaction` handle is
    // accepted and ignored, so nothing here can model a rollback. It is why the same contract suite
    // runs against a real database, and why the e2e tier does not use this store.
    const store = createMemoryPipelineStore();
    const stored = task('00000000-0000-4000-8000-000000000001');
    await store.tasks.insert(TX, stored);
    await store.tasks.insert(
      { adapter: 'another-transaction' } as never,
      task('00000000-0000-4000-8000-000000000002', 'ACME-2'),
    );
    // Two "transactions", one store, and no isolation between them.
    expect(store.snapshot()).toHaveLength(2);
  });

  it('refuses a duplicate ticket the way the unique index does (divergence 1)', async () => {
    const store = createMemoryPipelineStore();
    await store.tasks.insert(TX, task('00000000-0000-4000-8000-000000000001'));
    await expect(
      store.tasks.insert(TX, task('00000000-0000-4000-8000-000000000003')),
    ).rejects.toThrow(/already exists/);
  });

  it('hands out clones, so a caller mutating what it read cannot change the store (divergence 3)', async () => {
    const store = createMemoryPipelineStore();
    const stored = task('00000000-0000-4000-8000-000000000001');
    await store.tasks.insert(TX, stored);
    const loaded = await store.tasks.load(TX, stored.task.id);
    (loaded as { costActualUsd: number }).costActualUsd = 99;
    expect((await store.tasks.load(TX, stored.task.id))?.costActualUsd).toBe(0);
  });
});
