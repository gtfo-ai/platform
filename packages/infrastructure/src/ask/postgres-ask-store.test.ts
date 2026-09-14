/**
 * The `task_asks` row mapper (WP-31).
 *
 * The store's *statements* are held to the in-memory fake by the shared `AskStore` contract suite,
 * against a real PostgreSQL in `test/integration/ask/`. What that suite cannot see is the shape the
 * **driver** hands back, because it always goes through the same one: `timestamptz` arrives as a
 * `Date` from `pg` and as a string from a `sql` template, `numeric` arrives as a string, and
 * `citations` is `jsonb`, which is to say anything the column was ever given. Those are three
 * different ways a reader could be wrong about one row, so they are asserted here, where a case can
 * simply hand the function each shape.
 */
import { describe, expect, it } from 'vitest';
import { type AskRow, askRowToStored } from './postgres-ask-store.js';

const row = (overrides: Partial<AskRow> = {}): AskRow => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  task_id: '00000000-0000-4000-8000-0000000000b1',
  project_id: '00000000-0000-4000-8000-0000000000c1',
  source: 'ui',
  asked_by_user_id: '00000000-0000-4000-8000-0000000000d1',
  asked_by_identity: null,
  ticket_comment_id: null,
  question: 'why a column?',
  run_id: null,
  status: 'pending',
  answer: null,
  citations: [],
  dropped_citations: 0,
  answer_artifact_id: null,
  refusal_reason: null,
  redaction_count: 0,
  mirrored_at: null,
  created_at: new Date('2026-06-01T09:00:00.000Z'),
  answered_at: null,
  ...overrides,
});

describe('askRowToStored', () => {
  it('renders every instant as ISO 8601, from a Date or from a string', () => {
    const fromDates = askRowToStored(
      row({
        created_at: new Date('2026-06-01T09:00:00.000Z'),
        answered_at: new Date('2026-06-01T09:01:00.000Z'),
        mirrored_at: new Date('2026-06-01T09:02:00.000Z'),
      }),
    );
    expect(fromDates.createdAt).toBe('2026-06-01T09:00:00.000Z');
    expect(fromDates.answeredAt).toBe('2026-06-01T09:01:00.000Z');
    expect(fromDates.mirroredAt).toBe('2026-06-01T09:02:00.000Z');

    const fromStrings = askRowToStored(
      row({
        created_at: '2026-06-01T09:00:00.000Z' as unknown as Date,
        answered_at: '2026-06-01T09:01:00.000Z' as unknown as Date,
        mirrored_at: '2026-06-01T09:02:00.000Z' as unknown as Date,
      }),
    );
    expect(fromStrings.createdAt).toBe('2026-06-01T09:00:00.000Z');
    expect(fromStrings.answeredAt).toBe('2026-06-01T09:01:00.000Z');
    expect(fromStrings.mirroredAt).toBe('2026-06-01T09:02:00.000Z');
  });

  it('keeps a null instant null, which is a different fact from the epoch', () => {
    const stored = askRowToStored(row());
    expect(stored.answeredAt).toBeNull();
    expect(stored.mirroredAt).toBeNull();
  });

  it('answers an empty citation list for a jsonb value that is not an array', () => {
    // `jsonb` accepts anything the column was ever given, including a document written by a build
    // that shaped it differently. Answering `[]` fails closed at the reader rather than handing the
    // route a value its strict DTO would refuse (standing rule 20's read side).
    for (const value of [null, {}, 'not an array', 7]) {
      expect(askRowToStored(row({ citations: value })).citations).toEqual([]);
    }
  });

  it('passes a real citation list through unchanged', () => {
    const citations = [
      { kind: 'run', run_id: '00000000-0000-4000-8000-0000000000e1', detail: 'the run' },
    ];
    expect(askRowToStored(row({ citations })).citations).toEqual(citations);
  });

  it('carries the identity a ticket ask was asked by, and null for a UI one', () => {
    expect(askRowToStored(row()).askedByIdentity).toBeNull();
    const identity = { provider: 'jira-cloud', external_id: 'acct-ada', display_name: 'Ada' };
    expect(
      askRowToStored(
        row({ source: 'ticket', ticket_comment_id: 'c-1', asked_by_identity: identity }),
      ).askedByIdentity,
    ).toEqual(identity);
  });
});
