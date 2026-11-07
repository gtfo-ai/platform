/**
 * `fleetOf` (S-23.6): which seat holds which run, what is free, what waits, what needs a person, and
 * what each run is doing — the one model the map, the office and the list read.
 */
import { describe, expect, it } from 'vitest';
import { STUCK_AFTER_MS } from '../../ui/activity.js';
import {
  agentItem,
  approval,
  EMPTY_INBOX,
  facts,
  NOW,
  question,
  runRecord,
  uuid,
  worker,
  workerSeat,
} from './fleet.test-fixture.js';
import {
  ATTENTION_ORDER,
  botPhaseOf,
  type FleetInput,
  fleetOf,
  runSentence,
  SERVER_SEAT_ID,
  seatTitle,
  seatWords,
  slotsWords,
} from './model.js';

/** A string that would be an element if anything here rendered markup (BD-022). */
const HOSTILE = '<img src=x onerror=alert(1)>';

const base = (overrides: Partial<FleetInput> = {}): FleetInput => ({
  agents: [],
  workers: [],
  inbox: EMPTY_INBOX,
  now: NOW,
  ...overrides,
});

describe('the seats', () => {
  it('are the server first, then every active worker by name, revoked ones only while they hold a run', () => {
    const fleet = fleetOf(
      base({
        agents: [agentItem(1, { seat: workerSeat(30, 'zed') })],
        workers: [
          worker(31, { name: 'beta' }),
          worker(30, { name: 'zed', state: 'revoked', revoked_at: '2026-11-05T16:00:00.000Z' }),
          worker(32, { name: 'alpha' }),
          worker(33, { name: 'gone', state: 'revoked', revoked_at: '2026-11-05T16:00:00.000Z' }),
        ],
      }),
    );
    expect(fleet.seats.map((seat) => [seat.id, seat.state])).toEqual([
      [SERVER_SEAT_ID, 'active'],
      [`worker:${uuid(32)}`, 'active'],
      [`worker:${uuid(31)}`, 'active'],
      [`worker:${uuid(30)}`, 'revoked'],
    ]);
  });

  it('place each run by its seat’s worker id, and a run with no seat in the queue', () => {
    const fleet = fleetOf(
      base({
        agents: [
          agentItem(1),
          agentItem(2, { seat: workerSeat(30) }),
          agentItem(3, { seat: null, run: { status: 'created', started_at: null } }),
        ],
        workers: [worker(30)],
      }),
    );
    const byId = new Map(fleet.seats.map((seat) => [seat.id, seat.runs.map((run) => run.id)]));
    expect(byId.get(SERVER_SEAT_ID)).toEqual([uuid(1)]);
    expect(byId.get(`worker:${uuid(30)}`)).toEqual([uuid(2)]);
    expect(fleet.queue.map((run) => run.id)).toEqual([uuid(3)]);
    expect(fleet.queue[0]?.seatId).toBeNull();
  });

  it('count busy as the placed runs and the worker’s own list together, and free as what is left', () => {
    const fleet = fleetOf(
      base({
        agents: [agentItem(2, { seat: workerSeat(30) })],
        workers: [
          worker(30, {
            concurrency: 3,
            // One the agents read shows, and one it does not (yet): both hold a slot.
            running: [
              { run_id: uuid(2), task_id: uuid(1002), project_id: uuid(5) },
              { run_id: uuid(9), task_id: uuid(1009), project_id: uuid(5) },
            ],
          }),
        ],
      }),
    );
    const seat = fleet.seats[1];
    expect(seat?.busy).toBe(2);
    expect(seat?.free).toBe(1);
    expect(slotsWords(seat ?? { busy: 0, concurrency: null })).toBe('2 of 3 slots busy');
    expect(fleet.counts.freeSeats).toBe(1);
  });

  it('never invent the server’s capacity, and say so in words', () => {
    const fleet = fleetOf(base({ agents: [agentItem(1), agentItem(2)] }));
    const server = fleet.seats[0];
    expect(server?.concurrency).toBeNull();
    expect(server?.free).toBeNull();
    expect(server === undefined ? '' : slotsWords(server)).toBe('2 running');
    expect(fleet.counts.freeSeats).toBe(0);
  });

  it('do not count a paused worker’s slots as free, and read its pause off the clock', () => {
    const paused = worker(30, { paused_until: new Date(NOW + 60_000).toISOString() });
    const lapsed = worker(31, { paused_until: new Date(NOW - 60_000).toISOString() });
    const fleet = fleetOf(base({ workers: [paused, lapsed] }));
    expect(fleet.seats.map((seat) => seat.state)).toEqual(['active', 'paused', 'active']);
    expect(fleet.counts.freeSeats).toBe(3);
  });

  it('build a seat from the run when the caller cannot see its worker — name only, no capacity', () => {
    const fleet = fleetOf(
      base({ agents: [agentItem(1, { seat: workerSeat(40, HOSTILE) })], workers: [] }),
    );
    const seat = fleet.seats.find((candidate) => candidate.id === `worker:${uuid(40)}`);
    expect(seat).toMatchObject({ name: HOSTILE, owner: null, concurrency: null, free: null });
    expect(seat?.runs.map((run) => run.id)).toEqual([uuid(1)]);
  });

  it('name themselves in words, a worker’s name sanitised', () => {
    expect(seatWords(null)).toBe('no seat yet');
    expect(seatWords({ kind: 'server', name: null })).toBe('the platform server');
    expect(seatWords({ kind: 'worker', name: 'jan‮mbp' })).toBe('worker jan�mbp');
    expect(seatTitle({ kind: 'worker', name: null })).toBe('Unnamed worker');
  });
});

describe('each run’s activity', () => {
  const one = (input: Partial<FleetInput>) => fleetOf(base(input)).runs[0];

  it('says why a run nobody takes yet waits, "your machine" to its owner (S-26.8b part 2)', () => {
    const owner = uuid(4001);
    const waiting = agentItem(1, {
      seat: null,
      activity: null,
      run: { status: 'created', started_at: null },
      waiting: {
        reason: 'owner_worker_cannot_take',
        user: { user_id: owner, name: `Vojtěch${HOSTILE}` },
        last_seen_at: null,
        assignee_name: null,
        blockers: ['images_outdated'],
      },
    });
    const seen = one({ agents: [waiting] });
    expect(seen?.activity).toEqual({
      activity: 'waiting',
      detail: `Vojtěch${HOSTILE}’s machine needs an update`,
    });
    expect(one({ agents: [waiting], viewerId: owner })?.activity.detail).toBe(
      'your machine needs an update',
    );
    // Somebody can take it now: the activity's own words, nothing invented.
    const free = agentItem(2, {
      seat: null,
      activity: null,
      run: { status: 'created', started_at: null },
      waiting: { reason: null, user: null, last_seen_at: null, assignee_name: null, blockers: [] },
    });
    expect(one({ agents: [free] })?.activity).toEqual({ activity: 'waiting', detail: 'Starting' });
  });

  it('reads the agents read’s newest entry: a tool is working, with its words', () => {
    const run = one({ agents: [agentItem(1)] });
    expect(run?.activity).toEqual({ activity: 'working', detail: 'Reading files' });
    expect(run?.meta.pose).toBe('typing');
  });

  it('prefers the live transcript’s entry when it is newer, and the read’s when the transcript is older', () => {
    const latest = new Map([
      [uuid(1), { kind: 'thinking' as const, tool_name: null, at: '2026-11-05T16:44:30.000Z' }],
    ]);
    expect(one({ agents: [agentItem(1)], latest })?.activity.activity).toBe('thinking');
    const older = new Map([
      [uuid(1), { kind: 'thinking' as const, tool_name: null, at: '2026-11-05T16:43:00.000Z' }],
    ]);
    expect(one({ agents: [agentItem(1)], latest: older })?.activity.activity).toBe('working');
  });

  it('is "needs you" for the task’s open question, approval or state — and only for its stage run', () => {
    const taskId = uuid(1001);
    const asked = {
      questions: [question(70, taskId, 'Three or five?')],
      approvals: [],
      ci_held: [],
    };
    expect(one({ agents: [agentItem(1)], inbox: asked })?.activity.activity).toBe('needs_you');
    const approving = { questions: [], approvals: [approval(71, taskId)], ci_held: [] };
    expect(one({ agents: [agentItem(1)], inbox: approving })?.activity.activity).toBe('needs_you');
    const waiting = new Map([[taskId, facts('DEMO-1', { state: 'waiting_answers' })]]);
    expect(one({ agents: [agentItem(1)], tasks: waiting })?.activity.activity).toBe('needs_you');
    // BACKLOG 814: a question put to the task runs beside its pipeline, not as its current stage.
    const ask = agentItem(1, { role: 'ask', run: { stage: null, role: 'ask' } });
    expect(one({ agents: [ask], inbox: asked })?.activity.activity).toBe('working');
  });

  it('is "waiting" while starting, "stuck" when silent too long, "paused" never for a live run', () => {
    expect(one({ agents: [agentItem(1, { run: { status: 'starting' } })] })?.activity).toEqual({
      activity: 'waiting',
      detail: 'Starting',
    });
    const silent = agentItem(1, {
      activity: {
        kind: 'text',
        tool_name: null,
        at: new Date(NOW - STUCK_AFTER_MS - 60_000).toISOString(),
      },
    });
    expect(one({ agents: [silent] })?.activity.activity).toBe('stuck');
    const onPaused = agentItem(1, { seat: workerSeat(30) });
    const pausedWorker = worker(30, { paused_until: new Date(NOW + 60_000).toISOString() });
    expect(one({ agents: [onPaused], workers: [pausedWorker] })?.activity.activity).toBe('working');
  });

  it('carries the task’s key, title, project key and the whole phase strip once read', () => {
    const run = one({
      agents: [agentItem(1)],
      tasks: new Map([
        [
          uuid(1001),
          facts('DEMO-1', {
            title: HOSTILE,
            templateStages: [{ id: 'refinement' }, { id: 'implementation' }, { id: 'code_review' }],
          }),
        ],
      ]),
      projectKeys: new Map([[runRecord(1).project_id, 'demo']]),
    });
    expect(run).toMatchObject({ ticketKey: 'DEMO-1', title: HOSTILE, projectKey: 'demo' });
    expect(run?.phases.map((phase) => [phase.id, phase.state])).toEqual([
      ['refinement', 'skipped'],
      ['implementation', 'current'],
      ['code_review', 'upcoming'],
    ]);
    expect(one({ agents: [agentItem(1)] })?.phases).toEqual([]);
  });

  it('says the whole state in one sentence: key, title, stage, activity, seat', () => {
    const sentence = (title: string | null) => {
      const fleet = fleetOf(
        base({
          agents: [
            agentItem(1, { seat: workerSeat(30, 'jan-mbp'), run: { stage: 'code_review' } }),
          ],
          workers: [worker(30, { name: 'jan-mbp' })],
          tasks: new Map([[uuid(1001), facts('DEMO-1', { title })]]),
        }),
      );
      const run = fleet.runs[0];
      return run === undefined ? '' : runSentence(run, fleet.seats[1] ?? null);
    };
    expect(sentence('Checkout\u202Eflow')).toBe(
      'DEMO-1 · Checkout\uFFFDflow · Code review · working: Reading files · worker jan-mbp',
    );
    // A ticket the platform never read has no title, and the sentence does not invent one.
    expect(sentence(null)).toBe('DEMO-1 · Code review · working: Reading files · worker jan-mbp');
  });
});

describe('the runs that ended while the page watched', () => {
  it('stay at their desk as done or failed, outside every count, whatever the worker does since', () => {
    const entry = agentItem(1, { seat: workerSeat(30) });
    const pausedWorker = worker(30, { paused_until: new Date(NOW + 60_000).toISOString() });
    const fleet = fleetOf(
      base({
        workers: [pausedWorker],
        endings: [
          {
            entry,
            run: runRecord(1, { status: 'completed', ended_at: '2026-11-05T16:44:50.000Z' }),
          },
          {
            entry: agentItem(2, { seat: workerSeat(30) }),
            run: runRecord(2, { status: 'failed', terminal_reason: 'crash' }),
          },
        ],
      }),
    );
    const seat = fleet.seats[1];
    expect(seat?.endings.map((run) => [run.activity.activity, run.meta.pose])).toEqual([
      ['done', 'cheer'],
      ['failed', 'slumped'],
    ]);
    expect(seat?.runs).toEqual([]);
    expect(fleet.counts.live).toBe(0);
    expect(fleet.runs).toEqual([]);
  });

  it('read as how they ended, never as the task’s question or escalation (BACKLOG 814)', () => {
    const taskId = uuid(1001);
    const fleet = fleetOf(
      base({
        inbox: { questions: [question(70, taskId, 'Three or five?')], approvals: [], ci_held: [] },
        tasks: new Map([[taskId, facts('DEMO-1', { state: 'needs_human' })]]),
        endings: [
          {
            entry: agentItem(1),
            run: runRecord(1, { status: 'failed', terminal_reason: 'crash' }),
          },
        ],
      }),
    );
    const ended = fleet.seats[0]?.endings[0];
    expect([ended?.activity.activity, ended?.meta.pose]).toEqual(['failed', 'slumped']);
  });

  it('are dropped when the run is live again or the read still says it is live', () => {
    const fleet = fleetOf(
      base({
        agents: [agentItem(1)],
        endings: [
          { entry: agentItem(1), run: runRecord(1, { status: 'completed' }) },
          { entry: agentItem(2), run: runRecord(2, { status: 'running' }) },
        ],
      }),
    );
    expect(fleet.seats[0]?.endings).toEqual([]);
  });
});

describe('what needs a person', () => {
  it('lists open questions (first line, untrusted), pending approvals and permission asks, oldest first', () => {
    const fleet = fleetOf(
      base({
        agents: [
          agentItem(1, {
            activity: {
              kind: 'waiting_permission',
              tool_name: 'Bash',
              at: '2026-11-05T16:44:00.000Z',
            },
          }),
        ],
        inbox: {
          questions: [question(70, uuid(2001), `First line ${HOSTILE}\nsecond line`)],
          approvals: [approval(71, uuid(2002))],
          ci_held: [],
        },
        tasks: new Map([[uuid(2001), facts('DEMO-7', { projectId: runRecord(1).project_id })]]),
        projectKeys: new Map([[runRecord(1).project_id, 'demo']]),
      }),
    );
    expect(fleet.needs.map((need) => [need.kind, need.text, need.untrusted])).toEqual([
      ['approval', 'Plan approval is waiting for you', false],
      ['question', `First line ${HOSTILE}`, true],
      ['permission', 'Asking to use Bash', false],
    ]);
    expect(fleet.needs[1]).toMatchObject({ ticketKey: 'DEMO-7', projectKey: 'demo' });
    expect(fleet.counts.needsYou).toBe(3);
  });

  it('skips answered questions and decided approvals', () => {
    const answered = { ...question(70, uuid(1), 'q'), status: 'answered' as const };
    const decided = { ...approval(71, uuid(1)), status: 'approved' as const };
    expect(
      fleetOf(base({ inbox: { questions: [answered], approvals: [decided], ci_held: [] } })).needs,
    ).toEqual([]);
  });
});

describe('the counts and the order', () => {
  it('count working, stuck, waiting and live, and order what needs a person first', () => {
    const stale = new Date(NOW - STUCK_AFTER_MS - 60_000).toISOString();
    const fleet = fleetOf(
      base({
        agents: [
          agentItem(1),
          agentItem(2, {
            activity: { kind: 'thinking', tool_name: null, at: '2026-11-05T16:44:00.000Z' },
          }),
          agentItem(3, { activity: { kind: 'text', tool_name: null, at: stale } }),
          agentItem(4, { seat: null, run: { status: 'created', started_at: null } }),
          agentItem(5, {
            activity: {
              kind: 'waiting_permission',
              tool_name: 'Edit',
              at: '2026-11-05T16:44:00.000Z',
            },
          }),
          // Ended runs are not live: the read only lists live ones, and these are filtered anyway.
          agentItem(6, { run: { status: 'completed' } }),
        ],
      }),
    );
    expect(fleet.counts).toEqual({
      working: 2,
      stuck: 1,
      needsYou: 1,
      waiting: 1,
      freeSeats: 0,
      live: 5,
    });
    expect(fleet.runs.map((run) => run.activity.activity)).toEqual([
      'needs_you',
      'stuck',
      'working',
      'thinking',
      'waiting',
    ]);
    expect(ATTENTION_ORDER.needs_you).toBeLessThan(ATTENTION_ORDER.working);
  });
});

describe('botPhaseOf', () => {
  it('is fixed per id and spreads ids over all four phases', () => {
    expect(botPhaseOf(uuid(1))).toBe(botPhaseOf(uuid(1)));
    const phases = new Set(Array.from({ length: 40 }, (_, index) => botPhaseOf(uuid(index))));
    expect([...phases].sort()).toEqual([0, 1, 2, 3]);
  });
});
