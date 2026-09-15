/**
 * The **GitProvider** type port — technical/06 § "GitProvider", product/08 § "Git provider".
 *
 * GitLab (gitlab.com and self-managed) is the first provider (WP-09); GitHub is the second one
 * this contract is designed for, which is why nothing here says "merge request" in a way that
 * cannot mean "pull request".
 *
 * **The port never touches a working copy.** Clone, branch, commit, rebase and push are the
 * workspace manager's job, with `git` and a credential helper (BD-025); this port hands out the
 * clone URL and mints the short-lived credential, and everything else it does is API work. That
 * split is why `mintCredential` exists at all, and why its result is the one value in these ports
 * that must never be persisted, logged or put in an audit payload.
 */
import {
  ciStatusSchema,
  coveragePctSchema,
  diffStatsSchema,
  isoDateTimeSchema,
  mergeRequestRefSchema,
  nonEmptyStringSchema,
  shaSchema,
  urlSchema,
} from '@platform/contracts';
import * as z from 'zod';
import { externalIdentitySchema, type InboundNormaliser, type IntegrationPort } from './common.js';

// ── Data ─────────────────────────────────────────────────────────────────────

export const mergeRequestStateSchema = z.enum(['opened', 'merged', 'closed', 'locked']);

/**
 * A merge request as the pipeline sees it.
 *
 * `mergeable` and `has_conflicts` are separate on purpose: a provider that has not finished its
 * mergeability check reports `mergeable: null`, which the rebase gate must treat as "unknown, ask
 * again" rather than as "conflicted" (product/08, WP-26).
 */
export const mergeRequestSchema = z.strictObject({
  ref: mergeRequestRefSchema,
  state: mergeRequestStateSchema,
  draft: z.boolean(),
  title: z.string(),
  /** Untrusted markdown (BD-022) — humans and agents both write here. */
  description: z.string(),
  source_branch: nonEmptyStringSchema,
  target_branch: nonEmptyStringSchema,
  head_sha: shaSchema,
  /**
   * The commit this merge request's diff is taken **against** — the merge base (WP-34).
   *
   * On the single merge request and deliberately not on {@link mergedMergeRequestSchema}: GitLab
   * publishes `diff_refs` on *"Retrieve a merge request"* and **not** on *"List project merge
   * requests"* (measured against docs.gitlab.com/api/merge_requests on 2026-09-14), so a field on
   * the list shape would be a field every adapter had to invent. A caller that needs the base pays
   * one request per merge request, which is what `shadow/batch.ts` does for the one it selected.
   *
   * `null` is a first-class answer and must not be an exception: GitLab's own documentation says
   * `diff_refs` is *"empty when the merge request is created, and populates asynchronously"*, and a
   * provider that publishes no base at all is a provider this field simply cannot answer for. The
   * shadow batch **refuses the ticket by name** when it is null (Q82 (a)) rather than falling back
   * to the default branch, which would measure drift instead of similarity.
   */
  base_sha: shaSchema.nullish(),
  mergeable: z.boolean().nullish(),
  has_conflicts: z.boolean().nullish(),
  diff_stats: diffStatsSchema.nullish(),
  coverage_pct: coveragePctSchema.nullish(),
  labels: z.array(nonEmptyStringSchema),
  reviewers: z.array(externalIdentitySchema),
  author: externalIdentitySchema.nullish(),
  web_url: urlSchema,
  merged_at: isoDateTimeSchema.nullish(),
});

/** One note inside a discussion thread. `body` is untrusted (BD-022). */
export const discussionNoteSchema = z.strictObject({
  id: nonEmptyStringSchema,
  author: externalIdentitySchema,
  body: z.string(),
  created_at: isoDateTimeSchema,
  /** Set on a diff note; `null` on a plain thread. */
  path: nonEmptyStringSchema.nullish(),
  line: z.int().positive().nullish(),
  system: z.boolean(),
});

/**
 * A discussion thread. `resolvable` and `resolved` are distinct because provider system notes are
 * neither: a code-review loop that treats "not resolvable" as "unresolved" never terminates.
 */
export const discussionSchema = z.strictObject({
  id: nonEmptyStringSchema,
  resolvable: z.boolean(),
  resolved: z.boolean(),
  notes: z.array(discussionNoteSchema),
});

/**
 * One file's patch, as the provider reports it (WP-24).
 *
 * The shape is the intersection of what a provider can answer, not one vendor's: GitLab's
 * `GET …/merge_requests/:iid/diffs` publishes `old_path`, `new_path`, `diff`, `new_file`,
 * `renamed_file`, `deleted_file` and — since 18.4 — `collapsed`/`too_large`; GitHub's
 * `GET …/pulls/:n/files` publishes `filename`, `previous_filename`, `status` and `patch`, and omits
 * `patch` for a file that is too large. So both halves of *"here is the path, and here is the patch
 * if you may have it"* exist on both, and {@link fileDiffSchema} names them once.
 *
 * `diff` is **untrusted** (BD-022): it is somebody's source code, and on a fork workflow it is
 * somebody unknown's.
 */
export const fileDiffSchema = z.strictObject({
  /** The file's path after the change. */
  new_path: nonEmptyStringSchema,
  /** Before the change; equal to `new_path` when the file was not renamed. */
  old_path: nonEmptyStringSchema,
  /** The provider's patch text, or `null` when it declined to produce one — see `omitted`. */
  diff: z.string().nullish(),
  new_file: z.boolean(),
  renamed_file: z.boolean(),
  deleted_file: z.boolean(),
  /**
   * The provider has a patch and did not send it (GitLab `collapsed`/`too_large`, GitHub's missing
   * `patch`).
   *
   * Distinct from `diff: null` only in what it lets a caller *say*: "this file changed and the
   * platform was not shown how" is a fact a review must print, and a caller that cannot tell it
   * from "no patch" prints nothing. Standing rule 18 — the absent case must not be the quiet one.
   */
  omitted: z.boolean(),
});

export type FileDiff = z.infer<typeof fileDiffSchema>;

/** Terminal statuses come from `ciStatusSchema`; a pipeline can also still be in flight. */
export const pipelineStatusValueSchema = z.enum([
  ...ciStatusSchema.options,
  'pending',
  'running',
  'manual',
]);

export const pipelineJobSchema = z.strictObject({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  status: pipelineStatusValueSchema,
  /** Opaque handle for `getJobLog`; `null` when the provider keeps no log for this job. */
  log_ref: nonEmptyStringSchema.nullish(),
  allow_failure: z.boolean(),
});

export const pipelineStatusSchema = z.strictObject({
  id: nonEmptyStringSchema,
  head_sha: shaSchema,
  status: pipelineStatusValueSchema,
  url: urlSchema.nullish(),
  jobs: z.array(pipelineJobSchema),
  coverage_pct: coveragePctSchema.nullish(),
  finished_at: isoDateTimeSchema.nullish(),
});

/** CODEOWNERS, parsed. Patterns keep provider syntax; owners keep their `@` prefix. */
export const codeownersRulesSchema = z.strictObject({
  rules: z.array(
    z.strictObject({
      pattern: nonEmptyStringSchema,
      owners: z.array(nonEmptyStringSchema),
    }),
  ),
});

/** One merged MR of the history bootstrap and the shadow comparison (technical/06). */
export const mergedMergeRequestSchema = z.strictObject({
  ref: mergeRequestRefSchema,
  author: externalIdentitySchema,
  merged_at: isoDateTimeSchema,
  title: z.string(),
  diff_stats: diffStatsSchema.nullish(),
  discussion_count: z.int().nonnegative(),
});

/**
 * One commit of the repository's own history — product/19 §18's *"commit messages"* (WP-35).
 *
 * Read for the **history bootstrap** and for nothing else on this build: the delivery pipeline
 * learns what changed from a merge request's diff, and a commit list is the thing a *convention*
 * shows up in (the message format R10 is about, the size of a typical change, who touches what).
 *
 * `message` is the **whole** message, subject and body, because the convention is often in the body
 * — a trailer, a ticket reference, a `Co-authored-by`. It is provider text like every other string
 * here (BD-022) and the caller bounds it at its own consumer; the adapter does not truncate, so
 * that a caller that needs the whole thing can have it and a caller that does not can say so
 * (`ticket-snapshot.ts`'s "bound at the consumer" answer to Q54).
 */
export const repositoryCommitSchema = z.strictObject({
  sha: shaSchema,
  /** Subject and body, verbatim. Untrusted (BD-022). */
  message: z.string(),
  /** The author's display name as the provider renders it, not an identity the platform mapped. */
  author: z.string(),
  committed_at: isoDateTimeSchema,
  url: urlSchema.nullish(),
});

/** Longest merge-request description the platform sends; GitLab's own limit is ~1 MB. */
export const MAX_MERGE_REQUEST_DESCRIPTION_CHARS = 32_768;

export const mergeRequestDraftSchema = z.strictObject({
  project: nonEmptyStringSchema,
  branch: nonEmptyStringSchema,
  target: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  /**
   * Markdown a human reads. Bounded at WP-18b for the same reason the commit message is: the
   * Librarian's body carries a ticket key and a page path, and an unbounded string on a provider
   * request is a request whose size somebody else chooses.
   */
  description: z.string().max(MAX_MERGE_REQUEST_DESCRIPTION_CHARS),
  draft: z.boolean(),
  labels: z.array(nonEmptyStringSchema),
  /** Provider user ids, not emails — reviewer routing resolves CODEOWNERS beforehand. */
  reviewers: z.array(nonEmptyStringSchema),
  remove_source_branch: z.boolean(),
});

/**
 * One file the platform writes in a {@link CommitFilesRequest}.
 *
 * There is no `delete`, and that is a property of this port rather than of its one caller: the only
 * thing the platform commits is a knowledge page (WP-18b), and product/05 keeps a superseded page
 * and marks it rather than removing it. A provider adapter that grew a delete would be offering the
 * pipeline a capability nothing has decided to give it.
 */
export const commitActionSchema = z.strictObject({
  action: z.enum(['create', 'update']),
  /** Repository-relative. The caller has already decided it is a path it is allowed to write. */
  path: nonEmptyStringSchema,
  /** The file's whole new content, never a patch. */
  content: z.string(),
});

/**
 * Longest commit message the platform sends.
 *
 * A commit message is **line-structured** and is assembled from provider text (a ticket key) and
 * from model-chosen paths, so it needs a ceiling that does not depend on either staying small. The
 * platform's own builder is already bounded well under this — twenty path lines of at most 200
 * characters plus twenty trailers of at most 64 + 36 — so reaching it means a caller built
 * something else, which is exactly when a bound is worth having (standing rule 22: the outer guard
 * is named, this is the layer behind it, and `knowledgeWrites.commit` parses so the layer has a
 * seam rather than being unreachable by construction).
 */
export const MAX_COMMIT_MESSAGE_CHARS = 16_384;

/**
 * A commit made through the provider's API, with no working copy (technical/06, BD-025).
 *
 * The port's own docblock says clone, branch, commit, rebase and push belong to the workspace
 * manager — and they still do for an agent's own work, which happens in a workspace with a minted
 * credential. This is the other case: the platform itself writing a small, bounded set of files it
 * chose, on a branch it names, with no checkout anywhere. Every provider worth supporting has such
 * an endpoint (GitLab's commits API, GitHub's contents/trees API), and the alternative — giving the
 * platform process a workspace to run `git` in — would put a checkout and a push credential in the
 * process TD-021 keeps away from both.
 *
 * `start_branch` is what makes the branch: absent, the commit lands on `branch` and the branch must
 * already exist; present, `branch` is created from it. A caller that names an existing `branch`
 * **and** a `start_branch` is asking the provider to create a branch that is already there, which
 * is an error rather than a fast-forward.
 */
export const commitFilesRequestSchema = z.strictObject({
  project: nonEmptyStringSchema,
  branch: nonEmptyStringSchema,
  start_branch: nonEmptyStringSchema.nullish(),
  /** The whole commit message, provenance trailer included (technical/07 `Agentic-Source:`). */
  message: nonEmptyStringSchema.max(MAX_COMMIT_MESSAGE_CHARS),
  author_name: nonEmptyStringSchema.nullish(),
  author_email: nonEmptyStringSchema.nullish(),
  actions: z.array(commitActionSchema).min(1),
});

/** What a commit that happened is, as the platform records it. */
export const commitRefSchema = z.strictObject({
  sha: shaSchema,
  branch: nonEmptyStringSchema,
  url: urlSchema.nullish(),
});

export const mergeRequestUpdateSchema = z.strictObject({
  title: nonEmptyStringSchema.nullish(),
  description: z.string().nullish(),
  draft: z.boolean().nullish(),
  labels: z.array(nonEmptyStringSchema).nullish(),
  reviewers: z.array(nonEmptyStringSchema).nullish(),
});

export type MergeRequestState = z.infer<typeof mergeRequestStateSchema>;
export type MergeRequest = z.infer<typeof mergeRequestSchema>;
export type MergeRequestRefInput = z.infer<typeof mergeRequestRefSchema>;
export type Discussion = z.infer<typeof discussionSchema>;
export type DiscussionNote = z.infer<typeof discussionNoteSchema>;
export type PipelineStatus = z.infer<typeof pipelineStatusSchema>;
export type PipelineStatusValue = z.infer<typeof pipelineStatusValueSchema>;
export type CodeownersRules = z.infer<typeof codeownersRulesSchema>;
export type MergedMergeRequest = z.infer<typeof mergedMergeRequestSchema>;
export type RepositoryCommit = z.infer<typeof repositoryCommitSchema>;
export type MergeRequestDraft = z.infer<typeof mergeRequestDraftSchema>;
export type MergeRequestUpdate = z.infer<typeof mergeRequestUpdateSchema>;
export type CommitAction = z.infer<typeof commitActionSchema>;
export type CommitFilesRequest = z.infer<typeof commitFilesRequestSchema>;
export type CommitRef = z.infer<typeof commitRefSchema>;

// ── Credentials ──────────────────────────────────────────────────────────────

/** What a minted credential may be used for. `push:agentic/*` is BD-025's branch namespace. */
export type CredentialScope = 'read' | 'push';

/**
 * A short-lived credential for one workspace.
 *
 * **Not a zod-validated wire shape, and deliberately not one**: `value` is a secret, so this
 * object must never reach `integration_actions.payload`, a log line or an event. The contract
 * suite asserts that the audit payload of `mint_credential` contains no field holding the value
 * (TD-012, BD-002).
 */
export interface MintedCredential {
  /** Username the git credential helper should send, when the provider needs one. */
  readonly username: string | null;
  /** The secret. Handled only by the workspace manager and the runner. */
  readonly value: string;
  readonly scope: CredentialScope;
  /** Branch patterns the credential may push to; empty for a read-only credential. */
  readonly branchPatterns: readonly string[];
  readonly expiresAt: string;
  /** Provider handle so the credential can be revoked when the workspace is destroyed. */
  readonly revokeId: string | null;
}

// ── Capabilities ─────────────────────────────────────────────────────────────

export interface GitProviderCapabilities {
  readonly webhooks: boolean;
  /** Project access tokens (GitLab Premium / self-managed) — otherwise a bot PAT is used. */
  readonly projectTokens: boolean;
  readonly groupTokens: boolean;
  readonly codeowners: boolean;
  /**
   * Whether the provider can hand back a coverage **artifact** — and **nothing in this build reads
   * this flag or downloads one** (WP-39).
   *
   * Said here rather than left to be inferred, because it is what bounds the coverage feature:
   * `PipelineStatus.coverage_pct` is **one percentage for a whole pipeline**, so the delta the
   * Checks panel shows is one number for the whole change and never a per-file figure. Per-file
   * coverage is this artifact, parsed — which is a work package nobody has scheduled, and which is
   * why `policies.coverage_source` has no `'artifact'` value to promise it.
   */
  readonly coverageArtifacts: boolean;
  /** Whether pipelines run on draft merge requests. */
  readonly draftPipelines: boolean;
  /** Thread resolution API (`resolveDiscussion`). */
  readonly discussionResolution: boolean;
  /** Credential minting; `false` means the operator's static bot token is used as-is. */
  readonly credentialMinting: boolean;
}

/** Catalogue events a git delivery can produce (technical/02). */
export type GitProviderInboundEvent =
  | 'mr.opened'
  | 'mr.updated'
  | 'mr.merged'
  | 'mr.closed'
  | 'mr.review.comment'
  | 'ci.pipeline.finished'
  | 'default_branch.moved';

// ── The port ─────────────────────────────────────────────────────────────────

export interface GitProviderPort extends IntegrationPort<GitProviderCapabilities> {
  /**
   * The URL the workspace manager clones from, with the credential embedded when the provider
   * needs it there. Secret-bearing: never logged, never stored (BD-025).
   *
   * @throws {IntegrationError} `invalid_request` when the credential has been revoked or has
   * expired. This is an obligation on the *adapter*, not something the provider answers: it minted
   * and revoked the credential itself, so it knows. Written down here because the shared contract
   * suite asserts it, and a provider work package should learn it from the port rather than from a
   * failing suite (WP-07 review round 1).
   */
  cloneUrl(project: string, credential: MintedCredential): string;

  /**
   * Mints a short-lived credential for one workspace.
   *
   * @throws {IntegrationUnsupportedError} when `capabilities().credentialMinting` is false.
   */
  mintCredential(request: {
    readonly project: string;
    readonly scope: CredentialScope;
    readonly branchPatterns?: readonly string[];
    readonly ttlSeconds: number;
  }): Promise<MintedCredential>;

  /**
   * Revokes a credential minted earlier. Safe to call twice — the second call is a no-op, and an
   * adapter that has already revoked the handle discharges that without asking the provider.
   *
   * Two obligations on the adapter, both learned the hard way at WP-09 review round 1:
   *
   *  - **A minted credential carries its own revocation address.** `mintCredential` is given a
   *    project, which need not be the project the binding names, and `revokeCredential` is given
   *    only the credential back — so `revokeId` has to say *where* the credential lives, not just
   *    which one it is. Revoking against the binding's project sends the delete somewhere the
   *    token is not.
   *  - **An adapter may not report a revocation it cannot substantiate.** A provider's "no such
   *    credential" is evidence of "already gone" only for a handle *this* adapter minted at that
   *    address; for any other handle it is indistinguishable from "never existed here", and
   *    absorbing it tells the caller a live credential is dead. Refuse (`not_found`) instead.
   *
   * @throws {IntegrationError} `not_found` when the provider denies knowing a credential this
   * adapter did not mint. `invalid_request` when `revokeId` is not a handle this adapter wrote.
   */
  revokeCredential(credential: MintedCredential): Promise<void>;

  /**
   * Writes a set of whole files as **one commit**, on a branch, through the provider's API.
   *
   * Atomic by construction: a provider that cannot apply every action applies none, so a partly
   * written knowledge commit is not a state a caller has to reason about. The failure modes a
   * caller must handle are stated rather than discovered — an action that creates a file that
   * exists, or updates one that does not, is `invalid_request`; a branch that already exists when
   * `start_branch` is given is `conflict`; and a credential without push rights is `forbidden`.
   *
   * **It is a mutation** (technical/06): every call goes through `IntegrationActionExecutor`, so a
   * shadow-mode caller never reaches it.
   *
   * @throws {IntegrationError} as above; `not_found` for a project or a `start_branch` that is not
   * there.
   */
  commitFiles(request: CommitFilesRequest): Promise<CommitRef>;

  openMergeRequest(draft: MergeRequestDraft): Promise<MergeRequest>;
  updateMergeRequest(ref: MergeRequestRefInput, update: MergeRequestUpdate): Promise<MergeRequest>;
  getMergeRequest(ref: MergeRequestRefInput): Promise<MergeRequest>;

  listDiscussions(ref: MergeRequestRefInput): Promise<readonly Discussion[]>;
  replyToDiscussion(
    ref: MergeRequestRefInput,
    discussionId: string,
    markdown: string,
  ): Promise<Discussion>;
  /** Idempotent: resolving an already-resolved thread succeeds and changes nothing. */
  resolveDiscussion(ref: MergeRequestRefInput, discussionId: string): Promise<Discussion>;
  /**
   * A thread on a merge request — anchored to a diff line, or on the merge request itself.
   *
   * technical/06 lists it as `createDiscussion(mr, {path, line, markdown})  # review findings`, and
   * that is still the important case. `path` and `line` became nullable at **WP-24**, because
   * review-only mode owes the merge request *"a neutral summary"* (product/18) as well as its
   * findings, and a summary is about the change rather than about a line of it. Both providers
   * this contract is designed for answer both from one endpoint (GitLab posts a thread with or
   * without a `position`; GitHub has two endpoints and an adapter picks).
   *
   * The two are given together or not at all: a `path` with no `line` is an anchor no provider can
   * place, so it is `invalid_request` rather than a silently unanchored thread — a finding that
   * quietly moved off its line is a finding a reviewer cannot act on.
   *
   * **It is a mutation** (technical/06): every call goes through `IntegrationActionExecutor`, so a
   * shadow-mode caller never reaches it.
   *
   * @throws {IntegrationError} `invalid_request` when exactly one of `path` and `line` is given.
   */
  createDiscussion(
    ref: MergeRequestRefInput,
    note: {
      readonly path?: string | null;
      readonly line?: number | null;
      readonly markdown: string;
    },
  ): Promise<Discussion>;

  /**
   * The files a merge request changes, with their patches — technical/04's *"`review_only` |
   * Reviewer role on a human MR: read-only tools, **diff from provider**"* (WP-24).
   *
   * On the port rather than on one adapter for BD-017's reason: review-only mode is pipeline
   * behaviour, and the pipeline may not know which provider it is talking to.
   *
   * **Its second reader is the dependency gate** (WP-38), which is the first thing in this platform
   * to read a `diff` rather than a path: `detectDependencyChanges` parses the *added lines* of a
   * manifest or lockfile patch. So `diff: null` and `omitted` are load-bearing there too — a file
   * the provider will not render is a file the gate cannot answer about, and it says so rather than
   * reporting that nothing was added.
   *
   * `limit` bounds the **number of files**, and the adapter applies it: a merge request with four
   * thousand files is a request whose size somebody else chose, and paginating all of it to throw
   * most of it away costs the provider's rate limit rather than ours. A caller learns that it was
   * cut by getting exactly `limit` entries back — the count the provider would have returned is
   * **not** part of this answer, because no provider publishes it without fetching every page.
   *
   * It is a **read**, so it is performed in every mode (technical/06: a shadow task needs its
   * context).
   *
   * @throws {IntegrationError} `not_found` when the merge request does not exist.
   */
  getMergeRequestDiff(
    ref: MergeRequestRefInput,
    options: { readonly limit: number },
  ): Promise<readonly FileDiff[]>;

  /** Latest pipeline for a commit, or `null` when none has run yet. */
  getPipelineStatus(project: string, headSha: string): Promise<PipelineStatus | null>;
  /**
   * The **tail** of a job log: CI logs are large and untrusted (BD-022).
   *
   * **The returned string is redacted by the adapter, and the ordering is the obligation.** A CI job
   * log is the text most likely to contain a token the platform itself injected — a masked variable
   * is masked by *that* CI provider, not by ours, and a failing job prints the command it ran — and
   * it is *read to be handed to an agent and stored with the task*, so redacting the audit row is
   * not enough (the executor returns the raw result). An adapter therefore applies TD-012's
   * redactor, composed with one over its own binding credentials, **before it takes the tail**: a
   * cut applied first leaves the leading bytes of a token in the string, and an exact-match
   * redactor can never find them again. GitLab does it at the transport (`gitlab/http.ts`,
   * property 4) and `emitted-secrets.test.ts` plants the binding token in a trace to prove it.
   *
   * **Still open, and not dischargeable as this sentence used to promise it (Q55).** It read: a
   * *run-scoped* credential is not known to the adapter, "so the caller passes it in
   * `ProviderCreateInput.redactor`". The ordering forbids it for the credential that matters most
   * — `create()` runs once when the binding is instantiated, `mintCredential()` runs later per
   * run, and a redactor built at binding time is a closure over a fixed secret set, so a token
   * minted afterwards is not in it. The adapter cannot hold it either, deliberately: `cloneUrl`
   * and `mintCredential` must hand that value back **intact**. WP-15 therefore needs a run-scoped
   * redactor and either a per-run adapter instance or a redactor resolved at call time; Q55 states
   * both options and what each costs. Also still open: the count of what was removed is reported
   * through the adapter's `onRedaction`, which nothing yet persists.
   */
  getJobLog(
    project: string,
    logRef: string,
    options?: { readonly tailBytes?: number },
  ): Promise<string>;

  getDefaultBranchHead(project: string): Promise<{ readonly branch: string; readonly sha: string }>;

  /**
   * Is `branch` protected against a direct push?
   *
   * On the port rather than on one adapter, because the pipeline evaluates it before it lets an
   * agent push (product/04 S3, WP-15) and the pipeline may not know which provider it is talking
   * to (BD-017). WP-09 put it on `GitLabProvider` alone, which left the only caller with a
   * down-cast — and a down-cast in the pipeline is BD-017's claim quietly withdrawn.
   *
   * It is a **security** answer, so it is the one method whose failure mode is stated here: an
   * adapter that cannot tell must throw rather than answer `false`, because "not protected" starts
   * a run that may push to the default branch. It is the compensating control for a credential
   * that has no branch scoping of its own (Q40, GitLab divergence 3).
   *
   * @throws {IntegrationError} `not_found` when the branch does not exist on the project.
   */
  isBranchProtected(project: string, branch: string): Promise<boolean>;
  /**
   * The `CODEOWNERS` **at `ref`**, parsed, or `null` when that ref has none.
   *
   * `ref` is an obligation rather than a hint, and it is a security one: the platform reads this
   * file at the *default branch* because a merge request may edit it, and routing by the version
   * inside the change would let whoever wrote the change appoint their own reviewer (BD-022,
   * product/19:138). An adapter that answered one file for the whole project would satisfy every
   * caller and quietly break that — `FakeGitProvider` did, until WP-37 review round 2 — so the
   * shared contract suite asserts it both ways ("reads CODEOWNERS at the ref it was asked for, and
   * never another ref's") rather than leaving it to this sentence (standing rule 3).
   */
  readCodeowners(project: string, ref: string): Promise<CodeownersRules | null>;

  /**
   * The provider's own account identifier for a handle, or `null` when it does not name one
   * (WP-37).
   *
   * It exists because a merge request's reviewers are set by **id**: GitLab's API takes
   * `reviewer_ids` and nothing else, while `readCodeowners` and `policies.reviewers` produce
   * handles — `@dana`, `@team/security`, `dana@example.com`. Without this method the reviewer
   * routing product/19:138 specifies can be computed and never applied, which is the state
   * `readCodeowners` sat in from WP-09 until now: built, correct and never called.
   *
   * **`null` is a first-class answer and must not be an exception.** A CODEOWNERS file is written
   * by whoever can push to the repository (BD-022) and routinely names a *group*, a team that is
   * not a user, or somebody who has left — and the caller's answer to all three is the same: name
   * the handle in the log and assign nobody for it. An adapter that threw would turn one stale
   * line in somebody's `CODEOWNERS` into a failed job with a retry.
   *
   * A handle is passed **as written**, leading `@` and all; normalising is the adapter's business,
   * because what a handle means is the provider's. It is a **read**, so it happens in every mode.
   *
   * @throws {IntegrationError} only for transport-level failures — never for an unknown handle.
   */
  resolveUserId(handle: string): Promise<string | null>;

  listMergedMergeRequests(
    project: string,
    since: string,
    limit: number,
  ): Promise<readonly MergedMergeRequest[]>;

  /**
   * The repository's commits on the default branch since an instant, newest first (WP-35).
   *
   * The third read the history bootstrap makes, and the one product/19 §18 names that
   * `GitProviderPort` had **no method for at all** — the merge requests and their discussions were
   * already reachable, and *"commit messages"* was not. It is on the port rather than on the GitLab
   * adapter for BD-017's reason: the bootstrap is pipeline-adjacent application code and may not
   * know which provider it is talking to.
   *
   * `limit` is the caller's, because how much history is worth reading is a property of the batch;
   * an adapter pages up to it and stops. A repository with no commits in the window answers `[]`,
   * which is a fact and not a failure — a project that has just been created is the ordinary case.
   *
   * It is a **read**, so it happens in every mode. An adapter that cannot list commits at all
   * throws `unsupported_capability`, the same answer `readCodeowners` gives, and the caller records
   * the batch as having no commit half rather than failing it (standing rule 20: this is a read the
   * bootstrap can do without).
   */
  listCommits(
    project: string,
    options: { readonly since: string; readonly limit: number },
  ): Promise<readonly RepositoryCommit[]>;

  readonly inbound: InboundNormaliser<GitProviderInboundEvent>;
}
