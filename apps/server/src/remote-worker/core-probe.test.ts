/**
 * **Is this address a platform?** — WP-294 (3): one test per refusal, against real loopback
 * servers — a core, one that redirects, one that streams a megabyte, one that is not a platform,
 * one that serves another protocol, an older one whose `release` asks for a credential — and the
 * address rules checked before anything is sent.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  WORKER_PROTOCOL_HEADER,
  WORKER_PROTOCOL_VERSION,
  workerLocalCoreCheckResponseSchema,
} from '@platform/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import type { CoreFetch } from './core-client.js';
import {
  CORE_CHECK_MAX_BYTES,
  CoreCheckError,
  checkCoreAddress,
  probeCoreCandidates,
  transportFailureOf,
} from './core-probe.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const RELEASE = {
  protocol: { current: WORKER_PROTOCOL_VERSION, accepted: [WORKER_PROTOCOL_VERSION] },
  digests: {
    platform: DIGEST,
    platform_launcher: DIGEST,
    platform_runtime: DIGEST,
    platform_egress: DIGEST,
  },
};
const VERSION = { version: '0.4.0', commit: null, built_at: null };

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void;
const servers: http.Server[] = [];
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A loopback server; answers its origin (`http:` to 127.0.0.1 is admitted) and what it was asked. */
const serve = async (handler: Handler) => {
  const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url ?? '', headers: request.headers });
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
};
const json = (response: http.ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const core =
  (release: (response: http.ServerResponse) => void): Handler =>
  (request, response) => {
    if (request.url === '/api/version') return json(response, 200, VERSION);
    if (request.url === '/api/worker/v1/release') return release(response);
    return json(response, 404, { error: { code: 'not_found', message: 'no' } });
  };

const failureOf = async (address: string, fetcher?: CoreFetch): Promise<string> => {
  try {
    await checkCoreAddress(address, fetcher);
  } catch (error) {
    if (error instanceof CoreCheckError) return error.failure;
    throw error;
  }
  return 'accepted';
};

describe('checking a platform address (WP-294 (3))', () => {
  it('answers only the fields it parsed — origin, host, version, fit — and sends no credential', async () => {
    const { origin, seen } = await serve(core((response) => json(response, 200, RELEASE)));
    const found = await checkCoreAddress(`${origin}/some/page?x=1`);
    expect(workerLocalCoreCheckResponseSchema.parse(found)).toEqual({
      url: origin,
      host: new URL(origin).host,
      version: '0.4.0',
      protocol_fit: 'fits',
    });
    expect(seen.map((request) => request.url)).toEqual(['/api/version', '/api/worker/v1/release']);
    for (const request of seen) {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers[WORKER_PROTOCOL_HEADER.toLowerCase()]).toBe(
        String(WORKER_PROTOCOL_VERSION),
      );
    }
  });

  it.each([
    ['http to a host that is not this machine', 'http://core.example.test'],
    ['a user name and password', 'https://alice:secret@core.example.test'],
    ['a user name alone', 'https://alice@core.example.test'],
    ['another scheme', 'ftp://core.example.test'],
    ['javascript:', 'javascript:alert(1)'],
    ['not a URL', 'core.example.test'],
  ])('refuses %s before sending anything', async (_name, address) => {
    let asked = 0;
    const fetcher: CoreFetch = async () => {
      asked += 1;
      return new Response('{}');
    };
    expect(await failureOf(address, fetcher)).toBe('address_refused');
    expect(asked).toBe(0);
  });

  it('refuses a redirect, and does not follow it', async () => {
    const target = await serve(core((response) => json(response, 200, RELEASE)));
    const { origin } = await serve((_request, response) => {
      response.writeHead(302, { location: `${target.origin}/api/version` });
      response.end();
    });
    expect(await failureOf(origin)).toBe('not_a_platform');
    expect(target.seen).toEqual([]);
  });

  it('stops reading an answer past 64 KiB — a core that streams a megabyte', async () => {
    let written = 0;
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      const pump = (): void => {
        while (written < 1024 * 1024) {
          written += chunk.length;
          if (!response.write(chunk)) {
            response.once('drain', pump);
            return;
          }
        }
        response.end();
      };
      pump();
    });
    expect(await failureOf(origin)).toBe('not_a_platform');
    expect(CORE_CHECK_MAX_BYTES).toBe(64 * 1024);
  });

  it('names an address that is not a platform without echoing its body', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>a planted SECRET-BODY page</html>');
    });
    try {
      await checkCoreAddress(origin);
      expect.unreachable();
    } catch (error) {
      expect((error as CoreCheckError).failure).toBe('not_a_platform');
      expect((error as Error).message).not.toContain('SECRET-BODY');
    }
    // A version that does not parse strictly is not a platform either.
    const extra = await serve((_request, response) =>
      json(response, 200, { ...VERSION, injected: 'x' }),
    );
    expect(await failureOf(extra.origin)).toBe('not_a_platform');
  });

  it('names nothing answering, and a certificate it could not trust', async () => {
    const closed = await serve(() => undefined);
    const port = new URL(closed.origin).port;
    const server = servers.pop() as http.Server;
    await new Promise((resolve) => server.close(resolve));
    expect(await failureOf(`http://127.0.0.1:${port}`)).toBe('no_answer');
    const certificate = new TypeError('fetch failed', {
      cause: Object.assign(new Error('self-signed certificate'), {
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      }),
    });
    expect(transportFailureOf(certificate)).toBe('certificate');
    expect(
      await failureOf('https://core.example.test', async () => {
        throw certificate;
      }),
    ).toBe('certificate');
  });

  it('names a platform that serves another protocol (its 426)', async () => {
    const { origin } = await serve(core((response) => json(response, 426, { error: 'x' })));
    expect(await failureOf(origin)).toBe('needs_other_version');
    const older = await serve(
      core((response) =>
        json(response, 200, { ...RELEASE, protocol: { current: 99, accepted: [99] } }),
      ),
    );
    expect(await failureOf(older.origin)).toBe('needs_other_version');
  });

  it('takes an older core whose release asks for a credential as checked partly', async () => {
    const { origin } = await serve(
      core((response) => json(response, 401, { error: { code: 'unauthenticated', message: 'x' } })),
    );
    expect((await checkCoreAddress(origin)).protocol_fit).toBe('unknown');
  });

  it('offers only the candidates that answer as a platform', async () => {
    const good = await serve(core((response) => json(response, 200, RELEASE)));
    const bad = await serve((_request, response) => json(response, 404, {}));
    expect(
      await probeCoreCandidates([good.origin, bad.origin, 'http://core.example.test']),
    ).toEqual([{ url: good.origin, version: '0.4.0' }]);
  });
});
