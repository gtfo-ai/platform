/**
 * **Why a ready machine runs nothing (more)** — the pure half of `idle_reason` (S-28.6, the M28
 * ruling A on BD-010). The owner's feedback: "there was no info that the worker does not pick jobs
 * because of this rule — the user must always understand what is wrong, why it is stuck, the rules."
 *
 * The server reads the facts (`apps/server/src/queries/worker-idle.ts`: the claim's own counts of
 * the offers the machine would take and leaves, and the project task states the scheduler counts)
 * and this function chooses **one** cause, in a stated precedence — the first that holds wins:
 *
 * 1. **a blocker stands** → `null`: the claim blockers have their own words and they win;
 * 2. **every place is busy** → `slots_busy`;
 * 3. **an offer its claim would take is open** → `null`: it takes it at its next claim;
 * 4. **a queued task it would take is admitted by the limits** → `null`: the scheduler starts it;
 * 5. **its person's own limit holds their queued tasks** → `owner_limit` (part B's per-person
 *    limit; the facts carry it once that limit exists);
 * 6. **a project it serves is full and tasks it would take are queued there** → `project_limit` —
 *    the project with the most such tasks, then the lower key;
 * 7. **its claim policy leaves waiting runs for others** → `policy_skips`;
 * 8. otherwise → `nothing_queued`.
 *
 * Why this order: what physically stops it first (its places), then what would start next anyway
 * (no sentence to say), then the limits on work it **would** take before the work it declines —
 * a limit names the reader's own queued tasks, and a skipped run is someone else's.
 */
import type { TaskState, WorkerIdleReason } from '@platform/contracts';
import {
  countsAsActive,
  countsInPipeline,
  queueAdmissionOf,
  type WipBound,
  type WipCounts,
  type WipLimits,
} from './wip.js';

/** One task state's tasks in a project the machine serves. */
export interface ServedStateCount {
  readonly state: TaskState;
  /** Every task of the project in this state. */
  readonly count: number;
  /** Of those, how many the machine's claim policy would take. */
  readonly takes: number;
}

/** A project the machine serves, as the scheduler counts it. */
export interface ServedProject {
  readonly projectId: string;
  readonly projectKey: string;
  /** Live states only (`done`/`cancelled` are never counted and need not be listed). */
  readonly states: readonly ServedStateCount[];
  readonly limits: WipLimits;
  /** The keys of the limits the organisation's maximum lowered (`resolveWipLimits`' `bounded`). */
  readonly bounded: readonly WipBound['key'][];
}

/** The machine's person's own limit, when their queued tasks wait behind it (part B). */
export interface OwnerLimitFacts {
  readonly userId: string;
  readonly name: string;
  readonly count: number;
  readonly limit: number;
  /** Their queued tasks this machine would take. */
  readonly queued: number;
  readonly holders: readonly { readonly taskId: string; readonly ticketKey: string }[];
}

export interface WorkerIdleFacts {
  /** A claim blocker stands (`claim_blockers` is not empty). */
  readonly blocked: boolean;
  /** Live runs it holds. */
  readonly running: number;
  readonly concurrency: number;
  /** Open offers its automatic claim would take now (eligibility, scope and policy). */
  readonly takeableOffers: number;
  /** Open offers its eligibility and scope admit and its policy leaves for others. */
  readonly policySkippedOffers: number;
  readonly claimPolicy: 'everything' | 'mine_and_unassigned' | 'mine' | 'pick_only';
  /** The projects it serves (execution mode, scope, role, run credential — the claim's own). */
  readonly projects: readonly ServedProject[];
  /** `null`: no per-person limit holds any of its queued tasks. */
  readonly ownerLimit?: OwnerLimitFacts | null;
  /**
   * Queued tasks it would take that the per-person limit holds — subtracted from each project's
   * `takes` before the project's own limits are asked (part B); absent is none.
   */
  readonly ownerHeldByProject?: ReadonlyMap<string, number>;
}

const queuedTakesOf = (project: ServedProject, held: number): number =>
  Math.max(
    0,
    project.states
      .filter((state) => state.state === 'queued')
      .reduce((sum, state) => sum + state.takes, 0) - held,
  );

/** `wipCountsOf` over counted states: the same two predicates, without one entry per task. */
const countsOf = (states: readonly ServedStateCount[]): WipCounts => ({
  activeTasks: states.reduce((sum, s) => sum + (countsAsActive(s.state) ? s.count : 0), 0),
  tasksInPipeline: states.reduce((sum, s) => sum + (countsInPipeline(s.state) ? s.count : 0), 0),
});

/** The one cause, or `null` — see the module note for the precedence. */
export const workerIdleReasonOf = (facts: WorkerIdleFacts): WorkerIdleReason | null => {
  if (facts.blocked) {
    return null;
  }
  if (facts.running >= facts.concurrency) {
    return { kind: 'slots_busy', running: facts.running, concurrency: facts.concurrency };
  }
  if (facts.takeableOffers > 0) {
    return null;
  }
  const full: {
    readonly project: ServedProject;
    readonly queued: number;
    readonly admission: Exclude<ReturnType<typeof queueAdmissionOf>, { status: 'admitted' }>;
  }[] = [];
  for (const project of facts.projects) {
    const queued = queuedTakesOf(project, facts.ownerHeldByProject?.get(project.projectId) ?? 0);
    if (queued === 0) {
      continue;
    }
    const counts = countsOf(project.states);
    const admission = queueAdmissionOf(counts, project.limits);
    if (admission.status === 'admitted') {
      return null;
    }
    full.push({ project, queued, admission });
  }
  const owner = facts.ownerLimit ?? null;
  if (owner !== null && owner.queued > 0) {
    return {
      kind: 'owner_limit',
      owner: { user_id: owner.userId, name: owner.name },
      count: owner.count,
      limit: owner.limit,
      queued: owner.queued,
      holders: owner.holders
        .slice(0, 5)
        .map((holder) => ({ task_id: holder.taskId, ticket_key: holder.ticketKey })),
    };
  }
  const [first] = full.sort(
    (a, b) => b.queued - a.queued || a.project.projectKey.localeCompare(b.project.projectKey),
  );
  if (first !== undefined) {
    const key =
      first.admission.reason === 'max_parallel_tasks'
        ? 'pipeline.wip.max_parallel_tasks'
        : 'pipeline.wip.max_tasks_in_pipeline';
    return {
      kind: 'project_limit',
      project_id: first.project.projectId,
      project_key: first.project.projectKey,
      limit_kind: first.admission.reason,
      count: first.admission.count,
      limit: first.admission.limit,
      queued: first.queued,
      organisation_bound: first.project.bounded.includes(key),
    };
  }
  if (
    facts.policySkippedOffers > 0 &&
    (facts.claimPolicy === 'mine' || facts.claimPolicy === 'mine_and_unassigned')
  ) {
    return {
      kind: 'policy_skips',
      skipped: facts.policySkippedOffers,
      claim_policy: facts.claimPolicy,
    };
  }
  return { kind: 'nothing_queued' };
};
