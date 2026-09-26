/**
 * The run-scoped git credential broker (TD-021 § "Credentials", technical/05 § "Credentials and
 * identity", TD-028's WP-76 amendment).
 *
 * **The runner mints; this holds.** One short-lived credential per run with a checkout is minted by
 * the process that composes the provisioner (`apps/server/src/workspaces.ts`) through
 * `IntegrationActionExecutor`, and the create request carries it to the launcher (TD-028's WP-76
 * amendment, decisions 1 and 3). The broker is what each side keeps it in — **the same class on
 * both sides of the control plane**:
 *
 *  - in the **launcher**, where {@link RunCredentialBroker.credentialFor} hands it to the mirror
 *    fetch and the take-over export push, and nothing else reads it;
 *  - in the **runner**, where {@link RunCredentialBroker.answer} is the reply to the workspace's
 *    `cred.get` — the git credential helper inside the run container asks the shim, the shim relays
 *    the question over the control socket, and the runner answers here, on the platform side of the
 *    volume, where the agent cannot read the allow-list (Q50).
 *
 * It calls no provider. Until WP-76 it took a `RunCredentialSource` and minted through it, and the
 * launcher — which holds no binding, no secret key and no database — could only compose a source
 * that refused, so every writing run failed at `startRun` (backlog 133). The amendment's
 * "pass-through source" is this class without the source: a `mint` that returns what the request
 * carried and a `revoke` that calls nobody is a holder spelled as a provider, and a holder is what
 * is left. Revocation is the runner's, through the executor, once (decision 5).
 *
 * ## Why the allow-list is an exact match, and which negatives prove it
 *
 * `cred.get` names a host, and the answer is a credential for the project's repository. The only
 * thing between "the workspace asked for the git host" and "the workspace asked for a host it
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
 * A run that holds no credential, a run holding one, and a run whose credential has been forgotten
 * are different, and the last is the one that matters: the window between "the run ended" and "the
 * credential is revoked at the provider" is real (the export pushes first, then `endRun` returns,
 * then the runner revokes), and a broker that kept answering in it would hand a live token to a
 * workspace the platform has already stopped watching. After {@link RunCredentialBroker.forget} the
 * answer is `null` until the run is **held again** — which only a new create does, and the control
 * plane admits a second create for a run id only after the first one *failed* (TD-028 decision 4),
 * so for a run that started the answer is `null` for the rest of its life. It is asserted rather
 * than described.
 */
import type { Logger, WorkspaceGitCredential } from '@platform/application';
import { silentLogger, WorkspaceError } from '@platform/application';

/** What a minted credential may be used for (`CredentialScope` on the provider port). */
export type RunCredentialScope = 'read' | 'push';

/** The credential material the create request carries — never a `revokeId` (decision 3). */
export interface CarriedRunCredential extends WorkspaceGitCredential {
  readonly scope: RunCredentialScope;
  /** When the provider stops honouring it. Diagnostics here; the provider is the enforcer. */
  readonly expiresAt: string;
}

export interface HoldRequest {
  readonly runId: string;
  /** BD-021: a read-only stage may hold a `read` credential and never a `push` one. */
  readonly readOnly: boolean;
  readonly credential: CarriedRunCredential;
}

export class RunCredentialBroker {
  readonly #logger: Logger;
  readonly #held = new Map<string, CarriedRunCredential>();

  constructor(logger: Logger = silentLogger) {
    this.#logger = logger;
  }

  /**
   * Holds the run's credential and returns the part a git helper uses.
   *
   * Refuses — `invalid_spec`, terminal — a `push` credential for a read-only run (BD-021; the
   * control-plane schema refuses the same shape, and this is the check that holds when a caller
   * reaches the broker without it) and a blank password or username (standing rule 18: an empty
   * credential is not a credential).
   */
  hold(request: HoldRequest): WorkspaceGitCredential {
    const { credential } = request;
    if (request.readOnly && credential.scope === 'push') {
      throw new WorkspaceError(
        'invalid_spec',
        'a read-only run was sent a push credential; it may hold a read credential or none (BD-021)',
        { runId: request.runId },
      );
    }
    if (credential.password.trim().length === 0 || credential.username.trim().length === 0) {
      throw new WorkspaceError(
        'invalid_spec',
        'the run credential has an empty username or password; an empty credential is not a credential',
        { runId: request.runId },
      );
    }
    this.#held.set(request.runId, credential);
    this.#logger.debug(
      { run_id: request.runId, scope: credential.scope },
      'holding the run credential the create request carried',
    );
    return { host: credential.host, username: credential.username, password: credential.password };
  }

  /**
   * The answer to a `cred.get` from run `runId`, or `null`.
   *
   * `null` is a normal answer on this wire: a refused host and an unconfigured one are
   * indistinguishable to the workspace, which is the point.
   */
  answer(runId: string, host: string): WorkspaceGitCredential | null {
    const held = this.#held.get(runId);
    if (held === undefined) {
      return null;
    }
    // Exact. Not `endsWith`, not `includes`, not a case fold, not a trailing-dot strip — see the
    // docblock for which wrong implementation each of those is.
    if (host !== held.host) {
      this.#logger.warn({ run_id: runId }, 'workspace asked for a credential for another host');
      return null;
    }
    return this.#gitPart(held);
  }

  /**
   * The run's credential, for the **platform side's own** use — the mirror fetch and the export push.
   *
   * Deliberately not the same function as {@link answer}, and the difference is the whole design:
   * `answer` is the *workspace's* question, so it carries the host the workspace named and refuses
   * anything but an exact match; this is the platform side of the volume asking about a run it
   * created, where there is no untrusted host to compare. Collapsing the two would mean either the
   * launcher inventing a host string to satisfy a guard aimed at somebody else, or the guard being
   * skipped for the caller that needs it.
   *
   * Still `null` after {@link forget}: a forgotten credential is not a credential.
   */
  credentialFor(runId: string): WorkspaceGitCredential | null {
    const held = this.#held.get(runId);
    return held === undefined ? null : this.#gitPart(held);
  }

  /** The scope of what run `runId` holds, or `null`. Never the credential. */
  scopeOf(runId: string): RunCredentialScope | null {
    const held = this.#held.get(runId);
    return held?.scope ?? null;
  }

  /**
   * Stops answering for run `runId`, for ever, and drops the value. Idempotent; answers whether it
   * held anything. It calls no provider — revoking is the runner's, through the executor.
   */
  forget(runId: string): boolean {
    return this.#held.delete(runId);
  }

  /** How many runs currently hold a credential. Diagnostics; never the credential itself. */
  get liveCount(): number {
    return this.#held.size;
  }

  #gitPart(credential: CarriedRunCredential): WorkspaceGitCredential {
    return { host: credential.host, username: credential.username, password: credential.password };
  }
}
