/**
 * `agentic-runlet connect` — the run's SSH `ProxyCommand` (TD-028 decision 13b item 4, WP-146).
 *
 * A deploy-key run's `ssh` cannot open a TCP connection to the git host: the run network is
 * `internal: true`, and the only way off it is the egress sidecar, an HTTP proxy that admits
 * `CONNECT` to the allowed hosts on port 443. So `ssh` is given `-o ProxyCommand=agentic-runlet
 * connect --proxy <url> %h %p`, and this helper asks the sidecar `CONNECT altssh.gitlab.com:443`,
 * checks for a `200`, and then copies bytes both ways between its stdio and the tunnel. No `nc` or
 * `socat` is added to the image (the shim's binary already holds everything it needs).
 *
 * It decides nothing: the sidecar is the allow-list, and a refused `CONNECT` (`403`) ends the helper
 * with a non-zero exit and the proxy's status on stderr, which `ssh` prints.
 */
import { connect, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';

/** The largest proxy response header the helper reads before giving up. */
const MAX_PROXY_HEADER_BYTES = 8_192;

export interface ConnectHelperArgs {
  readonly proxy: { readonly host: string; readonly port: number };
  readonly host: string;
  readonly port: number;
}

/** What `parseConnectHelperArgs` refuses; the entrypoint prints it and exits 2. */
export class ConnectHelperUsageError extends Error {
  override readonly name = 'ConnectHelperUsageError';
}

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const portOf = (text: string | undefined): number | null => {
  if (text === undefined || !/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : null;
};

/** `--proxy http://<host>:<port> <host> <port>`, nothing else. */
export const parseConnectHelperArgs = (argv: readonly string[]): ConnectHelperArgs => {
  if (argv.length !== 4 || argv[0] !== '--proxy') {
    throw new ConnectHelperUsageError(
      'usage: agentic-runlet connect --proxy http://<proxy-host>:<port> <host> <port>',
    );
  }
  const proxy = /^http:\/\/([a-z0-9.-]+):(\d{1,5})$/.exec(argv[1] as string);
  const proxyPort = portOf(proxy?.[2]);
  if (proxy === null || proxyPort === null || !HOST.test(proxy[1] as string)) {
    throw new ConnectHelperUsageError('the proxy must be http://<host>:<port>');
  }
  const host = (argv[2] as string).toLowerCase();
  const port = portOf(argv[3]);
  if (!HOST.test(host) || port === null) {
    throw new ConnectHelperUsageError('the target must be a DNS host name and a port');
  }
  return { proxy: { host: proxy[1] as string, port: proxyPort }, host, port };
};

/**
 * Opens the tunnel and copies stdio through it. Resolves with the exit code: `0` when the tunnel
 * closed, `1` when the proxy refused or the connection failed (the reason on `stderr`).
 */
export const runConnectHelper = (input: {
  readonly args: ConnectHelperArgs;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly connectTo?: (host: string, port: number) => Socket;
}): Promise<number> =>
  new Promise<number>((resolve) => {
    const { args } = input;
    const socket = (input.connectTo ?? ((host, port) => connect({ host, port })))(
      args.proxy.host,
      args.proxy.port,
    );
    let settled = false;
    const finish = (code: number, message?: string): void => {
      if (settled) return;
      settled = true;
      if (message !== undefined) input.stderr.write(`agentic-runlet connect: ${message}\n`);
      socket.destroy();
      resolve(code);
    };
    let header = Buffer.alloc(0);
    let tunnelled = false;
    socket.on('connect', () => {
      const target = `${args.host}:${args.port}`;
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      if (tunnelled) return;
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end === -1) {
        if (header.length > MAX_PROXY_HEADER_BYTES) finish(1, 'the proxy sent no end of header');
        return;
      }
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(header.subarray(0, end).toString('latin1'));
      if (status?.[1] !== '200') {
        finish(
          1,
          `the proxy refused CONNECT ${args.host}:${args.port} (${status?.[1] ?? 'no status'})`,
        );
        return;
      }
      tunnelled = true;
      socket.removeAllListeners('data');
      const rest = header.subarray(end + 4);
      if (rest.length > 0) input.stdout.write(rest);
      socket.pipe(input.stdout);
      input.stdin.pipe(socket);
    });
    socket.on('error', (error) => finish(1, error.message));
    socket.on('close', () =>
      finish(tunnelled ? 0 : 1, tunnelled ? undefined : 'the proxy closed the connection'),
    );
  });
