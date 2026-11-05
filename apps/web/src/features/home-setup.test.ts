/**
 * The setup checklist's done-ness, as a table (research/19 § 5.2 "Home").
 *
 * Facts in, steps out: which step is ticked, which is current, where *Continue setup* goes, and when
 * the checklist is gone. The facts are what `dashboard.tsx` reads from the server; nothing here is
 * stored by the client, so the table is the whole of the decision.
 */
import { describe, expect, it } from 'vitest';
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
