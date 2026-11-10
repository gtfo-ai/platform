/**
 * **What a person did, in words** (S-25.22, BACKLOG 1372) — every `human_actions.action` the server
 * records, as the audit lists say it after the person's name: the task's *Who did what*
 * (`features/task-activity.tsx`) and the project's *Who changed what* (`features/operating-mode.tsx`)
 * printed the code name (`task.pause`, `project.autonomy.write`) where a person reads *Paused the
 * task*.
 *
 * `action` is an open string on the wire (`nonEmptyStringSchema`): a new command adds a spelling and
 * the contract does not change. So the table is held to the server's sources instead —
 * `human-actions.test.ts` reads every action string the server records (the command routes, the
 * worker writers, the chat door) off disk and fails on one with no words here, **and** on a key here
 * that nothing records. A row written by a build this one does not know reads
 * {@link UNKNOWN_HUMAN_ACTION} — never the code name.
 *
 * Its own module, which the worker's local page does not import: its 120 kB entry is untouched.
 */

export const HUMAN_ACTION_WORDS: Readonly<Record<string, string>> = {
  // A task (`routes/commands.ts`, `asks.ts`, `breakdown.ts`, the manual start).
  'task.pause': 'Paused the task',
  'task.resume': 'Resumed the task',
  'task.cancel': 'Cancelled the task',
  'task.budget.raise': 'Raised the task’s cost cap',
  'task.owner': 'Changed who owns the task',
  'task.retry_stage': 'Retried the step',
  'task.return_to_stage': 'Sent the task back to an earlier step',
  'task.rework': 'Asked for the work to be redone',
  'task.feedback': 'Gave feedback',
  'task.question.answer': 'Answered a question',
  'task.approval.decide': 'Decided on an approval',
  'task.take_over': 'Started working on it themselves',
  'task.hand_back': 'Gave it back to the agent',
  'task.ask': 'Asked the agent a question',
  'task.breakdown.decide': 'Decided on the proposed sub-tasks',
  'task.start': 'Started a task from its ticket',
  // A run.
  'run.retry': 'Re-ran the run',
  'run.cancel': 'Cancelled the run',
  'run.steer': 'Sent the agent a message',
  // A project and its settings.
  'budget.write': 'Changed a cost cap',
  'project.create': 'Created the project',
  'project.autonomy.write': 'Changed how much agents do alone',
  'project.config.write': 'Changed the project’s settings',
  'project.config.export': 'Wrote the settings to the repository',
  'project.config.refresh': 'Re-read the settings from the repository',
  'project.bindings.write': 'Changed the project’s connections',
  'project.default_branch.write': 'Changed the default branch',
  'project.execution.write': 'Changed where the project’s runs happen',
  'project.discovery.start': 'Started learning about the project',
  'project.discovery.rerun': 'Asked for the project to be looked at again',
  'project.history_bootstrap.start': 'Started learning from the project’s history',
  'project.interview.record': 'Recorded the business interview',
  'project.shadow.start': 'Started a trial run',
  // Connections.
  'integration.create': 'Added a connection',
  'integration.config.write': 'Changed a connection’s settings',
  'integration.secrets.write': 'Replaced a connection’s credentials',
  'integration.retire': 'Removed a connection',
  'integration.test': 'Tested a connection',
  // The organisation and people.
  'org.settings.write': 'Changed the organisation’s policies',
  'org.identity.map': 'Linked a tracker account to a person',
  'org.identity.unmap': 'Unlinked a tracker account from a person',
  'org.dead_letter.requeue': 'Tried a failed step again',
  'identity.link': 'Linked their own account',
  'identity.link_code.issue': 'Asked for a code to link their account',
  'identity.unlink': 'Unlinked their own account',
  // Machines.
  'worker.device.approve': 'Approved a machine',
  'worker.device.deny': 'Refused a machine',
  'worker.claim_policy': 'Changed what a machine takes',
  'user.task_limit': 'Changed a person’s limit on tasks in flight',
  'worker.claim_scope': 'Changed which projects a machine takes work from',
  'worker.pause': 'Paused a machine',
  'worker.resume': 'Resumed a machine',
  'worker.revoke': 'Removed a machine',
  'worker.update': 'Updated a machine’s software',
  'worker.take_offer': 'Picked a run on their machine',
};

/** What a row whose action this build has no words for reads — never the code name. */
export const UNKNOWN_HUMAN_ACTION = 'Did something this screen has no words for';

/** The words for a recorded action. */
export const humanActionWords = (action: string): string =>
  Object.hasOwn(HUMAN_ACTION_WORDS, action)
    ? (HUMAN_ACTION_WORDS[action] as string)
    : UNKNOWN_HUMAN_ACTION;

/** A person the audit names: who they are, as the organisation's user list has them. */
export interface AuditPerson {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
}

/**
 * The actor's display name — the user list's name, else its e-mail, else the e-mail the read
 * carried (the project audit's `user_email`) — and *A removed account* for a row whose user is gone
 * (`user_id` null). *Someone* while the list is not loaded or the caller may not read it: never the
 * raw id. Untrusted text: the caller renders it through `UntrustedText`.
 */
export const actorName = (
  userId: string | null,
  people: readonly AuditPerson[] | undefined,
  fallbackEmail: string | null = null,
): string => {
  if (userId === null) {
    return 'A removed account';
  }
  const person = people?.find((candidate) => candidate.id === userId);
  return person?.name ?? person?.email ?? fallbackEmail ?? 'Someone';
};
