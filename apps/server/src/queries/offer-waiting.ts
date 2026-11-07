/**
 * **Why a run waits** — S-26.5, TD-031's 2026-11-06 amendment item 8 (BD-032's 2026-11-06
 * amendment). A read-model field `waiting` on the task DTO, the board's items and the Agents rows:
 * for a run's **open** offer, whether somebody can take it now, and if nobody can, why — as a key
 * (the contract's `OFFER_WAITING_REASONS`); the web app says it in words, the server never does.
 *
 * **The claim's own predicates, asked once per offer** — never re-derived, which is what the
 * PostgreSQL parity test (`test/integration/pipeline/offer-waiting.integration.test.ts`) holds:
 * `reason` is `null` exactly when some claimant's predicates admit the offer now.
 *
 * - **The server claimant** takes it when a `server_claimants` row is fresh (a process is claiming,
 *   `serverClaimantRunning`'s question) and the claim's server conjunct admits the offer
 *   (`serverEligibleSql`).
 * - **A machine** takes it when it is connected (`last_seen_at` inside
 *   {@link WORKER_CONNECTED_SECONDS} — a worker that claims is one that calls, and every call
 *   records it) and the claim's three conjuncts for an automatic claim admit it: the eligibility
 *   (`workerEligibleSql`, over the digests the row holds and the core's own), the project list
 *   (`workerScopeTakesSql`) and the policy (`workerPolicyTakesSql`).
 *
 * When neither does, the reason is about **the person the offer is "mine" of** — the task's owner,
 * or an ask's asker (`offerIsMineSql`'s rule) — and their machines that would take it (not revoked,
 * their user able to run in the project, its project list taking it, its policy admitting it):
 * none and one that only picks → `owner_pick_only`; none → `owner_no_worker`; none connected →
 * `owner_worker_offline` (with the newest `last_seen_at`); every connected one paused →
 * `owner_worker_paused`; a connected running one that the claim still refuses (its images, an
 * exclusion, the project's mode or credential, a head start) is the residual and reads
 * `owner_no_worker`, which the Workers screen and the execution read then explain. With no such
 * person, a task **held elsewhere** (`taskHeldElsewhereSql`, the claim's fragment) is
 * `assignee_not_linked` and any other — a task a linked member released included, since it is
 * unassigned — `no_taker`.
 *
 * **One statement per page**: the reads take every run or task id of the answer at once.
 */
import type { Id, OfferWaiting, OfferWaitingReason } from '@platform/contracts';
import {
  ACTIVE_RUN_STATUSES,
  DEFAULT_EXECUTION_MODE,
  type RunImageDigests,
} from '@platform/domain';
import { pipeline as pipelineAdapters } from '@platform/infrastructure';
import { type SQL, sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';
import { WORKER_CONNECTED_SECONDS } from './worker-queries.js';

/** What the statement answers about one open offer — the facts {@link waitingReasonOf} decides on. */
export interface OfferWaitingFacts {
  /** The server claimant is running and its conjunct admits the offer. */
  readonly serverTakes: boolean;
  /** A connected machine's automatic claim admits the offer. */
  readonly workerTakes: boolean;
  /** The person the offer is "mine" of — the task's owner, an ask's asker — or `null`. */
  readonly person: { readonly userId: string; readonly name: string } | null;
  /** The task is *held elsewhere* (a stage offer, no owner, an unmappable tracker assignee). */
  readonly heldElsewhere: boolean;
  /** The held assignee's display name (provider text, redacted at the write), or `null`. */
  readonly assigneeName: string | null;
  /** The person's machines that would take the offer by themselves. */
  readonly takers: number;
  /** The person has a machine whose project list takes the project and whose policy only picks. */
  readonly pickOnly: boolean;
  /** One of the takers is connected and not paused. */
  readonly takerReady: boolean;
  /** One of the takers is connected and paused (by its owner or by a usage limit). */
  readonly takerPaused: boolean;
  /** The newest `last_seen_at` among the takers. */
  readonly takersLastSeenAt: string | null;
}

/**
 * The reason, or `null` when somebody can take the offer now. Pure, and the only place a fact
 * becomes a key: every value it returns is one of the contract's `OFFER_WAITING_REASONS`.
 */
export const waitingReasonOf = (facts: OfferWaitingFacts): OfferWaitingReason | null => {
  if (facts.serverTakes || facts.workerTakes) {
    return null;
  }
  if (facts.person !== null) {
    if (facts.takers === 0) {
      return facts.pickOnly ? 'owner_pick_only' : 'owner_no_worker';
    }
    if (facts.takerReady) {
      // The residual: the owner's machine is up and running, and the claim refuses it anyway.
      return 'owner_no_worker';
    }
    return facts.takerPaused ? 'owner_worker_paused' : 'owner_worker_offline';
  }
  return facts.heldElsewhere ? 'assignee_not_linked' : 'no_taker';
};

/** The DTO's `waiting`: the reason, and the one person, instant or name it is about. */
export const offerWaitingOf = (facts: OfferWaitingFacts): OfferWaiting => {
  const reason = waitingReasonOf(facts);
  const aboutPerson = reason?.startsWith('owner_') === true;
  return {
    reason,
    user:
      aboutPerson && facts.person !== null
        ? { user_id: facts.person.userId as Id, name: facts.person.name }
        : null,
    last_seen_at: reason === 'owner_worker_offline' ? facts.takersLastSeenAt : null,
    assignee_name: reason === 'assignee_not_linked' ? facts.assigneeName : null,
  };
};

/** The live run statuses as a literal array — a closed set of enum literals. */
const ACTIVE_STATUSES = `array[${ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(', ')}]::run_status[]`;

/** The `workers` row `alias` is connected now — the Workers screen's `online`. */
const connectedSql = (alias: string): string =>
  `(${alias}.last_seen_at is not null
     and ${alias}.last_seen_at > now() - make_interval(secs => ${WORKER_CONNECTED_SECONDS}))`;

/** The `workers` row `alias` is paused — by its owner, or by a usage limit still ahead. */
const pausedSql = (alias: string): string =>
  `(${alias}.manually_paused_at is not null
     or (${alias}.paused_until is not null and ${alias}.paused_until > now()))`;

/** The server claimant takes offer `o` now. */
const SERVER_TAKES = `(exists (select 1 from server_claimants sc where sc.expires_at > now())
     and ${pipelineAdapters.serverEligibleSql('now()')})`;

/**
 * A connected machine's automatic claim takes offer `o` now: the claim's eligibility, project list
 * and policy, over the digests the row holds (`wk`) and the core's (`cd`). `wk` names none of the
 * fragments' own aliases.
 */
const WORKER_TAKES = `exists (
     select 1 from workers wk
      where wk.revoked_at is null
        and ${connectedSql('wk')}
        and ${pipelineAdapters.workerEligibleSql({
          now: 'now()',
          worker: 'wk.id',
          held: 'array(select jsonb_array_elements_text(wk.image_digests))',
          run: 'cd.run',
          egress: 'cd.egress',
        })}
        and ${pipelineAdapters.workerScopeTakesSql('wk.id')}
        and ${pipelineAdapters.workerPolicyTakesSql('wk.id')})`;

/**
 * The person offer `o` is "mine" of (`offerIsMineSql`'s rule): an ask's asker — the ask the run
 * names (`runs.ask_id`), or the one whose `run_id` is this run, for an ask run before 0082 — and a
 * stage's task owner.
 */
const PERSON_OF_OFFER = `(case when o.kind = 'ask'
       then (select ma.asked_by_user_id from task_asks ma
              where ma.id = r.ask_id or ma.run_id = o.run_id
              order by (ma.id = r.ask_id) desc nulls last, ma.id
              limit 1)
       else t.owner_user_id end)`;

/** The person's machines, each: does it take the project's runs by itself, only by a pick, and how. */
const PERSON_MACHINES = `(
  select count(*) filter (where f.here and f.policy_takes)::int as takers,
         coalesce(bool_or(f.here and not f.policy_takes), false) as pick_only,
         coalesce(bool_or(f.here and f.policy_takes and f.connected and not f.paused), false) as ready,
         coalesce(bool_or(f.here and f.policy_takes and f.connected and f.paused), false) as paused,
         max(f.last_seen_at) filter (where f.here and f.policy_takes) as last_seen_at
    from (select pw.last_seen_at,
                 (${pipelineAdapters.userMayRunInProjectSql('pw.user_id', 'o.project_id')}
                  and ${pipelineAdapters.projectListTakesSql('pw', 'o.project_id')}) as here,
                 ${pipelineAdapters.workerPolicyTakesSql('pw.id')} as policy_takes,
                 ${connectedSql('pw')} as connected,
                 ${pausedSql('pw')} as paused
            from workers pw
           where pw.user_id = person.user_id and pw.revoked_at is null) f)`;

interface WaitingRow extends Record<string, unknown> {
  readonly run_id: string;
  readonly task_id: string;
  readonly server_takes: boolean;
  readonly worker_takes: boolean;
  readonly person_id: string | null;
  readonly person_name: string | null;
  readonly held_elsewhere: boolean;
  readonly assignee_name: string | null;
  readonly takers: number | null;
  readonly pick_only: boolean | null;
  readonly ready: boolean | null;
  readonly paused: boolean | null;
  readonly last_seen_at: Date | string | null;
}

const isoOf = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

export const factsOf = (row: WaitingRow): OfferWaitingFacts => ({
  serverTakes: row.server_takes === true,
  workerTakes: row.worker_takes === true,
  person: row.person_id === null ? null : { userId: row.person_id, name: row.person_name ?? '' },
  heldElsewhere: row.held_elsewhere === true,
  assigneeName: row.assignee_name ?? null,
  takers: Number(row.takers ?? 0),
  pickOnly: row.pick_only === true,
  takerReady: row.ready === true,
  takerPaused: row.paused === true,
  takersLastSeenAt: isoOf(row.last_seen_at ?? null),
});

/** The statement, over the open offers of live runs that `filter` selects. */
const waitingRows = async (
  database: Pick<Database, 'execute'>,
  filter: SQL,
  coreDigests: RunImageDigests | null,
): Promise<readonly WaitingRow[]> => {
  const { rows } = await database.execute<WaitingRow>(sql`
    select o.run_id, o.task_id,
           ${sql.raw(SERVER_TAKES)} as server_takes,
           ${sql.raw(WORKER_TAKES)} as worker_takes,
           person.user_id as person_id, coalesce(pu.name, '') as person_name,
           (o.kind = 'stage' and t.owner_user_id is null
            and ${sql.raw(pipelineAdapters.taskHeldElsewhereSql('t'))}) as held_elsewhere,
           t.ticket_assignee ->> 'display_name' as assignee_name,
           pm.takers, pm.pick_only, pm.ready, pm.paused, pm.last_seen_at
      from run_offers o
      join runs r on r.id = o.run_id
      join tasks t on t.id = o.task_id
      cross join (select ${coreDigests?.run ?? null}::text as run,
                         ${coreDigests?.egress ?? null}::text as egress) cd
      cross join lateral (select ${sql.raw(PERSON_OF_OFFER)} as user_id) person
      left join users pu on pu.id = person.user_id
      left join lateral ${sql.raw(PERSON_MACHINES)} pm on true
     where o.state = 'open'
       and r.status = any(${sql.raw(ACTIVE_STATUSES)})
       and ${filter}`);
  return rows;
};

const uuidList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/** `waiting` for each of `runIds` that has an open offer (the Agents rows); absent: none. */
export const waitingForRuns = async (
  database: Pick<Database, 'execute'>,
  runIds: readonly string[],
  coreDigests: RunImageDigests | null,
): Promise<ReadonlyMap<string, OfferWaiting>> => {
  if (runIds.length === 0) {
    return new Map();
  }
  const rows = await waitingRows(database, sql`o.run_id in (${uuidList(runIds)})`, coreDigests);
  return new Map(rows.map((row) => [row.run_id, offerWaitingOf(factsOf(row))]));
};

/**
 * `waiting` for each of `taskIds` whose current stage has an open offer (the task DTO, the board's
 * page) — a **stage** offer; at most one is live per task (`run_offers_one_live_stage_per_task`).
 * An ask's offer is the Agents row's, not the task's. Absent: nothing waits.
 */
export const waitingForTasks = async (
  database: Pick<Database, 'execute'>,
  taskIds: readonly string[],
  coreDigests: RunImageDigests | null,
): Promise<ReadonlyMap<string, OfferWaiting>> => {
  if (taskIds.length === 0) {
    return new Map();
  }
  const rows = await waitingRows(
    database,
    sql`o.kind = 'stage' and o.task_id in (${uuidList(taskIds)})`,
    coreDigests,
  );
  return new Map(rows.map((row) => [row.task_id, offerWaitingOf(factsOf(row))]));
};

/**
 * **Whether anybody else takes the project's unassigned tasks by themselves** (S-26.5 criterion 5,
 * the M26 UX spec §1's consequence line) — the execution read's `others_take_unassigned`: the
 * server claimant is running and the project's mode is not `workers_only`, or the mode is not
 * `server_only`, the run credential lets workers in (`remoteRunCredentialRefusedSql`), and a machine
 * of **another** user than `readerUserId` is not revoked, its user may act (`USER_MAY_ACT_SQL`) and
 * run here (`userMayRunInProjectSql`), its project list takes the project (`projectListTakesSql`)
 * and its policy (`effectiveClaimPolicySql`) is `everything` or `mine_and_unassigned` — the
 * policies whose claim admits an unassigned task. Connected or not: it answers the setting, not
 * this minute. No machine is named.
 */
export const othersTakeUnassigned = async (
  database: Pick<Database, 'execute'>,
  projectId: string,
  readerUserId: string,
): Promise<boolean> => {
  const { rows } = await database.execute<{ others: boolean }>(sql`
    select (
      (exists (select 1 from server_claimants sc where sc.expires_at > now())
         and coalesce(s.mode, ${DEFAULT_EXECUTION_MODE}) <> 'workers_only')
      or (coalesce(s.mode, ${DEFAULT_EXECUTION_MODE}) <> 'server_only'
          and not ${sql.raw(pipelineAdapters.remoteRunCredentialRefusedSql('p.id'))}
          and exists (
            select 1 from workers w join users u on u.id = w.user_id
             where w.revoked_at is null
               and w.user_id <> ${readerUserId}::uuid
               and ${sql.raw(pipelineAdapters.USER_MAY_ACT_SQL)}
               and ${sql.raw(pipelineAdapters.userMayRunInProjectSql('w.user_id', 'p.id'))}
               and ${sql.raw(pipelineAdapters.projectListTakesSql('w', 'p.id'))}
               and ${sql.raw(pipelineAdapters.effectiveClaimPolicySql('w'))}
                   in ('everything', 'mine_and_unassigned')))
    ) as others
      from projects p
      left join project_execution_settings s on s.project_id = p.id
     where p.id = ${projectId}::uuid`);
  return rows[0]?.others === true;
};
