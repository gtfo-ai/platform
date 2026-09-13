/**
 * The content-coding decisions of `encoding.ts`, at the tier that runs on every change.
 *
 * `compression.test.ts` asserts what arrives on a socket; this file asserts the three decisions
 * behind it that a request cannot show: which `accept-encoding` headers mean what, which content
 * types are worth coding — as a **census over the closed table**, so a type added to `bundle.ts`
 * and classified nowhere is a red test rather than a silent default — and that a file is coded
 * once rather than once per request.
 */
import { randomBytes } from 'node:crypto';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  type BundleFile,
  CONTENT_TYPES,
  DEFAULT_CONTENT_TYPE,
  IMMUTABLE_CACHE_CONTROL,
} from './bundle.js';
import {
  COMPRESSIBLE_CONTENT_TYPES,
  COMPRESSION_THRESHOLD_BYTES,
  createBundleEncoder,
  INCOMPRESSIBLE_CONTENT_TYPES,
  negotiateEncoding,
} from './encoding.js';

const lines: Record<string, unknown>[] = [];
const logger = {
  warn: (payload: Record<string, unknown>) => {
    lines.push(payload);
  },
} as unknown as FastifyBaseLogger;

const fileOf = (overrides: Partial<BundleFile> = {}): BundleFile => ({
  path: '/dist/assets/index-Wp15J000.js',
  contentType: CONTENT_TYPES.js,
  cacheControl: IMMUTABLE_CACHE_CONTROL,
  etag: 'W/"1000-1000"',
  lastModified: 'Sun, 13 Sep 2026 09:00:00 GMT',
  ...overrides,
});

/** Compressible, and comfortably over the threshold. */
const TEXT = Buffer.from(`export const wp15j = ${JSON.stringify('x'.repeat(4_000))};\n`);

describe('negotiateEncoding', () => {
  it.each([
    ['no header at all', undefined, null],
    ['an empty header', '   ', null],
    ['gzip only', 'gzip', 'gzip'],
    ['brotli only', 'br', 'br'],
    ['both, at equal quality', 'gzip, deflate, br', 'br'],
    ['both, with gzip preferred', 'br;q=0.5, gzip;q=0.9', 'gzip'],
    ['both, with brotli preferred', 'br;q=0.9, gzip;q=0.5', 'br'],
    ['a wildcard', '*', 'br'],
    ['a wildcard with gzip refused', 'gzip;q=0, *', 'br'],
    ['gzip refused and nothing else offered', 'gzip;q=0', null],
    ['everything refused', 'gzip;q=0, br;q=0', null],
    ['a wildcard refusal', '*;q=0', null],
    ['identity', 'identity', null],
    ['a coding this server does not offer', 'deflate, zstd', null],
    ['odd casing and spacing', '  GZIP ;  Q=1 ', 'gzip'],
    ['a quality this parser cannot read', 'br;q=later, gzip', 'gzip'],
  ])('%s', (_name, header, expected) => {
    expect(negotiateEncoding(header)).toBe(expected);
  });
});

describe('which content types are coded', () => {
  it('classifies every type bundle.ts declares, in exactly one list', () => {
    // The census (standing rule 7): the table is read off the module rather than copied here, so a
    // content type added there with no decision about the wire fails this test.
    const declared = [...new Set([...Object.values(CONTENT_TYPES), DEFAULT_CONTENT_TYPE])];
    const unclassified = declared.filter(
      (type) => COMPRESSIBLE_CONTENT_TYPES.has(type) === INCOMPRESSIBLE_CONTENT_TYPES.has(type),
    );
    expect(unclassified).toEqual([]);
    expect(declared.length).toBe(
      COMPRESSIBLE_CONTENT_TYPES.size + INCOMPRESSIBLE_CONTENT_TYPES.size,
    );
  });

  it('codes text and leaves already-compressed formats alone', async () => {
    const encoder = createBundleEncoder(logger);
    const text = await encoder.encode(fileOf(), TEXT, 'gzip');
    expect(text?.encoding).toBe('gzip');

    for (const contentType of [CONTENT_TYPES.png, CONTENT_TYPES.woff2, DEFAULT_CONTENT_TYPE]) {
      expect(await encoder.encode(fileOf({ contentType }), TEXT, 'gzip'), contentType).toBeNull();
    }
  });
});

describe('what the encoder returns', () => {
  it('round-trips through both codings', async () => {
    const encoder = createBundleEncoder(logger);
    const gzipped = await encoder.encode(fileOf(), TEXT, 'gzip');
    const brotli = await encoder.encode(fileOf(), TEXT, 'br');
    expect(gzipped).not.toBeNull();
    expect(brotli).not.toBeNull();
    // The bytes in, recovered from the bytes out: a coder that dropped or reordered a byte cannot
    // pass, and neither can one that returned the input unchanged with a coding header on it.
    expect(gunzipSync(gzipped?.body ?? Buffer.alloc(0)).equals(TEXT)).toBe(true);
    expect(brotliDecompressSync(brotli?.body ?? Buffer.alloc(0)).equals(TEXT)).toBe(true);
    expect((gzipped?.body.length ?? 0) < TEXT.length).toBe(true);
    expect((brotli?.body.length ?? 0) < TEXT.length).toBe(true);
  });

  it('leaves a payload below the threshold alone', async () => {
    const encoder = createBundleEncoder(logger);
    const small = Buffer.alloc(COMPRESSION_THRESHOLD_BYTES - 1, 0x61);
    expect(
      await encoder.encode(fileOf({ contentType: CONTENT_TYPES.html }), small, 'gzip'),
    ).toBeNull();
    // One byte more is coded, so the boundary is the threshold and not "small things are skipped".
    const atThreshold = Buffer.alloc(COMPRESSION_THRESHOLD_BYTES, 0x61);
    expect(
      await encoder.encode(fileOf({ contentType: CONTENT_TYPES.html }), atThreshold, 'gzip'),
    ).not.toBeNull();
  });

  it('refuses a coding that would make the response bigger', async () => {
    // Random bytes with a text content type: nothing compresses them, and a server that shipped
    // the result would be spending CPU to add bytes.
    const encoder = createBundleEncoder(logger);
    const incompressible = randomBytes(4_096);
    expect(await encoder.encode(fileOf(), incompressible, 'gzip')).toBeNull();
    expect(await encoder.encode(fileOf(), incompressible, 'gzip')).toBeNull();
  });

  it('codes a file once per coding and serves the same bytes afterwards', async () => {
    const encoder = createBundleEncoder(logger);
    const first = await encoder.encode(fileOf(), TEXT, 'gzip');
    const second = await encoder.encode(fileOf(), TEXT, 'gzip');
    // Identity, not equality: a second compression would produce an equal buffer, so only the
    // same object shows that the cache was used.
    expect(second?.body).toBe(first?.body);

    // A different validator is a different file, even at the same path: a bundle replaced under a
    // running process must not be served from the old entry.
    const replaced = await encoder.encode(fileOf({ etag: 'W/"2000-2000"' }), TEXT, 'gzip');
    expect(replaced?.body).not.toBe(first?.body);
    expect(gunzipSync(replaced?.body ?? Buffer.alloc(0)).equals(TEXT)).toBe(true);
  });

  it('compresses once for concurrent first requests, not once each', async () => {
    // The cold-start case the cache of *results* could not cover: N browsers ask for the 533 kB
    // chunk in the second after a deploy, and every one of them finds the map empty. What is
    // counted is the compressor's calls, because the outcome is identical either way — the same
    // bytes arrive, N times more CPU is spent producing them (round 3, nit).
    let calls = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = createBundleEncoder(logger, {
      compressor: async (_encoding, bytes) => {
        calls += 1;
        await gate;
        return gzipSync(bytes);
      },
    });

    // Every call is started before the first one can resolve: `encode` reaches the cache
    // synchronously, so the three are in flight together by the time `release()` runs.
    const inFlight = [
      encoder.encode(fileOf(), TEXT, 'gzip'),
      encoder.encode(fileOf(), TEXT, 'gzip'),
      encoder.encode(fileOf(), TEXT, 'gzip'),
    ];
    release();
    const [first, second, third] = await Promise.all(inFlight);

    expect(calls).toBe(1);
    expect(second?.body).toBe(first?.body);
    expect(third?.body).toBe(first?.body);
    expect(gunzipSync(first?.body ?? Buffer.alloc(0)).equals(TEXT)).toBe(true);
  });

  it('does not remember a compression that failed', async () => {
    // A promise cache that kept a rejection would answer every later request for that file with
    // the same failure — one transient zlib error turning a served file into a permanent 500.
    let calls = 0;
    const encoder = createBundleEncoder(logger, {
      compressor: async (_encoding, bytes) => {
        calls += 1;
        if (calls === 1) {
          throw new Error('zlib said no');
        }
        return gzipSync(bytes);
      },
    });

    await expect(encoder.encode(fileOf(), TEXT, 'gzip')).rejects.toThrow('zlib said no');
    expect((await encoder.encode(fileOf(), TEXT, 'gzip'))?.body).not.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('stops coding at the cache bound, and says so once', async () => {
    lines.length = 0;
    const encoder = createBundleEncoder(logger, { maxCachedBytes: 1 });
    expect(await encoder.encode(fileOf(), TEXT, 'gzip')).not.toBeNull();
    expect(await encoder.encode(fileOf({ path: '/dist/other.js' }), TEXT, 'gzip')).toBeNull();
    expect(await encoder.encode(fileOf({ path: '/dist/third.js' }), TEXT, 'gzip')).toBeNull();
    expect(lines.filter((line) => line['limit'] === 1)).toHaveLength(1);
    // The file already in the cache keeps being served coded: the bound stops new work, it does
    // not throw away what has been paid for.
    expect(await encoder.encode(fileOf(), TEXT, 'gzip')).not.toBeNull();
  });
});
