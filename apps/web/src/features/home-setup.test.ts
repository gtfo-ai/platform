/**
 * The setup checklist's done-ness, as a table (research/19 § 5.2 "Home").
 *
 * Facts in, steps out: which step is ticked, which is current, where *Continue setup* goes, and when
 * the checklist is gone. The facts are what `dashboard.tsx` reads from the server; nothing here is
 * stored by the client, so the table is the whole of the decision.
 */
import { describe, expect, it } from 'vitest';
import { leadingClaimBlocker, UPDATER_FIX } from '../ui/humanize.js';
import { type SetupFacts, setupChecklist, setupProjectOf } from './home-setup.js';

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
