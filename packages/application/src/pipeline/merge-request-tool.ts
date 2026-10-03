/**
 * The developer's `open_mr` and `update_mr_description` (WP-138) — the platform tools that make a
 * code merge request exist at all.
 *
 * Until WP-138 both refused by name (`apps/server/src/platform-tools.ts`), while the developer
 * prompt said *"open a draft merge request"* and `ImplementationNotes` requires `mr` — so the first
 * feature ticket on a real project failed at Implementation. The rulings this module is written to
 * are PROGRESS § "Architect ruling (M8 additions, session 11)" and the plan's WP-138 row:
 *
 *  - **(a) the executor, outside a transaction.** A tool call runs in `stage.execute`'s
 *    no-transaction phase, so it is the *call* half of WP-15d's split by construction; it still asks
 *    {@link assertOutsideTransaction}, reads the task in a short transaction of its own before the
 *    call and records the result in another after it. Every provider call is
 *    `IntegrationActionExecutor`'s (`codeMergeRequestWrites`): audited, rate-limited, idempotent,
 *    and for a **shadow** task recorded `would_have` with no merge request and no `mr_ref`.
 *  - **(b) the model supplies the title and the description, and nothing else.** The source branch
 *    is the task's own (`tasks.branch`, or the domain's `agentic/<key>` before it has one), and a
 *    branch outside `agentic/` is refused; the target is `projects.default_branch`. A branch the
 *    model names in the tool's input is ignored, and the answer says which branches were used.
 *  - **(c) one merge request per task and branch.** The executor's key is
 *    `open_mr:<task id>:<branch>`, and a provider refusal that one is already open is answered by
 *    adopting it only when it is the platform's own (`MergeRequestNotAdoptedError` otherwise).
 *  - **(d) the text is untrusted model output** (BD-022): the title bounded at
 *    {@link MAX_MERGE_REQUEST_TITLE_CHARS} and the description at
 *    `MAX_MERGE_REQUEST_DESCRIPTION_CHARS`, a cut announced in platform text, both redacted with the
 *    run's redactor composed with the binding's (TD-012 both steps), and BD-025 §4's *Requested by*
 *    footer appended as platform text after the redaction. `update_mr_description` addresses only
 *    the task's own merge request.
 *  - **(e) the record is the platform's**: `tasks.recordMergeRequest`, compare-and-set.
 */
import { createHash } from 'node:crypto';
import type { Id, MergeRequestRef, TaskMode } from '@platform/contracts';
import { taskBranchName } from '@platform/domain';
import { assertOutsideTransaction } from '../events/open-transaction.js';
import { composeSecretRedactors, type InjectedSecret } from '../integrations/redaction.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { IntegrationError } from '../ports/integrations/common.js';
import {
  MAX_MERGE_REQUEST_DESCRIPTION_CHARS,
  type MergeRequest,
} from '../ports/integrations/git-provider.js';
import { type Logger, silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  assertPlatformBranch,
  codeMergeRequestWrites,
  integrationsForProject,
  type PipelineIntegrationsPort,
} from './integrations.js';
import type { TaskRepository } from './store.js';

/** GitLab's own title limit is 255 characters; the platform sends no more (ruling (d)). */
export const MAX_MERGE_REQUEST_TITLE_CHARS = 255;

/** What the tool reads about the task, in one short transaction before any provider call. */
export interface MergeRequestToolTask {
  readonly taskId: Id;
  readonly projectId: Id;
  readonly mode: TaskMode;
  readonly ticketKey: string;
  readonly branch: string | null;
  readonly mr: MergeRequestRef | null;
  /** `projects.default_branch` — the only target the platform opens against (ruling (b)). */
  readonly defaultBranch: string;
  /** The requesting person's name for the footer (BD-025 §4), or `null` when nobody is mapped. */
  readonly requestedBy: string | null;
}

export interface MergeRequestToolReader {
  read(tx: Transaction, taskId: Id): Promise<MergeRequestToolTask | null>;
}

export interface MergeRequestToolOptions {
  readonly unitOfWork: UnitOfWork;
  readonly reader: MergeRequestToolReader;
  readonly tasks: Pick<TaskRepository, 'recordMergeRequest'>;
  readonly integrations: PipelineIntegrationsPort;
  /**
   * The credentials a run is given that no binding knows — the model credential (Q55). The run's
   * own redactor ({@link MergeRequestToolContext.redactor}) carries them too; the binding is
   * resolved with them as well, so the adapter's own redaction of what it sends has them.
   */
  readonly runScopedSecrets: () => readonly InjectedSecret[];
  readonly logger?: Logger;
}

/** The run a call comes from — never anything the model wrote. */
export interface MergeRequestToolContext {
  readonly taskId: Id;
  readonly projectId: Id;
  /**
   * The run's TD-012 step-1 redactor. Required **at the call** rather than by the type, because it
   * rides `PlatformToolContext`, whose other implementations have no use for it; absent, the tool
   * refuses rather than sending a model's words unredacted (standing rule 31).
   */
  readonly redactor?: SecretRedactor;
}

/** Thrown when the tool refuses to act. The message reaches the model and the run log. */
export class MergeRequestToolRefusedError extends Error {
  override readonly name = 'MergeRequestToolRefusedError';
}

const footerOf = (task: MergeRequestToolTask): string =>
  [
    '',
    '---',
    `Opened by the agentic platform for ${task.ticketKey}${
      task.requestedBy === null ? '.' : `. Requested by ${task.requestedBy}.`
    }`,
  ].join('\n');

/**
 * Room a provider's draft marker takes in the title — GitLab's adapter prefixes `Draft: ` (seven
 * characters) for a draft, so a draft's own title is bounded that much tighter (review round 1).
 */
export const DRAFT_TITLE_PREFIX_CHARS = 'Draft: '.length;

/** One line, bounded, the cut announced — a title is never multi-line on any provider. */
export const boundTitle = (title: string, draft = false): string => {
  const max = MAX_MERGE_REQUEST_TITLE_CHARS - (draft ? DRAFT_TITLE_PREFIX_CHARS : 0);
  const line = title.replaceAll(/\s+/g, ' ').trim();
  if (line.length <= max) {
    return line;
  }
  return `${line.slice(0, max - 1).trimEnd()}…`;
};

/**
 * The description as it is sent: the model's text redacted, cut so that the platform's cut notice
 * and footer still fit under the provider bound, then the footer. The cut is announced in platform
 * text rather than silently applied.
 */
export const composeDescription = (
  redacted: string,
  task: MergeRequestToolTask,
): { readonly text: string; readonly truncated: boolean } => {
  const footer = footerOf(task);
  const notice = (chars: number) =>
    `\n\n_[The platform cut this description at ${chars} characters.]_`;
  const room = MAX_MERGE_REQUEST_DESCRIPTION_CHARS - footer.length;
  if (redacted.length <= room) {
    return { text: `${redacted}${footer}`, truncated: false };
  }
  const keep = room - notice(redacted.length).length;
  return {
    text: `${redacted.slice(0, keep)}${notice(redacted.length)}${footer}`,
    truncated: true,
  };
};

const refOf = (
  mergeRequest: MergeRequest,
  provider: string,
  projectPath: string,
  branch: string,
): MergeRequestRef => ({
  provider,
  project_path: projectPath,
  iid: mergeRequest.ref.iid,
  url: mergeRequest.web_url,
  branch,
  head_sha: mergeRequest.head_sha,
});

/**
 * A provider refusal other than the duplicate (which `codeMergeRequestWrites.open` answers by
 * adoption), re-thrown with the two branches named. It states the requirement — the source branch
 * must exist on the provider — and the provider's own words, and **does not diagnose**: a GitLab
 * 422 is any validation failure (a title, a missing branch, a protected target), so telling the
 * model to "push first" would send it after the wrong cause (review round 1).
 */
const openOrExplain = async <T>(
  branch: string,
  target: string,
  open: () => Promise<T>,
): Promise<T> => {
  try {
    return await open();
  } catch (error) {
    if (!(error instanceof IntegrationError) || error.code !== 'invalid_request') {
      throw error;
    }
    throw new MergeRequestToolRefusedError(
      `open_mr: the provider refused a merge request from ${branch} into ${target}: ${error.message}. The merge request is opened from ${branch}, which must exist on the provider with your commits; the provider's message above says what it refused.`,
    );
  }
};

export const createMergeRequestTools = (options: MergeRequestToolOptions) => {
  const logger = options.logger ?? silentLogger;

  const readTask = async (
    context: MergeRequestToolContext,
    tool: string,
  ): Promise<MergeRequestToolTask> => {
    assertOutsideTransaction(`the ${tool} platform tool`);
    if (context.redactor === undefined) {
      throw new MergeRequestToolRefusedError(
        `${tool} needs the run's redactor and this call carries none, so the model's text is not sent`,
      );
    }
    const task = await options.unitOfWork.transaction(async (scope) =>
      options.reader.read(scope.tx, context.taskId),
    );
    if (task === null || task.projectId !== context.projectId) {
      throw new MergeRequestToolRefusedError(
        `${tool}: the run's task ${context.taskId} is not found`,
      );
    }
    return task;
  };

  const bindingOf = async (task: MergeRequestToolTask, tool: string) => {
    const integrations = await integrationsForProject(options.integrations, task.projectId, {
      runScopedSecrets: options.runScopedSecrets(),
    });
    const git = integrations.git;
    if (git === null) {
      throw new MergeRequestToolRefusedError(
        `${tool}: the project has no git binding, so there is no provider to open a merge request on`,
      );
    }
    return { integrations, git };
  };

  return {
    open: async (
      input: { readonly title: string; readonly description: string; readonly draft?: boolean },
      context: MergeRequestToolContext,
    ) => {
      const task = await readTask(context, 'open_mr');
      const branch = task.branch ?? taskBranchName(task.ticketKey);
      assertPlatformBranch(branch);
      const { integrations, git } = await bindingOf(task, 'open_mr');
      const redactor = composeSecretRedactors(context.redactor as SecretRedactor, git.redactor);
      const draft = input.draft ?? true;
      const title = boundTitle(redactor.redactText(input.title).value, draft);
      if (title.length === 0) {
        throw new MergeRequestToolRefusedError('open_mr: the title is empty once it is one line');
      }
      const description = composeDescription(redactor.redactText(input.description).value, task);
      const opening = await openOrExplain(branch, task.defaultBranch, () =>
        codeMergeRequestWrites(integrations).open(
          {
            branch,
            target: task.defaultBranch,
            title,
            description: description.text,
            draft,
            idempotencyKey: `open_mr:${task.taskId}:${branch}`,
          },
          { projectId: task.projectId, taskId: task.taskId, mode: task.mode },
        ),
      );
      if (opening === null) {
        throw new MergeRequestToolRefusedError('open_mr: the project has no git binding');
      }
      if (opening.kind === 'shadow') {
        return {
          status: 'shadow',
          detail:
            'This task runs in shadow mode: the platform recorded the merge request it would have opened and opened none. Report no merge request URL as a real one.',
          source_branch: branch,
          target_branch: task.defaultBranch,
        };
      }
      const ref = refOf(opening.mergeRequest, git.ref.provider, git.project, branch);
      const recorded = await options.unitOfWork.transaction(async (scope) =>
        options.tasks.recordMergeRequest(scope.tx, task.taskId, ref),
      );
      if (recorded.kind === 'refused') {
        logger.error(
          {
            task_id: task.taskId,
            iid: ref.iid,
            recorded_iid: recorded.recorded?.iid ?? null,
          },
          'open_mr: the provider answered a merge request the task record refused',
        );
        throw new MergeRequestToolRefusedError(
          `open_mr: merge request !${ref.iid} is on the provider, but this task already records ${
            recorded.recorded === null ? 'another branch' : `!${recorded.recorded.iid}`
          }, so it was not recorded`,
        );
      }
      return {
        status: opening.kind,
        iid: ref.iid,
        url: ref.url,
        source_branch: branch,
        target_branch: task.defaultBranch,
        draft: opening.mergeRequest.draft,
        description_truncated: description.truncated,
      };
    },

    updateDescription: async (
      input: { readonly description: string },
      context: MergeRequestToolContext,
    ) => {
      const task = await readTask(context, 'update_mr_description');
      if (task.mr === null) {
        throw new MergeRequestToolRefusedError(
          'update_mr_description: this task has no merge request yet — call open_mr first',
        );
      }
      const { integrations, git } = await bindingOf(task, 'update_mr_description');
      const redactor = composeSecretRedactors(context.redactor as SecretRedactor, git.redactor);
      const description = composeDescription(redactor.redactText(input.description).value, task);
      // A digest of the text the platform composed, never the text: a key is an identity and the
      // executor refuses one that would need redacting. The same description sent twice is one write.
      const digest = createHash('sha256').update(description.text).digest('hex').slice(0, 32);
      const updated = await codeMergeRequestWrites(integrations).describe(
        {
          ref: task.mr,
          description: description.text,
          idempotencyKey: `update_mr_description:${task.taskId}:${task.mr.iid}:${digest}`,
        },
        { projectId: task.projectId, taskId: task.taskId, mode: task.mode },
      );
      if (task.mode === 'shadow' || updated === null) {
        return { status: 'shadow', iid: task.mr.iid };
      }
      return {
        status: 'updated',
        iid: updated.ref.iid,
        url: updated.web_url,
        description_truncated: description.truncated,
      };
    },
  };
};

export type MergeRequestTools = ReturnType<typeof createMergeRequestTools>;
