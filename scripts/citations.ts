/**
 * Citations of tests, from prose that claims something about the suite — parsed, so they can be
 * resolved.
 *
 * ## Why this exists
 *
 * Standing rule 11: *a register entry that justifies a kindness by pointing at a test elsewhere must
 * name a test that exists.* WP-14's fake divergence register justified its kindest entry by naming
 * `docker-workspace.e2e.test.ts` and a test in it called "is covered by the fake in the contract
 * tier and by the cases above here" — which was never written. (That sentence deliberately omits the
 * `›`, because with it this docblock would be making the false claim rather than describing it.)
 * Five other citations in the same table resolved, which is what makes the class dangerous: the
 * register reads as evidence, and one entry of it was a sentence. Rule 30 says a lesson recorded
 * only in prose does not prevent recurrence, so the citations are now parsed and looked up.
 *
 * ## The grammar, which is deliberately small
 *
 * A citation opens with a backticked file name that ends in `.ts`/`.tsx` followed by `›`:
 *
 * ```
 *  `workspace/fake.test.ts` › "attach returns a path that no server is listening on"
 * ```
 *
 * While that context is open, **every double-quoted string on the same logical line** is a cited
 * test name in that file. That is what lets one citation carry a list — the six property names in
 * divergence 1 belong to the file named once at the start of the cell — without repeating the file
 * six times, and it is why a quoted phrase that is *not* a test name must not be written after a
 * citation while its context is open. The context closes at the next backticked `*.ts` token (with
 * or without a `›`) and at the end of the logical line.
 *
 * ## A logical line, because this repository wraps its prose at 100 columns
 *
 * A citation that runs past the margin is written across two comment lines, and the guard's first
 * version was line-scoped, so it could not see one: both citations in `workspace/provider.ts` were
 * invisible to it while that file's docblock claimed they were "resolved mechanically" — rule 44's
 * shape inside the fix for rule 11, and rule 48's corollary (*plant the shape the repository
 * actually writes, not the shape the grammar section shows*).
 *
 * So a line **continues** onto the next one when it ends part-way through a citation, and only
 * then: inside an unclosed `"name`, immediately after the `›`, or after the comma of a list. The
 * continuation's decoration (`*`, `//`, or `>` in Markdown) is stripped and the two are joined with
 * a single space, which is what the wrap replaced. A *complete* citation does not continue, so
 * ordinary quoted prose on the following line is not swallowed.
 *
 * Which decorations count is the caller's choice, because it depends on the file: `'comment'` (the
 * default) continues only onto a `*`- or `//`-prefixed line, which is what keeps a synthetic
 * fixture inside a TypeScript string literal from joining the code around it; `'prose'` continues
 * onto any non-blank line, which is how Markdown wraps.
 *
 * ## What it can and cannot check
 *
 * It checks that a cited name is the name of a `describe`, `it` or `test` in the file named, that
 * the file is tracked by git, and that the name is unambiguous. It does **not** check that the test
 * asserts what the prose says it asserts — no parser can — nor does it see a citation written in
 * any other shape, which is the honest limit of a syntactic guard (standing rule 48). Known gaps,
 * stated rather than discovered later:
 *
 *  - a name assembled from a template literal or a variable, on either side, is skipped;
 *  - a citation wrapped over a line whose decoration is not one of the two sets above — a Markdown
 *    fenced block inside a `.ts` docblock, say — closes at the wrap and loses its tail;
 *  - a citation is attributed to the line its **file token** is on, so two citations of the same
 *    file on one line are one site to the recall check in `citations.test.ts`;
 *  - the sweep reads a file as text, so a citation inside a string literal is read like any other.
 *    That is deliberate: the parser's own fixtures are therefore real citations of real tests.
 *
 * Its scope is `git ls-files` filtered to the file types this repository writes prose in — `.ts`,
 * `.tsx`, `.mjs` and `.md` — so it cannot drift the way a hand-maintained list does (standing rule
 * 7). Markdown is in that list because `CLAUDE.md`, `PROGRESS.md` and `docs/technical/*` are where
 * this class of claim also lives; no Markdown citation exists yet, so that half is a guard waiting
 * rather than a guard working, and the recall check will say so the day one is written.
 */

/** One `file › "name"` claim, with the line it was written on. */
export interface TestCitation {
  /** The file name as written, which may be a basename or a partial path. */
  readonly file: string;
  readonly name: string;
  /** 1-based, of the line the citation *opens* on — where an operator goes to fix it. */
  readonly line: number;
}

const FILE_TOKEN = /`([\w./-]+\.tsx?)`(\s*›)?/g;
const QUOTED = /"((?:\\.|[^"\\])*)"/g;

/**
 * Where a citation opens, as a second and deliberately separate expression of the same shape.
 *
 * `citations.test.ts` uses it to assert **recall**: every site in the checkout must produce a
 * citation. It repeats the file-name shape instead of reusing {@link FILE_TOKEN} because the marker
 * alone appears in prose *about* the grammar (a backticked `›` in this very docblock), and because
 * what it exists to catch is a regression in the scanning — context carrying, wrapping, quoted-name
 * collection — rather than in the file-name pattern. A guard and its oracle sharing one regex is
 * one guard.
 */
export const CITATION_SITE = /`([\w./-]+\.tsx?)`[ \t]*›/g;

/** Which line decorations a wrapped citation may continue over. */
export type CitationContinuation = 'comment' | 'prose';

const COMMENT_DECORATION = /^[ \t]*(?:\*|\/\/)[ \t]*/;
const PROSE_DECORATION = /^[ \t]*(?:>[ \t]*)*/;

const unescaped = (value: string): string => value.replace(/\\(.)/g, '$1');

/** The text a line contributes as a continuation, or `null` when it may not continue one. */
const continuationText = (line: string, kind: CitationContinuation): string | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('*/')) {
    return null;
  }
  if (kind === 'comment' && !COMMENT_DECORATION.test(line)) {
    return null;
  }
  const decoration = kind === 'comment' ? COMMENT_DECORATION : PROSE_DECORATION;
  const text = line.replace(decoration, '').trim();
  return text.length === 0 ? null : text;
};

interface ScannedCitation {
  readonly file: string;
  readonly name: string;
  /** Offset of the file token that opened the context, within the scanned text. */
  readonly at: number;
}

interface Scan {
  readonly citations: readonly ScannedCitation[];
  /** Offset of the file token still open at the end of the text, or `null`. */
  readonly openAt: number | null;
}

/** One pass over one logical line, merging both token kinds so their *order* decides the context. */
const scan = (text: string): Scan => {
  const citations: ScannedCitation[] = [];
  // A file token closes the previous citation, which is what keeps a later file name in the same
  // sentence from inheriting the earlier one's quoted names.
  const tokens = [
    ...[...text.matchAll(FILE_TOKEN)].map((match) => ({
      at: match.index,
      file: match[1] ?? '',
      opens: match[2] !== undefined,
      name: null as string | null,
    })),
    ...[...text.matchAll(QUOTED)].map((match) => ({
      at: match.index,
      file: '',
      opens: false,
      name: unescaped(match[1] ?? ''),
    })),
  ].sort((left, right) => left.at - right.at);
  let current: string | null = null;
  let openAt = 0;
  for (const token of tokens) {
    if (token.name === null) {
      current = token.opens ? token.file : null;
      openAt = token.at;
      continue;
    }
    if (current !== null && token.name.length > 0) {
      citations.push({ file: current, name: token.name, at: openAt });
    }
  }
  return { citations, openAt: current === null ? null : openAt };
};

/** The offset of a `"` that opens a name the text never closes, or -1. */
const danglingQuoteAt = (text: string): number => {
  let closed = 0;
  for (const match of text.matchAll(QUOTED)) {
    closed = match.index + match[0].length;
  }
  for (let index = closed; index < text.length; index += 1) {
    if (text[index] !== '"') {
      continue;
    }
    let backslashes = 0;
    while (text[index - backslashes - 1] === '\\') {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      return index;
    }
  }
  return -1;
};

/** Whether the text stops part-way through a citation, which is the only reason to read on. */
const endsMidCitation = (text: string): boolean => {
  const { openAt } = scan(text);
  if (openAt === null) {
    return false;
  }
  return /[›,][ \t]*$/.test(text) || danglingQuoteAt(text) > openAt;
};

/** Where each physical line's text starts inside the joined logical line. */
interface Piece {
  readonly at: number;
  readonly line: number;
}

interface LogicalLine {
  readonly text: string;
  readonly pieces: readonly Piece[];
}

const logicalLines = (source: string, kind: CitationContinuation): LogicalLine[] => {
  const lines = source.split('\n');
  const logical: LogicalLine[] = [];
  let index = 0;
  while (index < lines.length) {
    let text = (lines[index] ?? '').replace(/\s+$/, '');
    const pieces: Piece[] = [{ at: 0, line: index + 1 }];
    let next = index + 1;
    while (next < lines.length && endsMidCitation(text)) {
      const continued = continuationText(lines[next] ?? '', kind);
      if (continued === null) {
        break;
      }
      pieces.push({ at: text.length + 1, line: next + 1 });
      text = `${text} ${continued}`;
      next += 1;
    }
    logical.push({ text, pieces });
    index = next;
  }
  return logical;
};

const lineOf = (pieces: readonly Piece[], at: number): number => {
  let line = pieces[0]?.line ?? 1;
  for (const piece of pieces) {
    if (piece.at <= at) {
      line = piece.line;
    }
  }
  return line;
};

/** Every citation in one document. */
export const collectCitations = (
  source: string,
  kind: CitationContinuation = 'comment',
): TestCitation[] =>
  logicalLines(source, kind).flatMap((logical) =>
    scan(logical.text).citations.map((citation) => ({
      file: citation.file,
      name: citation.name,
      line: lineOf(logical.pieces, citation.at),
    })),
  );

/** Every line of a document at which a citation is written, by the independent site shape. */
export const citationSites = (source: string): { file: string; line: number }[] =>
  source.split('\n').flatMap((line, index) =>
    [...line.matchAll(CITATION_SITE)].map((match) => ({
      file: match[1] ?? '',
      line: index + 1,
    })),
  );

const NAMED_TEST =
  /\b(?:it|test|describe)(?:\.(?:skip|only|todo|concurrent|sequential|fails|runIf|skipIf))*\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
const EACH_TEST =
  /\b(?:it|test|describe)\.each\([\s\S]{0,400}?\)\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * Every test name a file declares.
 *
 * A name built from a template literal or a variable is not collected: it cannot be cited exactly
 * either, so pretending to know it would only turn one unresolvable citation into another.
 */
export const testNamesIn = (source: string): Set<string> => {
  const names = new Set<string>();
  for (const pattern of [NAMED_TEST, EACH_TEST]) {
    for (const match of source.matchAll(pattern)) {
      names.add(unescaped(match[2] ?? ''));
    }
  }
  return names;
};

export interface CitationFailure extends TestCitation {
  /** Where the citation was written. */
  readonly source: string;
  readonly reason: 'no such file' | 'ambiguous file name' | 'no such test';
}

/**
 * Resolves citations against the tracked files, given the repository's file list.
 *
 * `read` is injected so the whole check is a pure function of (citations, file list, contents) and
 * can be driven with a synthetic repository — the calibration standing rule 21 asks for: a guard
 * nobody has watched fail is a guard nobody has watched.
 */
export const resolveCitations = (input: {
  readonly citations: readonly (TestCitation & { readonly source: string })[];
  readonly trackedFiles: readonly string[];
  readonly read: (path: string) => string;
}): CitationFailure[] => {
  const failures: CitationFailure[] = [];
  const names = new Map<string, Set<string>>();
  for (const citation of input.citations) {
    const matches = input.trackedFiles.filter(
      (candidate) => candidate === citation.file || candidate.endsWith(`/${citation.file}`),
    );
    if (matches.length === 0) {
      failures.push({ ...citation, reason: 'no such file' });
      continue;
    }
    if (matches.length > 1) {
      failures.push({ ...citation, reason: 'ambiguous file name' });
      continue;
    }
    const file = matches[0] ?? '';
    let declared = names.get(file);
    if (declared === undefined) {
      declared = testNamesIn(input.read(file));
      names.set(file, declared);
    }
    if (!declared.has(citation.name)) {
      failures.push({ ...citation, reason: 'no such test' });
    }
  }
  return failures;
};

/** The line an operator sees, which has to be enough to fix the citation without opening a tool. */
export const describeFailure = (failure: CitationFailure): string =>
  `${failure.source}:${failure.line} cites ${failure.file} › "${failure.name}" — ${failure.reason}`;
