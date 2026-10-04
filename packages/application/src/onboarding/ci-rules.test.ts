import type { Id, IsoDateTime } from '@platform/contracts';
import { CI_RULES_NOTE_CODE, CI_RULES_WARNING_CODE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type {
  RepositoryFileEntry,
  RepositoryFileRequest,
  RepositoryFileSource,
} from '../config/repository-config.js';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { PipelineIntegrations } from '../pipeline/integrations.js';
import { staticPipelineIntegrations } from '../pipeline/integrations.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { CiConfigLocation, GitProviderPort } from '../ports/integrations/git-provider.js';
import { createMemoryAuditLog, createVirtualTimer } from '../testing/memory-integrations.js';
import { type CiDocumentParser, createCiRulesProbe } from './ci-rules.js';

const PROJECT = '00000000-0000-4000-8000-0000000000c1' as Id;
/** The binding's own credential — obviously fake; the canary below plants it in the CI file. */
const BINDING_TOKEN = 'glpat-FAKE-ci-rules-canary-0000';

/** JSON stands in for YAML here: the parser is infrastructure's, tested beside it. */
const jsonParser: CiDocumentParser = {
  parse: (text) => {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  },
};

const integrationsWith = (location: CiConfigLocation | (() => never)): PipelineIntegrations => {
  const port = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a001',
      provider: 'fake-git',
      type: 'git',
    },
    capabilities: () => ({}),
    repositorySettings: async () => {
      if (typeof location === 'function') return location();
      return { defaultBranch: 'main', ciConfig: location };
    },
  } as unknown as GitProviderPort;
  return {
    executor: createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog: createMemoryAuditLog(),
      redactor: exactSecretRedactor([]),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => '2026-10-04T09:00:00.000Z' as IsoDateTime },
    }),
    git: {
      port,
      ref: port.ref,
      project: 'acme/api',
      redactor: exactSecretRedactor([{ name: 'fake_git_token', value: BINDING_TOKEN }]),
    },
    taskManagement: null,
    communication: null,
  } as unknown as PipelineIntegrations;
};

const filesWith = (
  entry: RepositoryFileEntry | 'unavailable',
  asked: RepositoryFileRequest[] = [],
): RepositoryFileSource => ({
  read: async (request) => {
    asked.push(request);
    if (entry === 'unavailable')
      return { status: 'unavailable', reason: 'the mirror has not fetched yet' };
    return {
      status: 'ok',
      commitSha: 'c'.repeat(40),
      files: {},
      ...(request.ciConfigPath === undefined ? {} : { ciConfig: entry }),
    };
  },
});

const fileOf = (document: unknown): RepositoryFileEntry => ({
  kind: 'file',
  text: JSON.stringify(document),
  blobSha: 'b'.repeat(40),
});

const probe = (location: CiConfigLocation | (() => never), files: RepositoryFileSource) =>
  createCiRulesProbe({
    integrations: staticPipelineIntegrations(integrationsWith(location)),
    files,
    parser: jsonParser,
    defaultBranch: async () => 'develop',
  });

const BRANCH_ONLY = {
  test: { script: ['make test'], rules: [{ if: '$CI_COMMIT_BRANCH =~ /^(feature|bugfix)\\//' }] },
};

describe('createCiRulesProbe (WP-143)', () => {
  it('reads the CI file at the provider’s custom path, pinned to the commit, and warns on its rules', async () => {
    const asked: RepositoryFileRequest[] = [];
    const observed = await probe(
      { kind: 'repository', path: 'deploy/.gitlab-ci.yml' },
      filesWith(fileOf(BRANCH_ONLY), asked),
    ).read(PROJECT, 'a'.repeat(40));
    expect(asked).toEqual([
      {
        projectId: PROJECT,
        paths: [],
        ciConfigPath: 'deploy/.gitlab-ci.yml',
        commitSha: 'a'.repeat(40),
      },
    ]);
    expect(observed.notice?.code).toBe(CI_RULES_WARNING_CODE);
    expect(observed.notice?.message).toContain('deploy/.gitlab-ci.yml');
    // R13 is handed the file the project runs (backlog 442).
    expect(observed.ciFile?.path).toBe('deploy/.gitlab-ci.yml');
  });

  it('says an external CI configuration was not read, and reads no file', async () => {
    const asked: RepositoryFileRequest[] = [];
    const observed = await probe(
      { kind: 'external', location: 'ci.yml@acme/ci-templates' },
      filesWith(fileOf(BRANCH_ONLY), asked),
    ).read(PROJECT);
    expect(asked).toEqual([]);
    expect(observed.notice).toMatchObject({ code: CI_RULES_NOTE_CODE, severity: 'note' });
    expect(observed.notice?.message).toContain('were not read');
    expect(observed.ciFile).toBeNull();
  });

  it('turns a provider refusal and an unavailable mirror into a note, never a throw or a warning', async () => {
    const refused = await probe(
      () => {
        throw new IntegrationError('unavailable', 'fake-git', 'GitLab answered 503', {
          action: 'get_repository_settings',
        });
      },
      filesWith(fileOf(BRANCH_ONLY)),
    ).read(PROJECT);
    expect(refused.notice?.code).toBe(CI_RULES_NOTE_CODE);
    expect(refused.notice?.message).toContain('could not say where');

    const mirror = await probe(
      { kind: 'repository', path: '.gitlab-ci.yml' },
      filesWith('unavailable'),
    ).read(PROJECT);
    expect(mirror.notice?.code).toBe(CI_RULES_NOTE_CODE);
    expect(mirror.notice?.message).toContain('the mirror has not fetched yet');
  });

  it('says nothing when the repository has no CI file at the provider’s path', async () => {
    const observed = await probe(
      { kind: 'repository', path: '.gitlab-ci.yml' },
      filesWith({ kind: 'absent' }),
    ).read(PROJECT);
    expect(observed).toEqual({ notice: null, ciFile: null });
  });

  it('canary: the binding’s credential planted in a job name and a rule is absent from the notice and the R13 text (TD-012)', async () => {
    const planted = {
      [`deploy-${BINDING_TOKEN}`]: { stage: 'deploy', script: ['x'] },
      test: { script: ['x'], rules: [{ if: `$CI_COMMIT_BRANCH == "${BINDING_TOKEN}"` }] },
    };
    const observed = await probe(
      { kind: 'repository', path: '.gitlab-ci.yml' },
      filesWith(fileOf(planted)),
    ).read(PROJECT);
    expect(observed.notice?.code).toBe(CI_RULES_WARNING_CODE);
    expect(JSON.stringify(observed)).not.toContain(BINDING_TOKEN);
    expect(observed.notice?.message).toContain('[REDACTED');
  });
});
