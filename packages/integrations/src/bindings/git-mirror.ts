/**
 * The credential the knowledge indexer's mirror fetch authenticates with (WP-18a, TD-026).
 *
 * TD-026 decision 3: *"The credential is the project's **existing** git binding credential,
 * decrypted by WP-15a's `SecretStore` and binding loader, and it is supplied as a credential-helper
 * environment, never in the URL."* This is the "decrypted by" half — the rows, the decryption and
 * the provider's own declaration of which secret `git` wants — and nothing else: the environment,
 * the subprocess and the mirror belong to `packages/infrastructure/src/knowledge/git-vault.ts`,
 * which cannot import this package (the dependency rule makes `integrations` and `infrastructure`
 * peers).
 *
 * ## Why it is not `createPipelineIntegrationsLoader`
 *
 * That loader hands back **ports**, built through each provider's registration, and a port is an
 * HTTP client: it deliberately never exposes the plaintext credential, because every call it
 * mediates goes through `IntegrationActionExecutor`. A `git clone` is not one of those calls — it
 * is the git transport, the same operation the launcher's `updateMirror` performs, and it needs the
 * secret itself. So this reads the same three collaborators (`BindingRepository`, `SecretStore`,
 * `IntegrationRegistry`) and stops one step earlier.
 *
 * ## Absent, broken and empty are three different answers (standing rules 16, 18, 20)
 *
 *  - **No git binding** → `null`. A project that has not been bound to a repository has no vault to
 *    read, and the indexer reports `vault_unavailable` rather than an empty index.
 *  - **A binding that cannot be read** — two git bindings, a provider this build does not register,
 *    a credential that will not decrypt — throws {@link GitMirrorCredentialError}. A binding that
 *    fails to load silently becomes a project that quietly has no integrations, which is the
 *    distinction `loader.ts` exists to keep.
 *  - **A declared field that resolves to an empty string, or a provider with no
 *    `gitCredential` declaration** → also a throw. An empty credential is not a credential (rule
 *    18), and falling back to an anonymous fetch would work on a public repository and fail on
 *    every private one, which is the permissive default rule 16 names.
 *
 * Nothing here logs, stores or returns the credential anywhere but to its one caller: the value is
 * handed to `git` through the environment of one subprocess and is never written to the mirror's
 * `config`, to an argument vector, or to an audit row.
 */
import type { BindingRepository, ProjectBinding, SecretStore } from '@platform/application';
import type { Id } from '@platform/contracts';
import type { IntegrationRegistry } from '../registry.js';

/**
 * A username and password for one host, as `git`'s credential helper wants them.
 *
 * Structurally `WorkspaceGitCredential` without its `host` — restated here for the reason that type
 * states about `MintedCredential`: the ring that needs it cannot depend on the ring that declares
 * it. The host is not a field because the mirror fetch takes it from `projects.repo_url`, which is
 * the only address it ever contacts.
 */
export interface GitMirrorCredential {
  readonly username: string;
  readonly password: string;
}

export class GitMirrorCredentialError extends Error {
  override readonly name = 'GitMirrorCredentialError';
  readonly projectId: Id;

  constructor(projectId: Id, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.projectId = projectId;
  }
}

export interface GitMirrorCredentialsOptions {
  readonly repository: BindingRepository;
  readonly secrets: SecretStore;
  readonly registry: IntegrationRegistry;
}

export interface GitMirrorCredentials {
  /** The project's git credential, or `null` when the project has no git binding at all. */
  forProject(projectId: Id): Promise<GitMirrorCredential | null>;
}

const onlyGitBinding = (
  projectId: Id,
  bindings: readonly ProjectBinding[],
): ProjectBinding | null => {
  const git = bindings.filter((binding) => binding.type === 'git');
  const first = git[0];
  if (first === undefined) {
    return null;
  }
  if (git.length > 1) {
    // The same refusal `loader.ts` makes, for the same reason: choosing between two by sort order
    // would make which repository the index is built from depend on the name an operator typed.
    throw new GitMirrorCredentialError(
      projectId,
      `the project has ${git.length} "git" bindings (${git
        .map((binding) => `${binding.provider}/${binding.name}`)
        .join(', ')}); the knowledge mirror fetches one repository, so one of them must be unbound`,
    );
  }
  return first;
};

export const createGitMirrorCredentials = (
  options: GitMirrorCredentialsOptions,
): GitMirrorCredentials => ({
  forProject: async (projectId: Id): Promise<GitMirrorCredential | null> => {
    const binding = onlyGitBinding(projectId, await options.repository.forProject(projectId));
    if (binding === null) {
      return null;
    }

    let registration: ReturnType<IntegrationRegistry['get']>;
    try {
      registration = options.registry.get('git', binding.provider);
    } catch (cause) {
      throw new GitMirrorCredentialError(
        projectId,
        `git binding "${binding.name}" names provider "${binding.provider}", which this build does not register`,
        { cause },
      );
    }

    const declaration = registration.gitCredential;
    if (declaration === undefined) {
      throw new GitMirrorCredentialError(
        projectId,
        `provider "${binding.provider}" declares no static git credential, so the knowledge mirror has nothing to fetch with; it will not fetch anonymously (standing rule 16)`,
      );
    }

    let secrets: Readonly<Record<string, string>>;
    try {
      secrets = await options.secrets.resolve(binding.secretIds);
    } catch (cause) {
      throw new GitMirrorCredentialError(
        projectId,
        `git binding "${binding.name}" (${binding.provider}) has credentials that cannot be read: ${
          (cause as Error).message
        }`,
        { cause },
      );
    }

    const password = secrets[declaration.passwordField];
    if (password === undefined || password === '') {
      throw new GitMirrorCredentialError(
        projectId,
        `git binding "${binding.name}" (${binding.provider}) has no value for the credential field "${declaration.passwordField}"; an empty credential is not a credential (standing rule 18)`,
      );
    }
    return { username: declaration.username, password };
  },
});
