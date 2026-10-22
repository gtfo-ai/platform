/**
 * The command text as bash reads it: every line continuation removed, once, before any reader runs
 * (WP-260, backlogs 662, 664, 665, 666 and 667).
 *
 * **The rule** (bash manual, *Escape Character*: a `\`-newline pair "is treated as a line
 * continuation (that is, it is removed from the input stream and effectively ignored)"; *Here
 * Documents*: in a body whose delimiter is not quoted "the character sequence `\newline` is
 * ignored"). Bash removes the pair **everywhere** — inside an opener (`$\⏎(`, `<\⏎(`, `$\⏎'`), an
 * operator (`<\⏎<`, `2\⏎>` stays `2` and `>` only because a continuation is not a blank), a
 * redirection target, a here-document's delimiter and terminator line, inside `"…"`, `${…}`,
 * `$((…))` and a backtick body — **except** in five places, which this pass keeps byte for byte:
 * inside `'…'` and `$'…'`; in a comment, which runs to its newline; after an escaping `\` (`a\\⏎` is
 * an escaped `\` and a real newline); and in the body of a here-document whose delimiter is quoted.
 * Measured, `printf '[%s]'` under bash 5.3.20 and `/bin/bash` 3.2.57 (PROGRESS § WP-260 has the
 * tables): `$\⏎(printf r)` hands `[r]`, `"$\⏎(printf X)"` `[X]`, `$\⏎'-delete'` `[-delete]`,
 * `$'e\⏎f'` and `'g\⏎h'` keep the pair, `<<EOF⏎x\⏎y⏎E\⏎OF` reads the body `xy` and `E\⏎OF` ends it.
 *
 * **One forward walk, with bash's lexical state.** A command (the line, a `$(…)`, `<(…)` or `>(…)`
 * body) has its own quote state, its own word state — a comment begins only where a word does
 * ({@link WordStart}) — its own parentheses and its own here-documents; `"…"`, `${…}` and
 * `$((…))`/`((…))` nest inside it and each other. A backtick body is read **flat**: bash removes a
 * pair anywhere in it, single quotes, comments and quoted here-documents included (`` `printf '%s'
 * 'a\⏎b'` `` hands `[ab]` in both bashes), keeping only `\\` and `` \` ``. Inside `"${…}"` a single
 * quote is a plain character (`"${x:-'a\⏎b'}"` hands `['ab']`); in `${…}` outside double quotes it
 * quotes. A here-document's delimiter word is read as bash reads it (a continuation removed, quotes
 * and `\` taking off and marking it quoted); at the command's next newline each pending body is read
 * line by line, an unquoted one joined (`\\` kept whole) and compared after the join — with leading
 * tabs off for `<<-`, applied to the joined line as bash applies it (`\tE\⏎OF` ends a `<<-` body,
 * `\tE\⏎\tOF` does not) — and a quoted one kept as it is written.
 *
 * Where the two bashes differ this follows 5.3, whose parser reads a `$(…)` body as a command: a
 * comment in one ends at its newline (3.2 joins `# x \⏎echo d` into the comment) and a quoted
 * here-document's body in one is kept (3.2 joins it). Both differences keep text the readers then
 * read as commands, so the 3.2 reading is the narrower one.
 *
 * **Its callers** are every export of `command-policy.ts` and `unattended-commands.ts` that reads
 * command text (`evaluateCommand`, `decideUnattendedCommand`, `gitBoundaryViolation`,
 * `computesCommandName`, `normaliseCommand`, the `splitCommandSegments` family, the argv and hazard
 * readers), and `parseCommand` again on each text it hands a nested read — a here-document body a
 * shell reads, a `-c` script, an `eval` operand — because the child shell joins its own input. No
 * other code under `packages/domain/src/policies` tests for a `\` followed by a newline
 * (`bash-text.test.ts`'s census refuses one); a pair left in a {@link BashText} is one bash keeps, and
 * every reader reads it as a `\` and a newline.
 */

declare const bashTextBrand: unique symbol;

/** Command text with its line continuations removed as bash removes them ({@link joinLineContinuations}). */
export type BashText = string & { readonly [bashTextBrand]: true };

/**
 * Where an unquoted `#` opens a comment (WP-259, backlogs 661 and 663): only where it **begins a word**
 * (bash manual, *Comments*: "a word beginning with `#`"). That is the text's start, or after a blank
 * (space or tab), a newline, or an operator character the walk read as one — `;` `&` `|` `<` `>`, a
 * `(` and a `)` that closes a subshell, a group, an arithmetic command or a `case` pattern: `ls \⏎#;x`
 * is a comment, `ls a\⏎#;x` the word `a#` and then `x` (measured, bash 5.3.20 and 3.2.57) — read on
 * the joined text, where they are `ls #;x` and `ls a#;x`. A `)` that closes `$(`, `$((`, `<(`, `>(`
 * or an array assignment (`a=(…)`) ends no word, nor does a quoted, escaped or expanded character,
 * nor `\r`, `\v`, `\f` or a non-ASCII space, which bash keeps inside a word: `$(echo a)#`, `a\ #`,
 * `"a"#` and `a\r#` are each one word (measured).
 *
 * The state is carried **forward** by the walk that reads the text, never read off a peek backward:
 * `a\\⏎#` is an escaped `\` and then a real newline, so its `#` is a comment. Its readers, each
 * carrying one: {@link joinLineContinuations} (which keeps a comment whole), and in
 * `command-policy.ts` `scan`, `findClosingParen` (its `#` and its `case` word) and
 * `readShellContext` (its comment ranges and its here-document refusal). `scan` adds one piece of
 * its own: a `#` glued to a substitution it lifts out of the segment text is written `\#` there,
 * because the pipe pass and `feedsScriptReader` read that text and would see a blank before it (`ls
 * $(x)#|sudo id` is `ls #|sudo id` with the substitution lifted).
 */
export interface WordStart {
  /** Whether the next character begins a word. */
  atWordStart: boolean;
  /** The last character read as itself (`''` after a quoted, escaped or expanded unit). */
  last: string;
  /** Per open `(`: whether its `)` ends a word (a subshell or group did not start inside a word). */
  readonly closesWord: boolean[];
}

export const wordStart = (): WordStart => ({ atWordStart: true, last: '', closesWord: [] });

/** bash's blanks, its newline and its operator characters (`(` and `)` are read apart). */
const WORD_BREAK = /[ \t\n;&|<>]/;

/** The state after the walk reads the unquoted, unescaped character at `index` as itself. */
export const readWordCharacter = (state: WordStart, text: string, index: number): void => {
  const char = text[index] as string;
  if (char === '(') {
    state.closesWord.push(state.atWordStart && state.last !== '<' && state.last !== '>');
    state.atWordStart = true;
  } else if (char === ')') {
    state.atWordStart = state.closesWord.pop() ?? true;
  } else {
    state.atWordStart = WORD_BREAK.test(char);
  }
  state.last = char;
};

/** The state after a unit that stays inside a word: a quoted or escaped character, an expansion. */
export const readInsideWord = (state: WordStart): void => {
  state.atWordStart = false;
  state.last = '';
};

/** A here-document opened on the line being read, waiting for the line's newline. */
interface PendingBody {
  readonly delimiter: string;
  readonly quoted: boolean;
  readonly stripTabs: boolean;
}

type Frame =
  | {
      readonly kind: 'command';
      readonly words: WordStart;
      /** Open `(` of subshells and groups inside this command. */
      parens: number;
      /** `case` words not yet closed by `esac`: a `)` then closes a pattern, not the command. */
      cases: number;
      pending: PendingBody[];
      /** Whether a `)` closes this command (a `$(…)`, `<(…)` or `>(…)` body). */
      readonly closes: boolean;
    }
  | {
      readonly kind: 'arithmetic';
      /** `)` for `$((…))` and `((…))`, `]` for `$[…]`. */
      readonly closer: ')' | ']';
      parens: number;
      readonly expansion: boolean;
    }
  | { readonly kind: 'parameter'; braces: number; readonly quoted: boolean }
  | { readonly kind: 'double' };

const commandFrame = (closes: boolean): Frame => ({
  kind: 'command',
  words: wordStart(),
  parens: 0,
  cases: 0,
  pending: [],
  closes,
});

/** A metacharacter, which ends a here-document's delimiter word. */
const DELIMITER_END = /[ \t\n;&|()<>]/;

/**
 * `raw` as bash reads it, every line continuation outside the kept regions removed (module
 * docblock). Idempotent: what it leaves is only what bash keeps.
 */
export const joinLineContinuations = (raw: string): BashText => {
  if (!raw.includes('\\\n')) {
    return raw as BashText;
  }
  let out = '';
  let index = 0;
  const frames: Frame[] = [commandFrame(false)];
  /** The one test for a line continuation under `policies/`. */
  const continuationAt = (at: number): boolean => raw[at] === '\\' && raw[at + 1] === '\n';
  /** Where `token` ends when it is the text at `at` with continuations removed, or -1. */
  const opens = (at: number, token: string): number => {
    let cursor = at;
    for (const char of token) {
      while (continuationAt(cursor)) {
        cursor += 2;
      }
      if (raw[cursor] !== char) {
        return -1;
      }
      cursor += 1;
    }
    return cursor;
  };
  /** The next `count` characters at `at` with continuations removed. */
  const ahead = (at: number, count: number): string => {
    let text = '';
    let cursor = at;
    while (text.length < count && cursor < raw.length) {
      if (continuationAt(cursor)) {
        cursor += 2;
      } else {
        text += raw[cursor];
        cursor += 1;
      }
    }
    return text;
  };
  /** Copies `raw[from, to)` as written. */
  const keep = (from: number, to: number): void => {
    out += raw.slice(from, to);
  };
  /** A `'…'` from the quote at `at`, kept whole; returns where the walk resumes. */
  const singleQuoted = (at: number): number => {
    const close = raw.indexOf("'", at + 1);
    const end = close === -1 ? raw.length : close + 1;
    keep(at, end);
    return end;
  };
  /** A `$'…'` body from `at` (after the opener), kept whole; `\` escapes the next character. */
  const ansiC = (at: number): number => {
    let cursor = at;
    while (cursor < raw.length && raw[cursor] !== "'") {
      cursor += raw[cursor] === '\\' ? 2 : 1;
    }
    const end = Math.min(cursor + 1, raw.length);
    keep(at, end);
    return end;
  };
  /** A backtick body from the backtick at `at`, read flat; returns where the walk resumes. */
  const backtick = (at: number): number => {
    out += '`';
    let cursor = at + 1;
    while (cursor < raw.length) {
      if (continuationAt(cursor)) {
        cursor += 2;
      } else if (raw[cursor] === '\\') {
        keep(cursor, cursor + 2);
        cursor += 2;
      } else if (raw[cursor] === '`') {
        out += '`';
        return cursor + 1;
      } else {
        out += raw[cursor];
        cursor += 1;
      }
    }
    return cursor;
  };
  /** A here-document's delimiter word from `at`, joined into `out`; returns its reading. */
  const delimiterWord = (
    at: number,
  ): { readonly end: number; readonly body: PendingBody | null } => {
    let cursor = at;
    let delimiter = '';
    let quoted = false;
    while (cursor < raw.length) {
      if (continuationAt(cursor)) {
        cursor += 2;
        continue;
      }
      const char = raw[cursor] as string;
      if (DELIMITER_END.test(char)) {
        break;
      }
      if (char === '\\') {
        quoted = true;
        delimiter += raw[cursor + 1] ?? '';
        keep(cursor, cursor + 2);
        cursor += 2;
      } else if (char === "'") {
        quoted = true;
        const end = singleQuoted(cursor);
        delimiter += raw.slice(cursor + 1, Math.max(cursor + 1, end - 1));
        cursor = end;
      } else if (char === '"') {
        quoted = true;
        out += '"';
        cursor += 1;
        while (cursor < raw.length && raw[cursor] !== '"') {
          if (continuationAt(cursor)) {
            cursor += 2;
          } else if (raw[cursor] === '\\') {
            const next = raw[cursor + 1] ?? '';
            delimiter += '$`"\\'.includes(next) ? next : `\\${next}`;
            keep(cursor, cursor + 2);
            cursor += 2;
          } else {
            delimiter += raw[cursor];
            out += raw[cursor];
            cursor += 1;
          }
        }
        if (cursor < raw.length) {
          out += '"';
          cursor += 1;
        }
      } else {
        delimiter += char;
        out += char;
        cursor += 1;
      }
    }
    return {
      end: cursor,
      body: delimiter === '' && !quoted ? null : { delimiter, quoted, stripTabs: false },
    };
  };
  /** The bodies pending at the newline before `at`, each up to its terminator line. */
  const bodies = (at: number, pending: readonly PendingBody[]): number => {
    let cursor = at;
    for (const body of pending) {
      while (cursor < raw.length) {
        let line = '';
        if (body.quoted) {
          const newline = raw.indexOf('\n', cursor);
          const stop = newline === -1 ? raw.length : newline;
          line = raw.slice(cursor, stop);
          cursor = stop;
        } else {
          while (cursor < raw.length && raw[cursor] !== '\n') {
            if (continuationAt(cursor)) {
              cursor += 2;
            } else if (raw[cursor] === '\\' && raw[cursor + 1] === '\\') {
              line += '\\\\';
              cursor += 2;
            } else {
              line += raw[cursor];
              cursor += 1;
            }
          }
        }
        out += line;
        if (cursor < raw.length) {
          out += '\n';
          cursor += 1;
        }
        if ((body.stripTabs ? line.replace(/^\t+/, '') : line) === body.delimiter) {
          break;
        }
      }
    }
    return cursor;
  };
  /** An expansion's opener at `at` (`$((`, `$(`, `${`, and outside double quotes `$'`, `$"`), or -1. */
  const dollar = (at: number, quotedParameter: boolean, ansi: boolean): number => {
    let end = opens(at, '$((');
    if (end !== -1) {
      out += '$((';
      frames.push({ kind: 'arithmetic', closer: ')', parens: 0, expansion: true });
      return end;
    }
    // `$[…]`, bash's old arithmetic expansion: a `<<` in it is a shift, never a here-document.
    end = opens(at, '$[');
    if (end !== -1) {
      out += '$[';
      frames.push({ kind: 'arithmetic', closer: ']', parens: 0, expansion: true });
      return end;
    }
    end = opens(at, '$(');
    if (end !== -1) {
      out += '$(';
      frames.push(commandFrame(true));
      return end;
    }
    end = opens(at, '${');
    if (end !== -1) {
      out += '${';
      frames.push({ kind: 'parameter', braces: 0, quoted: quotedParameter });
      return end;
    }
    if (ansi) {
      end = opens(at, "$'");
      if (end !== -1) {
        out += "$'";
        return ansiC(end);
      }
      end = opens(at, '$"');
      if (end !== -1) {
        out += '$"';
        frames.push({ kind: 'double' });
        return end;
      }
    }
    out += '$';
    return at + 1;
  };
  /** The enclosing command's word state after a unit that stays inside its word. */
  const insideWord = (): void => {
    const frame = frames.at(-1);
    if (frame?.kind === 'command') {
      readInsideWord(frame.words);
    }
  };

  while (index < raw.length) {
    if (continuationAt(index)) {
      index += 2;
      continue;
    }
    const frame = frames.at(-1) as Frame;
    const char = raw[index] as string;
    if (char === '\\') {
      keep(index, index + 2);
      index += 2;
      insideWord();
      continue;
    }
    if (char === '`') {
      index = backtick(index);
      insideWord();
      continue;
    }
    if (frame.kind === 'double') {
      if (char === '"') {
        out += char;
        index += 1;
        frames.pop();
      } else if (char === '$') {
        index = dollar(index, true, false);
      } else {
        out += char;
        index += 1;
      }
      continue;
    }
    if (char === "'" && !(frame.kind === 'parameter' && frame.quoted)) {
      index = singleQuoted(index);
      insideWord();
      continue;
    }
    if (char === '"') {
      out += char;
      index += 1;
      insideWord();
      frames.push({ kind: 'double' });
      continue;
    }
    if (char === '$') {
      insideWord();
      index = dollar(
        index,
        frame.kind === 'parameter' && frame.quoted,
        !(frame.kind === 'parameter' && frame.quoted),
      );
      continue;
    }
    if (frame.kind === 'parameter') {
      if (char === '{') {
        frame.braces += 1;
      } else if (char === '}' && frame.braces > 0) {
        frame.braces -= 1;
      } else if (char === '}') {
        frames.pop();
      }
      out += char;
      index += 1;
      continue;
    }
    if (frame.kind === 'arithmetic') {
      if (char === (frame.closer === ')' ? '(' : '[')) {
        frame.parens += 1;
      } else if (char === frame.closer && frame.parens > 0) {
        frame.parens -= 1;
      } else if (char === frame.closer) {
        frames.pop();
        const end = frame.closer === ')' ? opens(index, '))') : -1;
        out += end === -1 ? char : '))';
        index = end === -1 ? index + 1 : end;
        const parent = frames.at(-1);
        if (parent?.kind === 'command') {
          // An arithmetic command's close ends a word; an expansion's does not.
          parent.words.atWordStart = !frame.expansion;
          parent.words.last = ')';
        }
        continue;
      }
      out += char;
      index += 1;
      continue;
    }
    // A command: the line, or a `$(…)`, `<(…)` or `>(…)` body.
    const { words } = frame;
    if (char === '#' && words.atWordStart) {
      const newline = raw.indexOf('\n', index);
      const stop = newline === -1 ? raw.length : newline;
      keep(index, stop);
      index = stop;
      continue;
    }
    if (char === '<' || char === '>') {
      const end = opens(index, `${char}(`);
      if (end !== -1) {
        out += `${char}(`;
        index = end;
        readInsideWord(words);
        frames.push(commandFrame(true));
        continue;
      }
    }
    if (char === '<') {
      const string = opens(index, '<<<');
      if (string !== -1) {
        out += '<<<';
        index = string;
        readWordCharacter(words, '<', 0);
        continue;
      }
      const operator = opens(index, '<<');
      if (operator !== -1) {
        const dash = opens(operator, '-');
        out += dash === -1 ? '<<' : '<<-';
        let cursor = dash === -1 ? operator : dash;
        while (continuationAt(cursor) || raw[cursor] === ' ' || raw[cursor] === '\t') {
          if (!continuationAt(cursor)) {
            out += raw[cursor];
          }
          cursor += continuationAt(cursor) ? 2 : 1;
        }
        const word = delimiterWord(cursor);
        if (word.body !== null) {
          frame.pending.push({ ...word.body, stripTabs: dash !== -1 });
        }
        index = word.end;
        readWordCharacter(words, '<', 0);
        if (word.end > cursor) {
          readInsideWord(words);
        }
        continue;
      }
    }
    if (char === '(' && words.atWordStart && opens(index, '((') !== -1) {
      out += '((';
      index = opens(index, '((');
      readInsideWord(words);
      frames.push({ kind: 'arithmetic', closer: ')', parens: 0, expansion: false });
      continue;
    }
    if (char === '(') {
      frame.parens += 1;
    } else if (char === ')' && frame.parens > 0) {
      frame.parens -= 1;
    } else if (char === ')' && frame.closes && frame.cases === 0) {
      frames.pop();
      out += char;
      index += 1;
      insideWord();
      continue;
    } else if (words.atWordStart && /^case[ \t\n]/.test(ahead(index, 5))) {
      frame.cases += 1;
    } else if (words.atWordStart && /^esac(?:[ \t\n;&|)]|$)/.test(ahead(index, 5))) {
      frame.cases = Math.max(0, frame.cases - 1);
    }
    readWordCharacter(words, raw, index);
    out += char;
    index += 1;
    if (char === '\n' && frame.pending.length > 0) {
      index = bodies(index, frame.pending);
      frame.pending = [];
    }
  }
  return out as BashText;
};
