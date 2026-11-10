/**
 * **A person's limit on their tasks in flight** (S-28.6, the M28 ruling B on BD-010) — the API DTOs
 * of the *Your limit* card on the Workers screen and an administrator's people list.
 *
 *   GET /api/me/task-limit                 your limit, what counts toward it and what holds it
 *   PUT /api/me/task-limit                 set your own (`null`: the default)
 *   GET /api/org/task-limits               every person's limit — an administrator's read
 *   PUT /api/org/users/:id/task-limit      set a person's — an administrator's write
 *
 * **What counts**: the tasks a person owns that are `active`, `returned`, `waiting_answers` or
 * `waiting_approval`, across every project — not `paused`, not `needs_human` (waiting for a person
 * to unblock them), not queued, not at *Ready for merge* or later, not finished. **The limit in
 * force** is their own `max_tasks_in_flight` when set, never above the organisation's
 * `pipeline.wip.max_tasks_per_owner` (`maximum`), else the organisation's value — 3 when it states
 * none (`default`); a project may hold its own tasks to a lower default.
 */
import * as z from 'zod';
import { idSchema, nonEmptyStringSchema, taskStateSchema } from './common.js';
import { MAX_WIP_TASKS_PER_OWNER } from './config.js';

/** A person's own limit as written: 1–200, or `null` for the default. */
export const personalTaskLimitSchema = z.int().min(1).max(MAX_WIP_TASKS_PER_OWNER).nullable();

/** `PUT /api/me/task-limit` and `PUT /api/org/users/:id/task-limit` — a state assertion. */
export const taskLimitRequestSchema = z.strictObject({
  max_tasks_in_flight: personalTaskLimitSchema,
});
export type TaskLimitRequest = z.infer<typeof taskLimitRequestSchema>;

/** One task holding a person's place. The ticket key is the provider's text (BD-022). */
export const taskLimitHolderSchema = z.strictObject({
  task_id: idSchema,
  ticket_key: nonEmptyStringSchema,
  project_key: nonEmptyStringSchema,
  state: taskStateSchema,
});

/** At most this many holders are named. */
export const TASK_LIMIT_HOLDERS_MAX = 20;

/** `GET /api/me/task-limit`: the reader's limit and what it counts now. */
export const myTaskLimitResponseSchema = z.strictObject({
  user_id: idSchema,
  /** Their own number, or `null` for the default. */
  max_tasks_in_flight: personalTaskLimitSchema,
  /** The limit in force for them: their own number under `maximum`, else `default`. */
  limit: z.int().positive(),
  /** The organisation's `max_tasks_per_owner`, else 3 — the limit of a person with none of their own. */
  default: z.int().positive(),
  /** The highest a person's own number may be: the organisation's value, else the schema's 200. */
  maximum: z.int().positive(),
  /** Whether the organisation states `max_tasks_per_owner` (else the default and the maximum are the platform's). */
  organisation_states: z.boolean(),
  /** Their tasks in flight now — the ones the limit counts. */
  in_flight: z.int().nonnegative(),
  /** Their queued tasks. */
  queued: z.int().nonnegative(),
  holders: z.array(taskLimitHolderSchema).max(TASK_LIMIT_HOLDERS_MAX),
});
export type MyTaskLimitResponse = z.infer<typeof myTaskLimitResponseSchema>;

/** `PUT …/task-limit`: the stored number and whether this call changed it. */
export const taskLimitResponseSchema = z.strictObject({
  user_id: idSchema,
  max_tasks_in_flight: personalTaskLimitSchema,
  limit: z.int().positive(),
  performed: z.boolean(),
});
export type TaskLimitResponse = z.infer<typeof taskLimitResponseSchema>;

/** `GET /api/org/task-limits`: every person's limit — an administrator's read. */
export const orgTaskLimitsResponseSchema = z.strictObject({
  default: z.int().positive(),
  maximum: z.int().positive(),
  organisation_states: z.boolean(),
  items: z.array(
    z.strictObject({
      user_id: idSchema,
      name: z.string().max(320).nullable(),
      email: z.string().max(320),
      max_tasks_in_flight: personalTaskLimitSchema,
      limit: z.int().positive(),
      in_flight: z.int().nonnegative(),
      queued: z.int().nonnegative(),
    }),
  ),
});
export type OrgTaskLimitsResponse = z.infer<typeof orgTaskLimitsResponseSchema>;

export const taskLimitUserParamsSchema = z.strictObject({ id: idSchema });
