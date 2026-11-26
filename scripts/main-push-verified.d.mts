/** Types for `main-push-verified.mjs`, which stays plain JavaScript so a job runs it with no install. */
export declare const decide: (input: {
  event: string;
  ref: string;
  sha: string;
  forced: boolean;
  after: string | undefined;
  workflow: string;
  runs: unknown[];
  pulls: unknown[];
  jobs: unknown[];
}) => { verified: boolean; reason: string };
export declare const TREE_STEP: string;
export declare const newestRun: (runs: unknown[], sha: string, workflow: string) => unknown;
