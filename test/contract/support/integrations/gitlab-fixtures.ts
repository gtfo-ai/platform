/**
 * The constants and the signed webhook envelopes the GitLab replay runs share.
 *
 * Every value here is obviously fake (BD-002, standing rule 5): the host is `.test`, the project is
 * `acme/api`, the tokens say what they are, and the minted token in `test/fixtures/http/gitlab`
 * is shaped like nothing GitLab issues so that no scanner can mistake a fixture for a credential.
 *
 * The delivery builders matter as much as the fixtures. Rule 4 says a rejection assertion is worth
 * nothing until the harness has been shown to build an *accepted* delivery, so both schemes are
 * built here and the first thing every negative test does is mutate a delivery that was just
 * proven to verify.
 */
import { createHmac } from 'node:crypto';
import type { WebhookDelivery } from '@platform/application';

export const GITLAB_HOST = 'https://gitlab.example.test';
export const GITLAB_PROJECT = 'acme/api';
export const GITLAB_WEB = `${GITLAB_HOST}/acme/api`;

/** Obviously fake. The legacy `X-Gitlab-Token` value. */
export const FAKE_SECRET_TOKEN = 'fake-gitlab-webhook-secret-token-do-not-use';
/**
 * Obviously fake. Built at run time rather than written as a base64 literal: a `whsec_`-prefixed
 * base64 string has the entropy of a real signing token, and gitleaks flags it as one — a fixture
 * that trips the repository's own secret scanner is a fixture nobody can commit (BD-002).
 */
export const FAKE_SIGNING_TOKEN = `whsec_${Buffer.from(
  'fake-gitlab-signing-key-do-not-use',
).toString('base64')}`;

export const SHA_MAIN = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const SHA_MR7 = '1111111111111111111111111111111111111111';
export const SHA_MERGE_COMMIT = '5555555555555555555555555555555555555555';
export const MR_IID = 7;
export const MISSING_MR_IID = 4242;
export const MERGEABLE_IID = 11;
export const CONFLICTED_IID = 12;
export const UNKNOWN_IID = 13;
export const FAILING_JOB = 'test:unit';
export const MISSING_JOB_LOG_REF = '999999';
/**
 * The access token id in `access-tokens.json` whose `DELETE` is a recorded `404`, and which this
 * provider never minted.
 *
 * It is the pair to token 58, the one the recorded mint issues: a `404` for 58 means "already
 * gone", because this provider minted it at that address; a `404` for this one cannot be told from
 * "never existed here", so the adapter refuses to report a revocation instead of absorbing it
 * (WP-09 review round 1).
 */
export const FOREIGN_TOKEN_ID = 59;
export const HUMAN_NOTE_ID = 1126;

/** The instant every replay run's clock is fixed at. */
export const CLOCK_AT = '2026-06-01T08:00:00.000Z';

const projectBlock = {
  id: 15513260,
  name: 'api',
  web_url: GITLAB_WEB,
  path_with_namespace: GITLAB_PROJECT,
  default_branch: 'main',
  git_http_url: `${GITLAB_WEB}.git`,
  namespace: 'acme',
  visibility_level: 0,
};

const humanUser = {
  id: 77,
  name: 'Dana Reviewer',
  username: 'dana.reviewer',
  email: 'dana.reviewer@example.test',
  avatar_url: null,
};

/** `X-Gitlab-Event: Merge Request Hook`, action `merge`. */
export const mergedHookBody = (): string =>
  JSON.stringify({
    object_kind: 'merge_request',
    event_type: 'merge_request',
    user: humanUser,
    project: projectBlock,
    labels: [{ id: 19, title: 'agentic', color: '#adb21a' }],
    object_attributes: {
      id: 155016007,
      iid: MR_IID,
      title: 'fix the totals',
      description: 'Ready for merge.',
      source_branch: 'agentic/task-1',
      target_branch: 'main',
      state: 'merged',
      action: 'merge',
      draft: false,
      merge_status: 'can_be_merged',
      detailed_merge_status: 'not_open',
      merge_commit_sha: SHA_MERGE_COMMIT,
      updated_at: '2026-06-01T07:59:00.000Z',
      url: `${GITLAB_WEB}/-/merge_requests/${MR_IID}`,
      last_commit: { id: SHA_MR7, message: 'Fix the totals\n' },
    },
  });

/** `X-Gitlab-Event: Note Hook` on a merge request. */
export const reviewCommentHookBody = (text: string): string =>
  JSON.stringify({
    object_kind: 'note',
    event_type: 'note',
    user: humanUser,
    project_id: projectBlock.id,
    project: projectBlock,
    object_attributes: {
      id: HUMAN_NOTE_ID,
      internal: false,
      note: text,
      noteable_type: 'MergeRequest',
      author_id: humanUser.id,
      created_at: '2026-06-01 07:30:00 UTC',
      updated_at: '2026-06-01 07:30:00 UTC',
      project_id: projectBlock.id,
      attachment: null,
      line_code: null,
      commit_id: '',
      noteable_id: 155016007,
      system: false,
      st_diff: null,
      action: 'create',
      url: `${GITLAB_WEB}/-/merge_requests/${MR_IID}#note_${HUMAN_NOTE_ID}`,
    },
    merge_request: {
      id: 155016007,
      iid: MR_IID,
      title: 'Draft: fix the totals',
      state: 'opened',
      source_branch: 'agentic/task-1',
      target_branch: 'main',
      last_commit: { id: SHA_MR7 },
    },
  });

/** `X-Gitlab-Event: Pipeline Hook`, a finished failed pipeline. */
export const pipelineHookBody = (): string =>
  JSON.stringify({
    object_kind: 'pipeline',
    project: projectBlock,
    object_attributes: {
      id: 900,
      iid: 12,
      name: 'Pipeline for branch: agentic/task-1',
      ref: 'agentic/task-1',
      tag: false,
      sha: SHA_MR7,
      source: 'merge_request_event',
      status: 'failed',
      detailed_status: 'failed',
      stages: ['test'],
      created_at: '2026-06-01 07:10:00 UTC',
      finished_at: '2026-06-01 07:12:00 UTC',
      duration: 100,
      url: `${GITLAB_WEB}/-/pipelines/900`,
    },
    merge_request: {
      id: 155016007,
      iid: MR_IID,
      title: 'Draft: fix the totals',
      source_branch: 'agentic/task-1',
      target_branch: 'main',
      state: 'opened',
      url: `${GITLAB_WEB}/-/merge_requests/${MR_IID}`,
    },
    builds: [
      { id: 9001, stage: 'test', name: 'lint', status: 'success', allow_failure: false },
      { id: 9002, stage: 'test', name: FAILING_JOB, status: 'failed', allow_failure: false },
      { id: 9003, stage: 'test', name: 'flaky', status: 'failed', allow_failure: true },
    ],
  });

/** `X-Gitlab-Event: Push Hook` onto the default branch. */
export const pushHookBody = (ref = 'refs/heads/main', after = SHA_MAIN): string =>
  JSON.stringify({
    object_kind: 'push',
    event_name: 'push',
    before: SHA_MR7,
    after,
    ref,
    checkout_sha: after,
    user_id: humanUser.id,
    user_name: humanUser.name,
    project_id: projectBlock.id,
    project: projectBlock,
    commits: [],
    total_commits_count: 1,
  });

const baseHeaders = (event: string): Record<string, string> => ({
  'content-type': 'application/json',
  'user-agent': 'GitLab/18.1.1-ee',
  'x-gitlab-event': event,
  'x-gitlab-event-uuid': '13792a34-cac6-4fda-95a8-c58e00a3954e',
  'x-gitlab-instance': GITLAB_HOST,
  'x-gitlab-webhook-uuid': '02affd2d-2cba-4033-917d-ec22d5dc4b38',
});

/**
 * The legacy scheme: the secret in plain text in `X-Gitlab-Token`
 * (<https://docs.gitlab.com/user/project/integrations/webhooks/>, retrieved 2026-09-10).
 */
export const legacyDelivery = (
  event: string,
  body: string,
  token = FAKE_SECRET_TOKEN,
): WebhookDelivery => ({
  headers: { ...baseHeaders(event), 'x-gitlab-token': token },
  body,
});

/**
 * Standard Webhooks, exactly as documented: `webhook-id`, `webhook-timestamp` (Unix seconds) and
 * `webhook-signature` = `v1,{base64 HMAC-SHA256 over "{id}.{timestamp}.{body}"}`, with the signing
 * token's `whsec_` prefix stripped and the remainder base64-decoded to get the key.
 */
export const signedDelivery = (
  event: string,
  body: string,
  options: {
    readonly at?: string;
    readonly messageId?: string;
    readonly signingToken?: string;
    readonly extraSignatures?: readonly string[];
  } = {},
): WebhookDelivery => {
  const messageId = options.messageId ?? 'f5e5f430-f57b-4e6e-9fac-d9128cd7232f';
  const timestamp = String(Math.floor(Date.parse(options.at ?? CLOCK_AT) / 1000));
  const key = Buffer.from(
    (options.signingToken ?? FAKE_SIGNING_TOKEN).replace(/^whsec_/, ''),
    'base64',
  );
  const signature = `v1,${createHmac('sha256', key)
    .update(`${messageId}.${timestamp}.${body}`, 'utf8')
    .digest('base64')}`;
  return {
    headers: {
      ...baseHeaders(event),
      'idempotency-key': messageId,
      'webhook-id': messageId,
      'webhook-timestamp': timestamp,
      'webhook-signature': [...(options.extraSignatures ?? []), signature].join(' '),
    },
    body,
  };
};
