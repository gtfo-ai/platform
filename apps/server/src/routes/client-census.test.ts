/**
 * **Every `/api/...` path the web app names is served by this server, or is an admitted gap.**
 *
 * PROGRESS backlog 29: `apps/web/src/api/endpoints.ts` called twenty distinct `/api/*` paths and
 * `apps/server` registered four, and **every tier was green** — because the only tier that
 * exercises the client's endpoint list (`pnpm test:web-e2e`) answers it with a fake API backend, so
 * sixteen missing routes were invisible everywhere. Nothing compared the two lists. This file is
 * that comparison, and it is the part of WP-15h that closes the recurrence rather than the
 * instance.
 *
 * ## How each half is obtained, and why neither is a list in this file
 *
 * - **The client's half is read off disk**, from every `.ts`/`.tsx` file under `apps/web/src` that
 *   git knows about — tracked **and** untracked-but-not-ignored. The second half of that is
 *   standing rule **85**, paid for by a rejected push the same morning this was written: a guard
 *   that reads `git ls-files` is green on a file the author has not committed yet, so the census
 *   would pass locally and fail on CI. It is **not** scoped to `endpoints.ts`, which makes that
 *   file's own docblock claim ("every endpoint of technical/08 this app talks to") enforced rather
 *   than decorative (standing rule 44): a `fetch('/api/…')` written anywhere else in the app is
 *   caught by the same sweep.
 * - **The server's half is the running router.** Not a list, not `openapi.json` — which would miss
 *   `/api/auth/*`, registered with `schema: {hide: true}` — but a real unauthenticated request
 *   through the real `buildApp`, classified by whether the reply is the not-found handler's own
 *   body. That makes the census also the **per-route auth assertion** the plan row asks for
 *   (standing rule 68: enumerate what you branch on), because the same probe shows which routes
 *   answer 401 to an anonymous caller and which are deliberately public.
 *
 * ## What it cannot see, stated rather than implied
 *
 * A path the app builds from pieces (`'/api/' + resource`), a path in a `*.test.ts`/`*.test.tsx`
 * file (deliberately out of scope — `api/http.test.ts` names `/api/thing`, which is not an
 * endpoint), and a path in a comment (block comments and comment-only lines are stripped, so
 * `endpoints.ts`'s own docblock naming `GET /api/org/stats` does not make the app a caller of it).
 * It also says nothing about the *shape* either side expects; that is `packages/contracts`, which
 * both import.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Auth } from '../auth/better-auth.js';
import { loadServerConfig } from '../config.js';
import { createLogger } from '../logging.js';
import { createMetrics } from '../metrics.js';
import type { Database } from '../queries/identity-queries.js';
import { SseHub } from '../sse/hub.js';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const WEB_SOURCES = 'apps/web/src';

/**
 * The endpoints the client calls and this server does not serve yet, each with the row that owns
 * it — the shape `apps/launcher/src/docker-access.test.ts` uses.
 *
 * It is an **admitted gap list, not a filter**: the assertion below is an equality in both
 * directions, so a path that leaves this list without a route fails, and a path that gains a route
 * while still listed here fails too. A list that only suppressed failures would go stale silently,
 * which is standing rule 7's corollary.
 */
const ADMITTED_GAPS: Readonly<Record<string, string>> = {
  // Every remaining gap is a **command**. The seven reads WP-15h's row attributed to a later
  // iteration — the running-agents, inbox, integrations, setup-guide, projects, readiness and
  // task-list screens — left this list at part 2, which is what makes the "serves this
  // iteration's" cases below the other half of the same check (standing rule 10).
  //
  // Commands. Every one of these writes, so each needs the aggregate, a `human_actions` row and an
  // `Idempotency-Key`, which is a different work package from a read API (technical/08 § Tasks).
  '/api/tasks/{}/pause': 'the task command surface — not this row',
  '/api/tasks/{}/resume': 'the task command surface — not this row',
  '/api/tasks/{}/cancel': 'the task command surface — not this row',
  '/api/tasks/{}/retry-stage': 'the task command surface — not this row',
  '/api/tasks/{}/return-to-stage': 'the task command surface — not this row',
  '/api/tasks/{}/rework': 'the task command surface — not this row',
  '/api/tasks/{}/feedback': 'the task command surface — not this row',
  '/api/tasks/{}/questions/{}/answer': 'the task command surface — not this row',
  '/api/tasks/{}/approvals/{}/decide': 'the task command surface — not this row',
  '/api/runs/{}/steer': 'the run command surface — not this row',
  '/api/runs/{}/retry': 'the run command surface — not this row',
  '/api/runs/{}/cancel': 'the run command surface — not this row',
};

/**
 * The routes that answer an anonymous caller with something other than 401, and why.
 *
 * Both directions are asserted: a path here that turns out to be guarded fails (the list is stale),
 * and a served path *not* here that does not answer 401 fails (a route lost its guard). That second
 * direction is the one this file exists to keep — an endpoint added without `requirePermission`
 * would otherwise be caught by nothing.
 */
const PUBLIC_PREFIXES: readonly { readonly prefix: string; readonly why: string }[] = [
  {
    prefix: '/api/auth/',
    why: 'Better Auth owns sign-in, sign-out and the session read; a login endpoint that needed a session could never be used',
  },
  { prefix: '/api/version', why: 'build metadata, and the SPA reads it before anybody signs in' },
];

/** Files git knows about under `apps/web/src`, tracked and untracked alike (standing rule 85). */
const webSourceFiles = (): string[] => {
  const git = (args: readonly string[]): string[] =>
    execFileSync('git', [...args], { cwd: repositoryRoot, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.length > 0);
  const tracked = git(['ls-files', '--', WEB_SOURCES]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', WEB_SOURCES]);
  return [...new Set([...tracked, ...untracked])].filter(
    (path) =>
      (path.endsWith('.ts') || path.endsWith('.tsx')) &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('.test.tsx'),
  );
};

/** Strips block comments and comment-only lines, so prose about an endpoint is not a call to one. */
export const withoutComments = (source: string): string =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');

/** A quoted literal beginning `/api/`, in any of the three quote styles. */
const API_PATH = /(['"`])(\/api\/[^'"`]*)\1/g;

/**
 * `/api/runs/${seg(runId)}/messages` → `/api/runs/{}/messages`.
 *
 * The interpolations become one opaque token so that the client's `${id}` and the server's
 * `:run_id` are the same path. A trailing slash is dropped for the same reason.
 */
export const normalisePath = (path: string): string =>
  path
    .replaceAll(/\$\{[^}]*\}/g, '{}')
    .replace(/\/$/, '')
    .replace(/\?.*$/, '');

export const clientPaths = (files: readonly { path: string; source: string }[]): string[] => {
  const found = new Set<string>();
  for (const file of files) {
    for (const [, , path] of withoutComments(file.source).matchAll(API_PATH)) {
      if (path !== undefined) {
        found.add(normalisePath(path));
      }
    }
  }
  return [...found].sort();
};

/** A syntactically valid id for every `{}`, so a route's own `z.uuid()` params validate. */
const PROBE_ID = '00000000-0000-4000-8000-000000000000';
const probeUrl = (path: string): string => path.replaceAll('{}', PROBE_ID);

const anonymousAuth = {
  api: { getSession: async () => null },
  handler: async () => new Response('{}', { status: 200 }),
} as unknown as Auth;

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    config: loadServerConfig({
      DATABASE_URL: 'postgres://app:app@db:5432/app',
      APP_SECRET_KEY: 'x'.repeat(40),
      APP_BASE_URL: 'http://localhost:8080',
    }),
    logger: createLogger({ level: 'silent', format: 'json', role: 'all' }),
    metrics: createMetrics({ defaultMetrics: false }),
    // No database is needed: every guarded route refuses an anonymous caller in a preHandler,
    // which is exactly the probe below. A route that reached the database here would be a route
    // with no guard — and that is the failure the auth half of this census reports.
    database: {} as Database,
    auth: anonymousAuth,
    hub: new SseHub({
      bufferSize: 4,
      maxQueuedFrames: 8,
      maxTopicsPerConnection: 4,
      maxBufferedTopics: 8,
      retryMs: 1_000,
      pingIntervalMs: 0,
      maxConnections: 2,
      shutdownDrainMs: 100,
    }),
    webhooks: null,
    // The commands a process with no pipeline composes: the routes are still registered and still
    // refuse an anonymous caller, which is what this census probes (the 503 is behind the guard).
    knowledge: null,
    version: { version: '0.0.0-test', commit: null, builtAt: null },
    readiness: async () => ({ status: 'ok', checks: {} }),
    isShuttingDown: () => false,
  });
});

afterAll(async () => {
  await app?.close();
});

interface Probe {
  readonly path: string;
  readonly served: boolean;
  readonly status: number;
  readonly code: string | null;
}

/**
 * Asks the router, through a real request.
 *
 * "Not served" is the not-found handler's **own** body (`app.ts`'s `setNotFoundHandler`), not a bare
 * 404: a route that exists and answers 404 — `GET /api/runs/<unknown>` does — must not be read as a
 * route that does not exist. A command route is registered for POST only, so a path that answers
 * not-found to GET is asked again with POST before it is called missing.
 */
const probe = async (path: string): Promise<Probe> => {
  const url = probeUrl(path);
  for (const method of ['GET', 'POST'] as const) {
    const response = await app.inject({ method, url });
    const body = response.json() as { error?: { code?: string } };
    const code = body.error?.code ?? null;
    const missing = response.statusCode === 404 && code === 'not_found';
    if (!missing) {
      return { path, served: true, status: response.statusCode, code };
    }
  }
  return { path, served: false, status: 404, code: 'not_found' };
};

describe('the client’s endpoint list against the server’s router', () => {
  it('finds the client’s paths on disk, including a file that is not committed yet', () => {
    // The scope, asserted before anything is concluded from it (standing rule 4): a census whose
    // sweep found nothing would report a perfectly clean result.
    const files = webSourceFiles();
    expect(files).toContain('apps/web/src/api/endpoints.ts');
    expect(files.length).toBeGreaterThan(20);
    // Test files are out of scope by suffix, not by name: `api/http.test.ts` calls `/api/thing`.
    expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false);

    const paths = clientPaths(
      files.map((path) => ({ path, source: readFileSync(join(repositoryRoot, path), 'utf8') })),
    );
    expect(paths).toContain('/api/runs/{}/messages');
    expect(paths).toContain('/api/auth/get-session');
    // …and a path that appears only in a docblock is not a path the app calls.
    expect(paths).not.toContain('/api/org/stats');
  });

  it('serves every path the client names, or admits the gap with the row that owns it', async () => {
    const paths = clientPaths(
      webSourceFiles().map((path) => ({
        path,
        source: readFileSync(join(repositoryRoot, path), 'utf8'),
      })),
    );
    const probes = await Promise.all(paths.map(probe));
    const missing = probes.filter((entry) => !entry.served).map((entry) => entry.path);

    // Direction 1 — a path the client calls that nothing serves and nobody owns. This is the
    // failure backlog 29 describes, and the message names the path so the next reader does not
    // have to diff two lists by eye.
    expect(missing.filter((path) => ADMITTED_GAPS[path] === undefined)).toEqual([]);

    // Direction 2 — an admitted gap that is no longer a gap, or was never a path the client names.
    // Without this the list would be a filter that silently outlives what it excuses.
    const served = new Set(probes.filter((entry) => entry.served).map((entry) => entry.path));
    const known = new Set(paths);
    expect(
      Object.keys(ADMITTED_GAPS).filter((path) => served.has(path) || !known.has(path)),
    ).toEqual([]);
  });

  it('serves this iteration’s five endpoints', async () => {
    // Named positively as well, because "not in the gap list" is satisfied by a path the sweep
    // failed to find at all (standing rule 10: assert which branch ran).
    for (const path of [
      '/api/tasks/{}',
      '/api/runs/{}',
      '/api/runs/{}/messages',
      '/api/runs/{}/prompt',
      '/api/runs/{}/context-pack',
    ]) {
      expect((await probe(path)).served, path).toBe(true);
    }
  });

  it('serves the four knowledge endpoints WP-18b took off the gap list', async () => {
    for (const path of [
      '/api/projects/{}/kb/tree',
      '/api/projects/{}/kb/doc',
      '/api/projects/{}/kb/proposals',
      '/api/projects/{}/kb/proposals/{}/{}',
    ]) {
      expect((await probe(path)).served, path).toBe(true);
    }
  });

  it('serves the seven reads WP-15h part 2 took off the gap list', async () => {
    // The other direction of the equality above, named (standing rule 10): "not in the gap list"
    // is also satisfied by a path the client sweep failed to find at all.
    for (const path of [
      '/api/org/agents',
      '/api/org/inbox',
      '/api/integrations',
      '/api/integrations/{}/setup-guide',
      '/api/projects',
      '/api/projects/{}/readiness',
      '/api/projects/{}/tasks',
    ]) {
      expect((await probe(path)).served, path).toBe(true);
    }
  });

  it('serves the kb health read no client calls, which is why the census cannot see it', async () => {
    // `GET /api/projects/:id/kb/health` reads `kb_health_reports` (WP-18b, migration 0018) and no
    // screen asks for it, so it appears in neither half of the comparison above — this census is
    // driven by the client's calls. It is a criterion on WP-15h's plan row (PROGRESS backlog 37)
    // and therefore asserted here by hand, including the 401 its siblings get automatically.
    const probed = await probe('/api/projects/{}/kb/health');
    expect(probed.served).toBe(true);
    expect(probed.status).toBe(401);
    expect(probed.code).toBe('unauthenticated');

    const paths = clientPaths(
      webSourceFiles().map((path) => ({
        path,
        source: readFileSync(join(repositoryRoot, path), 'utf8'),
      })),
    );
    expect(paths).not.toContain('/api/projects/{}/kb/health');
  });

  it('refuses an anonymous caller on every served path that is not deliberately public', async () => {
    const paths = clientPaths(
      webSourceFiles().map((path) => ({
        path,
        source: readFileSync(join(repositoryRoot, path), 'utf8'),
      })),
    );
    const probes = (await Promise.all(paths.map(probe))).filter((entry) => entry.served);
    const isPublic = (path: string): boolean =>
      PUBLIC_PREFIXES.some((entry) => path.startsWith(entry.prefix));

    // Every guarded path, per route rather than once — and on the *code*, not only the status, so
    // a 401 produced by something other than the auth guard would still have to be explained.
    expect(
      probes
        .filter((entry) => !isPublic(entry.path))
        .filter((entry) => entry.status !== 401 || entry.code !== 'unauthenticated')
        .map((entry) => `${entry.path} -> ${entry.status} ${entry.code}`),
    ).toEqual([]);

    // And the other direction: a prefix listed as public that is in fact guarded is a stale list.
    expect(
      probes.filter((entry) => isPublic(entry.path) && entry.status === 401).map((e) => e.path),
    ).toEqual([]);
    expect(probes.some((entry) => isPublic(entry.path))).toBe(true);
    expect(probes.some((entry) => !isPublic(entry.path))).toBe(true);
  });
});

describe('the census’s own instruments', () => {
  it('reads a path out of every quote style and normalises the interpolation away', () => {
    const source = [
      "client.get('/api/org/users')",
      'client.get(`/api/runs/${seg(id)}/messages`)',
      'fetch("/api/projects/" )',
    ].join('\n');
    expect(clientPaths([{ path: 'x.ts', source }])).toEqual([
      '/api/org/users',
      '/api/projects',
      '/api/runs/{}/messages',
    ]);
  });

  it('ignores a path that is only written about', () => {
    const source = [
      '/**',
      ' * Calls `/api/org/stats` one day.',
      ' */',
      "// also '/api/nope'",
      "const real = '/api/version';",
    ].join('\n');
    expect(clientPaths([{ path: 'x.ts', source }])).toEqual(['/api/version']);
  });
});
