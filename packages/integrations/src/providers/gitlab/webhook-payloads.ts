/**
 * The webhook payload shapes, transcribed from the published examples in
 * <https://docs.gitlab.com/user/project/integrations/webhook_events/> (retrieved 2026-09-10) and,
 * for the merge-request `object_attributes` table, from the same page's "`object_attributes`
 * field" section.
 *
 * Non-strict for the same reason as `schemas.ts`: a GitLab release adds fields to these payloads
 * (`object_attributes.merged_at` arrived in 19.1, `target_branch_protected` in 19.2), and a strict
 * schema would make every such release a rejected delivery.
 *
 * One documented **absence** shapes the note handling and is recorded here because a later reader
 * will otherwise assume it was overlooked: the published "Comment on a merge request" payload has
 * **no `discussion_id`** and **no `resolved_at`** in `object_attributes`. A thread id is therefore
 * not derivable from the delivery, and `inbound.ts` looks it up rather than inventing one — an
 * invented `note-<id>` would satisfy `mr.review.comment`'s schema and then fail the first time
 * WP-15 replied to it.
 */
import * as z from 'zod';

const webhookUser = z.object({
  id: z.int(),
  name: z.string().nullish(),
  username: z.string().nullish(),
  email: z.string().nullish(),
});

const webhookProject = z.object({
  id: z.int(),
  path_with_namespace: z.string().nullish(),
  web_url: z.string().nullish(),
  default_branch: z.string().nullish(),
});

const webhookLabel = z.object({ title: z.string().nullish() });

export const mergeRequestHookSchema = z.object({
  object_kind: z.literal('merge_request'),
  user: webhookUser.nullish(),
  project: webhookProject.nullish(),
  labels: z.array(webhookLabel).nullish(),
  object_attributes: z.object({
    id: z.int(),
    iid: z.int().positive(),
    action: z.string().nullish(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    state: z.string().nullish(),
    draft: z.boolean().nullish(),
    work_in_progress: z.boolean().nullish(),
    source_branch: z.string().nullish(),
    target_branch: z.string().nullish(),
    merge_status: z.string().nullish(),
    detailed_merge_status: z.string().nullish(),
    merge_commit_sha: z.string().nullish(),
    updated_at: z.string().nullish(),
    url: z.string().nullish(),
    last_commit: z.object({ id: z.string() }).nullish(),
  }),
});

export const noteHookSchema = z.object({
  object_kind: z.literal('note'),
  user: webhookUser,
  project: webhookProject.nullish(),
  object_attributes: z.object({
    id: z.int(),
    note: z.string(),
    noteable_type: z.string(),
    noteable_id: z.int().nullish(),
    author_id: z.int().nullish(),
    system: z.boolean().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    url: z.string().nullish(),
    /** Undocumented in the published example; parsed when an instance sends it, never required. */
    discussion_id: z.string().nullish(),
  }),
  merge_request: z
    .object({
      id: z.int().nullish(),
      iid: z.int().positive(),
      title: z.string().nullish(),
      state: z.string().nullish(),
      source_branch: z.string().nullish(),
      target_branch: z.string().nullish(),
      last_commit: z.object({ id: z.string() }).nullish(),
    })
    .nullish(),
});

export const pipelineHookSchema = z.object({
  object_kind: z.literal('pipeline'),
  project: webhookProject.nullish(),
  object_attributes: z.object({
    id: z.int(),
    iid: z.int().nullish(),
    ref: z.string().nullish(),
    sha: z.string(),
    status: z.string(),
    created_at: z.string().nullish(),
    finished_at: z.string().nullish(),
    url: z.string().nullish(),
  }),
  merge_request: z
    .object({
      id: z.int().nullish(),
      iid: z.int().positive(),
      source_branch: z.string().nullish(),
      target_branch: z.string().nullish(),
      url: z.string().nullish(),
    })
    .nullish(),
  builds: z
    .array(
      z.object({
        id: z.int(),
        name: z.string(),
        stage: z.string().nullish(),
        status: z.string(),
        allow_failure: z.boolean().nullish(),
      }),
    )
    .nullish(),
});

export const pushHookSchema = z.object({
  object_kind: z.literal('push'),
  ref: z.string(),
  before: z.string().nullish(),
  after: z.string(),
  checkout_sha: z.string().nullish(),
  project: webhookProject.nullish(),
});

export const gitlabHookSchema = z.discriminatedUnion('object_kind', [
  mergeRequestHookSchema,
  noteHookSchema,
  pipelineHookSchema,
  pushHookSchema,
]);

export type GitLabHook = z.output<typeof gitlabHookSchema>;
export type MergeRequestHook = z.output<typeof mergeRequestHookSchema>;
export type NoteHook = z.output<typeof noteHookSchema>;
export type PipelineHook = z.output<typeof pipelineHookSchema>;
export type PushHook = z.output<typeof pushHookSchema>;
