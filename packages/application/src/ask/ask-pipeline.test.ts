/**
 * Ask-the-task, driven through the composed pipeline (WP-31).
 *
 * Everything here goes through `createPipelineHarness` — the real `createPipelineRuntime`, the real
 * `askHandlers`, the real `createAskExecutor`, the real `createAskRunPlanner` and the real
 * `pipeline.outbound` duty — because the properties this row has to hold are *compositional*: that
 * an ask is a run with no stage, that it is charged like any other run, that a ticket comment
 * becomes exactly one ask or none, and that the question and the answer are bounded and redacted on
 * the way to a row.
 *
 * **The runner picks its scenario from the prompt** (standing rule 82, criterion 8). An ask has no
 * stage, so the harness's stage-keyed script table cannot express it at all; `harnessScriptKey`
 * reads the question out of the assembled prompt's `ask_question` block, which means every case
 * below is scripted against bytes the planner actually produced. A planner that emitted an empty
 * prompt, forgot the block, or put a different question in it fails to find a script — loudly.
 */
import {
  askAnswerDataSchema,
  type DomainEvent,
  domainEventSchemasByType,
  type Id,
  MAX_ASK_CITATION_DETAIL_CHARS,
} from '@platform/contracts';
import {
  ASK_ROLE,
  ASK_RUN_MODE,
  MAX_ASK_IDENTITY_LABEL_CHARS,
  MAX_ASK_QUESTION_CHARS,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { NewRun } from '../pipeline/store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { createMemoryAskStore } from '../testing/memory-ask.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { askTaskCommand } from './commands.js';
import { redactAskAnswer, scopeCitations } from './executor.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const ASKER = '00000000-0000-4000-8000-0000000000c1' as Id;
const TICKET = {
  provider: 'fake-jira',
  key: 'ACME-1',
  url: 'https://jira.example.test/browse/ACME-1',
};

let stream = 0;
const event = <T extends DomainEvent['type']>(type: T, payload: unknown): DomainEvent => {
  stream += 1;
  const suffix = stream.toString(16).padStart(12, '0');
  return domainEventSchemasByType[type].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: 'project',
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type,
    payload,
  }) as DomainEvent;
};

const ticketMatched = () =>
  event('ticket.matched', {
    project_id: PROJECT,
    ticket: TICKET,
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

const comment = (text: string, verified: boolean, commentId = 'c-1') =>
  event('ticket.comment.added', {
    project_id: PROJECT,
    task_id: null,
    ticket: TICKET,
    comment_id: commentId,
    author: {
      provider: 'fake-jira',
      external_id: 'acct-ada',
      email: null,
      display_name: 'Ada',
      verified,
    },
    text,
  });

const QUESTION = 'why did you choose a column instead of a table?';

const ANSWER = {
  answer: 'The plan says a second table would need a join on every read of the task page.',
  citations: [] as unknown[],
  unanswered: [],
  confidence: 'high' as const,
};

/**
 * A harness whose feature ticket parks after one stage, plus the ask's own script.
 *
 * `refinement` returns `decision: 'ask'`, which leaves the task in `waiting_answers` with one run
 * and one artifact on it — enough of a record for an ask to be about, and few enough moving parts
 * that the assertions below are about the ask.
 */
const harnessWith = (
  options: {
    readonly answer?: Record<string, unknown>;
    readonly askCostUsd?: number;
    readonly askStatus?: 'completed' | 'failed';
    readonly question?: string;
    readonly identities?: Record<string, Record<string, string>>;
    readonly askRedactor?: SecretRedactor;
    readonly settings?: Record<string, unknown>;
    /** The ledger, for the one case that reads `cost_entries` (criterion 9). */
    readonly cost?: boolean;
    /** Something that commits while the ask's prompt is assembled (round 2, TD-004). */
    readonly whileAskPlans?: () => Promise<void>;
  } = {},
): PipelineHarness =>
  createPipelineHarness({
    projectId: PROJECT,
    ...(options.cost === true ? { cost: true } : {}),
    ...(options.whileAskPlans === undefined ? {} : { whileAskPlans: options.whileAskPlans }),
    settings: { config: (options.settings ?? {}) as never },
    ...(options.identities === undefined ? {} : { askIdentities: options.identities }),
    ...(options.askRedactor === undefined ? {} : { askRedactor: options.askRedactor }),
    runs: {
      refinement: {
        status: 'completed',
        terminalReason: 'success',
        structuredOutput: { decision: 'ask', questions: [{ id: 'q1', text: 'Which currency?' }] },
        costUsd: 0.1,
      },
      [`ask:${options.question ?? QUESTION}`]: {
        status: options.askStatus ?? 'completed',
        terminalReason: options.askStatus === 'failed' ? 'error_during_execution' : 'success',
        structuredOutput: options.answer ?? ANSWER,
        costUsd: options.askCostUsd ?? 0.2,
        ...(options.askStatus === 'failed' ? { error: 'the model stopped' } : {}),
      },
    },
  });

const seedTask = async (harness: PipelineHarness) => {
  await harness.publish([ticketMatched()]);
  const [stored] = harness.store.snapshot();
  if (stored === undefined) throw new Error('no task was created');
  return stored;
};

const askThroughHttp = async (
  harness: PipelineHarness,
  question = QUESTION,
  redactor = exactSecretRedactor([]),
) => {
  const task = harness.store.snapshot()[0];
  if (task === undefined) throw new Error('no task');
  const result = await askTaskCommand(
    { unitOfWork: harness.memory, jobs: harness.jobs, asks: harness.asks, redactor },
    {
      id: harness.ids.next(),
      taskId: task.task.id,
      projectId: PROJECT,
      source: 'ui',
      askedByUserId: ASKER,
      askedByIdentity: null,
      ticketCommentId: null,
      question,
      createdAt: harness.clock.now(),
    },
  );
  await harness.drain();
  return result;
};

describe('an ask is a run with a task and no stage (criterion 1)', () => {
  it('runs, stores its answer, and records `task_stage_id` as null on the run', async () => {
    const harness = harnessWith();
    await seedTask(harness);
    const before = harness.specs.length;

    await askThroughHttp(harness);

    const askSpec = harness.specs.slice(before).find((spec) => spec.role === ASK_ROLE);
    expect(askSpec).toBeDefined();
    // The whole of criterion 1, on the spec the runner was actually handed.
    expect(askSpec?.stage).toBeNull();
    expect(askSpec?.mode).toBe(ASK_RUN_MODE);
    expect(askSpec?.artifactType).toBe('AskAnswer');

    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('answered');
    expect(ask?.answer).toBe(ANSWER.answer);
    expect(ask?.runId).not.toBeNull();
  });

  it('hands runs.insert the context pack its run.started carries (WP-57, standing rule 49)', async () => {
    // The second `runs.insert` call site: an ask's pack is recorded the way a stage's is, so its
    // `GET /api/runs/:id/context-pack` answers rather than refusing as "never recorded".
    const harness = harnessWith();
    await seedTask(harness);
    const inserted: NewRun[] = [];
    const repository = harness.store.runs as { insert: typeof harness.store.runs.insert };
    const original = repository.insert.bind(harness.store.runs);
    repository.insert = async (tx, run) => {
      inserted.push(run);
      await original(tx, run);
    };
    await askThroughHttp(harness);

    const [ask] = harness.asks.all();
    const row = inserted.find((run) => run.id === ask?.runId);
    const started = harness
      .events()
      .find(
        (entry) =>
          entry.type === 'run.started' &&
          (entry.payload as { run_id: string }).run_id === ask?.runId,
      );
    expect(row, 'the ask inserted no run').toBeDefined();
    expect(row?.contextPack).not.toBeNull();
    expect(row?.contextPack).toEqual(
      (started?.payload as { context_pack: unknown } | undefined)?.context_pack,
    );
  });

  it('claims this process’s run lease, so the sweep reaches it at the lease bound (backlog 120)', async () => {
    /**
     * WP-48. An ask's run is inserted by a different composition from the stage executor's, and
     * until this it claimed **no** lease — so the only thing that could ever end one whose process
     * died was the sweep's wall-clock backstop, about an hour rather than about six minutes, with
     * the reservation it holds valued at whatever the *next* admission asks for (up to $15).
     *
     * The owner is the harness's one owner string, which is the point of taking it from
     * `execution.lease` rather than adding a second option: one process, one lease identity.
     */
    const harness = harnessWith();
    await seedTask(harness);
    const before = { ...harness.heartbeats };
    await askThroughHttp(harness);

    const [ask] = harness.asks.all();
    expect(ask?.runId).not.toBeNull();
    expect(harness.store.leaseOf(ask?.runId as Id)?.owner).toBe('harness');
    // …and it **renews** it for the length of the run and stops when the run ends: a lease claimed
    // once and never beaten lapses five minutes in, which would have the sweep ending live runs.
    expect(harness.heartbeats.started).toBeGreaterThan(before.started);
    expect(harness.heartbeats.stopped).toBe(harness.heartbeats.started);
  });

  it('is given read-only platform tools and no repository tools at all (Q72 (b))', async () => {
    const harness = harnessWith();
    await seedTask(harness);
    await askThroughHttp(harness);
    const askSpec = harness.specs.find((spec) => spec.role === ASK_ROLE);
    expect(askSpec?.tools).toEqual([]);
    expect(askSpec?.platformTools).toEqual(['get_task_context', 'kb_search']);
    // Both directions: the stage run beside it *does* get file tools, so an empty list here is a
    // statement about the ask rather than about the harness.
    expect(harness.specs.find((spec) => spec.stage === 'refinement')?.tools).not.toEqual([]);
  });

  it('writes an `AskAnswer` artifact the citation of an answer can resolve through', async () => {
    const harness = harnessWith();
    const task = await seedTask(harness);
    await askThroughHttp(harness);
    const artifacts = await harness.memory.transaction(async (scope) =>
      harness.store.artifacts.listFor(scope.tx, task.task.id),
    );
    const answer = artifacts.find((artifact) => artifact.type === 'AskAnswer');
    expect(answer).toBeDefined();
    expect(answer?.version).toBe(1);
    expect((answer?.data as { answer: string } | undefined)?.answer).toBe(ANSWER.answer);
    // And the task aggregate was **not** written for it: an ask runs beside the pipeline and a
    // whole-row save from here is the lost update WP-15e closed. The refinement stage's own
    // `artifact.created` is still there, which is what makes this an assertion about the ask.
    const recorded = harness
      .events()
      .filter((entry) => entry.type === 'artifact.created')
      .map(
        (entry) =>
          (entry.payload as { artifact: { artifact_type: string } }).artifact.artifact_type,
      );
    expect(recorded).toContain('RefinedSpec');
    expect(recorded).not.toContain('AskAnswer');
  });

  it('never moves the task, whatever the ask does', async () => {
    const harness = harnessWith();
    const before = await seedTask(harness);
    await askThroughHttp(harness);
    const after = harness.store.snapshot()[0];
    expect(after?.task.state).toBe(before.task.state);
    expect(after?.task.currentStage).toBe(before.task.currentStage);
  });
});

describe('what an ask costs (criterion 9)', () => {
  it('is an ordinary ledger entry, and is added to the task’s own spend', async () => {
    const harness = harnessWith({ askCostUsd: 0.2, cost: true });
    await seedTask(harness);
    const spentBefore = harness.store.snapshot()[0]?.costActualUsd ?? 0;

    await askThroughHttp(harness);

    const spentAfter = harness.store.snapshot()[0]?.costActualUsd ?? 0;
    expect(spentAfter).toBeCloseTo(spentBefore + 0.2, 6);
    // Distinguishable from stage spend: the ledger's own rows carry the run, whose `mode` is `ask`
    // and whose stage is null — and the run the ask created is in the ledger like any other.
    const askRunId = harness.asks.all()[0]?.runId;
    expect(askRunId).not.toBeNull();
    expect(harness.cost?.entries.map((entry) => entry.runId)).toContain(askRunId);
  });

  it('refuses at the task cap and admits one unit under it, reading `cost_entries` rather than a status', async () => {
    // Criterion 9's *"asserted at the cap and one unit under it"*, and criterion 1's *"read back
    // from `cost_entries` rather than from a status code"*: a refused ask creates **no run**, so
    // there is no ledger entry and no spec for it.
    const under = harnessWith({ settings: { pipeline: { limits: {} } } });
    await seedTask(under);
    const task = under.store.snapshot()[0];
    if (task === undefined) throw new Error('no task');

    // One unit under: the row's spend plus one question's cap lands exactly **on** the task cap,
    // and the comparison is `>`, so it is admitted. Computed from what the row actually holds, not
    // from the cap alone — the refinement stage has already spent some of it.
    const cap = under.settings.taskBudgetUsd;
    await under.memory.transaction(async (scope) =>
      under.store.tasks.addSpend(scope.tx, task.task.id, cap - 0.5 - (task.costActualUsd ?? 0)),
    );
    const specsBefore = under.specs.length;
    await askThroughHttp(under, QUESTION);
    expect(under.specs.slice(specsBefore).some((spec) => spec.role === ASK_ROLE)).toBe(true);
    expect(under.asks.all()[0]?.status).toBe('answered');

    const at = harnessWith();
    await seedTask(at);
    const atTask = at.store.snapshot()[0];
    if (atTask === undefined) throw new Error('no task');
    // One unit over: the same sum plus the smallest amount that crosses it.
    await at.memory.transaction(async (scope) =>
      at.store.tasks.addSpend(
        scope.tx,
        atTask.task.id,
        at.settings.taskBudgetUsd - 0.5 - atTask.costActualUsd + 0.000001,
      ),
    );
    const atSpecs = at.specs.length;
    await askThroughHttp(at, QUESTION);
    expect(at.specs.slice(atSpecs).some((spec) => spec.role === ASK_ROLE)).toBe(false);
    const refused = at.asks.all()[0];
    expect(refused?.status).toBe('refused');
    expect(refused?.refusalReason).toContain('cap');
    expect(refused?.runId).toBeNull();
  });
});

describe('the question and the answer are untrusted in both directions (criterion 3)', () => {
  it('redacts a planted credential out of the stored question, and keeps the placeholder', async () => {
    const secret = 'glpat-FAKEFAKEFAKEFAKEFAKE';
    const harness = harnessWith({
      askRedactor: exactSecretRedactor([{ name: 'GIT_TOKEN', value: secret }]),
      question: `why did you use ${secret} here?`,
    });
    await seedTask(harness);
    await askThroughHttp(
      harness,
      `why did you use ${secret} here?`,
      exactSecretRedactor([{ name: 'GIT_TOKEN', value: secret }]),
    );

    const [ask] = harness.asks.all();
    expect(ask?.question).not.toContain(secret);
    expect(ask?.question).toContain('[REDACTED');
    expect(ask?.redactionCount).toBeGreaterThan(0);
  });

  it('bounds the stored question at the cap rather than refusing the row', async () => {
    const long = `${QUESTION} ${'x'.repeat(MAX_ASK_QUESTION_CHARS)}`;
    const harness = harnessWith({ question: long.slice(0, MAX_ASK_QUESTION_CHARS) });
    await seedTask(harness);
    await askThroughHttp(harness, long);
    const [ask] = harness.asks.all();
    expect(ask?.question.length).toBe(MAX_ASK_QUESTION_CHARS);
  });
});

describe('every model-authored string in the answer is redacted (round 2)', () => {
  const SECRET = 'glpat-FAKEFAKEFAKEFAKEFAKE';
  const placeholder = '[REDACTED:integration:GIT_TOKEN]';

  /** The answer with the same planted credential in all four fields the artifact carries. */
  const plantedAnswer = {
    answer: `the plan used ${SECRET}`,
    citations: [
      { kind: 'knowledge', reference: `vault/${SECRET}.md`, detail: `the rule says ${SECRET}` },
      { kind: 'artifact', artifact_type: 'ImplementationPlan', version: 1, detail: 'the plan' },
    ],
    unanswered: [`why ${SECRET} was chosen`],
    confidence: 'high' as const,
  };

  const answered = async () => {
    const harness = harnessWith({
      answer: plantedAnswer,
      askRedactor: exactSecretRedactor([{ name: 'GIT_TOKEN', value: SECRET }]),
    });
    const task = await seedTask(harness);
    await askThroughHttp(harness);
    return { harness, taskId: task.task.id };
  };

  it('redacts the citation detail, the citation reference and the unanswered list, not only the answer', async () => {
    // `answer` was the only one that passed the redactor until this round, and the other three are
    // stored in `task_asks.citations`, published by `GET …/asks`, rendered by the thread and — for
    // a `knowledge` citation — written into somebody else's ticket tracker by the mirror duty.
    const { harness } = await answered();
    const [ask] = harness.asks.all();
    const stored = JSON.stringify(ask);
    // Both directions (standing rule 42): the value is gone **and** the placeholder is there, so a
    // redactor that deleted the whole field would fail here too.
    expect(stored).not.toContain(SECRET);
    expect(ask?.citations[0]?.detail).toBe(`the rule says ${placeholder}`);
    expect(ask?.citations[0]?.reference).toBe(`vault/${placeholder}.md`);
    expect(ask?.answer).toBe(`the plan used ${placeholder}`);
  });

  it('counts all of them, so `redaction_count` does not under-report the row beside it', async () => {
    // Four occurrences in four fields. The count is the only signal a redactor that stopped
    // working would leave (migration 0024's note), and a count over one field of four would read
    // as "nothing else needed redacting".
    const { harness } = await answered();
    expect(harness.asks.all()[0]?.redactionCount).toBe(4);
  });

  it('carries the redacted answer into the `artifacts` row as well, not only the thread', async () => {
    // The row a citation resolves through, and `artifacts.data` is where PROGRESS backlog 35
    // measured a planted key surviving for every *other* artifact type. `AskAnswer` was the
    // exception this assertion made; WP-52 made every type keep the property, at the write.
    const { harness, taskId } = await answered();
    const artifacts = await harness.memory.transaction(async (scope) =>
      harness.store.artifacts.listFor(scope.tx, taskId),
    );
    const answer = artifacts.find((artifact) => artifact.type === 'AskAnswer');
    expect(JSON.stringify(answer?.data)).not.toContain(SECRET);
    expect(JSON.stringify(answer?.data)).toContain(placeholder);
  });

  it('counts zero when there was nothing to redact', async () => {
    // The other direction (standing rule 10): a counter that always answered four would pass above.
    const harness = harnessWith();
    await seedTask(harness);
    await askThroughHttp(harness);
    expect(harness.asks.all()[0]?.redactionCount).toBe(0);
  });

  it('leaves `run_id` alone, because it is the key the thread builds a link from', async () => {
    // Standing rule 70: redacting a value used as a key trades a leak for a collision. The
    // `detail` beside it in the same citation *is* redacted, which is what makes this about the
    // field and not the row.
    const runId = '00000000-0000-4000-8000-00000000c0de';
    const redacted = redactAskAnswer(
      {
        answer: 'see the run',
        citations: [{ kind: 'run', run_id: runId, detail: `the run ${runId} used ${SECRET}` }],
        unanswered: [],
        confidence: 'high',
      },
      [{ kind: 'run', run_id: runId, detail: `the run ${runId} used ${SECRET}` }],
      exactSecretRedactor([{ name: 'GIT_TOKEN', value: SECRET }]),
    );
    expect(redacted.data.citations[0]?.run_id).toBe(runId);
    expect(redacted.data.citations[0]?.detail).toBe(`the run ${runId} used ${placeholder}`);
  });

  /**
   * **The refusal's *ending*, through the executor** (WP-52 round 2).
   *
   * The case below drives `redactAskAnswer` directly, which pins the *decision*; what had no test
   * was what `AskExecutor.record` does with it — and a fail-open there would have stored a citation
   * whose key is a credential, in `task_asks.citations` and in `artifacts.data`, both of which this
   * work package's own route now serves.
   *
   * The credential has to **be** a run id this task really has, because `scopeCitations` drops a
   * citation naming any other run *before* redaction runs. So the redactor is late-bound: the
   * harness is built with an empty one, the task is seeded (which executes `refinement` and leaves
   * a run), and the run's own id is then registered as the secret. That is the only way this branch
   * is reachable at all, which is itself worth knowing.
   */
  it('ends the ask as failed, names the field and stores no artifact (WP-52)', async () => {
    let inner = exactSecretRedactor([]);
    const lateBound: SecretRedactor = {
      redactText: (text) => inner.redactText(text),
      redactJson: (value) => inner.redactJson(value),
    };
    const harness = harnessWith({ askRedactor: lateBound });
    await seedTask(harness);

    const priorRunId = harness.specs[0]?.runId;
    expect(priorRunId, 'seeding did not execute a run to cite').toBeDefined();
    // Divergence 2 of `memory-ask.ts`: the run projection is **seeded** rather than derived, so
    // the citation is only in scope if this store is told the run exists.
    harness.asks.seedRun({
      taskId: harness.store.snapshot()[0]?.task.id as Id,
      runId: priorRunId as Id,
      stage: 'refinement' as never,
      role: 'product_manager',
      mode: 'normal',
      attempt: 1,
      model: 'claude-opus-5',
      status: 'completed',
      terminalReason: 'success',
      costUsd: 0.1,
      createdAt: '2026-06-01T09:00:00.000Z' as never,
    });
    inner = exactSecretRedactor([{ name: 'GIT_TOKEN', value: priorRunId as string }]);
    harness.script(`ask:${QUESTION}`, {
      status: 'completed',
      terminalReason: 'success',
      structuredOutput: {
        answer: 'see the run',
        citations: [{ kind: 'run', run_id: priorRunId, detail: 'the refinement run' }],
        unanswered: [],
        confidence: 'high',
      },
      costUsd: 0.2,
    });

    await askThroughHttp(harness);

    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('failed');
    expect(ask?.refusalReason).toContain('citations[].run_id');
    // The value is the run id itself, and it is **not** in the reason: this string is stored on the
    // ask row and published by `GET /api/tasks/:id/asks`.
    expect(ask?.refusalReason).not.toContain(priorRunId as string);
    // Nothing was written: no answer, and no `AskAnswer` row for the route to serve.
    expect(ask?.answer).toBeNull();
    const artifacts = await harness.memory.transaction(async (scope) =>
      harness.store.artifacts.listFor(scope.tx, ask?.taskId as Id),
    );
    expect(artifacts.map((artifact) => artifact.type)).not.toContain('AskAnswer');
  });

  it('refuses the whole answer when the key itself is the credential (WP-52)', () => {
    /**
     * The most hostile form of the question, and **the answer changed at WP-52** — so it is
     * asserted here rather than left to be inferred from the case above.
     *
     * Until then this exact input was *stored verbatim*: the redactor skipped `run_id` because it
     * is a key, so a run id that happens to equal an injected credential was written into
     * `task_asks.citations` and into `artifacts.data` in the clear. That is rule 70's dilemma
     * answered by taking the **leak** rather than the collision. TD-012's WP-52 amendment adds the
     * third option — refuse — and it is the one that costs neither: the ask fails by name, the
     * field is named and the value is not.
     */
    const runId = '00000000-0000-4000-8000-00000000c0de';
    const citation = { kind: 'run' as const, run_id: runId, detail: 'see the run' };
    expect(() =>
      redactAskAnswer(
        { answer: 'see the run', citations: [citation], unanswered: [], confidence: 'high' },
        [citation],
        exactSecretRedactor([{ name: 'GIT_TOKEN', value: runId }]),
      ),
    ).toThrowError(/citations\[\]\.run_id/);
  });

  it('cuts each field after redacting, so a placeholder cannot push it past its own contract', async () => {
    // A placeholder is longer than the value it replaced, so a `detail` that arrived exactly at its
    // cap comes out of the redactor past it — and the read endpoint publishes it through the very
    // schema that fixes the cap, so an uncut field is a 500 on the thread rather than a leak. Both
    // sides of the bound (standing rule 42): exactly at the cap survives, one past it is cut.
    // Eight characters — `MIN_SECRET_LENGTH`, the shortest the redactor accepts — because the
    // property only exists when the placeholder is **longer** than what it replaces, and
    // `[REDACTED:integration:GIT_TOKEN]` is 32.
    const secret = 'x'.repeat(8);
    const detail = `${secret}${'d'.repeat(MAX_ASK_CITATION_DETAIL_CHARS - secret.length)}`;
    expect(detail.length).toBe(MAX_ASK_CITATION_DETAIL_CHARS);
    const redacted = redactAskAnswer(
      {
        answer: '',
        citations: [{ kind: 'knowledge', reference: null, detail }],
        unanswered: [],
        confidence: 'low',
      },
      [{ kind: 'knowledge', reference: null, detail }],
      exactSecretRedactor([{ name: 'GIT_TOKEN', value: secret }]),
    );
    expect(redacted.data.citations[0]?.detail.length).toBe(MAX_ASK_CITATION_DETAIL_CHARS);
    expect(redacted.data.citations[0]?.detail).toContain('[REDACTED:integration:GIT_TOKEN]');
    // …and the whole thing is still publishable, which is the property the cut exists for.
    expect(askAnswerDataSchema.safeParse(redacted.data).success).toBe(true);
  });
});

describe('the asker’s provider label is bounded and redacted (round 2)', () => {
  const SECRET = 'glpat-FAKEFAKEFAKEFAKEFAKE';
  const mapped = { 'fake-jira': { 'acct-ada': ASKER } };

  const askFromTicket = async (displayName: string) => {
    const harness = harnessWith({
      identities: mapped,
      askRedactor: exactSecretRedactor([{ name: 'GIT_TOKEN', value: SECRET }]),
    });
    await seedTask(harness);
    await harness.publish([
      event('ticket.comment.added', {
        project_id: PROJECT,
        task_id: null,
        ticket: TICKET,
        comment_id: 'c-label',
        author: {
          provider: 'fake-jira',
          external_id: 'acct-ada',
          email: null,
          display_name: displayName,
          verified: true,
        },
        text: `@agentic ask ${QUESTION}`,
      }),
    ]);
    return harness;
  };

  it('redacts a credential a provider put in the author’s display name', async () => {
    // Two lines from the question that is both bounded and redacted, and it was neither until this
    // round: `ExternalIdentity.display_name` is unbounded untrusted text out of a webhook.
    const harness = await askFromTicket(`Ada ${SECRET}`);
    const identity = harness.asks.all()[0]?.askedByIdentity as Record<string, unknown> | null;
    expect(JSON.stringify(identity)).not.toContain(SECRET);
    expect(identity?.display_name).toBe('Ada [REDACTED:integration:GIT_TOKEN]');
    // …and the count carries it, summed with the question's own.
    expect(harness.asks.all()[0]?.redactionCount).toBe(1);
  });

  it('bounds it at the cap rather than storing whatever the provider sent', async () => {
    const harness = await askFromTicket('A'.repeat(MAX_ASK_IDENTITY_LABEL_CHARS + 100));
    const identity = harness.asks.all()[0]?.askedByIdentity as Record<string, unknown> | null;
    expect(String(identity?.display_name).length).toBe(MAX_ASK_IDENTITY_LABEL_CHARS);
  });

  it('leaves the external id alone, because the handler resolved the mapping through it', async () => {
    // Standing rule 70 again: a redacted key would store an account id that resolves to nobody, on
    // the row whose whole subject is which account asked.
    const harness = await askFromTicket('Ada');
    const identity = harness.asks.all()[0]?.askedByIdentity as Record<string, unknown> | null;
    expect(identity?.external_id).toBe('acct-ada');
    expect(identity?.provider).toBe('fake-jira');
  });
});

describe('admission is re-asked after the prompt is built (TD-004, round 2)', () => {
  /**
   * The window this closes, measured rather than argued.
   *
   * The executor's shape is transaction / plan / transaction, and the plan phase holds no
   * transaction — so a stage running beside the ask can finish and increment `tasks.cost_actual` in
   * it. Until this round only *"is the ask still pending"* was re-asked, so a task that crossed its
   * cap during retrieval still got a paid run worth up to `features.ask.budget_usd`.
   */
  const spendDuringPlanning = (amount: (harness: PipelineHarness) => number): PipelineHarness => {
    // A holder, because the hook has to reach the harness the same call is building.
    const box: { harness?: PipelineHarness } = {};
    box.harness = harnessWith({
      whileAskPlans: async () => {
        const harness = box.harness;
        const task = harness?.store.snapshot()[0];
        if (harness === undefined || task === undefined) throw new Error('no task');
        await harness.memory.transaction(async (scope) =>
          harness.store.tasks.addSpend(scope.tx, task.task.id, amount(harness)),
        );
      },
    });
    return box.harness;
  };

  it('refuses the ask when a stage crosses the task cap while the prompt is built', async () => {
    const harness = spendDuringPlanning((built) => built.settings.taskBudgetUsd);
    await seedTask(harness);
    const before = harness.specs.length;

    await askThroughHttp(harness);

    // No run was created at all: the refusal happens in transaction 1b, before `runs.insert`.
    expect(harness.specs.slice(before).some((spec) => spec.role === ASK_ROLE)).toBe(false);
    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('refused');
    expect(ask?.refusalReason).toContain('cap');
    expect(ask?.runId).toBeNull();
  });

  it('still runs when what committed during planning stays under the cap', async () => {
    // The other direction (standing rule 10): a 1b that refused unconditionally would pass above.
    const harness = spendDuringPlanning(() => 0.01);
    await seedTask(harness);
    const before = harness.specs.length;

    await askThroughHttp(harness);

    expect(harness.specs.slice(before).some((spec) => spec.role === ASK_ROLE)).toBe(true);
    expect(harness.asks.all()[0]?.status).toBe('answered');
  });
});

describe('a ticket comment is classified in both directions (criterion 5)', () => {
  const mapped = { 'fake-jira': { 'acct-ada': ASKER } };

  it('produces exactly one ask for a triggered comment from a mapped author', async () => {
    const harness = harnessWith({ identities: mapped });
    await seedTask(harness);
    await harness.publish([comment(`@agentic ask ${QUESTION}`, true)]);
    expect(harness.asks.all()).toHaveLength(1);
    expect(harness.asks.all()[0]?.source).toBe('ticket');
    expect(harness.asks.all()[0]?.status).toBe('answered');
  });

  it.each([
    ['a plain remark', 'Looks good, shipping Friday.', true],
    ['the platform’s own workpad comment', 'Task ACME-1 agentic:task:abc', true],
    ['a feedback phrase', '@agentic remember: never call the payment API from a controller', true],
  ])('produces none for %s', async (_name, text, verified) => {
    const harness = harnessWith({ identities: mapped });
    await seedTask(harness);
    await harness.publish([comment(text, verified)]);
    expect(harness.asks.all()).toHaveLength(0);
  });

  it('refuses a triggered comment from an unverified identity', async () => {
    const harness = harnessWith({ identities: mapped });
    await seedTask(harness);
    await harness.publish([comment(`@agentic ask ${QUESTION}`, false)]);
    expect(harness.asks.all()).toHaveLength(0);
  });

  it('refuses a verified author the identity map does not actually hold — which on a build with no mapping is every one', async () => {
    // `user_identities` had no writer at all until this work package (PROGRESS backlog 79), so an
    // empty map is what a real instance has. The harness seeds none here on purpose.
    const harness = harnessWith();
    await seedTask(harness);
    await harness.publish([comment(`@agentic ask ${QUESTION}`, true)]);
    expect(harness.asks.all()).toHaveLength(0);
  });

  it('produces one ask for a redelivered comment, not two', async () => {
    const harness = harnessWith({ identities: mapped });
    await seedTask(harness);
    await harness.publish([comment(`@agentic ask ${QUESTION}`, true, 'c-9')]);
    await harness.publish([comment(`@agentic ask ${QUESTION}`, true, 'c-9')]);
    expect(harness.asks.all()).toHaveLength(1);
  });
});

describe('citations cannot cross a task or a project (criterion 6)', () => {
  const known = { runIds: new Set(['run-1']), auditIds: new Set(['audit-1']) };

  it('keeps a citation that resolves and drops one that does not, counting the drops', () => {
    const { kept, dropped } = scopeCitations(
      [
        { kind: 'run', run_id: 'run-1', detail: 'this task’s architecture run' },
        { kind: 'run', run_id: 'run-elsewhere', detail: 'a run of another project' },
        { kind: 'audit', reference: 'audit-1', detail: 'the pause' },
        { kind: 'audit', reference: 'audit-elsewhere', detail: 'somebody else’s pause' },
        { kind: 'artifact', artifact_type: 'ImplementationPlan', version: 2, detail: 'the plan' },
        { kind: 'knowledge', reference: 'technical/04.md', detail: 'the rule' },
      ],
      known,
    );
    expect(kept.map((citation) => citation.detail)).toEqual([
      'this task’s architecture run',
      'the pause',
      'the plan',
      'the rule',
    ]);
    expect(dropped).toBe(2);
  });

  it('drops a `run` citation with no id rather than keeping it as unchecked', () => {
    const { kept, dropped } = scopeCitations(
      [{ kind: 'run', detail: 'a run I will not name' }],
      known,
    );
    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('stores only the citations that survived, and publishes the count that did not', async () => {
    const harness = harnessWith({
      answer: {
        ...ANSWER,
        citations: [
          { kind: 'run', run_id: '00000000-0000-4000-8000-00000000dead', detail: 'elsewhere' },
        ],
      },
    });
    await seedTask(harness);
    await askThroughHttp(harness);
    const [ask] = harness.asks.all();
    expect(ask?.citations).toEqual([]);
    expect(ask?.droppedCitations).toBe(1);
    // The answer survives: refusing it would throw away a run the project paid for (rule 20).
    expect(ask?.status).toBe('answered');
  });
});

describe('a ticket mirror is an outbound duty (criterion 4)', () => {
  it('posts nothing for a `ui` ask when the project has not turned the mirror on (Q72 (d))', async () => {
    const harness = harnessWith();
    await seedTask(harness);
    await askThroughHttp(harness);
    expect(harness.asks.all()[0]?.mirroredAt).toBeNull();
  });

  it('posts the answer when the project asked for the mirror', async () => {
    const harness = harnessWith({ settings: { features: { ask: { mirror_to_ticket: true } } } });
    await seedTask(harness);
    await askThroughHttp(harness);
    const [ask] = harness.asks.all();
    expect(ask?.mirroredAt).not.toBeNull();
    const posted = harness.audit.entriesFor('add_comment').filter((entry) => entry.status === 'ok');
    expect(posted.length).toBeGreaterThan(0);
  });

  it('makes the call from the job and never from a handler', async () => {
    // The mechanism is WP-15d's and is refused mechanically on both paths; what is asserted here is
    // that the ask enqueues onto `pipeline.outbound` rather than calling.
    const harness = harnessWith({ settings: { features: { ask: { mirror_to_ticket: true } } } });
    await seedTask(harness);
    const task = harness.store.snapshot()[0];
    if (task === undefined) throw new Error('no task');
    await askTaskCommand(
      {
        unitOfWork: harness.memory,
        jobs: harness.jobs,
        asks: harness.asks,
        redactor: exactSecretRedactor([]),
      },
      {
        id: harness.ids.next(),
        taskId: task.task.id,
        projectId: PROJECT,
        source: 'ui',
        askedByUserId: ASKER,
        askedByIdentity: null,
        ticketCommentId: null,
        question: QUESTION,
        createdAt: harness.clock.now(),
      },
    );
    expect(harness.jobs.enqueued.map((request) => request.queue)).toContain(JOB_QUEUES.taskAsk);
  });
});

describe('a failed ask', () => {
  it('records the failure on the row and escalates nothing', async () => {
    const harness = harnessWith({ askStatus: 'failed' });
    await seedTask(harness);
    const before = harness.store.snapshot()[0];
    await askThroughHttp(harness);
    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('failed');
    expect(ask?.refusalReason).toContain('failed');
    expect(harness.store.snapshot()[0]?.task.state).toBe(before?.task.state);
  });
});

describe('an ask that never runs', () => {
  it('is refused by name when the project turned the feature off, and no run is created', async () => {
    // product/18:34's default is **on**, so this is a project that said no — which is a different
    // fact from a budget refusal and carries a different sentence.
    const harness = harnessWith({ settings: { features: { ask: { enabled: false } } } });
    await seedTask(harness);
    const before = harness.specs.length;
    await askThroughHttp(harness);
    expect(harness.specs.slice(before).some((spec) => spec.role === ASK_ROLE)).toBe(false);
    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('refused');
    expect(ask?.refusalReason).toContain('features.ask.enabled');
    expect(ask?.runId).toBeNull();
  });

  it('is skipped rather than run twice when the wake-up is delivered again', async () => {
    // A job is a wake-up and not a message (TD-004): the second delivery finds the ask answered.
    const harness = harnessWith();
    await seedTask(harness);
    await askThroughHttp(harness);
    const after = harness.specs.length;

    const [ask] = harness.asks.all();
    const handler = harness.jobs.handlers.get(JOB_QUEUES.taskAsk);
    await handler?.({
      id: 'job-replay',
      queue: JOB_QUEUES.taskAsk,
      data: { ask_id: ask?.id ?? '', task_id: ask?.taskId ?? '', project_id: PROJECT },
      signal: AbortSignal.abort(),
    });
    expect(harness.specs).toHaveLength(after);
    expect(harness.asks.all()[0]?.status).toBe('answered');
  });

  it('does nothing at all for an ask id that does not exist', async () => {
    const harness = harnessWith();
    await seedTask(harness);
    await harness.drain();
    const before = harness.specs.length;
    const handler = harness.jobs.handlers.get(JOB_QUEUES.taskAsk);
    await handler?.({
      id: 'job-ghost',
      queue: JOB_QUEUES.taskAsk,
      data: {
        ask_id: '00000000-0000-4000-8000-0000000000ff',
        task_id: '00000000-0000-4000-8000-0000000000fe',
        project_id: PROJECT,
      },
      signal: AbortSignal.abort(),
    });
    expect(harness.specs).toHaveLength(before);
    expect(harness.asks.all()).toHaveLength(0);
  });

  it('records the failure when the runner cannot start it, and names the class and not the message', async () => {
    // The class name, never the message: an error thrown out of a runner may quote a provider, a
    // URL or a credential, and this string reaches `events.payload` and the ask row (the stage
    // executor's rule, applied one work package later).
    const harness = createPipelineHarness({
      projectId: PROJECT,
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: { decision: 'ask', questions: [{ id: 'q1', text: 'Which currency?' }] },
          costUsd: 0.1,
        },
        [`ask:${QUESTION}`]: {
          status: 'failed',
          terminalReason: 'error_during_execution',
          throwsOnStart: Object.assign(new Error('https://launcher.internal/token=glpat-FAKE'), {
            name: 'LauncherUnreachableError',
          }),
        },
      },
    });
    await seedTask(harness);
    await askThroughHttp(harness);
    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('failed');
    expect(ask?.refusalReason).toContain('LauncherUnreachableError');
    expect(ask?.refusalReason).not.toContain('glpat-FAKE');
  });

  it('fails rather than storing an answer the contract rejects', async () => {
    const harness = harnessWith({ answer: { answer: 'no citations field at all' } });
    await seedTask(harness);
    await askThroughHttp(harness);
    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('failed');
    expect(ask?.refusalReason).toContain('AskAnswer contract');
    expect(ask?.answer).toBeNull();
  });
});

describe('the ask mirror duty’s refusals', () => {
  const mirrorJob = async (harness: PipelineHarness, askId: string) => {
    const handler = harness.jobs.handlers.get(JOB_QUEUES.pipelineOutbound);
    await handler?.({
      id: 'job-mirror',
      queue: JOB_QUEUES.pipelineOutbound,
      data: {
        duty: 'ask_answer',
        project_id: PROJECT,
        task_id: harness.store.snapshot()[0]?.task.id ?? '',
        ask_id: askId,
        cause_event_id: '00000000-0000-4000-8000-0000000000f9',
      },
      signal: AbortSignal.abort(),
    });
  };

  it('posts nothing for an ask id the job carried and the store does not have', async () => {
    const harness = harnessWith({ settings: { features: { ask: { mirror_to_ticket: true } } } });
    await seedTask(harness);
    await harness.drain();
    const before = harness.audit.entriesFor('add_comment').length;
    await mirrorJob(harness, '00000000-0000-4000-8000-0000000000ff');
    expect(harness.audit.entriesFor('add_comment')).toHaveLength(before);
  });

  it('posts nothing for a job that carried no ask id at all', async () => {
    const harness = harnessWith({ settings: { features: { ask: { mirror_to_ticket: true } } } });
    await seedTask(harness);
    await harness.drain();
    const before = harness.audit.entriesFor('add_comment').length;
    const handler = harness.jobs.handlers.get(JOB_QUEUES.pipelineOutbound);
    await handler?.({
      id: 'job-nameless',
      queue: JOB_QUEUES.pipelineOutbound,
      data: {
        duty: 'ask_answer',
        project_id: PROJECT,
        cause_event_id: '00000000-0000-4000-8000-0000000000f9',
      },
      signal: AbortSignal.abort(),
    });
    expect(harness.audit.entriesFor('add_comment')).toHaveLength(before);
  });

  it('posts nothing a second time for an ask it has already mirrored', async () => {
    // The duty's own guard, in front of the executor's idempotency key: a replay is free either
    // way, and this is the one that costs no provider call at all.
    const harness = harnessWith({ settings: { features: { ask: { mirror_to_ticket: true } } } });
    await seedTask(harness);
    await askThroughHttp(harness);
    const [ask] = harness.asks.all();
    expect(ask?.mirroredAt).not.toBeNull();
    const after = harness.audit.entriesFor('add_comment').length;

    await mirrorJob(harness, ask?.id ?? '');
    expect(harness.audit.entriesFor('add_comment')).toHaveLength(after);
  });

  it('mirrors a ticket-side ask whatever the project setting says', async () => {
    // The asymmetry Q72 (d) leaves to this row: the setting exists so the platform does not put its
    // words in front of people who never asked, and somebody who typed `@agentic ask` into the
    // ticket thread **did** ask, in that thread.
    const harness = harnessWith({
      identities: { 'fake-jira': { 'acct-ada': ASKER } },
      settings: { features: { ask: { mirror_to_ticket: false } } },
    });
    await seedTask(harness);
    await harness.publish([comment(`@agentic ask ${QUESTION}`, true)]);
    const [ask] = harness.asks.all();
    expect(ask?.source).toBe('ticket');
    expect(ask?.mirroredAt).not.toBeNull();
  });
});

describe('the in-memory ask store’s stated divergences', () => {
  /**
   * Divergence 4 of its register: migration 0024's three status `check` constraints are enforced
   * here too, by throwing. A caller that broke one would fail in production and pass against a fake
   * that did not — stricter is the only direction a fake may take (standing rule 1).
   */
  it('refuses a refusal with no reason, the way `task_asks_refusal_pair` does', async () => {
    const store = createMemoryAskStore();
    const tx = { adapter: 'memory' } as never;
    const id = '00000000-0000-4000-8000-000000000201' as Id;
    await store.insert(tx, {
      id,
      taskId: '00000000-0000-4000-8000-000000000202' as Id,
      projectId: PROJECT,
      source: 'ui',
      askedByUserId: ASKER,
      askedByIdentity: null,
      ticketCommentId: null,
      question: 'why?',
      redactionCount: 0,
      createdAt: '2026-06-01T09:00:00.000Z' as never,
    });
    await expect(
      store.recordRefusal(tx, { askId: id, status: 'refused', reason: '   ' }),
    ).rejects.toThrow(/carries a reason/);
    // And the row is untouched: a refused write leaves nothing behind.
    expect((await store.load(tx, id))?.status).toBe('pending');
  });

  it.each([
    [
      'attachRun',
      (store: ReturnType<typeof createMemoryAskStore>, tx: never, id: Id) =>
        store.attachRun(tx, id, id),
    ],
    [
      'recordAnswer',
      (store: ReturnType<typeof createMemoryAskStore>, tx: never, id: Id) =>
        store.recordAnswer(tx, {
          askId: id,
          answer: 'x',
          citations: [],
          droppedCitations: 0,
          answerArtifactId: null,
          redactionCount: 0,
          answeredAt: '2026-06-01T09:00:00.000Z' as never,
        }),
    ],
    [
      'markMirrored',
      (store: ReturnType<typeof createMemoryAskStore>, tx: never, id: Id) =>
        store.markMirrored(tx, id, '2026-06-01T09:00:00.000Z' as never),
    ],
  ])('refuses %s against an ask it has never seen, like the SQL adapter', async (_name, call) => {
    const store = createMemoryAskStore();
    await expect(
      call(store, { adapter: 'memory' } as never, '00000000-0000-4000-8000-0000000002ff' as Id),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('an ask whose run somebody else ended first', () => {
  it('writes nothing at all: no answer, no artifact and no spend', async () => {
    // The same rule the stage executor has: `runs.finish` is conditional on this caller still
    // owning the run, and a caller that lost must write nothing. Driven by making the store say it
    // lost, which is the only way this tier can express a second writer.
    const harness = harnessWith({ askCostUsd: 0.2 });
    const task = await seedTask(harness);
    const repository = harness.store.runs as { finish: typeof harness.store.runs.finish };
    const real = repository.finish.bind(harness.store.runs);
    repository.finish = async (tx, outcome) => {
      await real(tx, outcome);
      return false;
    };
    const spentBefore = harness.store.snapshot()[0]?.costActualUsd ?? 0;

    await askThroughHttp(harness);

    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('pending');
    expect(ask?.answer).toBeNull();
    expect(harness.store.snapshot()[0]?.costActualUsd).toBe(spentBefore);
    const artifacts = await harness.memory.transaction(async (scope) =>
      harness.store.artifacts.listFor(scope.tx, task.task.id),
    );
    expect(artifacts.some((artifact) => artifact.type === 'AskAnswer')).toBe(false);
  });
});

describe('the organisation and project budgets stop a new ask (criterion 1)', () => {
  const BUDGET = '00000000-0000-4000-8000-0000000000aa' as Id;

  it('refuses before any run exists, which is why there is nothing in `cost_entries` to read', async () => {
    // Criterion 1 asks for this to be *"read back from `cost_entries` rather than from a status
    // code"*, and a refusal before admission is the strongest form of that: no run was created, so
    // there is no ledger row for it, and the assertion is the absence of an entry for this ask
    // rather than a number the route happened to return.
    const harness = harnessWith({ cost: true });
    const cost = harness.cost;
    if (cost === null) throw new Error('the harness produced no cost store');
    await seedTask(harness);

    cost.seedBudget({
      id: BUDGET,
      scope: 'project',
      scopeId: PROJECT,
      projectId: PROJECT,
      window: 'month',
      limitUsd: 10,
    });
    await cost.budgets.saveWindow({ adapter: 'memory' } as never, {
      budgetId: BUDGET,
      windowStart: '2026-06-01T00:00:00.000Z' as never,
      spentUsd: 10,
      notifiedPct: [],
    });

    const before = harness.specs.length;
    const entriesBefore = cost.entries.length;
    await askThroughHttp(harness);

    expect(harness.specs.slice(before).some((spec) => spec.role === ASK_ROLE)).toBe(false);
    expect(cost.entries).toHaveLength(entriesBefore);
    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('refused');
    expect(ask?.refusalReason).toContain('budget for this month is exhausted');
    expect(ask?.runId).toBeNull();
    // And the **task** is untouched: a budget that stopped a question must not pause a delivery.
    expect(harness.store.snapshot()[0]?.task.state).not.toBe('paused');
  });
});

describe('a run that ended without an answer', () => {
  it('names the stop reason the transcript recorded, not only the status', async () => {
    const harness = createPipelineHarness({
      projectId: PROJECT,
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: { decision: 'ask', questions: [{ id: 'q1', text: 'Which currency?' }] },
          costUsd: 0.1,
        },
        [`ask:${QUESTION}`]: {
          status: 'stalled',
          terminalReason: 'stalled',
          structuredOutput: null,
          costUsd: 0,
          stopReason: 'cost_unreported',
        },
      },
    });
    await seedTask(harness);
    await askThroughHttp(harness);
    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('failed');
    expect(ask?.refusalReason).toContain('stalled');
    expect(ask?.refusalReason).toContain('cost_unreported');
  });

  it('names an unrecognisable throw rather than printing an object', async () => {
    const harness = createPipelineHarness({
      projectId: PROJECT,
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: { decision: 'ask', questions: [{ id: 'q1', text: 'Which currency?' }] },
          costUsd: 0.1,
        },
        [`ask:${QUESTION}`]: {
          status: 'failed',
          terminalReason: 'error_during_execution',
          // Not an `Error`: a transport that rejected with a string is the case the `instanceof`
          // branch exists for, and `[object Object]` in an ask row is what it prevents.
          throwsOnStart: 'the socket went away' as unknown as Error,
        },
      },
    });
    await seedTask(harness);
    await askThroughHttp(harness);
    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('failed');
    expect(ask?.refusalReason).toContain('unknown error');
    expect(ask?.refusalReason).not.toContain('[object');
  });
});

describe('an ask on a task that is gone', () => {
  it('is refused rather than run against a task nobody can read', async () => {
    // The row survives its task's deletion (`run_id` is `on delete set null`, the task is not), so
    // the executor has to answer for the window between the question and the wake-up.
    const harness = harnessWith();
    const task = await seedTask(harness);
    const store = harness.store.tasks as { load: typeof harness.store.tasks.load };
    const real = store.load.bind(harness.store.tasks);
    let dropped = false;
    store.load = async (tx, taskId) => (dropped ? null : real(tx, taskId));

    const result = await askTaskCommand(
      {
        unitOfWork: harness.memory,
        jobs: harness.jobs,
        asks: harness.asks,
        redactor: exactSecretRedactor([]),
      },
      {
        id: harness.ids.next(),
        taskId: task.task.id,
        projectId: PROJECT,
        source: 'ui',
        askedByUserId: ASKER,
        askedByIdentity: null,
        ticketCommentId: null,
        question: QUESTION,
        createdAt: harness.clock.now(),
      },
    );
    dropped = true;
    await harness.drain();
    store.load = real;

    expect(result.status).toBe('recorded');
    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('refused');
    expect(ask?.refusalReason).toContain('no longer exists');
  });
});
