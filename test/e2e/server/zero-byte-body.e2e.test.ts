/**
 * The e2e client records a zero-byte 2xx with its headers (WP-96, PROGRESS backlog 132).
 *
 * WP-52 saw one `200` with an empty body from a route that has no ending producing it, and could
 * not say which component answered, because the client kept only the status and the parsed body.
 * This drives the client against a loopback server that answers exactly that shape — twice, once
 * with a `content-encoding` and once without, which the entry names as two different findings — and
 * against a `204` and a body, which must not be recorded.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '../support/instance.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/empty-gzip') {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': '0' });
      response.end();
    } else if (request.url === '/empty') {
      response.writeHead(200, { 'content-length': '0', 'set-cookie': 'sid=FAKE-session; Path=/' });
      response.end();
    } else if (request.url === '/no-content') {
      response.writeHead(204);
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('a zero-byte 2xx (backlog 132)', () => {
  it('is recorded with its method, path, status and headers, and a 204 or a body is not', async () => {
    const client = new Client(baseUrl);
    const gzip = await client.json('/empty-gzip', { method: 'POST' });
    const plain = await client.json('/empty');
    await client.json('/no-content');
    await client.json('/body');

    expect(gzip.body).toBeNull();
    expect(gzip.headers['content-encoding']).toBe('gzip');
    expect(client.zeroByteBodies.map(({ method, path, status }) => [method, path, status])).toEqual(
      [
        ['POST', '/empty-gzip', 200],
        ['GET', '/empty', 200],
      ],
    );
    expect(client.zeroByteBodies[0]?.headers['content-encoding']).toBe('gzip');
    expect(client.zeroByteBodies[1]?.headers['content-encoding']).toBeUndefined();
    expect(client.zeroByteBodies[1]?.headers['content-length']).toBe('0');
    // The session cookie is not a framing header, and it stays out of the record.
    expect(plain.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(client.zeroByteBodies)).not.toContain('FAKE-session');
  });
});
