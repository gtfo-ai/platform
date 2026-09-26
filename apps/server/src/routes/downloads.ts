/**
 * The two files a person takes away from a take-over (WP-44, PROGRESS backlog 68, Q93).
 *
 * product/19 §19 promises the human who takes a task over three things — the branch, the
 * `claude --resume` line, and *"the transcript download"* — and technical/05 §6 adds an optional
 * tarball of the workspace. The branch and the resume line shipped at WP-27; nothing served either
 * file. These two routes are that delivery, and both are **reads of something that already exists**
 * rather than a copy:
 *
 * - `GET /api/runs/:run_id/transcript.jsonl` — the run's `run_messages` rendered one entry per line,
 *   through **the same projection** `/messages` serves (`listRunMessages`), so every line has
 *   already passed the redaction `createPostgresTranscriptSink` applied at the write (TD-012). **No
 *   `blobs` writer** (Q93, answered per its recommendation: serve, do not copy): a copy would be a
 *   fourth place the platform stores somebody else's words, after `inbox`, `kb_chunks` and
 *   `ticket_snapshot`, and it would owe its own redaction argument. The consequence is stated rather
 *   than hidden: the file is exactly as durable as the transcript, so product/19 §20's
 *   `APP_TRANSCRIPT_RETENTION_DAYS` purge takes it with the rows.
 * - `GET /api/runs/:run_id/export.tar` — the tarball the launcher wrote at the take-over, read from
 *   `APP_WORKSPACE_EXPORT_DIR` **through WP-15j's realpath guard** (`web/bundle.ts`), which is the
 *   one piece of this server that turns a name into a filesystem path. The name is not the
 *   caller's: it is the run id the route has already validated as a uuid and scoped to a project,
 *   plus `.tar`, exactly as `apps/launcher/src/service.ts` composes it. The guard is still applied,
 *   because the directory is a shared volume another container writes, and a symlink planted there
 *   must not become a read of this container's filesystem.
 *
 * ## Which permission
 *
 * `transcript.read` (member) for the transcript, for technical/08's reason — it is the model's own
 * text and the ticket's own words — and the gate `/messages` already has, so the file is exactly as
 * readable as the page. `task.take_over` (member) for the tarball: it is what a take-over produced,
 * the whole checkout minus `.git` and `node_modules`, and whoever may take a task over may take its
 * workspace. A viewer may take neither.
 *
 * ## What these routes do not do
 *
 * They do not say *why* a tarball is missing. A run with no tarball is one nobody took over, one
 * whose take-over did not ask for a tarball, one whose export failed (the launcher logs it and the
 * run's end says so), or one whose file the retention sweep removed after fourteen days
 * (`apps/launcher/src/export-retention.ts`) — and the platform keeps no record that would tell the
 * four apart, because `workspaces` has never held a row (technical/03 says so). The 404 names all
 * four rather than guessing one.
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { TranscriptEvent, UserRole } from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError } from '../errors.js';
import { resolveBundleFile, resolveBundleRoot } from '../web/bundle.js';
import { scopedProject, scopeToProject } from './scope.js';

/**
 * How many transcript entries one read fetches. The file is streamed page by page, so this bounds
 * the memory one download holds rather than the size of the file.
 */
export const TRANSCRIPT_DOWNLOAD_PAGE = 500;

/** The spelling of both paths, shared with the SPA's links through the census rather than a copy. */
export const transcriptDownloadPath = (runId: string): string =>
  `/api/runs/${runId}/transcript.jsonl`;
export const exportDownloadPath = (runId: string): string => `/api/runs/${runId}/export.tar`;

/** The file name the launcher writes (`apps/launcher/src/service.ts`), from a validated run id. */
export const exportFileName = (runId: string): string => `${runId}.tar`;

export interface DownloadQueries {
  readonly runProjectId: (runId: string) => Promise<string | null>;
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  /** One page of the run's transcript, **without** partial `stream_block` entries. */
  readonly transcriptPage: (
    runId: string,
    after: number | undefined,
    limit: number,
  ) => Promise<{ readonly items: readonly TranscriptEvent[]; readonly nextSeq: number | null }>;
}

export interface DownloadRoutesOptions {
  readonly queries: DownloadQueries;
  /** `APP_WORKSPACE_EXPORT_DIR`, or `null` when the operator has not said where it is mounted. */
  readonly exportDir: string | null;
}

const runParamsSchema = z.strictObject({ run_id: z.uuid() });

/** One JSON document per line, each ending in `\n` — the JSON Lines convention, final newline included. */
export const toJsonLines = (items: readonly TranscriptEvent[]): string =>
  items.map((item) => `${JSON.stringify(item)}\n`).join('');

export const registerDownloadRoutes = async (
  app: FastifyInstance,
  options: DownloadRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };
  const scope = scopeToProject({
    param: 'run_id',
    what: 'run',
    projectOf: options.queries.runProjectId,
  });

  typed.get(
    '/api/runs/:run_id/transcript.jsonl',
    {
      preHandler: [scope, requirePermission(guard, 'transcript.read', { project: scopedProject })],
      schema: {
        summary: 'The run’s transcript as a file',
        description:
          'The same entries `GET /api/runs/:run_id/messages` pages through — minus the partial `stream_block` frames, which the complete messages supersede — one JSON document per line, as an attachment. Every line has passed the redaction at the write (TD-012) and is untrusted content (BD-022). It is rendered from `run_messages` on each request rather than copied anywhere (Q93), so it lasts exactly as long as the transcript does.',
        tags: ['runs'],
        params: runParamsSchema,
        // **No `response` block**, for `/api/org/stats.csv`'s reason: the body is not one JSON
        // document, and a serialiser compiled for one would describe an answer this route never gives.
      },
    },
    async (request, reply) => {
      const runId = request.params.run_id;
      // The first page is read **before** the headers go out, so a refusal on it (an entry the
      // projection cannot serve) is an ordinary error response rather than a truncated download. A
      // refusal on a **later** page throws inside the stream after the 200 is sent; Fastify then
      // destroys the response (measured, `downloads.test.ts` › "aborts the download, rather than
      // completing it short, when a later page is refused"), so the client sees a failed download,
      // never a short file that looks complete.
      const first = await options.queries.transcriptPage(
        runId,
        undefined,
        TRANSCRIPT_DOWNLOAD_PAGE,
      );
      const pages = async function* (): AsyncGenerator<string> {
        yield toJsonLines(first.items);
        let next = first.nextSeq;
        while (next !== null) {
          const page = await options.queries.transcriptPage(runId, next, TRANSCRIPT_DOWNLOAD_PAGE);
          yield toJsonLines(page.items);
          next = page.nextSeq;
        }
      };
      return reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', `attachment; filename="run-${runId}-transcript.jsonl"`)
        .header('cache-control', 'no-store')
        .send(Readable.from(pages()));
    },
  );

  typed.get(
    '/api/runs/:run_id/export.tar',
    {
      preHandler: [scope, requirePermission(guard, 'task.take_over', { project: scopedProject })],
      schema: {
        summary: 'The workspace tarball a take-over exported',
        description:
          'The archive the launcher wrote when this run was taken over with `tarball: true` — the checkout minus `.git` and `node_modules` — as an attachment. Kept for fourteen days, the workspace volume’s own retention for a taken-over run (Q93); after that, and for a run nobody took over with a tarball, the answer is 404. `409 export_directory_not_configured` when this process was not told where the export volume is mounted (`APP_WORKSPACE_EXPORT_DIR`).',
        tags: ['runs'],
        params: runParamsSchema,
      },
    },
    async (request, reply) => {
      const runId = request.params.run_id;
      if (options.exportDir === null) {
        throw new HttpError(
          409,
          'export_directory_not_configured',
          'APP_WORKSPACE_EXPORT_DIR is not set on this process, so it cannot read the volume the launcher writes take-over tarballs to. Set it to the path the shared `exports` volume is mounted at (compose.yml mounts it at /var/lib/app/exports)',
        );
      }
      const root = await resolveBundleRoot(options.exportDir);
      const file = root === null ? null : await resolveBundleFile(root, [exportFileName(runId)]);
      if (file === null) {
        // Its own code rather than `not_found`: the route and the run both exist, and the client
        // census reads `not_found` as "no such route" (`routes/client-census.test.ts`).
        throw new HttpError(
          404,
          'export_not_found',
          `run ${runId} has no workspace tarball on this instance: it was not taken over, its take-over did not ask for a tarball, the export failed, or the file was removed at the end of its fourteen-day retention. The branch is where the work is either way`,
        );
      }
      return reply
        .header('content-type', 'application/x-tar')
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', `attachment; filename="run-${runId}-workspace.tar"`)
        .header('cache-control', 'no-store')
        .send(createReadStream(file.path));
    },
  );
};
