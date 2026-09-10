/**
 * One Jira Cloud binding, composed the way the composition root will compose it: the adapter, an
 * `IntegrationActionExecutor` with a memory audit log, a virtual timer and a fixed clock, all in
 * front of the fixture-backed replay double.
 *
 * It lives beside the contract suite because two runners need it — the shared
 * `runTaskManagementContract` and the Jira-specific contract file — and because the *composition*
 * is part of what WP-08 has to get right: an adapter that reached a provider without going through
 * the executor would still pass a suite that only calls port methods.
 */
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  exactSecretRedactor,
  type IntegrationActionExecutor,
  type MemoryIntegrationAuditLog,
  noSecretsRedactor,
  type SecretRedactor,
  type TaskManagementPort,
  type VirtualTimer,
} from '@platform/application';
import type { Id, TaskMode } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import {
  createJiraCloudTaskManagement,
  JIRA_CLOUD_RATE_LIMIT_POLICY,
  type JiraCloudConfig,
} from '@platform/integrations';
import {
  createJiraReplay,
  JIRA_REPLAY_EMAIL,
  JIRA_REPLAY_NOW,
  JIRA_REPLAY_SECRET,
  JIRA_REPLAY_SITE,
  JIRA_REPLAY_TOKEN,
  type JiraReplay,
} from './jira-cloud-replay.js';

export const JIRA_INTEGRATION_ID: Id = '00000000-0000-4000-8000-00000000a108';
export const JIRA_PROJECT_ID: Id = '00000000-0000-4000-8000-00000000b108';
export const JIRA_TASK_ID: Id = '00000000-0000-4000-8000-00000000c108';
export const JIRA_PICKUP_LABEL = 'agentic';

export interface JiraBinding {
  readonly port: TaskManagementPort;
  readonly replay: JiraReplay;
  readonly audit: MemoryIntegrationAuditLog;
  readonly timer: VirtualTimer;
  readonly executor: IntegrationActionExecutor;
  /** Flipped by the shadow-mode tests; the adapter reads it at every call. */
  mode: TaskMode;
}

export interface JiraBindingOptions {
  /** Replaces the replay double's `fetch` — used by the credential-leak tests. */
  readonly fetch?: typeof globalThis.fetch;
  readonly config?: Partial<JiraCloudConfig>;
  readonly mode?: TaskMode;
  /**
   * The redactor the **executor** is composed with.
   *
   * Its default knows the binding's token, which is what a correct composition root does — and
   * exactly why a test of the *adapter's* own redaction has to pass `noSecretsRedactor()`: with
   * both in place, either one alone would satisfy an assertion about the text, and neither would
   * be proved (standing rule 9). `docs/TODO.md` records that nothing yet forces the root to build
   * the executor's redactor from a binding's secrets, so the adapter cannot rely on it.
   */
  readonly executorRedactor?: SecretRedactor;
}

export const jiraConfig = (overrides: Partial<JiraCloudConfig> = {}): JiraCloudConfig =>
  ({
    site_url: JIRA_REPLAY_SITE,
    user_email: JIRA_REPLAY_EMAIL,
    api_token: JIRA_REPLAY_TOKEN,
    webhook_secret: JIRA_REPLAY_SECRET,
    project_keys: ['ACME'],
    pickup_label: JIRA_PICKUP_LABEL,
    webhook_max_age_ms: 24 * 60 * 60 * 1000,
    request_timeout_ms: 20_000,
    ...overrides,
  }) as JiraCloudConfig;

export const createJiraBinding = (options: JiraBindingOptions = {}): JiraBinding => {
  const replay = createJiraReplay();
  const audit = createMemoryAuditLog();
  // `autoAdvance`: a sleep wakes itself on the next microtask, so backoff costs no wall time and
  // the assertion is on the delay that was *asked for* (`timer.sleeps`), never on elapsed time.
  const timer = createVirtualTimer({ autoAdvance: true });
  const clock = fixedClock(JIRA_REPLAY_NOW as `${string}T${string}`, 0);
  const executor = createIntegrationActionExecutor({
    auditLog: audit,
    // The binding's own token, so the executor's scrub is the real one and not a no-op.
    redactor:
      options.executorRedactor ??
      exactSecretRedactor([{ name: 'jira_api_token', value: JIRA_REPLAY_TOKEN }]),
    timer,
    clock,
    rateLimits: () => JIRA_CLOUD_RATE_LIMIT_POLICY,
  });

  // The mode lives in a cell the adapter reads at every call, which is what a real
  // `actionContext` does: one binding serves tasks in both modes over its lifetime.
  const state: { mode: TaskMode } = { mode: options.mode ?? 'normal' };

  const port = createJiraCloudTaskManagement({
    integrationId: JIRA_INTEGRATION_ID,
    config: jiraConfig(options.config),
    executor,
    clock,
    actionContext: () => ({
      mode: state.mode,
      projectId: JIRA_PROJECT_ID,
      taskId: JIRA_TASK_ID,
    }),
    fetch: options.fetch ?? replay.fetch,
    // Required since WP-11 (standing rule 31). The adapter composes it with the redactor it builds
    // from its own configuration, so the no-op here states "this harness injected nothing else".
    redactor: noSecretsRedactor(),
  });

  return {
    port,
    replay,
    audit,
    timer,
    executor,
    get mode() {
      return state.mode;
    },
    set mode(next: TaskMode) {
      state.mode = next;
    },
  };
};

/** The ticket the contract suite reads, as the replay double seeds it. */
export const JIRA_TICKET = {
  provider: 'jira-cloud',
  key: 'ACME-1',
  url: `${JIRA_REPLAY_SITE}/browse/ACME-1`,
} as const;
