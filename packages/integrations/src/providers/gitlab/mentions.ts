/**
 * Every merge-request note body the GitLab adapter posts, made **mention-neutral** (WP-187, backlog
 * 549) — the counterpart of Slack's `escapeSlackText` (`../slack/mrkdwn.ts`), and for the same
 * reason: mention syntax is the provider's, so the pipeline's renderers stay provider-neutral and
 * the adapter owns what GitLab would turn into a notification.
 *
 * ## Why (BD-022)
 *
 * A finding, a review summary, a reply and a `needs_person` name are the model's words, and the
 * model reads the diff and the ticket. GitLab notifies every user and group a note names with
 * `@username` / `@groupname`, and `@all` notifies *"all members of that project's parent group"*
 * (`https://docs.gitlab.com/user/discussions/`, retrieved 2026-10-17). Written as they arrive, those
 * words let whoever wrote the ticket or the diff choose who gets an email.
 *
 * ## The form: the name as inline code, spelled as the `<code>` element, with a zero-width space
 *
 * Outside a code span or a fenced block, each `@name` (and `@all`, `@group/sub`, and the entity
 * spellings `&#64;`, `&#x40;`, `&commat;` that decode to `@`) is written as
 * `<code>@&#8203;name</code>`: the name shows as typed, in code, and notifies nobody. Inside a code
 * span or a fence nothing is changed.
 *
 * The ruling said *inline code*, and the backtick spelling of it was **measured unsafe**
 * (`marked` 16.4.2, a CommonMark renderer, WP-187): inside an HTML block a backtick is not Markdown,
 * so `` `@all` `` renders as text with `@all` in it; a stray backtick earlier in the text pairs with
 * the inserted one (`a ` b `@all` c` renders `@all` outside any code); and an escaped `\@all` turns
 * the inserted backtick into a literal. The `<code>` element is the same inline code, means the same
 * thing in a Markdown paragraph and in an HTML block, and pairs with nothing; `code` is on the
 * sanitisation allowlist GitLab's Markdown page points at (`html-pipeline`'s `SanitizationFilter`).
 * It is still a *tag*, and raw HTML before it can stop it being parsed as one — an unclosed tag
 * absorbs it as an attribute, and after an inline `<textarea>` or `<title>` it is text (measured
 * with happy-dom 20.14.0 for the first). The **`&#8203;`** after the `@` is what makes the form
 * independent of the parser: every context that decodes the entity yields `@`, a zero-width space
 * and the name, which no mention grammar reads as a name, and every context that does not decode it
 * yields `@&`. Both sources are cited in `test/fixtures/http/gitlab/SOURCES.md`.
 *
 * **Both facts are GitLab's source** (tag `v18.4.0-ee`, cited in `SOURCES.md`): the reference
 * filter skips every text node with a `pre`, `code`, `a` or `style` ancestor
 * (`lib/banzai/filter/references/reference_filter.rb`, *"References within <pre>, <code>, <a>, and
 * <style> elements are ignored"*), and a user reference is `(?<!\w)@` followed by a namespace that
 * starts with `[a-zA-Z0-9_\.]` (`User.reference_pattern`, `Gitlab::PathRegex`), so the zero-width
 * space alone already defeats it. What stays `[unverified]` (`docs/TODO.md` § Verification) is
 * whether GitLab's Markdown renderer places code spans and fences where CommonMark does.
 *
 * ## What counts as code, and why the reading is deliberately narrow
 *
 * Leaving a mention bare because the text was *thought* to be code is the one failure that
 * notifies people, so this module recognises code only where no Markdown reading could disagree,
 * and wraps everywhere else — inside a real code block that only costs a visible `<code>` tag:
 *
 *  - a **fence** at column 0 (a fence opened there is top-level whatever came before it, and a
 *    container's fence ends where the container does), or indented with spaces — a list item's
 *    continuation lines —
 *    while every line of it stays indented at least as far as its opener and it closes at exactly
 *    that indentation (four or more spaces only after a blank line; never in a paragraph that has
 *    a tag after a container marker). A line that breaks those terms, a GitLab `>>>` quote, or a
 *    fence-like line nothing above places makes **the rest of the note** uncertain, and every
 *    mention in it is wrapped;
 *  - an **HTML block** (a line opening with a tag, up to three spaces in) is followed to its end:
 *    the next blank line, or for CommonMark's types 1–5 (`<pre`, `<script`, `<style`,
 *    `<textarea`, `<!--`, `<?`, `<!X`, `<![CDATA[`) the line that closes it. Every mention in it is
 *    wrapped, a fence-like line or a block that could end elsewhere inside it makes the rest of
 *    the note uncertain, and after it the note is read as before — so a prose line such as
 *    `<Button> loses its label.` no longer costs the suggestion fence below it (review round 1). A
 *    long block behind a container marker is not followed: the rest is uncertain. One complete
 *    `<!-- … -->` line, which every platform note opens with, is a block of its own;
 *  - **nothing**, once the note opens an element a browser reads as text until its end tag
 *    (`<textarea>`, `<title>`, `<script>`, …): code after it may not be code;
 *  - **nothing after** a fence opened on a container-marker line (`- ```, `1. ```, `> ```, which
 *    ends with its container), and nothing at all in a note with a lone `\r` (a CommonMark line
 *    ending the `\n` split does not see) — review round 2, fail-closed by the orchestrator's
 *    ruling. A blank line is spaces and tabs only, as CommonMark has it (a no-break space is not).
 *  - a **code span** only inside one line, on a line with no `|` (a table cell boundary), with
 *    nothing `LINK_OR_TAG` names before it in its paragraph (a link, an HTML tag, a URL, a `~`),
 *    and only while every backtick string earlier in the paragraph closed on its own line — so the
 *    span is the same whichever line the paragraph really starts on.
 *
 * Those rules were driven by a property run of `mentions.test.ts`'s shape against `marked` and
 * happy-dom (WP-187; 240,000 generated notes clean after review round 1's rules, 60,000 more
 * after round 2's): every counterexample it found is a rule above.
 *
 * A plain inline link's destination (`[x](https://www.npmjs.com/package/@types/node)`) is left
 * alone in a Markdown paragraph — a URL is no text — and so is everything inside an `a` element
 * GitLab renders, which the filter skips.
 *
 * Residual, stated: what GitLab's own parser does differently from CommonMark is not read here;
 * a bare URL with `/@name` in it (no link syntax) and a link reference definition's URL are
 * wrapped, which breaks that link without notifying anybody; inside a code block this reading
 * cannot place, a name shows with a visible `<code>` around it — and for a suggestion fence that
 * is a changed suggestion, so "Apply suggestion" would commit it.
 */

/**
 * `@`, or an HTML entity that decodes to one, followed by a name — read wide on purpose: a name
 * character may also be spelled as an entity (`@&#97;ll`) or a backslash escape (`@\_all`). HTML5
 * decodes a numeric reference **without** its `;` and with leading zeros (`&#64all`, `&#x40zed`,
 * `&#0064all`), and an HTML block passes such text to the browser as it is (review round 3), so
 * both the `@` and a name character are matched with the `;` optional.
 */
const AT = '@|&#0*64(?![0-9]);?|&#[xX]0*40(?![0-9A-Fa-f]);?|&commat;?';
const NAME_ENTITY = '&#[0-9]+;?|&#[xX][0-9A-Fa-f]+;?|&[A-Za-z][A-Za-z0-9]*;';
const MENTION = new RegExp(
  `(\\\\*)(${AT})((?:[A-Za-z0-9_.\\-/]|(?!${AT})(?:${NAME_ENTITY})|\\\\[!-/:-?[-\`{-~])+)`,
  'g',
);

/**
 * A letter or digit before an unescaped `@` makes it an e-mail address. Not `_`: it is a word
 * character to GitLab's pattern, but in Markdown it may be an emphasis delimiter that leaves the
 * `@` opening a text node of its own (`_@all_`, measured with marked).
 */
const ADDRESS_BEFORE = /[A-Za-z0-9]/;

/** One complete HTML comment line — the platform marker every note opens with. */
const COMMENT_LINE = /^ {0,3}<!--.*-->/;

/** A column-0 fence opener: the run and the info string. */
const FENCE_OPEN = /^(`{3,}|~{3,})([^\n]*)$/;

/** An indented fence opener, spaces only: the indentation, the run and the info string. */
const INDENTED_FENCE_OPEN = /^( +)(`{3,}|~{3,})([^\n]*)$/;

/** Any line that could open or close a fence, inside a container or not. */
const FENCE_LIKE = /^[ \t]*(?:(?:>|[*+-]|\d{1,9}[.)])[ \t]*)*(?:```|~~~)/;

/** A fence opened behind a container marker (`- ```, `1. ```, `> ```): not followed. */
const CONTAINER_FENCE = /^[ \t]*(?:(?:>|[*+-]|\d{1,9}[.)])[ \t]*)+(?:```|~~~)/;

/** CommonMark's blank line: spaces and tabs only (no NBSP, BOM, form feed or vertical tab). */
const BLANK = /^[ \t]*\r?$/;

/** The line's container markers and indentation, then an HTML start. */
const HTML_START = /^([ \t]*(?:(?:>|[*+-]|\d{1,9}[.)])[ \t]*)*)<[A-Za-z/!?]/;

/**
 * CommonMark's HTML block types 1–5, with the line that ends each: unlike types 6 and 7 they run
 * across blank lines. Anything else that opens with a tag is ended by a blank line.
 */
const LONG_HTML_BLOCKS: readonly (readonly [RegExp, RegExp])[] = [
  [/^<(?:pre|script|style|textarea)(?:[\s>]|$)/i, /<\/(?:pre|script|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<!\[CDATA\[/, /\]\]>/],
  [/^<![A-Za-z]/, />/],
];

/**
 * An element whose content a browser reads as text until its end tag (RCDATA, RAW TEXT) — opened
 * anywhere in a note, it can turn what follows, code included, into plain text.
 */
const RAW_TEXT_ELEMENT =
  /<(?:textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext|script|style)\b/i;

/**
 * Before a code span, any of these makes its reading uncertain: a link, label or reference (`]`),
 * an HTML tag or autolink (`<`), a bare URL (an autolink to some renderers, which then never see
 * the span — marked) and a `~` (strikethrough, which marked reads before a span).
 */
const LINK_OR_TAG = /\]|<[A-Za-z/!?]|~|[A-Za-z]:\/\/|www\./i;

/** A long HTML block's opening line, where CommonMark would start one. */
const LONG_START =
  /^ {0,3}(?:<(?:pre|script|style|textarea)(?:[\s>]|$)|<!--|<\?|<!\[CDATA\[|<![A-Za-z])/i;

/** A plain inline link whose text holds no bracket, backtick or tag: its destination is no text. */
const INLINE_LINK = /(?<!\\)\[[^[\]`<\n]*\]\(([^\s()<>`]*)\)/g;

type Fence = { readonly char: string; readonly length: number; readonly indent: number };

/**
 * Wrap every mention in `text`, which the caller has decided is not code. With `links`, a mention
 * inside a plain inline link's destination is left alone: a URL is no text (the caller passes it
 * only for a Markdown paragraph, never for raw HTML).
 */
const wrapMentions = (text: string, before: string, links = false): string => {
  const destinations: [number, number][] = [];
  if (links) {
    for (const link of text.matchAll(INLINE_LINK)) {
      const end = (link.index ?? 0) + link[0].length - 1;
      destinations.push([end - (link[1] ?? '').length, end]);
    }
  }
  let wrappedEnd = -1;
  return text.replace(
    MENTION,
    (match, slashes: string, at: string, name: string, offset: number) => {
      if (destinations.some(([from, to]) => offset >= from && offset + match.length <= to)) {
        return match;
      }
      // An unescaped `@` straight after a letter or digit is an e-mail address, not a mention —
      // unless that character ends a name just wrapped, which leaves this `@` opening a text node.
      const previous = offset === 0 ? before.slice(-1) : text[offset - 1];
      // A letter or digit that ends a reference with no `;` (`&#x40@all`) is not what the
      // browser shows before the `@` (review round 3).
      const afterReference = /&#?[A-Za-z0-9]+$/.test(offset === 0 ? before : text.slice(0, offset));
      const afterWrap = offset === wrappedEnd || afterReference;
      if (slashes === '' && !afterWrap && previous !== undefined && ADDRESS_BEFORE.test(previous)) {
        return match;
      }
      wrappedEnd = offset + match.length;
      // An odd run of backslashes escapes the `@`; kept, it would escape the `<` of `<code>`.
      const kept = slashes.length % 2 === 1 ? slashes.slice(1) : slashes;
      return `${kept}<code>${at}&#8203;${name}</code>`;
    },
  );
};

/**
 * The code spans of one line, read the way CommonMark reads them from the line's start: a run of
 * `n` backticks opens a span closed by the next run of exactly `n`; a backslash before a backtick
 * makes that one backtick literal outside a span. Answers the spans and whether a run was left
 * open (which a later line of the same paragraph could close).
 */
const lineSpans = (
  line: string,
): { readonly spans: readonly (readonly [number, number])[]; readonly unclosed: boolean } => {
  const spans: [number, number][] = [];
  let unclosed = false;
  let index = 0;
  while (index < line.length) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line[index] !== '`') {
      index += 1;
      continue;
    }
    let end = index;
    while (line[end] === '`') end += 1;
    const length = end - index;
    const closer = new RegExp(`(?<!\`)\`{${String(length)}}(?!\`)`, 'g');
    closer.lastIndex = end;
    const found = closer.exec(line);
    if (found === null) {
      unclosed = true;
      index = end;
      continue;
    }
    spans.push([index, found.index + length]);
    index = found.index + length;
  }
  return { spans, unclosed };
};

/** One prose line, its trusted code spans kept byte-identical and every other mention wrapped. */
const neutraliseProseLine = (
  line: string,
  paragraphClean: boolean,
  before: string,
  links: boolean,
): string => {
  if (!paragraphClean || line.includes('|')) {
    return wrapMentions(line, before, links);
  }
  let out = '';
  let cursor = 0;
  for (const [start, end] of lineSpans(line).spans) {
    if (LINK_OR_TAG.test(line.slice(0, start))) break;
    out += wrapMentions(line.slice(cursor, start), before + out, links) + line.slice(start, end);
    cursor = end;
  }
  return out + wrapMentions(line.slice(cursor), before + out, links);
};

const isFenceClose = (line: string, fence: Fence): boolean => {
  const match = /^ {0,3}(`+|~+)[ \t]*\r?$/.exec(line);
  const run = match?.[1];
  return run !== undefined && run[0] === fence.char && run.length >= fence.length;
};

/** The spaces before a line's first other character, or `null` when a tab is among them. */
const indentOf = (line: string): number | null => {
  const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
  return lead.includes('\t') ? null : lead.length;
};

/**
 * One line of a fence opened with indentation (inside a list item, mostly): `'close'`, `'code'`,
 * or `'lost'` when the line could end the fence on some reading and not on another — a line
 * indented less than the opener (it may close the item that holds the fence), or a closing run at
 * another indentation.
 */
const indentedFenceLine = (line: string, fence: Fence): 'close' | 'code' | 'lost' => {
  if (BLANK.test(line)) return 'code';
  const indent = indentOf(line);
  if (indent === null || indent < fence.indent) return 'lost';
  const run = /^ *(`+|~+)[ \t]*\r?$/.exec(line)?.[1];
  if (run === undefined || run[0] !== fence.char || run.length < fence.length) return 'code';
  return indent === fence.indent ? 'close' : 'lost';
};

/** Which line ends the HTML block `line` opens: a pattern, or `null` for a blank line. */
const htmlBlockEnd = (line: string): RegExp | null =>
  LONG_HTML_BLOCKS.find(([opens]) => opens.test(line.trimStart()))?.[1] ?? null;

/**
 * The note body the adapter posts for `markdown`: identical except that no mention outside code
 * can notify anybody. Every member that writes a note passes its body through here
 * (`mentions.test.ts` holds that as a census over the adapter's sources).
 */
export const gitlabNoteBody = (markdown: string): string => {
  const out: string[] = [];
  let fence: Fence | null = null;
  // An open HTML block, and the line that ends it (`null`: the next blank line).
  let html: { readonly end: RegExp | null } | null = null;
  // Once the block structure cannot be followed, every later mention is wrapped.
  // A lone `\r` is a line ending to CommonMark and not to the `\n` split below: not followed.
  let uncertain = RAW_TEXT_ELEMENT.test(markdown) || /\r(?!\n)/.test(markdown);
  // Whether every backtick string so far in this paragraph closed on its own line and nothing
  // `LINK_OR_TAG` names came before — the condition under which a line's spans are the paragraph's.
  let clean = true;
  // Whether this paragraph has a line that opens with a tag after a container marker.
  let tagInContainer = false;
  let previousBlank = true;
  for (const line of markdown.split('\n')) {
    const before = out.length === 0 ? '' : '\n';
    const blank = BLANK.test(line);
    const wasBlank = previousBlank;
    previousBlank = blank;
    if (uncertain) {
      out.push(wrapMentions(line, before));
      continue;
    }
    if (fence !== null) {
      const verdict =
        fence.indent === 0
          ? isFenceClose(line, fence)
            ? 'close'
            : 'code'
          : indentedFenceLine(line, fence);
      if (verdict === 'lost') {
        uncertain = true;
        out.push(wrapMentions(line, before));
        continue;
      }
      if (verdict === 'close') {
        fence = null;
        clean = true;
      }
      out.push(line);
      continue;
    }
    if (html !== null) {
      out.push(wrapMentions(line, before));
      if (html.end === null ? blank : html.end.test(line)) {
        html = null;
        clean = true;
      } else if (
        FENCE_LIKE.test(line) ||
        (html.end === null ? LONG_START : HTML_START).test(line)
      ) {
        // A fence, or a block that could end somewhere else than this one: stop following.
        uncertain = true;
      }
      continue;
    }
    if (CONTAINER_FENCE.test(line)) {
      // A list item's or a quote's fence ends with its container, which this reading does not
      // follow: its close could be read as an opener (review round 2).
      uncertain = true;
      out.push(wrapMentions(line, before));
      continue;
    }
    if (blank) {
      clean = true;
      tagInContainer = false;
      out.push(line);
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    const run = open?.[1];
    if (run !== undefined && (run[0] === '~' || !(open?.[2] ?? '').includes('`'))) {
      fence = { char: run[0] as string, length: run.length, indent: 0 };
      clean = true;
      // The info string is no code; a renderer that does not take the line for a fence (marked
      // at the end of the text) shows it as prose.
      out.push(run + wrapMentions(open?.[2] ?? '', run));
      continue;
    }
    const indented = INDENTED_FENCE_OPEN.exec(line);
    const indentedRun = indented?.[2];
    if (indented !== null && indentedRun !== undefined && !tagInContainer) {
      const indent = (indented[1] ?? '').length;
      const info = indented[3] ?? '';
      const opens = indentedRun[0] === '~' || !info.includes('`');
      // Four spaces after a paragraph line continue the paragraph; after a blank line they are
      // an indented code block, and its lines are code either way.
      if (opens && (indent < 4 || wasBlank)) {
        fence = { char: indentedRun[0] as string, length: indentedRun.length, indent };
        clean = true;
        out.push((indented[1] ?? '') + indentedRun + wrapMentions(info, indentedRun));
        continue;
      }
    }
    if (COMMENT_LINE.test(line)) {
      clean = true;
      out.push(wrapMentions(line, before));
      continue;
    }
    if (FENCE_LIKE.test(line) && /^[ \t]/.test(line)) {
      // An indented fence this reading could not place.
      uncertain = true;
      out.push(wrapMentions(line, before));
      continue;
    }
    if (/^>>>/.test(line)) {
      // GitLab's multi-line quote, read before Markdown.
      uncertain = true;
      out.push(wrapMentions(line, before));
      continue;
    }
    const tag = HTML_START.exec(line);
    if (tag !== null) {
      const prefix = tag[1] ?? '';
      if (/^ {0,3}$/.test(prefix)) {
        // An HTML block (or, for a tag that cannot start one here, a paragraph that ends where it
        // would): followed to its end, every mention in it wrapped.
        const end = htmlBlockEnd(line);
        out.push(wrapMentions(line, before));
        const endsHere = end?.test(line.slice(line.indexOf('<') + 1)) === true;
        if (!endsHere) html = { end };
        clean = true;
        continue;
      }
      if (htmlBlockEnd(line.slice(prefix.length)) !== null) {
        // A long HTML block inside a container or an indented code block: not followed.
        uncertain = true;
        out.push(wrapMentions(line, before));
        continue;
      }
      tagInContainer = true;
      out.push(wrapMentions(line, before));
      clean = false;
      continue;
    }
    // A link's destination is left alone only in a paragraph no tag could have made raw HTML.
    const links = !tagInContainer && !/<[A-Za-z/!?]/.test(line);
    out.push(neutraliseProseLine(line, clean, before, links));
    clean = clean && !line.includes('|') && !LINK_OR_TAG.test(line) && !lineSpans(line).unclosed;
  }
  return out.join('\n');
};
