/**
 * **Why a ready machine runs nothing** (S-28.6, the M28 ruling A on BD-010) — a module of its own,
 * importing only zod and `common.ts`, so the Workers screen's rows (`workers.ts`), the worker
 * protocol's `GET offers` (`worker.ts`) and the worker's local state (`worker-local.ts`) all carry it
 * without an import cycle.
 *
 * The claim blockers (`worker-claim-blockers.ts`) say why a machine **cannot** take work; this says
 * why a machine that **can** is not running anything (or nothing more). It is `null` whenever a
 * blocker stands — the blocker's words win — and whenever the machine is about to take something
 * (an offer its claim would take, or a queued task the limits admit, which the scheduler starts).
 * Exactly one cause is chosen, by `workerIdleReasonOf` in `@platform/domain` with a stated
 * precedence:
 *
 * 1. `slots_busy` — every place on the machine is taken;
 * 2. `owner_limit` — the machine's person owns as many tasks in flight as their limit allows, and
 *    more of theirs are queued (S-28.6 part B's per-person limit);
 * 3. `project_limit` — a project it serves is full, and tasks it would take are queued behind that;
 * 4. `policy_skips` — runs are waiting, and what it takes (its claim policy) leaves them for others;
 * 5. `nothing_queued` — nothing is queued or waiting for it in the projects it serves.
 *
 * Every variant carries the numbers its sentence says, so a screen never computes them. Ticket keys
 * and project keys are stored text and are rendered as text (BD-022).
 *
 * **On the worker protocol it is an opt-in** (`GET offers?fields=…,idle_reason`), never a bump: a
 * worker built before it parses strictly and never asks, and an older core ignores the query. All
 * five kinds ship together, so a later core that names `owner_limit` is never refused by a worker
 * that asked.
 */
import * as z from 'zod';
import { idSchema } from './common.js';

/** The kinds, in the precedence `workerIdleReasonOf` decides them. */
export const WORKER_IDLE_REASONS = [
  'slots_busy',
  'owner_limit',
  'project_limit',
  'policy_skips',
  'nothing_queued',
] as const;
export type WorkerIdleReasonKind = (typeof WORKER_IDLE_REASONS)[number];

/** At most this many tasks are named as holding a person's places. */
export const WORKER_IDLE_HOLDERS_MAX = 5;

/** The bound of a per-person limit (S-28.6 part B: `pipeline.wip.max_tasks_per_owner`, 1–200). */
export const TASKS_PER_OWNER_MAX = 200;

export const workerIdleReasonSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('slots_busy'),
    /** Live runs it holds. */
    running: z.int().nonnegative(),
    /** Runs it may hold at once. */
    concurrency: z.int().positive().max(64),
  }),
  z.strictObject({
    kind: z.literal('owner_limit'),
    /** The machine's person, whose limit binds. `name` is their name, or their email without one. */
    owner: z.strictObject({ user_id: idSchema, name: z.string().min(1).max(320) }),
    /** Their tasks in flight — the ones the limit counts. */
    count: z.int().nonnegative(),
    limit: z.int().positive().max(TASKS_PER_OWNER_MAX),
    /** Their queued tasks this machine would take. */
    queued: z.int().positive(),
    /** Some of the tasks that hold their places, oldest first. */
    holders: z
      .array(z.strictObject({ task_id: idSchema, ticket_key: z.string().min(1).max(256) }))
      .max(WORKER_IDLE_HOLDERS_MAX),
  }),
  z.strictObject({
    kind: z.literal('project_limit'),
    project_id: idSchema,
    project_key: z.string().min(1).max(64),
    /** Which of the project's two limits refuses: tasks at once, or places in its pipeline. */
    limit_kind: z.enum(['max_parallel_tasks', 'max_tasks_in_pipeline']),
    /** The count that limit compared. */
    count: z.int().nonnegative(),
    limit: z.int().positive(),
    /** Queued tasks of the project this machine would take. */
    queued: z.int().positive(),
    /** The limit is the organisation's maximum: raising the project's own value changes nothing. */
    organisation_bound: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('policy_skips'),
    /** Waiting runs its eligibility and scope admit and its claim policy leaves for others. */
    skipped: z.int().positive(),
    /** The policy that leaves them — `everything` leaves nothing, `pick_only` is a blocker. */
    claim_policy: z.enum(['mine', 'mine_and_unassigned']),
  }),
  z.strictObject({ kind: z.literal('nothing_queued') }),
]);
export type WorkerIdleReason = z.infer<typeof workerIdleReasonSchema>;
