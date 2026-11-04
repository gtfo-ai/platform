/**
 * **Whether a remote worker may still act**, in SQL — one definition for every statement that asks
 * it (WP-281, PROGRESS backlog 714).
 *
 * A worker's credential is authenticated when a request arrives (`apps/server/src/workers/secrets.ts`),
 * but a revoke or a ban can commit between that read and the request's own write. So the claim, the
 * heartbeat's renewal, the spawn marker and `finish` re-ask it **in their own statement**: a write
 * that commits after a revoke or a ban was committed sees it and writes nothing.
 *
 * - {@link USER_MAY_ACT_SQL} is the session hook's rule (`userMayAct`,
 *   `apps/server/src/queries/identity-queries.ts`) over the `users` row aliased `u`: not disabled,
 *   and not under a ban still in force. The worker store (`worker-queries.ts`) reads the same text,
 *   so the device flow, authentication and these statements cannot disagree about an expired ban.
 * - {@link workerUsableSql} is "the worker is not revoked and its user may act", for a worker named
 *   by an SQL expression; {@link runHolderUsableSql} is the same for the worker a `runs` row names,
 *   **true** for a run no remote worker holds (`worker_id` null — the server's runner), so the server's
 *   writes are unchanged by it.
 */

/** `userMayAct` over the `users` row aliased `u`. */
export const USER_MAY_ACT_SQL =
  "(u.status <> 'disabled' and not (coalesce(u.banned, false) and (u.ban_expires is null or u.ban_expires > now())))";

/** The worker `expression` names is not revoked and its user may act. */
export const workerUsableSql = (expression: string): string =>
  `exists (select 1 from workers hw join users u on u.id = hw.user_id
            where hw.id = ${expression} and hw.revoked_at is null and ${USER_MAY_ACT_SQL})`;

/** The run `alias` names is held by no remote worker, or by one that may still act. */
export const runHolderUsableSql = (alias: string): string =>
  `(${alias}.worker_id is null or ${workerUsableSql(`${alias}.worker_id`)})`;
