/**
 * A small Docker Engine API client — the only thing in the platform that talks to a daemon.
 *
 * ## Why not dockerode
 *
 * TD-021 puts the daemon behind `docker-socket-proxy`, which speaks the Engine HTTP API over TCP;
 * the launcher therefore needs an HTTP client, not a Docker library. Node's own `http` module
 * takes `socketPath` for a Unix socket and a host/port for the proxy, so one 200-line adapter
 * covers both deployments with no dependency, no CLI binary in the launcher image, and — the part
 * that matters — **request bodies this repository can see**. `engine.test.ts` runs it against a
 * real `http.Server` on a Unix socket that answers like the Engine and records what it was sent,
 * which is a stricter double than a stubbed library object: it fails on a malformed URL, a missing
 * `Content-Type`, or a body that is not the JSON we think it is.
 *
 * ## The API version is pinned in the path
 *
 * `/v1.45/…` rather than `/…`. `Mount.VolumeOptions.Subpath` — TD-025 §2's whole isolation
 * mechanism — arrived in API 1.45, and an unversioned path silently uses whatever the daemon
 * defaults to. Pinning turns "this daemon is too old" into a 400 at the first call instead of a
 * mount that quietly covers the wrong directory. Measured against Docker 29.7.2 (API 1.55,
 * minimum 1.40): the version prefix is accepted and `VolumeOptions.Subpath` is the field the
 * daemon records (`docker inspect` shows it back).
 *
 * ## Everything the daemon says is untrusted (BD-022)
 *
 * Not because the daemon is hostile, but because the strings in its answers were chosen by the
 * containers: an image name, a label, a container's own `Path`. Every response this module *reads*
 * is parsed by a zod schema before a field is touched, and the schemas are `looseObject` on
 * purpose — the Engine adds fields between versions, and refusing an unknown one would break on a
 * daemon upgrade. That is the documented exception in `CLAUDE.md` for an opaque provider payload.
 */
import { request as httpRequest } from 'node:http';
import type { Logger } from '@platform/application';
import { silentLogger, WorkspaceError } from '@platform/application';
import * as z from 'zod';

/** The Engine API version every path carries. See the docblock. */
export const ENGINE_API_VERSION = 'v1.45';

export interface EngineAddress {
  /** `/var/run/docker.sock`, or the proxy's `host:port`. Exactly one of the two. */
  readonly socketPath?: string;
  readonly host?: string;
  readonly port?: number;
}

export interface EngineOptions extends EngineAddress {
  readonly logger?: Logger;
  /** How long a single request may take. A hung daemon must not hang a run for ever. */
  readonly timeoutMs?: number;
  /** Ceiling on a buffered response body (an export archive, a log tail). */
  readonly maxResponseBytes?: number;
}

interface EngineResponse {
  readonly status: number;
  readonly body: Buffer;
}

const errorMessageSchema = z.looseObject({ message: z.string().optional() });

const engineErrorDetail = (body: Buffer): string => {
  try {
    const parsed = errorMessageSchema.parse(JSON.parse(body.toString('utf8')));
    return parsed.message ?? body.toString('utf8').slice(0, 200);
  } catch {
    return body.toString('utf8').slice(0, 200);
  }
};

// ── Response shapes ──────────────────────────────────────────────────────────

const idSchema = z.looseObject({ Id: z.string().min(1) });
const volumeSchema = z.looseObject({
  Name: z.string().min(1),
  Labels: z.record(z.string(), z.string()).nullish(),
});
const volumeListSchema = z.looseObject({ Volumes: z.array(volumeSchema).nullish() });
const waitSchema = z.looseObject({ StatusCode: z.number() });
const containerSummarySchema = z.looseObject({
  Id: z.string().min(1),
  Names: z.array(z.string()).nullish(),
  State: z.string().nullish(),
  Labels: z.record(z.string(), z.string()).nullish(),
});
const inspectSchema = z.looseObject({
  Id: z.string().min(1),
  Name: z.string(),
  State: z.looseObject({
    Status: z.string(),
    Running: z.boolean(),
    ExitCode: z.number(),
  }),
  Config: z.looseObject({
    Image: z.string(),
    User: z.string().nullish(),
    Env: z.array(z.string()).nullish(),
    Labels: z.record(z.string(), z.string()).nullish(),
  }),
  HostConfig: z.looseObject({}),
  NetworkSettings: z.looseObject({}),
  Mounts: z.array(z.looseObject({})).nullish(),
});

export type EngineVolume = z.infer<typeof volumeSchema>;
export type EngineContainerSummary = z.infer<typeof containerSummarySchema>;
export type EngineInspect = z.infer<typeof inspectSchema>;

// ── The client ───────────────────────────────────────────────────────────────

export class DockerEngine {
  readonly #address: EngineAddress;
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: EngineOptions) {
    if ((options.socketPath === undefined) === (options.host === undefined)) {
      throw new WorkspaceError(
        'engine_unavailable',
        'the Docker engine needs exactly one of socketPath or host',
      );
    }
    this.#address =
      options.socketPath === undefined
        ? { host: options.host as string, port: options.port ?? 2375 }
        : { socketPath: options.socketPath };
    this.#logger = options.logger ?? silentLogger;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 128 * 1024 * 1024;
  }

  async #send(
    method: string,
    path: string,
    body?: { readonly json: unknown } | { readonly raw: Buffer },
  ): Promise<EngineResponse> {
    const payload =
      body === undefined
        ? undefined
        : 'json' in body
          ? Buffer.from(JSON.stringify(body.json), 'utf8')
          : body.raw;
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'json' in (body ?? {}) ? 'application/json' : 'application/x-tar';
      headers['content-length'] = String(payload.length);
    }
    return new Promise<EngineResponse>((resolve, reject) => {
      const req = httpRequest(
        { ...this.#address, method, path: `/${ENGINE_API_VERSION}${path}`, headers },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > this.#maxResponseBytes) {
              res.destroy();
              reject(
                new WorkspaceError(
                  'workspace_failed',
                  'Docker engine response exceeded the limit',
                  {
                    detail: `${path} over ${this.#maxResponseBytes} bytes`,
                  },
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
          res.on('error', reject);
        },
      );
      req.setTimeout(this.#timeoutMs, () => {
        req.destroy(
          new WorkspaceError('engine_unavailable', 'Docker engine request timed out', {
            detail: `${method} ${path}`,
          }),
        );
      });
      req.on('error', (cause) =>
        reject(
          cause instanceof WorkspaceError
            ? cause
            : new WorkspaceError('engine_unavailable', 'Docker engine is unreachable', {
                detail: `${method} ${path}`,
                cause,
              }),
        ),
      );
      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    });
  }

  /**
   * Sends a request and refuses anything but the expected statuses.
   *
   * A 404 becomes `not_found` and a 409 `workspace_failed` with the daemon's own message, because
   * both are answers rather than failures: "no such container" is what `destroy` gets when it runs
   * twice, and "volume is in use" is what the retention sweep gets when a run is still going.
   */
  async #expect(
    method: string,
    path: string,
    ok: readonly number[],
    body?: { readonly json: unknown } | { readonly raw: Buffer },
  ): Promise<EngineResponse> {
    const response = await this.#send(method, path, body);
    if (ok.includes(response.status)) {
      return response;
    }
    const detail = engineErrorDetail(response.body);
    this.#logger.debug({ method, path, status: response.status }, 'docker engine refused');
    throw new WorkspaceError(
      response.status === 404 ? 'not_found' : 'workspace_failed',
      // The daemon's own words are in the *message*, not only in `detail`. A 404 that cannot name
      // its object cost this project a CI round: `POST /containers/create` answers 404 when the
      // image is absent, and `Docker engine answered 404` named the container instead — the
      // `detail` was there and nothing printed it. What is appended is the `message` field of the
      // daemon's error document (or 200 characters of a body that is not one), never an echo of
      // the request, so this does not put a helper's environment into a log line.
      `Docker engine answered ${response.status}: ${detail}`,
      { detail: `${method} ${path}: ${detail}` },
    );
  }

  #json<T>(response: EngineResponse, schema: z.ZodType<T>): T {
    const text = response.body.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new WorkspaceError('workspace_failed', 'Docker engine answered with malformed JSON', {
        detail: text.slice(0, 200),
        cause,
      });
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new WorkspaceError('workspace_failed', 'Docker engine answered an unexpected shape', {
        detail: result.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      });
    }
    return result.data;
  }

  async ping(): Promise<string> {
    const response = await this.#expect('GET', '/_ping', [200]);
    return response.body.toString('utf8').trim();
  }

  async createVolume(input: {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
  }): Promise<string> {
    const response = await this.#expect('POST', '/volumes/create', [201], {
      json: { Name: input.name, Driver: 'local', Labels: input.labels },
    });
    return this.#json(response, volumeSchema).Name;
  }

  async listVolumes(
    filters: Readonly<Record<string, readonly string[]>>,
  ): Promise<readonly EngineVolume[]> {
    const query = `?filters=${encodeURIComponent(JSON.stringify(filters))}`;
    const response = await this.#expect('GET', `/volumes${query}`, [200]);
    return this.#json(response, volumeListSchema).Volumes ?? [];
  }

  /** `force` only makes a *missing* volume a success; a volume in use is still refused. */
  async removeVolume(name: string): Promise<void> {
    await this.#expect('DELETE', `/volumes/${encodeURIComponent(name)}?force=true`, [204, 404]);
  }

  async createNetwork(input: {
    readonly name: string;
    readonly internal: boolean;
    readonly labels: Readonly<Record<string, string>>;
  }): Promise<string> {
    const response = await this.#expect('POST', '/networks/create', [201], {
      json: {
        Name: input.name,
        Driver: 'bridge',
        Internal: input.internal,
        Attachable: false,
        Labels: input.labels,
      },
    });
    return this.#json(response, idSchema).Id;
  }

  async removeNetwork(id: string): Promise<void> {
    await this.#expect('DELETE', `/networks/${encodeURIComponent(id)}`, [204, 404]);
  }

  async connectNetwork(network: string, container: string): Promise<void> {
    await this.#expect('POST', `/networks/${encodeURIComponent(network)}/connect`, [200], {
      json: { Container: container },
    });
  }

  async createContainer(name: string, body: unknown): Promise<string> {
    const response = await this.#expect(
      'POST',
      `/containers/create?name=${encodeURIComponent(name)}`,
      [201],
      { json: body },
    );
    return this.#json(response, idSchema).Id;
  }

  async startContainer(id: string): Promise<void> {
    await this.#expect('POST', `/containers/${encodeURIComponent(id)}/start`, [204, 304]);
  }

  async waitContainer(id: string): Promise<number> {
    const response = await this.#expect(
      'POST',
      `/containers/${encodeURIComponent(id)}/wait`,
      [200],
    );
    return this.#json(response, waitSchema).StatusCode;
  }

  /** Idempotent: a container that is already stopped answers 304, a missing one 404. */
  async stopContainer(id: string, timeoutSeconds: number): Promise<void> {
    await this.#expect(
      'POST',
      `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSeconds}`,
      [204, 304, 404],
    );
  }

  /**
   * Removes a container **and the anonymous volumes it owns** (`v=true`).
   *
   * `v=false` was a leak, measured at WP-22: `alpine/git` — the image every helper container runs —
   * declares `VOLUME /git`, so the daemon creates an anonymous volume for each of the five or six
   * helpers a run uses, and `v=false` left every one of them behind for ever. One `verify:e2e` run
   * produced **220** empty anonymous volumes on the developer machine this was found on; nothing
   * sweeps them, because standing rule 60's sweep matches labels and an anonymous volume has none.
   *
   * `v=true` removes **only** anonymous volumes — the daemon never removes a named one this way,
   * which is what makes this safe for the volumes this adapter actually cares about: `ws-<run>`,
   * `egress-<run>`, the control volume and the cache are all named and all created explicitly, and
   * the workspace volume in particular is *meant* to outlive its container (technical/05 §5's
   * retention). Asserted in both directions in `engine.test.ts`, because a flag that removed too
   * much and a flag that removed nothing look identical from the passing side.
   */
  async removeContainer(id: string): Promise<void> {
    await this.#expect(
      'DELETE',
      `/containers/${encodeURIComponent(id)}?force=true&v=true`,
      [204, 404],
    );
  }

  async inspectContainer(id: string): Promise<EngineInspect> {
    const response = await this.#expect('GET', `/containers/${encodeURIComponent(id)}/json`, [200]);
    return this.#json(response, inspectSchema);
  }

  async listContainers(
    filters: Readonly<Record<string, readonly string[]>>,
  ): Promise<readonly EngineContainerSummary[]> {
    const query = `?all=true&filters=${encodeURIComponent(JSON.stringify(filters))}`;
    const response = await this.#expect('GET', `/containers/json${query}`, [200]);
    return this.#json(response, z.array(containerSummarySchema));
  }

  /**
   * The container's log tail, demultiplexed.
   *
   * Diagnostics only, and bounded: a helper that failed is worth a hundred lines in the launcher's
   * log, and the agent's own output never comes through here — it travels the control socket.
   */
  async containerLogs(id: string, tail = 100): Promise<string> {
    const response = await this.#expect(
      'GET',
      `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=${tail}`,
      [200],
    );
    return demultiplex(response.body).toString('utf8');
  }

  /** `docker cp` out of a container: a tar of whatever `path` names. */
  async getArchive(id: string, path: string): Promise<Buffer> {
    const response = await this.#expect(
      'GET',
      `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(path)}`,
      [200],
    );
    return response.body;
  }

  /** `docker cp` into a container. `path` must exist; the daemon does not create it. */
  async putArchive(id: string, path: string, tar: Buffer): Promise<void> {
    await this.#expect(
      'PUT',
      `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(path)}`,
      [200],
      { raw: tar },
    );
  }
}

/**
 * Docker's stream framing: `[type, 0, 0, 0, size(4, big-endian)]` then `size` bytes.
 *
 * A body that is not framed at all (a `Tty: true` container's logs) has no header to read, so a
 * frame whose declared size runs past the buffer is treated as raw output rather than as an error:
 * this is a diagnostic path, and refusing to show an operator the reason a helper died because its
 * container happened to have a tty would be the wrong trade.
 */
export const demultiplex = (body: Buffer): Buffer => {
  const chunks: Buffer[] = [];
  let cursor = 0;
  while (cursor + 8 <= body.length) {
    const type = body[cursor] ?? 0;
    const size = body.readUInt32BE(cursor + 4);
    if (type > 2 || cursor + 8 + size > body.length) {
      return body;
    }
    chunks.push(body.subarray(cursor + 8, cursor + 8 + size));
    cursor += 8 + size;
  }
  return cursor === 0 ? body : Buffer.concat(chunks);
};
