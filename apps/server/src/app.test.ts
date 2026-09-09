import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { Auth } from './auth/better-auth.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { createLogger } from './logging.js';
import { createMetrics } from './metrics.js';
import type { Database } from './queries/identity-queries.js';
import type { ReadinessReport } from './routes/ops.js';
import { SseHub } from './sse/hub.js';

/**
 * The HTTP shell with no database behind it.
 *
 * These are the parts of the surface that hold whatever the database is doing: the two probes, the
 * metrics endpoint, the error mapping and the route table each `ROLE` publishes. The authenticated
 * paths need a real session and a real schema, so they live in the e2e tier.
 */
const config = (overrides: Record<string, string> = {}): ServerConfig =>
  loadServerConfig({
    DATABASE_URL: 'postgres://app:app@db:5432/app',
    APP_SECRET_KEY: 'x'.repeat(40),
    APP_BASE_URL: 'http://localhost:8080',
    ...overrides,
  });

/** Answers "no session" to everything; enough for the unauthenticated paths. */
const anonymousAuth = {
  api: { getSession: async () => null },
  handler: async () => new Response('{}', { status: 200 }),
} as unknown as Auth;

interface Harness {
  app: FastifyInstance;
  hub: SseHub;
  readiness: ReadinessReport;
  /** When set, the readiness check throws it — the only route in this harness that can fail. */
  readinessError: Error | null;
  shuttingDown: boolean;
}

const harnesses: Harness[] = [];

const build = async (
  overrides: Record<string, string> = {},
  auth: Auth = anonymousAuth,
): Promise<Harness> => {
  const harness: Harness = {
    app: undefined as unknown as FastifyInstance,
    hub: new SseHub({
      bufferSize: 8,
      maxQueuedLiveFrames: 16,
      maxTopicsPerConnection: 8,
      retryMs: 1_000,
      pingIntervalMs: 20_000,
      maxConnections: 4,
    }),
    readiness: { status: 'ok', checks: { database: 'ok' } },
    readinessError: null,
    shuttingDown: false,
  };
  harness.app = await buildApp({
    config: config(overrides),
    logger: createLogger({ level: 'silent', format: 'json', role: 'all' }),
    metrics: createMetrics({ defaultMetrics: false }),
    database: {} as Database,
    auth,
    hub: harness.hub,
    version: { version: '1.2.3', commit: 'abc123', builtAt: '2026-09-09T10:00:00Z' },
    readiness: async () => {
      if (harness.readinessError !== null) {
        throw harness.readinessError;
      }
      return harness.readiness;
    },
    isShuttingDown: () => harness.shuttingDown,
  });
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.app.close();
  }
});

describe('ops endpoints', () => {
  it('answers the liveness probe without touching the database', async () => {
    // `database` is an empty object in this harness: if `/healthz` queried anything, it would throw.
    const { app } = await build();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { process: 'ok' } });
  });

  it('answers the readiness probe from the checks it was given', async () => {
    const harness = await build();
    expect((await harness.app.inject({ url: '/readyz' })).statusCode).toBe(200);

    harness.readiness = { status: 'down', checks: { database: 'down', migrations: 'ok' } };
    const down = await harness.app.inject({ url: '/readyz' });
    expect(down.statusCode).toBe(503);
    expect(down.json().checks).toEqual({ database: 'down', migrations: 'ok' });
  });

  it('fails readiness the moment shutdown starts, before anything is closed', async () => {
    // This ordering is what takes the instance out of a load balancer before its connections go.
    const harness = await build();
    harness.shuttingDown = true;
    const response = await harness.app.inject({ url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'down', checks: { shutdown: 'down' } });
  });

  it('reports the build metadata', async () => {
    const { app } = await build();
    expect((await app.inject({ url: '/api/version' })).json()).toEqual({
      version: '1.2.3',
      commit: 'abc123',
      built_at: '2026-09-09T10:00:00Z',
    });
  });
});

describe('/metrics', () => {
  it('serves the Prometheus exposition unauthenticated by default', async () => {
    const { app } = await build();
    const response = await app.inject({ url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('http_request_duration_seconds');
  });

  it('demands basic auth when a credential is configured', async () => {
    const { app } = await build({
      APP_METRICS_USERNAME: 'prom',
      APP_METRICS_PASSWORD: 'a-fake-password',
    });

    const anonymous = await app.inject({ url: '/metrics' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['www-authenticate']).toContain('Basic');

    const wrong = await app.inject({
      url: '/metrics',
      headers: { authorization: `Basic ${Buffer.from('prom:nope').toString('base64')}` },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await app.inject({
      url: '/metrics',
      headers: {
        authorization: `Basic ${Buffer.from('prom:a-fake-password').toString('base64')}`,
      },
    });
    expect(right.statusCode).toBe(200);
  });

  it('observes one histogram sample per request, labelled with the route pattern', async () => {
    const { app } = await build();
    await app.inject({ url: '/api/version' });
    const metrics = await app.inject({ url: '/metrics' });
    expect(metrics.body).toContain(
      'http_request_duration_seconds_count{method="GET",route="/api/version",status_code="200"} 1',
    );
  });

  it('labels an unmatched request `unknown`, never with the path a scanner sent', async () => {
    const { app } = await build();
    await app.inject({ url: '/../../etc/passwd-ish' });
    const metrics = await app.inject({ url: '/metrics' });
    expect(metrics.body).toContain('route="unknown"');
    expect(metrics.body).not.toContain('passwd-ish');
  });
});

describe('error mapping', () => {
  it('answers an unknown path with the published error shape', async () => {
    const { app } = await build();
    const response = await app.inject({ url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'no such endpoint' } });
  });

  it('turns a schema violation into a field-level 400', async () => {
    const { app } = await build();
    // `topics` is required by `eventsQuerySchema`.
    const response = await app.inject({ url: '/events', headers: { accept: 'text/event-stream' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
    expect(Array.isArray(response.json().error.details)).toBe(true);
  });

  it('refuses an unauthenticated guarded route with 401', async () => {
    const { app } = await build();
    const response = await app.inject({ url: '/api/org/users' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthenticated');
  });

  it('never leaks the cause of an unexpected failure to the client', async () => {
    const harness = await build();
    harness.readinessError = new Error('postgres://app:hunter2@db:5432 is unreachable');

    const response = await harness.app.inject({ url: '/readyz' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('hunter2');
    expect(response.json().error.code).toBe('internal_error');
  });
});

describe('ROLE gates the API surface, never the ops surface', () => {
  it('serves only the ops endpoints in a worker', async () => {
    const { app } = await build({ ROLE: 'worker' });
    // A worker container still has to be probeable and scrapeable.
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(200);
    // …but it publishes no API.
    expect((await app.inject({ url: '/api/org/users' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/events?topics=org' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/openapi.json' })).statusCode).toBe(404);
  });

  it('publishes the API in ROLE=api', async () => {
    const { app } = await build({ ROLE: 'api' });
    expect((await app.inject({ url: '/openapi.json' })).statusCode).toBe(200);
  });
});

describe('OpenAPI document', () => {
  it('is generated from the zod route schemas', async () => {
    const { app } = await build();
    const document = (await app.inject({ url: '/openapi.json' })).json();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.version).toBe('1.2.3');
    expect(document.servers).toEqual([{ url: 'http://localhost:8080' }]);
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/healthz', '/readyz', '/metrics', '/api/version', '/events']),
    );
    // A generated document describes the *shape*, not just the path.
    const version = document.paths['/api/version'].get.responses['200'].content['application/json'];
    expect(Object.keys(version.schema.properties).sort()).toEqual([
      'built_at',
      'commit',
      'version',
    ]);
  });
});

describe('graceful shutdown', () => {
  it('drains the event streams from preClose, before the server stops accepting', async () => {
    // TD-002's order: `preClose` ends the streams with a `shutdown` event, and only then does
    // Fastify close the server. Moving this to `onClose` would drain sockets that are already gone.
    const harness = await build();
    const sent: string[] = [];
    let closed = false;
    harness.hub.open({
      id: 'c1',
      userId: 'u1',
      topics: ['org'],
      transport: {
        send: async (message) => {
          sent.push(String(message.event));
        },
        comment: () => {},
        close: () => {
          closed = true;
        },
        get isConnected() {
          return !closed;
        },
      },
    });

    await harness.app.close();
    harnesses.length = 0;

    expect(sent.at(-1)).toBe('shutdown');
    expect(closed).toBe(true);
    expect(harness.hub.connectionCount).toBe(0);
  });
});
