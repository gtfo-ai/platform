/**
 * The `deadline.sweep` timer's wake-up and its arm — a module of its own, below `deadlines.ts`
 * (the arming handler and the job) and `reminders.ts` (which arms an approval's next reminder
 * itself, S-27.1), so neither imports the other's values.
 */
import type { IsoDateTime } from '@platform/contracts';
import { idSchema } from '@platform/contracts';
import * as z from 'zod';
import type { Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';

/**
 * One wake-up on `deadline.sweep`: which aggregate, which one, which of its deadlines.
 *
 * Exactly the triple the architect's ruling names and nothing else — in particular **no due
 * instant** and **no reminder ordinal**: the job re-reads them from the row (a question, an
 * approval's `reminders_sent`) or recomputes them from the event log (a take-over), so a wake-up
 * that outlives a change of mind carries nothing stale. Strict, like every boundary: a job enqueued
 * by a newer build with a field this one does not know is refused by name rather than
 * half-understood.
 *
 * `approval_timeout` is **kept parseable** though nothing arms it any more (BD-006's 2026-11-07
 * amendment, item 4): a timer an earlier build queued must end `settled`, not spend its retries
 * on a shape this build refuses.
 */
export const deadlineSweepDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    aggregate: z.literal('question'),
    id: idSchema,
    kind: z.literal('question_timeout'),
  }),
  z.strictObject({
    aggregate: z.literal('approval'),
    id: idSchema,
    kind: z.literal('approval_timeout'),
  }),
  z.strictObject({
    aggregate: z.literal('task'),
    id: idSchema,
    kind: z.literal('take_over_inactivity'),
  }),
  // WP-84 (PROGRESS backlog 165): BD-006's reminders — one more kind on the same queue per
  // aggregate, the architect's ruling.
  z.strictObject({
    aggregate: z.literal('question'),
    id: idSchema,
    kind: z.literal('question_reminder'),
  }),
  z.strictObject({
    aggregate: z.literal('approval'),
    id: idSchema,
    kind: z.literal('approval_reminder'),
  }),
]);

export type DeadlineSweepData = z.infer<typeof deadlineSweepDataSchema>;

/** The singleton key: one queued timer per `(aggregate, id, kind)`. */
export const deadlineKey = (data: DeadlineSweepData): string =>
  `${data.aggregate}:${data.id}:${data.kind}`;

/** Arms (or re-arms) one timer. */
export const enqueueDeadline = async (
  jobs: Jobs,
  data: DeadlineSweepData,
  dueAt: IsoDateTime,
): Promise<void> => {
  await jobs.enqueue<DeadlineSweepData>({
    queue: JOB_QUEUES.deadlineSweep,
    data,
    singletonKey: deadlineKey(data),
    startAfter: new Date(dueAt),
  });
};
