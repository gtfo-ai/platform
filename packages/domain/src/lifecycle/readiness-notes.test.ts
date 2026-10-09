/**
 * The ticket lifecycle's readiness notes (WP-181 ruling (d), BD-031 ruling 7): one note per empty
 * slot, one for a binding with no block, none for a fully mapped one — and never a status name.
 */
import { LIFECYCLE_SINGLE_SLOTS } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  BINDING_ACCOUNT_IS_A_PERSON_CODE,
  bindingAccountPersonNote,
  LIFECYCLE_NOT_CONFIGURED_CODE,
  LIFECYCLE_NOTE_SLOTS,
  LIFECYCLE_SLOT_UNMAPPED_CODE,
  lifecycleReadinessNotes,
} from './readiness-notes.js';

/** Invented, neutral status names (the product owner's rule). */
const FULL = {
  pickUpFrom: 'Ready for the agent',
  slots: {
    in_progress: 'Doing',
    in_review: 'Waiting for review',
    approved: 'Reviewed',
    qa: 'Testing',
    returned: ['Sent back'],
    done: 'Finished',
  },
};

describe('the ticket lifecycle’s readiness notes', () => {
  it('names every slot the product names, the single slots included', () => {
    for (const slot of LIFECYCLE_SINGLE_SLOTS) {
      expect(LIFECYCLE_NOTE_SLOTS).toContain(slot);
    }
    expect(LIFECYCLE_NOTE_SLOTS).toContain('pick_up_from');
    expect(LIFECYCLE_NOTE_SLOTS).toContain('returned');
    expect(LIFECYCLE_NOTE_SLOTS).toHaveLength(LIFECYCLE_SINGLE_SLOTS.length + 2);
  });

  it('answers nothing for a fully mapped block', () => {
    expect(lifecycleReadinessNotes(FULL)).toEqual([]);
  });

  it('answers one note per empty slot, in the order a ticket passes them', () => {
    const notes = lifecycleReadinessNotes({
      pickUpFrom: null,
      slots: { in_progress: 'Doing', returned: [], done: 'Finished' },
    });
    expect(notes.map((note) => note.slot)).toEqual([
      'pick_up_from',
      'in_review',
      'approved',
      'qa',
      'returned',
    ]);
    for (const note of notes) {
      expect(note.code).toBe(LIFECYCLE_SLOT_UNMAPPED_CODE);
      expect(note.severity).toBe('note');
      expect(note.message).toMatch(/not a failure/);
    }
  });

  it('answers the one not-configured note for a binding with no block', () => {
    const notes = lifecycleReadinessNotes(null);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      code: LIFECYCLE_NOT_CONFIGURED_CODE,
      severity: 'note',
      slot: null,
    });
    expect(notes[0]?.message).toContain('neither claims tickets nor moves them');
  });

  it('names a binding that acts as a person as a note, not a failure (Q118 (a))', () => {
    expect(bindingAccountPersonNote()).toEqual({
      code: BINDING_ACCOUNT_IS_A_PERSON_CODE,
      severity: 'note',
      slot: null,
      message: expect.stringContaining('This is information, not a failure.'),
    });
    expect(bindingAccountPersonNote().message).toContain('dedicated account');
  });

  it('quotes no status name: the messages are platform text about slots', () => {
    const all = [
      ...lifecycleReadinessNotes({ pickUpFrom: null, slots: {} }),
      ...lifecycleReadinessNotes(null),
    ];
    expect(all).toHaveLength(LIFECYCLE_NOTE_SLOTS.length + 1);
    for (const note of all) {
      expect(note.message).not.toMatch(/["“`]/);
      for (const name of ['Doing', 'Testing', 'Finished', 'Sent back']) {
        expect(note.message).not.toContain(name);
      }
    }
  });
});
