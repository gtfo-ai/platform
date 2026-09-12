/**
 * The task page's cursor, from both ends.
 *
 * It is opaque by contract, which means the client sends back whatever it was given and this
 * endpoint has to treat that string as untrusted input: an unparseable cursor that reached the
 * driver would be half a keyset in a query, and `parseAuditCursor`'s own test records what that
 * cost the audit endpoint (`new Date(NaN)` at the driver).
 *
 * The **pair** is the part worth testing rather than asserting in prose: `tasks.id` is a uuidv7 and
 * `created_at` is `now()`, so two tasks created in one transaction share the timestamp exactly, and
 * a cursor of the timestamp alone would silently skip whichever fell after a page boundary.
 */
import { describe, expect, it } from 'vitest';
import { HttpError } from '../errors.js';
import { decodeTaskCursor, encodeTaskCursor } from './projects.js';

const ID = '0199aa11-2b3c-7d4e-8f90-000000000001';

describe('the task page cursor', () => {
  it('round-trips the keyset it was built from, to the microsecond', () => {
    // Six fractional digits, because that is `timestamptz`'s resolution and the whole reason the
    // cursor is a string: a `Date` here truncates to milliseconds and the keyset then **skips** the
    // row it came from (measured on the integration tier — `TaskCursor`'s docblock has the figure).
    const cursor = { createdAt: '2026-09-13T10:15:30.123456Z', id: ID };
    const encoded = encodeTaskCursor(cursor);
    expect(encoded).toBe(`2026-09-13T10:15:30.123456Z|${ID}`);

    const decoded = decodeTaskCursor(encoded);
    expect(decoded.createdAt).toBe('2026-09-13T10:15:30.123456Z');
    expect(decoded.id).toBe(ID);
    // And nothing in the round trip went through `Date`: the microseconds survived, which is the
    // assertion a millisecond-only fixture could not make.
    expect(new Date(decoded.createdAt).toISOString()).not.toBe(decoded.createdAt);
  });

  it('splits on the last separator, so a timestamp offset cannot be mistaken for one', () => {
    const decoded = decodeTaskCursor(`2026-09-13T12:15:30.000+02:00|${ID}`);
    expect(decoded.createdAt).toBe('2026-09-13T12:15:30.000+02:00');
  });

  it('refuses anything it did not issue rather than passing it to the driver', () => {
    for (const raw of [
      '',
      'not-a-cursor',
      ID,
      `2026-09-13T10:15:30.123Z|${ID}x`,
      `yesterday|${ID}`,
      `2026-09-13T10:15:30.123Z|'; drop table tasks; --`,
      // A second field the shape does not have: the schema is strict, so a cursor from a future
      // version of this endpoint is refused rather than half-read.
      `2026-09-13T10:15:30.123Z|${ID}|extra`,
    ]) {
      expect(() => decodeTaskCursor(raw), raw).toThrow(HttpError);
    }
  });

  it('refuses with a 400 and a code a client can branch on', () => {
    try {
      decodeTaskCursor('nope');
      expect.unreachable('an unparseable cursor must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).statusCode).toBe(400);
      expect((error as HttpError).code).toBe('invalid_cursor');
    }
  });
});
