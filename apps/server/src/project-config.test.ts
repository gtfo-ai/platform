/**
 * The repository settings read the wizard's default-branch field is prefilled from (WP-139).
 *
 * Through the real `IntegrationActionExecutor` and the fake git provider, so what is asserted is the
 * composition: one audited provider read per call, the provider's answer bounded into the DTO, and
 * a provider's refusal turned into a sentence the form shows rather than a 500 — while anything that
 * is not the provider's refusal still propagates (rule 20).
 */
import {
  allowAnyIntegrationHost,
  type CiConfigLocation,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  IntegrationError,
  JOB_QUEUES,
  type Jobs,
  noSecretsRedactor,
  type PipelineIntegrations,
  silentLogger,
  staticPipelineIntegrations,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { createFakeGitProvider } from '@platform/integrations';
import { describe, expect, it } from 'vitest';
import { createProjectConfigCommands } from './project-config.js';

const PROJECT = '00000000-0000-4000-8000-0000000000d1' as Id;

const world = (
  options: {
    readonly git?: 'none' | 'fake' | 'refusing' | 'broken';
    readonly ciConfig?: CiConfigLocation;
    readonly jobs?: Jobs | null;
  } = {},
) => {
  const fake = createFakeGitProvider({
    integrationId: '00000000-0000-4000-8000-0000000000d2' as Id,
    projects: [
      {
        path: 'acme/goparking',
        defaultBranch: 'dev',
        ciConfig: options.ciConfig ?? { kind: 'repository', path: 'deploy/.gitlab-ci.yml' },
      },
    ],
  });
  const port =
    options.git === 'refusing'
      ? Object.assign(Object.create(fake) as typeof fake, {
          repositorySettings: async () => {
            throw new IntegrationError('unauthorised', 'fake-git', 'the token was revoked', {
              action: 'repository_settings',
            });
          },
        })
      : options.git === 'broken'
        ? Object.assign(Object.create(fake) as typeof fake, {
            repositorySettings: async () => {
              throw new TypeError('a defect, not a refusal');
            },
          })
        : fake;
  const auditLog = createMemoryAuditLog();
  const integrations: PipelineIntegrations = {
    executor: createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog,
      redactor: noSecretsRedactor(),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: fixedClock('2026-10-04T05:00:00.000Z', 1000),
    }),
    git:
      options.git === 'none'
        ? null
        : { port, ref: fake.ref, project: 'acme/goparking', redactor: noSecretsRedactor() },
    taskManagement: null,
    communication: null,
  };
  const commands = createProjectConfigCommands({
    pool: {} as never,
    integrations: staticPipelineIntegrations(integrations),
    files: {} as never,
    secretKey: 'not-a-real-secret-key-0000000000000000000000000000',
    logger: silentLogger,
    jobs: options.jobs ?? null,
  });
  return { commands, auditLog };
};

describe('the repository settings read (WP-139)', () => {
  it('answers the provider’s default branch and CI location through one audited read', async () => {
    const { commands, auditLog } = world();
    expect(await commands.repository(PROJECT)).toEqual({
      status: 'ok',
      provider: {
        provider: 'fake-git',
        default_branch: 'dev',
        ci_config: { kind: 'repository', path: 'deploy/.gitlab-ci.yml' },
      },
    });
    expect(auditLog.entriesFor('get_repository_settings').map((entry) => entry.status)).toEqual([
      'ok',
    ]);
  });

  it('publishes an external and an unknown CI location as the provider answered them', async () => {
    const external = await world({
      ciConfig: { kind: 'external', location: '.gitlab-ci.yml@acme/ci-templates' },
    }).commands.repository(PROJECT);
    expect(external).toMatchObject({
      provider: { ci_config: { kind: 'external', location: '.gitlab-ci.yml@acme/ci-templates' } },
    });
    const unknown = await world({
      ciConfig: { kind: 'unknown', reason: 'GitLab did not report ci_config_path' },
    }).commands.repository(PROJECT);
    expect(unknown).toMatchObject({
      provider: { ci_config: { kind: 'unknown', reason: 'GitLab did not report ci_config_path' } },
    });
  });

  it('says so for a project with no git binding, and for a provider that refuses', async () => {
    expect(await world({ git: 'none' }).commands.repository(PROJECT)).toEqual({
      status: 'unavailable',
      reason: 'this project has no git binding, so the platform cannot ask its provider',
    });
    const refused = await world({ git: 'refusing' }).commands.repository(PROJECT);
    expect(refused.status).toBe('unavailable');
    expect(refused.status === 'unavailable' ? refused.reason : '').toContain(
      'the token was revoked',
    );
  });

  it('lets a defect that is not the provider’s refusal propagate (rule 20)', async () => {
    await expect(world({ git: 'broken' }).commands.repository(PROJECT)).rejects.toThrow(
      'a defect, not a refusal',
    );
  });
});

describe('the knowledge index a change of the default branch requests (WP-142)', () => {
  it('enqueues one knowledge.index run of the project, keyed to the project, and says so', async () => {
    const enqueued: unknown[] = [];
    const jobs = {
      enqueue: async (request: unknown) => {
        enqueued.push(request);
        return { status: 'enqueued', jobId: 'job-1' };
      },
    } as unknown as Jobs;
    const { commands } = world({ jobs });
    expect(await commands.requestKnowledgeIndex(PROJECT)).toBe(true);
    expect(enqueued).toEqual([
      {
        queue: JOB_QUEUES.knowledgeIndex,
        singletonKey: `project:${PROJECT}`,
        data: { project_id: PROJECT, reason: 'default_branch_changed' },
      },
    ]);
  });

  it('answers false on a process that holds no job client', async () => {
    expect(await world().commands.requestKnowledgeIndex(PROJECT)).toBe(false);
  });
});
