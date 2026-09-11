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
 */
import type { Id, JsonObject, TaskMode } from '@platform/contracts';
import type { IntegrationActionExecutor } from '../integrations/action-executor.js';
import type { InjectedSecret } from '../integrations/redaction.js';
import type { IntegrationRef } from '../ports/integrations/common.js';
import type {
  Discussion,
  GitProviderPort,
  MergeRequest,
  MergeRequestRefInput,
  PipelineStatus,
} from '../ports/integrations/git-provider.js';
import type {
  CommentRef,
  TaskManagementPort,
  TicketRefInput,
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
): Promise<T> => {
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
  });
  return outcome.result;
};

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
      async () => git.port.getMergeRequest(ref),
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
      async () => git.port.listDiscussions(ref),
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

export const ticketWrites = (integrations: PipelineIntegrations) => ({
  /** BD-023's sticky comment: one per task, edited in place. */
  upsertWorkpad: async (
    ticket: TicketRefInput,
    markerId: string,
    markdown: string,
    context: CallContext & { readonly mode: TaskMode },
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
    );
  },

  /** product/04: "Map stage states to ticket statuses per project" (`status_mapping`). */
  transition: async (
    ticket: TicketRefInput,
    status: string,
    context: CallContext & { readonly mode: TaskMode },
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
    );
  },
});
