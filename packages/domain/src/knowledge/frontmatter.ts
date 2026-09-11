/**
 * The YAML frontmatter reader for knowledge documents — a **restricted** grammar that refuses what
 * it does not understand.
 *
 * This repository has no YAML parser and this module is not the place to acquire one. What it
 * parses is the subset product/05's lesson schema is written in: a flat mapping of scalars and
 * string sequences. Everything outside that subset — a nested mapping, a block scalar, an anchor,
 * a tab, an unterminated quote, a duplicate key, a fence that never closes — is reported as
 * {@link MalformedFrontmatter} with a line number.
 *
 * **Three outcomes, never two** (rule 18). A document with no frontmatter, a document whose
 * frontmatter the platform cannot read, and a document whose frontmatter is empty are three
 * different facts about a vault:
 *
 *  - `absent` — no `---` fence. Legitimate and common: most of the business and technical layers
 *    are ordinary Markdown pages. The document indexes with no frontmatter fields.
 *  - `present` — parsed. `fields` may be empty if the block was, which is not the same as `absent`
 *    and is worth telling a curator about.
 *  - `malformed` — the platform could not read it. The indexer records the document as invalid and
 *    the KB health report shows it (product/05 § Librarian "Validates: frontmatter schema").
 *    It is **not** indexed as a document with no fields, because that is the shape where
 *    `paths:`-scoped injection silently stops happening and nothing says so.
 *
 * A parser that guesses is worse than one that refuses, because the guess ends up in a prompt. The
 * grammar is stated in {@link FRONTMATTER_GRAMMAR} and the refusals are enumerated in the tests.
 */

/** A scalar as the restricted grammar can produce it. */
export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue = FrontmatterScalar | readonly string[];
export type FrontmatterFields = Readonly<Record<string, FrontmatterValue>>;

export interface MalformedFrontmatter {
  readonly kind: 'malformed';
  /** Human-readable, and safe to show: it quotes no document text beyond the key at fault. */
  readonly reason: string;
  /** 1-based, counted from the start of the file so it lines up with an editor. */
  readonly line: number;
}

export type FrontmatterBlock =
  | { readonly kind: 'absent'; readonly body: string }
  | { readonly kind: 'present'; readonly fields: FrontmatterFields; readonly body: string }
  | MalformedFrontmatter;

/** What the reader accepts, quoted in refusal messages so the author is told the rule. */
export const FRONTMATTER_GRAMMAR =
  'a flat YAML mapping: "key: scalar", "key: [a, b]", or "key:" followed by "  - item" lines';

const FENCE = '---';
const KEY = /^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/;
const SEQUENCE_ITEM = /^\s+-\s*(.*)$/;

const splitLines = (source: string): readonly string[] => source.split(/\r?\n/);

/** `value  # trailing comment` — YAML strips a comment only when whitespace precedes the `#`. */
const stripComment = (raw: string): string => {
  const at = raw.search(/(^|\s)#/);
  return at === -1 ? raw : raw.slice(0, at);
};

const unquote = (
  raw: string,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string } => {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") return { ok: true, value: raw };
  if (raw.length < 2 || raw.at(-1) !== quote) {
    return { ok: false, reason: 'unterminated quoted string' };
  }
  const inner = raw.slice(1, -1);
  if (inner.includes(quote)) return { ok: false, reason: 'unterminated quoted string' };
  return { ok: true, value: inner };
};

/**
 * A bare scalar.
 *
 * `true`/`false` and a plain number become typed values; everything else stays a string. YAML's
 * wider scalar vocabulary (`yes`, `on`, `~`, sexagesimals) is deliberately **not** honoured: this
 * is the subset product/05 writes in, and quietly turning `status: on` into a boolean is the class
 * of surprise that makes a hand-rolled parser dangerous. Such a value stays the string `"on"`, and
 * the field schema in `@platform/contracts` is what refuses it.
 */
const scalarValue = (raw: string): FrontmatterScalar => {
  if (raw === '') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) return Number(raw);
  return raw;
};

const flowSequence = (
  raw: string,
):
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly reason: string } => {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return { ok: true, value: [] };
  const items: string[] = [];
  for (const part of splitFlowItems(inner)) {
    const unquoted = unquote(part.trim());
    if (!unquoted.ok) return unquoted;
    items.push(unquoted.value);
  }
  return { ok: true, value: items };
};

/** Split on commas that are not inside a quoted item. */
const splitFlowItems = (inner: string): readonly string[] => {
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const character of inner) {
    if (quote !== null) {
      if (character === quote) quote = null;
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ',') {
      items.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  items.push(current);
  return items;
};

const malformed = (reason: string, line: number): MalformedFrontmatter => ({
  kind: 'malformed',
  reason,
  line,
});

/**
 * Reads the frontmatter block at the top of a document.
 *
 * The fence must be the very first line: a `---` further down is a horizontal rule, and treating it
 * as frontmatter would silently swallow the top of a page.
 */
export const readFrontmatter = (source: string): FrontmatterBlock => {
  const lines = splitLines(source);
  if (lines[0]?.trim() !== FENCE) return { kind: 'absent', body: source };

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (closing === -1) {
    return malformed(`frontmatter fence is never closed; ${FRONTMATTER_GRAMMAR}`, 1);
  }

  const fields: Record<string, FrontmatterValue> = {};
  let pendingKey: string | null = null;
  let pendingItems: string[] = [];

  const flushPending = (): void => {
    if (pendingKey !== null) {
      fields[pendingKey] = pendingItems;
      pendingKey = null;
      pendingItems = [];
    }
  };

  for (let index = 1; index < closing; index += 1) {
    const raw = lines[index] as string;
    const lineNumber = index + 1;

    if (raw.includes('\t')) {
      return malformed('a tab character; YAML indentation must be spaces', lineNumber);
    }

    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const item = SEQUENCE_ITEM.exec(raw);
    if (item !== null) {
      if (pendingKey === null) {
        return malformed(
          `a sequence item with no key above it; ${FRONTMATTER_GRAMMAR}`,
          lineNumber,
        );
      }
      const unquoted = unquote(stripComment(item[1] as string).trim());
      if (!unquoted.ok) return malformed(unquoted.reason, lineNumber);
      pendingItems.push(unquoted.value);
      continue;
    }

    if (raw !== raw.trimStart()) {
      return malformed('an indented key; nested mappings are not supported', lineNumber);
    }

    const key = KEY.exec(raw);
    if (key === null) {
      return malformed(
        `a line that is not a key or a sequence item; ${FRONTMATTER_GRAMMAR}`,
        lineNumber,
      );
    }

    flushPending();
    const name = key[1] as string;
    if (Object.hasOwn(fields, name)) {
      // `key in fields` would walk Object.prototype and read `constructor` as a duplicate
      // (rule 38); `Object.hasOwn` is the question being asked.
      return malformed(`duplicate key "${name}"`, lineNumber);
    }

    const rest = stripComment(key[2] as string).trim();
    if (rest === '') {
      pendingKey = name;
      continue;
    }
    if (rest.startsWith('&') || rest.startsWith('*')) {
      return malformed(`a YAML anchor or alias; ${FRONTMATTER_GRAMMAR}`, lineNumber);
    }
    if (rest === '|' || rest === '>' || rest.startsWith('|') || rest.startsWith('>')) {
      return malformed(`a block scalar; ${FRONTMATTER_GRAMMAR}`, lineNumber);
    }
    if (rest.startsWith('{')) {
      return malformed('an inline mapping; nested mappings are not supported', lineNumber);
    }
    if (rest.startsWith('[')) {
      if (!rest.endsWith(']')) return malformed('an unterminated flow sequence', lineNumber);
      const sequence = flowSequence(rest);
      if (!sequence.ok) return malformed(sequence.reason, lineNumber);
      fields[name] = sequence.value;
      continue;
    }
    const unquoted = unquote(rest);
    if (!unquoted.ok) return malformed(unquoted.reason, lineNumber);
    fields[name] = rest === unquoted.value ? scalarValue(unquoted.value) : unquoted.value;
  }

  flushPending();
  return { kind: 'present', fields, body: lines.slice(closing + 1).join('\n') };
};
