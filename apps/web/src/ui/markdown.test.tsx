import { cleanup, render } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { UntrustedInline, UntrustedProse } from './markdown.js';

/**
 * Markdown as React elements (S-28.9), asserted against the **DOM**, as `untrusted.test.tsx` asserts
 * every other untrusted renderer: what elements exist, what an `href` is, what the text says.
 */
afterEach(() => {
  cleanup();
});

/** The plan from the owner's screenshot, in the shape a model writes one. */
const PLAN = [
  'Add a retry budget to the client.',
  '',
  '1) **Read the helper** in `src/retry.ts` and keep its signature.',
  '2) **Add the budget** — default `3`, configurable per project:',
  '   - read it from `.agentic/config.yml`',
  '   - refuse a negative value',
  '3) **Test it** with the fake clock.',
].join('\n');

describe('UntrustedProse', () => {
  it('renders a plan as a numbered list with bold lead-ins and inline code', () => {
    const { container } = render(<UntrustedProse value={PLAN} />);
    const list = container.querySelector('ol');
    expect(list).not.toBeNull();
    const items = [...(list?.children ?? [])];
    expect(items).toHaveLength(3);
    // The source's own numbers and its `)` delimiter.
    expect(items.map((item) => item.getAttribute('value'))).toEqual(['1', '2', '3']);
    expect(items[0]?.textContent).toContain('1)');
    expect(items[0]?.querySelector('strong')?.textContent).toBe('Read the helper');
    expect(items[0]?.querySelector('code')?.textContent).toBe('src/retry.ts');
    expect(items[1]?.querySelectorAll('ul > li')).toHaveLength(2);
    // No syntax is left on screen.
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('`');
  });

  it('renders headings scaled down, a quote, a rule, a table and strikethrough', () => {
    const { container } = render(
      <UntrustedProse
        value={
          '# Title\n## Part\n\n> careful\n\n---\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n~~old~~ *new*'
        }
      />,
    );
    expect(container.querySelector('h1,h2')).toBeNull();
    expect(container.querySelector('h3')?.textContent).toBe('Title');
    expect(container.querySelector('h4')?.textContent).toBe('Part');
    expect(container.querySelector('blockquote')?.textContent).toBe('careful');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelector('[data-markdown-table] th')?.textContent).toBe('a');
    expect(container.querySelector('td.text-right')?.textContent).toBe('2');
    expect(container.querySelector('del')?.textContent).toBe('old');
    expect(container.querySelector('em')?.textContent).toBe('new');
  });

  it('keeps a line break inside a paragraph', () => {
    const { container } = render(<UntrustedProse value={'one\ntwo'} />);
    expect(container.querySelector('p')?.textContent).toBe('one\ntwo');
  });

  it('links a markdown link through safeHref, with the host when the label is not the URL', () => {
    const { container } = render(
      <UntrustedProse value="See [the merge request](https://gitlab.example/g/p/-/merge_requests/1)." />,
    );
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://gitlab.example/g/p/-/merge_requests/1');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(anchor?.textContent).toBe('the merge request');
    expect(container.querySelector('[data-link-host]')?.textContent).toBe(' (gitlab.example)');
  });

  it('shows the real host beside a label that spoofs another URL', () => {
    const { container } = render(
      <UntrustedProse value="[https://gitlab.com/acme/app](https://evil.example/steal)" />,
    );
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://evil.example/steal');
    expect(container.querySelector('[data-link-host]')?.textContent).toBe(' (evil.example)');
  });

  it('shows no host when the label is the URL, and still links a bare URL in a paragraph', () => {
    const { container } = render(
      <UntrustedProse value="<https://a.example/x> and https://b.example/y" />,
    );
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      'https://a.example/x',
      'https://b.example/y',
    ]);
    expect(container.querySelector('[data-link-host]')).toBeNull();
  });

  it.each([
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '[x](vbscript:msgbox(1))',
    '[x](file:///etc/passwd)',
    '<javascript:alert(1)>',
    '![x](javascript:alert(1))',
  ])('renders %s as inert literal text', (source) => {
    const { container } = render(<UntrustedProse value={`before ${source} after`} />);
    expect(container.textContent).toBe(`before ${source} after`);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.querySelector('script,img,iframe')).toBeNull();
  });

  it('renders raw HTML as characters and creates no element from it', () => {
    const value = '<img src=x onerror="window.__pwned = 1"> <script>window.__pwned = 1;</script>';
    const { container } = render(<UntrustedProse value={value} />);
    expect(container.textContent).toBe(value);
    expect(container.querySelector('script,img')).toBeNull();
  });

  it('never nests a link in a link, and links only the outer destination', () => {
    const { container } = render(
      <UntrustedProse value="[[x](javascript:alert(1)) https://inner.example](https://ok.example)" />,
    );
    const anchors = [...container.querySelectorAll('a')];
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual(['https://ok.example/']);
    expect(anchors[0]?.textContent).toBe('[x](javascript:alert(1)) https://inner.example');
  });

  it('renders an image as its description and a link, never as an image', () => {
    const { container } = render(<UntrustedProse value="![diagram](https://a.example/d.png)" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')?.textContent).toBe('Image: diagram');
    expect(container.querySelector('[data-link-host]')?.textContent).toBe(' (a.example)');
  });

  it('renders every prefix of a streaming document, and never an element from a payload', () => {
    const tokens = [
      '**',
      '*',
      '`',
      '```',
      '[x](',
      'javascript:alert(1)',
      'https://a.example',
      ')',
      ']',
      '<script>',
      '<img src=x onerror=alert(1)>',
      '1) ',
      '- ',
      '> ',
      '# ',
      '| a |',
      '|---|',
      '\n',
      ' ',
      'word',
    ];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...tokens), { maxLength: 25 }).map((parts) => parts.join('')),
        (document) => {
          for (let end = 0; end <= document.length; end += 7) {
            cleanup();
            const { container } = render(<UntrustedProse value={document.slice(0, end)} />);
            expect(container.querySelector('script,img,iframe')).toBeNull();
            for (const anchor of container.querySelectorAll('a')) {
              expect(anchor.getAttribute('href')).toMatch(/^https:\/\//u);
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('UntrustedInline', () => {
  it('renders the inline marks and no block element', () => {
    const { container } = render(
      <UntrustedInline value={'**Risk:** the `retry` budget\n# not a heading'} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('Risk:');
    expect(container.querySelector('code')?.textContent).toBe('retry');
    expect(container.querySelector('p,h1,h2,h3,h4,h5,h6,ol,ul,div')).toBeNull();
    expect(container.textContent).toContain('# not a heading');
  });
});
