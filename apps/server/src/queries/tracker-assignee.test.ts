/**
 * The task DTO's `tracker_assignee` (S-26.8b's follow-up, the review of PR #103): who the tracker
 * shows, off the stored `tasks.ticket_assignee` and the user it resolves to live
 * (`trackerAssigneeUserSql`). Four cases, each both ways where it has two: a **linked** person who
 * may own the project's tasks (their `user_id`), an **unlinked** one (`user_id` null, still named),
 * the **platform**'s own account or a machine (`null` — never named, even when a user id is
 * somehow resolved), and **no** assignee (`null`). The SQL half is held against a real PostgreSQL
 * in `test/integration/pipeline/task-owner.integration.test.ts`.
 */
import type { TicketAssignee } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { trackerAssigneeOf } from './pipeline-queries.js';

const VOJTECH = '00000000-0000-4000-8000-000000000009';

const assignee = (overrides: Partial<TicketAssignee> = {}): TicketAssignee => ({
  provider: 'jira-cloud',
  external_id: 'acct-vojtech',
  display_name: 'Vojtěch',
  platform: false,
  ...overrides,
});

describe('tracker_assignee', () => {
  it('names a linked person who may own the project’s tasks, with their user id', () => {
    expect(trackerAssigneeOf(assignee(), VOJTECH)).toEqual({
      display_name: 'Vojtěch',
      user_id: VOJTECH,
    });
  });

  it('names an unlinked person (or one who may not own here) with no user id', () => {
    expect(trackerAssigneeOf(assignee({ display_name: 'Jan Novák' }), null)).toEqual({
      display_name: 'Jan Novák',
      user_id: null,
    });
    // A provider that sent no name: still somebody, said so by the reader.
    expect(trackerAssigneeOf(assignee({ display_name: null }), null)).toEqual({
      display_name: null,
      user_id: null,
    });
  });

  it('never names the platform: its own account or a machine is null, whatever resolved', () => {
    expect(trackerAssigneeOf(assignee({ platform: true }), null)).toBeNull();
    expect(trackerAssigneeOf(assignee({ platform: true }), VOJTECH)).toBeNull();
  });

  it('is null when the tracker shows nobody, or was never read', () => {
    expect(trackerAssigneeOf(null, null)).toBeNull();
    expect(trackerAssigneeOf(null, VOJTECH)).toBeNull();
  });
});
