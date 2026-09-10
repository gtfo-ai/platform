/**
 * The adapter itself, against a scripted transport.
 *
 * The contract suite in `test/contract/integrations/gitlab.contract.test.ts` proves the port; this
 * file proves the things the shared suite cannot express because they are GitLab's and nobody
 * else's — the asynchronous `merge_status` transition, the protected-branch check, what a mint
 * failure means on a Free gitlab.com plan, and the redaction TD-012 puts on a CI job log.
 */
import {
  IntegrationError,
  IntegrationUnsupportedError,
  noSecretsRedactor,
  type SecretRedactor,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { gitlabConfigSchema } from './config.js';
import type { GitLabFetch } from './http.js';
import { createGitLabProvider, type GitLabProvider } from './provider.js';

const AT = '2026-06-01T08:00:00.000Z';
const HOST = 'https://gitlab.example.test';
const PROJECT = 'acme/api';
const P = 'acme%2Fapi';
const TOKEN = 'FAKE-binding-api-token-DO-NOT-USE';

interface Scripted {
  readonly status: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly headers?: Record<string, string>;
}

interface Harness {
  readonly port: GitLabProvider;
  readonly calls: { method: string; path: string; body: string | undefined }[];
  readonly redactions: { action: string; count: number }[];
}

const build = (
  script: Record<string, Scripted | Scripted[]>,
  options: {
    readonly config?: Record<string, unknown>;
    readonly redactor?: SecretRedactor;
  } = {},
): Harness => {
  const queues = new Map<string, Scripted[]>();
  for (const [key, value] of Object.entries(script)) {
    queues.set(key, Array.isArray(value) ? [...value] : [value]);
  }
  const calls: Harness['calls'] = [];
  const redactions: Harness['redactions'] = [];

  const fetchImpl: GitLabFetch = async (url, init) => {
    const parsed = new URL(url);
    const path = `${parsed.pathname.replace('/api/v4', '')}${parsed.search}`;
    const key = `${init.method} ${path}`;
    calls.push({ method: init.method, path, body: init.body });
    const queue = queues.get(key);
    if (queue === undefined || queue.length === 0) {
      throw new Error(
        `no scripted response for ${key}; scripted: ${[...queues.keys()].join(', ')}`,
      );
    }
    const next = (queue.length === 1 ? queue[0] : queue.shift()) as Scripted;
    const body = next.text ?? (next.body === undefined ? '' : JSON.stringify(next.body));
    return new Response(next.status === 204 ? null : body, {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  };

  const port = createGitLabProvider({
    integrationId: '00000000-0000-4000-8000-0000000000a9',
    config: gitlabConfigSchema.parse({
      base_url: HOST,
      project: PROJECT,
      mint_credentials: true,
      request_timeout_ms: 0,
      ...options.config,
    }),
    secrets: { token: TOKEN },
    fetchImpl,
    clock: fixedClock(AT),
    // Required (standing rule 31): a test that does not care still says which redactor it means.
    redactor: options.redactor ?? noSecretsRedactor(),
    onRedaction: (event) => redactions.push(event),
  });

  return { port, calls, redactions };
};

const mrBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 155016007,
  iid: 7,
  project_id: 1,
  title: 'Draft: fix the totals',
  description: '',
  state: 'opened',
  draft: true,
  source_branch: 'agentic/task-1',
  target_branch: 'main',
  sha: '1111111111111111111111111111111111111111',
  merge_status: 'can_be_merged',
  detailed_merge_status: 'mergeable',
  has_conflicts: false,
  labels: [],
  author: { id: 4242, username: 'agentic-bot', name: 'Agentic Bot' },
  reviewers: [],
  merged_at: null,
  web_url: `${HOST}/acme/api/-/merge_requests/7`,
  diff_refs: {
    base_sha: '2222222222222222222222222222222222222222',
    head_sha: '1111111111111111111111111111111111111111',
    start_sha: '2222222222222222222222222222222222222222',
  },
  ...overrides,
});

const mrRef = (iid = 7) => ({
  provider: 'gitlab',
  project_path: PROJECT,
  iid,
  url: `${HOST}/acme/api/-/merge_requests/${iid}`,
  branch: null,
  head_sha: null,
});

describe('mergeability is asynchronous and the adapter re-reads it', () => {
  /**
   * The case the shared suite can only assert one snapshot of.
   *
   * GitLab: "The mergeability (`merge_status`) of each merge request is checked asynchronously
   * when a request is made to this endpoint. **Poll this API endpoint** to get the updated
   * status." So the first read is `unchecked` and the second is `mergeable`, and the adapter must
   * report `null` and then `true` — not cache the first answer, and never turn `null` into
   * `false`.
   */
  it('reports null and then true across two reads of one merge request', async () => {
    const { port, calls } = build({
      [`GET /projects/${P}/merge_requests/7`]: [
        {
          status: 200,
          body: mrBody({
            merge_status: 'unchecked',
            detailed_merge_status: 'unchecked',
            has_conflicts: false,
          }),
        },
        { status: 200, body: mrBody() },
      ],
    });

    const first = await port.getMergeRequest(mrRef());
    expect(first.mergeable, 'not computed yet').toBeNull();
    expect(first.has_conflicts, 'and neither is the conflict flag').toBeNull();

    const second = await port.getMergeRequest(mrRef());
    expect(second.mergeable, 'the poll found the answer').toBe(true);
    expect(second.has_conflicts).toBe(false);

    expect(calls.length, 'the adapter asked twice; it does not cache mergeability').toBe(2);
  });
});

describe('the protected-branch check', () => {
  it('reads the documented `protected` boolean of the branch endpoint', async () => {
    const { port } = build({
      [`GET /projects/${P}/repository/branches/main`]: {
        status: 200,
        body: { name: 'main', protected: true, default: true, commit: { id: 'abc1234' } },
      },
      [`GET /projects/${P}/repository/branches/agentic%2Ftask-1`]: {
        status: 200,
        body: {
          name: 'agentic/task-1',
          protected: false,
          default: false,
          commit: { id: 'def5678' },
        },
      },
    });

    expect(await port.isBranchProtected(PROJECT, 'main')).toBe(true);
    expect(await port.isBranchProtected(PROJECT, 'agentic/task-1')).toBe(false);
  });

  it('surfaces the push and merge access levels, including 0 = no one', async () => {
    const { port } = build({
      [`GET /projects/${P}/protected_branches/main`]: {
        status: 200,
        body: {
          id: 101,
          name: 'main',
          push_access_levels: [{ id: 1001, access_level: 0, access_level_description: 'No one' }],
          merge_access_levels: [
            { id: 2001, access_level: 40, access_level_description: 'Maintainers' },
          ],
          allow_force_push: false,
          code_owner_approval_required: true,
        },
      },
    });

    expect(await port.branchProtection(PROJECT, 'main')).toEqual({
      name: 'main',
      allowForcePush: false,
      codeOwnerApprovalRequired: true,
      pushAccessLevels: [0],
      mergeAccessLevels: [40],
    });
  });

  it('answers null for a branch with no protection rule', async () => {
    const { port } = build({
      [`GET /projects/${P}/protected_branches/agentic%2Ftask-1`]: {
        status: 404,
        body: { message: '404 Not found' },
      },
    });
    expect(await port.branchProtection(PROJECT, 'agentic/task-1')).toBeNull();
  });
});

describe('credential minting', () => {
  const created = {
    id: 58,
    name: 'agentic-push-2026-06-02',
    scopes: ['read_repository', 'write_repository'],
    created_at: AT,
    expires_at: '2026-06-02',
    access_level: 30,
    active: true,
    revoked: false,
    user_id: 166,
    token: 'FAKE-project-access-token-DO-NOT-USE',
  };

  it('asks for a date, the documented scopes and the configured role', async () => {
    const { port, calls } = build({
      [`POST /projects/${P}/access_tokens`]: { status: 201, body: created },
    });
    const credential = await port.mintCredential({
      project: PROJECT,
      scope: 'push',
      branchPatterns: ['agentic/*'],
      ttlSeconds: 3600,
    });

    expect(JSON.parse(calls[0]?.body as string)).toEqual({
      name: 'agentic-push-2026-06-02',
      scopes: ['read_repository', 'write_repository'],
      expires_at: '2026-06-02',
      access_level: 30,
    });
    expect(
      credential.expiresAt,
      'the reported expiry is midnight UTC on the granted date, not now + ttl',
    ).toBe('2026-06-02T00:00:00.000Z');
    expect(credential.branchPatterns).toEqual(['agentic/*']);
    expect(
      credential.revokeId,
      'the handle is the whole revocation address, not just the token id',
    ).toBe(`${PROJECT}#58`);
  });

  it('uses the read role and read-only scope for a read credential', async () => {
    const { port, calls } = build({
      [`POST /projects/${P}/access_tokens`]: {
        status: 201,
        body: { ...created, scopes: ['read_repository'], access_level: 20 },
      },
    });
    const credential = await port.mintCredential({
      project: PROJECT,
      scope: 'read',
      ttlSeconds: 60,
    });
    expect(JSON.parse(calls[0]?.body as string).scopes).toEqual(['read_repository']);
    expect(JSON.parse(calls[0]?.body as string).access_level).toBe(20);
    expect(credential.branchPatterns, 'a read credential pushes nowhere').toEqual([]);
  });

  /**
   * The legibility requirement: an instance that cannot mint must say so, not 404.
   *
   * GitLab returns 404 both for "no such project" and for a feature the caller may not see, and
   * project access tokens need Premium or Ultimate on GitLab.com — plus a *personal* access token
   * to authenticate with, because "You cannot authenticate with a project access token".
   */
  it.each([404, 403])(
    'turns a %i on the token endpoint into an actionable refusal',
    async (status) => {
      const { port } = build({
        [`POST /projects/${P}/access_tokens`]: { status, body: { message: 'nope' } },
      });
      try {
        await port.mintCredential({ project: PROJECT, scope: 'push', ttlSeconds: 60 });
        expect.unreachable('a mint that cannot work must throw');
      } catch (error) {
        expect(error).toBeInstanceOf(IntegrationUnsupportedError);
        expect((error as IntegrationError).code).toBe('unsupported_capability');
        expect((error as Error).message).toMatch(/Premium or Ultimate/);
        expect((error as Error).message).toMatch(/personal access token/);
      }
    },
  );

  it('passes other failures through unchanged', async () => {
    const { port } = build({
      [`POST /projects/${P}/access_tokens`]: { status: 500, body: { message: 'boom' } },
    });
    try {
      await port.mintCredential({ project: PROJECT, scope: 'push', ttlSeconds: 60 });
      expect.unreachable('a 500 must throw');
    } catch (error) {
      expect((error as IntegrationError).code).toBe('unavailable');
    }
  });

  it('refuses to mint at all when the binding says it may not', async () => {
    const { port, calls } = build({}, { config: { mint_credentials: false } });
    expect(port.capabilities().credentialMinting).toBe(false);
    expect(port.capabilities().projectTokens).toBe(false);
    await expect(
      port.mintCredential({ project: PROJECT, scope: 'push', ttlSeconds: 60 }),
    ).rejects.toBeInstanceOf(IntegrationUnsupportedError);
    expect(calls, 'and it does not ask GitLab first').toEqual([]);
  });

  it('refuses a nonsensical ttl', async () => {
    const { port } = build({});
    await expect(
      port.mintCredential({ project: PROJECT, scope: 'push', ttlSeconds: 0 }),
    ).rejects.toBeInstanceOf(IntegrationError);
    await expect(
      port.mintCredential({ project: PROJECT, scope: 'push', ttlSeconds: 1.5 }),
    ).rejects.toBeInstanceOf(IntegrationError);
  });

  /**
   * The round 1 major.
   *
   * `mintCredential` mints on the project the *request* names; the binding's project is a
   * different thing. Sending the `DELETE` to the binding's project 404s on a real instance, the
   * "already gone" absorption swallows it, and the caller is told the credential was revoked while
   * the push token stays live until midnight UTC. Both projects answer `204` here on purpose: the
   * mutation has to die on the assertion below, not on an unscripted request.
   */
  it('revokes on the project the token was minted on, not the one the binding names', async () => {
    const { port, calls } = build({
      'POST /projects/other%2Frepo/access_tokens': { status: 201, body: created },
      'DELETE /projects/other%2Frepo/access_tokens/58': { status: 204 },
      [`DELETE /projects/${P}/access_tokens/58`]: { status: 204 },
    });
    const credential = await port.mintCredential({
      project: 'other/repo',
      scope: 'push',
      ttlSeconds: 3600,
    });
    expect(credential.revokeId, 'the handle names where the token lives').toBe('other/repo#58');

    await port.revokeCredential(credential);
    expect(
      calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
      'the DELETE must reach other/repo; acme/api would 404 and look like a successful revocation',
    ).toEqual(['/projects/other%2Frepo/access_tokens/58']);
  });

  /**
   * `project: null` is the documented "any project" binding, and round 1 threw for it — so a
   * platform running one GitLab binding across several projects could never revoke anything.
   */
  it('revokes for a binding that names no project at all', async () => {
    const { port, calls } = build(
      {
        'POST /projects/other%2Frepo/access_tokens': { status: 201, body: created },
        'DELETE /projects/other%2Frepo/access_tokens/58': { status: 204 },
      },
      { config: { project: null } },
    );
    const credential = await port.mintCredential({
      project: 'other/repo',
      scope: 'push',
      ttlSeconds: 3600,
    });
    // Caught rather than awaited: round 1 *threw* here, so the refusal has to be reachable by an
    // assertion with a name rather than blowing the test up as an unhandled rejection.
    const outcome = await port.revokeCredential(credential).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome, 'a binding that names no project must still revoke, not refuse').toBeNull();
    expect(
      calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
      'the credential carries its own address, so the binding does not have to name one',
    ).toEqual(['/projects/other%2Frepo/access_tokens/58']);
  });

  it('sends no request at all for a second revocation, so the no-op is not a 404 in disguise', async () => {
    const { port, calls } = build({
      [`POST /projects/${P}/access_tokens`]: { status: 201, body: created },
      [`DELETE /projects/${P}/access_tokens/58`]: [
        { status: 204 },
        { status: 404, body: { message: '404 Not found' } },
      ],
    });
    const credential = await port.mintCredential({
      project: PROJECT,
      scope: 'push',
      ttlSeconds: 3600,
    });
    await port.revokeCredential(credential);
    await port.revokeCredential(credential);
    expect(
      calls.filter((call) => call.method === 'DELETE').length,
      'the registry knows it is gone; a second DELETE would only buy an ambiguous 404',
    ).toBe(1);

    // …and the port then refuses to build a clone URL, which is the adapter obligation the port
    // docblock states.
    expect(() => port.cloneUrl(PROJECT, credential)).toThrow(/revoked/);
  });

  it('absorbs a 404 for a token it minted here, because that can only mean already gone', async () => {
    const { port } = build({
      [`POST /projects/${P}/access_tokens`]: { status: 201, body: created },
      [`DELETE /projects/${P}/access_tokens/58`]: {
        status: 404,
        body: { message: '404 Not found' },
      },
    });
    const credential = await port.mintCredential({
      project: PROJECT,
      scope: 'push',
      ttlSeconds: 3600,
    });
    await expect(
      port.revokeCredential(credential),
      'this provider minted it at this address, so a 404 is evidence and not a mystery',
    ).resolves.toBeUndefined();
    expect(() => port.cloneUrl(PROJECT, credential)).toThrow(/revoked/);
  });

  /**
   * The other half of the round 1 major: the absorption is what *hid* the wrong address, so it may
   * only apply where the adapter has evidence. For a handle it never minted — another process, a
   * restart, a fabricated handle — a 404 cannot tell "already revoked" from "never existed here",
   * and reporting success would be the same lie by a different route.
   */
  it('refuses to claim success for a handle it did not mint when GitLab says it is not there', async () => {
    const foreign = {
      username: 'oauth2',
      value: 'FAKE-token-from-another-process',
      scope: 'push' as const,
      branchPatterns: ['agentic/*'],
      expiresAt: '2026-06-02T00:00:00.000Z',
      revokeId: `${PROJECT}#58`,
    };
    const refused = build({
      [`DELETE /projects/${P}/access_tokens/58`]: { status: 404, body: { message: '404 Not' } },
    });
    const outcome = await refused.port.revokeCredential(foreign).then(
      () => null,
      (error: unknown) => error,
    );
    expect(
      (outcome as IntegrationError | null)?.code,
      'an unconfirmable revocation must not report success',
    ).toBe('not_found');
    expect((outcome as Error).message, 'and it says what the operator must check').toMatch(
      /may still be live/,
    );

    // The positive control: it is the 404 that is refused, not the unknown handle. A 204 is proof
    // the token existed and is gone, whoever minted it.
    const accepted = build({
      [`DELETE /projects/${P}/access_tokens/58`]: { status: 204 },
    });
    await expect(accepted.port.revokeCredential(foreign)).resolves.toBeUndefined();
  });

  it('refuses a handle that is not a revocation address', async () => {
    const { port, calls } = build({});
    await expect(
      port.revokeCredential({
        username: 'oauth2',
        value: 'FAKE-someone-elses-token',
        scope: 'read',
        branchPatterns: [],
        expiresAt: '2030-01-01T00:00:00.000Z',
        // A bare token id: what round 1 minted, and what says nothing about where to send it.
        revokeId: '58',
      }),
    ).rejects.toThrow(/revocation address/);
    expect(calls, 'and it guesses at no project first').toEqual([]);
  });

  it('refuses a clone URL for a credential it never minted', () => {
    const { port } = build({});
    expect(() =>
      port.cloneUrl(PROJECT, {
        username: 'oauth2',
        value: 'FAKE-someone-elses-token',
        scope: 'push',
        branchPatterns: [],
        expiresAt: '2030-01-01T00:00:00.000Z',
        revokeId: '999',
      }),
    ).toThrow(/not minted by this provider/);
  });
});

describe('merge request writes', () => {
  it('sends no draft parameter — GitLab has none — but a Draft: title', async () => {
    const { port, calls } = build({
      [`POST /projects/${P}/merge_requests`]: { status: 201, body: mrBody({ iid: 8 }) },
    });
    await port.openMergeRequest({
      project: PROJECT,
      branch: 'agentic/task-2',
      target: 'main',
      title: 'add the parser',
      description: 'body',
      draft: true,
      labels: ['agentic', 'backend'],
      reviewers: ['77'],
      remove_source_branch: true,
    });

    const sent = JSON.parse(calls[0]?.body as string) as Record<string, unknown>;
    expect(sent.title).toBe('Draft: add the parser');
    expect(sent, 'the create endpoint has no draft attribute').not.toHaveProperty('draft');
    expect(sent.labels, 'labels are a comma-separated string').toBe('agentic,backend');
    expect(sent.reviewer_ids, 'reviewer_ids is an integer array').toEqual([77]);
    expect(sent.remove_source_branch).toBe(true);
  });

  it('strips the prefix when the caller asks for a ready merge request', async () => {
    const { port, calls } = build({
      [`POST /projects/${P}/merge_requests`]: { status: 201, body: mrBody({ draft: false }) },
    });
    await port.openMergeRequest({
      project: PROJECT,
      branch: 'agentic/task-2',
      target: 'main',
      title: 'Draft: add the parser',
      description: '',
      draft: false,
      labels: [],
      reviewers: [],
      remove_source_branch: false,
    });
    expect(JSON.parse(calls[0]?.body as string).title).toBe('add the parser');
  });

  it('refuses a reviewer that is not a GitLab user id', async () => {
    const { port } = build({});
    await expect(
      port.openMergeRequest({
        project: PROJECT,
        branch: 'agentic/task-2',
        target: 'main',
        title: 'x',
        description: '',
        draft: false,
        labels: [],
        reviewers: ['dana.reviewer'],
        remove_source_branch: false,
      }),
    ).rejects.toBeInstanceOf(IntegrationError);
  });

  it('refuses a merge request onto its own branch', async () => {
    const { port, calls } = build({});
    await expect(
      port.openMergeRequest({
        project: PROJECT,
        branch: 'main',
        target: 'main',
        title: 'x',
        description: '',
        draft: false,
        labels: [],
        reviewers: [],
        remove_source_branch: false,
      }),
    ).rejects.toBeInstanceOf(IntegrationError);
    expect(calls, 'and never asks GitLab').toEqual([]);
  });

  it('reads the current title before clearing draft, because the flag lives in the title', async () => {
    const { port, calls } = build({
      [`GET /projects/${P}/merge_requests/7`]: { status: 200, body: mrBody() },
      [`PUT /projects/${P}/merge_requests/7`]: {
        status: 200,
        body: mrBody({ draft: false, title: 'fix the totals', description: 'Ready.' }),
      },
    });
    await port.updateMergeRequest(mrRef(), {
      draft: false,
      description: 'Ready.',
      title: null,
      labels: null,
      reviewers: null,
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /projects/${P}/merge_requests/7`,
      `PUT /projects/${P}/merge_requests/7`,
    ]);
    expect(JSON.parse(calls[1]?.body as string).title).toBe('fix the totals');
  });

  it('does not read the title when the caller supplied one', async () => {
    const { port, calls } = build({
      [`PUT /projects/${P}/merge_requests/7`]: { status: 200, body: mrBody({ draft: true }) },
    });
    await port.updateMergeRequest(mrRef(), {
      draft: true,
      title: 'fix the totals',
      description: null,
      labels: null,
      reviewers: null,
    });
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0]?.body as string).title).toBe('Draft: fix the totals');
  });
});

describe('CI', () => {
  const pipeline = {
    id: 900,
    sha: '1111111111111111111111111111111111111111',
    status: 'failed',
    coverage: '81.50',
    finished_at: '2026-06-01T07:12:00.000Z',
    web_url: `${HOST}/acme/api/-/pipelines/900`,
  };

  it('reads coverage from the single-pipeline endpoint, in either documented form', async () => {
    for (const coverage of ['81.50', 81.5]) {
      const { port } = build({
        [`GET /projects/${P}/pipelines?sha=${pipeline.sha}&order_by=id&sort=desc&per_page=1`]: {
          status: 200,
          body: [{ id: 900, sha: pipeline.sha, status: 'failed' }],
        },
        [`GET /projects/${P}/pipelines/900`]: { status: 200, body: { ...pipeline, coverage } },
        [`GET /projects/${P}/pipelines/900/jobs?per_page=100&page=1`]: { status: 200, body: [] },
      });
      const status = await port.getPipelineStatus(PROJECT, pipeline.sha);
      expect(status?.coverage_pct, `coverage sent as ${typeof coverage}`).toBe(81.5);
    }
  });

  it('rejects a log ref that is not a GitLab job id before making a request', async () => {
    const { port, calls } = build({});
    await expect(port.getJobLog(PROJECT, 'log:9002')).rejects.toBeInstanceOf(IntegrationError);
    expect(calls).toEqual([]);
  });

  it('turns a 404 trace into not_found, never an empty string', async () => {
    const { port } = build({
      [`GET /projects/${P}/jobs/9002/trace`]: { status: 404, body: { message: '404 Not found' } },
    });
    try {
      await port.getJobLog(PROJECT, '9002');
      expect.unreachable('a missing log must throw');
    } catch (error) {
      expect((error as IntegrationError).code).toBe('not_found');
    }
  });

  /**
   * TD-012, and the port's own TODO naming WP-09: "a CI job log is the text most likely to contain
   * a token the platform itself injected — a masked variable is masked by *that* CI provider, not
   * by ours, and a failing job prints the command it ran."
   */
  it('redacts the job log tail and reports the count', async () => {
    const leaked = 'FAKE-project-access-token-DO-NOT-USE';
    const redactor: SecretRedactor = {
      redactJson: (value) => ({ value, count: 0, log: [] }),
      redactText: (text) => {
        const value = text.split(leaked).join('[REDACTED:integration:gitlab]');
        return { value, count: text.includes(leaked) ? 1 : 0, log: [] };
      },
    };
    const { port, redactions } = build(
      {
        [`GET /projects/${P}/jobs/9002/trace`]: {
          status: 200,
          text: `$ git push https://oauth2:${leaked}@gitlab.example.test/acme/api.git\nfatal\n`,
        },
      },
      { redactor },
    );

    const log = await port.getJobLog(PROJECT, '9002');
    expect(log, 'the injected credential does not reach the caller').not.toContain(leaked);
    expect(log).toContain('[REDACTED:integration:gitlab]');
    expect(redactions).toEqual([{ action: 'get_job_log', count: 1 }]);
  });

  it('tails the log to the requested number of bytes', async () => {
    const { port } = build({
      [`GET /projects/${P}/jobs/9002/trace`]: { status: 200, text: 'abcdefghij' },
    });
    expect(await port.getJobLog(PROJECT, '9002', { tailBytes: 4 })).toBe('ghij');
  });
});

describe('CODEOWNERS lookup', () => {
  it('tries the three documented locations in order and stops at the first hit', async () => {
    const { port, calls } = build({
      [`GET /projects/${P}/repository/files/CODEOWNERS/raw?ref=main`]: {
        status: 404,
        body: { message: '404 File Not Found' },
      },
      [`GET /projects/${P}/repository/files/docs%2FCODEOWNERS/raw?ref=main`]: {
        status: 200,
        text: 'src/ @team\n',
      },
    });
    const rules = await port.readCodeowners(PROJECT, 'main');
    expect(rules).toEqual({ rules: [{ pattern: 'src/', owners: ['@team'] }] });
    expect(calls.length, 'the third location is not asked for once one is found').toBe(2);
  });

  it('answers null when the repository has no CODEOWNERS at all', async () => {
    const missing = { status: 404, body: { message: '404 File Not Found' } };
    const { port } = build({
      [`GET /projects/${P}/repository/files/CODEOWNERS/raw?ref=main`]: missing,
      [`GET /projects/${P}/repository/files/docs%2FCODEOWNERS/raw?ref=main`]: missing,
      [`GET /projects/${P}/repository/files/.gitlab%2FCODEOWNERS/raw?ref=main`]: missing,
    });
    expect(await port.readCodeowners(PROJECT, 'main')).toBeNull();
  });

  it('truncates an oversized file before parsing it (BD-022)', async () => {
    const { port } = build(
      {
        [`GET /projects/${P}/repository/files/CODEOWNERS/raw?ref=main`]: {
          status: 200,
          text: `a/ @one\nb/ @two\n${'c/ @three\n'.repeat(1_000)}`,
        },
      },
      { config: { max_codeowners_bytes: 16 } },
    );
    const rules = await port.readCodeowners(PROJECT, 'main');
    expect(rules?.rules.length).toBeLessThanOrEqual(2);
  });
});

describe('health and history', () => {
  it('probes /version read-only and reports the version and edition', async () => {
    const { port, calls } = build({
      'GET /version': {
        status: 200,
        body: { version: '18.1.1-ee', revision: 'ceb07b24cb0', enterprise: true },
      },
    });
    const probe = await port.testConnection();
    expect(probe.ok).toBe(true);
    expect(probe.detail).toBe('GitLab 18.1.1-ee (Enterprise Edition) at gitlab.example.test');
    expect(probe.token_expires_at, 'GitLab publishes no expiry for the calling token').toBeNull();
    expect(
      calls.every((call) => call.method === 'GET'),
      'a probe never mutates',
    ).toBe(true);
  });

  it('names Community Edition on a self-managed CE instance', async () => {
    const { port } = build({
      'GET /version': { status: 200, body: { version: '17.11.0', enterprise: false } },
    });
    expect((await port.testConnection()).detail).toContain('Community Edition');
  });

  it('runs the probe detail through the redactor (common.ts TODO)', async () => {
    const redactor: SecretRedactor = {
      redactJson: (value) => ({ value, count: 0, log: [] }),
      redactText: (text) => ({ value: text.replace('18.1.1-ee', '[REDACTED]'), count: 1, log: [] }),
    };
    const { port, redactions } = build(
      { 'GET /version': { status: 200, body: { version: '18.1.1-ee', enterprise: true } } },
      { redactor },
    );
    expect((await port.testConnection()).detail).toContain('[REDACTED]');
    // Three events, and the **last** is the one this test is named for. This stub redactor claims
    // a count of 1 for *any* text, so each of `http.ts`'s passes reports what it touched: the
    // pre-parse text pass (1), the header pass (2 — one `content-type`, name and value), and then
    // the probe's own composed string (1). Losing the last one would mean the probe stopped
    // redacting; losing the middle one would mean the header pass did.
    expect(redactions).toEqual([
      { action: 'test_connection', count: 1 },
      { action: 'test_connection', count: 2 },
      { action: 'test_connection', count: 1 },
    ]);
  });

  it('refuses a nonsensical history window before making a request', async () => {
    const { port, calls } = build({});
    await expect(port.listMergedMergeRequests(PROJECT, 'yesterday', 10)).rejects.toBeInstanceOf(
      IntegrationError,
    );
    await expect(
      port.listMergedMergeRequests(PROJECT, '2026-01-01T00:00:00.000Z', 0),
    ).rejects.toBeInstanceOf(IntegrationError);
    expect(calls).toEqual([]);
  });
});

describe('construction', () => {
  it('refuses a binding with no token rather than failing on the first call', () => {
    expect(() =>
      createGitLabProvider({
        integrationId: '00000000-0000-4000-8000-0000000000a9',
        config: gitlabConfigSchema.parse({ base_url: HOST }),
        secrets: {},
        clock: fixedClock(AT),
        redactor: noSecretsRedactor(),
      }),
    ).toThrow(/GITLAB_TOKEN/);
  });

  it('declares every capability as a boolean', () => {
    const { port } = build({});
    for (const [name, value] of Object.entries(port.capabilities())) {
      expect(typeof value, `capability ${name}`).toBe('boolean');
    }
  });
});
