import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodeText,
  ExternalLink,
  JsonView,
  NumberedCode,
  TerminalText,
  UntrustedProse,
  UntrustedText,
} from './untrusted.js';

/**
 * The rule of BD-022 in a UI, asserted against the **DOM** rather than against a string.
 *
 * WP-10's Slack escape was correct as a string and wrong in the sink, because a later function
 * undid it. The only assertion that would have caught that is one made on the thing the user's
 * browser actually holds — so every test here reaches into `container` and asks what elements
 * exist, what an `href` is, and what the text content is.
 *
 * Each test also asserts something **positive** first (the harmless part of the payload is on
 * screen), so a component that rendered nothing at all cannot pass by being empty (standing rule
 * 4).
 */
afterEach(() => {
  cleanup();
});

const PAYLOADS = {
  script: '<script>window.__pwned = 1;</script>',
  image: '<img src=x onerror="window.__pwned = 1">',
  svg: '<svg onload=alert(1)>',
  iframe: '<iframe src="javascript:alert(1)"></iframe>',
  entity: '&lt;b&gt;not bold&lt;/b&gt;',
} as const;

describe('UntrustedText', () => {
  it('renders markup as characters and creates no element from it', () => {
    const { container } = render(<UntrustedText value={`hello ${PAYLOADS.script}`} />);

    expect(container.textContent).toBe(`hello ${PAYLOADS.script}`);
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('<script');
  });

  it.each(Object.entries(PAYLOADS))('renders %s as text', (_name, payload) => {
    const { container } = render(<UntrustedText value={`before ${payload} after`} />);

    expect(container.textContent).toBe(`before ${payload} after`);
    expect(container.querySelector('script,img,svg,iframe')).toBeNull();
  });

  it('links an http URL with the full rel and never a javascript: one', () => {
    const { container } = render(
      <UntrustedText value="ok https://example.invalid/x and javascript:alert(1)" />,
    );

    const anchors = [...container.querySelectorAll('a')];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute('href')).toBe('https://example.invalid/x');
    expect(anchors[0]?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(anchors[0]?.getAttribute('target')).toBe('_blank');
    // The refused one is still readable, as text.
    expect(container.textContent).toContain('javascript:alert(1)');
  });

  it('never produces an anchor whose href is not http(s)', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      '[label](javascript:alert(1))',
      'file:///etc/passwd',
    ]) {
      cleanup();
      const { container } = render(<UntrustedText value={value} />);
      expect(container.textContent, value).toContain(value.slice(0, 10));
      expect([...container.querySelectorAll('a')], value).toHaveLength(0);
    }
  });
});

describe('ExternalLink', () => {
  /**
   * The DTO side of the same rule. `taskRecordSchema.ticket.url` is `urlSchema` — `z.url()` — and
   * `z.url()` accepts `javascript:alert(1)`, `data:text/html,…`, `vbscript:` and `file:`; the
   * board and the task screen used to put that string straight into `href`. React 19.3 rewrote a
   * `javascript:` URL and nothing else, so this component (not the framework) is what refuses
   * `data:` and `vbscript:` — the two the probe showed React passes through verbatim.
   */
  it('links an http(s) URL with the full rel', () => {
    const { container } = render(
      <ExternalLink url="https://tickets.example.invalid/browse/DEMO-1" label="Open ticket" />,
    );
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://tickets.example.invalid/browse/DEMO-1');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.textContent).toBe('Open ticket');
  });

  it.each([
    'javascript:window.__pwned=true',
    'data:text/html,<script>window.__pwned=true</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'jAvAsCrIpT:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'not a url at all',
  ])('renders no anchor at all for %s', (url) => {
    const { container } = render(<ExternalLink url={url} label="Open ticket" />);

    // The label is still on screen, so "no anchor" is not "nothing rendered" (standing rule 4).
    expect(container.textContent).toBe('Open ticket');
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.querySelector('[data-link-refused]')).not.toBeNull();
    // Not one attribute in the document holds the refused string.
    expect(container.innerHTML).not.toContain('href');
  });

  it('says in the title what it refused, with bidi controls neutralised', () => {
    const { container } = render(<ExternalLink url={'javascript:x\u202Ey'} label="Open ticket" />);
    const title = container.querySelector('span')?.getAttribute('title') ?? '';
    expect(title).toContain('javascript:x');
    expect(title).not.toContain('\u202E');
  });
});

describe('UntrustedProse', () => {
  it('renders a fenced block as a code element whose contents are text', () => {
    const { container } = render(
      <UntrustedProse value={`intro\n\`\`\`ts\nconst a = ${PAYLOADS.script};\n\`\`\``} />,
    );

    expect(screen.getByText('intro')).toBeTruthy();
    const code = container.querySelector('pre code');
    expect(code?.textContent).toBe(`const a = ${PAYLOADS.script};`);
    expect(container.querySelector('script')).toBeNull();
  });

  it('does not linkify inside a code block', () => {
    const { container } = render(
      <UntrustedProse value={'```\nsee https://example.invalid/x\n```'} />,
    );
    expect(container.querySelector('pre code')?.textContent).toContain('https://example.invalid/x');
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('linkifies outside a code block, so the previous assertion is about position', () => {
    const { container } = render(<UntrustedProse value={'see https://example.invalid/x'} />);
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });

  it('renders a heading, a table and raw HTML as literal text', () => {
    const value = '# Title\n<b>bold</b>\n| a | b |';
    const { container } = render(<UntrustedProse value={value} />);
    expect(container.textContent).toContain('# Title');
    expect(container.textContent).toContain('<b>bold</b>');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
  });
});

describe('the verbatim renderers', () => {
  it('CodeText writes into a pre > code and creates no element', () => {
    const { container } = render(<CodeText value={PAYLOADS.image} />);
    expect(container.querySelector('pre code')?.textContent).toBe(PAYLOADS.image);
    expect(container.querySelector('img')).toBeNull();
  });

  it('TerminalText strips ANSI and keeps the text', () => {
    const { container } = render(<TerminalText value={'\u001B[31mfailed\u001B[0m 2 tests'} />);
    const text = container.querySelector('pre code')?.textContent ?? '';
    expect(text).toBe('failed 2 tests');
    expect(text).not.toContain('\u001B');
  });

  it('NumberedCode numbers every line and renders the content as text', () => {
    const { container } = render(<NumberedCode value={`a\n${PAYLOADS.script}\nc`} />);
    expect(container.textContent).toContain('1');
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain(PAYLOADS.script);
    expect(container.querySelector('script')).toBeNull();
  });

  /**
   * Found by `test/web-e2e/xss.spec.ts` against the real DOM, not by these unit tests: the
   * segmenting renderers sanitised and the verbatim ones did not, which is the WP-10 shape — one
   * path filtering and another not. Every renderer is asserted here so the next one added is
   * measured against a list rather than against a memory.
   */
  it.each([
    ['CodeText', (value: string) => <CodeText value={value} />],
    ['TerminalText', (value: string) => <TerminalText value={value} />],
    ['NumberedCode', (value: string) => <NumberedCode value={value} />],
    ['UntrustedText', (value: string) => <UntrustedText value={value} />],
    ['UntrustedProse', (value: string) => <UntrustedProse value={value} />],
  ])('%s replaces a bidi override rather than letting it reorder the line', (_name, renderer) => {
    const { container } = render(renderer('if (admin) {\u202E // } yretsam si nrettap eht'));
    const text = container.textContent ?? '';

    expect(text).toContain('if (admin) {');
    expect(text).not.toContain('\u202E');
    expect(text).toContain('\uFFFD');
  });

  it('JsonView survives a value JSON.stringify cannot serialise', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const { container } = render(<JsonView value={cyclic} />);
    expect(container.querySelector('pre code')?.textContent).toBe('[object Object]');
  });
});
