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
  mergeable: z.boolean().nullish(),
  has_conflicts: z.boolean().nullish(),
  diff_stats: diffStatsSchema.nullish(),
  coverage_pct: z.number().min(0).max(100).nullish(),
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
  coverage_pct: z.number().min(0).max(100).nullish(),
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

export const mergeRequestDraftSchema = z.strictObject({
  project: nonEmptyStringSchema,
  branch: nonEmptyStringSchema,
  target: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  description: z.string(),
  draft: z.boolean(),
  labels: z.array(nonEmptyStringSchema),
  /** Provider user ids, not emails — reviewer routing resolves CODEOWNERS beforehand. */
  reviewers: z.array(nonEmptyStringSchema),
  remove_source_branch: z.boolean(),
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
export type MergeRequestDraft = z.infer<typeof mergeRequestDraftSchema>;
export type MergeRequestUpdate = z.infer<typeof mergeRequestUpdateSchema>;

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
  /** A review finding on a diff line (technical/06: "Findings … posted as MR discussions"). */
  createDiscussion(
    ref: MergeRequestRefInput,
    note: { readonly path: string; readonly line: number; readonly markdown: string },
  ): Promise<Discussion>;

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
  readCodeowners(project: string, ref: string): Promise<CodeownersRules | null>;

  listMergedMergeRequests(
    project: string,
    since: string,
    limit: number,
  ): Promise<readonly MergedMergeRequest[]>;

  readonly inbound: InboundNormaliser<GitProviderInboundEvent>;
}
