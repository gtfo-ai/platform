/**
 * The runner's half of TD-028's control plane: an HTTP client behind the `WorkspaceProvider` port.
 *
 * It is **not a Docker client** and that is the property this whole shape exists to preserve.
 * TD-021's WP-15g amendment forbids the process that composes the pipeline or serves `/webhooks/*`
 * from constructing one, and `apps/launcher/src/docker-access.test.ts` reads every tracked source
 * off disk to refuse one. What this file constructs is a `fetch` against a URL an operator
 * configured; the daemon stays in the `platform-launcher` container.
 *
 * ## Three things are decided here rather than left to `fetch`
 *
 *  - **A redirect is refused, never followed.** `redirect: 'error'`, for the reason
 *    `dependencies/registry-metadata.ts` gives one directory away: *"a redirect is how an
 *    allow-listed host hands the request to one that is not"*. This request carries
 *    `APP_LAUNCHER_TOKEN` in a header, so a followed 302 would hand the instance's launcher secret
 *    to whatever host the `Location` named. PROGRESS backlog **129** is the same defect in the five
 *    provider adapters; this client is written with the answer rather than into the entry.
 *  - **Every request is bounded in time.** An `AbortSignal.timeout`, because a `create` that hangs
 *    holds a `stage.execute` worker — and a worker that never returns is a queue that stops, which
 *    is worse than a run that fails and is retried (Q59(a)).
 *  - **Every failure is a {@link WorkspaceError}**, so `classifyProvisionFailure` decides
 *    retryability from the same four codes it always has and the stage executor's ending is
 *    unchanged. A body that does not parse falls back to the status (see
 *    `controlPlaneCodeOfStatus`), and a transport error — DNS, refused connection, timeout — is
 *    `engine_unavailable`, which is the retryable one.
 *
 * ## What is never logged
 *
 * The response body. It carries the run token (see `workspaceAttachmentSchema`'s docblock), and a
 * debug line with a body in it is how a credential reaches a log file that outlives the run. What is
 * logged is the path, the status and the run id.
 */
import { type Logger, silentLogger, WorkspaceError } from '@platform/application';
import * as z from 'zod';
import {
  CONTROL_PLANE_PATHS,
  type CreateRunRequestPayload,
  type CreateRunResponse,
  controlPlaneCodeOfStatus,
  createRunResponseSchema,
  type EndRunRequestPayload,
  type EndRunResponse,
  endRunResponseSchema,
  errorResponseSchema,
  type HealthResponse,
  healthResponseSchema,
  workspaceCodeOfControlPlaneCode,
} from './protocol.js';

/** The `fetch` this client calls. Injected so the unit tier needs no listener. */
export type LauncherFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly redirect: 'error';
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  text(): Promise<string>;
}>;

export interface LauncherControlClientOptions {
  /** `http://launcher:7780` — the launcher's address on the internal network (TD-028 decision 2). */
  readonly baseUrl: string;
  /** `APP_LAUNCHER_TOKEN`. Refused empty: an empty shared secret is not a shared secret (rule 18). */
  readonly token: string;
  /**
   * How long one control-plane call may take.
   *
   * The default is generous because `create` is genuinely slow — a mirror fetch over the network, a
   * clone, three helper containers and a wait for the shim's socket — and a timeout below the work
   * would turn every first run of a large repository into a retry storm. `DockerWorkspaceProvider`
   * bounds the socket wait itself at 30 s, so this is the outer bound rather than the useful one.
   */
  readonly timeoutMs?: number;
  readonly fetch?: LauncherFetch;
  readonly logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface LauncherControlClient {
  createRun(request: CreateRunRequestPayload): Promise<CreateRunResponse>;
  endRun(runId: string, request: EndRunRequestPayload): Promise<EndRunResponse>;
  health(): Promise<HealthResponse>;
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * The base URL, normalised and refused when it is not one this client may call.
 *
 * `http:` and `https:` only, and **no credentials in the URL**: a `http://user:pass@launcher/`
 * would put a second secret in a variable whose whole documented content is an address, and
 * `fetch` would send it. The scheme check is the same closed answer `httpUrlSchema` gives the
 * integration hosts (Q49) — `javascript:`, `file:` and `data:` are URLs too.
 */
export const parseLauncherBaseUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WorkspaceError('invalid_spec', `APP_LAUNCHER_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WorkspaceError(
      'invalid_spec',
      `APP_LAUNCHER_URL must be http:// or https:// (got ${url.protocol})`,
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WorkspaceError(
      'invalid_spec',
      'APP_LAUNCHER_URL must not carry credentials; the launcher token is APP_LAUNCHER_TOKEN',
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
};

export const createLauncherControlClient = (
  options: LauncherControlClientOptions,
): LauncherControlClient => {
  const base = parseLauncherBaseUrl(options.baseUrl);
  const logger = options.logger ?? silentLogger;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = options.fetch ?? (globalThis.fetch as unknown as LauncherFetch);
  if (options.token.trim().length === 0) {
    throw new WorkspaceError(
      'invalid_spec',
      'APP_LAUNCHER_TOKEN is empty; the control plane creates containers and is authenticated on every request (TD-028 decision 3)',
    );
  }

  const request = async <T>(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    schema: z.ZodType<T>,
    runId: string | null,
  ): Promise<T> => {
    const url = `${base}${path}`;
    let status: number;
    let text: string;
    try {
      const response = await call(url, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (cause) {
      // DNS, a refused connection, a timeout, or the refused redirect above. All of them are
      // "the launcher could not be reached", which is the retryable code.
      throw new WorkspaceError(
        'engine_unavailable',
        `the launcher control plane could not be reached at ${url}: ${describe(cause)}`,
        { ...(runId === null ? {} : { runId }), cause },
      );
    }
    if (status >= 200 && status < 300) {
      const parsed = schema.safeParse(parseJson(text));
      if (!parsed.success) {
        throw new WorkspaceError(
          'workspace_failed',
          `the launcher control plane answered ${path} with a body this build cannot read`,
          {
            ...(runId === null ? {} : { runId }),
            detail: z.prettifyError(parsed.error).slice(0, 500),
          },
        );
      }
      logger.debug({ run_id: runId, path, status }, 'launcher control plane answered');
      return parsed.data;
    }
    const failure = errorResponseSchema.safeParse(parseJson(text));
    const code = failure.success ? failure.data.error.code : controlPlaneCodeOfStatus(status);
    const message = failure.success
      ? failure.data.error.message
      : `the launcher control plane answered ${String(status)} for ${method} ${path}`;
    throw new WorkspaceError(workspaceCodeOfControlPlaneCode(code), message, {
      ...(runId === null ? {} : { runId }),
      detail: `${code} (HTTP ${String(status)})`,
    });
  };

  return {
    createRun: async (payload) =>
      request(
        CONTROL_PLANE_PATHS.runs,
        'POST',
        payload,
        createRunResponseSchema,
        payload.spec.runId,
      ),
    endRun: async (runId, payload) =>
      request(
        `${CONTROL_PLANE_PATHS.runs}/${encodeURIComponent(runId)}/${CONTROL_PLANE_PATHS.end}`,
        'POST',
        payload,
        endRunResponseSchema,
        runId,
      ),
    health: async () =>
      request(CONTROL_PLANE_PATHS.health, 'GET', undefined, healthResponseSchema, null),
  };
};

/** `JSON.parse` that answers `undefined` instead of throwing; the schema reports the shape. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
