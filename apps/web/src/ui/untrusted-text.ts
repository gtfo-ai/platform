/**
 * Everything the platform knows about a string it did not write (BD-022).
 *
 * Ticket titles, MR comments, agent transcripts, tool output, hook reasons, log lines and KB
 * excerpts are all attacker-influenced, and a UI is where they become an XSS surface. The position
 * this app takes is narrower than "sanitise the HTML":
 *
 * > **Untrusted text is never converted to HTML at all.**
 *
 * There is no markdown-to-HTML step, no `dangerouslySetInnerHTML`, no `innerHTML`, and no
 * sanitiser to get wrong — a deviation from TD-013, which names `streamdown`, and recorded as an
 * amendment on that decision rather than only here. This module turns a string into *data* — segments and blocks — and
 * `untrusted.tsx` turns that data into React elements, which React escapes when it writes them
 * into the DOM. A string therefore cannot become markup at any point, which is a property of the
 * pipeline rather than of a filter.
 *
 * That matters because the alternative has a specific, repeated failure: WP-10 escaped a string
 * for Slack and then undid the escape one function later, in its own link converter. An
 * escape-then-transform pipeline has to be correct at every stage; a pipeline that never produces
 * markup has nothing to undo. `untrusted.test.tsx` asserts this against the rendered **DOM** — no
 * `<img>`, no `<script>`, no `javascript:` href — rather than against an intermediate string,
 * because the intermediate string is exactly what was right in the Slack case.
 *
 * ### What is done to the characters
 * 1. `\r\n` and lone `\r` become `\n`, so a line count means one thing.
 * 2. C0 control characters other than `\n` and `\t` are removed. They render as nothing or as
 *    garbage, and `\b`/`\x1b` are how terminal output rewrites what a human already read.
 * 3. **Bidirectional overrides and isolates are replaced with U+FFFD** — U+202A…U+202E,
 *    U+2066…U+2069 and U+061C. These are the "Trojan Source" characters (CVE-2021-42574): they
 *    reorder the *display* of a line without changing its bytes, so a reviewer reading a diff or a
 *    tool result sees something other than what is there. This app renders model output and tool
 *    results — the two least trustworthy strings in the system — so reordering is a real risk and
 *    a visible replacement character is the honest answer. The plain marks U+200E/U+200F are
 *    **kept**: they cannot reorder a run, and product/10 says user content is shown as-is.
 *
 * Nothing here truncates: the transcript's own byte caps are applied server-side by the
 * `PostToolUse` hook (technical/04), and a second cap applied in a renderer would disagree with
 * the first (standing rule 36).
 */

/** Trojan-source characters: overrides, embeddings, isolates and the Arabic letter mark. */
const BIDI_CONTROLS = /[\u061C\u202A-\u202E\u2066-\u2069]/gu;

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: the control characters *are* what
// these two patterns exist to find — ESC, BEL and the C0 range. Suppressed as a range because the
// formatter wraps the second pattern onto its own line, which a single-line suppression cannot follow.

/** C0 except `\n` and `\t`, plus DEL. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F]/gu;

/** CSI / OSC / single-character escape sequences (ECMA-48). */
const ANSI_SEQUENCES =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_])/gu;

// biome-ignore-end lint/suspicious/noControlCharactersInRegex: see above.

export const REPLACEMENT = '\uFFFD';

/**
 * Strips ANSI escape sequences.
 *
 * Applied **before** control characters are removed: the ESC that starts a sequence is itself a
 * control character, so removing controls first would leave the sequence body (`[31m`) rendering
 * as visible text.
 */
export const stripAnsi = (value: string): string => value.replace(ANSI_SEQUENCES, '');

export const sanitiseUntrusted = (value: string): string =>
  value
    .replace(/\r\n?/gu, '\n')
    .replace(BIDI_CONTROLS, REPLACEMENT)
    .replace(CONTROL_CHARACTERS, '');

// ── Inline segmentation: text and links ──────────────────────────────────────

export type InlineSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'link'; readonly href: string; readonly label: string };

/**
 * Candidate URLs. Only `http://` and `https://` are even *looked for*: a scheme the pattern cannot
 * match can never reach `new URL()`, so `javascript:`, `data:`, `vbscript:` and `file:` are
 * excluded by the pattern and again by the check below — two independent reasons, because the
 * pattern is the easier of the two to loosen by accident.
 */
const URL_CANDIDATE = /https?:\/\/[^\s<>"'`\\]+/giu;

/** Punctuation that ends a sentence rather than a URL. Brackets are balanced, not stripped blindly. */
const trimTrailing = (candidate: string): string => {
  let end = candidate.length;
  while (end > 0) {
    const character = candidate[end - 1] ?? '';
    if (character === ')') {
      const inner = candidate.slice(0, end);
      const opens = (inner.match(/\(/gu) ?? []).length;
      const closes = (inner.match(/\)/gu) ?? []).length;
      if (closes <= opens) {
        break;
      }
      end -= 1;
      continue;
    }
    if ('.,;:!?"\'’”]}>'.includes(character)) {
      end -= 1;
      continue;
    }
    break;
  }
  return candidate.slice(0, end);
};

/**
 * The one function every `href` in this application goes through.
 *
 * The string is parsed by the platform's own URL parser and re-serialised, so what reaches the DOM
 * is the parser's normalised output rather than the attacker's spelling — no `\t`-in-`java\tscript:`
 * trick survives a parse, and any scheme other than the two allowed produces `null`, which renders
 * as plain text.
 *
 * Both callers are in `ui/untrusted.tsx`: `UntrustedText` for a URL found inside a run of text and
 * `ExternalLink` for one a DTO carried. That "both" is **enforced, not asserted in prose** —
 * `no-html.test.ts` fails when `href=` or `src=` appears in any source file other than
 * `ui/untrusted.tsx`. It has to be: this docblock previously claimed segmentation was the only
 * producer of an `href` while five call sites on the board and the task screen were writing the
 * attribute from a DTO field, and a sentence cannot notice that.
 *
 * A DTO field is not a substitute for this call. `urlSchema` is `z.url()`, which accepts
 * `javascript:`, `data:`, `vbscript:` and `file:` — the contract fixes the *syntax* of a URL, not
 * the schemes a browser may be handed.
 */
export const safeHref = (candidate: string): string | null => {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  return url.toString();
};

/**
 * Splits sanitised text into plain runs and links.
 *
 * Markdown link syntax is **not** interpreted: `[label](javascript:…)` renders as those literal
 * characters. Interpreting it would mean deciding a label separately from a destination, which is
 * how a link's visible text comes to disagree with where it goes — and the only reason to want it
 * is prettiness.
 */
export const segmentInline = (value: string): InlineSegment[] => {
  const sanitised = sanitiseUntrusted(value);
  const segments: InlineSegment[] = [];
  let index = 0;
  URL_CANDIDATE.lastIndex = 0;
  for (const match of sanitised.matchAll(URL_CANDIDATE)) {
    const start = match.index;
    const candidate = trimTrailing(match[0]);
    // Named `resolved` rather than `href`: `no-html.test.ts` forbids that name followed by an
    // equals sign outside `ui/untrusted.tsx`, and a guard with an exception list is a guard with a
    // hole (standing rule 7). Note the walk strips block comments and deliberately not line
    // comments, so this sentence had to be written without the pattern in it.
    const resolved = safeHref(candidate);
    if (resolved === null || candidate === '') {
      continue;
    }
    if (start > index) {
      segments.push({ kind: 'text', value: sanitised.slice(index, start) });
    }
    segments.push({ kind: 'link', href: resolved, label: candidate });
    index = start + candidate.length;
  }
  if (index < sanitised.length) {
    segments.push({ kind: 'text', value: sanitised.slice(index) });
  }
  return segments;
};

// ── Block segmentation: paragraphs and fenced code ───────────────────────────

export type TextBlock =
  | { readonly kind: 'paragraph'; readonly value: string }
  | { readonly kind: 'code'; readonly language: string | null; readonly value: string };

const FENCE = /^\s{0,3}(?:```|~~~)\s*([A-Za-z0-9_+#.-]*)\s*$/u;

/**
 * The single markdown construct this app understands: the fenced code block.
 *
 * It is understood because *not* understanding it is worse — a diff or a stack trace collapsed
 * into a paragraph is unreadable, and unreadable transcripts are why the run screen exists. It is
 * also the safest construct there is: the fence decides only which element the text goes into, and
 * the text inside a fence is rendered verbatim, never linkified and never re-parsed. The language
 * tag is kept as a label (rendered as text) and is **not** used to select a highlighter — shiki
 * behind a worker is follow-up, and it is the piece that would need its own review.
 *
 * Everything else — `#`, `**`, `[]()`, `<b>`, `|tables|` — renders literally.
 */
export const segmentBlocks = (value: string): TextBlock[] => {
  const sanitised = sanitiseUntrusted(value);
  const blocks: TextBlock[] = [];
  const lines = sanitised.split('\n');
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let language: string | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      const text = paragraph.join('\n');
      if (text.trim() !== '') {
        blocks.push({ kind: 'paragraph', value: text });
      }
      paragraph = [];
    }
  };

  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (code === null && fence !== null) {
      flushParagraph();
      code = [];
      language = (fence[1] ?? '') === '' ? null : (fence[1] ?? null);
      continue;
    }
    if (code !== null && fence !== null) {
      blocks.push({ kind: 'code', language, value: code.join('\n') });
      code = null;
      language = null;
      continue;
    }
    if (code === null) {
      paragraph.push(line);
    } else {
      code.push(line);
    }
  }

  if (code !== null) {
    // An unterminated fence is still a code block: the alternative is rendering a half-written
    // stream as a paragraph and then reflowing it when the closing fence arrives.
    blocks.push({ kind: 'code', language, value: code.join('\n') });
  }
  flushParagraph();
  return blocks;
};
