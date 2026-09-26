/**
 * The run credential nothing confirmed revoked — PROGRESS backlog **155**, WP-77, a row of
 * `./stranded.ts`'s table.
 *
 * ## What is wrong without this
 *
 * A run's git credential (push for a writing run, read otherwise) is minted by the runner and
 * revoked by it once, after the workspace is released (TD-028's WP-76 amendment, decision 5). Two
 * things leave it live after its run is over, and before WP-77 nothing ever looked at either:
 *
 *  - **the runner died between mint and revoke** — `./run-lease.ts` ends the run's row, and a row
 *    ending revokes nothing;
 *  - **the revoke failed at teardown** — a provider `5xx`, a network error — and the provisioner's
 *    `onceRevoker` logs it and, rightly, never retries in-process.
 *
 * GitLab grants a 24-hour request to midnight UTC on or after it, so either leaves a token live for
 * **24 to 48 hours** — a push token can push to every unprotected branch of the project — for
 * exactly the runs that ended badly. The address that would revoke it — `revoke_id`, `<project>#<token_id>` — is on the
 * mint's audit row (standing rule 19); this is its reader.
 *
 * ## What it looks for, and what bounds it
 *
 * A **terminal** run that ended more than a pass interval ago (its own teardown has had the time to
 * revoke), with a `mint_credential` row that carries a `revoke_id` and an expiry still in the
 * future, and **no** `revoke_credential` row for the same `revoke_id` that is either
 *
 *  - a **success** — `ok` with `revoked: true`, the only reading of a revoke that counts it done
 *    (WP-76 review round 2; Q98 (a)); or
 *  - **this row's own attempt**, whatever it says — the payload's `origin: 'recovery'`.
 *
 * The second clause is the bound, and it is the audit row the attempt writes, not a mark of its
 * own: every attempt goes through `IntegrationActionExecutor`, which writes its row on success and
 * on failure alike, so *one attempt per `revoke_id`* is a fact of `integration_actions`. A
 * `not_found` is recorded as **unconfirmed** in that row — `revoked: false` — and is never
 * retried: the adapter asking is by construction one that did not mint the handle, so "no such
 * token" cannot be told from "already gone", and asking again would get the same answer.
 *
 * The read is driven from `runs` (a partial index on `ended_at`, migration 0039) into
 * `integration_actions` through its `(task_id, created_at)` index, so a pass costs the runs that
 * ended inside the credential's longest lifetime rather than the audit table's size. The horizon is
 * that lifetime — the requested TTL plus GitLab's rounding to the next midnight — and the mint's own
 * recorded `expires_at` is the precise cut inside it: a token that expired needs nobody.
 *
 * ## Where the call happens: a job enqueued after the finding commits
 *
 * The pass's reads are one transaction (`./stranded.ts`); the revoke is a provider call, so it
 * leaves through `pipeline.outbound` — WP-15d's shape, a duty per credential enqueued **after**
 * that transaction commits, which `assertOutsideTransaction` inside `runCredentialWrites().recover`
 * refuses to break. The duty **re-validates on fire** with the same predicate for its one address
 * (TD-004: a job is a wake-up, not a message), so a wake-up enqueued twice — a pass that ran again
 * before the first job was taken — finds the first attempt's row and does nothing.
 *
 * **The residual, stated rather than implied.** Re-validation is a read followed by a call, not a
 * claim. Two copies of one wake-up taken *at the same moment* by two processes that both serve
 * `pipeline.outbound` both find no row, and both ask. The second `DELETE` reaches a token the first
 * already removed, is answered `404` and is recorded `unconfirmed` — a second row, a second
 * provider call, **no** claim of a revocation that did not happen. It needs the queue to be a whole
 * pass interval behind *and* two consumers; a claim column would close it at the cost of a mark the
 * row's bound is meant not to need.
 *
 * ## What it does not reach
 *
 *  - a credential minted through a git binding the project is **no longer bound to**: the finding
 *    query requires the mint's `integration_id` to be the project's git binding still, because a
 *    `revoke_id` is an address on that binding's host and no other binding may be sent it. Such a
 *    token lives to its expiry, and nothing but this sentence says so (PROGRESS backlog 156);
 *  - a mint whose response was lost (TD-028's residual): no `revoke_id` was ever recorded;
 *  - a run that is **not terminal**: a live run's credential is its runner's. The lease sweep ends a
 *    run nobody is renewing, and the pass after that reaches its credential here — which, for a
 *    runner that was only **partitioned** from the database, cuts its credential while it may still
 *    be working: `./run-lease.ts` states that consequence. A **cancelled** run is the other terminal
 *    row whose session may still be running (`cancelRunCommand` ends the row, not the session): about
 *    one pass interval after the cancel its token is revoked here, which is the safe direction, and
 *    the session's own teardown revoke then answers `not_found` and logs a failure for a token that is
 *    already gone; a take-over export after a cancel pushes with a revoked token and fails (WP-77
 *    review round 1, read, not measured).
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  integrationsForProject,
  noRunScopedSecrets,
  type PipelineIntegrationsPort,
  type RecoverableRunCredential,
  type RunCredentialRecovery,
  runCredentialWrites,
} from '../pipeline/integrations.js';
import type { PipelineOutboundData } from '../pipeline/jobs.js';
import type { Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** The pass's bounds, computed once per pass. */
export interface UnrevokedRunCredentialQuery {
  /** A run that ended after this still has its own teardown revoke in flight — `now - grace`. */
  readonly endedBefore: IsoDateTime;
  /** A run that ended before this cannot hold a live credential — `now - horizon`. */
  readonly endedAfter: IsoDateTime;
  /** A credential whose recorded expiry is at or before this is already dead. */
  readonly now: IsoDateTime;
  readonly limit: number;
}

export interface UnrevokedRunCredentialStore {
  /** Every credential the module docblock's predicate finds, oldest run ending first. */
  unrevokedRunCredentials(
    tx: Transaction,
    query: UnrevokedRunCredentialQuery,
  ): Promise<readonly RecoverableRunCredential[]>;
  /**
   * The same predicate for **one** address, without the run window — the duty's re-validation on
   * fire. `null` when it was revoked, attempted or has expired since the pass read it.
   */
  unrevokedRunCredential(
    tx: Transaction,
    input: { readonly runId: Id; readonly revokeId: string; readonly now: IsoDateTime },
  ): Promise<RecoverableRunCredential | null>;
}

/**
 * GitLab's rounding: `expires_at` is a **date**, and the token dies at midnight UTC on it, so a
 * credential lives up to one day longer than it was asked to (`gitlab/credentials.ts`,
 * `expiryForTtl`).
 */
const PROVIDER_EXPIRY_ROUNDING_MS = 24 * 60 * 60_000;

/**
 * How far back a run's ending can be and its credential still be live: the requested TTL plus the
 * provider's rounding. The mint happens before the run ends, so a run that ended earlier than this
 * holds a credential that has expired whatever the provider did.
 */
export const runCredentialRecoveryHorizonMs = (ttlSeconds: number): number =>
  ttlSeconds * 1000 + PROVIDER_EXPIRY_ROUNDING_MS;

/** The site's collaborators, as `./stranded.ts` takes them. */
export interface RunCredentialRecoverySite {
  readonly store: UnrevokedRunCredentialStore;
  /** {@link runCredentialRecoveryHorizonMs} of the TTL the composition mints with. */
  readonly horizonMs: number;
}

export const unrevokedRunCredentialQuery = (input: {
  readonly now: IsoDateTime;
  readonly graceMs: number;
  readonly horizonMs: number;
  readonly limit: number;
}): UnrevokedRunCredentialQuery => {
  const at = Date.parse(input.now);
  return {
    endedBefore: new Date(at - Math.max(0, input.graceMs)).toISOString() as IsoDateTime,
    endedAfter: new Date(at - Math.max(0, input.horizonMs)).toISOString() as IsoDateTime,
    now: input.now,
    limit: input.limit,
  };
};

/**
 * The wake-up for one address. `cause_event_id` is the **run** id, as the ask executor's is: no
 * event caused this — a pass found a row — and the field is the job's correlation, not a claim.
 */
export const enqueueRunCredentialRevocation = async (
  jobs: Jobs,
  credential: RecoverableRunCredential,
): Promise<void> => {
  const data: PipelineOutboundData = {
    duty: 'revoke_run_credential',
    project_id: credential.projectId,
    task_id: credential.taskId,
    run_id: credential.runId,
    revoke_id: credential.revokeId,
    cause_event_id: credential.runId,
  };
  await jobs.enqueue<PipelineOutboundData>({ queue: JOB_QUEUES.pipelineOutbound, data });
};

export interface RunCredentialRevocationOptions {
  readonly unitOfWork: UnitOfWork;
  readonly integrations: PipelineIntegrationsPort;
  readonly clock: { now(): string };
  /**
   * Where the duty re-validates. **Absent is a refusal, logged**, never a revoke without the
   * check: a composition that did not wire it has no way to know the attempt was already spent.
   */
  readonly runCredentials?: UnrevokedRunCredentialStore;
  readonly logger?: Logger;
}

/**
 * The `revoke_run_credential` duty: re-validate, then one revoke by address through the executor.
 *
 * It never throws for the revoke's own outcome. The job's retry would be a second attempt, which
 * the row's bound forbids; the attempt's audit row is already written, so the next pass does not
 * find this address again. What it throws for is what happens **before** the executor — the binding
 * failed to load — which wrote no row, so the retry, and the next pass after it, are still inside
 * the bound.
 */
export const runRunCredentialRevocation = async (
  options: RunCredentialRevocationOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const runId = data['run_id'];
  const revokeId = data['revoke_id'];
  if (typeof runId !== 'string' || typeof revokeId !== 'string') {
    logger.error(
      { duty: data.duty, project_id: data.project_id },
      'a run-credential revocation wake-up named no run or no address; nothing was revoked (PROGRESS backlog 155)',
    );
    return;
  }
  if (options.runCredentials === undefined) {
    logger.error(
      { run_id: runId, project_id: data.project_id },
      'this process was composed without the run-credential store, so it cannot tell whether this credential was already revoked and asks nobody; the next pass re-enqueues it (PROGRESS backlog 155)',
    );
    return;
  }
  const store = options.runCredentials;
  const now = options.clock.now() as IsoDateTime;
  const credential = await options.unitOfWork.transaction(async (scope) =>
    store.unrevokedRunCredential(scope.tx, { runId: runId as Id, revokeId, now }),
  );
  if (credential === null) {
    return;
  }
  const integrations = await integrationsForProject(
    options.integrations,
    credential.projectId,
    noRunScopedSecrets(),
  );
  const fields = {
    project_id: credential.projectId,
    task_id: credential.taskId,
    run_id: credential.runId,
    scope: credential.scope,
    expires_at: credential.expiresAt,
  };
  let outcome: RunCredentialRecovery;
  try {
    outcome = await runCredentialWrites(integrations).recover(credential);
  } catch (error) {
    logger.error(
      { ...fields, err: error },
      'the recovery pass could not revoke a run credential nothing had confirmed revoked, so the token is live until it expires — revoke it by hand in the provider (PROGRESS backlog 155)',
    );
    return;
  }
  if (outcome === 'revoked') {
    logger.warn(
      fields,
      'a run credential nothing had confirmed revoked — its runner died, or its teardown revoke failed — was revoked by the recovery pass (PROGRESS backlog 155)',
    );
    return;
  }
  logger.error(
    fields,
    'the provider says it has no such credential, which from a process that did not mint it cannot be told from "already revoked": recorded as unconfirmed, never as revoked; check the project\'s access tokens (PROGRESS backlog 155)',
  );
};
