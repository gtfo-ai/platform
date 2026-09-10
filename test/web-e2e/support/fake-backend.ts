/**
 * The fake backend the Playwright suite runs against (WP-20 acceptance: "Playwright e2e with fake
 * SSE").
 *
 * One Node HTTP server serves three things on **one origin**, because that is what technical/08
 * specifies and what makes the session cookie and the CSRF rule mean anything:
 *
 *  1. `/api/*` — the endpoint table of technical/08, answering the fixtures of `fixtures.ts`;
 *  2. `/events` — the multiplexed SSE stream of TD-014, driven by the test rather than by a
 *     pipeline;
 *  3. everything else — the built SPA from `apps/web/dist`, with an SPA fallback.
 *
 * ### It is stricter than the real server, never kinder (standing rule 1)
 *
 * The CSRF rule of `apps/server/src/auth/plugin.ts` is enforced here in the same shape: a mutating
 * request that carries a session cookie must also carry an `Origin` this server trusts **and** the
 * `X-Requested-With` header. A fake that skipped it would let the client forget the header and
 * every Playwright test would still pass, which is precisely the class of defect the rule exists
 * for. Unknown paths are 404 with the documented problem shape rather than a friendly empty
 * object.
 *
 * ### What the test can drive
 *
 * `POST /__test__/publish` writes one frame to every stream subscribed to a topic, and
 * `POST /__test__/control` writes a `reset` or a `shutdown`. `GET /__test__/streams` reports the
 * query string of every `GET /events` this server has seen, which is how the suite proves a
 * reconnect carried `last_event_id` rather than assuming it. These paths exist only in this file
 * and are the reason it lives under `test/`.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SseFrame } from '@platform/contracts';
import {
  cancelRunRequestSchema,
  cancelTaskRequestSchema,
  pauseTaskRequestSchema,
  resumeTaskRequestSchema,
  retryRunRequestSchema,
  retryStageRequestSchema,
  returnToStageRequestSchema,
  reworkRequestSchema,
  steerRunRequestSchema,
  submitFeedbackRequestSchema,
} from '@platform/contracts';
import * as fixtures from './fixtures.js';

/**
 * The published request schema of every command this server accepts.
 *
 * Parsed rather than waved through, because a fake must be **stricter** than the real adapter and
 * never kinder (standing rule 1): the real server parses the body with exactly these schemas, so a
 * client that sends `{stage}` where `{stage, reason}` is required must fail here too. Waving the
 * body through would let a Playwright test "prove" a command works while the real server 400s it.
 */
const TASK_COMMAND_SCHEMAS = {
  pause: pauseTaskRequestSchema,
  resume: resumeTaskRequestSchema,
  cancel: cancelTaskRequestSchema,
  'retry-stage': retryStageRequestSchema,
  'return-to-stage': returnToStageRequestSchema,
  rework: reworkRequestSchema,
  feedback: submitFeedbackRequestSchema,
} as const;

/** Just enough of zod's surface to parse a body; `zod` itself is not a dependency of `test/`. */
type SafeParse = (
  value: unknown,
) =>
  | { success: true; data: unknown }
  | { success: false; error: { issues: { message: string }[] } };

const RUN_COMMAND_SCHEMAS = {
  steer: steerRunRequestSchema,
  cancel: cancelRunRequestSchema,
  retry: retryRunRequestSchema,
} as const;

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const DIST = resolve(repositoryRoot, 'apps/web/dist');

const SESSION_COOKIE = 'session';
const SESSION_VALUE = 'fake-session-token';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

interface Stream {
  readonly connectionId: string;
  readonly response: ServerResponse;
  /**
   * Mutable, because `POST /events/subscriptions` changes it — which the real hub supports
   * (`SseHub.updateSubscriptions`). A fake that ignored the endpoint would silently stop
   * delivering the moment the SPA navigated between screens, and the suite would "prove" the
   * stream works by never asking it to.
   */
  readonly topics: Set<string>;
  readonly partials: boolean;
}

export interface FakeBackend {
  readonly server: Server;
  readonly url: string;
  readonly close: () => Promise<void>;
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
};

const problem = (response: ServerResponse, status: number, code: string, message: string): void => {
  json(response, status, { error: { code, message } });
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const hasSession = (request: IncomingMessage): boolean =>
  (request.headers.cookie ?? '').includes(`${SESSION_COOKIE}=${SESSION_VALUE}`);

/**
 * `apps/server/src/auth/plugin.ts` § `csrfViolation`, reproduced.
 *
 * Same three clauses in the same order: safe methods pass, a request with no session cookie is not
 * a cross-site *authenticated* request, and everything else needs a trusted `Origin` and the
 * custom header.
 */
export const csrfViolation = (input: {
  readonly method: string;
  readonly origin: string | undefined;
  readonly requestedWith: string | undefined;
  readonly hasSessionCookie: boolean;
  readonly trustedOrigin: string;
}): string | null => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(input.method.toUpperCase())) {
    return null;
  }
  if (!input.hasSessionCookie) {
    return null;
  }
  if (input.origin === undefined || input.origin !== input.trustedOrigin) {
    return `Origin ${input.origin ?? '(absent)'} is not trusted`;
  }
  if (input.requestedWith !== 'XMLHttpRequest') {
    return 'the x-requested-with header is required on mutating requests';
  }
  return null;
};

export const createFakeBackend = async (port = 0): Promise<FakeBackend> => {
  const streams = new Set<Stream>();
  /** Every `GET /events` query string, oldest first — the reconnect evidence. */
  const connects: string[] = [];
  /** Mutated by the answer command so the suite can prove the command reached the server. */
  const answeredQuestions = new Set<string>();
  /** Appended by `POST /__test__/add-task`; see there. */
  const extraTasks: (typeof fixtures.tasksPage)['items'] = [];
  /**
   * Every command this server accepted, oldest first.
   *
   * A command whose only visible effect is a row the fixtures do not serve — retry-stage, rework,
   * feedback — is otherwise unprovable from the browser: the screen would look the same whether
   * the POST arrived or not. `GET /__test__/commands` is what turns "the button was clicked" into
   * "the server received this body".
   */
  const commands: { path: string; body: unknown }[] = [];

  const writeFrame = (stream: Stream, frame: SseFrame, event: string): void => {
    const lines: string[] = [];
    if (frame.frame !== 'control') {
      lines.push(`id: ${frame.topic}:${frame.seq}`);
    }
    lines.push(`event: ${event}`);
    lines.push(`data: ${JSON.stringify(frame)}`);
    stream.response.write(`${lines.join('\n')}\n\n`);
  };

  const publish = (topic: string, frame: SseFrame, event: string): number => {
    let delivered = 0;
    for (const stream of streams) {
      if (!stream.topics.has(topic)) {
        continue;
      }
      writeFrame(stream, frame, event);
      delivered += 1;
    }
    return delivered;
  };

  const serveStatic = (response: ServerResponse, pathname: string): void => {
    const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    const candidate = join(DIST, relative);
    const file =
      candidate.startsWith(DIST) && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : join(DIST, 'index.html');
    if (!existsSync(file)) {
      problem(
        response,
        500,
        'bundle_missing',
        `${DIST} has no index.html; run \`pnpm --filter @platform/web run build\` first`,
      );
      return;
    }
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      problem(response, 500, 'fake_backend_error', String(error));
    });
  });

  const origin = (): string => `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', origin());
    const path = url.pathname;
    const method = (request.method ?? 'GET').toUpperCase();

    if (path.startsWith('/api/') || path.startsWith('/events') || path.startsWith('/__test__/')) {
      const violation = csrfViolation({
        method,
        origin: request.headers.origin,
        requestedWith: request.headers['x-requested-with'] as string | undefined,
        hasSessionCookie: hasSession(request),
        trustedOrigin: origin(),
      });
      // The test control endpoints are called from Node, not from the page, so they carry no
      // cookie and the rule lets them through by its first two clauses.
      if (violation !== null && !path.startsWith('/__test__/')) {
        problem(response, 403, 'forbidden', `cross-site request: ${violation}`);
        return;
      }
    }

    // ── Test control ─────────────────────────────────────────────────────────
    if (path === '/__test__/publish' && method === 'POST') {
      const body = (await readBody(request)) as { topic: string; frame: SseFrame; event: string };
      json(response, 200, { delivered: publish(body.topic, body.frame, body.event) });
      return;
    }
    if (path === '/__test__/control' && method === 'POST') {
      const body = (await readBody(request)) as {
        type: 'reset' | 'shutdown';
        topic?: string | null;
      };
      const frame: SseFrame = {
        frame: 'control',
        topic: body.topic ?? null,
        type: body.type,
        detail: null,
      };
      let delivered = 0;
      for (const stream of streams) {
        writeFrame(stream, frame, body.type);
        delivered += 1;
      }
      json(response, 200, { delivered });
      return;
    }
    if (path === '/__test__/add-task' && method === 'POST') {
      // Changes what the next fetch of the board returns, so a `reset` that causes a refetch is
      // provable by a positive assertion (a third card appears) rather than by "nothing broke".
      extraTasks.push({
        ...fixtures.bugTask,
        id: '00000000-0000-4000-8000-000000000022',
        ticket: {
          provider: 'jira',
          key: 'DEMO-3',
          url: 'https://tickets.example.invalid/browse/DEMO-3',
        },
        state: 'queued',
        current_stage: null,
      });
      json(response, 200, { tasks: fixtures.tasksPage.items.length + extraTasks.length });
      return;
    }
    if (path === '/__test__/reset' && method === 'POST') {
      // One server serves the whole run (`workers: 1`), so state a test wrote — an answered
      // question, an added task — would otherwise decide what the *next* test sees. Every spec
      // resets first, which is what makes each test's precondition its own.
      answeredQuestions.clear();
      extraTasks.length = 0;
      connects.length = 0;
      commands.length = 0;
      json(response, 200, { reset: true });
      return;
    }
    if (path === '/__test__/streams' && method === 'GET') {
      json(response, 200, { open: streams.size, connects });
      return;
    }
    if (path === '/__test__/commands' && method === 'GET') {
      json(response, 200, { commands });
      return;
    }
    if (path === '/__test__/drop-streams' && method === 'POST') {
      for (const stream of streams) {
        stream.response.end();
      }
      streams.clear();
      json(response, 200, { open: 0 });
      return;
    }

    // ── Auth (Better Auth's routes, in the shape the client calls them) ───────
    if (path === '/api/auth/get-session') {
      // The session lives in the **cookie**, not in a flag on this server. A flag would be shared
      // by every browser context Playwright creates, so one test signing in would sign every other
      // test in — and each of them would then be asserting against a state it never established.
      json(
        response,
        200,
        hasSession(request)
          ? { session: { id: fixtures.IDS.session }, user: fixtures.orgUsers.items[0] }
          : null,
      );
      return;
    }
    if (path === '/api/auth/sign-in/email' && method === 'POST') {
      const body = (await readBody(request)) as { email?: string; password?: string };
      if (
        body.email !== fixtures.CREDENTIALS.email ||
        body.password !== fixtures.CREDENTIALS.password
      ) {
        problem(response, 401, 'invalid_credentials', 'Invalid email or password');
        return;
      }
      response.setHeader(
        'set-cookie',
        `${SESSION_COOKIE}=${SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax`,
      );
      json(response, 200, { redirect: false });
      return;
    }
    if (path === '/api/auth/sign-out' && method === 'POST') {
      response.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
      json(response, 200, { success: true });
      return;
    }

    // Everything below `/api/` and the stream itself need a session, exactly as the real server's
    // RBAC middleware and `requireSession` in `sse/routes.ts` do.
    if ((path.startsWith('/api/') || path.startsWith('/events')) && !hasSession(request)) {
      problem(response, 401, 'unauthorized', 'a session is required');
      return;
    }

    // ── SSE ──────────────────────────────────────────────────────────────────
    if (path === '/events' && method === 'GET') {
      connects.push(url.search);
      const topics = new Set((url.searchParams.get('topics') ?? '').split(',').filter(Boolean));
      const connectionId = url.searchParams.get('connection_id') ?? '';
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      response.write('retry: 200\n\n');
      // The real hub writes a synthetic `ping` frame when a connection has nothing to replay
      // (`sse/hub.ts`, obligation 16), which is how a client learns the stream is alive before
      // anything happens on it. A fake that stayed silent would be kinder than the server.
      response.write(
        `event: ping\ndata: ${JSON.stringify({ frame: 'control', topic: null, type: 'ping', detail: null })}\n\n`,
      );
      const stream: Stream = {
        connectionId,
        response,
        topics,
        partials: url.searchParams.get('partials') !== '0',
      };
      streams.add(stream);
      request.on('close', () => {
        streams.delete(stream);
      });
      return;
    }
    if (path === '/events/subscriptions' && method === 'POST') {
      const body = (await readBody(request)) as {
        connection_id: string;
        add?: string[];
        remove?: string[];
      };
      const stream = [...streams].find((item) => item.connectionId === body.connection_id);
      if (stream === undefined) {
        problem(response, 404, 'not_found', `no open stream with id ${body.connection_id}`);
        return;
      }
      for (const topic of body.remove ?? []) {
        stream.topics.delete(topic);
      }
      for (const topic of body.add ?? []) {
        stream.topics.add(topic);
      }
      json(response, 200, { connection_id: body.connection_id, topics: [...stream.topics] });
      return;
    }

    // ── REST ─────────────────────────────────────────────────────────────────
    const answerMatch = /^\/api\/tasks\/([^/]+)\/questions\/([^/]+)\/answer$/.exec(path);
    if (answerMatch !== null && method === 'POST') {
      answeredQuestions.add(answerMatch[2] ?? '');
      json(response, 200, {});
      return;
    }
    const taskCommand = /^\/api\/tasks\/[^/]+\/([a-z-]+)$/.exec(path);
    const runCommand = /^\/api\/runs\/[^/]+\/([a-z-]+)$/.exec(path);
    const schema =
      method === 'POST'
        ? ((TASK_COMMAND_SCHEMAS as Record<string, { safeParse: SafeParse } | undefined>)[
            taskCommand?.[1] ?? ''
          ] ??
          (RUN_COMMAND_SCHEMAS as Record<string, { safeParse: SafeParse } | undefined>)[
            runCommand?.[1] ?? ''
          ])
        : undefined;
    if (schema !== undefined) {
      const body = await readBody(request);
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        problem(response, 400, 'invalid_request', parsed.error.issues[0]?.message ?? 'invalid');
        return;
      }
      commands.push({ path, body: parsed.data });
      json(response, 200, {});
      return;
    }
    if (/^\/api\/projects\/[^/]+\/kb\/proposals\/[^/]+\/(approve|reject|edit)$/.test(path)) {
      json(response, 200, {});
      return;
    }

    if (method === 'GET') {
      const withAnswers = {
        ...fixtures.taskDetail,
        questions: fixtures.taskDetail.questions.map((item) =>
          answeredQuestions.has(item.id)
            ? { ...item, status: 'answered' as const, answer: 'three' }
            : item,
        ),
      };
      const routes: Readonly<Record<string, unknown>> = {
        '/api/version': fixtures.version,
        '/api/org/users': fixtures.orgUsers,
        '/api/org/audit': fixtures.audit,
        '/api/org/agents': fixtures.agents,
        '/api/org/inbox': {
          questions: fixtures.inbox.questions.filter((item) => !answeredQuestions.has(item.id)),
          approvals: fixtures.inbox.approvals,
        },
        '/api/integrations': fixtures.integrations,
        '/api/projects': fixtures.projectsPage,
        [`/api/projects/${fixtures.IDS.project}/tasks`]: {
          ...fixtures.tasksPage,
          items: [...fixtures.tasksPage.items, ...extraTasks],
        },
        [`/api/projects/${fixtures.IDS.project}/config`]: fixtures.effectiveConfig,
        [`/api/projects/${fixtures.IDS.project}/budgets`]: fixtures.budgets,
        [`/api/projects/${fixtures.IDS.project}/kb/tree`]: fixtures.kbTree,
        [`/api/projects/${fixtures.IDS.project}/kb/doc`]: fixtures.kbDoc,
        [`/api/projects/${fixtures.IDS.project}/kb/proposals`]: fixtures.kbProposals,
        [`/api/integrations/${fixtures.IDS.integration}/setup-guide`]: fixtures.setupGuide,
        [`/api/tasks/${fixtures.IDS.taskFeature}`]: withAnswers,
        [`/api/tasks/${fixtures.IDS.taskBug}`]: fixtures.bugTaskDetail,
        [`/api/runs/${fixtures.IDS.run}`]: fixtures.run,
        [`/api/runs/${fixtures.IDS.run}/messages`]: fixtures.runMessages,
        [`/api/runs/${fixtures.IDS.run}/prompt`]: fixtures.runPrompt,
        [`/api/runs/${fixtures.IDS.run}/context-pack`]: fixtures.runContextPack,
      };
      const body = routes[path];
      if (body !== undefined) {
        json(response, 200, body);
        return;
      }
    }

    if (path.startsWith('/api/')) {
      problem(response, 404, 'not_found', `${method} ${path} is not part of the fake backend`);
      return;
    }

    serveStatic(response, path);
  };

  await new Promise<void>((resolveListen) => {
    server.listen(port, '127.0.0.1', resolveListen);
  });

  return {
    server,
    url: origin(),
    close: async () => {
      for (const stream of streams) {
        stream.response.end();
      }
      streams.clear();
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
    },
  };
};
