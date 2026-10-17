/**
 * `gitlabNoteBody` — every merge-request note the GitLab adapter posts is mention-neutral (WP-187,
 * backlog 549).
 *
 * Three halves. The **cases** pin the form and the code that is left alone. The **property** renders
 * generated notes with `marked` (a CommonMark renderer; GitLab's own is not available offline) and
 * reads the result with happy-dom, failing on any text a mention grammar would read outside the
 * elements GitLab's reference filter skips — `pre`, `code`, `a` and `style`
 * (`lib/banzai/filter/references/reference_filter.rb`, cited in `test/fixtures/http/gitlab/SOURCES.md`)
 * — the run that found every rule `mentions.ts` states. The **census** reads the
 * adapter's sources and refuses a call to a note-writing client member whose body does not come
 * from `gitlabNoteBody`; the note-writing members are derived from `client.ts` (the ones that send
 * GitLab's note field, `body`), not listed here (standing rule 7).
 *
 * What none of it proves: that GitLab's renderer agrees with `marked` where the two differ —
 * `[unverified]`, `docs/TODO.md`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderConversationReply, renderFindingWith } from '@platform/application';
import fc from 'fast-check';
import { Window } from 'happy-dom';
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { gitlabNoteBody } from './mentions.js';

const window = new Window();

/** Every text outside `pre`, `code`, `a` and `style` in which a mention grammar would find a name. */
const bareMentions = (markdown: string): string[] => {
  const host = window.document.createElement('div');
  host.innerHTML = marked.parse(markdown, { async: false });
  const found: string[] = [];
  const walk = (node: { readonly childNodes: ArrayLike<unknown> }, inCode: boolean): void => {
    for (const child of Array.from(node.childNodes) as {
      nodeType: number;
      textContent: string | null;
      tagName?: string;
      childNodes: ArrayLike<unknown>;
    }[]) {
      if (child.nodeType === 3) {
        const text = child.textContent ?? '';
        if (!inCode && /(?<![A-Za-z0-9_])@[A-Za-z0-9_]/.test(text)) found.push(text);
      } else if (child.nodeType === 1) {
        const tag = (child.tagName ?? '').toLowerCase();
        if (tag !== 'script') {
          walk(child, inCode || ['pre', 'code', 'a', 'style'].includes(tag));
        }
      }
    }
  };
  walk(host, false);
  return found;
};

describe('the form', () => {
  it.each([
    ['@all', '<code>@&#8203;all</code>'],
    ['ask @someone.', 'ask <code>@&#8203;someone.</code>'],
    ['(@group/sub)', '(<code>@&#8203;group/sub</code>)'],
    ['\\@all', '<code>@&#8203;all</code>'],
    ['&#64;all', '<code>&#64;&#8203;all</code>'],
    ['_@all_', '_<code>@&#8203;all_</code>'],
    ['@all@all', '<code>@&#8203;all</code><code>@&#8203;all</code>'],
  ])('writes %j as inline code', (input, expected) => {
    expect(gitlabNoteBody(input)).toBe(expected);
    expect(bareMentions(gitlabNoteBody(input))).toEqual([]);
  });

  it('leaves an e-mail address, a code span and a fence byte-identical', () => {
    const body = [
      'Mail dana@example.test about `@Injectable()` first.',
      '',
      '```suggestion:-0+0',
      '@Component({ selector: "app" })',
      '```',
      '~~~',
      '@all',
      '~~~',
    ].join('\n');
    expect(gitlabNoteBody(body)).toBe(body);
  });

  it.each([
    ['after a prose line that opens with a tag', '<Button> loses its label.\n\n'],
    ['inside a list item', '1. Change it:\n\n   '],
  ])('leaves a suggestion fence byte-identical %s', (_name, lead) => {
    const indent = lead.endsWith('   ') ? '   ' : '';
    const fence = ['```suggestion:-0+0', '@Override', '@Component({ selector: "app" })', '```']
      .map((line) => indent + line)
      .join('\n');
    const body = `${lead}${fence.slice(indent.length)}`;
    expect(gitlabNoteBody(body)).toBe(body);
  });

  it('still wraps a fence inside an open <pre> block, which is HTML and not a fence', () => {
    expect(gitlabNoteBody('<pre>\n\n```\n@x\n```\n</pre>\n@all')).toBe(
      '<pre>\n\n```\n<code>@&#8203;x</code>\n```\n</pre>\n<code>@&#8203;all</code>',
    );
  });

  it('leaves a link destination alone, which is no text', () => {
    const body = 'See [the types](https://www.npmjs.com/package/@types/node), @all.';
    expect(gitlabNoteBody(body)).toBe(
      'See [the types](https://www.npmjs.com/package/@types/node), <code>@&#8203;all.</code>',
    );
  });

  it('trusts no code at all once a note opens an element a browser reads as text', () => {
    expect(gitlabNoteBody('x <textarea> y\n\n`@all`')).toBe(
      'x <textarea> y\n\n`<code>@&#8203;all</code>`',
    );
  });

  it('changes nothing in a note with no mention-shaped text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (text) => {
        fc.pre(!text.includes('@') && !text.includes('&'));
        expect(gitlabNoteBody(text)).toBe(text);
      }),
    );
  });
});

describe('the readings a backtick form or a wider code reading loses (marked 16.4.2)', () => {
  it.each([
    ['a stray backtick before the mention', 'a ` b @all c'],
    ['an HTML block, where a backtick is not Markdown', '<div>\n@all\n</div>'],
    ['a fence inside a list item, which ends with the item', '1. x\n   ```\n   @x\n   ```\n@all'],
    ['a fence after an indented one', '  ```\n@Dec\n```\n@all'],
    ['a table row, whose cells split a span', '| h | i |\n| - | - |\n| `a | @all ` |'],
    ['a link destination, which takes the backtick', '[a](`x) @all `'],
    ['an inline textarea, after which a tag is text', 'x <textarea> @all'],
  ])('%s', (_name, input) => {
    expect(bareMentions(input).length, 'the input itself mentions somebody').toBeGreaterThan(0);
    expect(bareMentions(gitlabNoteBody(input))).toEqual([]);
  });
});

/**
 * Review round 2's fail-open inputs (each live under CommonMark 0.31.2 or marked before the fix),
 * and the two inputs that pin round 1's `tagInContainer` and four-space terms. Every mention in
 * them must come out wrapped — the fail-closed answer the orchestrator ruled for this round.
 */
describe('inputs whose structure the reading does not follow: every mention wrapped', () => {
  it.each([
    ['a fence on a list-marker line', '- ```\n  x\n  ```\n  @all'],
    ['an ordered item whose fence closes at once', '1. ```\n   ```\n   hi @all'],
    ['a suggestion fence on a list-marker line', '- ```suggestion\n  @Component\n  ```'],
    ['a lone carriage return as a line ending', '```\nx\r```\r@all\n```'],
    [
      'a no-break space, which is not a blank line, in an HTML block',
      '<div>\n\u00a0\n`@all`\n</div>',
    ],
    ['a no-break space before a link in an HTML block', '<div>\n\u00a0\n[x](h/@all)\n</div>'],
    ['a no-break space inside a paragraph with a stray backtick', 'a ` b\n\u00a0\n`@all` c'],
    ['a fence after a tag behind a list marker', '- <span>\n  ```\n  @all\n  ```'],
    ['four spaces after a paragraph line, which continue it', 'para\n    ```\n    @all\n    ```'],
  ])('%s', (_name, input) => {
    const posted = gitlabNoteBody(input);
    expect(posted.match(/(?<!<code>)@(?:all|Component)/g)).toBeNull();
    expect(bareMentions(posted)).toEqual([]);
  });
});

/** Review round 3: HTML5 decodes a numeric reference without its `;`, and an HTML block keeps it. */
describe('an `@` spelled as a reference without its semicolon', () => {
  it.each([
    '<div>\n&#64all\n</div>',
    '<details>\n<summary>s</summary>\n&#64all\n</details>',
    '<custom-el>\n&#64all\n</custom-el>',
    '<div>&#0064all</div>',
    '<div>&#64&#97;ll</div>',
    '<div>\n&#x40zed\n</div>',
    '<div>&#x40_team</div>',
    '<p>&#64all and &#x40;all</p>',
    '<div>@&#97ll</div>',
    '<div>&#x40@&#97;ll</div>',
  ])('%j is wrapped', (input) => {
    expect(bareMentions(input).length, 'the input itself mentions somebody').toBeGreaterThan(0);
    expect(bareMentions(gitlabNoteBody(input))).toEqual([]);
  });
});

describe('the platform text around the model text', () => {
  it('keeps the marker and wraps a needs_person name and the reply', () => {
    const marker = '<!-- agentic:reply:00000000-0000-4000-8000-0000000000d1 -->';
    const body = renderConversationReply({
      marker,
      kind: 'needs_person',
      reply: 'Ping @all, and see `@all` for the literal.',
      person: '@someone',
    });
    const posted = gitlabNoteBody(body);
    expect(posted.split('\n')[0]).toBe(marker);
    expect(posted).toContain('**<code>@&#8203;someone</code> must act on this.**');
    expect(posted).toContain('`@all` for the literal.');
    expect(bareMentions(posted)).toEqual([]);
  });

  it('wraps a finding’s explanation and suggestion', () => {
    const body = renderFindingWith('<!-- agentic:review-only:t1 -->', {
      id: 'f1',
      severity: 'major',
      category: 'security',
      explanation: 'Tell @all.',
      suggestion: 'Ask @group/sub.',
    });
    expect(bareMentions(body).length).toBeGreaterThan(0);
    expect(bareMentions(gitlabNoteBody(body))).toEqual([]);
  });
});

describe('the property: no generated note renders a bare mention', () => {
  const TOKENS = [
    '`',
    '``',
    '```',
    '~~~',
    '\n',
    '\n\n',
    '@all',
    '@bob',
    '&#64;x',
    '@&#97;ll',
    '@\\_x',
    '\\',
    '<div>',
    '</div>',
    '<details>',
    '<textarea>',
    '<title>',
    '<a title="',
    '">',
    '<!-- m -->',
    '<pre>',
    '<code>',
    '</code>',
    '|',
    ' ',
    'x',
    'é',
    '# ',
    '- ',
    '1. ',
    '> ',
    '    ',
    '  ',
    '\t',
    '[a](',
    ')',
    '[',
    ']',
    '>>>',
    '<',
    'http://h/',
    '*',
    '_',
    '---',
    '$',
    '  ```',
    '   ~~~',
    '<Button>',
    '</pre>',
    '[x](https://h/@a)',
    '](',
    '  - ',
    '- ```',
    '\r',
    '\u00a0',
    '&#64',
    '&#x40',
    'all',
  ];
  it('holds for notes built from Markdown’s delimiters', () => {
    const note = fc
      .array(fc.constantFrom(...TOKENS), { maxLength: 40 })
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(note, (input) => {
        expect(bareMentions(gitlabNoteBody(input))).toEqual([]);
      }),
      { numRuns: 1500 },
    );
  });
});

// ── The census ───────────────────────────────────────────────────────────────

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * The client members that write a note: those whose request sends GitLab's note field, `body`
 * (`json: { body }` / `{ body, position }`), with the index of the parameter carrying it.
 */
const noteWriters = (clientSource: string): Map<string, number> => {
  const writers = new Map<string, number>();
  const members = clientSource.split(/\n(?= {4}\w+: async \()/);
  for (const member of members) {
    const head = /^ {4}(\w+): async \(([^)]*)\)/.exec(member);
    if (head === null || !/json:[^\n]*\{ body\b/.test(member)) continue;
    const params = (head[2] ?? '').split(',').map((param) => param.trim());
    writers.set(head[1] as string, params.indexOf('body'));
  }
  return writers;
};

/** The top-level arguments of the call whose `(` is at `open`. */
const argumentsAt = (source: string, open: number): string[] => {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index] as string;
    if (depth === 0 && (char === ',' || char === ')')) {
      args.push(current.trim());
      current = '';
      if (char === ')') return args.filter((arg) => arg !== '');
      continue;
    }
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth -= 1;
    current += char;
  }
  return args;
};

/**
 * Whether the identifier `name`, used at `at`, is bound by `const name = gitlabNoteBody(`: its
 * **nearest** declaration before the use must be that one, the block it is declared in must still
 * be open at the use, and no arrow function between them may take a parameter of that name.
 */
const boundToNoteBody = (source: string, name: string, at: number): boolean => {
  const prefix = source.slice(0, at);
  const declarations = [...prefix.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`, 'g'))];
  const nearest = declarations.at(-1);
  if (nearest === undefined) return false;
  const from = nearest.index ?? 0;
  if (!prefix.startsWith(`const ${name} = gitlabNoteBody(`, from)) return false;
  let depth = 0;
  for (const char of prefix.slice(from)) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth < 0) return false;
  }
  const shadowing = new RegExp(`\\(([^()]*\\b${name}\\b[^()]*)\\)\\s*(?::[^=]*)?=>`);
  return !shadowing.test(prefix.slice(from));
};

/** Every call to a note writer in `source` whose body argument bypasses `gitlabNoteBody`. */
const bypasses = (source: string, writers: Map<string, number>): string[] => {
  const found: string[] = [];
  for (const [writer, bodyIndex] of writers) {
    for (const call of source.matchAll(new RegExp(`\\.${writer}\\(`, 'g'))) {
      const open = (call.index ?? 0) + call[0].length - 1;
      const body = argumentsAt(source, open)[bodyIndex] ?? '';
      const ok =
        body.startsWith('gitlabNoteBody(') ||
        (/^\w+$/.test(body) && boundToNoteBody(source, body, call.index ?? 0));
      if (!ok) found.push(`${writer}(… ${body} …)`);
    }
  }
  return found;
};

describe('the census: no note leaves the adapter around gitlabNoteBody', () => {
  const writers = noteWriters(readFileSync(`${HERE}client.ts`, 'utf8'));
  const sources = readdirSync(HERE)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'client.ts')
    .map((name) => ({ name, source: readFileSync(`${HERE}${name}`, 'utf8') }));

  it('derives the note-writing client members from client.ts', () => {
    expect([...writers.keys()]).toEqual(
      expect.arrayContaining(['createDiscussion', 'addDiscussionNote', 'createMergeRequestNote']),
    );
    for (const index of writers.values()) expect(index).toBeGreaterThanOrEqual(0);
  });

  it('finds every writer called, and every call passing its body through the function', () => {
    const called = [...writers.keys()].filter((writer) =>
      sources.some(({ source }) => source.includes(`.${writer}(`)),
    );
    expect(called.sort()).toEqual([...writers.keys()].sort());
    expect(
      sources.flatMap(({ name, source }) => bypasses(source, writers).map((b) => `${name}: ${b}`)),
    ).toEqual([]);
  });

  it('refuses a call that passes its body straight, so the census is not vacuous', () => {
    const planted = 'await client.createMergeRequestNote(project, mrRef.iid, markdown);';
    expect(bypasses(planted, writers)).toEqual(['createMergeRequestNote(… markdown …)']);
  });

  it('reads the nearest binding of a name, not any earlier one', () => {
    const bound =
      'const body = gitlabNoteBody(markdown);\nawait client.createMergeRequestNote(p, 1, body);';
    expect(bypasses(bound, writers)).toEqual([]);
    const rebound = [
      'const body = gitlabNoteBody(markdown);',
      'const reply = async () => {',
      '  const body = markdown;',
      '  await client.createMergeRequestNote(p, 1, body);',
      '};',
    ].join('\n');
    expect(bypasses(rebound, writers)).toEqual(['createMergeRequestNote(… body …)']);
    const closed =
      '{ const body = gitlabNoteBody(m); }\nawait client.createMergeRequestNote(p, 1, body);';
    expect(bypasses(closed, writers)).toEqual(['createMergeRequestNote(… body …)']);
  });
});
