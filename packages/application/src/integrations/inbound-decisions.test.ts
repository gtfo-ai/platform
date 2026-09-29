/**
 * A provider's human decision goes through the aggregate (WP-43).
 *
 * The approval and the question are the **real** domain aggregates; only the repositories and the
 * role lookup are doubles. What each case asserts is the row the aggregate left behind *and* the
 * event it produced, because a decision that moved the task and left `approvals.status = pending`
 * behind is exactly the defect this module exists to close.
 */
import {
  type Actor,
  type Id,
  type IsoDateTime,
  MAX_COMMAND_TEXT_CHARS,
  type UserRole,
} from '@platform/contracts';
import {
  type Approval,
  type CommandContext,
  createApproval,
  openQuestion,
  type Question,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { StoredApproval } from '../pipeline/store.js';
import type { Transaction } from '../ports/transaction.js';
import {
  createInboundDecisionApplier,
  type InboundDecisionDraft,
  type InboundHumanActionEntry,
} from './inbound-decisions.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1' as Id;
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000a2' as Id;
const TASK = '00000000-0000-4000-8000-0000000000b1' as Id;
const OTHER_TASK = '00000000-0000-4000-8000-0000000000b2' as Id;
const APPROVAL = '00000000-0000-4000-8000-0000000000c1' as Id;
const QUESTION = '00000000-0000-4000-8000-0000000000c2' as Id;
const USER = '00000000-0000-4000-8000-0000000000d1' as Id;
const NOW = '2026-09-26T10:00:00.000Z' as IsoDateTime;
const TX = { adapter: 'memory' } as Transaction;

let nextId = 0;
const context = (): CommandContext => ({
  ids: {
    next: () => {
      nextId += 1;
      return `00000000-0000-4000-9000-${String(nextId).padStart(12, '0')}` as Id;
    },
  },
  actor: { kind: 'system', component: 'pipeline' },
  clock: { now: () => NOW },
});

const person: Actor = {
  kind: 'user',
  user_id: USER,
  identity: {
    provider: 'slack',
    external_id: 'U1',
    email: null,
    display_name: null,
    verified: true,
  },
};

/** Which door the delivery came through (WP-88) — what the audit row names. */
const DELIVERY = {
  provider: 'slack',
  integrationId: '00000000-0000-4000-8000-0000000000e9' as Id,
  deliveryId: 'slack:interaction:U1:1780000002.000300',
};

const harness = (options: { readonly role?: UserRole | null; readonly taskProject?: Id } = {}) => {
  const actions: { tx: Transaction; entry: InboundHumanActionEntry }[] = [];
  const approvals = new Map<Id, StoredApproval>();
  const questions = new Map<Id, Question>();
  const approval: Approval = createApproval(
    { id: APPROVAL, taskId: TASK, projectId: PROJECT, kind: 'plan', deadlineFrom: () => null },
    context(),
  );
  approvals.set(APPROVAL, { approval, stage: 'architecture' as never, attempt: 1 });
  questions.set(
    QUESTION,
    openQuestion(
      {
        id: QUESTION,
        taskId: TASK,
        projectId: PROJECT,
        stage: 'refinement' as never,
        text: 'Which currency?',
        blocking: true,
        deadlineFrom: () => null,
      },
      context(),
    ),
  );
  const applier = createInboundDecisionApplier({
    store: {
      approvals: {
        load: async (_tx: Transaction, id: Id) => approvals.get(id) ?? null,
        save: async (_tx: Transaction, stored: StoredApproval) => {
          approvals.set(stored.approval.id, stored);
        },
      },
      questions: {
        load: async (_tx: Transaction, id: Id) => questions.get(id) ?? null,
        save: async (_tx: Transaction, question: Question) => {
          questions.set(question.id, question);
        },
      },
      tasks: {
        load: async (_tx: Transaction, id: Id) =>
          id === TASK ? { task: { id: TASK, projectId: options.taskProject ?? PROJECT } } : null,
      },
    } as never,
    roles: {
      roleIn: async () => (options.role === undefined ? 'maintainer' : options.role),
    },
    actions: {
      record: async (tx, entry) => {
        actions.push({ tx, entry });
      },
    },
    context: () => context(),
  });
  return { applier, approvals, questions, actions };
};

const approvalDraft = (overrides: Record<string, unknown> = {}): InboundDecisionDraft => ({
  type: 'task.approval.decided',
  payload: {
    project_id: PROJECT,
    task_id: TASK,
    approval_id: APPROVAL,
    decision: 'approved',
    decided_by_user_id: USER,
    reason: null,
    ...overrides,
  },
  actor: person,
});

const answerDraft = (overrides: Record<string, unknown> = {}): InboundDecisionDraft => ({
  type: 'task.question.answered',
  payload: {
    project_id: PROJECT,
    task_id: TASK,
    question_id: QUESTION,
    answer: 'EUR',
    answered_by_user_id: USER,
    channel: 'slack',
    ...overrides,
  },
  actor: person,
});

describe('an approval decided from a provider', () => {
  it('decides the aggregate: the row moves, and the event is the aggregate’s on its own stream', async () => {
    const { applier, approvals } = harness();

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: approvalDraft(),
    });

    expect(outcome.kind).toBe('applied');
    expect(approvals.get(APPROVAL)?.approval).toMatchObject({
      status: 'approved',
      decidedByUserId: USER,
    });
    const events = outcome.kind === 'applied' ? outcome.events : [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'task.approval.decided',
      stream_type: 'approval',
      stream_id: APPROVAL,
      // The person who pressed the button, never the pipeline.
      actor: { kind: 'user', user_id: USER },
      payload: { decision: 'approved', decided_by_user_id: USER, task_id: TASK },
    });
  });

  it('is refused by name for a role that cannot approve a plan, and leaves the row pending (BD-006)', async () => {
    const { applier, approvals } = harness({ role: 'viewer' });

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: approvalDraft(),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_permitted' });
    expect(approvals.get(APPROVAL)?.approval.status).toBe('pending');
  });

  it('is refused as already decided when somebody got there first (first answer wins)', async () => {
    const { applier } = harness();
    await applier.apply(TX, { projectId: PROJECT, delivery: DELIVERY, draft: approvalDraft() });

    const second = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: approvalDraft({ decision: 'rejected' }),
    });

    expect(second).toMatchObject({ kind: 'refused', reason: 'already_decided' });
  });

  it('is refused when the payload names a task the approval does not belong to', async () => {
    const { applier, approvals } = harness();

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: approvalDraft({ task_id: OTHER_TASK }),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'subject_mismatch' });
    expect(approvals.get(APPROVAL)?.approval.status).toBe('pending');
  });

  it('is refused when it arrives through another project’s binding', async () => {
    const { applier } = harness();

    const outcome = await applier.apply(TX, {
      projectId: OTHER_PROJECT,
      delivery: DELIVERY,
      draft: approvalDraft(),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'subject_mismatch' });
  });

  it('is refused when the task row itself says another project', async () => {
    const { applier } = harness({ taskProject: OTHER_PROJECT });

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: approvalDraft(),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'subject_mismatch' });
  });

  it('is refused for an approval that does not exist', async () => {
    const { applier } = harness();

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: approvalDraft({ approval_id: '00000000-0000-4000-8000-0000000000ff' }),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'unknown_subject' });
  });

  it('is refused for a decider who is no longer an active user', async () => {
    const { applier } = harness({ role: null });

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: approvalDraft(),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'unknown_decider' });
  });

  it('is refused when the actor is not a mapped person', async () => {
    const { applier } = harness();

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: {
        ...approvalDraft(),
        actor: { kind: 'integration', integration_id: TASK, provider: 'slack' } as Actor,
      },
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'unknown_decider' });
  });

  it('is refused for a decision that is neither approve nor reject', async () => {
    const { applier } = harness();

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: approvalDraft({ decision: 'expired' }),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'malformed_decision' });
  });
});

describe('a question answered from a provider', () => {
  it('answers the aggregate and records the channel it came through', async () => {
    const { applier, questions } = harness();

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: answerDraft(),
    });

    expect(outcome.kind).toBe('applied');
    expect(questions.get(QUESTION)).toMatchObject({
      status: 'answered',
      answer: 'EUR',
      answeredVia: 'slack',
      answeredByUserId: USER,
    });
  });

  it('is refused for a channel the catalogue does not know', async () => {
    const { applier, questions } = harness();

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: answerDraft({ channel: 'carrier-pigeon' }),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'malformed_decision' });
    expect(questions.get(QUESTION)?.status).toBe('open');
  });

  it('is refused for a viewer, who may not answer', async () => {
    const { applier } = harness({ role: 'viewer' });

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: answerDraft(),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_permitted' });
  });

  it('is refused when the question belongs to another task', async () => {
    const { applier } = harness();

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: answerDraft({ task_id: OTHER_TASK }),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'subject_mismatch' });
  });

  it('is refused for a question that does not exist', async () => {
    const { applier } = harness();

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: answerDraft({ question_id: '00000000-0000-4000-8000-0000000000fe' }),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'unknown_subject' });
  });
});

describe('the audit row an accepted decision leaves (WP-88, PROGRESS backlog 199)', () => {
  it('writes one `human_actions` row for an approval, in the delivery’s transaction, in the route’s vocabulary', async () => {
    const { applier, actions } = harness();

    await applier.apply(TX, { projectId: PROJECT, delivery: DELIVERY, draft: approvalDraft() });

    expect(actions).toEqual([
      {
        tx: TX,
        entry: {
          userId: USER,
          taskId: TASK,
          // `POST /api/tasks/:task_id/approvals/:approval_id/decide` records exactly this action,
          // and its `params` carry `task_id`, `approval_id` and `decision` spelled `approve`.
          action: 'task.approval.decide',
          params: {
            task_id: TASK,
            approval_id: APPROVAL,
            decision: 'approve',
            channel: 'slack',
            provider: 'slack',
            integration_id: DELIVERY.integrationId,
            delivery_id: DELIVERY.deliveryId,
          },
        },
      },
    ]);
  });

  it('spells a rejection as the route does', async () => {
    const { applier, actions } = harness();
    await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: approvalDraft({ decision: 'rejected' }),
    });
    expect(actions[0]?.entry.params.decision).toBe('reject');
  });

  it('writes one row for an answer, and none of the answer’s words', async () => {
    const { applier, actions } = harness();

    await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: answerDraft({ answer: 'EUR — and my token is in here' }),
    });

    expect(actions.map((action) => action.entry)).toEqual([
      {
        userId: USER,
        taskId: TASK,
        action: 'task.question.answer',
        params: {
          task_id: TASK,
          question_id: QUESTION,
          channel: 'slack',
          provider: 'slack',
          integration_id: DELIVERY.integrationId,
          delivery_id: DELIVERY.deliveryId,
        },
      },
    ]);
    expect(JSON.stringify(actions)).not.toContain('token');
  });

  it('writes none for a refused decision — the route’s rule', async () => {
    const refusedFor = [
      harness({ role: 'viewer' }),
      harness({ role: null }),
      harness({ taskProject: OTHER_PROJECT }),
    ];
    for (const { applier, actions } of refusedFor) {
      const outcome = await applier.apply(TX, {
        projectId: PROJECT,
        delivery: DELIVERY,
        draft: approvalDraft(),
      });
      expect(outcome.kind).toBe('refused');
      expect(actions).toEqual([]);
    }
    const { applier, actions } = harness();
    await applier.apply(TX, { projectId: PROJECT, delivery: DELIVERY, draft: approvalDraft() });
    await applier.apply(TX, { projectId: PROJECT, delivery: DELIVERY, draft: approvalDraft() });
    expect(actions, 'the second, already-decided press writes nothing').toHaveLength(1);
  });

  it('refuses an answer longer than the task page accepts, rather than cutting it', async () => {
    const { applier, actions, questions } = harness();

    const outcome = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: answerDraft({ answer: 'x'.repeat(MAX_COMMAND_TEXT_CHARS + 1) }),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'malformed_decision' });
    expect(questions.get(QUESTION)?.status).toBe('open');
    expect(actions).toEqual([]);
    const atTheCap = await applier.apply(TX, {
      projectId: PROJECT,
      delivery: DELIVERY,
      draft: answerDraft({ answer: 'x'.repeat(MAX_COMMAND_TEXT_CHARS) }),
    });
    expect(atTheCap.kind, 'control: exactly the cap is an answer').toBe('applied');
  });
});
