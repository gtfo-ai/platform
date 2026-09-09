/**
 * `ROLE` — one image, several workloads (technical/01 § Containers, TD-002).
 *
 * The same container runs the HTTP API, the event dispatcher and pg-boss workers, the agent runner
 * and the knowledge indexer. `ROLE=all` runs everything, which is the single-process default a
 * self-hoster gets; splitting the roles across containers is the first step of technical/01's
 * scaling path and changes nothing but this variable.
 *
 * Two properties matter more than the table itself:
 *
 * - **Every role serves the ops endpoints.** `/healthz`, `/readyz`, `/metrics` and `/api/version`
 *   are how an orchestrator and Prometheus see a container at all, so a worker container that
 *   served nothing would be a container nothing could observe. The *API* surface — auth, `/api/*`,
 *   `/events` — is what `api` gates.
 * - **A role whose workload does not exist yet says so.** `runner` and `indexer` are named by
 *   technical/01 but their workloads land in WP-12 and WP-16. Rather than quietly starting a
 *   process that does nothing, `roleCapabilities` reports them as unimplemented and the composition
 *   root logs a warning naming the work package. A container that looks healthy and does no work is
 *   the failure mode this avoids.
 */

export const ROLES = ['all', 'api', 'worker', 'runner', 'indexer'] as const;

export type Role = (typeof ROLES)[number];

export interface RoleCapabilities {
  /** Serve the authenticated API: Better Auth, `/api/*`, and the SSE stream. */
  readonly api: boolean;
  /** Run the outbox sweep, the event dispatcher, pg-boss workers and the maintenance cron. */
  readonly worker: boolean;
  /** Execute agent runs (WP-12). */
  readonly runner: boolean;
  /** Build the knowledge index and code map (WP-16). */
  readonly indexer: boolean;
  /**
   * Work this role is supposed to do that no work package has built yet, as
   * `<capability> (<WP>)`. Empty for a role that is fully implemented.
   */
  readonly unimplemented: readonly string[];
}

const CAPABILITIES: Record<Role, Omit<RoleCapabilities, 'unimplemented'>> = {
  all: { api: true, worker: true, runner: true, indexer: true },
  api: { api: true, worker: false, runner: false, indexer: false },
  worker: { api: false, worker: true, runner: false, indexer: false },
  runner: { api: false, worker: false, runner: true, indexer: false },
  indexer: { api: false, worker: false, runner: false, indexer: false },
};

/** Where each not-yet-built workload lands, so a warning can name it. */
const PENDING_WORK_PACKAGE = {
  runner: 'runner (WP-12: Claude SDK runner)',
  indexer: 'indexer (WP-16: knowledge index and code map)',
} as const;

export const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);

export const roleCapabilities = (role: Role): RoleCapabilities => {
  const base = CAPABILITIES[role];
  const unimplemented: string[] = [];
  if (base.runner) {
    unimplemented.push(PENDING_WORK_PACKAGE.runner);
  }
  // `indexer` has no capability flag of its own yet — nothing consumes one — so the role is
  // reported as wholly unimplemented rather than being given a flag that gates nothing.
  if (role === 'indexer' || role === 'all') {
    unimplemented.push(PENDING_WORK_PACKAGE.indexer);
  }
  return { ...base, unimplemented };
};

/**
 * True when the role has nothing to do in this build. `ROLE=indexer` today starts a process that
 * serves ops endpoints and waits — worth a warning, not a refusal: an operator splitting roles
 * ahead of the features landing should be able to write the compose file once.
 */
export const roleIsIdle = (role: Role): boolean => {
  const capabilities = roleCapabilities(role);
  return !capabilities.api && !capabilities.worker;
};
