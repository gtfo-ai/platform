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
  ExternalIdentity,
  GitProviderPort,
  InboundContext,
  MintedCredential,
  WebhookDelivery,
} from '@platform/application';
import { mergeRequestSchema } from '@platform/application';
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

      it('reports the default branch head', async () => {
        const head = await port.getDefaultBranchHead(context.project);
        expect(head.branch.length).toBeGreaterThan(0);
        expect(head.sha).toMatch(/^[0-9a-f]{7,64}$/);
      });

      it('fails with not_found for a project that does not exist', async () => {
        await expectIntegrationError(
          () => port.getDefaultBranchHead(context.missingProject),
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
        const foreign: MintedCredential = {
          username: 'oauth2',
          // Obviously fake, and foreign to every provider: no harness mints this (BD-002).
          value: 'FAKE-credential-minted-by-another-process',
          scope: 'push',
          branchPatterns: ['agentic/*'],
          // Far enough out that no provider can answer "expired" where it owes "not mine".
          expiresAt: '2099-01-01T00:00:00.000Z',
          revokeId: context.foreignRevokeId,
        };
        await expectIntegrationError(() => port.revokeCredential(foreign), 'not_found');
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
            () => port.readCodeowners(context.project, 'main'),
            'unsupported_capability',
          );
          return;
        }
        const rules = await port.readCodeowners(context.project, 'main');
        expect(rules).not.toBeNull();
        expect(rules?.rules.length).toBeGreaterThan(0);
        for (const rule of rules?.rules ?? []) {
          expect(rule.owners.length).toBeGreaterThan(0);
        }
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
