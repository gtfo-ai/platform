/**
 * Turning a project's rows into the objects the pipeline calls — the loader nobody's work package
 * owned (WP-15a).
 *
 * `createPipelineRuntime` has always taken a `PipelineIntegrations`, and until this file existed the
 * only thing that built one was a test harness: twenty-three work packages, a pipeline that walks a
 * ticket from `ticket.matched` to `task.completed`, and **nothing that read the `bindings` table**.
 * This is the step between them. Given a project it reads the bindings, decrypts each integration's
 * credentials, validates the merged config against the provider's own schema, builds the adapter
 * through the provider's registration, and wraps the two the pipeline knows about — the git
 * provider and the task manager — in `IntegrationActionExecutor`.
 *
 * ## Absent is not broken (standing rule 20)
 *
 * A project with **no** git binding resolves to `git: null`, and the sagas and the gate evaluator
 * already say so with a blocker brief. A project *with* a git binding that cannot be built —
 * a provider nobody registered, a config that fails its schema, a credential that will not
 * decrypt — throws {@link BindingLoadError}. The two are different facts and the difference is the
 * whole rule: a binding that fails to load silently becomes a project that quietly has no
 * integrations, and a task then passes every gate that asks a provider a question by getting
 * `null` back.
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
 * the adapters are built per call and the scope is an argument. What WP-15a does **not** do is
 * change what the CI gate returns — it still returns the failing job's *names* rather than
 * `getJobLog`'s body — because nothing on the pipeline's path holds a minted credential yet: the
 * runner reaches the launcher's broker over a transport that does not exist (Q52). The mechanism is
 * closed here; the gate's cut stays where WP-15 put it, pinned by `gates.test.ts`.
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
  InjectedSecret,
  IntegrationActionExecutor,
  IntegrationCallScope,
  PipelineIntegrations,
  PipelineIntegrationsPort,
  ProjectBinding,
  SecretStore,
} from '@platform/application';
import { bindingSecretRedactor, composeSecretRedactors } from '@platform/application';
import type { Id, IntegrationType } from '@platform/contracts';
import type { IntegrationPortByType, IntegrationRegistry } from '../registry.js';

export class BindingLoadError extends Error {
  override readonly name = 'BindingLoadError';
  readonly projectId: Id;
  /** The binding that could not be built, or `null` when the project's *set* is the problem. */
  readonly bindingId: Id | null;

  constructor(
    projectId: Id,
    bindingId: Id | null,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.projectId = projectId;
    this.bindingId = bindingId;
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
}

/** `<provider>:<integrationId>:<field>` — unique per binding, so two accounts cannot collide. */
const secretName = (binding: ProjectBinding, field: string): string =>
  `${binding.provider}:${binding.integrationId}:${field}`;

const only = <T>(
  projectId: Id,
  type: IntegrationType,
  candidates: readonly { binding: ProjectBinding; port: T }[],
): { binding: ProjectBinding; port: T } | null => {
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

export const createPipelineIntegrationsLoader = (
  options: PipelineIntegrationsLoaderOptions,
): PipelineIntegrationsPort => {
  const build = async <TType extends IntegrationType>(
    projectId: Id,
    binding: ProjectBinding,
    type: TType,
    scope: IntegrationCallScope,
  ): Promise<IntegrationPortByType[TType]> => {
    let registration: ReturnType<IntegrationRegistry['get']>;
    try {
      registration = options.registry.get(type, binding.provider);
    } catch (cause) {
      throw new BindingLoadError(
        projectId,
        binding.bindingId,
        `binding "${binding.name}" names provider "${binding.provider}", which this build does not register`,
        { cause },
      );
    }

    let secrets: Readonly<Record<string, string>>;
    try {
      secrets = await options.secrets.resolve(binding.secretIds);
    } catch (cause) {
      throw new BindingLoadError(
        projectId,
        binding.bindingId,
        `binding "${binding.name}" (${binding.provider}) has credentials that cannot be read: ${
          (cause as Error).message
        }`,
        { cause },
      );
    }

    const injected: InjectedSecret[] = Object.entries(secrets).map(([field, value]) => ({
      name: secretName(binding, field),
      value,
    }));
    const redactor = composeSecretRedactors(
      bindingSecretRedactor(injected),
      bindingSecretRedactor(scope.runScopedSecrets),
    );

    const parsed = registration.configSchema.safeParse({ ...binding.config, ...secrets });
    if (!parsed.success) {
      // The paths, never the values: a config document holds the credential this just merged in.
      const paths = parsed.error.issues
        .map((issue) => (issue.path.length === 0 ? '<root>' : issue.path.join('.')))
        .join(', ');
      throw new BindingLoadError(
        projectId,
        binding.bindingId,
        `binding "${binding.name}" (${binding.provider}) has configuration that fails its schema at: ${paths}`,
      );
    }

    try {
      return registration.create({
        integrationId: binding.integrationId,
        config: parsed.data,
        secrets,
        redactor,
      }) as IntegrationPortByType[TType];
    } catch (cause) {
      throw new BindingLoadError(
        projectId,
        binding.bindingId,
        `binding "${binding.name}" (${binding.provider}) could not be instantiated`,
        { cause },
      );
    }
  };

  return {
    forProject: async (
      projectId: Id,
      scope: IntegrationCallScope,
    ): Promise<PipelineIntegrations> => {
      const bindings = await options.repository.forProject(projectId);

      const gitCandidates = [];
      for (const binding of bindings.filter((row) => row.type === 'git')) {
        gitCandidates.push({ binding, port: await build(projectId, binding, 'git', scope) });
      }
      const ticketCandidates = [];
      for (const binding of bindings.filter((row) => row.type === 'task_management')) {
        ticketCandidates.push({
          binding,
          port: await build(projectId, binding, 'task_management', scope),
        });
      }

      const git = only(projectId, 'git', gitCandidates);
      const taskManagement = only(projectId, 'task_management', ticketCandidates);

      return {
        executor: options.executor,
        git:
          git === null
            ? null
            : {
                port: git.port,
                ref: git.port.ref,
                project: await options.gitProjectPath(projectId),
              },
        taskManagement:
          taskManagement === null
            ? null
            : { port: taskManagement.port, ref: taskManagement.port.ref },
      };
    },
  };
};
