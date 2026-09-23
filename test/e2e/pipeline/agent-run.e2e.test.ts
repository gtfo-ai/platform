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

/**
 * The planted, obviously-fake token in `ACME-1`'s **description** (`support/scenarios.ts`).
 *
 * It matches TD-012 step 2's `gitlab-token` rule, which is what makes it the positive half of the
 * prompt-redaction assertion: it reaches the prompt through `tasks.ticket_snapshot` and only the
 * **pattern** rules can replace it.
 */
const TICKET_PLANTED_TOKEN = 'glpat-notarealtokenatall';

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
    // One release per run, each carrying the terminal status — and `takeOver: null`, because none
    // of these runs was taken over (WP-27; `take-over.e2e.test.ts` is where that field is not
    // null). The per-ending enumeration is `workspace-runner.test.ts`; this is the same obligation
    // discharged by the **composed** instance, which is the half a unit test cannot state.
    expect(pipeline.workspaceReleases).toEqual(
      pipeline.agentRuns.map((run) => ({ stage: run.stage, ending: 'completed', takeOver: null })),
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

  /**
   * **Q64's two columns, and the measurement WP-52's criterion (9) asks for.**
   *
   * `runs.system_prompt` and `runs.user_prompt` have existed since migration 0004 and nothing had
   * ever written either — `RunRepository.insert` named twelve columns and neither was among them —
   * so `GET /api/runs/:id/prompt` refused every run by name and the run screen's Prompt tab was a
   * permanent error state. They are written at run creation now, from the *same* `RunSpec` the
   * runner is handed on the next line, through the run's own TD-012 redactor.
   *
   * Three things are asserted and one is **measured**:
   *
   *  - the columns carry the bytes the CLI received, which is what makes this an assertion about
   *    the prompt rather than about a string somebody stored (standing rule 82);
   *  - the planted model credential is **not** in either column and the placeholder is (rule 42);
   *  - the size of one assembled production prompt is printed, because nobody had measured it and
   *    a storage decision was being made without the number (rule 66). It is printed rather than
   *    bounded by an assertion: the figure depends on the project's context pack, so a threshold
   *    here would be a wall-clock-style assertion about a fixture (rule 2).
   */
  it('stores the assembled prompt on the run row, redacted, and reports its size', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'agent-prompt',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.settle('refinement completed', (task) => task.current_stage === 'architecture');

    const stored = await pipeline.runPromptRow('refinement');
    expect(stored?.systemPrompt).toBeTypeOf('string');
    expect(stored?.userPrompt).toBeTypeOf('string');

    // The bytes the CLI received, from the other side of the process boundary: the append in the
    // `initialize` control request is the system half and the user frames are the other.
    const run = pipeline.agentRuns.find((entry) => entry.stage === 'refinement');
    const initialize = run?.cli.stdin.find(
      (frame) => (frame['request'] as { subtype?: string } | undefined)?.subtype === 'initialize',
    );
    const append = (initialize?.['request'] as { appendSystemPrompt?: string } | undefined)
      ?.appendSystemPrompt;
    expect(stored?.systemPrompt).toBe(append);
    // The user half is framed by the SDK, so the column is compared by containment rather than by
    // equality: the frames carry the assembled prompt plus the SDK's own envelope.
    expect(JSON.stringify(run?.cli.stdin)).toContain(
      JSON.stringify(stored?.userPrompt).slice(1, -1),
    );

    /**
     * **Redacted at the write — and the count here is `0`, which is a finding rather than a gap.**
     *
     * Round 1 asserted `>= 0`, which a non-negative integer column satisfies vacuously. Round 2
     * measured what the value actually is and why. `ACME-1`'s description ends
     * `Reproduce with glpat-notarealtokenatall`, a shape TD-012 step 2 matches — and the prompt
     * carries the **placeholder**, not the token, because `tasks.ticket_snapshot` was already
     * redacted at *its* write (WP-15f). Every other input to a first-stage prompt is the platform's
     * own text. So the run's redactor really does run over the assembled prompt and really does
     * find nothing left: `0` is *"it ran and replaced nothing"*, which is exactly the reading
     * migration 0038 exists to make possible.
     *
     * It is pinned **exactly** rather than loosely, so a writer that double-counted or that stored
     * the count of some other document fails here; and the positive direction — a prompt that does
     * carry something only this write can redact — is asserted in
     * `packages/application/src/pipeline/stage-executor.test.ts`, where such a value is plantable.
     *
     * The end-to-end chain is asserted by the placeholder below rather than by the count: the token
     * was in the ticket, it is not in the stored prompt, and what is there is a redaction marker.
     */
    const both = `${stored?.systemPrompt ?? ''}\n${stored?.userPrompt ?? ''}`;
    expect(both).not.toContain(PLANTED_MODEL_KEY);
    expect(both).not.toContain(TICKET_PLANTED_TOKEN);
    expect(both).toContain('[REDACTED sha256:');
    expect(stored?.redactionCount).toBe(0);

    // The measurement, printed with what it rests on so the number is interpretable.
    const bytes = (value: string | null | undefined): number =>
      Buffer.byteLength(value ?? '', 'utf8');
    // A test reporting a measurement, not server code: `pino` is the rule for the platform's
    // own logs and this line exists to be read in the tier's output (rule 66).
    console.log(
      `WP-52 criterion 9 — one assembled production prompt (stage "refinement"): ` +
        `system_prompt ${bytes(stored?.systemPrompt)} B, user_prompt ${bytes(stored?.userPrompt)} B, ` +
        `total ${bytes(stored?.systemPrompt) + bytes(stored?.userPrompt)} B, ` +
        `redaction_count ${stored?.redactionCount ?? 'null'}`,
    );
  }, 240_000);

  /**
   * The same measurement across **every** agent stage of a walked ticket, because one stage is one
   * sample: a later stage's user prompt carries the prior artifacts, which is where the size
   * actually varies. The context pack is empty in this tier (the project has no vault), so this
   * bounds the *platform's own* contribution and the pack's is the planner's `budget_tokens`,
   * enforced before assembly. Printed rather than asserted, for the reason the case above gives.
   */
  it('reports the assembled prompt size at every agent stage', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'agent-prompt-sizes',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    const bytes = (value: string | null | undefined): number =>
      Buffer.byteLength(value ?? '', 'utf8');
    const sizes: string[] = [];
    for (const run of pipeline.agentRuns) {
      const row = await pipeline.runPromptRow(run.stage);
      // Every stage stored one: criterion (4) across the whole walk, not at the first stage
      // (standing rule 68 — enumerate what you branch on).
      expect(row?.systemPrompt, `stage ${run.stage}`).toBeTypeOf('string');
      expect(row?.userPrompt, `stage ${run.stage}`).toBeTypeOf('string');
      sizes.push(
        `${run.stage}: system ${bytes(row?.systemPrompt)} B + user ${bytes(row?.userPrompt)} B ` +
          `= ${bytes(row?.systemPrompt) + bytes(row?.userPrompt)} B`,
      );
    }
    console.log(`WP-52 criterion 9 — per stage (empty context pack): ${sizes.join('; ')}`);
  }, 240_000);
});

/**
 * **Q59(b) and TD-028 decision 5: what an instance with no launcher configuration does.**
 *
 * Such a process still *runs*. The alternative considered at WP-15g was refusing to compose the
 * pipeline at all, which would be louder and would also stop the intake, the status mapping, the
 * workpad and every outbound provider call — the part of the loop that works without an agent.
 *
 * ## What WP-53 changed here, and it is the honest half of TD-028 decision 5
 *
 * This case used to be called *"…and escalates the stage that needs an agent"* and asserted
 * `needs_human`, `run.failed` and `task.escalated`. That was WP-15c's ending, reached because the
 * process **subscribed** `stage.execute` and then could not perform the job it won. TD-028 decides
 * the opposite — *"a worker composition subscribes the agent-run queue only when it is configured to
 * run agents"*, because pg-boss hands a job to **any** subscribed worker and a deployment with
 * `ROLE=worker` beside `ROLE=runner` would otherwise fail half its stages — so the job is now
 * **enqueued and left queued**, the task stays where it is, and nothing is escalated.
 *
 * The decision's Consequences section states that trade (*"a deployment with no runner container
 * leaves `stage.execute` jobs queued … the queue depth is a metric"*). What it does not state, and
 * what this case measures, is that **the platform gates are on the same queue**, so they are not
 * evaluated either. That is reported for the architect rather than smoothed over here.
 *
 * The log line that names the missing pieces is asserted by `composition.e2e.test.ts` against an
 * instance started exactly as `main.ts` starts one; this file asserts the **behaviour**, which no log
 * line can.
 */
describe('an instance with no launcher configuration', () => {
  it('stays ready, does the non-agent work, and leaves the agent stage queued', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'no-agent',
      tickets: TICKETS,
      agent: 'none',
      config: { status_mapping: { refinement: 'In Progress' } },
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline)]);

    // The task reaches its first agent stage and **stops there**, with the job waiting: this
    // process did not subscribe the queue (TD-028 decision 5), so nothing won a job it could not
    // perform.
    const parked = await pipeline.settle(
      'the first agent stage',
      (task) => task.current_stage === 'refinement',
    );
    expect(parked.state).toBe('active');
    const types = (await pipeline.events()).map((event) => event.type);
    // No run was ever created, so there is nothing to fail and nobody to escalate to. This is the
    // assertion that changed at WP-53: it read `run.failed` / `task.escalated` before.
    expect(types).not.toContain('run.created');
    expect(types).not.toContain('run.failed');
    expect(types).not.toContain('task.escalated');
    // Nothing ran, so nothing was spent, and no artifact was invented for a run that never happened.
    expect(Number(parked.cost_actual)).toBe(0);
    expect(types).not.toContain('artifact.created');

    // **The countable effect, asked of pg-boss rather than inferred from an absence** (rule 42): a
    // queued job and a job nobody enqueued are the same silence from the task's side. The queue is
    // still *declared* either way, which is what makes its depth the metric TD-028 points at.
    const queued = await pipeline.query<{ name: string }>(
      `select name from pgboss.job where name = $1 and state in ('created', 'retry')`,
      ['stage.execute'],
    );
    expect(queued.length).toBeGreaterThan(0);

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
