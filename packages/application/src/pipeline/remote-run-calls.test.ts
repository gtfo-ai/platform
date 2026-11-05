/**
 * **What a remote run's calls to the core write** (WP-282, TD-031 decisions 5, 10a, 10b; §9) — the
 * commands over the in-memory store, a hand-built run row and stored plan, the real merge-request
 * tool over the real executor, and a git double with one rule (one open merge request per branch).
 *
 * The plan row's criteria held here: (1) a planted project secret in a transcript entry is stored
 * redacted, an undecodable entry is an `ingest_refused` row at its seq, a seq is stored once; (2) a
 * retried `open_mr` under one `tool_use_id` opens **one** merge request and answers the stored answer;
 * (3) an approval's decision is delivered once; (4) the session mirror is redacted and idempotent by
 * position; (5) `ssh-sign` counts before it signs, refuses past the cap, after the terminal write and
 * under a stale epoch; (7) a planted credential in a tool input is redacted in the audit
 * (`integration_actions`). The PostgreSQL statements are `remote-run-calls.integration.test.ts`'s.
 */
import type { Id, IsoDateTime, JsonObject, TranscriptEvent } from '@platform/contracts';
import { storedRunSpecOf } from '@platform/contracts';
import { DEFAULT_COMMAND_POLICY } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { RUN_TRANSCRIPT_TOPIC } from '../ports/broadcast.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { GitProviderPort, MergeRequestDraft } from '../ports/integrations/git-provider.js';
import {
  type PlatformToolPort,
  type RunSpec,
  runLimitsDefaults,
  runSpecSchema,
  type ToolApprovalRequest,
} from '../ports/runner.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
} from '../testing/memory-integrations.js';
import { createMemoryRemoteRunCallStore } from '../testing/memory-remote-run-calls.js';
import { createTestRunPlanSealer, TEST_RUN_PLAN_KEY_ID } from '../testing/run-plans.js';
import { staticPipelineIntegrations } from './integrations.js';
import { createMergeRequestTools } from './merge-request-tool.js';
import { workerLeaseOwner } from './offers.js';
import {
  createRemoteRunCalls,
  digestOf,
  INGEST_REFUSED_SUBTYPE,
  type RemoteRunCallsOptions,
  type SshSignRequest,
} from './remote-run-calls.js';
import { runCommandsTopic } from './run-commands.js';
import type { PipelineStore, RunSettlement, StoredRunPlan } from './store.js';

const RUN = '00000000-0000-4000-8000-000000282001' as Id;
const OTHER_RUN = '00000000-0000-4000-8000-000000282002' as Id;
const TASK = '00000000-0000-4000-8000-000000282003' as Id;
const PROJECT = '00000000-0000-4000-8000-000000282004' as Id;
const WORKER = '00000000-0000-4000-8000-000000282005' as Id;
const NOW = new Date('2026-11-05T09:00:00.000Z');
/** A project secret only the core's rebuilt redactor knows — shaped past a real token (rule 93). */
const PROJECT_SECRET = 'FAKE-project-secret-0282-aaaaaaaaaaaa';
const BINDING_TOKEN = 'FAKE-binding-token-0282-bbbbbbbbbbbbbb';

const spec = (overrides: Partial<RunSpec> = {}): RunSpec =>
  runSpecSchema.parse({
    runId: RUN,
    taskId: TASK,
    projectId: PROJECT,
    stage: 'implementation',
    role: 'developer',
    mode: 'normal',
    attempt: 1,
    model: 'claude-opus-5',
    effort: 'high',
    providerMode: 'api',
    promptVersion: 'sha256:fixture',
    systemPromptAppend: 'You are the developer agent.',
    userPrompt: 'Fix the flaky login test.',
    checkoutRef: null,
    checkoutCommit: null,
    unfinishedWorkBranch: null,
    workspacePath: '/workspace/task',
    contextPack: [],
    limits: runLimitsDefaults,
    tools: ['Read'],
    disallowedTools: [],
    platformTools: ['open_mr', 'kb_search'],
    commandPolicy: {
      allow: [...DEFAULT_COMMAND_POLICY.allow],
      ask: [...DEFAULT_COMMAND_POLICY.ask],
      block: [...DEFAULT_COMMAND_POLICY.block],
      unattended: 'auto',
    },
    protectedPaths: [],
    plannedProtectedPaths: [],
    existingProtectedPaths: { state: 'unlisted', reason: 'a unit fixture' },
    agents: {},
    mcpServers: {},
    skills: [],
    artifactType: null,
    env: {},
    secretEnvNames: [],
    claudeCodePath: null,
    resumeSessionId: null,
    ...overrides,
  });

/** A git double with the provider's one rule: one open merge request per source branch. */
const gitDouble = () => {
  const drafts: MergeRequestDraft[] = [];
  const open = new Set<string>();
  const port = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a282',
      provider: 'fake-git',
      type: 'git',
    },
    capabilities: () => ({}),
    openMergeRequest: async (draft: MergeRequestDraft) => {
      drafts.push(draft);
      if (open.has(draft.branch)) {
        throw new IntegrationError('conflict', 'fake-git', 'another open merge request exists');
      }
      open.add(draft.branch);
      return {
        ref: {
          provider: 'fake-git',
          project_path: 'acme/api',
          iid: 7,
          url: 'https://git.example.test/acme/api/-/merge_requests/7',
          branch: draft.branch,
          head_sha: 'b'.repeat(40),
        },
        state: 'opened',
        draft: draft.draft,
        title: draft.title,
        description: draft.description,
        source_branch: draft.branch,
        target_branch: draft.target,
        head_sha: 'b'.repeat(40),
        labels: [],
        reviewers: [],
        author: null,
        web_url: 'https://git.example.test/acme/api/-/merge_requests/7',
      };
    },
  } as unknown as GitProviderPort;
  return { port, drafts };
};

const refuse = async (): Promise<never> => {
  throw new Error('this tool is not composed in this test');
};

interface WorldOptions {
  readonly runSpec?: RunSpec;
  readonly maxSignatures?: number;
  readonly approvals?: RemoteRunCallsOptions['approvals'];
  readonly deployKey?: boolean;
  /** The project's `remote_run_credential`, read per signature (backlog 753); `allow` when absent. */
  readonly remote?: () => 'allow' | 'deny';
  readonly maxSessionLines?: number;
  readonly maxTranscriptEntries?: number;
  readonly tools?: Partial<PlatformToolPort>;
}

const world = (options: WorldOptions = {}) => {
  const memory = new MemoryEventing();
  const run = {
    status: 'running' as RunSettlement['status'],
    epoch: 2,
    owner: workerLeaseOwner(WORKER),
  };
  const sealer = createTestRunPlanSealer();
  const stored = storedRunSpecOf(options.runSpec ?? spec());
  const plan = {
    runId: RUN,
    format: 1,
    sealedSpec: sealer.seal(RUN, JSON.stringify(stored)).sealed,
    keyId: TEST_RUN_PLAN_KEY_ID,
    secretEnvNames: [],
    reviewChecklists: null,
    questionTimeout: 'PT4H',
  } as unknown as StoredRunPlan;
  const pipeline = {
    runs: {
      lockSettlement: async (_tx: unknown, runId: Id): Promise<RunSettlement | null> =>
        runId === RUN
          ? {
              runId,
              status: run.status,
              terminalReason: null,
              leaseEpoch: run.epoch,
              leaseOwner: run.owner,
            }
          : null,
      load: async (_tx: unknown, runId: Id) =>
        runId === RUN ? { id: RUN, taskId: TASK, projectId: PROJECT } : null,
    },
    runPlans: { load: async (_tx: unknown, runId: Id) => (runId === RUN ? plan : null) },
  } as unknown as Pick<PipelineStore, 'runs' | 'runPlans'>;
  const store = createMemoryRemoteRunCallStore({
    fenceHolds: async (_tx, input) =>
      input.runId === RUN &&
      ['starting', 'running'].includes(run.status) &&
      run.epoch === input.epoch &&
      run.owner === workerLeaseOwner(input.workerId),
  });
  const git = gitDouble();
  const auditLog = createMemoryAuditLog();
  const executor = createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog,
    idempotencyStore: createMemoryIdempotencyStore(),
    redactor: exactSecretRedactor([]),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: { now: () => NOW.toISOString() as IsoDateTime },
  });
  const mergeRequests = createMergeRequestTools({
    unitOfWork: memory,
    reader: {
      read: async () => ({
        taskId: TASK,
        projectId: PROJECT,
        mode: 'normal',
        ticketKey: 'ACME-1',
        branch: null,
        mr: null,
        defaultBranch: 'main',
        requestedBy: null,
      }),
    },
    tasks: { recordMergeRequest: async () => ({ kind: 'recorded' }) },
    integrations: staticPipelineIntegrations({
      executor,
      git: {
        port: git.port,
        ref: git.port.ref,
        project: 'acme/api',
        redactor: exactSecretRedactor([{ name: 'fake_git_token', value: BINDING_TOKEN }]),
      },
      taskManagement: null,
      communication: null,
    }),
    runScopedSecrets: () => [],
  });
  const kbQueries: string[] = [];
  const tools: PlatformToolPort = {
    askHuman: refuse,
    notifyHuman: refuse,
    reportProgress: refuse,
    getTaskContext: refuse,
    getConversation: refuse,
    // A read that echoes its input: the answer is redacted on the way back.
    kbSearch: async (input) => {
      kbQueries.push(input.query);
      return { hits: [{ path: 'notes.md', excerpt: input.query }] };
    },
    addTicketComment: refuse,
    openMergeRequest: async (input, context) =>
      (await mergeRequests.open(
        { title: input.title, description: input.description },
        {
          taskId: context.taskId,
          projectId: context.projectId,
          ...(context.redactor === undefined ? {} : { redactor: context.redactor }),
        },
      )) as never,
    updateMrDescription: refuse,
    createFollowupTicket: refuse,
  };
  Object.assign(tools, options.tools ?? {});
  const asked: ToolApprovalRequest[] = [];
  const signed: SshSignRequest[] = [];
  const calls = createRemoteRunCalls({
    unitOfWork: memory,
    store,
    pipeline,
    runPlans: sealer,
    // The run's redactor as the core rebuilds it: here, one project secret by exact value.
    redactors: {
      forRun: async () => exactSecretRedactor([{ name: 'project_secret', value: PROJECT_SECRET }]),
    },
    tools,
    approvals: options.approvals ?? {
      requestApproval: async (request) => {
        asked.push(request);
        return { decision: 'deny', reason: 'unattended', questionId: null };
      },
    },
    deployKeys: {
      remoteRunCredential: async () => options.remote?.() ?? 'allow',
      forRun: async () =>
        options.deployKey === false
          ? null
          : {
              admits: (request) => request.data.toString('utf8').startsWith('userauth:git'),
              sign: (request) => {
                signed.push(request);
                return Buffer.from(`sig:${request.data.toString('utf8')}`);
              },
            },
    },
    maxSignatures: options.maxSignatures ?? 128,
    ...(options.maxSessionLines === undefined ? {} : { maxSessionLines: options.maxSessionLines }),
    ...(options.maxTranscriptEntries === undefined
      ? {}
      : { maxTranscriptEntries: options.maxTranscriptEntries }),
    now: () => NOW,
  });
  return { calls, memory, run, store, git, auditLog, kbQueries, asked, signed };
};

const assistant = (seq: number, text: string, overrides: Partial<JsonObject> = {}): JsonObject => ({
  run_id: RUN,
  seq,
  created_at: '2026-11-05T08:59:00.000Z',
  redaction_count: 1,
  kind: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text }],
  ...overrides,
});

const fence = { runId: RUN, workerId: WORKER, epoch: 2 } as const;

describe('transcript ingest (TD-031 §10a)', () => {
  it('re-redacts a planted project secret before the row is written, and counts both sides', async () => {
    const w = world();
    const hints: unknown[] = [];
    await w.memory.broadcast.subscribe([RUN_TRANSCRIPT_TOPIC], (message) => {
      hints.push(message.payload);
    });
    const answer = await w.calls.transcript({
      ...fence,
      entries: [
        { seq: 0, event: assistant(0, `the token is ${PROJECT_SECRET}, control text kept`) },
      ],
    });
    expect(answer).toEqual({ kind: 'stored', stored: 1, refusedSeqs: [] });
    const rows = w.store.transcriptRows(RUN);
    expect(JSON.stringify(rows)).not.toContain(PROJECT_SECRET);
    expect(JSON.stringify(rows)).toContain('control text kept');
    // The worker's one plus the core's one.
    expect(rows[0]?.redaction_count).toBe(2);
    // The `run:<id>` stream is told the position at the commit.
    expect(hints).toEqual([{ run_id: RUN, seq: 0 }]);
  });

  it('stores an undecodable entry as an ingest_refused row at its seq, naming paths and not content', async () => {
    const w = world();
    const answer = await w.calls.transcript({
      ...fence,
      entries: [
        { seq: 1, event: { kind: 'assistant', secret_field: PROJECT_SECRET } },
        { seq: 2, event: assistant(2, 'fine') },
        { seq: 3, event: assistant(4, 'names another seq') },
        { seq: 5, event: assistant(5, 'another run', { run_id: OTHER_RUN }) },
        {
          seq: 6,
          event: assistant(6, 'from the past', { created_at: '2020-01-01T00:00:00.000Z' }),
        },
      ],
    });
    expect(answer).toEqual({ kind: 'stored', stored: 5, refusedSeqs: [1, 3, 5, 6] });
    const rows = w.store.transcriptRows(RUN) as TranscriptEvent[];
    const refused = rows.filter((row) => row.kind === 'system');
    expect(refused.map((row) => row.seq)).toEqual([1, 3, 5, 6]);
    for (const row of refused) {
      expect(row).toMatchObject({ subtype: INGEST_REFUSED_SUBTYPE, run_id: RUN });
    }
    expect(JSON.stringify(refused)).not.toContain(PROJECT_SECRET);
    expect(rows.find((row) => row.seq === 2)?.kind).toBe('assistant');
  });

  it('refuses a batch that would take the run past its bound, storing nothing of it (backlog 754)', async () => {
    const w = world({ maxTranscriptEntries: 3 });
    expect(
      await w.calls.transcript({
        ...fence,
        entries: [
          { seq: 0, event: assistant(0, 'a') },
          { seq: 1, event: assistant(1, 'b') },
        ],
      }),
    ).toEqual({ kind: 'stored', stored: 2, refusedSeqs: [] });
    // Two more would make four: the whole batch is refused, the bound named.
    expect(
      await w.calls.transcript({
        ...fence,
        entries: [
          { seq: 2, event: assistant(2, 'c') },
          { seq: 3, event: assistant(3, 'd') },
        ],
      }),
    ).toEqual({ kind: 'full', limit: 3 });
    expect(w.store.transcriptRows(RUN)).toHaveLength(2);
    // Up to the bound is stored: exactly three.
    expect(
      await w.calls.transcript({ ...fence, entries: [{ seq: 2, event: assistant(2, 'c') }] }),
    ).toEqual({ kind: 'stored', stored: 1, refusedSeqs: [] });
    expect(w.store.transcriptRows(RUN)).toHaveLength(3);
  });

  it('stores one row per (run_id, seq): a repeat with another instant writes nothing', async () => {
    const w = world();
    await w.calls.transcript({ ...fence, entries: [{ seq: 4, event: assistant(4, 'first') }] });
    const again = await w.calls.transcript({
      ...fence,
      entries: [
        { seq: 4, event: assistant(4, 'second', { created_at: '2026-11-05T08:59:30.000Z' }) },
        { seq: 4, event: assistant(4, 'third') },
      ],
    });
    expect(again).toEqual({ kind: 'stored', stored: 0, refusedSeqs: [] });
    expect(w.store.transcriptRows(RUN).map((row) => JSON.stringify(row))).toEqual([
      expect.stringContaining('first'),
    ]);
  });

  it('accepts a held run that ended, and refuses another epoch or another worker', async () => {
    const w = world();
    w.run.status = 'completed';
    expect(
      (await w.calls.transcript({ ...fence, entries: [{ seq: 0, event: assistant(0, 'tail') }] }))
        .kind,
    ).toBe('stored');
    expect(
      await w.calls.transcript({
        ...fence,
        epoch: 1,
        entries: [{ seq: 1, event: assistant(1, 'x') }],
      }),
    ).toEqual({ kind: 'lease_lost' });
    expect(
      await w.calls.transcript({
        ...fence,
        workerId: OTHER_RUN,
        entries: [{ seq: 1, event: assistant(1, 'x') }],
      }),
    ).toEqual({ kind: 'lease_lost' });
    expect(
      await w.calls.transcript({
        ...fence,
        runId: OTHER_RUN,
        entries: [{ seq: 1, event: assistant(1, 'x') }],
      }),
    ).toEqual({ kind: 'run_gone' });
  });
});

describe('platform tools through the core (TD-031 §10b)', () => {
  const openMr = (toolUseId: string, description = 'Fixes the flaky test.') => ({
    ...fence,
    name: 'open_mr' as const,
    toolUseId,
    input: { title: 'Fix the flaky login test', description },
    signal: new AbortController().signal,
  });

  it('a retried open_mr under one tool_use_id opens one merge request and answers the stored answer', async () => {
    const w = world();
    const first = await w.calls.tool(openMr('toolu_01'));
    expect(first).toMatchObject({ kind: 'answered', isError: false, result: { iid: 7 } });
    const second = await w.calls.tool(openMr('toolu_01'));
    expect(second).toEqual(first);
    // One provider call: the retry never reached the executor.
    expect(w.git.drafts).toHaveLength(1);
    expect(w.store.toolCallRows(RUN)).toHaveLength(1);
  });

  it('refuses the same tool_use_id with another input, and answers in_flight while a claim performs', async () => {
    const w = world();
    await w.calls.tool(openMr('toolu_02'));
    expect(await w.calls.tool(openMr('toolu_02', 'Something else.'))).toEqual({ kind: 'reused' });
    // A claim nobody completed, younger than the take-over bound.
    await w.memory.transaction(async (scope) =>
      w.store.claimToolCall(scope.tx, {
        runId: RUN,
        toolUseDigest: digestOf('toolu_03'),
        toolName: 'open_mr',
        // The canonical text of the input: keys sorted.
        inputDigest: digestOf(
          JSON.stringify({
            description: 'Fixes the flaky test.',
            title: 'Fix the flaky login test',
          }),
        ),
        epoch: 2,
        at: NOW.toISOString() as IsoDateTime,
        takeOverBefore: null,
      }),
    );
    expect(await w.calls.tool(openMr('toolu_03'))).toEqual({ kind: 'in_flight' });
    expect(w.git.drafts).toHaveLength(1);
  });

  it('gives the claim back when the worker went away mid-call, so its retry performs the call again', async () => {
    const aborted = new AbortController();
    let calls = 0;
    const w = world({
      tools: {
        openMergeRequest: async () => {
          calls += 1;
          if (calls === 1) aborted.abort();
          return { iid: 7, attempt: calls };
        },
      },
    });
    const first = await w.calls.tool({ ...openMr('toolu_12'), signal: aborted.signal });
    expect(first.kind).toBe('answered');
    // Nothing stored for an answer nobody received.
    expect(w.store.toolCallRows(RUN)).toHaveLength(0);
    const retry = await w.calls.tool(openMr('toolu_12'));
    expect(retry).toMatchObject({ kind: 'answered', result: { attempt: 2 } });
    expect(calls).toBe(2);
    // The retry's answer is the stored one from now on.
    expect(await w.calls.tool(openMr('toolu_12'))).toEqual(retry);
    expect(calls).toBe(2);
  });

  it('keeps a planted credential in a tool input out of the provider request and the audit (integration_actions)', async () => {
    const w = world();
    const answer = await w.calls.tool(openMr('toolu_04', `uses ${PROJECT_SECRET} to log in`));
    expect(answer).toMatchObject({ kind: 'answered', isError: false });
    expect(w.auditLog.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(w.auditLog.entries)).not.toContain(PROJECT_SECRET);
    expect(JSON.stringify(w.git.drafts)).not.toContain(PROJECT_SECRET);
    // Positively: the description did reach the provider, with the secret replaced.
    expect(w.git.drafts[0]?.description).toContain('to log in');
  });

  it('redacts a read’s answer, does not deduplicate a read, and refuses a tool the role was not given', async () => {
    const w = world();
    const read = await w.calls.tool({
      ...fence,
      name: 'kb_search',
      toolUseId: 'toolu_05',
      input: { query: `where is ${PROJECT_SECRET}` },
      signal: new AbortController().signal,
    });
    expect(read.kind).toBe('answered');
    expect(JSON.stringify(read)).not.toContain(PROJECT_SECRET);
    await w.calls.tool({
      ...fence,
      name: 'kb_search',
      toolUseId: 'toolu_05',
      input: { query: 'again' },
      signal: new AbortController().signal,
    });
    expect(w.kbQueries).toHaveLength(2);
    expect(w.store.toolCallRows(RUN)).toHaveLength(0);
    expect(
      await w.calls.tool({
        ...fence,
        name: 'add_ticket_comment',
        toolUseId: 'toolu_06',
        input: { body: 'hello' },
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'not_granted' });
  });

  it('answers an invalid input as the MCP server does, and refuses an ended run or a stale epoch', async () => {
    const w = world();
    const invalid = await w.calls.tool({
      ...fence,
      name: 'kb_search',
      toolUseId: 'toolu_07',
      input: { query: 'x', extra: true },
      signal: new AbortController().signal,
    });
    expect(invalid).toMatchObject({ kind: 'answered', isError: true });
    expect(String((invalid as { result: unknown }).result)).toMatch(/^invalid input for kb_search/);
    expect(await w.calls.tool({ ...openMr('toolu_08'), epoch: 1 })).toEqual({ kind: 'lease_lost' });
    w.run.status = 'completed';
    expect(await w.calls.tool(openMr('toolu_09'))).toEqual({ kind: 'lease_lost' });
    expect(w.git.drafts).toHaveLength(0);
  });
});

describe('approvals (TD-031 §9)', () => {
  it('opens one approval per tool_use_id, asks the port with redacted text, and delivers the decision once', async () => {
    const w = world();
    let decide: (() => void) | undefined;
    const woken: string[] = [];
    await w.memory.broadcast.subscribe([runCommandsTopic(workerLeaseOwner(WORKER))], (message) => {
      woken.push(message.topic);
    });
    const opened = await w.calls.openApproval({
      ...fence,
      toolUseId: 'toolu_10',
      toolName: 'WebFetch',
      detail: `fetch https://example.test/?k=${PROJECT_SECRET}`,
      input: { url: `https://example.test/?k=${PROJECT_SECRET}` },
      reason: 'ask list',
    });
    expect(opened.kind).toBe('opened');
    const again = await w.calls.openApproval({
      ...fence,
      toolUseId: 'toolu_10',
      toolName: 'WebFetch',
      detail: 'x',
      input: {},
      reason: 'ask list',
    });
    expect(again).toEqual(opened);
    // The port is asked after the commit, outside the request.
    await new Promise<void>((resolve) => {
      decide = resolve;
      setTimeout(() => decide?.(), 10);
    });
    expect(w.asked).toHaveLength(1);
    expect(JSON.stringify(w.asked[0]?.input)).not.toContain(PROJECT_SECRET);
    expect(w.asked[0]?.detail).not.toContain(PROJECT_SECRET);
    expect(woken).toHaveLength(1);
    const delivered = await w.calls.deliverApprovals({ runId: RUN });
    expect(delivered).toEqual([
      {
        approvalId: (opened as { approvalId: Id }).approvalId,
        decision: 'deny',
        reason: 'unattended',
        questionId: null,
      },
    ]);
    expect(await w.calls.deliverApprovals({ runId: RUN })).toEqual([]);
  });

  it('denies an approval whose port throws, rather than leaving it to hang', async () => {
    const w = world({
      approvals: {
        requestApproval: async () => {
          throw new Error('nobody home');
        },
      },
    });
    await w.calls.openApproval({
      ...fence,
      toolUseId: 'toolu_11',
      toolName: 'WebFetch',
      detail: 'x',
      input: {},
      reason: 'ask list',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await w.calls.deliverApprovals({ runId: RUN }))[0]?.decision).toBe('deny');
  });
});

describe('the session mirror (TD-007, TD-031 §9)', () => {
  it('redacts each line and stores each position once', async () => {
    const w = world();
    const lines = ['{"type":"user"}', `{"token":"${PROJECT_SECRET}"}`];
    expect(await w.calls.session({ ...fence, sessionId: 'sess-1', fromLine: 0, lines })).toEqual({
      kind: 'stored',
      stored: 2,
    });
    expect(
      await w.calls.session({
        ...fence,
        sessionId: 'sess-1',
        fromLine: 1,
        lines: [lines[1] ?? '', '{"n":3}'],
      }),
    ).toEqual({ kind: 'stored', stored: 1 });
    const rows = w.store.sessionRows(RUN);
    expect(rows.map((row) => row.line)).toEqual([0, 1, 2]);
    expect(JSON.stringify(rows)).not.toContain(PROJECT_SECRET);
    expect(
      await w.calls.session({ ...fence, epoch: 9, sessionId: 's', fromLine: 0, lines: [] }),
    ).toEqual({
      kind: 'lease_lost',
    });
  });
});

describe('the session mirror’s bound is per run (review of PR #22)', () => {
  it('counts every session id the run names: a second session cannot store past the run’s bound', async () => {
    const w = world({ maxSessionLines: 3 });
    expect(
      await w.calls.session({ ...fence, sessionId: 'sess-a', fromLine: 0, lines: ['1', '2'] }),
    ).toEqual({ kind: 'stored', stored: 2 });
    // A rotated session id starts at line 0 again; the run's total is what is bounded.
    expect(
      await w.calls.session({ ...fence, sessionId: 'sess-b', fromLine: 0, lines: ['3', '4'] }),
    ).toEqual({ kind: 'full', limit: 3 });
    expect(
      await w.calls.session({ ...fence, sessionId: 'sess-b', fromLine: 0, lines: ['3'] }),
    ).toEqual({ kind: 'stored', stored: 1 });
    expect(w.store.sessionRows(RUN)).toHaveLength(3);
  });
});

describe('ssh-sign (TD-031 decision 5, the 2026-11-04 amendment)', () => {
  const request = (data = 'userauth:git'): SshSignRequest => ({
    keyBlob: Buffer.from('key'),
    data: Buffer.from(data),
    flags: 0,
  });

  it('counts every signature against one cap, and signs nothing past it', async () => {
    const w = world({ maxSignatures: 2 });
    expect((await w.calls.sshSign({ ...fence, request: request() })).kind).toBe('signed');
    expect((await w.calls.sshSign({ ...fence, request: request() })).kind).toBe('signed');
    expect(await w.calls.sshSign({ ...fence, request: request() })).toEqual({
      kind: 'refused',
      reason: 'cap',
    });
    expect(w.store.signatures(RUN)).toBe(2);
    expect(w.signed).toHaveLength(2);
  });

  it('refuses what the oracle refuses without counting it, and a run with no deploy key', async () => {
    const w = world();
    expect(await w.calls.sshSign({ ...fence, request: request('SSHSIG arbitrary') })).toEqual({
      kind: 'refused',
      reason: 'not_admitted',
    });
    expect(w.store.signatures(RUN)).toBe(0);
    const keyless = world({ deployKey: false });
    expect(await keyless.calls.sshSign({ ...fence, request: request() })).toEqual({
      kind: 'refused',
      reason: 'no_deploy_key',
    });
  });

  it('re-reads remote_run_credential per signature: deny mid-run stops the next one (backlog 753)', async () => {
    let remote: 'allow' | 'deny' = 'allow';
    const w = world({ remote: () => remote });
    expect((await w.calls.sshSign({ ...fence, request: request() })).kind).toBe('signed');
    remote = 'deny';
    expect(await w.calls.sshSign({ ...fence, request: request() })).toEqual({
      kind: 'refused',
      reason: 'remote_credential_denied',
    });
    expect(w.signed).toHaveLength(1);
    expect(w.store.signatures(RUN)).toBe(1);
  });

  it('refuses a sign after the terminal write and under a stale epoch, signing nothing', async () => {
    const w = world();
    expect(await w.calls.sshSign({ ...fence, epoch: 1, request: request() })).toEqual({
      kind: 'lease_lost',
    });
    w.run.status = 'completed';
    expect(await w.calls.sshSign({ ...fence, request: request() })).toEqual({ kind: 'lease_lost' });
    expect(w.signed).toHaveLength(0);
    expect(w.store.signatures(RUN)).toBe(0);
  });
});
