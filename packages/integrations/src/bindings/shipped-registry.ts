/**
 * The providers a running instance registers for the **pipeline** (BD-017, WP-15a).
 *
 * `createIntegrationRegistry` has existed since WP-07 and nothing ever called it outside a test:
 * the registry is where "this build knows about GitLab" is written down, and until a loader read
 * the `bindings` table there was nobody to say it to. This is that list.
 *
 * ## Why all five, and why it used to be three
 *
 * The pipeline holds a git provider, a task manager, the chat binding the notification band posts
 * through (`PipelineIntegrations`, WP-32) and — since WP-89 — the project's error tracker and log
 * store, which the bug pre-fetch reads before the Investigator runs
 * (`pipeline/observability-prefetch.ts`, through `PipelineIntegrationsPort.forObservability`). **A
 * provider joins this list when it gets a consumer**, which is the rule this paragraph has always
 * stated: it used to read *"Registering Slack, Sentry and Loki here as well would be five entries of
 * which three are constructed by nothing … They are registered by the composition root that
 * consumes them (the digest job, the bug-task pre-fetch), in the work package that builds it"*.
 * WP-32 was that work package for Slack and WP-89 is it for Sentry and Loki (PROGRESS backlog 143 —
 * standing rule 83, closing a gap falsifies the sentence that described it). The loader's tests are
 * parameterised over the two new entries rather than trusting them (standing rule 68):
 * `loader.test.ts` builds each through this very registry.
 *
 * Both are built with the **process's** clock and the runtime's `fetch`; neither takes the executor,
 * because neither wraps its own calls — no shipped adapter does since WP-212 (below). Their
 * `IntegrationRef.host` is the binding's `base_url` host, so the executor's egress check against
 * `APP_INTEGRATION_HOSTS` applies to every pre-fetch read like any other call.
 *
 * **Registering Slack has one consequence beyond the notification band**, and it is deliberate:
 * the webhook ingress shares this registry, so `POST /webhooks/slack/<integrationId>` now resolves
 * a provider and can verify and normalise a delivery (WP-10 built both halves and WP-15c built the
 * door). An unmapped author is still `ignored` with a reason and never a decision (BD-022, Q10).
 *
 * ## One executor call per port call (WP-212, PROGRESS backlog 550)
 *
 * No adapter registered here enters `IntegrationActionExecutor`: the caller's call is the one —
 * the pipeline's `read`/`mutate` (`pipeline/integrations.ts`) and the prober's `test_connection`
 * (`prober.ts`) — so one port call is one `integration_actions` row and one rate-limit token. That
 * is WP-09's GitLab shape (`gitlab/provider.ts`: "Putting the executor *inside* the adapter would …
 * which is the whole of standing rule 14"), and since WP-212 it is Jira's too.
 *
 * Until WP-212, WP-08's Jira adapter took this registry's executor — the pipeline's own instance —
 * and wrapped its own members in it, so a ticket call entered the executor **twice** on one
 * `integrations.id`. This note once said that was safe because the outer executor refuses a shadow
 * mutation first; it never considered the limiter slot, which deadlocked `maxConcurrent` concurrent
 * calls until `df01f9b1` made the nested call run under the outer lease, and it left two audit rows
 * per read (three per transition) until WP-212 removed the inner wrap. `jira-one-wrap.integration.test.ts`
 * counts them on the production composition.
 *
 * ## The rate-limit policy each provider gets
 *
 * {@link pipelineRateLimitPolicy} is the executor's `rateLimits` resolver: Jira Cloud's own
 * {@link JIRA_CLOUD_RATE_LIMIT_POLICY}, every other provider the executor's default. It was declared
 * at WP-08 and never wired until backlog 550, which is also what made wiring it safe — at
 * `maxConcurrent: 3` the deadlock above needed one fewer caller.
 */
import {
  DEFAULT_RATE_LIMIT_POLICY,
  type IntegrationRef,
  type IntegrationTimer,
  type Logger,
  type RateLimitPolicy,
} from '@platform/application';
import type { Clock } from '@platform/domain';
import { gitlabProviderRegistration } from '../providers/gitlab/index.js';
import { JIRA_CLOUD_RATE_LIMIT_POLICY } from '../providers/jira-cloud/index.js';
import {
  createJiraCloudRegistration,
  JIRA_CLOUD_PROVIDER_METADATA,
} from '../providers/jira-cloud/registration.js';
import { createLokiRegistration } from '../providers/loki/index.js';
import { createSentryRegistration } from '../providers/sentry/index.js';
import { createSlackRegistration, type SocketConnect } from '../providers/slack/index.js';
import { createIntegrationRegistry, type IntegrationRegistry } from '../registry.js';

export interface PipelineProviderRegistryOptions {
  readonly clock: Clock;
  /**
   * Where Jira's adapter names what its single audit row no longer carries — a status read with two
   * categories (`listStatuses`, WP-212). Absent is silent.
   */
  readonly logger?: Logger;
  /**
   * Socket Mode's reconnect backoff (WP-43). Required: the Slack adapter refuses to open a socket
   * without one, and a registry that forgot it would turn every held connection into a refusal at
   * composition rather than a type error here.
   */
  readonly timer: IntegrationTimer;
  /**
   * **A labelled test seam**: the Socket Mode connector. Absent is production — Node's global
   * `WebSocket` through `webSocketConnect`. The e2e tier injects one so a click is driven end to
   * end without a Slack workspace (`test/e2e/pipeline/slack-socket.e2e.test.ts`).
   */
  readonly slackConnect?: SocketConnect;
}

/**
 * The production executor's `rateLimits` resolver (backlog 550): a provider that declared its own
 * policy gets it, every other the executor's default. Keyed by the ref's provider id, and still one
 * limiter per `integrations.id` — two Jira bindings are two budgets (`rate-limiter.ts`).
 */
export const pipelineRateLimitPolicy = (ref: IntegrationRef): RateLimitPolicy =>
  ref.provider === JIRA_CLOUD_PROVIDER_METADATA.id
    ? JIRA_CLOUD_RATE_LIMIT_POLICY
    : DEFAULT_RATE_LIMIT_POLICY;

export const createPipelineProviderRegistry = (
  options: PipelineProviderRegistryOptions,
): IntegrationRegistry =>
  createIntegrationRegistry([
    gitlabProviderRegistration,
    createJiraCloudRegistration({
      clock: options.clock,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
    /**
     * Slack (WP-32), built with the **process's** clock and nothing else.
     *
     * The adapter's other injectable pieces stay at their defaults on purpose: `fetch` is the
     * runtime's, the id source is `randomUUID`, and the thread directory is the in-memory one —
     * which is worth nothing here, because the loader builds an adapter *per call* (Q55). The
     * durable answer to "does this task already have a thread" is the executor's idempotency store,
     * and `communicationWrites.taskThread` is the caller that finally gives that action a plan.
     * The Socket Mode connection is **not** started from here — a registry is not a lifecycle —
     * but since WP-43 it is *opened* through this registration: `createHeldConnectionDirectory`
     * reads `inboundConnection` off it and `apps/server/src/inbound-connections.ts` holds the
     * socket in the process that serves `/webhooks/*`. Hence the timer and the connector.
     */
    createSlackRegistration({
      clock: options.clock,
      timer: options.timer,
      ...(options.slackConnect === undefined ? {} : { connect: options.slackConnect }),
    }),
    // WP-89: the bug pre-fetch's two providers, each read through `forObservability`.
    createSentryRegistration({ clock: options.clock }),
    createLokiRegistration({ clock: options.clock }),
  ]);
