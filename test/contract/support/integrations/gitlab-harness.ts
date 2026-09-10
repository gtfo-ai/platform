/**
 * One GitLab adapter wired to the recorded fixtures, shared by the contract runner and the
 * executor composition test.
 *
 * It lives beside the suites rather than inside a test file so that importing it does not register
 * somebody else's `describe` blocks.
 */
import { exactSecretRedactor } from '@platform/application';
import { fixedClock } from '@platform/domain';
import {
  createGitLabProvider,
  type GitLabProvider,
  gitlabConfigSchema,
} from '@platform/integrations';
import type { GitProviderContractContext } from './git-provider-contract-suite.js';
import {
  CLOCK_AT,
  CONFLICTED_IID,
  FAILING_JOB,
  FAKE_SECRET_TOKEN,
  FAKE_SIGNING_TOKEN,
  FOREIGN_TOKEN_ID,
  GITLAB_HOST,
  GITLAB_PROJECT,
  MERGEABLE_IID,
  MISSING_JOB_LOG_REF,
  MISSING_MR_IID,
  MR_IID,
  mergedHookBody,
  pipelineHookBody,
  reviewCommentHookBody,
  SHA_MR7,
  signedDelivery,
  UNKNOWN_IID,
} from './gitlab-fixtures.js';
import {
  createGitLabReplay,
  type GitLabReplay,
  loadReplayFixture,
  replayFixtureNames,
} from './gitlab-replay.js';

export const GITLAB_INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a9';
export const GITLAB_PROJECT_ID = '00000000-0000-4000-8000-0000000000b9';

/** Obviously fake: the binding's API token, shaped like nothing GitLab issues (BD-002). */
export const FAKE_BINDING_TOKEN = 'FAKE-binding-api-token-DO-NOT-USE';

export interface GitLabReplayContext extends GitProviderContractContext {
  readonly replay: GitLabReplay;
  /**
   * The same adapter under GitLab's own port. `GitProviderContractContext.port` is the type port,
   * which is the point of the shared suite; the extras BD-017 lets a provider add — the
   * protected-branch checks that compensate for Q40 — are only visible through this one.
   */
  readonly gitlab: GitLabProvider;
}

export const gitlabReplayContext = (
  overrides: { readonly mintCredentials?: boolean } = {},
): GitLabReplayContext => {
  // Every fixture file on disk, not a list somebody has to remember to extend (rule 7): a file
  // this list forgot would be a recorded interaction `unusedFixtures()` never even loads.
  const replay = createGitLabReplay(
    replayFixtureNames().flatMap((name) => loadReplayFixture(name)),
  );
  const port = createGitLabProvider({
    integrationId: GITLAB_INTEGRATION_ID,
    config: gitlabConfigSchema.parse({
      base_url: GITLAB_HOST,
      project: GITLAB_PROJECT,
      mint_credentials: overrides.mintCredentials ?? true,
      // No network, so no timeout timer either: a wall-clock timer in a replay run is a hardware
      // dependency with nothing to guard.
      request_timeout_ms: 0,
    }),
    secrets: {
      token: FAKE_BINDING_TOKEN,
      webhook_secret_token: FAKE_SECRET_TOKEN,
      webhook_signing_token: FAKE_SIGNING_TOKEN,
    },
    fetchImpl: replay.fetchImpl,
    clock: fixedClock(CLOCK_AT),
    // Required since WP-11 (standing rule 31): the binding's own credentials are what this suite
    // is about, and the composition root is where they become a redactor.
    redactor: exactSecretRedactor([
      { name: 'gitlab_token', value: FAKE_BINDING_TOKEN },
      { name: 'gitlab_webhook_secret_token', value: FAKE_SECRET_TOKEN },
      { name: 'gitlab_webhook_signing_token', value: FAKE_SIGNING_TOKEN },
    ]),
  });

  return {
    replay,
    port,
    gitlab: port,
    project: GITLAB_PROJECT,
    missingProject: 'acme/nope',
    branches: { source: 'agentic/task-2', target: 'main' },
    mergeRequestIid: MR_IID,
    missingMergeRequestIid: MISSING_MR_IID,
    mergeability: {
      mergeable: MERGEABLE_IID,
      conflicted: CONFLICTED_IID,
      unknown: UNKNOWN_IID,
    },
    pipelineSha: SHA_MR7,
    failingJobName: FAILING_JOB,
    // Provider-shaped: GitLab's log handle is the numeric job id, not the fake's `log:<id>`.
    missingJobLogRef: MISSING_JOB_LOG_REF,
    // GitLab's handle is the whole revocation address, `<project>#<token_id>`. Token 59 is the
    // recorded 404 in `access-tokens.json`: a legible address this provider never minted at, so
    // the DELETE goes out and its 404 is ambiguous. A random string here would earn
    // `invalid_request` instead and fail the suite case, which is what makes it a real assertion.
    foreignRevokeId: `${GITLAB_PROJECT}#${FOREIGN_TOKEN_ID}`,
    emitMerged: () => signedDelivery('Merge Request Hook', mergedHookBody()),
    emitReviewComment: (text) => signedDelivery('Note Hook', reviewCommentHookBody(text)),
    emitPipelineFinished: () => signedDelivery('Pipeline Hook', pipelineHookBody()),
    projectId: GITLAB_PROJECT_ID,
    integrationId: GITLAB_INTEGRATION_ID,
    cleanup: async () => {},
  };
};
