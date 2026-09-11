/**
 * The operational surface every `ROLE` serves: `/healthz`, `/readyz`, `/metrics`, `/api/version`
 * (technical/08 § Ops, TD-023).
 *
 * The distinction that matters is between the two health endpoints, because getting it wrong makes
 * a deployment either flap or hang:
 *
 * - **`/healthz` is liveness.** "This process is running and not wedged." It must not touch the
 *   database: a failing dependency would make an orchestrator kill and restart a perfectly healthy
 *   process, turning a database blip into a restart loop. It answers from `@fastify/under-pressure`'s
 *   view of the event loop and heap.
 * - **`/readyz` is readiness.** "This process can serve traffic now." It checks the database, that
 *   the schema is the one this build knows about, and — where the process runs workers — that the
 *   job runtime started **and that the event bus has a handler to dispatch to**. It answers 503 the
 *   moment shutdown begins, which is what takes the instance out of a load balancer *before*
 *   connections are closed (TD-002's shutdown order).
 *
 *   The fourth check is TD-023's amendment at WP-15a, and it has a consequence worth knowing here:
 *   `ROLE=all` and `ROLE=worker` are **503 for ever** until something composes a pipeline, which is
 *   the state `main.ts` is in today. That is intended — a process that would never advance a ticket
 *   must not report ready — but `ROLE=all` also serves the API and the SPA, so nothing may gate on
 *   this probe to decide whether *those* are usable. `/healthz` is the liveness probe.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { healthResponseSchema, versionResponseSchema } from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import type { ServerConfig } from '../config.js';
import type { Metrics } from '../metrics.js';

export type CheckStatus = 'ok' | 'degraded' | 'down';

export interface ReadinessReport {
  readonly status: CheckStatus;
  readonly checks: Record<string, CheckStatus>;
}

export interface OpsRoutesOptions {
  readonly config: ServerConfig;
  readonly metrics: Metrics;
  /** Build metadata, injected so the composition root owns where it comes from. */
  readonly version: {
    readonly version: string;
    readonly commit: string | null;
    readonly builtAt: string | null;
  };
  /** Every dependency's current state; see `readiness.ts`. */
  readonly readiness: () => Promise<ReadinessReport>;
  /** True from the first moment of shutdown, so `/readyz` fails before connections close. */
  readonly isShuttingDown: () => boolean;
  /** Whether the process is wedged (event loop delay, heap). */
  readonly isUnderPressure: () => boolean;
}

/**
 * Constant-time comparison of a basic-auth credential.
 *
 * `===` on secrets leaks their length and prefix through timing. The two strings are compared as
 * fixed-width digests so the comparison time does not depend on where they first differ.
 */
export const credentialsMatch = async (
  presented: { user: string; pass: string },
  expected: { user: string; pass: string },
): Promise<boolean> => {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  // Both halves are compared before either result is used. `&&` short-circuits, so a wrong
  // username would have skipped the password comparison entirely and answered measurably faster
  // than a right username with a wrong password — which tells an attacker when they have guessed
  // the username, and turns one search into two smaller ones.
  const userMatches = timingSafeEqual(digest(presented.user), digest(expected.user));
  const passMatches = timingSafeEqual(digest(presented.pass), digest(expected.pass));
  return userMatches && passMatches;
};

/** Parses `Authorization: Basic <base64>`; `null` for anything else. */
export const parseBasicAuth = (
  header: string | undefined,
): { user: string; pass: string } | null => {
  if (header === undefined || !header.toLowerCase().startsWith('basic ')) {
    return null;
  }
  const decoded = Buffer.from(header.slice('basic '.length).trim(), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  return separator === -1
    ? null
    : { user: decoded.slice(0, separator), pass: decoded.slice(separator + 1) };
};

export const registerOpsRoutes = async (
  app: FastifyInstance,
  options: OpsRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/healthz',
    {
      schema: {
        summary: 'Liveness probe',
        description:
          'Whether this process is running and responsive. Never touches the database — see the module note in routes/ops.ts.',
        tags: ['ops'],
        response: { 200: healthResponseSchema, 503: healthResponseSchema },
      },
    },
    async (_request, reply) => {
      const pressure: CheckStatus = options.isUnderPressure() ? 'degraded' : 'ok';
      const body = { status: pressure, checks: { process: pressure } } as const;
      return reply.status(pressure === 'ok' ? 200 : 503).send(body);
    },
  );

  typed.get(
    '/readyz',
    {
      schema: {
        summary: 'Readiness probe',
        description:
          'Whether this process can serve traffic: database reachable, schema known to this build, job runtime started, and an event handler registered to dispatch to. 503 as soon as shutdown begins.',
        tags: ['ops'],
        response: { 200: healthResponseSchema, 503: healthResponseSchema },
      },
    },
    async (_request, reply) => {
      if (options.isShuttingDown()) {
        return reply
          .status(503)
          .send({ status: 'down' as const, checks: { shutdown: 'down' as const } });
      }
      const report = await options.readiness();
      return reply.status(report.status === 'ok' ? 200 : 503).send(report);
    },
  );

  typed.get(
    '/api/version',
    {
      schema: {
        summary: 'Build metadata',
        tags: ['ops'],
        response: { 200: versionResponseSchema },
      },
    },
    async () => ({
      version: options.version.version,
      commit: options.version.commit,
      built_at: options.version.builtAt,
    }),
  );

  typed.get(
    '/metrics',
    {
      schema: {
        summary: 'Prometheus exposition',
        description:
          'Optionally protected with basic auth (APP_METRICS_USERNAME / APP_METRICS_PASSWORD).',
        tags: ['ops'],
        response: { 200: z.string(), 401: z.string() },
      },
    },
    async (request, reply) => {
      const { metricsUsername, metricsPassword } = options.config;
      if (metricsUsername !== null && metricsPassword !== null) {
        const presented = parseBasicAuth(request.headers.authorization);
        const ok =
          presented !== null &&
          (await credentialsMatch(presented, { user: metricsUsername, pass: metricsPassword }));
        if (!ok) {
          return reply
            .status(401)
            .header('www-authenticate', 'Basic realm="metrics", charset="UTF-8"')
            .type('text/plain; charset=utf-8')
            .send('unauthorized');
        }
      }
      await options.metrics.collect();
      return reply
        .type(options.metrics.registry.contentType)
        .send(await options.metrics.registry.metrics());
    },
  );
};
