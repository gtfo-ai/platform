/**
 * The two **partitions** the read API branches on, asserted against the enums they partition.
 *
 * `GET /api/org/agents` answers with the runs that are *not* terminal, and `ProjectSummary.
 * open_tasks` counts the tasks that are *not* closed. Both are written as one list and a
 * complement, so a status added to `runStatusSchema` or `taskStateSchema` and to neither list
 * silently picks a side — and in both cases it picks the **visible** one: a finished run would sit
 * on the agents screen for ever, and a closed task would be counted as open on every dashboard.
 *
 * This is standing rule 68: when a behaviour is parameterised over a set, the test has to be
 * parameterised over the same set, or the set is decoration. Reading the enum out of
 * `@platform/contracts` rather than restating its members here is what makes that true — the
 * assertion fails on the commit that adds a member, in this file, naming it.
 *
 * The projections themselves are exercised against real SQL in
 * `test/integration/server/read-api.integration.test.ts` and against rows the pipeline wrote in
 * `test/e2e/server/read-api.e2e.test.ts`; there is nothing a stubbed Drizzle handle could say about
 * them that either of those does not say better.
 */
import {
  RUN_STOPPED_REASONS,
  runStatusSchema,
  taskStageStateSchema,
  taskStateSchema,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  CLOSED_TASK_STATES,
  ciManualNotRunOf,
  ciManualStartedOf,
  gateWaitOf,
  lastGateWaitOf,
  latestProgressOfRow,
  runStageOf,
  savedWorkOf,
  stageStateOf,
  startFailureOf,
  stopReasonOfRow,
  TERMINAL_RUN_STATUSES,
  ticketClaimViewOf,
  ticketTitleOf,
  UnknownStageStateError,
  UnprojectableRowError,
} from './pipeline-queries.js';

describe('the run-status partition behind GET /api/org/agents', () => {
  it('covers every member of runStatusSchema exactly once', () => {
    const all = [...runStatusSchema.options].sort();
    const terminal = [...TERMINAL_RUN_STATUSES].sort();
    const active = all.filter((status) => !TERMINAL_RUN_STATUSES.includes(status));

    expect([...terminal, ...active].sort()).toEqual(all);
    // Both halves are non-empty, so the equality above cannot be satisfied by a list that swallowed
    // the whole enum or by one that is empty (standing rule 42).
    expect(terminal.length).toBeGreaterThan(0);
    expect(active).toEqual(['created', 'running', 'starting']);
  });

  it('treats a stalled run as ended and a starting one as an agent at work', () => {
    // The two judgement calls, named rather than left to the list: `stalled` is an ending the
    // platform reached (`runs.terminal_reason` has a value for it), and `created` is a run whose
    // row exists before its process does — which is still an agent about to work.
    expect(TERMINAL_RUN_STATUSES).toContain('stalled');
    expect(TERMINAL_RUN_STATUSES).not.toContain('created');
  });
});

describe('the task-state partition behind ProjectSummary.open_tasks', () => {
  it('covers every member of taskStateSchema exactly once', () => {
    const all = [...taskStateSchema.options].sort();
    const closed = [...CLOSED_TASK_STATES].sort();
    const open = all.filter((state) => !CLOSED_TASK_STATES.includes(state));

    expect([...closed, ...open].sort()).toEqual(all);
    expect(closed).toEqual(['cancelled', 'done']);
    expect(open.length).toBeGreaterThan(0);
  });

  it('counts a merged task and a task in retro as still open', () => {
    // The retrospective stage runs *after* the merge, so both still cost money and both still have
    // a stage to enter. Counting them as closed would make the dashboard's "open work" disagree
    // with the pipeline about when a task is over.
    expect(CLOSED_TASK_STATES).not.toContain('merged');
    expect(CLOSED_TASK_STATES).not.toContain('retro');
  });
});

/** WP-55: the stage state is parsed, never mapped — and a word outside the vocabulary is named. */
describe('stageStateOf', () => {
  it('publishes every word of the vocabulary as stored', () => {
    for (const state of taskStageStateSchema.options) {
      expect(stageStateOf({ stage: 'code_review', attempt: 1, state })).toBe(state);
    }
  });

  it('refuses the pre-0040 words and anything else with a typed error naming the row', () => {
    for (const state of ['entered', 'exited', '']) {
      expect(() => stageStateOf({ stage: 'ci_gate', attempt: 2, state })).toThrow(
        UnknownStageStateError,
      );
    }
    expect(() => stageStateOf({ stage: 'ci_gate', attempt: 2, state: 'exited' })).toThrow(
      /ci_gate#2 has state "exited"/,
    );
  });
});

/** WP-95, Q48: the board card's title comes out of the stored snapshot, or it is `null`. */
describe('ticketTitleOf', () => {
  it('reads the snapshot’s title as stored, including an empty one', () => {
    expect(ticketTitleOf({ title: 'Log in with a passkey', description: '' })).toBe(
      'Log in with a passkey',
    );
    // An empty title is what the provider said; it is not "not read" (standing rule 18).
    expect(ticketTitleOf({ title: '' })).toBe('');
  });

  it('answers null for no snapshot and for a snapshot whose title is not a string', () => {
    expect(ticketTitleOf(null)).toBeNull();
    expect(ticketTitleOf(undefined)).toBeNull();
    expect(ticketTitleOf({ description: 'no title key' })).toBeNull();
    expect(ticketTitleOf({ title: 42 })).toBeNull();
    expect(ticketTitleOf('a string')).toBeNull();
  });
});

/**
 * `runs.exit_detail` → `RunRecord.start_failure` (PROGRESS backlog 453), every branch: the column
 * null, a detail of another kind, a start failure this release reads, and one it cannot — which is
 * refused by name rather than published as `null`, because `null` says the run started. The column
 * and the record against PostgreSQL are `read-api.integration.test.ts`'s.
 */
describe('the start failure a run record publishes', () => {
  const ID = '00000000-0000-4000-8000-000000000453';
  const failure = {
    kind: 'not_started',
    diagnosis: 'RunStartError: workspace_failed',
    detail: "mkdir: can't create directory '/ctl/run': Permission denied",
    truncated: false,
    attempt: 1,
    retryable: false,
  };

  it('publishes null for a run that started and for a detail of another kind', () => {
    expect(startFailureOf({ id: ID, exitDetail: null })).toBeNull();
    expect(startFailureOf({ id: ID, exitDetail: { kind: 'other' } })).toBeNull();
  });

  it('publishes a start failure it reads, and refuses one it cannot', () => {
    expect(startFailureOf({ id: ID, exitDetail: failure })).toEqual(failure);
    expect(() => startFailureOf({ id: ID, exitDetail: { ...failure, unexpected: true } })).toThrow(
      `run ${ID} cannot be returned`,
    );
  });
});

/**
 * `runs.saved_work` → `RunRecord.saved_work` (PROGRESS backlog 467): the column null, a value this
 * release reads, and one it cannot — refused by name, because `null` would say no work was saved.
 */
describe('the saved work a run record publishes', () => {
  const ID = '00000000-0000-4000-8000-000000000467';
  const saved = { branch: 'agentic/ACME-1', commit_sha: 'abc1234def', pushed: true };

  it('publishes null for a run that saved nothing, and the record it reads', () => {
    expect(savedWorkOf({ id: ID, savedWork: null })).toBeNull();
    expect(savedWorkOf({ id: ID, savedWork: saved })).toEqual(saved);
  });

  it('refuses a value it cannot read rather than saying nothing was saved', () => {
    expect(() => savedWorkOf({ id: ID, savedWork: { ...saved, branch: 'main' } })).toThrow(
      `run ${ID} cannot be returned`,
    );
  });
});

/**
 * `RunRecord.stage` (PROGRESS backlog 493): an ask run has none and publishes `null`; a stage run
 * has its stage; a stage run with no link is still refused — never published as if it were an ask.
 */
describe('the stage a run record publishes', () => {
  const ID = '00000000-0000-4000-8000-000000000493';

  it('publishes null for an ask run and the stage for a stage run', () => {
    expect(runStageOf({ id: ID, stage: null, role: 'ask' })).toBeNull();
    expect(runStageOf({ id: ID, stage: 'implementation', role: 'developer' })).toBe(
      'implementation',
    );
  });

  it('refuses a stage run with no stage attempt rather than calling it an ask', () => {
    expect(() => runStageOf({ id: ID, stage: null, role: 'developer' })).toThrow(
      `run ${ID} cannot be returned`,
    );
  });
});

/**
 * `RunRecord.latest_progress` (PROGRESS backlog 496): a stored `progress` row is published as its
 * line, and a row this release cannot read is refused by name, never published as "no progress".
 */
describe('the latest progress line a run record publishes', () => {
  const RUN = '00000000-0000-4000-8000-000000000496';
  const payload = {
    run_id: RUN,
    seq: 9,
    created_at: '2026-10-06T10:00:00.000Z',
    parent_tool_use_id: null,
    redaction_count: 0,
    kind: 'progress',
    summary: 'slice 2 pushed',
    percent_complete: 40,
    truncated: false,
  };

  it('publishes the summary, the percentage and where the row sits', () => {
    expect(latestProgressOfRow({ runId: RUN, seq: 9, payload, blobId: null })).toEqual({
      seq: 9,
      at: '2026-10-06T10:00:00.000Z',
      summary: 'slice 2 pushed',
      percent_complete: 40,
    });
    const { percent_complete: _omitted, ...withoutPercent } = payload;
    expect(
      latestProgressOfRow({ runId: RUN, seq: 9, payload: withoutPercent, blobId: null })
        .percent_complete,
    ).toBeNull();
  });

  it.each([
    ['a payload in blobs', { payload, blobId: '00000000-0000-4000-8000-0000000000b1' }],
    ['a payload the schema refuses', { payload: { ...payload, summary: '' }, blobId: null }],
    [
      'a row of another kind',
      { payload: { ...payload, kind: 'steer', message: 'x', author_user_id: RUN }, blobId: null },
    ],
  ])('refuses %s by name', (_name, row) => {
    expect(() => latestProgressOfRow({ runId: RUN, seq: 9, ...row })).toThrow(
      `entry 9 of run ${RUN} cannot be returned`,
    );
  });
});

/** S-25.22 (BACKLOG 1394): `RunRecord.stop_reason`, off the newest `run_stopped` row. */
describe('stopReasonOfRow', () => {
  it.each(RUN_STOPPED_REASONS)('publishes the runner’s word %s', (reason) => {
    expect(stopReasonOfRow({ reason, blobId: null })).toBe(reason);
  });

  it.each([
    ['a word outside the runner’s vocabulary', { reason: 'overspent', blobId: null }],
    ['a missing reason', { reason: null, blobId: null }],
    ['a number', { reason: 3, blobId: null }],
    [
      'a payload in blobs',
      { reason: 'cost_unreported', blobId: '00000000-0000-4000-8000-0000000000b9' },
    ],
  ])('publishes null for %s — the terminal reason’s own words, nothing invented', (_name, row) => {
    expect(stopReasonOfRow(row)).toBeNull();
  });
});

/** WP-181 ruling (f), review round 1: the task DTO's view of `tasks.ticket_claim`. */
describe('ticketClaimViewOf', () => {
  const TASK = '00000000-0000-4000-8000-0000000001f1';
  const stored = {
    account_id: '557058:example',
    claimed_at: '2026-10-08T09:00:00.000Z',
    status: 'confirmed',
    in_progress_written: true,
    stale: false,
    released_at: null,
    release_cause: null,
  };

  it('publishes the status and the two instants, and null for a task that never claimed', () => {
    expect(ticketClaimViewOf(TASK, stored)).toEqual({
      status: 'confirmed',
      claimed_at: '2026-10-08T09:00:00.000Z',
      released_at: null,
    });
    expect(ticketClaimViewOf(TASK, null)).toBeNull();
  });

  it('refuses a corrupt claim by name, never a raw ZodError and never null', () => {
    for (const corrupt of [{ ...stored, status: 'stale' }, 'not an object', { claimed_at: 'x' }]) {
      const failure = (() => {
        try {
          return ticketClaimViewOf(TASK, corrupt);
        } catch (error) {
          return error;
        }
      })();
      expect(failure, JSON.stringify(corrupt)).toBeInstanceOf(UnprojectableRowError);
      expect((failure as UnprojectableRowError).code).toBe('row_not_projectable');
      expect((failure as Error).message).toContain(`task ${TASK}`);
      expect((failure as Error).message).toContain('tasks.ticket_claim');
    }
  });
});

/**
 * Backlog 1078: `gate_wait` is the **open** `ci_gate` attempt's last pending read, at the stage the
 * task is at — and a stored value that does not parse is refused by name, never served as null.
 */
describe('gate_wait on the task detail', () => {
  type StageRow = Parameters<typeof gateWaitOf>[1][number];
  const TASK = '00000000-0000-4000-8000-000000001078';
  const ENTERED = new Date('2026-11-06T19:28:00.000Z');
  const READ = {
    pipeline_id: '3038234623',
    pipeline_url: 'https://gitlab.example.test/acme/api/-/pipelines/3038234623',
    head_sha: '1111111111111111111111111111111111111111',
    status: 'manual',
    held_job: 'sentry-release-commit',
    held_job_url: 'https://gitlab.example.test/acme/api/-/jobs/9003',
    draft: true,
    checked_at: '2026-11-06T19:58:00.000Z',
    timeout_minutes: 60,
  };
  const row = (over: Partial<StageRow> = {}): StageRow =>
    ({
      taskId: TASK,
      stage: 'ci_gate',
      attempt: 1,
      state: 'running',
      enteredAt: ENTERED,
      exitedAt: null,
      ciPendingRead: READ,
      ...over,
    }) as unknown as StageRow;

  it('serves the open attempt’s read, timed from its entry, without the head it keys on', () => {
    expect(gateWaitOf({ state: 'active', currentStage: 'ci_gate' }, [row()])).toEqual({
      pipeline_id: '3038234623',
      pipeline_url: 'https://gitlab.example.test/acme/api/-/pipelines/3038234623',
      status: 'manual',
      held_job: 'sentry-release-commit',
      held_job_url: 'https://gitlab.example.test/acme/api/-/jobs/9003',
      draft: true,
      checked_at: '2026-11-06T19:58:00.000Z',
      waiting_since: '2026-11-06T19:28:00.000Z',
      timeout_minutes: 60,
    });
  });

  it('reads the newest attempt: a closed first attempt’s read is not the open second’s', () => {
    const closed = row({ state: 'failed', exitedAt: new Date('2026-11-06T20:28:00.000Z') });
    const reopened = row({
      attempt: 2,
      enteredAt: new Date('2026-11-06T21:53:00.000Z'),
      ciPendingRead: { ...READ, status: 'running', held_job: null, held_job_url: null },
    });
    expect(
      gateWaitOf({ state: 'active', currentStage: 'ci_gate' }, [closed, reopened]),
    ).toMatchObject({
      status: 'running',
      held_job: null,
      waiting_since: '2026-11-06T21:53:00.000Z',
    });
  });

  it('is null at another stage, for a closed attempt and for an attempt with no read', () => {
    expect(gateWaitOf({ state: 'active', currentStage: 'code_review' }, [row()])).toBeNull();
    expect(gateWaitOf({ state: 'active', currentStage: null }, [row()])).toBeNull();
    expect(
      gateWaitOf({ state: 'active', currentStage: 'ci_gate' }, [
        row({ state: 'failed', exitedAt: new Date('2026-11-06T20:28:00.000Z') }),
      ]),
    ).toBeNull();
    expect(
      gateWaitOf({ state: 'active', currentStage: 'ci_gate' }, [row({ ciPendingRead: null })]),
    ).toBeNull();
    expect(
      gateWaitOf({ state: 'active', currentStage: 'ci_gate' }, [row({ stage: 'rebase_gate' })]),
    ).toBeNull();
  });

  /**
   * Backlog 1301: a pause closes no stage row and the CI job stops checking a paused task, so a
   * wait is served only while the task is runnable (`active`) — every reader gets that answer.
   */
  it('is null unless the task is active: paused by hand, escalated or ended serves no wait', () => {
    expect(gateWaitOf({ state: 'active', currentStage: 'ci_gate' }, [row()])).not.toBeNull();
    for (const state of ['paused', 'needs_human', 'done', 'cancelled', 'merged'] as const) {
      expect(gateWaitOf({ state, currentStage: 'ci_gate' }, [row()]), state).toBeNull();
    }
  });

  /**
   * Review of #89 (A): the **parked** wait's last read — `needs_human` at `ci_gate`, the newest
   * attempt closed `failed`/`undecided`, with a read — and `null` for every neighbouring shape.
   */
  it('serves a parked wait’s last read as last_gate_wait, and never beside gate_wait', () => {
    const timedOut = row({
      state: 'failed',
      outcome: 'undecided',
      exitedAt: new Date('2026-11-06T20:28:00.000Z'),
    });
    const parked = { state: 'needs_human', currentStage: 'ci_gate' } as const;
    expect(lastGateWaitOf(parked, [timedOut])).toEqual({
      pipeline_id: '3038234623',
      pipeline_url: 'https://gitlab.example.test/acme/api/-/pipelines/3038234623',
      status: 'manual',
      held_job: 'sentry-release-commit',
      held_job_url: 'https://gitlab.example.test/acme/api/-/jobs/9003',
      draft: true,
      checked_at: '2026-11-06T19:58:00.000Z',
      waiting_since: '2026-11-06T19:28:00.000Z',
      timeout_minutes: 60,
    });
    expect(gateWaitOf(parked, [timedOut])).toBeNull();
    // The open wait is gate_wait's, never this one's.
    expect(lastGateWaitOf({ state: 'active', currentStage: 'ci_gate' }, [row()])).toBeNull();
    expect(lastGateWaitOf(parked, [row()])).toBeNull();
  });

  it('is null for last_gate_wait unless the task is parked at ci_gate by a no-answer ending with a read', () => {
    const closed = (over: Partial<StageRow>) =>
      row({ state: 'failed', exitedAt: new Date('2026-11-06T20:28:00.000Z'), ...over });
    const parked = { state: 'needs_human', currentStage: 'ci_gate' } as const;
    const cases: readonly [string, { state: string; currentStage: string | null }, StageRow[]][] = [
      [
        'not needs_human',
        { state: 'active', currentStage: 'ci_gate' },
        [closed({ outcome: 'undecided' })],
      ],
      [
        'another stage',
        { state: 'needs_human', currentStage: 'code_review' },
        [closed({ outcome: 'undecided' })],
      ],
      ['a repeated failure', parked, [closed({ outcome: 'converged' })]],
      ['an unsupported gate', parked, [closed({ outcome: 'unsupported' })]],
      ['a person’s return', parked, [closed({ state: 'returned', outcome: 'returned' })]],
      ['no read recorded', parked, [closed({ outcome: 'undecided', ciPendingRead: null })]],
      [
        'a newer attempt without one',
        parked,
        [closed({ outcome: 'undecided' }), closed({ attempt: 2, outcome: 'superseded' })],
      ],
      ['no ci_gate row', parked, []],
    ];
    for (const [why, task, rows] of cases) {
      expect(lastGateWaitOf(task, rows), why).toBeNull();
    }
  });

  it('refuses a stored read that does not parse, by name, never as null', () => {
    for (const corrupt of [
      { ...READ, status: 'held' },
      { ...READ, pipeline_url: 'javascript:alert(1)' },
      { ...READ, extra: true },
      'not an object',
    ]) {
      const failure = (() => {
        try {
          return gateWaitOf({ state: 'active', currentStage: 'ci_gate' }, [
            row({ ciPendingRead: corrupt }),
          ]);
        } catch (error) {
          return error;
        }
      })();
      expect(failure, JSON.stringify(corrupt)).toBeInstanceOf(UnprojectableRowError);
      expect((failure as Error).message).toContain('task_stages.ci_pending_read');
    }
  });
});

describe('ci_manual_not_run on the task detail (S-27.2, TD-036 decision 5)', () => {
  type Row = Parameters<typeof ciManualNotRunOf>[0][number];
  const TASK = '00000000-0000-4000-8000-000000006655';
  const NOT_RUN = {
    pipeline_id: '3038234623',
    pipeline_url: 'https://gitlab.example.test/acme/api/-/pipelines/3038234623',
    pipeline_status: 'manual',
    jobs: [{ name: 'sentry-release-commit', stage: 'release', url: null }],
    checked_at: '2026-11-07T09:00:00.000Z',
  };
  const row = (over: Partial<Row> = {}): Row =>
    ({
      taskId: TASK,
      stage: 'ci_gate',
      attempt: 1,
      state: 'completed',
      ciManualNotRun: NOT_RUN,
      ...over,
    }) as unknown as Row;

  it('serves the newest passed ci_gate attempt’s value, and null when it recorded none', () => {
    expect(ciManualNotRunOf([row()])).toEqual(NOT_RUN);
    expect(ciManualNotRunOf([row(), row({ attempt: 2, ciManualNotRun: null })])).toBeNull();
    // An open or failed later attempt is not a pass: the passed one is still the answer.
    expect(
      ciManualNotRunOf([row(), row({ attempt: 2, state: 'running', ciManualNotRun: null })]),
    ).toEqual(NOT_RUN);
    expect(ciManualNotRunOf([row({ state: 'returned' })])).toBeNull();
    expect(ciManualNotRunOf([row({ stage: 'rebase_gate' })])).toBeNull();
    expect(ciManualNotRunOf([])).toBeNull();
  });

  it('refuses a stored value that does not parse, by name, never as null', () => {
    expect(() => ciManualNotRunOf([row({ ciManualNotRun: { ...NOT_RUN, extra: true } })])).toThrow(
      UnprojectableRowError,
    );
    expect(() => ciManualNotRunOf([row({ ciManualNotRun: { ...NOT_RUN, jobs: [] } })])).toThrow(
      /ci_manual_not_run/,
    );
  });
});

describe('ci_manual_started on the task detail (S-28.7)', () => {
  type Row = Parameters<typeof ciManualStartedOf>[0][number];
  const TASK = '00000000-0000-4000-8000-000000002807';
  const STARTED = [
    {
      job_id: '9071',
      pipeline_id: '907',
      name: 'build_composer',
      url: null,
      at: '2026-11-10T09:00:00.000Z',
      outcome: 'started',
    },
  ];
  const row = (over: Partial<Row> = {}): Row =>
    ({
      taskId: TASK,
      stage: 'ci_gate',
      attempt: 1,
      ciManualStarted: STARTED,
      ...over,
    }) as unknown as Row;

  it('serves the newest ci_gate attempt’s value whatever its state, and null when it recorded none', () => {
    expect(ciManualStartedOf([row()])).toEqual(STARTED);
    expect(ciManualStartedOf([row(), row({ attempt: 2, ciManualStarted: null })])).toBeNull();
    expect(ciManualStartedOf([row({ stage: 'rebase_gate' })])).toBeNull();
    expect(ciManualStartedOf([])).toBeNull();
  });

  it('refuses a stored value that does not parse, by name, never as null', () => {
    expect(() =>
      ciManualStartedOf([row({ ciManualStarted: [{ ...STARTED[0], job_id: 'build' }] })]),
    ).toThrow(/ci_manual_started/);
  });
});
