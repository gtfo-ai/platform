/**
 * Markdown ⇄ ADF, held to the node shapes Atlassian publishes
 * (`https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/`, retrieved
 * 2026-09-10) and to the round trip BD-023 depends on: the workpad is written as markdown, stored
 * as ADF and read back as markdown, and a caller comparing the two must see what it wrote.
 */
import { describe, expect, it } from 'vitest';
import type { AdfDocument } from './adf.js';
import {
  AdfConversionError,
  adfMarkerId,
  adfToMarkdown,
  assertNoCallerMarker,
  markdownToAdfDocument,
  markerFooterText,
} from './adf.js';

describe('markdownToAdfDocument', () => {
  it('produces the documented root node', () => {
    const document = markdownToAdfDocument('Hello **world**');
    expect(document.version).toBe(1);
    expect(document.type).toBe('doc');
    expect(document.content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world', marks: [{ type: 'strong' }] },
        ],
      },
    ]);
  });

  it('converts the block vocabulary a workpad uses', () => {
    const markdown = [
      '# Stage: implementation',
      '',
      '- [x] acceptance criteria',
      '',
      '```ts',
      'const total = net + vat;',
      '```',
      '',
      '| check | result |',
      '| --- | --- |',
      '| unit | pass |',
    ].join('\n');
    const types = markdownToAdfDocument(markdown).content.map((node) => node.type);
    // Four nodes, named: a converter that flattened them into paragraphs fails here loudly.
    // `- [x]` becomes a `taskList`, not a `bulletList` — marklassian 1.2.1's own choice, and the
    // renderer has to know it or a checklist round-trips as prose.
    expect(types).toEqual(['heading', 'taskList', 'codeBlock', 'table']);

    const document = markdownToAdfDocument(markdown);
    expect(document.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(document.content[2]).toMatchObject({ type: 'codeBlock', attrs: { language: 'ts' } });
    expect(document.content[3]?.content?.[0]?.content?.[0]?.type).toBe('tableHeader');
  });

  it('refuses an empty document rather than posting a blank comment', () => {
    expect(() => markdownToAdfDocument('   \n  ')).toThrow(AdfConversionError);
    // Non-blank markdown that renders to nothing is the same caller bug: marklassian drops an HTML
    // comment entirely, so this would have posted `content: []` — a legal ADF document and a blank
    // Jira comment.
    expect(() => markdownToAdfDocument('<!-- nothing to say -->')).toThrow(AdfConversionError);
  });

  it('appends the marker as the last node and nowhere else', () => {
    const document = markdownToAdfDocument('# Workpad\n\nBody.', { markerId: 'agentic:workpad' });
    expect(adfMarkerId(document)).toBe('agentic:workpad');
    expect(document.content.at(-1)).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: markerFooterText('agentic:workpad'), marks: [{ type: 'code' }] },
      ],
    });
    expect(document.content.length).toBe(3);
  });

  describe('markdown structure cannot capture the marker', () => {
    // WP-08 review round 2. The footer used to be appended as a *line of markdown* and converted
    // with the body, so any structure the body left open swallowed it. An unclosed fence runs to
    // the end of the document under CommonMark, and the markdown is agent-authored — derived from
    // ticket text an attacker writes (BD-022) — so this was a crash reachable from a ticket.
    const MARKER = 'agentic:workpad';
    const typesOf = (markdown: string): readonly string[] =>
      markdownToAdfDocument(markdown, { markerId: MARKER }).content.map((node) => node.type);
    const codeOf = (markdown: string): string | undefined =>
      markdownToAdfDocument(markdown, { markerId: MARKER }).content[1]?.content?.[0]?.text;

    it('survives an unclosed code fence, which used to swallow it and throw', () => {
      const markdown = 'a\n\n```js\nconst x = 1;';
      const document = markdownToAdfDocument(markdown, { markerId: MARKER });
      expect(adfMarkerId(document), 'the marker is the last node, outside the code block').toBe(
        MARKER,
      );
      expect(typesOf(markdown)).toEqual(['paragraph', 'codeBlock', 'paragraph']);
      expect(codeOf(markdown), 'the code the agent wrote is intact').toBe('const x = 1;');
      expect(adfToMarkdown(document), 'read back, the fence is closed and the marker is gone').toBe(
        'a\n\n```js\nconst x = 1;\n```',
      );
    });

    it('survives an unclosed code fence when no marker was asked for', () => {
      const document = markdownToAdfDocument('a\n\n```js\nconst x = 1;');
      expect(adfMarkerId(document)).toBeNull();
      expect(document.content.map((node) => node.type)).toEqual(['paragraph', 'codeBlock']);
    });

    it('survives a fence closed at the very end of the markdown', () => {
      const markdown = 'a\n\n```js\nconst x = 1;\n```';
      expect(typesOf(markdown)).toEqual(['paragraph', 'codeBlock', 'paragraph']);
      expect(codeOf(markdown)).toBe('const x = 1;');
      expect(adfMarkerId(markdownToAdfDocument(markdown, { markerId: MARKER }))).toBe(MARKER);
    });

    it('survives nested fences, where the inner one is content and not structure', () => {
      const markdown = 'a\n\n````\n```js\nx\n```\n````';
      expect(typesOf(markdown)).toEqual(['paragraph', 'codeBlock', 'paragraph']);
      expect(codeOf(markdown), 'the inner fence stayed inside the block').toBe('```js\nx\n```');
      expect(adfMarkerId(markdownToAdfDocument(markdown, { markerId: MARKER }))).toBe(MARKER);
    });

    it('is the only live marker even when a fence contains the marker text', () => {
      const markdown = 'the reporter pasted:\n\n```\n[agentic:marker:agentic:workpad]\n```';
      const document = markdownToAdfDocument(markdown, { markerId: MARKER });
      expect(adfMarkerId(document)).toBe(MARKER);
      expect(
        document.content.filter((node) => JSON.stringify(node).includes('[agentic:marker:')).length,
        'exactly one node carries a live marker: the one the platform appended',
      ).toBe(1);
      expect(document.content[1]?.content?.[0]?.text, 'the pasted one is quoted, not dropped').toBe(
        '[quoted:agentic:marker:agentic:workpad]',
      );
    });
  });

  describe('a marker in the caller’s own markdown', () => {
    // BD-022: the markdown an agent writes is derived from ticket text an attacker controls, so a
    // marker in it is attacker-supplied even though the *bot* posts the comment. WP-08 review
    // round 1 posted one through `addComment` and had the next `upsertWorkpad` adopt it.
    const spoof = 'The reporter says:\n\n`[agentic:marker:agentic:workpad]`';

    it('is neutralised, so an unmarked comment stays unmarked', () => {
      const document = markdownToAdfDocument(spoof);
      expect(adfMarkerId(document), 'the comment claims no marker').toBeNull();
      expect(adfToMarkdown(document)).toBe(
        'The reporter says:\n\n`[quoted:agentic:marker:agentic:workpad]`',
      );
    });

    it('is neutralised whatever its case, because neutralising more than the reader reads is the safe direction', () => {
      const document = markdownToAdfDocument('see `[AGENTIC:MARKER:agentic:workpad]`');
      expect(adfToMarkdown(document)).toBe('see `[quoted:AGENTIC:MARKER:agentic:workpad]`');
    });

    it('does not become the marker of a workpad the platform does mark', () => {
      const document = markdownToAdfDocument(spoof, { markerId: 'agentic:workpad' });
      expect(adfMarkerId(document)).toBe('agentic:workpad');
      expect(
        document.content.filter((node) => JSON.stringify(node).includes('[agentic:marker:')).length,
        'exactly one node carries a live marker: the one the platform appended',
      ).toBe(1);
    });
  });
});

describe('assertNoCallerMarker', () => {
  /**
   * The seam for a guard that is otherwise unreachable (standing rule 3).
   *
   * `markdownToAdfDocument` cannot produce a document that ends in a marker node, because
   * `neutraliseQuotedMarkers` rewrites every `[agentic:marker:` in the caller's markdown first —
   * eleven spoof routes were tried at review round 2 and none got through. That completeness is
   * exactly what makes the inner refusal untestable *through the front door*, so the refusal lives
   * in its own function and is driven here with a document marklassian would never emit.
   */
  const endingIn = (text: string): AdfDocument => ({
    version: 1,
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
      { type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'code' }] }] },
    ],
  });

  it('refuses a document that already ends in a marker nobody asked for', () => {
    expect(() => assertNoCallerMarker(endingIn(markerFooterText('agentic:workpad')))).toThrow(
      AdfConversionError,
    );
  });

  it('interpolates none of the caller’s text, because it throws outside the executor', () => {
    // docs/TODO.md tracks every throw that leaves this adapter without passing the action
    // executor's redactor. A marker id is caller-derived (BD-022), so the refusal names it not.
    let message = 'never thrown';
    try {
      assertNoCallerMarker(endingIn(markerFooterText('spoofed-by-the-reporter')));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('refusing to post a comment whose own text ends in a platform marker');
  });

  it('passes a document whose last node is ordinary text', () => {
    expect(() => assertNoCallerMarker(endingIn('`just some code`'))).not.toThrow();
  });
});

describe('adfToMarkdown', () => {
  it('round-trips the markdown a workpad is written in', () => {
    for (const markdown of [
      '# Workpad v2',
      'Plain text with **bold**, *em*, `code` and a [link](https://example.test/x).',
      '- one\n- two',
      '1. first\n2. second',
      '```ts\nconst x = 1;\n```',
      '> quoted',
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
      '- [x] done\n- [ ] open',
      '## Heading\n\nA paragraph.\n\n---\n\nAnother.',
    ]) {
      expect(adfToMarkdown(markdownToAdfDocument(markdown)), markdown).toBe(markdown);
    }
  });

  it('strips the platform’s marker so a caller reads back what it wrote', () => {
    const markdown = '# Workpad v2\n\nStill going.';
    const document = markdownToAdfDocument(markdown, { markerId: 'agentic:workpad' });
    expect(adfToMarkdown(document)).toBe(markdown);
  });

  it('keeps a marker-shaped line a human wrote, because it is not the last node', () => {
    const document = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '[agentic:marker:agentic:workpad]', marks: [{ type: 'code' }] },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'nice try' }] },
      ],
    };
    expect(adfMarkerId(document), 'only the last node can be the marker').toBeNull();
    expect(adfToMarkdown(document)).toBe('`[agentic:marker:agentic:workpad]`\n\nnice try');
  });

  it('renders the inline nodes a human comment can contain', () => {
    const document = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: '557058:fake', text: '@Dev One' } },
            { type: 'text', text: ' see ' },
            { type: 'inlineCard', attrs: { url: 'https://example.test/ticket/1' } },
            { type: 'text', text: ' ' },
            { type: 'emoji', attrs: { shortName: ':warning:', text: '⚠️' } },
          ],
        },
      ],
    };
    expect(adfToMarkdown(document)).toBe('@Dev One see https://example.test/ticket/1 ⚠️');
  });

  it('prints the children of a node type it has never heard of', () => {
    // Atlassian ships new node types without a version bump (`bodiedSyncBlock`,
    // `multiBodiedExtension` are in the current list). Dropping the text inside one would silently
    // truncate a ticket description.
    const document = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'bodiedSyncBlock',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'synced text' }] }],
        },
      ],
    };
    expect(adfToMarkdown(document)).toBe('synced text');
  });

  it('is total: a value that is not a document renders as nothing', () => {
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown({ version: 2, type: 'doc', content: [] })).toBe('');
    expect(adfToMarkdown('a string')).toBe('');
  });
});

describe('adfToMarkdown — the nodes only Jira produces', () => {
  const doc = (...content: unknown[]) => ({ version: 1, type: 'doc', content });
  const paragraph = (text: string) => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
  });

  it('renders a panel and a blockquote as quoted markdown', () => {
    // A panel is Jira's "info/warning box"; there is no markdown for it, and a quote keeps the
    // words and the fact that they were set apart.
    expect(
      adfToMarkdown(
        doc({ type: 'panel', attrs: { panelType: 'warning' }, content: [paragraph('careful')] }),
      ),
    ).toBe('> careful');
    expect(adfToMarkdown(doc({ type: 'blockquote', content: [paragraph('quoted')] }))).toBe(
      '> quoted',
    );
  });

  it('renders a nested list under its parent item', () => {
    const nested = doc({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            paragraph('outer'),
            { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('inner')] }] },
          ],
        },
      ],
    });
    expect(adfToMarkdown(nested)).toBe('- outer\n\n  - inner');
  });

  it('renders a hard break inside a paragraph', () => {
    expect(
      adfToMarkdown(
        doc({
          type: 'paragraph',
          content: [
            { type: 'text', text: 'one' },
            { type: 'hardBreak' },
            { type: 'text', text: 'two' },
          ],
        }),
      ),
    ).toBe('one\ntwo');
  });

  it('renders the attachment, status and date nodes as something a human can read', () => {
    expect(
      adfToMarkdown(
        doc(
          { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'media-1' } }] },
          {
            type: 'paragraph',
            content: [
              { type: 'status', attrs: { text: 'BLOCKED' } },
              { type: 'text', text: ' since ' },
              { type: 'date', attrs: { timestamp: '1788350400000' } },
              { type: 'mediaInline', attrs: { id: 'media-2' } },
            ],
          },
        ),
      ),
    ).toBe('[media:media-1]\n\nBLOCKED since 1788350400000[media:media-2]');
  });

  it('renders an expand with its title, and a nested one without', () => {
    expect(
      adfToMarkdown(
        doc({ type: 'expand', attrs: { title: 'Logs' }, content: [paragraph('body')] }),
      ),
    ).toBe('**Logs**\n\nbody');
    expect(adfToMarkdown(doc({ type: 'nestedExpand', content: [paragraph('body')] }))).toBe('body');
  });

  it('clamps a heading level into the markdown range', () => {
    expect(
      adfToMarkdown(
        doc({ type: 'heading', attrs: { level: 9 }, content: [{ type: 'text', text: 'deep' }] }),
      ),
    ).toBe('###### deep');
    expect(
      adfToMarkdown(doc({ type: 'heading', content: [{ type: 'text', text: 'no level' }] })),
    ).toBe('# no level');
  });

  it('renders an open task item as an unchecked box', () => {
    expect(
      adfToMarkdown(
        doc({
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { state: 'TODO' },
              content: [{ type: 'text', text: 'open' }],
            },
          ],
        }),
      ),
    ).toBe('- [ ] open');
  });

  it('renders an empty table as nothing rather than a broken one', () => {
    expect(adfToMarkdown(doc({ type: 'table', content: [] }))).toBe('');
  });

  it('renders a mention with no text attribute from its id', () => {
    expect(
      adfToMarkdown(
        doc({ type: 'paragraph', content: [{ type: 'mention', attrs: { id: '557058:fake' } }] }),
      ),
    ).toBe('@557058:fake');
    expect(
      adfToMarkdown(doc({ type: 'paragraph', content: [{ type: 'mention', attrs: {} }] })),
    ).toBe('@unknown');
  });

  it('renders a link whose text also carries emphasis', () => {
    expect(
      adfToMarkdown(
        doc({
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'the MR',
              marks: [
                { type: 'strong' },
                { type: 'link', attrs: { href: 'https://example.test/7' } },
              ],
            },
          ],
        }),
      ),
    ).toBe('[**the MR**](https://example.test/7)');
  });
});
