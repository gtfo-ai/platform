/**
 * The configuration's two repository-facing commands — WP-63, Q94, product/06 § "Step 5".
 *
 *   POST /api/projects/:project_id/config/export    propose the settings as `.agentic/config.yml`
 *   POST /api/projects/:project_id/config/refresh   re-read that file from the default branch
 *
 * **Q94's three answers, and where each lands.** (a) *The repository wins*: `refresh` records the
 * default branch's file, and `GET …/config` merges it over the settings (`routes/projects.ts`). (b)
 * *No direct commit, ever*: the export is an `agentic/*` branch and a merge request through WP-18b's
 * apply path (`exportProjectConfig`), and nothing here — no flag, no project setting — asks for
 * anything else. (c) *A button that stays*: these are ordinary commands on the project, reachable
 * from the settings page at any time, not a wizard step that runs once.
 *
 * **The export is the wizard's other commands' shape** (technical/08 § "Principles"): it creates
 * something (a branch and a merge request), so the `Idempotency-Key` is **required**, a replay under
 * the same key answers the first attempt's result from its `human_actions` row without calling the
 * provider again, a different body under a used key is `409 idempotency_key_reused`, and every
 * performed export leaves one `human_actions` row — written **after** the provider answered, so a
 * refusal leaves none. `base_hash` pins what is exported to what the operator saw.
 *
 * The provider calls are made in this request, outside any transaction — no connection is held
 * while the provider answers (`exportProjectConfig`'s docblock carries the argument for a request
 * rather than a queue).
 */
import { createHash } from 'node:crypto';
import type {
  ConfigExportReport,
  PreviousConfigExport,
  RepositoryConfigRefresh,
  RepositoryConfigSnapshot,
} from '@platform/application';
import {
  type AgenticConfig,
  agenticConfigSchema,
  apiErrorSchema,
  exportProjectConfigRequestSchema,
  exportProjectConfigResponseSchema,
  type Id,
  type JsonObject,
  refreshProjectConfigResponseSchema,
} from '@platform/contracts';
import { config as configAdapters } from '@platform/infrastructure';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { ProjectConfigCommands } from '../project-config.js';
import type { HumanActionInput } from '../queries/onboarding-queries.js';
import {
  claimIdempotentAttempt,
  type IdempotencyRecords,
  readIdempotencyKey,
  requireIdempotencyKey,
} from './idempotency.js';
import { repositoryReadingOf } from './projects.js';

/** What the export reads about the project, re-read per request. */
export interface ExportableProject {
  readonly config: Record<string, unknown>;
  readonly configHash: string | null;
  readonly defaultBranch: string;
  readonly knowledgeDir: string;
}

/**
 * Everything these routes read or write outside the application ring — injected, as
 * `routes/shadow.ts` takes its seven, so the key policy, the replay, the capability and the
 * refusal-to-status mapping are asserted without a database.
 */
export interface ProjectConfigQueries {
  readonly projectRole: (projectId: string, userId: string) => Promise<string | null>;
  readonly exportableProject: (projectId: string) => Promise<ExportableProject | null>;
  readonly claimAttempt: IdempotencyRecords['claimAttempt'];
  readonly releaseAttempt: IdempotencyRecords['releaseAttempt'];
  readonly recordAction: (input: HumanActionInput) => Promise<void>;
  readonly readRepository: (projectId: string) => Promise<RepositoryConfigSnapshot | null>;
  /**
   * The project's last recorded export (WP-91, backlog 225) — the newest `project.config.export`
   * `human_actions` row for it — or `null`. Its merge request is re-validated by the export.
   */
  readonly lastExport: (projectId: string) => Promise<RecordedConfigExport | null>;
}

/** A `project.config.export` row's params, as `lastExport` reads them back. */
export interface RecordedConfigExport {
  readonly status: 'exported' | 'unchanged' | 'open';
  readonly configHash: string;
  readonly branch: string | null;
  readonly mergeRequestUrl: string | null;
  /** `null` for a row written before WP-91 recorded it: such an export cannot be re-validated. */
  readonly mergeRequestIid: number | null;
  readonly exportedAt: string;
}

/** The previous export the command re-validates, or `null` when there is nothing to ask about. */
export const previousExportOf = (
  recorded: RecordedConfigExport | null,
): PreviousConfigExport | null =>
  recorded === null ||
  recorded.status === 'unchanged' ||
  recorded.mergeRequestIid === null ||
  recorded.mergeRequestUrl === null ||
  recorded.branch === null
    ? null
    : {
        iid: recorded.mergeRequestIid,
        url: recorded.mergeRequestUrl,
        branch: recorded.branch,
        configHash: recorded.configHash,
      };

export interface ProjectConfigRoutesOptions {
  readonly queries: ProjectConfigQueries;
  /** `null` on a process that composed none; the routes answer `503` by name. */
  readonly commands: ProjectConfigCommands | null;
  /** TD-012 step 2 over a refusal's reason, which can quote `git`'s own stderr. */
  readonly redactText: (value: string) => string;
}

export const CONFIG_EXPORT_ACTION = 'project.config.export';
export const CONFIG_REFRESH_ACTION = 'project.config.refresh';

/** The comment block the exported file opens with. Platform text, no value from the document. */
export const exportHeaderLines = (configHash: string): readonly string[] => [
  ".agentic/config.yml — this project's configuration (technical/12).",
  `Exported from the Agentic platform's project settings (configuration ${configHash.slice(0, 12)}).`,
  'Once merged, this file wins over the settings screens (Q94): edit it here, in review.',
];

/**
 * The export's identity: a digest of **who asked and under which key**, never the key itself.
 *
 * The key is client text, so it reaches neither the branch name nor a provider idempotency key
 * (standing rule 70: an identity is refused or digested, never redacted into a collision). Scoped by
 * the caller like every `Idempotency-Key` on this server (`idempotency.ts`).
 */
export const configExportIdOf = (userId: string, key: string): string =>
  createHash('sha256').update(`${userId}\0${key}`).digest('hex').slice(0, 16);

/**
 * The settings layer rendered as the file, and **read back** before it is proposed.
 *
 * The codec's round trip is a property test beside it; this is the same promise checked on the one
 * document actually being exported, because a file the platform would refuse the moment it was
 * merged is the worst thing this endpoint could propose.
 */
export const renderExport = (document: AgenticConfig, configHash: string): string => {
  const content = configAdapters.yamlConfigCodec.stringify(
    document as unknown as JsonObject,
    exportHeaderLines(configHash),
  );
  const back = configAdapters.yamlConfigCodec.parse(content);
  const reparsed = back.ok ? agenticConfigSchema.safeParse(back.value) : null;
  if (
    reparsed === null ||
    !reparsed.success ||
    JSON.stringify(reparsed.data) !== JSON.stringify(document)
  ) {
    throw new Error(
      'the exported configuration did not read back as the document it was rendered from; nothing was proposed',
    );
  }
  return content;
};

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

const stringOr = (value: unknown, fallback: string | null): string | null =>
  typeof value === 'string' ? value : fallback;
const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

export const registerProjectConfigRoutes = async (
  app: FastifyInstance,
  options: ProjectConfigRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: async (projectId: string, userId: string) =>
      (await options.queries.projectRole(projectId, userId)) as never,
  };
  const projectOf = (request: FastifyRequest): string | undefined => {
    const value = (request.params as { project_id?: unknown }).project_id;
    return typeof value === 'string' && UUID.test(value) ? value : undefined;
  };
  const actorOf = (request: FastifyRequest): { userId: string } => {
    const actor = request.actor;
    if (actor === undefined) {
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return { userId: actor.userId };
  };
  const commands = (): ProjectConfigCommands => {
    if (options.commands === null) {
      throw new HttpError(
        503,
        'config_commands_unavailable',
        'this process composed no configuration commands: it cannot read the repository or reach the git provider. Ask an instance that serves the API with its integrations',
      );
    }
    return options.commands;
  };

  typed.post(
    '/api/projects/:project_id/config/export',
    {
      preValidation: requirePermission(guard, 'project.config.export', { project: projectOf }),
      schema: {
        summary: 'Propose the project settings as .agentic/config.yml in a merge request',
        description:
          'Writes the **settings layer** (what `PUT …/config` stores) as `.agentic/config.yml`, plus a one-line pointer to the knowledge index in `CLAUDE.md`, as one commit on an `agentic/config/*` branch and opens a merge request against the default branch — **never a direct commit** (Q94 (b)). Once merged, the file wins over the settings (Q94 (a)). Requires an `Idempotency-Key`: a retry under the same key answers the first attempt without calling the provider again (`performed: false`). `base_hash` pins the export to the configuration you read; a settings change made since is `409 config_conflict`. `409 config_export_unavailable` names why nothing could be proposed (no git binding, no repository mirror, a file the platform will not replace).',
        tags: ['projects'],
        params: projectParamsSchema,
        body: exportProjectConfigRequestSchema,
        response: {
          200: exportProjectConfigResponseSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const key = requireIdempotencyKey(request);
      const projectId = request.params.project_id;
      const actor = actorOf(request);
      const replay = await claimIdempotentAttempt(options.queries, {
        userId: actor.userId,
        action: CONFIG_EXPORT_ACTION,
        key,
        request: { project_id: projectId, base_hash: request.body.base_hash ?? null },
      });
      if (replay.replayed && replay.previous !== null) {
        const previous = replay.previous;
        const recorded = previous.status;
        return {
          status:
            recorded === 'unchanged'
              ? ('unchanged' as const)
              : recorded === 'open'
                ? ('open' as const)
                : ('exported' as const),
          performed: false,
          config_hash: stringOr(previous.config_hash, 'unconfigured') as string,
          branch: stringOr(previous.branch, null),
          commit_sha: stringOr(previous.commit_sha, null),
          merge_request_url: stringOr(previous.merge_request_url, null),
          paths: stringsOf(previous.paths),
          notes: stringsOf(previous.notes),
        };
      }

      return replay.run(async (effectReturned) => {
        const project = await options.queries.exportableProject(projectId);
        if (project === null) {
          throw new NotFoundError(`project ${projectId}`);
        }
        const configHash = project.configHash ?? 'unconfigured';
        if (request.body.base_hash !== undefined && request.body.base_hash !== configHash) {
          throw new HttpError(
            409,
            'config_conflict',
            `this project's configuration has moved since you read it (its hash is now ${configHash}); re-read it and export again`,
          );
        }
        if (project.configHash === null || Object.keys(project.config).length === 0) {
          throw new HttpError(
            409,
            'nothing_to_export',
            `project ${projectId} has no settings to export: write them first (PUT /api/projects/${projectId}/config)`,
          );
        }
        const parsed = agenticConfigSchema.safeParse(project.config);
        if (!parsed.success) {
          throw new HttpError(
            409,
            'invalid_stored_config',
            `the stored configuration of project ${projectId} does not parse, so it cannot be exported; GET /api/projects/${projectId}/config names the keys`,
          );
        }

        const report: ConfigExportReport = await commands().export({
          projectId: projectId as Id,
          project: { defaultBranch: project.defaultBranch, knowledgeDir: project.knowledgeDir },
          configHash,
          content: renderExport(parsed.data, configHash),
          exportId: configExportIdOf(actor.userId, key),
          requestedByUserId: actor.userId as Id,
          previous: previousExportOf(await options.queries.lastExport(projectId)),
        });
        if (report.status === 'unavailable') {
          throw new HttpError(409, 'config_export_unavailable', options.redactText(report.reason));
        }
        effectReturned();

        const answer = {
          status: report.status,
          // `open` performed nothing at the provider: it read, and answered what it read.
          performed: report.status !== 'open',
          // An `open` answer names the configuration the open merge request carries, which the
          // note compares with the one being exported now.
          config_hash: report.status === 'open' ? report.configHash : configHash,
          branch: report.status === 'unchanged' ? null : report.branch,
          commit_sha: report.status === 'exported' ? report.commitSha : null,
          merge_request_url: report.status === 'unchanged' ? null : report.mergeRequestUrl,
          paths: report.status === 'exported' ? [...report.paths] : [],
          notes: report.status === 'unchanged' ? [report.reason] : [...report.notes],
        };
        const mergeRequestIid = report.status === 'unchanged' ? null : report.mergeRequestIid;
        await options.queries.recordAction({
          userId: actor.userId,
          action: CONFIG_EXPORT_ACTION,
          params: {
            project_id: projectId,
            config_hash: answer.config_hash,
            status: answer.status,
            branch: answer.branch,
            commit_sha: answer.commit_sha,
            merge_request_url: answer.merge_request_url,
            // WP-91: what the next press re-validates against the provider (backlog 225).
            merge_request_iid: mergeRequestIid,
            paths: answer.paths,
            notes: answer.notes,
            idempotency_key: key,
            body_digest: replay.digest,
          },
        });
        return answer;
      });
    },
  );

  typed.post(
    '/api/projects/:project_id/config/refresh',
    {
      preValidation: requirePermission(guard, 'project.config.export', { project: projectOf }),
      schema: {
        summary: 'Re-read .agentic/config.yml from the default branch now',
        description:
          "Reads the repository's own `.agentic/config.yml` from the project's **default branch** (BD-025 §1; never a task or merge-request branch) and records what it means: `absent`, `valid` (merged over the settings, winning where it states a key) or `invalid` with the key paths it failed on — which refuses every run of the project until a later reading parses. The same reading happens after every knowledge index run. `409 repository_unreadable` names why the branch could not be read; the previous reading then stands. When an integration's credentials cannot be decrypted the configuration is still stored and the prompt files are not: `prompts_withheld` names the integration (WP-107). An `Idempotency-Key` is optional: a replay answers the stored reading without reading again.",
        tags: ['projects'],
        params: projectParamsSchema,
        response: {
          200: refreshProjectConfigResponseSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const key = readIdempotencyKey(request);
      const projectId = request.params.project_id;
      const actor = actorOf(request);
      const replay = await claimIdempotentAttempt(options.queries, {
        userId: actor.userId,
        action: CONFIG_REFRESH_ACTION,
        key,
        request: { project_id: projectId },
      });
      if (replay.replayed) {
        return {
          repository: repositoryReadingOf(await options.queries.readRepository(projectId)),
        };
      }
      return replay.run(async (effectReturned) => {
        if ((await options.queries.exportableProject(projectId)) === null) {
          throw new NotFoundError(`project ${projectId}`);
        }
        const outcome: RepositoryConfigRefresh = await commands().refresh(projectId as Id);
        if (outcome.status === 'unavailable') {
          throw new HttpError(
            409,
            'repository_unreadable',
            `the default branch could not be read, so the previous reading stands: ${options.redactText(outcome.reason)}`,
          );
        }
        effectReturned();
        await options.queries.recordAction({
          userId: actor.userId,
          action: CONFIG_REFRESH_ACTION,
          params: {
            project_id: projectId,
            status: outcome.snapshot.status,
            commit_sha: outcome.snapshot.commitSha,
            ...(key === null ? {} : { idempotency_key: key, body_digest: replay.digest }),
          },
        });
        return {
          repository: repositoryReadingOf(outcome.snapshot),
          // WP-107 (backlog 358): the configuration was stored; the prompt files were not, and the
          // integrations whose credentials would not decrypt are named here, not in a 409.
          ...(outcome.status === 'recorded' && outcome.promptsWithheld !== null
            ? { prompts_withheld: options.redactText(outcome.promptsWithheld) }
            : {}),
        };
      });
    },
  );
};
