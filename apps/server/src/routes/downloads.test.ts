/**
 * The take-over downloads (WP-44, PROGRESS backlog 68, Q93) through the real router, the real
 * guards and the real error handler, against plain functions and a real directory.
 *
 * The directory is real because the tarball's only protection beyond the permission is WP-15j's
 * realpath guard, and a guard is only asserted by the filesystem it guards: a planted symlink out of
 * the export volume is the case that matters, and it cannot be faked.
 *
 * **What this tier cannot see**: whether `listRunMessages` reads the rows correctly, which is
 * `test/integration/server/read-api.integration.test.ts`'s, and whether the launcher writes the
 * file under the name this route reads — `exportFileName` is asserted equal to the launcher's own
 * composition below, off the launcher's source rather than a copy of it.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TranscriptEvent, UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import {
  type DownloadQueries,
  exportFileName,
  registerDownloadRoutes,
  TRANSCRIPT_DOWNLOAD_PAGE,
} from './downloads.js';

const RUN = '00000000-0000-4000-8000-0000000000a1';
const OTHER_RUN = '00000000-0000-4000-8000-0000000000a2';
/** A run of a project the caller is **not** a member of. */
const FOREIGN_RUN = '00000000-0000-4000-8000-0000000000a3';
const PROJECT = '00000000-0000-4000-8000-0000000000c1';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000c2';
const USER = '00000000-0000-4000-8000-0000000000d1';

const entry = (seq: number): TranscriptEvent => ({
  kind: 'assistant',
  run_id: RUN,
  seq,
  created_at: '2026-09-01T09:00:00.000Z',
  redaction_count: 0,
  model: 'claude-test',
  content: [{ type: 'text', text: `line ${seq}` }],
});

interface World {
  role: UserRole | null;
  signedIn: boolean;
  entries: TranscriptEvent[];
  /** A page read from this cursor on throws — a row the projection refuses mid-file. */
  failAfter?: number;
  readonly pageCalls: { after: number | undefined; limit: number }[];
}

const build = async (exportDir: string | null): Promise<{ app: FastifyInstance; world: World }> => {
  const world: World = { role: 'member', signedIn: true, entries: [], pageCalls: [] };
  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    if (world.signedIn) {
      request.actor = {
        userId: USER,
        email: 'operator@example.test',
        name: 'Operator',
        // The organisation role is the lowest, so the project role the world sets is what decides
        // (`effectiveRole` takes the higher of the two).
        role: 'viewer',
        sessionId: 'session-1',
      };
    }
  });
  const queries: DownloadQueries = {
    runProjectId: async (runId) =>
      runId === RUN || runId === OTHER_RUN ? PROJECT : runId === FOREIGN_RUN ? OTHER_PROJECT : null,
    // Keyed by project (review round 1): the caller holds a role in `PROJECT` and none in
    // `OTHER_PROJECT`, so a guard scoped to anything but the run's own project is caught.
    projectRole: async (projectId) => (projectId === PROJECT ? world.role : null),
    transcriptPage: async (_runId, after, limit) => {
      world.pageCalls.push({ after, limit });
      if (world.failAfter !== undefined && after !== undefined && after >= world.failAfter) {
        throw new Error('entry 500 cannot be projected');
      }
      const rest = world.entries.filter((item) => after === undefined || item.seq > after);
      const items = rest.slice(0, limit);
      return {
        items,
        nextSeq: rest.length > limit ? (items.at(-1)?.seq ?? null) : null,
      };
    },
  };
  await registerDownloadRoutes(app, { queries, exportDir });
  await app.ready();
  return { app, world };
};

describe('GET /api/runs/:run_id/transcript.jsonl', () => {
  it('renders every entry, one JSON document per line, as an attachment', async () => {
    const { app, world } = await build(null);
    world.entries = [entry(0), entry(1), entry(2)];
    const response = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/transcript.jsonl` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="run-${RUN}-transcript.jsonl"`,
    );
    const lines = response.body.split('\n');
    // Three documents and the final newline JSON Lines ends with.
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toBe('');
    expect(lines.slice(0, 3).map((line) => (JSON.parse(line) as TranscriptEvent).seq)).toEqual([
      0, 1, 2,
    ]);
  });

  it('follows the cursor across pages rather than stopping at the first', async () => {
    const { app, world } = await build(null);
    const count = TRANSCRIPT_DOWNLOAD_PAGE * 2 + 3;
    world.entries = Array.from({ length: count }, (_, seq) => entry(seq));
    const response = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/transcript.jsonl` });
    expect(response.statusCode).toBe(200);
    expect(response.body.trimEnd().split('\n')).toHaveLength(count);
    // The first read has no cursor — `seq: 0` is a real entry — and each later one is exclusive.
    expect(world.pageCalls.map((call) => call.after)).toEqual([
      undefined,
      TRANSCRIPT_DOWNLOAD_PAGE - 1,
      TRANSCRIPT_DOWNLOAD_PAGE * 2 - 1,
    ]);
  });

  it('refuses a member of another project: the guard is the run’s own project', async () => {
    const { app, world } = await build(null);
    world.entries = [entry(0)];
    const response = await app.inject({
      method: 'GET',
      url: `/api/runs/${FOREIGN_RUN}/transcript.jsonl`,
    });
    expect(response.statusCode).toBe(403);
    expect(world.pageCalls).toEqual([]);
  });

  it('sends nosniff, so a browser never guesses the text is something to run', async () => {
    const { app } = await build(null);
    const response = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/transcript.jsonl` });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('aborts the download, rather than completing it short, when a later page is refused', async () => {
    const { app, world } = await build(null);
    world.entries = Array.from({ length: TRANSCRIPT_DOWNLOAD_PAGE + 5 }, (_, seq) => entry(seq));
    world.failAfter = 0;
    // The headers went out with the first page, so the only signal left is the connection.
    // Measured: Fastify destroys the response when the body stream errors, so the injector's
    // request **fails** — what a browser reports as a failed download, never a short, finished file.
    await expect(
      app.inject({ method: 'GET', url: `/api/runs/${RUN}/transcript.jsonl` }),
    ).rejects.toThrow('response destroyed before completion');
    // …and it did fail on page 2, after page 1 was read: the case is the one this is about.
    expect(world.pageCalls.map((call) => call.after)).toEqual([
      undefined,
      TRANSCRIPT_DOWNLOAD_PAGE - 1,
    ]);
  });

  it('answers an empty file, not an error, for a run with no transcript yet', async () => {
    const { app } = await build(null);
    const response = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/transcript.jsonl` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
  });

  it('refuses before reading: 401 with no session, 403 for a viewer, 404 for an unknown run', async () => {
    const { app, world } = await build(null);
    world.signedIn = false;
    const anonymous = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/transcript.jsonl` });
    expect(anonymous.statusCode).toBe(401);
    world.signedIn = true;
    // `transcript.read` is `member`, exactly as `/messages`: the file is no more readable than the page.
    world.role = 'viewer';
    const viewer = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/transcript.jsonl` });
    expect(viewer.statusCode).toBe(403);
    world.role = 'member';
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/runs/00000000-0000-4000-8000-00000000ffff/transcript.jsonl',
    });
    expect(unknown.statusCode).toBe(404);
    expect(world.pageCalls).toEqual([]);
  });
});

describe('GET /api/runs/:run_id/export.tar', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'wp44-exports-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('serves the tarball the launcher wrote, as an attachment', async () => {
    const exports = path.join(root, 'exports');
    await mkdir(exports);
    await writeFile(path.join(exports, exportFileName(RUN)), 'fake tar bytes');
    const { app } = await build(exports);
    const response = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/export.tar` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-tar');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="run-${RUN}-workspace.tar"`,
    );
    expect(response.body).toBe('fake tar bytes');
  });

  it('answers 404 export_not_found for a run with no tarball', async () => {
    const exports = path.join(root, 'exports');
    await mkdir(exports);
    await writeFile(path.join(exports, exportFileName(OTHER_RUN)), 'someone else');
    const { app } = await build(exports);
    const response = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/export.tar` });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('export_not_found');
  });

  it('refuses a tarball that is a symlink out of the export volume (the realpath guard)', async () => {
    const exports = path.join(root, 'exports');
    await mkdir(exports);
    const outside = path.join(root, 'secret.txt');
    await writeFile(outside, 'not an export');
    await symlink(outside, path.join(exports, exportFileName(RUN)));
    const { app } = await build(exports);
    const response = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/export.tar` });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('not an export');
  });

  it('refuses by name when the export directory is not configured', async () => {
    const { app } = await build(null);
    const response = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/export.tar` });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'export_directory_not_configured',
    );
  });

  it('is gated at task.take_over: a viewer gets 403 and never reaches the file', async () => {
    const exports = path.join(root, 'exports');
    await mkdir(exports);
    await writeFile(path.join(exports, exportFileName(RUN)), 'fake tar bytes');
    const { app, world } = await build(exports);
    world.role = 'viewer';
    const response = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/export.tar` });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('fake tar bytes');
  });

  it('refuses a member of another project, whatever the export volume holds', async () => {
    const exports = path.join(root, 'exports');
    await mkdir(exports);
    await writeFile(path.join(exports, exportFileName(FOREIGN_RUN)), 'someone else’s workspace');
    const { app } = await build(exports);
    const response = await app.inject({
      method: 'GET',
      url: `/api/runs/${FOREIGN_RUN}/export.tar`,
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('someone else');
  });

  it('sends nosniff with the tarball', async () => {
    const exports = path.join(root, 'exports');
    await mkdir(exports);
    await writeFile(path.join(exports, exportFileName(RUN)), 'fake tar bytes');
    const { app } = await build(exports);
    const response = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/export.tar` });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('reads the name the launcher writes, off the launcher’s own source', async () => {
    // One spelling of the file name in two processes: the launcher composes it and this route reads
    // it. Asserted against the launcher's line rather than restated, so a rename on either side
    // fails here instead of turning every download into a 404.
    const source = await readFile(
      path.resolve(import.meta.dirname, '../../../launcher/src/service.ts'),
      'utf8',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the launcher's source text, searched for verbatim.
    expect(source).toContain('`${handle.runId}.tar`');
    expect(exportFileName(RUN)).toBe(`${RUN}.tar`);
  });
});
