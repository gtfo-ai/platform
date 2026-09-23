/**
 * TD-028's control plane, server half — the launcher's HTTP surface, and the reason
 * `service.ts`'s *"what is deliberately not here: a network transport"* is now false.
 *
 * Five facts about it, each of which is a decision in TD-028 rather than an implementation detail:
 *
 *  1. **Only the control plane is HTTP.** The run's stdio never crosses it. TD-025 §2's static `ctl`
 *     mount and the per-run Unix socket are unchanged, and what this returns from `create` is the
 *     coordinates of that socket. Relaying stdio through this process is TD-025 §5's fallback (a),
 *     which that record already ranks below the shim.
 *  2. **It is authenticated on every request**, with a constant-time comparison, *in addition to*
 *     the `internal: true` network it listens on. A control plane that is safe only because of a
 *     compose file is safe until somebody writes a different compose file, and this one creates
 *     containers (TD-028 decision 3, BD-002, standing rule 18).
 *  3. **Every operation is idempotent on the run id** (decision 4). At-least-once delivery is this
 *     platform's assumption everywhere else, and an operation that starts a container must not be
 *     the exception: a `create` for a run that already has a handle answers the **stored** handle,
 *     and a create that is still in flight is *awaited* rather than started again.
 *  4. **Failure is typed** (decision 7): a `WorkspaceError` keeps its code across the wire, so the
 *     runner's `classifyProvisionFailure` decides retryability from the same four values it always
 *     has and the stage executor's ending is unchanged (Q59).
 *  5. **The body is bounded before it is parsed.** There is no reverse proxy on an internal compose
 *     network, so the only bound is the one this file applies.
 *
 * ## What the idempotency map is, and what it is not
 *
 * It is the answer to *"have **I** already created this run"*, held in this process' memory. It is
 * **not** a record of what is running: a launcher that restarted has forgotten, and that is why
 * `end` carries the handle back rather than looking it up here.
 *
 * So TD-028 decision 4's guarantee is real **within one launcher process** and is not preserved
 * across a restart — the decision's second WP-53 amendment scopes it that way, and a durable store
 * would need a database connection the same decision's topology denies this container
 * (`compose.yml`'s launcher joins neither the default network nor `db`, which is the argument that
 * rejected pg-boss as the transport).
 *
 * **What that residual costs is open, and this comment must not close it.** A create replayed after a
 * restart does not find the stored handle; what happens next is PROGRESS backlog **136**'s question,
 * and its three candidates are a **name collision** that leaves the first run's container orphaned,
 * a **rollback**, or a **second container**. Which one occurs is **unmeasured**.
 *
 * An earlier draft of this paragraph asserted the cheerful one — no second container, "because every
 * object's name is derived from the run id, so the daemon refuses the duplicate" — and that
 * mechanism is **wrong on this tree**. The first name-derived object `create` makes is the
 * **network**, `createVolume` is idempotent, and `#prepare`, which **rewrites `/ctl/<run-id>/token`**,
 * runs *before* any container name is used; `DockerEngine.createNetwork` sends no `CheckDuplicate`,
 * so whether the daemon refuses at all is version-dependent. So the collision, if it happens, is the
 * network or the sidecar — and the realistic bad case is **not** fail-closed: a replayed create can
 * overwrite the live run's shim token and *then* fail, orphaning the container it never knew about.
 *
 * TD-028's second WP-53 amendment states the same three candidates, and backlog **136** owns the
 * measurement. Nothing here should be read as having taken it.
 *
 * ## What is never logged
 *
 * The token, the request body and the response body. The body carries the run token
 * (`workspaceAttachmentSchema`'s docblock says why it may), and a debug line with a body in it is
 * how a credential outlives the run that needed it.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger, WorkspaceSpec } from '@platform/application';
import { WorkspaceError } from '@platform/application';
import { launcher as launcherProtocol } from '@platform/infrastructure';
import * as z from 'zod';
import type { LauncherService } from './service.js';

const {
  CONTROL_PLANE_MAX_BODY_BYTES,
  CONTROL_PLANE_PATHS,
  CONTROL_PLANE_STATUS_BY_CODE,
  createRunRequestSchema,
  endRunRequestSchema,
} = launcherProtocol;

type CreateRunResponse = launcherProtocol.CreateRunResponse;
type ControlPlaneErrorCode = launcherProtocol.ControlPlaneErrorCode;

export interface ControlPlaneOptions {
  readonly service: LauncherService;
  /** `APP_LAUNCHER_TOKEN`. Refused empty by `readLauncherConfig`, never defaulted. */
  readonly token: string;
  readonly host: string;
  /** `0` asks the OS for a free port — the unit tier's shape, never production's. */
  readonly port: number;
  /** Reported by `/v1/health` so an operator can compare it with the runner's own. */
  readonly controlRoot: string;
  readonly runtimeImage: string;
  /** Where the CLI is in the run image; answered on every `create` (PROGRESS backlog 34). */
  readonly claudeCodePath: string;
  readonly logger: Logger;
}

export interface ControlPlane {
  readonly port: number;
  close(): Promise<void>;
}

/** One run's create, as this process remembers it. */
interface CreateRecord {
  readonly promise: Promise<CreateRunResponse>;
}

class ControlPlaneError extends Error {
  readonly code: ControlPlaneErrorCode;
  readonly runId: string | null;
  readonly detail: string | null;

  constructor(
    code: ControlPlaneErrorCode,
    message: string,
    options: { readonly runId?: string | null; readonly detail?: string | null } = {},
  ) {
    super(message);
    this.name = 'ControlPlaneError';
    this.code = code;
    this.runId = options.runId ?? null;
    this.detail = options.detail ?? null;
  }
}

/**
 * Constant-time secret comparison.
 *
 * Over **sha256 digests** rather than the raw bytes, because `timingSafeEqual` throws on a length
 * mismatch — which would make the length of the expected token observable from whether the call
 * threw. Digesting first makes both sides 32 bytes whatever the caller sent, so the only thing the
 * timing can tell an attacker is that a hash was computed.
 */
export const tokenMatches = (presented: string, expected: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(presented, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest(),
  );

/** `Authorization: Bearer <token>`, or nothing. Case-insensitive on the scheme, as RFC 9110 is. */
export const bearerOf = (header: string | undefined): string | null => {
  if (header === undefined) {
    return null;
  }
  const match = /^bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
};

/**
 * Reads a request body, refusing one that is too big **while it arrives** rather than after.
 *
 * `request.destroy()` on the overrun: a 413 written to a socket the client is still streaming into
 * is a 413 nobody reads, and continuing to buffer would make the bound decorative.
 */
const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > CONTROL_PLANE_MAX_BODY_BYTES) {
      request.destroy();
      throw new ControlPlaneError(
        'bad_request',
        `the request body is larger than ${String(CONTROL_PLANE_MAX_BODY_BYTES)} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const parseBody = <T>(text: string, schema: z.ZodType<T>, what: string): T => {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new ControlPlaneError('bad_request', `${what} is not JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ControlPlaneError('bad_request', `${what} did not validate`, {
      detail: z.prettifyError(parsed.error).slice(0, 500),
    });
  }
  return parsed.data;
};

const errorOf = (error: unknown): ControlPlaneError => {
  if (error instanceof ControlPlaneError) {
    return error;
  }
  if (error instanceof WorkspaceError) {
    return new ControlPlaneError(error.code, error.message, {
      runId: error.runId,
      detail: error.detail,
    });
  }
  // Deliberately **not** the thrown message: an unclassified failure from inside the launcher may
  // carry a path, a command line or a daemon response, and this surface answers a different
  // process. The launcher's own log keeps the cause.
  return new ControlPlaneError('internal', 'the launcher could not complete this operation');
};

export const startControlPlane = async (options: ControlPlaneOptions): Promise<ControlPlane> => {
  const creates = new Map<string, CreateRecord>();
  const { logger } = options;

  const createRun = async (body: string): Promise<CreateRunResponse> => {
    const request = parseBody(body, createRunRequestSchema, 'the create request');
    const spec: WorkspaceSpec = request.spec;
    const existing = creates.get(spec.runId);
    if (existing !== undefined) {
      // Awaited rather than re-started: a redelivery that arrives while the first create is still
      // cloning must not produce a second container (TD-028 decision 4).
      return { ...(await existing.promise), replayed: true };
    }
    const promise = (async (): Promise<CreateRunResponse> => {
      const started = await options.service.startRun(spec, request.credential);
      return {
        handle: started.handle,
        attachment: started.attachment,
        claudeCodePath: options.claudeCodePath,
        credentialMinted: started.credential !== null,
        replayed: false,
      };
    })();
    creates.set(spec.runId, { promise });
    try {
      return await promise;
    } catch (error) {
      // A failed create left nothing behind — `LauncherService.startRun` destroys what it made —
      // so the next attempt must be allowed to try again rather than replaying a rejection for
      // ever (standing rule 54: the guarantee is the composition root's).
      creates.delete(spec.runId);
      throw error;
    }
  };

  const endRun = async (runId: string, body: string): Promise<unknown> => {
    const request = parseBody(body, endRunRequestSchema, 'the end request');
    if (request.handle.runId !== runId) {
      throw new ControlPlaneError(
        'bad_request',
        'the handle in the body names a different run from the path',
        { runId },
      );
    }
    const ended = await options.service.endRun(request.handle, {
      export:
        request.export === null
          ? null
          : {
              branch: request.export.branch,
              commitMessage: request.export.commitMessage,
              tarball: request.export.tarball,
              ...(request.export.keepUntil === undefined
                ? {}
                : { keepUntil: request.export.keepUntil }),
            },
    });
    // After the end, not before: a `create` that arrives while an end is in flight should meet the
    // handle it is about rather than start a second container for a run that is being torn down.
    creates.delete(runId);
    return { exported: ended.exported, keepUntil: ended.keepUntil, failures: ended.failures };
  };

  const route = async (request: IncomingMessage, url: URL): Promise<unknown> => {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'GET' && path === CONTROL_PLANE_PATHS.health) {
      return {
        status: 'ok',
        controlRoot: options.controlRoot,
        runtimeImage: options.runtimeImage,
        claudeCodePath: options.claudeCodePath,
        runs: creates.size,
      };
    }
    if (request.method === 'POST' && path === CONTROL_PLANE_PATHS.runs) {
      return await createRun(await readBody(request));
    }
    const end = new RegExp(
      `^${CONTROL_PLANE_PATHS.runs}/([^/]{1,64})/${CONTROL_PLANE_PATHS.end}$`,
    ).exec(path);
    if (request.method === 'POST' && end !== null) {
      return await endRun(decodeURIComponent(end[1] as string), await readBody(request));
    }
    throw new ControlPlaneError(
      'not_found',
      `no control-plane operation at ${request.method ?? '?'} ${path}`,
    );
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://launcher.invalid');
      try {
        const presented = bearerOf(request.headers.authorization);
        if (presented === null || !tokenMatches(presented, options.token)) {
          throw new ControlPlaneError('unauthorized', 'the launcher token is missing or wrong');
        }
        const payload = await route(request, url);
        send(response, 200, payload);
      } catch (error) {
        const failure = errorOf(error);
        if (failure.code === 'internal') {
          logger.error({ err: error, path: url.pathname }, 'the control plane failed a request');
        } else {
          logger.warn(
            { code: failure.code, path: url.pathname, run_id: failure.runId },
            'the control plane refused a request',
          );
        }
        send(response, CONTROL_PLANE_STATUS_BY_CODE[failure.code], {
          error: {
            code: failure.code,
            message: failure.message,
            runId: failure.runId,
            detail: failure.detail,
          },
        });
      }
    })();
  });
  // A request that stalls mid-body must not hold a socket for ever; the default in Node is 0 (off).
  server.requestTimeout = 60_000;
  server.headersTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  logger.info(
    { host: options.host, port, runtime_image: options.runtimeImage },
    'the launcher control plane is listening (TD-028)',
  );

  return {
    port,
    /**
     * Stops accepting, lets in-flight requests finish, and **then** resolves.
     *
     * `closeIdleConnections()` is what makes that terminate at all: `server.close()` waits for every
     * connection to end, and an HTTP/1.1 keep-alive connection does not end on its own. Standing
     * rule 85's caveat applies and is stated rather than hidden — a resolved `close()` is a claim
     * about this server's bookkeeping, not about the kernel having released the port.
     */
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    },
  };
};

const send = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body).toString(),
    // This surface answers one client and stores nothing in a browser; the headers that matter are
    // the ones that say "do not treat this as a document".
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  response.end(body);
};
