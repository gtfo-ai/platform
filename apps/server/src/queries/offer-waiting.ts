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
 * or an ask's asker (`offerIsMineSql`'s rule) — and each of their machines (not revoked) is given a
 * reason of its own ({@link machineWaitingOf}): one whose user may not run in the project or whose
 * project list leaves it out is `owner_no_worker`; otherwise the Workers screen's own blockers
 * (`coreClaimBlockersOf`, the function `claim_blockers` is) decide, by {@link reasonOfBlockers}.
 * The person's reason is the machine reason nearest to taking the run (`owner_worker_cannot_take`,
 * then `owner_worker_paused`, `owner_worker_offline`, `owner_pick_only`, `owner_no_worker`; none
 * at all is `owner_no_worker`), with the newest contact of the offline ones and the blockers of the
 * ones that cannot take it. With no such person, a task **held elsewhere** (`taskHeldElsewhereSql`,
 * the claim's fragment) is `assignee_not_linked` and any other — a task a linked member released
 * included, since it is unassigned — `no_taker`.
 *
 * **One statement per page**: the reads take every run or task id of the answer at once.
 */
import {
  type Id,
  type OfferWaiting,
  type OfferWaitingReason,
  orderClaimBlockers,
  type WorkerClaimBlocker,
} from '@platform/contracts';
import {
  ACTIVE_RUN_STATUSES,
  coreClaimBlockersOf,
  DEFAULT_EXECUTION_MODE,
  type RunImageDigests,
} from '@platform/domain';
import { pipeline as pipelineAdapters } from '@platform/infrastructure';
import { type SQL, sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';
import { holdOf, WORKER_CONNECTED_SECONDS } from './worker-queries.js';

/** One of the person's machines (not revoked), as the claim facts the Workers screen reads. */
export interface WaitingMachineFacts {
  /** Its user may run in the project and its project list takes it. */
  readonly here: boolean;
  /** Its claim policy admits this offer (`workerPolicyTakesSql`); `false` is *pick only*. */
  readonly policyTakes: boolean;
  /** Its user is not disabled and under no ban in force (`USER_MAY_ACT_SQL`). */
  readonly ownerMayAct: boolean;
  /** Seen within the online window, on the database's clock. */
  readonly online: boolean;
  readonly protocolVersion: number | null;
  /** The owner's hold: `paused`, a drain's, or none (`holdOf`). */
  readonly hold: 'paused' | 'draining' | null;
  /** A usage limit's pause still ahead. */
  readonly usagePaused: boolean;
  readonly heldDigests: readonly string[];
  readonly lastSeenAt: string | null;
}

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
  /** The person's machines (not revoked). */
  readonly machines: readonly WaitingMachineFacts[];
  /** The core's current run and egress digests, or `null` while it cannot name them. */
  readonly coreDigests: RunImageDigests | null;
}

/**
 * The blockers `owner_worker_cannot_take` may carry: the core-known ones that are not a reason of
 * their own. The local-only ones (`not_set_up`, `claude_rejected`, `launcher_unreachable`) never
 * come from the core's half.
 */
export const CANNOT_TAKE_BLOCKERS: ReadonlySet<WorkerClaimBlocker> = new Set<WorkerClaimBlocker>([
  'protocol_outdated',
  'platform_images_unresolved',
  'draining',
  'usage_limited',
  'images_missing',
  'images_outdated',
]);

/** A machine's reason and, for `owner_worker_cannot_take`, the blockers that explain it. */
export interface MachineWaiting {
  readonly reason: Extract<OfferWaitingReason, `owner_${string}`>;
  readonly blockers: readonly WorkerClaimBlocker[];
}

/**
 * **The mapping from a machine's blockers to its reason** — the one place it is decided, pinned by
 * `offer-waiting.test.ts`: `revoked`, `owner_disabled` and `no_eligible_project` are
 * `owner_no_worker`; then `pick_only` (the owner's choice outranks a state) is `owner_pick_only`;
 * otherwise the first in the vocabulary's order decides — `offline` is `owner_worker_offline`,
 * `paused` is `owner_worker_paused`, and any of {@link CANNOT_TAKE_BLOCKERS} is
 * `owner_worker_cannot_take` carrying those of them it has. No blocker at all on a machine that
 * still did not take the run (its exclusion from the offer, a head start, the project's mode or
 * run credential) is `owner_worker_cannot_take` with none: the execution read names the rest.
 */
export const reasonOfBlockers = (blockers: readonly WorkerClaimBlocker[]): MachineWaiting => {
  if (
    blockers.some((b) => b === 'revoked' || b === 'owner_disabled' || b === 'no_eligible_project')
  ) {
    return { reason: 'owner_no_worker', blockers: [] };
  }
  if (blockers.includes('pick_only')) {
    return { reason: 'owner_pick_only', blockers: [] };
  }
  const first = orderClaimBlockers(blockers).find(
    (b) => b === 'offline' || b === 'paused' || CANNOT_TAKE_BLOCKERS.has(b),
  );
  if (first === 'offline') return { reason: 'owner_worker_offline', blockers: [] };
  if (first === 'paused') return { reason: 'owner_worker_paused', blockers: [] };
  return {
    reason: 'owner_worker_cannot_take',
    blockers: orderClaimBlockers(blockers.filter((b) => CANNOT_TAKE_BLOCKERS.has(b))),
  };
};

/** One machine's reason: not here is no machine for the project; else its claim blockers decide. */
export const machineWaitingOf = (
  machine: WaitingMachineFacts,
  coreDigests: RunImageDigests | null,
): MachineWaiting =>
  !machine.here
    ? { reason: 'owner_no_worker', blockers: [] }
    : reasonOfBlockers(
        coreClaimBlockersOf({
          revoked: false,
          ownerMayAct: machine.ownerMayAct,
          online: machine.online,
          protocolVersion: machine.protocolVersion,
          hold: machine.hold,
          usagePaused: machine.usagePaused,
          heldDigests: machine.heldDigests,
          coreDigests,
          // This project's question is `here`; the worker's count of projects is not asked.
          eligibleProjects: null,
          pickOnly: !machine.policyTakes,
        }),
      );

/** The person's reasons, nearest to taking the run first. */
const MACHINE_REASON_RANK: readonly MachineWaiting['reason'][] = [
  'owner_worker_cannot_take',
  'owner_worker_paused',
  'owner_worker_offline',
  'owner_pick_only',
  'owner_no_worker',
];

/**
 * The reason, or `null` when somebody can take the offer now. Pure, and the only place a fact
 * becomes a key: every value it returns is one of the contract's `OFFER_WAITING_REASONS`.
 */
export const waitingReasonOf = (facts: OfferWaitingFacts): OfferWaitingReason | null =>
  personWaitingOf(facts)?.reason ?? null;

interface PersonWaiting {
  readonly reason: OfferWaitingReason;
  readonly blockers: readonly WorkerClaimBlocker[];
  readonly lastSeenAt: string | null;
}

const personWaitingOf = (facts: OfferWaitingFacts): PersonWaiting | null => {
  if (facts.serverTakes || facts.workerTakes) {
    return null;
  }
  if (facts.person === null) {
    return {
      reason: facts.heldElsewhere ? 'assignee_not_linked' : 'no_taker',
      blockers: [],
      lastSeenAt: null,
    };
  }
  const each = facts.machines.map((machine) => ({
    machine,
    waiting: machineWaitingOf(machine, facts.coreDigests),
  }));
  const reason =
    MACHINE_REASON_RANK.find((rank) => each.some((entry) => entry.waiting.reason === rank)) ??
    'owner_no_worker';
  const chosen = each.filter((entry) => entry.waiting.reason === reason);
  const seen = chosen
    .map((entry) => entry.machine.lastSeenAt)
    .filter((value): value is string => value !== null)
    .sort();
  return {
    reason,
    blockers: orderClaimBlockers(chosen.flatMap((entry) => entry.waiting.blockers)),
    lastSeenAt: reason === 'owner_worker_offline' ? (seen.at(-1) ?? null) : null,
  };
};

/** The DTO's `waiting`: the reason, and the one person, instant, name or blockers it is about. */
export const offerWaitingOf = (facts: OfferWaitingFacts): OfferWaiting => {
  const waiting = personWaitingOf(facts);
  const reason = waiting?.reason ?? null;
  const aboutPerson = reason?.startsWith('owner_') === true;
  return {
    reason,
    user:
      aboutPerson && facts.person !== null
        ? { user_id: facts.person.userId as Id, name: facts.person.name }
        : null,
    last_seen_at: reason === 'owner_worker_offline' ? (waiting?.lastSeenAt ?? null) : null,
    assignee_name: reason === 'assignee_not_linked' ? facts.assigneeName : null,
    blockers: reason === 'owner_worker_cannot_take' ? [...(waiting?.blockers ?? [])] : [],
  };
};

/** The live run statuses as a literal array — a closed set of enum literals. */
const ACTIVE_STATUSES = `array[${ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(', ')}]::run_status[]`;

/** The `workers` row `alias` is connected now — the Workers screen's `online`. */
const connectedSql = (alias: string): string =>
  `(${alias}.last_seen_at is not null
     and ${alias}.last_seen_at > now() - make_interval(secs => ${WORKER_CONNECTED_SECONDS}))`;

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

/**
 * The person's machines (not revoked), each as the claim facts the Workers screen reads
 * (`worker-queries.ts`'s `CLAIM_FACTS_OF_WORKER_ROW`: the online window, `USER_MAY_ACT_SQL`, the
 * newest `worker.pause` row's `via`, a usage pause still ahead) and whether it is **here** — its
 * user may run in the project and its project list takes it — and its policy admits the offer.
 */
const PERSON_MACHINES = `coalesce((
  select json_agg(json_build_object(
           'here', (${pipelineAdapters.userMayRunInProjectSql('pw.user_id', 'o.project_id')}
                    and ${pipelineAdapters.projectListTakesSql('pw', 'o.project_id')}),
           'policy_takes', ${pipelineAdapters.workerPolicyTakesSql('pw.id')},
           'owner_may_act', ${pipelineAdapters.USER_MAY_ACT_SQL},
           'online', ${connectedSql('pw')},
           'protocol_version', pw.protocol_version,
           'manually_paused', pw.manually_paused_at is not null,
           'hold_via', case when pw.manually_paused_at is null then null
                            else (select h.params ->> 'via'
                                    from human_actions h
                                   where h.action = 'worker.pause'
                                     and h.params ->> 'worker_id' = pw.id::text
                                   order by h.created_at desc, h.id desc
                                   limit 1) end,
           'usage_paused', (pw.paused_until is not null and pw.paused_until > now()),
           'held', pw.image_digests,
           'last_seen_at', pw.last_seen_at) order by pw.id)
    from workers pw
    join users u on u.id = pw.user_id
   where pw.user_id = person.user_id and pw.revoked_at is null), '[]'::json)`;

interface MachineRow {
  readonly here: boolean;
  readonly policy_takes: boolean;
  readonly owner_may_act: boolean;
  readonly online: boolean;
  readonly protocol_version: number | null;
  readonly manually_paused: boolean;
  readonly hold_via: string | null;
  readonly usage_paused: boolean;
  readonly held: unknown;
  readonly last_seen_at: string | null;
}

interface WaitingRow extends Record<string, unknown> {
  readonly run_id: string;
  readonly task_id: string;
  readonly server_takes: boolean;
  readonly worker_takes: boolean;
  readonly person_id: string | null;
  readonly person_name: string | null;
  readonly held_elsewhere: boolean;
  readonly assignee_name: string | null;
  readonly machines: readonly MachineRow[];
}

const isoOf = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const machineFactsOf = (row: MachineRow): WaitingMachineFacts => ({
  here: row.here === true,
  policyTakes: row.policy_takes === true,
  ownerMayAct: row.owner_may_act === true,
  online: row.online === true,
  protocolVersion: row.protocol_version ?? null,
  hold: holdOf(row.manually_paused === true, row.hold_via ?? null),
  usagePaused: row.usage_paused === true,
  heldDigests: Array.isArray(row.held)
    ? row.held.filter((digest): digest is string => typeof digest === 'string')
    : [],
  lastSeenAt: isoOf(row.last_seen_at ?? null),
});

export const factsOf = (
  row: WaitingRow,
  coreDigests: RunImageDigests | null,
): OfferWaitingFacts => ({
  serverTakes: row.server_takes === true,
  workerTakes: row.worker_takes === true,
  person: row.person_id === null ? null : { userId: row.person_id, name: row.person_name ?? '' },
  heldElsewhere: row.held_elsewhere === true,
  assigneeName: row.assignee_name ?? null,
  machines: (row.person_id === null ? [] : (row.machines ?? [])).map(machineFactsOf),
  coreDigests,
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
           ${sql.raw(PERSON_MACHINES)} as machines
      from run_offers o
      join runs r on r.id = o.run_id
      join tasks t on t.id = o.task_id
      cross join (select ${coreDigests?.run ?? null}::text as run,
                         ${coreDigests?.egress ?? null}::text as egress) cd
      cross join lateral (select ${sql.raw(PERSON_OF_OFFER)} as user_id) person
      left join users pu on pu.id = person.user_id
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
  return new Map(rows.map((row) => [row.run_id, offerWaitingOf(factsOf(row, coreDigests))]));
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
  return new Map(rows.map((row) => [row.task_id, offerWaitingOf(factsOf(row, coreDigests))]));
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
