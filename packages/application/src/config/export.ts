/**
 * The configuration export — `POST /api/projects/:project_id/config/export` (WP-63 criterion 1,
 * product/06 § "Step 5", PROGRESS backlog 44).
 *
 * > *"One MR to the repository adding `.agentic/` with the accepted content … plus a one-line
 * > pointer in `CLAUDE.md` to the KB index (proposed)"*
 *
 * ## Through the knowledge apply path, and never onto the default branch
 *
 * The commit and the merge request are WP-18b's two writes (`knowledgeWrites`) — the same
 * `IntegrationActionExecutor` door, the same shadow guard, idempotency record, rate-limit budget
 * and audit row — on a branch of the platform's `agentic/*` namespace, opened as a merge request a
 * human merges (BD-007). **Q94 (b): no direct commit, ever**, whatever the project allows: the file
 * this writes governs every later run (BD-025 §1 reads it from the default branch), and a direct
 * commit is the one write that changes those rules with no review in between — the argument
 * `knowledge/apply.ts` makes for knowledge pages, one directory over. product/06's *"(or a direct
 * commit if the project allows)"* is amended rather than implemented.
 *
 * ## The shape: read, call — and no transaction at all
 *
 * The export is a human's command and runs in the request that asked for it, so the person who
 * pressed the button is told the merge request's address or the reason there is none. It reads the
 * default branch first (the mirror, outside any transaction), then makes the two provider calls,
 * each of which refuses to run inside a transaction (`integrationsForProject`, the executor) — the
 * `pipeline.outbound` rule, *decide, then call with nothing open*, without a queue between the two:
 * the route's own audit row is written **after** the calls have answered.
 *
 * ## Create or update is read, not guessed
 *
 * The git provider refuses a `create` over a file that exists and an `update` of one that does not,
 * so which one is sent comes from the default branch at the moment of the export
 * ({@link RepositoryFileSource}), and a mirror that cannot be read is a refusal rather than a guess
 * that would fail at the provider. A file that already says exactly what the export would write is
 * left out of the commit, and an export that would change nothing opens nothing.
 */
import type { Id } from '@platform/contracts';
import {
  integrationsForProject,
  knowledgeWrites,
  noRunScopedSecrets,
  type PipelineIntegrationsPort,
} from '../pipeline/integrations.js';
import type { CommitAction } from '../ports/integrations/git-provider.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import {
  CLAUDE_MD_PATH,
  REPOSITORY_CONFIG_PATH,
  type RepositoryFileEntry,
  type RepositoryFileSource,
} from './repository-config.js';

export interface ConfigExportProject {
  readonly defaultBranch: string;
  /** `projects.knowledge_dir` — what the `CLAUDE.md` pointer names. */
  readonly knowledgeDir: string;
}

export interface ConfigExportOptions {
  readonly integrations: PipelineIntegrationsPort;
  readonly files: RepositoryFileSource;
  readonly logger?: Logger;
}

export interface ConfigExportRequest {
  readonly projectId: Id;
  readonly project: ConfigExportProject;
  /** `projects.config_hash` of the document being exported. Hex, from `configHashOf`. */
  readonly configHash: string;
  /** The rendered `.agentic/config.yml` — the codec's output, parsed back by the caller's test. */
  readonly content: string;
  /** A hex discriminator of this export — the branch's suffix and the replay's identity. */
  readonly exportId: string;
  /** BD-025 §4: the human the bot acts for, as the uuid the audit row names. */
  readonly requestedByUserId: Id;
}

export type ConfigExportReport =
  | {
      readonly status: 'exported';
      readonly branch: string;
      readonly commitSha: string;
      readonly mergeRequestUrl: string | null;
      /** The paths the commit carried, in order. */
      readonly paths: readonly string[];
      /** Platform text for what the export left out and why — the pointer, today. */
      readonly notes: readonly string[];
    }
  /** The default branch already says exactly this. Nothing was committed or opened. */
  | { readonly status: 'unchanged'; readonly reason: string }
  /** No git binding, no mirror, or a file the platform will not overwrite. Nothing was sent. */
  | { readonly status: 'unavailable'; readonly reason: string };

const HEX = /^[0-9a-f]{8,64}$/;

/**
 * `agentic/config/<hash12>-<export id>` — inside BD-025's `agentic/*` namespace.
 *
 * Both halves are hex, so the name can never need escaping and the provider idempotency keys built
 * from it can never need redacting (standing rule 70). The hash says *what* is exported; the export
 * id says *which press of the button*: the same key replays onto the same branch, and a second
 * export of the same document — after the first merge request was closed, say — gets a branch of
 * its own rather than colliding with the first.
 */
export const configExportBranch = (configHash: string, exportId: string): string => {
  if (!HEX.test(configHash) || !HEX.test(exportId)) {
    throw new Error('a configuration export branch is built from two hex strings');
  }
  return `agentic/config/${configHash.slice(0, 12)}-${exportId.slice(0, 12)}`;
};

/**
 * A knowledge directory the pointer line may name: a relative path of plain segments.
 *
 * It is the project's own setting, and it lands in a Markdown line in somebody's repository — so a
 * value with a newline, a backtick or a traversal is left out of the file rather than escaped, and
 * the merge request says so.
 */
const SAFE_DIRECTORY = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export const claudeMdPointerLine = (knowledgeDir: string): string | null =>
  SAFE_DIRECTORY.test(knowledgeDir) && !knowledgeDir.split('/').includes('..')
    ? `The project's knowledge base is indexed at \`${knowledgeDir}/index.md\` (proposed by the Agentic platform).`
    : null;

/** What the commit does to `.agentic/config.yml`, or `null` when the branch already says it. */
const configAction = (
  entry: RepositoryFileEntry | undefined,
  content: string,
): CommitAction | null | { readonly refused: string } => {
  if (entry === undefined || entry.kind === 'absent') {
    return { action: 'create', path: REPOSITORY_CONFIG_PATH, content };
  }
  if (entry.kind === 'file') {
    return entry.text === content
      ? null
      : { action: 'update', path: REPOSITORY_CONFIG_PATH, content };
  }
  // A symlink or a submodule at that path, or a file over the bound: overwriting it through the
  // provider API would replace something the platform never read, so it is refused by name.
  return {
    refused:
      entry.kind === 'not_a_file'
        ? `${REPOSITORY_CONFIG_PATH} on the default branch is not a regular file (git mode ${entry.mode}); the export will not replace it`
        : `${REPOSITORY_CONFIG_PATH} on the default branch is ${entry.bytes} bytes, over the bound the platform reads; the export will not replace a file it has not read`,
  };
};

/** What the commit does to `CLAUDE.md`, with the reason when it does nothing. */
const pointerAction = (
  entry: RepositoryFileEntry | undefined,
  pointer: string | null,
  knowledgeDir: string,
): { readonly action: CommitAction | null; readonly note: string | null } => {
  if (pointer === null) {
    return {
      action: null,
      note: `the CLAUDE.md pointer was left out: the knowledge directory ${JSON.stringify(knowledgeDir.slice(0, 80))} is not a plain relative path`,
    };
  }
  if (entry === undefined || entry.kind === 'absent') {
    return {
      action: { action: 'create', path: CLAUDE_MD_PATH, content: `${pointer}\n` },
      note: null,
    };
  }
  if (entry.kind !== 'file') {
    return {
      action: null,
      note: 'the CLAUDE.md pointer was left out: CLAUDE.md on the default branch is not a regular file the platform read',
    };
  }
  if (entry.text.includes(`${knowledgeDir}/index.md`)) {
    // Already pointing there — whatever words a human chose for it.
    return { action: null, note: null };
  }
  const separator = entry.text.length === 0 || entry.text.endsWith('\n') ? '' : '\n';
  return {
    action: {
      action: 'update',
      path: CLAUDE_MD_PATH,
      content: `${entry.text}${separator}\n${pointer}\n`,
    },
    note: null,
  };
};

const messageFor = (request: ConfigExportRequest, paths: readonly string[]): string =>
  [
    'chore(config): export the project settings to .agentic/config.yml',
    '',
    `The platform's settings for this project (configuration ${request.configHash.slice(0, 12)}),`,
    'written to the file the platform reads from the default branch (technical/12, Q94).',
    '',
    ...paths.map((path) => `- ${path}`),
    '',
    `Agentic-Requested-By: user ${request.requestedByUserId}`,
    '',
  ].join('\n');

const descriptionFor = (
  request: ConfigExportRequest,
  paths: readonly string[],
  notes: readonly string[],
): string =>
  [
    'The project settings, exported by the Agentic platform (WP-63).',
    '',
    `Once merged, \`${REPOSITORY_CONFIG_PATH}\` on the default branch is this project's configuration and **wins over the settings screens** (Q94 (a)). Edit it here, in review; a later change made in the platform is proposed the same way.`,
    '',
    ...paths.map((path) => `- \`${path}\``),
    ...(notes.length === 0 ? [] : ['', ...notes.map((note) => `Note: ${note}.`)]),
    '',
    `Requested by user ${request.requestedByUserId}.`,
  ].join('\n');

/** One export. Outside any transaction; see the module note. */
export const exportProjectConfig = async (
  options: ConfigExportOptions,
  request: ConfigExportRequest,
): Promise<ConfigExportReport> => {
  const logger = options.logger ?? silentLogger;
  const branch = configExportBranch(request.configHash, request.exportId);
  const integrations = await integrationsForProject(
    options.integrations,
    request.projectId,
    noRunScopedSecrets(),
  );
  if (integrations.git === null) {
    return {
      status: 'unavailable',
      reason: 'the project has no git binding, so there is no repository to propose the file to',
    };
  }

  const read = await options.files.read({
    projectId: request.projectId,
    paths: [REPOSITORY_CONFIG_PATH, CLAUDE_MD_PATH],
  });
  if (read.status === 'unavailable') {
    return {
      status: 'unavailable',
      reason: `the default branch could not be read, so the export cannot tell a new file from a changed one: ${read.reason}`,
    };
  }

  const config = configAction(read.files[REPOSITORY_CONFIG_PATH], request.content);
  if (config !== null && 'refused' in config) {
    return { status: 'unavailable', reason: config.refused };
  }
  const pointer = pointerAction(
    read.files[CLAUDE_MD_PATH],
    claudeMdPointerLine(request.project.knowledgeDir),
    request.project.knowledgeDir,
  );
  const actions = [config, pointer.action].filter(
    (action): action is CommitAction => action !== null,
  );
  const notes = pointer.note === null ? [] : [pointer.note];
  if (actions.length === 0) {
    return {
      status: 'unchanged',
      reason: `the default branch (${read.commitSha}) already carries this configuration and the pointer; nothing was proposed`,
    };
  }

  const paths = actions.map((action) => action.path);
  const writes = knowledgeWrites(integrations);
  const context = { projectId: request.projectId, taskId: null };
  const commit = await writes.commit(
    {
      branch,
      startBranch: request.project.defaultBranch,
      message: messageFor(request, paths),
      // BD-025 §4: the bot acts, and the message names the human it acts for.
      authorName: 'Agentic',
      authorEmail: 'agentic@platform.invalid',
      actions,
      idempotencyKey: `config_commit:${branch}`,
    },
    context,
  );
  if (commit === null) {
    return { status: 'unavailable', reason: 'the git binding disappeared between two reads' };
  }
  const mergeRequest = await writes.openMergeRequest(
    {
      branch,
      target: request.project.defaultBranch,
      title: 'Configuration: export the project settings to .agentic/config.yml',
      description: descriptionFor(request, paths, notes),
      idempotencyKey: `config_mr:${branch}`,
      labels: ['agentic', 'configuration'],
    },
    context,
  );
  logger.info(
    {
      project_id: request.projectId,
      branch,
      commit_sha: commit.sha,
      merge_request: mergeRequest?.web_url ?? null,
      paths,
    },
    'project configuration exported as a merge request',
  );
  return {
    status: 'exported',
    branch,
    commitSha: commit.sha,
    mergeRequestUrl: mergeRequest?.web_url ?? null,
    paths,
    notes,
  };
};
