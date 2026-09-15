/**
 * What this origin puts on the wire (WP-15j review round 2, finding 1).
 *
 * The SPA's initial graph is 551 009 raw bytes; `pnpm bundle:check` holds 163 554 **gzipped** to
 * TD-013:8's budget. Until this change no instance sent the second number, because nothing
 * compressed anything: TD-002's `@fastify/compress` was not registered. This file is the
 * measurement in both directions — that the bytes are coded for a client that accepts a coding,
 * and that the two responses which must **not** be coded are not.
 *
 * ## The two halves, and why there are two
 *
 * `@fastify/compress` attaches its `onSend` through an `onRoute` hook, and Fastify emits no
 * `onRoute` for the context `setNotFoundHandler` creates — where the SPA is served from. So the
 * plugin covers the registered routes and `web/encoding.ts` covers the bundle. Both halves are
 * asserted here, against one instance, because "the origin compresses" is one property to a
 * browser and it is served by two mechanisms.
 *
 * ## The SSE assertion is over a socket, and it measures two things at once
 *
 * `app.inject()` buffers the whole response, so an injected SSE request cannot tell a stream that
 * arrived frame by frame from one the compressor held until it flushed — which is exactly the
 * failure TD-002's exclusion exists to prevent. The case below therefore opens a real socket,
 * sends `Accept-Encoding: br, gzip, deflate`, and asserts that the first frame arrives **as
 * readable text while the response is still open**: no `content-encoding`, no gzip magic, and the
 * `retry:` field the hub writes on connect, before anything closes the stream.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import fastifyCompress from '@fastify/compress';
import fastifySse from '@fastify/sse';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Auth } from '../auth/better-auth.js';
import { loadServerConfig } from '../config.js';
import { createLogger } from '../logging.js';
import { createMetrics } from '../metrics.js';
import type { Database } from '../queries/identity-queries.js';
import { SseHub } from '../sse/hub.js';
import { registerSseRoutes } from '../sse/routes.js';

/** Above the 1 024-byte threshold, and compressible: a shell with a realistic amount of markup. */
const SHELL = `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8" />${'<meta name="wp15j" content="a shell large enough to be worth coding" />\n'.repeat(
  20,
)}</head>\n<body><div id="root"></div></body>\n</html>\n`;
const ASSET = `export const wp15j = ${JSON.stringify('x'.repeat(4_000))};\n`;
/** Below the threshold: coding it would cost CPU and add framing for nothing. */
const SMALL = 'User-agent: *\nDisallow:\n';
/** Above the threshold and of a type this server never codes (`encoding.ts`). */
const IMAGE = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4_000, 0x41),
]);
/** Long enough that a compressor would have something to do, if one ran (it must not). */
const AUTH_BODY = JSON.stringify({ token: 'not-a-real-session-token', pad: 'p'.repeat(4_000) });

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wp15j-compression-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), SHELL);
  writeFileSync(join(root, 'assets', 'index-Wp15J111.js'), ASSET);
  writeFileSync(join(root, 'robots.txt'), SMALL);
  writeFileSync(join(root, 'assets', 'shot-Wp15J111.png'), IMAGE);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const ACTOR = {
  id: '0199aa11-2b3c-7d4e-8f90-0000000000aa',
  email: 'operator@example.test',
  name: 'Operator',
  role: 'admin',
  status: 'active',
  banned: false,
  banExpires: null,
};

/** Better Auth and the `users` read behind it, both stubbed: this file's subject is the wire. */
const signedInAuth = {
  api: { getSession: async () => ({ user: { id: ACTOR.id }, session: { id: 'session-1' } }) },
  handler: async () =>
    new Response(AUTH_BODY, { status: 200, headers: { 'content-type': 'application/json' } }),
} as unknown as Auth;

const database = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => [ACTOR] }) }),
  }),
} as unknown as Database;

const apps: FastifyInstance[] = [];

const build = async (): Promise<FastifyInstance> => {
  const app = await buildApp({
    config: loadServerConfig({
      DATABASE_URL: 'postgres://app:app@db:5432/app',
      APP_SECRET_KEY: 'x'.repeat(40),
      APP_BASE_URL: 'http://localhost:8080',
    }),
    logger: createLogger({
      level: 'error',
      format: 'json',
      role: 'all',
      destination: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    }),
    metrics: createMetrics({ defaultMetrics: false }),
    database,
    auth: signedInAuth,
    hub: new SseHub({
      bufferSize: 4,
      maxQueuedFrames: 8,
      maxTopicsPerConnection: 4,
      maxBufferedTopics: 8,
      retryMs: 1_000,
      // No ping timer: the frame this file waits for has to be the one `open()` writes, not one a
      // 20-second interval produced later.
      pingIntervalMs: 0,
      maxConnections: 2,
      shutdownDrainMs: 100,
    }),
    webhooks: null,
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
    webRoot: root,
    version: { version: '0.0.0-test', commit: null, builtAt: null },
    readiness: async () => ({ status: 'ok', checks: {} }),
    isShuttingDown: () => false,
  });
  apps.push(app);
  return app;
};

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
});

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

describe('the browser application is coded on the wire', () => {
  it('serves the shell gzipped, and the decoded bytes are the file’s bytes', async () => {
    const app = await build();
    const response = await app.inject({ url: '/', headers: { 'accept-encoding': 'gzip' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers.vary).toBe('accept-encoding');
    expect(response.rawPayload.subarray(0, 2).equals(GZIP_MAGIC)).toBe(true);
    // Rule 82: the bytes on disk, decoded from what the socket carried — not a string this test
    // also wrote, and not the server's own claim about what it sent.
    const onDisk = readFileSync(join(root, 'index.html'));
    expect(gunzipSync(response.rawPayload).equals(onDisk)).toBe(true);
    expect(response.rawPayload.length).toBeLessThan(onDisk.length);
  });

  it('prefers brotli when the client offers both, and gzip when it offers only gzip', async () => {
    const app = await build();
    const both = await app.inject({
      url: '/assets/index-Wp15J111.js',
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });
    expect(both.headers['content-encoding']).toBe('br');
    const gzipOnly = await app.inject({
      url: '/assets/index-Wp15J111.js',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(gzipOnly.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gzipOnly.rawPayload).toString()).toBe(ASSET);
    // Both codings of one file, cached independently and both correct.
    expect(both.rawPayload.length).toBeLessThan(Buffer.byteLength(ASSET));
  });

  it('sends the file’s own bytes to a client that accepts no coding', async () => {
    const app = await build();
    for (const headers of [
      {},
      { 'accept-encoding': 'gzip;q=0, br;q=0' },
      { 'accept-encoding': 'identity' },
    ]) {
      const response = await app.inject({ url: '/', headers });
      expect(response.headers['content-encoding'], JSON.stringify(headers)).toBeUndefined();
      expect(response.rawPayload.equals(readFileSync(join(root, 'index.html')))).toBe(true);
      // The header is still declared, so a cache in front of this server keys on it either way.
      expect(response.headers.vary).toBe('accept-encoding');
    }
  });

  it('leaves a small file and an image alone even for a client that accepts gzip', async () => {
    const app = await build();
    const small = await app.inject({ url: '/robots.txt', headers: { 'accept-encoding': 'gzip' } });
    expect(small.statusCode).toBe(200);
    expect(small.headers['content-encoding']).toBeUndefined();
    expect(small.rawPayload.toString()).toBe(SMALL);

    const image = await app.inject({
      url: '/assets/shot-Wp15J111.png',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-encoding']).toBeUndefined();
    expect(image.rawPayload.equals(IMAGE)).toBe(true);
  });

  it('answers a conditional request for a coded representation with 304 and no body', async () => {
    const app = await build();
    const first = await app.inject({ url: '/', headers: { 'accept-encoding': 'gzip' } });
    const second = await app.inject({
      url: '/',
      headers: { 'accept-encoding': 'gzip', 'if-none-match': String(first.headers.etag) },
    });
    expect(second.statusCode).toBe(304);
    expect(second.rawPayload.length).toBe(0);
    expect(second.headers['content-encoding']).toBeUndefined();
  });
});

describe('the API is coded by the plugin TD-002 names', () => {
  it('codes the OpenAPI document, and the decoded bytes are the document', async () => {
    const app = await build();
    const plain = await app.inject({ url: '/openapi.json' });
    const coded = await app.inject({
      url: '/openapi.json',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(coded.statusCode).toBe(200);
    expect(coded.headers['content-encoding']).toBe('gzip');
    expect(String(coded.headers.vary ?? '')).toContain('accept-encoding');
    expect(gunzipSync(coded.rawPayload).toString()).toBe(plain.rawPayload.toString());
    expect(coded.rawPayload.length).toBeLessThan(plain.rawPayload.length);
  });

  it('codes the metrics exposition, which is the most compressible thing this server sends', async () => {
    // Not compared byte for byte against a second read: each request adds its own observation to
    // the histogram, so two readings of `/metrics` are legitimately different documents. The
    // decoded text is asserted to be the exposition instead.
    //
    // The warm-up is load-bearing and was measured: a **fresh** registry renders 362 bytes, below
    // the 1 024-byte threshold, so the first `/metrics` of a process is legitimately uncoded and a
    // test that asserted `gzip` on it would be asserting the wrong thing. The scope is stated
    // below before anything is concluded from it (rule 4).
    const app = await build();
    for (const url of ['/healthz', '/api/version', '/metrics', '/metrics']) {
      await app.inject({ url });
    }
    const plain = await app.inject({ url: '/metrics' });
    expect(plain.rawPayload.length).toBeGreaterThan(1_024);
    const coded = await app.inject({ url: '/metrics', headers: { 'accept-encoding': 'gzip' } });
    expect(coded.statusCode).toBe(200);
    expect(coded.headers['content-encoding']).toBe('gzip');
    const decoded = gunzipSync(coded.rawPayload).toString();
    expect(decoded).toContain('# TYPE http_request_duration_seconds histogram');
    expect(coded.rawPayload.length).toBeLessThan(decoded.length);
  });

  it('does not code Better Auth’s responses, whose bodies carry a bearer credential', async () => {
    // The body is 4 kB and compressible, so an uncoded answer here is the route's `compress:
    // false` and not the threshold (rule 21: the instrument is calibrated by the case above,
    // which codes a document of the same type through the same plugin).
    const app = await build();
    const response = await app.inject({
      url: '/api/auth/get-session',
      headers: { 'accept-encoding': 'gzip, br' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.rawPayload.toString()).toBe(AUTH_BODY);
  });

  it('never inflates a request body, and the probe that says so is calibrated', async () => {
    // `globalDecompression: false`: nothing in this product sends a compressed request body,
    // `/webhooks/*` verifies a signature over the bytes as they arrive (WP-15c), and a body limit
    // applied before inflation is a body limit applied to the wrong number.
    const claimsGzip = {
      method: 'POST' as const,
      url: '/api/auth/sign-in/email',
      headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
      payload: Buffer.from('{"this":"is not gzip"}'),
    };

    // The instrument first (rule 21): the same plugin version, with decompression left at its
    // default, refuses this request by name. So a green result below is the option and not a
    // request the plugin never saw.
    const calibration = fastify();
    await calibration.register(fastifyCompress);
    calibration.post('/api/auth/sign-in/email', async () => ({ ok: true }));
    const refused = await calibration.inject(claimsGzip);
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('FST_CP_ERR_INVALID_CONTENT');
    await calibration.close();

    const app = await build();
    const response = await app.inject(claimsGzip);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('FST_CP_ERR');
  });
});

interface StreamStart {
  readonly head: string;
  readonly body: Buffer;
  /** Whether the socket was still open when the first complete frame arrived. */
  readonly open: boolean;
}

/**
 * Opens `/events` on a listening instance and resolves at the **first complete SSE block**.
 *
 * Deliberately a socket and not `app.inject()`: the injector buffers the whole response, so it
 * cannot tell a frame that arrived from one the compressor held. `Accept-Encoding` is offered in
 * full, because a client that asks for a coding is the case TD-002's exclusion is about.
 */
const firstFrame = async (app: FastifyInstance): Promise<StreamStart> => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server is not listening on a port');
  }
  return await new Promise<StreamStart>((resolve, reject) => {
    const socket = net.connect(address.port, '127.0.0.1', () => {
      socket.write(
        'GET /events?topics=org HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Accept: text/event-stream\r\n' +
          'Accept-Encoding: br, gzip, deflate\r\n\r\n',
      );
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no frame within 5s; got ${Buffer.concat(chunks).toString('latin1')}`));
    }, 5_000);
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      const separator = all.indexOf('\r\n\r\n');
      if (separator === -1) {
        return;
      }
      const body = all.subarray(separator + 4);
      // Wait for a complete SSE block, which is what a browser's `onmessage` waits for.
      if (!body.includes('\n\n')) {
        return;
      }
      clearTimeout(timer);
      resolve({
        head: all.subarray(0, separator).toString('latin1'),
        body,
        // Still open: the frame reached us without the response ending, which is the property a
        // compressed stream loses.
        open: !socket.destroyed && socket.readyState === 'open',
      });
      socket.destroy();
    });
    socket.on('error', reject);
  });
};

describe('the event stream is excluded, and arrives frame by frame', () => {
  it('sends the first frame as readable text, uncoded, while the response is open', async () => {
    const app = await build();
    const received = await firstFrame(app);

    const head = received.head.toLowerCase();
    expect(head).toContain('content-type: text/event-stream');
    expect(head).not.toContain('content-encoding');
    expect(head).not.toContain('transfer-encoding: identity');
    expect(received.open).toBe(true);
    expect(received.body.subarray(0, 2).equals(GZIP_MAGIC)).toBe(false);
    // The hub's own opening frame, in plain text: `retry:` reaches every new connection.
    expect(received.body.toString('utf8')).toContain('retry: 1000');
  });

  it('stays uncoded even where every content type is declared compressible', async () => {
    // The case above is also true of a server that configured nothing: `@fastify/compress`
    // excludes `text/event-stream` in its own default table. This one takes that default away —
    // `customTypes: () => true` makes **everything** compressible — and the stream is still plain
    // text, which is the stronger statement: `@fastify/sse` commits the response by writing to
    // `reply.raw` (`sendHeaders`, `index.js:433`), so no `onSend` hook of any kind runs on an SSE
    // payload. That is also why removing `compress: false` from the route fails no test here
    // (measured by mutation, and written down at the route). The sibling is the calibration
    // (rule 21): on this same instance it *is* coded, so an uncoded stream is a property of the
    // stream and not a compressor that never ran.
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(fastifyCompress, { customTypes: () => true });
    await app.register(fastifySse, { heartbeatInterval: 0 });
    app.addHook('onRequest', async (request) => {
      request.actor = {
        userId: ACTOR.id,
        email: ACTOR.email,
        name: ACTOR.name,
        role: 'admin',
        sessionId: 'session-1',
      };
    });
    app.get('/sibling', async () => ({ pad: 'p'.repeat(4_000) }));
    await registerSseRoutes(app, {
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
      metrics: createMetrics({ defaultMetrics: false }),
      access: {
        projectRole: async () => null,
        projectExists: async () => true,
        taskProjectId: async () => null,
        runProjectId: async () => null,
      },
    });
    apps.push(app);

    const sibling = await app.inject({ url: '/sibling', headers: { 'accept-encoding': 'gzip' } });
    expect(sibling.headers['content-encoding']).toBe('gzip');

    const received = await firstFrame(app);
    expect(received.head.toLowerCase()).not.toContain('content-encoding');
    expect(received.body.subarray(0, 2).equals(GZIP_MAGIC)).toBe(false);
    expect(received.body.toString('utf8')).toContain('retry: 1000');
  });
});
