/**
 * `GET /events` and `POST /events/subscriptions` (technical/08 § Events, TD-014).
 *
 * The route is thin on purpose: everything about buffering, replay, ordering and drain lives in
 * `hub.ts`, which has no Fastify in it and can therefore be tested against a transport made of two
 * arrays; who may watch which topic lives in `topic-access.ts`, which has no database in it. What
 * is here is the binding — `@fastify/sse`'s reply object adapted to the hub's transport, the topic
 * list parsed and then authorised through `authoriseTopics`, and the cursor read from either the
 * `Last-Event-ID` header or the query string.
 *
 * Why both cursor sources: `Last-Event-ID` is the SSE standard and a browser sends it *by itself*
 * on an automatic reconnect — but only ever the id of the last frame it received, which on a
 * multiplexed stream is one topic's position. A client that tracks all of its topics sends the
 * full set, and it cannot do that in a header because `EventSource` has no way to set one. So the
 * query parameter is the complete cursor and the header is the browser's automatic partial one;
 * when both are present the query wins, because it is the one the client chose.
 */
import type { SseTopic } from '@platform/contracts';
import {
  eventsQuerySchema,
  sseTopicSchema,
  updateSubscriptionsRequestSchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requireSession } from '../auth/plugin.js';
import { BadRequestError, HttpError, NotFoundError, TooManyRequestsError } from '../errors.js';
import type { Metrics } from '../metrics.js';
import {
  ConnectionIdInUseError,
  parseCursors,
  ShuttingDownError,
  type SseHub,
  type SseTransport,
  TooManyConnectionsError,
  TooManyTopicsError,
  UnknownConnectionError,
} from './hub.js';
import { authoriseTopics, type TopicAccessDependencies } from './topic-access.js';

/** Splits and validates `?topics=org,task:<uuid>`; every entry must be a documented topic. */
export const parseTopics = (raw: string): SseTopic[] => {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) {
    throw new BadRequestError('invalid_topics', 'at least one topic is required');
  }
  const topics = entries.map((entry) => {
    const parsed = sseTopicSchema.safeParse(entry);
    if (!parsed.success) {
      throw new BadRequestError(
        'invalid_topics',
        `${JSON.stringify(entry)} is not a topic: expected "org", "project:<uuid>", "task:<uuid>" or "run:<uuid>"`,
      );
    }
    return parsed.data;
  });
  return [...new Set(topics)];
};

/** Adapts `@fastify/sse`'s reply object to the hub's transport. */
export const sseTransportFor = (reply: FastifyReply): SseTransport => ({
  send: async (message) => {
    await reply.sse.send(message);
  },
  comment: (text) => {
    // The plugin has no comment API; a comment is a raw line by definition and this is exactly how
    // the plugin writes its own heartbeat (`reply.raw.write(': heartbeat\n\n')`). Ours says
    // `: ping`, which is the spelling technical/08 fixes.
    reply.raw.write(`: ${text}\n\n`);
  },
  close: () => {
    reply.sse.close();
  },
  get isConnected() {
    return reply.sse.isConnected;
  },
});

export interface SseRoutesOptions {
  readonly hub: SseHub;
  readonly metrics: Metrics;
  /**
   * What the topic check needs from the database, as functions.
   *
   * Injected rather than taken as a `Database` so the *wiring* — that both entry points call
   * `authoriseTopics` before touching the hub — is pinned by a unit test rather than only by the
   * e2e tier. A guard whose only proof runs in the slowest suite is a guard that gets deleted by
   * accident.
   */
  readonly access: TopicAccessDependencies;
}

export const registerSseRoutes = async (
  app: FastifyInstance,
  options: SseRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { access } = options;

  typed.get(
    '/events',
    {
      // `only`: this route serves nothing but an event stream, so a client that explicitly refuses
      // `text/event-stream` gets 406 rather than a body it cannot read.
      sse: { kind: 'only', heartbeat: false },
      schema: {
        summary: 'Multiplexed server-sent event stream',
        description:
          'One stream per tab. Frames carry `id: <topic>:<seq>`; reconnect with `Last-Event-ID` or `?last_event_id=` to replay, or receive `event: reset` when the position is outside the buffer.',
        tags: ['events'],
        querystring: eventsQuerySchema,
        produces: ['text/event-stream'],
      },
    },
    async (request, reply) => {
      const actor = await requireSession(request);
      const topics = parseTopics(request.query.topics);
      // Authorised before the stream is opened, so a refusal is an ordinary JSON error response
      // rather than a `text/event-stream` that closes immediately.
      //
      // **Known gap, recorded rather than fixed here: this is the only time the stream is
      // authorised.** A user banned or demoted while a stream is open keeps receiving its frames
      // until they reconnect — the "a ban bites on the next request" property that
      // `auth/plugin.ts` gives every other endpoint has no next request on a connection that lives
      // for hours. Closing it needs a revocation signal the platform does not have yet — the
      // `Broadcast` port carries no such topic. It carries one for the transcript since WP-15h
      // (`run.transcript.appended`), which is the shape a revocation hint would take and is not
      // one, so the gap is unchanged and now has a worked example beside it.
      await authoriseTopics(access, actor, topics);
      const cursors = parseCursors(
        request.query.last_event_id ?? (request.headers['last-event-id'] as string | undefined),
      );
      const connectionId = request.query.connection_id ?? crypto.randomUUID();

      let handle: { close: () => void };
      try {
        handle = options.hub.open({
          id: connectionId,
          userId: actor.userId,
          topics,
          cursors,
          partials: request.query.partials !== '0',
          transport: sseTransportFor(reply),
        });
      } catch (error) {
        if (error instanceof TooManyConnectionsError || error instanceof ShuttingDownError) {
          // Both are "come back later", and both are what a `retry:`-driven reconnect handles.
          throw new TooManyRequestsError(error.message);
        }
        if (error instanceof ConnectionIdInUseError) {
          // Not 403: the caller is authenticated and allowed to open a stream, it just cannot have
          // this id. Retrying with a fresh one works, which is what 409 tells a client.
          throw new HttpError(409, 'connection_id_in_use', error.message);
        }
        if (error instanceof TooManyTopicsError) {
          throw new BadRequestError('too_many_topics', error.message);
        }
        throw error;
      }

      options.metrics.sseConnections.set({ state: 'open' }, options.hub.connectionCount);
      reply.sse.onClose(() => {
        handle.close();
        options.metrics.sseConnections.set({ state: 'open' }, options.hub.connectionCount);
      });
      // Hand the stream to the hub: the handler returning must not end the response.
      reply.sse.keepAlive();
    },
  );

  typed.post(
    '/events/subscriptions',
    {
      schema: {
        summary: 'Add or remove topics on an open stream',
        description:
          'Addresses the stream by the `connection_id` the client passed to `GET /events`. A newly added topic is not replayed: fetch its current state over REST and follow from here.',
        tags: ['events'],
        body: updateSubscriptionsRequestSchema,
        response: {
          200: z.strictObject({ connection_id: z.string(), topics: z.array(sseTopicSchema) }),
        },
      },
    },
    async (request) => {
      const actor = await requireSession(request);
      // Adding a topic through this endpoint is the same subscription decision as naming it on
      // `GET /events`, so it goes through the same check. Removing one needs no permission.
      await authoriseTopics(access, actor, request.body.add ?? []);
      try {
        const result = options.hub.updateSubscriptions(request.body.connection_id, actor.userId, {
          ...(request.body.add === undefined ? {} : { add: request.body.add }),
          ...(request.body.remove === undefined ? {} : { remove: request.body.remove }),
        });
        return { connection_id: request.body.connection_id, topics: result.topics as SseTopic[] };
      } catch (error) {
        if (error instanceof UnknownConnectionError) {
          throw new NotFoundError(`event stream ${request.body.connection_id}`);
        }
        if (error instanceof TooManyTopicsError) {
          throw new BadRequestError('too_many_topics', error.message);
        }
        throw error;
      }
    },
  );
};
