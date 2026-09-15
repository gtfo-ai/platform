/**
 * The composition root's two decisions that are not wiring.
 *
 * `composePipeline` itself is exercised by the `e2e-fake-claude` tier against a real instance —
 * that is the only place a pg-boss worker, an outbox sweep and a `bindings` row can all be present
 * at once, and a unit test of it would be a test of a mock. What is unit-testable is what it
 * *decides*: where a git binding's repository path comes from, and what a project's settings are.
 */
import type { RunSpec } from '@platform/application';
import { autonomyPresetFor, silentLogger } from '@platform/application';
import { materialiseAutonomy } from '@platform/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectSettingsPort,
  RunnerUnavailableError,
  repositoryPathOf,
  unavailableClaudeRunner,
} from './pipeline.js';

describe('unavailableClaudeRunner', () => {
  /**
   * The runner every production process gets until Q52 is answered, and the reason it is a
   * *refusal* rather than a null object.
   *
   * A runner that returned a handle whose outcome resolved to a failed `RunOutcome` would be
   * kinder and much worse: the stage executor would record `run.failed` and the interpreter would
   * transition on a verdict for a run that was never attempted — a fabricated fact, and the
   * fail-open direction of standing rule 20. Throwing keeps the failure inside the
   * `stage.execute` job that asked for it.
   */
  it('throws, naming the stage and the open question, instead of faking an outcome', () => {
    const runner = unavailableClaudeRunner();
    let thrown: unknown;
    try {
      runner.start({ stage: 'implementation' } as RunSpec);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RunnerUnavailableError);
    expect((thrown as Error).message).toContain('implementation');
    expect((thrown as Error).message).toContain('Q52');
  });

  it('still names the failure when the spec has no stage', () => {
    expect(() => unavailableClaudeRunner().start({} as RunSpec)).toThrow(RunnerUnavailableError);
  });
});

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
  const poolOf = (rows: { config: unknown; autonomy_policies?: unknown }[]) =>
    ({ query: vi.fn(async () => ({ rows, rowCount: rows.length })) }) as never;

  it('reads the effective configuration off the project row', async () => {
    const settings = await createProjectSettingsPort(
      poolOf([{ config: { status_mapping: { refinement: 'In Progress' } } }]),
    ).forProject('00000000-0000-4000-8000-0000000000b1' as never);
    expect(settings.config.status_mapping).toEqual({ refinement: 'In Progress' });
    // The shipped seven since WP-35 added `history_bootstrap` beside WP-25's `ticket_lint`,
    // WP-24's `review_only` and WP-21's `discovery`; a project's own `.agentic/pipeline.yml` needs
    // a workspace to read.
    expect(Object.keys(settings.templates).sort()).toEqual([
      'bug',
      'chore',
      'discovery',
      // WP-40's opt-in variant. It is in the map for every project, which is what makes turning the
      // feature on a *settings* change rather than a deployment one; `templateForIssueType` is what
      // decides whether an epic ever reaches it.
      'epic_split',
      'feature',
      'history_bootstrap',
      'review_only',
      'spike',
      'ticket_lint',
    ]);
  });

  it('refuses a project that has no row instead of settling defaults for a task it cannot place', async () => {
    await expect(
      createProjectSettingsPort(poolOf([])).forProject(
        '00000000-0000-4000-8000-0000000000b9' as never,
      ),
    ).rejects.toThrow(/has no row; the pipeline cannot settle its settings/);
  });

  /**
   * `projects.autonomy_policies` — the column the plan-approval gate reads (WP-30, BD-027:14).
   *
   * Parsed and never cast: this document decides whether a plan waits for a human, so one that does
   * not match the current schema must not be read as one that does. It is `null` and **logged**
   * rather than thrown, because a throw here fails the `stage.execute` job into a retry loop over a
   * configuration problem no retry can fix.
   */
  it('parses the materialised dial, and reads an unparseable one as absent with a named log line', async () => {
    const stored = materialiseAutonomy({
      level: 'autonomous',
      at: '2026-09-14T10:00:00.000Z' as never,
      appliedBy: null,
    });
    const project = '00000000-0000-4000-8000-0000000000b1' as never;
    const settings = await createProjectSettingsPort(
      poolOf([{ config: {}, autonomy_policies: stored }]),
    ).forProject(project);
    expect(settings.autonomy).toEqual(stored);
    // …and the domain reads the effective preset off it rather than off the level.
    expect(autonomyPresetFor(settings)?.planApproval).toBe('never');

    const warnings: { message: string }[] = [];
    const logger = {
      ...silentLogger,
      warn: (_fields: unknown, message: string) => warnings.push({ message }),
    } as never;
    const broken = await createProjectSettingsPort(
      poolOf([{ config: {}, autonomy_policies: { level: 'autonomous' } }]),
      logger,
    ).forProject(project);
    expect(broken.autonomy).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('re-apply the preset');

    // A row with no document at all is the same answer and is **not** a warning: migration 0021
    // backfilled every row that existed, so `null` here is a harness's row rather than a fault.
    const quiet: { message: string }[] = [];
    const absent = await createProjectSettingsPort(
      poolOf([{ config: {}, autonomy_policies: null }]),
      {
        ...silentLogger,
        warn: (_fields: unknown, message: string) => quiet.push({ message }),
      } as never,
    ).forProject(project);
    expect(absent.autonomy).toBeNull();
    expect(quiet).toEqual([]);
  });
});
