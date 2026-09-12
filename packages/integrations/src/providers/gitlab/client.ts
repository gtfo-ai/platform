/**
 * The typed GitLab endpoints this platform uses — nineteen of them, which is the whole point of a
 * thin client (TD-024: "covering only the endpoints the type contracts need").
 *
 * Each method does exactly two things: build one documented request, and parse the answer through
 * `parseProviderData` so an unexpected shape is an `invalid_response` at the ring edge rather than
 * an `undefined` in the pipeline (BD-022). No method retries, sleeps or looks at a clock.
 *
 * Endpoint documentation, all retrieved 2026-09-10, is cited at each method.
 */
import { parseProviderData } from '@platform/application';
import * as z from 'zod';
import { encodeProjectId, type GitLabHttp } from './http.js';
import {
  gitlabAccessTokenSchema,
  gitlabBranchSchema,
  gitlabCommitSchema,
  gitlabDiscussionSchema,
  gitlabJobSchema,
  gitlabMergeRequestSchema,
  gitlabPipelineSchema,
  gitlabProjectSchema,
  gitlabProtectedBranchSchema,
  gitlabVersionSchema,
} from './schemas.js';

const parse = <TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  action: string,
): z.output<TSchema> =>
  parseProviderData(schema, value, { provider: 'gitlab', action }) as z.output<TSchema>;

export interface CreateMergeRequestBody {
  readonly source_branch: string;
  readonly target_branch: string;
  readonly title: string;
  readonly description: string;
  readonly labels?: string;
  readonly reviewer_ids?: number[];
  readonly remove_source_branch: boolean;
}

export interface UpdateMergeRequestBody {
  readonly title?: string;
  readonly description?: string;
  readonly labels?: string;
  readonly reviewer_ids?: number[];
}

export interface DiffNotePosition {
  readonly base_sha: string;
  readonly head_sha: string;
  readonly start_sha: string;
  readonly position_type: 'text';
  readonly new_path: string;
  readonly old_path: string;
  readonly new_line: number;
}

/**
 * The body of § "Create a commit with multiple files and actions", in the subset the platform sends.
 *
 * `start_branch` is documented as "Name of the branch to use as the parent for the new commit"; the
 * platform passes it only when it wants the branch created. `encoding` is left at its `text`
 * default: a knowledge page is UTF-8 Markdown.
 */
export interface CreateCommitBody {
  readonly branch: string;
  readonly commit_message: string;
  readonly start_branch?: string;
  readonly author_name?: string;
  readonly author_email?: string;
  readonly actions: readonly {
    readonly action: 'create' | 'update';
    readonly file_path: string;
    readonly content: string;
  }[];
}

export interface GitLabClient {
  /** <https://docs.gitlab.com/api/version/> — the read-only probe behind `testConnection`. */
  version(): Promise<z.output<typeof gitlabVersionSchema>>;
  /** <https://docs.gitlab.com/api/projects/> § "Retrieve a project". */
  project(project: string): Promise<z.output<typeof gitlabProjectSchema>>;
  /** <https://docs.gitlab.com/api/branches/> § "Retrieve a repository branch". */
  branch(project: string, branch: string): Promise<z.output<typeof gitlabBranchSchema>>;
  /** <https://docs.gitlab.com/api/protected_branches/> § "Retrieve a protected branch …". */
  protectedBranch(
    project: string,
    branch: string,
  ): Promise<z.output<typeof gitlabProtectedBranchSchema> | null>;
  /**
   * <https://docs.gitlab.com/api/commits/> § "Create a commit with multiple files and actions".
   *
   * One request, one commit, every action or none — which is what lets the caller treat a knowledge
   * commit as atomic.
   */
  createCommit(
    project: string,
    body: CreateCommitBody,
  ): Promise<z.output<typeof gitlabCommitSchema>>;
  /** <https://docs.gitlab.com/api/merge_requests/> § "Create a merge request". */
  createMergeRequest(
    project: string,
    body: CreateMergeRequestBody,
  ): Promise<z.output<typeof gitlabMergeRequestSchema>>;
  /** § "Update a merge request". */
  updateMergeRequest(
    project: string,
    iid: number,
    body: UpdateMergeRequestBody,
  ): Promise<z.output<typeof gitlabMergeRequestSchema>>;
  /** § "Retrieve a merge request". */
  mergeRequest(project: string, iid: number): Promise<z.output<typeof gitlabMergeRequestSchema>>;
  /** § "List project merge requests". */
  listMergeRequests(
    project: string,
    query: Readonly<Record<string, string | number>>,
  ): Promise<z.output<typeof gitlabMergeRequestSchema>[]>;
  /** <https://docs.gitlab.com/api/discussions/> § "List all merge request discussion items". */
  listDiscussions(project: string, iid: number): Promise<z.output<typeof gitlabDiscussionSchema>[]>;
  /** § "Retrieve a merge request discussion item". */
  discussion(
    project: string,
    iid: number,
    discussionId: string,
  ): Promise<z.output<typeof gitlabDiscussionSchema>>;
  /** § "Create a merge request thread". */
  createDiscussion(
    project: string,
    iid: number,
    body: string,
    position?: DiffNotePosition,
  ): Promise<z.output<typeof gitlabDiscussionSchema>>;
  /** § "Add note to a merge request thread" — returns the created *note*, so the caller re-reads. */
  addDiscussionNote(
    project: string,
    iid: number,
    discussionId: string,
    body: string,
  ): Promise<void>;
  /** § "Resolve a merge request thread". */
  resolveDiscussion(
    project: string,
    iid: number,
    discussionId: string,
  ): Promise<z.output<typeof gitlabDiscussionSchema>>;
  /** <https://docs.gitlab.com/api/pipelines/> § "List project pipelines" (filtered by `sha`). */
  latestPipelineForSha(
    project: string,
    sha: string,
  ): Promise<z.output<typeof gitlabPipelineSchema> | null>;
  /** § "Retrieve a single pipeline" — the only place `coverage` appears. */
  pipeline(project: string, pipelineId: number): Promise<z.output<typeof gitlabPipelineSchema>>;
  /** <https://docs.gitlab.com/api/jobs/> § "List pipeline jobs". */
  pipelineJobs(project: string, pipelineId: number): Promise<z.output<typeof gitlabJobSchema>[]>;
  /** § "Retrieve a job log file" (`GET /projects/:id/jobs/:job_id/trace`). */
  jobTrace(project: string, jobId: number): Promise<string | null>;
  /** <https://docs.gitlab.com/api/repository_files/> § "Retrieve a raw file from a repository". */
  rawFile(project: string, path: string, ref: string): Promise<string | null>;
  /** <https://docs.gitlab.com/api/project_access_tokens/> § "Create a project access token". */
  createProjectAccessToken(
    project: string,
    body: {
      readonly name: string;
      readonly scopes: string[];
      readonly expires_at: string;
      readonly access_level: number;
    },
  ): Promise<z.output<typeof gitlabAccessTokenSchema>>;
  /**
   * § "Revoke a project access token". Answers `true` when GitLab deleted the token (`204`) and
   * `false` when GitLab says there is no such token at that address (`404`). The caller — not
   * this client — decides what a `404` means, because only it knows whether this provider minted
   * the token there (WP-09 review round 1).
   */
  revokeProjectAccessToken(project: string, tokenId: number): Promise<boolean>;
}

export const createGitLabClient = (http: GitLabHttp): GitLabClient => {
  const mrPath = (project: string, iid: number): string =>
    `/projects/${encodeProjectId(project)}/merge_requests/${iid}`;

  const required = async <TSchema extends z.ZodType>(
    schema: TSchema,
    action: string,
    body: Promise<{ body: unknown } | null>,
  ): Promise<z.output<TSchema>> => {
    const response = await body;
    return parse(schema, response?.body ?? null, action);
  };

  return {
    version: async () =>
      required(
        gitlabVersionSchema,
        'test_connection',
        http.request({
          method: 'GET',
          path: '/version',
          action: 'test_connection',
        }),
      ),

    project: async (project) =>
      required(
        gitlabProjectSchema,
        'get_project',
        http.request({
          method: 'GET',
          path: `/projects/${encodeProjectId(project)}`,
          action: 'get_project',
        }),
      ),

    branch: async (project, branch) =>
      required(
        gitlabBranchSchema,
        'get_branch',
        http.request({
          method: 'GET',
          path: `/projects/${encodeProjectId(project)}/repository/branches/${encodeURIComponent(branch)}`,
          action: 'get_branch',
        }),
      ),

    protectedBranch: async (project, branch) => {
      const response = await http.request({
        method: 'GET',
        path: `/projects/${encodeProjectId(project)}/protected_branches/${encodeURIComponent(branch)}`,
        action: 'get_protected_branch',
        notFoundIsNull: true,
      });
      return response === null
        ? null
        : parse(gitlabProtectedBranchSchema, response.body, 'get_protected_branch');
    },

    createCommit: async (project, body) =>
      required(
        gitlabCommitSchema,
        'commit_files',
        http.request({
          method: 'POST',
          path: `/projects/${encodeProjectId(project)}/repository/commits`,
          json: body,
          action: 'commit_files',
        }),
      ),

    createMergeRequest: async (project, body) =>
      required(
        gitlabMergeRequestSchema,
        'open_merge_request',
        http.request({
          method: 'POST',
          path: `/projects/${encodeProjectId(project)}/merge_requests`,
          json: body,
          action: 'open_merge_request',
        }),
      ),

    updateMergeRequest: async (project, iid, body) =>
      required(
        gitlabMergeRequestSchema,
        'update_merge_request',
        http.request({
          method: 'PUT',
          path: mrPath(project, iid),
          json: body,
          action: 'update_merge_request',
        }),
      ),

    mergeRequest: async (project, iid) =>
      required(
        gitlabMergeRequestSchema,
        'get_merge_request',
        http.request({
          method: 'GET',
          path: mrPath(project, iid),
          action: 'get_merge_request',
        }),
      ),

    listMergeRequests: async (project, query) =>
      parse(
        z.array(gitlabMergeRequestSchema),
        await http.paginate(
          {
            method: 'GET',
            path: `/projects/${encodeProjectId(project)}/merge_requests`,
            query,
            action: 'list_merged_merge_requests',
          },
          100,
        ),
        'list_merged_merge_requests',
      ),

    listDiscussions: async (project, iid) =>
      parse(
        z.array(gitlabDiscussionSchema),
        await http.paginate(
          {
            method: 'GET',
            path: `${mrPath(project, iid)}/discussions`,
            action: 'list_discussions',
          },
          100,
        ),
        'list_discussions',
      ),

    discussion: async (project, iid, discussionId) =>
      required(
        gitlabDiscussionSchema,
        'get_discussion',
        http.request({
          method: 'GET',
          path: `${mrPath(project, iid)}/discussions/${encodeURIComponent(discussionId)}`,
          action: 'get_discussion',
        }),
      ),

    createDiscussion: async (project, iid, body, position) =>
      required(
        gitlabDiscussionSchema,
        'create_discussion',
        http.request({
          method: 'POST',
          path: `${mrPath(project, iid)}/discussions`,
          json: position === undefined ? { body } : { body, position },
          action: 'create_discussion',
        }),
      ),

    addDiscussionNote: async (project, iid, discussionId, body) => {
      await http.request({
        method: 'POST',
        path: `${mrPath(project, iid)}/discussions/${encodeURIComponent(discussionId)}/notes`,
        json: { body },
        action: 'reply_to_discussion',
      });
    },

    resolveDiscussion: async (project, iid, discussionId) =>
      required(
        gitlabDiscussionSchema,
        'resolve_discussion',
        http.request({
          method: 'PUT',
          path: `${mrPath(project, iid)}/discussions/${encodeURIComponent(discussionId)}`,
          json: { resolved: true },
          action: 'resolve_discussion',
        }),
      ),

    latestPipelineForSha: async (project, sha) => {
      const response = await http.request<unknown[]>({
        method: 'GET',
        path: `/projects/${encodeProjectId(project)}/pipelines`,
        // `order_by` defaults to `id` and `sort` to `desc`, but both are stated so a change of
        // GitLab's defaults cannot silently return the oldest pipeline for the commit.
        query: { sha, order_by: 'id', sort: 'desc', per_page: 1 },
        action: 'get_pipeline_status',
      });
      const list = parse(
        z.array(gitlabPipelineSchema),
        response?.body ?? [],
        'get_pipeline_status',
      );
      return list[0] ?? null;
    },

    pipeline: async (project, pipelineId) =>
      required(
        gitlabPipelineSchema,
        'get_pipeline_status',
        http.request({
          method: 'GET',
          path: `/projects/${encodeProjectId(project)}/pipelines/${pipelineId}`,
          action: 'get_pipeline_status',
        }),
      ),

    pipelineJobs: async (project, pipelineId) =>
      parse(
        z.array(gitlabJobSchema),
        await http.paginate(
          {
            method: 'GET',
            path: `/projects/${encodeProjectId(project)}/pipelines/${pipelineId}/jobs`,
            action: 'get_pipeline_status',
          },
          100,
        ),
        'get_pipeline_status',
      ),

    jobTrace: async (project, jobId) => {
      const response = await http.requestText({
        method: 'GET',
        path: `/projects/${encodeProjectId(project)}/jobs/${jobId}/trace`,
        action: 'get_job_log',
        notFoundIsNull: true,
      });
      return response === null ? null : response.body;
    },

    rawFile: async (project, path, ref) => {
      const response = await http.requestText({
        method: 'GET',
        path: `/projects/${encodeProjectId(project)}/repository/files/${encodeURIComponent(path)}/raw`,
        query: { ref },
        action: 'read_codeowners',
        notFoundIsNull: true,
      });
      return response === null ? null : response.body;
    },

    createProjectAccessToken: async (project, body) =>
      required(
        gitlabAccessTokenSchema,
        'mint_credential',
        http.request({
          method: 'POST',
          path: `/projects/${encodeProjectId(project)}/access_tokens`,
          json: body,
          action: 'mint_credential',
        }),
      ),

    revokeProjectAccessToken: async (project, tokenId) => {
      // "404: Not Found if the access token does not exist". Reported rather than absorbed here:
      // a 404 is only evidence of "already gone" when the caller knows the token was minted at
      // this address in the first place.
      const response = await http.request({
        method: 'DELETE',
        path: `/projects/${encodeProjectId(project)}/access_tokens/${tokenId}`,
        action: 'revoke_credential',
        notFoundIsNull: true,
      });
      return response !== null;
    },
  };
};
