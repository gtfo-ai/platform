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
 * endpoint), and a path in a comment (block comments and comment-only lines are stripped, which
 * the first case below asserts over `clientPaths` itself — it used to be asserted against
 * `endpoints.ts`'s docblock naming `GET /api/org/stats`, and WP-41 made the app a real caller of
 * that path). It also says nothing about the *shape* either side expects; that is
 * `packages/contracts`, which both import.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Auth } from '../auth/better-auth.js';
import { loadServerConfig } from '../config.js';
import { createLogger } from '../logging.js';
import { createMetrics } from '../metrics.js';
import type { Database } from '../queries/identity-queries.js';
import { SseHub } from '../sse/hub.js';
import { repositoryRoot, webSourceFiles, withoutComments } from './web-sources.js';

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
  // **Empty, and it is meant to stay that way.** Twelve commands were listed here until WP-15i;
  // eleven landed with that row and the twelfth — `POST /api/runs/:id/steer` — landed with WP-27,
  // which is why this object is now empty rather than one line shorter. Every path the client names
  // is served, and both directions of the comparison below are asserted, so a new client call with
  // no route fails here whether or not anybody remembers to add an entry.
  //
  // **The wizard's seven were never on this list**, which is worth saying because a list of
  // commands reads as if it were about all of them. WP-21 added the client's calls and the
  // server's routes in one change, so the two halves were never out of step and there was nothing
  // to admit; they too are asserted positively below.
  //
  // What this census **cannot** see is unchanged and is asserted by hand further down: a route no
  // screen calls. There are three paths — `GET /api/projects/:id/kb/health` (WP-15h part 2), and
  // WP-27's `take-over` and `hand-back`, whose buttons are a UI row of their own. WP-31's
  // `/api/org/identities` pair was the fourth until WP-43 gave it a screen (the settings page's
  // "Provider identities"), so the comparison above now sees it; the per-method case below says so.
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
    onboarding: null,
    // WP-34: no pipeline here, so the batch command refuses by name and the gate cannot answer.
    shadow: null,
    shadowGate: null,
    historyBootstrap: null,
    historyBootstrapGate: null,
    commands: null,
    // WP-31: no pipeline here, so the ask command refuses by name; the reads answer nothing.
    asks: {
      commands: null,
      queries: { listAsks: async () => [], taskAudit: async () => [] },
    },
    // WP-40: no pipeline store here, so the decision refuses by name and the queue reads empty.
    breakdown: null,
    version: { version: '0.0.0-test', commit: null, builtAt: null },
    readiness: async () => ({ status: 'ok', checks: {} }),
    isShuttingDown: () => false,
  });
});

afterAll(async () => {
  await app?.close();
});

/** The shape of every error body this server sends (`apiErrorSchema`). */
interface ApiErrorBody {
  readonly error?: { readonly code?: string };
}

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
 * route that does not exist. A command route is registered for one method only, so a path that
 * answers not-found to GET is asked again with POST and then with **PUT** before it is called
 * missing.
 *
 * `PUT` was added at WP-21 and it was not cosmetic: `PUT /api/projects/:id/bindings` and
 * `PUT /api/projects/:id/config` both have a GET sibling on the same path, so they passed on the
 * *sibling's* answer and this census could not have told a missing PUT from a present one.
 */
const probe = async (path: string): Promise<Probe> => {
  const url = probeUrl(path);
  for (const method of ['GET', 'POST', 'PUT'] as const) {
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
    // …and a path that appears only in a comment is not a path the app calls. This used to be
    // asserted against `/api/org/stats`, which `endpoints.ts` named in a docblock while nothing
    // called it — **WP-41 made the app a caller**, so the assertion moved from an observation about
    // the repository to a case over the function itself, which is stronger and cannot go stale the
    // same way (standing rule 83: closing a gap falsifies the sentence that described it).
    expect(
      clientPaths([
        { path: 'fake.ts', source: '/** names `/api/never-called` */\nconst a = 1;\n' },
        { path: 'fake2.ts', source: '// also /api/never-called-either\nconst b = 2;\n' },
      ]),
    ).toEqual([]);
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

  it('serves the artifact body WP-52 added, and the client calls it', async () => {
    // PROGRESS backlog 85: the task projection published `url: null` as a literal and no route
    // served a body, so every artifact on every task screen was a row a reader could see and not
    // open. Named positively **and** matched against the client's own sweep (standing rule 10), and
    // asked for its 401 like every other guarded read — `artifact.read` had been in
    // `PERMISSION_REQUIREMENTS` since WP-04 with no user until this route.
    const probed = await probe('/api/artifacts/{}');
    expect(probed.served).toBe(true);
    expect(probed.status).toBe(401);
    expect(probed.code).toBe('unauthenticated');
    const paths = clientPaths(
      webSourceFiles().map((path) => ({
        path,
        source: readFileSync(join(repositoryRoot, path), 'utf8'),
      })),
    );
    expect(paths).toContain('/api/artifacts/{}');
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

  it('serves the seven onboarding commands WP-21 added', async () => {
    // The wizard's whole surface, named (standing rule 10). Six of the seven **write** — only
    // `…/readiness` is a read, and `…/bindings` is both — so this case is also the other half of
    // the auth assertion below: a command registered without `requirePermission` would answer
    // something other than 401 there.
    for (const path of [
      '/api/projects',
      '/api/integrations',
      '/api/integrations/{}/test',
      '/api/projects/{}/bindings',
      '/api/projects/{}/config',
      '/api/projects/{}/discovery',
      '/api/projects/{}/readiness',
    ]) {
      expect((await probe(path)).served, path).toBe(true);
    }
  });

  it('serves the statistics pair WP-41 added', async () => {
    // Named positively (standing rule 10): "not in the gap list" is also satisfied by a path the
    // client sweep failed to find at all. Two paths rather than one `?format=` parameter, because
    // one of them answers `text/csv` and a route cannot publish two response schemas honestly
    // (`routes/stats.ts` says so).
    for (const path of ['/api/org/stats', '/api/org/stats.csv']) {
      expect((await probe(path)).served, path).toBe(true);
    }
  });

  it('serves the two history-bootstrap endpoints WP-35 added', async () => {
    // Named positively (standing rule 10): "not in the gap list" is also satisfied by a path the
    // client sweep failed to find at all. One path carrying both methods — the read publishes the
    // gate and the estimate the write refuses on, which is what keeps the wizard from offering a
    // button that answers 409.
    expect((await probe('/api/projects/{}/history-bootstraps')).served).toBe(true);
  });

  it('serves the three shadow-mode endpoints WP-34 added', async () => {
    // Named positively (standing rule 10): "not in the gap list" is also satisfied by a path the
    // client sweep failed to find at all. `/api/shadow-batches/{}` is **not** under a project, and
    // that is deliberate — the batch id is what a reader has after starting one.
    for (const path of ['/api/projects/{}/shadow-batches', '/api/shadow-batches/{}']) {
      expect((await probe(path)).served, path).toBe(true);
    }
  });

  it('refuses an anonymous caller on the shadow batch command, by its own method', async () => {
    // POST with **no body at all**, for the reason the wizard's case gives: Fastify validates the
    // body before `preHandler`, so a guard that slipped back to `preHandler` answers 400 here.
    const response = await app.inject({
      method: 'POST',
      url: probeUrl('/api/projects/{}/shadow-batches'),
    });
    const body = response.json() as ApiErrorBody;
    expect(`${response.statusCode} ${body.error?.code ?? ''}`).toBe('401 unauthenticated');
  });

  it('serves the six settings endpoints WP-30 added', async () => {
    // Named positively for standing rule 10's reason, and by their own methods below. Two of them
    // are the first production writers of `budgets`: before WP-30 every budget in existence was a
    // row a test had seeded, so BD-010's org and project caps were inert on a real instance.
    for (const path of [
      '/api/projects/{}/autonomy',
      '/api/projects/{}/budgets',
      '/api/org/budgets',
      '/api/projects/{}/audit',
    ]) {
      expect((await probe(path)).served, path).toBe(true);
    }
  });

  it('refuses an anonymous caller on every settings write, by its own method', async () => {
    // The same hole the wizard's commands have — Fastify validates the body before `preHandler` —
    // asked with **no body at all**, so a guard that slipped back answers 400 and fails here.
    for (const [method, path] of [
      ['PUT', '/api/projects/{}/autonomy'],
      ['PUT', '/api/projects/{}/budgets'],
      ['PUT', '/api/org/budgets'],
    ] as const) {
      const response = await app.inject({ method, url: probeUrl(path) });
      const body = response.json() as ApiErrorBody;
      expect(`${method} ${path} -> ${response.statusCode} ${body.error?.code ?? ''}`).toBe(
        `${method} ${path} -> 401 unauthenticated`,
      );
    }
  });

  it('refuses an anonymous caller on every wizard command, by its own method', async () => {
    /**
     * Two holes this closes, both found by the WP-21 review and by this case itself.
     *
     * **The method.** `probe()` tried GET then POST, so a path with a GET sibling —
     * `…/bindings` and `…/config` both have one — was reported "served" whatever happened to its
     * PUT, and the anonymous-401 sweep below judged it on the sibling's answer.
     *
     * **The hook.** Asked by its own method, `PUT …/bindings` answered **400** rather than 401:
     * Fastify validates the body before `preHandler`, so an unauthenticated caller was told the
     * route's shape before being refused. The guards moved to `preValidation`, which is exactly
     * what `routes/kb.ts` did for a query parameter. A route that slips back fails here.
     */
    for (const [method, path] of [
      ['POST', '/api/projects'],
      ['POST', '/api/integrations'],
      ['POST', '/api/integrations/{}/test'],
      ['PUT', '/api/projects/{}/bindings'],
      ['PUT', '/api/projects/{}/config'],
      ['POST', '/api/projects/{}/discovery'],
    ] as const) {
      const response = await app.inject({ method, url: probeUrl(path) });
      const body = response.json() as { error?: { code?: string } };
      expect(`${method} ${path} -> ${response.statusCode} ${body.error?.code ?? ''}`).toBe(
        `${method} ${path} -> 401 unauthenticated`,
      );
    }
  });

  it('serves the eleven task and run commands WP-15i took off the gap list', async () => {
    // Named positively, and this is the case that makes the gap list's shrinking mean something:
    // the equality above is also satisfied by a path the client sweep failed to find (standing
    // rule 10). Eleven, not twelve — `…/steer` is WP-27's and has its own case below.
    for (const path of [
      '/api/tasks/{}/pause',
      '/api/tasks/{}/resume',
      '/api/tasks/{}/cancel',
      '/api/tasks/{}/retry-stage',
      '/api/tasks/{}/return-to-stage',
      '/api/tasks/{}/rework',
      '/api/tasks/{}/feedback',
      '/api/tasks/{}/questions/{}/answer',
      '/api/tasks/{}/approvals/{}/decide',
      '/api/runs/{}/retry',
      '/api/runs/{}/cancel',
    ]) {
      expect((await probe(path)).served, path).toBe(true);
    }
  });

  it('refuses an anonymous caller on every command, by POST and before validating the body', async () => {
    /**
     * The hole this closes is the one WP-21's review found for the wizard, one family later: these
     * routes all take a **body**, and Fastify validates it before `preHandler` — so a guard in the
     * wrong position answers an anonymous caller `400` describing the route's shape instead of
     * `401`. Every command below is therefore asked by its own method with **no body at all**: a
     * route whose guard slipped back to `preHandler` fails here with a 400.
     */
    for (const path of [
      '/api/tasks/{}/pause',
      '/api/tasks/{}/resume',
      '/api/tasks/{}/cancel',
      '/api/tasks/{}/retry-stage',
      '/api/tasks/{}/return-to-stage',
      '/api/tasks/{}/rework',
      '/api/tasks/{}/feedback',
      '/api/tasks/{}/questions/{}/answer',
      '/api/tasks/{}/approvals/{}/decide',
      '/api/runs/{}/retry',
      '/api/runs/{}/cancel',
    ]) {
      const response = await app.inject({ method: 'POST', url: probeUrl(path) });
      const body = response.json() as { error?: { code?: string } };
      expect(`POST ${path} -> ${response.statusCode} ${body.error?.code ?? ''}`).toBe(
        `POST ${path} -> 401 unauthenticated`,
      );
    }
  });

  it('serves the steer command WP-27 took off the gap list — the last entry on it', async () => {
    // The twelfth command, and the one that needed a different work package rather than a later
    // iteration: it pushes a user turn into a **live session**, which is why WP-15i left it here.
    // Asserted positively for standing rule 10's reason, and by POST because a GET would answer
    // not-found and the probe would then be judging the wrong method.
    const probed = await probe('/api/runs/{}/steer');
    expect(probed.served).toBe(true);
    const response = await app.inject({ method: 'POST', url: probeUrl('/api/runs/{}/steer') });
    expect(`${response.statusCode} ${(response.json() as ApiErrorBody).error?.code ?? ''}`).toBe(
      '401 unauthenticated',
    );
  });

  it('serves take-over and hand-back, which no screen calls yet and this census cannot see', async () => {
    // technical/08:17 names both and `apps/web/src/api/endpoints.ts` calls neither: the SPA's own
    // docblock says why it declined to build the buttons, and WP-27 supplies the half it was
    // waiting for (`takeOverResponseSchema`). A client-driven comparison is blind to a route with
    // no caller, so — exactly like `kb/health` — they are asserted here by hand, with the 401 their
    // siblings get automatically.
    const paths = clientPaths(
      webSourceFiles().map((path) => ({
        path,
        source: readFileSync(join(repositoryRoot, path), 'utf8'),
      })),
    );
    for (const path of ['/api/tasks/{}/take-over', '/api/tasks/{}/hand-back']) {
      const probed = await probe(path);
      expect(probed.served, path).toBe(true);
      expect(probed.status, path).toBe(401);
      expect(probed.code, path).toBe('unauthenticated');
      expect(paths, path).not.toContain(path);
    }
  });

  it('serves the three ask-the-task paths WP-31 added, and the client calls all three', async () => {
    // Criterion 7's other half. `POST /api/tasks/:id/ask` was the route this census was blind to by
    // construction — the SPA did not call it — and `features/ask-thread.tsx` is what changed that,
    // so the comparison above now covers all three. They are named here positively as well, because
    // a route that leaves the client's list would otherwise drop silently out of both halves at
    // once (the shape `serves the seven reads WP-15h part 2 took off the gap list` already uses).
    const paths = clientPaths(
      webSourceFiles().map((path) => ({
        path,
        source: readFileSync(join(repositoryRoot, path), 'utf8'),
      })),
    );
    for (const path of ['/api/tasks/{}/ask', '/api/tasks/{}/asks', '/api/tasks/{}/audit']) {
      const probed = await probe(path);
      expect(probed.served, path).toBe(true);
      expect(probed.status, path).toBe(401);
      expect(probed.code, path).toBe('unauthenticated');
      expect(paths, path).toContain(path);
    }
  });

  it('serves the identity pair the settings page calls, by each of its own methods', async () => {
    // `POST /api/org/identities` is the writer `user_identities` had never had (WP-31, PROGRESS
    // backlog 79) and `GET` is the list beside it. **No screen called either until WP-43**, which
    // is what left every chat decision `unmapped_identity`; the settings page's identity section
    // (`features/identities.tsx`) calls both now, and the last assertion below is the inverted
    // form of the one that used to hold it absent. Asked **by each method**, because `probe()` tries GET first and would
    // otherwise judge the POST on its sibling's answer (the hole WP-21's review found), and with
    // **no body at all**, because the write's guard is a `preValidation` hook: one that slipped
    // back to `preHandler` would answer `400` describing the route's shape instead of `401`.
    const probed = await probe('/api/org/identities');
    expect(probed.served).toBe(true);
    expect(probed.status).toBe(401);
    expect(probed.code).toBe('unauthenticated');
    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({ method, url: '/api/org/identities' });
      const body = response.json() as ApiErrorBody;
      expect(`${method} -> ${response.statusCode} ${body.error?.code ?? ''}`).toBe(
        `${method} -> 401 unauthenticated`,
      );
    }

    const paths = clientPaths(
      webSourceFiles().map((path) => ({
        path,
        source: readFileSync(join(repositoryRoot, path), 'utf8'),
      })),
    );
    // The screen calls it — the inverse of the pre-WP-43 assertion, so a screen that lost the call
    // fails here rather than quietly returning the product to `unmapped_identity`.
    expect(paths).toContain('/api/org/identities');
  });

  it('serves the two breakdown paths no screen calls, by each of their own methods', async () => {
    // WP-40's acceptance surface. No SPA screen calls either yet, so the comparison above is blind
    // to both by construction — the position `kb/health`, `take-over` and `hand-back` are in.
    // Asked **by each method**, because `probe()` tries GET first and would otherwise judge the
    // POST on its sibling's answer, and with **no body at all** on the write, because its guard is
    // a `preValidation` hook: one that slipped back to `preHandler` would answer 400 describing the
    // route's shape instead of 401 (the hole WP-21's review found for the wizard).
    for (const path of ['/api/tasks/{}/breakdown', '/api/tasks/{}/breakdown/decide']) {
      const probed = await probe(path);
      expect(probed.served, path).toBe(true);
    }
    for (const [method, path] of [
      ['GET', '/api/tasks/{}/breakdown'],
      ['POST', '/api/tasks/{}/breakdown/decide'],
    ] as const) {
      const response = await app.inject({ method, url: probeUrl(path) });
      const body = response.json() as ApiErrorBody;
      expect(`${method} ${path} -> ${response.statusCode} ${body.error?.code ?? ''}`).toBe(
        `${method} ${path} -> 401 unauthenticated`,
      );
    }

    const paths = clientPaths(
      webSourceFiles().map((path) => ({
        path,
        source: readFileSync(join(repositoryRoot, path), 'utf8'),
      })),
    );
    expect(paths).not.toContain('/api/tasks/{}/breakdown');
    expect(paths).not.toContain('/api/tasks/{}/breakdown/decide');
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
