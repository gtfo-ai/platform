/**
 * **A stage run executes the project's own test command** — WP-54's first criterion, and the one
 * PROGRESS backlog 49 exists for.
 *
 * Until WP-54 no run of any role could execute a single project command: the shipped command
 * baseline named none, a project may only narrow it, and its `commands.allow: ["npm test"]` was
 * dropped in silence into an `ignoredAllow` nothing read. Every tier was green because every tier's
 * fake ran nothing (standing rule 82). This file cannot be green that way:
 *
 *  - the instance composes the **production** runner over a scripted CLI (`real-over-fake-cli`), so
 *    each Bash call goes through the production `PreToolUse(Bash)` hook — `evaluateCommand` over the
 *    policy the planner built from the role's baseline narrowed by the project — and, on `ask`,
 *    through the production unattended `canUseTool`, which denies;
 *  - the scripted CLI **executes** a command only when the platform allowed it
 *    (`fake-spawn.ts`, divergence 4), in a fixture repository this file writes;
 *  - the assertions are on what the **command** produced — a file it wrote, its exit status and its
 *    output in the stored transcript — and on the file the refused command would have written and
 *    did not (standing rules 42 and 82).
 *
 * What it does not prove: anything about the run container (its user, its mount, its egress), which
 * is `test/e2e/workspace/docker-workspace.e2e.test.ts`'s, or about a model choosing to run the
 * command, which no tier here can show.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

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

/** What the fixture's test script writes, so its presence is something only the script produced. */
const TEST_MARKER = 'test-ran.txt';
/** What the fixture's build script would write if the platform had let it run. */
const BUILD_MARKER = 'build-ran.txt';

/**
 * A fixture repository with two `package.json` scripts: a test the project declares and a build it
 * does not. Both write a file, so "it ran" and "it did not" are both facts on disk.
 */
const writeFixtureRepository = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'agentic-wp54-repo-'));
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'fixture-declared-commands',
        version: '0.0.0',
        private: true,
        scripts: {
          test: `printf 'the declared test command ran\\n' > ${TEST_MARKER} && echo '3 passing'`,
          build: `printf 'the undeclared build ran\\n' > ${BUILD_MARKER}`,
        },
      },
      null,
      2,
    )}\n`,
  );
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

describe("the project's declared commands, run by a stage", () => {
  it('executes the declared test command, refuses the undeclared one, and reports what it dropped', async () => {
    const workdir = await writeFixtureRepository();
    repository = workdir;
    const pipeline = await startPipeline({
      scenarios: (world) => ({
        ...featureScenarios(world),
        implementation: {
          ...featureScenarios(world).implementation,
          bash: { commands: ['npm test', 'npm run build'], workdir },
        },
      }),
      label: 'project-commands',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
      // technical/12's `commands.allow`, narrowed to the one command this project declares — and
      // one entry no role's baseline grants, which must be reported rather than dropped in silence.
      config: { version: 1, commands: { allow: ['npm test', 'curl https://example.test'] } },
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline)]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(waiting.current_stage).toBe('ready_for_merge');

    const implementation = pipeline.agentRuns.find((run) => run.stage === 'implementation');
    expect(implementation, 'the implementation stage ran').toBeDefined();
    const runId = implementation?.spec.runId as string;

    /**
     * The last row the platform writes about the commands is the transcript (rule 87), so the wait
     * binds it: the `tool_result` the model read, carrying the command's own output.
     */
    await pipeline.waitFor('the test command’s output in the stored transcript', async () =>
      (await pipeline.transcript()).some(
        (row) => row.run_id === runId && JSON.stringify(row.payload).includes('3 passing'),
      ),
    );

    // ── criterion 1: the declared command ran, and what it produced exists ────────────
    expect(existsSync(join(workdir, TEST_MARKER))).toBe(true);
    expect(await readFile(join(workdir, TEST_MARKER), 'utf8')).toBe(
      'the declared test command ran\n',
    );
    const rows = (await pipeline.transcript()).filter((row) => row.run_id === runId);
    const stored = JSON.stringify(rows.map((row) => row.payload));
    expect(stored).toContain('exit code 0');
    expect(stored).toContain('3 passing');

    // ── criterion 3: the undeclared one did not, and the refusal names it ─────────────
    // `npm run build` is in the developer's baseline (`npm run *`) and the project's own `allow`
    // does not list it, so the narrowed policy leaves it to `ask` and the unattended `canUseTool`
    // denies — and the command never runs, which the absent file shows rather than a verdict.
    expect(existsSync(join(workdir, BUILD_MARKER))).toBe(false);
    expect(implementation?.cli.executions.map((entry) => [entry.command, entry.ran])).toEqual([
      ['npm test', true],
      ['npm run build', false],
    ]);
    expect(stored).toContain('npm run build');
    expect(stored).toContain('canUseTool');
    // The policy the run was planned with is the narrowing, seen from the spec: of the project
    // commands, exactly the one the project declared, and no `curl` — while the developer keeps
    // the git verbs it delivers with (Q97, WP-54 review round 1: a declared `allow` narrows the
    // project commands only).
    const allow = implementation?.spec.commandPolicy.allow ?? [];
    expect(allow).toContain('npm test');
    expect(allow).not.toContain('npm run *');
    expect(allow).not.toContain('curl https://example.test');
    expect(allow).toContain('git commit *');
    expect(allow).toContain('git push origin agentic/*');

    // ── criterion 2: the entry no role is granted is published, not dropped ────────────
    const client = new Client(pipeline.instance.baseUrl);
    const signedIn = await client.post('/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    const effective = await client.json<{ ignored_allow_commands: string[] }>(
      `/api/projects/${pipeline.projectId}/config`,
    );
    expect(effective.status, JSON.stringify(effective.body)).toBe(200);
    expect(effective.body.ignored_allow_commands).toEqual(['curl https://example.test']);
  });
});
