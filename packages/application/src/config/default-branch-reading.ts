/**
 * **What a change of the default branch reads at once** — WP-147, PROGRESS backlog 442.
 *
 * The change command (`PUT /api/projects/:id/default-branch`) marks the old branch's configuration
 * reading `invalid` in its own transaction (so runs wait for this reading) and, after it commits, asks for a knowledge index of the new
 * branch (WP-142). The index run would also re-read `.agentic/config.yml` and wake a readiness
 * re-check — but only when it runs, which is a queue away. This is the part that does not wait:
 *
 *  1. the repository configuration is read from the stored (new) branch's head and recorded
 *     ({@link refreshRepositoryConfig}, the same producer the index run and `POST …/config/refresh`
 *     use, outside any transaction);
 *  2. a readiness re-check is enqueued **pinned to the commit that reading answered**, so the
 *     re-check reads the new branch's files (R8, R10, R13 and the CI-rules notice) at the commit the
 *     configuration describes. A project nobody evaluated skips it by name in the job.
 *
 * A reading that recorded nothing (an unreachable mirror) requests no re-check: there is no commit
 * of the new branch to pin it to, and the index run's own re-check follows its first read.
 */
import type { Id } from '@platform/contracts';
import { enqueueReadinessRecheck } from '../onboarding/recheck.js';
import type { Jobs } from '../ports/jobs.js';
import type { RepositoryConfigRefresh } from './repository-config.js';

export interface DefaultBranchReading {
  readonly config: RepositoryConfigRefresh['status'];
  /** The commit the configuration was read at, or `null` when nothing was recorded. */
  readonly commitSha: string | null;
  /** Whether a readiness re-check pinned to {@link commitSha} was enqueued. */
  readonly recheckRequested: boolean;
}

export const readNewDefaultBranch = async (
  options: {
    readonly refresh: (request: { readonly projectId: Id }) => Promise<RepositoryConfigRefresh>;
    /** `null` on a process that holds no job client: the reading is still recorded. */
    readonly jobs: Jobs | null;
  },
  projectId: Id,
): Promise<DefaultBranchReading> => {
  const config = await options.refresh({ projectId });
  const commitSha = config.status === 'recorded' ? config.snapshot.commitSha : null;
  if (commitSha === null || options.jobs === null) {
    return { config: config.status, commitSha, recheckRequested: false };
  }
  await enqueueReadinessRecheck(options.jobs, { projectId, commitSha });
  return { config: config.status, commitSha, recheckRequested: true };
};
