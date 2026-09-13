/**
 * Content coding for the bytes the SPA fallback serves (WP-15j review round 2).
 *
 * ## Why this exists beside `@fastify/compress` rather than instead of it
 *
 * TD-002 puts `@fastify/compress` in the stack, and `app.ts` registers it. It cannot serve the
 * browser application, and the reason is structural rather than a configuration mistake —
 * **measured on `@fastify/compress@9.2.0` and `fastify@5.12.3` before this module was written**
 * (standing rule 13):
 *
 * | response                                   | `content-encoding` with `accept-encoding: gzip` |
 * |--------------------------------------------|-------------------------------------------------|
 * | a registered route returning 8 000 B        | `gzip`                                          |
 * | the **not-found handler** returning 8 000 B | *none* — 8 000 B on the wire                    |
 *
 * The plugin adds its `onSend` through an `onRoute` hook (`index.js:65`), and Fastify emits no
 * `onRoute` for the context `setNotFoundHandler` creates — `lib/four-oh-four.js` builds that
 * context at `preReady` out of `instance[kHooks]`, the hooks added with `addHook`, which is not
 * where the plugin puts its own. The SPA is served *from* that handler (`fallback.ts` explains
 * why, and it is what makes criterion 2 structural), so a globally registered plugin would have
 * compressed every API response and left the 533 kB the browser actually downloads untouched.
 *
 * So the split is: the plugin owns every registered route, this module owns the bundle. It is
 * deliberately **not** a second negotiator for the same responses — no response is offered to
 * both — which is the condition rule 15 is about.
 *
 * ## What it does, and what each choice costs
 *
 * - **`br` is preferred over `gzip` at equal quality**, because the result is cached and the
 *   smaller one is therefore free after the first request. A client that offers only one gets it;
 *   a client that offers neither, or refuses both with `q=0`, gets the bytes on disk.
 * - **Nothing below 1 024 bytes is compressed.** The same threshold `@fastify/compress` defaults
 *   to: below it the framing overhead and the CPU buy nothing.
 * - **Only the content types this server declares as text-shaped.** `bundle.ts` owns a closed
 *   table of content types, and `encoding.test.ts` fails when one of them is classified by
 *   neither list — so a type added there is a decision somebody makes rather than a default
 *   somebody inherits. Images, fonts and `application/octet-stream` are left alone: they are
 *   already compressed, and the last one is what an unknown extension gets.
 * - **Each file is compressed once per encoding and kept** — once in total, not once per request
 *   that misses: what the cache holds is the **in-flight promise**, so the N browsers that ask for
 *   the main chunk in the second after a deploy share one compression instead of starting N (round
 *   3). The bundle is immutable for the life of the process (`bundle.ts`), so the key is the file's
 *   own validator — path, size and mtime — and a replaced file is a new key rather than a stale
 *   hit. This is what makes `gzip` level 9 and `br` quality 5 affordable: they are paid once, on a
 *   thread-pool thread, never on the event loop.
 * - **The cache is bounded, and past the bound nothing is compressed rather than everything being
 *   recompressed per request.** A root holding more compressible bytes than the cap is an
 *   operator pointing `APP_WEB_ROOT` at something that is not a Vite bundle; serving it uncoded
 *   is slower on the wire but bounded in CPU, and the one warn line says so (rule 18).
 */
import { promisify } from 'node:util';
import {
  brotliCompress as brotliCompressCallback,
  constants,
  gzip as gzipCallback,
} from 'node:zlib';
import type { FastifyBaseLogger } from 'fastify';
import { type BundleFile, CONTENT_TYPES, DEFAULT_CONTENT_TYPE } from './bundle.js';

const gzip = promisify(gzipCallback);
const brotliCompress = promisify(brotliCompressCallback);

/** The codings this server offers for a bundle file, in preference order. */
export type ContentEncoding = 'br' | 'gzip';

/** `@fastify/compress`'s own default, kept identical so one origin has one rule. */
export const COMPRESSION_THRESHOLD_BYTES = 1_024;

/** Compressed bytes this process will hold. A Vite bundle is two orders of magnitude below it. */
export const MAX_CACHED_ENCODED_BYTES = 8 * 1_024 * 1_024;

/**
 * The content types worth compressing, out of the closed table `bundle.ts` declares.
 *
 * Membership is stated for **every** entry of that table (the leftovers are
 * {@link INCOMPRESSIBLE_CONTENT_TYPES}) so that neither list can quietly acquire a default.
 */
export const COMPRESSIBLE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  CONTENT_TYPES.css,
  CONTENT_TYPES.html,
  CONTENT_TYPES.js,
  CONTENT_TYPES.json,
  CONTENT_TYPES.map,
  CONTENT_TYPES.mjs,
  CONTENT_TYPES.svg,
  CONTENT_TYPES.txt,
  CONTENT_TYPES.wasm,
  CONTENT_TYPES.webmanifest,
]);

/** Already-compressed formats: a second pass costs CPU and adds bytes. */
export const INCOMPRESSIBLE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  CONTENT_TYPES.gif,
  CONTENT_TYPES.ico,
  CONTENT_TYPES.jpeg,
  CONTENT_TYPES.jpg,
  CONTENT_TYPES.png,
  CONTENT_TYPES.webp,
  CONTENT_TYPES.woff,
  CONTENT_TYPES.woff2,
  DEFAULT_CONTENT_TYPE,
]);

/**
 * RFC 9110 §12.5.3 in the small: a comma-separated list of codings, each with an optional `q`.
 *
 * `*` supplies the quality of anything not named. `q=0` is a refusal, and a malformed quality is
 * read as one — a header this server cannot parse is not a permission it may assume.
 */
const qualities = (header: string): ReadonlyMap<string, number> => {
  const parsed = new Map<string, number>();
  for (const part of header.split(',')) {
    const [rawCoding, ...parameters] = part.split(';');
    const coding = rawCoding?.trim().toLowerCase();
    if (coding === undefined || coding.length === 0) {
      continue;
    }
    let quality = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.split('=');
      if (name?.trim().toLowerCase() !== 'q') {
        continue;
      }
      const parsedQuality = Number.parseFloat(value ?? '');
      quality = Number.isNaN(parsedQuality) ? 0 : parsedQuality;
    }
    parsed.set(coding, quality);
  }
  return parsed;
};

/** The coding to use for a client that sent this `accept-encoding`, or `null` for the raw bytes. */
export const negotiateEncoding = (header: string | undefined): ContentEncoding | null => {
  if (header === undefined || header.trim().length === 0) {
    return null;
  }
  const parsed = qualities(header);
  const wildcard = parsed.get('*');
  const quality = (coding: ContentEncoding): number => parsed.get(coding) ?? wildcard ?? 0;
  const br = quality('br');
  const gzipQuality = quality('gzip');
  if (br <= 0 && gzipQuality <= 0) {
    return null;
  }
  return br >= gzipQuality ? 'br' : 'gzip';
};

export const isCompressibleContentType = (contentType: string): boolean =>
  COMPRESSIBLE_CONTENT_TYPES.has(contentType);

/** A coded representation of a bundle file, or `null` when the file is served as it is on disk. */
export interface EncodedBundleFile {
  readonly encoding: ContentEncoding;
  readonly body: Buffer;
}

export interface BundleEncoder {
  /** The coded body for this request, or `null` to send `bytes` unchanged. */
  encode(
    file: BundleFile,
    bytes: Buffer,
    acceptEncoding: string | undefined,
  ): Promise<EncodedBundleFile | null>;
}

/** What turns bytes into coded bytes. A parameter of the factory only so a test can count calls. */
export type Compressor = (encoding: ContentEncoding, bytes: Buffer) => Promise<Buffer>;

const compress: Compressor = async (encoding, bytes) =>
  encoding === 'gzip'
    ? await gzip(bytes, { level: 9 })
    : await brotliCompress(bytes, {
        params: {
          // Quality 5 rather than the default 11: the result is cached, but the *first* request
          // for the bundle's main chunk still waits for it, and 11 turns that wait into hundreds
          // of milliseconds for a few per cent (`@fastify/compress` defaults to 4 for the same
          // reason, citing https://blog.cloudflare.com/this-is-brotli-from-origin).
          [constants.BROTLI_PARAM_QUALITY]: 5,
          [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
        },
      });

/**
 * The encoder the fallback uses, with its cache.
 *
 * A factory rather than a module-level map: two `buildApp` instances in one test process (and the
 * e2e tier builds several) must not share one, and a cache nobody can discard is a cache no test
 * can start empty.
 */
export const createBundleEncoder = (
  logger: FastifyBaseLogger,
  options: { readonly maxCachedBytes?: number; readonly compressor?: Compressor } = {},
): BundleEncoder => {
  // Parameters only so that `encoding.test.ts` can reach the bound without allocating eight
  // megabytes of compressible fixture, and can count how many compressions N concurrent requests
  // for one file cause; no caller passes either.
  const maxCachedBytes = options.maxCachedBytes ?? MAX_CACHED_ENCODED_BYTES;
  const compressor = options.compressor ?? compress;
  /**
   * `path\0etag\0coding` -> the **work**, not its result: a promise of the coded bytes, or of
   * `null` for "coding does not pay here".
   *
   * Caching the promise rather than the buffer is what makes N concurrent first requests for the
   * 533 kB chunk pay gzip-9/brotli-5 **once**. A cache of results cannot: every request that
   * arrives before the first compression resolves finds the map empty and starts its own, which is
   * precisely the moment a cold process can least afford it (round 3, nit). A **rejected**
   * compression is evicted rather than remembered, so a transient zlib failure cannot turn one
   * file into a permanent 500.
   */
  const cached = new Map<string, Promise<Buffer | null>>();
  let cachedBytes = 0;
  let capacityReported = false;

  const start = (key: string, encoding: ContentEncoding, bytes: Buffer): Promise<Buffer | null> => {
    const work = compressor(encoding, bytes).then(
      (body) => {
        // A coding that makes the response bigger is remembered as a refusal, so the next request
        // pays neither the CPU nor the extra bytes.
        if (body.length >= bytes.length) {
          return null;
        }
        cachedBytes += body.length;
        return body;
      },
      (error: unknown) => {
        cached.delete(key);
        throw error;
      },
    );
    cached.set(key, work);
    return work;
  };

  return {
    encode: async (file, bytes, acceptEncoding) => {
      const encoding = negotiateEncoding(acceptEncoding);
      if (
        encoding === null ||
        !isCompressibleContentType(file.contentType) ||
        bytes.length < COMPRESSION_THRESHOLD_BYTES
      ) {
        return null;
      }
      const key = `${file.path}\0${file.etag}\0${encoding}`;
      let work = cached.get(key);
      if (work === undefined) {
        if (cachedBytes >= maxCachedBytes) {
          if (!capacityReported) {
            capacityReported = true;
            logger.warn(
              { cached_bytes: cachedBytes, limit: maxCachedBytes },
              'the compressed-bundle cache is full: the rest of this directory is served uncompressed',
            );
          }
          return null;
        }
        work = start(key, encoding, bytes);
      }
      const body = await work;
      return body === null ? null : { encoding, body };
    },
  };
};
