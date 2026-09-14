/**
 * `FakeGitProvider` — the in-memory provider behind the GitProvider contract suite and every
 * pipeline test that opens a merge request (technical/06, technical/10).
 *
 * It models the seven things the pipeline actually depends on: a project with a moving default
 * branch, merge requests with a draft flag, discussion threads that resolve, pipelines with job
 * logs, CODEOWNERS, short-lived credentials that can be revoked, and — since WP-18b — the files a
 * `commitFiles` call wrote, per branch.
 *
 * **A working copy is still deliberately absent**, and the distinction is the port's: clone,
 * rebase and push belong to the workspace manager (BD-025) and are how an *agent* changes a
 * repository, while `commitFiles` is the provider's own commits API — one request, whole files, no
 * checkout anywhere. This fake answers that endpoint and nothing more; divergence 9 says where it
 * is stricter and where it is kinder than GitLab.
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
 *  9. **Different, and the one place this fake holds repository content — `commitFiles`.** WP-18b
 *     gave the port a way to write whole files through the provider's API (no working copy: see the
 *     port's own docblock), so the fake keeps a map of `branch → path → content` and the sha of the
 *     commit that last wrote it. It is **stricter** than GitLab in the two ways that matter to a
 *     caller: `create` on a path that already exists on the branch and `update` on one that does not
 *     are both `invalid_request` (GitLab answers 400 with the same distinction), and naming
 *     `start_branch` for a branch that already exists is `conflict`. It is **kinder** in one: there
 *     is no merge, no rebase and no concurrent writer, so a commit can never fail because somebody
 *     else moved the branch. Whoever builds retry-on-conflict must not conclude from a green test
 *     here that the race does not exist.
 * 10. **Different — a merge request has the diff a test gave it, and no diff otherwise.** WP-24
 *     added `getMergeRequestDiff`, and this fake holds no repository content it could compute one
 *     from (see divergence 9 and the working-copy paragraph above), so `setDiff` seeds it and an
 *     unseeded merge request answers `[]`. It is **stricter** than GitLab in one way — `limit` is
 *     applied here rather than trusted, so a caller that asked for five files gets five — and
 *     **kinder** in two: a real provider paginates, computes `collapsed`/`too_large` from its own
 *     size rules, and may answer `404` for a merge request whose diff has been garbage-collected.
 *     A test that needs the omitted case seeds it (`omitted: true`), which is why the shared
 *     contract suite drives one.
 * 11. **Stricter — `resolveUserId` knows exactly the handles a test seeded, and `null` for every
 *     other.** WP-37 added the method so reviewer routing can turn a CODEOWNERS handle into the
 *     account id a merge request's reviewers are set by. A real provider searches its user
 *     directory: it can answer an account the platform has never heard of, it matches
 *     case-insensitively, and it may return several candidates for one query. The fake answers only
 *     what `seedUser` put in, which makes "this handle routes to nobody" the *default* in tests —
 *     the case the routing has to survive, since a `CODEOWNERS` naming a group or a departed
 *     colleague is the ordinary state of a real repository.
 * 12. **Different — `CODEOWNERS` belongs to a *ref*, and a ref this fake holds no file for has
 *     none.** Until WP-37 review round 2 the file was stored per **project** and `ref` was ignored,
 *     which made the one security property the reviewer routing rests on untestable: routing reads
 *     the file at the *default branch* precisely because a merge request may edit it and its author
 *     must not be able to appoint their own reviewer (BD-022), and with the ref ignored a build
 *     that read it from the branch under review passed every tier. Now `FakeProjectSeed.codeowners`
 *     is the **default branch's** file, `seedFile`/`commitFiles` put one on any branch (divergence
 *     9's store), and the file a ref holds wins for that ref. It is **stricter** than real git in
 *     one way, deliberately: a real branch carries the whole tree, so a task branch that never
 *     touched `CODEOWNERS` still has the default branch's copy, while here it answers `null` — a
 *     caller that read the wrong ref gets nothing rather than the right answer by accident. It is
 *     **kinder** in one: only the root `CODEOWNERS` path exists, where GitLab also looks in `docs/`
 *     and `.gitlab/`, so an adapter's search order is the shared contract suite's business and not
 *     this fake's.
 * 13. **Kinder — the pipeline webhook carries the pipeline's `coverage`, and GitLab's does not.**
 *     `normalise` fills `ci.pipeline.finished.coverage_pct` from the stored pipeline, which is what
 *     the port's payload *can* carry; the only real adapter this build ships publishes `null` there
 *     on every delivery, because GitLab's documented Pipeline Hook has no `coverage` on
 *     `object_attributes` or on `builds[]` (`gitlab/inbound.ts:281-283`). It is left kinder rather
 *     than narrowed to GitLab's shape because the field is the **port's**, and a fake that emptied
 *     it would make a provider that does publish coverage untestable here. The consequence is
 *     stated where it bites: a platform feature that read the *event's* number would be green on
 *     this fake and blank in production, which is why WP-39's coverage duty reads
 *     `getPipelineStatus` for both sides and ignores the payload field entirely
 *     (`packages/application/src/pipeline/coverage.ts`). Anything else that reaches for
 *     `coverage_pct` on a delivery owes itself the same check.
 * 14. **Different — `base_sha` is the target branch's head at the moment the merge request was
 *     created, and never moves afterwards.** WP-34 added the field to the port because a shadow
 *     run has to be checked out at the commit the human branched from (Q82 (a)), and this fake has
 *     no commit graph to compute a merge base from (divergence 9). So `openMergeRequest` records
 *     the target branch's current head and `seedMergedMergeRequest` takes one explicitly. It is
 *     **kinder** than GitLab in one way that is worth knowing before trusting a green test: a real
 *     `diff_refs` is *"empty when the merge request is created, and populates asynchronously"*, so
 *     production sees `base_sha: null` for a window this fake never has — which is exactly why the
 *     shadow batch's refusal branch is driven here explicitly (`seedMergedMergeRequest` with
 *     `baseSha: null`) rather than left to arise.
 */
import {
  type CodeownersRules,
  type CommitFilesRequest,
  type CommitRef,
  type CredentialScope,
  type Discussion,
  type FileDiff,
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

/** The one path this fake keeps a `CODEOWNERS` at (divergence 12's kinder half). */
const CODEOWNERS_PATH = 'CODEOWNERS';

export interface FakeProjectSeed {
  readonly path: string;
  readonly defaultBranch?: string;
  readonly head?: string;
  /**
   * Raw CODEOWNERS text **at the default branch**; `null` when the project has none.
   *
   * Divergence 12: the file belongs to a ref. Another branch's copy is planted with `seedFile`
   * (path `CODEOWNERS`) or written by `commitFiles`, and it is visible only at that branch.
   */
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
  /** Handle (as CODEOWNERS writes it) → the account id reviewers are set by (WP-37). */
  readonly users?: Readonly<Record<string, string>>;
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
  /** Divergence 14: the target branch's head when the merge request was created. */
  base_sha: string | null;
  /** Divergence 10: what `getMergeRequestDiff` answers, seeded by `setDiff`. */
  files: FileDiff[];
}

/** One branch of one project, with the files this fake has been asked to write on it. */
interface StoredBranch {
  project: string;
  name: string;
  head: string;
  files: Map<string, string>;
}

/** One commit `commitFiles` made, kept so a test can assert what was written and with what message. */
export interface FakeCommit {
  readonly project: string;
  readonly branch: string;
  readonly sha: string;
  readonly message: string;
  readonly author: { readonly name: string | null; readonly email: string | null };
  readonly files: readonly { readonly path: string; readonly content: string }[];
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
  /** Maps a handle to the account id `resolveUserId` answers with (divergence 11). */
  seedUser(handle: string, externalId: string): void;
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
  /**
   * Sets what `getMergeRequestDiff` answers for a merge request — divergence 10 made reachable.
   *
   * A `diff` of `null` together with `omitted: true` is the case a real provider produces for a
   * file it will not render (GitLab's `collapsed`/`too_large`, GitHub's missing `patch`), and it is
   * the one a caller is most likely to get wrong, so it is seedable rather than only describable.
   */
  setDiff(input: {
    readonly project?: string;
    readonly iid: number;
    readonly files: readonly {
      readonly path: string;
      readonly oldPath?: string;
      readonly diff?: string | null;
      readonly newFile?: boolean;
      readonly renamedFile?: boolean;
      readonly deletedFile?: boolean;
      readonly omitted?: boolean;
    }[];
  }): void;
  /**
   * A merge request a **human** merged, already in the past — WP-34's shadow comparison.
   *
   * `listMergedMergeRequests` only ever answered merge requests this fake opened and then saw an
   * `mr.merged` event for, which are the agent's own: a shadow batch compares against somebody
   * else's history, and there was no way to give the fake any. `baseSha` is explicitly nullable so
   * that Q82 (a)'s refusal — a merge request whose merge base the provider does not publish — is a
   * case a test can drive rather than one that has to be waited for (divergence 14).
   */
  seedMergedMergeRequest(input: {
    readonly project?: string;
    readonly title: string;
    readonly branch: string;
    readonly mergedAt: string;
    readonly baseSha?: string | null;
    readonly headSha?: string;
    readonly diffStats?: DiffStats | null;
    readonly files?: readonly {
      readonly path: string;
      readonly diff?: string | null;
      readonly omitted?: boolean;
    }[];
  }): MergeRequest;
  /** Moves the default branch, as a merge on another MR would. */
  moveDefaultBranch(project: string, newHead: string): void;
  /** Every commit `commitFiles` made, oldest first. */
  readonly commits: readonly FakeCommit[];
  /** The content of a file on a branch, or `null` when the branch does not have it. */
  fileAt(project: string, branch: string, path: string): string | null;
  /** Seeds a file on a branch without a commit — the state a repository was already in. */
  seedFile(input: {
    readonly project: string;
    readonly branch: string;
    readonly path: string;
    readonly content: string;
  }): void;
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
  const branches = new Map<string, StoredBranch>();
  const commits: FakeCommit[] = [];
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

  const users = new Map<string, string>(Object.entries(options.users ?? {}));
  const seedUser = (handle: string, externalId: string): void => {
    users.set(handle, externalId);
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

  const branchKey = (project: string, branch: string): string => `${project}\u0000${branch}`;

  const branchOf = (project: string, branch: string): StoredBranch | undefined =>
    branches.get(branchKey(project, branch));

  const seedFile = (input: {
    readonly project: string;
    readonly branch: string;
    readonly path: string;
    readonly content: string;
  }): void => {
    const existing = branchOf(input.project, input.branch);
    const target =
      existing ??
      ({
        project: input.project,
        name: input.branch,
        head: nextSha(),
        files: new Map<string, string>(),
      } satisfies StoredBranch);
    target.files.set(input.path, input.content);
    branches.set(branchKey(input.project, input.branch), target);
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
      base_sha: mr.base_sha,
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

  /**
   * The `CODEOWNERS` **at one ref** — divergence 12, and the reason it is a function.
   *
   * A branch that holds the file answers with it, so a merge request that edits `CODEOWNERS`
   * (through `commitFiles`, or `seedFile` for a repository that was already in that state) is
   * visible at *its* branch and nowhere else. Everything else answers the seed, and only at the
   * default branch: that is the copy the change cannot rewrite, which is what makes a caller
   * reading the wrong ref fail loudly here instead of passing.
   */
  const codeownersAt = (stored: StoredProject, ref: string): string | null => {
    const onRef = branchOf(stored.path, ref)?.files.get(CODEOWNERS_PATH);
    if (onRef !== undefined) {
      return onRef;
    }
    return ref === stored.defaultBranch ? stored.codeowners : null;
  };

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

    commitFiles: async (request: CommitFilesRequest): Promise<CommitRef> => {
      core.enter('commit_files');
      const project = requireProject('commit_files', request.project);
      const existing = branchOf(request.project, request.branch);
      const start = request.start_branch ?? null;

      if (start !== null && existing !== undefined) {
        // Divergence 9: naming a start branch is *creating* a branch, and the branch is there.
        throw conflict(
          PROVIDER,
          'commit_files',
          `branch ${request.branch} already exists on ${request.project}`,
        );
      }
      if (start === null && existing === undefined) {
        throw notFound(PROVIDER, 'commit_files', `branch ${request.branch} on ${request.project}`);
      }
      if (
        start !== null &&
        start !== project.defaultBranch &&
        branchOf(request.project, start) === undefined
      ) {
        throw notFound(PROVIDER, 'commit_files', `branch ${start} on ${request.project}`);
      }

      // A branch created from another starts with that branch's files; the default branch is
      // whatever was seeded onto it (usually nothing), which is how a first knowledge commit works.
      const base =
        existing ??
        ({
          project: request.project,
          name: request.branch,
          head: project.head,
          files: new Map(
            start === null ? [] : (branchOf(request.project, start)?.files ?? new Map()),
          ),
        } satisfies StoredBranch);

      // Validated *before* anything is written: the port promises the commit is atomic, so a fake
      // that applied the first action and then refused the second would be kinder than the real
      // provider in the one way a caller cannot see (rule 1).
      for (const action of request.actions) {
        const present = base.files.has(action.path);
        if (action.action === 'create' && present) {
          throw invalidRequest(
            PROVIDER,
            'commit_files',
            `a file with the name ${action.path} already exists on branch ${request.branch}`,
          );
        }
        if (action.action === 'update' && !present) {
          throw invalidRequest(
            PROVIDER,
            'commit_files',
            `${action.path} does not exist on branch ${request.branch}`,
          );
        }
      }

      for (const action of request.actions) {
        base.files.set(action.path, action.content);
      }
      const sha = nextSha();
      base.head = sha;
      branches.set(branchKey(request.project, request.branch), base);
      commits.push({
        project: request.project,
        branch: request.branch,
        sha,
        message: request.message,
        author: { name: request.author_name ?? null, email: request.author_email ?? null },
        files: request.actions.map((action) => ({ path: action.path, content: action.content })),
      });
      return {
        sha,
        branch: request.branch,
        url: `${baseUrl}/${request.project}/-/commit/${sha}`,
      };
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
        // Divergence 14: no commit graph, so the target branch's head now *is* the merge base.
        base_sha: branchOf(draft.project, draft.target)?.head ?? project.head,
        files: [],
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
      const path = note.path ?? null;
      const line = note.line ?? null;
      // The port's refusal, reproduced rather than tolerated: an anchor with only half of itself is
      // one no provider can place, and a fake that accepted it would let a caller ship a finding
      // that silently arrives unanchored (WP-24).
      if ((path === null) !== (line === null)) {
        throw invalidRequest(
          PROVIDER,
          'create_discussion',
          'a diff note needs both a path and a line, or neither',
        );
      }
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
            path,
            line,
            system: false,
          },
        ],
      };
      discussions.push(discussion);
      return toDiscussion(discussion);
    },

    getMergeRequestDiff: async (mrRef, options) => {
      core.enter('get_merge_request_diff');
      const mr = requireMr('get_merge_request_diff', mrRef);
      // Divergence 10: `limit` is applied here, so a caller that asked for five files gets five.
      return mr.files.slice(0, Math.max(0, options.limit)).map((file) => ({ ...file }));
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

    /**
     * Divergence 11: exactly what was seeded, and `null` for everything else.
     *
     * The leading `@` is not stripped, because a handle is passed to the port **as written** and
     * what one means is the provider's business — so a test that seeds `@dana` and a routing that
     * asks for `dana` disagree here, which is the honest reproduction of a real directory lookup.
     */
    resolveUserId: async (handle: string) => {
      core.enter('resolve_user_id');
      return users.get(handle) ?? null;
    },

    readCodeowners: async (project, ref) => {
      core.enter('read_codeowners');
      if (!capabilities.codeowners) {
        throw new IntegrationUnsupportedError(PROVIDER, 'CODEOWNERS');
      }
      const stored = requireProject('read_codeowners', project);
      const text = codeownersAt(stored, ref);
      return text === null ? null : parseCodeowners(text);
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
    seedUser,
    seedFile,
    commits,
    fileAt: (project: string, branch: string, path: string) =>
      branchOf(project, branch)?.files.get(path) ?? null,

    setDiff: (input) => {
      const project = input.project ?? projectOf({ iid: input.iid, url: '' });
      const mr = findMr(project, input.iid);
      if (mr === undefined) {
        throw notFound(PROVIDER, 'set_diff', `merge request ${project}!${input.iid}`);
      }
      mr.files = input.files.map((file) => ({
        new_path: file.path,
        old_path: file.oldPath ?? file.path,
        diff: file.diff === undefined ? `@@ -1 +1 @@\n-old\n+new in ${file.path}\n` : file.diff,
        new_file: file.newFile ?? false,
        renamed_file: file.renamedFile ?? false,
        deleted_file: file.deletedFile ?? false,
        omitted: file.omitted ?? false,
      }));
    },

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

    seedMergedMergeRequest: (input) => {
      const only = [...projects.keys()][0];
      const projectPath = input.project ?? only;
      if (projectPath === undefined) {
        throw invalidRequest(PROVIDER, 'seed_merged_merge_request', 'no project is configured');
      }
      const project = requireProject('seed_merged_merge_request', projectPath);
      const mr: StoredMergeRequest = {
        project: projectPath,
        iid: project.nextIid,
        state: 'merged',
        draft: false,
        title: input.title,
        description: '',
        source_branch: input.branch,
        target_branch: project.defaultBranch,
        head_sha: input.headSha ?? nextSha(),
        mergeable: true,
        has_conflicts: false,
        diff_stats: input.diffStats === undefined ? null : input.diffStats,
        coverage_pct: null,
        labels: [],
        reviewers: [],
        merged_at: input.mergedAt,
        base_sha: input.baseSha === undefined ? project.head : input.baseSha,
        files: (input.files ?? []).map((file) => ({
          new_path: file.path,
          old_path: file.path,
          diff: file.diff ?? null,
          new_file: false,
          renamed_file: false,
          deleted_file: false,
          omitted: file.omitted ?? false,
        })),
      };
      project.nextIid += 1;
      mergeRequests.push(mr);
      return toMergeRequest(mr);
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
