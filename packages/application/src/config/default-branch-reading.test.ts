import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { JOB_QUEUES, type Jobs } from '../ports/jobs.js';
import { readNewDefaultBranch } from './default-branch-reading.js';
import type { RepositoryConfigRefresh } from './repository-config.js';

const PROJECT = '00000000-0000-4000-8000-0000000000e1' as Id;
const MAIN_HEAD = 'a'.repeat(40);

const recorded: RepositoryConfigRefresh = {
  status: 'recorded',
  snapshot: {
    status: 'absent',
    commitSha: MAIN_HEAD,
    readAt: '2026-10-05T00:00:00.000Z' as IsoDateTime,
  } as never,
  promptsWithheld: null,
};

const jobsCapturing = () => {
  const enqueued: unknown[] = [];
  const jobs = {
    enqueue: async (request: unknown) => {
      enqueued.push(request);
      return { status: 'enqueued', jobId: 'job-1' };
    },
  } as unknown as Jobs;
  return { jobs, enqueued };
};

describe('readNewDefaultBranch (WP-147, backlog 442)', () => {
  it('reads the configuration and pins a readiness re-check to the commit that reading answered', async () => {
    const { jobs, enqueued } = jobsCapturing();
    const asked: unknown[] = [];
    const reading = await readNewDefaultBranch(
      {
        refresh: async (request) => {
          asked.push(request);
          return recorded;
        },
        jobs,
      },
      PROJECT,
    );
    expect(asked).toEqual([{ projectId: PROJECT }]);
    expect(reading).toEqual({ config: 'recorded', commitSha: MAIN_HEAD, recheckRequested: true });
    expect(enqueued).toEqual([
      {
        queue: JOB_QUEUES.discoveryRecord,
        data: { kind: 'readiness_recheck', project_id: PROJECT, commit_sha: MAIN_HEAD },
      },
    ]);
  });

  it('requests no re-check when nothing was recorded, or when the process holds no job client', async () => {
    const { jobs, enqueued } = jobsCapturing();
    expect(
      await readNewDefaultBranch(
        {
          refresh: async () => ({ status: 'unavailable', reason: 'the mirror is unreachable' }),
          jobs,
        },
        PROJECT,
      ),
    ).toEqual({ config: 'unavailable', commitSha: null, recheckRequested: false });
    expect(enqueued).toEqual([]);
    expect(
      await readNewDefaultBranch({ refresh: async () => recorded, jobs: null }, PROJECT),
    ).toEqual({ config: 'recorded', commitSha: MAIN_HEAD, recheckRequested: false });
  });
});
