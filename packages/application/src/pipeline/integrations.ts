/**
 * The provider calls the pipeline makes, and the one door they all go through.
 *
 * technical/06: "Every action call goes through an `IntegrationActionExecutor`". The pipeline never
 * holds a provider and calls it — it holds this, which is a thin, typed set of the calls the
 * pipeline actually makes, each already wrapped in the executor's shadow guard, idempotency, rate
 * limit and audit row. Keeping the wrapping *here* rather than in each saga is what makes
 * "the pipeline cannot forget the executor" a property of the code rather than of the reviewer.
 *
 * A project with no git or task-management binding gets `null`, and the sagas that need one say so
 * with a blocker brief instead of throwing: a project whose GitLab integration was removed should
 * park its tasks, not crash its dispatcher.
 *
 * ## Nothing here may run inside a database transaction (WP-15d)
 *
 * Two refusals, and they are **not** the same guard bounded twice (standing rule 41) — they stop
 * different things, and each has a test the other cannot pass:
 *
 *  - {@link integrationsForProject} refuses to *resolve a project's bindings* inside a transaction.
 *    In production that resolution is itself I/O — a `bindings` read, a `secrets` read and an
 *    envelope decryption per call (`packages/integrations/src/bindings/loader.ts`), on a connection
 *    borrowed *inside* the caller's — so it is a nested borrow before a provider is even reached;
 *  - {@link read} and {@link mutate} refuse the *call*. That is the one a caller who resolved the
 *    bindings before opening its transaction would otherwise walk straight past, and it is where
 *    the connection would actually be held across the provider's latency.
 *
 * The place that answers "a transaction is open" is `events/open-transaction.ts`, which has the
 * measurement and the honest list of what the mechanism cannot see.
 */
import type { DiffStats, ExternalIdentity, Id, JsonObject, TaskMode } from '@platform/contracts';
import { isPlatformMergeRequestNote, opensWithPlatformCommentMarker } from '@platform/domain';
import { assertOutsideTransaction } from '../events/open-transaction.js';
import {
  type IdempotencyPlan,
  type IntegrationActionExecutor,
  SHADOW_RUN_CREDENTIAL_CARVE_OUT,
} from '../integrations/action-executor.js';
import { hasMintedCredentialShape } from '../integrations/credential-shape.js';
import {
  exactSecretRedactor,
  type InjectedSecret,
  MIN_SECRET_LENGTH,
} from '../integrations/redaction.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { IntegrationError, type IntegrationRef } from '../ports/integrations/common.js';
import type {
  ApprovalPost,
  CommunicationPort,
  DigestItem,
  MessageBody,
  MessageRef,
  QuestionPost,
  ThreadRef,
} from '../ports/integrations/communication.js';
import type {
  BranchPushProtection,
  CiConfigLocation,
  CodeownersRules,
  CommitAction,
  CommitRef,
  CreatedPipeline,
  CredentialScope,
  Discussion,
  FileDiff,
  GitProviderPort,
  MergedMergeRequest,
  MergeRequest,
  MergeRequestListing,
  MergeRequestRefInput,
  MintedCredential,
  MintedRunCredential,
  PipelineStatus,
  RepositoryCommit,
  RepositorySettings,
} from '../ports/integrations/git-provider.js';
import {
  commitFilesRequestSchema,
  mergeRequestDraftSchema,
} from '../ports/integrations/git-provider.js';
import type {
  ErrorEvent,
  Issue,
  ObservabilityErrorsPort,
} from '../ports/integrations/observability-errors.js';
import type {
  LogQueryResult,
  LogRangeQuery,
  ObservabilityLogsPort,
} from '../ports/integrations/observability-logs.js';
import type {
  AssignResult,
  CommentPage,
  CommentRef,
  ListCommentsOptions,
  TaskManagementPort,
  Ticket,
  TicketDraft,
  TicketMatch,
  TicketMatchRule,
  TicketRefInput,
  TransitionResult,
  UnassignResult,
} from '../ports/integrations/task-management.js';

export interface GitBinding {
  readonly port: GitProviderPort;
  readonly ref: IntegrationRef;
  /** The repository path the project is bound to (`acme/api`). */
  readonly project: string;
  /**
   * The redactor this binding's adapter was built with — **both steps of TD-012**, in order, the
   * same value and for the same reason {@link TaskManagementBinding.redactor} carries one.
   *
   * Two callers, added at WP-24, and both are places the platform handles provider text *itself*
   * rather than handing it to a provider:
   *
   *  - **the merge-request snapshot** it stores on the task (`tasks.review_subject`), which is the
   *    `ticket_snapshot` case one provider over: the executor redacts the audit row and returns
   *    `outcome.result` unredacted (standing rule 31's note), so a sink of its own needs the
   *    redactor of its own;
   *  - **a review finding on its way to a discussion thread**, which is the *other* direction — a
   *    model's words going out to a third party. `artifacts.data` held them unredacted until WP-52
   *    (PROGRESS backlog 35, closed at the write by `artifacts/redaction.ts`); this redaction is
   *    still owed and is not the same one, because it covers what a **provider** is sent and
   *    composes the binding's own credentials on top of the run's.
   */
  readonly redactor: SecretRedactor;
  /**
   * The provider's words for the two mint refusals, from its registration's credential-minting
   * declaration (WP-107, PROGRESS backlog 278). Absent for a provider that declares no minting, and
   * for a binding a test builds by hand; a refusal then names no setting rather than guessing one.
   */
  readonly mintingHints?: CredentialMintingHints;
  /**
   * The integration's **static run credential** (TD-028 decision 13, WP-137) — present exactly when
   * the integration declares one (GitLab: `run_credential: static`), absent when minting is the only
   * source. Read by {@link runCredentialWrites} and by the dependency gate's exact-value search, and
   * by nothing else: the adapter in {@link port} is built without it, so no platform API call can
   * carry it (decision 13 item 3).
   */
  readonly staticRunCredential?: StaticRunCredential;
  /**
   * The integration's **SSH deploy key** (TD-028 decision 13b, WP-146) — present exactly when the
   * integration declares `run_credential: deploy_key`. Read by {@link runCredentialWrites} and the
   * dependency gate's search, and by nothing else: the adapter is built without the private key.
   */
  readonly deployKeyRunCredential?: DeployKeyRunCredential;
}

/**
 * How a run reaches the git host over **SSH** — TD-028 decision 13b items 3 and 4. A provider fact
 * (GitLab.com: `altssh.gitlab.com:443`, pinned under `gitlab.com`), never an operator's string, so
 * nothing in it is a credential and all of it may travel on the launcher's wire.
 */
export interface SshGitRoute {
  /** The HTTPS URL prefix git rewrites (`https://gitlab.com/`) — the repository's ordinary URL. */
  readonly httpsPrefix: string;
  /** What it is rewritten to (`ssh://git@altssh.gitlab.com:443/`). */
  readonly sshPrefix: string;
  /** The host the egress sidecar is asked to `CONNECT` to, and the port — 443, never 22. */
  readonly connectHost: string;
  readonly connectPort: number;
  /** The name the host keys are pinned under (`HostKeyAlias`), so `known_hosts` is the documented one. */
  readonly hostKeyAlias: string;
  /** The documented `known_hosts` lines, each `<hostKeyAlias> <type> <base64>`; never a first connection's. */
  readonly knownHosts: readonly string[];
}

/**
 * A deploy key as the loader read it (TD-028 decision 13b, WP-146). Like {@link StaticRunCredential},
 * everything the run-credential path needs to **refuse** by name is here.
 */
export interface DeployKeyRunCredential {
  /** The OpenSSH private key text. `''` when the integration declares `deploy_key` and holds none. */
  readonly privateKey: string;
  /** The declared `ssh-ed25519 AAAA…` line. Not a secret. */
  readonly publicKey: string;
  /** The route, or `null` when the provider has none for this host (self-managed). */
  readonly route: SshGitRoute | null;
  /** Every configuration and key fault (self-managed, minting on, a key that does not match), or `null`. */
  readonly refusal: string | null;
  /** The binding redactor's placeholder for the private key (as {@link StaticRunCredential.redactedAs}). */
  readonly redactedAs?: string;
}

/**
 * A static run credential as the loader read it (TD-028 decision 13, WP-137). Everything the
 * run-credential path needs to **refuse** by name is here, because a declared-but-broken credential
 * must never become "no credential" silently (standing rule 18).
 */
export interface StaticRunCredential {
  /**
   * Whose token it is (TD-028 decisions 13 and 13a): a dedicated low-privilege user's, or — WP-141
   * — the operator's own repository-only token, which is handed to a run only while the default
   * branch is protected with push **No one** and force push off, re-read before each run.
   * Required, so no hand-built credential skips that check by omission.
   */
  readonly owner: 'dedicated_user' | 'operator';
  /** The username git sends beside the token (GitLab: `run_token_username`). */
  readonly username: string;
  /** The secret. `''` when the integration declares `static` and holds no run token. */
  readonly value: string;
  /** The declared expiry as an instant (00:00 UTC on the date, GitLab's reading), or `null`. */
  readonly expiresAt: string | null;
  /** The declared expiry as the operator wrote it, for a refusal's words. */
  readonly declaredExpiry: string;
  /** The run token equals the integration's own API token — refused at use as at the write. */
  readonly sameAsApiToken: boolean;
  /** The configuration-level refusal (minting also on, no username, no expiry), or `null`. */
  readonly refusal: string | null;
  /**
   * The placeholder the binding's own redactor writes in the token's place
   * (`[REDACTED:integration:<provider>:<integration>:<field>]`, WP-137 review round 1). The run token
   * is a sealed secret of the integration, so every provider response the adapter hands back — a
   * merge request's diff included — already carries this instead of the value; the leak search
   * matches both. Absent for a credential a test builds by hand.
   */
  readonly redactedAs?: string;
}

/**
 * How an operator fixes the two refusals a mint can meet, in the provider's own words — declared on
 * the provider's registration (`CredentialMintingDeclaration.hints` in `@platform/integrations`) so
 * this ring renders them and names no provider (WP-107, PROGRESS backlog 278).
 */
export interface CredentialMintingHints {
  /** How minting is turned on, for a binding whose port reports it off. */
  readonly enable: string;
  /** How a minted value that does not have the declared shape is fixed. */
  readonly shape: string;
  /**
   * How a static run credential is declared instead (TD-028 decision 13 item 6, WP-137) — absent
   * for a provider that offers none, and the refusal then names only the minting setting.
   */
  readonly static?: string;
}

export interface TaskManagementBinding {
  readonly port: TaskManagementPort;
  readonly ref: IntegrationRef;
  /**
   * The redactor this binding's adapter was built with — **both steps of TD-012**, in order.
   *
   * It is here because of one caller: the ticket snapshot is provider **text the platform stores**
   * (WP-15f), and the executor redacts the audit row rather than the result it hands back
   * (`action-executor.ts` returns `outcome.result` unredacted, standing rule 31's note). So the
   * one place that writes provider text into a row of its own needs the redactor the adapter
   * holds, and Q61 says so in as many words: *"redaction goes through the binding's redactor with
   * a `redaction_count`, which is the `inbox` precedent"*.
   *
   * **What is in it.** `bindings/loader.ts` composes step 1 — this binding's resolved credentials
   * and the call's run-scoped ones (Q55) — with the `platformRedactor` the composition root hands
   * it, which in production is step 2, the gitleaks-derived pattern rules. Binding first, platform
   * last, the order `composeSecretRedactors` reduces in. A loader given no `platformRedactor`
   * applies step 1 alone: narrower redaction, never none.
   *
   * **This paragraph used to say the opposite**, and the sentence was made false by the fix rather
   * than written wrong — closing a gap turns every sentence that described it into a lie (rules 63
   * and 49). Round 1 shipped the snapshot with step 1 only and filed step 2 as discovered work on a
   * false comparison: `inbox` has had step 2 since WP-15c, so one provider call had two sinks
   * treated oppositely. Round 2 closed it; this is the sibling sentence that had to move with it.
   */
  readonly redactor: SecretRedactor;
  /**
   * The provider's own name for the permission the claim's assign needs (WP-177, TD-029 decision
   * 5) — `Assign Issues` on Jira Cloud — declared by the provider's registration
   * (`ProviderRegistration.assignPermission`) so the brief of a refused claim names it while this
   * ring names no provider (the WP-107 precedent `GitBinding.mintingHints` set). Absent for a
   * provider that declares none; the brief then speaks of *"the permission to assign tickets"*.
   */
  readonly assignPermission?: string;
}

/**
 * The project's chat binding — the third type the loader resolves (WP-32).
 *
 * `channel` and `digestChannel` are **binding** configuration rather than feature configuration:
 * one Slack account serves every project in an organisation, and which conversation *this*
 * project's notifications land in is what `bindings.config` exists for (its port docblock:
 * *"a project overriding … for its own tickets is the reason the column exists"*). Which config
 * key holds it is the provider's knowledge, so the provider's registration declares it and the
 * loader reads the declared key — the shape `gitCredential` already has, for the reason BD-017
 * gives: adding a provider must not touch a consumer.
 */
export interface CommunicationBinding {
  readonly port: CommunicationPort;
  readonly ref: IntegrationRef;
  /** Where task threads are opened (product/08: one channel per project). */
  readonly channel: string;
  /** Where the digest is posted. Falls back to {@link CommunicationBinding.channel}. */
  readonly digestChannel: string;
  /**
   * The redactor this binding's adapter was built with — both steps of TD-012, in order, and here
   * for the same reason the other two bindings carry one: the notification band **stores** the
   * text it sends (`notifications.title`/`detail`, migration 0023), built out of a ticket key, a
   * stage's return reason and a blocker brief, and the executor redacts the audit row rather than
   * the value it hands back. The adapter redacts what goes *out*; this is what redacts what stays.
   */
  readonly redactor: SecretRedactor;
}

export interface PipelineIntegrations {
  readonly executor: IntegrationActionExecutor;
  readonly git: GitBinding | null;
  readonly taskManagement: TaskManagementBinding | null;
  /** `null` for a project with no chat binding; a binding that fails to load throws (rule 20). */
  readonly communication: CommunicationBinding | null;
}

/**
 * One observability binding as the bug pre-fetch holds it (WP-89): the executor its reads go
 * through, the port, its ref and — for the reason {@link TaskManagementBinding.redactor} carries
 * one — the redactor the loader composed for it, because the pre-fetch puts provider text into a
 * prompt the platform stores (`runs.user_prompt`) and the executor hands back the result it
 * audited unredacted.
 */
export interface ObservabilityBinding<TPort> {
  readonly executor: IntegrationActionExecutor;
  readonly port: TPort;
  readonly ref: IntegrationRef;
  readonly redactor: SecretRedactor;
}

/** The two observability types and their ports — Sentry and Loki on this build (WP-89). */
export interface ObservabilityPortByType {
  readonly errors: ObservabilityErrorsPort;
  readonly logs: ObservabilityLogsPort;
}
export type ObservabilityType = keyof ObservabilityPortByType;

/**
 * The credentials the **caller** knows about and a binding cannot — Q55, and the reason this is a
 * required argument rather than an option.
 *
 * A provider adapter builds a redactor from its own resolved credentials; that half a caller
 * cannot forget. The half the adapter cannot know is a token that did not exist when the binding
 * was instantiated: `mintCredential()` runs per run, `create()` ran once, and the minted token is
 * exactly what a CI job echoes into a log. Q55's recommendation is *make the run the scope*, so
 * the scope is passed at the call and the adapters are built with it.
 *
 * It is **required by the type** because standing rule 31 says an optional security dependency is
 * an absent one, and standing rule 35 says the type only proves it is *supplied*: the behaviour is
 * proved by a test that plants a run-scoped secret here and greps what the provider emits
 * (`packages/integrations/src/bindings/loader.test.ts` ›
 * "keeps a run-scoped credential out of what a provider returns").
 */
export interface IntegrationCallScope {
  /** Named so a placeholder identifies the credential; see `bindingSecretRedactor`. */
  readonly runScopedSecrets: readonly InjectedSecret[];
}

/**
 * The scope of a call that is **not** inside a run, written out rather than defaulted.
 *
 * Every call site in this ring uses this, and since WP-76 that is a statement about *where* the
 * run's credential lives rather than about whether one exists: the runner mints one per run with a
 * checkout, and the one call made with a run's scope is its **revocation**
 * (`apps/server/src/workspaces.ts`). Everything here runs in a job or a handler after the run, and
 * what reaches it instead is the composition root's process-wide registry of the credentials that
 * process minted, composed into each binding's platform redactor, and — since WP-80 — the step-2
 * rule every process compiles from each minted credential's recorded shape, which is what reaches
 * a process that did not mint (TD-012's M5 amendment, PROGRESS backlog 259).
 */
export const noRunScopedSecrets = (): IntegrationCallScope => ({ runScopedSecrets: [] });

/**
 * A project's bindings, resolved when they are needed.
 *
 * Per **project**, because one instance serves many, and per **call**, because the redactor is
 * composed from the call's scope (Q55). `ProjectSettingsPort` is the same shape for the same
 * reason, and the two are the whole of what the pipeline needs from a composition root.
 *
 * @throws when a binding exists and cannot be built — a provider that is not registered, a config
 * that fails its schema, a credential that will not decrypt. That is *not* the same as a project
 * with no binding, which resolves to `git: null` / `taskManagement: null` and is handled by the
 * sagas and the gate evaluator (standing rule 20).
 */
export interface PipelineIntegrationsPort {
  forProject(projectId: Id, scope: IntegrationCallScope): Promise<PipelineIntegrations>;
  /**
   * **The integration that minted a run credential, bound or not** — TD-028 decision 10 (M5
   * amendment), WP-80, PROGRESS backlog 156 half 3.
   *
   * A minted credential's `revoke_id` is an address on the host of the integration that minted
   * it, and that integration is by construction the host that issued it; the executor's audit,
   * idempotency and rate-limit records are keyed by `integrations.id` already. So the revoke —
   * teardown and recovery alike — is built from the **minting** `integrations.id`, whether or not
   * the project still binds it, and never from the project's current git binding, which is a
   * different integration exactly in the case that matters.
   *
   * `null` when no integration has that id any more: there is then no host the platform may send
   * the address to, and the caller reports the credential and leaves it to its expiry.
   *
   * @throws {Error} when the integration exists and cannot be built, or is not a git integration —
   * the loader's *broken is not absent* rule (standing rule 20).
   */
  forMintingIntegration(
    integrationId: Id,
    scope: IntegrationCallScope,
  ): Promise<MintingIntegration | null>;
  /**
   * The project's binding of one **observability** type (WP-89, PROGRESS backlog 143), or `null`
   * for a project with none.
   *
   * A separate member from {@link forProject}, and per type, and both are the decision: a broken
   * git or ticket binding must stop the pipeline (the loader's *broken is not absent*, rule 20),
   * while a broken observability binding must stop **nothing** — the pre-fetch is an advisory read
   * and fails open, one binding at a time, so a Sentry token that no longer decrypts costs the
   * event excerpt and not the log excerpt. Folded into `forProject`, it would have been a
   * `BindingLoadError` on every pipeline call the project made.
   *
   * @throws when the binding exists and cannot be built, or when there are two of the type — the
   * loader's rules unchanged. The one caller (`observability-prefetch.ts`) catches it and says so
   * in the prompt; the refusal is still made here, so what "broken" means is decided once.
   */
  forObservability<TType extends ObservabilityType>(
    projectId: Id,
    type: TType,
    scope: IntegrationCallScope,
  ): Promise<ObservabilityBinding<ObservabilityPortByType[TType]> | null>;
}

/**
 * The git integration a credential was minted through, built from its account alone — enough to
 * revoke by address and nothing more (WP-80). No repository path: a revocation address carries its
 * own project (`revokeId`, standing rule 19), and a binding's path is exactly what an unbound
 * integration no longer has.
 */
export interface MintingIntegration {
  readonly executor: IntegrationActionExecutor;
  readonly port: GitProviderPort;
  readonly ref: IntegrationRef;
  /** Both TD-012 steps, as the loader composes them for a binding. */
  readonly redactor: SecretRedactor;
}

/** The project's git binding as a {@link MintingIntegration} — what a mint's own refusal revokes through. */
export const mintingIntegrationOf = (
  integrations: PipelineIntegrations,
): MintingIntegration | null =>
  integrations.git === null
    ? null
    : {
        executor: integrations.executor,
        port: integrations.git.port,
        ref: integrations.git.ref,
        redactor: integrations.git.redactor,
      };

/**
 * One already-composed set for every project: the unit tier's case, and a single-project instance.
 * Its minting integration is its git binding when the id matches, and `null` — a deleted
 * integration — otherwise.
 */
export const staticPipelineIntegrations = (
  integrations: PipelineIntegrations,
  observability: {
    readonly [TType in ObservabilityType]?: Omit<
      ObservabilityBinding<ObservabilityPortByType[TType]>,
      'executor'
    >;
  } = {},
): PipelineIntegrationsPort => ({
  forProject: async () => integrations,
  forObservability: async <TType extends ObservabilityType>(_projectId: Id, type: TType) => {
    const binding = observability[type];
    return binding === undefined
      ? null
      : ({ executor: integrations.executor, ...binding } as ObservabilityBinding<
          ObservabilityPortByType[TType]
        >);
  },
  forMintingIntegration: async (integrationId) =>
    integrations.git?.ref.integrationId === integrationId
      ? mintingIntegrationOf(integrations)
      : null,
});

/**
 * The door to {@link PipelineIntegrationsPort.forMintingIntegration}, guarded like
 * {@link integrationsForProject}: a revoke is a provider call and none is made inside a transaction.
 */
export const mintingIntegrationFor = async (
  port: PipelineIntegrationsPort,
  integrationId: Id,
  scope: IntegrationCallScope,
): Promise<MintingIntegration | null> => {
  assertOutsideTransaction('integrations.forMintingIntegration');
  return port.forMintingIntegration(integrationId, scope);
};

/**
 * **The door.** Every pipeline path that wants a provider starts here, and it refuses to open
 * inside a transaction.
 *
 * It is a function rather than a decorator on the port so that no call site can be handed an
 * unguarded instance: `staticPipelineIntegrations` in a unit test, the production loader and
 * whatever a later composition root writes all go through this one call, and
 * `integrations.test.ts` reads the ring off disk and fails a site that calls `forProject` directly.
 *
 * @throws {TransactionOpenError} when a transaction is open on this call path.
 */
export const integrationsForProject = async (
  port: PipelineIntegrationsPort,
  projectId: Id,
  scope: IntegrationCallScope,
): Promise<PipelineIntegrations> => {
  assertOutsideTransaction('integrations.forProject');
  return port.forProject(projectId, scope);
};

/**
 * The door to {@link PipelineIntegrationsPort.forObservability}, guarded like
 * {@link integrationsForProject}: resolving a binding is a `bindings` read and a credential
 * decryption, and the reads behind it are provider round trips (WP-89).
 *
 * @throws {TransactionOpenError} when a transaction is open on this call path.
 */
export const observabilityForProject = async <TType extends ObservabilityType>(
  port: PipelineIntegrationsPort,
  projectId: Id,
  type: TType,
  scope: IntegrationCallScope,
): Promise<ObservabilityBinding<ObservabilityPortByType[TType]> | null> => {
  assertOutsideTransaction('integrations.forObservability');
  return port.forObservability(projectId, type, scope);
};

/**
 * The organisation's own integrations — the ones an organisation-scoped call goes through, with
 * **no binding** (WP-65, PROGRESS backlog 80).
 *
 * `PipelineIntegrationsPort` answers per project, because a binding is a project's use of an
 * account; an organisation budget has no project, so it cannot ask that question at all. What the
 * organisation has instead is the **account**: `integrations` is org-scoped by construction, and a
 * communication account names its own default channel in `integrations.config` — the channel a
 * project's binding overrides. That channel is one a human already chose, which is why backlog 80
 * took answer (c) rather than a fan-out to every project's channel.
 *
 * The answer has the same shape as a project's, with `git` and `taskManagement` always `null`, so
 * the call helpers below serve both unchanged. Every call made through it is still an
 * `IntegrationActionExecutor` call, and the executor's audit row, idempotency record and rate-limit
 * budget are keyed by `integrations.id` — the **account's** own id, which is the honest attribution:
 * it is that account's credential in scope and no project's. The row's project is `null` rather
 * than an arbitrary project the account happens to be bound to (CLAUDE.md, WP-51's rule).
 *
 * @throws when the organisation's communication account exists and cannot be built, or when there
 * are **two** — the same refusal a project with two chat bindings gets, because choosing one by sort
 * order would make where the organisation's budget alarm goes depend on a name somebody typed.
 */
export interface OrganisationIntegrationsPort {
  forOrganisation(scope: IntegrationCallScope): Promise<PipelineIntegrations>;
}

/** The organisation's door, guarded like {@link integrationsForProject}. */
export const integrationsForOrganisation = async (
  port: OrganisationIntegrationsPort,
  scope: IntegrationCallScope,
): Promise<PipelineIntegrations> => {
  assertOutsideTransaction('integrations.forOrganisation');
  return port.forOrganisation(scope);
};

/** An organisation with no chat account: every binding `null`, the unit tier's default. */
export const noOrganisationIntegrations = (
  executor: IntegrationActionExecutor,
): OrganisationIntegrationsPort => ({
  forOrganisation: async () => ({
    executor,
    git: null,
    taskManagement: null,
    communication: null,
  }),
});

interface CallContext {
  /**
   * `null` for an organisation-scoped call (WP-65) — made through an integration with no binding,
   * audited against that integration and against no project, because no project's credential or
   * configuration was in scope.
   */
  readonly projectId: Id | null;
  readonly taskId: Id | null;
}

/** A read: performed in every mode, because a shadow task needs its context (technical/06). */
const read = async <T>(
  integrations: { readonly executor: IntegrationActionExecutor },
  ref: IntegrationRef,
  action: string,
  payload: JsonObject,
  context: CallContext,
  perform: () => Promise<T>,
): Promise<T> => {
  assertOutsideTransaction(`the provider read "${action}"`);
  const outcome = await integrations.executor.execute<T>({
    integration: ref,
    action,
    payload,
    mutating: false,
    projectId: context.projectId,
    taskId: context.taskId,
    perform,
  });
  return outcome.result;
};

/**
 * A mutation: refused for a shadow task and recorded as `would_have` (technical/06, BD-021).
 *
 * `mode` is required by the type *and* parsed by the executor, so a caller that loses the task's
 * mode on the way here cannot post a real comment on a real ticket.
 */
const mutate = async <T>(
  integrations: { readonly executor: IntegrationActionExecutor },
  ref: IntegrationRef,
  action: string,
  payload: JsonObject,
  context: CallContext & { readonly mode: TaskMode },
  perform: () => Promise<T>,
  shadowResult: () => T,
  describeResult: (result: T) => JsonObject | null,
  idempotency?: IdempotencyPlan<T>,
): Promise<T> => {
  assertOutsideTransaction(`the provider mutation "${action}"`);
  const outcome = await integrations.executor.execute<T>({
    integration: ref,
    action,
    payload,
    mutating: true,
    mode: context.mode,
    projectId: context.projectId,
    taskId: context.taskId,
    perform,
    shadowResult,
    describeResult,
    ...(idempotency === undefined ? {} : { idempotency }),
  });
  return outcome.result;
};

/**
 * The merge request, addressed at the binding that is **live now**.
 *
 * `tasks.mr_ref` records the merge request the developer's `open_mr` opened or adopted — the iid,
 * the URL, the branch, the head commit, and since WP-138 the provider and the repository path the
 * tool's binding answered. A row written before WP-138 came from the developer's report and carries
 * neither, because the saga learned it inside its handler's transaction, where resolving a binding
 * is a nested pool borrow and a credential decryption (WP-15d). So a missing provider or path is
 * filled in **here**, where the binding is already in hand and is the one in force rather than the
 * one that was in force when the row was written. A ref that carries its own path keeps it.
 */
const addressed = (git: GitBinding, ref: MergeRequestRefInput): MergeRequestRefInput => ({
  ...ref,
  provider: ref.provider ?? git.ref.provider,
  project_path: ref.project_path ?? git.project,
});

export const gitReads = (integrations: PipelineIntegrations) => ({
  /**
   * The bound repository's merge requests updated since an instant, oldest first — the
   * merge-request poller's read (WP-110, PROGRESS backlog 297). A **read**, so it happens in every
   * mode and is audited, rate-limited and refused inside a transaction like every other.
   */
  mergeRequests: async (
    options: { readonly updatedAfter: string; readonly limit: number },
    context: CallContext,
  ): Promise<readonly MergeRequestListing[] | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'list_merge_requests',
      { project: git.project, updated_after: options.updatedAfter, limit: options.limit },
      context,
      async () =>
        git.port.listMergeRequests(git.project, {
          updatedAfter: options.updatedAfter,
          limit: options.limit,
        }),
    );
  },

  mergeRequest: async (
    ref: MergeRequestRefInput,
    context: CallContext,
  ): Promise<MergeRequest | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'get_merge_request',
      { project: git.project, iid: ref.iid },
      context,
      async () => git.port.getMergeRequest(addressed(git, ref)),
    );
  },

  /**
   * The files a merge request changes, with their patches — WP-24, technical/04's *"diff from
   * provider"*.
   *
   * A **read**, so it happens in every mode; `limit` is the caller's, because the caller is the one
   * that knows how many files it can put in a prompt (`review-only.ts` derives it from the same
   * caps the prompt already applies).
   */
  mergeRequestDiff: async (
    ref: MergeRequestRefInput,
    limit: number,
    context: CallContext,
  ): Promise<readonly FileDiff[] | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'get_merge_request_diff',
      { project: git.project, iid: ref.iid, limit },
      context,
      async () => git.port.getMergeRequestDiff(addressed(git, ref), { limit }),
    );
  },

  /**
   * A merge request's size — files, inserted and deleted lines — or `null` when the provider has
   * not computed it (WP-59, PROGRESS backlog 113). A **read**, so it happens in every mode. Its
   * one caller is the history bootstrap, for a mined merge request whose listing carried no
   * `diff_stats` — which on the one shipped adapter is every one of them (GitLab divergence 1).
   */
  mergeRequestDiffStats: async (
    ref: MergeRequestRefInput,
    context: CallContext,
  ): Promise<DiffStats | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'get_merge_request_diff_stats',
      { project: git.project, iid: ref.iid },
      context,
      async () => git.port.getMergeRequestDiffStats(addressed(git, ref)),
    );
  },

  /**
   * Merge requests a human already merged — WP-34's shadow comparison, and `listMergedMergeRequests`'
   * first caller since it was built at WP-09.
   *
   * A **read**, so it happens in every mode; `since` and `limit` are the caller's, because how far
   * back a comparison should look is a property of the batch rather than of the provider.
   */
  mergedMergeRequests: async (
    since: string,
    limit: number,
    context: CallContext,
  ): Promise<readonly MergedMergeRequest[] | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'list_merged_merge_requests',
      { project: git.project, since, limit },
      context,
      async () => git.port.listMergedMergeRequests(git.project, since, limit),
    );
  },

  /**
   * The repository's own commit messages since an instant — WP-35, product/19 §18's third input.
   *
   * A **read**, so it happens in every mode. `null` for a project with no git binding, like every
   * other member here; an adapter that does not support the listing throws
   * `unsupported_capability`, which the bootstrap catches and records as a batch with no commit
   * half rather than a failed collection (standing rule 20).
   */
  commits: async (
    since: string,
    limit: number,
    context: CallContext,
  ): Promise<readonly RepositoryCommit[] | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'list_commits',
      { project: git.project, since, limit },
      context,
      async () => git.port.listCommits(git.project, { since, limit }),
    );
  },

  /**
   * The latest pipeline for a revision — **never coalesced**, and deliberately not on the key the
   * diff read shares (`diff-coalescer.ts`, WP-59). A merge request's files at a fixed head sha are
   * stable; a pipeline's status at a fixed head sha is **not**: it moves from `running` to a
   * terminal state, and a re-run on the same revision reports a different outcome and a different
   * coverage — which is why the coverage duty refuses to cache the head (`coverage.ts`). Keyed by
   * sha, a second asker would be answered the CI gate's `running` after the pipeline had failed. A
   * coalesce here would have to be bounded in *time*, and nobody has decided that window (PROGRESS
   * backlog 64).
   */
  pipelineStatus: async (headSha: string, context: CallContext): Promise<PipelineStatus | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'get_pipeline_status',
      { project: git.project, head_sha: headSha },
      context,
      async () => git.port.getPipelineStatus(git.project, headSha),
    );
  },

  /**
   * A CI job's log — WP-81, BD-024 §5's *"the failing job's error block"*, and the port method's
   * first caller since WP-09 built it. A **read**, so it happens in every mode; `null` for a project
   * with no git binding, like every other member here.
   *
   * The adapter redacts what it returns (`getJobLog`'s port docblock: TD-012's redactor composed with
   * one over its own credentials, applied before its own tail cut), and the caller redacts again
   * with the binding's redactor before it cuts anything (`ci-log.ts`) — the second pass is the one
   * that carries every minted-credential shape this process knows (WP-80) whichever adapter answered.
   * The text is untrusted (BD-022) and goes nowhere but a data block.
   */
  jobLog: async (logRef: string, context: CallContext): Promise<string | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'get_job_log',
      { project: git.project, log_ref: logRef },
      context,
      async () => git.port.getJobLog(git.project, logRef),
    );
  },

  discussions: async (
    ref: MergeRequestRefInput,
    context: CallContext,
  ): Promise<readonly Discussion[]> => {
    const git = integrations.git;
    if (git === null) {
      return [];
    }
    return read(
      integrations,
      git.ref,
      'list_discussions',
      { project: git.project, iid: ref.iid },
      context,
      async () => git.port.listDiscussions(addressed(git, ref)),
    );
  },

  /**
   * The account the git binding's credential acts as (`authenticatedUser`), or `null` for a project
   * with no git binding — what the review conversation compares a marked note's author with before
   * it counts the note as its own (WP-179). A read, so it is performed in every mode.
   */
  self: async (context: CallContext): Promise<ExternalIdentity | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'authenticated_user',
      { project: git.project },
      context,
      async () => git.port.authenticatedUser(),
    );
  },

  /**
   * Is the branch the agent will open its merge request against protected?
   *
   * The compensating control for Q40: a GitLab project access token has no branch scoping, so the
   * only thing standing between a minted push credential and the default branch is the branch's
   * own protection. WP-09 records that as divergence 3 and says the check belongs to the pipeline;
   * this is it.
   */
  branchProtected: async (branch: string, context: CallContext): Promise<boolean | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'is_branch_protected',
      { project: git.project, branch },
      context,
      async () => git.port.isBranchProtected(git.project, branch),
    );
  },

  /**
   * The project's `CODEOWNERS`, parsed, or `null` when it has none (WP-37 — the first caller
   * `readCodeowners` has had since WP-09 built it).
   *
   * A **read**, so it happens in every mode: a shadow task computes its routing and assigns
   * nobody, which is the executor's job rather than this one's.
   *
   * `ref` is the branch the file is read at, and it is the **target** of the merge request rather
   * than the source: a change may edit `CODEOWNERS` itself, and routing by the version in the
   * change would let a contributor appoint their own reviewer (BD-022 — this file is written by
   * whoever can push). `null` also covers a provider that does not support the concept at all,
   * which is an `unsupported_capability` the caller has nothing to do about.
   */
  codeowners: async (ref: string, context: CallContext): Promise<CodeownersRules | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'read_codeowners',
      { project: git.project, ref },
      context,
      async () => git.port.readCodeowners(git.project, ref),
    );
  },

  /**
   * A reviewer handle → the provider's own account id, or `null` when it names nobody (WP-37).
   *
   * One provider read per handle, which is why {@link MAX_ROUTED_REVIEWERS} exists. The payload
   * records the handle, because the audit's question here is *"who did the platform look up"* —
   * and the handle comes from a `CODEOWNERS` file or a configuration document, both of which are
   * provider text, so the executor redacts what it stores (TD-012).
   */
  userId: async (handle: string, context: CallContext): Promise<string | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(integrations, git.ref, 'resolve_user_id', { handle }, context, async () =>
      git.port.resolveUserId(handle),
    );
  },

  /**
   * The repository's default branch and CI configuration location, as the provider answers them
   * (WP-139). A **read**, in every mode; `null` for a project with no git binding.
   *
   * **The provider's default branch is for a person to read, never for the pipeline to follow**
   * (WP-142, backlog 441): its one caller is the wizard's prefill and the mismatch notice
   * (`apps/server/src/project-config.ts`). The pipeline asks {@link ciConfigLocation} and names
   * the stored `projects.default_branch` to {@link branchHead}; `default-branch-readers.test.ts`
   * holds both halves as a census.
   */
  repositorySettings: async (context: CallContext): Promise<RepositorySettings | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'get_repository_settings',
      { project: git.project },
      context,
      async () => git.port.repositorySettings(git.project),
    );
  },

  /**
   * Where the provider says the CI configuration lives (WP-139) — {@link repositorySettings} with
   * the provider's default branch **dropped**, so the CI gate cannot follow it (WP-142).
   */
  ciConfigLocation: async (context: CallContext): Promise<CiConfigLocation | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    const settings = await read(
      integrations,
      git.ref,
      'get_repository_settings',
      { project: git.project },
      context,
      async () => git.port.repositorySettings(git.project),
    );
    return settings.ciConfig;
  },

  /**
   * The head of `branch` — which every caller passes as the project's **stored**
   * `projects.default_branch` (WP-142, backlog 441), never the provider's default.
   */
  branchHead: async (
    branch: string,
    context: CallContext,
  ): Promise<{ readonly branch: string; readonly sha: string } | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'get_branch_head',
      { project: git.project, branch },
      context,
      async () => git.port.getBranchHead(git.project, branch),
    );
  },
});

/**
 * The reads the pipeline makes against the task-management provider.
 *
 * One member today, and it is the one `readTicket` had no production caller for until WP-15f. It
 * is a **read**, so it is performed in every mode (technical/06: a shadow task needs its context)
 * and carries no idempotency plan — replaying a read costs a request, not a comment.
 *
 * `null` for a project with no task-management binding, like every other member here: a project
 * whose Jira integration was removed runs its pipeline without the ticket's text rather than
 * failing every stage (standing rule 20).
 */
/**
 * The reads the bug pre-fetch makes of an errors binding (WP-89), each an
 * `IntegrationActionExecutor` read like every other provider call the pipeline makes — audited
 * against the binding's own `integrations.id`, rate-limited on its budget, refused inside a
 * transaction. A read is performed in every task mode (technical/06: a shadow task needs its
 * context too).
 */
export const errorReads = (binding: ObservabilityBinding<ObservabilityErrorsPort>) => ({
  issue: async (id: string, context: CallContext): Promise<Issue> =>
    read(binding, binding.ref, 'get_issue', { issue_id: id }, context, async () =>
      binding.port.getIssue({ id }),
    ),
  latestEvent: async (id: string, context: CallContext): Promise<ErrorEvent | null> =>
    read(binding, binding.ref, 'get_latest_event', { issue_id: id }, context, async () =>
      binding.port.getLatestEvent({ id }),
    ),
});

/** What the platform keeps of a resolve: the issue and the status Sentry answered, or `null` in shadow. */
export interface ResolvedIssue {
  readonly issue_id: string;
  /** The issue's status after the call; `null` when shadow mode made no call. */
  readonly status: Issue['status'] | null;
}

/**
 * The one write the pipeline makes to an errors binding — WP-111, PROGRESS backlog 302: resolving
 * an issue a bug task's ticket links, once that task's merge request merged, on a binding that sets
 * `resolve_on_merge` (`resolve-on-merge.ts` decides; this only calls).
 *
 * A **mutation** through the executor like every ticket write: refused for a shadow task and
 * recorded as `would_have`, audited against the binding's own `integrations.id`, rate-limited on
 * its budget, refused inside a transaction. It carries an `IdempotencyPlan` because it runs from an
 * at-least-once job, and the key is the caller's: it must identify *the task and the issue*, so a
 * second merge event for the same task replays rather than resolving again. No release is sent —
 * the platform does not know which release will carry the merge, and a wrong `inRelease` would
 * tell Sentry the fix shipped somewhere it did not.
 */
export const errorWrites = (binding: ObservabilityBinding<ObservabilityErrorsPort>) => ({
  resolve: async (
    id: string,
    context: CallContext & { readonly mode: TaskMode; readonly idempotencyKey: string },
  ): Promise<ResolvedIssue> =>
    mutate<ResolvedIssue>(
      binding,
      binding.ref,
      'resolve_issue',
      { issue_id: id },
      context,
      async () => ({ issue_id: id, status: (await binding.port.resolve({ id })).status }),
      () => ({ issue_id: id, status: null }),
      (result) => ({ issue_id: result.issue_id, status: result.status }),
      replayable<ResolvedIssue>(context.idempotencyKey),
    ),
});

/** {@link errorReads}' sibling for a logs binding: one range query around the event (WP-89). */
export const logReads = (binding: ObservabilityBinding<ObservabilityLogsPort>) => ({
  range: async (query: LogRangeQuery, context: CallContext): Promise<LogQueryResult> =>
    read(
      binding,
      binding.ref,
      'query_range',
      {
        selector: query.selector,
        from: query.from,
        to: query.to,
        limit: query.limit,
        filter: query.filter ?? null,
      },
      context,
      async () => binding.port.queryRange(query),
    ),
});

export const ticketReads = (integrations: PipelineIntegrations) => ({
  /**
   * Tickets a rule matches, since an instant — two callers, one read.
   *
   * The **ticket poller** (WP-87, `ticket-poll.ts`) asks it for the binding's pick-up rule since the
   * binding's cursor, which is how a binding with no webhook starts tickets — and, since WP-110, a
   * second time with a `keys` rule for its live tasks' tickets, so an edit to a ticket the rule no
   * longer matches is still recorded (backlog 298); the **history
   * bootstrap** (WP-35's closed-ticket half) asks it a different question with its own rule,
   * because what "closed" means is the project's own status mapping and not a platform constant
   * (`shadow/batch.ts` states why the platform has no definition of its own). Both go through this
   * member so both are audited, rate-limited and refused inside a transaction the same way.
   */
  matches: async (
    rule: TicketMatchRule,
    options: {
      readonly since: string;
      readonly limit: number;
      /** The port's: the keys a `keys` rule named that the provider refused (WP-134, backlog 375). */
      readonly onUnreadableKeys?: (keys: readonly string[], ids: readonly string[]) => void;
    },
    context: CallContext,
  ): Promise<readonly TicketMatch[] | null> => {
    const binding = integrations.taskManagement;
    if (binding === null) {
      return null;
    }
    return read(
      integrations,
      binding.ref,
      'match_tickets',
      { rule: rule.kind, since: options.since, limit: options.limit },
      context,
      async () =>
        binding.port.matchTickets(rule, {
          since: options.since,
          limit: options.limit,
          ...(options.onUnreadableKeys === undefined
            ? {}
            : { onUnreadableKeys: options.onUnreadableKeys }),
        }),
    );
  },

  /**
   * One ticket, or `null` — **including for a reference no provider issued** (PROGRESS backlog 62).
   *
   * The `binding === null` half has always been here; the second half is WP-36's, and it closes the
   * *read* side of the rule the three writes below have enforced since WP-25. Four kinds of task
   * carry `{provider: 'platform', …}` — discovery, review-only, the ticket lint and now a scheduled
   * maintenance chore — and `ensureTicketSnapshot` runs from the `stage.execute` job for every
   * agent stage of a task that has no snapshot. Without this line, a project that *has* a Jira
   * binding got one doomed round trip per stage, one `failed` row in `integration_actions`, one
   * rate-limit token and a `warn` about a ticket that does not exist. It read as working because
   * the read **fails open** by design (rule 20), which is exactly why nobody noticed: it was
   * refused *by the provider*, which is not the same as being refused (rule 47).
   */
  /**
   * The account the binding's credential acts as — the claim's "me" (WP-177, TD-029 decision 5) —
   * or `null` for a project with no task-management binding. A read, so it is performed for a
   * shadow task too: the claim's comparison needs it in every mode.
   */
  selfIdentity: async (context: CallContext): Promise<ExternalIdentity | null> => {
    const binding = integrations.taskManagement;
    if (binding === null) {
      return null;
    }
    return read(integrations, binding.ref, 'self_identity', {}, context, async () =>
      binding.port.selfIdentity(),
    );
  },

  ticket: async (ticket: TicketRefInput, context: CallContext): Promise<Ticket | null> => {
    const binding = integrations.taskManagement;
    if (binding === null || !namesAProviderTicket(ticket)) {
      return null;
    }
    return read(
      integrations,
      binding.ref,
      'read_ticket',
      { ticket_key: ticket.key },
      context,
      async () => binding.port.readTicket(ticket),
    );
  },

  /**
   * The ticket's comments, newest first, one page (WP-171's `listComments`), strictly after
   * `since` when it is given — the human-return window's re-read (WP-178) and the conversation
   * reader's (WP-180) — or `null` for a project with no task-management binding, a ticket no
   * provider issued, or a binding whose provider does not declare `commentsRead` (BD-017: the flag
   * is asked, never a call that would throw `unsupported_capability`). A read, so it is performed
   * for a shadow task too. Unredacted, like every read here: the caller redacts with the binding's
   * redactor.
   */
  comments: async (
    ticket: TicketRefInput,
    options: ListCommentsOptions,
    context: CallContext,
  ): Promise<CommentPage | null> => {
    const binding = integrations.taskManagement;
    if (
      binding === null ||
      !namesAProviderTicket(ticket) ||
      binding.port.capabilities().commentsRead !== true
    ) {
      return null;
    }
    return read(
      integrations,
      binding.ref,
      'list_comments',
      { ticket_key: ticket.key, since: options.since ?? null, limit: options.limit },
      context,
      async () => binding.port.listComments(ticket, options),
    );
  },
});

/**
 * What makes a ticket write replayable: the wake-up that asked for it.
 *
 * Both ticket writes are made from a job now (WP-15d), and a job is *at-least-once* — pg-boss
 * re-delivers one whose lease expired and retries one that threw after the provider had already
 * answered. The event that caused the wake-up is the identity of the work: the same event asking
 * twice is the same write, and the next event is a new one. Nothing untrusted goes into the key —
 * a platform-chosen marker or task id and an event id — because an idempotency key is an identity
 * and the executor **refuses** one that needs redacting (`idempotencyScopeFor`).
 */
export interface TicketWriteContext extends CallContext {
  readonly mode: TaskMode;
  /** The event this write is the consequence of; `null` outside a dispatch (a manual re-render). */
  readonly causeEventId: Id | null;
}

/**
 * `encode`/`decode` are casts and not a `parse`, which every plan in this repository does.
 *
 * (The sentence used to name `slack/digest.ts` as *"the one other plan"*; WP-32 moved that
 * mechanism into `notify/digest.ts` and gave the chat calls below plans of their own, so the
 * exclusivity claim is gone rather than stale — standing rules 63 and 83.)
 *
 * The stored value is redacted before it is written, so a `parse` would turn the rare case where
 * TD-012's pattern redactor matched something inside a provider's own comment id into a job that
 * fails, retries, replays the same unparseable value and dies — a workpad that stops rendering
 * because a URL looked like a token. The cast keeps the replay lossy-but-alive instead, which is
 * the fail-open direction on a *notification* (standing rule 20).
 */
const replayable = <T>(key: string): IdempotencyPlan<T> => ({
  key,
  encode: (result) => result as unknown as JsonObject,
  decode: (stored) => stored as unknown as T,
});

/**
 * The provider value a **platform-issued** ticket reference carries, and the one thing every ticket
 * write refuses.
 *
 * Three kinds of task have no ticket at all — discovery (WP-21), review-only (WP-24) and the ticket
 * readiness linter (WP-25) — and each carries `{provider: 'platform', key: '<something>!<id>'}` so
 * that `unique (project_id, ticket_key, mode)` can make it idempotent. `tasks.ticket_*` is not
 * nullable, so those rows reach the same handlers as every other task: the workpad render (TD-005
 * priority 120) and the status mapping (110) both fire, and both used to call the provider with a
 * key no provider issued.
 *
 * **It was refused by the provider, which is not the same as being refused** (standing rule 47). The
 * fake answers `not_found` and Jira answers 404, so the audit row is a `failed` one, the job throws,
 * pg-boss retries it and eventually dead-letters it — per discovery task and per review-only task,
 * on every build since WP-21. Nothing leaked and nothing was written, so it read as working. Here it
 * is a **decision**: a reference that names no ticket is not written to, the call is not made, and
 * `null` is the same answer a project with no binding gets.
 */
export const PLATFORM_TICKET_PROVIDER = 'platform';

/** Does this reference name a ticket a provider knows? See {@link PLATFORM_TICKET_PROVIDER}. */
export const namesAProviderTicket = (ticket: TicketRefInput): boolean =>
  ticket.provider !== PLATFORM_TICKET_PROVIDER;

export const ticketWrites = (integrations: PipelineIntegrations) => ({
  /** BD-023's sticky comment: one per task, edited in place. */
  upsertWorkpad: async (
    ticket: TicketRefInput,
    markerId: string,
    markdown: string,
    context: TicketWriteContext,
  ): Promise<CommentRef | null> => {
    const binding = integrations.taskManagement;
    if (binding === null || !namesAProviderTicket(ticket)) {
      return null;
    }
    return mutate(
      integrations,
      binding.ref,
      'upsert_workpad',
      { ticket_key: ticket.key, marker_id: markerId },
      context,
      async () => binding.port.upsertWorkpad(ticket, markerId, markdown),
      () => ({
        provider: ticket.provider,
        ticket_key: ticket.key,
        comment_id: `would-have-${markerId}`,
        url: null,
      }),
      (result) => ({ comment_id: result.comment_id }),
      context.causeEventId === null
        ? undefined
        : replayable<CommentRef>(`upsert_workpad:${markerId}:${context.causeEventId}`),
    );
  },

  /**
   * The ticket readiness linter's one comment — product/18, WP-25.
   *
   * `addComment` rather than `upsertWorkpad` because product/08 says *"a new comment every time —
   * questions and linter output must notify"*: a workpad is edited in place and notifies nobody,
   * and the whole value of a lint is that the ticket's author sees it.
   *
   * **The markdown is redacted here, at the call**, for the reason `reviewWrites.thread` states: it
   * is a model's words on their way to a third party, the executor redacts what it *stores* rather
   * than what it sends, and doing it at the call means a second caller cannot forget it. The
   * redactor is the **task-management** binding's — TD-012 step 1 over that binding's own
   * credentials, then step 2's patterns — and the residual is the one Q55 leaves everywhere outside
   * a run: this job holds no run-scoped secret set of its own. Since WP-76 a lint run **is** minted
   * a credential — a `read` one, because `TOOLS_BY_ROLE.product_manager` is
   * `['Read','Glob','Grep','Skill']` (no `Edit`, no `Write`) and `runIsReadOnly` is true — and it
   * is revoked when the run ends; the composition root's
   * platform redactor carries the run-scoped secrets **its own process** minted by exact value, and
   * since WP-80 every process's step-2 rules carry each minted credential's recorded shape, so an
   * outbound job in a process that did not mint replaces it too (PROGRESS backlog 259).
   *
   * `idempotencyKey` is the caller's and identifies *the lint*, not the wake-up: product/19 § 17
   * says the comment is never re-posted, so a redelivery **and** a re-run of the stage must both
   * replay (`lintCommentIdempotencyKey`).
   */
  lintComment: async (
    ticket: TicketRefInput,
    markdown: string,
    context: CallContext & {
      readonly mode: TaskMode;
      readonly idempotencyKey: string;
      /**
       * The platform's own marker for this comment, in the provider's dialect (`marker_id` on the
       * stored comment, `[agentic:marker:…]` on Jira).
       *
       * Two things come with it and both are wanted. A marked comment is recognisably the
       * platform's, so `boundTicketSnapshot` skips it and a later stage is never shown the
       * platform's own lint as if a human had written it; and the Jira adapter **looks for it before
       * posting**, which is a third guard behind the idempotency key and the task key.
       */
      readonly markerId: string;
    },
  ): Promise<CommentRef | null> => {
    const binding = integrations.taskManagement;
    if (binding === null || !namesAProviderTicket(ticket)) {
      return null;
    }
    const redacted = binding.redactor.redactText(markdown).value;
    return mutate(
      integrations,
      binding.ref,
      'add_comment',
      // The ticket and the marker, never the body: `integration_actions.payload` wants what was
      // touched rather than a copy of the comment (the rule `create_discussion` follows).
      { ticket_key: ticket.key, marker_id: context.markerId },
      context,
      async () => binding.port.addComment(ticket, redacted, { markerId: context.markerId }),
      () => ({
        provider: ticket.provider,
        ticket_key: ticket.key,
        comment_id: 'would-have-lint',
        url: null,
        marker_id: context.markerId,
      }),
      (result) => ({ comment_id: result.comment_id }),
      replayable<CommentRef>(context.idempotencyKey),
    );
  },

  /**
   * The ask-the-task mirror — product/10:57's *"and mirrored in the ticket thread"* (WP-31).
   *
   * A sibling of {@link lintComment} rather than a reuse of it, because the two differ in the one
   * thing the idempotency key is about: a lint is posted **once per task** and an ask is posted once
   * per *ask*, so the key and the marker are the ask's id. Sharing the function would have meant one
   * caller passing the other's vocabulary.
   *
   * Q72 (d): this is reached only when the project turned `features.ask.mirror_to_ticket` on. The
   * marker does the second job it does for the lint — a comment the platform wrote is recognisable,
   * so `boundTicketSnapshot` skips it and `classifyTicketComment` refuses it, which is what stops an
   * answer from being read as a new question.
   */
  askComment: async (
    ticket: TicketRefInput,
    markdown: string,
    context: CallContext & {
      readonly mode: TaskMode;
      readonly idempotencyKey: string;
      readonly markerId: string;
    },
  ): Promise<CommentRef | null> => {
    const binding = integrations.taskManagement;
    if (binding === null || !namesAProviderTicket(ticket)) {
      return null;
    }
    const redacted = binding.redactor.redactText(markdown).value;
    return mutate(
      integrations,
      binding.ref,
      'add_comment',
      { ticket_key: ticket.key, marker_id: context.markerId },
      context,
      async () => binding.port.addComment(ticket, redacted, { markerId: context.markerId }),
      () => ({
        provider: ticket.provider,
        ticket_key: ticket.key,
        comment_id: 'would-have-ask',
        url: null,
        marker_id: context.markerId,
      }),
      (result) => ({ comment_id: result.comment_id }),
      replayable<CommentRef>(context.idempotencyKey),
    );
  },

  /**
   * The spike's report, attached to the ticket — product/04:117's *"a markdown report attached to
   * the ticket"* (WP-40).
   *
   * A third sibling of {@link lintComment} and {@link askComment}, for the reason those two are
   * siblings of each other: what differs is the **identity the idempotency key names**. A lint is
   * posted once per task, an ask once per ask, and a report once per *architecture attempt* — a
   * spike that returns to refinement and produces a second report has something new to say, and a
   * key that named only the task would replay the first one for ever.
   *
   * `addComment` rather than `upsertWorkpad` because product/08 says *"a new comment every time —
   * questions and linter output must notify"*, and a research report a nobody is notified about is
   * a report nobody reads. The markdown is redacted **here, at the call**, like every other model
   * text on its way to a third party.
   */
  reportComment: async (
    ticket: TicketRefInput,
    markdown: string,
    context: CallContext & {
      readonly mode: TaskMode;
      readonly idempotencyKey: string;
      readonly markerId: string;
    },
  ): Promise<CommentRef | null> => {
    const binding = integrations.taskManagement;
    if (binding === null || !namesAProviderTicket(ticket)) {
      return null;
    }
    const redacted = binding.redactor.redactText(markdown).value;
    return mutate(
      integrations,
      binding.ref,
      'add_comment',
      { ticket_key: ticket.key, marker_id: context.markerId },
      context,
      async () => binding.port.addComment(ticket, redacted, { markerId: context.markerId }),
      () => ({
        provider: ticket.provider,
        ticket_key: ticket.key,
        comment_id: 'would-have-report',
        url: null,
        marker_id: context.markerId,
      }),
      (result) => ({ comment_id: result.comment_id }),
      replayable<CommentRef>(context.idempotencyKey),
    );
  },

  /**
   * **The largest external write this platform makes**: a ticket in somebody else's backlog
   * (product/08:9's *"create follow-up tickets"*, product/04:117's epic split — WP-40).
   *
   * Four properties, and each is here rather than at the caller so that a second caller cannot
   * forget one:
   *
   *  - **The capability is checked before the call.** `TaskManagementCapabilities.createTicket` is
   *    the port's own contract (*"a caller checks the flag before asking; a provider that is asked
   *    anyway throws `IntegrationUnsupportedError` rather than pretending"*), so a read-only binding
   *    answers `null` and **no provider call and no audit row** happen — the same answer a project
   *    with no binding gets.
   *  - **A shadow task creates nothing.** That is `mutate`'s guard rather than a branch here, and it
   *    is why the `shadowResult` below is an obviously fake key: BD-021, and the same sentence Jira's
   *    own adapter carries (*"a shadow task must not be able to pretend it filed a ticket"*).
   *  - **The idempotency key is the caller's and identifies the child**, never the wake-up: a
   *    replayed job and a second decision on the same row must both replay the first answer rather
   *    than file a second ticket. No part of it is model output, so `idempotencyScopeFor` has
   *    nothing to refuse (the rule WP-24's review round 2 earned).
   *  - **Every word of the draft is redacted here** — title, description, labels and the parent key
   *    — because all four reach a third party and three of the four are model output over untrusted
   *    input (BD-022, TD-012).
   *
   * The `payload` recorded on the audit row is the parent and the child's **title**, never the
   * body: `integration_actions.payload` wants what was touched rather than a copy of the ticket
   * (the rule `add_comment` follows).
   */
  createChildTicket: async (
    draft: TicketDraft,
    context: CallContext & { readonly mode: TaskMode; readonly idempotencyKey: string },
  ): Promise<TicketRefInput | null> => {
    const binding = integrations.taskManagement;
    if (binding === null || !binding.port.capabilities().createTicket) {
      return null;
    }
    const text = (value: string): string => binding.redactor.redactText(value).value;
    const redacted: TicketDraft = {
      ...draft,
      title: text(draft.title),
      description: text(draft.description),
      labels: draft.labels.map(text),
      ...(draft.parent_key === undefined || draft.parent_key === null
        ? {}
        : { parent_key: text(draft.parent_key) }),
    };
    return mutate(
      integrations,
      binding.ref,
      'create_ticket',
      {
        project_key: redacted.project_key,
        parent_key: redacted.parent_key ?? null,
        title: redacted.title,
      },
      context,
      async () => binding.port.createTicket(redacted),
      () => ({
        provider: binding.ref.provider,
        key: `WOULD-HAVE-NOT-A-REAL-TICKET`,
        url: 'https://shadow.invalid/would-have-created',
      }),
      (result) => ({ ticket_key: result.key }),
      replayable<TicketRefInput>(context.idempotencyKey),
    );
  },

  /**
   * product/04: "Map stage states to ticket statuses per project" (`status_mapping`), and since
   * WP-177 the ticket lifecycle's slots (TD-029 decision 4): the claim's `in_progress`, the
   * `ticket_lifecycle` duty's moments and the release's `pick_up_from`. Always **to a status name**,
   * never a transition label — the adapter resolves the transition (`transition.to.name`).
   *
   * `idempotencyKey` is for a caller whose write is not the consequence of one event — the claim,
   * made from the `stage.execute` job — and names the platform's own identity of the write (task,
   * stage attempt, slot), never provider text. Absent, the key is the cause event's, as before.
   * Answers what the provider did, or `null` when nothing was called.
   */
  transition: async (
    ticket: TicketRefInput,
    status: string,
    context: TicketWriteContext & { readonly idempotencyKey?: string },
  ): Promise<TransitionResult | null> => {
    const binding = integrations.taskManagement;
    if (binding === null || !namesAProviderTicket(ticket)) {
      return null;
    }
    const key =
      context.idempotencyKey ??
      (context.causeEventId === null || context.taskId === null
        ? undefined
        : `transition_ticket:${context.taskId}:${context.causeEventId}`);
    return mutate(
      integrations,
      binding.ref,
      'transition_ticket',
      { ticket_key: ticket.key, to: status },
      context,
      async () => binding.port.transition(ticket, status),
      () => ({ changed: false, from: status, to: status }),
      (result) => ({ changed: result.changed, from: result.from, to: result.to }),
      key === undefined ? undefined : replayable<TransitionResult>(key),
    );
  },

  /**
   * The claim's write (WP-177, TD-029 decision 5): assigns the ticket to the binding's own account,
   * whoever held it — the caller re-reads the ticket to see who won. A shadow task assigns nothing
   * and is answered `{changed: false, assignee: self}`, recorded `would_have` (BD-021).
   * `idempotencyKey` is the caller's: the task and the stage attempt the claim admits.
   */
  assignToSelf: async (
    ticket: TicketRefInput,
    context: TicketWriteContext & {
      readonly idempotencyKey: string;
      /** The binding's own account, for the shadow answer. */
      readonly self: ExternalIdentity;
    },
  ): Promise<AssignResult | null> => {
    const binding = integrations.taskManagement;
    if (binding === null || !namesAProviderTicket(ticket)) {
      return null;
    }
    return mutate(
      integrations,
      binding.ref,
      'assign_to_self',
      { ticket_key: ticket.key },
      context,
      async () => binding.port.assignToSelf(ticket),
      () => ({ changed: false, assignee: context.self }),
      (result) => ({ changed: result.changed }),
      replayable<AssignResult>(context.idempotencyKey),
    );
  },

  /**
   * The release's write (WP-177): unassigns the ticket **only while the binding's own account
   * holds it** — the port's own contract, so another person's assignment is answered
   * `{changed: false}` and left alone. A shadow task writes nothing.
   */
  unassign: async (
    ticket: TicketRefInput,
    context: TicketWriteContext & { readonly idempotencyKey: string },
  ): Promise<UnassignResult | null> => {
    const binding = integrations.taskManagement;
    if (binding === null || !namesAProviderTicket(ticket)) {
      return null;
    }
    return mutate(
      integrations,
      binding.ref,
      'unassign',
      { ticket_key: ticket.key },
      context,
      async () => binding.port.unassign(ticket),
      () => ({ changed: false }),
      (result) => ({ changed: result.changed }),
      replayable<UnassignResult>(context.idempotencyKey),
    );
  },

  /**
   * The claim refusal's comment (WP-177, TD-029 decision 5): one per refused admission, opened by
   * the marker `agentic:claim-refused:<task>` so the platform never reads it as a person's word.
   * Platform text only — the caller writes no provider text into it — and redacted here anyway, at
   * the call, the rule every comment this module posts follows.
   */
  claimRefusedComment: async (
    ticket: TicketRefInput,
    markdown: string,
    context: CallContext & {
      readonly mode: TaskMode;
      readonly idempotencyKey: string;
      readonly markerId: string;
    },
  ): Promise<CommentRef | null> => {
    const binding = integrations.taskManagement;
    if (binding === null || !namesAProviderTicket(ticket)) {
      return null;
    }
    const redacted = binding.redactor.redactText(markdown).value;
    return mutate(
      integrations,
      binding.ref,
      'add_comment',
      { ticket_key: ticket.key, marker_id: context.markerId },
      context,
      async () => binding.port.addComment(ticket, redacted, { markerId: context.markerId }),
      () => ({
        provider: ticket.provider,
        ticket_key: ticket.key,
        comment_id: 'would-have-claim-refused',
        url: null,
        marker_id: context.markerId,
      }),
      (result) => ({ comment_id: result.comment_id }),
      replayable<CommentRef>(context.idempotencyKey),
    );
  },

  /**
   * The Developer's answer to a ticket comment that asked for something (WP-179, TD-029 decision
   * 10: *"a reply to a ticket-comment request is a ticket comment with the same marker"*). A fifth
   * sibling of {@link lintComment}, for the reason those are siblings: the key names *this* reply
   * (`conversationReplyIdempotencyKeyFor`, the task, the run and the entry's position — no model
   * text). The body is redacted here and **must open with its marker** — the bare
   * `agentic:reply:…` that `opensWithPlatformCommentMarker` reads — which is refused rather than
   * repaired (`assertOpensWithMarker`), so the platform's own reply can never be read back as a
   * person's word that returns the task (decision 6).
   */
  replyComment: async (
    ticket: TicketRefInput,
    markdown: string,
    context: CallContext & {
      readonly mode: TaskMode;
      readonly idempotencyKey: string;
      readonly markerId: string;
    },
  ): Promise<CommentRef | null> => {
    const binding = integrations.taskManagement;
    if (binding === null || !namesAProviderTicket(ticket)) {
      return null;
    }
    const redacted = binding.redactor.redactText(markdown).value;
    assertOpensWithMarker('ticket', redacted, 'add_comment');
    return mutate(
      integrations,
      binding.ref,
      'add_comment',
      { ticket_key: ticket.key, marker_id: context.markerId },
      context,
      async () => binding.port.addComment(ticket, redacted, { markerId: context.markerId }),
      () => ({
        provider: ticket.provider,
        ticket_key: ticket.key,
        comment_id: 'would-have-reply',
        url: null,
        marker_id: context.markerId,
      }),
      (result) => ({ comment_id: result.comment_id }),
      replayable<CommentRef>(context.idempotencyKey),
    );
  },
});

/**
 * **A note the platform posts opens with its marker, or it is not posted** (WP-179, TD-029
 * decision 6: *"every platform write path opens its body with a marker"*). Asked of the redacted
 * body — what is sent — by every merge-request note write (`reviewWrites.thread`, `reply`) and by
 * the ticket reply; `platform-marker-census.test.ts` holds the renderers to the same rule, so this is
 * the backstop for a caller that renders by hand. A refusal throws before the executor is reached:
 * no provider call and no audit row, because nothing was attempted.
 */
export const assertOpensWithMarker = (
  surface: 'merge_request' | 'ticket',
  body: string,
  action: string,
): void => {
  const marked =
    surface === 'merge_request'
      ? isPlatformMergeRequestNote(body)
      : opensWithPlatformCommentMarker(body);
  if (!marked) {
    throw new Error(
      `the platform refused to ${action}: a body it posts on a ${surface === 'ticket' ? 'ticket' : 'merge request'} must open with a platform marker (TD-029 decision 6)`,
    );
  }
};

/**
 * The writes the **Librarian** makes (WP-18b): a knowledge commit and the merge request that offers
 * it for review.
 *
 * Beside `ticketWrites` rather than in the knowledge package because this is the same door — every
 * provider call the platform makes goes through the executor, with the same shadow guard, the same
 * idempotency and the same audit row — and because `assertOutsideTransaction` has to stay on the
 * path. The knowledge job holds no transaction when it calls these; `open-transaction.ts` refuses
 * if a later change opens one.
 *
 * **`mode` is `normal` and that is a decision, not an oversight.** A shadow task's proposals are
 * never auto-applied (the curator queues them instead, BD-021), so the only way one of these pages
 * reaches a commit is a maintainer approving it — a human's action attributed to the platform's bot
 * identity (BD-025 §4), not the shadow run's.
 */
/** The branch namespace the platform writes into (BD-025 §3). */
export const PLATFORM_BRANCH_PREFIX = 'agentic/';

/** Refuses a commit or a merge request from a branch outside {@link PLATFORM_BRANCH_PREFIX}. */
export const assertPlatformBranch = (branch: string): void => {
  if (
    !branch.startsWith(PLATFORM_BRANCH_PREFIX) ||
    branch.length <= PLATFORM_BRANCH_PREFIX.length
  ) {
    throw new Error(
      `the platform commits only to branches under ${PLATFORM_BRANCH_PREFIX} (BD-025); ${JSON.stringify(branch.slice(0, 80))} is not one`,
    );
  }
};

export const knowledgeWrites = (integrations: PipelineIntegrations) => ({
  /** One commit carrying whole files, on a branch of its own (never the default branch). */
  commit: async (
    input: {
      readonly branch: string;
      readonly startBranch: string;
      readonly message: string;
      readonly authorName: string;
      readonly authorEmail: string;
      readonly actions: readonly CommitAction[];
      /** The identity of this batch, for the replay: the branch it is committing to. */
      readonly idempotencyKey: string;
    },
    context: CallContext,
  ): Promise<CommitRef | null> => {
    // BD-025's namespace, **checked** rather than promised (WP-63 review round 1): both callers of
    // this door build `agentic/…` names, and a third that did not would be committing onto a
    // branch the platform does not own — the default branch included.
    assertPlatformBranch(input.branch);
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    // **Parsed, not merely typed** (standing rule 14): the message carries a ticket key and page
    // paths, and a bound only TypeScript knows about is not a bound at a boundary. This is the one
    // place the platform builds a commit, so it is the place the schema is applied.
    const request = commitFilesRequestSchema.parse({
      project: git.project,
      branch: input.branch,
      start_branch: input.startBranch,
      message: input.message,
      author_name: input.authorName,
      author_email: input.authorEmail,
      actions: input.actions.map((action) => ({ ...action })),
    });
    return mutate(
      integrations,
      git.ref,
      'commit_files',
      {
        project: git.project,
        branch: input.branch,
        start_branch: input.startBranch,
        // The paths, never the contents: a knowledge page is model output on its way to
        // `integration_actions.payload`, and the audit row wants what was touched rather than a
        // copy of every byte (technical/06's payload is a description, not a body).
        paths: input.actions.map((action) => action.path),
      },
      { ...context, mode: 'normal' },
      async () => git.port.commitFiles(request),
      () => ({ sha: 'would-have', branch: input.branch, url: null }),
      (result) => ({ sha: result.sha, branch: result.branch }),
      replayable<CommitRef>(input.idempotencyKey),
    );
  },

  /** The knowledge merge request (technical/07 step 4). BD-007 still applies: a human merges it. */
  openMergeRequest: async (
    input: {
      readonly branch: string;
      readonly target: string;
      readonly title: string;
      readonly description: string;
      readonly idempotencyKey: string;
      /**
       * The merge request's labels; `['agentic', 'knowledge']` when omitted. WP-63's configuration
       * export is the second caller of this door and labels its merge request `configuration`.
       */
      readonly labels?: readonly string[];
    },
    context: CallContext,
  ): Promise<MergeRequest | null> => {
    assertPlatformBranch(input.branch);
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    // Parsed here too, and for the same reason: the description carries the same two untrusted
    // values the commit message does. The developer's `open_mr` (WP-138) builds its own draft in
    // `codeMergeRequestWrites.open` below and parses it there too.
    const draft = mergeRequestDraftSchema.parse({
      project: git.project,
      branch: input.branch,
      target: input.target,
      title: input.title,
      description: input.description,
      // Not a draft: there is nothing for CI to finish and nothing more for the platform to
      // add — the whole change is in the commit, and a draft would need a second call to
      // undraft it before a human could merge (BD-007).
      draft: false,
      labels: [...(input.labels ?? ['agentic', 'knowledge'])],
      reviewers: [],
      remove_source_branch: true,
    });
    return mutate(
      integrations,
      git.ref,
      'open_merge_request',
      { project: git.project, branch: input.branch, target: input.target },
      { ...context, mode: 'normal' },
      async () => git.port.openMergeRequest(draft),
      () => null as unknown as MergeRequest,
      (result) => ({ iid: result.ref.iid, url: result.web_url }),
      replayable<MergeRequest>(input.idempotencyKey),
    );
  },
});

/**
 * The writes **review-only mode** makes: one thread per finding, and one thread for the summary
 * (WP-24, product/18).
 *
 * Beside `ticketWrites` and `knowledgeWrites` because it is the same door — the shadow guard, the
 * rate limiter, the idempotency record and the audit row are the executor's, and
 * `assertOutsideTransaction` is on the path — and because putting it here is what makes "the
 * pipeline cannot forget the executor" a property of the code.
 *
 * **`mode` is the task's**, unlike `knowledgeWrites`, and since WP-45 both values reach it.
 * `runReviewOnlyCheck` creates every review-only task with `mode: 'normal'` (`review-only.ts` § "the
 * task shape": `tasks.mode` stays the two-valued shadow switch and `review_only` is a **run** mode),
 * so its threads are real — measured by
 * `packages/application/src/pipeline/review-only.test.ts` › "creates the review task in `normal`
 * mode, so every thread it posts is a real one". The shadow report's review of a **human** merge
 * request (`shadow/human-review.ts`) creates the same kind of task in `mode: 'shadow'`, so every
 * thread it would post is recorded `would_have` and nothing reaches the merge request — measured by
 * `packages/application/src/shadow/report.test.ts` › "posts nothing on the human merge request:
 * every thread is a `would_have` row". The sentence that stood here
 * until WP-45 — *"review-only mode has no shadow mode … the executor's `would_have` branch is
 * unreachable from here"* — was true of that build and is not of this one; the guard was already on
 * the path, as it said it would be.
 *
 * **The markdown is redacted here, at the call**, not by the caller and not by the executor. The
 * executor redacts what it *stores* (the audit row, the idempotency value, the thrown error) and
 * hands the adapter the argument it was given, so a finding is a model's words on their way to a
 * third party with nothing in between — which is exactly the reach TD-012 exists for. Doing it here
 * rather than in the duty means a second caller cannot forget it (standing rule 44's shape: the
 * claim is enforced by the same function that makes it).
 *
 * **What that redactor is, and what is left over — measured, not assumed** (WP-24 review round 2).
 * `bindings/loader.ts` composes it as TD-012 step 1 over the *binding's* resolved credentials, then
 * step 2, the platform's gitleaks-derived pattern rules. So a provider token, an `sk-ant-…` model
 * key, a `glpat-…` or any other pattern-matched shape a model quoted into a finding is removed
 * before it reaches the merge request — measured through a composed instance in
 * `test/e2e/pipeline/review-only.e2e.test.ts`. What this call holds no copy of is the **run-scoped**
 * secret set: it runs after the run, in a process that may not be the one that held it (Q55's
 * unfinished half).
 *
 * **Since WP-76 that set is not empty for a review, and this sentence said it was.** The chain is
 * `packages/infrastructure/src/workspace/spec.test.ts` § "is at most a read credential for a
 * review-only run": `REVIEW_ONLY_TEMPLATE`'s one agent stage is the reviewer's,
 * `TOOLS_BY_ROLE.reviewer` has neither `Write` nor `Edit` (it gained `Bash` at WP-54, which
 * `runIsReadOnly` does not read), so the run is read-only and the runner mints it a **`read`**
 * credential (TD-028's WP-76 amendment, decision 2) — which its shell can read through the git
 * credential helper, and which is **revoked when the run ends**, before this job runs. The
 * composition root composes the run-scoped secrets **its own process** minted into every binding's
 * platform redactor (`apps/server/src/pipeline.ts`), held until the token expires, so a thread
 * posted from the process that ran the review has it replaced by name; one posted from a process
 * that did not mint has it replaced by the step-2 rule compiled from its recorded shape (WP-80,
 * TD-012's M5 amendment — until then that residual was PROGRESS backlog 154's).
 */
export const reviewWrites = (integrations: PipelineIntegrations) => ({
  /**
   * Closes a merge request without merging it — product/04:86's *"the old MR is closed"*, for the
   * one caller that has a merge request to close: a reworked task (WP-59, PROGRESS backlog 51).
   *
   * A **mutation**, so a shadow task records `would_have` and closes nothing, with a platform-owned
   * `IdempotencyPlan`: it runs from an at-least-once job, and a retry after the provider already
   * answered replays. The port's own close is idempotent too (an already-closed merge request
   * succeeds), which is what covers a retry whose idempotency record was never written.
   */
  close: async (
    input: { readonly ref: MergeRequestRefInput; readonly idempotencyKey: string },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<MergeRequest | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return mutate(
      integrations,
      git.ref,
      'close_merge_request',
      { project: git.project, iid: input.ref.iid },
      context,
      async () => git.port.closeMergeRequest(addressed(git, input.ref)),
      // A shadow task makes no call; `null` is described as no result rather than read as one.
      () => null as unknown as MergeRequest,
      (result) => (result === null ? null : { iid: result.ref.iid, state: result.state }),
      replayable<MergeRequest>(input.idempotencyKey),
    );
  },

  /**
   * Sets the merge request's reviewers — product/08:10's `set_reviewers`, which no caller had
   * until WP-37.
   *
   * It is a **mutation**, so a shadow task records `would_have` and assigns nobody, and it carries
   * a platform-owned `IdempotencyPlan` keyed on the task and the revision: this runs from an
   * at-least-once job, and a retry after the provider already answered must replay rather than
   * assign a second time.
   *
   * **The ids are the caller's and are already resolved** (`resolveUserId`), because the port takes
   * the provider's own identifiers — GitLab's API takes `reviewer_ids` and nothing else. The
   * platform's own reviewers are **added to** whoever is already on the merge request rather than
   * replacing them: `updateMergeRequest` sets the whole list, so a caller that sent only its own
   * would silently remove a human who had added themselves. The union is computed here rather than
   * in the duty for the reason the markdown redaction is (standing rule 44): a second caller cannot
   * forget it.
   */
  reviewers: async (
    input: {
      readonly ref: MergeRequestRefInput;
      readonly externalIds: readonly string[];
      readonly idempotencyKey: string;
    },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<MergeRequest | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    const current = await read(
      integrations,
      git.ref,
      'get_merge_request',
      { project: git.project, iid: input.ref.iid },
      context,
      async () => git.port.getMergeRequest(addressed(git, input.ref)),
    );
    const reviewers = [...current.reviewers.map((identity) => identity.external_id)];
    for (const id of input.externalIds) {
      if (!reviewers.includes(id)) {
        reviewers.push(id);
      }
    }
    if (reviewers.length === current.reviewers.length) {
      // Nothing to add. A mutation that would change nothing is not made: it would cost a request,
      // an audit row and an idempotency record to write the list that is already there.
      return current;
    }
    return mutate(
      integrations,
      git.ref,
      'set_reviewers',
      { project: git.project, iid: input.ref.iid, reviewers },
      context,
      async () => git.port.updateMergeRequest(addressed(git, input.ref), { reviewers }),
      /**
       * The merge request as this call **would have** left it — and never `null`.
       *
       * A shadow task makes no call, but the executor still *describes* the result for the
       * `would_have` row (technical/06: the row says what it would have done), so a `null` here
       * is a `TypeError` thrown inside `describeResult` and a failed `risk_route` job on every
       * shadow task instead of a recorded non-call. It **was** one until WP-37 review round 2,
       * and what hid it is that no tier drove a shadow task through this write — the sentence
       * four paragraphs up ("a shadow task records `would_have` and assigns nobody") was a claim
       * nothing held. `risk-routing.test.ts` § "records a shadow task’s assignment as would_have"
       * holds it now.
       *
       * Nothing is invented: the value is the merge request just read, carrying the union that
       * was about to be sent. An identity already on it is kept as the provider wrote it, and one
       * this call would have added is `verified: false`, because nothing verified it.
       */
      () => ({
        ...current,
        reviewers: reviewers.map(
          (externalId) =>
            current.reviewers.find((identity) => identity.external_id === externalId) ?? {
              provider: git.ref.provider,
              external_id: externalId,
              verified: false,
            },
        ),
      }),
      (result) => ({ reviewers: result.reviewers.map((identity) => identity.external_id) }),
      replayable<MergeRequest>(input.idempotencyKey),
    );
  },

  /**
   * One thread. `path`/`line` anchor it to the diff; both absent posts it on the merge request,
   * which is what the neutral summary is.
   *
   * `idempotencyKey` is the caller's, and it must identify *this* thread on *this* revision: a
   * job is at-least-once, and a retry after the provider already answered must replay rather than
   * post a second copy of the same finding.
   */
  thread: async (
    input: {
      readonly ref: MergeRequestRefInput;
      readonly path: string | null;
      readonly line: number | null;
      readonly markdown: string;
      readonly idempotencyKey: string;
    },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<Discussion | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    const markdown = git.redactor.redactText(input.markdown).value;
    // WP-179: every note the platform posts opens with its marker (TD-029 decision 6).
    assertOpensWithMarker('merge_request', markdown, 'create_discussion');
    return mutate(
      integrations,
      git.ref,
      'create_discussion',
      // The path, never the body: `integration_actions.payload` wants what was touched rather than
      // a copy of a model's paragraph (the same rule `commit_files` follows).
      { project: git.project, iid: input.ref.iid, path: input.path, line: input.line },
      context,
      async () =>
        git.port.createDiscussion(addressed(git, input.ref), {
          path: input.path,
          line: input.line,
          markdown,
        }),
      () => null as unknown as Discussion,
      // `null` is the shadow result above, and the executor describes a `would_have` row too: a
      // `result.id` read here threw inside the describe and failed the job for every shadow caller.
      // Reached at WP-59 by a shadow **peer** of a conflict warning; the same shape WP-37 round 2
      // fixed in `reviewers` above.
      (result) => (result === null ? null : { discussion_id: result.id }),
      replayable<Discussion>(input.idempotencyKey),
    );
  },

  /**
   * One reply in an existing discussion (WP-179, TD-029 decision 10) — the Developer's answer to a
   * finding or to a person's note, posted by the platform.
   *
   * **The discussion that comes back may not be the one asked for** (`replyToDiscussion`'s
   * docblock; GitLab divergence 8): a reply to an individual note can arrive as a new general
   * note with an id of its own. So nothing may find this reply again by the returned id; the caller
   * finds it by the marker its body opens with, which the provider keeps at the start. A mutation
   * with the caller's idempotency key, the body redacted with the git binding's redactor and
   * refused unless it opens with a platform marker.
   */
  reply: async (
    input: {
      readonly ref: MergeRequestRefInput;
      readonly discussionId: string;
      readonly markdown: string;
      readonly idempotencyKey: string;
    },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<Discussion | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    const markdown = git.redactor.redactText(input.markdown).value;
    assertOpensWithMarker('merge_request', markdown, 'reply_to_discussion');
    return mutate(
      integrations,
      git.ref,
      'reply_to_discussion',
      // The thread, never the body (`create_discussion`'s rule).
      { project: git.project, iid: input.ref.iid, discussion_id: input.discussionId },
      context,
      async () =>
        git.port.replyToDiscussion(addressed(git, input.ref), input.discussionId, markdown),
      () => null as unknown as Discussion,
      (result) => (result === null ? null : { discussion_id: result.id }),
      replayable<Discussion>(input.idempotencyKey),
    );
  },

  /**
   * Resolves a discussion (WP-179, TD-029 decision 10) — only ever one of the Reviewer's own finding
   * threads, which the caller has checked by marker. A mutation **without** an idempotency key: the
   * port's resolve is idempotent (an already-resolved thread succeeds and changes nothing), and the
   * caller skips a thread it read as resolved.
   */
  resolve: async (
    input: { readonly ref: MergeRequestRefInput; readonly discussionId: string },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<Discussion | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return mutate(
      integrations,
      git.ref,
      'resolve_discussion',
      { project: git.project, iid: input.ref.iid, discussion_id: input.discussionId },
      context,
      async () => git.port.resolveDiscussion(addressed(git, input.ref), input.discussionId),
      () => null as unknown as Discussion,
      (result) =>
        result === null ? null : { discussion_id: result.id, resolved: result.resolved },
    );
  },
});

/**
 * Why the developer's `open_mr` did not adopt the open merge request it met (WP-138 ruling (c)).
 *
 * The provider answered that a merge request is already open from the task's branch, and the
 * platform read it: it is adopted only when it is the platform's own — its target is the project's
 * default branch and its author is the binding's account. Anything else is a person's merge request
 * (or one aimed elsewhere), and recording it on the task would hand that person's work to the
 * pipeline — `mr.merged` would advance the task. So it is refused **by name**, and nothing is
 * recorded.
 */
export class MergeRequestNotAdoptedError extends Error {
  override readonly name = 'MergeRequestNotAdoptedError';
}

/** What {@link codeMergeRequestWrites}`.open` did. */
export type CodeMergeRequestOpening =
  | { readonly kind: 'opened' | 'adopted'; readonly mergeRequest: MergeRequest }
  /** A shadow task: recorded `would_have`, nothing reached the provider (rule 18). */
  | { readonly kind: 'shadow' };

/**
 * The developer's own merge request — opened, described, given a pipeline, marked ready at
 * `ready_for_merge` and put back to draft when an agent changes it again (WP-138, backlog 486).
 * Every call is the executor's, outside a transaction (WP-15d): the platform tool runs in
 * `stage.execute`'s no-transaction phase and the three merge-request duties in `pipeline.outbound`.
 *
 * The caller has already decided the branch (the task's), the target (`projects.default_branch`)
 * and the text (bounded, redacted, footer appended); nothing here takes a value from the model.
 * `null` is a project with no git binding, as for every other write surface.
 */
export const codeMergeRequestWrites = (integrations: PipelineIntegrations) => ({
  open: async (
    input: {
      readonly branch: string;
      readonly target: string;
      readonly title: string;
      readonly description: string;
      readonly draft: boolean;
      /** `open_mr:<task id>:<branch>` — one merge request per task and branch (ruling (c)). */
      readonly idempotencyKey: string;
    },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<CodeMergeRequestOpening | null> => {
    assertPlatformBranch(input.branch);
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    const draft = mergeRequestDraftSchema.parse({
      project: git.project,
      branch: input.branch,
      target: input.target,
      title: input.title,
      description: input.description,
      draft: input.draft,
      labels: ['agentic'],
      reviewers: [],
      remove_source_branch: true,
    });
    try {
      const opened = await mutate(
        integrations,
        git.ref,
        'open_merge_request',
        // What was touched, never the text: the title and the description are a model's words.
        { project: git.project, branch: input.branch, target: input.target, draft: input.draft },
        context,
        async () => git.port.openMergeRequest(draft),
        () => null as unknown as MergeRequest,
        (result) => (result === null ? null : { iid: result.ref.iid, url: result.web_url }),
        replayable<MergeRequest>(input.idempotencyKey),
      );
      return context.mode === 'shadow' || opened === null
        ? { kind: 'shadow' }
        : { kind: 'opened', mergeRequest: opened };
    } catch (error) {
      if (!(error instanceof IntegrationError) || error.code !== 'conflict') {
        throw error;
      }
    }
    // The provider holds an open merge request from this branch already — a retried call whose
    // idempotency record was never written, or a resumed run. Read it and adopt it only if it is ours.
    const existing = await read(
      integrations,
      git.ref,
      'find_open_merge_request',
      { project: git.project, branch: input.branch },
      context,
      async () => git.port.findOpenMergeRequest(git.project, input.branch),
    );
    if (existing === null) {
      throw new MergeRequestNotAdoptedError(
        `the provider refused a merge request from ${input.branch} as a duplicate and lists no open one from it; nothing was recorded`,
      );
    }
    const me = await read(integrations, git.ref, 'authenticated_user', {}, context, async () =>
      git.port.authenticatedUser(),
    );
    if (existing.target_branch !== input.target) {
      throw new MergeRequestNotAdoptedError(
        `merge request !${existing.ref.iid} is already open from ${input.branch} but targets another branch than the project's default branch ${input.target}; the platform does not adopt it`,
      );
    }
    if (existing.author?.external_id !== me.external_id) {
      throw new MergeRequestNotAdoptedError(
        `merge request !${existing.ref.iid} is already open from ${input.branch} and was opened by another account than the binding's; the platform does not adopt a person's merge request`,
      );
    }
    return { kind: 'adopted', mergeRequest: existing };
  },

  /** Replaces the description — `update_mr_description`. Keyed per description digest. */
  describe: async (
    input: {
      readonly ref: MergeRequestRefInput;
      readonly description: string;
      readonly idempotencyKey: string;
    },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<MergeRequest | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return mutate(
      integrations,
      git.ref,
      'update_merge_request_description',
      { project: git.project, iid: input.ref.iid },
      context,
      async () =>
        git.port.updateMergeRequest(addressed(git, input.ref), {
          description: input.description,
          title: null,
          draft: null,
          labels: null,
          reviewers: null,
        }),
      () => null as unknown as MergeRequest,
      (result) => (result === null ? null : { iid: result.ref.iid }),
      replayable<MergeRequest>(input.idempotencyKey),
    );
  },

  /**
   * Removes the draft prefix — the provider's own title rewrite, nothing else. Called when the task
   * enters `ready_for_merge` (backlog 486, the product owner's 2026-10-06 reversal of WP-138 ruling
   * (g), which called it at the Developer stage's completion).
   */
  markReady: async (
    input: { readonly ref: MergeRequestRefInput; readonly idempotencyKey: string },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<MergeRequest | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return mutate(
      integrations,
      git.ref,
      'mark_merge_request_ready',
      { project: git.project, iid: input.ref.iid },
      context,
      async () =>
        git.port.updateMergeRequest(addressed(git, input.ref), {
          draft: false,
          title: null,
          description: null,
          labels: null,
          reviewers: null,
        }),
      () => null as unknown as MergeRequest,
      (result) => (result === null ? null : { iid: result.ref.iid, draft: result.draft }),
      replayable<MergeRequest>(input.idempotencyKey),
    );
  },

  /**
   * Puts the draft prefix back (backlog 486): a task that left `ready_for_merge` for an agent stage
   * is being changed again, so its merge request is not left ready meanwhile.
   */
  markDraft: async (
    input: { readonly ref: MergeRequestRefInput; readonly idempotencyKey: string },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<MergeRequest | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return mutate(
      integrations,
      git.ref,
      'mark_merge_request_draft',
      { project: git.project, iid: input.ref.iid },
      context,
      async () =>
        git.port.updateMergeRequest(addressed(git, input.ref), {
          draft: true,
          title: null,
          description: null,
          labels: null,
          reviewers: null,
        }),
      () => null as unknown as MergeRequest,
      (result) => (result === null ? null : { iid: result.ref.iid, draft: result.draft }),
      replayable<MergeRequest>(input.idempotencyKey),
    );
  },

  /** Starts a merge-request pipeline at the head (ruling (g)); keyed per head sha by the caller. */
  createPipeline: async (
    input: { readonly ref: MergeRequestRefInput; readonly idempotencyKey: string },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<CreatedPipeline | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return mutate(
      integrations,
      git.ref,
      'create_merge_request_pipeline',
      { project: git.project, iid: input.ref.iid },
      context,
      async () => git.port.createMergeRequestPipeline(addressed(git, input.ref)),
      () => null as unknown as CreatedPipeline,
      (result) => (result === null ? null : { pipeline_id: result.id, head_sha: result.head_sha }),
      replayable<CreatedPipeline>(input.idempotencyKey),
    );
  },
});

/**
 * The chat calls the notification band makes (WP-32) — each one a mutation, each one replayable.
 *
 * Three calls and no reads: a notification is something the platform *says*. Every one of them
 * answers `null` for a project with no communication binding, which is the same "absent is not
 * broken" shape the other two write surfaces have — the caller logs a reason and the task carries
 * on, because a project without a chat integration is a project that reads its tickets.
 *
 * **Every call carries an `IdempotencyPlan` whose key the platform owns**, and that is not a
 * convenience: these calls are made from a `pipeline.outbound` job, a job is at-least-once, and a
 * retried wake-up that posted a second copy of the same escalation would be the bot product/18
 * exists to keep welcome. The keys are built from platform identifiers — an event id, a task id, a
 * channel and a date — never from provider text, because the executor **refuses** a key that would
 * need redacting (`idempotencyScopeFor`: redaction is many-to-one and a key is an identity).
 */
export const communicationWrites = (integrations: PipelineIntegrations) => ({
  /**
   * The task's thread (product/08: one channel per project, one thread per task).
   *
   * The port promises one thread per task and the Slack adapter keeps that promise **in memory**,
   * which is worth nothing here: `bindings/loader.ts` builds the adapter *per call* so the
   * redactor can carry the call's run-scoped credentials (Q55), so every notification would meet a
   * fresh, empty directory and open a new thread. The durable half is the executor's idempotency
   * store, keyed by task — which `threads.ts` has described since WP-10 as *available and unused*,
   * with *"whoever gives the action a plan owns the assertion"*. This is that caller.
   */
  taskThread: async (
    input: { readonly taskId: Id; readonly body: MessageBody },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<ThreadRef | null> => {
    const chat = integrations.communication;
    if (chat === null) {
      return null;
    }
    return mutate(
      integrations,
      chat.ref,
      'post_task_thread',
      // The channel and the task, never the body: `integration_actions.payload` wants what was
      // touched rather than a copy of the message.
      { channel: chat.channel, task_id: input.taskId },
      context,
      async () =>
        chat.port.postTaskThread({
          channel: chat.channel,
          taskId: input.taskId,
          body: input.body,
        }),
      () => ({
        provider: chat.ref.provider,
        channel: chat.channel,
        thread_id: `would-have-${input.taskId}`,
        url: null,
      }),
      (result) => ({ channel: result.channel, thread_id: result.thread_id }),
      replayable<ThreadRef>(`${chat.ref.provider}:thread:${input.taskId}`),
    );
  },

  /** One notification in the task's thread: picked up, question, returned, escalated, finished. */
  message: async (
    input: {
      readonly thread: ThreadRef;
      readonly body: MessageBody;
      readonly idempotencyKey: string;
    },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<MessageRef | null> => {
    const chat = integrations.communication;
    if (chat === null) {
      return null;
    }
    return mutate(
      integrations,
      chat.ref,
      'post_message',
      { channel: input.thread.channel, thread_id: input.thread.thread_id },
      context,
      async () => chat.port.postMessage(input.thread, input.body),
      () => ({
        provider: chat.ref.provider,
        channel: input.thread.channel,
        message_id: `would-have-${input.idempotencyKey}`,
        thread_id: input.thread.thread_id,
        url: null,
      }),
      (result) => ({ channel: result.channel, message_id: result.message_id }),
      replayable<MessageRef>(input.idempotencyKey),
    );
  },

  /**
   * An approval in the task's thread, **with its buttons** (WP-43) — `postApproval`, whose Block
   * Kit carries the approval and the task in each button's value.
   *
   * The caller has already decided a click can arrive (`capabilities().buttons`); this is the call.
   * Keyed like `message`, by the wake-up, so a retried job replays the stored `MessageRef` instead
   * of posting a second pair of buttons for one approval.
   */
  approval: async (
    input: {
      readonly thread: ThreadRef;
      readonly approval: ApprovalPost;
      readonly body: MessageBody;
      readonly idempotencyKey: string;
    },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<MessageRef | null> => {
    const chat = integrations.communication;
    if (chat === null) {
      return null;
    }
    return mutate(
      integrations,
      chat.ref,
      'post_approval',
      {
        channel: input.thread.channel,
        thread_id: input.thread.thread_id,
        approval_id: input.approval.id,
      },
      context,
      async () => chat.port.postApproval(input.thread, input.approval, input.body),
      () => ({
        provider: chat.ref.provider,
        channel: input.thread.channel,
        message_id: `would-have-${input.idempotencyKey}`,
        thread_id: input.thread.thread_id,
        url: null,
      }),
      (result) => ({ channel: result.channel, message_id: result.message_id }),
      replayable<MessageRef>(input.idempotencyKey),
    );
  },

  /**
   * A question in the task's thread, **through `postQuestion`** (WP-88, PROGRESS backlog 195) — the
   * port method that renders its options as buttons and says a reply in the thread answers it.
   * Until WP-88 it had no caller and a question went out as a plain `message`, so no button existed
   * and nothing told a person a reply would count.
   *
   * The caller has already decided a click and a reply can arrive (`capabilities().buttons`, and a
   * holder for a held transport); this is the call. Keyed like `message`, by the wake-up.
   */
  question: async (
    input: {
      readonly thread: ThreadRef;
      readonly question: QuestionPost;
      readonly body: MessageBody;
      readonly idempotencyKey: string;
    },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<MessageRef | null> => {
    const chat = integrations.communication;
    if (chat === null) {
      return null;
    }
    return mutate(
      integrations,
      chat.ref,
      'post_question',
      {
        channel: input.thread.channel,
        thread_id: input.thread.thread_id,
        question_id: input.question.id,
      },
      context,
      async () => chat.port.postQuestion(input.thread, input.question, input.body),
      () => ({
        provider: chat.ref.provider,
        channel: input.thread.channel,
        message_id: `would-have-${input.idempotencyKey}`,
        thread_id: input.thread.thread_id,
        url: null,
      }),
      (result) => ({ channel: result.channel, message_id: result.message_id }),
      replayable<MessageRef>(input.idempotencyKey),
    );
  },

  /**
   * Edits a posted message in place — the settled approval's buttons removed (WP-65, PROGRESS
   * backlog 202), `updateMessage` finally having a caller.
   *
   * The caller has already asked `capabilities().messageUpdate`; a provider that cannot edit
   * throws `IntegrationUnsupportedError` rather than posting a second message, which is the right
   * failure — a second message saying "decided" beside live buttons would still be a lie. Keyed by
   * the caller, so a retried job replays the stored `MessageRef` instead of editing twice.
   */
  updateMessage: async (
    input: {
      readonly message: MessageRef;
      readonly body: MessageBody;
      readonly idempotencyKey: string;
    },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<MessageRef | null> => {
    const chat = integrations.communication;
    if (chat === null) {
      return null;
    }
    return mutate(
      integrations,
      chat.ref,
      'update_message',
      { channel: input.message.channel, message_id: input.message.message_id },
      context,
      async () => chat.port.updateMessage(input.message, input.body),
      () => ({ ...input.message }),
      (result) => ({ channel: result.channel, message_id: result.message_id }),
      replayable<MessageRef>(input.idempotencyKey),
    );
  },

  /**
   * One message in the channel, outside every thread — the notification that has no task.
   *
   * A budget window belongs to a project, so `budget.exhausted` has no `task_id` and there is no
   * thread to reply in. Opening a "task thread" keyed by the budget id was the alternative and it
   * would have written a budget into the `task_id` of every audit row the call makes.
   */
  channelMessage: async (
    input: { readonly body: MessageBody; readonly idempotencyKey: string },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<MessageRef | null> => {
    const chat = integrations.communication;
    if (chat === null) {
      return null;
    }
    return mutate(
      integrations,
      chat.ref,
      'post_channel_message',
      { channel: chat.channel },
      context,
      async () => chat.port.postChannelMessage(chat.channel, input.body),
      () => ({
        provider: chat.ref.provider,
        channel: chat.channel,
        message_id: `would-have-${input.idempotencyKey}`,
        thread_id: null,
        url: null,
      }),
      (result) => ({ channel: result.channel, message_id: result.message_id }),
      replayable<MessageRef>(input.idempotencyKey),
    );
  },

  /**
   * The day's digest, in the digest channel — one call per `(channel, day)`.
   *
   * The key is the caller's and names the **day in the schedule's own zone**, which is what makes a
   * retried job replay instead of posting twice and what makes two ticks in one day one message.
   */
  digest: async (
    input: { readonly items: readonly DigestItem[]; readonly day: string },
    context: CallContext & { readonly mode: TaskMode },
  ): Promise<MessageRef | null> => {
    const chat = integrations.communication;
    if (chat === null) {
      return null;
    }
    return mutate(
      integrations,
      chat.ref,
      'post_digest',
      { channel: chat.digestChannel, item_count: input.items.length, day: input.day },
      context,
      async () => chat.port.postDigest(chat.digestChannel, input.items),
      () => ({
        provider: chat.ref.provider,
        channel: chat.digestChannel,
        message_id: `would-have-digest-${input.day}`,
        thread_id: null,
        url: null,
      }),
      (result) => ({ channel: result.channel, message_id: result.message_id }),
      // The mode is part of the key rather than part of the day, and the honest statement of what
      // that buys is worth more than the obvious one. **What keeps a shadow task's lines out of a
      // real message is the caller making one call per mode** (`notify/digest.ts`), plus the guard
      // at step 1 of the executor, which answers a mutating shadow request `would_have` *before*
      // the idempotency step — measured: `action-executor.ts` returns at the shadow branch, so a
      // shadow call reads no key and writes none, and on this build the suffix can therefore not be
      // observed through the store at all. It is here for the case that guard is ever moved or a
      // third mode appears, where two calls sharing a key would make the second replay the first.
      //
      // **Whose digest it is — the project id, or `org` — is part of the key** (WP-93, PROGRESS
      // backlog 317). The executor scopes a key by account and action alone, and one account with
      // one digest channel commonly serves several projects (every binding that leaves the channel
      // to the account's), so a key without the project made the second project's digest of the
      // day a replay of the first's: answered from the store, marked digested, logged "posted", and
      // never sent. The organisation's digest (no project) is `org` for the same reason. One-time
      // consequence of the change, stated: a project digest already posted today under the old
      // key is posted once more if a tick reaches it after the deploy — it cannot, since
      // `digestDelivered` stops a delivered day first, unless the first post's mark never landed.
      replayable<MessageRef>(
        `${chat.ref.provider}:digest:${chat.digestChannel}:${input.day}:${context.projectId ?? 'org'}` +
          (context.mode === 'normal' ? '' : `:${context.mode}`),
      ),
    );
  },
});

// ── The run's git credential (WP-76, TD-028's WP-76 amendment) ──────────────

/**
 * TD-021: *"a run-scoped credential that expires next day"*.
 *
 * A constant rather than a knob: it is a security property of a minted push token, and the only
 * operator interest in changing it points the wrong way. The provisioner passes it to
 * `mintCredential` (WP-76); GitLab grants it in whole days, so the token lives up to two
 * (`gitlab/credentials.ts`, TD-028's WP-76 amendment residuals). Here rather than in
 * `apps/server/src/workspaces.ts`, which minted with it alone until WP-77: the recovery row's
 * horizon is derived from the same number (`runCredentialRecoveryHorizonMs`), and a second copy is
 * a horizon that stops covering the tokens it exists for the day somebody changes one of them.
 */
export const RUN_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;

/** What one run asks its project's git binding for. */
export interface RunCredentialRequest {
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  /** `tasks.mode` — the task's own, never the run's richer mode (TD-028 amendment decision 1). */
  readonly mode: TaskMode;
  /** `push` for a writing run, `read` for a read-only one (decision 2). */
  readonly scope: CredentialScope;
  /** BD-025's namespace; empty for a `read` credential, which pushes nothing. */
  readonly branchPatterns: readonly string[];
  readonly ttlSeconds: number;
  /**
   * `projects.default_branch` — whose protection an **operator's** static run token is handed only
   * behind (TD-028 decision 13a item 2, WP-141). Read before each such run.
   */
  readonly defaultBranch: string;
}

/**
 * The answer: a credential, or the reason there is none.
 *
 * `unavailable` is an **answer**, not a failure — the caller decides what it means: a writing run is
 * refused on it (decision 6) and a read-only run fetches anonymously. A binding that *fails* to
 * mint (the provider refused, the network) throws instead, because that is not a fact about the
 * project's configuration.
 */
export type RunCredentialMint =
  | {
      readonly kind: 'minted';
      readonly credential: MintedRunCredential;
      readonly ref: IntegrationRef;
      /** What the teardown revoke takes: the address, and the binding that minted it (backlog 156). */
      readonly handle: RunCredentialHandle;
    }
  | {
      /**
       * The integration's **static run credential** (TD-028 decision 13, WP-137): no provider call
       * was made, so there is no audit row and nothing to revoke. Always `push` — a static token
       * cannot be narrowed — and its expiry is the operator's declared date.
       */
      readonly kind: 'static';
      readonly credential: StaticRunCredentialGrant;
      readonly ref: IntegrationRef;
    }
  | {
      /**
       * The integration's **SSH deploy key** (TD-028 decision 13b, WP-146): no provider call, no audit
       * row, nothing to revoke per run (removing the key from the project is the revocation). Always
       * `push` — a deploy key with write access cannot be narrowed.
       */
      readonly kind: 'deploy_key';
      readonly credential: DeployKeyRunCredentialGrant;
      readonly ref: IntegrationRef;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * What a run is handed from a deploy key (decision 13b item 2): the key, which the **runner** holds
 * and signs with — it never enters the run container — and the route the run's git takes.
 */
export interface DeployKeyRunCredentialGrant {
  /**
   * The OpenSSH private key text. Joins the run's redactors as the **whole text** before use (the
   * registry holds one value per run); its base64 body joined without line breaks is not a redaction
   * needle — the dependency gate's added-lines search covers that shape (`deployKeyNeedles`).
   */
  readonly privateKey: string;
  /** The `ssh-ed25519 AAAA…` line the run's agent socket lists. */
  readonly publicKey: string;
  readonly route: SshGitRoute;
  readonly scope: 'push';
}

/** What a run is handed from a static run credential (TD-028 decision 13 item 2). */
export interface StaticRunCredentialGrant {
  readonly username: string;
  /** The secret. Joins the run's redactors exactly as a minted value does (decision 8). */
  readonly value: string;
  readonly scope: 'push';
  /** The declared expiry, as an instant. */
  readonly expiresAt: string;
}

/**
 * A declared static run credential the platform will not use — terminal, before the create, and
 * by name (TD-028 decision 13 items 1 and 2): no run token, the API token in its place, a
 * configuration fault, or an expiry passed. Never a fallback to anything else (standing rule 18).
 */
export class StaticRunCredentialRefusedError extends Error {
  override readonly name = 'StaticRunCredentialRefusedError';
  readonly integrationId: Id;
  constructor(integrationId: Id, message: string) {
    super(message);
    this.integrationId = integrationId;
  }
}

/**
 * Why a static credential is refused at use, or `null` — every check the write makes that the
 * load can answer again (decision 13 item 1: *"at the write **and** again at use"*).
 */
const staticCredentialRefusal = (fixed: StaticRunCredential, now: string | null): string | null => {
  if (fixed.refusal !== null) {
    return fixed.refusal;
  }
  if (fixed.value.trim() === '') {
    return 'the integration declares a static run credential and holds no run token';
  }
  if (fixed.value.trim().length < MIN_SECRET_LENGTH) {
    return `its run token is shorter than ${MIN_SECRET_LENGTH} characters, so it could not be redacted`;
  }
  if (fixed.sameAsApiToken) {
    return 'its run token is the integration’s own API token, which is never sent to a workspace (TD-028 decisions 6 and 13)';
  }
  if (fixed.expiresAt === null) {
    return 'its run token has no declared expiry';
  }
  if (now === null) {
    return 'no clock was composed to check the run token’s declared expiry against';
  }
  if (Date.parse(fixed.expiresAt) <= Date.parse(now)) {
    return `its run token expired on ${fixed.declaredExpiry} (the declared expiry); create a new one and declare its expiry`;
  }
  return null;
};

/**
 * Why a declared deploy key is refused at use, or `null` — the write's checks asked again of the
 * loaded values (decision 13b item 1), plus a key too short to redact.
 */
const deployKeyRefusal = (declared: DeployKeyRunCredential): string | null => {
  if (declared.refusal !== null) {
    return declared.refusal;
  }
  if (declared.privateKey.trim().length < MIN_SECRET_LENGTH) {
    return 'the integration declares an SSH deploy key and holds no private key';
  }
  return null;
};

/**
 * The push control behind an **operator's own** run token (TD-028 decision 13a item 2, WP-141): the
 * project's default branch must be protected with push **No one** and force push off. Read **with the
 * API token**, through the executor (a read: audited, rate-limited), before every create of a run
 * that would receive the token — so protection loosened after the probe refuses the next run by
 * name, before any workspace exists. One read per run; the run holds the token for its lifetime and
 * the answer is not asked again (decision 13a: *"cached for the run's lifetime"*).
 *
 * A provider that cannot answer refuses (rule 18): the token reaches every repository its owner can,
 * and the protection is the only thing standing between a writing stage and the default branch.
 */
const operatorTokenProtectionRefusal = async (
  integrations: PipelineIntegrations,
  git: GitBinding,
  request: RunCredentialRequest,
): Promise<string | null> => {
  const branch = request.defaultBranch;
  if (branch.trim() === '') {
    return 'it is the operator’s own token, and no default branch was given whose protection could be checked';
  }
  assertOutsideTransaction('the provider read "check_default_branch_protection"');
  const protection = (
    await integrations.executor.execute<BranchPushProtection>({
      integration: git.ref,
      action: 'check_default_branch_protection',
      // Names only: the project and the branch, never a credential.
      payload: { project: git.project, branch, run_id: request.runId },
      projectId: request.projectId,
      taskId: request.taskId,
      mutating: false,
      perform: async () => git.port.branchPushProtection(git.project, branch),
      describeResult: (rule) => ({
        protected: rule.protected,
        nobody_pushes: rule.nobodyPushes,
        force_push_allowed: rule.forcePushAllowed,
      }),
    })
  ).result;
  return operatorProtectionFault(git.project, branch, protection);
};

/**
 * Why `branch`'s protection does not bound an operator's own run token, or `null` — one sentence an
 * operator acts on, shared by the run's refusal and the probe (WP-141). Provider words (`pushers`)
 * are names GitLab answers for access levels, users and groups.
 */
export const operatorProtectionFault = (
  project: string,
  branch: string,
  protection: BranchPushProtection,
): string | null => {
  const fix = `protect ${branch} with push "No one" and force push off`;
  if (!protection.protected) {
    return `it is the operator’s own token, and the default branch ${branch} of ${project} is not protected, so the token could push to it — ${fix} (TD-028 decision 13a)`;
  }
  if (!protection.nobodyPushes) {
    const who = protection.pushers.length === 0 ? 'someone' : protection.pushers.join(', ');
    return `it is the operator’s own token, and the default branch ${branch} of ${project} lets ${who} push, which the token’s owner may be — ${fix} (TD-028 decision 13a)`;
  }
  if (protection.forcePushAllowed) {
    return `it is the operator’s own token, and the default branch ${branch} of ${project} allows force push — ${fix} (TD-028 decision 13a)`;
  }
  return null;
};

/**
 * Why `branch`'s protection does not bound a project **deploy key** with write access, or `null`
 * (TD-028 decision 13b item 6, WP-146): the default branch must be protected with push **No one** —
 * which, read the provider's way, also means no deploy key is admitted to push there (GitLab lets a
 * deploy key be added to a protected branch's push rule, and `nobodyPushes` is false then).
 */
export const deployKeyProtectionFault = (
  project: string,
  branch: string,
  protection: BranchPushProtection,
): string | null => {
  const fix = `protect ${branch} with push "No one" and admit no deploy key to it`;
  if (!protection.protected) {
    return `the default branch ${branch} of ${project} is not protected, so a deploy key with write access could push to it — ${fix} (TD-028 decision 13b)`;
  }
  if (!protection.nobodyPushes) {
    const who = protection.pushers.length === 0 ? 'someone' : protection.pushers.join(', ');
    return `the default branch ${branch} of ${project} lets ${who} push — ${fix} (TD-028 decision 13b)`;
  }
  return null;
};

/**
 * Minting the run-scoped git credential — **through the executor, keyed by the git binding, with
 * no idempotency key** (TD-028's WP-76 amendment, decisions 1, 5 and 7). Revoking it is
 * {@link runCredentialRevocations}, keyed by the integration that minted it (decision 10, WP-80).
 *
 * No key, because the executor stores a *redacted* result and a replay would answer with
 * `[REDACTED:…]` where the token was — its own docblock asks exactly this of "a minted credential".
 * `describeResult` records `scope`, `expires_at` and `revoke_id` — the revocation address a crash
 * path needs (standing rule 19), which is not secret — and never the value. The payload carries the
 * run id, so a later sweep can find the row of a run whose process died between mint and revoke.
 *
 * **Shadow (Q98 (a), implemented).** A shadow task may mint a **`read`** credential, and **every**
 * revoke is performed whatever the scope — revoking only removes access (review round 2): both
 * declare the executor's run-credential carve-out, and the audit row is a performed mutation whose
 * payload names the task's `shadow` mode. A shadow request to mint `push` is still a `would_have`
 * with **no** credential (never a fake value — standing rule 18), which the caller sees as
 * `unavailable`. A revoke that the executor did not perform (`would_have`, or a `false` result) is
 * a **failure**, never reported as a revocation.
 */
/**
 * A revocation's failure, fit to put in a refusal: redacted against the value just minted — which
 * neither the binding's scope nor the process registry holds yet on a refusal path — and reduced to
 * its class name when the value is too short to redact safely.
 */
const describeRevokeFailure = (error: unknown, value: string): string => {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (value.length < MIN_SECRET_LENGTH) {
    return error instanceof Error ? error.name : 'an error';
  }
  return exactSecretRedactor([{ name: 'refused_run_credential', value }]).redactText(text).value;
};

/**
 * Whether an integration has been **retired** (`integrations.retired_at`, WP-114) — asked by the mint
 * **after** its audit row has committed (PROGRESS backlog 386).
 *
 * Why after, and why that is enough: `DELETE /api/integrations/:id` holds the integration's row
 * `for update` while it refuses on any recorded, unexpired, unconfirmed mint, and the mint's audit
 * insert takes the same row `for key share` through `integration_actions.integration_id`'s foreign
 * key. So either the record commits first — and the retire, reading after the lock, sees it and
 * refuses — or the retire commits first, and this read, made after the record, sees `retired_at`.
 * There is no third order. A mint whose provider call was in flight across an unbind and a retire
 * is therefore always caught here, while the adapter that minted it is still in hand.
 */
export interface MintingIntegrationLiveness {
  readonly isRetired: (integrationId: Id) => Promise<boolean>;
  /**
   * The time a static run credential's declared expiry is checked against (WP-137). Absent, a
   * static credential is **refused** rather than used unchecked — the minted path never reads it.
   */
  readonly now?: () => string;
}

export class RunCredentialMintRetiredError extends Error {
  override readonly name = 'RunCredentialMintRetiredError';
  readonly integrationId: Id;
  constructor(integrationId: Id, message: string) {
    super(message);
    this.integrationId = integrationId;
  }
}

export const runCredentialWrites = (
  integrations: PipelineIntegrations,
  /** Required, never defaulted (standing rule 31): an absent check is backlog 386's defect. */
  liveness: MintingIntegrationLiveness,
) => ({
  mint: async (request: RunCredentialRequest): Promise<RunCredentialMint> => {
    const git = integrations.git;
    if (git === null) {
      return {
        kind: 'unavailable',
        reason: `project ${request.projectId} has no git binding, so no run credential can be minted for it`,
      };
    }
    const deployKey = git.deployKeyRunCredential;
    if (deployKey !== undefined) {
      // TD-028 decision 13b item 7: a deploy key with write access cannot be narrowed to `read`, so
      // a shadow task gets **no** credential (rule 18) — exactly as decision 13 item 4 says.
      if (request.mode === 'shadow') {
        return {
          kind: 'unavailable',
          reason: `a shadow task is never given the SSH deploy key of the git integration ${git.ref.integrationId}: it can push and cannot be narrowed to the read scope Q98 (a) admits (TD-028 decision 13b)`,
        };
      }
      const refusal = deployKeyRefusal(deployKey);
      if (refusal !== null || deployKey.route === null) {
        throw new StaticRunCredentialRefusedError(
          git.ref.integrationId,
          `the git integration ${git.ref.integrationId} (${git.ref.provider}) declares an SSH deploy key this platform will not give run ${request.runId}: ${refusal ?? 'the provider has no SSH route for its host'}. Nothing else is sent instead (TD-028 decision 13b)`,
        );
      }
      return {
        kind: 'deploy_key',
        credential: {
          privateKey: deployKey.privateKey,
          publicKey: deployKey.publicKey,
          route: deployKey.route,
          scope: 'push',
        },
        ref: git.ref,
      };
    }
    const fixed = git.staticRunCredential;
    if (fixed !== undefined) {
      // TD-028 decision 13 item 4: push-capable and impossible to narrow to the `read` Q98 (a)
      // admits, so a shadow task gets **no** credential (rule 18) — never the static one.
      if (request.mode === 'shadow') {
        return {
          kind: 'unavailable',
          reason: `a shadow task is never given the static run credential of the git integration ${git.ref.integrationId}: it is push-capable and cannot be narrowed to the read scope Q98 (a) admits (TD-028 decision 13)`,
        };
      }
      const refusal =
        staticCredentialRefusal(fixed, liveness.now?.() ?? null) ??
        (fixed.owner === 'operator'
          ? await operatorTokenProtectionRefusal(integrations, git, request)
          : null);
      if (refusal !== null) {
        throw new StaticRunCredentialRefusedError(
          git.ref.integrationId,
          `the git integration ${git.ref.integrationId} (${git.ref.provider}) declares a static run credential this platform will not give run ${request.runId}: ${refusal}. Nothing else is sent instead (TD-028 decision 13)`,
        );
      }
      return {
        kind: 'static',
        credential: {
          username: fixed.username,
          value: fixed.value,
          scope: 'push',
          expiresAt: fixed.expiresAt as string,
        },
        ref: git.ref,
      };
    }
    if (!git.port.capabilities().credentialMinting) {
      return {
        kind: 'unavailable',
        reason:
          `the git binding ${git.ref.integrationId} (${git.ref.provider}) cannot give run ${request.runId} a credential: ` +
          `minting is off${hintClause(git.mintingHints?.enable)} and no static run credential is configured${hintClause(git.mintingHints?.static)}. ` +
          'The binding’s own token is never sent instead (TD-028 decisions 6 and 13)',
      };
    }
    assertOutsideTransaction('the provider mutation "mint_credential"');
    const readScoped = request.scope === 'read';
    const outcome = await integrations.executor.execute<MintedRunCredential | null>({
      integration: git.ref,
      action: 'mint_credential',
      payload: {
        project: git.project,
        scope: request.scope,
        ttl_seconds: request.ttlSeconds,
        run_id: request.runId,
        task_mode: request.mode,
      },
      mutating: true,
      mode: request.mode,
      projectId: request.projectId,
      taskId: request.taskId,
      perform: async () =>
        git.port.mintCredential({
          project: git.project,
          scope: request.scope,
          ...(readScoped ? {} : { branchPatterns: [...request.branchPatterns] }),
          ttlSeconds: request.ttlSeconds,
        }),
      shadowResult: () => null,
      describeResult: (minted) =>
        minted === null
          ? null
          : { scope: minted.scope, expires_at: minted.expiresAt, revoke_id: minted.revokeId },
      // WP-80 (TD-012's M5 amendment): the value's non-secret shape, written beside this row in its
      // transaction, so every process can redact a value only this one holds.
      credentialShape: (minted) =>
        minted === null ? null : { shape: minted.shape, expiresAt: minted.expiresAt },
      ...(readScoped ? { shadowCarveOut: SHADOW_RUN_CREDENTIAL_CARVE_OUT } : {}),
    });
    const minted = outcome.result;
    if (minted === null) {
      return {
        kind: 'unavailable',
        reason: `a shadow task is never given a ${request.scope} credential (Q98 (a) admits only a read-scoped one)`,
      };
    }
    /**
     * **Revoked before a refusal is thrown** (WP-76 review round 1): the provider has already
     * created the token, and a refusal that left it would leave a live credential nothing holds, in
     * no redaction registry, until its expiry. The revocation runs through the adapter that just
     * minted — which still holds the account's decrypted credential even when the integration's
     * `secrets` rows are gone (WP-114, backlog 386) — and a revocation that fails is named.
     */
    const revokeInHand = async (afterFailure: string): Promise<string> => {
      const minting = mintingIntegrationOf(integrations) as MintingIntegration;
      return runCredentialRevocations(minting)
        .revoke(runCredentialHandle(minted, git.ref), request)
        .then(
          () => 'it was revoked',
          (error: unknown) =>
            `its revocation failed (${describeRevokeFailure(error, minted.value)}), so it is live until ${afterFailure}`,
        );
    };
    const refusal = mintRefusal(minted, request, git.mintingHints);
    if (refusal !== null) {
      throw new Error(
        `the git binding ${git.ref.integrationId} minted a credential this platform will not use: ${refusal}; ${await revokeInHand(`the recovery pass revokes it from the audit row (PROGRESS backlog 155) or it expires at ${minted.expiresAt}`)}`,
      );
    }
    // WP-114, backlog 386: the integration was retired while the mint's call was open. Read after
    // the record committed ({@link MintingIntegrationLiveness} says why that order is sound).
    if (await liveness.isRetired(git.ref.integrationId)) {
      throw new RunCredentialMintRetiredError(
        git.ref.integrationId,
        `the git integration ${git.ref.integrationId} was retired while run ${request.runId}'s credential was being minted, so the run is not started and the credential is not used; ${await revokeInHand(`it expires at ${minted.expiresAt}, because a retired integration has no credential left to revoke it with — delete it at the provider`)}`,
      );
    }
    return {
      kind: 'minted',
      credential: minted,
      ref: git.ref,
      handle: runCredentialHandle(minted, git.ref),
    };
  },
});

/** ` (<hint>)` when the provider declared one, and nothing when it did not (WP-107). */
const hintClause = (hint: string | undefined): string =>
  hint === undefined || hint.trim() === '' ? '' : ` (${hint})`;

/**
 * Why a minted value is not used, or `null`.
 *
 * Standing rule 18: an empty credential is not a credential, and a short one cannot be kept out of a
 * transcript (`exactSecretRedactor` refuses it). A scope the provider changed is a provider defect
 * that would hand a read-only run a push token. And since WP-80 a value that does not have the
 * shape it came with cannot be redacted by any process but this one (TD-012's M5 amendment), so it
 * is refused the same way. How to fix that is the **provider's** sentence (`hints.shape`, declared
 * on its registration — GitLab's names its `token_prefix`), never this ring's (WP-107, PROGRESS
 * backlog 278).
 */
const mintRefusal = (
  minted: MintedRunCredential,
  request: RunCredentialRequest,
  hints: CredentialMintingHints | undefined,
): string | null => {
  if (minted.scope !== request.scope) {
    return `asked for ${request.scope}, got ${minted.scope}`;
  }
  if (minted.value.trim().length < MIN_SECRET_LENGTH) {
    return `its value is shorter than ${MIN_SECRET_LENGTH} characters, so it could not be redacted`;
  }
  if (!hasMintedCredentialShape(minted.shape, minted.value)) {
    return (
      `its value does not have the shape the provider declared (prefix "${minted.shape.prefix}", ` +
      `${minted.shape.charset} characters, ${minted.shape.length} long), so no process but this one ` +
      `could redact it (TD-012, WP-80)${hints === undefined || hints.shape.trim() === '' ? '' : ` — ${hints.shape}`}`
    );
  }
  return null;
};

/**
 * Revoking a run credential **through the integration that minted it** — TD-028 decision 10 (M5
 * amendment), WP-80, PROGRESS backlog 156 half 3.
 *
 * Both the teardown revoke and the recovery revoke are built from the minting `integrations.id`
 * ({@link PipelineIntegrationsPort.forMintingIntegration}), bound or not: a project unbound from —
 * or re-bound away from — that integration still has its token revoked on the host that issued it,
 * with one audit row under that integration's id. What WP-73b's refusal was right about stands and
 * is now structural: `minting` must **be** the integration that minted, and anything else is
 * refused before the executor, so no row is ever written under an integration that did not mint.
 */
export const runCredentialRevocations = (minting: MintingIntegration) => {
  const assertMinter = (integrationId: Id, runId: Id, expiresAt: string): void => {
    if (minting.ref.integrationId !== integrationId) {
      throw new Error(
        `run ${runId}'s credential was minted through the git integration ${integrationId}, and a revocation was built from ${minting.ref.integrationId}; its address is never sent to an integration that did not mint it, so it lives until ${expiresAt} (PROGRESS backlog 156)`,
      );
    }
  };
  return {
    /**
     * Revokes a credential `mint` returned. Called **once** per credential by its owner (decision
     * 5): a per-call adapter has no memory of an earlier revoke, so a second call is `not_found`
     * rather than a no-op (GitLab divergence 6).
     */
    revoke: async (
      credential: RunCredentialHandle,
      context: Pick<RunCredentialRequest, 'runId' | 'taskId' | 'projectId' | 'mode'>,
    ): Promise<void> => {
      assertMinter(credential.integrationId, context.runId, credential.expiresAt);
      assertOutsideTransaction('the provider mutation "revoke_credential"');
      const outcome = await minting.executor.execute<boolean>({
        integration: minting.ref,
        action: 'revoke_credential',
        payload: {
          scope: credential.scope,
          revoke_id: credential.revokeId,
          run_id: context.runId,
          task_mode: context.mode,
        },
        mutating: true,
        mode: context.mode,
        projectId: context.projectId,
        taskId: context.taskId,
        perform: async () => {
          await minting.port.revokeCredential({ revokeId: credential.revokeId });
          return true;
        },
        // Reached only if the carve-out below stopped applying: `false` is "nothing was revoked",
        // and the check after this call turns it into a failure rather than a success.
        shadowResult: () => false,
        describeResult: (revoked) => ({ revoked, revoke_id: credential.revokeId }),
        // **Every** revoke declares it, whatever the scope (WP-76 review round 2): revoking only
        // removes access, so a shadow task's revoke is never suppressed — including the `push`
        // token a provider handed a shadow task that asked for `read`.
        shadowCarveOut: SHADOW_RUN_CREDENTIAL_CARVE_OUT,
      });
      // A revoke is a success only when the provider was asked and answered: `would_have` or a
      // `false` result means the token is still live, and saying "revoked" there is the defect
      // review round 2 measured (0 provider revocations, a refusal that read "it was revoked").
      if (outcome.status !== 'ok' || outcome.result !== true) {
        throw new Error(
          `run ${context.runId}'s credential was not revoked (the executor answered ${outcome.status}); it is live until the recovery pass revokes it from the audit row (PROGRESS backlog 155) or it expires at ${credential.expiresAt}`,
        );
      }
    },

    /**
     * **The recovery revoke** (WP-77, PROGRESS backlog 155): a credential whose runner died between
     * mint and revoke, or whose teardown revoke failed, revoked from the **address** the mint's
     * audit row recorded — never from a credential rebuilt with an invented value (standing rule 18).
     *
     * Three things differ from {@link revoke}, and each is the point:
     *
     *  - **the payload says `origin: 'recovery'`**, which is what bounds it: the finding query
     *    excludes a `revoke_id` with any such row, whatever it says, so each address gets one
     *    attempt, bounded by the audit row that attempt writes;
     *  - **`not_found` is an answer, recorded as `unconfirmed`, never as revoked.** The adapter that
     *    reaches this is by construction one that did not mint the handle, so a provider's "no such
     *    token" cannot tell *already revoked* from *never existed here* (the port's docblock). The
     *    row is `ok` — the provider was asked and answered — with `revoked: false` and
     *    `confirmation: 'unconfirmed'`, which the "revoked means `ok` with `revoked: true`" reading
     *    every other reader applies does not count as a revocation. Every other failure throws,
     *    after the executor wrote a `failed` row;
     *  - **a shadow task's revoke is performed** under the same Q98 (a) carve-out the mint used, and
     *    anything but an `ok` outcome — `would_have` above all — throws: a recovery that the shadow
     *    guard swallowed would read as the one attempt spent on a token still live.
     */
    recover: async (credential: RecoverableRunCredential): Promise<RunCredentialRecovery> => {
      assertMinter(credential.integrationId, credential.runId, credential.expiresAt);
      assertOutsideTransaction('the provider mutation "revoke_credential"');
      const outcome = await minting.executor.execute<RunCredentialRecovery | null>({
        integration: minting.ref,
        action: 'revoke_credential',
        payload: {
          scope: credential.scope,
          revoke_id: credential.revokeId,
          run_id: credential.runId,
          task_mode: credential.mode,
          origin: RUN_CREDENTIAL_RECOVERY_ORIGIN,
        },
        mutating: true,
        mode: credential.mode,
        projectId: credential.projectId,
        taskId: credential.taskId,
        perform: async () => {
          try {
            await minting.port.revokeCredential({ revokeId: credential.revokeId });
            return 'revoked';
          } catch (error) {
            if (error instanceof IntegrationError && error.code === 'not_found') {
              return 'unconfirmed';
            }
            throw error;
          }
        },
        shadowResult: () => null,
        describeResult: (result) => ({
          revoked: result === 'revoked',
          confirmation: result ?? 'not_performed',
          revoke_id: credential.revokeId,
        }),
        shadowCarveOut: SHADOW_RUN_CREDENTIAL_CARVE_OUT,
      });
      if (outcome.status !== 'ok' || outcome.result === null) {
        throw new Error(
          `run ${credential.runId}'s credential was not revoked by the recovery pass (the executor answered ${outcome.status}); it is live until ${credential.expiresAt}`,
        );
      }
      return outcome.result;
    },
  };
};

/**
 * What {@link runCredentialRevocations}' `revoke` reads of a credential: its address, the two facts
 * the audit row and a failure message name, and the integration that minted it (WP-73b, backlog 156
 * — the revocation is built from it since WP-80 and refuses any other). Never the value (WP-77).
 */
export type RunCredentialHandle = Pick<MintedCredential, 'revokeId' | 'scope' | 'expiresAt'> & {
  readonly integrationId: Id;
};

/** The handle of a credential minted through `ref` — the only way one is built. */
export const runCredentialHandle = (
  minted: Pick<MintedCredential, 'revokeId' | 'scope' | 'expiresAt'>,
  ref: IntegrationRef,
): RunCredentialHandle => ({
  revokeId: minted.revokeId,
  scope: minted.scope,
  expiresAt: minted.expiresAt,
  integrationId: ref.integrationId,
});

/** The payload marker every recovery revoke carries, and the finding query's bound (WP-77). */
export const RUN_CREDENTIAL_RECOVERY_ORIGIN = 'recovery' as const;

/**
 * A credential nothing confirmed revoked, as the recovery row reads it off the mint's audit row.
 *
 * Every field is the platform's own — ids, the task's mode, the binding that minted, and the three
 * facts `describeResult` recorded at the mint — so nothing here is a secret or needs one.
 */
export interface RecoverableRunCredential {
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly mode: TaskMode;
  /**
   * The git integration the mint went through (`integration_actions.integration_id`) — which need
   * not be a binding of the project any more: since WP-80 the revoke is built from it, bound or not
   * (TD-028 decision 10).
   */
  readonly integrationId: Id;
  readonly revokeId: string;
  readonly scope: CredentialScope;
  readonly expiresAt: string;
}

/**
 * `revoked` — the provider deleted it. `unconfirmed` — the provider says it has no such token,
 * which from an adapter that did not mint it cannot be told from "never existed here".
 */
export type RunCredentialRecovery = 'revoked' | 'unconfirmed';
