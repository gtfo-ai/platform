/**
 * The run-scoped git credential broker (TD-021 § "Credentials", technical/05 § "Credentials and
 * identity").
 *
 * The launcher mints one short-lived credential per run, the workspace's git credential helper
 * asks the shim for it over the control socket (`cred.get`), and the shim relays the question to
 * the runner — which answers **here**, on the platform side of the volume, where the agent cannot
 * read the allow-list (Q50). At run end the credential is revoked, once.
 *
 * ## Why the allow-list is an exact match, and which negatives prove it
 *
 * `cred.get` names a host, and the answer is a push credential for the project's repository. The
 * only thing between "the workspace asked for the git host" and "the workspace asked for a host it
 * controls" is how that name is compared. `evil.example.com` is refused by every candidate
 * implementation and therefore proves nothing (standing rule 43, which cost WP-13 a round on this
 * very allow-list). The cases that discriminate are `evil-gitlab.example.com` (which `endsWith`
 * accepts), `gitlab.example.com.evil.test` (which `startsWith` and a substring match accept),
 * `gitlab.example.com.` (the DNS-absolute spelling of the same name, which a normalising
 * comparison accepts and this one does not) and `GITLAB.example.com` (which a case-insensitive
 * comparison accepts). `broker.test.ts` drives all four against the mutation that would pass them.
 *
 * ## Three states, not two
 *
 * A run that has not been issued a credential, a run holding one, and a run whose credential has
 * been revoked are different, and the last is the one that matters: the window between "the run
 * ended" and "the container is gone" is real (`stdioFlushMs`, plus however long a grandchild holds
 * a pipe), and a broker that kept answering in it would hand a live push token to a workspace the
 * platform has already stopped watching. After {@link RunCredentialBroker.revoke} the answer is
 * `null` for ever, and it is asserted rather than described.
 */
import type { Logger, WorkspaceGitCredential } from '@platform/application';
import { silentLogger } from '@platform/application';

/**
 * What the broker needs from a git provider, restated so this module does not depend on the
 * integration ports: the composition root decides whether the calls travel through
 * `IntegrationActionExecutor` (they do, in production — shadow mode, idempotency and audit are
 * that executor's, and minting is a mutation).
 */
export interface RunCredentialSource {
  mint(request: {
    readonly project: string;
    readonly scope: 'read' | 'push';
    readonly branchPatterns: readonly string[];
    readonly ttlSeconds: number;
  }): Promise<{
    readonly username: string | null;
    readonly value: string;
    readonly expiresAt: string;
    readonly revokeId: string | null;
  }>;
  revoke(credential: { readonly value: string; readonly revokeId: string | null }): Promise<void>;
}

export interface IssueRequest {
  readonly runId: string;
  /** The provider's project handle — not the platform's project id. */
  readonly project: string;
  /** The git host the workspace will be told to authenticate against. Lowercase, no port. */
  readonly host: string;
  /** BD-021: a read-only stage gets no write credential at all. */
  readonly readOnly: boolean;
  /** BD-025's namespace. */
  readonly branchPatterns: readonly string[];
  readonly ttlSeconds: number;
}

interface Issued {
  readonly host: string;
  readonly credential: WorkspaceGitCredential;
  readonly revokeId: string | null;
  revoked: boolean;
}

export class RunCredentialBroker {
  readonly #source: RunCredentialSource;
  readonly #logger: Logger;
  readonly #issued = new Map<string, Issued>();

  constructor(source: RunCredentialSource, logger: Logger = silentLogger) {
    this.#source = source;
    this.#logger = logger;
  }

  /**
   * Mints the run's credential, or answers `null` for a read-only stage.
   *
   * Returns the credential so the launcher can use it for the mirror fetch and the export push;
   * it is never written to the container's environment, never logged and never persisted.
   */
  async issue(request: IssueRequest): Promise<WorkspaceGitCredential | null> {
    if (request.readOnly) {
      this.#logger.debug({ run_id: request.runId }, 'read-only run: no git credential minted');
      return null;
    }
    const minted = await this.#source.mint({
      project: request.project,
      scope: 'push',
      branchPatterns: request.branchPatterns,
      ttlSeconds: request.ttlSeconds,
    });
    const credential: WorkspaceGitCredential = {
      host: request.host,
      username: minted.username ?? 'agentic',
      password: minted.value,
    };
    this.#issued.set(request.runId, {
      host: request.host,
      credential,
      revokeId: minted.revokeId,
      revoked: false,
    });
    return credential;
  }

  /**
   * The answer to a `cred.get` from run `runId`, or `null`.
   *
   * `null` is a normal answer on this wire: a refused host and an unconfigured one are
   * indistinguishable to the workspace, which is the point.
   */
  answer(runId: string, host: string): WorkspaceGitCredential | null {
    const issued = this.#issued.get(runId);
    if (issued === undefined || issued.revoked) {
      return null;
    }
    // Exact. Not `endsWith`, not `includes`, not a case fold, not a trailing-dot strip — see the
    // docblock for which wrong implementation each of those is.
    if (host !== issued.host) {
      this.#logger.warn({ run_id: runId }, 'workspace asked for a credential for another host');
      return null;
    }
    return issued.credential;
  }

  /**
   * The run's credential, for the **launcher's own** use — the mirror fetch and the export push.
   *
   * Deliberately not the same function as {@link answer}, and the difference is the whole design:
   * `answer` is the *workspace's* question, so it carries the host the workspace named and refuses
   * anything but an exact match; this is the platform side of the volume asking about a run it
   * created, where there is no untrusted host to compare. Collapsing the two would mean either the
   * launcher inventing a host string to satisfy a guard aimed at somebody else, or the guard being
   * skipped for the caller that needs it.
   *
   * Still `null` after {@link revoke}: a revoked credential is not a credential.
   */
  credentialFor(runId: string): WorkspaceGitCredential | null {
    const issued = this.#issued.get(runId);
    return issued === undefined || issued.revoked ? null : issued.credential;
  }

  /**
   * Revokes the run's credential. Idempotent, and it marks the run refused *before* the provider
   * call: if revocation fails, the broker must already have stopped answering.
   */
  async revoke(runId: string): Promise<void> {
    const issued = this.#issued.get(runId);
    if (issued === undefined || issued.revoked) {
      return;
    }
    issued.revoked = true;
    try {
      await this.#source.revoke({ value: issued.credential.password, revokeId: issued.revokeId });
    } finally {
      this.#issued.delete(runId);
    }
  }

  /** How many runs currently hold a live credential. Diagnostics; never the credential itself. */
  get liveCount(): number {
    return this.#issued.size;
  }
}
