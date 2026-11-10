/**
 * **Why a ready machine runs nothing (more)** — the read half of `idle_reason` (S-28.6, the M28
 * ruling A on BD-010). The decision is `workerIdleReasonOf` in `@platform/domain`; this module reads
 * the facts it decides on, each **the claim's or the scheduler's own question asked again** and
 * never stored:
 *
 * - **the offers** — how many open offers the machine's automatic claim would take now
 *   (`takeableOffersSql`: eligibility, scope and policy, the claim's three conjuncts) and how many
 *   its policy leaves for others (`policySkippedOffersSql`, S-26.4's count);
 * - **the projects it serves** — the projects `CLAIM_FACTS_OF_WORKER`'s `eligible_projects` counts
 *   (not `server_only`, its scope, its person's effective role, a run credential workers may use),
 *   each project's live tasks counted by state, and how many of each state its claim policy would
 *   take (`workerPolicyTakesTaskSql`, the policy over a task that has no offer yet);
 * - **the limits** — `ProjectSettings.wip` through the scheduler's own settings port (the same
 *   `WipLimitsReader` `queue_wait` is read with), so the organisation's bound applies here exactly
 *   as it does to admission.
 *
 * Two statements for every machine that is asked at all, and nothing for a machine a blocker stops
 * or whose places are all busy — those causes need no read. The limits are read once per project.
 */
import type { TaskState, WorkerClaimPolicy, WorkerIdleReason } from '@platform/contracts';
import {
  DEFAULT_EXECUTION_MODE,
  type RunImageDigests,
  type ServedProject,
  type ServedStateCount,
  workerIdleReasonOf,
} from '@platform/domain';
import { pipeline as pipelineAdapters } from '@platform/infrastructure';
import { sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';
import type { WipLimitsInForce, WipLimitsReader } from './queue-wait.js';

/** A machine whose idle reason is asked, with what its row already says. */
export interface IdleCandidate {
  readonly workerId: string;
  /** A claim blocker stands: the answer is `null` and nothing is read. */
  readonly blocked: boolean;
  readonly running: number;
  readonly concurrency: number;
  readonly claimPolicy: WorkerClaimPolicy;
}

/**
 * The idle reason of each candidate, by worker id; a candidate absent from the answer is unknown.
 * `coreDigests` `null` (the core cannot name its images — a blocker on every machine) answers
 * `null` for each.
 */
export type WorkerIdleReader = (
  candidates: readonly IdleCandidate[],
  coreDigests: RunImageDigests | null,
) => Promise<ReadonlyMap<string, WorkerIdleReason | null>>;

const TAKEABLE = sql.raw(
  pipelineAdapters.takeableOffersSql({
    worker: 'wk.wid',
    held: 'wk.held',
    run: 'cd.run',
    egress: 'cd.egress',
  }),
);
const SKIPPED = sql.raw(
  pipelineAdapters.policySkippedOffersSql({
    worker: 'wk.wid',
    held: 'wk.held',
    run: 'cd.run',
    egress: 'cd.egress',
  }),
);
const MAY_RUN_IN = sql.raw(pipelineAdapters.userMayRunInProjectSql('w.user_id', 'p.id'));
const CREDENTIAL_REFUSED = sql.raw(pipelineAdapters.remoteRunCredentialRefusedSql('p.id'));
const POLICY_TAKES_TASK = sql.raw(pipelineAdapters.workerPolicyTakesTaskSql('w', 't'));
const SCOPE_TAKES = sql.raw(pipelineAdapters.projectListTakesSql('w', 'p.id'));

const uuidArray = (ids: readonly string[]): string => `{${ids.join(',')}}`;

/** The reader over `database`, the limits read through `wipLimits` (the scheduler's settings). */
export const createWorkerIdleReader =
  (database: Database, wipLimits: WipLimitsReader): WorkerIdleReader =>
  async (candidates, coreDigests) => {
    const answers = new Map<string, WorkerIdleReason | null>();
    const asked: IdleCandidate[] = [];
    for (const candidate of candidates) {
      const quick =
        coreDigests === null || candidate.blocked || candidate.running >= candidate.concurrency;
      if (quick) {
        answers.set(
          candidate.workerId,
          coreDigests === null
            ? null
            : workerIdleReasonOf({
                blocked: candidate.blocked,
                running: candidate.running,
                concurrency: candidate.concurrency,
                takeableOffers: 0,
                policySkippedOffers: 0,
                claimPolicy: candidate.claimPolicy,
                projects: [],
              }),
        );
      } else {
        asked.push(candidate);
      }
    }
    if (asked.length === 0 || coreDigests === null) {
      return answers;
    }
    const ids = uuidArray(asked.map((candidate) => candidate.workerId));
    const [offers, served] = await Promise.all([
      database.execute<{ worker_id: string; takeable: number; skipped: number }>(sql`
        select wk.wid as worker_id, ${TAKEABLE} as takeable, ${SKIPPED} as skipped
          from workers w
         cross join lateral (select w.id as wid,
                                    array(select jsonb_array_elements_text(w.image_digests)) as held) wk
         cross join (select ${coreDigests.run}::text as run, ${coreDigests.egress}::text as egress) cd
         where w.id = any(${ids}::uuid[])`),
      database.execute<{
        worker_id: string;
        project_id: string;
        project_key: string;
        state: TaskState;
        count: number;
        takes: number;
      }>(sql`
        select w.id as worker_id, p.id as project_id, p.key as project_key, t.state::text as state,
               count(*)::int as count,
               count(*) filter (where ${POLICY_TAKES_TASK})::int as takes
          from workers w
          join projects p on ${SCOPE_TAKES}
          left join project_execution_settings s on s.project_id = p.id
          join tasks t on t.project_id = p.id
         where w.id = any(${ids}::uuid[])
           and t.state not in ('done', 'cancelled')
           and coalesce(s.mode, ${DEFAULT_EXECUTION_MODE}) <> 'server_only'
           and ${MAY_RUN_IN}
           and not ${CREDENTIAL_REFUSED}
         group by w.id, p.id, p.key, t.state`),
    ]);
    const offersOf = new Map(offers.rows.map((row) => [row.worker_id, row]));
    const limits = new Map<string, Promise<WipLimitsInForce>>();
    const limitsOf = (projectId: string): Promise<WipLimitsInForce> => {
      const known = limits.get(projectId);
      if (known !== undefined) return known;
      const read = wipLimits(projectId);
      limits.set(projectId, read);
      return read;
    };
    for (const candidate of asked) {
      const byProject = new Map<string, { key: string; states: ServedStateCount[] }>();
      for (const row of served.rows) {
        if (row.worker_id !== candidate.workerId) continue;
        const entry = byProject.get(row.project_id) ?? { key: row.project_key, states: [] };
        entry.states.push({ state: row.state, count: Number(row.count), takes: Number(row.takes) });
        byProject.set(row.project_id, entry);
      }
      const projects: ServedProject[] = await Promise.all(
        [...byProject].map(async ([projectId, entry]) => {
          const inForce = await limitsOf(projectId);
          return {
            projectId,
            projectKey: entry.key,
            states: entry.states,
            limits: inForce.limits,
            bounded: inForce.bounded,
          };
        }),
      );
      const counted = offersOf.get(candidate.workerId);
      answers.set(
        candidate.workerId,
        workerIdleReasonOf({
          blocked: false,
          running: candidate.running,
          concurrency: candidate.concurrency,
          takeableOffers: Number(counted?.takeable ?? 0),
          policySkippedOffers: Number(counted?.skipped ?? 0),
          claimPolicy: candidate.claimPolicy,
          projects,
        }),
      );
    }
    return answers;
  };
