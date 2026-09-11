/**
 * The workpad and the status mapping (BD-023, technical/12 `status_mapping`).
 *
 * The rendering is a pure function, so it is asserted directly; the handlers are asserted through
 * the harness, against the fake task-management provider they write to.
 */

import { type DomainEvent, domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createPipelineHarness, type HarnessOptions } from '../testing/pipeline-harness.js';
import { mappedStatus, renderWorkpad, workpadMarker } from './workpad.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000001',
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: { provider: 'fake-jira', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

const harnessFor = (options: Partial<HarnessOptions> = {}) =>
  createPipelineHarness({
    projectId: PROJECT,
    runs: {
      refinement: {
        status: 'completed',
        terminalReason: 'success',
        structuredOutput: { decision: 'ask', questions: [{ id: 'q1', text: 'Which currency?' }] },
      },
    },
    ...options,
  });

describe('renderWorkpad', () => {
  const view = {
    ticketKey: 'ACME-1',
    state: 'active' as const,
    currentStage: 'implementation',
    stages: [
      { id: 'refinement', entered: true },
      { id: 'implementation', entered: true },
      { id: 'code_review', entered: false },
    ],
    costUsd: 1.5,
    budgetUsd: 50,
    mrUrl: 'https://git.example.test/acme/api/-/merge_requests/7',
    blocker: null,
  };

  it('shows the state, the checklist, the spend and the merge request', () => {
    const markdown = renderWorkpad(view);
    expect(markdown).toContain('**ACME-1** — active (implementation)');
    expect(markdown).toContain('- ✓ refinement');
    expect(markdown).toContain('- ▶ implementation');
    expect(markdown).toContain('- · code_review');
    expect(markdown).toContain('Cost so far: 1.50 of 50.00 USD');
    expect(markdown).toContain('merge_requests/7');
    expect(markdown).not.toContain('Needs a human');
  });

  it('is byte-identical for the same task, so an edit-in-place does not churn', () => {
    expect(renderWorkpad(view)).toBe(renderWorkpad({ ...view }));
  });

  it('adds the blocker brief when the task is parked', () => {
    const markdown = renderWorkpad({
      ...view,
      state: 'needs_human',
      blocker: 'Answer the question',
    });
    expect(markdown).toContain('**Needs a human**');
    expect(markdown).toContain('Answer the question');
  });
});

describe('mappedStatus', () => {
  const mapping = {
    refinement: 'In Refinement',
    waiting_answers: 'Waiting for input',
    done: 'Done',
  };

  it('prefers the stage over the state, because it is the more specific statement', () => {
    expect(mappedStatus(mapping, 'waiting_answers', 'refinement')).toBe('In Refinement');
    expect(mappedStatus(mapping, 'waiting_answers', null)).toBe('Waiting for input');
    expect(mappedStatus(mapping, 'done', 'done')).toBe('Done');
  });

  it('answers null rather than guessing when nothing is mapped', () => {
    expect(mappedStatus(mapping, 'active', 'code_review')).toBeNull();
    expect(mappedStatus(undefined, 'active', 'refinement')).toBeNull();
  });
});

describe('the handlers', () => {
  it('keeps one workpad per task, edited in place', async () => {
    const upserts: { markerId: string; markdown: string }[] = [];
    const harness = harnessFor({
      taskManagement: {
        upsertWorkpad: (async (_ref: unknown, markerId: string, markdown: string) => {
          upserts.push({ markerId, markdown });
          return {
            provider: 'fake-jira',
            ticket_key: 'ACME-1',
            comment_id: 'comment-1',
            url: null,
          };
        }) as never,
      },
    });
    await harness.publish([ticketMatched()]);

    // Several events moved the task; every one of them wrote the same comment.
    expect(upserts.length).toBeGreaterThan(1);
    const taskId = harness.store.snapshot()[0]?.task.id as string;
    expect(new Set(upserts.map((entry) => entry.markerId))).toEqual(
      new Set([workpadMarker(taskId)]),
    );
    expect(upserts.at(-1)?.markdown).toContain('ACME-1');
    // The comment reference is remembered on the task.
    expect(harness.store.snapshot()[0]?.workpad?.comment_id).toBe('comment-1');
  });

  it('transitions the ticket only for a state the project mapped', async () => {
    const transitions: string[] = [];
    const harness = harnessFor({
      settings: {
        config: { status_mapping: { refinement: 'In Refinement' } },
      },
      taskManagement: {
        transition: (async (_ref: unknown, to: string) => {
          transitions.push(to);
          return { changed: true, from: 'To Do', to };
        }) as never,
      },
    });
    await harness.publish([ticketMatched()]);
    // `intake` and `waiting_answers` are not mapped; `refinement` is.
    expect(transitions).toEqual(['In Refinement']);
  });

  it('leaves the ticket alone when the project has no mapping at all', async () => {
    const transitions: string[] = [];
    const harness = harnessFor({
      taskManagement: {
        transition: (async (_ref: unknown, to: string) => {
          transitions.push(to);
          return { changed: true, from: 'To Do', to };
        }) as never,
      },
    });
    await harness.publish([ticketMatched()]);
    expect(transitions).toEqual([]);
  });

  it('writes both through the action executor, so every call is audited', async () => {
    const harness = harnessFor({
      settings: { config: { status_mapping: { refinement: 'In Refinement' } } },
    });
    await harness.publish([ticketMatched()]);
    const actions = harness.audit.entries.map((entry) => entry.action);
    expect(actions).toContain('upsert_workpad');
    expect(actions).toContain('transition_ticket');
  });
});
