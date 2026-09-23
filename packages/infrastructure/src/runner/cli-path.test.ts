/**
 * PROGRESS backlog **34**, asserted on the bytes the CLI received — WP-53 criterion 3.
 *
 * ## The defect, restated from the entry
 *
 * *"`Options.pathToClaudeCodeExecutable` is `null` outside `local` mode, so the SDK resolves its
 * **own bundled** binary and passes that path as the spawn command; the run container's binary is
 * `/usr/local/bin/claude`. The two are different paths on two different filesystems, and nothing
 * compares them."* The `existsSync` check that would have caught it is on the branch that spawns
 * **locally**, so the override path does not validate the path at all — the mismatch surfaces as an
 * exec failure inside the container, which the shim reports as `exit { code: null }` with nothing
 * naming the path.
 *
 * ## Why it is asserted here rather than on the spec
 *
 * Standing rule **82**: the fake that lets an acceptance test pass is the one that never reads the
 * artefact. A case that asserted `spec.claudeCodePath` would pass with `buildQueryOptions` deleted.
 * So this drives the **real** `createWorkspaceClaudeRunner` over the **real** `createClaudeRunner`
 * over the **real** SDK `query()`, and reads `SpawnOptions.command` — the string the SDK hands the
 * transport, which is what the run shim `exec`s in the container. Nothing between the provisioner's
 * answer and that string is stubbed except the model.
 *
 * The **platform-side refusal** the entry also asks for is not here and is not this layer's: it is
 * `DockerWorkspaceProvider#assertRuntimeCli`, which runs `test -x <path>` in the run image before
 * `create` makes anything (`provider.test.ts` drives both directions of it).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { createClaudeRunner } from './claude-runner.js';
import { manualClock } from './clock.js';
import { type FakeCliScript, fakeSpawnClaudeCodeProcess } from './fake-spawn.js';
import { injectedSecretRedactorFixture, recordingTools, runSpecFixture } from './fixtures.js';
import { createWorkspaceClaudeRunner, type ProvisionedRunWorkspace } from './workspace-runner.js';

/** The same golden script `claude-runner.test.ts` drives; this file asserts a different byte. */
const loadClaudeScript = (name: string): FakeCliScript =>
  readFileSync(path.join(process.cwd(), 'test/fixtures/claude', `${name}.script.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeCliScript[number]);

const RUN_IMAGE_CLI = '/usr/local/bin/claude';
const WORKDIR = '/work/repo';

/** The whole production composition minus the model: provisioner → workspace runner → SDK. */
const runThrough = async (
  workspaceFields: Partial<ProvisionedRunWorkspace>,
  specFields: Parameters<typeof runSpecFixture>[0] = {},
): Promise<{ readonly command: string; readonly cwd: string | undefined }> => {
  const cli = fakeSpawnClaudeCodeProcess(loadClaudeScript('happy-path'));
  const workspace: ProvisionedRunWorkspace = {
    workdir: WORKDIR,
    spawn: (options: SpawnOptions): SpawnedProcess => cli.spawn(options),
    release: async () => undefined,
    ...workspaceFields,
  };
  const runner = createWorkspaceClaudeRunner({
    provisioner: { provision: async () => workspace },
    build: ({ spawn }) =>
      createClaudeRunner({
        sink: { append: async () => undefined },
        approvals: {
          requestApproval: async () => ({
            decision: 'deny',
            reason: 'unattended',
            questionId: null,
          }),
        },
        tools: recordingTools(),
        clock: manualClock(Date.parse('2026-01-01T00:00:00.000Z')),
        injectedSecretRedactorFor: () => injectedSecretRedactorFixture(),
        spawnClaudeCodeProcess: spawn,
      }),
  });
  await runner.start(runSpecFixture(specFields)).outcome;
  const spawned = cli.spawnOptions;
  expect(spawned, 'the SDK never spawned, so there is nothing to assert about').not.toBeNull();
  return { command: (spawned as SpawnOptions).command, cwd: (spawned as SpawnOptions).cwd };
};

describe('backlog 34 — the CLI path a containerised run execs', () => {
  it('is the run image’s, in `api` mode, where nothing on the spec named one', async () => {
    // The whole defect in one case: `providerMode: 'api'` used to leave
    // `pathToClaudeCodeExecutable` unset, and the command became the SDK's own bundled binary on
    // the *platform's* filesystem.
    const { command } = await runThrough(
      { claudeCodePath: RUN_IMAGE_CLI },
      { providerMode: 'api', claudeCodePath: null },
    );
    expect(command).toBe(RUN_IMAGE_CLI);
  });

  it('is the run image’s even when the planner wrote a different one', async () => {
    // `APP_CLAUDE_BINARY` is a path on the *operator's* host. A containerised run must not exec it,
    // and the workspace's answer is the one that wins — at the one place that knows both.
    const { command } = await runThrough(
      { claudeCodePath: RUN_IMAGE_CLI },
      { providerMode: 'local', claudeCodePath: '/opt/homebrew/bin/claude' },
    );
    expect(command).toBe(RUN_IMAGE_CLI);
  });

  it('is the SDK’s own resolution when no workspace answers, which is the local-binary case', async () => {
    // The other direction (standing rule 42): a provisioner that names no path leaves the SDK's
    // behaviour alone, so `pnpm dev` against a local binary is unchanged.
    const { command } = await runThrough({}, { providerMode: 'api', claudeCodePath: null });
    expect(command).not.toBe(RUN_IMAGE_CLI);
    expect(command.length).toBeGreaterThan(0);
  });

  it('spawns in the workspace’s own working directory, not the planner’s placeholder', async () => {
    const { cwd } = await runThrough(
      { claudeCodePath: RUN_IMAGE_CLI },
      { workspacePath: '/workspaces/6f1c9d2e-0000-4000-8000-000000000001' },
    );
    expect(cwd).toBe(WORKDIR);
  });
});
