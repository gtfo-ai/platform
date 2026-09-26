/**
 * The one thing WP-16 does to a knowledge document's bytes, and the exact boundary of it.
 *
 * A vault document is written by whoever can push to the project's repository, so it is untrusted
 * input (BD-022) — and this work package is what puts it into a prompt, into `kb_chunks`, into a
 * `kb_search` answer and into a file in the agent's workspace. Three separate things get lumped
 * together under "sanitise" and only one of them belongs here.
 *
 * **1. Characters that are not text (replaced here).** C0 and C1 control codes and the Unicode
 * bidirectional overrides. These are not content in any language; they are *rendering instructions*
 * to whatever displays the string. An `ESC[2J` in a lesson clears the terminal a developer is
 * reading a pack in; `U+202E` reverses the visual order of everything after it, so a page can
 * display as one instruction and contain another. And a literal `U+0000` is not merely unpleasant:
 * **PostgreSQL refuses it in a `text` column**, so one NUL in one vault page fails the `INSERT` and
 * takes the whole index run with it. Replacing them is a correctness requirement before it is a
 * security one, and `context-pack.integration.test.ts` drives that case against a real database —
 * both that a sanitised document stores, and that an **unsanitised** one is refused with
 * `invalid byte sequence for encoding "UTF8": 0x00` — rather than asserting it here.
 *
 * **2. Text that says hostile things (NOT touched here).** "Ignore previous instructions",
 * `<system>`, an HTML tag, a `javascript:` link. Those are *words*, and an indexer that edited the
 * words would be a knowledge base nobody could trust to say what the file says — a page about XSS
 * could not contain the string it is about. They pass through byte-identical, and the defence is
 * structural and belongs to the two rings that have one: the prompt's delimiters (technical/04
 * § "Prompt assembly"; `packages/domain/src/prompt/data-block.ts`) and the web app's text-node
 * rendering
 * (`apps/web/src/ui/untrusted.tsx`, whose guard fails the build on a markup sink). A test in
 * `document.test.ts` asserts this text survives unchanged, so the deferral is a checked claim
 * rather than an omission.
 *
 * **3. The repository file itself (out of reach, by design).** This changes `kb_chunks`, not the
 * `.md` file. The agent has that file in its own workspace and can read it with its ordinary tools,
 * where the path guard and the container are what apply. Nothing here is a barrier between an agent
 * and the vault, and claiming otherwise would be the kind of scope sentence standing rule 44 exists
 * to stop.
 *
 * Replacement rather than deletion, and a **count**: a removed character that leaves no trace is a
 * document that quietly differs from its file, so each becomes one U+FFFD and the total travels on
 * `ParsedKbDocument.sanitised` into `IndexReport` — which is what lets a KB health report say
 * "this page contains control characters" instead of nobody ever finding out.
 *
 * **4. Invisible characters inside a word (stripped here, and counted — WP-58, PROGRESS backlog
 * 12).** `U+200B` ZERO WIDTH SPACE, `U+FEFF` ZERO WIDTH NO-BREAK SPACE, `U+2060` WORD JOINER and
 * `U+00AD` SOFT HYPHEN reorder nothing, so they sat outside item 1 by design until a measurement
 * showed what they cost: every term splitter in this repository — `extractQueryTerms`, the
 * in-memory store's, PostgreSQL's `simple` parser — breaks a word at them, so `sess` + `U+200B` +
 * `ions` is indexed as two fragments and **no query can find the page by that word**. They are
 * *deleted* rather than replaced, because a `U+FFFD` in the same position splits the word exactly as
 * the original did; the count is the same count (`removed`), so a page carrying them is still
 * visible in `IndexReport`. The same four are stripped on the **query** path
 * ({@link stripInvisible}, called by `extractQueryTerms`), so a ticket title carrying one matches the
 * page it names. The prompt's data blocks still carry any such character a *non-indexed* source
 * brings — `assemblePrompt` edits nothing — and `data-block.ts` says why a nonce is indifferent to
 * them.
 */

/** U+FFFD REPLACEMENT CHARACTER — one visible codepoint per replaced character. */
export const SANITISED_MARKER = '\u{FFFD}';

/**
 * What is replaced, as escapes rather than as the characters themselves.
 *
 * - `U+0000`–`U+0008`, `U+000B`–`U+001F`, `U+007F`: the C0 controls and DEL, **except** `\t` and
 *   `\n`, which are document structure a fenced code block depends on. `\r` is **not** exempt:
 *   line endings are normalised before chunking, so a surviving carriage return is one in the
 *   middle of a line, which is a cursor instruction and not a line ending.
 * - `U+0080`–`U+009F`: the C1 controls, which arrive through a mis-decoded byte stream.
 * - `U+200E`, `U+200F`, `U+202A`–`U+202E`, `U+2066`–`U+2069`: the bidi marks, embeddings,
 *   overrides and isolates. Every one of them reorders what a reader sees without changing what a
 *   parser reads.
 */
const UNSAFE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing them is the point of this module.
  /[\u{0000}-\u{0008}\u{000B}-\u{001F}\u{007F}-\u{009F}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

/** Item 4 of the module docblock: invisible, split a word, reorder nothing — deleted, and counted. */
const INVISIBLE = /[\u{200B}\u{FEFF}\u{2060}\u{00AD}]/gu;

export interface SanitisedText {
  readonly text: string;
  /**
   * How many characters were replaced (items 1) or deleted (item 4). Zero for the overwhelming
   * majority of real documents.
   */
  readonly removed: number;
}

/**
 * Item 4 alone: the four invisible characters deleted, and how many there were.
 *
 * The query path's half of backlog 12 — `extractQueryTerms` calls it before it splits, so a term
 * cannot be cut in two by a character nobody can see.
 */
export const stripInvisible = (text: string): SanitisedText => {
  let removed = 0;
  const cleaned = text.replace(INVISIBLE, () => {
    removed += 1;
    return '';
  });
  return { text: cleaned, removed };
};

export const sanitiseDocumentText = (text: string): SanitisedText => {
  let removed = 0;
  const replaced = text.replace(UNSAFE, () => {
    removed += 1;
    return SANITISED_MARKER;
  });
  const stripped = stripInvisible(replaced);
  return { text: stripped.text, removed: removed + stripped.removed };
};
