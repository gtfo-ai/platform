/**
 * The one SQL spelling of a take-over's **last activity** (WP-44, PROGRESS backlog 167).
 *
 * Two queries ask when a held task last saw its holder — `tasks.takenOver`, which the inactivity
 * timer and the workpad read, and the deadline recovery's `heldTasks`, which finds a timer that was
 * lost — and until WP-44 both answered *the take-over instant* by separate arithmetic. The rule is
 * `TakeOverRecord.lastActivityAt`'s (`packages/application/src/pipeline/store.ts`): the newest
 * `human_actions` row on the task by the user the `task.taken_over` event names, written after it,
 * or the take-over instant when there is none. It is one expression here so the timer and its
 * recovery cannot disagree about when a take-over went quiet.
 *
 * `taskId` and `event` are SQL expressions, not values: the task id column or parameter of the
 * caller's query, and the alias of its `task.taken_over` row (which must expose `occurred_at` and
 * `actor`). A system actor has no `user_id`, so the comparison is against `null` and matches no row.
 */
export const takeOverLastActivitySql = (taskId: string, event: string): string => `greatest(
  ${event}.occurred_at,
  coalesce(
    (select max(h.created_at) from human_actions h
      where h.task_id = ${taskId}
        and h.user_id = (${event}.actor ->> 'user_id')::uuid
        and h.created_at > ${event}.occurred_at),
    ${event}.occurred_at
  )
)`;
