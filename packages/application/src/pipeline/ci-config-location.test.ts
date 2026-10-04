import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { CiConfigLocation, GitProviderPort } from '../ports/integrations/git-provider.js';
import { createMemoryAuditLog, createVirtualTimer } from '../testing/memory-integrations.js';
import {
  CiConfigLocationUnavailableError,
  createCiConfigLocationReader,
} from './ci-config-location.js';
import { type PipelineIntegrations, staticPipelineIntegrations } from './integrations.js';

const PROJECT = '00000000-0000-4000-8000-0000000000c1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c2' as Id;
/** The binding's own credential — obviously fake; the canary plants it in the provider's refusal. */
const BINDING_TOKEN = 'glpat-FAKE-ci-location-canary-0000';

const integrationsWith = (
  answer: CiConfigLocation | (() => never),
  options: { readonly git?: boolean } = {},
): PipelineIntegrations => {
  const port = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a001',
      provider: 'fake-git',
      type: 'git',
    },
    capabilities: () => ({}),
    repositorySettings: async () => {
      if (typeof answer === 'function') return answer();
      return { defaultBranch: 'main', ciConfig: answer };
    },
  } as unknown as GitProviderPort;
  return {
    executor: createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog: createMemoryAuditLog(),
      redactor: exactSecretRedactor([]),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => '2026-10-05T09:00:00.000Z' as IsoDateTime },
    }),
    git:
      options.git === false
        ? null
        : {
            port,
            ref: port.ref,
            project: 'acme/goparking',
            redactor: exactSecretRedactor([{ name: 'fake_git_token', value: BINDING_TOKEN }]),
          },
    taskManagement: null,
    communication: null,
  } as unknown as PipelineIntegrations;
};

const readerOver = (integrations: PipelineIntegrations) =>
  createCiConfigLocationReader({ integrations: staticPipelineIntegrations(integrations) });

describe('createCiConfigLocationReader (WP-147)', () => {
  it('answers the provider’s custom CI path', async () => {
    const read = readerOver(
      integrationsWith({ kind: 'repository', path: 'deploy/.gitlab-ci.yml' }),
    );
    await expect(read(PROJECT, TASK)).resolves.toEqual({
      kind: 'repository',
      path: 'deploy/.gitlab-ci.yml',
    });
  });

  it('answers null for a project with no git binding', async () => {
    const read = readerOver(
      integrationsWith({ kind: 'repository', path: 'x.yml' }, { git: false }),
    );
    await expect(read(PROJECT, TASK)).resolves.toBeNull();
  });

  it('refuses the plan on a provider refusal, redacted, so the stage is retried rather than run unprotected (canary: the planted credential is absent)', async () => {
    const read = readerOver(
      integrationsWith(() => {
        throw new IntegrationError(
          'unavailable',
          'fake-git',
          `GitLab answered 503 for ${BINDING_TOKEN}`,
          { action: 'get_repository_settings' },
        );
      }),
    );
    const failure = await read(PROJECT, TASK).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CiConfigLocationUnavailableError);
    expect((failure as Error).message).toMatch(/503/);
    expect((failure as Error).message).not.toContain(BINDING_TOKEN);
  });

  it('lets anything that is not a provider refusal escape (rule 20)', async () => {
    const read = readerOver(
      integrationsWith(() => {
        throw new TypeError('a defect, not an answer');
      }),
    );
    await expect(read(PROJECT, TASK)).rejects.toThrow(TypeError);
  });
});
