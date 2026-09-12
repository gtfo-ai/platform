/**
 * GitLab REST payloads, validated at the ring edge (BD-022).
 *
 * Every schema here describes a *response*, so it is deliberately **non-strict**: `z.object`
 * strips unknown keys. That is the documented exception in CLAUDE.md ("opaque provider payloads"),
 * and it is the right direction for a provider that adds fields every release — a strict schema
 * would turn a new GitLab field into an outage. What is *named* here is checked, and a named field
 * of the wrong type is an `invalid_response` at `parseProviderData`, never an `undefined` three
 * layers up.
 *
 * Field lists are transcribed from the published documentation, retrieved 2026-09-10:
 *  - merge requests: <https://docs.gitlab.com/api/merge_requests/>
 *  - discussions:    <https://docs.gitlab.com/api/discussions/>
 *  - pipelines:      <https://docs.gitlab.com/api/pipelines/>
 *  - jobs:           <https://docs.gitlab.com/api/jobs/>
 *  - branches:       <https://docs.gitlab.com/api/branches/>
 *  - commits:        <https://docs.gitlab.com/api/commits/>
 *  - projects:       <https://docs.gitlab.com/api/projects/>
 *  - protected branches: <https://docs.gitlab.com/api/protected_branches/>
 *  - project access tokens: <https://docs.gitlab.com/api/project_access_tokens/>
 *  - version:        <https://docs.gitlab.com/api/version/>
 *  - webhook events: <https://docs.gitlab.com/user/project/integrations/webhook_events/>
 */
import * as z from 'zod';

/**
 * A coverage percentage.
 *
 * The documentation shows `"coverage": null` in every example and never states the non-null type,
 * so both forms GitLab is known to emit are accepted and normalised. Recorded as an **ambiguity**,
 * not as knowledge: no example in the published docs carries a non-null coverage value.
 */
export const gitlabCoverageSchema = z
  .union([z.number(), z.string(), z.null()])
  .transform((value) => {
    if (value === null) {
      return null;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      return null;
    }
    return parsed;
  });

/** `author`, `user`, `reviewers[]` — the same user object everywhere in the API. */
export const gitlabUserSchema = z.object({
  id: z.int(),
  username: z.string(),
  name: z.string().nullish(),
  state: z.string().nullish(),
  web_url: z.string().nullish(),
  email: z.string().nullish(),
  avatar_url: z.string().nullish(),
});

export const gitlabMergeStatusSchema = z.enum([
  'unchecked',
  'checking',
  'can_be_merged',
  'cannot_be_merged',
  'cannot_be_merged_recheck',
]);

/**
 * Every value `detailed_merge_status` may take, transcribed from
 * <https://docs.gitlab.com/api/merge_requests/#merge-status> on 2026-09-10.
 *
 * Kept as a plain string in the schema (see `gitlabMergeRequestSchema`) and matched against this
 * set in the mapping: GitLab adds a value here whenever it adds a merge check, and an enum would
 * make a new check an outage rather than a fallback.
 */
export const DETAILED_MERGE_STATUSES = [
  'approvals_syncing',
  'checking',
  'ci_must_pass',
  'ci_still_running',
  'commits_status',
  'conflict',
  'discussions_not_resolved',
  'draft_status',
  'jira_association_missing',
  'locked_lfs_files',
  'locked_paths',
  'merge_request_blocked',
  'merge_time',
  'mergeable',
  'need_rebase',
  'not_approved',
  'not_open',
  'preparing',
  'requested_changes',
  'security_policy_pipeline_check',
  'security_policy_violations',
  'status_checks_must_pass',
  'title_regex',
  'unchecked',
] as const;

export const gitlabMergeRequestSchema = z.object({
  id: z.int(),
  iid: z.int().positive(),
  project_id: z.int().nullish(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.enum(['opened', 'closed', 'merged', 'locked']),
  draft: z.boolean().nullish(),
  work_in_progress: z.boolean().nullish(),
  source_branch: z.string(),
  target_branch: z.string(),
  sha: z.string().nullish(),
  merge_status: gitlabMergeStatusSchema.nullish(),
  detailed_merge_status: z.string().nullish(),
  has_conflicts: z.boolean().nullish(),
  labels: z.array(z.string()).nullish(),
  author: gitlabUserSchema.nullish(),
  reviewers: z.array(gitlabUserSchema).nullish(),
  merged_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  changes_count: z.string().nullish(),
  user_notes_count: z.int().nullish(),
  web_url: z.string(),
  head_pipeline: z.object({ id: z.int(), coverage: gitlabCoverageSchema.nullish() }).nullish(),
  diff_refs: z
    .object({
      base_sha: z.string().nullish(),
      head_sha: z.string().nullish(),
      start_sha: z.string().nullish(),
    })
    .nullish(),
});

export type GitLabMergeRequest = z.output<typeof gitlabMergeRequestSchema>;

export const gitlabNoteSchema = z.object({
  id: z.int(),
  type: z.string().nullish(),
  body: z.string(),
  author: gitlabUserSchema,
  created_at: z.string(),
  updated_at: z.string().nullish(),
  system: z.boolean(),
  resolvable: z.boolean().nullish(),
  resolved: z.boolean().nullish(),
  position: z
    .object({
      new_path: z.string().nullish(),
      old_path: z.string().nullish(),
      new_line: z.int().nullish(),
      old_line: z.int().nullish(),
    })
    .nullish(),
});

export const gitlabDiscussionSchema = z.object({
  id: z.string(),
  individual_note: z.boolean().nullish(),
  notes: z.array(gitlabNoteSchema).nullish(),
});

export type GitLabDiscussion = z.output<typeof gitlabDiscussionSchema>;

/**
 * Pipeline and job statuses share one vocabulary
 * (<https://docs.gitlab.com/api/pipelines/>, <https://docs.gitlab.com/api/jobs/>).
 *
 * A plain string, not an enum, for the same reason as `detailed_merge_status`: `mapPipelineStatus`
 * refuses an unrecognised value loudly, which is a better failure than a schema error that hides
 * which field was new.
 */
export const gitlabPipelineSchema = z.object({
  id: z.int(),
  iid: z.int().nullish(),
  sha: z.string(),
  ref: z.string().nullish(),
  status: z.string(),
  source: z.string().nullish(),
  web_url: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  started_at: z.string().nullish(),
  finished_at: z.string().nullish(),
  coverage: gitlabCoverageSchema.nullish(),
});

export const gitlabJobSchema = z.object({
  id: z.int(),
  name: z.string(),
  stage: z.string().nullish(),
  status: z.string(),
  allow_failure: z.boolean().nullish(),
  coverage: gitlabCoverageSchema.nullish(),
  created_at: z.string().nullish(),
  started_at: z.string().nullish(),
  finished_at: z.string().nullish(),
  failure_reason: z.string().nullish(),
  web_url: z.string().nullish(),
});

export const gitlabBranchSchema = z.object({
  name: z.string(),
  merged: z.boolean().nullish(),
  protected: z.boolean(),
  default: z.boolean().nullish(),
  can_push: z.boolean().nullish(),
  web_url: z.string().nullish(),
  commit: z.object({
    id: z.string(),
    short_id: z.string().nullish(),
    title: z.string().nullish(),
    committed_date: z.string().nullish(),
  }),
});

/**
 * One commit, as `POST /projects/:id/repository/commits` answers (WP-18b).
 *
 * `id` is the sha the platform records on the proposal; `web_url` is what a maintainer follows. The
 * rest of the documented object — `stats`, `parent_ids`, the author/committer pairs — is not read
 * here, and an unread field is a field this adapter cannot get wrong.
 */
export const gitlabCommitSchema = z.object({
  id: z.string(),
  short_id: z.string().nullish(),
  title: z.string().nullish(),
  message: z.string().nullish(),
  web_url: z.string().nullish(),
});

export const gitlabProjectSchema = z.object({
  id: z.int(),
  path_with_namespace: z.string(),
  default_branch: z.string().nullish(),
  http_url_to_repo: z.string().nullish(),
  web_url: z.string(),
});

export const gitlabAccessLevelEntrySchema = z.object({
  id: z.int().nullish(),
  access_level: z.int().nullish(),
  access_level_description: z.string().nullish(),
  user_id: z.int().nullish(),
  group_id: z.int().nullish(),
});

export const gitlabProtectedBranchSchema = z.object({
  id: z.int().nullish(),
  name: z.string(),
  push_access_levels: z.array(gitlabAccessLevelEntrySchema).nullish(),
  merge_access_levels: z.array(gitlabAccessLevelEntrySchema).nullish(),
  allow_force_push: z.boolean().nullish(),
  code_owner_approval_required: z.boolean().nullish(),
});

/**
 * The create-token response. `token` is the one secret this whole module handles, so the schema
 * names it and nothing else ever puts the parsed object into a log line, an audit payload or an
 * error (BD-002, TD-012).
 */
export const gitlabAccessTokenSchema = z.object({
  id: z.int(),
  name: z.string(),
  scopes: z.array(z.string()),
  created_at: z.string().nullish(),
  expires_at: z.string().nullish(),
  active: z.boolean().nullish(),
  revoked: z.boolean().nullish(),
  access_level: z.int().nullish(),
  user_id: z.int().nullish(),
  token: z.string(),
});

export const gitlabVersionSchema = z.object({
  version: z.string(),
  revision: z.string().nullish(),
  enterprise: z.boolean().nullish(),
});

export type GitLabVersion = z.output<typeof gitlabVersionSchema>;
