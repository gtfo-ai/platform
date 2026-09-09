import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../errors.js';
import { parseAuditCursor } from './org.js';

describe('parseAuditCursor', () => {
  it('accepts the timestamp this endpoint hands out as next_cursor', () => {
    expect(parseAuditCursor('2026-09-09T10:15:30.000Z').toISOString()).toBe(
      '2026-09-09T10:15:30.000Z',
    );
  });

  it('refuses anything it cannot read, rather than passing new Date(NaN) to the driver', () => {
    // `paginationQuerySchema` types the cursor as an opaque non-empty string, which is right for
    // the API as a whole and wrong to hand straight to a query.
    for (const cursor of ['not-a-date', '', '2026-13-45', 'null', "'; drop table users; --"]) {
      expect(() => parseAuditCursor(cursor), cursor).toThrow(BadRequestError);
    }
  });
});
