import { describe, expect, it } from 'vitest';
import {
  kbLayerOf,
  MAX_CHUNK_BYTES,
  MAX_CHUNKS_PER_DOCUMENT,
  parseKbDocument,
} from './document.js';

const parse = (source: string, vaultRelativePath = 'lessons/L-1.md') =>
  parseKbDocument({
    path: `.agentic/knowledge/${vaultRelativePath}`,
    vaultRelativePath,
    source,
    projectKey: 'DEMO',
  });

const ok = (source: string, vaultRelativePath?: string) => {
  const result = parse(source, vaultRelativePath);
  if (result.status !== 'ok') throw new Error(`expected ok, got: ${result.reason}`);
  return result.document;
};

describe('parseKbDocument — chunking', () => {
  it('splits by heading and prefixes every chunk with project / path / heading path', () => {
    const document = ok(
      ['# Title', 'intro text', '', '## First', 'first body', '', '### Deep', 'deep body'].join(
        '\n',
      ),
    );
    expect(document.chunks.map((chunk) => chunk.headingPath)).toEqual([
      'Title',
      'Title > First',
      'Title > First > Deep',
    ]);
    expect(document.chunks[0]?.text).toBe('DEMO / lessons/L-1.md / Title\n\nintro text');
    expect(document.chunks[2]?.text).toBe(
      'DEMO / lessons/L-1.md / Title > First > Deep\n\ndeep body',
    );
  });

  it('keeps a preamble before the first heading as its own chunk with an empty heading path', () => {
    const document = ok('preamble\n\n# Title\n\nbody');
    expect(document.chunks[0]?.headingPath).toBe('');
    expect(document.chunks[0]?.text).toBe('DEMO / lessons/L-1.md\n\npreamble');
  });

  it('pops the heading stack when a shallower heading follows a deeper one', () => {
    const document = ok('# A\n\na\n\n## B\n\nb\n\n# C\n\nc');
    expect(document.chunks.map((chunk) => chunk.headingPath)).toEqual(['A', 'A > B', 'C']);
  });

  it('does not read a comment inside a fenced code block as a heading', () => {
    const document = ok(['# Pitfall', '', '```sh', '# make test', 'make test', '```'].join('\n'));
    expect(document.chunks).toHaveLength(1);
    expect(document.chunks[0]?.text).toContain('# make test');
  });

  it('sums document tokens from its chunks, so the row and the chunks cannot disagree', () => {
    const document = ok('# A\n\naaaa\n\n# B\n\nbbbb');
    expect(document.tokens).toBe(document.chunks.reduce((total, chunk) => total + chunk.tokens, 0));
    expect(document.tokens).toBeGreaterThan(0);
  });
});

describe('parseKbDocument — the bounds the database imposes', () => {
  it('splits an over-long section rather than truncating it, and every piece is under the cap', () => {
    // Postgres refuses a tsvector over 1 MB, so an unbounded chunk is a failed INSERT, not a big
    // row. The split is asserted by *producing* the over-long section, not by describing it.
    const line = `${'word '.repeat(200)}\n`;
    const body = line.repeat(400);
    const document = ok(`# Long\n\n${body}`);
    expect(document.chunks.length).toBeGreaterThan(1);
    const encoder = new TextEncoder();
    for (const chunk of document.chunks) {
      expect(encoder.encode(chunk.text).length).toBeLessThanOrEqual(MAX_CHUNK_BYTES + 200);
    }
    expect(document.truncated).toBe(false);
  });

  it('splits a single line longer than the cap, whatever the script', () => {
    const document = ok(`# Long\n\n${'ěščřž'.repeat(20_000)}`);
    expect(document.chunks.length).toBeGreaterThan(1);
    const encoder = new TextEncoder();
    for (const chunk of document.chunks) {
      expect(encoder.encode(chunk.text).length).toBeLessThanOrEqual(MAX_CHUNK_BYTES + 200);
    }
  });

  it('marks a document truncated when it exceeds the chunk ceiling', () => {
    const sections = Array.from(
      { length: MAX_CHUNKS_PER_DOCUMENT + 20 },
      (_unused, index) => `# H${String(index)}\n\nbody ${String(index)}`,
    ).join('\n\n');
    const document = ok(sections);
    expect(document.chunks).toHaveLength(MAX_CHUNKS_PER_DOCUMENT);
    expect(document.truncated).toBe(true);
  });
});

describe('parseKbDocument — frontmatter', () => {
  it('validates the known vocabulary and keeps unknown keys', () => {
    const document = ok(
      [
        '---',
        'type: pitfall',
        'kind: technical',
        'status: active',
        'confidence: confirmed',
        'scope: stage:architecture',
        'paths: ["src/api/**"]',
        'owner: the-platform-team',
        '---',
        '# Body',
      ].join('\n'),
    );
    expect(document.frontmatter.type).toBe('pitfall');
    expect(document.frontmatter.scope).toBe('stage:architecture');
    expect(document.rawFrontmatter.owner).toBe('the-platform-team');
  });

  it('refuses a known key with a value outside the vocabulary, naming the key', () => {
    const result = parse('---\nstatus: activ\n---\n# Body');
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('expected invalid');
    expect(result.reason).toContain('status');
  });

  it('refuses a malformed block and carries the line through', () => {
    const result = parse('---\nkind: technical\nnested:\n  key: value\n---\n# Body');
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('expected invalid');
    expect(result.line).toBe(4);
  });

  it('refuses a scope that is not `project` or `stage:<slug>`', () => {
    expect(parse('---\nscope: stage:Architecture\n---\n# B').status).toBe('invalid');
    expect(parse('---\nscope: everywhere\n---\n# B').status).toBe('invalid');
    expect(parse('---\nscope: project\n---\n# B').status).toBe('ok');
  });
});

describe('parseKbDocument — links', () => {
  it('collects wikilinks and intra-vault markdown links, and drops external ones', () => {
    const document = ok(
      [
        '# Body',
        'See [[decisions/D-0001-postgres-sessions]] and [[technical/x|the page]].',
        'Also [billing](../technical/billing.md) and [vendor](https://example.test/docs).',
        'And an [anchor](#section).',
      ].join('\n'),
    );
    expect(document.links).toEqual([
      { toPath: 'decisions/D-0001-postgres-sessions', kind: 'wikilink' },
      { toPath: 'technical/x', kind: 'wikilink' },
      { toPath: '../technical/billing.md', kind: 'markdown' },
    ]);
  });

  it('deduplicates repeated links', () => {
    const document = ok('# B\n\n[[a]] [[a]] [[a]]');
    expect(document.links).toHaveLength(1);
  });
});

describe('kbLayerOf', () => {
  it.each([
    ['business/overview.md', 'business'],
    ['technical/architecture.md', 'technical'],
    ['decisions/D-1.md', 'decisions'],
    ['lessons/L-1.md', 'lessons'],
    ['tasks/DEMO-1.md', 'tasks'],
    ['rules/commit-style.md', 'rules'],
    ['CLAUDE.md', 'root'],
    ['index.md', 'root'],
    ['scratch/notes/a.md', 'other'],
    ['root/a.md', 'other'],
    ['other/a.md', 'other'],
  ])('%s → %s', (relative, layer) => {
    expect(kbLayerOf(relative)).toBe(layer);
  });
});

describe('parseKbDocument — the frontmatter that has to be searchable', () => {
  it('puts `title` and `trigger` into the first chunk, so the trigger match can fire', () => {
    // technical/07 step 2 is a *trigger*/full-text match, and product/05 calls `trigger` "the
    // description used for matching". Neither appears in the body, so without this the trigger half
    // of step 2 matches nothing, ever — and nothing would say so.
    const document = ok(
      [
        '---',
        'title: Session tests need a seeded fixture user',
        'trigger: "running or writing tests for the session service"',
        '---',
        '# Pitfall',
        '',
        'Run seed:users first.',
      ].join('\n'),
    );
    expect(document.chunks[0]?.text).toContain('Session tests need a seeded fixture user');
    expect(document.chunks[0]?.text).toContain('running or writing tests for the session service');
    expect(document.chunks[0]?.text).toContain('Run seed:users first.');
  });

  it('puts it in the first chunk only, so metadata cannot outrank the document body', () => {
    const document = ok(
      ['---', 'title: A title', '---', '# One', '', 'a', '', '# Two', '', 'b'].join('\n'),
    );
    expect(document.chunks[0]?.text).toContain('A title');
    expect(document.chunks[1]?.text).not.toContain('A title');
  });

  it('gives a frontmatter-only document a chunk, so it is reachable at all', () => {
    const document = ok(['---', 'title: Only metadata', '---'].join('\n'));
    expect(document.chunks).toHaveLength(1);
    expect(document.chunks[0]?.text).toContain('Only metadata');
  });

  it('leaves a document with no title or trigger unchanged', () => {
    const document = ok(['---', 'kind: technical', '---', '# One', '', 'a'].join('\n'));
    expect(document.chunks[0]?.text).toBe('DEMO / lessons/L-1.md / One\n\na');
  });
});
