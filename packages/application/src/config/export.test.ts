/**
 * The configuration export — WP-63 criterion 1, the shape of the calls.
 *
 * The provider is a stub (this ring may not import `@platform/integrations`), as in
 * `knowledge/apply.test.ts`; the same flow against a provider that models branches and files, over
 * a real repository mirror, is `test/e2e/onboarding/config-export.e2e.test.ts`.
 */
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { PipelineIntegrations } from '../pipeline/integrations.js';
import { knowledgeWrites, staticPipelineIntegrations } from '../pipeline/integrations.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { CommitFilesRequest, CommitRef } from '../ports/integrations/git-provider.js';
import {
  type ConfigExportRequest,
  claudeMdPointerLine,
  configExportBranch,
  exportProjectConfig,
} from './export.js';
import {
  CLAUDE_MD_PATH,
  REPOSITORY_CONFIG_PATH,
  type RepositoryFileEntry,
  type RepositoryFilesResult,
} from './repository-config.js';

const PROJECT = '00000000-0000-4000-8000-0000000000f1' as Id;
const USER = '00000000-0000-4000-8000-0000000000f2' as Id;
const HASH = '0123456789abcdef0123456789abcdef';
const EXPORT_ID = 'fedcba9876543210';
const CONTENT = '# exported\nversion: 1\n';
const SHA = 'c'.repeat(40);

const harness = (
  options: {
    readonly git?: boolean;
    readonly files?: Partial<Record<string, RepositoryFileEntry>>;
    readonly read?: RepositoryFilesResult;
    /** What `getMergeRequest` answers for the previous export (WP-91): a state, or a throw. */
    readonly previousState?: 'opened' | 'merged' | 'closed' | Error;
  } = {},
) => {
  const mergeRequestReads: number[] = [];
  const commits: CommitFilesRequest[] = [];
  const mergeRequests: { branch: string; target: string; labels: readonly string[] }[] = [];
  const port = {
    commitFiles: async (request: CommitFilesRequest): Promise<CommitRef> => {
      commits.push(request);
      return { sha: 'abc1234', branch: request.branch, url: null };
    },
    openMergeRequest: async (draft: { branch: string; target: string; labels: string[] }) => {
      mergeRequests.push({ branch: draft.branch, target: draft.target, labels: draft.labels });
      return {
        ref: { provider: 'fake-git', project_path: 'acme/api', iid: 9, url: 'https://mr.test/9' },
        web_url: 'https://mr.test/9',
      };
    },
    getMergeRequest: async (ref: { iid: number }) => {
      mergeRequestReads.push(ref.iid);
      const state = options.previousState ?? 'opened';
      if (state instanceof Error) throw state;
      return {
        ref: { iid: ref.iid, url: 'https://mr.test/7' },
        state,
        web_url: 'https://mr.test/7',
      };
    },
  };
  const integrations: PipelineIntegrations = {
    executor: {
      execute: async (request: { perform: () => Promise<unknown> }) => ({
        status: 'ok' as const,
        result: await request.perform(),
      }),
    } as unknown as PipelineIntegrations['executor'],
    git:
      (options.git ?? true)
        ? {
            port: port as unknown as NonNullable<PipelineIntegrations['git']>['port'],
            ref: { integrationId: PROJECT, provider: 'fake-git', type: 'git' as const, host: null },
            project: 'acme/api',
            redactor: exactSecretRedactor([]),
          }
        : null,
    taskManagement: null,
    communication: null,
  };
  const reads: unknown[] = [];
  const exportOptions = {
    integrations: staticPipelineIntegrations(integrations),
    files: {
      read: async (request: unknown): Promise<RepositoryFilesResult> => {
        reads.push(request);
        return (
          options.read ?? {
            status: 'ok',
            commitSha: SHA,
            files: {
              [REPOSITORY_CONFIG_PATH]: options.files?.[REPOSITORY_CONFIG_PATH],
              [CLAUDE_MD_PATH]: options.files?.[CLAUDE_MD_PATH],
            },
          }
        );
      },
    },
  };
  return { commits, mergeRequests, reads, exportOptions, mergeRequestReads };
};

const request: ConfigExportRequest = {
  projectId: PROJECT,
  project: { defaultBranch: 'main', knowledgeDir: '.agentic/knowledge' },
  configHash: HASH,
  content: CONTENT,
  exportId: EXPORT_ID,
  requestedByUserId: USER,
  previous: null,
};

const file = (text: string): RepositoryFileEntry => ({
  kind: 'file',
  text,
  blobSha: 'd'.repeat(40),
});

describe('the export branch', () => {
  it('is inside agentic/* and built only from hex', () => {
    expect(configExportBranch(HASH, EXPORT_ID)).toBe('agentic/config/0123456789ab-fedcba987654');
    expect(() => configExportBranch('not hex', EXPORT_ID)).toThrow(/hex/);
    expect(() => configExportBranch(HASH, '../main')).toThrow(/hex/);
  });
});

describe('the CLAUDE.md pointer', () => {
  it('names the knowledge index, and refuses a directory that is not a plain relative path', () => {
    expect(claudeMdPointerLine('.agentic/knowledge')).toContain('`.agentic/knowledge/index.md`');
    for (const hostile of ['a\nb', '../x', 'a/../b', '`x`', '/abs']) {
      expect(claudeMdPointerLine(hostile), hostile).toBeNull();
    }
  });
});

describe('exportProjectConfig', () => {
  it('creates both files on a branch and opens a merge request — never the default branch', async () => {
    const h = harness();
    const report = await exportProjectConfig(h.exportOptions, request);
    expect(report.status).toBe('exported');
    expect(h.commits).toHaveLength(1);
    const commit = h.commits[0];
    expect(commit?.branch).toBe('agentic/config/0123456789ab-fedcba987654');
    expect(commit?.branch).not.toBe('main');
    expect(commit?.start_branch).toBe('main');
    expect(commit?.actions).toEqual([
      { action: 'create', path: REPOSITORY_CONFIG_PATH, content: CONTENT },
      {
        action: 'create',
        path: CLAUDE_MD_PATH,
        content: `${claudeMdPointerLine('.agentic/knowledge')}\n`,
      },
    ]);
    // BD-025 §4: the requesting human is named in the commit.
    expect(commit?.message).toContain(`Agentic-Requested-By: user ${USER}`);
    expect(h.mergeRequests).toEqual([
      {
        branch: 'agentic/config/0123456789ab-fedcba987654',
        target: 'main',
        labels: ['agentic', 'configuration'],
      },
    ]);
  });

  it('updates a file that exists, and appends the pointer to a CLAUDE.md that lacks it', async () => {
    const h = harness({
      files: {
        [REPOSITORY_CONFIG_PATH]: file('version: 1\n'),
        [CLAUDE_MD_PATH]: file('# House rules'),
      },
    });
    await exportProjectConfig(h.exportOptions, request);
    expect(h.commits[0]?.actions).toEqual([
      { action: 'update', path: REPOSITORY_CONFIG_PATH, content: CONTENT },
      {
        action: 'update',
        path: CLAUDE_MD_PATH,
        content: `# House rules\n\n${claudeMdPointerLine('.agentic/knowledge')}\n`,
      },
    ]);
  });

  it('proposes nothing when the default branch already says it', async () => {
    const h = harness({
      files: {
        [REPOSITORY_CONFIG_PATH]: file(CONTENT),
        [CLAUDE_MD_PATH]: file('See .agentic/knowledge/index.md for the knowledge base.\n'),
      },
    });
    const report = await exportProjectConfig(h.exportOptions, request);
    expect(report.status).toBe('unchanged');
    expect(h.commits).toEqual([]);
    expect(h.mergeRequests).toEqual([]);
  });

  it('refuses to replace a symlink at the configuration path', async () => {
    const h = harness({
      files: { [REPOSITORY_CONFIG_PATH]: { kind: 'not_a_file', mode: '120000' } },
    });
    const report = await exportProjectConfig(h.exportOptions, request);
    expect(report).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('not a regular file'),
    });
    expect(h.commits).toEqual([]);
  });

  it('leaves the pointer out, and says so, for a knowledge directory it will not write', async () => {
    const h = harness();
    const report = await exportProjectConfig(h.exportOptions, {
      ...request,
      project: { defaultBranch: 'main', knowledgeDir: 'kb`\n' },
    });
    expect(report.status === 'exported' && report.paths).toEqual([REPOSITORY_CONFIG_PATH]);
    expect(report.status === 'exported' && report.notes[0]).toContain('pointer was left out');
  });

  it('sends nothing without a git binding, and nothing when the branch cannot be read', async () => {
    const unbound = harness({ git: false });
    expect((await exportProjectConfig(unbound.exportOptions, request)).status).toBe('unavailable');
    expect(unbound.reads).toEqual([]);
    const unreadable = harness({ read: { status: 'unavailable', reason: 'no mirror' } });
    const report = await exportProjectConfig(unreadable.exportOptions, request);
    expect(report.status === 'unavailable' && report.reason).toContain('no mirror');
    expect(unreadable.commits).toEqual([]);
  });

  /** Review round 1: the `agentic/*` namespace is checked at the door, not only promised. */
  it('refuses, at the door, a commit or a merge request off the platform namespace', async () => {
    const h = harness();
    const integrations = await h.exportOptions.integrations.forProject(PROJECT, {
      runScopedSecrets: [],
    });
    const writes = knowledgeWrites(integrations);
    const context = { projectId: PROJECT, taskId: null };
    await expect(
      writes.commit(
        {
          branch: 'main',
          startBranch: 'main',
          message: 'x',
          authorName: 'Agentic',
          authorEmail: 'agentic@platform.invalid',
          actions: [{ action: 'create', path: 'a', content: 'b' }],
          idempotencyKey: 'k',
        },
        context,
      ),
    ).rejects.toThrow(/agentic\//);
    await expect(
      writes.openMergeRequest(
        { branch: 'agentic/', target: 'main', title: 't', description: 'd', idempotencyKey: 'k' },
        context,
      ),
    ).rejects.toThrow(/agentic\//);
    expect(h.commits).toEqual([]);
    expect(h.mergeRequests).toEqual([]);
  });
});

/**
 * WP-91 (PROGRESS backlog 225): a second press while the first export's merge request is open
 * answers that merge request instead of opening a second — and the stored reference is believed
 * only after the provider confirms it.
 */
describe('an export with a previous merge request on record', () => {
  const previous = {
    iid: 7,
    url: 'https://mr.test/7',
    branch: 'agentic/config/0123456789ab-aaaaaaaaaaaa',
    configHash: HASH,
  };

  it('answers the open merge request and commits nothing, opens nothing', async () => {
    const h = harness({ previousState: 'opened' });
    const report = await exportProjectConfig(h.exportOptions, { ...request, previous });
    expect(report).toMatchObject({
      status: 'open',
      mergeRequestIid: 7,
      mergeRequestUrl: 'https://mr.test/7',
      branch: previous.branch,
    });
    expect(h.mergeRequestReads).toEqual([7]);
    expect(h.commits).toHaveLength(0);
    expect(h.mergeRequests).toHaveLength(0);
    expect(h.reads).toHaveLength(0);
    expect(report.status === 'open' ? report.notes[0] : '').toMatch(/already proposes this/);
  });

  it('says so when the open merge request carries an earlier configuration, and still opens none', async () => {
    const h = harness({ previousState: 'opened' });
    const report = await exportProjectConfig(h.exportOptions, {
      ...request,
      previous: { ...previous, configHash: 'f'.repeat(32) },
    });
    expect(report.status).toBe('open');
    expect(report.status === 'open' ? report.notes[0] : '').toMatch(/earlier configuration/);
    expect(h.commits).toHaveLength(0);
  });

  for (const state of ['merged', 'closed'] as const) {
    it(`opens a new one when the previous merge request was ${state}`, async () => {
      const h = harness({ previousState: state });
      const report = await exportProjectConfig(h.exportOptions, { ...request, previous });
      expect(report.status).toBe('exported');
      expect(h.commits).toHaveLength(1);
      expect(h.mergeRequests).toHaveLength(1);
    });
  }

  it('opens a new one when the provider no longer has it (not_found)', async () => {
    const h = harness({
      previousState: new IntegrationError('not_found', 'fake-git', 'no such merge request'),
    });
    const report = await exportProjectConfig(h.exportOptions, { ...request, previous });
    expect(report.status).toBe('exported');
    expect(h.mergeRequests).toHaveLength(1);
  });

  it('refuses, rather than guessing, when the provider cannot say', async () => {
    const h = harness({
      previousState: new IntegrationError('unavailable', 'fake-git', 'connection reset'),
    });
    const report = await exportProjectConfig(h.exportOptions, { ...request, previous });
    expect(report.status).toBe('unavailable');
    expect(report.status === 'unavailable' ? report.reason : '').toMatch(
      /!7 could not be read.*connection reset/,
    );
    expect(h.commits).toHaveLength(0);
    expect(h.mergeRequests).toHaveLength(0);
  });

  it('asks nothing when there is no previous merge request on record', async () => {
    const h = harness();
    await exportProjectConfig(h.exportOptions, request);
    expect(h.mergeRequestReads).toEqual([]);
  });
});
