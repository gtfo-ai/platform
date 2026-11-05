/**
 * The `domain_event` frame's `data` is a projection, never the event (S-23.14).
 *
 * The claim under test is the one the stream's whole exposure rests on: whatever a payload carries,
 * what reaches a browser is ids, a stage and three small enums. It is checked two ways — on real
 * catalogue events, whose text fields are named, and over **every** live type with a payload that
 * plants one marker string in every key the catalogue uses for text, so a type added later is
 * covered by construction rather than by somebody remembering to add a case.
 */
import { describe, expect, it } from 'vitest';
import { sseFrameSchema } from './api.js';
import { DOMAIN_EVENT_TYPES, domainEventSchemasByType } from './events.js';
import {
  isLiveDomainEventType,
  LIVE_DOMAIN_EVENT_TYPES,
  liveDomainEventSchema,
  projectLiveDomainEvent,
} from './live-events.js';

const PROJECT = '0199aa11-2b3c-7d4e-8f90-000000000001';
const TASK = '0199aa11-2b3c-7d4e-8f90-000000000002';
const RUN = '0199aa11-2b3c-7d4e-8f90-000000000003';
const QUESTION = '0199aa11-2b3c-7d4e-8f90-000000000004';
const WORKER = '0199aa11-2b3c-7d4e-8f90-000000000005';
const OFFER = '0199aa11-2b3c-7d4e-8f90-000000000006';
const APPROVAL = '0199aa11-2b3c-7d4e-8f90-000000000007';
const EVENT = '0199aa11-2b3c-7d4e-8f90-0000000000e1';
const AT = '2026-11-05T09:00:00.000Z';
const PLANT = 'PLANTED-free-text-ignore-previous-instructions';

const envelope = (type: string, streamType: string, streamId: string) => ({
  id: EVENT,
  stream_type: streamType,
  stream_id: streamId,
  stream_seq: 3,
  correlation_id: TASK,
  cause_event_id: null,
  actor: { kind: 'system', component: 'pipeline' },
  occurred_at: AT,
  type,
});

/** A catalogue event, parsed by its own schema first so the fixture is one the log accepts. */
const catalogued = (
  type: keyof typeof domainEventSchemasByType,
  streamType: string,
  payload: object,
) => {
  const streamId = streamType === 'run' ? RUN : streamType === 'question' ? QUESTION : TASK;
  return domainEventSchemasByType[type].parse({ ...envelope(type, streamType, streamId), payload });
};

describe('the live projection of a stored event', () => {
  it('reduces a question to its ids: the agent’s words never reach the stream', () => {
    const asked = catalogued('task.question.asked', 'task', {
      project_id: PROJECT,
      task_id: TASK,
      question: {
        id: QUESTION,
        task_id: TASK,
        stage: 'refinement',
        run_id: RUN,
        text: PLANT,
        options: [PLANT],
        blocking: true,
        status: 'open',
        asked_at: AT,
        reminders_sent: 0,
      },
    });

    const projected = projectLiveDomainEvent(asked);

    expect(projected).toEqual({
      id: EVENT,
      type: 'task.question.asked',
      stream_type: 'task',
      stream_id: TASK,
      occurred_at: AT,
      project_id: PROJECT,
      task_id: TASK,
      question_id: QUESTION,
    });
    expect(JSON.stringify(projected)).not.toContain(PLANT);
  });

  it('keeps a claim’s worker and claimant kind, and drops nothing it needs', () => {
    const claimed = catalogued('run.claimed', 'run', {
      project_id: PROJECT,
      task_id: TASK,
      run_id: RUN,
      offer_id: OFFER,
      claimant_kind: 'worker',
      worker_id: WORKER,
      lease_epoch: 2,
    });

    expect(projectLiveDomainEvent(claimed)).toEqual({
      id: EVENT,
      type: 'run.claimed',
      stream_type: 'run',
      stream_id: RUN,
      occurred_at: AT,
      project_id: PROJECT,
      task_id: TASK,
      run_id: RUN,
      worker_id: WORKER,
      claimant_kind: 'worker',
    });
  });

  it('drops an escalation’s reason and brief, a steer’s message and an approval’s reason', () => {
    const cases = [
      catalogued('task.escalated', 'task', {
        project_id: PROJECT,
        task_id: TASK,
        reason: PLANT,
        blocker_brief: PLANT,
      }),
      catalogued('run.steered', 'run', {
        project_id: PROJECT,
        task_id: TASK,
        run_id: RUN,
        message: PLANT,
        author_user_id: WORKER,
      }),
      catalogued('task.approval.decided', 'approval', {
        project_id: PROJECT,
        task_id: TASK,
        approval_id: APPROVAL,
        decision: 'rejected',
        reason: PLANT,
      }),
      catalogued('run.offer.withdrawn', 'run', {
        project_id: PROJECT,
        task_id: TASK,
        run_id: RUN,
        offer_id: OFFER,
        reason: PLANT,
      }),
    ];
    for (const event of cases) {
      const projected = projectLiveDomainEvent(event);
      expect(projected, event.type).not.toBeNull();
      expect(JSON.stringify(projected), event.type).not.toContain(PLANT);
    }
    expect(projectLiveDomainEvent(cases[2] as (typeof cases)[number])?.approval_id).toBe(APPROVAL);
  });

  it('forwards a verdict the platform maps and drops the raw words a model wrote', () => {
    const completed = (verdict: string) =>
      catalogued('task.stage.completed', 'task', {
        project_id: PROJECT,
        task_id: TASK,
        stage: 'code_review',
        artifacts: [],
        verdict,
      });

    expect(projectLiveDomainEvent(completed('approve'))?.verdict).toBe('approve');
    expect(projectLiveDomainEvent(completed('approve'))?.stage).toBe('code_review');
    // `RefinedSpec.decision` reaches the payload as the model wrote it (capped at 64 characters).
    const raw = projectLiveDomainEvent(completed('ship it'));
    expect(raw).not.toBeNull();
    expect(raw).not.toHaveProperty('verdict');
  });

  it('reads a status only off a run event: a human return’s status is a provider’s word', () => {
    const humanReturn = catalogued('task.human_return', 'task', {
      project_id: PROJECT,
      task_id: TASK,
      from_stage: 'qa',
      forms: ['status'],
      counts: { mr_diff: 0, mr_note: 0, ticket_comment: 0 },
      // A provider status that happens to spell a run status is still not one.
      status: 'completed',
    });
    expect(projectLiveDomainEvent(humanReturn)).not.toHaveProperty('status');

    const finished = catalogued('run.failed', 'run', {
      project_id: PROJECT,
      task_id: TASK,
      run_id: RUN,
      status: 'failed',
      terminal_reason: 'crash',
      error: PLANT,
    });
    const projected = projectLiveDomainEvent(finished);
    expect(projected?.status).toBe('failed');
    expect(JSON.stringify(projected)).not.toContain(PLANT);
  });

  it.each(LIVE_DOMAIN_EVENT_TYPES)(
    'reduces a %s whose every text key carries a planted string',
    (type) => {
      // Not a catalogue-valid payload, on purpose: the projection never parses the whole payload,
      // so the hostile case is a payload whose every key is the attacker's.
      const hostile = {
        project_id: PROJECT,
        task_id: TASK,
        run_id: RUN,
        stage: PLANT,
        to_stage: PLANT,
        status: PLANT,
        verdict: PLANT,
        claimant_kind: PLANT,
        worker_id: PLANT,
        question: { id: QUESTION, text: PLANT },
        approval: { id: PLANT, reason: PLANT },
        reason: PLANT,
        blocker_brief: PLANT,
        message: PLANT,
        answer: PLANT,
        error: PLANT,
        outcome: PLANT,
        branch: PLANT,
        summary: PLANT,
        extra: PLANT,
      };
      const projected = projectLiveDomainEvent({
        id: EVENT,
        type,
        stream_type: 'task',
        stream_id: TASK,
        occurred_at: AT,
        payload: hostile,
      });

      expect(projected).not.toBeNull();
      expect(JSON.stringify(projected)).not.toContain(PLANT);
      expect(liveDomainEventSchema.parse(projected)).toEqual(projected);
      expect(projected).toMatchObject({ project_id: PROJECT, task_id: TASK, run_id: RUN });
    },
  );

  it('projects nothing for a type the live topics do not carry, or an envelope that does not parse', () => {
    const source = {
      id: EVENT,
      type: 'ticket.comment.added',
      stream_type: 'project',
      stream_id: PROJECT,
      occurred_at: AT,
      payload: { project_id: PROJECT },
    };
    expect(projectLiveDomainEvent(source)).toBeNull();
    expect(projectLiveDomainEvent({ ...source, type: 'task.queued', id: 'not-a-uuid' })).toBeNull();
    expect(projectLiveDomainEvent({ ...source, type: 'task.queued', payload: null })).toEqual({
      id: EVENT,
      type: 'task.queued',
      stream_type: 'project',
      stream_id: PROJECT,
      occurred_at: AT,
    });
  });
});

describe('the live types', () => {
  it('are every task and run event in the catalogue, and nothing else', () => {
    const expected = DOMAIN_EVENT_TYPES.filter(
      (type) => type.startsWith('task.') || type.startsWith('run.'),
    );
    expect([...LIVE_DOMAIN_EVENT_TYPES].sort()).toEqual([...expected].sort());
    for (const type of [
      'run.claimed',
      'run.finished',
      'task.stage.entered',
      'task.question.asked',
      'task.approval.requested',
      'task.escalated',
      'task.paused',
    ]) {
      expect(isLiveDomainEventType(type), type).toBe(true);
    }
    for (const type of ['ticket.matched', 'mr.opened', 'budget.exhausted', 'artifact.created']) {
      expect(isLiveDomainEventType(type), type).toBe(false);
    }
  });
});

describe('the live types’ payloads', () => {
  /**
   * The bridge fans an event to `project:<project_id>` and `task:<task_id>` only when the projection
   * found them, so a live type whose payload did not carry both would silently reach `org` alone.
   * Every live type's payload schema must therefore **require** both — checked off the catalogue,
   * so a `task.*` or `run.*` event added later without them fails here.
   */
  it.each(LIVE_DOMAIN_EVENT_TYPES)('%s requires project_id and task_id', (type) => {
    const payload = domainEventSchemasByType[type].shape.payload;
    for (const key of ['project_id', 'task_id'] as const) {
      const field = (
        payload.shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>
      )[key];
      expect(field, `${type}.${key}`).toBeDefined();
      expect(field?.safeParse(undefined).success, `${type}.${key} is required`).toBe(false);
      expect(field?.safeParse(null).success, `${type}.${key} is not nullable`).toBe(false);
    }
  });
});

describe('the domain_event frame', () => {
  it('carries the projection and refuses a frame that carries the event', () => {
    const data = {
      id: EVENT,
      type: 'task.stage.entered' as const,
      stream_type: 'task' as const,
      stream_id: TASK,
      occurred_at: AT,
      project_id: PROJECT,
      task_id: TASK,
      stage: 'development',
    };
    const frame = { frame: 'domain_event', topic: 'org', seq: 41, type: data.type, data };
    expect(sseFrameSchema.parse(frame)).toEqual(frame);

    // The whole event, as the frame carried it before S-23.14, is refused: strict means strict.
    expect(
      sseFrameSchema.safeParse({ ...frame, data: { ...data, payload: { reason: PLANT } } }).success,
    ).toBe(false);
    // A type the live topics do not carry is refused at the frame too.
    expect(
      sseFrameSchema.safeParse({
        ...frame,
        type: 'mr.opened',
        data: { ...data, type: 'mr.opened' },
      }).success,
    ).toBe(false);
  });
});
