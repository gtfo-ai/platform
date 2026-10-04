/**
 * The **GitProvider** contract suite (technical/10 contract tier).
 *
 * WP-07 runs it against `FakeGitProvider`; WP-09 runs the same assertions against GitLab
 * (gitlab.com and self-managed) in nock replay mode, and GitHub joins later without a line
 * changing here.
 *
 * Two assertions in this suite are security assertions rather than behaviour ones, and they are
 * the reason the credential type is not a zod wire shape: a minted credential must never appear in
 * a URL that is logged, and the *audit description* of a mint must not contain the token
 * (BD-002, BD-025, TD-012).
 */
import type {
  CodeownersRules,
  ExternalIdentity,
  GitProviderPort,
  InboundContext,
  WebhookDelivery,
} from '@platform/application';
import {
  mergeRequestListingSchema,
  mergeRequestPollPlanSchema,
  mergeRequestSchema,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectCatalogueEvent, expectIntegrationError } from './shared.js';

export interface GitProviderContractContext {
  readonly port: GitProviderPort;
  readonly project: string;
  readonly missingProject: string;
  /**
   * Branch names this provider's fixtures arrange.
   *
   * `source`/`target` are free for a new merge request; `protected`/`unprotected` are the two
   * answers `isBranchProtected` must give, and `missing` is a branch the provider does not have.
   */
  readonly branches: {
    readonly source: string;
    readonly target: string;
    readonly protected: string;
    readonly unprotected: string;
    readonly missing: string;
  };
  /**
   * A branch this provider does **not** have and a path no branch of it holds — what
   * `commitFiles` creates (WP-18b).
   *
   * Named by the harness rather than by the suite because a provider's fixtures decide what exists:
   * the fake keeps a real map of branches, the GitLab replay matches on the endpoint and not on the
   * body, and a literal here would be a fake detail the next adapter has to reproduce (BD-017).
   */
  readonly commit: {
    readonly branch: string;
    readonly path: string;
  };
  /** An existing merge request, and one that does not exist. */
  readonly mergeRequestIid: number;
  readonly missingMergeRequestIid: number;
  /**
   * A merge request whose **merge base** this harness's fixtures publish, or `null` when none does.
   *
   * Named the way {@link GitProviderContractContext.diff}`.omittedPath` is, and for the same
   * reason: a harness that cannot reach a case says so instead of the suite pretending it did. Both
   * harnesses shipped with this field name one today — the fake records the target branch's head
   * when a merge request is opened (divergence 14) and GitLab's recorded `GET
   * /merge_requests/7` carries `diff_refs.base_sha` — so the suite asserts a **sha**, not a
   * tolerance (WP-34 review round 2).
   */
  readonly mergeBaseIid: number | null;
  /**
   * What `listCommits` must answer for this harness — WP-35.
   *
   * `since` is a window the harness's own `sha` is inside and `emptySince` one it is outside, so
   * the suite can assert the parameter is honoured rather than only that a list came back.
   * `message` is a substring of that commit's message, because the message is the whole reason the
   * history bootstrap reads commits at all.
   */
  readonly commits: {
    readonly since: string;
    readonly emptySince: string;
    readonly sha: string;
    readonly message: string;
  };
  /**
   * Three merge requests whose mergeability the harness has arranged.
   *
   * The third one is the reason this is in the contract at all: a provider that has not finished
   * its mergeability check answers `mergeable: null`, and WP-26's rebase gate must treat that as
   * "unknown, ask again" rather than as "conflicted". A fake that always answered `true` would let
   * that path pass untested (WP-07 review round 1).
   */
  readonly mergeability: {
    /** `mergeable: true`, `has_conflicts: false`. */
    readonly mergeable: number;
    /** `mergeable: false`, `has_conflicts: true`. */
    readonly conflicted: number;
    /** `mergeable: null` — the provider has not computed it yet. */
    readonly unknown: number;
  };
  /**
   * The merge request whose **diff** the harness has arranged, and what it should contain (WP-24).
   *
   * A path is named rather than counted because a count alone is satisfied by a provider that
   * returns the wrong files, and `omittedPath` is named because the case that matters is the one an
   * adapter is most likely to get wrong: a provider that has a patch and will not send it
   * (GitLab's `collapsed`/`too_large`, GitHub's missing `patch`) must come back as
   * `omitted: true`, never as an empty change. `null` when this provider's fixtures arrange no such
   * file — a harness that cannot reach the case says so instead of the suite pretending it did.
   */
  readonly diff: {
    readonly iid: number;
    readonly path: string;
    readonly omittedPath: string | null;
    /** How many files the harness arranged, so the `limit` case can ask for fewer. */
    readonly fileCount: number;
  };
  /**
   * Two merge requests for `closeMergeRequest` (WP-59, PROGRESS backlog 51): one **open**, which
   * the suite closes twice, and one already **merged**, which it must refuse to close.
   *
   * Their own iids rather than {@link GitProviderContractContext.mergeRequestIid}: a replay harness
   * keys a response on method and path, so closing the merge request other cases update would make
   * the draft case and the close case answer each other's fixtures.
   */
  readonly close: {
    readonly openIid: number;
    readonly mergedIid: number;
  };
  /**
   * A merge request whose diff stats this harness publishes, and what they are (WP-59, backlog
   * 113). Named numbers rather than "some stats came back", because an adapter that mapped
   * `additions` onto `deletions` passes a presence check.
   */
  readonly diffStats: {
    readonly iid: number;
    readonly expected: {
      readonly files_changed: number;
      readonly insertions: number;
      readonly deletions: number;
    };
  };
  /**
   * What `listMergeRequests` must answer for this harness (WP-110, PROGRESS backlog 297).
   *
   * `since` is a window both named merge requests are inside and `emptySince` one every merge
   * request is outside, so the suite asserts the window is honoured both ways (rule 42). One is open
   * and one merged, because a poll that listed only open merge requests would never see a merge.
   */
  readonly listing: {
    readonly since: string;
    readonly emptySince: string;
    readonly openIid: number;
    readonly mergedIid: number;
  };
  /**
   * The same provider built with merge-request polling **switched on** in its binding
   * configuration, and the interval that configuration states (WP-110) — an obligation of the
   * contract (rule 23): the merge-request poller asks `pollPlan()`, and a provider that answered a
   * plan for a binding that never asked would read a provider nobody asked it to.
   */
  readonly polling: {
    readonly port: GitProviderPort;
    readonly intervalSeconds: number;
    /**
     * WP-123: `port` is built **with** this provider's webhook secret, and this one polls with
     * **none** — a poll-only binding, whose plan must say no webhook reaches it, because the
     * poller makes its two extra reads (the default branch, the review notes) on that answer alone.
     */
    readonly pollOnlyPort: GitProviderPort;
  };
  /**
   * WP-123: a merge request whose threads hold one person's note, one provider **system** note and
   * one the platform posted (opening with its `<!-- agentic:… -->` marker), each at its own instant
   * — what the poll-only binding's review-note read lists and filters. Named rather than counted,
   * because the filter reads `system`, `created_at` and the body, and an adapter that mapped any
   * of them wrongly passes a presence check.
   */
  readonly notes: {
    readonly iid: number;
    readonly human: { readonly threadId: string; readonly noteId: string; readonly at: string };
    readonly systemNoteId: string;
    readonly platformNoteId: string;
  };
  /**
   * WP-138: the developer's `open_mr` adopts an existing open merge request only when it is the
   * platform's own. `openBranch` has exactly one open merge request (`openIid`), opened by the
   * binding's own account; `emptyBranch` has none. `pipelineIid` is the merge request a new
   * merge-request pipeline is created for.
   */
  readonly adoption: {
    readonly openBranch: string;
    readonly openIid: number;
    readonly emptyBranch: string;
    readonly pipelineIid: number;
  };
  /**
   * WP-137: the probe of a static run credential. In `project`, `developer` is a member with the
   * push role, `maintainer` one with a role above it, and `outsider` an existing user who is not a
   * member; `unknown` is a username nobody has.
   */
  readonly members: {
    readonly developer: string;
    readonly maintainer: string;
    readonly outsider: string;
  };
  /**
   * WP-141 (TD-028 decision 13a): an operator's own run token. In `project`, `noOne` is protected
   * with push **No one** and force push off, `unprotected` has no rule, `maintainersPush` lets
   * Maintainers push (by an exact rule or, in GitLab's corpus, a wildcard over an exact No-one rule) and `forcePush` admits a force push. Of the run tokens, `repositoryOnly` is
   * refused the identity read for its scope, `apiCapable` is answered, and `unknown` is a token the
   * provider does not accept at all.
   */
  readonly protection: {
    readonly noOne: string;
    readonly unprotected: string;
    readonly maintainersPush: string;
    readonly forcePush: string;
  };
  /**
   * WP-146 (TD-028 decision 13b item 6): public key lines of `project`'s deploy keys — `writable` is
   * enabled with write access, `readOnly` without it, and `absent` is not enabled at all.
   */
  readonly deployKeys: {
    readonly writable: string;
    readonly readOnly: string;
    readonly absent: string;
  };
  readonly runTokens: {
    readonly repositoryOnly: string;
    readonly apiCapable: string;
    readonly unknown: string;
    /** Answered `403` for a reason that is not its scope (review round 1). */
    readonly blockedElsewhere: string;
  };
  /**
   * WP-139: three projects whose repository settings differ the three ways the CI gate reads —
   * `plain` keeps its CI at the provider's default path with default branch `main`, `custom` keeps
   * it at `deploy/.gitlab-ci.yml` with default branch `dev` (GoParking), and `external` takes it
   * from another project (`.gitlab-ci.yml@acme/ci-templates`).
   */
  readonly repositories: {
    readonly plain: string;
    readonly custom: string;
    readonly external: string;
  };
  /** Head sha of a pipeline the harness seeded, with one failing job that has a log. */
  readonly pipelineSha: string;
  readonly failingJobName: string;
  /**
   * A job log reference this provider does not have.
   *
   * Provider-shaped, not suite-shaped: the fake keys logs as `log:<id>` and GitLab by numeric job
   * id, so a literal here would be a fake detail that WP-09 has to work around (BD-017).
   */
  readonly missingJobLogRef: string;
  /**
   * A revocation handle **shaped the way this provider writes one**, naming a credential this
   * provider never minted: another process minted it, or it survived a restart, or it was
   * fabricated.
   *
   * Provider-shaped on purpose, and the shape is what makes the case sharp. GitLab writes
   * `<project>#<token_id>`, so `acme/api#59` is foreign but legible and earns `not_found`, while a
   * random string is not a handle at all and earns `invalid_request` — a different refusal about a
   * different mistake. A harness that supplies the second here fails the case, which is the point:
   * the suite asserts the distinction rather than accepting either error.
   */
  readonly foreignRevokeId: string;
  /**
   * A handle this provider can resolve to an account id, and one it cannot (WP-37).
   *
   * Provider-shaped like every other name in this context: the fake answers exactly what a test
   * seeded, GitLab replays a recorded `GET /users?username=` page. `unknown` is the load-bearing
   * half — a `CODEOWNERS` naming a group, a team or somebody who has left is the ordinary state of
   * a real repository, and the port promises `null` for it rather than an exception.
   */
  readonly reviewer: {
    readonly handle: string;
    readonly externalId: string;
    readonly unknownHandle: string;
  };
  /**
   * Two refs whose `CODEOWNERS` differ, and an owner each file names (WP-37 review round 2).
   *
   * `ref` is the trusted copy — the default branch, which the platform reads routing from because
   * a merge request may edit the file and its author must not be able to appoint their own
   * reviewer (BD-022) — and `otherRef` is a branch carrying a *different* file. The suite asserts
   * both directions, because "the ref is honoured" is satisfied by an adapter that answers the
   * right file for the wrong reason: the fake stored one file per project and ignored `ref`
   * entirely until this case existed, and every tier above it was green.
   */
  readonly codeowners: {
    readonly ref: string;
    readonly owner: string;
    readonly otherRef: string;
    readonly otherOwner: string;
  };
  /**
   * Produces the delivery a provider sends when a person **approves** {@link mergeRequestIid}, and
   * the provider account id of that person (WP-60, PROGRESS backlog 90).
   *
   * An obligation of the contract rather than of GitLab (standing rule 23): `mr.approved`'s whole
   * value is the approver, and product/19 §16 counts an approval as review activity — a provider
   * that did not produce it would under-count every reviewer who approves without commenting.
   */
  emitApproval(): WebhookDelivery;
  readonly approverExternalId: string;
  /**
   * Produces the delivery a provider sends when a merge request is **updated** — a push, say
   * (WP-60 review round 2). The suite asserts it carries the provider's own `updated_at`: the
   * recorded head moves forward only by that instant, so a provider that sent none would leave a
   * human's push unrecorded for ever (standing rule 23).
   */
  emitUpdated(): WebhookDelivery;
  /** Produces signed deliveries. */
  emitMerged(): WebhookDelivery;
  emitReviewComment(text: string): WebhookDelivery;
  emitPipelineFinished(): WebhookDelivery;
  readonly projectId: Id;
  readonly integrationId: Id;
  cleanup(): Promise<void>;
}

export interface GitProviderContractHarness {
  readonly name: string;
  create(): Promise<GitProviderContractContext>;
}

export const runGitProviderContract = (harness: GitProviderContractHarness): void => {
  describe(`GitProvider contract — ${harness.name}`, () => {
    let context: GitProviderContractContext;
    let port: GitProviderPort;

    beforeEach(async () => {
      context = await harness.create();
      port = context.port;
      return async () => {
        await context.cleanup();
      };
    });

    const mrRef = (iid: number) => ({
      provider: port.ref.provider,
      project_path: context.project,
      iid,
      url: `https://git.example.test/${context.project}/-/merge_requests/${iid}`,
      branch: null,
      head_sha: null,
    });

    const inboundContext = (
      resolve: (identity: ExternalIdentity) => Id | null = () => null,
    ): InboundContext => ({
      projectId: context.projectId,
      integrationId: context.integrationId,
      resolveUser: resolve,
      resolveThread: async () => null,
    });

    describe('capabilities and health', () => {
      it('declares every capability flag as a boolean', () => {
        const capabilities = port.capabilities();
        for (const [name, value] of Object.entries(capabilities)) {
          expect(typeof value, `capability ${name}`).toBe('boolean');
        }
        expect(Object.keys(capabilities)).toEqual(
          expect.arrayContaining([
            'webhooks',
            'projectTokens',
            'codeowners',
            'coverageArtifacts',
            'draftPipelines',
            'discussionResolution',
            'credentialMinting',
          ]),
        );
      });

      it('answers a read-only probe', async () => {
        expect((await port.testConnection()).ok).toBe(true);
      });

      it('reports the head of a branch the platform names (WP-142)', async () => {
        const head = await port.getBranchHead(context.project, context.branches.protected);
        expect(head.branch).toBe(context.branches.protected);
        expect(head.sha).toMatch(/^[0-9a-f]{7,64}$/);
      });

      it('fails with not_found for a project that does not exist', async () => {
        await expectIntegrationError(
          () => port.getBranchHead(context.missingProject, context.branches.protected),
          'not_found',
        );
      });

      it('fails with not_found for a branch the project does not have (WP-142)', async () => {
        await expectIntegrationError(
          () => port.getBranchHead(context.project, context.branches.missing),
          'not_found',
        );
      });

      /**
       * The protection check the pipeline runs before it lets an agent push (WP-15).
       *
       * Both answers are asserted, from a branch the harness says is protected and one it says is
       * not — a one-sided case would pass against an adapter that always answers `true`, and
       * `true` is the answer that lets the pipeline start a run. The harness names the branches
       * because a *provider* decides what its own fixtures protect (BD-017).
       */
      it('answers the protection of a protected and an unprotected branch', async () => {
        expect(await port.isBranchProtected(context.project, context.branches.protected)).toBe(
          true,
        );
        expect(await port.isBranchProtected(context.project, context.branches.unprotected)).toBe(
          false,
        );
      });

      it('fails rather than answering "unprotected" for a branch it cannot see', async () => {
        // "Not protected" starts a run that may push to the default branch, so an adapter that
        // cannot tell must refuse instead of guessing the permissive answer.
        await expectIntegrationError(
          () => port.isBranchProtected(context.project, context.branches.missing),
          'not_found',
        );
      });
    });

    describe('credentials (BD-025)', () => {
      it('mints a scoped, expiring credential, or refuses when it cannot', async () => {
        if (!port.capabilities().credentialMinting) {
          await expectIntegrationError(
            () =>
              port.mintCredential({
                project: context.project,
                scope: 'read',
                ttlSeconds: 60,
              }),
            'unsupported_capability',
          );
          return;
        }
        const credential = await port.mintCredential({
          project: context.project,
          scope: 'push',
          branchPatterns: ['agentic/*'],
          ttlSeconds: 3600,
        });
        expect(credential.value.length).toBeGreaterThan(0);
        expect(credential.scope).toBe('push');
        expect(credential.branchPatterns).toEqual(['agentic/*']);
        expect(Date.parse(credential.expiresAt)).not.toBeNaN();

        // The clone URL is the one place the value may appear; it is never logged (BD-025).
        const url = port.cloneUrl(context.project, credential);
        expect(url).toContain(credential.value);

        // Once revoked, the port refuses to build a clone URL at all.
        await port.revokeCredential(credential);
        await port.revokeCredential(credential);
        await expectIntegrationError(
          async () => port.cloneUrl(context.project, credential),
          'invalid_request',
        );
      });

      /**
       * The port obligation WP-09 added, asserted where every provider meets it (BD-017).
       *
       * It lived in GitLab's own contract file for one review round, which made it a
       * provider-local promise: a GitHub adapter that simply `return`s for a foreign handle
       * passed this entire suite. A provider that reports success here has told the caller a live
       * push credential is dead — the credential keeps working until the provider expires it, and
       * nothing will ever look at it again.
       *
       * `not_found` exactly, never a resolve and never `invalid_request` (see `foreignRevokeId`).
       */
      it('refuses to report a revocation it cannot substantiate', async () => {
        // The address alone (WP-77): nothing a provider could answer "expired" from, and no value
        // invented to reach the refusal (standing rule 18).
        await expectIntegrationError(
          () => port.revokeCredential({ revokeId: context.foreignRevokeId }),
          'not_found',
        );
      });

      /**
       * **Revoke by address** (WP-77, PROGRESS backlog 155): the recovery row that revokes a
       * credential whose runner died holds the mint's `revoke_id` and nothing else. Asserted on
       * what the provider then refuses — a clone URL for the minted credential — rather than on
       * the call resolving, which a no-op would also do (standing rule 1).
       */
      it('revokes a credential given only its revocation address', async () => {
        if (!port.capabilities().credentialMinting) {
          return;
        }
        const credential = await port.mintCredential({
          project: context.project,
          scope: 'push',
          branchPatterns: ['agentic/*'],
          ttlSeconds: 3600,
        });
        expect(credential.revokeId, 'a minted credential carries its own address').not.toBeNull();
        expect(port.cloneUrl(context.project, credential)).toContain(credential.value);

        await port.revokeCredential({ revokeId: credential.revokeId });

        await expectIntegrationError(
          async () => port.cloneUrl(context.project, credential),
          'invalid_request',
        );
      });
    });

    describe('merge requests', () => {
      it('opens a draft merge request and reads it back', async () => {
        const opened = await port.openMergeRequest({
          project: context.project,
          branch: context.branches.source,
          target: context.branches.target,
          title: 'Draft: add the parser',
          description: 'Requested by a human, linked to the task.',
          draft: true,
          labels: ['agentic'],
          reviewers: [],
          remove_source_branch: true,
        });
        const parsed = mergeRequestSchema.parse(opened);
        expect(parsed.draft).toBe(true);
        expect(parsed.state).toBe('opened');

        const fetched = await port.getMergeRequest(parsed.ref);
        expect(fetched.ref.iid).toBe(parsed.ref.iid);
        expect(fetched.title).toBe('Draft: add the parser');
      });

      it('refuses a second open merge request for one source branch', async () => {
        const draft = {
          project: context.project,
          branch: context.branches.source,
          target: context.branches.target,
          title: 'Draft: add the parser',
          description: '',
          draft: true,
          labels: [],
          reviewers: [],
          remove_source_branch: true,
        };
        await port.openMergeRequest(draft);
        // `conflict`, not `invalid_request`: GitLab answers 409 here, and the caller's response is
        // "read the existing merge request", not "fix the call".
        await expectIntegrationError(() => port.openMergeRequest(draft), 'conflict');
      });

      /**
       * WP-138's adoption read, both answers (rule 42): the one open merge request of a branch, and
       * `null` for a branch with none — never an error, which would read as "cannot tell".
       */
      it('finds the one open merge request of a source branch, and none for a branch without one', async () => {
        const found = await port.findOpenMergeRequest(context.project, context.adoption.openBranch);
        expect(found, 'the branch has an open merge request').not.toBeNull();
        const parsed = mergeRequestSchema.parse(found);
        expect(parsed.ref.iid).toBe(context.adoption.openIid);
        expect(parsed.state).toBe('opened');
        expect(parsed.source_branch).toBe(context.adoption.openBranch);

        const none = await port.findOpenMergeRequest(context.project, context.adoption.emptyBranch);
        expect(none).toBeNull();
      });

      /**
       * WP-138: the binding's own account is what tells the platform's merge request from a
       * person's — so it must be the identity the provider writes as a merge request's author.
       */
      it("answers the binding's own account, the author of the merge requests it opened", async () => {
        const me = await port.authenticatedUser();
        expect(me.external_id.length).toBeGreaterThan(0);
        const mine = await port.findOpenMergeRequest(context.project, context.adoption.openBranch);
        expect(mine?.author?.external_id, 'the open merge request is the binding’s own').toBe(
          me.external_id,
        );
      });

      /**
       * WP-137 (TD-028 decision 13 item 3): the static run credential's user, asked with the API
       * token — a Developer is a member that does not administer, a Maintainer administers, an
       * outsider is no member, and an unknown project is `not_found`.
       */
      it("answers a user's membership of the project and whether its role is above the push role", async () => {
        const developer = await port.projectMemberAccess(
          context.project,
          context.members.developer,
        );
        expect(developer).toMatchObject({ member: true, pushes: true, administers: false });
        expect(developer.role).not.toBeNull();
        const maintainer = await port.projectMemberAccess(
          context.project,
          context.members.maintainer,
        );
        expect(maintainer).toMatchObject({ member: true, pushes: true, administers: true });
        expect(await port.projectMemberAccess(context.project, context.members.outsider)).toEqual({
          member: false,
          role: null,
          pushes: false,
          administers: false,
        });
        await expectIntegrationError(
          () => port.projectMemberAccess(context.missingProject, context.members.developer),
          'not_found',
        );
      });

      /**
       * WP-141 (TD-028 decision 13a item 2): who may push to a branch, in neutral words — the four
       * shapes the operator-token check reads, and an unknown project is `not_found`.
       */
      it('answers who may push to a branch: No one, nobody protected, Maintainers, and a force push', async () => {
        expect(await port.branchPushProtection(context.project, context.protection.noOne)).toEqual({
          protected: true,
          nobodyPushes: true,
          forcePushAllowed: false,
          pushers: ['No one'],
        });
        expect(
          await port.branchPushProtection(context.project, context.protection.unprotected),
        ).toEqual({ protected: false, nobodyPushes: false, forcePushAllowed: true, pushers: [] });
        const maintainers = await port.branchPushProtection(
          context.project,
          context.protection.maintainersPush,
        );
        expect(maintainers).toMatchObject({ protected: true, nobodyPushes: false });
        expect(
          maintainers.pushers.some((pusher) => pusher.includes('Maintainers')),
          'the pushers name the Maintainers rule, exact or wildcard',
        ).toBe(true);
        expect(
          await port.branchPushProtection(context.project, context.protection.forcePush),
        ).toMatchObject({ protected: true, nobodyPushes: true, forcePushAllowed: true });
        await expectIntegrationError(
          () => port.branchPushProtection(context.missingProject, context.protection.noOne),
          'not_found',
        );
      });

      /**
       * WP-146 (TD-028 decision 13b item 6): a public key is matched by type and base64 — the comment
       * is the operator's — and its write access answered as the provider has it.
       */
      it('answers whether a public key is one of the project’s deploy keys, and whether it may push', async () => {
        expect(
          await port.deployKeyAccess(
            context.project,
            `${context.deployKeys.writable} another-comment`,
          ),
        ).toMatchObject({ enabled: true, canPush: true });
        expect(
          await port.deployKeyAccess(context.project, context.deployKeys.readOnly),
        ).toMatchObject({
          enabled: true,
          canPush: false,
        });
        expect(await port.deployKeyAccess(context.project, context.deployKeys.absent)).toEqual({
          enabled: false,
          canPush: false,
          keyId: null,
        });
        await expectIntegrationError(
          () => port.deployKeyAccess(context.missingProject, context.deployKeys.writable),
          'not_found',
        );
      });

      /**
       * WP-141 (TD-028 decision 13a item 1): the scope proof answers the provider's status as it
       * came — a refusal for scope is the one answer that proves a repository-only token.
       */
      it('answers the scope proof of a run token: refused for scope, answered, or not accepted', async () => {
        const repositoryOnly = await port.runTokenApiAccess(context.runTokens.repositoryOnly);
        expect(repositoryOnly).toMatchObject({ status: 403, refusedForScope: true });
        expect(repositoryOnly.error).toBe('insufficient_scope');
        expect(await port.runTokenApiAccess(context.runTokens.apiCapable)).toEqual({
          status: 200,
          refusedForScope: false,
          error: null,
        });
        expect(await port.runTokenApiAccess(context.runTokens.unknown)).toMatchObject({
          status: 401,
          refusedForScope: false,
        });
        // Review round 1: a 403 that is not for the token's scope (a proxy, a firewall) proves nothing.
        expect(await port.runTokenApiAccess(context.runTokens.blockedElsewhere)).toMatchObject({
          status: 403,
          refusedForScope: false,
        });
      });

      /**
       * WP-139 ruling (b): the repository's own default branch and CI configuration location —
       * the default path, a custom path in the repository, and another project's file.
       */
      it("answers the repository's default branch and where its CI configuration lives", async () => {
        expect(await port.repositorySettings(context.repositories.plain)).toEqual({
          defaultBranch: 'main',
          ciConfig: { kind: 'repository', path: '.gitlab-ci.yml' },
        });
        expect(await port.repositorySettings(context.repositories.custom)).toEqual({
          defaultBranch: 'dev',
          ciConfig: { kind: 'repository', path: 'deploy/.gitlab-ci.yml' },
        });
        expect(await port.repositorySettings(context.repositories.external)).toEqual({
          defaultBranch: 'main',
          ciConfig: { kind: 'external', location: '.gitlab-ci.yml@acme/ci-templates' },
        });
        await expectIntegrationError(
          () => port.repositorySettings(context.missingProject),
          'not_found',
        );
      });

      /**
       * WP-138 ruling (g): a merge request marked ready with no pipeline on its head gets one.
       * Asserted on the head the pipeline runs at, not only on an id coming back.
       */
      it("creates a merge-request pipeline at the merge request's head", async () => {
        const mr = await port.getMergeRequest(mrRef(context.adoption.pipelineIid));
        const created = await port.createMergeRequestPipeline(mrRef(context.adoption.pipelineIid));
        expect(created.id.length).toBeGreaterThan(0);
        expect(created.head_sha).toBe(mr.head_sha);
        expect(['pending', 'running', 'created']).toContain(created.status);
        await expectIntegrationError(
          () => port.createMergeRequestPipeline(mrRef(context.missingMergeRequestIid)),
          'not_found',
        );
      });

      it('reports mergeability as the provider computed it, including "not computed yet"', async () => {
        const mergeable = await port.getMergeRequest(mrRef(context.mergeability.mergeable));
        expect(mergeable.mergeable, 'a mergeable merge request').toBe(true);
        expect(mergeable.has_conflicts ?? false, 'a mergeable merge request has no conflicts').toBe(
          false,
        );

        const conflicted = await port.getMergeRequest(mrRef(context.mergeability.conflicted));
        expect(conflicted.mergeable, 'a conflicted merge request').toBe(false);
        expect(conflicted.has_conflicts, 'a conflicted merge request reports its conflicts').toBe(
          true,
        );

        // The state WP-26 depends on, and the one a kind fake never produces.
        const unknown = await port.getMergeRequest(mrRef(context.mergeability.unknown));
        expect(
          unknown.mergeable ?? null,
          'mergeability the provider has not computed must be null, never false',
        ).toBeNull();
        expect(
          unknown.has_conflicts ?? null,
          'conflicts the provider has not computed must be null, never false',
        ).toBeNull();
      });

      it('takes a merge request out of draft', async () => {
        const updated = await port.updateMergeRequest(mrRef(context.mergeRequestIid), {
          draft: false,
          description: 'Ready for merge.',
          title: null,
          labels: null,
          reviewers: null,
        });
        expect(updated.draft).toBe(false);
        expect(updated.description).toBe('Ready for merge.');
      });

      it('fails with not_found for a merge request that does not exist', async () => {
        await expectIntegrationError(
          () => port.getMergeRequest(mrRef(context.missingMergeRequestIid)),
          'not_found',
        );
      });

      /**
       * product/04:86's *"the old MR is closed"* (WP-59, backlog 51) — the port had no way to say
       * it until now, so no adapter, fake or suite in this tree could close anything.
       *
       * **Idempotent**, and asserted by calling it twice: the rework duty runs from an
       * at-least-once job, so a retry after the provider already closed the merge request must
       * succeed rather than fail the job. And the refusal is asserted beside it (standing rule 42):
       * an adapter that answered "closed" for a **merged** merge request would tell the rework duty
       * the rejected change is gone while it sits on the default branch.
       */
      it('closes a merge request, succeeds when it is already closed, and refuses a merged one', async () => {
        const first = await port.closeMergeRequest(mrRef(context.close.openIid));
        expect(first.state).toBe('closed');
        expect(first.ref.iid).toBe(context.close.openIid);
        const again = await port.closeMergeRequest(mrRef(context.close.openIid));
        expect(again.state).toBe('closed');

        await expectIntegrationError(
          () => port.closeMergeRequest(mrRef(context.close.mergedIid)),
          'conflict',
        );
        await expectIntegrationError(
          () => port.closeMergeRequest(mrRef(context.missingMergeRequestIid)),
          'not_found',
        );
      });

      /**
       * The diff-stats read (WP-59, backlog 113): the one number the shipped adapter's three
       * `diff_stats` surfaces never carry. Asserted field by field, so an adapter that swapped
       * insertions and deletions — GitLab calls them `additions` and `deletions` — fails here.
       */
      it('reads a merge request’s diff stats', async () => {
        expect(await port.getMergeRequestDiffStats(mrRef(context.diffStats.iid))).toEqual(
          context.diffStats.expected,
        );
      });
    });

    /**
     * WP-18b: the platform writing files of its own, with no working copy (BD-025, technical/07's
     * knowledge MR).
     *
     * Both halves are here because a one-sided case passes against an adapter that refuses
     * everything (standing rule 42), and the refusal is the one a caller has to handle: the
     * Librarian decides `add` from an index that can be stale, so "create a file that is already
     * there" is a real outcome rather than a programming error.
     */
    describe('commits', () => {
      it('writes files as one commit on a new branch, and refuses to create one that is there', async () => {
        const commit = await port.commitFiles({
          project: context.project,
          branch: context.commit.branch,
          start_branch: context.branches.target,
          message:
            'docs(knowledge): apply 1 knowledge proposal\n\nAgentic-Source: task ACME-1 run 00000000-0000-4000-8000-000000000001\n',
          author_name: 'Agentic Bot',
          author_email: 'agentic-bot@example.test',
          actions: [{ action: 'create', path: context.commit.path, content: '# a lesson\n' }],
        });
        expect(commit.branch).toBe(context.commit.branch);
        expect(commit.sha).toMatch(/^[0-9a-f]{7,64}$/);

        // The branch exists now, so this one does not create it — and the file does, so `create`
        // is the caller's mistake and the provider says so rather than overwriting.
        await expectIntegrationError(
          () =>
            port.commitFiles({
              project: context.project,
              branch: context.commit.branch,
              start_branch: null,
              message: 'docs(knowledge): the same page again',
              author_name: null,
              author_email: null,
              actions: [{ action: 'create', path: context.commit.path, content: '# again\n' }],
            }),
          'invalid_request',
        );
      });
    });

    describe('discussions', () => {
      it('creates a finding, replies to it and resolves it idempotently', async () => {
        const ref = mrRef(context.mergeRequestIid);
        const created = await port.createDiscussion(ref, {
          path: 'src/parser.ts',
          line: 42,
          markdown: 'This branch is unreachable.',
        });
        expect(created.notes[0]?.path).toBe('src/parser.ts');
        expect(created.resolved).toBe(false);

        const replied = await port.replyToDiscussion(ref, created.id, 'Fixed in the next commit.');
        expect(replied.notes.length).toBe(2);

        if (port.capabilities().discussionResolution) {
          const resolved = await port.resolveDiscussion(ref, created.id);
          expect(resolved.resolved).toBe(true);
          // Idempotent: a re-review resolves threads it already resolved.
          const again = await port.resolveDiscussion(ref, created.id);
          expect(again.resolved).toBe(true);
        } else {
          await expectIntegrationError(
            () => port.resolveDiscussion(ref, created.id),
            'unsupported_capability',
          );
        }

        const listed = await port.listDiscussions(ref);
        expect(listed.map((discussion) => discussion.id)).toContain(created.id);
      });

      it('fails with not_found for an unknown discussion', async () => {
        await expectIntegrationError(
          () => port.replyToDiscussion(mrRef(context.mergeRequestIid), 'no-such-thread', 'hi'),
          'not_found',
        );
      });

      /**
       * WP-24: a thread on the merge request itself, which is what review-only mode's neutral
       * summary is.
       *
       * In the shared suite rather than in one provider's file, because BD-017's whole claim is
       * that a new provider is trustworthy without touching the pipeline — and a GitHub adapter
       * that quietly anchored the summary to a line, or dropped it, would pass a suite that never
       * asked (standing rule 23, earned by exactly this omission at WP-09).
       */
      it('creates a thread on the merge request when there is no path and no line', async () => {
        const ref = mrRef(context.mergeRequestIid);
        // The anchored thread first, then the summary — which is the order the review-only duty
        // posts them in, and the order a replay harness serving one endpoint has to be driven in.
        const anchored = await port.createDiscussion(ref, {
          path: 'src/parser.ts',
          line: 42,
          markdown: 'This branch is unreachable.',
        });
        expect(anchored.notes[0]?.path).toBe('src/parser.ts');

        const summary = await port.createDiscussion(ref, {
          markdown: 'A neutral summary of the whole change.',
        });
        expect(summary.id).not.toBe(anchored.id);
        expect(summary.notes[0]?.path ?? null).toBeNull();
        expect(summary.notes[0]?.line ?? null).toBeNull();
        expect(summary.notes[0]?.body).toContain('A neutral summary');
      });

      /** Half an anchor is one no provider can place: refuse it rather than post it unanchored. */
      it('refuses a path without a line, and a line without a path', async () => {
        await expectIntegrationError(
          () =>
            port.createDiscussion(mrRef(context.mergeRequestIid), {
              path: 'src/parser.ts',
              markdown: 'half an anchor',
            }),
          'invalid_request',
        );
        await expectIntegrationError(
          () =>
            port.createDiscussion(mrRef(context.mergeRequestIid), {
              line: 3,
              markdown: 'the other half',
            }),
          'invalid_request',
        );
      });
    });

    describe('the merge request diff (WP-24)', () => {
      it('returns each changed file with its patch', async () => {
        const files = await port.getMergeRequestDiff(mrRef(context.diff.iid), { limit: 50 });
        expect(files.length).toBeGreaterThan(0);
        const named = files.find((file) => file.new_path === context.diff.path);
        expect(named, `no entry for ${context.diff.path}`).toBeDefined();
        expect(named?.omitted).toBe(false);
        expect(named?.diff ?? '').not.toBe('');
        expect(named?.old_path).toBeDefined();
      });

      it('applies the caller’s limit rather than trusting it', async () => {
        const files = await port.getMergeRequestDiff(mrRef(context.diff.iid), { limit: 1 });
        expect(files).toHaveLength(1);
      });

      it('marks a file the provider excluded as omitted, never as an empty change', async () => {
        if (context.diff.omittedPath === null) {
          return;
        }
        const files = await port.getMergeRequestDiff(mrRef(context.diff.iid), { limit: 50 });
        const excluded = files.find((file) => file.new_path === context.diff.omittedPath);
        expect(excluded?.omitted).toBe(true);
        // Both directions (standing rule 42): it is marked *and* it carries no patch that would
        // read as "this file changed by nothing".
        expect(excluded?.diff ?? null).toBeNull();
      });
    });

    describe('CI', () => {
      it('reports the pipeline for a commit and the tail of a failing job log', async () => {
        const pipeline = await port.getPipelineStatus(context.project, context.pipelineSha);
        expect(pipeline).not.toBeNull();
        expect(pipeline?.head_sha).toBe(context.pipelineSha);
        const failing = pipeline?.jobs.find((job) => job.name === context.failingJobName);
        expect(failing?.status).toBe('failed');
        expect(failing?.log_ref).not.toBeNull();

        const log = await port.getJobLog(context.project, failing?.log_ref as string, {
          tailBytes: 20,
        });
        expect(log.length).toBeLessThanOrEqual(20);
        expect(log.length).toBeGreaterThan(0);
      });

      it('returns null when no pipeline ran for a commit', async () => {
        expect(await port.getPipelineStatus(context.project, 'f'.repeat(40))).toBeNull();
      });

      it('fails with not_found for an unknown job log', async () => {
        await expectIntegrationError(
          () => port.getJobLog(context.project, context.missingJobLogRef),
          'not_found',
        );
      });
    });

    describe('CODEOWNERS and history', () => {
      it('parses CODEOWNERS into rules, or refuses when it cannot', async () => {
        if (!port.capabilities().codeowners) {
          await expectIntegrationError(
            () => port.readCodeowners(context.project, context.codeowners.ref),
            'unsupported_capability',
          );
          return;
        }
        const rules = await port.readCodeowners(context.project, context.codeowners.ref);
        expect(rules).not.toBeNull();
        expect(rules?.rules.length).toBeGreaterThan(0);
        for (const rule of rules?.rules ?? []) {
          expect(rule.owners.length).toBeGreaterThan(0);
        }
      });

      it('reads CODEOWNERS at the ref it was asked for, and never another ref’s', async () => {
        /**
         * A **security** assertion, like the two the file's docblock names: reviewer routing reads
         * this file at the default branch on purpose, because a merge request may edit it and
         * routing by the copy *inside* the change would let whoever wrote the change appoint their
         * own reviewer (BD-022, product/19:138, WP-37).
         *
         * Asserted **both ways** (standing rule 42): each ref's own owner is present and the
         * other's is absent. One direction alone passes against a provider that ignores `ref` and
         * answers one file for the whole project, which is what `FakeGitProvider` did through the
         * whole of WP-37's first round.
         */
        if (!port.capabilities().codeowners) {
          // The same refusal its sibling asserts: a future adapter without the capability must not
          // pass this case vacuously by returning early.
          await expectIntegrationError(
            () => port.readCodeowners(context.project, context.codeowners.ref),
            'unsupported_capability',
          );
          return;
        }
        const ownersOf = (rules: CodeownersRules | null): readonly string[] =>
          (rules?.rules ?? []).flatMap((rule) => rule.owners);

        const trusted = ownersOf(
          await port.readCodeowners(context.project, context.codeowners.ref),
        );
        const branch = ownersOf(
          await port.readCodeowners(context.project, context.codeowners.otherRef),
        );

        expect(trusted).toContain(context.codeowners.owner);
        expect(trusted).not.toContain(context.codeowners.otherOwner);
        expect(branch).toContain(context.codeowners.otherOwner);
        expect(branch).not.toContain(context.codeowners.owner);
      });

      it('resolves a handle to the account id reviewers are set by', async () => {
        expect(await port.resolveUserId(context.reviewer.handle)).toBe(context.reviewer.externalId);
      });

      it('answers null for a handle it does not know, rather than throwing', async () => {
        // Standing rule 20's direction for a *notification*: a stale CODEOWNERS line must cost a
        // reviewer that is not assigned, never a failed job with a retry behind it.
        expect(await port.resolveUserId(context.reviewer.unknownHandle)).toBeNull();
      });

      /**
       * WP-34, Q82 (a): the commit a merge request's diff is taken against.
       *
       * **Non-null where the harness arranged one**, which is what round 2 changed: the first
       * version accepted *"a sha or `null`"* for every harness, and `shaSchema` already refuses an
       * empty string, a branch name and a truncated sha at the port's own parse — so the case was a
       * tautology, and a `base_sha: null` mutant in the GitLab adapter passed it while refusing
       * every real ticket from a shadow batch (`shadow/batch.ts`'s `no_comparison_base`). A harness
       * whose fixtures publish none says so with `mergeBaseIid: null` and gets the tolerant
       * assertion, because GitLab documents `diff_refs` as *"empty when the merge request is
       * created, and populates asynchronously"* and a suite that demanded one would be demanding a
       * fixture nobody can honestly record. The **refusal** that rests on this is the platform's,
       * not the adapter's.
       */
      it('answers a merge base for the merge request the harness published one for', async () => {
        const mr = await port.getMergeRequest(
          mrRef(context.mergeBaseIid ?? context.mergeRequestIid),
        );
        if (context.mergeBaseIid === null) {
          expect(mr.base_sha === null || mr.base_sha === undefined || mr.base_sha.length >= 7).toBe(
            true,
          );
          return;
        }
        expect(typeof mr.base_sha).toBe('string');
        expect(mr.base_sha ?? '').toMatch(/^[0-9a-f]{7,}$/);
      });

      /**
       * WP-35: product/19 §18's third input, and the method `GitProviderPort` had none for.
       *
       * **Two cases, because one of them is a tautology on its own.** The wide window asserts that
       * the harness's own commit is there with its message; an adapter that ignored `since`
       * entirely would pass it. The narrow window is the discriminating negative (standing rule
       * 43): a `since` after every commit the harness has must answer without that commit, which
       * only an adapter that actually sends the parameter can do. Both sides of the boundary are
       * asserted rather than one (standing rule 42).
       */
      it('lists commit messages since an instant', async () => {
        const commits = await port.listCommits(context.project, {
          since: context.commits.since,
          limit: 20,
        });
        const found = commits.find((commit) => commit.sha === context.commits.sha);
        expect(found, `no commit ${context.commits.sha} in the window`).toBeDefined();
        expect(found?.message).toContain(context.commits.message);
        for (const commit of commits) {
          expect(Date.parse(commit.committed_at)).not.toBeNaN();
          expect(Date.parse(commit.committed_at)).toBeGreaterThanOrEqual(
            Date.parse(context.commits.since),
          );
        }
      });

      it('answers without a commit older than the window it was asked for', async () => {
        const commits = await port.listCommits(context.project, {
          since: context.commits.emptySince,
          limit: 20,
        });
        expect(commits.map((commit) => commit.sha)).not.toContain(context.commits.sha);
      });

      /**
       * WP-110: the merge-request poller's read. Every state, oldest update first (the poller's
       * cursor is the newest `updated_at` of a page, so any other order moves it past merge requests
       * it never read), and the window honoured both ways.
       */
      it('lists merge requests of every state updated since an instant, oldest first (WP-110)', async () => {
        const listed = await port.listMergeRequests(context.project, {
          updatedAfter: context.listing.since,
          limit: 20,
        });
        for (const entry of listed) {
          mergeRequestListingSchema.parse(entry);
          expect(Date.parse(entry.updated_at)).toBeGreaterThanOrEqual(
            Date.parse(context.listing.since),
          );
        }
        const instants = listed.map((entry) => Date.parse(entry.updated_at));
        expect(instants, 'oldest first').toEqual(instants.toSorted((left, right) => left - right));
        const byIid = new Map(listed.map((entry) => [entry.ref.iid, entry]));
        expect(byIid.get(context.listing.openIid)?.state).toBe('opened');
        const merged = byIid.get(context.listing.mergedIid);
        expect(merged?.state).toBe('merged');
        expect(Number.isNaN(Date.parse(merged?.merged_at ?? ''))).toBe(false);
      });

      it('answers without a merge request older than the window it was asked for (WP-110)', async () => {
        const listed = await port.listMergeRequests(context.project, {
          updatedAfter: context.listing.emptySince,
          limit: 20,
        });
        expect(listed.map((entry) => entry.ref.iid)).not.toContain(context.listing.openIid);
        expect(listed.map((entry) => entry.ref.iid)).not.toContain(context.listing.mergedIid);
      });

      it('polls its merge requests only when the binding switched polling on (WP-110)', () => {
        expect(port.pollPlan()).toBeNull();
        const plan = mergeRequestPollPlanSchema.parse(context.polling.port.pollPlan());
        expect(plan.interval_seconds).toBe(context.polling.intervalSeconds);
      });

      /**
       * WP-123 (backlog 373): the poller reads the default branch and the waiting merge requests'
       * notes **only** for a binding no webhook reaches — so the plan has to tell the two apart, in
       * both directions (rule 42): a provider that always said `false` would read twice on a
       * webhook binding, and one that always said `true` would leave a poll-only binding deaf.
       */
      it('says whether a webhook can reach the binding, so a poll-only binding is told apart (WP-123)', () => {
        expect(mergeRequestPollPlanSchema.parse(context.polling.port.pollPlan())).toMatchObject({
          receives_webhooks: true,
        });
        expect(
          mergeRequestPollPlanSchema.parse(context.polling.pollOnlyPort.pollPlan()),
        ).toMatchObject({ receives_webhooks: false });
      });

      /**
       * WP-123: what the review-note read stands on — each note's instant, its `system` flag, its
       * body as written (the platform's marker is read off it) and the thread it belongs to.
       */
      it('lists the notes a poll reads: the thread, the instant, the system flag and the body (WP-123)', async () => {
        const discussions = await port.listDiscussions(mrRef(context.notes.iid));
        const notes = discussions.flatMap((discussion) =>
          discussion.notes.map((note) => ({ thread: discussion.id, note })),
        );
        const byId = new Map(notes.map((entry) => [entry.note.id, entry]));
        const human = byId.get(context.notes.human.noteId);
        expect(human?.thread).toBe(context.notes.human.threadId);
        expect(human?.note.system).toBe(false);
        expect(Date.parse(human?.note.created_at ?? '')).toBe(Date.parse(context.notes.human.at));
        expect(byId.get(context.notes.systemNoteId)?.note.system).toBe(true);
        const platform = byId.get(context.notes.platformNoteId)?.note;
        expect(platform?.system).toBe(false);
        expect(platform?.body.trimStart().startsWith('<!-- agentic:')).toBe(true);
      });

      it('lists merged merge requests since an instant', async () => {
        const merged = await port.listMergedMergeRequests(
          context.project,
          '2000-01-01T00:00:00.000Z',
          10,
        );
        for (const entry of merged) {
          expect(Date.parse(entry.merged_at)).not.toBeNaN();
          expect(entry.discussion_count).toBeGreaterThanOrEqual(0);
        }
      });
    });

    describe('inbound (BD-022)', () => {
      it('verifies a delivery and rejects a tampered body', () => {
        const delivery = context.emitReviewComment('please fix');
        expect(port.inbound.verify(delivery)).toBe(true);
        expect(port.inbound.verify({ headers: delivery.headers, body: `${delivery.body} ` })).toBe(
          false,
        );
      });

      it('normalises a review comment with the author identity resolved', async () => {
        const userId = '00000000-0000-4000-8000-00000000f002';
        const result = await port.inbound.normalise(
          context.emitReviewComment('nit: rename this'),
          inboundContext(() => userId),
        );
        expect(result.ignored).toEqual([]);
        const [event] = result.events;
        const { payload } = expectCatalogueEvent(
          event as NonNullable<typeof event>,
          'mr.review.comment',
        );
        expect(payload.text).toBe('nit: rename this');
        expect((payload.author as ExternalIdentity).verified).toBe(true);
      });

      it('normalises an approval into mr.approved, naming the person who approved', async () => {
        const userId = '00000000-0000-4000-8000-00000000f003';
        const result = await port.inbound.normalise(
          context.emitApproval(),
          inboundContext(() => userId),
        );
        expect(result.ignored).toEqual([]);
        expect(result.events).toHaveLength(1);
        const [event] = result.events;
        const { payload } = expectCatalogueEvent(event as NonNullable<typeof event>, 'mr.approved');
        expect((payload.mr as { iid: number }).iid).toBe(context.mergeRequestIid);
        const approver = payload.approver as ExternalIdentity;
        expect(approver.external_id).toBe(context.approverExternalId);
        expect(approver.verified, 'the resolver maps the approver').toBe(true);
      });

      it('normalises an update into mr.updated, carrying the provider’s own instant', async () => {
        const result = await port.inbound.normalise(context.emitUpdated(), inboundContext());
        expect(result.ignored).toEqual([]);
        const [event] = result.events;
        const { payload } = expectCatalogueEvent(event as NonNullable<typeof event>, 'mr.updated');
        expect(payload.updated_at, 'an update the pipeline can order').not.toBeNull();
        expect(Number.isNaN(Date.parse(payload.updated_at as string))).toBe(false);
      });

      it('normalises a merge into mr.merged', async () => {
        const result = await port.inbound.normalise(context.emitMerged(), inboundContext());
        const [event] = result.events;
        expectCatalogueEvent(event as NonNullable<typeof event>, 'mr.merged');
      });

      it('normalises a finished pipeline with its failing jobs', async () => {
        const result = await port.inbound.normalise(
          context.emitPipelineFinished(),
          inboundContext(),
        );
        const [event] = result.events;
        const { payload } = expectCatalogueEvent(
          event as NonNullable<typeof event>,
          'ci.pipeline.finished',
        );
        expect(payload.head_sha).toBe(context.pipelineSha);
        expect(Array.isArray(payload.failed_jobs)).toBe(true);
        expect((payload.failed_jobs as { name: string }[]).map((job) => job.name)).toContain(
          context.failingJobName,
        );
      });
    });
  });
};
