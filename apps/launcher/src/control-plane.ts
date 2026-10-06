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
 *     and a create that is still in flight is *awaited* rather than started again. A `destroy` of a
 *     run with nothing left answers `found: false` and succeeds. **The bound of that guarantee is
 *     one launcher process** — see the next two sections for what it costs and what reaps it.
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
 * **What that residual costs was measured at WP-82** (PROGRESS backlog **136**,
 * `node scripts/launcher-control-plane-check.mjs`, Docker Engine 29.7.2 / API 1.55): a create
 * replayed after a restart — the first create having completed — is **refused at the network**.
 * The first name-derived object `create` makes is the run's network, and the daemon answers
 * `409 network with name run-<id> already exists` although `DockerEngine.createNetwork` sends no
 * `CheckDuplicate`; the runner is told `workspace_failed`. Because the refusal comes before
 * `#prepare`, the live run's `/ctl/<run-id>/token` is **not** rewritten, the rollback removes
 * nothing (this attempt made nothing), and **no second container** starts. Two earlier readings are
 * therefore both wrong on this daemon: the cheerful one (*"the container name is derived from the
 * run id, so the daemon refuses the duplicate"* — it is the network, not the container) and the
 * alarming one (*"a replayed create can overwrite the live run's shim token and then fail"*).
 *
 * What the measurement does **not** make better is the first run's container: it keeps running,
 * and no launcher holds a handle for it. Until WP-103 nothing bounded it — the lease sweep ends the
 * *row* and WP-77's recovery revokes the run's git credential, neither stops a container, and
 * `purgeExpired` removes volumes. A daemon that did not refuse the duplicate network would reach
 * `#prepare`, so the check asserts the refusal rather than assuming it survives a daemon upgrade.
 *
 * ## What reaps a container nobody holds a handle for (WP-103, TD-028 decision 12)
 *
 * PROGRESS backlog **286** measured three producers on Docker Engine 29.8.1 before the fix was
 * chosen: a create that outlives the runner's timeout **completes** here (three start attempts left
 * three running run containers, sidecars, networks and control directories); a launcher stopped or
 * killed **during** a create answers nothing and leaves the helper it was running, the network and
 * the volume, with no run container; and an unattached shim does not exit (ten minutes, measured).
 * Two things bound them now, and the division between them is the decision:
 *
 *  - **This process abandons a create whose every requester has gone** (`abandon` below): when the
 *    create resolves and each request waiting on it closed its connection before the answer, what it
 *    made is ended with no export. A replay still waiting keeps it. What this cannot reach is a
 *    launcher that dies during the create, or is stopped and outlives its grace — a killed process
 *    runs nothing. SIGTERM does wait for the in-flight create
 *    (`index.ts`), and since WP-132 (PROGRESS backlog 425) `compose.yml` gives this service a
 *    60 s stop grace, so a stop drains a create and answers it (measured: 11.7–12.6 s after the signal
 *    at load 5–7); before it a stop under the daemon's default killed the process with the create
 *    unanswered (WP-127, backlog 339). What remains is a kill, a create longer than the grace — and
 *    a create that resolves in the instant before its socket's close arrives.
 *  - **The runner reaps what is left** (`packages/application/src/recovery/orphan-workspaces.ts`),
 *    because deciding that a run is over needs `runs` and this process reads no database (TD-021).
 *    It asks the two verbs below: `GET /v1/runs`, the run ids of the containers and networks this
 *    **instance** labelled (networks since WP-118's pre-review round), read off the daemon — never off `creates`, which a restart empties — and
 *    `POST /v1/runs/<id>/destroy`, which removes a run by label with no handle and is serialised
 *    behind this process' own create and end of the same run. The instance is the control volume's
 *    name (`WORKSPACE_LABELS.instance`); `DockerWorkspaceProvider.listLabelledRuns` states the two
 *    residuals — a shared control volume is one instance, and a pre-WP-103 container is never listed.
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
import {
  WorkspaceError,
  type WorkspaceErrorReason,
  type WorkspaceProtocols,
} from '@platform/application';
import { launcher as launcherProtocol } from '@platform/infrastructure';
import * as z from 'zod';
import type { LauncherService } from './service.js';

const {
  CONTROL_PLANE_MAX_BODY_BYTES,
  CONTROL_PLANE_PATHS,
  CONTROL_PLANE_STATUS_BY_CODE,
  createRunRequestSchema,
  destroyRunRequestSchema,
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
  /**
   * Every request waiting on this create — the first and any replay — and the ones among them whose
   * connection closed before an answer was written (WP-103). When every waiter has gone, nobody will
   * ever hold the handle, and the create is abandoned: what it made is removed.
   */
  readonly waiters: Set<ServerResponse>;
  readonly gone: Set<ServerResponse>;
}

/** Remembers a waiter, and marks it gone if its connection closes before the answer is written. */
const watch = (record: CreateRecord, response: ServerResponse): void => {
  record.waiters.add(response);
  response.once('close', () => {
    if (!response.writableFinished) {
      record.gone.add(response);
    }
  });
};

const everyWaiterGone = (record: CreateRecord): boolean =>
  record.waiters.size > 0 && [...record.waiters].every((waiter) => record.gone.has(waiter));

class ControlPlaneError extends Error {
  readonly code: ControlPlaneErrorCode;
  readonly runId: string | null;
  readonly detail: string | null;
  /** The workspace's platform-written cause, carried across so the runner can name it (WP-127). */
  readonly reason: WorkspaceErrorReason | null;
  readonly commit: string | null;
  /** The failing step's own redacted words, for the run page (backlog 453, `WorkspaceError.output`). */
  readonly output: string | null;
  readonly outputTruncated: boolean;
  /** A run-image protocol refusal's two numbers (WP-151 round 1, `WorkspaceError.protocols`). */
  readonly protocols: WorkspaceProtocols | null;

  constructor(
    code: ControlPlaneErrorCode,
    message: string,
    options: {
      readonly runId?: string | null;
      readonly detail?: string | null;
      readonly reason?: WorkspaceErrorReason | null;
      readonly commit?: string | null;
      readonly output?: string | null;
      readonly outputTruncated?: boolean;
      readonly protocols?: WorkspaceProtocols | null;
    } = {},
  ) {
    super(message);
    this.name = 'ControlPlaneError';
    this.code = code;
    this.runId = options.runId ?? null;
    this.detail = options.detail ?? null;
    this.reason = options.reason ?? null;
    this.commit = options.commit ?? null;
    this.output = options.output ?? null;
    this.outputTruncated = options.outputTruncated ?? false;
    this.protocols = options.protocols ?? null;
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
      reason: error.reason,
      commit: error.commit,
      output: error.output,
      outputTruncated: error.outputTruncated,
      protocols: error.protocols,
    });
  }
  // Deliberately **not** the thrown message: an unclassified failure from inside the launcher may
  // carry a path, a command line or a daemon response, and this surface answers a different
  // process. The launcher's own log keeps the cause.
  return new ControlPlaneError('internal', 'the launcher could not complete this operation');
};

export const startControlPlane = async (options: ControlPlaneOptions): Promise<ControlPlane> => {
  const creates = new Map<string, CreateRecord>();
  /** Ends in flight, by run id, so a destroy of the same run waits for them (WP-103). */
  const ends = new Map<string, Promise<unknown>>();
  const { logger } = options;

  /**
   * WP-103: a create whose every requester closed its connection before the answer is **abandoned**
   * — the workspace it made is ended here, with no export, because no process will ever hold its
   * handle. Measured before this existed (PROGRESS backlog 286 (b)): a create that outlived the
   * runner's timeout completed, and each of a stage's three start attempts left a running run
   * container, a sidecar, a network and a control directory with a live token.
   *
   * What it cannot reach, and why: **a launcher that stops or dies during the create.** A killed
   * process runs nothing, and a stopped one is not given the time — `docker stop` measured the
   * in-flight create interrupted, not finished, and what it left (the helper it was running, the
   * network, the volume) belongs to no request any more. Those are the runner-side reaper's
   * (`packages/application/src/recovery/orphan-workspaces.ts`), which lists them off the daemon.
   */
  const abandon = async (runId: string, created: CreateRunResponse): Promise<void> => {
    creates.delete(runId);
    // Registered like any end, so a destroy of the same run waits for it (WP-103 review).
    const ending = options.service.endRun(created.handle, { export: null });
    ends.set(runId, ending);
    try {
      await ending;
      logger.warn(
        { run_id: runId },
        'a create request closed before its answer was written, so nobody holds this run’s handle: the workspace it made was removed (WP-103, PROGRESS backlog 286)',
      );
    } catch (error) {
      logger.error(
        { run_id: runId, err: error },
        'a create request closed before its answer and the workspace it made could not be removed; the runner-side reaper lists it on its next pass (PROGRESS backlog 286)',
      );
    } finally {
      if (ends.get(runId) === ending) {
        ends.delete(runId);
      }
    }
  };

  const createRun = async (body: string, response: ServerResponse): Promise<CreateRunResponse> => {
    const request = parseBody(body, createRunRequestSchema, 'the create request');
    const spec: WorkspaceSpec = request.spec;
    const existing = creates.get(spec.runId);
    if (existing !== undefined) {
      // Awaited rather than re-started: a redelivery that arrives while the first create is still
      // cloning must not produce a second container (TD-028 decision 4).
      watch(existing, response);
      return { ...(await existing.promise), replayed: true };
    }
    const promise = (async (): Promise<CreateRunResponse> => {
      const started = await options.service.startRun(spec, request.credential);
      return {
        handle: started.handle,
        attachment: started.attachment,
        claudeCodePath: options.claudeCodePath,
        credentialScope: started.credentialScope,
        existingProtectedPaths: started.existingProtectedPaths,
        cliEnvironment: started.cliEnvironment,
        replayed: false,
      };
    })();
    const record: CreateRecord = { promise, waiters: new Set(), gone: new Set() };
    watch(record, response);
    creates.set(spec.runId, record);
    try {
      const created = await promise;
      if (everyWaiterGone(record)) {
        await abandon(spec.runId, created);
      }
      return created;
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
    const ending = options.service.endRun(request.handle, {
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
              // Backlog 467: an unsuccessful run's export pushes nothing for an unchanged tree.
              ...(request.export.onlyIfChanged === true ? { onlyIfChanged: true } : {}),
            },
    });
    ends.set(runId, ending);
    let ended: Awaited<typeof ending>;
    try {
      ended = await ending;
    } finally {
      if (ends.get(runId) === ending) {
        ends.delete(runId);
      }
    }
    // After the end, not before: a `create` that arrives while an end is in flight should meet the
    // handle it is about rather than start a second container for a run that is being torn down.
    creates.delete(runId);
    return { exported: ended.exported, keepUntil: ended.keepUntil, failures: ended.failures };
  };

  /**
   * TD-028 decision 12's destroy (WP-103): by run id, with no handle, found by label.
   *
   * **Serialised behind this process' own create and end of the same run**, whose outcome it does
   * not care about: a destroy that interleaved with a create would race the create's own objects,
   * and one that interleaved with a take-over's export would stop the export mid-push. The reaper's
   * grace is the first line against the second case; this is the second.
   */
  const destroyRun = async (runId: string, body: string): Promise<unknown> => {
    parseBody(body, destroyRunRequestSchema, 'the destroy request');
    await creates.get(runId)?.promise.catch(() => undefined);
    await ends.get(runId)?.catch(() => undefined);
    const destroyed = await options.service.destroyRun(runId);
    creates.delete(runId);
    return { found: destroyed.found };
  };

  const route = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<unknown> => {
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
      return await createRun(await readBody(request), response);
    }
    if (request.method === 'GET' && path === CONTROL_PLANE_PATHS.runs) {
      // Read off the daemon, never off `creates` (WP-103): the orphans this exists for are the runs
      // a restarted process has forgotten.
      return { runs: await options.service.listRuns() };
    }
    const end = new RegExp(
      `^${CONTROL_PLANE_PATHS.runs}/([^/]{1,64})/${CONTROL_PLANE_PATHS.end}$`,
    ).exec(path);
    if (request.method === 'POST' && end !== null) {
      return await endRun(decodeURIComponent(end[1] as string), await readBody(request));
    }
    const destroy = new RegExp(
      `^${CONTROL_PLANE_PATHS.runs}/([^/]{1,64})/${CONTROL_PLANE_PATHS.destroy}$`,
    ).exec(path);
    if (request.method === 'POST' && destroy !== null) {
      return await destroyRun(decodeURIComponent(destroy[1] as string), await readBody(request));
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
        const payload = await route(request, response, url);
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
            reason: failure.reason,
            commit: failure.commit,
            output: failure.output,
            outputTruncated: failure.outputTruncated,
            protocols: failure.protocols,
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
