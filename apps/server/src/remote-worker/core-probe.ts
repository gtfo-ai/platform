/**
 * **Is this address a platform?** — WP-294 (3), TD-031's 2026-11-05 first-run amendment §3 and §6.
 *
 * The wizard's *Connect to a platform* asks the **worker**, never the browser (whose CSP allows
 * `connect-src 'self'` and whose loopback is not the core's), to check an address before it is kept:
 *
 * 1. The address is `https:`, or `http:` only to this machine (`host.docker.internal`, `localhost`,
 *    `127.0.0.1`, `[::1]`), and carries no userinfo — else `address_refused`, and nothing is sent.
 * 2. `GET /api/version` and `GET /api/worker/v1/release`, each with `X-Worker-Protocol`,
 *    `redirect: 'error'`, a 5 s timeout, a 64 KiB cap on the body and **no credential**.
 * 3. Each answer is parsed by the core's own strict schema; only the parsed fields reach the page
 *    (the host, the version, whether the protocol fits) — never the body. A failure is a **class**:
 *    `no_answer`, `not_a_platform`, `certificate`, `needs_other_version` (the `426`).
 *
 * An older core whose `release` still needs a credential answers `401`: the address is taken on
 * `/api/version` alone, *checked partly* (`protocol_fit: 'unknown'`).
 *
 * SSRF, stated: the person holds the page and owns the machine, so the fetch reaches nothing they
 * could not `curl`; the bounds keep the worker from becoming a reader of arbitrary bodies.
 */
import {
  versionResponseSchema,
  WORKER_API_PREFIX,
  WORKER_PATHS,
  WORKER_PROTOCOL_HEADER,
  WORKER_PROTOCOL_VERSION,
  type WorkerLocalCoreCheckResponse,
  type WorkerLocalCoreFailure,
  workerReleaseResponseSchema,
} from '@platform/contracts';
import { coreOriginOf } from './config.js';
import type { CoreFetch } from './core-client.js';

/** The longest one check request may take. */
export const CORE_CHECK_TIMEOUT_MS = 5_000;
/** The most of an answer's body the worker reads. */
export const CORE_CHECK_MAX_BYTES = 64 * 1024;

/** A check that did not find a platform, by class. */
export class CoreCheckError extends Error {
  override readonly name = 'CoreCheckError';
  readonly failure: WorkerLocalCoreFailure;
  constructor(failure: WorkerLocalCoreFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

/** The TLS failures Node's `fetch` names in its `cause.code` (undici over `node:tls`). */
const CERTIFICATE_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i;

/** A transport failure's class: a certificate it could not trust, or no answer. */
export const transportFailureOf = (error: unknown): WorkerLocalCoreFailure => {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const message = typeof cause?.message === 'string' ? cause.message : '';
  if (CERTIFICATE_CODES.test(code) || /certificate/i.test(message)) return 'certificate';
  if (/redirect/i.test(message) || /redirect/i.test(String((error as Error)?.message ?? ''))) {
    return 'not_a_platform';
  }
  return 'no_answer';
};

/** The body as text, refusing past {@link CORE_CHECK_MAX_BYTES} — read as a stream, never whole. */
const boundedText = async (response: Response): Promise<string> => {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CORE_CHECK_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new CoreCheckError('not_a_platform', 'the answer is larger than a platform’s');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const get = async (
  fetcher: CoreFetch,
  url: string,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL_VERSION),
      },
      // No credential is ever sent here, and a redirect is not followed anywhere.
      redirect: 'error',
      signal: AbortSignal.timeout(CORE_CHECK_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CoreCheckError(transportFailureOf(error), 'the address did not answer');
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new CoreCheckError('not_a_platform', 'the address answered with a redirect');
  }
  let text: string;
  try {
    text = await boundedText(response);
  } catch (error) {
    if (error instanceof CoreCheckError) throw error;
    throw new CoreCheckError('no_answer', 'the answer was cut off');
  }
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
};

/**
 * Checks `address` as a platform: its origin, host, version and whether this worker's protocol
 * fits — or a {@link CoreCheckError} naming the class.
 */
export const checkCoreAddress = async (
  address: string,
  fetcher: CoreFetch = (url, init) => fetch(url, init),
): Promise<WorkerLocalCoreCheckResponse> => {
  const origin = coreOriginOf(address);
  if (origin === null) {
    throw new CoreCheckError(
      'address_refused',
      'use an https address, or http to this machine only, with no user name or password in it',
    );
  }
  const version = await get(fetcher, `${origin}/api/version`);
  const parsedVersion = versionResponseSchema.safeParse(version.body);
  if (version.status !== 200 || !parsedVersion.success) {
    throw new CoreCheckError('not_a_platform', 'the address does not answer as a platform');
  }
  const release = await get(fetcher, `${origin}${WORKER_API_PREFIX}/${WORKER_PATHS.release}`);
  let fit: WorkerLocalCoreCheckResponse['protocol_fit'] = 'unknown';
  if (release.status === 426) {
    throw new CoreCheckError(
      'needs_other_version',
      'the platform serves another version of the worker protocol',
    );
  }
  if (release.status === 200) {
    const parsedRelease = workerReleaseResponseSchema.safeParse(release.body);
    if (!parsedRelease.success) {
      throw new CoreCheckError('not_a_platform', 'the address does not answer as a platform');
    }
    if (!parsedRelease.data.protocol.accepted.includes(WORKER_PROTOCOL_VERSION)) {
      throw new CoreCheckError(
        'needs_other_version',
        'the platform serves another version of the worker protocol',
      );
    }
    fit = 'fits';
  }
  // A `401` is an older core whose `release` needed a credential; a `503` one whose digests are
  // not resolved yet: the address is a platform by `/api/version`, checked partly.
  return {
    url: origin,
    host: new URL(origin).host,
    version: parsedVersion.data.version.slice(0, 128),
    protocol_fit: fit,
  };
};

/** The candidates that answer as a platform, in their order (TD-031's first-run amendment §3). */
export const probeCoreCandidates = async (
  candidates: readonly string[],
  fetcher?: CoreFetch,
): Promise<{ readonly url: string; readonly version: string }[]> => {
  const answers = await Promise.all(
    candidates.map((candidate) =>
      checkCoreAddress(candidate, fetcher).then(
        (found) => ({ url: found.url, version: found.version }),
        () => null,
      ),
    ),
  );
  return answers.filter((answer): answer is { url: string; version: string } => answer !== null);
};
