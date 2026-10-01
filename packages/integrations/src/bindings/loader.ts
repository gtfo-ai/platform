/**
 * Turning a project's rows into the objects the pipeline calls — the loader nobody's work package
 * owned (WP-15a).
 *
 * `createPipelineRuntime` has always taken a `PipelineIntegrations`, and until this file existed the
 * only thing that built one was a test harness: twenty-three work packages, a pipeline that walks a
 * ticket from `ticket.matched` to `task.completed`, and **nothing that read the `bindings` table**.
 * This is the step between them. Given a project it reads the bindings, decrypts each integration's
 * credentials, validates the merged config against the provider's own schema, builds the adapter
 * through the provider's registration, and wraps the three the pipeline knows about — the git
 * provider, the task manager and (since WP-32) the chat binding the notification band posts
 * through — in `IntegrationActionExecutor`. Since WP-89 it also builds a project's Sentry and Loki
 * bindings, one type at a time, through `forObservability`, whose docblock says why that answer is
 * separate from `forProject`'s.
 *
 * ## Absent is not broken (standing rule 20)
 *
 * A project with **no** git binding resolves to `git: null`. A project *with* a git binding that
 * cannot be built — a provider nobody registered, a config that fails its schema, a credential
 * that will not decrypt — throws {@link BindingLoadError}. The two are different facts and the
 * difference is the whole rule: a binding that fails to load silently becomes a project that
 * quietly has no integrations.
 *
 * **This half of the guarantee is not this file's**, and review round 1 proved why saying so
 * matters (standing rules 44 and 63: a scope claim is a claim about every *other* file). The first
 * version of this docblock went on to assert that the split stopped "a task passing every gate that
 * asks a provider a question by getting `null` back" — and it did not, because
 * `pipeline/gates.ts` collapsed *two* producers of `null`: an unbound project and a commit with no
 * CI pipeline, the second of which product/04 S4 makes **pass**. A project with no bindings walked
 * through `ci_gate` on `passed: true`. The consumer is where that had to be fixed, and the gate now
 * asks `bindings.git === null` by identity before it reads anything
 * (`gates.test.ts` › "refuses the CI gate when the project has no git binding, instead of passing
 * it"). What this file guarantees is only that *absent* and *broken* arrive here as different
 * facts; what each consumer does with `null` is that consumer's guard to hold.
 *
 * Two bindings of one type is also a refusal rather than a coin toss. The pipeline holds exactly
 * one git repository and one ticket system per task (`PipelineIntegrations`), so choosing between
 * two by sort order would make which repository a task pushes to depend on the name an operator
 * typed. product/08's settings screen binds one per type; until something changes that, this says
 * so where it can be fixed.
 *
 * ## The redactor, and where the run's credentials come in (Q55)
 *
 * Every adapter is built with a redactor composed from two lists:
 *
 *  1. the **binding's own** resolved credentials, named `<provider>:<integrationId>:<field>` so two
 *     bindings of one provider cannot collide on a placeholder (`bindingSecretRedactor`'s docblock
 *     asks a composition root for exactly this, and `exactSecretRedactor` throws on a collision);
 *  2. the **call's** run-scoped credentials — `IntegrationCallScope`, required by the type.
 *
 * The first of those is **defence in depth against a provider this repository has not written yet**,
 * and standing rule 22 says to name the outer guard that makes it unreachable rather than let it
 * look tested. Measured: deleting it leaves every test in `loader.test.ts` green *except* the one
 * written for it, because both registered adapters compose a redactor over their own resolved
 * credentials and `providers/emitted-secrets.test.ts` holds them to it. But that file is a
 * hand-written enumeration of **two** providers rather than a sweep of `providers/` (rule 7), so it
 * is exactly a sixth provider — the one whose review is the one that misses this, twice already —
 * that the loader's half covers. The seam that keeps it honest is a registration that uses the
 * redactor it is handed and composes none of its own, which is what GitLab did until WP-11's
 * follow-up: `loader.test.ts` › "redacts a credential the provider does not redact for itself".
 *
 * That is Q55's recommendation (a): *make the run the scope*. The redactor cannot be built once at
 * binding time, because the token that matters most is minted per run and did not exist then; so
 * the adapters are built per call and the scope is an argument. What WP-15a did **not** do is
 * change what the CI gate returns — it returned the failing job's *names* rather than `getJobLog`'s
 * body until WP-81. Since WP-76 a run's credential **is** minted — by the runner, through this
 * loader — and the one call made with a run's scope is its revocation; the gate runs after the
 * run, with the process-wide registry of minted credentials in its platform redactor rather than a
 * run scope (`apps/server/src/pipeline.ts`); a process that did not mint redacts it by its recorded
 * shape since WP-80 (TD-012's M5 amendment, PROGRESS backlog 259). **WP-81 closed the gate's
 * half** on that redactor: the failing job's log is read, redacted by the binding's redactor on the
 * whole text, bounded, and handed back (`packages/application/src/pipeline/ci-log.ts`).
 *
 * ## Cost, stated rather than optimised away
 *
 * There is **no cache**. Every call reads the rows and constructs the adapters, which is a query
 * and some object allocation per provider call. A cache here would have to be invalidated by a
 * settings change, a credential rotation and a rate-limit budget that lives on the adapter — and
 * it would have to hold decrypted credentials in memory for as long as it held an entry. Caching
 * is a decision with evidence behind it, not a default; when a measurement asks for one, the place
 * to put it is `BindingRepository`, not here, because that is the half that is actually a query.
 */
import type {
  BindingRepository,
  CredentialMintingHints,
  GitProviderPort,
  InjectedSecret,
  IntegrationActionExecutor,
  IntegrationCallScope,
  MintingIntegration,
  ObservabilityBinding,
  ObservabilityPortByType,
  ObservabilityType,
  PipelineIntegrations,
  PipelineIntegrationsPort,
  ProjectBinding,
  ProjectBindingSecrets,
  SecretRedactor,
  SecretStore,
} from '@platform/application';
import {
  bindingSecretRedactor,
  composeSecretRedactors,
  IntegrationUnsupportedError,
  noSecretsRedactor,
} from '@platform/application';
import type { Id, IntegrationType } from '@platform/contracts';
import type { IntegrationPortByType, IntegrationRegistry } from '../registry.js';

export class BindingLoadError extends Error {
  override readonly name = 'BindingLoadError';
  /** `null` for the organisation's own account, which is built with no project (WP-65). */
  readonly projectId: Id | null;
  /**
   * The binding that could not be built, or `null` when the project's *set* is the problem — and
   * `null` for an **account** built with no binding (the minting integration, WP-80), whose id is
   * {@link integrationId} instead (WP-107, PROGRESS backlog 278).
   */
  readonly bindingId: Id | null;
  /** The integration (account) that could not be built, when the failing site knows it. */
  readonly integrationId: Id | null;

  constructor(
    projectId: Id | null,
    bindingId: Id | null,
    message: string,
    options: { cause?: unknown; integrationId?: Id } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.projectId = projectId;
    this.bindingId = bindingId;
    this.integrationId = options.integrationId ?? null;
  }
}

export interface PipelineIntegrationsLoaderOptions {
  readonly repository: BindingRepository;
  readonly secrets: SecretStore;
  readonly registry: IntegrationRegistry;
  /** One per process: the shadow guard, the idempotency store, the rate limits and the audit log. */
  readonly executor: IntegrationActionExecutor;
  /**
   * Which repository path a project's git binding is bound to.
   *
   * It is not on the integration: `integrations` is the *account* (a GitLab instance), and the path
   * `acme/api` is the project's. technical/03 puts it on `projects.repo_url`, so the composition
   * root resolves it from there rather than this file inventing a second home for it.
   */
  readonly gitProjectPath: (projectId: Id) => Promise<string>;
  /**
   * The platform's own redactor, composed **after** the binding's exact-match one — TD-012 step 2.
   *
   * The same option `createInboundIntegrationLoader` takes, for the same reason and now for a
   * second sink. WP-15c passes `patternRedactor()` there because the delivery is written to
   * `inbox(headers, payload)`; WP-15f created the other place the platform stores provider **text**
   * — `tasks.ticket_snapshot`, which is read into every prompt (and which a task DTO will serve
   * once one carries it; none does today) — and
   * without this the two sinks of *one* provider call were treated oppositely: a `glpat-…` pasted
   * into a ticket description was pattern-redacted in the `integration_actions` row (the executor
   * holds its own `patternRedactor`) and stored verbatim beside it.
   *
   * Optional in the type and *named* rather than defaulted at every call site, like the inbound
   * loader's: the composition root passes `patternRedactor()`, and a caller that really means
   * "nothing but this binding's own secrets" passes {@link noSecretsRedactor} in full. It is not a
   * silent no-op (standing rule 31), and the visible default is the binding's own redactor, which
   * is never absent.
   */
  readonly platformRedactor?: SecretRedactor;
}

/** `<provider>:<integrationId>:<field>` — unique per binding, so two accounts cannot collide. */
const secretName = (binding: ProjectBinding, field: string): string =>
  `${binding.provider}:${binding.integrationId}:${field}`;

/**
 * The decrypted credentials of **every** binding of a project, named as {@link
 * createPipelineIntegrationsLoader} names them for a binding's own redactor — WP-107, TD-012's M6
 * amendment (2), PROGRESS backlog 316.
 *
 * The one consumer is the repository reading (`refreshRepositoryConfig`), which stores text a human
 * committed to `.agentic/prompts/` and composes an exact-value redactor over these before it stores
 * it. Every type, not only the three the pipeline calls: a Sentry or Loki token committed to a
 * prompt file is a credential the platform holds as much as a Jira one. Two bindings of one account
 * resolve to the same names and values and are kept once.
 *
 * **A credential that will not decrypt is reported, not thrown** (backlog 358): the integration is
 * named in `unreadable` with the store's reason, and every other binding's credentials are still
 * returned, so the reading stores its configuration and withholds only its prompt texts — one
 * broken Sentry token must not keep a merged restriction from applying (WP-89's *a broken
 * observability binding stops nothing*). Outside any transaction, like every read of the secret
 * store; the values leave only in the returned list, never in a reason.
 */
export const createProjectBindingSecrets =
  (options: { readonly repository: BindingRepository; readonly secrets: SecretStore }) =>
  async (projectId: Id): Promise<ProjectBindingSecrets> => {
    const named = new Map<string, InjectedSecret>();
    const unreadable = new Map<Id, { integration: string; reason: string }>();
    for (const binding of await options.repository.forProject(projectId)) {
      let resolved: Readonly<Record<string, string>>;
      try {
        resolved = await options.secrets.resolve(binding.secretIds);
      } catch (cause) {
        unreadable.set(binding.integrationId, {
          integration: `integration "${binding.name}" (${binding.provider}, ${binding.integrationId})`,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        continue;
      }
      for (const [field, value] of Object.entries(resolved)) {
        const name = secretName(binding, field);
        if (!named.has(name)) {
          named.set(name, { name, value });
        }
      }
    }
    return { secrets: [...named.values()], unreadable: [...unreadable.values()] };
  };

/** A built adapter and the redactor it was built with (WP-15f), plus WP-32's channels. */
interface Built<TType extends IntegrationType> {
  readonly port: IntegrationPortByType[TType];
  readonly redactor: SecretRedactor;
  /**
   * Where a `communication` binding posts, read from the key the **registration** declares and out
   * of the **validated** config (WP-32).
   *
   * `''` for every other type, because the field is not optional on the interface: a type that has
   * no channel must not be able to be *given* one by accident, and a consumer only ever reads it
   * through `PipelineIntegrations.communication`, which exists exactly when this was filled in.
   */
  readonly channel: string;
  readonly digestChannel: string;
  /** The registration's credential-minting hints (WP-107); absent for a provider that mints nothing. */
  readonly mintingHints?: CredentialMintingHints;
}

/**
 * The channel a communication binding names, out of the config the provider's schema just accepted.
 *
 * It is read here rather than in the adapter because it is the *pipeline* that needs to know where
 * a notification goes, and the adapter's `postTaskThread` takes the channel as an argument. A value
 * that is not a non-empty string is a `BindingLoadError`, not a default: a chat binding with no
 * channel would post nowhere, and standing rule 18 is about exactly the case where an absent value
 * silently produces a permissive result.
 */
const channelsOf = (
  projectId: Id | null,
  binding: ProjectBinding,
  config: unknown,
  fields: { readonly channel: string; readonly digestChannel?: string } | undefined,
): { channel: string; digestChannel: string } => {
  if (fields === undefined) {
    throw new BindingLoadError(
      projectId,
      binding.bindingId,
      `binding "${binding.name}" (${binding.provider}) is a communication provider that declares no channel field`,
    );
  }
  const values = config as Record<string, unknown>;
  const channel = values[fields.channel];
  if (typeof channel !== 'string' || channel.trim() === '') {
    throw new BindingLoadError(
      projectId,
      binding.bindingId,
      `binding "${binding.name}" (${binding.provider}) names no channel in "${fields.channel}"; a notification would be posted nowhere`,
    );
  }
  const digest = fields.digestChannel === undefined ? undefined : values[fields.digestChannel];
  return {
    channel,
    digestChannel: typeof digest === 'string' && digest.trim() !== '' ? digest : channel,
  };
};

const only = <T>(
  projectId: Id,
  type: IntegrationType,
  candidates: readonly { binding: ProjectBinding; built: T }[],
): { binding: ProjectBinding; built: T } | null => {
  if (candidates.length === 0) {
    return null;
  }
  const first = candidates[0];
  if (candidates.length > 1 || first === undefined) {
    throw new BindingLoadError(
      projectId,
      null,
      `the project has ${candidates.length} "${type}" bindings (${candidates
        .map((candidate) => `${candidate.binding.provider}/${candidate.binding.name}`)
        .join(', ')}); the pipeline holds one per task, so one of them must be unbound`,
    );
  }
  return first;
};

/**
 * A git port whose registration declared no credential minting, with the capability **declined**
 * (WP-80, TD-012's M5 amendment): `capabilities().credentialMinting` reads `false` and
 * `mintCredential` refuses, whatever the adapter says. The registration's declaration — refused at
 * boot unless it names a stable shape — is what admits minting, so an adapter that reports the
 * flag without it mints nothing a process other than its minter could not redact.
 *
 * A `Proxy` rather than a spread: an adapter is free to be a class whose members read `this`, and a
 * copy would detach them. A port that does not claim the capability is returned as it is.
 */
export const declineUndeclaredMinting = <TType extends IntegrationType>(
  registration: ReturnType<IntegrationRegistry['get']>,
  type: TType,
  port: IntegrationPortByType[TType],
): IntegrationPortByType[TType] => {
  if (type !== 'git' || registration.credentialMinting !== undefined) {
    return port;
  }
  const git = port as GitProviderPort;
  if (!git.capabilities().credentialMinting) {
    return port;
  }
  return new Proxy(git, {
    get: (target, property, receiver) => {
      if (property === 'capabilities') {
        return () => ({ ...target.capabilities(), credentialMinting: false });
      }
      if (property === 'mintCredential') {
        return async () => {
          throw new IntegrationUnsupportedError(
            registration.id,
            'credential minting (the provider registration declares no stable credential shape, WP-80)',
          );
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as IntegrationPortByType[TType];
};

export const createPipelineIntegrationsLoader = (
  options: PipelineIntegrationsLoaderOptions,
): PipelineIntegrationsPort => {
  const platformRedactor = options.platformRedactor ?? noSecretsRedactor();
  const build = async <TType extends IntegrationType>(
    projectId: Id | null,
    binding: ProjectBinding,
    type: TType,
    scope: IntegrationCallScope,
    /**
     * What the row is called in a refusal: a project's **binding**, or an **integration** built
     * from its account alone (`forMintingIntegration`) — which is not a binding, so it is not
     * named one and carries no binding id (WP-107, PROGRESS backlog 278).
     */
    subject: 'binding' | 'integration' = 'binding',
  ): Promise<Built<TType>> => {
    const failing = subject === 'binding' ? binding.bindingId : null;
    const refusal = (message: string, cause?: unknown): BindingLoadError =>
      new BindingLoadError(projectId, failing, message, {
        integrationId: binding.integrationId,
        ...(cause === undefined ? {} : { cause }),
      });
    if (binding.retired) {
      // WP-114: the integration's credentials were destroyed when it was retired, and the retire is
      // refused while a binding names it — so this row was written past that refusal. Refused by
      // name, never read as an absent binding (standing rule 20).
      throw refusal(
        `${subject} "${binding.name}" (${binding.provider}) names integration ${binding.integrationId}, which is retired: its credentials are destroyed, so it cannot be loaded. Bind a live integration instead`,
      );
    }
    let registration: ReturnType<IntegrationRegistry['get']>;
    try {
      registration = options.registry.get(type, binding.provider);
    } catch (cause) {
      throw refusal(
        `${subject} "${binding.name}" names provider "${binding.provider}", which this build does not register`,
        cause,
      );
    }

    let secrets: Readonly<Record<string, string>>;
    try {
      secrets = await options.secrets.resolve(binding.secretIds);
    } catch (cause) {
      throw refusal(
        `${subject} "${binding.name}" (${binding.provider}) has credentials that cannot be read: ${
          (cause as Error).message
        }`,
        cause,
      );
    }

    const injected: InjectedSecret[] = Object.entries(secrets).map(([field, value]) => ({
      name: secretName(binding, field),
      value,
    }));
    const redactor = composeSecretRedactors(
      bindingSecretRedactor(injected),
      bindingSecretRedactor(scope.runScopedSecrets),
      platformRedactor,
    );

    const parsed = registration.configSchema.safeParse({ ...binding.config, ...secrets });
    if (!parsed.success) {
      // The paths, never the values: a config document holds the credential this just merged in.
      const paths = parsed.error.issues
        .map((issue) => (issue.path.length === 0 ? '<root>' : issue.path.join('.')))
        .join(', ');
      throw refusal(
        `${subject} "${binding.name}" (${binding.provider}) has configuration that fails its schema at: ${paths}`,
      );
    }

    const channels =
      type === 'communication'
        ? channelsOf(projectId, binding, parsed.data, registration.communicationChannels)
        : { channel: '', digestChannel: '' };

    try {
      const mintingHints = registration.credentialMinting?.hints;
      return {
        ...channels,
        ...(mintingHints === undefined ? {} : { mintingHints }),
        port: declineUndeclaredMinting(
          registration,
          type,
          registration.create({
            integrationId: binding.integrationId,
            config: parsed.data,
            secrets,
            redactor,
          }) as IntegrationPortByType[TType],
        ),
        // Handed out beside the port because the one caller that stores provider **text** needs it
        // and the executor's redactor is a different one (`TaskManagementBinding.redactor`,
        // WP-15f): step 1 of TD-012 belongs to the binding, step 2 to the process.
        redactor,
      };
    } catch (cause) {
      throw refusal(
        `${subject} "${binding.name}" (${binding.provider}) could not be instantiated`,
        cause,
      );
    }
  };

  /**
   * The minting integration, from its **account** alone (WP-80, TD-028 decision 10): the revoke
   * needs the account's credential and host, and a revocation address carries its own project, so
   * no binding — which an unbound integration no longer has — is read. Built through the same
   * {@link build} as a binding, so the redactor, the schema check and the refusals are the ones
   * every other adapter gets.
   */
  const forMintingIntegration = async (
    integrationId: Id,
    scope: IntegrationCallScope,
  ): Promise<MintingIntegration | null> => {
    const account = await options.repository.forIntegration(integrationId);
    if (account === null) {
      return null;
    }
    if (account.type !== 'git') {
      throw new BindingLoadError(
        null,
        null,
        `integration "${account.name}" (${account.provider}) minted a run credential but is a "${account.type}" integration, so no git adapter can revoke it`,
      );
    }
    const built = await build(
      null,
      {
        bindingId: integrationId,
        integrationId,
        type: 'git',
        provider: account.provider,
        name: account.name,
        config: account.config,
        secretIds: account.secretIds,
        // `forIntegration` answers no account for a retired integration, so this one is live.
        retired: false,
      },
      'git',
      scope,
      'integration',
    );
    return {
      executor: options.executor,
      port: built.port,
      ref: built.port.ref,
      redactor: built.redactor,
    };
  };

  /**
   * The project's Sentry or Loki binding (WP-89) — built by the same {@link build} as every other
   * binding, so the redactor, the strict schema parse and the refusals are the ones the pipeline's
   * three get, and a type with two bindings is refused by the same {@link only}.
   *
   * A separate member, per type, rather than two more fields on `forProject`'s answer, because the
   * answers fail differently on purpose: a git or ticket binding that will not load stops the
   * pipeline (rule 20's *broken is not absent*), and an observability binding that will not load
   * must stop **nothing** — the one caller, the bug pre-fetch, catches this throw and runs the
   * investigation without that excerpt. Folded into `forProject`, a Sentry token that no longer
   * decrypted would have been a `BindingLoadError` on every pipeline call the project made.
   */
  const forObservability = async <TType extends ObservabilityType>(
    projectId: Id,
    type: TType,
    scope: IntegrationCallScope,
  ): Promise<ObservabilityBinding<ObservabilityPortByType[TType]> | null> => {
    const candidates = [];
    for (const binding of (await options.repository.forProject(projectId)).filter(
      (row) => row.type === type,
    )) {
      candidates.push({ binding, built: await build(projectId, binding, type, scope) });
    }
    const chosen = only(projectId, type, candidates);
    if (chosen === null) {
      return null;
    }
    const port = chosen.built.port as ObservabilityPortByType[TType];
    return { executor: options.executor, port, ref: port.ref, redactor: chosen.built.redactor };
  };

  return {
    forMintingIntegration,
    forObservability,
    forProject: async (
      projectId: Id,
      scope: IntegrationCallScope,
    ): Promise<PipelineIntegrations> => {
      const bindings = await options.repository.forProject(projectId);

      const gitCandidates = [];
      for (const binding of bindings.filter((row) => row.type === 'git')) {
        gitCandidates.push({ binding, built: await build(projectId, binding, 'git', scope) });
      }
      const ticketCandidates = [];
      for (const binding of bindings.filter((row) => row.type === 'task_management')) {
        ticketCandidates.push({
          binding,
          built: await build(projectId, binding, 'task_management', scope),
        });
      }

      const chatCandidates = [];
      for (const binding of bindings.filter((row) => row.type === 'communication')) {
        chatCandidates.push({
          binding,
          built: await build(projectId, binding, 'communication', scope),
        });
      }

      const git = only(projectId, 'git', gitCandidates);
      const taskManagement = only(projectId, 'task_management', ticketCandidates);
      const chat = only(projectId, 'communication', chatCandidates);

      return {
        executor: options.executor,
        git:
          git === null
            ? null
            : {
                port: git.built.port,
                ref: git.built.port.ref,
                project: await options.gitProjectPath(projectId),
                // WP-24: the same value the adapter was built with, for the two sinks the pipeline
                // owns itself — `tasks.review_subject` and a finding on its way to a thread.
                redactor: git.built.redactor,
                // WP-107 (backlog 278): the provider's words for the mint refusals, so the ring
                // that renders them names no provider.
                ...(git.built.mintingHints === undefined
                  ? {}
                  : { mintingHints: git.built.mintingHints }),
              },
        taskManagement:
          taskManagement === null
            ? null
            : {
                port: taskManagement.built.port,
                ref: taskManagement.built.port.ref,
                redactor: taskManagement.built.redactor,
              },
        communication:
          chat === null
            ? null
            : {
                port: chat.built.port,
                ref: chat.built.port.ref,
                // The provider says which key holds it (`communicationChannels`) and the registry
                // refuses a registration that does not; this reads the declared key out of the
                // **validated** config, so a channel that failed the provider's own schema never
                // reaches a call.
                channel: chat.built.channel,
                digestChannel: chat.built.digestChannel,
                // WP-32: the notify duty stores the text it sends (`notifications.title`/`detail`).
                redactor: chat.built.redactor,
              },
      };
    },
  };
};
