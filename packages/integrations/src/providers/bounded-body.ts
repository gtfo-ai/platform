/**
 * **Every provider HTTP client reads a response body through this module** — WP-190, PROGRESS
 * backlog 548.
 *
 * Until WP-190 all five clients read `response.text()` whole before parsing, so the byte caps the
 * adapters apply (`max_total_bytes`, `max_codeowners_bytes`, `getJobLog`'s tail, …) cut text that
 * was already in the process's memory. The trust boundary is an operator-allow-listed host with the
 * binding's credential, so the size is the vendor's, not an attacker's; this is hardening against a
 * vendor that misbehaves and against a very large CI trace, not a closed exploit.
 *
 * Two readers, and the choice between them is the call site's:
 *
 *  - {@link readBoundedBody} reads the stream up to a ceiling and **refuses** past it with
 *    {@link ProviderResponseTooLargeError} — `invalid_response`, naming the ceiling and the host.
 *    Never a silent cut: a JSON document cut at a byte offset is not a smaller document, and a
 *    refusal is something the caller's error path already handles.
 *  - {@link readBodyTail} keeps the **last** `tailBytes` of the stream and reports whether it cut.
 *    It has exactly one caller, the GitLab job-log read, which is the only read whose producer is
 *    known to be large and whose useful end is its tail (`gitlab/http.ts`, `JOB_LOG_TAIL_BYTES`).
 *
 * The ceiling is a **required** argument with no default (standing rule 31): each client declares
 * its own constant beside its transport, with the derivation written there. The census that holds
 * every client to this module is `response-ceiling.test.ts`, read off disk.
 *
 * Decoding matches `Response.text()`: UTF-8 with replacement, a leading BOM dropped. What a tail cut
 * leaves at its start is at most one partial UTF-8 sequence, decoded as U+FFFD.
 */
import { IntegrationError } from '@platform/application';

/** A body past its client's ceiling. The message names the ceiling and the host, never a body byte. */
export class ProviderResponseTooLargeError extends IntegrationError {
  readonly ceilingBytes: number;
  readonly host: string;

  constructor(
    provider: string,
    input: {
      readonly ceilingBytes: number;
      readonly host: string;
      readonly what: string;
      readonly action: string;
    },
  ) {
    super(
      'invalid_response',
      provider,
      `${input.what} from ${input.host} answered more than ${input.ceilingBytes} bytes; refused rather than cut`,
      { action: input.action },
    );
    this.ceilingBytes = input.ceilingBytes;
    this.host = input.host;
  }
}

export interface BoundedBodyRequest {
  /** The provider id the refusal carries. */
  readonly provider: string;
  /** The client's own ceiling, in bytes of the encoded body. Required (standing rule 31). */
  readonly ceilingBytes: number;
  /** The host the client was configured with — named in the refusal. */
  readonly host: string;
  /** `GET /path` or the method name — named in the refusal; never request data beyond that. */
  readonly what: string;
  readonly action: string;
  /**
   * What an overflow means, decided by the caller from the status **before** the read (WP-190
   * review round 1). `'refuse'` for a body the caller will use — the answer. `'drop'` for an error
   * body, which no client quotes past a slug: the overflow answers `''`, so the status keeps its
   * classification (a 503 stays `unavailable` and retryable, a 429 keeps `Retry-After`) instead of
   * becoming `invalid_response`. Required: no default decides it silently (standing rule 31).
   */
  readonly overflow: 'refuse' | 'drop';
}

/**
 * Reads the whole body when it is at most `ceilingBytes`; past it, refuses — or, for an error
 * body (`overflow: 'drop'`), answers `''`.
 */
export const readBoundedBody = async (
  response: Response,
  request: BoundedBodyRequest,
): Promise<string> => {
  const body = response.body;
  if (body === null) {
    return '';
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > request.ceilingBytes) {
        if (request.overflow === 'drop') {
          return '';
        }
        throw new ProviderResponseTooLargeError(request.provider, request);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Releases the connection on a refusal; a no-op on a stream that already ended.
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
};

export interface BodyTail {
  readonly text: string;
  /** True when bytes before the kept tail were dropped. */
  readonly truncated: boolean;
}

/**
 * Keeps the last `tailBytes` bytes of the body; memory is bounded by `tailBytes` plus one chunk.
 * Only the GitLab job-log read may call it (`response-ceiling.test.ts` holds that).
 */
export const readBodyTail = async (response: Response, tailBytes: number): Promise<BodyTail> => {
  const body = response.body;
  if (body === null) {
    return { text: '', truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let held = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      held += value.byteLength;
      // Drop whole chunks the tail can no longer reach.
      while (chunks.length > 1 && held - (chunks[0] as Uint8Array).byteLength >= tailBytes) {
        held -= (chunks.shift() as Uint8Array).byteLength;
        truncated = true;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(held);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const cut = Math.max(0, held - tailBytes);
  return {
    // A cut tail starts mid-document, so a BOM there is content rather than a marker.
    text: new TextDecoder('utf-8', { ignoreBOM: cut > 0 || truncated }).decode(
      joined.subarray(cut),
    ),
    truncated: truncated || cut > 0,
  };
};
