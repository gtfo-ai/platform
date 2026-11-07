/**
 * The setup checklist's done-ness, as a table (research/19 § 5.2 "Home").
 *
 * Facts in, steps out: which step is ticked, which is current, where *Continue setup* goes, and when
 * the checklist is gone. The facts are what `dashboard.tsx` reads from the server; nothing here is
 * stored by the client, so the table is the whole of the decision.
 *
 * Since S-25.6 (research/21 F10) a second table sits on top of it: once the setup project has run a
 * ticket, Home shows only the pieces still missing — `missingPieces` and `homeSetup`.
 */
import { describe, expect, it } from 'vitest';
import { leadingClaimBlocker, UPDATER_FIX } from '../ui/humanize.js';
import {
  homeSetup,
  missingPieces,
  type SetupFacts,
  setupChecklist,
  setupProjectOf,
} from './home-setup.js';

const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  connect: 'todo',
  project: 'todo',
  discovery: 'todo',
  autonomy: 'todo',
  ticket: 'todo',
  ...over,
});

const ALL_DONE = facts({
  connect: 'done',
  project: 'done',
  discovery: 'done',
  autonomy: 'done',
  ticket: 'done',
});

describe('setupChecklist', () => {
  it.each([
    {
      name: 'a brand-new instance',
      input: facts(),
      key: null,
      ticked: [],
      next: 'connect',
      to: { to: '/integrations' },
    },
    {
      name: 'connected, no project yet',
      input: facts({ connect: 'done' }),
      key: null,
      ticked: ['connect'],
      next: 'project',
      to: { to: '/onboarding' },
    },
    {
      name: 'a project, discovery not run',
      input: facts({ connect: 'done', project: 'done' }),
      key: 'acme',
      ticked: ['connect', 'project'],
      next: 'discovery',
      to: { to: '/onboarding', project: 'acme' },
    },
    {
      name: 'discovered, the dial never applied',
      input: facts({ connect: 'done', project: 'done', discovery: 'done' }),
      key: 'acme',
      ticked: ['connect', 'project', 'discovery'],
      next: 'autonomy',
      to: { to: '/onboarding', project: 'acme' },
    },
    {
      name: 'everything but a ticket',
      input: facts({ connect: 'done', project: 'done', discovery: 'done', autonomy: 'done' }),
      key: 'acme',
      ticked: ['connect', 'project', 'discovery', 'autonomy'],
      next: 'ticket',
      to: { to: '/projects/$key', key: 'acme', hash: 'start-ticket' },
    },
    {
      name: 'a project made without a git host: the first undone step leads, not the last',
      input: facts({ project: 'done', discovery: 'done', autonomy: 'done', ticket: 'done' }),
      key: 'acme',
      ticked: ['project', 'discovery', 'autonomy', 'ticket'],
      next: 'connect',
      to: { to: '/integrations' },
    },
    {
      name: 'a read that failed is not a tick',
      input: facts({ connect: 'done', project: 'done', discovery: 'unknown', autonomy: 'done' }),
      key: 'acme',
      ticked: ['connect', 'project', 'autonomy'],
      next: 'discovery',
      to: { to: '/onboarding', project: 'acme' },
    },
  ])('$name', ({ input, key, ticked, next, to }) => {
    const checklist = setupChecklist(input, key);
    expect(checklist.steps.filter((step) => step.fact === 'done').map((step) => step.id)).toEqual(
      ticked,
    );
    expect(checklist.next?.id).toBe(next);
    expect(checklist.next?.destination).toEqual(to);
    expect(checklist.complete).toBe(false);
    expect(checklist.settling).toBe(false);
  });

  it('is complete, with nowhere to continue, when every step is done', () => {
    const checklist = setupChecklist(ALL_DONE, 'acme');
    expect(checklist.complete).toBe(true);
    expect(checklist.next).toBeNull();
  });

  it('settles only once every fact is answered', () => {
    expect(setupChecklist(facts({ connect: 'pending' }), null).settling).toBe(true);
    expect(setupChecklist({ ...ALL_DONE, ticket: 'pending' }, 'acme').settling).toBe(true);
    expect(setupChecklist({ ...ALL_DONE, ticket: 'unknown' }, 'acme').settling).toBe(false);
  });

  it('does not take the steps after a project from anything while there is no project', () => {
    // A stale "done" for discovery cannot stand without a project to have been read from, and a
    // pending read for one cannot hold the checklist back.
    const checklist = setupChecklist(
      facts({ connect: 'done', discovery: 'done', autonomy: 'pending', ticket: 'done' }),
      null,
    );
    expect(checklist.steps.map((step) => step.fact)).toEqual([
      'done',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
    expect(checklist.settling).toBe(false);
  });

  it('names the five steps in the order a person does them', () => {
    expect(setupChecklist(facts(), null).steps.map((step) => step.label)).toEqual([
      'Connect your tracker and git host',
      'Create a project',
      'Run technical discovery',
      'Choose how autonomous agents are',
      'Start your first ticket',
    ]);
  });
});

describe('setupChecklist’s worker step (S-23.20)', () => {
  const upToWorker = facts({
    connect: 'done',
    project: 'done',
    discovery: 'done',
    autonomy: 'done',
  });

  it('is absent on a platform whose server runs agent work — not optional, absent', () => {
    expect(setupChecklist(ALL_DONE, 'acme').steps.map((step) => step.id)).not.toContain('worker');
    expect(setupChecklist(ALL_DONE, 'acme').complete).toBe(true);
  });

  it('sits between the autonomy and the first ticket, and leads there when it is not done', () => {
    const checklist = setupChecklist({ ...upToWorker, worker: 'todo' }, 'acme');
    expect(checklist.steps.map((step) => step.id)).toEqual([
      'connect',
      'project',
      'discovery',
      'autonomy',
      'worker',
      'ticket',
    ]);
    expect(checklist.next?.id).toBe('worker');
    expect(checklist.next?.label).toBe('Connect a worker');
    expect(checklist.next?.hint).toBe(
      'Nothing on the platform server runs this project’s agents: a developer’s own computer has to.',
    );
    expect(checklist.next?.destination).toEqual({ to: '/workers/new' });
  });

  it('names a worker that exists but cannot take work, with the fix, and resumes the wizard at Ready for it', () => {
    const checklist = setupChecklist({ ...upToWorker, worker: 'todo' }, 'acme', {
      name: 'jan-mbp',
      reason: 'Not connected to the platform',
      fix: 'Start the worker on that computer.',
      createdAt: '2026-11-05T09:00:00.000Z',
    });
    expect(checklist.next?.hint).toBe(
      'jan-mbp can’t take work yet: not connected to the platform. Start the worker on that computer.',
    );
    // A name stays as it is in the middle of the sentence.
    const claude = setupChecklist({ ...upToWorker, worker: 'todo' }, 'acme', {
      name: 'jan-mbp',
      reason: 'Claude refused its sign-in',
      fix: 'Sign in to Claude again on the worker’s page.',
      createdAt: '2026-11-05T09:00:00.000Z',
    });
    expect(claude.next?.hint).toBe(
      'jan-mbp can’t take work yet: Claude refused its sign-in. Sign in to Claude again on the worker’s page.',
    );
    expect(checklist.next?.destination).toEqual({
      to: '/workers/new',
      step: 'ready',
      since: '2026-11-05T09:00:00.000Z',
    });
  });

  it('says a worker that is updating itself is updating, not that it can’t take work (S-23.27)', () => {
    const blocker = leadingClaimBlocker(['draining', 'images_outdated']);
    expect(blocker?.updating).toBe(true);
    const checklist = setupChecklist({ ...upToWorker, worker: 'todo' }, 'acme', {
      name: 'jan-mbp',
      reason: blocker?.word ?? '',
      fix: blocker?.fix ?? '',
      updating: true,
      createdAt: '2026-11-05T09:00:00.000Z',
    });
    expect(checklist.next?.hint).toBe(`jan-mbp is updating now. ${UPDATER_FIX}`);
    expect(checklist.next?.hint).not.toMatch(/can’t take work|compose|download/);
    expect(checklist.next?.destination).toEqual({
      to: '/workers/new',
      step: 'ready',
      since: '2026-11-05T09:00:00.000Z',
    });
  });

  it('holds the checklist while it is being read, and is ticked like any other step', () => {
    expect(setupChecklist({ ...ALL_DONE, worker: 'pending' }, 'acme').settling).toBe(true);
    const done = setupChecklist({ ...ALL_DONE, worker: 'done' }, 'acme');
    expect(done.complete).toBe(true);
    expect(done.steps).toHaveLength(6);
  });
});

describe('setupProjectOf', () => {
  it('follows the oldest project, and none when there is none', () => {
    expect(setupProjectOf([])).toBeNull();
    const projects = [
      { id: 'b', created_at: '2026-10-02T00:00:00.000Z' },
      { id: 'a', created_at: '2026-10-01T00:00:00.000+00:00' },
      { id: 'c', created_at: '2026-10-03T00:00:00.000Z' },
    ];
    expect(setupProjectOf(projects)?.id).toBe('a');
  });
});

describe('homeSetup: once a ticket has run, only a missing piece is named (S-25.6, F10)', () => {
  const ALL_PIECES = { tracker: 'done', git: 'done' } as const;

  it('shows the checklist until the setup project has run a ticket', () => {
    const checklist = setupChecklist(facts({ connect: 'done', project: 'done' }), 'acme');
    expect(homeSetup(checklist, []).kind).toBe('checklist');
    // …and nothing while a fact is still being read, rather than a box that flickers.
    const settling = setupChecklist(facts({ connect: 'pending', project: 'done' }), 'acme');
    expect(homeSetup(settling, []).kind).toBe('none');
  });

  it('hides the checklist on a working install whose discovery and dial were never ticked', () => {
    // The F10 install: "4 of 5 done" for good. A ticket ran, so the steps no longer matter.
    const checklist = setupChecklist(
      facts({ connect: 'done', project: 'done', ticket: 'done' }),
      'acme',
    );
    expect(checklist.complete).toBe(false);
    expect(homeSetup(checklist, missingPieces(ALL_PIECES))).toEqual({ kind: 'none' });
  });

  it('names what is missing, and what that costs, once a ticket has run', () => {
    const checklist = setupChecklist(
      facts({ connect: 'todo', project: 'done', ticket: 'done' }),
      'acme',
    );
    const missing = missingPieces({ tracker: 'done', git: 'todo' });
    expect(homeSetup(checklist, missing)).toEqual({
      kind: 'missing',
      pieces: [
        {
          id: 'git',
          text: 'Merge requests can’t be opened until a git host is connected.',
          action: 'Connect a git host',
          destination: { to: '/integrations' },
        },
      ],
    });
  });

  it.each([
    [{ tracker: 'todo', git: 'done' }, ['tracker']],
    [{ tracker: 'todo', git: 'todo' }, ['tracker', 'git']],
    [{ tracker: 'done', git: 'done', worker: 'todo' }, ['worker']],
    // Only an answered "no" is missing: a read that failed or has not answered names nothing.
    [{ tracker: 'unknown', git: 'pending', worker: 'unknown' }, []],
    // A platform that runs agent work on its server has no worker piece at all.
    [{ tracker: 'done', git: 'done' }, []],
  ] as const)('missingPieces(%j) names %j', (pieces, ids) => {
    expect(missingPieces(pieces).map((piece) => piece.id)).toEqual(ids);
  });

  it('names a worker that cannot take work, and resumes its wizard at Ready', () => {
    const blocker = leadingClaimBlocker(['offline']);
    const [piece] = missingPieces({ tracker: 'done', git: 'done', worker: 'todo' }, [
      {
        name: 'jan-mbp',
        reason: blocker?.word ?? '',
        fix: blocker?.fix ?? '',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ]);
    expect(piece?.text).toContain('jan-mbp can’t take work');
    expect(piece?.text).toContain(blocker?.fix ?? '∅');
    expect(piece?.destination).toEqual({
      to: '/workers/new',
      step: 'ready',
      since: '2026-10-01T00:00:00.000Z',
    });
  });

  /**
   * S-25.15 (the walk of Autix on 2026-11-07): three machines could not take work and the box named
   * only the newest. One machine is still named, with its fix; several are counted by reason.
   */
  const machine = (
    name: string,
    blockers: Parameters<typeof leadingClaimBlocker>[0],
    createdAt: string,
  ) => {
    const lead = leadingClaimBlocker(blockers);
    return {
      name,
      reason: lead?.word ?? '',
      fix: lead?.fix ?? '',
      updating: lead?.updating ?? false,
      ...(lead === undefined ? {} : { blocker: lead.blocker }),
      createdAt,
    };
  };
  const WORKER_TODO = { tracker: 'done', git: 'done', worker: 'todo' } as const;

  it('names the one machine that is the reason, with its fix and its setup', () => {
    const [piece] = missingPieces(WORKER_TODO, [
      machine('Tom-MacbookPro', ['offline'], '2026-11-01T00:00:00.000Z'),
    ]);
    expect(piece?.text).toBe(
      `No agent can run this project’s tickets yet: Tom-MacbookPro can’t take work (not connected to the platform). ${leadingClaimBlocker(['offline'])?.fix ?? '∅'}`,
    );
    expect(piece?.action).toBe('Open the worker’s setup');
    expect(piece?.destination).toEqual({
      to: '/workers/new',
      step: 'ready',
      since: '2026-11-01T00:00:00.000Z',
    });
  });

  it('counts several machines by reason, the largest group first, and opens Workers', () => {
    const [piece] = missingPieces(WORKER_TODO, [
      machine('Tom-MacbookPro', ['protocol_outdated'], '2026-11-03T00:00:00.000Z'),
      machine('Tom-Studio', ['offline'], '2026-11-02T00:00:00.000Z'),
      machine('jan-mbp', ['offline', 'protocol_outdated'], '2026-11-01T00:00:00.000Z'),
    ]);
    expect(piece).toEqual({
      id: 'worker',
      text: 'No machine can take this project’s tickets right now: 3 can’t take work (2 not connected, 1 needs an update).',
      action: 'Open Workers',
      destination: { to: '/workers' },
    });
    // No machine is named once there are several: the Workers screen lists them.
    expect(piece?.text).not.toContain('Tom-MacbookPro');
  });

  it('agrees the verb with the count, and groups two blockers that read the same', () => {
    const [piece] = missingPieces(WORKER_TODO, [
      machine('a', ['protocol_outdated'], '2026-11-03T00:00:00.000Z'),
      machine('b', ['images_outdated'], '2026-11-02T00:00:00.000Z'),
      machine('c', ['draining', 'protocol_outdated'], '2026-11-01T00:00:00.000Z'),
    ]);
    expect(piece?.text).toBe(
      'No machine can take this project’s tickets right now: 3 can’t take work (2 need an update, 1 updating now).',
    );
  });

  it('says several machines without a blocker id in their row words, never a raw id', () => {
    const [piece] = missingPieces(WORKER_TODO, [
      { name: 'a', reason: 'Not set up yet', fix: '', createdAt: '2026-11-02T00:00:00.000Z' },
      { name: 'b', reason: 'Not set up yet', fix: '', createdAt: '2026-11-01T00:00:00.000Z' },
    ]);
    expect(piece?.text).toBe(
      'No machine can take this project’s tickets right now: 2 can’t take work (2 not set up yet).',
    );
  });
});
