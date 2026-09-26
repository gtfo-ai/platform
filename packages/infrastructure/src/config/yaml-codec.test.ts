/**
 * The YAML codec — the export's promise and the reader's refusals (WP-63).
 *
 * The export writes what `stringify` produces and the platform later reads the file back with
 * `parse`, so the one property that matters is the round trip: **whatever document the export
 * writes, the reader reads the same document** — over arbitrary JSON documents, not only the
 * friendly ones, because a value like `yes`, `09:00`, `null` or `1.0` is exactly where a YAML
 * round trip goes wrong.
 */
import type { JsonObject } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { MAX_YAML_ALIASES, yamlConfigCodec } from './yaml-codec.js';

const roundTrip = (document: JsonObject): unknown => {
  const parsed = yamlConfigCodec.parse(yamlConfigCodec.stringify(document, ['a header line']));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
};

describe('yamlConfigCodec', () => {
  it('reads back exactly the document it wrote, for any JSON document', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (document) => {
        // JSON is the wire the document came from; compare through it so `-0` and `0` agree.
        const expected = JSON.parse(JSON.stringify(document)) as JsonObject;
        expect(JSON.stringify(roundTrip(expected))).toBe(JSON.stringify(expected));
      }),
      { numRuns: 300 },
    );
  });

  it('keeps the strings YAML 1.1 would have turned into something else', () => {
    const document = { a: 'yes', b: 'on', c: '09:00', d: 'null', e: '1.0', f: '', g: '~' };
    expect(roundTrip(document)).toEqual(document);
  });

  it('writes the header as comments the reader ignores', () => {
    const text = yamlConfigCodec.stringify({ version: 1 }, ['exported', '']);
    expect(text.startsWith('# exported\n#\n')).toBe(true);
    expect(yamlConfigCodec.parse(text)).toEqual({ ok: true, value: { version: 1 } });
  });

  it('refuses a document with a key written twice rather than keeping either', () => {
    const parsed = yamlConfigCodec.parse('version: 1\nversion: 2\n');
    expect(parsed.ok).toBe(false);
  });

  it('refuses an alias bomb by name, and a merge key', () => {
    const levels = ['a: &a [x, x, x, x, x, x, x, x, x]'];
    for (const [index, name] of ['b', 'c', 'd', 'e'].entries()) {
      const previous = String.fromCharCode('a'.charCodeAt(0) + index);
      levels.push(`${name}: &${name} [${Array(9).fill(`*${previous}`).join(', ')}]`);
    }
    const bomb = yamlConfigCodec.parse(`${levels.join('\n')}\n`);
    expect(bomb.ok).toBe(false);
    expect(bomb.ok ? '' : bomb.reason).toMatch(/alias/i);
    expect(MAX_YAML_ALIASES).toBe(50);
    // `<<` is an ordinary key without the merge extension, so the strict schema sees it and refuses.
    const merged = yamlConfigCodec.parse('base: &b { x: 1 }\nother:\n  <<: *b\n');
    expect(merged).toEqual({ ok: true, value: { base: { x: 1 }, other: { '<<': { x: 1 } } } });
  });

  it('keeps no source line in a refusal, only the message and the position', () => {
    const parsed = yamlConfigCodec.parse('ok: 1\nsecret: glpat-FAKE-not-real-000\n  bad: : :\n');
    expect(parsed.ok).toBe(false);
    const reason = parsed.ok ? '' : parsed.reason;
    expect(reason).not.toContain('glpat-FAKE');
    expect(reason).toMatch(/line \d+, column \d+/);
  });

  /**
   * Review round 1: an unknown tag used to print the attacker's text on stderr (outside pino and
   * the redactor) and read `!custom 1` as `"1"`. Every explicit tag is now a named refusal, and
   * nothing reaches `process.emitWarning`.
   */
  it('refuses every explicit tag by name, and writes nothing to stderr', () => {
    const warned = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      for (const text of [
        'a: !custom 1\n',
        'a: !!js/function "x"\n',
        'a: !!binary aGk=\n',
        'a: !!set {x}\n',
        'a: !!str 1\n',
      ]) {
        const parsed = yamlConfigCodec.parse(text);
        expect(parsed.ok, text).toBe(false);
        expect(parsed.ok ? '' : parsed.reason, text).toMatch(/explicit YAML tag/);
      }
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });
});
