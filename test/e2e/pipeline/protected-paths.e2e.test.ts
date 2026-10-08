/**
 * **A Developer run writes a new test and cannot quietly change an existing one** — WP-99's
 * criterion (4), PROGRESS backlog 279.
 *
 * Until WP-99 the planner passed `plannedProtectedPaths: []` and the guard refused every write under
 * a protected path, so the first real Developer run on a repository with tests could not write the
 * test the product asks it for. This file cannot be green that way:
 *
 *  - the instance composes the **production** runner over a scripted CLI (`real-over-fake-cli`), so
 *    each `Write`/`Edit` goes through the production `PreToolUse` write hook and the production path
 *    guard, over the spec the production planner built;
 *  - the listing of what exists at the merge base comes from the launcher's own script and parser, run
 *    over a git fixture repository this file commits (`agent-workspace.ts` § `ScenarioWrites`);
 *  - the scripted CLI **writes** only when the platform allowed it (`fake-spawn.ts`, divergence 4),
 *    so the assertions are on the files — the new test is there, the undeclared existing one holds
 *    its old bytes, the declared one holds the new — and on the stored `hook` row that says why.
 *
 * What it does not prove: the Docker helper that produces the listing in production, which is
 * `test/e2e/workspace/docker-workspace.e2e.test.ts`'s (the contract suite's listing case), or a
 * model choosing to write a test, which no tier here can show.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initScratchRepository } from '../../../scripts/git-scratch-env.mjs';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

const run = promisify(execFile);

let harness: PipelineE2E | undefined;
let repository: string | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  if (repository !== undefined) {
    await rm(repository, { recursive: true, force: true });
    repository = undefined;
  }
});

const ORIGINAL = 'the test as the repository committed it\n';

/** Two existing tests under the default `**` + `/*.test.*` protected pattern, committed. */
const writeFixtureRepository = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'agentic-wp99-repo-'));
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'src', 'totals.ts'), 'export const total = 0;\n');
  await writeFile(join(directory, 'src', 'totals.test.ts'), ORIGINAL);
  await writeFile(join(directory, 'src', 'legacy.test.ts'), ORIGINAL);
  const env = initScratchRepository(directory);
  const git = (...args: string[]) =>
    run(
      'git',
      [
        '-C',
        directory,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        ...args,
      ],
      { env },
    );
  await git('add', '-A');
  await git('commit', '-q', '-m', 'fixture');
  return directory;
};

const ticketMatched = (pipeline: PipelineE2E) =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key: 'ACME-1',
      url: 'https://tickets.example.test/browse/ACME-1',
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

describe('protected paths at write time (WP-99)', () => {
  it('lets a Developer write a new test, denies an undeclared edit of an existing one, and allows a declared one', async () => {
    const workdir = await writeFixtureRepository();
    repository = workdir;
    const pipeline = await startPipeline({
      scenarios: (world) => ({
        ...featureScenarios(world),
        architecture: {
          structuredOutput: {
            ...(featureScenarios(world).architecture.structuredOutput as Record<string, unknown>),
            // The Architect declares one existing test (BD-024 §2); the other stays undeclared.
            protected_path_changes: [
              { path: 'src/legacy.test.ts', reason: 'it pins the rounding this change fixes' },
            ],
          },
        },
        implementation: {
          ...featureScenarios(world).implementation,
          writes: {
            workdir,
            steps: [
              {
                tool_name: 'Write',
                file_path: '/work/repo/src/discount.test.ts',
                content: 'a new test the Developer wrote\n',
              },
              {
                tool_name: 'Edit',
                file_path: '/work/repo/src/totals.test.ts',
                old_string: 'the test as the repository committed it',
                new_string: 'an assertion the Developer weakened',
              },
              {
                tool_name: 'Edit',
                file_path: '/work/repo/src/legacy.test.ts',
                old_string: 'the test as the repository committed it',
                new_string: 'the rounding the plan declared',
              },
            ],
          },
        },
      }),
      label: 'protected-paths',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    const implementation = pipeline.agentRuns.find((entry) => entry.stage === 'implementation');
    expect(implementation, 'the implementation stage ran').toBeDefined();
    const runId = implementation?.spec.runId as string;
    // The planner's half (criterion 3), seen from the spec the run was planned with.
    expect(implementation?.spec.plannedProtectedPaths).toEqual(['src/legacy.test.ts']);
    expect(implementation?.spec.protectedPaths).toContain('**/*.test.*');

    // The last row the platform writes about the writes is the deny's `hook` row (rule 87).
    const denied = async () =>
      (await pipeline.transcript()).find(
        (row) =>
          row.run_id === runId &&
          row.kind === 'hook' &&
          row.payload['tool_use_id'] === 'toolu_implementation_w2',
      );
    await pipeline.waitFor(
      'the denied edit’s hook row',
      async () => (await denied()) !== undefined,
    );

    // ── the new test landed ───────────────────────────────────────────────────────────
    expect(await readFile(join(workdir, 'src', 'discount.test.ts'), 'utf8')).toBe(
      'a new test the Developer wrote\n',
    );
    // ── the undeclared existing test holds the repository's bytes ────────────────────
    expect(await readFile(join(workdir, 'src', 'totals.test.ts'), 'utf8')).toBe(ORIGINAL);
    // ── the declared one was changed ──────────────────────────────────────────────────
    expect(await readFile(join(workdir, 'src', 'legacy.test.ts'), 'utf8')).toBe(
      'the rounding the plan declared\n',
    );
    expect(
      implementation?.cli.writes.map((entry) => [entry.toolName, entry.decision, entry.landed]),
    ).toEqual([
      ['Write', 'allow', true],
      ['Edit', 'deny', false],
      ['Edit', 'allow', true],
    ]);

    // ── and the transcript says why, in the BD-024 reason ─────────────────────────────
    const row = await denied();
    expect(row?.payload['decision']).toBe('deny');
    expect(row?.payload['tool_name']).toBe('Edit');
    const reason = String(row?.payload['reason']);
    expect(reason).toContain('"src/totals.test.ts" matches the protected path "**/*.test.*"');
    expect(reason).toContain('it exists at the merge base with the default branch');
    expect(reason).toContain(
      "none of the latest Implementation Plan's protected_path_changes matches it",
    );
    expect(reason).toContain('(BD-024)');
    // A new file is an allow with nothing to say, so it leaves no `hook` row of its own.
    const rows = (await pipeline.transcript()).filter((entry) => entry.run_id === runId);
    expect(
      rows.some(
        (entry) =>
          entry.kind === 'hook' && entry.payload['tool_use_id'] === 'toolu_implementation_w1',
      ),
    ).toBe(false);
  });
});
