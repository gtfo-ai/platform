/**
 * **An integration's words** (S-23.11a, S-25.3) — the Integrations screens, the add-integration
 * wizard and the project's connections.
 *
 * A module of its own since S-25.13: only lazy screens show these words, and `ui/humanize.ts` —
 * which the SPA's first paint imports — does **not** re-export them, because a re-export would put
 * them back in the initial graph (TD-013's budget, `bundle:check`). Screens import this module.
 */
import type { IntegrationSummary, IntegrationType } from '@platform/contracts';

/** What each kind of integration is, in the words of the person adding one. */
export const INTEGRATION_TYPE_LABEL: Readonly<Record<IntegrationType, string>> = {
  task_management: 'Ticket tracker',
  git: 'Git host',
  communication: 'Chat',
  logs: 'Logs',
  errors: 'Error tracker',
};

/** One line per kind: what connecting it does — the add-integration wizard's provider cards. */
export const INTEGRATION_TYPE_PURPOSE: Readonly<Record<IntegrationType, string>> = {
  task_management: 'Where tickets come from: the pipeline picks them up and moves their status.',
  git: 'Where the code lives: agents push branches and open merge requests there.',
  communication: 'Where questions, approvals and the daily digest are posted.',
  logs: 'Log search the agents may read while they investigate a bug.',
  errors: 'Error reports the agents may read while they investigate a bug.',
};

export type IntegrationHealth = IntegrationSummary['health']['status'];

/**
 * `integrations.health.status` — the last *Test connection*'s verdict, and only that: since S-25.3 an
 * integration's health is `current_health` (read from its traffic), and this is one dated fact on
 * its page. So the words are a test's — *Passed*, *Failed* — never *Healthy*, which a month-old
 * probe once claimed on the row. `unknown` is a connection nobody has tested.
 */
export const INTEGRATION_HEALTH_LABEL: Readonly<Record<IntegrationHealth, string>> = {
  ok: 'Passed',
  degraded: 'Passed with warnings',
  down: 'Failed',
  unknown: 'Never tested',
};

/**
 * The integrations list's groups, in the order product/08's 2026-11-06 amendment gives them: what
 * an integration does for a project (S-25.3). Every type appears exactly once (`humanize.test.ts`).
 */
export const INTEGRATION_ROLE_GROUPS: readonly {
  readonly type: IntegrationType;
  readonly label: string;
}[] = [
  { type: 'task_management', label: 'Tickets' },
  { type: 'git', label: 'Code & merge requests' },
  { type: 'communication', label: 'Chat' },
  { type: 'errors', label: 'Errors' },
  { type: 'logs', label: 'Logs' },
];

export type IntegrationCurrentHealthStatus = IntegrationSummary['current_health']['status'];

/**
 * `current_health.status` — what the platform knows about an integration **now**, from its traffic
 * (S-25.3). Never *Healthy* on a stale probe: that is *Not checked recently*.
 */
export const INTEGRATION_CURRENT_HEALTH_LABEL: Readonly<
  Record<IntegrationCurrentHealthStatus, string>
> = {
  working: 'Working',
  degraded: 'Some calls failing',
  failing: 'Failing',
  not_checked_recently: 'Not checked recently',
  never_checked: 'Never checked',
};
