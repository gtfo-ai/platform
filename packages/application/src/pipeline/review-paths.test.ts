/**
 * `reviewedMergeRequestPaths`' one error it must never absorb (WP-105, PROGRESS backlog 303).
 *
 * The read fails open for a provider — a Reviewer run matches its checklists on the plan alone and
 * says so — but `TransactionOpenError` is not a provider: it is a change that moved the call inside
 * a transaction. Until WP-105 the blanket `catch` answered `undefined` for it with a `warn` line, so
 * the guard still stopped the provider call and the signal that somebody moved it was lost. The
 * shape is `ticket-snapshot.ts`'s and `observability-prefetch.ts`'s, whose tests hold the same
 * property. The rest of the function is exercised through the pipeline harness in `saga.test.ts`
 * (*"the first review’s checklist reads the merge request (backlog 218)"*).
 */
import type { Id } from '@platform/contracts';
import type { PipelineStage } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { TransactionOpenError, withOpenTransaction } from '../events/open-transaction.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { PipelineIntegrationsPort } from './integrations.js';
import { reviewedMergeRequestPaths } from './review-paths.js';
import type { StoredTask } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;

const stored = {
  task: { id: TASK, projectId: PROJECT },
  mr: {
    provider: 'fake-git',
    project_path: 'acme/api',
    iid: 7,
    url: 'https://git.example.test/acme/api/-/merge_requests/7',
    branch: 'agentic/acme-1',
    head_sha: 'b'.repeat(40),
  },
  reviewSubject: null,
} as unknown as StoredTask;
const codeReview = { id: 'code_review', kind: 'agent', role: 'reviewer' } as PipelineStage;

/** A port whose every resolution fails the way a provider or a binding does. */
const failing = (error: Error): PipelineIntegrationsPort =>
  ({
    forProject: async () => {
      throw error;
    },
  }) as unknown as PipelineIntegrationsPort;

const world = (integrations: PipelineIntegrationsPort) => {
  const warnings: unknown[] = [];
  const logger: Logger = {
    ...silentLogger,
    warn: (fields: unknown) => {
      warnings.push(fields);
    },
  } as Logger;
  return {
    warnings,
    run: () =>
      reviewedMergeRequestPaths(
        { integrations, clock: { now: () => '2026-06-01T09:00:00.000Z' }, logger },
        stored,
        codeReview,
      ),
  };
};

describe('reviewedMergeRequestPaths when the read cannot be made', () => {
  it('answers undefined for a provider or a binding that fails, and says so at warn', async () => {
    const probe = world(failing(new Error('the credential will not decrypt')));
    await expect(probe.run()).resolves.toBeUndefined();
    expect(probe.warnings).toHaveLength(1);
  });

  it('rethrows TransactionOpenError — a moved call, never a provider being down (backlog 303)', async () => {
    const probe = world(failing(new Error('never reached: the guard throws first')));
    await expect(withOpenTransaction(() => probe.run())).rejects.toBeInstanceOf(
      TransactionOpenError,
    );
    // Nothing was logged as a provider failure: the error is the caller's to see.
    expect(probe.warnings).toEqual([]);
  });
});
