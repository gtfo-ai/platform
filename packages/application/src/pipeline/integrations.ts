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
  CommitAction,
  CommitRef,
  Discussion,
  GitProviderPort,
  MergeRequest,
  MergeRequestRefInput,
  PipelineStatus,
} from '../ports/integrations/git-provider.js';
import {
  commitFilesRequestSchema,
  mergeRequestDraftSchema,
} from '../ports/integrations/git-provider.js';
import type {
  CommentRef,
  TaskManagementPort,
  Ticket,
  TicketRefInput,
  TransitionResult,
} from '../ports/integrations/task-management.js';

export interface GitBinding {
  readonly port: GitProviderPort;
  readonly ref: IntegrationRef;
  /** The repository path the project is bound to (`acme/api`). */
  readonly project: string;
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

export interface PipelineIntegrations {
  readonly executor: IntegrationActionExecutor;
  readonly git: GitBinding | null;
  readonly taskManagement: TaskManagementBinding | null;
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
 * `encode`/`decode` are casts and not a `parse`, matching the one other plan in the repository
 * (`slack/digest.ts`).
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

export const ticketWrites = (integrations: PipelineIntegrations) => ({
  /** BD-023's sticky comment: one per task, edited in place. */
  upsertWorkpad: async (
    ticket: TicketRefInput,
    markerId: string,
    markdown: string,
    context: TicketWriteContext,
  ): Promise<CommentRef | null> => {
    const binding = integrations.taskManagement;
    if (binding === null) {
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

  /** product/04: "Map stage states to ticket statuses per project" (`status_mapping`). */
  transition: async (
    ticket: TicketRefInput,
    status: string,
    context: TicketWriteContext,
  ): Promise<void> => {
    const binding = integrations.taskManagement;
    if (binding === null) {
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
