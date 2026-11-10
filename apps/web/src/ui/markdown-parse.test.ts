import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Block,
  type Inline,
  inlineText,
  MAX_MARKDOWN_CHARS,
  markdownToPlainText,
  parseInlineMarkdown,
  parseMarkdown,
} from './markdown-parse.js';

/**
 * The markdown reader (S-28.9): one construct per test, the degradations, the streaming property
 * and the linear-time bound. The rendered DOM — links, refusals, the host beside a label — is
 * `markdown.test.tsx`'s.
 */

const text = (value: string): Inline => ({ kind: 'text', value });
const paragraph = (...content: Inline[]): Block => ({ kind: 'paragraph', content });

describe('blocks', () => {
  it('reads ATX headings, with an optional closing run, and not `#word`', () => {
    expect(parseMarkdown('# One\n## Two ##\n###### Six\n####### seven\n#nospace')).toEqual([
      { kind: 'heading', level: 1, content: [text('One')] },
      { kind: 'heading', level: 2, content: [text('Two')] },
      { kind: 'heading', level: 6, content: [text('Six')] },
      paragraph(text('####### seven\n#nospace')),
    ]);
  });

  it('keeps a line break inside a paragraph and splits paragraphs on a blank line', () => {
    expect(parseMarkdown('first line\nsecond line\n\nnext')).toEqual([
      paragraph(text('first line\nsecond line')),
      paragraph(text('next')),
    ]);
  });

  it('reads a numbered list in the `1)` style with the source’s own numbers', () => {
    const [list] = parseMarkdown('3) **Read** the helper\n7) Change `retry.ts`');
    expect(list).toEqual({
      kind: 'list',
      ordered: true,
      items: [
        {
          number: 3,
          delimiter: ')',
          blocks: [paragraph({ kind: 'strong', children: [text('Read')] }, text(' the helper'))],
        },
        {
          number: 7,
          delimiter: ')',
          blocks: [paragraph(text('Change '), { kind: 'code', value: 'retry.ts' })],
        },
      ],
    });
  });

  it('lets a list interrupt a paragraph, as a plan writes "Steps:" and then the steps', () => {
    const blocks = parseMarkdown('Steps:\n1. one\n2. two');
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'list']);
  });

  it('nests a bullet list under a numbered item, at two spaces or at the content column', () => {
    for (const indent of ['  ', '   ']) {
      const [list] = parseMarkdown(`1. parent\n${indent}- child a\n${indent}- child b\n2. next`);
      expect(list?.kind).toBe('list');
      if (list?.kind !== 'list') return;
      expect(list.items).toHaveLength(2);
      const nested = list.items[0]?.blocks[1];
      expect(nested?.kind === 'list' && nested.items.length).toBe(2);
      expect(nested?.kind === 'list' && nested.ordered).toBe(false);
    }
  });

  it('keeps a lazy continuation line in its item and a blank-separated item in the same list', () => {
    const [list] = parseMarkdown('- one\ncontinued\n\n- two');
    expect(list).toEqual({
      kind: 'list',
      ordered: false,
      items: [
        { number: null, delimiter: null, blocks: [paragraph(text('one\ncontinued'))] },
        { number: null, delimiter: null, blocks: [paragraph(text('two'))] },
      ],
    });
  });

  it('reads a block quote, a thematic break and a fence', () => {
    expect(parseMarkdown('> quoted\n> more\n\n---\n\n```ts\nconst a = 1;\n```')).toEqual([
      { kind: 'quote', blocks: [paragraph(text('quoted\nmore'))] },
      { kind: 'rule' },
      { kind: 'code', language: 'ts', value: 'const a = 1;' },
    ]);
  });

  it('keeps an unterminated fence a code block, and never reads markdown inside one', () => {
    expect(parseMarkdown('```\n**not bold** [x](https://a.example)')).toEqual([
      { kind: 'code', language: null, value: '**not bold** [x](https://a.example)' },
    ]);
  });

  it('reads a pipe table with its alignment and pads a short row', () => {
    expect(parseMarkdown('| a | b | c |\n|:--|:-:|--:|\n| 1 | **2** |')).toEqual([
      {
        kind: 'table',
        align: ['left', 'center', 'right'],
        header: [[text('a')], [text('b')], [text('c')]],
        rows: [[[text('1')], [{ kind: 'strong', children: [text('2')] }], []]],
      },
    ]);
  });

  it('does not read a table whose delimiter row disagrees with its header', () => {
    expect(parseMarkdown('| a | b |\n|---|')[0]?.kind).toBe('paragraph');
  });

  it('never tokenises raw HTML: it stays the characters it was', () => {
    expect(parseMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>')).toEqual([
      paragraph(text('<script>alert(1)</script> <img src=x onerror=alert(1)>')),
    ]);
  });

  it('replaces a bidi override and drops control characters before reading', () => {
    expect(parseMarkdown('**a‮b**\u0007')).toEqual([
      paragraph({ kind: 'strong', children: [text('a�b')] }),
    ]);
  });

  it('falls back to paragraphs and fences above the size guard', () => {
    const big = `# heading **bold**\n\n${'x'.repeat(MAX_MARKDOWN_CHARS)}`;
    const [first] = parseMarkdown(big);
    // One paragraph of literal text: no heading, no strong — the old reading.
    expect(first?.kind).toBe('paragraph');
    expect(first?.kind === 'paragraph' && first.content).toEqual([
      text(`# heading **bold**\n\n${'x'.repeat(MAX_MARKDOWN_CHARS)}`),
    ]);
  });
});

describe('inline', () => {
  it.each([
    ['**strong**', [{ kind: 'strong', children: [text('strong')] }]],
    ['__strong__', [{ kind: 'strong', children: [text('strong')] }]],
    ['*em*', [{ kind: 'emphasis', children: [text('em')] }]],
    ['_em_', [{ kind: 'emphasis', children: [text('em')] }]],
    [
      '***both***',
      [{ kind: 'strong', children: [{ kind: 'emphasis', children: [text('both')] }] }],
    ],
    ['~~gone~~', [{ kind: 'strikethrough', children: [text('gone')] }]],
    ['`a * b`', [{ kind: 'code', value: 'a * b' }]],
    ['`` a ` b ``', [{ kind: 'code', value: 'a ` b' }]],
  ] as const)('reads %s', (source, expected) => {
    expect(parseInlineMarkdown(source)).toEqual(expected);
  });

  it.each([
    'snake_case_name and __init__file',
    '2 * 3 * 4',
    '**unterminated bold',
    '`unterminated code',
    '[no destination]',
    '[unclosed](https://a.example',
    '~5 minutes, ~10 at most',
    '\\*escaped\\*',
  ])('leaves %s as text', (source) => {
    const nodes = parseInlineMarkdown(source);
    expect(nodes.every((node) => node.kind === 'text')).toBe(true);
  });

  it('reads an escape as its literal character', () => {
    expect(parseInlineMarkdown('\\*not em\\*')).toEqual([text('*not em*')]);
  });

  it('reads a link with its raw destination, its label as inline nodes and its source', () => {
    expect(parseInlineMarkdown('see [the **MR**](https://gitlab.example/mr/1 "title")')).toEqual([
      text('see '),
      {
        kind: 'link',
        url: 'https://gitlab.example/mr/1',
        label: [text('the '), { kind: 'strong', children: [text('MR')] }],
        source: '[the **MR**](https://gitlab.example/mr/1 "title")',
      },
    ]);
  });

  it('keeps a balanced parenthesis inside a destination', () => {
    const [link] = parseInlineMarkdown('[w](https://en.example/wiki/A_(b))');
    expect(link?.kind === 'link' && link.url).toBe('https://en.example/wiki/A_(b)');
  });

  it('carries a hostile destination as written — refusing it is the renderer’s', () => {
    const [link] = parseInlineMarkdown('[x](javascript:alert(1))');
    expect(link).toMatchObject({ kind: 'link', url: 'javascript:alert(1)' });
  });

  it('never reads a link inside a link label', () => {
    const [link] = parseInlineMarkdown('[[x](javascript:alert(1))](https://ok.example)');
    expect(link?.kind === 'link' && link.url).toBe('https://ok.example');
    expect(link?.kind === 'link' && link.label).toEqual([text('[x](javascript:alert(1))')]);
  });

  it('reads an http(s) autolink and leaves any other `<…>` as text', () => {
    expect(parseInlineMarkdown('<https://a.example/x>')).toEqual([
      {
        kind: 'link',
        url: 'https://a.example/x',
        label: [text('https://a.example/x')],
        source: '<https://a.example/x>',
      },
    ]);
    expect(parseInlineMarkdown('<javascript:alert(1)>')).toEqual([text('<javascript:alert(1)>')]);
  });

  it('reads an image as data, never as an image', () => {
    expect(parseInlineMarkdown('![diagram](https://a.example/d.png)')).toEqual([
      {
        kind: 'image',
        url: 'https://a.example/d.png',
        alt: 'diagram',
        source: '![diagram](https://a.example/d.png)',
      },
    ]);
  });
});

describe('plain text', () => {
  it('takes the marks off and keeps a refused link’s source', () => {
    expect(markdownToPlainText('**Plan:** use `retry` — [docs](https://a.example)')).toBe(
      'Plan: use retry — docs',
    );
    expect(markdownToPlainText('[click](javascript:alert(1))')).toBe(
      '[click](javascript:alert(1))',
    );
    expect(inlineText([])).toBe('');
  });
});

/** A small markdown alphabet, so a random string is dense in syntax rather than in letters. */
const TOKENS = [
  '*',
  '**',
  '_',
  '__',
  '~~',
  '`',
  '```',
  '[',
  ']',
  '(',
  ')',
  '![',
  '<',
  '>',
  '<https://a.example>',
  '](https://a.example)',
  '](javascript:alert(1))',
  '#',
  '# ',
  '- ',
  '1) ',
  '2. ',
  '> ',
  '|',
  '|---|',
  '---',
  '\\',
  ' ',
  '  ',
  '\t',
  '\n',
  '\n\n',
  'a',
  'word',
  '<script>',
  '‮',
];

const documents = fc
  .array(fc.constantFrom(...TOKENS), { maxLength: 60 })
  .map((parts) => parts.join(''));

describe('properties', () => {
  it('parses every prefix of any document without throwing (a stream is a run of prefixes)', () => {
    fc.assert(
      fc.property(documents, (document) => {
        for (let end = 0; end <= document.length; end += 1) {
          parseMarkdown(document.slice(0, end));
          parseInlineMarkdown(document.slice(0, end));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('keeps every word of a document: nothing a reader parsed is lost', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('**', '*', '`', '_', ' ', '\n'), { maxLength: 20 }),
        (marks) => {
          const document = `${marks.join('')}needle${[...marks].reverse().join('')}`;
          expect(JSON.stringify(parseMarkdown(document))).toContain('needle');
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('linear time', () => {
  /**
   * Inputs that make a naive reader quadratic: openers with no closer, unmatched brackets, nested
   * destinations, autolink starts, deep nesting. At 150 000 characters a quadratic reader does
   * ~10^10 steps; a linear one finishes in milliseconds, so the bound is generous and still decisive.
   */
  it.each([
    ['unclosed emphasis', '*a '.repeat(50_000)],
    ['unclosed strong', '**a '.repeat(37_500)],
    ['unclosed underscores', '_a '.repeat(50_000)],
    [
      'unclosed backticks of every length',
      Array.from({ length: 500 }, (_, n) => `${'`'.repeat(n % 40)}x `)
        .join('')
        .repeat(20),
    ],
    ['open brackets', '['.repeat(150_000)],
    ['link openers', '[a]('.repeat(37_500)],
    ['nested destinations', `${'[a]('.repeat(20_000)}${')'.repeat(20_000)}`],
    ['autolink starts', '<http://a'.repeat(16_000)],
    ['spaces before a heading close', `# ${' '.repeat(150_000)}x`],
    ['deeply nested quotes', `${'> '.repeat(50_000)}x`],
    [
      'deeply nested lists',
      Array.from({ length: 2_000 }, (_, n) => `${' '.repeat(n * 2)}- x`).join('\n'),
    ],
    ['table-like lines', '| a | b |\n'.repeat(15_000)],
  ])('reads %s in linear time', (_name, document) => {
    const started = performance.now();
    parseMarkdown(document);
    parseInlineMarkdown(document.slice(0, MAX_MARKDOWN_CHARS));
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
