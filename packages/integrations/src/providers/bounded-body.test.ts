/**
 * The two readers of `bounded-body.ts` (WP-190, backlog 548), on hand-built streams: each boundary
 * from both sides (standing rule 42), chunk splits that land inside a UTF-8 sequence, and the
 * stream released on a refusal. The per-client ceilings are `response-ceiling.test.ts`'s.
 */
import { IntegrationError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { ProviderResponseTooLargeError, readBodyTail, readBoundedBody } from './bounded-body.js';

const encoder = new TextEncoder();

interface Streamed {
  readonly response: Response;
  /** Chunks the reader pulled. */
  readonly pulled: () => number;
  readonly cancelled: () => boolean;
}

const streamOf = (chunks: readonly Uint8Array[]): Streamed => {
  let index = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[index];
      index += 1;
      if (next === undefined) {
        controller.close();
      } else {
        controller.enqueue(next);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream),
    pulled: () => Math.min(index, chunks.length),
    cancelled: () => cancelled,
  };
};

const ascii = (text: string): Uint8Array => encoder.encode(text);

const REQUEST = {
  provider: 'example',
  ceilingBytes: 10,
  host: 'example.test',
  what: 'GET /thing',
  action: 'read_thing',
  overflow: 'refuse',
} as const;

describe('readBoundedBody', () => {
  it('reads a body of exactly the ceiling whole, across chunks', async () => {
    const { response } = streamOf([ascii('abcd'), ascii('efg'), ascii('hij')]);
    expect(await readBoundedBody(response, REQUEST)).toBe('abcdefghij');
  });

  it('refuses one byte past the ceiling, naming the ceiling and the host, and releases the stream', async () => {
    const streamed = streamOf([ascii('abcd'), ascii('efg'), ascii('hijk'), ascii('never-read')]);
    const outcome = await readBoundedBody(streamed.response, REQUEST).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(ProviderResponseTooLargeError);
    expect(outcome).toBeInstanceOf(IntegrationError);
    const error = outcome as ProviderResponseTooLargeError;
    expect(error.code).toBe('invalid_response');
    expect(error.provider).toBe('example');
    expect(error.action).toBe('read_thing');
    expect(error.retryable).toBe(false);
    expect(error.ceilingBytes).toBe(10);
    expect(error.host).toBe('example.test');
    expect(error.message).toBe(
      'example: GET /thing from example.test answered more than 10 bytes; refused rather than cut',
    );
    expect(streamed.pulled(), 'the fourth chunk is never asked for').toBe(3);
    expect(streamed.cancelled()).toBe(true);
  });

  it('decodes a UTF-8 sequence split across two chunks, and counts bytes rather than characters', async () => {
    const bytes = encoder.encode('žluťoučký'); // 9 characters, 13 bytes
    const { response } = streamOf([bytes.subarray(0, 1), bytes.subarray(1)]);
    expect(await readBoundedBody(response, { ...REQUEST, ceilingBytes: 13 })).toBe('žluťoučký');
    const again = streamOf([bytes]);
    await expect(
      readBoundedBody(again.response, { ...REQUEST, ceilingBytes: 12 }),
    ).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
  });

  it('drops a leading BOM as Response.text() does', async () => {
    const { response } = streamOf([new Uint8Array([0xef, 0xbb, 0xbf]), ascii('{}')]);
    expect(await readBoundedBody(response, REQUEST)).toBe('{}');
  });

  it('answers an empty string for a response with no body', async () => {
    expect(await readBoundedBody(new Response(null, { status: 204 }), REQUEST)).toBe('');
  });
});

describe('readBoundedBody with overflow: drop (an error body)', () => {
  it('answers an empty string one byte past the ceiling, and releases the stream', async () => {
    const streamed = streamOf([ascii('abcd'), ascii('efg'), ascii('hijk'), ascii('never-read')]);
    expect(await readBoundedBody(streamed.response, { ...REQUEST, overflow: 'drop' })).toBe('');
    expect(streamed.pulled()).toBe(3);
    expect(streamed.cancelled()).toBe(true);
  });

  it('reads an error body of exactly the ceiling whole', async () => {
    const { response } = streamOf([ascii('abcde'), ascii('fghij')]);
    expect(await readBoundedBody(response, { ...REQUEST, overflow: 'drop' })).toBe('abcdefghij');
  });
});

describe('readBodyTail', () => {
  it('keeps the last tailBytes of a longer body and says it cut', async () => {
    const { response } = streamOf([ascii('abc'), ascii('defg'), ascii('hij')]);
    expect(await readBodyTail(response, 4)).toEqual({ text: 'ghij', truncated: true });
  });

  it('keeps a body of exactly tailBytes whole and says it did not cut', async () => {
    const { response } = streamOf([ascii('ab'), ascii('cd')]);
    expect(await readBodyTail(response, 4)).toEqual({ text: 'abcd', truncated: false });
  });

  it('reads the stream to its end rather than refusing', async () => {
    const chunks = Array.from({ length: 50 }, (_, index) => ascii(String(index % 10)));
    const streamed = streamOf(chunks);
    expect(await readBodyTail(streamed.response, 3)).toEqual({ text: '789', truncated: true });
    expect(streamed.pulled()).toBe(50);
  });

  it('a cut inside a UTF-8 sequence decodes as one replacement character', async () => {
    const { response } = streamOf([encoder.encode('ažb')]); // a, ž (2 bytes), b
    expect(await readBodyTail(response, 2)).toEqual({ text: '�b', truncated: true });
  });

  it('answers an empty, uncut text for a response with no body', async () => {
    expect(await readBodyTail(new Response(null, { status: 204 }), 4)).toEqual({
      text: '',
      truncated: false,
    });
  });
});
