/**
 * **WP-15g's first and third acceptance criteria: the real runner, and a transcript that exists.**
 *
 * Every other pipeline e2e in this directory drives `FakeClaudeRunner`, which picks its scenario from
 * `spec.stage` and **never reads the prompt** (standing rule 82). So "a ticket reaches
 * `task.completed`" was already green before this work package, on an artefact — the whole input to
 * the model — that nothing inspected. This file is the one that cannot be green that way:
 *
 *  - the instance composes the **production** runner. `apps/server/src/pipeline.ts` →
 *    `composeAgentRunner` → `createClaudeRunner` over the Agent SDK's own `query()`, with the
 *    production `run_messages` sink and a per-run TD-012 step-1 redactor built from
 *    `RunSpec.secretEnvNames`. The only double is the CLI **process** (`support/agent-workspace.ts`);
 *  - the prompt assertion is against **what the CLI received** — `FakeCli.stdin`, "every frame the SDK
 *    wrote to stdin, parsed", and `FakeCli.spawnOptions` — and never against the `RunSpec`, which is
 *    the object the fake runner ignores and therefore the assertion that cannot fail;
 *  - the transcript assertion reads `run_messages` back out of the database, which **no test in this
 *    repository had ever done**, because nothing wrote a row until WP-15g.
 *
 * ## What this file does not prove
 *
 * Nothing about the real `claude` binary (its arguments, its exit codes, its own parsing), the run
 * container, the run shim, the control socket, the credential helper, the egress allow-list, or the
 * model's behaviour. The first four meet each other once, against a Docker daemon, in
 * `node scripts/runlet-launcher-check.mjs` — not a `verify` target, because CI has no daemon. The
 * last is not testable here at all, and this repository has no model credential (the blocker brief in
 * `PROGRESS.md`), which is why no criterion of this work package needs one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  PLANTED_MODEL_KEY,
  PLANTED_MODEL_KEY_PLACEHOLDER,
  TRANSCRIPT_CONTROL_TEXT,
} from '../support/agent-workspace.js';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** The title of `ACME-1` in `support/scenarios.ts`; the string the prompt must carry. */
const TICKET_TITLE = 'Show the totals in the invoice footer';

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

/** Everything the SDK wrote to one run's stdin, as one string. */
const stdinBytesOf = (pipeline: PipelineE2E, stage: string): string => {
  const run = pipeline.agentRuns.find((entry) => entry.stage === stage);
  if (run === undefined) {
    throw new Error(
      `no run for "${stage}"; the instance started: ${pipeline.agentRuns.map((entry) => entry.stage).join(', ')}`,
    );
  }
  return JSON.stringify(run.cli.stdin);
};

describe('the production runner, over a scripted CLI', () => {
  it('sends the ticket’s own title to the process, and stores a redacted transcript', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'agent-run',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline)]);
    // The same ending the fake-runner walk reaches, through the real adapter: five agent stages, the
    // interpreter's transitions, and a human's merge still required (BD-007). Stopping at
    // `ready_for_merge` is enough for every assertion below and saves the merge round trip.
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(waiting.current_stage).toBe('ready_for_merge');

    // ── criterion 1: the bytes the CLI received ──────────────────────────────
    //
    // **Measured rather than assumed, and the measurement corrected the guess** (the plan row asks
    // for exactly this). With `@anthropic-ai/claude-agent-sdk@0.3.267`, *both* prompt halves travel
    // on **stdin** and neither is in argv: the user prompt as `{"type":"user",…}` frames in
    // streaming-input mode, and the system-prompt append inside the `initialize` **control request**
    // as `request.appendSystemPrompt`. The argv the SDK builds carries only options
    // (`--output-format`, `--model`, `--json-schema`, `--tools`, `--managed-settings`, …). The second
    // case below asserts that split, because a later reader looking for the role prompt in argv would
    // find nothing and conclude the prompt was empty.
    const refinement = stdinBytesOf(pipeline, 'refinement');
    expect(refinement).toContain(TICKET_TITLE);
    // The ticket's *description* reaches it too — WP-15f's snapshot, inside the data block.
    expect(refinement).toContain('The footer sums the visible rows rather than all of them');
    // And it is delimited as untrusted data (BD-022), not pasted into the instructions.
    expect(refinement).toContain('untrusted-data-');

    // Every agent stage, not only the first: the prompt is built per stage and a title that reached
    // one is not a title that reached the rest (standing rule 68).
    for (const run of pipeline.agentRuns) {
      expect(stdinBytesOf(pipeline, run.stage), `stage ${run.stage}`).toContain(TICKET_TITLE);
    }
    expect(pipeline.agentRuns.map((run) => run.stage)).toEqual([
      'refinement',
      'architecture',
      'implementation',
      'code_review',
      'business_review',
    ]);

    // ── criterion 3: the transcript is stored, and redacted ──────────────────
    const rows = await pipeline.transcript();
    expect(rows.length).toBeGreaterThan(0);
    const stored = JSON.stringify(rows);
    // Both directions, because a sink that stored nothing and a sink that redacted everything look
    // identical from one side (standing rule 42). The planted key is the run's own
    // `ANTHROPIC_API_KEY`, echoed back by the scripted CLI the way a model repeating its environment
    // would, and it is deliberately not in a shape TD-012 step 2's patterns match — so only step 1,
    // built per run from `RunSpec.secretEnvNames`, can have replaced it.
    expect(stored).not.toContain(PLANTED_MODEL_KEY);
    expect(stored).toContain(PLANTED_MODEL_KEY_PLACEHOLDER);
    expect(stored).toContain(TRANSCRIPT_CONTROL_TEXT);
    expect(rows.reduce((total, row) => total + row.redaction_count, 0)).toBeGreaterThan(0);
    // The row is a row, not a blob: `seq` is zero-based (migration 0016's whole subject) and the
    // columns technical/03 indexes are filled.
    expect(rows.map((row) => row.seq).includes(0)).toBe(true);
    expect(rows.some((row) => row.kind === 'assistant' && row.search_text !== null)).toBe(true);
    expect(rows.every((row) => row.size_bytes > 0)).toBe(true);

    // ── criterion 4: every ending freed the workspace ────────────────────────
    //
    // One release per run, each carrying the terminal status. The per-ending enumeration is
    // `workspace-runner.test.ts`; this is the same obligation discharged by the **composed**
    // instance, which is the half a unit test cannot state.
    expect(pipeline.workspaceReleases).toEqual(
      pipeline.agentRuns.map((run) => ({ stage: run.stage, ending: 'completed' })),
    );
  }, 240_000);

  it('passes the role prompt in the initialize frame, and the run’s env to the process', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'agent-argv',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline)]);
    // **The wait is on the stage *after* the first one** (standing rule 50): `current_stage !==
    // 'refinement'` is satisfied by a task that has not entered a stage at all, which is the state a
    // freshly created task is in — the first version of this case read `agentRuns[0]` of an empty
    // array and failed on `undefined` rather than on anything about argv.
    await pipeline.settle('refinement completed', (task) => task.current_stage === 'architecture');

    const run = pipeline.agentRuns[0];
    const options = run?.cli.spawnOptions;
    // `spawnOptions` is `SpawnOptions | null` until the SDK has spawned, and `toBeDefined()` passes
    // on `null` — so the assertion is on the field the case is about.
    expect(options?.args).toBeDefined();
    const argv = JSON.stringify(options?.args ?? []);

    // **The measurement.** The append is in the `initialize` control request on stdin, under
    // `request.appendSystemPrompt`; the shipped Product Manager prompt is what `refinement` runs
    // (`packages/prompts/roles/product_manager/prompt.md`, `templates.ts`'s `refinement` stage), so a
    // phrase from that file is what proves the *role* prompt and not merely *a* prompt arrived.
    const initialize = run?.cli.stdin.find(
      (frame) => (frame['request'] as { subtype?: string } | undefined)?.subtype === 'initialize',
    );
    const append = (initialize?.['request'] as { appendSystemPrompt?: string } | undefined)
      ?.appendSystemPrompt;
    expect(append).toContain('You are the **Product Manager**');
    // Options travel in argv, prompts do not — the half that would send a later reader looking in the
    // wrong place. Both directions, so neither can pass vacuously.
    expect(argv).toContain('--output-format');
    expect(argv).not.toContain('Product Manager');
    expect(argv).not.toContain('--append-system-prompt');

    // The run's own environment reaches the process, which is what makes the credential real enough
    // to be worth redacting. `Options.env` **replaces** `process.env` for the child (technical/04),
    // so this is the whole environment the CLI would run with.
    expect(options?.env?.['ANTHROPIC_API_KEY']).toBe(PLANTED_MODEL_KEY);
    // And the workspace's own working directory, not the path the planner invented.
    expect(options?.cwd).toBe('/work/repo');
  }, 240_000);
});

/**
 * **Q59(b), decided on WP-15g: the refusal stays, and it is conditional on configuration.**
 *
 * This is what every production process is today — no launcher, therefore no workspace provisioner
 * (Q52), therefore no agent runner — and the decision is that such a process still *runs*. The
 * alternative considered was refusing to compose the pipeline at all, which would be louder and would
 * also stop the intake, the status mapping, the workpad and every outbound provider call, i.e. the
 * part of the loop that works without an agent.
 *
 * The log line that names the missing pieces is asserted by `composition.e2e.test.ts` against an
 * instance started exactly as `main.ts` starts one; this file asserts the **behaviour**, which no log
 * line can.
 */
describe('an instance with no launcher configuration', () => {
  it('stays ready, does the non-agent work, and escalates the stage that needs an agent', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'no-agent',
      tickets: TICKETS,
      agent: 'none',
      config: { status_mapping: { refinement: 'In Progress' } },
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline)]);

    // The agent stage fails its run and the task is parked for a human — WP-15c's ending, reached
    // here by configuration rather than by a build.
    const parked = await pipeline.settle('needs_human', (task) => task.state === 'needs_human');
    expect(parked.current_stage).toBe('refinement');
    const types = (await pipeline.events()).map((event) => event.type);
    expect(types).toContain('run.failed');
    expect(types).toContain('task.escalated');
    // Nothing ran, so nothing was spent, and no artifact was invented for a run that never happened.
    expect(Number(parked.cost_actual)).toBe(0);
    expect(types).not.toContain('artifact.created');

    // **The non-agent half of the loop ran anyway**, which is the whole argument for keeping the
    // refusal conditional: the task exists, the ticket's own words were read and stored, the board
    // moved, and the workpad was rendered — every one of those through the production outbound path.
    expect(parked.ticket_snapshot?.title).toBe(TICKET_TITLE);
    await pipeline.waitFor('the workpad and the ticket status', async () => {
      const seen = pipeline.tickets.peek('ACME-1');
      return seen?.comments[0]?.body.includes('ACME-1') === true && seen?.status === 'In Progress';
    });
    // The audit row is written by the executor **after** the provider call returns (BD-003, in a
    // transaction of its own), so a workpad visible on the ticket does not mean the row exists yet —
    // the window the librarian e2e fell into on CI run `34722271238` (rule 50: bound the line you
    // assert, not one that precedes it). `every(status === 'ok')` is true of an empty set as well,
    // so this wait is what makes the two assertions below a measurement rather than a coincidence.
    await pipeline.waitFor('the workpad call to be audited', async () =>
      (await pipeline.auditRows()).some((row) => row.action === 'upsert_workpad'),
    );
    const audited = await pipeline.auditRows();
    expect(audited.length).toBeGreaterThan(0);
    expect(audited.every((row) => row.status === 'ok')).toBe(true);

    // And it is **ready**: a process that cannot run an agent is still a complete consumer of every
    // event the platform declares consumed, which is the only question `/readyz`'s dispatch check
    // asks. Reporting `down` here would take an otherwise working deployment out of a load balancer.
    const ready = await pipeline.instance.runtime.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect((ready.json() as { checks: Record<string, string> }).checks.dispatch).toBe('ok');

    // No workspace was provisioned and none was released: the refusal happens before a run exists.
    expect(pipeline.agentRuns).toEqual([]);
    expect(pipeline.workspaceReleases).toEqual([]);
  }, 240_000);
});
