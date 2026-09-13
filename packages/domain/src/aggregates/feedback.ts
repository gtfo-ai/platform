/**
 * The Feedback aggregate — technical/02 § "Aggregates and entities" → Feedback (WP-15i).
 *
 * A human's opinion about a task, a stage, an artifact or a project. It has no state machine:
 * feedback is *received*, never decided, so the aggregate is one command (`recordFeedback`) and one
 * event (`feedback.received`) on its own stream.
 *
 * ## Two things this aggregate decides rather than carries
 *
 * **The text is untrusted** (BD-022). It is a human's words on their way into the event log, and
 * from there into a prompt when WP-24's feedback intake agent reads it — so it is bounded here,
 * at the aggregate, rather than at whichever transport happened to bring it. {@link MAX_FEEDBACK_TEXT_CHARS}
 * states the number and its derivation. Redaction is **not** done here: it is composed per
 * deployment (TD-012) and the domain holds no redactor, so the caller applies one before the text
 * reaches this function — `packages/application/src/pipeline/commands.ts` is where that happens and
 * it says so at the line.
 *
 * **An unverified author is recorded and never acted on.** `authorUserId` is the platform user who
 * submitted it and `authorIdentity` the external identity a ticket or Slack comment came from
 * (BD-006/Q10). Both may be absent; what must not happen is an *identity* being promoted to a
 * *user*, so this function never derives one from the other.
 */
import type { ExternalIdentity, FeedbackRecord, Id, IsoDateTime, Slug } from '@platform/contracts';
import { InvariantViolationError } from '../errors.js';
import { type CommandContext, type Decision, eventRecorder, FIRST_STREAM_SEQ } from '../events.js';

/** What a piece of feedback is about (`feedbackRecordSchema.scope`). */
export type FeedbackScope = FeedbackRecord['scope'];

/**
 * How much feedback text the platform stores.
 *
 * 8 000 characters, deliberately the same number as the prompt assembler's `MAX_FEEDBACK_CHARS`
 * (`../prompt/assembly.js`) rather than coincidentally: that one bounds the return feedback a prompt
 * may carry, and feedback recorded here is what WP-24's intake agent will put in one. They stay two
 * constants because they bound two different values — a stored record and a prompt block — and one
 * constant would make a change to either silently change the other.
 *
 * The text is **refused** past the cap rather than truncated: a human who typed it can shorten it,
 * and a silently halved sentence is a sentence the intake agent will read as the whole opinion.
 */
export const MAX_FEEDBACK_TEXT_CHARS = 8_000;

export interface Feedback {
  readonly id: Id;
  readonly projectId: Id;
  readonly taskId: Id | null;
  readonly authorUserId: Id | null;
  readonly authorIdentity: ExternalIdentity | null;
  readonly scope: FeedbackScope;
  readonly stage: Slug | null;
  readonly artifactId: Id | null;
  /** A human's own words; rendered and prompted, never executed (BD-022). */
  readonly text: string;
  readonly rating: number | null;
  readonly sourceChannel: FeedbackRecord['source_channel'];
  readonly createdAt: IsoDateTime;
  readonly sequence: number;
}

export type FeedbackDecision = Decision<Feedback>;

export interface RecordFeedbackInput {
  readonly id: Id;
  readonly projectId: Id;
  readonly taskId?: Id | null;
  readonly authorUserId?: Id | null;
  readonly authorIdentity?: ExternalIdentity | null;
  readonly scope: FeedbackScope;
  readonly stage?: Slug | null;
  readonly artifactId?: Id | null;
  readonly text: string;
  readonly rating?: number | null;
  readonly sourceChannel: FeedbackRecord['source_channel'];
}

export const toFeedbackRecord = (feedback: Feedback): FeedbackRecord => ({
  id: feedback.id,
  project_id: feedback.projectId,
  task_id: feedback.taskId,
  author_user_id: feedback.authorUserId,
  author_identity: feedback.authorIdentity,
  scope: feedback.scope,
  stage: feedback.stage,
  artifact_id: feedback.artifactId,
  text: feedback.text,
  rating: feedback.rating,
  source_channel: feedback.sourceChannel,
  created_at: feedback.createdAt,
});

/**
 * Records one piece of feedback and emits `feedback.received`.
 *
 * The scope is not inferred: a caller that sends `scope: 'stage'` with no stage is describing the
 * task and should say so, so the mismatch is an invariant violation rather than a quiet promotion
 * to `task`. The other direction — a stage named on a `task`-scoped note — is accepted and kept,
 * because "this happened while the task was at implementation" is context, not a contradiction.
 */
export const recordFeedback = (
  input: RecordFeedbackInput,
  context: CommandContext,
): FeedbackDecision => {
  const text = input.text.trim();
  if (text.length === 0) {
    throw new InvariantViolationError('feedback.text', 'feedback with no words says nothing');
  }
  if (text.length > MAX_FEEDBACK_TEXT_CHARS) {
    throw new InvariantViolationError(
      'feedback.text',
      `feedback is at most ${MAX_FEEDBACK_TEXT_CHARS} characters and this one is ${text.length}`,
    );
  }
  if (input.scope === 'stage' && (input.stage ?? null) === null) {
    throw new InvariantViolationError(
      'feedback.scope',
      'feedback scoped to a stage has to name the stage',
    );
  }
  if (input.scope === 'artifact' && (input.artifactId ?? null) === null) {
    throw new InvariantViolationError(
      'feedback.scope',
      'feedback scoped to an artifact has to name the artifact',
    );
  }
  if (input.rating !== undefined && input.rating !== null) {
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new InvariantViolationError(
        'feedback.rating',
        `a rating is a whole number from 1 to 5, not ${input.rating}`,
      );
    }
  }

  const feedback: Feedback = {
    id: input.id,
    projectId: input.projectId,
    taskId: input.taskId ?? null,
    authorUserId: input.authorUserId ?? null,
    authorIdentity: input.authorIdentity ?? null,
    scope: input.scope,
    stage: input.stage ?? null,
    artifactId: input.artifactId ?? null,
    text,
    rating: input.rating ?? null,
    sourceChannel: input.sourceChannel,
    createdAt: context.clock.now(),
    sequence: FIRST_STREAM_SEQ,
  };
  const recorder = eventRecorder(
    { streamType: 'feedback', streamId: feedback.id },
    FIRST_STREAM_SEQ,
    {
      ...context,
      // The task is what a reader correlates by: feedback about a task belongs in that task's story,
      // and feedback about a project has nothing else to be correlated to.
      correlationId: context.correlationId ?? feedback.taskId ?? feedback.id,
    },
  );
  recorder.emit('feedback.received', {
    project_id: feedback.projectId,
    task_id: feedback.taskId,
    feedback: toFeedbackRecord(feedback),
  });
  return { aggregate: { ...feedback, sequence: recorder.sequence }, events: recorder.events };
};
