/**
 * **BD-004's `local` mode through the composition root** (WP-133, PROGRESS backlog 137's `local`
 * half).
 *
 * `composeAgentRunner` refuses to compose an agent runner in `local` mode without
 * `CLAUDE_CODE_OAUTH_TOKEN`, and `agent.test.ts` asserts that refusal and its positive half — but it
 * calls the function with the token in hand. The composition root's one call (`pipeline.ts`) **did
 * not pass it**: the field was optional, so leaving it out typechecked, and every `local`-mode
 * process composed no agent runner and logged the token as missing while its environment carried
 * it. Found by `scripts/compose-stock-check.mjs`'s `local` leg against the image — the one place a
 * `local`-mode process had ever been started — and asserted here, where a tier runs it on every
 * change: a `runner` process in `local` mode, configured the way `compose.local.yml` configures one,
 * takes a stage and spawns the CLI with the subscription token **by name**.
 *
 * The shape is the shipped topology's (`two-processes.e2e.test.ts`): `app` runs no agent, `runner`
 * runs the production runner over a scripted CLI. No model is reached and no credential is real.
 */
import { PassThrough } from 'node:stream';
import { loadServerConfig, requiredPoolConnections } from '@platform/server';
import { afterEach, describe, expect, it } from 'vitest';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

/** Obviously fake, and not the shape `claude setup-token` prints (standing rule 93). */
const FAKE_OAUTH_TOKEN = 'FAKE-wp133-e2e-oauth-token-not-a-credential';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe('a runner in local mode (compose.local.yml’s arrangement)', () => {
  it('composes an agent runner and spawns the CLI with CLAUDE_CODE_OAUTH_TOKEN by name (WP-133)', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'local-mode',
      tickets: TICKETS,
      agent: 'none',
      processName: 'app',
    });
    harness = pipeline;
    const lines: string[] = [];
    const destination = new PassThrough();
    destination.on('data', (chunk: Buffer) => {
      lines.push(chunk.toString('utf8'));
    });
    await pipeline.addProcess({
      name: 'runner',
      role: 'runner',
      agent: 'real-over-fake-cli',
      logDestination: destination,
      env: {
        APP_DB_POOL_MAX: String(
          requiredPoolConnections(
            loadServerConfig({
              ROLE: 'runner',
              DATABASE_URL: 'postgres://127.0.0.1:5432/floor',
              APP_SECRET_KEY: 'e2e-pool-floor-probe-not-a-real-secret-000',
              APP_DB_POOL_MAX: '1000',
            }),
          ),
        ),
        // The harness defaults to `silent`, under which every log assertion below passes on an
        // empty log (review round 1); `info` is where the composition's positive line is.
        LOG_LEVEL: 'info',
        // `compose.local.yml`'s three lines, as the runner service receives them.
        APP_PROVIDER_MODE: 'local',
        CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH_TOKEN,
        ANTHROPIC_API_KEY: '',
      },
    });

    await pipeline.publish([
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
      }),
    ]);
    // Before the fix nothing here happens: the runner subscribes no `stage.execute`, the job queues,
    // and this wait fails by name.
    await pipeline.waitFor('the local-mode runner to finish its first stage', async () => {
      const [row] = await pipeline.query<{ status: string }>(
        "select status::text as status from runs where status <> 'running' order by created_at limit 1",
      );
      return row !== undefined;
    });

    const logged = lines.join('');
    // The positive half first, so the two negatives below cannot pass on an empty log: the stage
    // executor's own line, written by this process. (Not the launcher-provisioner line
    // `composeRunWorkspaces` logs — the harness hands its scripted provisioner in directly.)
    expect(logged).toContain('"msg":"stage executed"');
    expect(logged).not.toContain('composed without an agent runner');

    const [first] = pipeline.agentRuns;
    expect(first?.stage).toBe('refinement');
    expect(first?.spec.providerMode).toBe('local');
    // The run's environment, as `agentRunEnvironment` decided it: the token's name and nothing else,
    // and the name handed to the run's redactor.
    expect(Object.keys(first?.spec.env ?? {})).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
    expect(first?.spec.secretEnvNames).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
    // What the process was actually given — the SDK's spawn options, past every merge.
    const spawned = first?.cli.spawnOptions?.env ?? {};
    expect(spawned['CLAUDE_CODE_OAUTH_TOKEN']).toBe(FAKE_OAUTH_TOKEN);
    expect(spawned['ANTHROPIC_API_KEY'] ?? '').toBe('');

    // Only the name is anywhere the platform writes: not in the runner's log, a run row or the
    // transcript.
    expect(logged).not.toContain(FAKE_OAUTH_TOKEN);
    const runs = await pipeline.query<Record<string, unknown>>('select * from runs');
    expect(JSON.stringify(runs)).not.toContain(FAKE_OAUTH_TOKEN);
    expect(JSON.stringify(await pipeline.transcript())).not.toContain(FAKE_OAUTH_TOKEN);
  }, 300_000);
});
