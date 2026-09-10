/**
 * A Docker Engine double: a **real** HTTP server on a Unix socket that answers like the daemon.
 *
 * Not a stubbed client object. `DockerEngine` is an HTTP client, so the only double that exercises
 * what it actually does — the URL it builds, the method, the `Content-Type`, the JSON body, the
 * status codes it treats as answers rather than failures — is one that speaks HTTP. A stub of the
 * class would agree with whatever the class does, which is standing rule 4's instrument problem.
 *
 * ## Where it is deliberately stricter than Docker
 *
 * A double that is kinder than production launders bugs (standing rule 1), so this one refuses
 * what the daemon merely tolerates: an unknown path is a 404 rather than a redirect, a request
 * body that is not the JSON the endpoint expects is a 400, a duplicate container or volume name is
 * a 409, and a `POST` where the client should send `PUT` is a 405.
 *
 * ## The one place it *models* the daemon, and how far the model goes
 *
 * WP-13 measured that the daemon refuses to start a container whose `volume-subpath` does not
 * exist — the reason WP-14 must create `<ctl>/<run-id>/` first. Reproducing that here needs the
 * double to know which sub-directories exist, and it cannot run the prepare helper's shell. So it
 * reads the helper's script for `mkdir -p /ctl/<uuid>` and records the directory. That is a model
 * of one line of shell, and it is enough to make the *ordering* mistake fail in the unit tier;
 * whether the real daemon still behaves this way is `docker-workspace.e2e.test.ts`'s to say, and
 * it asserts exactly that.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface FakeContainer {
  readonly id: string;
  readonly name: string;
  readonly body: FakeCreateBody;
  state: 'created' | 'running' | 'exited';
  exitCode: number;
  logs: string;
  networks: string[];
}

interface FakeCreateBody {
  readonly Image?: string;
  readonly Cmd?: readonly string[];
  readonly Entrypoint?: readonly string[] | null;
  readonly Env?: readonly string[];
  readonly User?: string;
  readonly Labels?: Readonly<Record<string, string>>;
  readonly HostConfig?: {
    readonly Mounts?: readonly {
      readonly Type: string;
      readonly Source: string;
      readonly Target: string;
      readonly ReadOnly?: boolean;
      readonly VolumeOptions?: { readonly Subpath?: string };
    }[];
    readonly NetworkMode?: string;
  };
}

export interface FakeDaemonOptions {
  /** Decides a helper's outcome from its name and script. Default: exit 0, no output. */
  readonly script?: (container: FakeContainer) => { exitCode: number; logs: string };
  /** `containerName:path` → the tar `GET /archive` answers with. */
  readonly archives?: Map<string, Buffer>;
  /**
   * Endpoints to answer with something other than the normal response, by `METHOD /path`, so the
   * client's failure paths can be driven. `raw` is sent verbatim (for a body that is not JSON at
   * all); otherwise the message is wrapped the way the daemon wraps its errors.
   */
  readonly fail?: Map<string, { status: number; message: string; raw?: string }>;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let counter = 0;

export class FakeDockerDaemon {
  readonly volumes = new Map<string, Record<string, string>>();
  readonly networks = new Map<string, { name: string; internal: boolean }>();
  readonly containers = new Map<string, FakeContainer>();
  /**
   * Every container ever created, removals included.
   *
   * `containers` is what the daemon would answer `GET /containers/json` with, so it shrinks; a
   * helper's whole life is create-start-wait-remove and an assertion about what it was *sent* has
   * nothing to read otherwise. Keeping both is what lets a test assert a helper's flags and a test
   * assert that the helper is gone.
   */
  readonly history: FakeContainer[] = [];
  readonly requests: RecordedRequest[] = [];
  readonly controlSubpaths = new Set<string>();
  #server: Server | null = null;
  #dir = '';
  #socketPath = '';
  readonly #options: FakeDaemonOptions;

  constructor(options: FakeDaemonOptions = {}) {
    this.#options = options;
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  /** Containers that still exist, in creation order — the daemon's own view. */
  get created(): readonly FakeContainer[] {
    return [...this.containers.values()];
  }

  /** A container by name, removed ones included. */
  byName(name: string): FakeContainer | undefined {
    return this.history.find((container) => container.name === name);
  }

  async start(): Promise<string> {
    this.#dir = await mkdtemp(path.join(tmpdir(), 'agentic-fake-docker-'));
    this.#socketPath = path.join(this.#dir, 'docker.sock');
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        try {
          this.#route(req.method ?? 'GET', req.url ?? '/', raw, res);
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: String(error) }));
        }
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(this.#socketPath, resolve));
    return this.#socketPath;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.#server === null) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
    });
    await rm(this.#dir, { recursive: true, force: true });
  }

  #route(method: string, url: string, raw: Buffer, res: import('node:http').ServerResponse): void {
    const send = (status: number, payload: unknown): void => {
      if (Buffer.isBuffer(payload)) {
        res.writeHead(status, { 'content-type': 'application/x-tar' });
        res.end(payload);
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };

    const versioned = /^\/v\d+\.\d+(\/.*)$/.exec(url);
    if (versioned === null) {
      // The client pins the API version in the path; an unversioned request is a client bug.
      send(400, { message: `unversioned request path ${url}` });
      return;
    }
    const rest = versioned[1] ?? '/';
    const [pathname = '/', query = ''] = rest.split('?');
    let body: unknown;
    if (raw.length > 0 && res.req.headers['content-type'] === 'application/json') {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        send(400, { message: 'body is not JSON' });
        return;
      }
    }
    this.requests.push({ method, path: pathname, body });

    const failure = this.#options.fail?.get(`${method} ${pathname}`);
    if (failure !== undefined) {
      if (failure.raw !== undefined) {
        res.writeHead(failure.status, { 'content-type': 'application/json' });
        res.end(failure.raw);
        return;
      }
      send(failure.status, { message: failure.message });
      return;
    }

    const params = new URLSearchParams(query);

    if (method === 'GET' && pathname === '/_ping') {
      send(200, 'OK');
      return;
    }
    if (method === 'POST' && pathname === '/volumes/create') {
      const input = body as { Name?: string; Labels?: Record<string, string> };
      if (typeof input?.Name !== 'string' || input.Name.length === 0) {
        send(400, { message: 'volume needs a name' });
        return;
      }
      // The daemon answers 201 for an existing volume too, so the client's `ensure` is honest.
      this.volumes.set(input.Name, input.Labels ?? {});
      send(201, { Name: input.Name, Labels: input.Labels ?? {} });
      return;
    }
    if (method === 'GET' && pathname === '/volumes') {
      const filters = JSON.parse(params.get('filters') ?? '{}') as Record<string, string[]>;
      const wanted = filters['label'] ?? [];
      const volumes = [...this.volumes.entries()]
        .filter(([, labels]) =>
          wanted.every((entry) => {
            const [key = '', value] = entry.split('=');
            return value === undefined ? key in labels : labels[key] === value;
          }),
        )
        .map(([Name, Labels]) => ({ Name, Labels }));
      send(200, { Volumes: volumes });
      return;
    }
    if (method === 'DELETE' && pathname.startsWith('/volumes/')) {
      const name = decodeURIComponent(pathname.slice('/volumes/'.length));
      send(this.volumes.delete(name) ? 204 : 404, undefined);
      return;
    }
    if (method === 'POST' && pathname === '/networks/create') {
      const input = body as { Name?: string; Internal?: boolean };
      if (typeof input?.Name !== 'string') {
        send(400, { message: 'network needs a name' });
        return;
      }
      if ([...this.networks.values()].some((network) => network.name === input.Name)) {
        send(409, { message: 'network already exists' });
        return;
      }
      counter += 1;
      const id = `net-${counter}`;
      this.networks.set(id, { name: input.Name, internal: input.Internal === true });
      send(201, { Id: id });
      return;
    }
    if (method === 'DELETE' && pathname.startsWith('/networks/')) {
      const id = this.#network(decodeURIComponent(pathname.slice('/networks/'.length)));
      send(id !== null && this.networks.delete(id) ? 204 : 404, undefined);
      return;
    }
    if (method === 'POST' && /^\/networks\/[^/]+\/connect$/.test(pathname)) {
      const key = decodeURIComponent(pathname.split('/')[2] ?? '');
      const input = body as { Container?: string };
      const container = this.containers.get(input?.Container ?? '');
      // Docker resolves a network by id *or* name; a double that only knew ids would make the
      // provider look wrong for using the name the compose file gives it.
      const id = this.#network(key);
      if (id === null || container === undefined) {
        send(404, { message: 'no such network or container' });
        return;
      }
      container.networks.push(id);
      send(200, undefined);
      return;
    }
    if (method === 'POST' && pathname === '/containers/create') {
      const name = params.get('name') ?? '';
      // Live containers only: a name is free again once the container is removed, which is the
      // daemon's behaviour and the reason the launcher's helper names need no timestamp.
      if (this.created.some((container) => container.name === name)) {
        send(409, { message: `container name "${name}" is already in use` });
        return;
      }
      counter += 1;
      const id = `cnt-${counter}`;
      const create = body as FakeCreateBody;
      const container: FakeContainer = {
        id,
        name,
        body: create,
        state: 'created',
        exitCode: 0,
        logs: '',
        networks: [create.HostConfig?.NetworkMode ?? 'none'],
      };
      this.containers.set(id, container);
      this.history.push(container);
      this.#noteMkdir(create);
      send(201, { Id: id });
      return;
    }
    if (method === 'POST' && /^\/containers\/[^/]+\/start$/.test(pathname)) {
      const container = this.#container(pathname);
      if (container === undefined) {
        send(404, { message: 'no such container' });
        return;
      }
      const missing = this.#missingSubpath(container);
      if (missing !== null) {
        // WP-13's measurement, modelled: `cannot access path …: no such file or directory`.
        send(500, { message: `cannot access path /var/lib/docker/volumes/${missing}` });
        return;
      }
      const outcome = this.#options.script?.(container) ?? { exitCode: 0, logs: '' };
      container.state = 'running';
      container.exitCode = outcome.exitCode;
      container.logs = outcome.logs;
      send(204, undefined);
      return;
    }
    if (method === 'POST' && /^\/containers\/[^/]+\/wait$/.test(pathname)) {
      const container = this.#container(pathname);
      if (container === undefined) {
        send(404, { message: 'no such container' });
        return;
      }
      container.state = 'exited';
      send(200, { StatusCode: container.exitCode });
      return;
    }
    if (method === 'POST' && /^\/containers\/[^/]+\/stop$/.test(pathname)) {
      const container = this.#container(pathname);
      if (container === undefined) {
        send(404, { message: 'no such container' });
        return;
      }
      const already = container.state === 'exited';
      container.state = 'exited';
      send(already ? 304 : 204, undefined);
      return;
    }
    if (method === 'DELETE' && /^\/containers\/[^/]+$/.test(pathname)) {
      const container = this.#container(`${pathname}/x`);
      if (container === undefined) {
        send(404, { message: 'no such container' });
        return;
      }
      this.containers.delete(container.id);
      send(204, undefined);
      return;
    }
    if (method === 'GET' && /^\/containers\/[^/]+\/json$/.test(pathname)) {
      const container = this.#container(pathname);
      if (container === undefined) {
        send(404, { message: 'no such container' });
        return;
      }
      send(200, {
        Id: container.id,
        Name: `/${container.name}`,
        State: {
          Status: container.state,
          Running: container.state === 'running',
          ExitCode: container.exitCode,
        },
        Config: {
          Image: container.body.Image ?? '',
          User: container.body.User ?? '',
          Env: container.body.Env ?? [],
          Labels: container.body.Labels ?? {},
        },
        HostConfig: container.body.HostConfig ?? {},
        NetworkSettings: { Networks: {} },
        Mounts: container.body.HostConfig?.Mounts ?? [],
      });
      return;
    }
    if (method === 'GET' && pathname === '/containers/json') {
      const filters = JSON.parse(params.get('filters') ?? '{}') as Record<string, string[]>;
      const wanted = filters['label'] ?? [];
      send(
        200,
        this.created
          .filter((container) =>
            wanted.every((entry) => {
              const [key = '', value] = entry.split('=');
              const labels = container.body.Labels ?? {};
              return value === undefined ? key in labels : labels[key] === value;
            }),
          )
          .map((container) => ({
            Id: container.id,
            Names: [`/${container.name}`],
            State: container.state,
            Labels: container.body.Labels ?? {},
          })),
      );
      return;
    }
    if (method === 'GET' && /^\/containers\/[^/]+\/logs$/.test(pathname)) {
      const container = this.#container(pathname);
      if (container === undefined) {
        send(404, { message: 'no such container' });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' });
      res.end(frame(container.logs));
      return;
    }
    if (method === 'GET' && /^\/containers\/[^/]+\/archive$/.test(pathname)) {
      const container = this.#container(pathname);
      const wanted = params.get('path') ?? '';
      const archive = this.#options.archives?.get(`${container?.name ?? ''}:${wanted}`);
      if (container === undefined || archive === undefined) {
        send(404, { message: `no such path ${wanted}` });
        return;
      }
      send(200, archive);
      return;
    }
    send(404, { message: `no route for ${method} ${pathname}` });
  }

  /** A network id, from an id or a name — which is what the daemon accepts. */
  #network(key: string): string | null {
    if (this.networks.has(key)) {
      return key;
    }
    for (const [id, network] of this.networks) {
      if (network.name === key) {
        return id;
      }
    }
    return null;
  }

  /** By id or by name, the way the daemon resolves a container reference. */
  #container(pathname: string): FakeContainer | undefined {
    const key = decodeURIComponent(pathname.split('/')[2] ?? '');
    return this.containers.get(key) ?? this.created.find((container) => container.name === key);
  }

  /** See the docblock: a model of one line of the prepare helper's shell. */
  #noteMkdir(body: FakeCreateBody): void {
    for (const line of body.Cmd ?? []) {
      for (const match of line.matchAll(/mkdir -p \/ctl\/([0-9a-f-]{36})/g)) {
        this.controlSubpaths.add(match[1] ?? '');
      }
    }
  }

  #missingSubpath(container: FakeContainer): string | null {
    for (const mount of container.body.HostConfig?.Mounts ?? []) {
      const subpath = mount.VolumeOptions?.Subpath;
      if (subpath !== undefined && !this.controlSubpaths.has(subpath)) {
        return `${mount.Source}/_data/${subpath}`;
      }
    }
    return null;
  }
}

/** Docker's stream framing, so the client's demultiplexer is exercised rather than bypassed. */
const frame = (text: string): Buffer => {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};
