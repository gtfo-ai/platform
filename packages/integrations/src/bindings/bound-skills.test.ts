/**
 * `createBoundSkillsReader` — which provider skills a project's bindings name (WP-54, PROGRESS
 * backlog 40), over the **shipped catalogue** so the answer is the providers' own
 * `AgentTooling.skill` and not a list written here. The first case failed against the pipeline's
 * registry, which is how the reader came to read the catalogue: Loki and Sentry are not in it.
 */
import type { BindingRepository, ProjectBinding } from '@platform/application';
import type { Id, IntegrationType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createBoundSkillsReader } from './bound-skills.js';

const PROJECT = '00000000-0000-4000-8000-00000000b001' as Id;
const OTHER = '00000000-0000-4000-8000-00000000b002' as Id;

const binding = (type: IntegrationType, provider: string): ProjectBinding => ({
  bindingId: `00000000-0000-4000-8000-${provider
    .padEnd(12, '0')
    .slice(0, 12)
    .replace(/[^0-9a-f]/g, '0')}` as Id,
  integrationId: '00000000-0000-4000-8000-0000000000aa' as Id,
  type,
  provider,
  name: provider,
  config: {},
  secretIds: [],
});

const repositoryOf = (
  byProject: Readonly<Record<string, readonly ProjectBinding[]>>,
): BindingRepository => ({
  forProject: async (projectId) => byProject[projectId] ?? [],
  forIntegration: async () => null,
});

describe('the provider skills a project’s bindings name', () => {
  it('names the skills of the bound providers, and not of the ones the project lacks', async () => {
    const read = createBoundSkillsReader({
      repository: repositoryOf({
        [PROJECT]: [binding('git', 'gitlab'), binding('errors', 'sentry')],
        [OTHER]: [binding('logs', 'loki')],
      }),
    });
    expect(await read(PROJECT)).toEqual(['gitlab-mr', 'sentry-issue']);
    // The other project's Loki binding is the other project's (rule 42: both directions).
    expect(await read(OTHER)).toEqual(['loki-logs']);
    expect(await read(PROJECT)).not.toContain('loki-logs');
  });

  it('names no skill for a provider without one, or one this build does not register', async () => {
    const read = createBoundSkillsReader({
      repository: repositoryOf({
        [PROJECT]: [
          binding('communication', 'slack'),
          binding('task_management', 'no-such-provider'),
          // A row whose type disagrees with the provider's registration.
          binding('git', 'loki'),
        ],
      }),
    });
    expect(await read(PROJECT)).toEqual([]);
  });

  it('names Jira’s recipes, which its tooling now carries (WP-54)', async () => {
    const read = createBoundSkillsReader({
      repository: repositoryOf({ [PROJECT]: [binding('task_management', 'jira-cloud')] }),
    });
    expect(await read(PROJECT)).toEqual(['jira-ticket']);
  });
});
