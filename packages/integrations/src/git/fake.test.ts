/**
 * `FakeGitProvider` beyond the contract suite: the divergence register's claims, and the states a
 * pipeline test needs to be able to reach.
 */
import { IntegrationUnsupportedError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { createFakeGitProvider } from './fake.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a2';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b2';
const PROJECT = 'acme/api';

type Options = Parameters<typeof createFakeGitProvider>[0];

const build = (options: Partial<Options> = {}) =>
  createFakeGitProvider({
    integrationId: INTEGRATION_ID,
    projects: [{ path: PROJECT, defaultBranch: 'main', codeowners: 'src/** @team\n' }],
    ...options,
  });

const context = {
  projectId: PROJECT_ID,
  integrationId: INTEGRATION_ID,
  resolveUser: () => null,
};

describe('FakeGitProvider credentials', () => {
  it('reports minting as unsupported when the capability is off', async () => {
    const port = build({ capabilities: { credentialMinting: false } });
    await expect(
      port.mintCredential({ project: PROJECT, scope: 'read', ttlSeconds: 60 }),
    ).rejects.toBeInstanceOf(IntegrationUnsupportedError);
  });

  it('refuses a non-positive ttl and an unknown project', async () => {
    const port = build();
    await expect(
      port.mintCredential({ project: PROJECT, scope: 'read', ttlSeconds: 0 }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      port.mintCredential({ project: 'acme/ghost', scope: 'read', ttlSeconds: 60 }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('gives a read credential no push patterns', async () => {
    const port = build();
    const credential = await port.mintCredential({
      project: PROJECT,
      scope: 'read',
      ttlSeconds: 60,
    });
    expect(credential.branchPatterns).toEqual([]);
    expect(credential.value).toMatch(/^fake_credential_\d+$/);
  });

  it('refuses a clone URL for a credential it never minted', () => {
    const port = build();
    expect(() =>
      port.cloneUrl(PROJECT, {
        username: 'oauth2',
        value: 'fake_credential_from_elsewhere',
        scope: 'read',
        branchPatterns: [],
        expiresAt: '2030-01-01T00:00:00.000Z',
        revokeId: null,
      }),
    ).toThrow(/not minted by this provider|was not minted/);
  });

  /**
   * Divergence 8, and the port obligation behind it: an adapter may not report a revocation it
   * cannot substantiate. A fake that shrugged here would let a WP-14 teardown be written against
   * a refusal it never sees (rule 1).
   */
  it('refuses to revoke a credential it never minted', async () => {
    const port = build();
    await expect(
      port.revokeCredential({
        username: 'oauth2',
        value: 'fake_credential_from_elsewhere',
        scope: 'push',
        branchPatterns: ['agentic/*'],
        expiresAt: '2030-01-01T00:00:00.000Z',
        revokeId: 'rev-from-elsewhere',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('stays a no-op for a second revocation of a credential it did mint', async () => {
    const port = build();
    const credential = await port.mintCredential({
      project: PROJECT,
      scope: 'push',
      ttlSeconds: 3600,
    });
    await port.revokeCredential(credential);
    await expect(
      port.revokeCredential(credential),
      'the idempotency the port asks for survives divergence 8',
    ).resolves.toBeUndefined();
  });

  it('refuses a clone URL once the credential has expired (divergence 1)', async () => {
    const port = build();
    const credential = await port.mintCredential({
      project: PROJECT,
      scope: 'read',
      // The fake clock advances one second per read, so a one-second ttl is stale on the next call.
      ttlSeconds: 1,
    });
    expect(() => port.cloneUrl(PROJECT, credential)).toThrow(/expired/);
  });
});

describe('FakeGitProvider projects and merge requests', () => {
  it('needs a project path once more than one project exists', async () => {
    const port = build({
      projects: [{ path: PROJECT }, { path: 'acme/web' }],
    });
    await expect(
      port.getMergeRequest({
        provider: 'fake-git',
        project_path: null,
        iid: 1,
        url: 'https://git.example.test/x/-/merge_requests/1',
        branch: null,
        head_sha: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('refuses a merge request whose source and target are the same branch', async () => {
    const port = build();
    await expect(
      port.openMergeRequest({
        project: PROJECT,
        branch: 'main',
        target: 'main',
        title: 'x',
        description: '',
        draft: true,
        labels: [],
        reviewers: [],
        remove_source_branch: false,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('lists a merged merge request only after it merged', async () => {
    const port = build();
    const mr = await port.openMergeRequest({
      project: PROJECT,
      branch: 'agentic/task-1',
      target: 'main',
      title: 'Draft: fix',
      description: '',
      draft: true,
      labels: [],
      reviewers: [],
      remove_source_branch: true,
    });

    expect(await port.listMergedMergeRequests(PROJECT, '2000-01-01T00:00:00.000Z', 10)).toEqual([]);

    port.emitMergeRequestEvent({ event: 'mr.merged', project: PROJECT, iid: mr.ref.iid });
    const merged = await port.listMergedMergeRequests(PROJECT, '2000-01-01T00:00:00.000Z', 10);
    expect(merged.map((entry) => entry.ref.iid)).toEqual([mr.ref.iid]);
    expect((await port.getMergeRequest(mr.ref)).state).toBe('merged');
  });

  it('closes a merge request through its event', async () => {
    const port = build();
    const mr = await port.openMergeRequest({
      project: PROJECT,
      branch: 'agentic/task-2',
      target: 'main',
      title: 'Draft: fix',
      description: '',
      draft: true,
      labels: [],
      reviewers: [],
      remove_source_branch: true,
    });
    port.emitMergeRequestEvent({ event: 'mr.closed', project: PROJECT, iid: mr.ref.iid });
    expect((await port.getMergeRequest(mr.ref)).state).toBe('closed');
  });
});

describe('FakeGitProvider CI and CODEOWNERS', () => {
  it('leaves `finished_at` empty while a pipeline is still running', async () => {
    const port = build();
    port.setPipeline({ project: PROJECT, headSha: 'a'.repeat(40), status: 'running' });
    const pipeline = await port.getPipelineStatus(PROJECT, 'a'.repeat(40));
    expect(pipeline?.finished_at).toBeNull();
    expect(pipeline?.status).toBe('running');
  });

  it('ignores an allowed-failure job in the failed set', async () => {
    const port = build();
    const sha = 'b'.repeat(40);
    port.setPipeline({
      project: PROJECT,
      headSha: sha,
      status: 'failed',
      jobs: [
        { name: 'flaky', status: 'failed', log: 'x', allowFailure: true },
        { name: 'unit', status: 'failed', log: 'boom' },
      ],
    });
    const result = await port.inbound.normalise(
      port.emitPipelineFinished({ project: PROJECT, headSha: sha }),
      context,
    );
    const payload = result.events[0]?.payload as { failed_jobs: { name: string }[] };
    expect(payload.failed_jobs.map((job) => job.name)).toEqual(['unit']);
  });

  it('ignores a pipeline event for a commit it has no pipeline for', async () => {
    const port = build();
    const result = await port.inbound.normalise(
      port.emitPipelineFinished({ project: PROJECT, headSha: 'c'.repeat(40) }),
      context,
    );
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.reason).toBe('not_for_this_project');
  });

  it('returns the whole log when no tail is asked for', async () => {
    const port = build();
    const sha = 'd'.repeat(40);
    const pipeline = port.setPipeline({
      project: PROJECT,
      headSha: sha,
      status: 'failed',
      jobs: [{ name: 'unit', status: 'failed', log: 'line one\nline two\n' }],
    });
    const log = await port.getJobLog(PROJECT, pipeline.jobs[0]?.log_ref as string);
    expect(log).toBe('line one\nline two\n');
  });

  it('reports CODEOWNERS as unsupported when the capability is off, and null when absent', async () => {
    const off = build({ capabilities: { codeowners: false } });
    await expect(off.readCodeowners(PROJECT, 'main')).rejects.toBeInstanceOf(
      IntegrationUnsupportedError,
    );

    const none = build({ projects: [{ path: PROJECT, codeowners: null }] });
    expect(await none.readCodeowners(PROJECT, 'main')).toBeNull();
  });

  it('skips comments and blank lines when parsing CODEOWNERS', async () => {
    const port = build({
      projects: [
        {
          path: PROJECT,
          codeowners: '# a comment\n\nsrc/billing/** @billing @second\ndocs/**\n',
        },
      ],
    });
    const rules = await port.readCodeowners(PROJECT, 'main');
    expect(rules?.rules).toEqual([{ pattern: 'src/billing/**', owners: ['@billing', '@second'] }]);
  });

  it('moves the default branch and reports it', async () => {
    const port = build();
    port.moveDefaultBranch(PROJECT, 'e'.repeat(40));
    expect((await port.getDefaultBranchHead(PROJECT)).sha).toBe('e'.repeat(40));

    const result = await port.inbound.normalise(
      port.emitDefaultBranchMoved({ project: PROJECT, newHead: 'f'.repeat(40) }),
      context,
    );
    expect(result.events[0]?.type).toBe('default_branch.moved');
    expect((await port.getDefaultBranchHead(PROJECT)).sha).toBe('f'.repeat(40));
  });
});

describe('FakeGitProvider discussions', () => {
  it('reports thread resolution as unsupported when the capability is off', async () => {
    const port = build({ capabilities: { discussionResolution: false } });
    const mr = await port.openMergeRequest({
      project: PROJECT,
      branch: 'agentic/task-3',
      target: 'main',
      title: 'Draft',
      description: '',
      draft: true,
      labels: [],
      reviewers: [],
      remove_source_branch: true,
    });
    const discussion = port.addHumanDiscussion({
      project: PROJECT,
      iid: mr.ref.iid,
      authorId: 'human-1',
      text: 'please rename',
    });
    await expect(port.resolveDiscussion(mr.ref, discussion.id)).rejects.toBeInstanceOf(
      IntegrationUnsupportedError,
    );
  });

  it('normalises an mr.updated event and ignores one for an unknown merge request', async () => {
    const port = build();
    const mr = await port.openMergeRequest({
      project: PROJECT,
      branch: 'agentic/task-4',
      target: 'main',
      title: 'Draft',
      description: '',
      draft: true,
      labels: [],
      reviewers: [],
      remove_source_branch: true,
    });

    const updated = await port.inbound.normalise(
      port.emitMergeRequestEvent({ event: 'mr.updated', project: PROJECT, iid: mr.ref.iid }),
      context,
    );
    expect(updated.events[0]?.type).toBe('mr.updated');

    const unknown = await port.inbound.normalise(
      {
        headers: port.emitMergeRequestEvent({
          event: 'mr.opened',
          project: PROJECT,
          iid: mr.ref.iid,
        }).headers,
        body: JSON.stringify({ event: 'mr.opened', project: PROJECT, iid: 9999 }),
      },
      context,
    );
    expect(unknown.ignored[0]?.reason).toBe('not_for_this_project');
  });

  it('reports a malformed delivery instead of throwing', async () => {
    const port = build();
    const result = await port.inbound.normalise({ headers: {}, body: '{"event":"nope"}' }, context);
    expect(result.ignored[0]?.reason).toBe('malformed_payload');
  });
});

/**
 * Divergence 9's claims, asserted rather than described (standing rule 12: the place a fake is most
 * permissive is the place a later work package leans hardest, and the knowledge apply path leans
 * entirely on this one).
 */
describe('FakeGitProvider commits', () => {
  const commit = (port: ReturnType<typeof build>, overrides: Record<string, unknown> = {}) =>
    port.commitFiles({
      project: PROJECT,
      branch: 'agentic/knowledge/2026-09-12',
      start_branch: 'main',
      message: 'docs(knowledge): a page\n\nAgentic-Source: task ACME-1 run r-1\n',
      author_name: 'Agentic Bot',
      author_email: 'bot@example.test',
      actions: [
        { action: 'create', path: '.agentic/knowledge/lessons/L-1.md', content: '# one\n' },
      ],
      ...overrides,
    });

  it('creates the branch, writes the files and records the message', async () => {
    const port = build();
    const first = await commit(port);

    expect(
      port.fileAt(PROJECT, 'agentic/knowledge/2026-09-12', '.agentic/knowledge/lessons/L-1.md'),
    ).toBe('# one\n');
    // …and nothing was written to the branch it started from.
    expect(port.fileAt(PROJECT, 'main', '.agentic/knowledge/lessons/L-1.md')).toBeNull();
    expect(port.commits).toHaveLength(1);
    expect(port.commits[0]?.sha).toBe(first.sha);
    expect(port.commits[0]?.message).toContain('Agentic-Source: task ACME-1 run r-1');
    expect(port.commits[0]?.author).toEqual({ name: 'Agentic Bot', email: 'bot@example.test' });
  });

  it('refuses to create a branch that is already there', async () => {
    const port = build();
    await commit(port);
    await expect(
      commit(port, {
        actions: [
          { action: 'create', path: '.agentic/knowledge/lessons/L-2.md', content: '# two\n' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('commits onto an existing branch when no start branch is named', async () => {
    const port = build();
    await commit(port);
    await commit(port, {
      start_branch: null,
      actions: [
        { action: 'update', path: '.agentic/knowledge/lessons/L-1.md', content: '# two\n' },
      ],
    });
    expect(
      port.fileAt(PROJECT, 'agentic/knowledge/2026-09-12', '.agentic/knowledge/lessons/L-1.md'),
    ).toBe('# two\n');
    expect(port.commits).toHaveLength(2);
  });

  it('applies every action or none', async () => {
    const port = build();
    await commit(port);
    // The first action is legal and the second is not; the port promises the commit is atomic, so
    // the legal one must not have landed either.
    await expect(
      commit(port, {
        start_branch: null,
        actions: [
          { action: 'create', path: '.agentic/knowledge/lessons/L-3.md', content: '# three\n' },
          { action: 'update', path: '.agentic/knowledge/lessons/nope.md', content: '# no\n' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(
      port.fileAt(PROJECT, 'agentic/knowledge/2026-09-12', '.agentic/knowledge/lessons/L-3.md'),
    ).toBeNull();
    expect(port.commits).toHaveLength(1);
  });

  it('refuses a branch it does not have when no start branch is named', async () => {
    const port = build();
    await expect(commit(port, { start_branch: null })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('starts a branch from a seeded one and keeps its files', async () => {
    const port = build();
    port.seedFile({
      project: PROJECT,
      branch: 'main',
      path: '.agentic/knowledge/index.md',
      content: '# index\n',
    });
    await commit(port);
    expect(
      port.fileAt(PROJECT, 'agentic/knowledge/2026-09-12', '.agentic/knowledge/index.md'),
    ).toBe('# index\n');
  });
});
