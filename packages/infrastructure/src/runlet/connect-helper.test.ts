import { createServer, type Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConnectHelperUsageError,
  parseConnectHelperArgs,
  runConnectHelper,
} from './connect-helper.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A stand-in egress proxy: records the request line, answers `status`, then echoes the tunnel. */
const proxy = async (status: string): Promise<{ port: number; requests: string[] }> => {
  const requests: string[] = [];
  const server = createServer((socket) => {
    let header = '';
    const onData = (chunk: Buffer): void => {
      header += chunk.toString('latin1');
      if (!header.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      requests.push(header.split('\r\n')[0] ?? '');
      socket.write(`HTTP/1.1 ${status}\r\nProxy-Agent: fake\r\n\r\n`);
      if (status.startsWith('200')) {
        socket.write('SSH-2.0-fake\r\n');
        socket.pipe(socket);
      } else {
        socket.end();
      }
    };
    socket.on('data', onData);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  return { port: typeof address === 'object' && address !== null ? address.port : 0, requests };
};

describe('agentic-runlet connect — a deploy-key run’s ProxyCommand (WP-146)', () => {
  it('asks the proxy CONNECT host:port and then carries bytes both ways', async () => {
    const fake = await proxy('200 Connection established');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const received: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => received.push(chunk));
    const done = runConnectHelper({
      args: { proxy: { host: '127.0.0.1', port: fake.port }, host: 'altssh.gitlab.com', port: 443 },
      stdin,
      stdout,
      stderr,
    });
    // Written before the tunnel exists: stdin buffers until the helper pipes it, as ssh's would.
    stdin.end('SSH-2.0-client\r\n');
    expect(await done).toBe(0);
    expect(fake.requests).toEqual(['CONNECT altssh.gitlab.com:443 HTTP/1.1']);
    expect(Buffer.concat(received).toString()).toBe('SSH-2.0-fake\r\nSSH-2.0-client\r\n');
  });

  it('exits 1 with the proxy’s status when the CONNECT is refused', async () => {
    const fake = await proxy('403 Forbidden');
    const stderr = new PassThrough();
    const said: string[] = [];
    stderr.on('data', (chunk: Buffer) => said.push(chunk.toString()));
    const code = await runConnectHelper({
      args: { proxy: { host: '127.0.0.1', port: fake.port }, host: 'gitlab.com', port: 22 },
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr,
    });
    expect(code).toBe(1);
    expect(said.join('')).toMatch(/refused CONNECT gitlab.com:22 \(403\)/);
  });

  it('takes exactly --proxy http://<host>:<port> <host> <port>', () => {
    expect(
      parseConnectHelperArgs(['--proxy', 'http://egress-r1:3128', 'altssh.gitlab.com', '443']),
    ).toEqual({ proxy: { host: 'egress-r1', port: 3128 }, host: 'altssh.gitlab.com', port: 443 });
    for (const argv of [
      [],
      ['--proxy', 'https://egress:3128', 'a.example', '443'],
      ['--proxy', 'http://egress:3128', 'a.example;rm', '443'],
      ['--proxy', 'http://egress:3128', 'a.example', '0'],
      ['--proxy', 'http://egress:3128', 'a.example', '443', 'extra'],
    ]) {
      expect(() => parseConnectHelperArgs(argv)).toThrow(ConnectHelperUsageError);
    }
  });
});
