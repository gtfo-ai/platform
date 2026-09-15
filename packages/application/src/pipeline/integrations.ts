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
import type { Id, JsonObject, TaskMode } from '@platform/contracts';
import { assertOutsideTransaction } from '../events/open-transaction.js';
import type {
  IdempotencyPlan,
  IntegrationActionExecutor,
} from '../integrations/action-executor.js';
import type { InjectedSecret } from '../integrations/redaction.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { IntegrationRef } from '../ports/integrations/common.js';
import type {
  CommunicationPort,
  DigestItem,
  MessageBody,
  MessageRef,
  ThreadRef,
} from '../ports/integrations/communication.js';
import type {
  CodeownersRules,
  CommitAction,
  CommitRef,
  Discussion,
  FileDiff,
  GitProviderPort,
  MergedMergeRequest,
  MergeRequest,
  MergeRequestRefInput,
  PipelineStatus,
  RepositoryCommit,
} from '../ports/integrations/git-provider.js';
import {
  commitFilesRequestSchema,
  mergeRequestDraftSchema,
} from '../ports/integrations/git-provider.js';
import type {
  CommentRef,
  TaskManagementPort,
  Ticket,
  TicketMatch,
  TicketMatchRule,
  TicketRefInput,
  TransitionResult,
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
   *    model's words going out to a third party. `artifacts.data` holds them unredacted (PROGRESS
   *    backlog 35, which this work package does not close and does not widen), so the redaction
   *    happens where the text leaves the platform.
   */
  readonly redactor: SecretRedactor;
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
 * Every pipeline call site uses this today, and that is a statement about the build rather than
 * about the design: nothing on the pipeline's path holds a minted credential, because the runner
 * reaches the launcher's broker through a transport that does not exist yet (Q52). The moment one
 * does, the call sites that are inside a run are the ones that stop calling this.
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
}

/** One already-composed set for every project: the unit tier's case, and a single-project instance. */
export const staticPipelineIntegrations = (
  integrations: PipelineIntegrations,
): PipelineIntegrationsPort => ({ forProject: async () => integrations });

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

interface CallContext {
  readonly projectId: Id;
  readonly taskId: Id | null;
}

/** A read: performed in every mode, because a shadow task needs its context (technical/06). */
const read = async <T>(
  integrations: PipelineIntegrations,
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
  integrations: PipelineIntegrations,
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
 * `tasks.mr_ref` records what the developer stage reported — the iid, the URL, the branch, the head
 * commit — and deliberately not which account it is on: learning that means resolving the project's
 * bindings, and the saga learns about a merge request from inside its handler's transaction, where
 * resolving a binding is a nested pool borrow and a credential decryption (WP-15d). So the provider
 * and the repository path are filled in **here**, where the binding is already in hand and is the
 * one in force rather than the one that was in force when the row was written. A ref that carries
 * its own path (an older row, or an event payload that named one) keeps it.
 */
const addressed = (git: GitBinding, ref: MergeRequestRefInput): MergeRequestRefInput => ({
  ...ref,
  provider: ref.provider ?? git.ref.provider,
  project_path: ref.project_path ?? git.project,
});

export const gitReads = (integrations: PipelineIntegrations) => ({
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

  defaultBranch: async (
    context: CallContext,
  ): Promise<{ readonly branch: string; readonly sha: string } | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    return read(
      integrations,
      git.ref,
      'get_default_branch_head',
      { project: git.project },
      context,
      async () => git.port.getDefaultBranchHead(git.project),
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
export const ticketReads = (integrations: PipelineIntegrations) => ({
  /**
   * Tickets a rule matches, since an instant — WP-35's closed-ticket half.
   *
   * `matchTickets` is the port method intake already uses to find *new* tickets for a label; this
   * is the same read asked a different question, which is why it is a member here rather than a
   * second mechanism. The rule is the caller's, because what "closed" means is the project's own
   * status mapping and not a platform constant (`shadow/batch.ts` states why the platform has no
   * definition of its own).
   */
  matches: async (
    rule: TicketMatchRule,
    options: { readonly since: string; readonly limit: number },
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
      async () => binding.port.matchTickets(rule, { since: options.since, limit: options.limit }),
    );
  },

  ticket: async (ticket: TicketRefInput, context: CallContext): Promise<Ticket | null> => {
    const binding = integrations.taskManagement;
    if (binding === null) {
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
   * a run: this job holds no run-scoped secret set. On this build a lint run mints none, for the
   * same measured reason a review-only run does not (`TOOLS_BY_ROLE.product_manager` is
   * `['Read','Glob','Grep']`, so `runIsReadOnly` is true and `RunCredentialBroker.issue` answers
   * `null` without calling the source).
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

  /** product/04: "Map stage states to ticket statuses per project" (`status_mapping`). */
  transition: async (
    ticket: TicketRefInput,
    status: string,
    context: TicketWriteContext,
  ): Promise<void> => {
    const binding = integrations.taskManagement;
    if (binding === null || !namesAProviderTicket(ticket)) {
      return;
    }
    await mutate(
      integrations,
      binding.ref,
      'transition_ticket',
      { ticket_key: ticket.key, to: status },
      context,
      async () => binding.port.transition(ticket, status),
      () => ({ changed: false, from: status, to: status }),
      (result) => ({ changed: result.changed, from: result.from, to: result.to }),
      context.causeEventId === null || context.taskId === null
        ? undefined
        : replayable<TransitionResult>(
            `transition_ticket:${context.taskId}:${context.causeEventId}`,
          ),
    );
  },
});

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
    },
    context: CallContext,
  ): Promise<MergeRequest | null> => {
    const git = integrations.git;
    if (git === null) {
      return null;
    }
    // Parsed here too, and for the same reason: the description carries the same two untrusted
    // values the commit message does. **It does not cover the other caller** — the developer's
    // `open_mr` platform tool will build its own draft, and that one is a named refusal today
    // (`apps/server/src/platform-tools.ts`); whoever builds it inherits this obligation.
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
      labels: ['agentic', 'knowledge'],
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
 * **`mode` is the task's**, unlike `knowledgeWrites` — and on this build that is always `normal`,
 * which is a statement about review-only mode rather than about this call. `runReviewOnlyCheck`
 * creates every review task with `mode: 'normal'` (`review-only.ts` § "the task shape": `tasks.mode`
 * stays the two-valued shadow switch and `review_only` is a **run** mode), and nothing else creates
 * one — so **review-only mode has no shadow mode**, the executor's `would_have` branch is
 * unreachable from here, and the round-1 sentence claiming a shadow review "records a `would_have`
 * row and posts nothing" described a path that does not exist. It is measured rather than asserted
 * by reading: `packages/application/src/pipeline/review-only.test.ts` › "creates the review task in
 * `normal` mode, so every thread it posts is a real one" reads the stored task and the audit rows the
 * review left. Passing the task's mode is still the right shape —
 * the day a shadow review is decided, the guard is already on the path — but until then what makes a
 * review-only task's writes real is the mode its creator wrote, not this argument.
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
 * **On this build that set is empty for a review, so there is nothing to leak.** The chain is
 * `packages/infrastructure/src/workspace/spec.test.ts` § "is none for a review-only run":
 * `REVIEW_ONLY_TEMPLATE`'s one agent stage is the reviewer's, `TOOLS_BY_ROLE.reviewer` is
 * `['Read','Glob','Grep']`, so `runIsReadOnly` is true, the workspace is read-only, and
 * `RunCredentialBroker.issue` answers `null` **without calling the credential source** (BD-021) —
 * and `apps/launcher` has no other source to mint from (Q52). The residual is therefore narrower
 * than round 1 stated: it is not "a review's threads can carry the run's token", it is "the day a
 * role both mints a credential and posts provider text, this call site will need the run's scope".
 */
export const reviewWrites = (integrations: PipelineIntegrations) => ({
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
      (result) => ({ discussion_id: result.id }),
      replayable<Discussion>(input.idempotencyKey),
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
      replayable<MessageRef>(
        `${chat.ref.provider}:digest:${chat.digestChannel}:${input.day}` +
          (context.mode === 'normal' ? '' : `:${context.mode}`),
      ),
    );
  },
});
