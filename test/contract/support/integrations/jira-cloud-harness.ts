/**
 * One Jira Cloud binding, composed the way the composition root composes it: the adapter, an
 * `IntegrationActionExecutor` with a memory audit log, a virtual timer and a fixed clock, all in
 * front of the fixture-backed replay double.
 *
 * It lives beside the contract suite because two runners need it — the shared
 * `runTaskManagementContract` and the Jira-specific contract file — and because the *composition*
 * is part of what WP-08 has to get right.
 *
 * **Since WP-212 the adapter makes no executor call of its own** (GitLab's shape): the caller's
 * call is the one. So the binding carries two views of one adapter: `adapter`, the port itself,
 * which the shared suite runs against; and `port`, the same adapter with every port call made
 * inside **one** executor call, as the pipeline's `read`/`mutate` make it
 * (`packages/application/src/pipeline/integrations.ts`) — a read for the members that change
 * nothing and a mutation, under the binding's `mode`, for the eight that do. The Jira-specific
 * file asserts the audit rows, the shadow guard, the retries and the scrub through `port`.
 */
import {
  allowAnyIntegrationHost,
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
import type { Id, JsonObject, TaskMode } from '@platform/contracts';
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
  /** The adapter as its caller holds it: one executor call per port call (WP-212). */
  readonly port: TaskManagementPort;
  /** The adapter itself, with no executor anywhere — what the shared suite runs against. */
  readonly adapter: TaskManagementPort;
  readonly replay: JiraReplay;
  readonly audit: MemoryIntegrationAuditLog;
  readonly timer: VirtualTimer;
  readonly executor: IntegrationActionExecutor;
  /** Flipped by the shadow-mode tests; the executor call around each port call reads it. */
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
    // Declared open on purpose (WP-51): this file is not about the egress allow-list, and an
    // omitted policy is not a thing `IntegrationActionExecutorOptions` permits.
    egress: allowAnyIntegrationHost(),
    auditLog: audit,
    // The binding's own token, so the executor's scrub is the real one and not a no-op.
    redactor:
      options.executorRedactor ??
      exactSecretRedactor([{ name: 'jira_api_token', value: JIRA_REPLAY_TOKEN }]),
    timer,
    clock,
    rateLimits: () => JIRA_CLOUD_RATE_LIMIT_POLICY,
  });

  // The mode lives in a cell read at every call: one binding serves tasks in both modes over its
  // lifetime, and the caller states the task's mode on each executor call.
  const state: { mode: TaskMode } = { mode: options.mode ?? 'normal' };

  const adapter = createJiraCloudTaskManagement({
    integrationId: JIRA_INTEGRATION_ID,
    config: jiraConfig(options.config),
    clock,
    fetch: options.fetch ?? replay.fetch,
    // Required since WP-11 (standing rule 31). The adapter composes it with the redactor it builds
    // from its own configuration, so the no-op here states "this harness injected nothing else".
    redactor: noSecretsRedactor(),
  });

  return {
    port: throughOneExecutorCall(adapter, executor, () => state.mode),
    adapter,
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

/**
 * Every port call made inside one executor call, the way the pipeline makes it (WP-212): a read for
 * a member that changes nothing, and a mutation under the caller's `mode` for the eight that do,
 * each answering a shadow task with a value that cannot be mistaken for a provider's (the
 * pipeline's own `would-have` spellings). Action names are the members' own, in snake_case.
 */
const throughOneExecutorCall = (
  adapter: TaskManagementPort,
  executor: IntegrationActionExecutor,
  mode: () => TaskMode,
): TaskManagementPort => {
  const scope = { projectId: JIRA_PROJECT_ID, taskId: JIRA_TASK_ID };
  const read = async <T>(action: string, payload: JsonObject, perform: () => Promise<T>) =>
    (
      await executor.execute<T>({
        integration: adapter.ref,
        action,
        mutating: false,
        payload,
        ...scope,
        perform,
      })
    ).result;
  const mutate = async <T>(
    action: string,
    payload: JsonObject,
    perform: () => Promise<T>,
    shadowResult: () => T,
  ) =>
    (
      await executor.execute<T>({
        integration: adapter.ref,
        action,
        mutating: true,
        mode: mode(),
        payload,
        ...scope,
        perform,
        shadowResult,
        describeResult: () => null,
      })
    ).result;
  const wouldHaveComment = (ticketKey: string, markerId: string | null) => ({
    provider: adapter.ref.provider,
    ticket_key: ticketKey,
    comment_id: 'would-have',
    url: null,
    marker_id: markerId,
  });
  return {
    ...adapter,
    readTicket: (ref) =>
      read('read_ticket', { ticket_key: ref.key }, () => adapter.readTicket(ref)),
    matchTickets: (rule, options) =>
      read('match_tickets', { rule: rule.kind }, () => adapter.matchTickets(rule, options)),
    resolveIdentity: (query) => read('resolve_identity', {}, () => adapter.resolveIdentity(query)),
    testConnection: () => read('test_connection', {}, () => adapter.testConnection()),
    listStatuses: () => read('list_statuses', {}, () => adapter.listStatuses()),
    listTransitions: (ref) =>
      read('list_transitions', { ticket_key: ref.key }, () => adapter.listTransitions(ref)),
    selfIdentity: () => read('self_identity', {}, () => adapter.selfIdentity()),
    listComments: (ref, options) =>
      read('list_comments', { ticket_key: ref.key }, () => adapter.listComments(ref, options)),
    transition: (ref, status, fields) =>
      mutate(
        'transition',
        { ticket_key: ref.key, to: status },
        () => adapter.transition(ref, status, fields),
        () => ({ changed: false, from: status, to: status }),
      ),
    upsertWorkpad: (ref, markerId, markdown) =>
      mutate(
        'upsert_workpad',
        { ticket_key: ref.key, marker_id: markerId },
        () => adapter.upsertWorkpad(ref, markerId, markdown),
        () => wouldHaveComment(ref.key, markerId),
      ),
    addComment: (ref, markdown, options) =>
      mutate(
        'add_comment',
        { ticket_key: ref.key },
        () => adapter.addComment(ref, markdown, options),
        () => wouldHaveComment(ref.key, options?.markerId ?? null),
      ),
    setLabels: (ref, add, remove) =>
      mutate(
        'set_labels',
        { ticket_key: ref.key },
        () => adapter.setLabels(ref, add, remove),
        () => [...add],
      ),
    linkMergeRequest: (ref, mrUrl) =>
      mutate(
        'link_merge_request',
        { ticket_key: ref.key },
        () => adapter.linkMergeRequest(ref, mrUrl),
        () => undefined,
      ),
    createTicket: (draft) =>
      mutate(
        'create_ticket',
        { project_key: draft.project_key },
        () => adapter.createTicket(draft),
        () => ({
          provider: adapter.ref.provider,
          key: 'WOULD-HAVE-NOT-A-REAL-TICKET',
          url: 'https://shadow.invalid/would-have-created',
        }),
      ),
    assignToSelf: (ref) =>
      mutate(
        'assign_to_self',
        { ticket_key: ref.key },
        () => adapter.assignToSelf(ref),
        () => ({
          changed: false,
          assignee: { provider: adapter.ref.provider, external_id: 'would-have', verified: false },
        }),
      ),
    unassign: (ref) =>
      mutate(
        'unassign',
        { ticket_key: ref.key },
        () => adapter.unassign(ref),
        () => ({ changed: false }),
      ),
  };
};
