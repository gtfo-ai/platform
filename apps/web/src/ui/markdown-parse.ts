/**
 * Markdown, read into **data** (S-28.9, the M28 ruling; TD-013's WP-20 amendment names exactly this
 * as what would reopen its "no markdown" position: *a renderer that emits React elements from an AST
 * without ever producing HTML*).
 *
 * Model output, questions, briefs and knowledge pages are written in markdown, and rendering the
 * syntax literally made a plan a wall of `**` and backticks (the owner's feedback of 2026-11-10).
 * This module turns a string into a tree of plain objects — blocks and inline runs — and
 * `ui/markdown.tsx` turns the tree into React elements, which React escapes when it writes them. No
 * step produces markup, so the property `ui/untrusted-text.ts` states — *a string cannot become
 * markup at any point* — still holds, and `no-html.test.ts` holds it unchanged.
 *
 * ### What is understood
 * ATX headings (`#` … `######`), paragraphs (a line break inside one stays a line break), bullet
 * and numbered lists — nested, with the source's own numbers and either `1.` or `1)` — block
 * quotes, thematic breaks, fenced code (the old renderer's behaviour, unterminated included), pipe
 * tables, and inline `**strong**`, `*emphasis*`, `~~strikethrough~~`, `` `code` ``,
 * `[label](url)`, `<https://autolink>` and `![alt](url)` (never an image: the renderer shows the
 * alt text as a link under the same rule as any other).
 *
 * ### What is not, on purpose
 * - **Raw HTML is never tokenised.** `<b>` and `<script>` stay characters in a text node.
 * - **No URL is trusted here.** A destination is carried as the source wrote it, and the renderer
 *   sends it through `safeHref` in `ui/untrusted.tsx`; a refused one renders the literal source
 *   text. A link whose label differs from its destination shows the destination's host beside the
 *   label, which answers the objection `segmentInline`'s docblock records (a label can lie about
 *   where it goes).
 * - Setext headings, indented code blocks, reference links, HTML entities, footnotes and single
 *   `~` strikethrough (a single tilde is "approximately" far more often than it is a strike).
 *
 * ### Robustness
 * Malformed or unterminated syntax degrades to literal text, and **every prefix of a document
 * parses** — a transcript streams, so a half-written `**bold` is shown as written until its close
 * arrives (`markdown-parse.test.ts` holds both as properties). The parse is linear in the input: no
 * pattern here has nested or adjacent ambiguous quantifiers, bracket pairs are matched in one stack
 * pass, a delimiter that found no closer is never searched for again from a later position, and
 * nesting is capped ({@link MAX_BLOCK_DEPTH}, {@link MAX_INLINE_DEPTH}). Above
 * {@link MAX_MARKDOWN_CHARS} a document falls back to the old paragraphs-and-fences reading.
 *
 * Characters are sanitised first (`sanitiseUntrusted`: bidi overrides replaced, C0 controls
 * removed), exactly as every other untrusted renderer does.
 */
import { FENCE, safeHref, sanitiseUntrusted, segmentBlocks } from './untrusted-text.js';

/** Above this many characters a document is read as paragraphs and fences only. */
export const MAX_MARKDOWN_CHARS = 200_000;
/** Lists and quotes nested deeper than this read their content as paragraphs. */
export const MAX_BLOCK_DEPTH = 8;
/** Inline marks nested deeper than this are literal text. */
export const MAX_INLINE_DEPTH = 6;
/** A `(destination)` longer than this is not a link destination. */
const MAX_DESTINATION_CHARS = 4096;

export type Inline =
  | { readonly kind: 'text'; readonly value: string }
  | {
      readonly kind: 'strong' | 'emphasis' | 'strikethrough';
      readonly children: readonly Inline[];
    }
  | { readonly kind: 'code'; readonly value: string }
  | {
      readonly kind: 'link';
      /** As the source wrote it — never trusted here; the renderer asks `safeHref`. */
      readonly url: string;
      readonly label: readonly Inline[];
      /** The literal `[label](url)`, shown when the URL is refused. */
      readonly source: string;
    }
  | {
      readonly kind: 'image';
      readonly url: string;
      readonly alt: string;
      readonly source: string;
    };

export type Alignment = 'left' | 'center' | 'right' | null;

export interface ListItem {
  /** The source's own number for a numbered list, `null` for a bullet. */
  readonly number: number | null;
  /** `.` or `)` for a numbered list, `null` for a bullet. */
  readonly delimiter: '.' | ')' | null;
  readonly blocks: readonly Block[];
}

export type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly content: readonly Inline[] }
  | { readonly kind: 'paragraph'; readonly content: readonly Inline[] }
  | { readonly kind: 'code'; readonly language: string | null; readonly value: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly ListItem[] }
  | { readonly kind: 'quote'; readonly blocks: readonly Block[] }
  | { readonly kind: 'rule' }
  | {
      readonly kind: 'table';
      readonly align: readonly Alignment[];
      readonly header: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    };

// ── Lines ────────────────────────────────────────────────────────────────────

const isBlank = (line: string): boolean => line.trim() === '';

const leadingSpaces = (line: string): number => {
  let count = 0;
  while (count < line.length && line[count] === ' ') count += 1;
  return count;
};

/** Removes up to `count` leading spaces. */
const dedent = (line: string, count: number): string =>
  line.slice(Math.min(count, leadingSpaces(line)));

/** Leading tabs become four spaces, so indentation is one unit everywhere below. */
const expandLeadingTabs = (line: string): string => {
  let index = 0;
  let prefix = '';
  while (index < line.length && (line[index] === ' ' || line[index] === '\t')) {
    prefix += line[index] === '\t' ? '    ' : ' ';
    index += 1;
  }
  return index === 0 ? line : prefix + line.slice(index);
};

const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)/u;

const atxHeading = (line: string): { level: number; text: string } | null => {
  const match = ATX.exec(line);
  if (match === null) return null;
  let text = line.slice(match[0].length).trim();
  // An optional closing run of `#`, when a space separates it from the text (or it is all there is).
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  if (end === 0) {
    text = '';
  } else if (end < text.length && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
    text = text.slice(0, end).trimEnd();
  }
  return { level: (match[1] ?? '#').length, text };
};

const isRule = (line: string): boolean => {
  if (leadingSpaces(line) > 3) return false;
  const marks = line.replace(/[ \t]/gu, '');
  if (marks.length < 3) return false;
  const mark = marks[0];
  if (mark !== '-' && mark !== '*' && mark !== '_') return false;
  for (const character of marks) if (character !== mark) return false;
  return true;
};

const QUOTE = /^ {0,3}> ?/u;

interface Marker {
  readonly indent: number;
  readonly ordered: boolean;
  /** The bullet character, or the delimiter of a numbered item. */
  readonly symbol: string;
  readonly number: number | null;
  readonly content: string;
  /** The column the item's own content starts at; continuation lines are read relative to it. */
  readonly contentIndent: number;
}

const BULLET = /^( {0,3})([-*+])( +|$)/u;
const ORDERED = /^( {0,3})(\d{1,9})([.)])( +|$)/u;

const listMarker = (line: string): Marker | null => {
  const bullet = BULLET.exec(line);
  const ordered = bullet === null ? ORDERED.exec(line) : null;
  const match = bullet ?? ordered;
  if (match === null) return null;
  const indent = (match[1] ?? '').length;
  const spaces = (match[bullet === null ? 4 : 3] ?? '').length;
  const markerWidth = bullet === null ? (match[2] ?? '').length + 1 : 1;
  const content = line.slice(match[0].length);
  return {
    indent,
    ordered: bullet === null,
    symbol: bullet === null ? (match[3] ?? '.') : (match[2] ?? '-'),
    number: bullet === null ? Number(match[2]) : null,
    content,
    contentIndent: indent + markerWidth + (spaces >= 1 && spaces <= 4 ? spaces : 1),
  };
};

/** Splits a table row on unescaped pipes, dropping one leading and one trailing pipe. */
const splitCells = (line: string): string[] => {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\' && text[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
};

const DELIMITER_CELL = /^:?-+:?$/u;

const delimiterRow = (line: string): Alignment[] | null => {
  if (!line.includes('-')) return null;
  const cells = splitCells(line);
  const align: Alignment[] = [];
  for (const cell of cells) {
    if (!DELIMITER_CELL.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return align;
};

const tableStart = (lines: readonly string[], index: number): Alignment[] | null => {
  const header = lines[index];
  const next = lines[index + 1];
  if (header === undefined || next === undefined || !header.includes('|')) return null;
  const align = delimiterRow(next);
  if (align === null || align.length !== splitCells(header).length) return null;
  return align;
};

/** Whether `lines[index]` opens a block of its own, and so ends a paragraph above it. */
const startsBlock = (lines: readonly string[], index: number, containers: boolean): boolean => {
  const line = lines[index] ?? '';
  if (FENCE.test(line) || atxHeading(line) !== null || isRule(line)) return true;
  if (containers) {
    if (QUOTE.test(line)) return true;
    const marker = listMarker(line);
    if (marker !== null && marker.content.trim() !== '') return true;
  }
  return tableStart(lines, index) !== null;
};

// ── Blocks ───────────────────────────────────────────────────────────────────

const parseBlocks = (lines: readonly string[], depth: number): Block[] => {
  const containers = depth < MAX_BLOCK_DEPTH;
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const language = (fence[1] ?? '') === '' ? null : (fence[1] ?? null);
      const code: string[] = [];
      index += 1;
      // An unterminated fence runs to the end: a half-written stream stays a code block rather
      // than reflowing when its closing fence arrives (the old renderer's rule, kept).
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', language, value: code.join('\n') });
      continue;
    }

    const heading = atxHeading(line);
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: heading.level,
        content: parseInlineNodes(heading.text, 0, true),
      });
      index += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    if (containers && QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (QUOTE.test(current)) {
          quoted.push(current.replace(QUOTE, ''));
        } else if (
          // A lazy continuation: a paragraph line inside the quote that dropped its `>`.
          !isBlank(current) &&
          !isBlank(quoted[quoted.length - 1] ?? '') &&
          !startsBlock(lines, index, containers)
        ) {
          quoted.push(current);
        } else {
          break;
        }
        index += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(quoted, depth + 1) });
      continue;
    }

    const first = containers ? listMarker(line) : null;
    if (first !== null) {
      const items: ListItem[] = [];
      while (index < lines.length) {
        const marker = listMarker(lines[index] ?? '');
        if (
          marker === null ||
          marker.ordered !== first.ordered ||
          marker.symbol !== first.symbol ||
          marker.indent > first.indent + 1
        ) {
          break;
        }
        const itemLines = [marker.content.trimStart()];
        // A line more indented than the marker by two belongs to the item (lenient: models nest
        // under `1) ` with two spaces as often as with three).
        const threshold = Math.min(marker.contentIndent, marker.indent + 2);
        let afterBlank = false;
        index += 1;
        while (index < lines.length) {
          const current = lines[index] ?? '';
          if (isBlank(current)) {
            itemLines.push('');
            afterBlank = true;
          } else if (leadingSpaces(current) >= threshold) {
            itemLines.push(dedent(current, marker.contentIndent));
            afterBlank = false;
          } else if (!afterBlank && !startsBlock(lines, index, containers)) {
            itemLines.push(current.trimStart());
          } else {
            break;
          }
          index += 1;
        }
        while (itemLines.length > 0 && isBlank(itemLines[itemLines.length - 1] ?? '')) {
          itemLines.pop();
        }
        items.push({
          number: marker.number,
          delimiter: marker.ordered ? (marker.symbol as '.' | ')') : null,
          blocks: parseBlocks(itemLines, depth + 1),
        });
      }
      blocks.push({ kind: 'list', ordered: first.ordered, items });
      continue;
    }

    const align = tableStart(lines, index);
    if (align !== null) {
      const width = align.length;
      const fit = (cells: string[]): (readonly Inline[])[] =>
        Array.from({ length: width }, (_, column) =>
          parseInlineNodes(cells[column] ?? '', 0, true),
        );
      const header = fit(splitCells(line));
      const rows: (readonly Inline[])[][] = [];
      index += 2;
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (isBlank(current) || !current.includes('|')) break;
        rows.push(fit(splitCells(current)));
        index += 1;
      }
      blocks.push({ kind: 'table', align, header, rows });
      continue;
    }

    const paragraph = [line.trimStart()];
    index += 1;
    while (
      index < lines.length &&
      !isBlank(lines[index] ?? '') &&
      !startsBlock(lines, index, containers)
    ) {
      paragraph.push((lines[index] ?? '').trimStart());
      index += 1;
    }
    blocks.push({
      kind: 'paragraph',
      content: parseInlineNodes(paragraph.join('\n').trimEnd(), 0, true),
    });
  }
  return blocks;
};

/**
 * A document as blocks. Never throws, for any string — including every prefix of a document that
 * is still streaming.
 */
export const parseMarkdown = (value: string): Block[] => {
  if (value.length > MAX_MARKDOWN_CHARS) {
    // The size guard: paragraphs and fences only, the renderer this module replaced.
    return segmentBlocks(value).map(
      (block): Block =>
        block.kind === 'code'
          ? block
          : { kind: 'paragraph', content: [{ kind: 'text', value: block.value }] },
    );
  }
  const lines = sanitiseUntrusted(value).split('\n').map(expandLeadingTabs);
  return parseBlocks(lines, 0);
};

// ── Inline ───────────────────────────────────────────────────────────────────

const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/u;
const WHITESPACE = /^\s$/u;
const WORD = /^[\p{L}\p{N}]$/u;

const isSpace = (character: string | undefined): boolean =>
  character === undefined || WHITESPACE.test(character);
const isWord = (character: string | undefined): boolean =>
  character !== undefined && WORD.test(character);

const runLength = (text: string, from: number, character: string): number => {
  let end = from;
  while (text[end] === character) end += 1;
  return end - from;
};

/** Every opener matched to its closer in one stack pass; backslash-escaped ones are skipped. */
const matchPairs = (text: string, open: string, close: string): Map<number, number> => {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
    } else if (character === open) {
      stack.push(index);
    } else if (character === close) {
      const opener = stack.pop();
      if (opener !== undefined) pairs.set(opener, index);
    }
  }
  return pairs;
};

/** The position of a backtick run exactly `length` long at or after `from`, or -1. */
const backtickCloser = (text: string, from: number, length: number): number => {
  let index = text.indexOf('`', from);
  while (index !== -1) {
    const run = runLength(text, index, '`');
    if (run === length) return index;
    index = text.indexOf('`', index + run);
  }
  return -1;
};

/**
 * The position of a closing delimiter run at or after `from`, or -1. Whether a run closes depends
 * on the run alone (its length, the character before it, and for `_` the one after), never on the
 * opener — which is what makes a failed search valid for every later opener of the same kind.
 */
const delimiterCloser = (text: string, from: number, character: string, length: number): number => {
  let index = text.indexOf(character, from);
  while (index !== -1) {
    const run = runLength(text, index, character);
    if (
      run === length &&
      !isSpace(text[index - 1]) &&
      (character !== '_' || !isWord(text[index + run]))
    ) {
      return index;
    }
    index = text.indexOf(character, index + run);
  }
  return -1;
};

/** `[label](destination "title")` → the destination, or `null` for a malformed one. */
const parseDestination = (raw: string): string | null => {
  const text = raw.trim();
  if (text.startsWith('<')) {
    const end = text.indexOf('>');
    return end <= 1 ? null : text.slice(1, end);
  }
  const space = text.search(/\s/u);
  const url = space === -1 ? text : text.slice(0, space);
  const rest = space === -1 ? '' : text.slice(space).trim();
  if (url === '' || (rest !== '' && !/^["'(]/u.test(rest))) return null;
  return url;
};

const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/iuy;

const pushText = (out: Inline[], value: string): void => {
  if (value === '') return;
  const last = out[out.length - 1];
  if (last !== undefined && last.kind === 'text') {
    out[out.length - 1] = { kind: 'text', value: last.value + value };
  } else {
    out.push({ kind: 'text', value });
  }
};

const wrapMark = (character: string, run: number, children: Inline[]): Inline | null => {
  if (character === '~') return run === 2 ? { kind: 'strikethrough', children } : null;
  if (run === 1) return { kind: 'emphasis', children };
  if (run === 2) return { kind: 'strong', children };
  if (run === 3) return { kind: 'strong', children: [{ kind: 'emphasis', children }] };
  return null;
};

const parseInlineNodes = (text: string, depth: number, links: boolean): Inline[] => {
  if (depth > MAX_INLINE_DEPTH) return text === '' ? [] : [{ kind: 'text', value: text }];
  const out: Inline[] = [];
  let buffer = '';
  const flush = (): void => {
    pushText(out, buffer);
    buffer = '';
  };
  const brackets = links ? matchPairs(text, '[', ']') : new Map<number, number>();
  const parens = links ? matchPairs(text, '(', ')') : new Map<number, number>();
  /** Delimiter kinds (character + run length) already known to have no closer from here on. */
  const exhausted = new Set<string>();

  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? '';

    if (character === '\\' && ASCII_PUNCTUATION.test(text[index + 1] ?? '')) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }

    if (character === '`') {
      const run = runLength(text, index, '`');
      const key = `\`${run}`;
      const close = exhausted.has(key) ? -1 : backtickCloser(text, index + run, run);
      if (close === -1) {
        exhausted.add(key);
        buffer += text.slice(index, index + run);
        index += run;
        continue;
      }
      let code = text.slice(index + run, close).replace(/\n/gu, ' ');
      if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
        code = code.slice(1, -1);
      }
      flush();
      out.push({ kind: 'code', value: code });
      index = close + run;
      continue;
    }

    if (links && (character === '[' || (character === '!' && text[index + 1] === '['))) {
      const open = character === '!' ? index + 1 : index;
      const close = brackets.get(open);
      const opening = close === undefined || text[close + 1] !== '(' ? undefined : close + 1;
      const paired = opening === undefined ? undefined : parens.get(opening);
      // A destination longer than any real URL is not read as one: it bounds the work a hostile
      // nest of `[a](` can cause to a constant per bracket.
      const end =
        opening !== undefined && paired !== undefined && paired - opening <= MAX_DESTINATION_CHARS
          ? paired
          : undefined;
      const destination =
        close === undefined || end === undefined
          ? null
          : parseDestination(text.slice(close + 2, end));
      if (close !== undefined && end !== undefined && destination !== null) {
        const label = text.slice(open + 1, close);
        const source = text.slice(index, end + 1);
        flush();
        out.push(
          character === '!'
            ? { kind: 'image', url: destination, alt: label, source }
            : {
                kind: 'link',
                url: destination,
                label: parseInlineNodes(label, depth + 1, false),
                source,
              },
        );
        index = end + 1;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    if (links && character === '<') {
      AUTOLINK.lastIndex = index;
      const match = AUTOLINK.exec(text);
      if (match !== null) {
        const url = match[1] ?? '';
        flush();
        out.push({ kind: 'link', url, label: [{ kind: 'text', value: url }], source: match[0] });
        index += match[0].length;
        continue;
      }
    }

    if (character === '*' || character === '_' || character === '~') {
      const run = runLength(text, index, character);
      const opens =
        (character === '~' ? run === 2 : run <= 3) &&
        !isSpace(text[index + run]) &&
        (character !== '_' || !isWord(text[index - 1]));
      if (opens) {
        const key = `${character}${run}`;
        const close = exhausted.has(key) ? -1 : delimiterCloser(text, index + run, character, run);
        if (close === -1) {
          exhausted.add(key);
        } else {
          const mark = wrapMark(
            character,
            run,
            parseInlineNodes(text.slice(index + run, close), depth + 1, links),
          );
          if (mark !== null) {
            flush();
            out.push(mark);
            index = close + run;
            continue;
          }
        }
      }
      buffer += text.slice(index, index + run);
      index += run;
      continue;
    }

    buffer += character;
    index += 1;
  }
  flush();
  return out;
};

/** One line of inline markdown — marks, code and links, no blocks. Never throws. */
export const parseInlineMarkdown = (value: string): Inline[] => {
  const sanitised = sanitiseUntrusted(value);
  if (sanitised.length > MAX_MARKDOWN_CHARS) return [{ kind: 'text', value: sanitised }];
  return parseInlineNodes(sanitised, 0, true);
};

/** The words of inline nodes with the marks taken off; a refused link keeps its literal source. */
export const inlineText = (nodes: readonly Inline[]): string =>
  nodes
    .map((node): string => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.value;
        case 'link':
          return safeHref(node.url) === null ? node.source : inlineText(node.label);
        case 'image':
          return node.alt;
        default:
          return inlineText(node.children);
      }
    })
    .join('');

/** A line's block markers — quote `>`, heading `#`, bullet or number — up to its words. */
const BLOCK_PREFIX = /^ {0,3}(?:> ?|#{1,6}(?=[ \t]|$)[ \t]*|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/u;

const stripBlockMarkers = (line: string): string => {
  let rest = line;
  // Bounded: each pass removes at least one character of a prefix, and nesting is capped.
  for (let pass = 0; pass < MAX_BLOCK_DEPTH; pass += 1) {
    const match = BLOCK_PREFIX.exec(rest);
    if (match === null || match[0] === '') break;
    rest = rest.slice(match[0].length);
  }
  return rest;
};

/**
 * A string's words with markdown taken off — for a one-line preview inside a control: each line's
 * block markers (`# `, `- `, `1) `, `> `) and the inline marks.
 */
export const markdownToPlainText = (value: string): string =>
  inlineText(
    parseInlineMarkdown(sanitiseUntrusted(value).split('\n').map(stripBlockMarkers).join('\n')),
  );
