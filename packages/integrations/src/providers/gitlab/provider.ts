/**
 * The GitLab adapter — `GitProviderPort` for gitlab.com and self-managed instances (WP-09).
 *
 * ## What it is not
 *
 * It is **not** a place where retries, backoff or shadow mode live. `IntegrationActionExecutor`
 * owns those, and every outbound call in the product path goes through it: handlers in the
 * integration priority band build an `IntegrationActionRequest` whose `perform` calls one of these
 * methods (technical/06 § "Outbound: actions"). Putting the executor *inside* the adapter would
 * force the adapter to invent a `mode`, and a shadow guard that defaults its mode fails open —
 * which is the whole of standing rule 14. `test/contract/integrations/gitlab-executor.contract.test.ts`
 * proves the composition: a mutating port call in shadow mode issues zero HTTP requests, and a
 * recorded 429 is retried on the executor's injected timer.
 *
 * It also **never merges** (BD-007). It reports merge state, comments, resolves threads and reads
 * gates; the merge button belongs to a human.
 *
 * ## Divergences from real GitLab, stated rather than implied
 *
 * The fake's register has a dual for a real adapter: *the adapter must not be kinder than the
 * provider*. Where replay cannot reproduce a behaviour, it is written down here.
 *
 *  1. **`diff_stats` is always `null`.** GitLab's REST merge request publishes `changes_count` — a
 *     *file* count, and the string `"1000+"` above a thousand — and no insertion/deletion counts.
 *     Filling two of `diffStatsSchema`'s three fields with zeroes would put invented numbers into
 *     `mr.opened` payloads and into WP-39's coverage/diff deltas. GraphQL's `diffStatsSummary` has
 *     them; adding a GraphQL call is out of this work package's scope and is recorded as
 *     discovered work.
 *  2. **`mintCredential` grants whole days, not seconds.** See `credentials.ts`: GitLab's
 *     `expires_at` is a date and the token dies at midnight UTC on it, so `expiresAt` reports the
 *     instant GitLab enforces and never `now + ttlSeconds`.
 *  3. **`branchPatterns` is carried, not enforced.** A GitLab access token has no branch scoping.
 *     `isBranchProtected` is the compensating check, and the setup guide makes protecting the
 *     default branch a prerequisite. Filed as Q40.
 *  4. **Mergeability is asynchronous and this adapter does not poll for it.** GitLab documents
 *     "Poll this API endpoint to get the updated status"; a poll needs a clock and a budget, both
 *     of which belong to the caller (WP-26's rebase gate). `getMergeRequest` reports `null` for as
 *     long as GitLab says `unchecked`/`checking`, and the replay runner asserts the transition
 *     across two reads of the same merge request.
 *  5. **Coverage on the webhook path is `null`.** The documented Pipeline Hook publishes no
 *     `coverage`, on the pipeline or on a build. `getPipelineStatus` is the read that has it.
 *  6. **A revocation is addressed by the credential, not by the binding.** `revokeId` is
 *     `<project>#<token_id>`, because `mintCredential` mints on the project the *request* names
 *     and `revokeCredential` gets only the credential back. GitLab's `404` on the delete is
 *     absorbed only for a handle this provider minted; for any other handle the adapter reports
 *     `not_found` rather than claiming a revocation it cannot substantiate (see `credentials.ts`).
 *     **The residual, which the design accepts rather than solves:** for a handle this provider
 *     *did* mint, a `404` is still absorbed — and GitLab answers `404`, not `403`, for a project
 *     the caller may not see, so a binding token that loses access to the project between mint and
 *     teardown produces the same response as "already gone". The caller is told the credential is
 *     revoked while it lives until midnight UTC. Nothing in the response distinguishes the two,
 *     and the alternative — refusing every `404` — would fail every honest second teardown, which
 *     is the failure the port's idempotency exists to prevent. The compensating controls are the
 *     token's own expiry (a day at most, `credentials.ts`) and the protected default branch (Q40).
 *  7. **Rate limiting cannot be reproduced in replay.** GitLab.com allows 2,000 authenticated API
 *     requests a minute and answers `429` with `Retry-After` in seconds; the *mapping* of that
 *     response is exercised by a recorded 429 fixture driven through the executor, but no test
 *     here reaches a real quota.
 */
import {
  type CodeownersRules,
  type CredentialScope,
  type Discussion,
  type ExternalIdentity,
  type GitProviderCapabilities,
  type GitProviderInboundEvent,
  type GitProviderPort,
  type HealthProbe,
  type InboundContext,
  type InboundNormaliser,
  IntegrationError,
  type IntegrationRef,
  IntegrationUnsupportedError,
  type MergedMergeRequest,
  type MergeRequest,
  type MergeRequestDraft,
  type MergeRequestRefInput,
  type MergeRequestUpdate,
  type MintedCredential,
  mergeRequestSchema,
  type NormalisedDelivery,
  type PipelineStatus,
  type SecretRedactor,
  type WebhookDelivery,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import type { Clock } from '@platform/domain';
import { createGitLabClient, type DiffNotePosition, type GitLabClient } from './client.js';
import { CODEOWNERS_PATHS, DEFAULT_CODEOWNERS_LIMITS, parseCodeowners } from './codeowners.js';
import type { GitLabConfig } from './config.js';
import {
  buildCloneUrl,
  createMintedCredentialRegistry,
  expiryForTtl,
  formatRevokeId,
  parseRevokeId,
  type RevocationAddress,
  scopesFor,
} from './credentials.js';
import { createGitLabHttp, GITLAB_PROVIDER_ID, type GitLabFetch } from './http.js';
import { normaliseGitLabDelivery } from './inbound.js';
import {
  isDraftTitle,
  mapMergeability,
  mapMergeRequestState,
  mapPipelineStatus,
  toIsoDateTime,
  toIsoDateTimeOrNull,
  withDraftPrefix,
  withoutDraftPrefix,
} from './mapping.js';
import type { GitLabDiscussion, GitLabMergeRequest, gitlabAccessTokenSchema } from './schemas.js';
import { gitLabDeliveryKey, verifyGitLabDelivery } from './webhook-verify.js';

export interface GitLabProviderOptions {
  readonly integrationId: Id;
  readonly config: GitLabConfig;
  /** `{token, webhook_secret_token, webhook_signing_token}` from the secret store. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Injected so replay needs no HTTP interception; production passes `globalThis.fetch`. */
  readonly fetchImpl?: GitLabFetch;
  /** Injected: webhook replay detection needs "now", and a wall clock is a hardware assertion. */
  readonly clock: Clock;
  /**
   * TD-012. Applied to two provider strings that leave this ring: the health probe's `detail` and
   * the tail of a CI job log. `getJobLog`'s port docblock names WP-09 for exactly this — "a CI job
   * log is the text most likely to contain a token the platform itself injected".
   *
   * **Required, never defaulted** (standing rule 31, earned at WP-11): while it was optional the
   * registration did not pass one, so `redact` was the identity function along the only production
   * path and the job-log tail left this ring unredacted.
   */
  readonly redactor: SecretRedactor;
  /** Where a redaction count is reported. Optional so a unit test can assert on it. */
  readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
}

/** GitLab's own extra capabilities, beyond the type port's. */
export interface GitLabBranchProtection {
  readonly name: string;
  readonly allowForcePush: boolean;
  readonly codeOwnerApprovalRequired: boolean;
  /** `0` means "no one"; `30` Developer, `40` Maintainer, `60` Administrator (self-managed only). */
  readonly pushAccessLevels: readonly number[];
  readonly mergeAccessLevels: readonly number[];
}

export interface GitLabProvider extends GitProviderPort {
  /**
   * Whether a branch is protected — the gate WP-15 evaluates before a push, and the compensating
   * control for divergence 3 (a GitLab token has no branch scoping).
   *
   * Uses `GET /projects/:id/repository/branches/:branch`, whose `protected` boolean is documented
   * on a 200 response, rather than inferring protection from a 404 on the protected-branches
   * endpoint — whose "not protected" status code the documentation does not state.
   */
  isBranchProtected(project: string, branch: string): Promise<boolean>;
  /** The protection rules themselves, or `null` when the branch has none. */
  branchProtection(project: string, branch: string): Promise<GitLabBranchProtection | null>;
  /** The instance's version string and edition, for the health panel and the setup guide. */
  instanceVersion(): Promise<{ readonly version: string; readonly enterprise: boolean }>;
}

const MAX_JOB_LOG_TAIL_BYTES = 1_048_576;

const identityOf = (user: {
  id: number;
  username?: string | null;
  name?: string | null;
  email?: string | null;
}): ExternalIdentity => ({
  provider: GITLAB_PROVIDER_ID,
  external_id: String(user.id),
  email: user.email?.includes('@') === true ? user.email : null,
  display_name: user.name ?? user.username ?? null,
  verified: true,
});

const invalidRequest = (action: string, detail: string): IntegrationError =>
  new IntegrationError('invalid_request', GITLAB_PROVIDER_ID, detail, { action });

export const createGitLabProvider = (options: GitLabProviderOptions): GitLabProvider => {
  const { config, clock } = options;
  const token = options.secrets.token ?? '';
  if (token === '') {
    throw invalidRequest('create', 'the binding has no API token; set GITLAB_TOKEN (TD-020)');
  }

  const http = createGitLabHttp({
    baseUrl: config.base_url,
    token,
    fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit)),
    timeoutMs: config.request_timeout_ms,
    maxPages: config.max_pages,
  });
  const client: GitLabClient = createGitLabClient(http);
  const credentials = createMintedCredentialRegistry();

  const ref: IntegrationRef = {
    integrationId: options.integrationId,
    provider: GITLAB_PROVIDER_ID,
    type: 'git',
  };

  const capabilities: GitProviderCapabilities = {
    webhooks: true,
    projectTokens: config.mint_credentials,
    // Group access tokens exist but this adapter mints project-scoped ones only: BD-025 wants the
    // narrowest credential a workspace can work with, and a group token can push to every project
    // in the group.
    groupTokens: false,
    // The *file* is readable on every tier; enforcement of Code Owners is Premium/Ultimate
    // (<https://docs.gitlab.com/user/project/codeowners/reference/> "Tier: Premium, Ultimate").
    codeowners: true,
    coverageArtifacts: true,
    // "Draft merge requests run the same pipelines as merge requests marked as ready."
    draftPipelines: true,
    discussionResolution: true,
    credentialMinting: config.mint_credentials,
  };

  const redact = (action: string, text: string): string => {
    const outcome = options.redactor.redactText(text);
    options.onRedaction?.({ action, count: outcome.count });
    return outcome.value;
  };

  const projectOf = (mrRef: MergeRequestRefInput, action: string): string => {
    const path = mrRef.project_path ?? config.project;
    if (path == null || path === '') {
      throw invalidRequest(
        action,
        'the merge request ref needs a project_path when the binding names no project',
      );
    }
    return path;
  };

  const reviewerIds = (reviewers: readonly string[], action: string): number[] =>
    reviewers.map((value) => {
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) {
        throw invalidRequest(
          action,
          'reviewers must be numeric GitLab user ids (the API takes `reviewer_ids`)',
        );
      }
      return id;
    });

  const toMergeRequest = (project: string, source: GitLabMergeRequest): MergeRequest => {
    const mergeability = mapMergeability({
      mergeStatus: source.merge_status,
      detailedMergeStatus: source.detailed_merge_status,
      hasConflicts: source.has_conflicts,
    });
    const headSha = source.sha ?? source.diff_refs?.head_sha ?? null;
    if (headSha === null) {
      throw new IntegrationError(
        'invalid_response',
        GITLAB_PROVIDER_ID,
        `merge request ${project}!${source.iid} carries no head sha`,
        { action: 'get_merge_request' },
      );
    }
    return mergeRequestSchema.parse({
      ref: {
        provider: GITLAB_PROVIDER_ID,
        project_path: project,
        iid: source.iid,
        url: source.web_url,
        branch: source.source_branch,
        head_sha: headSha,
      },
      state: mapMergeRequestState(source.state),
      // `draft` is authoritative when present; `work_in_progress` is its deprecated alias, and the
      // title prefix is the last resort for an instance older than either.
      draft: source.draft ?? source.work_in_progress ?? isDraftTitle(source.title),
      title: source.title,
      description: source.description ?? '',
      source_branch: source.source_branch,
      target_branch: source.target_branch,
      head_sha: headSha,
      mergeable: mergeability.mergeable,
      has_conflicts: mergeability.hasConflicts,
      diff_stats: null,
      coverage_pct: source.head_pipeline?.coverage ?? null,
      labels: source.labels ?? [],
      reviewers: (source.reviewers ?? []).map(identityOf),
      author: source.author == null ? null : identityOf(source.author),
      web_url: source.web_url,
      merged_at: toIsoDateTimeOrNull(source.merged_at, 'get_merge_request'),
    });
  };

  const toDiscussion = (source: GitLabDiscussion): Discussion => {
    const notes = source.notes ?? [];
    return {
      id: source.id,
      resolvable: notes.some((note) => note.resolvable === true),
      // A thread is resolved when every resolvable note in it is: GitLab resolves per note and
      // reports the thread through them.
      resolved:
        notes.some((note) => note.resolvable === true) &&
        notes.every((note) => note.resolvable !== true || note.resolved === true),
      notes: notes.map((note) => ({
        id: String(note.id),
        author: identityOf(note.author),
        body: note.body,
        created_at: toIsoDateTime(note.created_at, 'list_discussions'),
        path: note.position?.new_path ?? note.position?.old_path ?? null,
        line: note.position?.new_line ?? note.position?.old_line ?? null,
        system: note.system,
      })),
    };
  };

  const requireDiscussion = async (
    project: string,
    iid: number,
    discussionId: string,
    action: string,
  ): Promise<GitLabDiscussion> => {
    try {
      return await client.discussion(project, iid, discussionId);
    } catch (error) {
      if (error instanceof IntegrationError && error.code === 'not_found') {
        throw new IntegrationError(
          'not_found',
          GITLAB_PROVIDER_ID,
          `discussion ${discussionId} of ${project}!${iid} does not exist`,
          { action },
        );
      }
      throw error;
    }
  };

  const inbound: InboundNormaliser<GitProviderInboundEvent> = {
    verify: (delivery: WebhookDelivery) =>
      verifyGitLabDelivery(
        delivery,
        {
          secretToken: options.secrets.webhook_secret_token ?? null,
          signingToken: options.secrets.webhook_signing_token ?? null,
          toleranceSeconds: config.webhook_tolerance_seconds,
        },
        clock,
      ),
    deliveryKey: gitLabDeliveryKey,
    normalise: async (
      delivery: WebhookDelivery,
      context: InboundContext,
    ): Promise<NormalisedDelivery<GitProviderInboundEvent>> =>
      normaliseGitLabDelivery(delivery, context, {
        project: config.project ?? null,
        findThreadForNote: async (project, iid, noteId) => {
          const discussions = await client.listDiscussions(project, iid);
          for (const discussion of discussions) {
            const note = (discussion.notes ?? []).find((candidate) => candidate.id === noteId);
            if (note !== undefined) {
              return { id: discussion.id, resolved: note.resolved === true };
            }
          }
          return null;
        },
      }),
  };

  const provider: GitLabProvider = {
    ref,
    capabilities: () => ({ ...capabilities }),

    testConnection: async (): Promise<HealthProbe> => {
      const version = await client.version();
      const edition = version.enterprise === true ? 'Enterprise Edition' : 'Community Edition';
      const host = new URL(config.base_url).host;
      return {
        ok: true,
        checked_at: clock.now(),
        detail: redact('test_connection', `GitLab ${version.version} (${edition}) at ${host}`),
        // GitLab does not publish the expiry of the token that authenticated the call on any
        // endpoint this adapter uses, and the personal-access-token self endpoint 404s for a
        // project access token — so "unknown", which is what `null` means here.
        token_expires_at: null,
      };
    },

    cloneUrl: (project, credential) => {
      credentials.assertUsable(credential, clock.now());
      return buildCloneUrl(config.base_url, project, credential);
    },

    mintCredential: async (request) => {
      if (!capabilities.credentialMinting) {
        throw new IntegrationUnsupportedError(GITLAB_PROVIDER_ID, 'credential minting');
      }
      if (!Number.isInteger(request.ttlSeconds) || request.ttlSeconds <= 0) {
        throw invalidRequest('mint_credential', 'ttlSeconds must be a positive integer');
      }
      const expiry = expiryForTtl(clock.now(), request.ttlSeconds);
      const scope: CredentialScope = request.scope;

      let created: ReturnType<typeof gitlabAccessTokenSchema.parse>;
      try {
        created = await client.createProjectAccessToken(request.project, {
          // The name is visible in the project's token list; it says which workspace to blame.
          name: `agentic-${scope}-${expiry.date}`,
          scopes: scopesFor(scope),
          expires_at: expiry.date,
          access_level: scope === 'push' ? config.push_access_level : config.read_access_level,
        });
      } catch (error) {
        throw asMintFailure(error);
      }

      // The token was minted on `request.project`, which is not necessarily the project the
      // binding names — so the handle carries the whole address, not just the id.
      const address: RevocationAddress = { project: request.project, tokenId: created.id };
      const credential: MintedCredential = {
        username: 'oauth2',
        value: created.token,
        scope,
        branchPatterns: scope === 'push' ? [...(request.branchPatterns ?? ['agentic/*'])] : [],
        expiresAt: expiry.expiresAt,
        revokeId: formatRevokeId(address),
      };
      credentials.remember(credential, address);
      return credential;
    },

    /**
     * Deletes the token **at the address it was minted on** — never at the binding's project.
     *
     * The port asks for idempotency ("safe to call twice"), and this discharges it in the order
     * that keeps the two apart:
     *
     *  1. a handle this provider has already revoked sends no request at all, so the no-op is a
     *     fact of the registry rather than an inference from a status code;
     *  2. a `404` for a handle this provider *did* mint here is "already gone" — the only way a
     *     token can be missing from the project it was created in, unless the binding token has
     *     itself lost sight of the project, which GitLab reports with the same `404` (divergence 6
     *     records that residual) — and is absorbed;
     *  3. a `404` for a handle this provider did **not** mint (another process, a restart, a
     *     fabricated handle) is ambiguous: "already revoked" and "never existed here" are the same
     *     response. The adapter cannot tell them apart, so it refuses to report success. Saying
     *     "revoked" here is what let a live push token look revoked until midnight UTC.
     */
    revokeCredential: async (credential) => {
      if (credential.revokeId === null) {
        // Not minted by this provider (a static bot token): there is nothing to delete.
        return;
      }
      const minted = credentials.addressFor(credential.revokeId);
      const address = minted ?? parseRevokeId(credential.revokeId);
      if (address === null) {
        throw invalidRequest(
          'revoke_credential',
          'revokeId is not a GitLab revocation address (expected <project>#<token_id>)',
        );
      }
      if (credentials.isRevoked(credential.revokeId)) {
        return;
      }
      const deleted = await client.revokeProjectAccessToken(address.project, address.tokenId);
      if (!deleted && minted === null) {
        throw new IntegrationError(
          'not_found',
          GITLAB_PROVIDER_ID,
          `access token ${address.tokenId} is not present on ${address.project}, and this provider did not mint it — "already revoked" cannot be told from "never existed here", so the token may still be live; check the project's access tokens`,
          { action: 'revoke_credential' },
        );
      }
      credentials.markRevoked(credential.revokeId);
    },

    openMergeRequest: async (draft: MergeRequestDraft) => {
      if (draft.branch === draft.target) {
        throw invalidRequest('open_merge_request', 'source and target branch must differ');
      }
      const created = await client.createMergeRequest(draft.project, {
        source_branch: draft.branch,
        target_branch: draft.target,
        // There is no `draft` parameter on POST /merge_requests; the title prefix is the API.
        title: draft.draft ? withDraftPrefix(draft.title) : withoutDraftPrefix(draft.title),
        description: draft.description,
        ...(draft.labels.length === 0 ? {} : { labels: draft.labels.join(',') }),
        ...(draft.reviewers.length === 0
          ? {}
          : { reviewer_ids: reviewerIds(draft.reviewers, 'open_merge_request') }),
        remove_source_branch: draft.remove_source_branch,
      });
      return toMergeRequest(draft.project, created);
    },

    updateMergeRequest: async (mrRef, update: MergeRequestUpdate) => {
      const project = projectOf(mrRef, 'update_merge_request');
      let title = update.title ?? null;
      if (update.draft != null) {
        // Toggling draft rewrites the title, so the current one has to be known when the caller
        // did not supply a new one.
        const base = title ?? (await client.mergeRequest(project, mrRef.iid)).title;
        title = update.draft ? withDraftPrefix(base) : withoutDraftPrefix(base);
      }
      const updated = await client.updateMergeRequest(project, mrRef.iid, {
        ...(title === null ? {} : { title }),
        ...(update.description == null ? {} : { description: update.description }),
        ...(update.labels == null ? {} : { labels: update.labels.join(',') }),
        ...(update.reviewers == null
          ? {}
          : { reviewer_ids: reviewerIds(update.reviewers, 'update_merge_request') }),
      });
      return toMergeRequest(project, updated);
    },

    getMergeRequest: async (mrRef) => {
      const project = projectOf(mrRef, 'get_merge_request');
      return toMergeRequest(project, await client.mergeRequest(project, mrRef.iid));
    },

    listDiscussions: async (mrRef) => {
      const project = projectOf(mrRef, 'list_discussions');
      return (await client.listDiscussions(project, mrRef.iid)).map(toDiscussion);
    },

    replyToDiscussion: async (mrRef, discussionId, markdown) => {
      const project = projectOf(mrRef, 'reply_to_discussion');
      // The documented response of POST …/notes is the created *note*, not the thread, so the
      // thread is re-read. That also makes an unknown discussion a 404 on the POST, which is the
      // `not_found` the contract suite asserts.
      try {
        await client.addDiscussionNote(project, mrRef.iid, discussionId, markdown);
      } catch (error) {
        if (error instanceof IntegrationError && error.code === 'not_found') {
          throw new IntegrationError(
            'not_found',
            GITLAB_PROVIDER_ID,
            `discussion ${discussionId} of ${project}!${mrRef.iid} does not exist`,
            { action: 'reply_to_discussion' },
          );
        }
        throw error;
      }
      return toDiscussion(
        await requireDiscussion(project, mrRef.iid, discussionId, 'reply_to_discussion'),
      );
    },

    resolveDiscussion: async (mrRef, discussionId) => {
      const project = projectOf(mrRef, 'resolve_discussion');
      return toDiscussion(await client.resolveDiscussion(project, mrRef.iid, discussionId));
    },

    createDiscussion: async (mrRef, note) => {
      const project = projectOf(mrRef, 'create_discussion');
      const mergeRequest = await client.mergeRequest(project, mrRef.iid);
      const refs = mergeRequest.diff_refs;
      if (refs?.base_sha == null || refs.head_sha == null || refs.start_sha == null) {
        throw new IntegrationError(
          'invalid_response',
          GITLAB_PROVIDER_ID,
          `merge request ${project}!${mrRef.iid} has no diff_refs, so a diff note has no position`,
          { action: 'create_discussion' },
        );
      }
      const position: DiffNotePosition = {
        base_sha: refs.base_sha,
        head_sha: refs.head_sha,
        start_sha: refs.start_sha,
        position_type: 'text',
        new_path: note.path,
        old_path: note.path,
        new_line: note.line,
      };
      return toDiscussion(
        await client.createDiscussion(project, mrRef.iid, note.markdown, position),
      );
    },

    getPipelineStatus: async (project, headSha): Promise<PipelineStatus | null> => {
      const latest = await client.latestPipelineForSha(project, headSha);
      if (latest === null) {
        return null;
      }
      const [full, jobs] = await Promise.all([
        client.pipeline(project, latest.id),
        client.pipelineJobs(project, latest.id),
      ]);
      return {
        id: String(full.id),
        head_sha: full.sha,
        status: mapPipelineStatus(full.status, 'get_pipeline_status'),
        url: full.web_url ?? null,
        jobs: jobs.map((job) => ({
          id: String(job.id),
          name: job.name,
          status: mapPipelineStatus(job.status, 'get_pipeline_status'),
          // Every GitLab job has a trace endpoint; whether it holds anything is a 404 at read time.
          log_ref: String(job.id),
          allow_failure: job.allow_failure ?? false,
        })),
        coverage_pct: full.coverage ?? null,
        finished_at: toIsoDateTimeOrNull(full.finished_at, 'get_pipeline_status'),
      };
    },

    getJobLog: async (project, logRef, logOptions) => {
      const jobId = Number(logRef);
      if (!Number.isInteger(jobId) || jobId <= 0) {
        throw invalidRequest('get_job_log', 'a GitLab log_ref is a numeric job id');
      }
      const trace = await client.jobTrace(project, jobId);
      if (trace === null) {
        // "404: Job not found or no log file" — never an empty string, which would let a CI gate
        // report "no failures" for a job whose log it never read.
        throw new IntegrationError(
          'not_found',
          GITLAB_PROVIDER_ID,
          `job ${jobId} of ${project} has no log`,
          { action: 'get_job_log' },
        );
      }
      const tailBytes = Math.min(
        logOptions?.tailBytes ?? MAX_JOB_LOG_TAIL_BYTES,
        MAX_JOB_LOG_TAIL_BYTES,
      );
      const tail = trace.length <= tailBytes ? trace : trace.slice(trace.length - tailBytes);
      return redact('get_job_log', tail);
    },

    getDefaultBranchHead: async (project) => {
      const details = await client.project(project);
      const branch = details.default_branch;
      if (branch == null || branch === '') {
        throw new IntegrationError(
          'invalid_response',
          GITLAB_PROVIDER_ID,
          `project ${project} reports no default branch`,
          { action: 'get_default_branch_head' },
        );
      }
      const head = await client.branch(project, branch);
      return { branch: head.name, sha: head.commit.id };
    },

    readCodeowners: async (project, ref): Promise<CodeownersRules | null> => {
      if (!capabilities.codeowners) {
        throw new IntegrationUnsupportedError(GITLAB_PROVIDER_ID, 'CODEOWNERS');
      }
      for (const path of CODEOWNERS_PATHS) {
        const raw = await client.rawFile(project, path, ref);
        if (raw === null) {
          continue;
        }
        // BD-022: a fork's contributor writes this file. Truncating before parsing bounds the work
        // regardless of what they wrote.
        const bounded =
          raw.length <= config.max_codeowners_bytes
            ? raw
            : raw.slice(0, config.max_codeowners_bytes);
        return parseCodeowners(bounded, DEFAULT_CODEOWNERS_LIMITS);
      }
      return null;
    },

    listMergedMergeRequests: async (
      project,
      since,
      limit,
    ): Promise<readonly MergedMergeRequest[]> => {
      if (!Number.isInteger(limit) || limit <= 0) {
        throw invalidRequest('list_merged_merge_requests', 'limit must be a positive integer');
      }
      const sinceMs = Date.parse(since);
      if (Number.isNaN(sinceMs)) {
        throw invalidRequest('list_merged_merge_requests', 'since must be an ISO-8601 instant');
      }
      // `order_by=merged_at` needs GitLab 17.2; `updated_at` works everywhere, and `merged_at` is
      // then filtered and sorted here — a self-managed instance two versions behind still answers.
      const listed = await client.listMergeRequests(project, {
        state: 'merged',
        updated_after: new Date(sinceMs).toISOString(),
        order_by: 'updated_at',
        sort: 'desc',
      });
      const merged = listed
        .filter((mr) => mr.merged_at != null && Date.parse(mr.merged_at) >= sinceMs)
        .sort((left, right) => Date.parse(right.merged_at ?? '') - Date.parse(left.merged_at ?? ''))
        .slice(0, limit);

      const results: MergedMergeRequest[] = [];
      for (const mr of merged) {
        // GitLab publishes `user_notes_count` (notes) and not a thread count, so the threads are
        // counted. One request per merge request, bounded by `limit`.
        const discussions = await client.listDiscussions(project, mr.iid);
        results.push({
          ref: {
            provider: GITLAB_PROVIDER_ID,
            project_path: project,
            iid: mr.iid,
            url: mr.web_url,
            branch: mr.source_branch,
            head_sha: mr.sha ?? null,
          },
          author:
            mr.author == null
              ? {
                  provider: GITLAB_PROVIDER_ID,
                  external_id: 'unknown',
                  email: null,
                  display_name: null,
                  verified: false,
                }
              : identityOf(mr.author),
          merged_at: toIsoDateTime(mr.merged_at as string, 'list_merged_merge_requests'),
          title: mr.title,
          diff_stats: null,
          discussion_count: discussions.filter((discussion) =>
            (discussion.notes ?? []).some((note) => note.system !== true),
          ).length,
        });
      }
      return results;
    },

    inbound,

    isBranchProtected: async (project, branch) => (await client.branch(project, branch)).protected,

    branchProtection: async (project, branch) => {
      const rules = await client.protectedBranch(project, branch);
      if (rules === null) {
        return null;
      }
      return {
        name: rules.name,
        allowForcePush: rules.allow_force_push ?? false,
        codeOwnerApprovalRequired: rules.code_owner_approval_required ?? false,
        pushAccessLevels: (rules.push_access_levels ?? [])
          .map((entry) => entry.access_level)
          .filter((level): level is number => typeof level === 'number'),
        mergeAccessLevels: (rules.merge_access_levels ?? [])
          .map((entry) => entry.access_level)
          .filter((level): level is number => typeof level === 'number'),
      };
    },

    instanceVersion: async () => {
      const version = await client.version();
      return { version: version.version, enterprise: version.enterprise === true };
    },
  };

  return provider;
};

/**
 * Why a mint failed, in terms an operator can act on.
 *
 * The project access token endpoint is the one place where "this instance cannot do that" and
 * "you asked for something that does not exist" arrive as the same status. GitLab answers `404`
 * for a resource the caller may not see *and* documents that on GitLab.com project access tokens
 * need Premium or Ultimate; it also documents that the endpoint must be called with a **personal**
 * access token ("You cannot authenticate with a project access token"). A raw `not_found` here
 * would send an operator looking for a missing project.
 */
const asMintFailure = (error: unknown): unknown => {
  if (!(error instanceof IntegrationError)) {
    return error;
  }
  if (error.code === 'not_found' || error.code === 'forbidden') {
    return new IntegrationUnsupportedError(
      GITLAB_PROVIDER_ID,
      'project access tokens on this instance — they need Premium or Ultimate on GitLab.com, ' +
        'the Maintainer or Owner role, and a personal access token to authenticate with ' +
        '(a project access token cannot create one)',
    );
  }
  return error;
};
