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
import {
  noSecretsRedactor,
  renderConversationReply,
  renderFindingWith,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import fc from 'fast-check';
import { Window } from 'happy-dom';
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { gitlabConfigSchema } from './config.js';
import type { GitLabFetch } from './http.js';
import { gitlabMergeRequestTitle, gitlabNoteBody } from './mentions.js';
import { createGitLabProvider } from './provider.js';

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

/**
 * Backlog 609 (WP-209 review round 1): a name absorbed a backslash-escaped `&`, so the `&#64;` it
 * opened was never matched. Markdown reads `\&` as a literal `&`; an HTML block shows `\@all`.
 */
describe('a name that would swallow the `&` opening the next `@`', () => {
  const COUNTEREXAMPLE = '<details>&#x40x  ```suggestion&#64;x\\&#64;x&#64;x`1. ';
  it.each([
    ['WP-209’s counterexample', COUNTEREXAMPLE],
    ['@all after an escaped & in an HTML block', '<details>\na&#64;b\\&#64;all\n</details>'],
    ['the hexadecimal spelling', '<div>\na&#x40;b\\&#x40;all\n</div>'],
    ['the named spelling', '<div>\na&commat;b\\&commat;all\n</div>'],
  ])('%s: a note renders no mention', (_name, input) => {
    expect(bareMentions(input).length, 'the input itself mentions somebody').toBeGreaterThan(0);
    expect(bareMentions(gitlabNoteBody(input))).toEqual([]);
  });

  it('a description through the real adapter renders no @all', async () => {
    const description = '<details>\na&#64;b\\&#64;all\n</details>';
    const { port, sent } = mergeRequestAdapter();
    await port.updateMergeRequest(MR_REF, {
      title: null,
      description,
      draft: null,
      labels: null,
      reviewers: null,
    });
    expect(bareMentions(description)).toEqual(['\na@b\\@all\n']);
    expect(bareMentions(String(sent[0]?.description))).toEqual([]);
  });

  it.each([
    ['an escaped & outside an HTML block', 'a\\&b'],
    ['an e-mail address', 'name@example.com'],
    ['an e-mail address with an escaped & after it', 'Mail name@example.com\\& co.'],
  ])('leaves %s byte-identical', (_name, input) => {
    expect(gitlabNoteBody(input)).toBe(input);
  });

  /**
   * The property behind the cases: an HTML-block opener (or none) and up to 12 parts. 50,000 ran
   * clean after the fix (WP-209 notes). Against the old grammar it found the class about once in
   * 2,500 notes, so the pinned cases above are the canary and this is the net.
   */
  it('holds as a property with the escapes and every @ spelling beside a letter', () => {
    const parts = [
      ...['n', 'x', 'all', '\\&', '\\', '\\\\', '&#64;', '&#64', '&#x40;', '&#x40'],
      ...['&commat;', '&commat', '@', ' ', '&', '#64;', '_', '.', '&amp;', '&#97;'],
    ];
    const note = fc
      .tuple(
        fc.constantFrom('<details>\n', '<div>', ''),
        fc.array(fc.constantFrom(...parts), { maxLength: 12 }),
      )
      .map(([opener, rest]) => opener + rest.join(''));
    fc.assert(
      fc.property(note, (input) => {
        expect(bareMentions(gitlabNoteBody(input))).toEqual([]);
      }),
      { numRuns: 500 },
    );
  });
});

/**
 * Backlog 611 (WP-209 round 2b): GitLab's extractor deletes `\r` and runs `^\/<command>` on the
 * source lines of top-level paragraphs (`lib/gitlab/quick_actions/extractor.rb`), so a command
 * runs only from column 0. One leading space moves it off and renders the same in a paragraph.
 */
/**
 * WP-209 review round 3: comrak opens GitLab's `>>>` quote behind up to three spaces
 * (`detect_multiline_blockquote`), and its closing `>>>` closes a fence left open inside it — so
 * after `  >>>`, nothing is placed. Measured by the reviewer with comrak 0.40.0.
 */
describe('a multi-line quote opened behind spaces', () => {
  it.each([
    ['one space', ' >>>'],
    ['three spaces', '   >>>'],
  ])('makes the rest uncertain behind %s, so a mention after its fence is wrapped', (_n, open) => {
    expect(gitlabNoteBody(`${open}\n\`\`\`\n>>>\n@all\n\`\`\``)).toBe(
      `${open}\n\`\`\`\n>>>\n<code>@&#8203;all</code>\n\`\`\``,
    );
  });

  it('still places a fence after four spaces of `>>>`, which is an indented code line', () => {
    expect(gitlabNoteBody('    >>>\n\n```\n@all\n```')).toBe('    >>>\n\n```\n@all\n```');
  });
});

describe('a line GitLab could run as a quick action', () => {
  it.each([
    ['a command line', '/close', ' /close'],
    ['commands after prose', 'Fixed.\n/label ~x\n/close', 'Fixed.\n /label ~x\n /close'],
    ['a command after a deleted carriage return', '\r/approve', ' \r/approve'],
    ['any line opening with a slash', '/usr/bin/env', ' /usr/bin/env'],
    ['a command in an HTML block', '<div>\n/close\n</div>', '<div>\n /close\n</div>'],
    ['a command after a fence the reading lost', '- ```\n/close', '- ```\n /close'],
    [
      'a command after a fence an indented multi-line quote closed (review round 3)',
      '  >>>\n```\n>>>\n/close\n/approve x\n```',
      '  >>>\n```\n>>>\n /close\n /approve x\n```',
    ],
  ])('moves %s off column 0', (_name, input, expected) => {
    expect(gitlabNoteBody(input)).toBe(expected);
    expect(gitlabNoteBody(expected), 'idempotent').toBe(expected);
  });

  it.each([
    ['a fence it placed', '```\n/close\n```'],
    ['an unclosed fence it placed', '```\n/close'],
    ['a code span', '`/close`'],
    ['a mid-line slash', 'a /close'],
    ['an indented line', '  /close'],
  ])('leaves %s byte-identical', (_name, input) => {
    expect(gitlabNoteBody(input)).toBe(input);
  });

  /**
   * CommonMark strips a paragraph line's leading spaces; marked keeps one in the HTML, which a
   * browser collapses with the line break before it, or drops at a block's start — so the shown
   * text is compared.
   */
  it('shows the moved line as the same paragraph text (marked + happy-dom)', () => {
    const shown = (markdown: string): string => {
      const host = window.document.createElement('div');
      host.innerHTML = marked.parse(markdown, { async: false });
      return Array.from(host.querySelectorAll('p'))
        .map((paragraph) => (paragraph.textContent ?? '').replace(/\s+/g, ' ').trim())
        .join('|');
    };
    const input = 'Fixed.\n/close\n\n/label ~x';
    expect(shown(gitlabNoteBody(input))).toBe(shown(input));
    expect(shown(input)).toBe('Fixed. /close|/label ~x');
  });

  /** 100,000 notes ran clean before this was committed (WP-209 notes, round 2b). */
  it('holds as a property: no output line opens with a slash outside a fence', () => {
    /** The lines no column-0 CommonMark fence holds, once `\r` is deleted as GitLab does. */
    const outsideFences = (text: string): string[] => {
      const kept: string[] = [];
      let fence: string | null = null;
      for (const line of text.replaceAll('\r', '').split('\n')) {
        const run = /^(`{3,}|~{3,})(.*)$/.exec(line);
        const marker = run?.[1] ?? '';
        const info = run?.[2] ?? '';
        if (fence === null) {
          if (run !== null && !(marker.startsWith('`') && info.includes('`'))) {
            fence = marker;
            continue;
          }
          kept.push(line);
        } else if (
          run !== null &&
          marker[0] === fence[0] &&
          marker.length >= fence.length &&
          /^[ \t]*$/.test(info)
        ) {
          fence = null;
        }
      }
      return kept;
    };
    const parts = ['/close', '/label ~x', '\n', '\r', '\r\n', ' ', '```', '~~~', 'x', '`'];
    const more = ['- ', '> ', '<div>', '\n\n', '    ', '@all'];
    const note = fc
      .array(fc.constantFrom(...parts, ...more), { maxLength: 30 })
      .map((rest) => rest.join(''));
    fc.assert(
      fc.property(note, (input) => {
        expect(outsideFences(gitlabNoteBody(input)).filter((line) => line.startsWith('/'))).toEqual(
          [],
        );
      }),
      { numRuns: 500 },
    );
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

const PROPERTY_TOKENS = [
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

describe('the property: no generated note renders a bare mention', () => {
  it('holds for notes built from Markdown’s delimiters', () => {
    const note = fc
      .array(fc.constantFrom(...PROPERTY_TOKENS), { maxLength: 40 })
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(note, (input) => {
        expect(bareMentions(gitlabNoteBody(input))).toEqual([]);
      }),
      { numRuns: 1500 },
    );
  });
});

// ── The merge request's title and description (WP-209 (a), backlog 573) ──────────

/** The real adapter over a fetch that records each body it sent and answers one merge request. */
const mergeRequestAdapter = () => {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl: GitLabFetch = async (_url, init) => {
    const body = init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
    sent.push(body);
    const answer = {
      id: 155016007,
      iid: 7,
      project_id: 1,
      title: body.title ?? 'x',
      description: body.description ?? '',
      state: 'opened',
      draft: false,
      source_branch: 'agentic/task-1',
      target_branch: 'main',
      sha: '1111111111111111111111111111111111111111',
      merge_status: 'can_be_merged',
      detailed_merge_status: 'mergeable',
      has_conflicts: false,
      labels: [],
      author: { id: 4242, username: 'agentic-bot', name: 'Agentic Bot' },
      reviewers: [],
      merged_at: null,
      web_url: 'https://gitlab.example.test/acme/api/-/merge_requests/7',
    };
    return new Response(JSON.stringify(answer), {
      status: init.method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const port = createGitLabProvider({
    integrationId: '00000000-0000-4000-8000-0000000000a9',
    config: gitlabConfigSchema.parse({
      base_url: 'https://gitlab.example.test',
      project: 'acme/api',
      request_timeout_ms: 0,
    }),
    secrets: { token: 'FAKE-binding-api-token-DO-NOT-USE' },
    fetchImpl,
    clock: fixedClock('2026-06-01T08:00:00.000Z'),
    redactor: noSecretsRedactor(),
  });
  return { port, sent };
};

const MR_REF = {
  provider: 'gitlab',
  project_path: 'acme/api',
  iid: 7,
  url: 'https://gitlab.example.test/acme/api/-/merge_requests/7',
  branch: null,
  head_sha: null,
};

describe('the merge request’s title and description, through the real adapter (WP-209 (a))', () => {
  const TITLE = 'Fix the totals for @all, ask @someone';
  const DESCRIPTION = 'Ping @all.\n\nAsk @someone about `@Injectable()`.';
  const draft = (title: string, description: string) => ({
    project: 'acme/api',
    branch: 'agentic/task-1',
    target: 'main',
    title,
    description,
    draft: true,
    labels: [],
    reviewers: [],
    remove_source_branch: true,
  });

  it('starts from text that mentions somebody, so the cases below are not vacuous', () => {
    expect(bareMentions(TITLE).length).toBeGreaterThan(0);
    expect(bareMentions(DESCRIPTION).length).toBeGreaterThan(0);
  });

  it('open_mr: neither the title nor the description mentions anybody', async () => {
    const { port, sent } = mergeRequestAdapter();
    await port.openMergeRequest(draft(TITLE, DESCRIPTION));
    const body = sent[0] ?? {};
    expect(bareMentions(String(body.title)), 'the title').toEqual([]);
    expect(bareMentions(String(body.description)), 'the description').toEqual([]);
    expect(body.title).toBe('Draft: Fix the totals for @\u200ball, ask @\u200bsomeone');
    expect(body.description).toBe(
      'Ping <code>@&#8203;all.</code>\n\nAsk <code>@&#8203;someone</code> about `@Injectable()`.',
    );
  });

  it('update_mr_description: neither the title nor the description mentions anybody', async () => {
    const { port, sent } = mergeRequestAdapter();
    await port.updateMergeRequest(MR_REF, {
      title: TITLE,
      description: DESCRIPTION,
      draft: null,
      labels: null,
      reviewers: null,
    });
    const body = sent[0] ?? {};
    expect(bareMentions(String(body.title)), 'the title').toEqual([]);
    expect(bareMentions(String(body.description)), 'the description').toEqual([]);
    expect(body.title).toBe(gitlabMergeRequestTitle(TITLE));
    expect(body.description).toBe(gitlabNoteBody(DESCRIPTION));
  });

  /**
   * Measured before the fix (WP-209 (a)): a second pass wrapped the form again,
   * `<code><code>@&#8203;&#8203;all</code></code>`. The Developer may send back what it was shown.
   */
  it('neutralises a description sent back through update_mr_description once', async () => {
    const { port, sent } = mergeRequestAdapter();
    await port.openMergeRequest(draft(TITLE, DESCRIPTION));
    const posted = String(sent[0]?.description);
    const shownTitle = String(sent[0]?.title).replace(/^Draft: /, '');
    await port.updateMergeRequest(MR_REF, {
      title: shownTitle,
      description: posted,
      draft: null,
      labels: null,
      reviewers: null,
    });
    expect(sent[1]?.description, 'the description is sent as it was posted').toBe(posted);
    expect(sent[1]?.title, 'and so is the title').toBe(shownTitle);
  });
});

describe('a second pass over the function’s own output (WP-209 (a))', () => {
  it.each([
    '@all',
    'Ping @all and @someone.',
    '&#64;all and @&#97;ll',
    'See `@Injectable()` and @all.',
    'Line one @x\n\nSecond `@code` here\n\n```suggestion\n@Component\n```',
    '## Summary\n\nFixes the parser. cc @all\n\n---\nRequested by @dana.',
  ])('leaves %j as the first pass wrote it', (input) => {
    const once = gitlabNoteBody(input);
    expect(gitlabNoteBody(once)).toBe(once);
  });

  it('reads its own form as text, so a code span after it stays code on the second pass', () => {
    const once = gitlabNoteBody('@all and `@x`');
    expect(once).toBe('<code>@&#8203;all</code> and `@x`');
    expect(gitlabNoteBody(once)).toBe(once);
    // Any other tag before the span still makes it uncertain.
    expect(gitlabNoteBody('<b>@&#8203;all</b> and `@x`')).toContain('`<code>@&#8203;x</code>`');
  });

  it('never nests its own form, and never leaves a mention, on a second pass', () => {
    const note = fc
      .array(fc.constantFrom(...PROPERTY_TOKENS), { maxLength: 40 })
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(note, (input) => {
        const twice = gitlabNoteBody(gitlabNoteBody(input));
        expect(twice).not.toContain('&#8203;&#8203;');
        expect(bareMentions(twice)).toEqual([]);
      }),
      { numRuns: 500 },
    );
  });
});

describe('the title form (WP-209 (a))', () => {
  it.each([
    ['@all', '@\u200ball'],
    ['&#64;all', '&#64;\u200ball'],
    ['&#64all', '&#64\u200ball'],
    ['&commat;all', '&commat;\u200ball'],
    ['\\@all', '\\@\u200ball'],
    ['mail dana@example.test', 'mail dana@\u200bexample.test'],
    ['@\u200ball', '@\u200ball'],
    ['&#64;\u200ball', '&#64;\u200ball'],
    ['fix the totals', 'fix the totals'],
  ])('writes %j as %j', (input, expected) => {
    expect(gitlabMergeRequestTitle(input)).toBe(expected);
    expect(bareMentions(gitlabMergeRequestTitle(input))).toEqual([]);
    expect(gitlabMergeRequestTitle(expected), 'idempotent').toBe(expected);
  });

  it('stays within GitLab’s 255 characters when the inserted ones push a bounded title past', () => {
    const bounded = `${'x'.repeat(249)} @a @b`;
    expect(bounded).toHaveLength(255);
    const sent = gitlabMergeRequestTitle(bounded);
    expect([...sent]).toHaveLength(255);
    expect(sent.endsWith('…')).toBe(true);
    expect(bareMentions(sent)).toEqual([]);
    const plain = 'y'.repeat(255);
    expect(gitlabMergeRequestTitle(plain)).toBe(plain);
  });
});

// ── A suggestion this reading changed (WP-209 (b), backlog 574) ─────────────────

describe('a suggestion fence the wrap rewrote can never be applied (WP-209 (b))', () => {
  it.each([
    [
      'on a list-marker line',
      '- ```suggestion:-0+0\n  @Component\n  ```',
      '- ```\n  <code>@&#8203;Component</code>\n  ```',
    ],
    [
      'in a blockquote',
      '> ```suggestion\n> @Component\n> ```',
      '> ```\n> <code>@&#8203;Component</code>\n> ```',
    ],
    [
      'after an element a browser reads as text',
      '<textarea>x</textarea>\n\n```suggestion\n@Override\n```',
      '<textarea>x</textarea>\n\n```\n<code>@&#8203;Override</code>\n```',
    ],
    [
      'after a lone carriage return, a line ending the reading does not split on',
      '```suggestion\r@Component\r```',
      '```\r<code>@&#8203;Component</code>\r```',
    ],
    [
      'in an indented fence the reading lost',
      '1. Change it:\n\n   ```suggestion\n   @Component\n  ```\n   @Other\n   ```',
      '1. Change it:\n\n   ```\n   @Component\n  ```\n   <code>@&#8203;Other</code>\n   ```',
    ],
  ])('loses its info string %s', (_name, input, expected) => {
    expect(gitlabNoteBody(input)).toBe(expected);
    expect(bareMentions(gitlabNoteBody(input))).toEqual([]);
  });

  it('keeps the info string where the reading is lost but nothing after it changed', () => {
    const body = '- ```suggestion\n  const total = 1;\n  ```';
    expect(gitlabNoteBody(body)).toBe(body);
  });

  /**
   * The property behind the cases: every suggestion `marked` renders from the posted note is one
   * it renders from the input. 80,000 notes of up to 40 tokens and 30,000 of up to 80 ran clean
   * before this was committed (WP-209 notes); a lone `\r` and an info string that only starts with
   * `suggestion` were the two counterexamples it found.
   */
  it('renders no suggestion the input did not have', () => {
    const suggestionsIn = (markdown: string): string[] => {
      const host = window.document.createElement('div');
      host.innerHTML = marked.parse(markdown, { async: false });
      return Array.from(host.querySelectorAll('code'))
        .filter((code) => /language-suggestion/.test(code.getAttribute('class') ?? ''))
        .map((code) => code.textContent ?? '');
    };
    const tokens = [
      ...PROPERTY_TOKENS,
      '```suggestion',
      '```suggestion:-0+0',
      '- ```suggestion',
      '> ```suggestion',
      '  ```suggestion',
      '@Component',
    ];
    const note = fc
      .array(fc.constantFrom(...tokens), { maxLength: 40 })
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(note, (input) => {
        const before = new Set(suggestionsIn(input));
        for (const text of suggestionsIn(gitlabNoteBody(input))) {
          expect(before.has(text), `a changed suggestion: ${JSON.stringify(text)}`).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('keeps a fence it placed and closed, whatever is wrapped after it', () => {
    expect(gitlabNoteBody('```suggestion\n@Component\n```\n\ncc @all')).toBe(
      '```suggestion\n@Component\n```\n\ncc <code>@&#8203;all</code>',
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
 * Whether the identifier `name`, used at `at`, is bound by `const name = gitlabNoteBody(` (or by
 * `fn`): its **nearest** declaration before the use must be that one, the block it is declared in
 * must still be open at the use, and no arrow function between them may take a parameter of that
 * name.
 */
const boundToNoteBody = (
  source: string,
  name: string,
  at: number,
  fn = 'gitlabNoteBody',
): boolean => {
  const prefix = source.slice(0, at);
  const declarations = [...prefix.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`, 'g'))];
  const nearest = declarations.at(-1);
  if (nearest === undefined) return false;
  const from = nearest.index ?? 0;
  if (!prefix.startsWith(`const ${name} = ${fn}(`, from)) return false;
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

type TextField = 'title' | 'description';

/** Which function each merge-request field's text must come from (WP-209 (a)). */
const FIELD_FUNCTION: Readonly<Record<TextField, string>> = {
  title: 'gitlabMergeRequestTitle',
  description: 'gitlabNoteBody',
};

interface TextWriter {
  readonly member: string;
  readonly field: TextField;
  /** The parameter that carries the text — the field's own value, or the whole request body. */
  readonly index: number;
  readonly whole: boolean;
}

/**
 * The client members that send a merge request's `title` or `description` (WP-209 (a), backlog
 * 573), derived from client.ts like the note writers: a `json:` object literal naming the field
 * (the parameter it names carries it), or `json: <parameter>` whose declared type in client.ts —
 * a named interface or an inline object — has the field (the whole body carries it).
 */
const textWriters = (clientSource: string): TextWriter[] => {
  const writers: TextWriter[] = [];
  for (const member of clientSource.split(/\n(?= {4}\w+: async \()/)) {
    const head = /^ {4}(\w+): async \(([^)]*)\)/.exec(member);
    if (head === null) continue;
    const name = head[1] as string;
    const params = (head[2] ?? '').split(',').map((param) => param.trim());
    const literal = /json:\s*\{([^}]*)\}/.exec(member)?.[1];
    for (const field of Object.keys(FIELD_FUNCTION) as TextField[]) {
      const property =
        literal === undefined
          ? null
          : new RegExp(`(?<![\\w.])${field}\\b(?:\\s*:\\s*(\\w+))?`).exec(literal);
      if (property !== null) {
        writers.push({
          member: name,
          field,
          index: params.indexOf(property[1] ?? field),
          whole: false,
        });
      }
    }
    const whole = /json:\s*(\w+)\s*,/.exec(member)?.[1];
    if (whole === undefined) continue;
    const declared =
      new RegExp(`\\n {2}${name}\\(([\\s\\S]*?)\\): Promise`).exec(clientSource)?.[1] ?? '';
    const typed = new RegExp(`\\b${whole}: (?:(\\w+)|\\{([\\s\\S]*?)\\})`).exec(declared);
    const shape =
      typed?.[2] ??
      new RegExp(`interface ${typed?.[1] ?? '\\0'} \\{([\\s\\S]*?)\\n\\}`).exec(
        clientSource,
      )?.[1] ??
      '';
    for (const field of Object.keys(FIELD_FUNCTION) as TextField[]) {
      if (new RegExp(`\\b${field}\\??:`).test(shape)) {
        writers.push({ member: name, field, index: params.indexOf(whole), whole: true });
      }
    }
  }
  return writers;
};

/** Every call to a title or description writer in `source` whose text bypasses its function. */
const textBypasses = (source: string, writers: readonly TextWriter[]): string[] => {
  const found: string[] = [];
  for (const { member, field, index, whole } of writers) {
    const fn = FIELD_FUNCTION[field];
    for (const call of source.matchAll(new RegExp(`\\.${member}\\(`, 'g'))) {
      const at = call.index ?? 0;
      const arg = argumentsAt(source, at + call[0].length - 1)[index] ?? '';
      let ok: boolean;
      if (!whole) {
        ok =
          arg.startsWith(`${fn}(`) || (/^\w+$/.test(arg) && boundToNoteBody(source, arg, at, fn));
      } else {
        // Every `field:` (or shorthand `field`) in the body literal must be `fn(…)`.
        const properties = [
          ...arg.matchAll(new RegExp(`(?<![\\w.])${field}\\b(?=\\s*[:,}])(\\s*:\\s*)?`, 'g')),
        ];
        ok =
          arg.startsWith('{') &&
          properties.every(
            (property) =>
              property[1] !== undefined &&
              arg.startsWith(`${fn}(`, (property.index ?? 0) + property[0].length),
          );
      }
      if (!ok) found.push(`${member}(… ${field} …)`);
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

describe('the census: no merge-request title or description leaves the adapter around its function (WP-209 (a))', () => {
  const client = readFileSync(`${HERE}client.ts`, 'utf8');
  const writers = textWriters(client);
  const sources = readdirSync(HERE)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'client.ts')
    .map((name) => ({ name, source: readFileSync(`${HERE}${name}`, 'utf8') }));

  it('derives the title and description writers from client.ts', () => {
    expect(writers.map((writer) => `${writer.member}.${writer.field}`).sort()).toEqual(
      expect.arrayContaining([
        'createMergeRequest.description',
        'createMergeRequest.title',
        'updateMergeRequest.description',
        'updateMergeRequest.title',
      ]),
    );
    for (const writer of writers) expect(writer.index, writer.member).toBeGreaterThanOrEqual(0);
  });

  it('finds every writer called, and every call passing its text through the function', () => {
    const members = [...new Set(writers.map((writer) => writer.member))];
    const called = members.filter((member) =>
      sources.some(({ source }) => source.includes(`.${member}(`)),
    );
    expect(called.sort()).toEqual(members.sort());
    expect(
      sources.flatMap(({ name, source }) =>
        textBypasses(source, writers).map((bypass) => `${name}: ${bypass}`),
      ),
    ).toEqual([]);
  });

  it('refuses a body whose title or description bypasses its function, so it is not vacuous', () => {
    expect(
      textBypasses(
        'await client.updateMergeRequest(project, mrRef.iid, { title, description: gitlabNoteBody(d) });',
        writers,
      ),
    ).toEqual(['updateMergeRequest(… title …)']);
    expect(
      textBypasses(
        'await client.createMergeRequest(project, { title: gitlabMergeRequestTitle(t), description: draft.description });',
        writers,
      ),
    ).toEqual(['createMergeRequest(… description …)']);
    expect(
      textBypasses('await client.createMergeRequest(project, body);', writers),
      'a body the census cannot read is a bypass',
    ).toEqual(['createMergeRequest(… title …)', 'createMergeRequest(… description …)']);
  });

  it('derives a member that sends `json: { title }` itself', () => {
    const planted = `${client}
    renameMergeRequest: async (project, iid, title) =>
      http.request({ method: 'PUT', path: mrPath(project, iid), json: { title }, action: 'x' }),
`;
    const derived = textWriters(planted).filter((writer) => writer.member === 'renameMergeRequest');
    expect(derived).toEqual([
      { member: 'renameMergeRequest', field: 'title', index: 2, whole: false },
    ]);
    expect(textBypasses('await client.renameMergeRequest(p, 1, draft.title);', derived)).toEqual([
      'renameMergeRequest(… title …)',
    ]);
    expect(
      textBypasses('await client.renameMergeRequest(p, 1, gitlabMergeRequestTitle(t));', derived),
    ).toEqual([]);
  });
});
