/**
 * The GitProvider contract against the in-memory fake (technical/10 contract tier).
 *
 * WP-09 adds a second runner for GitLab (gitlab.com and self-managed) in nock replay mode against
 * the same suite.
 */
import { createFakeGitProvider } from '@platform/integrations';
import {
  type GitProviderContractContext,
  runGitProviderContract,
} from '../support/integrations/git-provider-contract-suite.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a2';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b2';
const PROJECT = 'acme/api';
const FAILING_JOB = 'test:unit';

runGitProviderContract({
  name: 'in-memory fake',
  create: async (): Promise<GitProviderContractContext> => {
    const port = createFakeGitProvider({
      integrationId: INTEGRATION_ID,
      projects: [
        {
          path: PROJECT,
          defaultBranch: 'main',
          codeowners: '# owners\nsrc/billing/** @billing-team\n*.md @docs-team\n',
        },
      ],
    });

    // One merge request already exists, with a failed pipeline on its head commit: that is the
    // state the CI gate and the review loop actually start from.
    const existing = await port.openMergeRequest({
      project: PROJECT,
      branch: 'agentic/task-1',
      target: 'main',
      title: 'Draft: fix the totals',
      description: 'Requested by a human.',
      draft: true,
      labels: ['agentic'],
      reviewers: [],
      remove_source_branch: true,
    });
    port.setPipeline({
      project: PROJECT,
      headSha: existing.head_sha,
      status: 'failed',
      jobs: [
        { name: 'lint', status: 'success' },
        {
          name: FAILING_JOB,
          status: 'failed',
          log: 'FAIL src/billing/totals.test.ts\n  expected 42, received 41\n',
        },
      ],
      coveragePct: 81.5,
    });

    // Three more merge requests, one per mergeability state. The seeded `null` is the one the
    // rebase gate (WP-26) turns on, and the fake can only reach it through `setMergeability`.
    const openOn = async (branch: string) =>
      port.openMergeRequest({
        project: PROJECT,
        branch,
        target: 'main',
        title: `Draft: ${branch}`,
        description: '',
        draft: true,
        labels: [],
        reviewers: [],
        remove_source_branch: true,
      });
    const mergeable = await openOn('agentic/mergeable');
    const conflicted = await openOn('agentic/conflicted');
    const unknown = await openOn('agentic/unknown');
    port.setMergeability({
      project: PROJECT,
      iid: mergeable.ref.iid,
      mergeable: true,
      hasConflicts: false,
    });
    port.setMergeability({
      project: PROJECT,
      iid: conflicted.ref.iid,
      mergeable: false,
      hasConflicts: true,
    });
    port.setMergeability({
      project: PROJECT,
      iid: unknown.ref.iid,
      mergeable: null,
      hasConflicts: null,
    });

    // WP-37: the one handle this fake resolves. Everything else answers `null` (divergence 11).
    port.seedUser('@dana-reviewer', '4242');

    // WP-37 round 2, divergence 12: a `CODEOWNERS` that exists only on the branch under review —
    // the file a contributor can write, and the one routing must never read.
    port.seedFile({
      project: PROJECT,
      branch: 'agentic/task-1',
      path: 'CODEOWNERS',
      content: '# Owners on this branch only\nsrc/billing/** @branch-owner\n',
    });

    // WP-24: the diff `getMergeRequestDiff` answers, including the file the provider excluded —
    // divergence 10 says the fake holds no repository content, so a test that wants a diff seeds it.
    port.setDiff({
      project: PROJECT,
      iid: existing.ref.iid,
      files: [
        { path: 'src/billing/totals.ts' },
        { path: 'src/billing/totals.test.ts' },
        { path: 'assets/logo.bin', diff: null, omitted: true },
      ],
    });

    return {
      port,
      project: PROJECT,
      missingProject: 'acme/nope',
      branches: {
        source: 'agentic/task-2',
        target: 'main',
        // The fake protects the default branch and nothing else; `agentic/task-1` exists because
        // the merge request seeded above opened from it.
        protected: 'main',
        unprotected: 'agentic/task-1',
        missing: 'no/such-branch',
      },
      commit: {
        branch: 'agentic/knowledge/2026-09-12',
        path: '.agentic/knowledge/lessons/L-2026-09-12-locks.md',
      },
      mergeRequestIid: existing.ref.iid,
      missingMergeRequestIid: 4242,
      mergeability: {
        mergeable: mergeable.ref.iid,
        conflicted: conflicted.ref.iid,
        unknown: unknown.ref.iid,
      },
      diff: {
        iid: existing.ref.iid,
        path: 'src/billing/totals.ts',
        omittedPath: 'assets/logo.bin',
        fileCount: 3,
      },
      pipelineSha: existing.head_sha,
      failingJobName: FAILING_JOB,
      missingJobLogRef: 'log:does-not-exist',
      // The fake writes `rev-<n>`; this one is shaped like a handle it issues and was never
      // issued. (The fake identifies a credential by its value, so the foreign *value* the suite
      // sends is what it actually looks up — the shape is what the next provider needs.)
      foreignRevokeId: 'rev-4242',
      // WP-37, divergence 11: the fake knows what a test seeded and nothing else, so the unknown
      // handle needs no arrangement at all — which is the state a real `CODEOWNERS` is usually in.
      reviewer: {
        handle: '@dana-reviewer',
        externalId: '4242',
        unknownHandle: '@departed',
      },
      // The seed's file is the default branch's; the plant above is `agentic/task-1`'s.
      codeowners: {
        ref: 'main',
        owner: '@billing-team',
        otherRef: 'agentic/task-1',
        otherOwner: '@branch-owner',
      },
      emitMerged: () =>
        port.emitMergeRequestEvent({
          event: 'mr.merged',
          project: PROJECT,
          iid: existing.ref.iid,
        }),
      emitReviewComment: (text) =>
        port.emitReviewComment({
          project: PROJECT,
          iid: existing.ref.iid,
          discussionId: 'disc-seed',
          authorId: 'reviewer-1',
          text,
        }),
      emitPipelineFinished: () =>
        port.emitPipelineFinished({ project: PROJECT, headSha: existing.head_sha }),
      projectId: PROJECT_ID,
      integrationId: INTEGRATION_ID,
      cleanup: async () => {},
    };
  },
});
