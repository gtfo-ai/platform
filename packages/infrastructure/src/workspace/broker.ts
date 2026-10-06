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
 * ## And the repository, not just the host (backlog 481, technical/05's 2026-10-06 amendment)
 *
 * The exact host was the whole check until 2026-10-06, and it is not enough for a token that
 * reaches more than the project — a dedicated user's or the operator's static run token (WP-137,
 * WP-141): under `commands.unattended: auto` an interpreter can spell `git push https://<git
 * host>/<another group>/<another repository>` past any reading of the command line, and git asks
 * the helper for the same host. So the workspace's git sends the path (the launcher sets
 * `credential.useHttpPath` beside the helper), `cred.get` carries it, and {@link answer} answers
 * only {@link repositoryPathMatches} — the project's path `P` or `P.git`, byte for byte. A missing
 * path is refused, not defaulted: git omits it exactly when something switched `useHttpPath` off,
 * which is the spelling an attacker would reach for. A broker that holds **no** path answers
 * nothing at all — the launcher's copy, which serves the mirror and export helpers through
 * {@link credentialFor}, is held without one.
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
import type { Logger, WorkspaceGitCredential, WorkspaceGitSsh } from '@platform/application';
import { silentLogger, WorkspaceError } from '@platform/application';

/** What a minted credential may be used for (`CredentialScope` on the provider port). */
export type RunCredentialScope = 'read' | 'push';

/**
 * Where the run's credential came from: minted for the run, or the integration's declared static
 * run token (TD-028 decision 13, WP-137), which is always `push` and cannot be narrowed.
 */
export type RunCredentialSource = 'minted' | 'static' | 'deploy_key';

/** The credential material the create request carries — never a `revokeId` (decision 3). */
export interface CarriedRunCredential extends WorkspaceGitCredential {
  readonly scope: RunCredentialScope;
  /** When the provider stops honouring it. Diagnostics here; the provider is the enforcer. */
  readonly expiresAt: string;
  /** Absent is `minted`: the strict rule, never the exception. */
  readonly source?: RunCredentialSource;
}

export interface HoldRequest {
  readonly runId: string;
  /**
   * BD-021: a read-only stage may hold a `read` credential and never a minted `push` one — the one
   * exception is a static run credential, which cannot be narrowed (TD-028 decision 13, WP-137).
   */
  readonly readOnly: boolean;
  readonly credential: CarriedRunCredential;
  /**
   * The spec's SSH route, for a deploy key (WP-146) — required with `source: 'deploy_key'` and
   * refused without it, so the helpers that read {@link RunCredentialBroker.credentialFor} know to
   * go over SSH rather than hand the key to a credential helper as a password.
   */
  readonly ssh?: WorkspaceGitSsh;
  /**
   * The project's repository path on the git host — `RunWorkspaceProject.projectPath`, i.e.
   * `repositoryPathOf(projects.repo_url)` (`acme/api`, no leading or trailing slash, no `.git`) —
   * the only path {@link RunCredentialBroker.answer} answers for (backlog 481). Absent, `answer`
   * answers nothing: the launcher holds without one because it never answers the workspace. A
   * malformed one is refused (see {@link isRepositoryPath}).
   */
  readonly repositoryPath?: string;
}

/** The workspace's `cred.get`, as the runner received it from the shim. */
export interface CredentialQuestion {
  readonly host: string;
  /** git's own `path` field; `null` when git sent none (`credential.useHttpPath` off). */
  readonly path: string | null;
}

/** Why {@link RunCredentialBroker.answer} said no. Logged; never the asked path itself. */
export type CredentialRefusal =
  | 'no_credential'
  | 'deploy_key'
  | 'another_host'
  | 'no_repository_held'
  | 'no_path'
  | 'another_repository';

/** One path segment as GitLab allows it: letters, digits, `_`, `.`, `-` — and never `.` or `..`. */
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Whether `value` is a repository path the broker may hold: one or more `/`-separated segments of
 * `A–Z a–z 0–9 _ . -`, none of them `.` or `..`, not ending in `.git` — GitLab's own rule for a
 * namespace or project path ("letters, digits, '_', '-' and '.'; cannot end in '.git'"). A path
 * that is not this shape is a configuration git and the broker would disagree about (git
 * percent-decodes what it sends, so `acme/my%20repo` would never match), and it is refused when the
 * run starts rather than discovered as a push that fails for want of a credential.
 */
export const isRepositoryPath = (value: string): boolean => {
  if (value.length === 0 || value.length > 1024 || value.endsWith('.git')) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => REPOSITORY_SEGMENT.test(segment) && segment !== '.' && segment !== '..');
};

/**
 * Whether the path git asked about is the project's repository: exactly `held`, or exactly
 * `held.git` — byte for byte, so case-sensitive, nothing decoded, no slash trimmed and no query
 * dropped (backlog 481).
 *
 * Why so literal, each against the looser rule it rejects (`broker.test.ts` has the cases):
 *  - **no case fold.** GitLab routes paths case-insensitively, so `Acme/API` is the same project
 *    there — but the checkout's `origin` is `projects.repo_url` verbatim, so nothing legitimate is
 *    spelled otherwise, and a fold would admit a second repository on a case-sensitive host;
 *  - **no decoding, no `..` resolution, no slash trimming.** git has already done all three before
 *    the helper sees the path (measured in `platform-runtime`'s git 2.47.3), so what arrives is the
 *    path git will request; a second normalisation here could only make two different requests
 *    equal;
 *  - **one `.git`, lower-case.** `P.git` and `P` are the two spellings GitLab serves one repository
 *    under; `P.GIT`, `P.git.git` and `P.git/` are not spellings anybody's `origin` carries.
 */
export const repositoryPathMatches = (held: string, asked: string): boolean =>
  asked === held || asked === `${held}.git`;

interface HeldCredential {
  readonly credential: CarriedRunCredential;
  readonly repositoryPath: string | null;
}

export class RunCredentialBroker {
  readonly #logger: Logger;
  readonly #held = new Map<string, HeldCredential>();

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
    // TD-028 decision 13: a static run credential cannot be narrowed, so a read-only run holds it
    // with its push scope — the stated loss. A *minted* push credential there is still refused.
    // TD-028 decision 13b: a deploy key with write access cannot be narrowed either.
    if (
      request.readOnly &&
      credential.scope === 'push' &&
      credential.source !== 'static' &&
      credential.source !== 'deploy_key'
    ) {
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
    if ((credential.source === 'deploy_key') !== (request.ssh !== undefined)) {
      throw new WorkspaceError(
        'invalid_spec',
        'a deploy key is held with its SSH route and nothing else is (TD-028 decision 13b)',
        { runId: request.runId },
      );
    }
    if (request.repositoryPath !== undefined && !isRepositoryPath(request.repositoryPath)) {
      throw new WorkspaceError(
        'invalid_spec',
        'the project’s repository path is not one the credential helper can be scoped to: it must be `/`-separated segments of letters, digits, `_`, `.` and `-`, with no `.` or `..` segment and no trailing `.git` (backlog 481)',
        { runId: request.runId },
      );
    }
    this.#held.set(request.runId, {
      credential: request.ssh === undefined ? credential : { ...credential, ssh: request.ssh },
      repositoryPath: request.repositoryPath ?? null,
    });
    this.#logger.debug(
      { run_id: request.runId, scope: credential.scope },
      'holding the run credential the create request carried',
    );
    return this.#gitPart((this.#held.get(request.runId) as HeldCredential).credential);
  }

  /**
   * The answer to a `cred.get` from run `runId`, or `null`.
   *
   * `null` is a normal answer on this wire: a refused host, a refused repository and an
   * unconfigured one are indistinguishable to the workspace, which is the point. Every refusal of
   * a held run is a `warn` line naming the run and the {@link CredentialRefusal} — never the asked
   * path, which the workspace chose and which could carry the token itself.
   */
  answer(runId: string, question: CredentialQuestion): WorkspaceGitCredential | null {
    const held = this.#held.get(runId);
    const refusal = this.#refusal(held, question);
    if (refusal !== null) {
      if (refusal !== 'no_credential') {
        this.#logger.warn(
          { run_id: runId, reason: refusal },
          'refused the workspace’s request for the run credential',
        );
      }
      return null;
    }
    return this.#gitPart((held as HeldCredential).credential);
  }

  #refusal(
    held: HeldCredential | undefined,
    question: CredentialQuestion,
  ): CredentialRefusal | null {
    if (held === undefined) {
      return 'no_credential';
    }
    // WP-146 (TD-028 decision 13b item 2): a deploy key is never handed to the workspace — its
    // signatures come from the runner through the agent socket. The answer is the ordinary refusal.
    if (held.credential.source === 'deploy_key') {
      return 'deploy_key';
    }
    // Exact. Not `endsWith`, not `includes`, not a case fold, not a trailing-dot strip — see the
    // docblock for which wrong implementation each of those is.
    if (question.host !== held.credential.host) {
      return 'another_host';
    }
    // Backlog 481: the repository, not just the host. Each of these three is a refusal, never a
    // default — see the docblock.
    if (held.repositoryPath === null) {
      return 'no_repository_held';
    }
    if (question.path === null) {
      return 'no_path';
    }
    return repositoryPathMatches(held.repositoryPath, question.path) ? null : 'another_repository';
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
    return held === undefined ? null : this.#gitPart(held.credential);
  }

  /** The scope of what run `runId` holds, or `null`. Never the credential. */
  scopeOf(runId: string): RunCredentialScope | null {
    const held = this.#held.get(runId);
    return held?.credential.scope ?? null;
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
    return {
      host: credential.host,
      username: credential.username,
      password: credential.password,
      ...(credential.ssh === undefined ? {} : { ssh: credential.ssh }),
    };
  }
}
