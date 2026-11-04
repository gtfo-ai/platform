/**
 * **Where an offer may be claimed, and from when** — WP-278, TD-031 decision 8, BD-032 decisions 3
 * and 5. Pure: the offer's writer reads the project's execution settings, the assignee and whether
 * the instance has a server claimant, and this decides the four timestamps the offer carries.
 *
 * TD-031 §8, as written:
 *
 * > At offer creation the core computes the timestamps: with an **online** assignee worker
 * > `assignee_until = now + assignee_window`; then the preferred side's `*_from` = `assignee_until
 * > or now`, the other side's = that `+ fallback_after`; `server_only` sets `workers_from = null`,
 * > `workers_only` sets `server_from = null`. **A core with no claimant composed for the server**
 * > treats every project as `workers_only` at offer time and says so on the settings screen.
 *
 * Three readings this module makes, each stated where it is decided:
 *
 * 1. **`server_only` gives no head start**: no worker may claim, so an assignee window would only
 *    delay the server. `assignee_user_id` and `assignee_until` are `null` and `server_from` is now.
 * 2. **`server_only` is never widened** by a core with no server claimant: an administrator who
 *    chose it may have chosen it because the project's credential must not reach a developer's
 *    machine (Q124), and sending its runs to workers would override that. Its offers wait — the
 *    offer timeout bounds the wait — and the settings screen says so. This is what keeps
 *    *"`server_only` never sets `workers_from`"* (the row's property) unconditional.
 * 3. **A `hybrid` project with no server claimant opens to workers at the start and keeps its
 *    `server_from`**: workers do not wait a fallback for a server that is not there — which is
 *    what treating the project as `workers_only` means to a claimant — but `server_from` is still
 *    written as the preference decides, never `null`. A runner restarting for longer than a
 *    liveness window would otherwise leave every offer written meanwhile unclaimable by the runner
 *    when it returns; on today's installations, where the server is the only claimant, that would
 *    be every run until its offer times out. So a liveness read that is wrong can only let workers
 *    claim as early as the server, never keep the server from a run.
 */
import type { ExecutionMode, ExecutionPreference, Id, IsoDateTime } from '@platform/contracts';

/** TD-031 §8's defaults, in whole seconds. */
export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'hybrid';
export const DEFAULT_EXECUTION_PREFERENCE: ExecutionPreference = 'server';
export const DEFAULT_FALLBACK_AFTER_SECONDS: Readonly<Record<ExecutionPreference, number>> = {
  server: 15,
  workers: 300,
};
export const DEFAULT_ASSIGNEE_WINDOW_SECONDS = 120;
export const DEFAULT_OFFER_TIMEOUT_SECONDS = 86_400;

/** A project's execution settings (`project_execution_settings`, migration 0097). */
export interface ExecutionSettings {
  readonly mode: ExecutionMode;
  readonly prefer: ExecutionPreference;
  /** `null` is the default for {@link prefer}. */
  readonly fallbackAfterSeconds: number | null;
  readonly assigneeWindowSeconds: number;
  readonly offerTimeoutSeconds: number;
}

/** What a project with no stored row runs under. */
export const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = {
  mode: DEFAULT_EXECUTION_MODE,
  prefer: DEFAULT_EXECUTION_PREFERENCE,
  fallbackAfterSeconds: null,
  assigneeWindowSeconds: DEFAULT_ASSIGNEE_WINDOW_SECONDS,
  offerTimeoutSeconds: DEFAULT_OFFER_TIMEOUT_SECONDS,
};

/** The fallback the settings resolve to: the stored number, or the preference's default. */
export const effectiveFallbackAfterSeconds = (settings: ExecutionSettings): number =>
  settings.fallbackAfterSeconds ?? DEFAULT_FALLBACK_AFTER_SECONDS[settings.prefer];

export interface OfferRoutingInput {
  readonly settings: ExecutionSettings;
  readonly now: IsoDateTime;
  /**
   * The assignee's user when **a worker of theirs is online** (TD-031 §8: heartbeat in the last
   * 60 s, a member of the project, not paused) — for an ask, the asking user (§13). `null` when
   * there is no assignee or none of their workers is online.
   */
  readonly onlineAssigneeUserId: Id | null;
  /** Whether the instance has a server claimant running now (`server_claimants`). */
  readonly serverClaimant: boolean;
}

/** The offer's routing columns (`run_offers`, TD-031 decision 1). `null` `*_from` is *never*. */
export interface OfferRouting {
  readonly assigneeUserId: Id | null;
  readonly assigneeUntil: IsoDateTime | null;
  readonly serverFrom: IsoDateTime | null;
  readonly workersFrom: IsoDateTime | null;
  /** `offered_at + offer_timeout`: past it, an open offer is withdrawn and its task escalated. */
  readonly expiresAt: IsoDateTime;
}

const plusSeconds = (at: IsoDateTime, seconds: number): IsoDateTime =>
  new Date(Date.parse(at) + seconds * 1000).toISOString() as IsoDateTime;

/** TD-031 §8's computation, with this module's three readings (module docblock). */
export const routeOffer = (input: OfferRoutingInput): OfferRouting => {
  const { settings, now } = input;
  const expiresAt = plusSeconds(now, settings.offerTimeoutSeconds);
  if (settings.mode === 'server_only') {
    return {
      assigneeUserId: null,
      assigneeUntil: null,
      serverFrom: now,
      workersFrom: null,
      expiresAt,
    };
  }
  const headStart =
    input.onlineAssigneeUserId !== null && settings.assigneeWindowSeconds > 0
      ? plusSeconds(now, settings.assigneeWindowSeconds)
      : null;
  const start = headStart ?? now;
  const assignee = {
    assigneeUserId: headStart === null ? null : input.onlineAssigneeUserId,
    assigneeUntil: headStart,
  };
  if (settings.mode === 'workers_only') {
    return { ...assignee, serverFrom: null, workersFrom: start, expiresAt };
  }
  const later = plusSeconds(start, effectiveFallbackAfterSeconds(settings));
  const serverFirst = settings.prefer === 'server';
  return {
    ...assignee,
    serverFrom: serverFirst ? start : later,
    // Reading 3: with no server claimant, workers wait for nobody.
    workersFrom: serverFirst && input.serverClaimant ? later : start,
    expiresAt,
  };
};

/**
 * The sentence the settings screen shows for a project's mode on an instance with no server
 * claimant (TD-031 §8: *"says so on the settings screen"*), or `null` when nothing is unusual.
 */
export const executionNotice = (mode: ExecutionMode, serverClaimant: boolean): string | null => {
  if (serverClaimant) return null;
  switch (mode) {
    case 'server_only':
      return 'No server runner is running on this instance, so this project’s runs wait for one; an offer nobody takes before the offer timeout is withdrawn and its task escalated.';
    case 'hybrid':
      return 'No server runner is running on this instance, so this project is treated as workers only: workers may take its runs at once rather than after the fallback, and a server runner that starts takes them as the preference says.';
    case 'workers_only':
      return null;
  }
};
