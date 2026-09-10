import { describe, expect, it } from 'vitest';
import {
  REPLACEMENT,
  safeHref,
  sanitiseUntrusted,
  segmentBlocks,
  segmentInline,
  stripAnsi,
} from './untrusted-text.js';

/**
 * The segmentation half of the untrusted-text rules. The *rendering* half is asserted against the
 * DOM in `untrusted.test.tsx`, which is where the property that matters lives — this file pins the
 * decisions that file would otherwise have to infer.
 */
describe('safeHref', () => {
  it('accepts http and https and returns the parser’s own serialisation', () => {
    expect(safeHref('https://example.invalid/a?b=c#d')).toBe('https://example.invalid/a?b=c#d');
    expect(safeHref('http://example.invalid')).toBe('http://example.invalid/');
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.invalid/x',
    'not a url at all',
  ])('refuses %j', (candidate) => {
    expect(safeHref(candidate)).toBeNull();
  });
});

describe('sanitiseUntrusted', () => {
  it('normalises line endings', () => {
    expect(sanitiseUntrusted('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('removes C0 control characters but keeps tab and newline', () => {
    expect(sanitiseUntrusted('a\u0000b\u0008c\u001Bd\u007Fe\tf\ng')).toBe('abcde\tf\ng');
  });

  it('replaces every Trojan-source bidi character with U+FFFD', () => {
    // CVE-2021-42574: LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI and ALM.
    for (const codePoint of [
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c,
    ]) {
      const value = `x${String.fromCodePoint(codePoint)}y`;
      expect(sanitiseUntrusted(value), `U+${codePoint.toString(16)}`).toBe(`x${REPLACEMENT}y`);
    }
  });

  it('keeps the plain left-to-right and right-to-left marks, which cannot reorder a run', () => {
    expect(sanitiseUntrusted('x\u200Ey\u200Fz')).toBe('x\u200Ey\u200Fz');
  });
});

describe('stripAnsi', () => {
  it('removes CSI colour sequences and leaves the text', () => {
    expect(stripAnsi('\u001B[32mok\u001B[0m done')).toBe('ok done');
  });

  it('removes an OSC sequence terminated either way', () => {
    expect(stripAnsi('\u001B]0;title\u0007rest')).toBe('rest');
    expect(stripAnsi('\u001B]8;;https://x.invalid\u001B\\link')).toBe('link');
  });

  it('leaves a bare bracket alone', () => {
    expect(stripAnsi('array[0] = 1')).toBe('array[0] = 1');
  });
});

describe('segmentInline', () => {
  it('turns a bare http(s) URL into a link segment and leaves the rest as text', () => {
    expect(segmentInline('see https://example.invalid/x now')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', href: 'https://example.invalid/x', label: 'https://example.invalid/x' },
      { kind: 'text', value: ' now' },
    ]);
  });

  it('never produces a link segment for a dangerous scheme', () => {
    const segments = segmentInline('javascript:alert(1) and data:text/html,x');
    expect(segments.every((segment) => segment.kind === 'text')).toBe(true);
  });

  it('does not interpret markdown link syntax', () => {
    const segments = segmentInline('[click](javascript:alert(1))');
    expect(segments).toEqual([{ kind: 'text', value: '[click](javascript:alert(1))' }]);
  });

  it('leaves sentence punctuation out of the URL but keeps balanced brackets in it', () => {
    expect(segmentInline('go to https://example.invalid/a.')[1]).toEqual({
      kind: 'link',
      href: 'https://example.invalid/a',
      label: 'https://example.invalid/a',
    });
    expect(segmentInline('see https://example.invalid/a_(b) here')[1]).toEqual({
      kind: 'link',
      href: 'https://example.invalid/a_(b)',
      label: 'https://example.invalid/a_(b)',
    });
  });

  it('sanitises before it segments, so a control character cannot split a URL', () => {
    const segments = segmentInline('https://example.invalid/\u0000ok');
    expect(segments).toEqual([
      { kind: 'link', href: 'https://example.invalid/ok', label: 'https://example.invalid/ok' },
    ]);
  });
});

describe('segmentBlocks', () => {
  it('separates fenced code from prose and keeps the language as a label', () => {
    expect(segmentBlocks('before\n```ts\nconst a = 1;\n```\nafter')).toEqual([
      { kind: 'paragraph', value: 'before' },
      { kind: 'code', language: 'ts', value: 'const a = 1;' },
      { kind: 'paragraph', value: 'after' },
    ]);
  });

  it('treats an unterminated fence as a code block, which is what a live stream looks like', () => {
    expect(segmentBlocks('```\nhalf a diff')).toEqual([
      { kind: 'code', language: null, value: 'half a diff' },
    ]);
  });

  it('never interprets anything inside a fence', () => {
    const blocks = segmentBlocks('```\n<script>alert(1)</script>\nhttps://example.invalid\n```');
    expect(blocks).toEqual([
      {
        kind: 'code',
        language: null,
        value: '<script>alert(1)</script>\nhttps://example.invalid',
      },
    ]);
  });

  it('leaves every other markdown construct as literal text', () => {
    expect(segmentBlocks('# heading **bold** <b>tag</b> | table |')).toEqual([
      { kind: 'paragraph', value: '# heading **bold** <b>tag</b> | table |' },
    ]);
  });

  it('accepts a tilde fence and an indented fence', () => {
    expect(segmentBlocks('~~~sh\nls\n~~~')).toEqual([
      { kind: 'code', language: 'sh', value: 'ls' },
    ]);
    expect(segmentBlocks('  ```\nls\n  ```')).toEqual([
      { kind: 'code', language: null, value: 'ls' },
    ]);
  });

  it('drops a whitespace-only paragraph rather than rendering an empty one', () => {
    expect(segmentBlocks('\n\n   \n\n')).toEqual([]);
  });
});
