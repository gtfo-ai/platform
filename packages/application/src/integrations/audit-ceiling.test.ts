/**
 * The audit row ceiling's own boundaries (WP-83, Q54): both sides of each cap (standing rule 42),
 * idempotence (standing rule 36 — a marker-bearing cap applied twice must not disagree with itself),
 * and the escaping case that makes the fit a search rather than arithmetic.
 */
import { describe, expect, it } from 'vitest';
import {
  boundAuditError,
  boundAuditJson,
  MAX_AUDIT_ERROR_CHARS,
  MAX_AUDIT_JSON_BYTES,
} from './audit-ceiling.js';

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

describe('boundAuditJson', () => {
  /** An object whose serialisation is exactly `size` bytes: `{"k":"…"}` is 8 bytes of frame. */
  const ofBytes = (size: number) => ({ k: 'x'.repeat(size - 8) });

  it('returns a value at exactly the ceiling as it came, and cuts one byte past it', () => {
    const at = ofBytes(MAX_AUDIT_JSON_BYTES);
    expect(bytes(at)).toBe(MAX_AUDIT_JSON_BYTES);
    expect(boundAuditJson(at)).toBe(at);

    const past = ofBytes(MAX_AUDIT_JSON_BYTES + 1);
    const cut = boundAuditJson(past);
    expect(cut).toMatchObject({ truncated: true, original_bytes: MAX_AUDIT_JSON_BYTES + 1 });
    expect(bytes(cut)).toBeLessThanOrEqual(MAX_AUDIT_JSON_BYTES);
    // The head is the serialised value's own beginning, so a reader sees what was there.
    expect(JSON.stringify(past).startsWith(String((cut as { head: string }).head))).toBe(true);
  });

  it('is idempotent: the replacement is under the ceiling, so a second pass changes nothing', () => {
    const cut = boundAuditJson(ofBytes(MAX_AUDIT_JSON_BYTES * 4));
    expect(boundAuditJson(cut)).toBe(cut);
  });

  it('fits a body whose characters grow sixfold when escaped', () => {
    // A control character serialises as `\u0001`, six bytes, and escapes again inside the head.
    const cut = boundAuditJson({ k: '\u0001'.repeat(MAX_AUDIT_JSON_BYTES) }, 1_000);
    expect(bytes(cut)).toBeLessThanOrEqual(1_000);
    expect((cut as { head: string }).head.length).toBeGreaterThan(0);
  });

  it('never ends the head half-way through a surrogate pair', () => {
    const cut = boundAuditJson({ k: '😀'.repeat(1_000) }, 200) as { head: string };
    const last = cut.head.charCodeAt(cut.head.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

describe('boundAuditError', () => {
  it('returns an error at exactly the cap as it came, and cuts one character past it', () => {
    const at = 'e'.repeat(MAX_AUDIT_ERROR_CHARS);
    expect(boundAuditError(at)).toBe(at);
    const cut = boundAuditError(`${at}f`);
    expect(cut.length).toBeLessThanOrEqual(MAX_AUDIT_ERROR_CHARS);
    expect(cut).toMatch(/ \[truncated: 2001 chars\]$/);
  });

  it('is idempotent', () => {
    const cut = boundAuditError('e'.repeat(MAX_AUDIT_ERROR_CHARS * 5));
    expect(boundAuditError(cut)).toBe(cut);
  });
});
