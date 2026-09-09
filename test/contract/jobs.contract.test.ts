/**
 * The `Jobs` contract against the in-memory fake (technical/10 contract tier).
 *
 * Runs on every `pnpm run -s verify`: no Docker, no PostgreSQL, virtual clock, so a suite that
 * would take half a minute of real waiting finishes in milliseconds. The same assertions run
 * against pg-boss in `test/integration/jobs/pg-boss-jobs.integration.test.ts`.
 */
import { jobs } from '@platform/infrastructure';
import { type JobsContractContext, runJobsContract } from './support/jobs-contract-suite.js';

const WAIT_STEP_MS = 250;
const MAX_WAIT_STEPS = 400;

runJobsContract({
  name: 'in-memory fake',
  create: async (): Promise<JobsContractContext> => {
    const fake = jobs.createInMemoryJobs();

    return {
      runtime: fake,
      now: fake.now,
      elapse: (milliseconds) => fake.advance(milliseconds),
      waitFor: async (predicate, description) => {
        for (let step = 0; step < MAX_WAIT_STEPS; step += 1) {
          await fake.drain();
          if (predicate()) {
            return;
          }
          await fake.advance(WAIT_STEP_MS);
        }
        throw new Error(`timed out waiting for ${description}`);
      },
      // The virtual clock only moves in `advance` steps, so a timer can be observed at most one
      // step late. Nothing here is subject to scheduler jitter.
      timerToleranceMs: WAIT_STEP_MS,
      pollingIntervalSeconds: 0.5,
      cleanup: async () => {},
    };
  },
});
