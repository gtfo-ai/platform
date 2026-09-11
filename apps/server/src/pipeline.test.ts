/**
 * The composition root's two decisions that are not wiring.
 *
 * `composePipeline` itself is exercised by the `e2e-fake-claude` tier against a real instance —
 * that is the only place a pg-boss worker, an outbox sweep and a `bindings` row can all be present
 * at once, and a unit test of it would be a test of a mock. What is unit-testable is what it
 * *decides*: where a git binding's repository path comes from, and what a project's settings are.
 */
import { describe, expect, it, vi } from 'vitest';
import { createProjectSettingsPort, repositoryPathOf } from './pipeline.js';

describe('repositoryPathOf', () => {
  it('reads the path a provider addresses a repository by, from every spelling of the url', () => {
    expect(repositoryPathOf('https://git.example.test/acme/api.git')).toBe('acme/api');
    expect(repositoryPathOf('https://git.example.test/acme/api')).toBe('acme/api');
    expect(repositoryPathOf('https://git.example.test/acme/team/api.git')).toBe('acme/team/api');
    expect(repositoryPathOf('git@git.example.test:acme/api.git')).toBe('acme/api');
    expect(repositoryPathOf('ssh://git@git.example.test:2222/acme/api.git')).toBe('acme/api');
    expect(repositoryPathOf('https://git.example.test/acme/api/')).toBe('acme/api');
  });

  /**
   * Rule 18: the empty case must not be the permissive one. A `repo_url` with no path would
   * otherwise resolve to `''`, and the pipeline would ask the provider about a project named
   * nothing — a 404 four stages later instead of a refusal at the binding.
   */
  it('refuses a url with no repository path rather than addressing an empty project', () => {
    expect(() => repositoryPathOf('https://git.example.test')).toThrow(
      /has no repository path; the git binding cannot be addressed/,
    );
    expect(() => repositoryPathOf('https://git.example.test/')).toThrow(/has no repository path/);
    expect(() => repositoryPathOf('https://git.example.test/.git')).toThrow(
      /has no repository path/,
    );
  });
});

describe('the project settings port', () => {
  const poolOf = (rows: { config: unknown }[]) =>
    ({ query: vi.fn(async () => ({ rows, rowCount: rows.length })) }) as never;

  it('reads the effective configuration off the project row', async () => {
    const settings = await createProjectSettingsPort(
      poolOf([{ config: { status_mapping: { refinement: 'In Progress' } } }]),
    ).forProject('00000000-0000-4000-8000-0000000000b1' as never);
    expect(settings.config.status_mapping).toEqual({ refinement: 'In Progress' });
    // The shipped three; a project's own `.agentic/pipeline.yml` needs a workspace to read.
    expect(Object.keys(settings.templates).sort()).toEqual(['bug', 'chore', 'feature']);
  });

  it('refuses a project that has no row instead of settling defaults for a task it cannot place', async () => {
    await expect(
      createProjectSettingsPort(poolOf([])).forProject(
        '00000000-0000-4000-8000-0000000000b9' as never,
      ),
    ).rejects.toThrow(/has no row; the pipeline cannot settle its settings/);
  });
});
