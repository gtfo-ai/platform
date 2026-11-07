/**
 * **Why a stopped task waits, in a row's words** (S-25.15 part B, `./escalation-short.ts`), and the
 * Inbox's one count (`ui/task-status.ts`' `inboxRows`).
 *
 * - Every reason's kind, both directions: a ticket someone else holds, named and nameless (and a
 *   tracker this build does not name); a key the stage timeline words as *Needs you: …*; a sentence;
 *   a key nobody words; no reason at all.
 * - **The key census** (checklist 6: parameterised over the set the code branches on): the short
 *   words exist for exactly the outcome words `stageOutcomeWordSentence` says as *Needs you: …*,
 *   except `ticket_assigned_elsewhere`, which names whose ticket it is — so a key nobody words
 *   there is not given words here, and a key worded there is not left generic here.
 * - The person-facing words never say *claim*, *offer* or *seat*.
 * - `inboxRows`: a stopped task with a question or an approval row is that row, once, and the
 *   total is what the Inbox lists.
 */
import { type InboxResponse, taskStageOutcomeWordSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { inboxRows } from '../ui/task-status.js';
import {
  ESCALATION_SHORT_WORDS,
  type EscalationSubject,
  escalationShort,
  NEEDS_A_PERSON,
} from './escalation-short.js';
import { stageOutcomeWordSentence } from './stage-outcome.js';

const subject = (over: Partial<EscalationSubject> = {}): EscalationSubject => ({
  reason: 'ticket_assigned_elsewhere',
  ticket: { provider: 'jira-cloud' },
  current_stage: 'refinement',
  tracker_assignee: { display_name: 'Vojtěch Kaizr', user_id: null },
  unlinked_assignee: { display_name: 'Vojtěch Kaizr' },
  ...over,
});

describe('escalationShort', () => {
  it('names whose ticket it is, as untrusted text, with the tracker’s own word', () => {
    expect(escalationShort(subject(), { stage: true })).toEqual({
      kind: 'held_elsewhere',
      parts: ['Waiting for: ', { untrusted: 'Vojtěch Kaizr' }, '’s Jira ticket'],
    });
    // The name from `unlinked_assignee` when the read has no `tracker_assignee` (ticketHolder).
    expect(
      escalationShort(subject({ tracker_assignee: null, ticket: { provider: 'gitlab' } }), {
        stage: false,
      }).parts,
    ).toEqual(['Waiting for: ', { untrusted: 'Vojtěch Kaizr' }, '’s GitLab ticket']);
  });

  it('says someone else holds it when the platform knows no name, and never a blank name', () => {
    expect(
      escalationShort(
        subject({
          tracker_assignee: { display_name: '  ', user_id: null },
          unlinked_assignee: { display_name: null },
        }),
        { stage: true },
      ),
    ).toEqual({ kind: 'held_nameless', parts: ['Waiting for: a Jira ticket someone else holds'] });
  });

  it('leaves out a tracker this build does not name, rather than say “the tracker’s ticket”', () => {
    expect(
      escalationShort(subject({ ticket: { provider: 'redmine' } }), { stage: true }).parts,
    ).toEqual(['Waiting for: ', { untrusted: 'Vojtěch Kaizr' }, '’s ticket']);
    expect(
      escalationShort(
        subject({
          ticket: { provider: 'constructor' },
          tracker_assignee: null,
          unlinked_assignee: { display_name: null },
        }),
        { stage: true },
      ).parts,
    ).toEqual(['Waiting for: a ticket someone else holds']);
  });

  it('says a key’s short words, whatever the stage option', () => {
    for (const stage of [true, false]) {
      expect(escalationShort(subject({ reason: 'converged' }), { stage })).toEqual({
        kind: 'worded',
        parts: ['The same failure repeated'],
      });
    }
  });

  it('says Needs a person for a sentence, a key nobody words and no reason — with the stage when asked', () => {
    for (const reason of ['stage "refinement" rejected the task', 'escalated', 'failed', null]) {
      expect(escalationShort(subject({ reason }), { stage: true })).toEqual({
        kind: 'generic',
        parts: [`${NEEDS_A_PERSON} · Refinement`],
      });
      expect(escalationShort(subject({ reason }), { stage: false })).toEqual({
        kind: 'generic',
        parts: [NEEDS_A_PERSON],
      });
    }
    // No stage to name: the words alone.
    expect(
      escalationShort(subject({ reason: 'x y', current_stage: null }), { stage: true }).parts,
    ).toEqual([NEEDS_A_PERSON]);
    // A prototype key is not a key the table words.
    expect(escalationShort(subject({ reason: 'toString' }), { stage: false }).kind).toBe('generic');
  });
});

describe('the short words are the stage timeline’s Needs you keys, no more and no fewer', () => {
  const wordedThere = taskStageOutcomeWordSchema.options.filter(
    (word) =>
      word !== 'ticket_assigned_elsewhere' &&
      stageOutcomeWordSentence(word).startsWith('Needs you:'),
  );

  it('reads a non-empty set off the timeline (the calibration)', () => {
    expect(wordedThere.length).toBeGreaterThanOrEqual(10);
    expect(wordedThere).toContain('converged');
  });

  it('has a short form for every one of them, and for nothing else', () => {
    expect(Object.keys(ESCALATION_SHORT_WORDS).sort()).toEqual([...wordedThere].sort());
  });

  it.each(wordedThere)('words %s without claim, offer or seat, as a row-length phrase', (word) => {
    const short = ESCALATION_SHORT_WORDS[word] ?? '';
    expect(short).not.toMatch(/\b(claim|offer|seat)/i);
    expect(short.length).toBeLessThan(stageOutcomeWordSentence(word).length);
    expect(short.endsWith('.')).toBe(false);
  });

  it('never says claim, offer or seat for a held ticket either', () => {
    for (const parts of [
      escalationShort(subject(), { stage: true }).parts,
      escalationShort(subject({ unlinked_assignee: null, tracker_assignee: null }), {
        stage: true,
      }).parts,
    ]) {
      const text = parts.map((part) => (typeof part === 'string' ? part : part.untrusted)).join('');
      expect(text).not.toMatch(/\b(claim|offer|seat)/i);
    }
  });
});

describe('inboxRows: what the Inbox lists and its badge counts', () => {
  const TASK_A = '00000000-0000-4000-8000-0000000000a1';
  const TASK_B = '00000000-0000-4000-8000-0000000000a2';
  const TASK_C = '00000000-0000-4000-8000-0000000000a3';
  const escalated = (taskId: string): InboxResponse['escalated'][number] => ({
    task_id: taskId,
    project_id: '00000000-0000-4000-8000-0000000000e1',
    ticket: { provider: 'jira', key: 'ACME-1', url: 'https://tickets.example.invalid/ACME-1' },
    ticket_title: null,
    current_stage: 'refinement',
    reason: 'converged',
    at: '2026-11-07T09:00:00.000Z',
    tracker_assignee: null,
    unlinked_assignee: null,
  });
  const question = { task_id: TASK_A } as InboxResponse['questions'][number];
  const approval = { task_id: TASK_B } as InboxResponse['approvals'][number];

  it('counts every stopped task with nothing else open', () => {
    const rows = inboxRows({
      questions: [],
      approvals: [],
      ci_held: [],
      escalated: [escalated(TASK_A), escalated(TASK_C)],
    });
    expect(rows.escalated.map((row) => row.task_id)).toEqual([TASK_A, TASK_C]);
    expect(rows.total).toBe(2);
  });

  it('lists a stopped task with a question or an approval once, as that row', () => {
    const rows = inboxRows({
      questions: [question],
      approvals: [approval],
      ci_held: [],
      escalated: [escalated(TASK_A), escalated(TASK_B), escalated(TASK_C)],
    });
    expect(rows.escalated.map((row) => row.task_id)).toEqual([TASK_C]);
    expect(rows.total).toBe(3);
  });

  it('counts the held CI jobs beside them, as before', () => {
    const held = { task_id: TASK_C } as InboxResponse['ci_held'][number];
    expect(
      inboxRows({ questions: [question], approvals: [], ci_held: [held], escalated: [] }).total,
    ).toBe(2);
  });
});
