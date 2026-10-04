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
  BranchPushProtection,
  DeployKeyAccess,
  GitProviderPort,
  HealthProbe,
  InjectedSecret,
  IntegrationAccount,
  IntegrationActionExecutor,
  IntegrationRef,
  ProjectMemberAccess,
  RunTokenApiAccess,
  SecretRedactor,
  SecretStore,
} from '@platform/application';
import {
  bindingSecretRedactor,
  composeSecretRedactors,
  deployKeyProtectionFault,
  noSecretsRedactor,
  operatorProtectionFault,
} from '@platform/application';
import type { Id, IntegrationType } from '@platform/contracts';
import type { IntegrationRegistry } from '../registry.js';
import { deployKeyRunCredentialOf, staticRunCredentialOf } from '../static-run-credential.js';
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
   * The one project bound to this integration — its repository path (`acme/api`) and its stored
   * `projects.default_branch` — or `null` when none is: where a **static run credential**'s user is
   * checked (WP-137, TD-028 decision 13 item 3) and, for an operator's own token, whose default
   * branch's protection is read (WP-141, decision 13a item 2). Absent, the check reports that it
   * could not be made, as a failed check, never a pass.
   */
  readonly boundProjectOf?: (integrationId: Id) => Promise<BoundProject | null>;
}

/** {@link IntegrationProberOptions.boundProjectOf}'s answer. */
export interface BoundProject {
  readonly path: string;
  readonly defaultBranch: string;
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
   * credential (WP-137) or a deploy key (WP-146), and `default_branch_protection` for an operator's
   * own token (WP-141) and a deploy key. `detail` above is the connection's.
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
      // WP-146 (TD-028 decision 13b item 6): a deploy key's two checks.
      const deployKey = deployKeyRunCredentialOf(
        registration.staticRunCredential,
        parsed.data as Readonly<Record<string, unknown>>,
      );
      if (deployKey !== undefined) {
        checks.push(
          ...(await checkDeployKey({
            options,
            integrationId,
            ref,
            port,
            publicKey: deployKey.publicKey,
            refusal: deployKey.refusal,
            connected: result.ok,
            redact: (text: string) => redactor.redactText(text).value,
          })),
        );
      }
      if (fixed !== undefined) {
        const input = {
          options,
          integrationId,
          ref,
          port,
          username: fixed.username,
          connected: result.ok,
          redact: (text: string) => redactor.redactText(text).value,
        };
        if (fixed.owner === 'operator') {
          checks.push(
            ...(await checkOperatorRunToken({
              ...input,
              runToken: fixed.value,
              scopeProofHint:
                registration.staticRunCredential?.scopeProofHint ??
                'this token can call the provider’s API; create one with repository scopes only',
            })),
          );
        } else {
          checks.push(await checkStaticRunCredential(input));
        }
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
  'The platform never uses a dedicated user’s run token for an API call, so it cannot confirm that the token belongs to this user — check that yourself in the user’s access tokens.';

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
  const bound =
    input.options.boundProjectOf === undefined
      ? null
      : await input.options.boundProjectOf(input.integrationId);
  const project = bound?.path ?? null;
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

/**
 * What the probe of an **operator's own** run token says it cannot see (TD-028 decision 13a item 3):
 * the token's reach is its owner's, not one project's.
 */
const OPERATOR_REACH =
  'This is your own token: it reaches every repository you can access, not only this project, and the platform cannot see which.';

/** {@link checkOperatorRunToken}'s input: the dedicated-user check's, plus the token and the hint. */
interface OperatorRunTokenInput {
  readonly options: IntegrationProberOptions;
  readonly integrationId: Id;
  readonly ref: IntegrationRef;
  readonly port: object;
  readonly username: string;
  readonly connected: boolean;
  readonly redact: (text: string) => string;
  readonly runToken: string;
  readonly scopeProofHint: string;
}

/**
 * The probe of an **operator's own** repository-only run token (WP-141, TD-028 decision 13a): the
 * dedicated-user role check is **replaced** by two checks, both through the executor as reads.
 *
 *  - `run_credential` — the **scope proof**: exactly one identity read made **with the run token**
 *    (`GitProviderPort.runTokenApiAccess`), accepted only when the provider refuses it for scope
 *    (GitLab `403`). A token that can call the API could change protection, membership and settings;
 *    one that cannot is left with git, which the next check bounds. Any role is accepted — a
 *    Maintainer's or an Owner's token included — because the role is not what the token can use.
 *  - `default_branch_protection` — with the **API** token: the bound project's stored default branch
 *    protected with push **No one** and force push off. Re-read before every run that gets the token
 *    (`runCredentialWrites`), so this line is the operator's preview, not the only gate.
 *
 * The audit row of the scope proof names the project and the status; the token is in neither the
 * payload nor the result (and the executor redacts both with the account's redactor, which knows it).
 */
const checkOperatorRunToken = async (
  input: OperatorRunTokenInput,
): Promise<readonly IntegrationProbeCheck[]> => {
  const scope = 'run_credential';
  const protection = 'default_branch_protection';
  if (!input.connected) {
    const detail = `Not checked: the API token's connection failed. ${OPERATOR_REACH}`;
    return [
      { name: scope, ok: false, detail },
      { name: protection, ok: false, detail },
    ];
  }
  const git = input.port as Partial<GitProviderPort>;
  if (
    typeof git.runTokenApiAccess !== 'function' ||
    typeof git.branchPushProtection !== 'function'
  ) {
    const detail = 'This provider cannot prove a run token’s scope or read a branch’s protection.';
    return [
      { name: scope, ok: false, detail },
      { name: protection, ok: false, detail },
    ];
  }
  const bound =
    input.options.boundProjectOf === undefined
      ? null
      : await input.options.boundProjectOf(input.integrationId);
  return [
    await scopeProof(input, git.runTokenApiAccess.bind(git), bound),
    await protectionCheck(input, git.branchPushProtection.bind(git), bound),
  ];
};

const scopeProof = async (
  input: OperatorRunTokenInput,
  access: GitProviderPort['runTokenApiAccess'],
  bound: BoundProject | null,
): Promise<IntegrationProbeCheck> => {
  const name = 'run_credential';
  if (input.runToken.trim() === '') {
    return { name, ok: false, detail: `No run token is sealed. ${OPERATOR_REACH}` };
  }
  const answer = (
    await input.options.executor.execute<RunTokenApiAccess>({
      integration: input.ref,
      action: 'check_run_token_scope',
      // Names only — never the token, which is the one thing this call carries.
      payload: { project: bound?.path ?? null, owner: 'operator' },
      projectId: null,
      taskId: null,
      mutating: false,
      perform: async () => access(input.runToken),
      describeResult: (result) => ({
        status: result.status,
        refused_for_scope: result.refusedForScope,
        error: result.error,
      }),
    })
  ).result;
  if (answer.refusedForScope) {
    const code = answer.error === null ? '' : ` (${answer.error})`;
    return {
      name,
      ok: true,
      detail: `The run token cannot call the API: the provider refused it for its scope, ${answer.status}${code}. ${OPERATOR_REACH}`,
    };
  }
  if (answer.status >= 200 && answer.status < 300) {
    return {
      name,
      ok: false,
      detail: `Refused: ${input.scopeProofHint} (the provider answered ${answer.status}). An operator’s own token is accepted only when it cannot change protection, membership or settings (TD-028 decision 13a).`,
    };
  }
  if (answer.status === 403) {
    // Review round 1: a 403 that is not a refusal *for scope* — a proxy or firewall in front of the
    // provider, a terms-of-service block — says nothing about what the token could do elsewhere.
    const code = answer.error === null ? 'no error code' : `error ${answer.error}`;
    return {
      name,
      ok: false,
      detail: `Refused: the provider answered 403 with ${code}, not a refusal for the token's scope (GitLab: insufficient_scope), so it proves nothing about whether the token can call the API. ${OPERATOR_REACH}`,
    };
  }
  if (answer.status === 401) {
    return {
      name,
      ok: false,
      detail: `Refused: the provider did not accept the run token at all (401) — it is wrong, expired or revoked. ${OPERATOR_REACH}`,
    };
  }
  return {
    name,
    ok: false,
    detail: `Refused: the provider answered ${answer.status}, which proves nothing about the token's scope. ${OPERATOR_REACH}`,
  };
};

const protectionCheck = async (
  input: OperatorRunTokenInput,
  read: GitProviderPort['branchPushProtection'],
  bound: BoundProject | null,
): Promise<IntegrationProbeCheck> => {
  const name = 'default_branch_protection';
  if (bound === null) {
    return {
      name,
      ok: false,
      detail:
        'Not checked: no project is bound to this integration yet, so there is no default branch to read. Bind it and test again.',
    };
  }
  const rule = (
    await input.options.executor.execute<BranchPushProtection>({
      integration: input.ref,
      action: 'check_default_branch_protection',
      payload: { project: bound.path, branch: bound.defaultBranch },
      projectId: null,
      taskId: null,
      mutating: false,
      perform: async () => read(bound.path, bound.defaultBranch),
      describeResult: (result) => ({
        protected: result.protected,
        nobody_pushes: result.nobodyPushes,
        force_push_allowed: result.forcePushAllowed,
      }),
    })
  ).result;
  const fault = operatorProtectionFault(bound.path, bound.defaultBranch, {
    ...rule,
    pushers: rule.pushers.map(input.redact),
  });
  return fault === null
    ? {
        name,
        ok: true,
        detail: `${bound.defaultBranch} of ${bound.path} is protected with push "No one" and force push off; it is read again before every run that gets the token.`,
      }
    : { name, ok: false, detail: `Refused: ${fault}.` };
};

/** What the deploy-key probe says it cannot see, on both of its checks (decision 13b item 6). */
const DEPLOY_KEY_REACH =
  'The platform cannot see whether this key is also enabled on other projects; a deploy key reaches every project it is enabled on, so enable it on this one only.';

/**
 * The probe of a **deploy key** (WP-146, TD-028 decision 13b item 6), both with the API token through
 * the executor as reads:
 *
 *  - `run_credential` — the project's deploy keys list the declared public key with write access;
 *  - `default_branch_protection` — the bound project's stored default branch protected with push
 *    **No one**, which also admits no deploy key (a deploy key can be added to a protected branch's
 *    push rule).
 *
 * The private key is sent nowhere: the platform never uses it against the API.
 */
const checkDeployKey = async (input: {
  readonly options: IntegrationProberOptions;
  readonly integrationId: Id;
  readonly ref: IntegrationRef;
  readonly port: object;
  readonly publicKey: string;
  readonly refusal: string | null;
  readonly connected: boolean;
  readonly redact: (text: string) => string;
}): Promise<readonly IntegrationProbeCheck[]> => {
  const key = 'run_credential';
  const protection = 'default_branch_protection';
  const both = (detail: string): readonly IntegrationProbeCheck[] => [
    { name: key, ok: false, detail },
    { name: protection, ok: false, detail },
  ];
  if (input.refusal !== null) {
    return both(`Refused: ${input.refusal}.`);
  }
  if (!input.connected) {
    return both(`Not checked: the API token's connection failed. ${DEPLOY_KEY_REACH}`);
  }
  const git = input.port as Partial<GitProviderPort>;
  if (typeof git.deployKeyAccess !== 'function' || typeof git.branchPushProtection !== 'function') {
    return both('This provider cannot read its deploy keys or a branch’s protection.');
  }
  const bound =
    input.options.boundProjectOf === undefined
      ? null
      : await input.options.boundProjectOf(input.integrationId);
  if (bound === null) {
    return both(
      'Not checked: no project is bound to this integration yet, so there is no project whose deploy keys and default branch could be read. Bind it and test again.',
    );
  }
  const access = (
    await input.options.executor.execute<DeployKeyAccess>({
      integration: input.ref,
      action: 'check_deploy_key',
      // The project and the key's public half only — never the private key.
      payload: { project: bound.path },
      projectId: null,
      taskId: null,
      mutating: false,
      perform: async () =>
        (git.deployKeyAccess as GitProviderPort['deployKeyAccess'])(bound.path, input.publicKey),
      describeResult: (result) => ({ enabled: result.enabled, can_push: result.canPush }),
    })
  ).result;
  const keyCheck: IntegrationProbeCheck = !access.enabled
    ? {
        name: key,
        ok: false,
        detail: `Refused: the declared public key is not one of ${bound.path}'s deploy keys — add it under Settings › Repository › Deploy keys with "Grant write permissions". ${DEPLOY_KEY_REACH}`,
      }
    : !access.canPush
      ? {
          name: key,
          ok: false,
          detail: `Refused: the deploy key is enabled on ${bound.path} without write access, so no writing stage could push — grant it write permissions. ${DEPLOY_KEY_REACH}`,
        }
      : {
          name: key,
          ok: true,
          detail: `The deploy key is enabled on ${bound.path} with write access. ${DEPLOY_KEY_REACH}`,
        };
  const rule = (
    await input.options.executor.execute<BranchPushProtection>({
      integration: input.ref,
      action: 'check_default_branch_protection',
      payload: { project: bound.path, branch: bound.defaultBranch },
      projectId: null,
      taskId: null,
      mutating: false,
      perform: async () =>
        (git.branchPushProtection as GitProviderPort['branchPushProtection'])(
          bound.path,
          bound.defaultBranch,
        ),
      describeResult: (result) => ({
        protected: result.protected,
        nobody_pushes: result.nobodyPushes,
        force_push_allowed: result.forcePushAllowed,
      }),
    })
  ).result;
  const fault = deployKeyProtectionFault(bound.path, bound.defaultBranch, {
    ...rule,
    pushers: rule.pushers.map(input.redact),
  });
  return [
    keyCheck,
    fault === null
      ? {
          name: protection,
          ok: true,
          detail: `${bound.defaultBranch} of ${bound.path} is protected with push "No one", which admits no deploy key.`,
        }
      : { name: protection, ok: false, detail: `Refused: ${fault}.` },
  ];
};
