/**
 * The providers a running instance registers for the **pipeline** (BD-017, WP-15a).
 *
 * `createIntegrationRegistry` has existed since WP-07 and nothing ever called it outside a test:
 * the registry is where "this build knows about GitLab" is written down, and until a loader read
 * the `bindings` table there was nobody to say it to. This is that list.
 *
 * ## Why three and not five
 *
 * The pipeline holds a git provider, a task manager and — since WP-32 — the chat binding the
 * notification band posts through (`PipelineIntegrations`), and the loader builds exactly those
 * three. **Slack joined this list when it got a consumer**, which is the rule this paragraph has
 * always stated rather than an exception to it: it used to read *"Registering Slack, Sentry and
 * Loki here as well would be five entries of which three are constructed by nothing … They are
 * registered by the composition root that consumes them (the digest job, the bug-task pre-fetch),
 * in the work package that builds it"*, and WP-32 is that work package for Slack (standing rule
 * 83 — closing a gap falsifies the sentence that described it).
 *
 * Sentry and Loki are still absent for the original reason: nothing constructs them. The bug
 * task's observability pre-fetch has no owner, so registering them would be two entries the code
 * is parameterised over and the tests are not (standing rule 68's shape).
 *
 * **Registering Slack has one consequence beyond the notification band**, and it is deliberate:
 * the webhook ingress shares this registry, so `POST /webhooks/slack/<integrationId>` now resolves
 * a provider and can verify and normalise a delivery (WP-10 built both halves and WP-15c built the
 * door). An unmapped author is still `ignored` with a reason and never a decision (BD-022, Q10).
 *
 * ## The duplication this composition carries, stated rather than discovered later
 *
 * WP-09's GitLab adapter deliberately keeps `IntegrationActionExecutor` **outside** itself
 * (`gitlab/provider.ts`: "Putting the executor *inside* the adapter would … which is the whole of
 * standing rule 14"), and the pipeline wraps every call in the executor itself
 * (`pipeline/integrations.ts`). WP-08's Jira adapter does the opposite: it takes an executor and
 * wraps its own calls. So a ticket write through a Jira binding passes through **two** executors —
 * two `integration_actions` rows for one action, and two rate-limit acquisitions from one budget.
 * Nothing is unsafe (the outer executor refuses a shadow mutation before the inner one is reached),
 * and nothing here can fix it: the fix is Jira adopting GitLab's shape, which is an adapter change
 * with its own contract suite. It is filed in `docs/technical/PROGRESS.md` under discovered work.
 */
import type { IntegrationActionExecutor, IntegrationTimer } from '@platform/application';
import type { Clock } from '@platform/domain';
import { gitlabProviderRegistration } from '../providers/gitlab/index.js';
import { fixedActionContext } from '../providers/jira-cloud/index.js';
import { createJiraCloudRegistration } from '../providers/jira-cloud/registration.js';
import { createSlackRegistration, type SocketConnect } from '../providers/slack/index.js';
import { createIntegrationRegistry, type IntegrationRegistry } from '../registry.js';

export interface PipelineProviderRegistryOptions {
  /**
   * The executor Jira's adapter wraps its own calls in — see the duplication note above.
   *
   * It is the same instance the pipeline uses, deliberately: two executors would mean two
   * idempotency stores and two rate-limit budgets for one account, which is worse than two rows.
   */
  readonly executor: IntegrationActionExecutor;
  readonly clock: Clock;
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

export const createPipelineProviderRegistry = (
  options: PipelineProviderRegistryOptions,
): IntegrationRegistry =>
  createIntegrationRegistry([
    gitlabProviderRegistration,
    createJiraCloudRegistration({
      executor: options.executor,
      clock: options.clock,
      // The task and the mode a call belongs to are carried by the *outer* executor, which the
      // pipeline calls with the task's own `mode` (`pipeline/integrations.ts`). This inner context
      // therefore never decides whether a mutation happens — the outer guard has already refused a
      // shadow task's mutation before `perform` runs — and `normal` is what a call that reached
      // here was allowed to be.
      actionContext: fixedActionContext('normal'),
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
  ]);
