/**
 * **What a background job was doing, in words** (S-25.20): the job queues the platform declares
 * (`JOB_QUEUES` in `@platform/application`), as the *Failed background jobs* list names them in
 * place of the code name (`pipeline.outbound`). The web app does not depend on the application
 * ring, so `apps/server/src/routes/failed-jobs.test.ts` holds this table to `JOB_QUEUES` in both
 * directions, read off this file. A queue this build does not declare is exactly what that list may
 * show, so {@link jobQueueLabel} answers `null` and the screen says so with the name as text.
 *
 * A module of its own: only the lazy Instance screen shows these words (TD-013's budget).
 */
export const JOB_QUEUE_LABEL: Readonly<Record<string, string>> = {
  'stage.execute': 'Running a stage',
  'deadline.sweep': 'A deadline for a question or a person’s work',
  'mr.comment.debounce': 'Reading merge request comments',
  'pipeline.outbound': 'A call to a connected tool',
  'pipeline.intake.reconcile': 'Starting tickets that matched',
  'task.ask': 'Answering a question about a task',
  'ticket.poll': 'Checking the tracker for tickets',
  'mr.poll': 'Checking merge requests',
  'budget.window.reset': 'Starting a new budget window',
  'knowledge.index': 'Indexing the knowledge base',
  'knowledge.proposals': 'Proposing knowledge',
  'knowledge.apply': 'Applying accepted knowledge',
  'knowledge.hygiene': 'Tidying the knowledge base',
  'onboarding.discovery': 'Recording what discovery found',
  'bootstrap.history': 'Reading the project’s history',
  'notify.digest': 'Sending a digest',
  'db.partitions.maintain': 'Database upkeep',
  'maintenance.schedule': 'Scheduled upkeep',
  'price.list.maintain': 'Updating model prices',
};

/** The queue's words, or `null` for a queue this build does not name. */
export const jobQueueLabel = (queue: string): string | null =>
  Object.hasOwn(JOB_QUEUE_LABEL, queue) ? (JOB_QUEUE_LABEL[queue] ?? null) : null;
