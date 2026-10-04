/**
 * `POST /api/integrations/:id/test` — the wizard's *"does this credential work?"* (WP-21).
 *
 * The third loader beside `loader.ts` (a project's two ports) and `inbound-loader.ts` (an account's
 * webhook halves), and it exists for the same reason they are two rather than one: this one starts
 * from an **account** and needs the built port *itself*, not its inbound half. Every type port
 * carries `testConnection(): Promise<HealthProbe>` — "a read-only probe for the health panel and
 * the setup wizard" (`ports/integrations/common.ts`) — so the probe is the provider's own, and this
 * module is the lookup that reaches it.
 *
 * ## Three answers, and they are different facts
 *
 * - **No integration with that id** → `null`. The route answers 404 and writes nothing.
 * - **An adapter that cannot be built** — an unregistered provider, a config that fails its schema,
 *   a credential that will not decrypt → {@link BindingLoadError}, thrown. Same rule as both other
 *   loaders: a binding that fails to load must not become a binding that quietly is not there.
 * - **A probe that came back** → the provider's verdict, whatever it is. `ok: false` is a
 *   successful *test* reporting a failed *connection*, and collapsing the two would make a wizard
 *   step that cannot tell "your token is wrong" from "the platform is broken".
 *
 * ## The call goes through `IntegrationActionExecutor`, like every other outbound call
 *
 * CLAUDE.md's rule is *"every outbound provider call goes through `IntegrationActionExecutor` —
 * never directly"*, and `action-executor.ts` names `testConnection` in the docblock of
 * `ReadActionRequest.mode` as one of the two reads that have no task. It is not decoration here: a
 * probe is the product's **only HTTP-triggered outbound call**, so without the executor it would
 * write no `integration_actions` row (BD-003), take no rate limit and be the one call an operator
 * could drive at whatever rate they like against somebody else's API with the organisation's
 * credential. `mutating: false` is correct and is the provider's promise — `testConnection` is
 * documented "never mutates, so it is safe to run from the settings UI on demand" — so the shadow
 * guard does not apply; the audit row and the rate limit do.
 *
 * `projectId` and `taskId` are `null`: an integration belongs to the organisation and a probe
 * belongs to no task, which is exactly the case `ReadActionRequest.mode` is optional for.
 */
import type {
  BindingRepository,
  GitProviderPort,
  HealthProbe,
  InjectedSecret,
  IntegrationAccount,
  IntegrationActionExecutor,
  IntegrationRef,
  ProjectMemberAccess,
  SecretRedactor,
  SecretStore,
} from '@platform/application';
import {
  bindingSecretRedactor,
  composeSecretRedactors,
  noSecretsRedactor,
} from '@platform/application';
import type { Id, IntegrationType } from '@platform/contracts';
import type { IntegrationRegistry } from '../registry.js';
import { staticRunCredentialOf } from '../static-run-credential.js';
import { BindingLoadError } from './loader.js';

export interface IntegrationProberOptions {
  readonly repository: BindingRepository;
  readonly secrets: SecretStore;
  readonly registry: IntegrationRegistry;
  /**
   * The process's one executor — **required, never defaulted** (standing rule 31).
   *
   * A prober built without it would make an unaudited, unlimited provider call, which is the
   * defect this option exists to make impossible rather than to make configurable.
   */
  readonly executor: IntegrationActionExecutor;
  /**
   * The platform's own redactor, composed after the account's exact-match one — TD-012 step 2.
   *
   * Named rather than defaulted at the call site for the reason `inbound-loader.ts` states: an
   * optional security dependency is an absent one (standing rule 31). What it protects here is the
   * probe's **detail string**, which is provider text on its way to an HTTP response and an audit
   * row — a provider whose error message echoes the token it rejected is the ordinary case.
   */
  readonly platformRedactor?: SecretRedactor;
  /**
   * The repository path of the one project bound to this integration (`acme/api`), or `null` when
   * none is — where a **static run credential**'s user is checked (WP-137, TD-028 decision 13 item
   * 3). Absent, the check reports that it could not be made, as a failed check, never a pass.
   */
  readonly boundProjectPathOf?: (integrationId: Id) => Promise<string | null>;
}

/** One line of the probe's answer: the connection, and for a static run credential its user. */
export interface IntegrationProbeCheck {
  readonly name: string;
  readonly ok: boolean;
  /** Platform text, or provider text through the account's redactor. */
  readonly detail: string;
}

/** `<provider>:<integrationId>:<field>` — the naming both other loaders use. */
const secretName = (account: IntegrationAccount, field: string): string =>
  `${account.provider}:${account.integrationId}:${field}`;

/** Asked of the built object, not of its type: what a new provider gets wrong is the object. */
const probeOf = (port: object): (() => Promise<HealthProbe>) | null =>
  'testConnection' in port &&
  typeof (port as { testConnection: unknown }).testConnection === 'function'
    ? (port as { testConnection: () => Promise<HealthProbe> }).testConnection.bind(port)
    : null;

/**
 * The adapter's **own** `IntegrationRef`, asked of the built object (WP-51).
 *
 * This used to build a ref by hand from the account row, which was harmless while a ref was three
 * identity fields — and stopped being harmless when it grew `host`, the value the executor's egress
 * allow-list decides on. A hand-built ref would have carried `host: null` and the probe, the one
 * outbound call an HTTP request can trigger, would have been the one call the allow-list could not
 * see. The adapter reads the host out of the config its own schema just validated; there is no
 * second place that should be deriving it.
 */
const refOf = (port: object): IntegrationRef | null => {
  if (!('ref' in port)) {
    return null;
  }
  const ref = (port as { ref: unknown }).ref;
  return typeof ref === 'object' && ref !== null && 'integrationId' in ref
    ? (ref as IntegrationRef)
    : null;
};

export interface IntegrationProbeOutcome {
  /** Every check passed. */
  readonly ok: boolean;
  readonly checkedAt: string;
  /** One line, already through the account's redactor. Never null — an empty string says so. */
  readonly detail: string;
  /**
   * `connection` always; `run_credential` beside it for an integration that declares a static run
   * credential (WP-137). `detail` above is the connection's.
   */
  readonly checks: readonly IntegrationProbeCheck[];
}

export interface IntegrationProber {
  test(integrationId: Id): Promise<IntegrationProbeOutcome | null>;
}

export const createIntegrationProber = (options: IntegrationProberOptions): IntegrationProber => {
  const platformRedactor = options.platformRedactor ?? noSecretsRedactor();
  return {
    test: async (integrationId: Id): Promise<IntegrationProbeOutcome | null> => {
      const account = await options.repository.forIntegration(integrationId);
      if (account === null) {
        return null;
      }

      let registration: ReturnType<IntegrationRegistry['get']>;
      try {
        registration = options.registry.get(account.type as IntegrationType, account.provider);
      } catch (cause) {
        throw new BindingLoadError(
          null,
          null,
          `integration "${account.name}" names provider "${account.provider}", which this build does not register`,
          { cause, integrationId },
        );
      }

      let secrets: Readonly<Record<string, string>>;
      try {
        secrets = await options.secrets.resolve(account.secretIds);
      } catch (cause) {
        throw new BindingLoadError(
          null,
          null,
          `integration "${account.name}" (${account.provider}) has credentials that cannot be read: ${
            (cause as Error).message
          }`,
          { cause, integrationId },
        );
      }

      const injected: InjectedSecret[] = Object.entries(secrets).map(([field, value]) => ({
        name: secretName(account, field),
        value,
      }));
      const redactor = composeSecretRedactors(bindingSecretRedactor(injected), platformRedactor);

      const parsed = registration.configSchema.safeParse({ ...account.config, ...secrets });
      if (!parsed.success) {
        // The paths, never the values: the merged document holds the credential.
        const paths = parsed.error.issues
          .map((issue) => (issue.path.length === 0 ? '<root>' : issue.path.join('.')))
          .join(', ');
        throw new BindingLoadError(
          null,
          null,
          `integration "${account.name}" (${account.provider}) has configuration that fails its schema at: ${paths}`,
          { integrationId },
        );
      }

      let port: object;
      try {
        port = registration.create({
          integrationId,
          config: parsed.data,
          secrets,
          redactor,
        }) as object;
      } catch (cause) {
        throw new BindingLoadError(
          null,
          null,
          `integration "${account.name}" (${account.provider}) could not be instantiated`,
          { cause, integrationId },
        );
      }

      const probe = probeOf(port);
      if (probe === null) {
        // Unreachable while every registration builds an `IntegrationPort`, and asserted rather
        // than assumed because what a new provider gets wrong is the object (standing rule 22).
        throw new BindingLoadError(
          null,
          null,
          `integration "${account.name}" (${account.provider}) built a port with no testConnection`,
          { integrationId },
        );
      }
      const ref = refOf(port);
      if (ref === null) {
        // The same shape as the `probeOf` refusal above and for the same reason (standing rule 22):
        // every registration builds an `IntegrationPort`, which carries `ref`, and a provider that
        // does not is a build defect rather than a call the platform should make ref-less.
        throw new BindingLoadError(
          null,
          null,
          `integration "${account.name}" (${account.provider}) built a port with no ref, so the platform cannot tell which host it would call`,
          { integrationId },
        );
      }
      const outcome = await options.executor.execute<HealthProbe>({
        integration: ref,
        action: 'test_connection',
        // The account's own configuration, never its credentials: `secrets` is merged into the
        // adapter's config above and is deliberately not in what the audit row records.
        payload: { name: account.name },
        projectId: null,
        taskId: null,
        mutating: false,
        perform: async () => probe(),
        // The verdict, not the provider's prose: `detail` is provider text and the executor
        // redacts what it stores, but a boolean is the evidence an operator reads in the audit.
        describeResult: (result) => ({ ok: result.ok }),
      });
      const result = outcome.result;
      // The provider's own words, through the account's redactor. Every `testConnection` already
      // owes this (`healthProbeSchema.detail` says so) and it is applied **again** here rather
      // than trusted: the obligation is on every provider, and this is the one place that can
      // hold a provider that forgot to a promise the platform makes to the operator. Redaction is
      // idempotent over an already-redacted string, so the cost is one pass.
      const detail = redactor.redactText(result.detail ?? '').value;
      const checks: IntegrationProbeCheck[] = [{ name: 'connection', ok: result.ok, detail }];
      const fixed = staticRunCredentialOf(
        registration.staticRunCredential,
        parsed.data as Readonly<Record<string, unknown>>,
      );
      if (fixed !== undefined) {
        checks.push(
          await checkStaticRunCredential({
            options,
            integrationId,
            ref,
            port,
            username: fixed.username,
            connected: result.ok,
            redact: (text) => redactor.redactText(text).value,
          }),
        );
      }
      return {
        ok: checks.every((check) => check.ok),
        checkedAt: result.checked_at,
        detail,
        checks,
      };
    },
  };
};

/** What the probe says it cannot do, on every static run credential check (decision 13 item 3). */
const CANNOT_CONFIRM_OWNER =
  'The platform never uses the run token for an API call, so it cannot confirm that the token belongs to this user — check that yourself in the user’s access tokens.';

/**
 * The static run credential's line of the probe (WP-137, TD-028 decision 13 item 3): the declared
 * user's membership of the bound project, read **with the API token** through the executor (a read,
 * audited, rate-limited), refused when the role is above the push role, and always saying what it
 * cannot confirm. The run token itself is never sent anywhere here.
 */
const checkStaticRunCredential = async (input: {
  readonly options: IntegrationProberOptions;
  readonly integrationId: Id;
  readonly ref: IntegrationRef;
  readonly port: object;
  readonly username: string;
  readonly connected: boolean;
  readonly redact: (text: string) => string;
}): Promise<IntegrationProbeCheck> => {
  const name = 'run_credential';
  if (!input.connected) {
    return {
      name,
      ok: false,
      detail: `Not checked: the API token's connection failed, and the run token's user is read with it. ${CANNOT_CONFIRM_OWNER}`,
    };
  }
  if (input.username.trim() === '') {
    return { name, ok: false, detail: `No run token user is declared. ${CANNOT_CONFIRM_OWNER}` };
  }
  const project =
    input.options.boundProjectPathOf === undefined
      ? null
      : await input.options.boundProjectPathOf(input.integrationId);
  if (project === null) {
    return {
      name,
      ok: false,
      detail: `Not checked: no project is bound to this integration yet, so there is no membership to read. Bind it and test again. ${CANNOT_CONFIRM_OWNER}`,
    };
  }
  const git = input.port as Partial<GitProviderPort>;
  if (typeof git.projectMemberAccess !== 'function') {
    return { name, ok: false, detail: 'This provider cannot read a project membership.' };
  }
  const access = (
    await input.options.executor.execute<ProjectMemberAccess>({
      integration: input.ref,
      action: 'check_run_credential_member',
      // Names only: the user and the project, never a credential.
      payload: { username: input.username, project },
      projectId: null,
      taskId: null,
      mutating: false,
      perform: async () =>
        (git.projectMemberAccess as GitProviderPort['projectMemberAccess'])(
          project,
          input.username,
        ),
      describeResult: (result) => ({ member: result.member, administers: result.administers }),
    })
  ).result;
  const who = input.redact(input.username);
  if (!access.member) {
    return {
      name,
      ok: false,
      detail: `${who} is not a member of ${project}, so the run token cannot fetch it. ${CANNOT_CONFIRM_OWNER}`,
    };
  }
  const role = input.redact(access.role ?? 'an unnamed role');
  if (!access.pushes) {
    return {
      name,
      ok: false,
      detail: `${who} is ${role} on ${project}, which cannot push, so a stage that writes would fail; a static run credential's user needs the push role (GitLab: Developer). ${CANNOT_CONFIRM_OWNER}`,
    };
  }
  if (access.administers) {
    return {
      name,
      ok: false,
      detail: `${who} is ${role} on ${project}; a static run credential must belong to a user with the push role and no more (GitLab: Developer), because a higher role can unprotect the default branch (TD-028 decision 13). Lower the role, or use another user. ${CANNOT_CONFIRM_OWNER}`,
    };
  }
  return {
    name,
    ok: true,
    detail: `${who} is ${role} on ${project}. ${CANNOT_CONFIRM_OWNER}`,
  };
};
