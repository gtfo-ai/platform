/**
 * `FakeGitProvider` — the in-memory provider behind the GitProvider contract suite and every
 * pipeline test that opens a merge request (technical/06, technical/10).
 *
 * It models the six things the pipeline actually depends on: a project with a moving default
 * branch, merge requests with a draft flag, discussion threads that resolve, pipelines with job
 * logs, CODEOWNERS, and short-lived credentials that can be revoked. Git itself is deliberately
 * absent — clone, commit, rebase and push belong to the workspace manager (BD-025), and this fake
 * would be lying if it pretended to hold a working copy.
 *
 * ## Known divergences from a real git provider
 *
 * The rule: **a fake may be stricter than the real adapter, never kinder.**
 *
 *  1. **Stricter — a revoked or expired credential is rejected by `cloneUrl`.** GitLab would
 *     simply return 401 at clone time, one layer further away; failing at the port makes a
 *     workspace that reuses a dead credential fail where the mistake is.
 *  2. **Stricter — a second open merge request for one source branch is a `conflict`.** That is
 *     GitLab's real behaviour ("Another open merge request already exists for this source
 *     branch", HTTP 409, which `common.ts` maps to `conflict`), reproduced here rather than
 *     allowed, so a pipeline bug that re-opens an MR fails in the unit tier. The code matters as
 *     much as the refusal: the shared contract suite asserts it, so a fake that answered
 *     `invalid_request` would oblige WP-09 to mis-map a real 409.
 *  3. **Stricter — `getJobLog` refuses an unknown `log_ref`.** A provider that returned an empty
 *     string would let the CI gate report "no failures" for a job whose log it never read.
 *  4. **Kinder, deliberately — there is no quota and no pipeline latency.** No 429 unless a test
 *     scripts one; `getPipelineStatus` returns the seeded status immediately, where a real
 *     provider needs seconds and may report `pending` first. Tests that care drive the state with
 *     `setPipeline`. The scripted 429 is driven through the executor by
 *     `test/contract/integrations/action-executor.contract.test.ts` ("git — open_merge_request"),
 *     which is a test that exists: until WP-07 review round 1 this sentence pointed at none.
 *  5. **Kinder — mergeability is whatever the seed says.** A real provider computes it
 *     asynchronously and answers `null` until it has; the fake answers `null` only when asked to,
 *     through `setMergeability`. WP-26 (rebase gate) must not conclude from a green test here that
 *     `null` is handled. That the three states *round-trip* at all is asserted by the shared suite
 *     ("reports mergeability as the provider computed it, including 'not computed yet'"), because
 *     until WP-07 review round 1 nothing did: hard-coding `mergeable: true` here left 39 of 39
 *     tests green.
 *  6. **Different — shas are counters in hex and iids are sequential per project.** Deterministic,
 *     therefore fixture-friendly, and unlike a real sha they carry order.
 *  7. **Different — `mintCredential` returns a value shaped `fake_credential_<n>`.** It matches no
 *     provider's token format on purpose: a secret scanner must never find a plausible token in
 *     this repository (BD-002), and no test should be able to pattern-match a real one.
 *  8. **Stricter — revoking a credential this fake never minted is `not_found`.** A real adapter
 *     cannot tell "already revoked" from "never existed here" when the provider denies knowing a
 *     handle it did not mint, so the port forbids it to report success (WP-09 review round 1); the
 *     fake knows exactly what it minted, and refusing is the stricter of the two answers. A second
 *     revocation of a credential it *did* mint stays a no-op, which is the idempotency the port
 *     asks for. Asserted by `fake.test.ts` ("refuses to revoke a credential it never minted").
 */
import {
  type CodeownersRules,
  type CredentialScope,
  type Discussion,
  type GitProviderCapabilities,
  type GitProviderInboundEvent,
  type GitProviderPort,
  type HealthProbe,
  type InboundContext,
  type InboundNormaliser,
  type IntegrationRef,
  IntegrationUnsupportedError,
  type MergedMergeRequest,
  type MergeRequest,
  type MergeRequestDraft,
  type MergeRequestRefInput,
  type MergeRequestState,
  type MergeRequestUpdate,
  type MintedCredential,
  mergeRequestSchema,
  type NormalisedDelivery,
  type NormalisedEvent,
  type PipelineStatus,
  type PipelineStatusValue,
  type WebhookDelivery,
} from '@platform/application';
import type { CiStatus, DiffStats, ExternalIdentity, Id } from '@platform/contracts';
import * as z from 'zod';
import {
  buildFakeDelivery,
  conflict,
  createFakeCore,
  type FakeCore,
  fakeDeliveryKey,
  invalidRequest,
  notFound,
  snapshot,
  verifyFakeDelivery,
} from '../support/fake-support.js';

const PROVIDER = 'fake-git';

export interface FakeProjectSeed {
  readonly path: string;
  readonly defaultBranch?: string;
  readonly head?: string;
  /** Raw CODEOWNERS text; `null` when the project has none. */
  readonly codeowners?: string | null;
  /**
   * Branches this project protects. Defaults to `[defaultBranch]`, because a project whose default
   * branch is unprotected is the unusual case and a fake that made it the default would let every
   * test pass the pipeline's protection gate without meaning to.
   */
  readonly protectedBranches?: readonly string[];
}

export interface FakeGitOptions {
  readonly integrationId: Id;
  readonly baseUrl?: string;
  readonly projects?: readonly FakeProjectSeed[];
  readonly capabilities?: Partial<GitProviderCapabilities>;
  readonly webhookSecret?: string;
}

interface StoredProject {
  path: string;
  defaultBranch: string;
  head: string;
  codeowners: string | null;
  protectedBranches: Set<string>;
  nextIid: number;
}

interface StoredNote {
  id: string;
  author: ExternalIdentity;
  body: string;
  created_at: string;
  path: string | null;
  line: number | null;
  system: boolean;
}

interface StoredDiscussion {
  id: string;
  project: string;
  iid: number;
  resolvable: boolean;
  resolved: boolean;
  notes: StoredNote[];
}

interface StoredJob {
  id: string;
  name: string;
  status: PipelineStatusValue;
  log: string | null;
  allow_failure: boolean;
}

interface StoredPipeline {
  id: string;
  project: string;
  head_sha: string;
  status: PipelineStatusValue;
  jobs: StoredJob[];
  coverage_pct: number | null;
  finished_at: string | null;
}

interface StoredMergeRequest {
  project: string;
  iid: number;
  state: MergeRequestState;
  draft: boolean;
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  head_sha: string;
  mergeable: boolean | null;
  has_conflicts: boolean | null;
  diff_stats: DiffStats | null;
  coverage_pct: number | null;
  labels: string[];
  reviewers: string[];
  merged_at: string | null;
}

interface StoredCredential {
  value: string;
  revokeId: string;
  revoked: boolean;
  expiresAt: string;
  project: string;
}

const mrEventBody = z.strictObject({
  event: z.enum(['mr.opened', 'mr.updated', 'mr.merged', 'mr.closed']),
  project: z.string().min(1),
  iid: z.int().positive(),
});

const reviewCommentBody = z.strictObject({
  event: z.literal('mr.review.comment'),
  project: z.string().min(1),
  iid: z.int().positive(),
  discussion_id: z.string().min(1),
  author_id: z.string().min(1),
  text: z.string(),
  resolved: z.boolean(),
});

const pipelineBody = z.strictObject({
  event: z.literal('ci.pipeline.finished'),
  project: z.string().min(1),
  head_sha: z.string().min(1),
});

const branchMovedBody = z.strictObject({
  event: z.literal('default_branch.moved'),
  project: z.string().min(1),
  branch: z.string().min(1),
  new_head: z.string().min(1),
});

const deliveryBody = z.discriminatedUnion('event', [
  mrEventBody,
  reviewCommentBody,
  pipelineBody,
  branchMovedBody,
]);

export interface FakeGitProvider extends GitProviderPort {
  readonly core: FakeCore;
  seedProject(seed: FakeProjectSeed): void;
  /** Installs (or replaces) the pipeline for a commit. */
  setPipeline(pipeline: {
    readonly project: string;
    readonly headSha: string;
    readonly status: PipelineStatusValue;
    readonly jobs?: readonly {
      name: string;
      status: PipelineStatusValue;
      log?: string;
      allowFailure?: boolean;
    }[];
    readonly coveragePct?: number | null;
  }): PipelineStatus;
  /**
   * Sets what the provider says about mergeability — divergence 5 made reachable.
   *
   * `null` is the state that matters: a real provider answers `mergeable: null` while it is still
   * computing, and WP-26's rebase gate has to treat that as "unknown, ask again" rather than as
   * "not mergeable". Without this control the fake could only ever say `true`.
   */
  setMergeability(input: {
    readonly project?: string;
    readonly iid: number;
    readonly mergeable: boolean | null;
    readonly hasConflicts: boolean | null;
  }): MergeRequest;
  /** Moves the default branch, as a merge on another MR would. */
  moveDefaultBranch(project: string, newHead: string): void;
  /** Adds a human discussion thread, the way a reviewer would. */
  addHumanDiscussion(input: {
    readonly project: string;
    readonly iid: number;
    readonly authorId: string;
    readonly text: string;
    readonly path?: string;
    readonly line?: number;
  }): Discussion;
  emitMergeRequestEvent(input: {
    readonly event: 'mr.opened' | 'mr.updated' | 'mr.merged' | 'mr.closed';
    readonly project: string;
    readonly iid: number;
    readonly deliveryId?: string;
  }): WebhookDelivery;
  emitReviewComment(input: {
    readonly project: string;
    readonly iid: number;
    readonly discussionId: string;
    readonly authorId: string;
    readonly text: string;
    readonly resolved?: boolean;
    readonly deliveryId?: string;
  }): WebhookDelivery;
  emitPipelineFinished(input: {
    readonly project: string;
    readonly headSha: string;
    readonly deliveryId?: string;
  }): WebhookDelivery;
  emitDefaultBranchMoved(input: {
    readonly project: string;
    readonly newHead: string;
    readonly deliveryId?: string;
  }): WebhookDelivery;
}

export const createFakeGitProvider = (options: FakeGitOptions): FakeGitProvider => {
  const ref: IntegrationRef = {
    integrationId: options.integrationId,
    provider: PROVIDER,
    type: 'git',
  };
  const core = createFakeCore({ ref, webhookSecret: options.webhookSecret });
  const baseUrl = options.baseUrl ?? 'https://git.example.test';
  const capabilities: GitProviderCapabilities = {
    webhooks: true,
    projectTokens: true,
    groupTokens: false,
    codeowners: true,
    coverageArtifacts: true,
    draftPipelines: true,
    discussionResolution: true,
    credentialMinting: true,
    ...options.capabilities,
  };

  const projects = new Map<string, StoredProject>();
  const mergeRequests: StoredMergeRequest[] = [];
  const discussions: StoredDiscussion[] = [];
  const pipelines: StoredPipeline[] = [];
  const credentials = new Map<string, StoredCredential>();
  let shaCounter = 0x100;
  let discussionCounter = 0;
  let noteCounter = 0;
  let pipelineCounter = 0;
  let credentialCounter = 0;
  let deliveryCounter = 0;

  const nextSha = (): string => {
    shaCounter += 1;
    return shaCounter.toString(16).padStart(40, '0');
  };
  const nextDeliveryId = (): string => {
    deliveryCounter += 1;
    return `d-${deliveryCounter}`;
  };

  const seedProject = (seed: FakeProjectSeed): void => {
    projects.set(seed.path, {
      path: seed.path,
      defaultBranch: seed.defaultBranch ?? 'main',
      protectedBranches: new Set(seed.protectedBranches ?? [seed.defaultBranch ?? 'main']),
      head: seed.head ?? nextSha(),
      codeowners: seed.codeowners ?? null,
      nextIid: 1,
    });
  };
  for (const seed of options.projects ?? []) {
    seedProject(seed);
  }

  const requireProject = (action: string, path: string): StoredProject => {
    const project = projects.get(path);
    if (project === undefined) {
      throw notFound(PROVIDER, action, `project ${path}`);
    }
    return project;
  };

  const projectOf = (mrRef: MergeRequestRefInput): string => {
    if (mrRef.project_path != null) {
      return mrRef.project_path;
    }
    const only = [...projects.keys()];
    if (only.length === 1 && only[0] !== undefined) {
      return only[0];
    }
    throw invalidRequest(
      PROVIDER,
      'merge_request',
      'the merge request ref needs a project_path when more than one project is configured',
    );
  };

  const findMr = (project: string, iid: number): StoredMergeRequest | undefined =>
    mergeRequests.find((mr) => mr.project === project && mr.iid === iid);

  const requireMr = (action: string, mrRef: MergeRequestRefInput): StoredMergeRequest => {
    const project = projectOf(mrRef);
    const mr = findMr(project, mrRef.iid);
    if (mr === undefined) {
      throw notFound(PROVIDER, action, `merge request ${project}!${mrRef.iid}`);
    }
    return mr;
  };

  const mrUrl = (mr: StoredMergeRequest): string =>
    `${baseUrl}/${mr.project}/-/merge_requests/${mr.iid}`;

  const toMergeRequest = (mr: StoredMergeRequest): MergeRequest =>
    mergeRequestSchema.parse({
      ref: {
        provider: PROVIDER,
        project_path: mr.project,
        iid: mr.iid,
        url: mrUrl(mr),
        branch: mr.source_branch,
        head_sha: mr.head_sha,
      },
      state: mr.state,
      draft: mr.draft,
      title: mr.title,
      description: mr.description,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      head_sha: mr.head_sha,
      mergeable: mr.mergeable,
      has_conflicts: mr.has_conflicts,
      diff_stats: mr.diff_stats,
      coverage_pct: mr.coverage_pct,
      labels: [...mr.labels],
      reviewers: mr.reviewers.map((id) => identityOf(id)),
      author: identityOf('agentic-bot'),
      web_url: mrUrl(mr),
      merged_at: mr.merged_at,
    });

  const identityOf = (externalId: string): ExternalIdentity => ({
    provider: PROVIDER,
    external_id: externalId,
    email: null,
    display_name: externalId,
    verified: true,
  });

  const toDiscussion = (discussion: StoredDiscussion): Discussion => ({
    id: discussion.id,
    resolvable: discussion.resolvable,
    resolved: discussion.resolved,
    notes: snapshot(discussion.notes),
  });

  const toPipeline = (pipeline: StoredPipeline): PipelineStatus => ({
    id: pipeline.id,
    head_sha: pipeline.head_sha,
    status: pipeline.status,
    url: `${baseUrl}/${pipeline.project}/-/pipelines/${pipeline.id}`,
    jobs: pipeline.jobs.map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      log_ref: job.log === null ? null : `log:${job.id}`,
      allow_failure: job.allow_failure,
    })),
    coverage_pct: pipeline.coverage_pct,
    finished_at: pipeline.finished_at,
  });

  const findPipeline = (project: string, headSha: string): StoredPipeline | undefined =>
    [...pipelines].reverse().find((p) => p.project === project && p.head_sha === headSha);

  const parseCodeowners = (text: string): CodeownersRules => ({
    rules: text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => {
        const [pattern, ...owners] = line.split(/\s+/);
        return { pattern: pattern ?? '', owners };
      })
      .filter((rule) => rule.pattern.length > 0 && rule.owners.length > 0),
  });

  const terminalStatus = (status: PipelineStatusValue): CiStatus =>
    status === 'success' || status === 'failed' || status === 'canceled' || status === 'skipped'
      ? status
      : 'failed';

  const inbound: InboundNormaliser<GitProviderInboundEvent> = {
    verify: (delivery) => verifyFakeDelivery(core.webhookSecret, delivery),
    deliveryKey: (delivery) => fakeDeliveryKey(PROVIDER, delivery),
    normalise: async (
      delivery: WebhookDelivery,
      context: InboundContext,
    ): Promise<NormalisedDelivery<GitProviderInboundEvent>> => {
      const parsed = deliveryBody.safeParse(JSON.parse(delivery.body) as unknown);
      if (!parsed.success) {
        return {
          events: [],
          ignored: [{ reason: 'malformed_payload', detail: parsed.error.issues[0]?.message ?? '' }],
        };
      }
      const body = parsed.data;
      const actor = {
        kind: 'integration',
        integration_id: context.integrationId,
        provider: PROVIDER,
      } as const;

      if (body.event === 'default_branch.moved') {
        const event: NormalisedEvent<'default_branch.moved'> = {
          type: 'default_branch.moved',
          payload: {
            project_id: context.projectId,
            branch: body.branch,
            new_head: body.new_head,
          },
          actor,
        };
        return { events: [event], ignored: [] };
      }

      if (body.event === 'ci.pipeline.finished') {
        const pipeline = findPipeline(body.project, body.head_sha);
        if (pipeline === undefined) {
          return {
            events: [],
            ignored: [
              { reason: 'not_for_this_project', detail: `no pipeline for ${body.head_sha}` },
            ],
          };
        }
        const mr = mergeRequests.find(
          (candidate) => candidate.project === body.project && candidate.head_sha === body.head_sha,
        );
        const event: NormalisedEvent<'ci.pipeline.finished'> = {
          type: 'ci.pipeline.finished',
          payload: {
            project_id: context.projectId,
            task_id: null,
            mr:
              mr === undefined
                ? null
                : {
                    provider: PROVIDER,
                    project_path: mr.project,
                    iid: mr.iid,
                    url: mrUrl(mr),
                    branch: mr.source_branch,
                    head_sha: mr.head_sha,
                  },
            head_sha: pipeline.head_sha,
            status: terminalStatus(pipeline.status),
            failed_jobs: pipeline.jobs
              .filter((job) => job.status === 'failed' && !job.allow_failure)
              .map((job) => ({
                name: job.name,
                log_ref: job.log === null ? null : `log:${job.id}`,
              })),
            coverage_pct: pipeline.coverage_pct,
          },
          actor,
        };
        return { events: [event], ignored: [] };
      }

      const mr = findMr(body.project, body.iid);
      if (mr === undefined) {
        return {
          events: [],
          ignored: [
            { reason: 'not_for_this_project', detail: `unknown mr ${body.project}!${body.iid}` },
          ],
        };
      }
      const mrRef = {
        provider: PROVIDER,
        project_path: mr.project,
        iid: mr.iid,
        url: mrUrl(mr),
        branch: mr.source_branch,
        head_sha: mr.head_sha,
      };

      if (body.event === 'mr.review.comment') {
        const identity = identityOf(body.author_id);
        const author: ExternalIdentity = {
          ...identity,
          verified: context.resolveUser(identity) !== null,
        };
        const event: NormalisedEvent<'mr.review.comment'> = {
          type: 'mr.review.comment',
          payload: {
            project_id: context.projectId,
            task_id: null,
            mr: mrRef,
            thread_id: body.discussion_id,
            author,
            text: body.text,
            resolved: body.resolved,
          },
          actor: { ...actor, identity: author },
        };
        return { events: [event], ignored: [] };
      }

      const payload = {
        project_id: context.projectId,
        task_id: null,
        mr: mrRef,
        draft: mr.draft,
        head_sha: mr.head_sha,
        diff_stats: mr.diff_stats,
      };
      if (body.event === 'mr.merged') {
        const event: NormalisedEvent<'mr.merged'> = {
          type: 'mr.merged',
          payload: { ...payload, merge_commit_sha: nextSha() },
          actor,
        };
        return { events: [event], ignored: [] };
      }
      const event = {
        type: body.event,
        payload,
        actor,
      } as NormalisedEvent<'mr.opened' | 'mr.updated' | 'mr.closed'>;
      return { events: [event], ignored: [] };
    },
  };

  return {
    core,
    ref,
    capabilities: () => ({ ...capabilities }),
    testConnection: async (): Promise<HealthProbe> => {
      core.enter('test_connection');
      return {
        ok: true,
        checked_at: core.clock.now(),
        detail: `${projects.size} projects seeded`,
        token_expires_at: null,
      };
    },

    cloneUrl: (project, credential) => {
      requireProject('clone_url', project);
      const stored = credentials.get(credential.value);
      if (stored === undefined) {
        throw invalidRequest(PROVIDER, 'clone_url', 'credential was not minted by this provider');
      }
      // Divergence 1: fail at the port, not at `git clone`.
      if (stored.revoked) {
        throw invalidRequest(PROVIDER, 'clone_url', 'credential has been revoked');
      }
      if (Date.parse(stored.expiresAt) <= Date.parse(core.clock.now())) {
        throw invalidRequest(PROVIDER, 'clone_url', 'credential has expired');
      }
      return `${baseUrl.replace('https://', `https://oauth2:${credential.value}@`)}/${project}.git`;
    },

    mintCredential: async (request) => {
      core.enter('mint_credential');
      if (!capabilities.credentialMinting) {
        throw new IntegrationUnsupportedError(PROVIDER, 'credential minting');
      }
      requireProject('mint_credential', request.project);
      if (!Number.isInteger(request.ttlSeconds) || request.ttlSeconds <= 0) {
        throw invalidRequest(PROVIDER, 'mint_credential', 'ttlSeconds must be a positive integer');
      }
      credentialCounter += 1;
      // Divergence 7: shaped like nothing real, so no scanner can mistake it for a token.
      const value = `fake_credential_${credentialCounter}`;
      const expiresAt = new Date(
        Date.parse(core.clock.now()) + request.ttlSeconds * 1000,
      ).toISOString();
      credentials.set(value, {
        value,
        revokeId: `rev-${credentialCounter}`,
        revoked: false,
        expiresAt,
        project: request.project,
      });
      const credential: MintedCredential = {
        username: 'oauth2',
        value,
        scope: request.scope satisfies CredentialScope,
        branchPatterns:
          request.scope === 'push' ? [...(request.branchPatterns ?? ['agentic/*'])] : [],
        expiresAt,
        revokeId: `rev-${credentialCounter}`,
      };
      return credential;
    },

    revokeCredential: async (credential) => {
      core.enter('revoke_credential');
      const stored = credentials.get(credential.value);
      if (stored === undefined) {
        // Divergence 8: refuse rather than shrug. The port makes "may not report a revocation it
        // cannot substantiate" an adapter obligation, and a fake that returns void here would let
        // a teardown built against it ship code that never handles the refusal (rule 1).
        throw notFound(PROVIDER, 'revoke_credential', 'credential this provider never minted');
      }
      stored.revoked = true;
    },

    openMergeRequest: async (draft: MergeRequestDraft) => {
      core.enter('open_merge_request');
      const project = requireProject('open_merge_request', draft.project);
      if (draft.branch === draft.target) {
        throw invalidRequest(
          PROVIDER,
          'open_merge_request',
          'source and target branch must differ',
        );
      }
      const conflicting = mergeRequests.find(
        (mr) =>
          mr.project === draft.project &&
          mr.source_branch === draft.branch &&
          mr.state === 'opened',
      );
      if (conflicting !== undefined) {
        // Divergence 2: GitLab's real refusal, with GitLab's real code. It answers 409 here
        // (evidenced by every bot that has ever hit it), and `common.ts` maps 409 → `conflict`.
        throw conflict(
          PROVIDER,
          'open_merge_request',
          `another open merge request already exists for source branch ${draft.branch}`,
        );
      }
      const mr: StoredMergeRequest = {
        project: draft.project,
        iid: project.nextIid,
        state: 'opened',
        draft: draft.draft,
        title: draft.title,
        description: draft.description,
        source_branch: draft.branch,
        target_branch: draft.target,
        head_sha: nextSha(),
        mergeable: true,
        has_conflicts: false,
        diff_stats: { files_changed: 1, insertions: 10, deletions: 2 },
        coverage_pct: null,
        labels: [...draft.labels],
        reviewers: [...draft.reviewers],
        merged_at: null,
      };
      project.nextIid += 1;
      mergeRequests.push(mr);
      return toMergeRequest(mr);
    },

    updateMergeRequest: async (mrRef, update: MergeRequestUpdate) => {
      core.enter('update_merge_request');
      const mr = requireMr('update_merge_request', mrRef);
      if (update.title != null) {
        mr.title = update.title;
      }
      if (update.description != null) {
        mr.description = update.description;
      }
      if (update.draft != null) {
        mr.draft = update.draft;
      }
      if (update.labels != null) {
        mr.labels = [...update.labels];
      }
      if (update.reviewers != null) {
        mr.reviewers = [...update.reviewers];
      }
      return toMergeRequest(mr);
    },

    getMergeRequest: async (mrRef) => {
      core.enter('get_merge_request');
      return toMergeRequest(requireMr('get_merge_request', mrRef));
    },

    listDiscussions: async (mrRef) => {
      core.enter('list_discussions');
      const mr = requireMr('list_discussions', mrRef);
      return discussions
        .filter((discussion) => discussion.project === mr.project && discussion.iid === mr.iid)
        .map(toDiscussion);
    },

    replyToDiscussion: async (mrRef, discussionId, markdown) => {
      core.enter('reply_to_discussion');
      const mr = requireMr('reply_to_discussion', mrRef);
      const discussion = discussions.find(
        (candidate) =>
          candidate.id === discussionId &&
          candidate.project === mr.project &&
          candidate.iid === mr.iid,
      );
      if (discussion === undefined) {
        throw notFound(PROVIDER, 'reply_to_discussion', `discussion ${discussionId}`);
      }
      noteCounter += 1;
      discussion.notes.push({
        id: `n-${noteCounter}`,
        author: identityOf('agentic-bot'),
        body: markdown,
        created_at: core.clock.now(),
        path: null,
        line: null,
        system: false,
      });
      return toDiscussion(discussion);
    },

    resolveDiscussion: async (mrRef, discussionId) => {
      core.enter('resolve_discussion');
      if (!capabilities.discussionResolution) {
        throw new IntegrationUnsupportedError(PROVIDER, 'discussion resolution');
      }
      const mr = requireMr('resolve_discussion', mrRef);
      const discussion = discussions.find(
        (candidate) =>
          candidate.id === discussionId &&
          candidate.project === mr.project &&
          candidate.iid === mr.iid,
      );
      if (discussion === undefined) {
        throw notFound(PROVIDER, 'resolve_discussion', `discussion ${discussionId}`);
      }
      if (!discussion.resolvable) {
        throw invalidRequest(
          PROVIDER,
          'resolve_discussion',
          `discussion ${discussionId} is not resolvable`,
        );
      }
      discussion.resolved = true;
      return toDiscussion(discussion);
    },

    createDiscussion: async (mrRef, note) => {
      core.enter('create_discussion');
      const mr = requireMr('create_discussion', mrRef);
      discussionCounter += 1;
      noteCounter += 1;
      const discussion: StoredDiscussion = {
        id: `disc-${discussionCounter}`,
        project: mr.project,
        iid: mr.iid,
        resolvable: true,
        resolved: false,
        notes: [
          {
            id: `n-${noteCounter}`,
            author: identityOf('agentic-bot'),
            body: note.markdown,
            created_at: core.clock.now(),
            path: note.path,
            line: note.line,
            system: false,
          },
        ],
      };
      discussions.push(discussion);
      return toDiscussion(discussion);
    },

    getPipelineStatus: async (project, headSha) => {
      core.enter('get_pipeline_status');
      requireProject('get_pipeline_status', project);
      const pipeline = findPipeline(project, headSha);
      return pipeline === undefined ? null : toPipeline(pipeline);
    },

    getJobLog: async (project, logRef, logOptions) => {
      core.enter('get_job_log');
      requireProject('get_job_log', project);
      const jobId = logRef.startsWith('log:') ? logRef.slice(4) : logRef;
      const job = pipelines
        .flatMap((pipeline) => pipeline.jobs)
        .find((candidate) => candidate.id === jobId);
      if (job === undefined || job.log === null) {
        // Divergence 3: an unknown log is an error, never an empty string.
        throw notFound(PROVIDER, 'get_job_log', `job log ${logRef}`);
      }
      const tailBytes = logOptions?.tailBytes;
      if (tailBytes === undefined) {
        return job.log;
      }
      return job.log.slice(Math.max(0, job.log.length - tailBytes));
    },

    getDefaultBranchHead: async (project) => {
      core.enter('get_default_branch_head');
      const stored = requireProject('get_default_branch_head', project);
      return { branch: stored.defaultBranch, sha: stored.head };
    },

    isBranchProtected: async (project, branch) => {
      core.enter('is_branch_protected');
      const stored = requireProject('is_branch_protected', project);
      // Divergence: the fake knows every branch its merge requests created, plus the default. A
      // name it has never seen is `not_found` rather than `false` — stricter than a provider that
      // might answer "unprotected" for a typo, and stricter in the direction that matters, because
      // "unprotected" is what lets a push credential near the default branch.
      const known =
        stored.protectedBranches.has(branch) ||
        branch === stored.defaultBranch ||
        mergeRequests.some((mr) => mr.project === project && mr.source_branch === branch);
      if (!known) {
        throw notFound(PROVIDER, 'is_branch_protected', `branch ${branch}`);
      }
      return stored.protectedBranches.has(branch);
    },

    readCodeowners: async (project, _ref) => {
      core.enter('read_codeowners');
      if (!capabilities.codeowners) {
        throw new IntegrationUnsupportedError(PROVIDER, 'CODEOWNERS');
      }
      const stored = requireProject('read_codeowners', project);
      return stored.codeowners === null ? null : parseCodeowners(stored.codeowners);
    },

    listMergedMergeRequests: async (
      project,
      since,
      limit,
    ): Promise<readonly MergedMergeRequest[]> => {
      core.enter('list_merged_merge_requests');
      requireProject('list_merged_merge_requests', project);
      return mergeRequests
        .filter(
          (mr) =>
            mr.project === project &&
            mr.state === 'merged' &&
            mr.merged_at !== null &&
            Date.parse(mr.merged_at) >= Date.parse(since),
        )
        .slice(0, limit)
        .map((mr) => ({
          ref: {
            provider: PROVIDER,
            project_path: mr.project,
            iid: mr.iid,
            url: mrUrl(mr),
            branch: mr.source_branch,
            head_sha: mr.head_sha,
          },
          author: identityOf('human-reviewer'),
          merged_at: mr.merged_at as string,
          title: mr.title,
          diff_stats: mr.diff_stats,
          discussion_count: discussions.filter(
            (discussion) => discussion.project === mr.project && discussion.iid === mr.iid,
          ).length,
        }));
    },

    inbound,

    seedProject,

    setMergeability: (input) => {
      const only = [...projects.keys()][0];
      const project = input.project ?? only;
      if (project === undefined) {
        throw invalidRequest(PROVIDER, 'set_mergeability', 'no project is configured');
      }
      const mr = findMr(project, input.iid);
      if (mr === undefined) {
        throw notFound(PROVIDER, 'set_mergeability', `merge request ${project}!${input.iid}`);
      }
      mr.mergeable = input.mergeable;
      mr.has_conflicts = input.hasConflicts;
      return toMergeRequest(mr);
    },

    setPipeline: (input) => {
      requireProject('set_pipeline', input.project);
      pipelineCounter += 1;
      const pipeline: StoredPipeline = {
        id: `p-${pipelineCounter}`,
        project: input.project,
        head_sha: input.headSha,
        status: input.status,
        jobs: (input.jobs ?? []).map((job, index) => ({
          id: `${pipelineCounter}-${index + 1}`,
          name: job.name,
          status: job.status,
          log: job.log ?? null,
          allow_failure: job.allowFailure ?? false,
        })),
        coverage_pct: input.coveragePct ?? null,
        finished_at:
          input.status === 'pending' || input.status === 'running' ? null : core.clock.now(),
      };
      pipelines.push(pipeline);
      return toPipeline(pipeline);
    },

    moveDefaultBranch: (project, newHead) => {
      requireProject('move_default_branch', project).head = newHead;
    },

    addHumanDiscussion: (input) => {
      const mr = findMr(input.project, input.iid);
      if (mr === undefined) {
        throw notFound(PROVIDER, 'add_human_discussion', `merge request ${input.iid}`);
      }
      discussionCounter += 1;
      noteCounter += 1;
      const discussion: StoredDiscussion = {
        id: `disc-${discussionCounter}`,
        project: input.project,
        iid: input.iid,
        resolvable: true,
        resolved: false,
        notes: [
          {
            id: `n-${noteCounter}`,
            author: identityOf(input.authorId),
            body: input.text,
            created_at: core.clock.now(),
            path: input.path ?? null,
            line: input.line ?? null,
            system: false,
          },
        ],
      };
      discussions.push(discussion);
      return toDiscussion(discussion);
    },

    emitMergeRequestEvent: (input) => {
      const mr = findMr(input.project, input.iid);
      if (mr === undefined) {
        throw notFound(PROVIDER, 'emit', `merge request ${input.iid}`);
      }
      if (input.event === 'mr.merged') {
        mr.state = 'merged';
        mr.merged_at = core.clock.now();
      }
      if (input.event === 'mr.closed') {
        mr.state = 'closed';
      }
      return buildFakeDelivery({
        secret: core.webhookSecret,
        event: input.event,
        deliveryId: input.deliveryId ?? nextDeliveryId(),
        payload: { event: input.event, project: input.project, iid: input.iid },
      });
    },

    emitReviewComment: (input) =>
      buildFakeDelivery({
        secret: core.webhookSecret,
        event: 'mr.review.comment',
        deliveryId: input.deliveryId ?? nextDeliveryId(),
        payload: {
          event: 'mr.review.comment',
          project: input.project,
          iid: input.iid,
          discussion_id: input.discussionId,
          author_id: input.authorId,
          text: input.text,
          resolved: input.resolved ?? false,
        },
      }),

    emitPipelineFinished: (input) =>
      buildFakeDelivery({
        secret: core.webhookSecret,
        event: 'ci.pipeline.finished',
        deliveryId: input.deliveryId ?? nextDeliveryId(),
        payload: {
          event: 'ci.pipeline.finished',
          project: input.project,
          head_sha: input.headSha,
        },
      }),

    emitDefaultBranchMoved: (input) => {
      const project = requireProject('emit', input.project);
      project.head = input.newHead;
      return buildFakeDelivery({
        secret: core.webhookSecret,
        event: 'default_branch.moved',
        deliveryId: input.deliveryId ?? nextDeliveryId(),
        payload: {
          event: 'default_branch.moved',
          project: input.project,
          branch: project.defaultBranch,
          new_head: input.newHead,
        },
      });
    },
  };
};
