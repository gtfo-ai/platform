/**
 * WP-141 criterion (2) — TD-028 decision 13a: the probe of an **operator's own** repository-only run
 * token, made through the real GitLab adapter against the recorded corpus (`run-token-scope.json`,
 * `instance.json`, `project-members.json`, each interaction with its `source` block), through the
 * real executor into a memory audit log.
 *
 * What it holds:
 *
 *  - the dedicated-user role check is **replaced**: a Maintainer's or an Owner's token is accepted,
 *    and no membership is read at all;
 *  - the scope proof is one `GET /user` **with the run token** — a `403` accepts, a `200` is refused
 *    naming the scopes, a `401` is refused as a token GitLab does not accept;
 *  - the protection check reads the bound project's stored default branch with the **API** token and
 *    refuses an unprotected branch, a Maintainers-push rule and a force push, naming the branch and
 *    the setting;
 *  - `dedicated_user` is unchanged: a Maintainer is still refused (WP-137's case, here on the adapter).
 *
 * The replay is built from the three files this probe reads rather than the whole corpus, so the
 * corpus-wide "every fixture served" check stays with `gitlab.contract.test.ts`, which serves these
 * interactions through the shared suite.
 */
import {
  allowAnyIntegrationHost,
  type BindingRepository,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  type IntegrationAccount,
  type MemoryIntegrationAuditLog,
  noSecretsRedactor,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import {
  type AnyProviderRegistration,
  createGitLabProvider,
  createIntegrationProber,
  createIntegrationRegistry,
  gitlabAdapterInput,
  gitlabConfigSchema,
  gitlabProviderRegistration,
} from '@platform/integrations';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLOCK_AT, GITLAB_HOST, GITLAB_PROJECT } from '../support/integrations/gitlab-fixtures.js';
import {
  FAKE_BINDING_TOKEN,
  GITLAB_FAKE_RUN_TOKENS,
} from '../support/integrations/gitlab-harness.js';
import {
  createGitLabReplay,
  type GitLabReplay,
  loadReplayFixture,
} from '../support/integrations/gitlab-replay.js';

const INTEGRATION = '00000000-0000-4000-8000-0000000001a1' as Id;
const SECRET = '00000000-0000-4000-8000-0000000001a2' as Id;

let replay: GitLabReplay;
let auditLog: MemoryIntegrationAuditLog;

beforeEach(() => {
  replay = createGitLabReplay(
    ['instance', 'run-token-scope', 'project-members'].flatMap((name) => loadReplayFixture(name)),
  );
  auditLog = createMemoryAuditLog();
});

/** GitLab's own registration, its adapter on the replay transport instead of the network. */
const registration = (): AnyProviderRegistration => ({
  ...gitlabProviderRegistration,
  create: (input) => {
    const adapter = gitlabAdapterInput(input);
    return createGitLabProvider({
      integrationId: input.integrationId,
      config: gitlabConfigSchema.parse(adapter.config),
      secrets: adapter.secrets,
      redactor: input.redactor,
      fetchImpl: replay.fetchImpl,
      clock: fixedClock(CLOCK_AT),
    });
  },
});

const proberFor = (input: {
  readonly owner: 'dedicated_user' | 'operator';
  readonly runToken: string;
  readonly username: string;
  readonly defaultBranch?: string;
}) => {
  const account: IntegrationAccount = {
    integrationId: INTEGRATION,
    type: 'git',
    provider: 'gitlab',
    name: 'acme gitlab',
    config: {
      base_url: GITLAB_HOST,
      project: GITLAB_PROJECT,
      request_timeout_ms: 0,
      run_credential: 'static',
      run_token_owner: input.owner,
      run_token_username: input.username,
      run_token_expires_at: '2026-12-01',
    },
    secretIds: [SECRET],
    bindings: [],
  };
  const repository: BindingRepository = {
    forProject: async () => [],
    forIntegration: async () => account,
  };
  return createIntegrationProber({
    repository,
    secrets: { resolve: async () => ({ token: FAKE_BINDING_TOKEN, run_token: input.runToken }) },
    registry: createIntegrationRegistry([registration()]),
    executor: createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog,
      // Redacts nothing, so an audit row free of the run token is the prober's doing, not the log's.
      redactor: noSecretsRedactor(),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: fixedClock(CLOCK_AT, 1000),
    }),
    boundProjectOf: async () => ({
      path: GITLAB_PROJECT,
      defaultBranch: input.defaultBranch ?? 'main',
    }),
  });
};

const checkNamed = (
  outcome: Awaited<ReturnType<ReturnType<typeof proberFor>['test']>>,
  name: string,
) => outcome?.checks.find((check) => check.name === name);

/** Every request that carried `token` in its `PRIVATE-TOKEN` header. */
const sentWith = (token: string) =>
  replay.requests.filter((request) => request.headers['private-token'] === token);

describe('the probe of an operator’s own run token, on the GitLab adapter (WP-141)', () => {
  it.each([
    ['a Maintainer', 'agentic-maintainer'],
    ['an Owner', 'acme-owner'],
  ])(
    'accepts %s’s repository-only token behind a No-one default branch, reading no membership',
    async (_role, username) => {
      const outcome = await proberFor({
        owner: 'operator',
        runToken: GITLAB_FAKE_RUN_TOKENS.repositoryOnly,
        username,
      }).test(INTEGRATION);
      expect(outcome?.ok).toBe(true);
      expect(checkNamed(outcome, 'run_credential')).toMatchObject({
        ok: true,
        detail: expect.stringMatching(
          /cannot call the API.*403 \(insufficient_scope\).*every repository/,
        ),
      });
      expect(checkNamed(outcome, 'default_branch_protection')).toMatchObject({
        ok: true,
        detail: expect.stringMatching(/main of acme\/api is protected with push "No one"/),
      });
      expect(
        replay.requests.filter((request) => request.key.includes('/members/')),
        'the role is not what this token can use, so no membership is read',
      ).toEqual([]);
      // The scope proof is the one request with the run token, and it carries nothing else.
      expect(sentWith(GITLAB_FAKE_RUN_TOKENS.repositoryOnly).map((request) => request.key)).toEqual(
        ['GET /user [private-token FAKE-run-token-repository-only-DO-NOT-USE]'],
      );
      expect(auditLog.entriesFor('check_run_token_scope')).toHaveLength(1);
      expect(auditLog.entriesFor('check_default_branch_protection')).toHaveLength(1);
      expect(JSON.stringify(auditLog.entries)).not.toContain(GITLAB_FAKE_RUN_TOKENS.repositoryOnly);
    },
  );

  it('refuses a token that can call the API, naming the two scopes', async () => {
    const outcome = await proberFor({
      owner: 'operator',
      runToken: GITLAB_FAKE_RUN_TOKENS.apiCapable,
      username: 'acme-operator',
    }).test(INTEGRATION);
    expect(outcome?.ok).toBe(false);
    expect(checkNamed(outcome, 'run_credential')).toMatchObject({
      ok: false,
      detail: expect.stringMatching(
        /this token can call the GitLab API; create one with only `read_repository` and `write_repository` \(the provider answered 200\)/,
      ),
    });
  });

  /** Review round 1: a 403 that is not `insufficient_scope` — a proxy or a firewall — is refused by name. */
  it('refuses a 403 that is not a refusal for the token’s scope, naming what it was', async () => {
    const outcome = await proberFor({
      owner: 'operator',
      runToken: GITLAB_FAKE_RUN_TOKENS.blockedElsewhere,
      username: 'acme-operator',
    }).test(INTEGRATION);
    expect(outcome?.ok).toBe(false);
    expect(checkNamed(outcome, 'run_credential')).toMatchObject({
      ok: false,
      detail: expect.stringMatching(
        /answered 403 with no error code, not a refusal for the token's scope/,
      ),
    });
  });

  it('refuses a token GitLab does not accept at all', async () => {
    const outcome = await proberFor({
      owner: 'operator',
      runToken: GITLAB_FAKE_RUN_TOKENS.unknown,
      username: 'acme-operator',
    }).test(INTEGRATION);
    expect(checkNamed(outcome, 'run_credential')).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/did not accept the run token at all \(401\)/),
    });
  });

  it.each([
    ['develop', /develop of acme\/api is not protected/],
    // Review round 1: an exact No-one rule loosened by the wildcard `rel*` (most permissive wins).
    ['release', /release of acme\/api lets No one, Maintainers \(rule rel\*\) push/],
    ['main-hotfix', /main-hotfix of acme\/api allows force push/],
    ['stable', /stable of acme\/api allows force push/],
  ])(
    'refuses a default branch %s whose protection does not bound the token, by name',
    async (branch, words) => {
      const outcome = await proberFor({
        owner: 'operator',
        runToken: GITLAB_FAKE_RUN_TOKENS.repositoryOnly,
        username: 'acme-operator',
        defaultBranch: branch,
      }).test(INTEGRATION);
      expect(outcome?.ok).toBe(false);
      const check = checkNamed(outcome, 'default_branch_protection');
      expect(check?.ok).toBe(false);
      expect(check?.detail).toMatch(words);
      expect(check?.detail).toMatch(/protect .* with push "No one" and force push off/);
      // The protection is read with the API token, never the run token.
      expect(sentWith(FAKE_BINDING_TOKEN).map((request) => request.key)).toContain(
        'GET /projects/acme%2Fapi/protected_branches?page=1&per_page=100',
      );
    },
  );

  /** Criterion (4)'s third canary, on the adapter: WP-137's dedicated-user role check is unchanged. */
  it('still refuses a Maintainer for a dedicated user, and sends the run token nowhere', async () => {
    const outcome = await proberFor({
      owner: 'dedicated_user',
      runToken: GITLAB_FAKE_RUN_TOKENS.repositoryOnly,
      username: 'agentic-maintainer',
    }).test(INTEGRATION);
    expect(checkNamed(outcome, 'run_credential')).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/is Maintainer on acme\/api/),
    });
    expect(checkNamed(outcome, 'default_branch_protection')).toBeUndefined();
    expect(sentWith(GITLAB_FAKE_RUN_TOKENS.repositoryOnly)).toEqual([]);
  });
});
