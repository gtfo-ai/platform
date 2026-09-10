/**
 * The GitProvider contract suite against the **real GitLab adapter**, in replay
 * (WP-09 acceptance: "contract suite in replay").
 *
 * Not one line of `git-provider-contract-suite.ts` changed for this runner, which is the BD-017
 * claim being tested as much as the adapter is: adding a provider is a module, a registration, a
 * setup guide and a runner.
 *
 * Every response comes from `test/fixtures/http/gitlab/*.json`, each interaction carrying the
 * documentation URL it was transcribed from and whether that shape is `documented` or `inferred`.
 * The adapter's `fetch` is injected, so nothing here opens a socket, sleeps or reads a wall clock.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { runGitProviderContract } from '../support/integrations/git-provider-contract-suite.js';
import {
  CLOCK_AT,
  FAKE_SECRET_TOKEN,
  FOREIGN_TOKEN_ID,
  GITLAB_HOST,
  GITLAB_PROJECT,
  legacyDelivery,
  mergedHookBody,
  pushHookBody,
  SHA_MAIN,
  signedDelivery,
} from '../support/integrations/gitlab-fixtures.js';
import { gitlabReplayContext } from '../support/integrations/gitlab-harness.js';
import {
  closeFixtureAssertionWindow,
  loadReplayFixture,
  type ReplayInteraction,
  replayFixtureNames,
  unassertedFixtureServes,
  unusedFixtures,
} from '../support/integrations/gitlab-replay.js';

runGitProviderContract({
  name: 'gitlab (replay against recorded fixtures)',
  create: async () => gitlabReplayContext(),
});

/**
 * The corpus is held to the suite, not just the suite to the corpus (WP-09 review round 1).
 *
 * Round 1 shipped a per-instance `unused()` that nothing ever called, so a fixture no test
 * exercised — a recorded 404, a documented shape nobody reads — sat there looking like coverage.
 * This file is where every fixture file is loaded and where the whole contract suite runs, so it
 * is where the check belongs; it counts interactions rather than keys, so the second answer in a
 * queue cannot hide behind the first.
 *
 * Round 2 found the half it could not see: **it counted execution, not assertion.** Deleting all
 * three `expect`s from the `branchProtection` test while keeping both calls passed 32 of 32,
 * because the fixtures were still served. `unassertedFixtureServes()` is the companion — every
 * serve must be followed by an assertion inside the same test — and its docblock states exactly
 * what it still cannot prove (that the assertion is *about* the response). Both are asserted
 * below; neither is sufficient alone.
 */
afterEach(() => {
  closeFixtureAssertionWindow();
});

afterAll(() => {
  expect(
    unusedFixtures(),
    'every recorded interaction must be exercised: write the test, or delete the fixture',
  ).toEqual([]);
  expect(
    unassertedFixtureServes(),
    'every fixture a test fetched must be followed by an assertion in that test: a call is not a check',
  ).toEqual([]);
});

/**
 * Standing rule 17 applied to this corpus, which nothing else applies it to.
 *
 * `ReplayInteraction.source` is required *by the type*, and `loadReplayFixture` casts the parsed
 * JSON rather than validating it — so until this test existed a fixture could lose its `source`
 * block, or name `https://example.invalid`, and every test in this file would still pass. That is
 * exactly the mutation that survived 157 tests at WP-08's review.
 *
 * What it deliberately does not claim: that docs.gitlab.com still says what the fixture says it
 * says. No test can check that; only a human re-reading the page can, which is what `retrieved`
 * is for. What is checkable is that the claim was *made*, points at the vendor's own
 * documentation, and distinguishes a documented shape from an inferred one.
 */
it('every recorded interaction names a vendor page, a retrieval date and a kind', () => {
  const complaints = replayFixtureNames().flatMap((name) =>
    loadReplayFixture(name).flatMap((interaction, index) => {
      const where = `${name}.json #${index} (${interaction.method} ${interaction.path})`;
      // Cast to the partial shape on purpose: the point is that the file on disk may not have it.
      const source = interaction.source as Partial<ReplayInteraction['source']> | undefined;
      if (source === undefined) {
        return [`${where}: no source block`];
      }
      const problems: string[] = [];
      if (!/^https:\/\/docs\.gitlab\.com\//.test(source.url ?? '')) {
        problems.push(`url ${String(source.url)} is not a page on the vendor's documentation`);
      }
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(source.retrieved ?? '') ||
        Number.isNaN(Date.parse(source.retrieved ?? ''))
      ) {
        problems.push(`retrieved ${String(source.retrieved)} is not a date`);
      }
      if (source.kind !== 'documented' && source.kind !== 'inferred') {
        problems.push(`kind ${String(source.kind)} is neither documented nor inferred`);
      }
      return problems.map((problem) => `${where}: ${problem}`);
    }),
  );
  expect(
    complaints,
    'a provenance label is a claim about the corpus, and an unasserted claim drifts (rule 17)',
  ).toEqual([]);
});

/**
 * The harness's own guard (standing rule 4: a positive assertion fails loudly on a broken harness).
 *
 * If the replay transport answered an unmatched request with an empty body instead of throwing,
 * every assertion in the suite above would still pass while asserting nothing about the adapter.
 */
it('gitlab replay refuses a request it has no fixture for', async () => {
  const context = gitlabReplayContext();
  let caught: unknown;
  try {
    await context.port.getMergeRequest({
      provider: 'gitlab',
      project_path: GITLAB_PROJECT,
      iid: 999,
      url: `${GITLAB_HOST}/acme/api/-/merge_requests/999`,
      branch: null,
      head_sha: null,
    });
  } catch (error) {
    caught = error;
  }
  expect(caught, 'an unmatched request must fail, never answer').toBeInstanceOf(Error);
  // The adapter maps a transport failure to `unavailable`; the harness's own complaint — which
  // names the key it looked for — survives on the cause, so a missing fixture is debuggable
  // rather than a mystery 21 assertions later.
  expect(
    String((caught as Error).cause),
    'the replay transport names the key it could not serve',
  ).toContain('no fixture for GET /projects/acme%2Fapi/merge_requests/999');
});

/**
 * What the shared suite cannot reach, because it belongs to GitLab and to WP-09's review.
 *
 * All three exercise fixtures that nothing else does, which is now a failure rather than a
 * shrug: `unusedFixtures()` above is what turned "there is a recorded 404 for a protected-branch
 * lookup" into "and no test has ever sent that request".
 */
describe('GitLab in replay: revocation, and the Q40 compensating control', () => {
  /**
   * The round 1 major, through the port. Absorbing a 404 is right only where the adapter minted
   * the token; for a handle it did not mint, "already revoked" and "never existed here" are the
   * same response, and reporting success is how a live push token looked revoked.
   */
  it('will not report success for a revocation it cannot substantiate', async () => {
    const { port, replay } = gitlabReplayContext();
    let caught: unknown;
    try {
      await port.revokeCredential({
        username: 'oauth2',
        value: 'FAKE-token-from-another-process',
        scope: 'push',
        branchPatterns: ['agentic/*'],
        expiresAt: '2026-06-02T00:00:00.000Z',
        // Well-formed, and this provider never minted it: another process, or a restart.
        revokeId: `${GITLAB_PROJECT}#${FOREIGN_TOKEN_ID}`,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught, 'an unconfirmable revocation must not resolve').toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('not_found');
    expect(
      replay.requests.map((request) => request.key),
      "and it asked at the address the handle carries, not at the binding's project",
    ).toEqual(['DELETE /projects/acme%2Fapi/access_tokens/59']);
  });

  it('reports the default branch protected and an agentic branch not (Q40)', async () => {
    const { gitlab } = gitlabReplayContext();
    expect(
      await gitlab.isBranchProtected(GITLAB_PROJECT, 'main'),
      'BD-025 wants a token that cannot push to main; GitLab has no branch-scoped token, so this is the control',
    ).toBe(true);
    expect(
      await gitlab.isBranchProtected(GITLAB_PROJECT, 'agentic/task-1'),
      'and the namespace the agent works in is pushable',
    ).toBe(false);
  });

  it('reads the protection rules, and answers null for a branch that has none', async () => {
    const { gitlab } = gitlabReplayContext();
    const main = await gitlab.branchProtection(GITLAB_PROJECT, 'main');
    expect(main?.name).toBe('main');
    expect(main?.pushAccessLevels, '0 is GitLab\'s "No one"').toEqual([0]);
    expect(main?.codeOwnerApprovalRequired).toBe(true);
    expect(
      await gitlab.branchProtection(GITLAB_PROJECT, 'agentic/task-1'),
      'no protection rule is null, not an empty rule set that reads like one',
    ).toBeNull();
  });

  /**
   * The documented lookup order, end to end: "GitLab checks these locations in your repository in
   * this order. The first `CODEOWNERS` file found is used, and all others are ignored."
   */
  it('falls through the three CODEOWNERS locations in the documented order', async () => {
    const context = gitlabReplayContext();
    context.replay.script({
      method: 'GET',
      path: '/projects/acme%2Fapi/repository/files/CODEOWNERS/raw?ref=main',
      status: 404,
      body: { message: '404 File Not Found' },
      source: {
        url: 'https://docs.gitlab.com/api/repository_files/',
        retrieved: '2026-09-10',
        kind: 'inferred',
        note: 'Scripted: a repository whose root CODEOWNERS is absent, so the fallbacks are reached.',
      },
    });

    expect(
      await context.port.readCodeowners(GITLAB_PROJECT, 'main'),
      'no CODEOWNERS anywhere is null — an empty rule set would read like "nobody owns anything"',
    ).toBeNull();
    expect(
      context.replay.requests.map((request) => request.key),
      'root, then docs/, then .gitlab/, and it stops at the first file it finds',
    ).toEqual([
      'GET /projects/acme%2Fapi/repository/files/CODEOWNERS/raw?ref=main',
      'GET /projects/acme%2Fapi/repository/files/docs%2FCODEOWNERS/raw?ref=main',
      'GET /projects/acme%2Fapi/repository/files/.gitlab%2FCODEOWNERS/raw?ref=main',
    ]);
  });
});

/**
 * The half of the inbound contract the shared suite cannot reach.
 *
 * `git-provider-contract-suite.ts` drives one signature scheme, because a type port has no opinion
 * about how many a provider has. GitLab has two, and an operator migrating between them runs both
 * at once, so both are exercised end to end **through the port** here — not against the verifier
 * in isolation. Rule 4 order applies: each rejection follows an acceptance built by the same
 * harness.
 */
describe('GitLab inbound, through the port, in replay', () => {
  const inboundContext = (context: ReturnType<typeof gitlabReplayContext>) => ({
    projectId: context.projectId,
    integrationId: context.integrationId,
    resolveUser: () => null,
  });

  it('accepts a legacy X-Gitlab-Token delivery, then rejects a wrong token', () => {
    const { port } = gitlabReplayContext();
    const good = legacyDelivery('Merge Request Hook', mergedHookBody());
    expect(port.inbound.verify(good), 'the legacy scheme still works').toBe(true);
    expect(
      port.inbound.verify(legacyDelivery('Merge Request Hook', mergedHookBody(), 'fake-wrong')),
    ).toBe(false);
    expect(FAKE_SECRET_TOKEN.length, 'the harness really configured a token').toBeGreaterThan(0);
  });

  it('accepts a signed delivery, then rejects one signed with another key', () => {
    const { port } = gitlabReplayContext();
    expect(port.inbound.verify(signedDelivery('Merge Request Hook', mergedHookBody()))).toBe(true);
    expect(
      port.inbound.verify(
        signedDelivery('Merge Request Hook', mergedHookBody(), {
          signingToken: `whsec_${Buffer.from('another-fake-key-entirely').toString('base64')}`,
        }),
      ),
      'a signature made with a different key must not verify',
    ).toBe(false);
  });

  it('rejects a signed delivery replayed from outside the tolerance window', () => {
    const { port } = gitlabReplayContext();
    const stale = new Date(Date.parse(CLOCK_AT) - 3_600_000).toISOString();
    expect(
      port.inbound.verify(signedDelivery('Merge Request Hook', mergedHookBody(), { at: stale })),
    ).toBe(false);
  });

  it('normalises a push onto the default branch into default_branch.moved', async () => {
    const context = gitlabReplayContext();
    const delivery = signedDelivery('Push Hook', pushHookBody());
    expect(context.port.inbound.verify(delivery)).toBe(true);

    const result = await context.port.inbound.normalise(delivery, inboundContext(context));
    expect(result.ignored).toEqual([]);
    const event = result.events[0];
    expect(event?.type).toBe('default_branch.moved');
    expect((event?.payload as { new_head: string } | undefined)?.new_head).toBe(SHA_MAIN);
  });

  it('drops a push onto a feature branch and says why', async () => {
    const context = gitlabReplayContext();
    const delivery = signedDelivery(
      'Push Hook',
      pushHookBody('refs/heads/agentic/task-1', SHA_MAIN),
    );
    const result = await context.port.inbound.normalise(delivery, inboundContext(context));
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.reason).toBe('unsupported_event');
  });

  it('keys the same change identically and a different change differently', () => {
    const { port } = gitlabReplayContext();
    const first = port.inbound.deliveryKey(signedDelivery('Merge Request Hook', mergedHookBody()));
    const redelivered = port.inbound.deliveryKey(
      // A redelivery of the same change carries a new `webhook-id`; the dedup key must not.
      signedDelivery('Merge Request Hook', mergedHookBody(), { messageId: 'a-different-id' }),
    );
    expect(redelivered, 'a redelivery of one change dedups against the first').toBe(first);
    expect(port.inbound.deliveryKey(signedDelivery('Push Hook', pushHookBody()))).not.toBe(first);
  });
});
