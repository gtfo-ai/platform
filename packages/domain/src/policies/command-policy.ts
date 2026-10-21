/**
 * The three-list command policy — BD-025, with the shipped defaults from product/19 §3.
 *
 * "Shell commands available to agents follow a **three-list policy**: allow-list (runs), ask-list
 * (requires a human approval via question), block-list (never; resolved against the real binary,
 * not the name). Defaults ship per stage; the organisation sets the maximum autonomy; projects can
 * only narrow it."
 *
 * Five rules. The first four decide; the fifth is what makes the first four safe.
 *
 *  1. **Every fragment the shell would run is evaluated**, not just the line: each element of a
 *     list (`a && b`, `a; b`, `a & b`), each stage of a pipeline, the pipeline as a whole (so
 *     `curl * | sh` still matches), each subshell `( … )`, the body of every command substitution
 *     (`$( … )`, backticks) and process substitution (`<( … )`, `>( … )`), and the script a shell
 *     wrapper is handed (`sh -c '…'`, `eval '…'`, or a here-document a shell reads) — every string
 *     a builtin or a program runs as one, now or later, and `find -exec`'s argv (WP-160, below).
 *     The most restrictive verdict of all wins.
 *  2. **Block patterns match tokens *or* the whole line.** Token matching lets a flag sit anywhere
 *     (`git push --force*` catches `git push origin agentic/x --force`) and lets extra arguments
 *     never escape a ban; the whole-line glob is kept alongside it so the token rule can only ever
 *     *add* coverage. argv[0] is normalised first: leading `VAR=value` assignments and the
 *     wrappers `env`/`exec`/`xargs`/`nice`/shell keywords are peeled off and the binary is
 *     compared by basename, so `FOO=1 /usr/bin/sudo reboot` is a `sudo` command. The tokens are
 *     read twice (WP-198, `argvForms`): as written, and as argv — the parser's words with every
 *     redirection removed and the quotes taken off — so `2>/dev/null sudo id` is a `sudo` command
 *     too; a match on either is a match. Quotes come off **once**, by bash's rule (`unquoteToken`,
 *     WP-242): inside `"…"` a backslash stays unless `$`, a backtick, `"`, `\` or a newline
 *     follows, so `"\--"` is the positional `\--` the program receives and ends no option
 *     reading. The readers of the argv reading take its words as handed, the block-entry
 *     readers too (WP-245, backlog 644), and the wrapper walk `commandNameWalk` (WP-247, backlog
 *     647: `env "\-u" sudo id` hands env the command `\-u`), with two exceptions, both over-asks:
 *     the block-entry readers also read it dequoted a second time (`OVER_READ`: taking that away
 *     moved 930 sweep cells toward `allow`), and a candidate's name is read through `argv0Name`,
 *     which dequotes it (read as handed it moved 3 135: `"'git'" -c core.fsmonitor=x status`, git
 *     boundary → `auto`, where bash runs `'git'`). Not yet read as handed, and not measured: the
 *     peel's wrapper test (`isWrapperToken`, `isAssignment`) and a package runner's subcommand
 *     (`runnerSubcommandAt`), which dequote an argv-reading word again (WP-247's discovered work).
 *     `$"…"` is quoting, not an expansion (WP-244, backlog 643): with no catalogue bash ignores
 *     the `$` and the text is double-quoted, so `$"--script-shell=x"` is that option.
 *     Braces are expanded on the argv reading as bash expands them (WP-243, backlog 642,
 *     `expandBraces`): a comma list and an integer or single-letter sequence, bounded at
 *     `BRACE_EXPANSION_CEILING` words; a brace past it or of a form the port does not read is
 *     `braceExpansion`. Three places read the expansion: the name search in an unknown program's
 *     arguments (`braceWords`, since WP-248, backlog 646, where it was a second expander), the argv
 *     reading (`argvWords`: the block
 *     matcher, the floors, the git boundary's words), and `parseCommand`, which reads a stage whose
 *     braces expand a second time as the words bash makes (review round 2) — so every reader,
 *     the ask list, the sed/awk reader, `find -exec`, `script -c` and `compgen -C` included,
 *     judges `find . {-ok,sudo} id +` as `find . -ok sudo id +`. Both readings are judged and the
 *     union only tightens; the readers of the written words (a command name, a block entry's
 *     word, git's verb) also refuse a brace through `expandsAsName`, and the git boundary asks
 *     what a fragment is made of without the copy (`splitCommandSegmentsAsWritten`). The residual
 *     is expansion (`$x`, `${…}`, `$(…)`, a backtick, a glob), which no dequote reads, and a
 *     `$"…"` word a catalogue the run supplies may translate (TD-030, 2026-10-20).
 *  3. **The allow- and ask-lists stay prefix-anchored globs, and peel far less.** Only the
 *     block-list is generous — being generous with `allow` is how a policy becomes decoration.
 *     `env`-style wrappers are peeled for them; a leading `VAR=value`, `sh -c`, `eval` and `xargs`
 *     are not, because each of those decides what actually runs and the policy has not read it.
 *     **One kind of allow entry is not a glob**: a precise entry (`PRECISE_ALLOW_ENTRIES`, today
 *     only `sed`'s print-range form, backlog 462) is a token grammar for a verb whose argument is
 *     a program, so no glob over it could be safe; it never admits a line with a substitution.
 *  4. **An unmatched command is `ask`, never `allow`** (product/19 §3: "everything else → ask").
 *     Two things floor an otherwise allowed line at `ask`: a redirection that writes to a path,
 *     and an argument on `HAZARDOUS_ARGUMENTS` — the flag that hands an allow-listed verb an
 *     arbitrary command, an arbitrary path to write, or an unread package source. A floor's
 *     options are a declared grammar (TD-030 tier 2), and its single-dash spelling is read by the
 *     rules of its program's own parser (`FLOOR_OPTION_READINGS`, WP-214): git's clusters letter by
 *     letter up to a letter that takes a value, Go's whole.
 *  5. **Parse uncertainty fails closed.** A hand-rolled shell scanner is never complete, so it
 *     says when it is out of its depth (`CommandEvaluation.uncertainty`) and an uncertain line can
 *     never be `allow`. `UNCERTAINTY` lists every construct that trips it; what the scanner still
 *     does not read is named below, under *What it still does not read*, and nowhere else.
 *
 * **A here-document's body is data** (WP-153, PROGRESS backlog 482). `cat > a.php <<'EOF'` followed
 * by PHP is one command, `cat`, and its body is what `cat` reads: no segment, no quote state, no
 * write target and no block-list match comes out of it; the line that opens it is judged as before,
 * redirection included, and the lines after the terminator are commands again. One reader
 * (`readHereDocumentOperator`, `readHereDocumentBodies`) serves the scanner, the substitution
 * matcher and the git boundary's `computesCommandName`. It is written to recognise **only what the
 * shell certainly reads as a here-document** — the cost of missing one is the body read as
 * commands, the cost of inventing one is a line the shell runs and the policy never sees — and three
 * things keep a body from being data: an unquoted delimiter whose body the shell expands, a body
 * that never ends (both uncertain, rule 5), and a body handed to a shell, which is a script and is
 * read as one (rule 1's `sh -c`, `HERE_DOCUMENT_SCRIPT_READERS`). Reading a missed body as commands
 * is not free when its delimiter is unquoted: the shell expands a `$(…)` there that the commands'
 * reading takes for single-quoted text, so such a would-be body is also read as a body for its
 * expansions (`unrecognisedOperator`, WP-158); and a missed body's quotes can pair across bash's
 * terminator and hide what runs after it, so the lines after that terminator are read again from
 * a fresh state, quoted delimiter or not (WP-160 (e), backlog 513). What keeps an operator from
 * being recognised is only what is still open at it — a `${`, `$[`, `((`, `[[`, or a comment on its
 * own line (WP-160 (f)) — and a comment names no script reader.
 *
 * **A variable's text is code in some places** (WP-158, PROGRESS backlog 509). bash evaluates a
 * value as an arithmetic expression — and runs the `$(…)` of an array subscript inside it — in a
 * subscript, an offset, `$[…]`, `((…))`, `let`, an integer variable and a `[[` arithmetic test; as
 * a prompt in `${x@P}`; as a name in `${!x}` and wherever a builtin takes a variable name. So a
 * single-quoted value the scanner reads as data is code to the shell, and every such place is
 * `UNCERTAINTY.evaluatedText` unless its operand is literal (a plain number, a `@`/`*` subscript).
 * Reading a value is never uncertain; evaluating one is. The detector runs wherever the walk does
 * **and** over the words it consumes whole — a redirection's target (review round 1) — on the text
 * as bash reads it, line continuations (`\\` + newline) joined; and a stage's command is found past
 * a wrapper's options (`command -p`, `time -p`, `--`) and `coproc`.
 *
 * **A command handed over as a string is a script** (WP-160, PROGRESS backlog 511). `trap '…' EXIT`,
 * `rbash -c '…'`, `script -qc '…'`, `bash <<<'…'` and `find -exec …` each run a command the line
 * holds as a string or as argv; read as one `trap`, `script` or `find` command, the push or the
 * `sudo` inside was `unattended_auto` (measured, with bash running it). `wrappedScript` reads every
 * such string off the stage's words as written and parses it when it is literal; when it is not —
 * or when the shell will run a stored string later (`PS4`, `PROMPT_COMMAND`, an alias, a callback)
 * or read its script from a pipe or a process substitution — the line is `UNCERTAINTY.handedCommand`
 * (`storesCommand`, and `wrappedScript`'s standard-input reader).
 *
 * **What it reads as uncertain instead** (WP-161, backlog 516–523): more than eight wrappers,
 * assignments or nested substitutions (`UNCERTAINTY.tooDeep`), a command name — or a wrapper's —
 * that is not literal — a parameter or command substitution joined to text, a glob or a brace
 * (`expandedName`, since WP-201 every class `isLiteralWord` names, a bare `~` or `~/…` aside), a name `hash -p` rebinds
 * (`reboundName`), and an `xargs` that hands its input to a wrapper, `find -exec`, `git`, a verb
 * a `command`-kind floor is written for (since WP-164: `make`, `go`, `cargo`, `npm`, `pnpm`,
 * `pytest`, `rg`, and `gmake` since WP-186 — `XARGS_FLOORED_VERBS`), whose floored argument the input can carry, or a script
 * shell whatever its own words (since WP-185), or that replaces a string that is not literal
 * (WP-185) — `xargsArguments`. A line continuation is joined before any word is classified, inside a word
 * as between words (`normaliseCommand`), and git's abbreviated long options are resolved by git's
 * rule (`HAZARDOUS_ARGUMENTS`).
 *
 * **A program the policy does not know may be a wrapper** (WP-203, backlog 599): one no `allow` or
 * `ask` entry of the stage's policy begins with, on no wrapper set, no shell or package runner, with
 * no floor and no reader, and not on the valve of cited non-wrappers (`KNOWN_NON_WRAPPERS`). Every
 * argument of it is a command-position word, so one holding a judged name — a wrapper, a shell, a
 * package runner, `git` or a block entry's first token, read with its quotes off, split on
 * operators and its braces expanded (`fakeroot sudo id`, `parallel git push ::: origin`,
 * `sg grp 'git push origin main'` were `unattended_auto`) — is uncertain (`unknownProgramReasons`).
 * One the shell expands is not read (WP-207, backlog 603: the residual below). The run image's own
 * wrappers are on the sets with their grammar: `chroot`, `setpriv`, `setarch`, `prlimit`, `runcon`,
 * `start-stop-daemon`, `ssh-agent`, `fstab-decode`, `choom` and the rest on `ARGV0_WRAPPERS`, the
 * dynamic loader by its name pattern (`DYNAMIC_LOADER_NAME`), `sg` and `script -c` read as a handed
 * script, `newgrp` as a shell on its input, and a wrapper that runs `$SHELL` when it is given no
 * command (`linux64`, `setarch`, `unshare`, `chroot`, …) as a shell on its input too (backlog 602).
 *
 * **A name glued into an argument is read, and a list knows a program only where it matches**
 * (WP-206, backlog 604: `tar --to-command='git push origin main'`, `sed 's/x/git push/e'` and
 * `ssh -o ProxyCommand=…` were `unattended_auto`, and the first two ran in the run image). The
 * scan reads a name between boundaries (`NAME_BOUNDARY`: any character outside `[A-Za-z0-9._-]`),
 * a part by its last `/`-segment (a URL's `…/git/refs` is `refs`), the argument as written too with
 * each parameter expansion a boundary and a `${v:-w}` word as text (`expansionsAsBoundaries`), and
 * a short option's attached value and sed's glued `e` command, behind an address and its `I`/`M`
 * modifiers (`gluedReadings`), and the argument **joined**, every backslash, quote, empty splice
 * and expansion's syntax deleted (`"g\\it"`, `${x-g}it`, `g$''it`), and every command
 * substitution too (`g$(:)it`, `substitutionsDeleted`), where a part holding a glob
 * is a pattern that counts if it could match a judged name (`joinedNameIn`). An `allow`/`ask` entry makes its program
 * known only on a line it admits (`knownProgram`), so `sed` off `sed -n '<N>[,<M>]p'` is scanned;
 * the wrappers, shells, runners, readers, floored names and the valve stay known by name, and a
 * census holds every default list's first token on exactly one of the two readers.
 *
 * **A `sed` or awk script that can run a command is uncertain whatever its input** (WP-210, backlog
 * 605: `echo 'git push origin main' | sed 's/^//e'` and `| awk '{system($0)}'` were
 * `unattended_auto`). The reader is coarse and fails closed (`scriptExecutesReasons`): sed's `e`
 * command and `s` flag, whatever the delimiter, awk's `system` and a pipe beside `print`, `printf`
 * or `getline`, and a script it cannot read (a file, an expansion, a sed script it cannot walk).
 * Not read: gawk's `@include "f"` and `@load`, an indirect call (`@f($0)`), and the names
 * `original-awk` and `gsed`, and a `sed` or awk behind any program the policy does not know
 * (`strace -f`, `eatmydata`, `rlwrap`, `faketime 0`, `parallel` — WP-210's round-2 review; latent where
 * the program is absent, and the image's awk is mawk 1.3.4). Tier 3 and unchanged (TD-030): a composing interpreter's inline script (`python3 -c`, `node -e`,
 * `perl -e`, `ruby -e`, `php -r`) keeps WP-206's literal read (Q121), and `git -C <dir>` or
 * `cd <dir>; git …` into a repository the run wrote keeps its cell (backlog 587).
 *
 * **What it still does not read:** a script in a file (`bash file`, `bash < file`, `. ./x.sh`,
 * `run-parts dir`, `scriptlive` — a file the run wrote, backlog 481's residual and the unattended
 * module's, and `--to-command=./x.sh` over one; `sed -f`, `awk -f` and a `sed … e` over a file are
 * uncertain since WP-210), a name a script composes
 * (`"gi"+"t"`, `getattr(os, "sys"+"tem")`: since WP-206 a judged name written in an
 * interpreter's or a tool's script is uncertain, glued or not), the script of a runner known by
 * name (`bun -e '…'`: a package runner's arguments are not scanned), a name glued by a name's own
 * characters (`s.git.`, `legit`), a command a
 * program assembles from its input where no string on the line names it (`cat cmds | parallel`;
 * and `xargs` feeding a known command that is not a wrapper, `find -exec`, `git`, a shell or a verb
 * a `command`-kind floor names — WP-164 made `xargs make`, whose input can name assignments and
 * `--eval` as well as targets, uncertain), an argument the shell expands given to a program the policy does not know
 * (`frobnicate $x id`, `find -exec frobnicate {}`, `xargs frobnicate` — WP-207: the non-literal half refused
 * 80 of 286 ordinary agent lines, 38 of them `"$f"` alone, no syntactic narrowing recovers them
 * without reopening the class, and a wrapper the image ships is listed by name, so a wrapper the
 * image does not ship, handed an expansion, is the sandbox's: BD-025, 2026-10-06, decision 1),
 * a project's own wide entry (`tar *` admits `tar --to-command`: its allow entry is its door), a
 * `$'…'` string or a `$"…"` word a catalogue the run supplies may translate, a prompt variable
 * or an alias set by a start-up file, an option's value attached to its option (`read -aNAME`), a name taken by a
 * builtin it does not list (`getopts`, `wait -p`, `exec {var}>…`), an attribute (`-i`, `-n`) given
 * to a variable outside the line, a name bound outside the line (`hash -p` in an earlier call, if
 * the CLI's Bash tool keeps a shell — not measured), and the leading operand of a wrapper that
 * `WRAPPER_OPERAND` does not list when a globbed command name follows it (an option's value is
 * always read as one — backlog 531 — and the operand of `timeout`, `taskset`, `chrt`, `flock`, `su`
 * and `runuser` whatever its shape, WP-161 review round 2).
 *
 * **Quoting is honoured in one place and ignored in the other, on purpose.** The scanner
 * (`scan`, and so the redirection floor) honours it: `ls "> out"` is not a redirection, because
 * quoting is exactly what stops the shell reading `>` as an operator. Token classification
 * (`splitFlags`, and so the block-list and `HAZARDOUS_ARGUMENTS`) ignores it: `git fetch
 * "--upload-pack=x"` *is* that flag, because quoting decides how a line is split into words and
 * never what a program sees inside one word.
 *
 * The price is not paid by that rule but by `tokenise`, which splits on whitespace with no idea
 * of quoting: `git commit -m "add --output-file"` is *one* word to bash and git never sees a flag
 * at all, but `tokenise` makes `"add` and `--output-file"` two tokens and `unquoteToken` then
 * takes the orphan quote off the second, leaving something that classifies as a flag. So the line
 * floors at `ask`. Measured against 54 177 real commit subjects that costs three of them
 * (0.006 %), and ` -n` never occurs at all, so the floor is left alone. **The correct fix is to
 * make `tokenise` quote-aware**, which removes the false positive without weakening any bypass
 * case; it is a behaviour change on the security path and is deliberately not made in this round
 * (recorded in `docs/technical/PROGRESS.md`).
 *
 * Binary resolution ("the real binary, not the name") is I/O and is done by the caller, which
 * passes the resolved path as `resolvedBinary`; its *basename* is checked against the block-list's
 * whole-binary bans and substituted for argv[0]. The enforcing hook lives in the runner (WP-12).
 */
import type { CommandPolicy, UnattendedCommandMode, VerificationMode } from '@platform/contracts';
import { DEFAULT_UNATTENDED_COMMAND_MODE } from '@platform/contracts';
import { PolicyViolationError } from '../errors.js';
import { GIT_LONG_OPTIONS, type GitLongOptionTable } from './git-long-options.generated.js';

export type CommandVerdict = 'allow' | 'ask' | 'block';

const VERDICT_RANK = { allow: 0, ask: 1, block: 2 } as const satisfies Record<
  CommandVerdict,
  number
>;

const mostRestrictive = (a: CommandVerdict, b: CommandVerdict): CommandVerdict =>
  VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;

/** A policy with all three lists present — what `narrowCommandPolicy` produces. */
export interface ResolvedCommandPolicy {
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly block: readonly string[];
}

/**
 * How many words the brace expansions of one text may make before the argv reading stops reading
 * them (WP-243): the largest committed corpus line makes 2, and 256 leaves room for any line a
 * person writes while bounding what a line can cost (`{1..100000}` is `braceExpansion`).
 */
export const BRACE_EXPANSION_CEILING = 256;

/**
 * The constructs the scanner refuses to reason about. Each one floors the verdict at `ask`: the
 * line may be perfectly innocent, but the scanner cannot prove it, and a policy that guesses in
 * the permissive direction is worse than one that asks.
 */
export const UNCERTAINTY = {
  unbalancedQuote: 'a quote is never closed',
  /**
   * WP-243 (backlog 642): the argv reading expands braces as bash does (`expandBraces`), bounded.
   * A brace it does not read, or one that makes more words than the ceiling, is this — never
   * `allow`, because the words the program receives are then unknown.
   */
  braceExpansion: `a brace expansion the platform does not read (a zero-padded or mixed-case range, a range bash leaves as written, or more than ${BRACE_EXPANSION_CEILING} words made by expansion) — write the words out; the platform reads a comma list ({a,b}) and an integer or single-letter range ({1..3}, {a..c})`,
  unterminatedSubstitution: 'a command or process substitution is never closed',
  /**
   * WP-251 (backlog 651): the substitution matcher (`findClosingParen`) has no `case` pattern and
   * no comment state, so a pattern's `)` or a `)` in a comment closed `<(…)`/`$(…)` early and a
   * git option after it went unseen. bash 5.3.20 and 3.2.57 disagree on both constructs
   * (measured), so the body is not read rather than parsed one bash's way.
   */
  unreadSubstitutionBody:
    'a command or process substitution whose body holds a case command or a comment, where the shells disagree on which ) closes it — move the case or the comment out of the substitution; the platform does not read a substitution body that holds either',
  unterminatedBacktick: 'a backtick substitution is never closed',
  ansiCQuoting: "ANSI-C quoting ($'…'), whose escapes change what the shell sees",
  arithmetic: 'arithmetic expansion ($((…))), whose result can become a command',
  /** WP-153 (e): the body runs to the end of the line, so where the commands resume is unknown. */
  unterminatedHereDocument:
    'a here-document whose terminator never comes (the closing line must be the delimiter alone — no leading spaces, no trailing space)',
  /**
   * WP-153 (d): an **unquoted** delimiter lets the shell expand the body. A substitution there runs
   * a command, and a line ending in a backslash is joined to the next before bash compares it with
   * the delimiter (measured: bash 5.2 ends `<<EOF` at `E\` + `OF`), so the body may end before the
   * line the scanner reads as its terminator. `$VAR` alone is not on this list; an expansion that
   * evaluates a variable's text is `evaluatedText` (WP-158).
   */
  hereDocumentExpansion:
    "a here-document with an unquoted delimiter whose body the shell expands (a $(…) or backtick substitution, or a line ending in a backslash) — quote the delimiter, <<'EOF', so the body is plain text",
  /**
   * WP-158 (backlog 509): bash evaluates a variable's **text** as an arithmetic expression — and
   * an array subscript inside it runs its `$(…)` — in a subscript, an offset, `$[…]`, `((…))`,
   * `let`, an integer or nameref variable and a `[[` arithmetic test, and as a prompt string in
   * `${x@P}`. So `x='b[$(cmd)]'; echo ${y[x]}` runs `cmd` behind a single-quoted assignment
   * (measured, bash 5.2.37 and 3.2.57; dash runs none of them). The detector is
   * `evaluatesVariableText` (expansions) and `stageEvaluatesText` (commands); the only exemptions
   * are literal — a plain decimal number, a `@`/`*` subscript — and each is backed by the shell.
   */
  /**
   * WP-160 (backlog 511): a command handed over as a **string** the platform cannot read — a trap
   * action, an `eval`/`sh -c`/`script -c` script that is not literal, a prompt or hook variable
   * (`PS4`, `PROMPT_COMMAND`, …), an alias, a callback (`mapfile -C`, `bind -x`, `complete -C`,
   * `fc`), or a script a shell reads from a pipe or a process substitution. A literal one is read
   * as a script instead (`wrappedScript`); these are what is left.
   */
  handedCommand:
    'a command handed over as a string — a trap action, an eval or sh -c script that is not literal, a prompt or hook variable (PS4, PROMPT_COMMAND), an alias, a callback (mapfile -C, bind -x, complete -C or -W, fc), or a script piped or process-substituted into a shell — write the command itself; the platform cannot read a command stored in a trap, a prompt, an alias or a callback',
  evaluatedText: `an expansion or command that evaluates a variable's text as code (a subscript or offset that is not a plain number, \${x@…}, \${!x}, $[…], ((…)), let, declare -i or -n, a [[ … -eq … ]] or -v test, a variable name built from an expansion) — write the value literally; the platform cannot read an expansion that evaluates a variable's text`,
  /**
   * WP-161 (d), backlog 516: past {@link MAX_WRAPPER_DEPTH} the argv peel and the substitution walk
   * stop reading, so a command behind a ninth wrapper or assignment, or inside a substitution nested
   * past the bound, was judged by nothing. Each site now says so instead (rule 5).
   */
  tooDeep:
    'more than eight wrappers, assignments or nested substitutions in front of a command — write the command with fewer wrappers, assignments or nested substitutions; the platform reads eight',
  /**
   * WP-161 (f), backlog 518: a command word holding an unquoted `*`, `?`, `[` or a brace expansion
   * (`,` or `..`) is a name the shell expands — `/usr/bin/g[i]t` ran git 2.47.3 in the run image —
   * so the block list and the git boundary, which match the name as written, never saw it.
   * WP-201 (backlogs 591, 593): a parameter or command substitution too (`su$x id`, `su"$@"` in a
   * `-c` script, `g$(echo it) push`), at every command-name word of every stage, handed scripts
   * included, with **no** exemption — the glob-named shell WP-160 read (`/bin/[r]bash -c …`) is
   * uncertain as well. The one word kept out is exactly one expansion where a reader reads it
   * (`expandsCommandName`): the first name of a top-level stage, which the git boundary refuses as
   * computed (`$GIT push …`), and a `-c` script's `"$@"`, whose operands are read as a command.
   */
  expandedName:
    "a command name the shell expands — a variable or command substitution joined to other text, a glob (*, ?, [) or a brace expansion ({a,b}, {a..b}) — write the command's name literally; the platform cannot read a name the shell expands",
  /** WP-161 criterion (12), backlog 522: `hash -p FILE NAME` makes `NAME` run `FILE`. */
  reboundName:
    'hash -p, which binds a command name to another program — run the program by its own name; the platform reads a command by the name it is written with',
  /**
   * WP-161 criterion (13), backlog 523: `xargs` appends the words it reads to its command, so a
   * command that runs its arguments — a wrapper, `find -exec`, `git` — runs what the pipe said.
   * WP-164 (backlog 530): so does a verb a `command`-kind floor names, given the floored argument
   * by the pipe; the verbs listed here are held to `XARGS_FLOORED_VERBS` by a unit test.
   * WP-185 (backlogs 561, 562): so does a script shell, whatever its own words — its `-c`, its
   * script and its positional parameters can all arrive from the input — and a replace string
   * (`-I`) that is not literal, whose text the platform cannot know.
   */
  xargsArguments:
    'xargs handing the words it reads from its input to a command that runs its arguments (a wrapper such as env, nice, nohup or timeout, a shell such as sh or bash, a package runner such as npx, pnpx, yarn, bun, bunx or corepack, find with -exec, or git) or that a refused argument would make run a program (cargo, gmake, go, make, npm, pnpm, pytest or rg, or a name beginning with one), or replacing a string (-I) that is not literal — write the command and its arguments on the line; the platform cannot read arguments xargs supplies from its input',
  /**
   * WP-188 review round 1: `npx -c '<string>'`/`--call=<string>` runs the string in a shell. It is
   * never read as a script — the closed rule (rule 65), in every spelling (`runnerCallsString`).
   * WP-196 (backlog 575): every package runner's exec form — `npm exec`/`x`, `pnpm exec`/`dlx`
   * (`-c`/`--shell-mode`), `pnpx`, `yarn dlx`/`exec`, `bun x`, `bunx` — under the same reader.
   */
  npxCall:
    'a package runner given -c, --call or --shell-mode (npx, npm exec, pnpm exec or dlx, and the rest), which runs a string in a shell — run the command itself; the platform does not read the string a package runner hands to a shell',
  /**
   * WP-196 review round 1: a package runner whose subcommand the platform cannot determine exactly
   * (`yarn workspaces foreach … exec`) is never read as a command that runs nothing. WP-211 review
   * rounds 1 to 3: a Composer command word that is not exactly a canonical built-in name — an alias too (`composer x`,
   * `composer test`, `composer ex`), which Composer may run as a `composer.json` script.
   */
  runnerSubcommand:
    'a package runner whose subcommand the platform cannot determine (yarn workspaces …, or a composer word that is not exactly a canonical built-in command), which may run a command — run the command itself; the platform reads a package runner only where it knows what it runs',
  /**
   * WP-196 review round 2 (backlog 579): `npm explore <pkg> -- <words>` joins its words into one
   * string and runs it in a shell (npm 11 `lib/commands/explore.js`), and `bun exec '<string>'` runs
   * its string in Bun Shell. The string is never read.
   * WP-211: `composer run-script`/`run` hands a `composer.json` script to a shell (backlog 606), and
   * Yarn 1's `create` joins every word after the starter kit's name into one shell string (backlog
   * 581, `yarnCreateHandsString`).
   */
  runnerString:
    'npm explore, bun exec, composer run-script or yarn create, which runs its words as a string in a shell — run the command itself; the platform does not read the string a package runner hands to a shell',
  /**
   * WP-210 (backlog 605): a `sed` or awk script holding an execution primitive runs text as a shell
   * command — its own, or its input's (`echo … | sed 's/^//e'`) — so it is uncertain whatever its
   * input; and so is a script the platform cannot read (`-f`, one the shell expands, a sed script it
   * cannot parse). `scriptExecutesReasons` is the reader.
   */
  scriptExecutes:
    "a sed or awk script that can run a command — sed's e command or the e flag of s, awk's system(), a pipe into getline or a print or printf into a pipe — or one the platform cannot read (a script file, a script the shell expands, a sed script it cannot parse) — write the edit without e, system or a pipe, and run a command itself; the platform does not read what a sed or awk script runs",
} as const;

/**
 * WP-197 (backlog 576): the one reason that names something — the block entry an `xargs` could
 * complete from its input (`xargs gh` against `gh release *`, `echo apply | xargs terraform`
 * against `terraform apply`). Only some completions match, so the honest verdict is uncertain, not
 * `block` (`xargsBlockPrefix`); under `auto` both are `deny` (BD-025's 2026-10-06 amendment,
 * decision 2).
 */
export const xargsCompletesBlockEntry = (entry: string) =>
  `xargs handing the words it reads from its input to a command that the block-list entry "${entry}" names, whose remaining words the input could supply — write the command and its arguments on the line; the platform cannot tell whether the input completes a command no run may execute` as const;

/**
 * WP-198 (backlog 584): the block entry a line matches only when a word after an option written
 * with no `=` is that option's value (`gh -R o/r release create v1` against `gh release *`). The
 * platform does not know which options take a value, so the honest verdict is uncertain, as for
 * {@link xargsCompletesBlockEntry} (`blockEntryBehindFlagValue`).
 */
export const flagValueHidesBlockEntry = (entry: string) =>
  `a word after an option written with no "=", which, read as that option's value, leaves a command that the block-list entry "${entry}" names — write the option as --option=value; the platform does not know which options take a value` as const;

/**
 * WP-201 (backlog 591's measurement): the block entry a line could match once a word the shell
 * expands is expanded (`terraform ap$x` against `terraform apply`, `rm -rf $x` against `rm -rf /*`,
 * `gh rel{e,}ase` against `gh release *`). The words before it are a proper prefix of the entry and
 * the platform cannot know what the expansion yields, so the honest verdict is uncertain, as for
 * {@link xargsCompletesBlockEntry} (`blockEntryBehindExpansion`).
 */
export const expansionCompletesBlockEntry = (entry: string) =>
  `a word the shell expands (a variable or command substitution, a glob or a brace) where the block-list entry "${entry}" names a word — write the word literally; the platform cannot tell whether the expansion completes a command no run may execute` as const;

/**
 * WP-204 (backlog 598, ruling (b)(iii)): a line that meets every operand of a block entry and
 * writes an option while the entry's own options are not all met (`rm -Rf /` against `rm -rf /*`,
 * `git branch --delete --force main` against `git branch -D *`). Whether that option is the
 * entry's by another name is a per-program fact the platform does not have, so the honest verdict
 * is uncertain, as for {@link xargsCompletesBlockEntry} (`blockEntryUnderUnreadOption`).
 */
export const optionMayBeBlockEntry = (entry: string, option: string) =>
  `an option, ${option}, beside the operands of the block-list entry "${entry}", which may be that entry's option by another name — write the entry's own option letters, or run the command without the option; the platform does not know which options of a program are aliases of each other` as const;

/**
 * WP-199 (backlog 583), formerly WP-196's `npmEnvironment`: a word naming an environment variable
 * a `command`-kind floor declares (`HazardousArgument.environment` — `npm_config_*`,
 * `NODE_OPTIONS`, `EDITOR`, `MAKEFLAGS`, `GOFLAGS`, `PYTEST_ADDOPTS`, `CARGO_*`, …), wherever it
 * stands and whatever the command (`FLOOR_ENVIRONMENT`). The reason names the verb of the floor the
 * word spells.
 */
export const environmentSpellsFloor = (verb: string) =>
  `a word naming an environment variable ${verb} reads for an option the platform floors, which can hand ${verb} a program or configuration to run — run the command without it, or write the option on the line, where the floor reads it; to search for the name, use the Grep tool; the platform does not read settings a line puts in the environment` as const;

/**
 * WP-200 (backlog 585): a git configuration key a run sets — `-c`, attached `-c<key>`,
 * `--config-env`, `git clone -c` or a `git config` write — that is neither one the git boundary
 * guards (`isGuardedGitConfigKey`) nor on its inert list (`INERT_GIT_CONFIG_KEYS`). Nobody read what
 * the key does, so the line is uncertain rather than refused for a stated effect. The git boundary
 * reports it (`gitBoundaryViolation`); `evaluateCommand` does not.
 */
export const unreadGitConfigKey = (key: string) =>
  `a git configuration key, \`${key}\`, set for the command — git runs a program, reads a file or reaches a host through many keys, and the platform reads only a short list of keys that do none of these (user.name, user.email, color.*, …) — run the command without it; the platform does not read what a git configuration key does` as const;

/**
 * WP-203 (backlog 599), the literal half: an argument of a program the policy does not know holds a
 * name that runs a command (`fakeroot sudo id`, `catchsegv git push origin main`). Such a program
 * may be a wrapper, which would run it (`unknownProgramReasons`).
 */
export const unknownProgramRunsJudgedName = (program: string, name: string) =>
  `an argument naming ${name} given to ${program}, a program the platform does not know — it may run its arguments as a command, as sg, chroot or fakeroot do — run the command itself, not through ${program}; the platform judges a command only where it knows the program in front of it` as const;

export type UncertaintyReason =
  | (typeof UNCERTAINTY)[keyof typeof UNCERTAINTY]
  | ReturnType<typeof environmentSpellsFloor>
  | ReturnType<typeof unreadGitConfigKey>
  | ReturnType<typeof xargsCompletesBlockEntry>
  | ReturnType<typeof flagValueHidesBlockEntry>
  | ReturnType<typeof expansionCompletesBlockEntry>
  | ReturnType<typeof optionMayBeBlockEntry>
  | ReturnType<typeof unknownProgramRunsJudgedName>;

/**
 * product/19 §3, "Block (all stages)". These are the entries the organisation maximum starts from
 * and that no project can remove — `narrowCommandPolicy` only ever adds to `block`.
 */
export const DEFAULT_BLOCKED_COMMANDS: readonly string[] = [
  'rm -rf /*',
  'git push --force*',
  // The spellings of the two `git push` bans that the document states in one form each. They are
  // written out rather than left to Q37 because — unlike `rm -fr /` — each of them was reachable
  // from the **allow**-list: `git push origin agentic/*` allows the agent to push its own branch,
  // and `-f`, `-d` and `--delete` ride along on exactly that line (all three verified `allow`
  // before this list grew). See `DECLINED_BLOCK_VARIANTS` for where the line is drawn.
  'git push -f*',
  'git push origin :*',
  'git push --delete*',
  'git push -d*',
  'git push origin +*',
  'git branch -D *',
  'git reset --hard origin/*',
  'docker *',
  'sudo *',
  'curl * | sh',
  'wget * | sh',
  'npm publish',
  'pip upload',
  'gh release *',
  'glab release *',
  'kubectl *',
  'terraform apply',
];

/**
 * Two spellings of product/19 §3's block list that the list does not write, and the verdict each
 * gets (WP-204, backlog 598). They were *declined* while an unlisted spelling could only land on
 * `ask`; since BD-025's 2026-10-06 amendment an unattended `auto` run runs an `ask`, so the block
 * list is what keeps them out, and the block matcher reads an entry by getopt's own rules instead
 * of by its spelling: a letter cluster by its letters, an operand wherever it stands
 * (`entryFlagsMet`, `entryOperandsMet`), and an option it cannot read beside the entry's operands
 * as `uncertain` (`blockEntryUnderUnreadOption`), which an unattended run refuses (BD-025,
 * decision 2). `verdict` is the `decideUnattendedCommand` rule on `spelled`, held there by a unit
 * test.
 *
 * **The line WP-02a drew still holds for patterns:** no spelling is invented here as a new entry —
 * `git push -f`, `git push … --delete` and `git push origin +…` became entries because the allow
 * entry `git push origin agentic/*` carried them; these two are read from the entries that exist.
 */
export const DECLINED_BLOCK_VARIANTS = [
  {
    hazard: 'recursive delete with the flags spelled differently — `rm -fr /`, `rm -r -f /`',
    stated: 'rm -rf /*',
    spelled: 'rm -fr /',
    verdict: 'block',
    why: 'getopt reads `-fr` as `-f -r`, which meets the entry’s `-rf` letter by letter (WP-204 (b)(i))',
  },
  {
    hazard: 'branch deletion in long form — `git branch --delete --force main`',
    stated: 'git branch -D *',
    spelled: 'git branch --delete --force main',
    verdict: 'uncertain',
    why: 'the line meets the entry’s operand and writes options the platform cannot read as `-D` or not (WP-204 (b)(iii)); a push of the deletion is also refused by the git boundary',
  },
] as const;

/**
 * The two entries of product/19 §3's block list that no command pattern can express, and where
 * they are actually enforced. Kept here so the gap is visible rather than silently missing.
 */
export const UNPATTERNABLE_BLOCK_ITEMS = [
  {
    item: 'any command writing outside the workspace',
    enforcedBy:
      'the run container: the workspace is the only writable mount (TD-021), plus the path-guard hook (WP-12). This module approximates it by flooring a redirection that writes to a path at `ask`.',
  },
  {
    item: 'network calls to non-allow-listed hosts',
    enforcedBy:
      'the per-run egress proxy on the `internal` network (TD-021); a command pattern cannot see the host a tool dials.',
  },
] as const;

/**
 * An allow entry that is **not a glob**: a named grammar the policy checks token by token (PROGRESS
 * backlog 462). A glob over a verb whose script is a program — `sed -n *` — admits
 * `sed -n '1e rm -rf /' f` and `sed -n 1p f -i`, so a verb like that reaches `allow` only through a
 * precise matcher, and anything its grammar does not spell falls through to the `ask` fallback.
 *
 * The entry's `entry` string is what sits in an allow list (and in the effective-configuration
 * DTO), so a project or organisation narrows it like any other entry: listing it verbatim in `ask`
 * or `block` removes it from `allow`, and an organisation `allow` that does not list it verbatim
 * removes it from every run. It is never matched as a glob.
 */
export interface PreciseAllowEntry {
  /** The name the entry has in an allow list. Never matched as a glob. */
  readonly entry: string;
  /**
   * A glob every line the grammar admits also matches. Only its specificity is used, so the entry
   * ties with an ask entry exactly as the glob would — never more specific than its envelope.
   */
  readonly envelope: string;
  /** Decides on the line's **written** tokens (`tokenise`, quoting still on). */
  readonly admits: (tokens: readonly string[]) => boolean;
}

/** One sed address: a line number, or `$` (the last line) — the second only inside single quotes. */
const SED_PRINT_SCRIPT_UNQUOTED = /^\d+(?:,\d+)?p$/;
const SED_PRINT_SCRIPT_DOUBLE_QUOTED = /^"\d+(?:,\d+)?p"$/;
const SED_PRINT_SCRIPT_SINGLE_QUOTED = /^'(?:\d+|\$)(?:,(?:\d+|\$))?p'$/;

/**
 * An input file the sed grammar accepts: a plain word the shell hands on unchanged, and never one
 * that reads as an option. No quote, `$`, backtick, backslash, glob (`* ? [`), brace or tilde, so
 * nothing the shell expands can put a word in front of sed that the policy did not read.
 */
const SED_PLAIN_FILE = /^[A-Za-z0-9_./@%+=:,][A-Za-z0-9_./@%+=:,-]*$/;

/** A redirection that sends output nowhere: to `/dev/null`, or a descriptor duplicated or closed. */
const SED_NOWHERE_REDIRECTION = /^(?:(?:\d*>>?|&>>?|\d*>\|)\/dev\/null|\d*>&(?:\d+-?|-))$/;
const SED_NOWHERE_OPERATOR = /^(?:\d*>>?|&>>?|\d*>\|)$/;

const sedOperandsAreReadOnly = (operands: readonly string[]): boolean => {
  for (let index = 0; index < operands.length; index += 1) {
    const token = operands[index] as string;
    if (SED_NOWHERE_OPERATOR.test(token) && operands[index + 1] === '/dev/null') {
      index += 1;
    } else if (!SED_NOWHERE_REDIRECTION.test(token) && !SED_PLAIN_FILE.test(token)) {
      return false;
    }
  }
  return true;
};

/**
 * `sed -n '<N>p' [<file>…]` and `sed -n '<N>,<M>p' [<file>…]` — sed's print-range form, which is
 * the `head`/`tail` of a line range and nothing else (PROGRESS backlog 462, the product owner's
 * decision of 2026-10-05). GNU sed 4.9 is what the run image ships (`platform-runtime:dev`,
 * Debian 13, measured 2026-10-05).
 *
 * **The grammar, token by token — anything else falls to `ask`:**
 *
 *  1. argv[0] is exactly `sed` (an environment wrapper is peeled first, like every allow entry).
 *  2. argv[1] is exactly `-n`. Not `--quiet`, `--silent`, `-ne`, `-n1p` or a quoted `"-n"`.
 *  3. argv[2] is the whole script: an address `N` or `N,M` followed by `p`, where `N`/`M` are
 *     decimal line numbers — written bare (`10,20p`), in double quotes (`"10,20p"`) or in single
 *     quotes (`'10,20p'`). `$` (the last line) is accepted **only inside single quotes**
 *     (`'$p'`, `'10,$p'`): bare or double-quoted, `$p` is the shell's parameter expansion of `p`,
 *     not an address. No other command, no second command, no regular-expression address, no
 *     `-e`/`-f`/`--expression`.
 *  4. Every further token is an input file matching {@link SED_PLAIN_FILE}, or a redirection to
 *     `/dev/null` or a descriptor (`2>/dev/null`, `2> /dev/null`, `2>&1`). Zero files is
 *     accepted: sed reads standard input, which is the pipeline form `… | sed -n 1,5p`.
 *
 * **What the grammar is shaped to exclude, each measured or read off `sed --help`:**
 *
 *  - **a script that is a program** — `e` executes a command (`sed -n '1e echo EXECUTED' f`
 *    printed `EXECUTED`, measured in the run image), `w`/`W` write a file, `r`/`R` read one into
 *    the output, `s///e` and `s///w` do both. Rule 3 admits one command, `p`, after a numeric
 *    address, so none of them can be spelled.
 *  - **an option after the script** — GNU getopt permutes, so `sed -n 1p f -i` edits `f` in place
 *    (measured: `f` was cut to its first line). Rule 4 refuses any operand starting with `-`:
 *    `-i`, `--in-place`, `-s`, `-z`, `-E`, `-u`, `-l`, `--debug`, `--posix`, `--follow-symlinks`,
 *    `--`, and `-` (standard input by name — over-asked, stated).
 *  - **an option the shell writes in** — `sed -n 1p *` with a file named `-i` in the directory
 *    edited every file in place (measured). Rule 4 refuses a glob, a brace, a tilde, a quote, a
 *    backslash and any `$`, and the policy refuses this entry on **any line that carries a command
 *    or process substitution** (`evaluateCommand`), because the scanner lifts a substitution's
 *    body out of the line and `sed -n 1p f $(ls)` would otherwise be judged as `sed -n 1p f`.
 *
 * **Left out deliberately:** a regular-expression address (`sed -n '/re/p'`) — `grep` and `rg` are
 * already allowed and say the same thing, while GNU sed's address syntax (`\cREc` delimiters, the
 * `I`/`M` flags, `addr1,+N`, `first~step`) is more grammar to prove for no new capability; `-e`
 * with the allowed script; and `sed --sandbox`, which disables `e`/`r`/`w` but would admit every
 * other option above. They ask.
 */
export const SED_PRINT_RANGE_ALLOW: PreciseAllowEntry = {
  entry: "sed -n '<N>[,<M>]p' [<file>…]",
  envelope: 'sed -n *',
  admits: (tokens) => {
    const [name, quiet, script, ...operands] = tokens;
    return (
      name === 'sed' &&
      quiet === '-n' &&
      script !== undefined &&
      (SED_PRINT_SCRIPT_UNQUOTED.test(script) ||
        SED_PRINT_SCRIPT_DOUBLE_QUOTED.test(script) ||
        SED_PRINT_SCRIPT_SINGLE_QUOTED.test(script)) &&
      sedOperandsAreReadOnly(operands)
    );
  },
};

/** Every precise allow entry the platform ships, by the name it has in an allow list. */
export const PRECISE_ALLOW_ENTRIES: ReadonlyMap<string, PreciseAllowEntry> = new Map(
  [SED_PRINT_RANGE_ALLOW].map((entry) => [entry.entry, entry]),
);

/**
 * product/19 §3, read-only stages: exploration commands, nothing that writes.
 *
 * **`head`, `tail`, `wc` and `pwd`** joined at the product owner's decision of 2026-10-05 (PROGRESS
 * backlog 462: the first local test's runs had `head -60 <file>`, `ls <dir> | tail -25` and
 * `wc -l <file>` denied as `ask`, a model round-trip each). The run image ships GNU coreutils 9.7
 * (Debian 13; `readlink -f` of each is `/usr/bin/<name>`, no busybox — measured 2026-10-05), and
 * every option of all four was read off `--help` there: **none writes a file or runs a command**.
 * The three that do more than print are decided, not missed: `wc --files0-from=F` reads the file
 * names to count from `F` (a read, the class `cat *` already allows); `tail --pid=PID` only watches
 * a process; and `tail -f`/`-F`/`--follow` blocks until the Bash tool's own timeout ends it —
 * read-only, so allowed. That is also why a bare entry and a `*` entry are safe for these four and
 * are not for `sed`: no argument the shell or a file name can put in front of them changes what
 * they do, so a glob is enough. `sed` is a program interpreter and reaches `allow` only through
 * {@link SED_PRINT_RANGE_ALLOW}'s grammar.
 */
export const DEFAULT_READ_ONLY_ALLOW: readonly string[] = [
  // Two entries per verb — `git log` and `git log <args>` — never `git log*`. A trailing `*` with
  // no space allows every command whose *name merely starts with* the verb, which is not what
  // product/19 §3 lists and is a real hole: `git diff*` allowed `git difftool --extcmd=…`,
  // `git fetch*` allowed `git fetch-pack --exec=…`, and `ls*` allowed `lsof`, `lsblk`, `lsattr`.
  // All three were verified executing before the entries were scoped.
  'git log',
  'git log *',
  'git diff',
  'git diff *',
  'git show',
  'git show *',
  'git blame',
  'git blame *',
  'git status',
  'git status *',
  'ls',
  'ls *',
  'cat *',
  'grep *',
  'rg *',
  'find *',
  'head',
  'head *',
  'tail',
  'tail *',
  'wc',
  'wc *',
  'pwd',
  'pwd *',
  SED_PRINT_RANGE_ALLOW.entry,
];

/**
 * product/19 §3's install-from-lockfile clause — `npm ci`, `pnpm install --frozen-lockfile`,
 * `pip install -r` — which the Implementation list has always carried and which WP-54 also gives
 * the two roles that verify rather than write (`DEFAULT_VERIFICATION_ALLOW`): a test command in a
 * fresh workspace runs against no dependencies until one of these has.
 */
export const LOCKFILE_INSTALL_ALLOW: readonly string[] = [
  'npm ci',
  'pnpm install --frozen-lockfile',
  'pip install -r *',
];

/**
 * The names the three `make` floors are written for (WP-186, backlog 557): GNU make's own name and
 * `gmake`, its name on BSD and macOS. A name **beginning with** one of them is make to every floor
 * (`isMakeName`) — `make-4.4`, `gmake-4.4` — which is the reach the `make*` glob always had and the
 * reach `XARGS_FLOORED_VERBS` matches by, so the line and `xargs` agree. The over-ask, stated:
 * `makeinfo` begins with `make`, so `makeinfo -E x` and `makeinfo X=1` are floored too, as
 * `makeinfo --e…` always was by the glob; `makeinfo doc.texi` is not. The run image ships neither
 * name (measured, PROGRESS § WP-186); a project's own image may. {@link PROJECT_COMMAND_ALLOW}'s
 * `make` entries are derived from it (WP-188), so it is declared before that list.
 */
const MAKE_VERBS: readonly [string, ...string[]] = ['make', 'gmake'];

/**
 * product/19 §3's *"allow the project's declared commands (`how-to-run.md`: test, lint, format,
 * build, typecheck) … `make *` targets"* — as the **named verb set** Q69 (ii) ruled on (WP-54,
 * PROGRESS backlog 49).
 *
 * Until WP-54 no shipped list carried this clause at all, so a project's `commands.allow:
 * ["npm test"]` was dropped by the narrowing and fell to the `ask` fallback, which an unattended
 * run denies: no run of any role could run a project's own tests. The clause now reaches a run as
 * **patterns in the per-role baseline** that a project's `commands.allow` narrows, and never as a
 * `*` allow — anything not named here keeps falling to `ask`.
 *
 * The set is Q69's recommendation verbatim (`npm test`, `npm run *`, `pnpm test`, `pnpm run *`,
 * `make *`, `pytest *`, `go test *`, `cargo test *`) plus the **same verbs' other spelling**, the
 * two-entries-per-verb convention of `DEFAULT_READ_ONLY_ALLOW`: a bare `pytest`, `go test`,
 * `cargo test` and `make`, and `npm test`/`pnpm test` with arguments. No verb is added that Q69
 * does not name (`gmake` is `make` under its BSD name, below).
 *
 * **What a name does not bound, said where the names are.** `npm run *` and `make *` run whatever
 * the repository's own `package.json` or `Makefile` says, and a task branch can change that: the
 * *body* of these commands is repository content, bounded by the run container, its non-root user,
 * its workspace-only writable mount and its egress allow-list (BD-021, TD-021) — never by this
 * list. Some spellings that hand one of these verbs a command string **the model** wrote rather
 * than the repository are floored at `ask` by {@link HAZARDOUS_ARGUMENTS}: a `make` variable
 * assignment, `make --eval` (and the getopt prefixes `--ev`/`--eva`) and `-E` in a short-option
 * cluster, `go -exec`/`-toolexec`/`-ldflags … -extld` in either dash form, `cargo --config`, and
 * npm's and pnpm's `--script-shell`, `--node-options` and pnpm's `--config.<key>`, and since
 * WP-197 npm's `--editor`, `--browser` and `--viewer`, which name a program npm runs.
 *
 * **That is an enumeration of known spellings and can be incomplete** — WP-54's review found seven
 * the first list missed in round 1 and five more in round 2. npm and pnpm accept any unique prefix
 * of a long option, and those are floored from the **shortest prefix that is unique today**
 * (`--scr`, `--node`, `--ed`, `--br`, `--vi`), in every spelling nopt reads (`NPM_OPTION_FLOORS`): that is knowledge of the CLIs' current option sets, not a measurement, and a
 * later option sharing the prefix moves it. The floors narrow what a model can author on the
 * command line; the boundary for what these commands *do* is the sandbox above.
 *
 * **Flags that write or delete a path the model chose are floored too** (WP-104, PROGRESS backlog
 * 281): `pytest --basetemp=<dir>` (pytest clears that directory), `pytest --junitxml=<path>`,
 * `go test -o <path>` and `cargo test --target-dir <dir>`, in every spelling the CLIs accept — and
 * since WP-120 (backlog 343) `go test`'s `-coverprofile`, `-cpuprofile`, `-memprofile`,
 * `-blockprofile`, `-mutexprofile`, `-trace` and `-outputdir`, pytest's `-o`/`--override-ini` (every
 * key: `cache_dir`, `log_file` and `addopts` among them), `--debug`, `--log-file` and `--rootdir`,
 * pytest-cov's `--cov-report=<kind>:<dest>`, go's build flags `-pkgdir`, `-debug-trace`,
 * `-debug-actiongraph` and `-debug-runtime-trace`, and the test binary's `-test.testlogfile`,
 * `-test.gocoverdir` and `-test.fuzzcachedir`, each in the spellings read off the tools'
 * sources at the entries — and since WP-221 (backlog 624) logcli's `--cpuprofile`, `--memprofile`
 * and `--part-path-prefix`, beside go's profile flags. Until
 * WP-104 this docblock called the first three *"contained by the workspace-only writable mount"*;
 * the mount contains a write to the workspace and nothing else, and the workspace is exactly where
 * BD-024's protected paths live — the path guard judges only the Edit and Write tools, so a test
 * runner pointed at `tests/` changed a protected tree with no BD-024 reason.
 *
 * **What the floors do not cover, stated (WP-54 review round 3).** Flags that point one of these
 * verbs at a **file to read** stay `allow`: `npm --userconfig=<file>`, `make -f <file>` and
 * `go test -overlay=<file>` read configuration or a makefile from one — which can set a script
 * shell or node options without any floored flag. They are the same class as the model editing the
 * `Makefile` or `package.json`, which BD-025 already accepts. **pytest is the exception, and is
 * floored** (WP-120): `pytest @<file>` (argparse's `fromfile_prefix_chars`) and `pytest -c <file>`
 * read arguments or an `addopts` line out of a file the agent can write in an unprotected
 * directory, which walks past every pytest floor on this list, so both ask. **logcli is the same
 * case** (WP-231, backlog 626): kingpin expands `logcli … @<file>` into the file's lines (before a
 * bare `--` only), which walks past its three path floors, so that line asks too — and, because
 * every option it can carry is one a literal `logcli query *` line may already run, it runs under
 * `auto` as a `path` floor rather than being refused as a `command` one. **The other skill CLIs do
 * not expand one** (WP-232, backlog 626, measured in `platform-runtime` with `--network none`):
 * glab 1.117.0, jira 1.7.0 and sentry-cli 3.7.0 each took `@<file>` as a literal command or
 * argument, so they get no such floor; `acli` is unpinned and unread. **go refuses one before any
 * tool sees it** (WP-240, backlog 639, measured in `golang:1.25.0` by digest, go1.25.0 linux/arm64,
 * `--network none`): `go test -ldflags=all=@f`, `-gcflags=all=@f` and `-asmflags=all=@f` each exit 1
 * with *"invalid command-line argument @f in command: …/link"* (`compile`, `asm`), because go1.25.0's
 * `src/cmd/go/internal/work/shell.go` refuses every word beginning with `@` in any tool command it runs,
 * so the tools' own `@<file>` reading is never reached and the `-extld` floor below is not walked
 * past; `-ldflags=@f` without `<pattern>=` is refused at go's flag parse. **The tools' own
 * path-writing options inside those values are floored** (WP-241, backlog 641, on WP-240's
 * measurement: `-gcflags=all=-cpuprofile=…`, `-ldflags=-cpuprofile=…` and `-ldflags=-o=…` each wrote
 * the file): the value is read as go1.25.0's `load/flag.go` and `cmd/internal/quoted` read it, in
 * either dash form, `=`-attached or the next word, with or without `<pattern>=`, and the compiler's,
 * linker's and assembler's options in it are `path` floors by exact name
 * ({@link GO_COMPILE_PATH_WRITING_OPTIONS}, {@link GO_LINK_PATH_WRITING_OPTIONS},
 * {@link GO_ASM_PATH_WRITING_OPTIONS}); a value `quoted.Split` refuses fails closed. A project image
 * with another go version is measured at none, and the lists are an enumeration. **What still reads a
 * written file as pytest configuration, stated:** an ordinary `pytest sub/` — pytest locates its
 * configuration from the *arguments* upward (`locate_config`: `pytest.toml`, `pytest.ini`,
 * `pyproject.toml`, `tox.ini`, `setup.cfg`), so a `sub/pytest.ini` the agent wrote is read by a line
 * no floor can tell from `pytest tests/` — the repository-content route. `--confcutdir` only limits
 * which `conftest.py` files load and reads no configuration, so it stays `allow`. A `.coveragerc`
 * that names a report's output path is the same class. **The floors remain an enumeration**
 * (BD-025): a tool's next path-writing flag, and any not on the list (go's `-modfile` is not
 * measured), is not covered. `make -e`
 * (`--environment-overrides`) is `allow` in its short spelling although the long one is floored:
 * nothing model-written reaches the environment, because a leading assignment is not peeled for
 * `allow`.
 *
 * **One over-block, stated**: every `make` argument with `=` that is not a flag is floored,
 * including an ordinary `make test V=1` — a command-line variable overrides the makefile's, and
 * `CC=`/`SHELL=` are exactly the ones a recipe runs, so the harmless spelling is not told apart.
 *
 * **`make`'s entries are derived from {@link MAKE_VERBS}** (WP-188, backlog 569), so `gmake` —
 * make's own name on BSD and macOS, not a verb Q69 would have to name — is allowed as `make` is,
 * and the floors that reach it (WP-186) floor it as they floor `make`.
 */
export const PROJECT_COMMAND_ALLOW: readonly string[] = [
  'npm test',
  'npm test *',
  'npm run *',
  'pnpm test',
  'pnpm test *',
  'pnpm run *',
  ...MAKE_VERBS.flatMap((verb) => [verb, `${verb} *`]),
  'pytest',
  'pytest *',
  'go test',
  'go test *',
  'cargo test',
  'cargo test *',
];

/**
 * product/19 §3, Implementation: the project's declared commands, safe git, and lockfile installs.
 *
 * The first clause — *"the project's declared commands"* — is {@link PROJECT_COMMAND_ALLOW} since
 * WP-54; before it this docblock claimed the sentence in full while the list implemented every
 * clause of it except that one (PROGRESS backlog 49).
 */
export const DEFAULT_IMPLEMENTATION_ALLOW: readonly string[] = [
  ...DEFAULT_READ_ONLY_ALLOW,
  'git add *',
  'git commit *',
  'git push origin agentic/*',
  'git rebase',
  'git rebase *',
  // No merge verb: product/19 §3's Implementation bullet names `git rebase` and no merge at all,
  // and this constant is the organisation **maximum** every implementation-stage run of every
  // project inherits. WP-26 put `'git merge'` and `'git merge *'` here to make the rebase gate's
  // conflict resolution runnable; TD-027 (the ruling on Q77) took them out again and moved four
  // literal spellings onto the stage that needs them — {@link CONFLICT_RESOLUTION_EXTRA_ALLOW}.
  'git fetch',
  'git fetch *',
  ...LOCKFILE_INSTALL_ALLOW,
  ...PROJECT_COMMAND_ALLOW,
];

/**
 * product/19 §5's documented one-command setup, **`.agentic/workspace/setup`**, as a named verb —
 * the literal path and nothing else (WP-64, PROGRESS backlog 144).
 *
 * product/17 R6 is detected *"executed in the workspace"*. Since WP-54 a `make` target or a package
 * script is run by discovery; the platform's own documented setup path was the one form that had no
 * verb, so discovery *read* the script — the weaker evidence R6 was reworded to avoid. One literal,
 * with no argument form: `./.agentic/workspace/setup --anything` falls to `ask`, like every spelling
 * nobody named.
 *
 * **What the name does not bound, said where the name is** (BD-025's WP-54 amendment, accepted
 * there for `make *` and `npm run *`): the script's *body* is repository content, and a task branch
 * can change it. What bounds it is the run container, its non-root user, its workspace-only writable
 * mount and its egress allow-list (BD-021, TD-021) — never this list. It is the same residual as
 * `make setup`, for the same repository-controlled reason.
 *
 * **In the verification baseline only** — discovery, the Reviewer and the Acceptance Tester — and
 * **not** in {@link PROJECT_COMMAND_ALLOW}: it is the platform's documented path rather than a
 * command a project declares, so a project's `commands.allow` does not narrow it away
 * ({@link isProjectCommandEntry} does not cover it). A project that does not want it run writes it
 * into `commands.block`, which always wins.
 */
export const WORKSPACE_SETUP_ALLOW: readonly string[] = ['./.agentic/workspace/setup'];

/**
 * The baseline of the two roles that **check** work rather than write it — the Reviewer (product/13
 * *"tests only"*) and the Acceptance Tester (*"tests/app cmds"*) — and of Discovery, whose
 * readiness criteria R1, R2 and R6 product/17 detects by running the project's commands (WP-54).
 *
 * product/19 §3's read-only list plus *"the project's test/lint commands (review stages only)"*,
 * plus the lockfile installs those commands cannot run without. No git write, no push, no
 * dependency addition: a role on this list reads, installs what the lockfile pins, and runs what
 * the project declares.
 */
export const DEFAULT_VERIFICATION_ALLOW: readonly string[] = [
  ...DEFAULT_READ_ONLY_ALLOW,
  ...LOCKFILE_INSTALL_ALLOW,
  ...PROJECT_COMMAND_ALLOW,
  ...WORKSPACE_SETUP_ALLOW,
];

/**
 * What `verification.mode: ci` takes away from every run (BD-025's 2026-10-05 amendment, PROGRESS
 * backlog 460): the project's declared commands, the lockfile installs that exist to serve them and
 * the platform's documented setup script — the three lists that carry *running the project* into a
 * baseline. Nothing else: the read verbs, the git verbs and a stage's or a skill's additions stay.
 *
 * The entries move to **`block`**, not merely out of `allow` (which would leave them to the `ask`
 * fallback). Two reasons, both measured against this build rather than preferred:
 *
 *  - **The refusal the model reads.** An `ask` was denied by the unattended approval port with *"do
 *    the work another way"*, which invites the model to find another spelling of the same test run
 *    — and since BD-025's 2026-10-06 amendment an `ask` **runs** under the default `auto`; a `block`
 *    is denied at the `PreToolUse` hook with `command policy: block — … matches the block-list entry
 *    "<pattern>"`, which names the pattern, and the run's system
 *    prompt says why that pattern is blocked ({@link withVerificationMode}'s caller passes the
 *    platform's CI instruction to `assemblePrompt`).
 *  - **The block-list matches generously** (module rule 2): a `make test` handed to `sh -c` or
 *    `env` is still a `make` command, and an extra argument never escapes a ban. An allow-list
 *    removal only stops the spellings that matched it.
 *
 * Block is also the one list a later layer cannot shrink, so a project's `commands.allow: ["npm
 * test"]` cannot re-grant a run what the mode took: the narrowing reports it in `ignoredAllow`.
 * **What this list does not cover, stated:** a runner the shipped lists never allowed —
 * `vendor/bin/phpunit`, `npx jest`, `./gradlew test` — was already outside every `allow` and stays
 * on the `ask` fallback, which an unattended run **runs** under the default `auto` since BD-025's
 * 2026-10-06 amendment (and refuses under `deny`); the CI instruction in the prompt is what keeps
 * the model from trying it, and a project that must stop it writes it into `commands.block`.
 */
export const CI_VERIFICATION_BLOCK: readonly string[] = [
  ...LOCKFILE_INSTALL_ALLOW,
  ...PROJECT_COMMAND_ALLOW,
  ...WORKSPACE_SETUP_ALLOW,
];

/**
 * A run's starting policy under the project's verification mode — the identity for `local`, and for
 * `ci` the same policy with {@link CI_VERIFICATION_BLOCK} removed from `allow` and added to `block`.
 *
 * Applied to the **baseline**, before the organisation maximum and the project layers narrow it, so
 * every later layer judges its own entries against a policy that already blocks these: an
 * organisation literal `make test` and a project's `npm test` are then not granted (the project's
 * is reported in `ignoredAllow`). It only ever narrows: `allow` loses entries, `ask` loses
 * only an entry that moved to `block` (the shape `narrowCommandPolicy` keeps: no entry is on two
 * lists), `block` grows — asserted over every shipped baseline in the tests.
 */
export const withVerificationMode = (
  baseline: ResolvedCommandPolicy,
  mode: VerificationMode,
): ResolvedCommandPolicy =>
  mode === 'local'
    ? baseline
    : {
        allow: baseline.allow.filter((entry) => !CI_VERIFICATION_BLOCK.includes(entry)),
        ask: baseline.ask.filter((entry) => !CI_VERIFICATION_BLOCK.includes(entry)),
        block: [...new Set([...baseline.block, ...CI_VERIFICATION_BLOCK])],
      };

/**
 * product/19 §3, Conflict resolution: the four merge spellings the rebase gate's resolution stage
 * adds to the implementation baseline — and nothing else (TD-027, the ruling on Q77).
 *
 * **Extra patterns, not a replacement list**, so the direction is structural: the stage layer that
 * consults this (`COMMAND_ALLOW_BY_STAGE` in the planner) can only *add* to `allow`, never touch
 * `ask` and never remove from `block`, and the project's own narrowing still runs after it. BD-025
 * §2's words are *"defaults ship **per stage**"*; the role table was the approximation that made a
 * one-stage need look like a change to the organisation maximum.
 *
 * **Every entry is a literal spelling product/19 §3 lists for this stage** — the allow-side twin of
 * {@link DECLINED_BLOCK_VARIANTS}' standing rule. A stage layer is where a documented default is
 * put, not where one is invented.
 *
 * **What the set is shaped to exclude.** Nothing may sit between the verb and a remote-tracking
 * ref, so `git merge -s ours origin/main` (git-merge(1): the `ours` strategy's *"resulting tree of
 * the merge is always that of the current branch head"* — a branch that claims commits it does not
 * contain), `git merge -X theirs …` (*"forces conflicting hunks to be auto-resolved"* by deleting a
 * side) and `git merge --no-verify …` (skips the hooks where a repository runs its secret scan,
 * BD-002) match nothing here and fall to the `ask` fallback — and carry a `trust` hazard, which an
 * unattended run refuses in either mode (`decideUnattendedCommand`, BD-025's 2026-10-06 amendment).
 * **The same flags written *after* the ref are a different matter and are floored, not excluded**:
 * `*` matches a run of characters including spaces, so `git merge origin/main --no-verify` *does*
 * match `git merge origin/*` — measured with `evaluateCommand` — and what refuses it is
 * {@link HAZARDOUS_ARGUMENTS}, exactly as that list's docblock says a flag under a wide allow entry
 * is refused. product/19 §3's fourth bullet requires those spellings to be `ask` wherever they sit.
 *
 * `--no-edit` is here because git-merge(1) makes the editor the default on a successful mechanical
 * merge and a run has no terminal; `--abort` because `git reset --hard origin/*` is blocked and a
 * half-finished merge would otherwise strand the workspace for the second of BD-030's two attempts;
 * `--continue` because it can do nothing `git commit *` cannot already do. The reason the stage
 * merges rather than rebases is Q76: `git push --force*` is blocked for every stage, so a rebased
 * branch cannot be published by any run this build starts.
 */
export const CONFLICT_RESOLUTION_EXTRA_ALLOW: readonly string[] = [
  'git merge origin/*',
  'git merge --no-edit origin/*',
  'git merge --abort',
  'git merge --continue',
];

/**
 * product/19 §3, Implementation: dependency additions and anything that leaves the workspace.
 *
 * The `-exec` family is here rather than on the allow-list because it turns a safe command into an
 * arbitrary-command runner: `find … -exec` runs a command per match and `git rebase -x/--exec` runs
 * one per commit. The plain verbs stay allowed — product/19 §3 allows both — because these ask
 * entries are more specific and so win the tie against them.
 *
 * **This sentence used to end "…and the rebase gate (WP-26) rebases on every task's happy path",
 * which WP-26 made false twice over** (standing rule 83). The gate does not run a command at all:
 * it reads the provider's `has_conflicts` and settles. A command is run only when it *fails*, by
 * the `conflict_resolution` stage — and what that stage runs is one of the four merge spellings of
 * {@link CONFLICT_RESOLUTION_EXTRA_ALLOW}, which is the **stage's** list and not this maximum
 * (TD-027), because a rebased branch cannot be pushed under the same list's `git push --force*`
 * block (Q76).
 */
export const DEFAULT_IMPLEMENTATION_ASK: readonly string[] = [
  'npm install *',
  'pnpm add *',
  'pip install *',
  // WP-211 (b): `require`'s options, read off https://getcomposer.org/doc/03-cli.md#require-r
  // (2026-10-19; unversioned, and Composer is in no stock image): `--dev`, `--dry-run`,
  // `--prefer-install`, `--no-progress`, `--no-update`, `--no-install`, `--no-audit`,
  // `--audit-format`, `--no-security-blocking`, `--no-blocking`, `--update-no-dev`, `-w`/`-W`,
  // `--ignore-platform-req(s)`, `--prefer-stable`, `--prefer-lowest`, `-m`, `--sort-packages`,
  // `-o`, `-a`, `--apcu-autoloader(-prefix)`, and the global `-d`, `--no-plugins`, `--no-scripts`,
  // `--no-cache`, `--profile`, `-n`, `-q`, `-v`, `--ansi`. None names a program; what it runs is
  // the required package's plugins and `composer.json`'s scripts, which is why the entry asks.
  'composer require *',
  'git push*',
  'git rebase* -x*',
  'git rebase* --exec*',
  'find * -exec*',
  'find * -delete*',
  'find * -ok*',
];

/** {@link HazardousArgument.kind}'s three values. */
export type HazardKind = 'command' | 'trust' | 'path';

interface HazardousArgumentShape {
  /**
   * Matched exactly like a block pattern: tokens (flag anywhere) or the whole line as a glob —
   * unless {@link tokens} is given, when this is the entry's **name** and only that predicate
   * decides.
   */
  readonly pattern: string;
  /**
   * What the argument does, which decides what an **unattended `auto`** run makes of it (BD-025's
   * 2026-10-06 amendment, `decideUnattendedCommand`):
   *
   *  - `command` — hands the verb a program or configuration the policy has not read
   *    (`--upload-pack`, `make --eval`, `npm --script-shell`, `pytest -c`). **Refused** under `auto`.
   *  - `trust` — widens what the verb trusts: a refspec to a ref of its own choosing, a skipped
   *    hook, a merge strategy that discards a side, an unread package index. **Refused** under
   *    `auto`; each is product/19 §3's *"never allow"* or BD-002's/BD-030's.
   *  - `path` — writes a path the command line chose (`--junitxml`, `go test -coverprofile`).
   *    **Runs** under `auto`, like any other write in the workspace: the container's only writable
   *    mount is the workspace, and the CI gate's tamper check judges a protected path the branch
   *    changed whichever tool changed it (BD-024).
   *
   * Under `deny`, and for an attended run, every kind floors at `ask` exactly as before.
   */
  readonly kind: HazardKind;
  /** What the argument hands the verb that the policy has not read. */
  readonly hazard: string;
  /**
   * A token-scoped match, for a floor a glob cannot scope (WP-54 review round 2): called with the
   * command's argv0 (basename) and its dequoted flags and positionals, for every argv0 candidate
   * the block matcher would try. The whole-line glob is **not** consulted for such an entry, which
   * is the point — `make* -*E*` as a glob matched a capital E in any later word.
   */
  readonly tokens?: (argv: {
    readonly name: string;
    readonly flags: readonly string[];
    readonly positional: readonly string[];
    /** Every word after the name, dequoted, in order (WP-161: git's subcommand is read off these). */
    readonly words: readonly string[];
    /**
     * The same words exactly as the program receives them — a literal quote inside a word kept —
     * on the `argvWords` reading only, `undefined` on the written one (WP-241: a go tool flag's
     * value is split again by go, so its quotes matter). Since WP-242 `words` is dequoted once, so
     * on that reading the two are equal; `received` stays as the reading's name, because the go
     * tool-flag floors must not read the written one (`-ldflags "-s -w"` is two tokens there).
     */
    readonly received?: readonly string[] | undefined;
    /**
     * Beside `received`, per word: whether bash may hand the program other text than `received`
     * says — a `$` or backtick outside single quotes (an expansion; a brace is expanded before
     * the mark is read, WP-243) — and, kept as an over-ask since WP-242 made the dequote keep it
     * as bash does, a backslash inside double quotes before a character bash does not escape there.
     */
    readonly receivedUnsure?: readonly boolean[] | undefined;
  }) => boolean;
}

/**
 * A floor on {@link HAZARDOUS_ARGUMENTS}. A `command`-kind entry must name the **verbs** it floors
 * (WP-164, backlog 530): the argv0 basenames its pattern or predicate is written for (`make`, `go`,
 * `pytest`). An `xargs` that feeds one of them is uncertain ({@link XARGS_FLOORED_VERBS}), because
 * the hazardous argument can arrive on xargs' input, where no floor reads it. A `trust` or `path`
 * entry may name them and does not have to: those kinds are not derived into the set.
 *
 * A `command`-kind entry must also declare its **environment** (WP-199, backlog 583): the
 * environment variables its verb documents reading for the same effect as the floored option —
 * `--editor` and `EDITOR`, `make --eval` and `MAKEFLAGS`, `cargo --config` and `CARGO_*`. A word
 * naming one, wherever it stands, is uncertain whatever the command ({@link FLOOR_ENVIRONMENT},
 * the only place the scan reads names from). Each name is declared on exactly one entry, cited
 * from the tool's documentation beside it; `[]` carries its reason in a comment at the entry.
 */
export type HazardousArgument = HazardousArgumentShape &
  (
    | {
        readonly kind: 'command';
        readonly verbs: readonly [string, ...string[]];
        readonly environment: readonly FloorEnvironmentName[];
      }
    | {
        readonly kind: 'trust' | 'path';
        readonly verbs?: readonly string[];
        readonly environment?: readonly FloorEnvironmentName[];
      }
  );

/**
 * One environment spelling of a floor: an exact name (`EDITOR`), or a prefix written with a
 * trailing `*` (`CARGO_*`); `anyCase` when the verb reads it case-insensitively (npm's
 * `npm_config_*`). Unix environment names are otherwise case-sensitive.
 */
export type FloorEnvironmentName = string | { readonly name: string; readonly anyCase: true };

/**
 * `go test` flags that write a path the command line chose (PROGRESS backlog 343, WP-120): six
 * profile and trace outputs and the directory they are written into. Each is a string flag of
 * `go test` and is in go1.25.0's `passFlagToTest`, so it is accepted with a `test.` prefix too.
 */
export const GO_PATH_WRITING_TEST_FLAGS: readonly string[] = [
  'coverprofile',
  'cpuprofile',
  'memprofile',
  'blockprofile',
  'mutexprofile',
  'trace',
  'outputdir',
];

/**
 * `go test` **build** flags that write a path the command line chose (WP-120 pre-review): go1.25.0's
 * `work.AddBuildFlags` registers them on `go test`, and `work/init.go` (`-debug-runtime-trace`:
 * `os.Create`; `-debug-trace`: `trace.Start`), `work/exec.go` (`-debug-actiongraph`) and `go help
 * build` (`-pkgdir`: *"use -pkgdir to keep generated packages in a separate location"*) write
 * there. They are **not** in `passFlagToTest`, so no `test.` spelling exists.
 */
export const GO_PATH_WRITING_BUILD_FLAGS: readonly string[] = [
  'pkgdir',
  'debug-trace',
  'debug-actiongraph',
  'debug-runtime-trace',
];

/**
 * Flags of the **test binary** that write a path and that `go test` itself does not declare
 * (WP-120 review round 1): go1.25.0's `testing.go:463` `test.gocoverdir` (*"write coverage
 * intermediate files to this directory"*), `testing.go:479` `test.testlogfile` (*"write test action
 * log to `file`"*, `os.Create` at `testing.go:2543`, so it truncates) and `fuzz.go:26`
 * `test.fuzzcachedir` (where interesting fuzzing inputs are stored). `cmd/go`'s `testflag.go`
 * (the `FlagNotDefinedError` branch, `:297-321`) hands any flag it does not know to the binary —
 * before `-args` as well as after it — and the binary's `flag` package takes them only **with**
 * the `test.` prefix. The whole flag set of `testing.go`, `fuzz.go` and `benchmark.go` (the only
 * files of `src/testing` that register a flag) was read: every other flag naming a path is already
 * in {@link GO_PATH_WRITING_TEST_FLAGS}.
 */
export const GO_PATH_WRITING_BINARY_FLAGS: readonly string[] = [
  'testlogfile',
  'gocoverdir',
  'fuzzcachedir',
];

/** How a go flag may carry the `test.` prefix: `go test` forwards it, never has it, or needs it. */
type GoTestPrefix = 'optional' | 'none' | 'required';

const GO_TEST_PREFIX: Readonly<Record<GoTestPrefix, string>> = {
  optional: '(?:test\\.)?',
  none: '',
  required: 'test\\.',
};

const GO_PREFIX_WORDING: Readonly<Record<GoTestPrefix, string>> = {
  optional: 'optional test. prefix, ',
  none: '',
  required: 'test. prefix only, ',
};

/**
 * One floor per go flag, by its exact name — never a prefix glob, which would also floor
 * `-memprofilerate`, `-blockprofilerate` and `-mutexprofilefraction` (go does not match prefixes,
 * so those are different flags). Matches one or two dashes and `=` or a space, with the `test.`
 * prefix as the flag's owner accepts it; `go*` as the binary, like the four `go* -o` entries. A flag
 * is matched wherever it sits, so after `-args` too.
 */
const goPathWritingFloor =
  (prefix: GoTestPrefix) =>
  (flagName: string): HazardousArgument => {
    const spelled = new RegExp(`^--?${GO_TEST_PREFIX[prefix]}${flagName}(?:=|$)`);
    return {
      pattern: `go -${prefix === 'required' ? 'test.' : ''}${flagName} (one or two dashes, ${GO_PREFIX_WORDING[prefix]}= or a space)`,
      kind: 'path',
      hazard: `go test -${flagName} writes to a path the command line chose, which the path guard never sees (BD-024)`,
      tokens: ({ name, flags }) =>
        name.startsWith('go') && flags.some((flag) => spelled.test(flag)),
    };
  };

/**
 * The **compiler's** options that write a path, reached through `go -gcflags` (WP-241, backlog
 * 641): go1.25.0's `go tool compile -help`, read in `golang:1.25.0` by digest (PROGRESS § WP-240),
 * lists them as *writing a path* — `-asmhdr`, `-bench` (appends), `-blockprofile`, `-cpuprofile`,
 * `-json` (`version,file`), `-linkobj`, `-memprofile`, `-mutexprofile`, `-o`, `-traceprofile`.
 * `go test -gcflags=all=-cpuprofile=/tmp/c.prof ./...` wrote the file (exit 0, measured there).
 */
export const GO_COMPILE_PATH_WRITING_OPTIONS: readonly string[] = [
  'asmhdr',
  'bench',
  'blockprofile',
  'cpuprofile',
  'json',
  'linkobj',
  'memprofile',
  'mutexprofile',
  'o',
  'traceprofile',
];

/**
 * The **linker's** options that write a path, reached through `go -ldflags` (WP-241): go1.25.0's
 * `go tool link -help`, read in the same image — `-benchmarkprofile` (a base name),
 * `-capturehostobjs` (a directory), `-cpuprofile`, `-fipso`, `-memprofile`, `-o`, `-tmpdir` (a
 * directory). `-ldflags=-cpuprofile=/tmp/l.prof` wrote the file (exit 0) and `-ldflags=-o=/tmp/x`
 * wrote the test binary there although go then failed (exit 1), both measured at WP-240.
 */
export const GO_LINK_PATH_WRITING_OPTIONS: readonly string[] = [
  'benchmarkprofile',
  'capturehostobjs',
  'cpuprofile',
  'fipso',
  'memprofile',
  'o',
  'tmpdir',
];

/**
 * The **assembler's** option that writes a path, reached through `go -asmflags` (WP-241): `go tool
 * asm -help` lists `-o` (and `-gensymabis`, which writes to `-o`). **Floored although measured not to
 * write**: `go test -asmflags=all=-o=/tmp/a.o ./...` exited 0 and wrote nothing at WP-240, because
 * go1.25.0 puts its own `-o` after the value and the last one wins. That ordering is one go
 * version's, read nowhere in the source by this row; flooring it over-asks one spelling nobody
 * needs, leaving it would make the floor's coverage depend on it.
 */
export const GO_ASM_PATH_WRITING_OPTIONS: readonly string[] = ['o'];

/** Which tool each go flag hands its value to, and that tool's path-writing options. */
const GO_TOOL_FLAG_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  gcflags: GO_COMPILE_PATH_WRITING_OPTIONS,
  ldflags: GO_LINK_PATH_WRITING_OPTIONS,
  asmflags: GO_ASM_PATH_WRITING_OPTIONS,
};

/** go's flag package: one or two dashes, the value `=`-attached or the next word. */
const GO_TOOL_FLAG = /^--?(gcflags|ldflags|asmflags)(?:=([\s\S]*))?$/;

/**
 * go1.25.0 `src/cmd/internal/quoted/quoted.go:25-59` (`Split`), ported: fields separated by space,
 * tab, newline or carriage return; a field that *opens* with `'` or `"` runs to the next same quote
 * with nothing unescaped, and a quote further inside a field is an ordinary byte. `null` where
 * `Split` returns *"unterminated %c string"*.
 */
const goQuotedSplit = (value: string): readonly string[] | null => {
  const fields: string[] = [];
  const space = /[ \t\n\r]/;
  let rest = value;
  while (rest.length > 0) {
    let start = 0;
    while (start < rest.length && space.test(rest[start] as string)) {
      start += 1;
    }
    rest = rest.slice(start);
    if (rest.length === 0) {
      break;
    }
    const quote = rest[0] as string;
    if (quote === '"' || quote === "'") {
      const close = rest.indexOf(quote, 1);
      if (close < 0) {
        return null;
      }
      fields.push(rest.slice(1, close));
      rest = rest.slice(close + 1);
      continue;
    }
    let end = 0;
    while (end < rest.length && !space.test(rest[end] as string)) {
      end += 1;
    }
    fields.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return fields;
};

/**
 * go1.25.0's `strings.TrimSpace` (`strings/strings.go:1093-1125`), which trims `unicode.IsSpace`
 * (`unicode/graphic.go:128-138`): `\t \n \v \f \r`, space, U+0085 and U+00A0, and above Latin-1 the
 * `White_Space` table (`unicode/tables.go:8570-8581`). Not JS `trim`, which drops U+0085 and adds
 * U+FEFF (review round 1: a leading NEL read as a `<pattern>=` cut, `allow`).
 */
const GO_SPACE =
  '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const GO_TRIM_SPACE = new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, 'g');

/**
 * The words go hands its tool for one `-gcflags`/`-ldflags`/`-asmflags` value, read as go1.25.0's
 * `src/cmd/go/internal/load/flag.go:42-78` (`PerPackageFlag.set`) reads it: trimmed; a value not
 * opening with `-` is `<pattern>=<flags>`, cut at its first `=` (`:54-68`), and go refuses one with
 * no `=`, an empty pattern or a leading quote — nothing runs, so it yields no words; the rest is
 * `quoted.Split` (`:69`), whose refusal is `null` here.
 */
const goToolValueWords = (raw: string): readonly string[] | null => {
  let value = raw.replace(GO_TRIM_SPACE, '');
  if (value !== '' && !value.startsWith('-')) {
    const cut = value.indexOf('=');
    if (cut <= 0 || value.startsWith("'") || value.startsWith('"')) {
      return [];
    }
    value = value.slice(cut + 1);
  }
  return goQuotedSplit(value);
};

/**
 * Every value of `flag` on a go command line, split as go splits it — `null` for one `Split`
 * refuses, and for one whose words bash may hand go differently (`unsure`, review round 1).
 */
const goToolValues = (
  words: readonly string[],
  unsure: readonly boolean[],
  flag: string,
): readonly (readonly string[] | null)[] =>
  words.flatMap((word, index) => {
    const spelled = GO_TOOL_FLAG.exec(word);
    if (spelled === null || spelled[1] !== flag) {
      return [];
    }
    const valueAt = spelled[2] === undefined ? index + 1 : index;
    const raw = spelled[2] ?? words[valueAt];
    if (raw === undefined) {
      return [];
    }
    return [unsure[index] === true || unsure[valueAt] === true ? null : goToolValueWords(raw)];
  });

/**
 * One floor per tool option, by its exact name — the tools parse with go's flag package
 * (`objabi.Flagparse`), so one or two dashes and `=` or the next word, and `-memprofilerate` is a
 * different option. `go*` as the binary, like {@link goPathWritingFloor}'s; an option is matched
 * wherever it sits in the value, which can only over-read.
 */
const goToolPathWritingFloor =
  (flag: string) =>
  (optionName: string): HazardousArgument => {
    const spelled = new RegExp(`^--?${optionName}(?:=|$)`);
    return {
      pattern: `go* -${flag} value: -${optionName} (either dash form of both, = or the next word, optional <pattern>=)`,
      kind: 'path',
      hazard: `go -${flag} hands its tool -${optionName}, which writes to a path the command line chose, which the path guard never sees (BD-024)`,
      tokens: ({ name, received, receivedUnsure = [] }) =>
        name.startsWith('go') &&
        received !== undefined &&
        goToolValues(received, receivedUnsure, flag).some(
          (options) => options !== null && options.some((option) => spelled.test(option)),
        ),
    };
  };

/**
 * logcli options that write a file at a path the command line chose (WP-221, backlog 624), as
 * {@link GO_PATH_WRITING_TEST_FLAGS} are go's. logcli 3.7.7's `cmd/logcli/main.go`
 * (https://github.com/grafana/loki/blob/v3.7.7/cmd/logcli/main.go): `--cpuprofile` and
 * `--memprofile` are `os.Create`d, so truncated, right after parsing and before any request;
 * `--part-path-prefix` (`query`) saves each response to `<prefix>_<start>_<end>.part`, and
 * `--merge-parts` then deletes those files. All three wrote their file in `platform-runtime:s16`
 * with `--network none`, the query failing (PROGRESS § WP-221). The skill grammar marks them
 * (`SKILL_COMMAND_GRAMMARS`' `pathWriting`, held to these floors by the planner's census).
 */
export const LOGCLI_PATH_WRITING_OPTIONS: readonly string[] = [
  'cpuprofile',
  'memprofile',
  'part-path-prefix',
];

/**
 * One floor per logcli option, by its exact name with two dashes and `=` or a space: kingpin (v2,
 * logcli's parser) matches a long flag by its whole name (`--cpuprof` is refused, measured) and
 * reads a single dash as a short flag. The pattern's first word is the glob `logcli*`, never the
 * bare name, so the floor does not put logcli on {@link FLOORED_NAMES}: a name known there loses
 * the unknown program rule's reading of its other subcommands (`logcli delete sudo id` reads
 * uncertain, measured), the reason the skill CLIs' environment sits on
 * {@link ENVIRONMENT_ONLY_FLOORS}.
 */
const logcliPathWritingFloor = (optionName: string): HazardousArgument => {
  const spelled = new RegExp(`^--${optionName}(?:=|$)`);
  return {
    pattern: `logcli* --${optionName} (two dashes, = or a space)`,
    kind: 'path',
    hazard: `logcli --${optionName} writes to a path the command line chose, which the path guard never sees (BD-024)`,
    tokens: ({ name, flags }) => name === 'logcli' && flags.some((flag) => spelled.test(flag)),
  };
};

/**
 * pytest 9.0.2's short options that take a value (`-k`, `-m`, `-c`, `-p`, `-o`, `-W`, `-r`): in a
 * short-option cluster argparse hands the first of them the rest of the token.
 */
const PYTEST_VALUE_SHORT_OPTIONS: ReadonlySet<string> = new Set([
  'k',
  'm',
  'c',
  'p',
  'o',
  'W',
  'r',
]);

/**
 * The value-taking short option a single-dash token reaches — alone (`-o`, `-ok=v`, `-o=k=v`,
 * `-cx.ini`) or at the end of a cluster (`-qo`, `-vqok=v`, `-qc x.ini`) — or `null`. Scanning stops
 * at the first such option, because argparse gives it the rest of the token (`-kfoo` is `-k foo`,
 * never an `-o`). A letter pytest does not know is scanned past, which can only over-match: pytest
 * would refuse the token.
 */
const pytestClusterValueOption = (flag: string): string | null => {
  if (!flag.startsWith('-') || flag.startsWith('--')) {
    return null;
  }
  for (const letter of flag.slice(1)) {
    if (PYTEST_VALUE_SHORT_OPTIONS.has(letter)) {
      return letter;
    }
  }
  return null;
};

/** pytest's own long options that write a path, matched by exact name (`allow_abbrev=False`). */
const pytestLongFlag = (flagName: string): RegExp => new RegExp(`^--${flagName}(?:=|$)`);

/** pytest-cov's report kinds that take `:DEST` (`validate_report`, pytest-cov 7.1.0). */
const COV_REPORT_DEST_KINDS = 'annotate|html|xml|json|markdown-append|markdown|lcov';
const COV_REPORT_DEST = new RegExp(`^(?:${COV_REPORT_DEST_KINDS}):`);
const COV_REPORT_ATTACHED_DEST = new RegExp(`^--cov-report=(?:${COV_REPORT_DEST_KINDS}):`);

/**
 * The long spellings of `HAZARDOUS_ARGUMENTS`' git entries, each with its entry's kind (WP-161 (b),
 * PROGRESS backlog 515). git maps a long word `--t` to an option when `t` is a prefix of one of that
 * option's spellings, and git 2.47.3 (the run image's) did so for every parse-options table:
 * `git commit --no-verif` and `--no-veri` skipped a failing pre-commit hook, `git fetch --upload-p=`
 * and `--upload=`, `git ls-remote --upload-p=` and `git push --receive-p=`, `--exe=` and `--ex=` ran
 * the value, and `git cat-file --te` and `--text` ran the repository's textconv driver (measured,
 * PROGRESS § WP-161). So being a prefix of one of these is the **necessary** condition for an
 * abbreviation to reach a hazard, and it is the floor (`gitAbbreviationFloor`).
 */
export interface GitAbbreviationHazard {
  /** The long option's name, without `--`. */
  readonly spelling: string;
  readonly kind: HazardKind;
  readonly hazard: string;
}

export const GIT_ABBREVIATION_HAZARDS: readonly GitAbbreviationHazard[] = [
  {
    spelling: 'no-verify',
    kind: 'trust',
    hazard:
      'skips the pre-commit, pre-merge, pre-push and commit-msg hooks, which is where a repository runs its secret scan (BD-002) and its formatter',
  },
  {
    spelling: 'upload-pack',
    kind: 'command',
    hazard: 'git runs the --upload-pack value as a shell command, on this machine for a local path',
  },
  {
    spelling: 'receive-pack',
    kind: 'command',
    hazard: 'git push runs the value as a shell command',
  },
  {
    spelling: 'exec',
    kind: 'command',
    hazard:
      'git push and fetch-pack run --exec as their pack program, and git rebase runs it after each commit',
  },
  {
    spelling: 'extcmd',
    kind: 'command',
    hazard: 'git difftool runs --extcmd once per changed file',
  },
  {
    spelling: 'ext-diff',
    kind: 'command',
    hazard: "runs the external diff driver the repository's own config names (BD-022)",
  },
  {
    spelling: 'textconv',
    kind: 'command',
    hazard: "runs the textconv filter the repository's config names (BD-022)",
  },
  { spelling: 'output', kind: 'path', hazard: "git's diff family writes --output to any path" },
];

const GIT_HAZARD_SPELLINGS: ReadonlySet<string> = new Set(
  GIT_ABBREVIATION_HAZARDS.map((entry) => entry.spelling),
);

/**
 * The option git resolves the long word `--t` to in `table`, by its own rule (`parse_long_opt`): an
 * exact spelling wins; otherwise a prefix that matches the spellings of exactly one option (its
 * positive and `no-` forms are one option) wins; otherwise nothing — an ambiguous or unknown word,
 * which git refuses. Answers the matched spelling, a hazardous one first, or `null`. With no table
 * (an alias, `git-foo`, `mergetool`, anything unknown) it resolves nothing, so the floor stays.
 */
export const gitResolvesLongOption = (
  table: GitLongOptionTable | undefined,
  word: string,
): string | null => {
  if (table === undefined) {
    return null;
  }
  if (table.abbreviates.includes(word) || table.exact.includes(word)) {
    return word;
  }
  const matches = table.abbreviates.filter((spelling) => spelling.startsWith(word));
  const options = new Set(matches.map((spelling) => spelling.replace(/^no-/, '')));
  if (options.size !== 1) {
    return null;
  }
  return matches.find((spelling) => GIT_HAZARD_SPELLINGS.has(spelling)) ?? (matches[0] as string);
};

/** How a git global option takes its value: the next word, after its own `=`, or none. */
export type GitGlobalOptionShape = 'separate' | 'equals' | 'valueless';

/** Where {@link GIT_GLOBAL_OPTIONS} was read: `handle_options` in the run image's git. */
export const GIT_GLOBAL_OPTIONS_SOURCE = {
  git: 'git version 2.47.3',
  url: 'https://raw.githubusercontent.com/git/git/v2.47.3/git.c',
  retrieved: '2026-10-19',
} as const;

/**
 * WP-218 (backlogs 621 and 620): git's global options before the verb, as **one declared grammar**
 * read off `handle_options` in `git.c` at `v2.47.3` (the run image's git,
 * {@link GIT_GLOBAL_OPTIONS_SOURCE}); `line` is the line of the option's branch there. A word that
 * starts with `-` before the verb and is not declared here is **unreadable**: the git boundary
 * answers it `uncertain` and `gitSubcommandOf` answers `null`, so an option this list misses fails
 * closed instead of handing its value word to the boundary as the verb (`--shallow-file` was that
 * omission until WP-218). TD-030 decision 1's admission test. Only {@link readGitGlobalOptions}
 * reads it (a census in `unattended-commands.test.ts`).
 *
 * - `separate`: the next word is the value (an exact `strcmp`, then `(*argv)++`).
 * - `equals`: the key is the spelling up to and including `=` (`skip_prefix`); the value is the rest.
 * - `valueless`: no value. `--exec-path` without `=`, `--html-path`, `--man-path` and
 *   `--info-path` print a path and **exit**; `-h`, `--help`, `-v` and `--version` end git's options
 *   (`:167`) and become the verb `help` or `version` (`cmd_main`). Reading on past any of them for a
 *   verb is stricter than git's own reading, which runs nothing after them.
 *
 * Not declared, so unreadable: `--super-prefix` (no occurrence in `git.c` at `v2.47.3`; it was in
 * the value list before WP-218), `--shallow-file=` (git's branch is an exact `strcmp`), `-C=`,
 * `-c=`, `-c<key>` written attached (the boundary still judges its key first: a stricter reading
 * than git's, which refuses the word), and `--` (git answers *unknown option* at `:355`).
 */
export const GIT_GLOBAL_OPTIONS: Readonly<
  Record<string, { readonly shape: GitGlobalOptionShape; readonly line: number }>
> = {
  '--help': { shape: 'valueless', line: 167 },
  '-h': { shape: 'valueless', line: 167 },
  '--version': { shape: 'valueless', line: 168 },
  '-v': { shape: 'valueless', line: 168 },
  '--exec-path': { shape: 'valueless', line: 174 },
  '--exec-path=': { shape: 'equals', line: 174 },
  '--html-path': { shape: 'valueless', line: 182 },
  '--man-path': { shape: 'valueless', line: 186 },
  '--info-path': { shape: 'valueless', line: 190 },
  '-p': { shape: 'valueless', line: 194 },
  '--paginate': { shape: 'valueless', line: 194 },
  '-P': { shape: 'valueless', line: 196 },
  '--no-pager': { shape: 'valueless', line: 196 },
  '--no-lazy-fetch': { shape: 'valueless', line: 200 },
  '--no-replace-objects': { shape: 'valueless', line: 205 },
  '--git-dir': { shape: 'separate', line: 210 },
  '--git-dir=': { shape: 'equals', line: 220 },
  '--namespace': { shape: 'separate', line: 224 },
  '--namespace=': { shape: 'equals', line: 234 },
  '--work-tree': { shape: 'separate', line: 238 },
  '--work-tree=': { shape: 'equals', line: 248 },
  '--bare': { shape: 'valueless', line: 252 },
  '-c': { shape: 'separate', line: 260 },
  '--config-env': { shape: 'separate', line: 268 },
  '--config-env=': { shape: 'equals', line: 276 },
  '--literal-pathspecs': { shape: 'valueless', line: 278 },
  '--no-literal-pathspecs': { shape: 'valueless', line: 282 },
  '--glob-pathspecs': { shape: 'valueless', line: 286 },
  '--noglob-pathspecs': { shape: 'valueless', line: 290 },
  '--icase-pathspecs': { shape: 'valueless', line: 294 },
  '--no-optional-locks': { shape: 'valueless', line: 298 },
  '--shallow-file': { shape: 'separate', line: 302 },
  '-C': { shape: 'separate', line: 308 },
  '--list-cmds=': { shape: 'equals', line: 321 },
  '--attr-source': { shape: 'separate', line: 335 },
  '--attr-source=': { shape: 'equals', line: 345 },
  '--no-advice': { shape: 'valueless', line: 350 },
};

/** One global option {@link readGitGlobalOptions} read: its spelling, its value, and its index. */
export interface GitGlobalOption {
  /** The option without `=` and value (`--git-dir` for `--git-dir=x`). */
  readonly option: string;
  /** Its value, or `null` for a valueless option and for a separate one at the end of the argv. */
  readonly value: string | null;
  /** The index of the option's own word in the words read. */
  readonly index: number;
}

/** The one reading of git's words before the verb (WP-218). */
export interface GitGlobalOptionReading {
  /** The declared options before the verb (or before the undeclared word), in order. */
  readonly options: readonly GitGlobalOption[];
  /** The index of the verb, or `null` when there is none or an undeclared word stands first. */
  readonly verb: number | null;
  /** The index of the first word that starts with `-` and {@link GIT_GLOBAL_OPTIONS} does not declare. */
  readonly undeclared: number | null;
}

/**
 * **The** reader of git's global options (WP-218): `words` is a `git` argv after argv[0], dequoted.
 * `gitSubcommandOf`, `unreadableGitWord` and the boundary's `checkGitArgv` all take the verb and
 * the options before it from here, so they cannot read the same line differently.
 */
export const readGitGlobalOptions = (words: readonly string[]): GitGlobalOptionReading => {
  const options: GitGlobalOption[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (!word.startsWith('-')) {
      return { options, verb: index, undeclared: null };
    }
    const equals = word.indexOf('=');
    const key = equals > 0 ? word.slice(0, equals + 1) : word;
    const declared = Object.hasOwn(GIT_GLOBAL_OPTIONS, key) ? GIT_GLOBAL_OPTIONS[key] : undefined;
    if (declared === undefined) {
      return { options, verb: null, undeclared: index };
    }
    if (declared.shape === 'equals') {
      options.push({ option: word.slice(0, equals), value: word.slice(equals + 1), index });
    } else if (declared.shape === 'separate') {
      options.push({ option: word, value: words[index + 1] ?? null, index });
      index += 1;
    } else {
      options.push({ option: word, value: null, index });
    }
  }
  return { options, verb: null, undeclared: null };
};

/**
 * The subcommand of a `git` argv (`name` is `git` or `git-<sub>`), past git's own options — or
 * `null` when an option word git's grammar does not declare stands first (WP-218), which fails
 * closed: an unnamed subcommand reads every letter and keeps every floor.
 */
const gitSubcommandOf = (name: string, words: readonly string[]): string | null => {
  if (name !== 'git') {
    return name.slice('git-'.length);
  }
  const { verb } = readGitGlobalOptions(words);
  return verb === null ? null : (words[verb] as string);
};

/** The table of a subcommand, if the generated data has one (never an inherited property). */
const gitTableOf = (subcommand: string | null): GitLongOptionTable | undefined =>
  subcommand !== null && Object.hasOwn(GIT_LONG_OPTIONS, subcommand)
    ? GIT_LONG_OPTIONS[subcommand]
    : undefined;

/**
 * WP-161 (b): the floor for every abbreviation of one hazardous spelling. A git word `--t` or `--t=v`
 * before a bare `--`, in any argv candidate (so behind any wrapper), is floored at the hazard's kind
 * whenever `t` is a prefix of `spelling` — **unless** git's own resolution of `t` against the
 * subcommand's table (`GIT_LONG_OPTIONS`, generated from the run image's git) answers exactly one
 * option and that option is not hazardous (`git diff --text`, `git commit --verify`). If it answers
 * another hazardous spelling, that spelling's entry floors it instead. The table can only remove a
 * floor, and only by git's rule; an ambiguous `t` stays floored, which costs nothing because git
 * refuses it. Short options are not read here (`-n` and `rebase -x` have entries of their own).
 */
const gitAbbreviationFloor = ({
  spelling,
  kind,
  hazard,
}: GitAbbreviationHazard): HazardousArgument => ({
  pattern: `git --${spelling} abbreviated (any prefix of it git could resolve to it, e.g. --${spelling.slice(0, Math.max(2, spelling.length - 2))})`,
  kind,
  verbs: ['git'],
  // The full spelling's entry declares the option's environment names; an abbreviation is the
  // same option, so declaring them here too would spell them twice.
  environment: [],
  hazard: `git accepts any unambiguous prefix of a long option, so this is --${spelling}: ${hazard}`,
  tokens: ({ name, flags, words }) => {
    if (name !== 'git' && !name.startsWith('git-')) {
      return false;
    }
    const table = gitTableOf(gitSubcommandOf(name, words));
    return flags.some((flag) => {
      const word = /^--([^=]+)/.exec(flag)?.[1];
      if (word === undefined || !spelling.startsWith(word)) {
        return false;
      }
      const resolved = gitResolvesLongOption(table, word);
      return resolved === null || resolved === spelling;
    });
  },
});

const isMakeName = (name: string): boolean => MAKE_VERBS.some((verb) => name.startsWith(verb));

/**
 * The npm and pnpm options that hand the tool a program or any configuration key, each with the
 * prefix it is floored from. A prefix is the shortest unique to the option among **npm 11**'s option
 * names — the run image's npm (`node:24-trixie-slim`), where nopt resolves a unique prefix (npm 12
 * refuses abbreviations outright) — or shorter (`node`, floored since WP-54). `--editor`,
 * `--browser` and `--viewer` are WP-197's (backlog 580): `npm edit` splits `editor` on whitespace
 * and spawns it, `npm docs` and `npm help` with `viewer=browser` hand `browser` to a shell, and
 * `viewer` picks the program `npm help` runs. Each row declares its environment spellings (WP-199,
 * backlog 583), read off npm 11's `workspaces/config/lib/definitions/definitions.js` (v11.6.2,
 * retrieved 2026-10-18): npm reads every setting from `npm_config_<key>` in any case, so that prefix
 * is declared once, on `config.<key>` — the floor that already stands for any key — and covers
 * `npm_config_script_shell`, `npm_config_editor`, `npm_config_browser` and `npm_config_viewer`
 * too.
 */
const NPM_OPTION_FLOORS: readonly {
  option: string;
  prefix: string;
  hazard: string;
  environment: readonly FloorEnvironmentName[];
}[] = [
  {
    option: 'script-shell',
    prefix: 'scr',
    hazard: 'npm and pnpm run the package script under the --script-shell binary instead of sh',
    // `script-shell` reads no environment variable of its own (`default: null`); its
    // `npm_config_script_shell` spelling is `config.<key>`'s prefix.
    environment: [],
  },
  {
    option: 'node-options',
    prefix: 'node',
    hazard:
      'npm turns --node-options into NODE_OPTIONS, so `--import=data:…` runs model-written code',
    // node reads NODE_OPTIONS itself (https://nodejs.org/api/cli.html#node_optionsoptions). Any
    // case, as WP-196 matched it: the closed side.
    environment: [{ name: 'NODE_OPTIONS', anyCase: true }],
  },
  {
    option: 'config.<key>',
    prefix: 'config.',
    hazard:
      'pnpm `--config.<key>=` sets any configuration key, including `node-options` and `script-shell` (on npm, floored as a precaution; not measured)',
    // npm reads any setting from `npm_config_<key>`, matched case-insensitively
    // (https://docs.npmjs.com/cli/v11/using-npm/config#environment-variables); pnpm 11 and later
    // read `pnpm_config_<key>` and, since 11.0.6, `PNPM_CONFIG_<key>` instead, and no longer
    // `npm_config_*` (https://pnpm.io/configuring; the repository pins pnpm 12). Both in any case:
    // the closed side.
    environment: [
      { name: 'npm_config_*', anyCase: true },
      { name: 'pnpm_config_*', anyCase: true },
    ],
  },
  {
    option: 'editor',
    prefix: 'ed',
    hazard: 'npm edit spawns the --editor value as a program',
    // definitions.js: `const editor = process.env.EDITOR || process.env.VISUAL || …`, the
    // `editor` default ("The EDITOR or VISUAL environment variables").
    environment: ['EDITOR', 'VISUAL'],
  },
  {
    option: 'browser',
    prefix: 'br',
    hazard: 'npm docs and npm help run the --browser value as a shell string',
    // `browser` defaults to `xdg-open` on Linux, which runs `$BROWSER` when it is set (xdg-utils,
    // https://portland.freedesktop.org/doc/xdg-open.html; the generic-desktop branch). Not npm's
    // own read: xdg-open's, for the same effect.
    environment: ['BROWSER'],
  },
  {
    option: 'viewer',
    prefix: 'vi',
    hazard: 'npm help runs the --viewer value as its viewer',
    // `viewer` reads no environment variable of npm's own (`default: isWindows ? 'browser' :
    // 'man'`); its `npm_config_viewer` spelling is `config.<key>`'s. `man`, the default viewer,
    // runs `MANPAGER`, else `PAGER`, as its pager (man(1), ENVIRONMENT) — man's names for the
    // viewer's own effect, declared here once (WP-200, backlog 586). By the wherever-it-stands rule
    // `PAGER='sh -c id' git log` names npm too: git reads `PAGER` after `GIT_PAGER` and
    // `core.pager`, and `GIT_PAGER` is the git boundary's (`unattended-commands.ts`).
    environment: ['MANPAGER', 'PAGER'],
  },
];

/** The names whose option words nopt parses: npm and pnpm, and their runners `npx` and `pnpx`. */
const NPM_OPTION_VERBS = ['npm', 'pnpm', 'npx', 'pnpx'] as const;

/**
 * An option word as nopt names it (WP-197 review round 2): every leading dash stripped (nopt reads
 * `-node-options` and `---node-options` as `--node-options`), the value after `=` dropped, and
 * every leading `no-` stripped, case-insensitively — nopt cancels a doubled `no-`, so
 * `--no-no-node-options=x` sets it; stripping an odd count too is the closed side. `null` for a
 * word that is not an option.
 */
const noptOptionName = (word: string): string | null => {
  if (!word.startsWith('-')) {
    return null;
  }
  let name = (word.replace(/^-+/, '').split('=')[0] as string).toLowerCase();
  while (name.startsWith('no-')) {
    name = name.slice(3);
  }
  return name;
};

/**
 * The words nopt reads as options: those before the first bare `--`, which npm and pnpm hand to the
 * script untouched (`npm test -- --browser=chromium`, review round 2). `npx` and `pnpx` also stop
 * at their command — the first word that is not an option and cannot be the value of the option
 * before it (one with no `=`).
 */
const npmOptionWords = (name: string, words: readonly string[]): readonly string[] => {
  const end = words.indexOf('--');
  const before = end < 0 ? words : words.slice(0, end);
  if (name !== 'npx' && name !== 'pnpx') {
    return before;
  }
  const command = before.findIndex(
    (word, index) =>
      !word.startsWith('-') && !/^-[^=]*$/.test(before[index - 1] ?? 'not-an-option'),
  );
  return command < 0 ? before : before.slice(0, command);
};

/** One floor per {@link NPM_OPTION_FLOORS} row: an option word whose nopt name begins with its prefix. */
const npmOptionFloor = ({
  option,
  prefix,
  hazard,
  environment,
}: (typeof NPM_OPTION_FLOORS)[number]): HazardousArgument => ({
  pattern: `npm/pnpm --${option} (any spelling nopt reads: every leading dash, a no- prefix, a prefix from --${prefix})`,
  kind: 'command',
  verbs: NPM_OPTION_VERBS,
  hazard,
  environment,
  tokens: ({ name, words }) =>
    (NPM_OPTION_VERBS as readonly string[]).includes(name) &&
    npmOptionWords(name, words).some((word) => noptOptionName(word)?.startsWith(prefix) === true),
});

/**
 * Arguments that turn an allow-listed verb into something else: the `find … -exec` hazard, gone
 * looking for on the rest of the shipped verbs instead of waiting for it to be reported.
 *
 * **Why these are a floor rather than more `DEFAULT_IMPLEMENTATION_ASK` entries.** An ask entry
 * only beats an allow entry by being the more literal pattern (`find * -exec*` has ten literal
 * characters against `find *`'s five). That arithmetic is not a safety property: the allow entry
 * `git push origin agentic/*` pins twenty-four characters, so an ask entry naming a flag —
 * `git push* --receive-pack*` pins twenty-three — *loses* to it, and the hazard stays `allow`.
 * These therefore floor the verdict at `ask` the way a redirection to a path does. They can only
 * tighten: a `block` verdict is untouched, and nothing here can make an `ask` into an `allow`.
 *
 * Matching is the block-list's (tokens or whole line), so a flag is caught wherever it sits and an
 * environment wrapper cannot hide it. The whole-line half over-matches slightly on quoted text
 * (`git commit -m "add -native support"` reads as `-n`); over-asking is the safe direction.
 *
 * Verified against the real tools rather than assumed (git 2.50.1, throwaway repository): a
 * `--upload-pack`/`--receive-pack`/`--exec` payload really is executed, and `git diff --output=`
 * and `git log --output=` really do write a path no redirection rule can see.
 *
 * **git abbreviates long options, so every git entry is matched by git's rule too** (WP-161 (b),
 * backlog 515). git 2.47.3 — the run image's — maps `--t` to an option whenever `t` is an
 * unambiguous prefix of one of its spellings in a parse-options table: `git commit --no-verif`
 * skipped a failing hook and `git fetch --upload-p=` ran its value (measured), while diff, revision
 * and global options are exact-only (`git diff --ext-dif` and `git log --textco` were refused). The
 * full-spelling entries below stay; beside them, one `gitAbbreviationFloor` per hazardous spelling
 * (`GIT_ABBREVIATION_HAZARDS`) floors any long word that is a prefix of it, unless git's own
 * resolution against the subcommand's generated table (`git-long-options.generated.ts`) answers one
 * option that is not hazardous. Short options are not abbreviations; `-n`, `rebase -x` and
 * `difftool -x` have entries of their own.
 */
export const HAZARDOUS_ARGUMENTS: readonly HazardousArgument[] = [
  // ── hands the verb an arbitrary command ──
  {
    pattern: 'git * --upload-pack*',
    kind: 'command',
    verbs: ['git'],
    // git documents no environment variable for --upload-pack; the transport's own (`GIT_SSH`,
    // `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND`) are the git boundary's (BD-025's 2026-10-06 amendment).
    environment: [],
    hazard:
      'git runs the --upload-pack value as a shell command on the far end, and with a local path as the remote that far end is this machine',
  },
  {
    pattern: 'git * --receive-pack*',
    kind: 'command',
    verbs: ['git'],
    // As for --upload-pack: none of its own; the transport's are the git boundary's.
    environment: [],
    hazard: 'the push-side twin of --upload-pack, and equally a shell command',
  },
  {
    // WP-214, backlog 613 row 4: git-clone(1) at 2.47.3 gives --upload-pack the short `-u
    // <upload-pack>`; git-ls-remote(1) does not (its option table has `--upload-pack` only), so
    // there is no ls-remote twin.
    pattern: 'git clone* -u*',
    kind: 'command',
    verbs: ['git'],
    // As for --upload-pack: none of its own; the transport's are the git boundary's.
    environment: [],
    hazard: 'git clone’s short spelling of --upload-pack, a shell command run on the far end',
  },
  /**
   * `--exec`, and since WP-160 (d) `git rebase`'s short spelling, `-x`: attached (`-xCMD`) or last
   * in a cluster (`-ix`, `-qx`) — git 2.47.3 (the run image's) and 2.54 each ran the command for all
   * three, and for `--ex`/`--exe`, the abbreviations git's option parser accepts. A token predicate
   * rather than the glob it was, because a glob could not read a cluster then; the glob's own reach (a
   * flag after any subcommand, quoting off) is the predicate's too. Since WP-214 a git glob floor
   * reads clusters by `FLOOR_OPTION_READINGS`; this predicate was kept, and over-reads where the
   * table would not (`-x` after a letter that takes a value), which is the safe direction.
   */
  {
    pattern: 'git * --exec*',
    kind: 'command',
    verbs: ['git'],
    // git has no editor option to floor, so the program git runs while it commits and rebases is
    // declared on the floor of the program `git rebase` runs (git-var(1), `GIT_EDITOR`; git-rebase(1)
    // and git(1), `GIT_SEQUENCE_EDITOR`: *"the editor used to edit the todo list of an interactive
    // rebase"*). `EDITOR` and `VISUAL`, git's fallback, are declared once, on npm's --editor.
    environment: ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR'],
    hazard:
      "--exec is git push's synonym for --receive-pack, git fetch-pack's for --upload-pack, and git rebase runs it (or -x) after each commit; it is not scoped to a subcommand because the next verb to grow one would be missed",
    tokens: ({ name, flags, positional }) =>
      (name === 'git' || name.startsWith('git-')) &&
      (flags.some((flag) => flag.startsWith('--exec') || /^--exe?(?:=|$)/.test(flag)) ||
        ((name === 'git-rebase' || positional.includes('rebase')) &&
          flags.some((flag) => /^-[^-]*x/.test(flag)))),
  },
  /**
   * `--extcmd`, and since WP-161 criterion (11) `git difftool`'s short spelling, `-x`: attached
   * (`-xCMD`), separate, or last in a cluster (`-yx`) — git 2.47.3 ran the command for each (PROGRESS
   * § WP-161). `git mergetool` rejects both `-x` and `--extcmd` (measured), so this names difftool
   * only; the hazard text said *"difftool and mergetool"* until WP-161. A token predicate for
   * `--exec`'s reason, and kept since WP-214 for the same one.
   */
  {
    pattern: 'git * --extcmd*',
    kind: 'command',
    verbs: ['git'],
    // git-difftool(1) documents no environment variable for --extcmd; its helper reads two
    // (`git-difftool--helper.sh`, git master, read 2026-10-18 — read, not measured):
    // `GIT_DIFFTOOL_EXTCMD`, which it `eval`s with the two file names, and `GIT_DIFF_TOOL`, the
    // tool whose `difftool.<tool>.cmd` it runs (WP-200, backlog 586).
    environment: ['GIT_DIFF_TOOL', 'GIT_DIFFTOOL_EXTCMD'],
    hazard: 'git difftool runs --extcmd (-x) once per changed file',
    tokens: ({ name, flags, positional }) =>
      (name === 'git' || name.startsWith('git-')) &&
      (flags.some((flag) => flag.startsWith('--extcmd')) ||
        ((name === 'git-difftool' || positional.includes('difftool')) &&
          flags.some((flag) => /^-[^-]*x/.test(flag)))),
  },
  {
    pattern: 'git * --ext-diff*',
    kind: 'command',
    verbs: ['git'],
    // git(1): *"GIT_EXTERNAL_DIFF … the program named by it is called to generate diffs"* — the
    // external driver --ext-diff turns on, from the environment instead of the repository.
    environment: ['GIT_EXTERNAL_DIFF'],
    hazard:
      "--ext-diff turns on the external diff driver the *repository's own* config names, and a repository is untrusted input (BD-022)",
  },
  {
    pattern: 'git * --textconv*',
    kind: 'command',
    verbs: ['git'],
    // The textconv driver is named by the repository's configuration only; git documents no
    // environment variable for it.
    environment: [],
    hazard: "--textconv runs the textconv filter the repository's config names (BD-022)",
  },
  {
    pattern: 'git * ext::*',
    kind: 'command',
    verbs: ['git'],
    // git(1): `GIT_ALLOW_PROTOCOL` *"behave as if protocol.allow is set to never, and each of the
    // listed protocols has protocol.<name>.allow set to always"* — listing `ext` turns ext:: on.
    environment: ['GIT_ALLOW_PROTOCOL'],
    hazard:
      "git's ext:: transport runs its argument as a shell command; it is refused unless protocol.ext.allow is set, which is the workspace's configuration and not this module's to promise",
  },
  {
    pattern: 'rg * --pre*',
    kind: 'command',
    verbs: ['rg'],
    // rg(1): `RIPGREP_CONFIG_PATH` names a file whose lines are prepended to the arguments, so it
    // carries --pre (and --hostname-bin) as written.
    environment: ['RIPGREP_CONFIG_PATH'],
    hazard: 'ripgrep runs the --pre command over every file it searches',
  },
  {
    pattern: 'rg * --hostname-bin*',
    kind: 'command',
    verbs: ['rg'],
    // Its environment spelling is `RIPGREP_CONFIG_PATH`, declared once, on --pre.
    environment: [],
    hazard: 'ripgrep runs the --hostname-bin command to label hyperlinks',
  },
  // ── writes a path that the `> file` rule never sees ──
  {
    pattern: 'git * --output*',
    kind: 'path',
    hazard: "git's diff family writes --output to any path, redirection-free",
  },
  {
    pattern: 'find * -fprint*',
    kind: 'path',
    hazard: 'GNU find writes -fprint/-fprintf/-fprint0 to any path, redirection-free',
  },
  { pattern: 'find * -fls*', kind: 'path', hazard: 'GNU find -fls writes a listing to any path' },
  {
    pattern: 'pip install* --target*',
    kind: 'path',
    hazard: 'installs into any directory, redirection-free',
  },
  {
    pattern: 'pip install* --root*',
    kind: 'path',
    hazard: 'installs under any root, redirection-free',
  },
  {
    pattern: 'pip install* --prefix*',
    kind: 'path',
    hazard: 'installs under any prefix, redirection-free',
  },
  {
    pattern: 'pip install* --log*',
    kind: 'path',
    hazard: 'writes a log to any path, redirection-free',
  },
  {
    pattern: 'pip install* --report*',
    kind: 'path',
    hazard: 'writes a report to any path, redirection-free',
  },
  // ── widens what the verb trusts ──
  {
    pattern: 'git push* *:*',
    kind: 'trust',
    hazard:
      'a refspec pushes to a destination ref of its own choosing, so `git push origin agentic/x:main` writes main under an allow entry that names only agentic/*; a remote spelled as a URL is caught by the same colon',
    // WP-218 (c), backlog 620: a predicate, so the verb is the one `readGitGlobalOptions` finds and
    // `git -C . push origin HEAD:main` carries the floor as the bare line does. As a whole-line glob
    // it could not see past a global option, and its token reading put `origin` where `*:*` stood.
    tokens: ({ name, words }) => {
      if (name === 'git-push') {
        return words.some((word) => word.includes(':'));
      }
      if (name !== 'git') {
        return false;
      }
      const { verb } = readGitGlobalOptions(words);
      return (
        verb !== null &&
        (words[verb] as string).startsWith('push') &&
        words.slice(verb + 1).some((word) => word.includes(':'))
      );
    },
  },
  {
    // Not scoped to `commit`, for `git * --exec*`'s reason and for a measured one. `git merge` is
    // allow-listed at the `conflict_resolution` stage (TD-027) and git-merge(1) says `--no-verify`
    // there *"bypasses the pre-merge and commit-msg hooks"*; because an allow glob's `*` spans
    // spaces, `git merge origin/main --no-verify` matches `git merge origin/*` and was `allow`
    // before this entry existed (measured with `evaluateCommand`). The next verb to grow the flag
    // would be missed the same way.
    pattern: 'git * --no-verify*',
    kind: 'trust',
    hazard:
      'skips the pre-commit, pre-merge and commit-msg hooks, which is where a repository runs its secret scan (BD-002) and its formatter',
  },
  // WP-214: read by git's own cluster rule (`FLOOR_OPTION_READINGS`), so `-an` and `-sn` carry it.
  { pattern: 'git commit* -n*', kind: 'trust', hazard: 'the short spelling of --no-verify' },
  // WP-214, backlog 613 row 3: git-am(1) at 2.47.3, *"When any of `--no-verify` or `-n` is given,
  // these are bypassed"* — the pre-applypatch and applypatch-msg hooks. The long spelling is the
  // entry above's.
  { pattern: 'git am* -n*', kind: 'trust', hazard: 'git am’s short spelling of --no-verify' },
  // WP-161 (b): every abbreviation git resolves to one of the long spellings above.
  ...GIT_ABBREVIATION_HAZARDS.map(gitAbbreviationFloor),
  /**
   * The two merge strategy flags, floored because product/19 §3's conflict-resolution bullet says
   * they are `ask` *"never allow"* and the closed allow set only answers for the position before
   * the ref: `git merge -s ours origin/main` matches no allow pattern, but
   * `git merge origin/main -s ours` matches `git merge origin/*`.
   *
   * They belong on this list rather than on `DEFAULT_IMPLEMENTATION_ASK` for the list's own reason
   * — an ask entry wins only by pinning more literal characters, and `git merge origin/*` pins
   * eighteen. git-merge(1), retrieved 2026-09-13: `-s ours` gives a merge whose *"resulting tree …
   * is always that of the current branch head, effectively ignoring all changes from all other
   * branches"*, and `-X ours`/`-X theirs` *"forces conflicting hunks to be auto-resolved cleanly by
   * favoring"* one side — the one outcome the stage's own prompt tells the model not to produce.
   */
  {
    pattern: 'git merge* -s*',
    kind: 'trust',
    hazard:
      'the `ours` merge strategy records the other branch as merged while discarding its tree, so the human merge that follows silently reverts it',
  },
  {
    pattern: 'git merge* --strategy*',
    kind: 'trust',
    hazard: 'the long spelling of -s, and --strategy-option is the long spelling of -X',
  },
  {
    pattern: 'git merge* -X*',
    kind: 'trust',
    hazard: 'resolves every conflicting hunk by deleting one side of it',
  },
  {
    pattern: 'pip install* --index-url*',
    kind: 'trust',
    hazard: 'installs from a package index nobody has read (BD-030)',
  },
  {
    pattern: 'pip install* --extra-index-url*',
    kind: 'trust',
    hazard: 'adds a package index nobody has read (BD-030)',
  },
  {
    pattern: 'pip install* --find-links*',
    kind: 'trust',
    hazard: 'adds a package source nobody has read (BD-030)',
  },
  // ── hands a project-command verb a command string the model chose (WP-54) ──
  //
  // PROJECT_COMMAND_ALLOW runs repository content, which only the sandbox bounds. These floors are
  // an **enumeration of known spellings** that run text written on the command line instead — each
  // listed one measured through `evaluateCommand` in `command-policy.test.ts` § "the project-command
  // floors" — and an enumeration can be incomplete: a tool's next flag, or a spelling nobody listed,
  // is not covered. They narrow what the model can author; they are not the boundary.
  {
    pattern: 'make VAR=value (a positional containing `=`)',
    kind: 'command',
    verbs: MAKE_VERBS,
    // `MAKEFLAGS` carries assignments too, and is declared once, on the -E entry. A variable a
    // makefile reads from the environment (`CC`) is repository content: the stated residual.
    environment: [],
    hazard:
      'a make argument with `=` that is not a flag is a command-line variable assignment — `X:=$(shell …)`, `SHELL=`, `.SHELLFLAGS=`, or an ordinary `V=1`, which can equally override a recipe variable such as `CC` — so every one is floored, while `--jobs=4` (a flag) is not',
    tokens: ({ name, positional }) =>
      isMakeName(name) && positional.some((token) => token.includes('=')),
  },
  // One glob per make name (WP-186): a glob is anchored at its first character, so `make*` alone
  // never reaches `gmake`; together they reach exactly `isMakeName`'s set.
  ...MAKE_VERBS.map(
    (verb): HazardousArgument => ({
      pattern: `${verb}* --e*`,
      kind: 'command',
      verbs: [verb],
      // make's names are declared once, on the -E entry, which floors every make verb.
      environment: [],
      hazard:
        'make --eval, spelled in full or by the prefixes GNU getopt accepts (`--ev`, `--eva`), evaluates the text as makefile source; `--environment-overrides` lets the environment replace the makefile’s variables',
    }),
  ),
  {
    pattern: 'make -…E… (a single-dash short-option cluster containing E)',
    kind: 'command',
    verbs: MAKE_VERBS,
    // GNU make manual §5.7.3 (*"Communicating Options to a Sub-make"*): make reads its flags,
    // `--eval` and `-e` included, from `MAKEFLAGS`, and GNU make from `GNUMAKEFLAGS` too; `MFLAGS`
    // is the historical spelling; §3.4 (*"The Variable MAKEFILES"*): the makefiles it names are
    // read first, which is --eval from a file. One entry for every make verb.
    environment: ['MAKEFLAGS', 'GNUMAKEFLAGS', 'MFLAGS', 'MAKEFILES'],
    hazard: 'the short spelling of make --eval, alone (`-E`) or inside a clustered flag (`-sE`)',
    tokens: ({ name, flags }) => isMakeName(name) && flags.some((flag) => /^-[^-]*E/.test(flag)),
  },
  {
    pattern: 'go* -exec*',
    kind: 'command',
    verbs: ['go'],
    // Its environment spelling is `GOFLAGS`, declared once, on -toolexec.
    environment: [],
    hazard: 'go test -exec runs the test binary under an arbitrary program',
  },
  {
    pattern: 'go* --exec*',
    kind: 'command',
    verbs: ['go'],
    // As for -exec.
    environment: [],
    hazard: 'the double-dash spelling of go -exec',
  },
  {
    pattern: 'go* -toolexec*',
    kind: 'command',
    verbs: ['go'],
    // `go help environment`: `GOFLAGS` is *"a space-separated list of -flag=value settings to apply
    // to go commands by default"* — any go flag, -exec, -toolexec and -ldflags included — and
    // `GOENV` names the configuration file `go env -w` writes, which can set `GOFLAGS`. The same
    // page documents programs go runs from its environment, which is -toolexec's effect:
    // `GOCACHEPROG` (*"a command … that implements the build cache"*), `GOAUTH` (*"a command …
    // to fetch authentication"*), `GOROOT` (where go finds its compiler and tools) and
    // `CGO_CFLAGS` (handed to the C compiler, which takes `-wrapper`).
    environment: ['GOFLAGS', 'GOENV', 'GOCACHEPROG', 'GOAUTH', 'GOROOT', 'CGO_CFLAGS'],
    hazard: 'go -toolexec runs an arbitrary program in front of every toolchain invocation',
  },
  {
    pattern: 'go* --toolexec*',
    kind: 'command',
    verbs: ['go'],
    // As for -toolexec, which declares the names.
    environment: [],
    hazard: 'the double-dash spelling of go -toolexec',
  },
  {
    pattern: 'go* -ldflags*extld*',
    kind: 'command',
    verbs: ['go'],
    // `go help environment`: `CC` and `CXX` are *"the command to use to compile C (C++) code"*,
    // and the go command hands that compiler to the linker as its `-extld`; `CGO_LDFLAGS` reaches
    // that linker — the floor's own effect (WP-200, backlog 586). `CC` is read by every C build, so
    // `CC=clang make` is uncertain too, naming go: the over-ask, named.
    environment: ['CC', 'CXX', 'CGO_LDFLAGS'],
    hazard:
      '`-ldflags=-extld=…` names the external linker, which is a program the command line chose',
  },
  {
    pattern: 'go* --ldflags*extld*',
    kind: 'command',
    verbs: ['go'],
    // As for -ldflags … -extld.
    environment: [],
    hazard: 'the double-dash spelling of go -ldflags … -extld',
  },
  {
    pattern: 'cargo* --config*',
    kind: 'command',
    verbs: ['cargo'],
    // The Cargo Book, *"Environment variables"* and *"Configuration"*: every configuration key
    // reads `CARGO_<KEY>` (`CARGO_BUILD_RUSTC`, `CARGO_TARGET_<triple>_RUNNER`, `CARGO_HOME`, the
    // directory of the config file itself), and cargo reads `RUSTC`, `RUSTC_WRAPPER`,
    // `RUSTC_WORKSPACE_WRAPPER`, `RUSTDOC`, `RUSTFLAGS` and `RUSTDOCFLAGS` (`-C linker=`).
    environment: ['CARGO_*', 'RUSTC*', 'RUSTDOC*', 'RUSTFLAGS'],
    hazard: 'cargo --config can set a target runner, which is an arbitrary command',
  },
  // npm's and pnpm's program-naming options, read as nopt reads them (WP-197 review round 2).
  ...NPM_OPTION_FLOORS.map(npmOptionFloor),
  {
    pattern: 'pip install -r http*',
    kind: 'trust',
    hazard:
      'the allow entry `pip install -r *` is meant to be a lockfile install; a requirements file fetched over the network is not one',
  },
  // ── hands a project-command verb a path to write or delete that the path guard never sees (WP-104) ──
  //
  // PROGRESS backlog 281: the workspace is where BD-024's protected paths live, and the write guard
  // judges only the Edit and Write tools, so a test runner told to write (or clear) a directory is
  // a write to a protected path with no BD-024 reason. Floored **always**, in every spelling the CLI
  // accepts, rather than only when the argument names a protected path: the evaluator does not know
  // the run's protected patterns, and handing them to it is a larger change than the floor. **The
  // over-block, stated**: `pytest --junitxml=reports/junit.xml` or `cargo test --target-dir /tmp/t`,
  // which touch no protected path, ask too.
  //
  // Spellings measured on 2026-09-30 rather than assumed: pytest 9.1.1 accepts `--basetemp=x`,
  // `--basetemp x`, `--junitxml`/`--junit-xml` with `=` or a space, and **refuses** a prefix
  // (`--basete=x`, `--junitx=x`: *"unrecognized arguments"*); cargo 1.96.0 accepts
  // `--target-dir=x` and `--target-dir x` and refuses `--target-di=x`. go was not on the machine,
  // so its spellings are **documented, not measured**: the `flag` package treats one or two dashes
  // as equivalent and takes `-o=x` beside `-o x`, which is what the four go entries floor, and
  // `go help testflag` says `-o` saves the binary and *"the test still runs (unless -c is
  // specified)"*, so `-c` is not required (https://pkg.go.dev/flag, https://pkg.go.dev/cmd/go).
  // A later CLI version that starts accepting prefixes moves these, like npm's (above).
  {
    pattern: 'pytest* --basetemp*',
    kind: 'path',
    hazard:
      'pytest --basetemp clears the directory it is given before the run and writes under it, and the path guard never sees that write (BD-024)',
  },
  {
    pattern: 'pytest* --junitxml*',
    kind: 'path',
    hazard: 'pytest --junitxml writes the report to any path the path guard never sees (BD-024)',
  },
  {
    pattern: 'pytest* --junit-xml*',
    kind: 'path',
    hazard: 'the other spelling pytest accepts for --junitxml',
  },
  {
    pattern: 'go* -o',
    kind: 'path',
    hazard:
      'go test -o (with or without -c) writes the compiled test binary to any path the path guard never sees (BD-024)',
  },
  { pattern: 'go* -o=*', kind: 'path', hazard: 'go test -o with its value attached' },
  { pattern: 'go* --o', kind: 'path', hazard: 'the double-dash spelling of go test -o' },
  {
    pattern: 'go* --o=*',
    kind: 'path',
    hazard: 'the double-dash spelling of go test -o=, value attached',
  },
  {
    pattern: 'cargo* --target-dir*',
    kind: 'path',
    hazard:
      'cargo test --target-dir writes the whole build tree under any directory the path guard never sees (BD-024), in either `--target-dir x` or `--target-dir=x`',
  },
  // ── more of the same: the profile, cache, debug and coverage outputs WP-104 named (WP-120) ──
  //
  // PROGRESS backlog 343, ruled: floored **always**, as for 281, with the same over-block —
  // `go test -coverprofile=cover.out`, `pytest -o xfail_strict=true`, `pytest --debug` and
  // `pytest --cov-report=xml:coverage.xml` touch no protected path and ask too. **Still an
  // enumeration** (BD-025): the flags nobody listed are named in `PROJECT_COMMAND_ALLOW`'s
  // docblock, and a tool's next path-writing flag is not covered.
  //
  // Spellings read off the tools' own sources on 2026-10-02 (neither go nor pytest is on this
  // machine, so nothing below ran the CLI itself):
  //  - go1.25.0, `src/cmd/go/internal/cmdflag/flag.go` `ParseOne`: `--` is reduced to `-` and the
  //    value is either `=`-attached or the next argument; no prefix matching (`fs.Lookup` of the
  //    exact name). `src/cmd/go/internal/test/flagdefs.go`: every flag below is in
  //    `passFlagToTest`, so `testflag.go` registers it again as `test.<name>` — `-test.trace=x` is
  //    `-trace=x`, and is also what reaches a test binary after `-args`. So eight spellings each:
  //    one or two dashes × with or without `test.` × `=` or a space.
  //  - pytest 9.0.2, `src/_pytest/config/argparsing.py`: an `argparse` parser with
  //    `allow_abbrev=False` (no prefix — WP-104 measured `--basete=x` refused on 9.1.1);
  //    `src/_pytest/helpconfig.py`: `-o`/`--override-ini` (`action="append"`, *"e.g. `-o
  //    strict_xfail=True -o cache_dir=cache`"*) and `--debug` (`nargs="?"`, `const=
  //    "pytestdebug.log"`, *"opened with 'w' and truncated"*). Python 3.14.6's `argparse`, with
  //    those two options declared the same way, was run here: it takes `-o k=v`, `-ok=v`,
  //    `-o=k=v`, `--override-ini k=v`, `--override-ini=k=v` and a short cluster (`-qo k=v`,
  //    `-qok=v`), refuses `--override`, and gives `--debug tests/` the value `tests/` — a bare
  //    `--debug` followed by a path writes that path.
  //  - pytest-cov 7.1.0, `src/pytest_cov/plugin.py` `validate_report`: annotate, html, xml, json,
  //    markdown, markdown-append and lcov *"may be followed by ':DEST'"*; term and term-missing
  //    only by `:skip-covered`. One value, `=`-attached or the next argument.
  //  Sources: https://github.com/golang/go/tree/go1.25.0/src/cmd/go/internal,
  //  https://github.com/pytest-dev/pytest/tree/9.0.2/src/_pytest,
  //  https://github.com/pytest-dev/pytest-cov/blob/v7.1.0/src/pytest_cov/plugin.py.
  ...GO_PATH_WRITING_TEST_FLAGS.map(goPathWritingFloor('optional')),
  // The test binary's own three (review round 1): `test.`-prefixed only, before or after `-args`.
  ...GO_PATH_WRITING_BINARY_FLAGS.map(goPathWritingFloor('required')),
  // The compiler's, linker's and assembler's (WP-241, backlog 641), read inside the value go hands
  // each tool. `path`, as go's own: under `auto` the line runs, as `go test` runs repository code.
  ...Object.entries(GO_TOOL_FLAG_OPTIONS).flatMap(([flag, options]) =>
    options.map(goToolPathWritingFloor(flag)),
  ),
  // Review round 1: `received` comes from the shared dequote (`argvWords`), which reads no `$`
  // or backtick expansion; those values fail closed here (braces are expanded since WP-243). (It also dropped a backslash inside double quotes
  // that bash keeps, until WP-242 made it keep that backslash for every floor, backlog 642.)
  {
    pattern:
      'go* -gcflags/-ldflags/-asmflags value the floors cannot read (quoted.Split refuses it, or bash may hand go other text)',
    kind: 'path',
    hazard:
      'a tool flag value the floors above cannot read fails closed: one `quoted.Split` refuses (go refuses it too, `load/flag.go:69-71`), or one holding a `$`, a backtick or a backslash inside double quotes, where the dequoted words this module reads may not be what bash hands go',
    tokens: ({ name, received, receivedUnsure = [] }) =>
      name.startsWith('go') &&
      received !== undefined &&
      Object.keys(GO_TOOL_FLAG_OPTIONS).some((flag) =>
        goToolValues(received, receivedUnsure, flag).includes(null),
      ),
  },
  // logcli's three (WP-221, backlog 624), as go's: floored always, `--part-path-prefix` with or
  // without `--merge-parts`.
  ...LOGCLI_PATH_WRITING_OPTIONS.map(logcliPathWritingFloor),
  // logcli's argument file (WP-231, backlog 626), as pytest's below. kingpin v2.4.0 (the version
  // logcli 3.7.7 vendors), `parser.go` `ParseContext.Next`
  // (https://github.com/alecthomas/kingpin/blob/v2.4.0/parser.go): a word starting with `@` that is
  // not an option is replaced by the file's lines — a flag's separate value too — and after a bare
  // `--` every word is a literal argument, so the words past it are not read. `=`-attached values
  // are never expanded. `path`, not `command`: under `auto` the line runs nothing a literal
  // `logcli query *` line would not (the three options it can carry are `path` floors themselves),
  // and `logcli*` keeps logcli off {@link FLOORED_NAMES}, as above.
  {
    pattern: 'logcli* @<file> (an argument read from a file, before --)',
    kind: 'path',
    hazard:
      'kingpin replaces an argument starting with `@` by the lines of a file the agent may have written, which can carry every logcli option floored here, and no pattern sees them',
    tokens: ({ name, words }) => {
      const end = words.indexOf('--');
      return (
        name === 'logcli' &&
        (end < 0 ? words : words.slice(0, end)).some((word) => word.startsWith('@'))
      );
    },
  },
  {
    pattern: 'pytest -o / --override-ini (any key, any spelling argparse accepts)',
    kind: 'command',
    verbs: ['pytest'],
    // pytest reference, *"Environment Variables"*: `PYTEST_ADDOPTS` *"contains a command-line
    // (parsed by the py:mod:`shlex` module) that will be prepended to the command line"* — every
    // flag floored here, -o included.
    environment: ['PYTEST_ADDOPTS'],
    hazard:
      'pytest -o sets any configuration key from the command line: `cache_dir` moves the cache (pytest writes under it, and `--cache-clear` deletes its `d` and `v` subdirectories), `log_file` writes a log, and `addopts` is read from the overridden configuration, so it re-adds any flag floored here — floored for every key, like pnpm --config.<key>',
    tokens: ({ name, flags }) =>
      name.startsWith('pytest') &&
      flags.some(
        (flag) =>
          pytestLongFlag('override-ini').test(flag) || pytestClusterValueOption(flag) === 'o',
      ),
  },
  {
    pattern: 'pytest* --debug*',
    kind: 'path',
    hazard:
      'pytest --debug truncates and writes its debug log to the path it is given — `--debug=<path>` or `--debug <path>`, since the value is optional and argparse takes the next word — and the path guard never sees that write (BD-024)',
  },
  {
    pattern: 'pytest --cov-report=<kind>:<dest> (either spelling)',
    kind: 'path',
    hazard:
      'pytest-cov writes an annotate, html, xml, json, markdown, markdown-append or lcov report to the destination after the colon, which the path guard never sees (BD-024)',
    tokens: ({ name, flags, positional }) =>
      name.startsWith('pytest') &&
      (flags.some((flag) => COV_REPORT_ATTACHED_DEST.test(flag)) ||
        (flags.includes('--cov-report') &&
          positional.some((token) => COV_REPORT_DEST.test(token)))),
  },
  // ── the rest of the list, and the arguments read from a file (WP-120 pre-review round) ──
  //
  // Floored **always**, as above. Spellings from the same pinned sources, plus Python 3.14.6's
  // `argparse` run with pytest's `-c`/`--config-file` declaration and `fromfile_prefix_chars="@"`:
  // `-c x`, `-cx`, `-c=x`, `--config-file x`, `--config-file=x`, `-qc x` and `-qcx` all set the
  // file, `--config x` does not; `@args.txt` is replaced by the file's lines wherever it sits —
  // after `-k`, and after `--` too (where the expansion is only a positional). **Over-block,
  // stated:** `pytest -c pytest.ini`, `pytest --log-file=/tmp/run.log`, `pytest --rootdir=.` and
  // `go test -pkgdir=/tmp/pkg` ask although they name no protected path.
  ...GO_PATH_WRITING_BUILD_FLAGS.map(goPathWritingFloor('none')),
  {
    pattern: 'pytest @<file> (an argument read from a file)',
    kind: 'command',
    verbs: ['pytest'],
    // Its environment spelling is `PYTEST_ADDOPTS`, declared once, on -o.
    environment: [],
    hazard:
      'pytest 9.0.2 builds its parser with `fromfile_prefix_chars="@"` (`src/_pytest/config/argparsing.py:463`), so any argument starting with `@` is replaced by the lines of a file the agent may have written — which can carry every flag floored here, and no pattern sees them',
    tokens: ({ name, flags, positional }) =>
      name.startsWith('pytest') && [...flags, ...positional].some((token) => token.startsWith('@')),
  },
  {
    pattern: 'pytest -c / --config-file (any spelling argparse accepts)',
    kind: 'command',
    verbs: ['pytest'],
    // pytest reference: `PYTEST_PLUGINS` *"contains comma-separated list of modules that should be
    // loaded as plugins"* — code from the repository, as a configuration file's `-p` would load.
    environment: ['PYTEST_PLUGINS'],
    hazard:
      'pytest -c <file> loads its configuration — `addopts`, `cache_dir`, `log_file` — from a file the agent may have written, so it re-adds any flag floored here (`src/_pytest/main.py`, `dest="inifilename"`; `config/findpaths.py` `determine_setup` reads it)',
    tokens: ({ name, flags }) =>
      name.startsWith('pytest') &&
      flags.some(
        (flag) =>
          pytestLongFlag('config-file').test(flag) || pytestClusterValueOption(flag) === 'c',
      ),
  },
  {
    pattern: 'pytest --log-file (exact name, = or a space)',
    kind: 'path',
    hazard:
      'pytest --log-file writes the run’s log to the path it is given, opened with `--log-file-mode`, whose default `w` truncates it (`src/_pytest/logging.py`) — the path guard never sees that write (BD-024); `--log-file-mode`, `--log-file-level` and the format options are other flags and are not floored',
    tokens: ({ name, flags }) =>
      name.startsWith('pytest') && flags.some((flag) => pytestLongFlag('log-file').test(flag)),
  },
  {
    pattern: 'pytest --rootdir (exact name, = or a space)',
    kind: 'path',
    hazard:
      'pytest --rootdir decides where the cache is written — `cache_dir` (default `.pytest_cache`) is resolved against it (`src/_pytest/cacheprovider.py`) — so `--rootdir=tests` writes new files under a protected tree the path guard never sees; it does not change which configuration file is read (`determine_setup` locates that from the arguments)',
    tokens: ({ name, flags }) =>
      name.startsWith('pytest') && flags.some((flag) => pytestLongFlag('rootdir').test(flag)),
  },
];

/**
 * The environment a platform-skill CLI reads to run a program, for a CLI whose subcommands have no
 * option to floor (WP-211 review round 1, backlog 625). Each is a `command` floor with **no
 * option** — its `tokens` never match — and is **not** on {@link HAZARDOUS_ARGUMENTS}, so it adds
 * names to {@link FLOOR_ENVIRONMENT} without putting the CLI on {@link FLOORED_NAMES}: a floored
 * name is known, and `glab alias set x '!sudo id'` would lose the unknown program rule's reading.
 * `PAGER`, `BROWSER`, `EDITOR` and `VISUAL` are npm's rows already; `HOME` and `XDG_CONFIG_HOME`,
 * which re-point every CLI's configuration, are the git boundary's (`GUARDED_GIT_ENVIRONMENT`).
 * **Residual, stated** (WP-211 review round 2): the configuration file itself. `glab config set
 * glab_pager x` reads `ask / auto / deny` — `deny` refuses it, and under `auto` it adds nothing a
 * direct run of `x` would not — and a Write-tool edit of glab's configuration file, used by a later
 * allowed `glab mr view`, is the file guard's residual (TD-030 tier 3, a file the run wrote).
 */
export const ENVIRONMENT_ONLY_FLOORS: readonly HazardousArgument[] = [
  {
    pattern: 'glab (environment)',
    kind: 'command',
    verbs: ['glab'],
    hazard:
      'glab runs its pager and editor from these, and its configuration directory holds `browser`, `glab_pager`, `editor` and `custom_headers` `valueFromCommand`, a command it runs',
    tokens: () => false,
    // `glab config --help` at 1.117.0 (`platform-runtime:s16`): `glab_pager` ("GLAB_PAGER takes
    // precedence over both"), `editor` ("`GLAB_EDITOR`, `VISUAL`, `EDITOR`"), `custom_headers`
    // ("valueFromCommand … glab runs it once for each process"); `GLAB_CONFIG_DIR` re-points the
    // file those keys are read from (the binary's own text: "Set to a directory path to override the
    // global configuration location").
    environment: ['GLAB_PAGER', 'GLAB_EDITOR', 'GLAB_CONFIG_DIR'],
  },
  {
    pattern: 'jira (environment)',
    kind: 'command',
    verbs: ['jira'],
    hazard: 'jira runs its pager, browser and editor from these',
    tokens: () => false,
    // jira-cli v1.7.0: `pkg/tui/helper.go` (`os.Getenv("JIRA_PAGER")`, then `PAGER`, then
    // `exec.Command(pager, …)`), `pkg/browser/browser.go` (`JIRA_BROWSER`, then `BROWSER`),
    // `pkg/surveyext/editor.go` (`JIRA_EDITOR`, then `VISUAL`, then `EDITOR`). Its configuration
    // (`JIRA_CONFIG_FILE`) names no program there.
    environment: ['JIRA_PAGER', 'JIRA_BROWSER', 'JIRA_EDITOR'],
  },
  {
    pattern: 'acli (environment)',
    kind: 'command',
    verbs: ['acli'],
    hazard:
      'acli reads its configuration from this directory, and what that configuration may run is not documented',
    tokens: () => false,
    // The one such name in the `acli` 1.3.39-stable binary (`grep -a`, `platform-runtime:s16`);
    // acli's source is not public, so the name is declared on the closed side `[unverified]`.
    // logcli 3.7.7 reads no environment that names a program (its `--help`: `LOKI_*` only).
    environment: ['ACLI_CONFIG_DIR'],
  },
];

/**
 * How a floored program's parser reads a single-dash option (WP-214, backlog 613; TD-030 tier 2).
 * `getopt`: a single-dash word is a cluster of one-character options read in order, and the first
 * one that takes a value ends the cluster, the rest of the word being its value — so to git `-an`
 * is `-a -n` and `-mn` is `-m` with the message `n`. `valued` names, per subcommand, the short
 * options that take a value, required or attached-optional alike (either ends the cluster).
 * **Omission fails closed**: a subcommand or a letter it does not name takes no value, so a floored
 * letter after it is read as an option (the over-ask, named: `-Zn`, were `Z` to take a value, is
 * floored). `whole`: every option is one word, the reading WP-204 left every floor on, with the
 * reason it is right for that program.
 */
export type FloorOptionReading =
  | { readonly reading: 'getopt'; readonly valued: Readonly<Record<string, string>> }
  | { readonly reading: 'whole'; readonly reason: string };

/**
 * Every program a floor's single-dash spelling is written for, on exactly one of the two readings
 * (the census in `unattended-commands.test.ts`); a program on neither keeps the whole-word reading. The
 * `hazard` reading of `entryFlagsMet` explodes a `getopt` program's clusters by this table, so it
 * changes the glob floors (`git commit* -n*`, `git merge* -s*`/`-X*`, `git am* -n*`, `git clone*
 * -u*`); the token predicates (`rebase -x`, `difftool -x`, make's `-E`, pytest's `-o`/`-c`) read
 * their own clusters, as they did.
 */
export const FLOOR_OPTION_READINGS: Readonly<Record<string, FloorOptionReading>> = {
  // git 2.47.3, the run image's: each subcommand's manual and its parse-options table in
  // `builtin/<subcommand>.c` (https://github.com/git/git/tree/v2.47.3, read 2026-10-19; the
  // sentences are quoted in PROGRESS § WP-214). `scripts/git-long-options.mjs` prints long options
  // only, so this table is written by hand.
  git: {
    reading: 'getopt',
    valued: {
      // git-commit(1): `-C <commit>`, `-c <commit>`, `-F <file>`, `-m <msg>`, `-t <file>`,
      // `-u[<mode>]`, `-S[<keyid>]`; `-a`, `-e`, `-i`, `-n`, `-o`, `-p`, `-q`, `-s`, `-v`, `-z` take none.
      commit: 'CFSctmu',
      // git-merge(1): `-m <msg>`, `-F <file>`, `-s <strategy>`, `-X <option>`, `-S[<keyid>]`; `-n`
      // is `--no-stat` and takes none, nor do `-e`, `-q`, `-v`.
      merge: 'FSXms',
      // git-am(1): `-C<n>`, `-p<n>`, `-S[<keyid>]`; `-3`, `-c`, `-i`, `-k`, `-m`, `-n`, `-q`, `-r`,
      // `-s`, `-u` take none.
      am: 'CSp',
      // git-clone(1): `-o <name>`, `-b <name>`, `-u <upload-pack>`, `-c <key>=<value>`, `-j <n>`;
      // `-l`, `-n`, `-q`, `-s`, `-v` take none.
      clone: 'bcjou',
    },
  },
  go: {
    reading: 'whole',
    reason:
      'Go’s flag package reads one or two dashes and a whole name (`-cover` is one flag, never `-c -o -v…`); exploded, `go test -cover` met the `go* -o` floor (WP-204, measured)',
  },
  find: {
    reading: 'whole',
    reason:
      'find’s primaries (`-fprint`, `-fls`) are whole words of its expression, never clusters',
  },
  pip: {
    reading: 'whole',
    reason:
      'not declared by WP-214, whose rows name git: pip’s parser is optparse (`src/pip/_internal/cli/parser.py`), which does cluster (`-qr`), so `pip install -r http*` keeps the whole-word reading and a cluster spelling is a filed residual',
  },
  pytest: {
    reading: 'whole',
    reason:
      'its single-dash floors (`-o`, `-c`) are token predicates that read argparse’s cluster themselves (`pytestClusterValueOption`); no glob floor of pytest’s names a short option',
  },
  ...Object.fromEntries(
    MAKE_VERBS.map((verb): [string, FloorOptionReading] => [
      verb,
      {
        reading: 'whole',
        reason:
          'its one single-dash floor, `-E`, is a token predicate that reads the cluster itself (`-sE`), and over-reads a value letter’s value rather than under-reads it',
      },
    ]),
  ),
};

export const DEFAULT_COMMAND_POLICY: ResolvedCommandPolicy = {
  allow: DEFAULT_IMPLEMENTATION_ALLOW,
  ask: DEFAULT_IMPLEMENTATION_ASK,
  block: DEFAULT_BLOCKED_COMMANDS,
};

/**
 * Every git subcommand a shipped allow, ask or block entry names (WP-161 (c)): the generator reads
 * a long-option table for each, and the census in `command-policy.test.ts` holds that each has one
 * or is listed as table-less (`GIT_TABLELESS_SUBCOMMANDS`).
 */
export const POLICY_GIT_SUBCOMMANDS: readonly string[] = [
  ...new Set(
    [
      ...DEFAULT_READ_ONLY_ALLOW,
      ...LOCKFILE_INSTALL_ALLOW,
      ...PROJECT_COMMAND_ALLOW,
      ...DEFAULT_IMPLEMENTATION_ALLOW,
      ...WORKSPACE_SETUP_ALLOW,
      ...DEFAULT_VERIFICATION_ALLOW,
      ...CI_VERIFICATION_BLOCK,
      ...CONFLICT_RESOLUTION_EXTRA_ALLOW,
      ...DEFAULT_IMPLEMENTATION_ASK,
      ...DEFAULT_BLOCKED_COMMANDS,
    ].flatMap((entry) => {
      const subcommand = /^git\s+([a-z][a-z0-9-]*)/.exec(entry)?.[1];
      return subcommand === undefined ? [] : [subcommand];
    }),
  ),
].sort();

// ── pattern matching ─────────────────────────────────────────────────────────

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * `text` with every line continuation (`\` + newline) outside single quotes taken out — once, as
 * bash takes it out before it splits words (WP-161 criterion (10), backlog 520). `su\⏎do id` is
 * `sudo id` to bash, and read with the backslash kept it was `su` and `do` to every classifier here,
 * so the block list, the git boundary and the hazard floor never saw it. Inside single quotes the
 * pair is two literal characters; an escaped backslash (`\\`) is kept whole, so the newline after
 * it stays a newline. A here-document body is not in the text this reads: the scanner cuts a body
 * that is data out of every fragment, and a body a shell runs is joined by that shell too.
 */
/**
 * Whether an unquoted `#` at `index` opens a comment: it begins a word — the text's start, or after a
 * blank or an operator character — as bash requires (`a#b` and `$#` are words, not comments).
 */
const startsComment = (text: string, index: number): boolean =>
  index === 0 || /[\s;&|()<>]/.test(text[index - 1] as string);

const joinQuotedContinuations = (text: string): string => {
  if (!text.includes('\\\n')) {
    return text;
  }
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quote === null && char === '#' && startsComment(text, index)) {
      // A comment runs to the newline, and a backslash in it is not a continuation (WP-161
      // criterion (14)): `ls # x \⏎sudo id` runs `sudo id` in bash 3.2, 5.2 and dash.
      const end = text.indexOf('\n', index);
      out += text.slice(index, end === -1 ? text.length : end);
      index = (end === -1 ? text.length : end) - 1;
    } else if (quote === "'") {
      quote = char === "'" ? null : quote;
      out += char;
    } else if (char === '\\') {
      if (text[index + 1] !== '\n') {
        out += text.slice(index, index + 2);
      }
      index += 1;
    } else {
      if (char === '"' || char === "'") {
        quote = quote === char ? null : quote === null ? char : quote;
      }
      out += char;
    }
  }
  return out;
};

/**
 * Collapses whitespace so `npm  test` and `npm test` are the same command, after taking out the
 * line continuations bash takes out (`joinQuotedContinuations`): every word this module classifies
 * is split from here (`tokenise`), so a continuation is removed before any word is read.
 */
export const normaliseCommand = (command: string): string =>
  joinQuotedContinuations(command).trim().replace(/\s+/g, ' ');

const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .replace(REGEX_SPECIALS, '\\$&')
      .replace(/\*/g, '[\\s\\S]*')
      .replace(/\?/g, '[\\s\\S]')}$`,
  );

/**
 * `globToRegExp` for a policy entry's own words (a block entry, a floor's glob), compiled once.
 * Its keys are the policy's patterns, never command text — every caller passes a pattern word —
 * so it stays module-level (review round 2); bounded anyway.
 */
const GLOB_CACHE = new Map<string, RegExp>();
const cachedGlob = (glob: string): RegExp => {
  let compiled = GLOB_CACHE.get(glob);
  if (compiled === undefined) {
    if (GLOB_CACHE.size >= 4_096) {
      GLOB_CACHE.clear();
    }
    compiled = globToRegExp(glob);
    GLOB_CACHE.set(glob, compiled);
  }
  return compiled;
};

/**
 * Glob matching over a whole command line: `*` matches any run of characters, `?` matches one.
 * Anchored at both ends — a pattern is a command, not a substring. This is what the allow- and
 * ask-lists use, and it remains one half of block matching.
 */
export const matchesCommandPattern = (pattern: string, command: string): boolean =>
  globToRegExp(normaliseCommand(pattern)).test(normaliseCommand(command));

/**
 * How specific a pattern is: the number of literal characters it pins down. `git push origin
 * agentic/*` is more specific than `git push*`, so the allow entry beats the ask entry for a push
 * to an `agentic/` branch — which is exactly the split product/19 §3 describes.
 */
const specificity = (pattern: string): number =>
  normaliseCommand(PRECISE_ALLOW_ENTRIES.get(pattern)?.envelope ?? pattern).replace(/\*/g, '')
    .length;

/** The most specific pattern in `patterns` that matches under `matches`. */
const bestMatch = (
  patterns: readonly string[],
  command: string,
  matches: (pattern: string, command: string) => boolean,
): string | undefined => {
  let best: string | undefined;
  for (const pattern of patterns) {
    if (
      matches(pattern, command) &&
      (best === undefined || specificity(pattern) > specificity(best))
    ) {
      best = pattern;
    }
  }
  return best;
};

// ── argv[0] normalisation ────────────────────────────────────────────────────

/** The last path segment of a resolved binary path, on either path separator. */
export const basename = (binaryPath: string): string =>
  binaryPath
    .split(/[/\\]/)
    .filter((part) => part.length > 0)
    .at(-1) ?? binaryPath;

/**
 * The package runners that run a command by their name alone (WP-196, backlog 575): `npx`,
 * `pnpx`, `bunx`, and `corepack <pm> …`, which runs `<pm> …`. Each is on {@link ARGV0_WRAPPERS};
 * the runners that need a subcommand first are {@link RUNNER_EXEC_SUBCOMMANDS}.
 */
const PACKAGE_RUNNER_COMMANDS: readonly string[] = ['npx', 'pnpx', 'bunx', 'corepack'];

/**
 * A package runner's exec form (WP-196 (b), backlog 575): the subcommands after which it runs the
 * command that follows (`npm exec -- sudo id`, `bun x make 'X=1'`). Under any other subcommand
 * (`npm test`, `pnpm run build`) the runner is the command, as before. `yarnpkg` is the name the
 * stock image ships beside `yarn` for the same binary (measured, `platform-runtime`).
 */
const RUNNER_EXEC_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['exec', 'dlx']),
  yarn: new Set(['dlx', 'exec']),
  yarnpkg: new Set(['dlx', 'exec']),
  bun: new Set(['x']),
  // `sentry-cli monitors run <slug> -- <command>` (WP-205 (e), backlog 608): `run` after `monitors`
  // only, and its grammar is `WRAPPER_GRAMMARS`' `sentry-cli run`.
  'sentry-cli': new Set(['run']),
  // WP-211 (b), backlog 606: `composer exec <binary>` "executes a vendored binary/script" as `npx`
  // runs a package's (https://getcomposer.org/doc/03-cli.md#exec, read 2026-10-19). Its command word
  // is a built-in only when it is a canonical name exactly; any other word may be a script (`composerSubcommandAt`);
  // `run-script`/`run` hands a `composer.json` script to a shell and is `runnerSubcommandAt`'s
  // `'string'`. Not on `PACKAGE_RUNNER_COMMANDS`: it runs nothing by its name.
  composer: new Set(['exec']),
};

/**
 * Words that stand in front of the command that actually runs: environment wrappers, shell
 * keywords and grouping tokens. A block pattern names the real binary, so these are peeled off
 * before matching — otherwise `env sudo id` and `then sudo id` read as `env` and `then` commands.
 */
/**
 * `setarch` and the names util-linux installs as links to it (WP-203 review round 2): `uname26`,
 * `linux32` and `linux64` everywhere, and the per-architecture names its build adds
 * (`sys-utils/Makemodule.am`'s `SETARCH_LINKS`, https://github.com/util-linux/util-linux). Each
 * runs `/bin/sh` when given no program (https://manpages.debian.org/trixie/util-linux/setarch.8.en.html).
 */
const SETARCH_NAMES: readonly string[] = [
  'setarch',
  'uname26',
  'linux32',
  'linux64',
  'i386',
  'x86_64',
  's390',
  's390x',
  'ppc',
  'ppc32',
  'ppc64',
  'sparc',
  'sparc32',
  'sparc32bash',
  'sparc64',
  'mips',
  'mips32',
  'mips64',
  'ia64',
  'parisc',
  'parisc32',
  'parisc64',
];

/**
 * The node image's entrypoint (`/usr/local/bin/docker-entrypoint.sh` in `platform-runtime:s16`,
 * read there): `node "$@"` when its first argument starts with `-` or names no command, else
 * `exec "$@"`. It has no options of its own, so {@link commandNameWalk} reads a leading option as
 * `node`'s and stops at the entrypoint (WP-207).
 */
const NODE_ENTRYPOINT = 'docker-entrypoint.sh';

const ARGV0_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'nice',
  'ionice',
  'xargs',
  // Commands that run the rest of their line as a program (first local test, 2026-10-06): a
  // developer run wrapped its pushes as `timeout 180 git push …`, and with `timeout` unknown here
  // the git boundary never saw a `git push`, so `timeout 180 git push --no-verify …` and a refspec
  // push were allowed. Every one of these takes options or an argument before the command, which
  // the suffix walk below skips by trying each start position.
  'timeout',
  'stdbuf',
  'setsid',
  'flock',
  'chrt',
  'taskset',
  'unbuffer',
  'watch',
  'strace',
  'ltrace',
  'nsenter',
  'unshare',
  // An applet or package runner (WP-188, backlog 559): `busybox make 'X=1'` runs make's applet and
  // `npx make 'X=1'` a bin named `make`, so the floors and the block list read the word after it
  // as the command, and an `xargs` into either is an input-driven runner (`xargsRunsItsInput`).
  // WP-196 (backlog 575): every package runner that needs no subcommand, read the way `npx` is.
  'busybox',
  ...PACKAGE_RUNNER_COMMANDS,
  'runuser',
  'su',
  'doas',
  // WP-203 (backlog 599): the run image's own argv wrappers (`command -v` in `platform-runtime:s16`
  // finds every one but `i386` and `x86_64`, which util-linux ships on x86 only), each running its
  // operands as a program: coreutils' `chroot NEWROOT CMD` and `runcon CONTEXT CMD`
  // (https://manpages.debian.org/trixie/coreutils/chroot.8.en.html,
  // https://manpages.debian.org/trixie/coreutils/runcon.1.en.html); util-linux's `setpriv`,
  // `setarch ARCH` and its per-architecture names, `prlimit` and `uclampset`
  // (https://manpages.debian.org/trixie/util-linux/setpriv.1.en.html, …/setarch.8.en.html,
  // …/prlimit.1.en.html, …/uclampset.1.en.html); dpkg's `start-stop-daemon --exec PATH -- ARGS`
  // (https://manpages.debian.org/trixie/dpkg/start-stop-daemon.8.en.html).
  'chroot',
  'runcon',
  'setpriv',
  ...SETARCH_NAMES,
  'prlimit',
  'uclampset',
  'start-stop-daemon',
  // WP-207 (backlog 603): the rest of the run image's exec shims, from a reading of every
  // `/usr/bin`, `/usr/sbin` and `/usr/local/bin` name in `platform-runtime:s16` (PROGRESS § WP-207;
  // the dynamic loader joins by `DYNAMIC_LOADER_NAME`). openssh-client's `ssh-agent … command [arg
  // …]` (https://manpages.debian.org/trixie/openssh-client/ssh-agent.1.en.html), sysvinit-utils'
  // `fstab-decode COMMAND [ARGUMENT …]` (…/sysvinit-utils/fstab-decode.8.en.html), util-linux's
  // `choom -n number [--] command` and `switch_root newroot init` (…/util-linux/choom.1.en.html,
  // …/util-linux/switch_root.8.en.html), debconf's `debconf [options] command` and
  // `debconf-apt-progress [--] command` (…/debconf/debconf.1.en.html,
  // …/debconf/debconf-apt-progress.1.en.html), and the node image's `docker-entrypoint.sh`, which
  // ends `exec "$@"` (read in the image).
  'ssh-agent',
  'fstab-decode',
  'choom',
  'switch_root',
  'debconf',
  'debconf-apt-progress',
  NODE_ENTRYPOINT,
  // Not `sudo`: the block list bans it by name (`sudo *`), and peeling it would report the inner
  // command's match instead of that one (the `denied-tool` golden pins the reason a run reads).
  'builtin',
  'sh',
  'bash',
  'zsh',
  'dash',
  'eval',
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  'done',
  'fi',
  'for',
  'case',
  'esac',
  '{',
  '}',
  '!',
  '[[',
  ']]',
  // A keyword that runs the rest of its line as an asynchronous command (WP-158 review round 1's
  // sibling sweep): without it, `coproc sudo id` and `coproc git push --force origin main` read
  // as a `coproc` command and were `unattended_auto` (measured).
  'coproc',
]);

/**
 * The dynamic loader, which runs a program given to it "directly": `/lib/ld-linux.so.* [OPTIONS]
 * [PROGRAM [ARGUMENTS]]` (WP-207, backlog 603; https://manpages.debian.org/trixie/manpages/ld.so.8.en.html).
 * Its file name carries the architecture — `ld-linux-aarch64.so.1` on arm64, `ld-linux-x86-64.so.2`
 * on amd64 (https://packages.debian.org/trixie/arm64/libc6/filelist,
 * https://packages.debian.org/trixie/amd64/libc6/filelist), and `/usr/bin/ld.so` links to it in
 * `platform-runtime:s16` — so it joins {@link ARGV0_WRAPPERS} by this declared pattern of the
 * loader's own spellings, tested where that set is consulted ({@link isArgv0Wrapper}, its grammar
 * key, and the judged names of `unknownProgramReasons`, which derive from it) and nowhere else.
 */
const DYNAMIC_LOADER_NAME =
  /^(?:ld-linux-[\s\S]*\.so\.[\s\S]*|ld-linux\.so\.[\s\S]*|ld-musl-[\s\S]*\.so\.[\s\S]*|ld64\.so\.[\s\S]*|ld\.so)$/;

/** Whether a name (an `argv0Name`) is on {@link ARGV0_WRAPPERS} or is the dynamic loader. */
const isArgv0Wrapper = (name: string): boolean =>
  ARGV0_WRAPPERS.has(name) || DYNAMIC_LOADER_NAME.test(name);

/** The key of a wrapper's grammar: the loader's spellings share one ({@link DYNAMIC_LOADER_NAME}). */
const wrapperGrammarKey = (name: string): string =>
  DYNAMIC_LOADER_NAME.test(name) ? 'ld.so' : name;

/**
 * One token with the shell's quoting and escaping taken off, which is what the program on the
 * other side of the fork actually receives.
 *
 * This is the root fix for round 2's first finding. Classification — is this token a flag, a
 * wrapper, an assignment, argv[0]? — was done on the *written* token, so `"--upload-pack=…"` read
 * as a positional and `-\-upload-pack=…` read as a word starting with `-\`. Neither is true of
 * what `git` receives: quoting decides how the shell *splits* a line, never what a program sees
 * inside one word. That gap reopened `find . "-exec"` and `git rebase '--exec='` as well.
 *
 * Unbalanced quotes are simply dropped: a line whose quoting does not close is already floored at
 * `ask` by rule 5, so being generous here can only tighten.
 *
 * Inside `"…"` a backslash is kept unless the next character is `$`, a backtick, `"`, `\` or a
 * newline (bash, *Double Quotes*: https://www.gnu.org/software/bash/manual/bash.html#Double-Quotes;
 * WP-242, backlog 642): `"\--"` is `\--` to the program, a positional after which npm's nopt goes
 * on reading options (measured, npm 11.19.0). {@link literalValue} carries the same rule and stays
 * a function of its own: it reads a word `isLiteralWord` has admitted (balanced, no expansion) and
 * drops a `\<newline>` anywhere, while this one reads every word every floor shares, unbalanced
 * quotes included, and leaves a newline as it was.
 *
 * A `$` outside quotes immediately before a `"` is dropped and the `"` opens double quoting (bash,
 * *Locale-Specific Translation*: https://www.gnu.org/software/bash/manual/bash.html#Locale-Translation
 * — with no translation *the dollar sign is ignored*; WP-244, backlog 643; TD-030's amendment of
 * 2026-10-20): `$"--script-shell=/bin/id"` is `--script-shell=/bin/id` to npm (measured, bash 5.2.37
 * in the run image, which ships no catalogue). Inside `"…"` or `'…'` the `$` stays (`"$"x` is `$x`).
 * `$'…'` is not read here: the tokeniser refuses it (`ansiCQuoting`), because its escapes compose a
 * name. The residual is a catalogue the run supplies, which may translate the text into anything.
 */
const unquoteToken = (token: string): string => {
  if (!/["'\\]/.test(token)) {
    return token;
  }
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index] as string;
    if (quote === null && char === '$' && token[index + 1] === '"') {
      // `$"…"` with no catalogue: bash ignores the `$` and the text is double-quoted (WP-244).
    } else if (quote === null && (char === '"' || char === "'")) {
      quote = char;
    } else if (quote !== null && char === quote) {
      quote = null;
    } else if (char === '\\' && quote !== "'") {
      index += 1;
      const next = token[index] ?? '';
      out += quote === '"' && !'$`"\\\n'.includes(next) ? `\\${next}` : next;
    } else {
      out += char;
    }
  }
  return out;
};

/**
 * The line as the shell would hand it on, one space per word and no quoting left.
 *
 * **This whole line** is offered to the **ask**-list alongside the line as written, and never to
 * the allow-list: a pattern that only matches after the line is dequoted must be able to tighten
 * a verdict and never to loosen one. `"ls" -la` is therefore `ask`, not `allow`.
 *
 * The asymmetry is not absolute, and the exception is deliberate. Dequoting a single *token* is
 * how every classification works (`unquoteToken`, `argv0Name`), `stripEnvironmentPrefix` uses it
 * to recognise a wrapper, and the peeled remainder does reach the allow-list — so `"env" ls -la`
 * and `e\nv ls` are `allow`, exactly as `env ls -la` is. A differential sweep found 3 624 lines of
 * this family, every one of them returning the verdict of its unquoted twin. That is the
 * definition of the wrapper rule, not a way past it: what reaches the allow-list is still the
 * *rest of the line as written*, and `env` is on `ENVIRONMENT_WRAPPERS` precisely because it execs
 * what follows.
 */
export const dequoteCommand = (command: string): string =>
  tokenise(command).map(unquoteToken).join(' ');

/** `FOO=1 sudo …` — a leading assignment is environment, not the command. */
const isAssignment = (token: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]*=/.test(unquoteToken(token));

const isWrapperToken = (token: string): boolean =>
  isArgv0Wrapper(argv0Name(token)) || isAssignment(token);

/**
 * The name a package runner runs under: `argv0Name` with corepack's version pin taken off, so
 * `corepack pnpm@9 dlx …` is a `pnpm` (WP-196 review round 1).
 */
const runnerName = (word: string): string => argv0Name(word).replace(/@[\s\S]*$/, '');

/**
 * pnpm's spellings of `recursive` (pnpm 11 `pnpm/src/cmd/recursive.ts`, `commandNames`), which run
 * the command after them in every project (`pnpm m exec …`), so they are skipped as Yarn's
 * `workspace <name>` is (WP-196 review round 2).
 */
/**
 * pnpm's global options known to take a separate value (`-C`/`--dir`, `-F`/`--filter`,
 * `--workspace-dir`), whose value the built-in fallback must not read as the command (WP-196, the
 * orchestrator's round-3 probe). An option not listed is read as taking none, which over-reads
 * its value as an implicit exec; the shell-mode string is read on every word of the line anyway.
 */
const PNPM_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C',
  '--dir',
  '-F',
  '--filter',
  '--workspace-dir',
]);

const PNPM_RECURSIVE: ReadonlySet<string> = new Set(['recursive', 'multi', 'm']);

/**
 * pnpm's built-in commands this policy knows (WP-196 review round 2, backlog 578): pnpm runs a
 * first positional that is no built-in as `exec` (pnpm 11 `exec/commands/src/run.ts`,
 * `fallbackCommandUsed`), so **any other** first positional is read as the exec form — an over-read
 * for a built-in missing here, never a fail-open. A minimal list, not pnpm's own: pnpm 11's command
 * names are spread over its command packages (`pnpm/src/cmd/index.ts` imports them), and a word
 * wrongly added here would fail open, so only common built-ins are listed. `exec`, `dlx`,
 * `recursive` and `with` are read before this list.
 */
const PNPM_BUILT_INS: ReadonlySet<string> = new Set([
  'install',
  'i',
  'add',
  'remove',
  'update',
  'run',
  'test',
  'list',
  'why',
  'outdated',
  'audit',
  'store',
  'config',
  'init',
  'publish',
  'pack',
  'link',
  'unlink',
  'import',
  'rebuild',
  'prune',
  'fetch',
  'deploy',
  'env',
  'setup',
  'server',
  'start',
  'create',
  'patch',
  'patch-commit',
  'licenses',
  'root',
  'bin',
  'help',
]);

/** npm's exec form by its own resolution (npm 11 `lib/utils/cmd-list.js` `deref`), read closed. */
const npmExecWord = (value: string): boolean => value === 'x' || 'exec'.startsWith(value);

/**
 * Composer 2.10.3's built-in commands by their **canonical names** (`getDefaultCommands()` in
 * `src/Composer/Console/Application.php` and each command's `setName`,
 * https://github.com/composer/composer/tree/2.10.3/src/Composer/Command), plus Symfony Console's
 * `completion`. Read as that command only when the word is exactly one of them (WP-211 review
 * rounds 2 and 3). Not here, and so read as a word that may run a script: every alias (`i`, `r`,
 * `u`, `upgrade`, `info`, `home`, `rm`, …), `list`, `help` and `_complete`.
 */
const COMPOSER_COMMANDS: ReadonlySet<string> = new Set([
  'about',
  'config',
  'depends',
  'prohibits',
  'init',
  'install',
  'create-project',
  'update',
  'search',
  'validate',
  'audit',
  'show',
  'suggests',
  'require',
  'dump-autoload',
  'status',
  'archive',
  'diagnose',
  'run-script',
  'licenses',
  'global',
  'clear-cache',
  'remove',
  'browse',
  'exec',
  'outdated',
  'check-platform-reqs',
  'fund',
  'reinstall',
  'bump',
  'repository',
  'policy',
  'self-update',
  'completion',
]);

/**
 * The built-in Composer runs for a command word, **only when the word is exactly a built-in's
 * canonical name** (WP-211 review rounds 2 and 3, the last orchestrator-directed); `null` for any
 * other word, which Composer may run as a `composer.json` script. Composer 2.10.3 loads the
 * project's scripts when the raw word is not the resolved name (`src/Composer/Console/Application.php:267`,
 * `$mayNeedScriptCommand = $mayNeedPluginCommand || … || $rawCommandName !== $commandName`) and for
 * no command word, `list`, `help` and `_complete` (`:256`–`:265`, `$mayNeedPluginCommand`). A script
 * is skipped only when its **name** is a built-in's (`:383`, `$this->has($script)`), but its
 * `scripts-aliases` reach Symfony Console 5.4.47's `Application::add`, which writes
 * `$this->commands[$alias] = $command` over a built-in's alias
 * (https://github.com/symfony/console/blob/v5.4.47/Application.php#L547). Symfony's `find` answers
 * an exact entry before any prefix or case-folded match (`:685`, `if ($this->has($name))`). So an
 * alias, a prefix, a case-folded name, `list`, `help` and a bare `composer` may all run a script,
 * and an exact canonical name — whose raw word is its name, so no script is loaded — may not.
 */
const composerCommandOf = (word: string): string | null =>
  COMPOSER_COMMANDS.has(word) ? word : null;

/**
 * Where Composer's exec form stands (WP-211 (b) and review round 1): the command word is the first
 * word that is no option and no `-d`/`--working-dir` value (Composer binds its global definition
 * before reading it, `getCommandNameBeforeBinding`), read by {@link composerCommandOf}. `exec` is
 * the exec form; `run-script` hands a `composer.json` script to a shell (`'string'`); `global`
 * reads the next command word; any word that is not exactly a built-in's canonical name, and no
 * command word at all, is `'unknown'` — an alias, a prefix, a case-folded name, a script or a typo, any of which Composer may run as a
 * `composer.json` script — and any other command is `null`. **The cost, stated:** `composer EXEC
 * git push --no-verify` reads `runnerSubcommand` rather than the git boundary's reason; the block
 * list still reads past the word (`composer EXEC sudo id` is blocked).
 */
const composerSubcommandAt = (
  words: readonly string[],
  head: number,
): number | null | 'unknown' | 'string' => {
  for (let index = head + 1; index < words.length; index += 1) {
    const value = unquoteToken(words[index] as string);
    if (value === '--') {
      continue;
    }
    if (isFlagToken(value)) {
      // `-d`'s value is the next word, also at the end of a short cluster (`-nd dir`).
      index += /^(?:-[A-Za-z]*d|--working-dir)$/.test(value) ? 1 : 0;
      continue;
    }
    const command = composerCommandOf(value);
    if (command === 'exec') {
      return index;
    }
    if (command === 'run-script') {
      return 'string';
    }
    if (command !== 'global') {
      return command === null ? 'unknown' : null;
    }
  }
  // No command word (`composer`, `composer -n`, `composer global`): `list`, which loads the scripts.
  return 'unknown';
};

/**
 * Where a package runner's exec subcommand stands, when `words[head]` is a runner (WP-196 (b)):
 * the first word after the runner that is neither one of its options nor possibly an option's
 * value (a word after an option with no `=`) — or such a value, read closed, so `npm --prefix exec
 * jest` is read as an exec form. `null` for any other subcommand and any other word, and
 * **`'unknown'` where the subcommand cannot be determined exactly** (review round 1's ruling), which
 * `wrappedScript` makes `UNCERTAINTY.runnerSubcommand` and the peel reads through.
 *
 * Review round 1: a `--` before the subcommand is skipped (nopt puts the rest in `remain`, and npm
 * takes its command from there: `npm -- exec …`); npm resolves its commands by unique prefix and
 * one alias, so a non-empty prefix of `exec` and `x` are its exec form — the only words its `deref`
 * can resolve to `exec` (`e` and `ex` are ambiguous there and run nothing: an over-read); Yarn 1
 * runs `yarn workspace <name> <cmd>` as `yarn <cmd>`, so `workspace` and its name are skipped; and
 * `yarn workspaces …` (`foreach … exec` in Yarn 2+, `run` in Yarn 1) is `'unknown'`.
 */
const runnerSubcommandAt = (
  words: readonly string[],
  head: number,
): number | null | 'unknown' | 'string' => {
  const name = runnerName(words[head] ?? '');
  if (!Object.hasOwn(RUNNER_EXEC_SUBCOMMANDS, name)) {
    return null;
  }
  if (name === 'composer') {
    return composerSubcommandAt(words, head);
  }
  const subcommands = RUNNER_EXEC_SUBCOMMANDS[name] as ReadonlySet<string>;
  const yarn = name === 'yarn' || name === 'yarnpkg';
  let valueMayFollow = false;
  let option = '';
  let monitors = false;
  for (let index = head + 1; index < words.length; index += 1) {
    const value = unquoteToken(words[index] as string);
    if (value === '--') {
      continue;
    }
    if (isFlagToken(value)) {
      valueMayFollow = !value.includes('=');
      option = value;
    } else if (name === 'pnpm' && valueMayFollow && PNPM_VALUE_OPTIONS.has(option)) {
      // The value of a pnpm global option (`pnpm -C d exec …`) is not its first positional.
      valueMayFollow = false;
    } else if (
      (name === 'npm' && 'explore'.startsWith(value)) ||
      (name === 'bun' && value === 'exec')
    ) {
      return 'string';
    } else if (name === 'sentry-cli' && value === 'monitors' && !monitors) {
      monitors = true;
      valueMayFollow = false;
    } else if (
      (subcommands.has(value) && (name !== 'sentry-cli' || monitors)) ||
      (name === 'npm' && npmExecWord(value))
    ) {
      return index;
    } else if ((yarn && value === 'workspaces') || (name === 'pnpm' && value === 'with')) {
      return 'unknown';
    } else if (yarn && value === 'workspace') {
      index += 1;
      valueMayFollow = false;
    } else if (name === 'pnpm' && PNPM_RECURSIVE.has(value)) {
      valueMayFollow = false;
    } else if (name === 'pnpm' && !PNPM_BUILT_INS.has(value)) {
      return index;
    } else if (valueMayFollow) {
      valueMayFollow = false;
    } else {
      return null;
    }
  }
  return null;
};

/**
 * A written word that is a redirection (`2>/dev/null`, `>`, `<in`): the parser's operators
 * (`REDIRECTION_OPERATOR`) after an optional descriptor. The peel steps past it as past a wrapper
 * (WP-198 review round 1), so the written reading of `2>/dev/null sudo 2>&1` still has a
 * candidate at `sudo` — the argv reading has `sudo` alone, which `sudo *` does not match.
 */
const isRedirectionWord = (token: string): boolean =>
  REDIRECTION_OPERATOR.test(token.replace(/^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})/, ''));

/**
 * A wrapper at `index` of `words`: a wrapper token, a redirection word, or a package runner in its
 * exec form.
 */
const isWrapperAt = (words: readonly string[], index: number): boolean =>
  isWrapperToken(words[index] as string) ||
  isRedirectionWord(words[index] as string) ||
  runnerSubcommandAt(words, index) !== null;

/** The name a token would run under: quoting off, then the last path segment. */
const argv0Name = (token: string): string => argv0NameAs(token, unquoteToken);

/**
 * {@link argv0Name} with the reading's own dequote (`asHanded` on the argv reading): how
 * {@link commandNameWalk} reads a wrapper's name (WP-247).
 */
const argv0NameAs = (token: string, dequote: (token: string) => string): string =>
  basename(dequote(token));

/**
 * The shells, as **one** set (WP-160 (b)): each takes a script as its `-c` argument, reads one
 * from standard input, and runs a here-document it is handed. It was two sets until WP-160 —
 * `sh`/`bash`/`zsh`/`dash` for `-c`, and these for a here-document — so `rbash -c '…'` (shipped in
 * the run image) and `ksh -c '…'` were unread. `busybox` is not here: it is a shell only with a
 * second word (`busybox sh -c '…'`), which `wrappedScript` reads. `yash`, `posh`, `bash5` and
 * `sh5` joined at WP-188 (backlog 568), so `xargs yash` is uncertain as `xargs rbash` is and
 * `yash -c '…'` is read. A name list is open-ended by nature: a shell under a name not here (a
 * copied `./s`) is read as the command it is named.
 */
const SCRIPT_SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'ash',
  'rbash',
  'fish',
  'csh',
  'tcsh',
  'hush',
  'yash',
  'posh',
  'bash5',
  'sh5',
]);

/**
 * Wrappers that only set up the environment and then `exec` what follows, so the command that runs
 * really is the rest of the line. Only these are peeled off before matching the **allow**- and
 * ask-lists, so `env ls` keeps `ls`'s verdict.
 *
 * Deliberately excluded: `sh -c`, `eval` and `xargs`, whose real argv comes from a script, a
 * variable or standard input rather than from the tokens in front of us — peeling those off would
 * hand an allow verdict to a command nobody has read. They remain peeled for the *block*-list,
 * where the same reasoning only ever tightens.
 *
 * `busybox` is here (WP-188, backlog 559): `busybox ls` runs the `ls` applet, so it keeps `ls`'s
 * verdict. `npx` is not: `npx make test` may fetch or run a package's bin named `make`, so it stays
 * peeled for the block list and the floors only — and so does every package runner (WP-196).
 */
const ENVIRONMENT_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'nice',
  'ionice',
  'busybox',
]);

/**
 * The written words: the line split on blanks, a redirection a word and a quote part of one. Its
 * callers are a census (`command-policy.test.ts`, WP-198 (d)): the pattern side, the allow and
 * ask side, and the written half of {@link argvForms}.
 */
const tokenise = (text: string): readonly string[] =>
  normaliseCommand(text)
    .split(' ')
    .filter((token) => token.length > 0);

/**
 * A stage's words before the shell takes its quotes off: split by `shellWords` (quotes honoured),
 * every redirection removed with its target, attached (`2>/dev/null`) or apart (`2> /dev/null`,
 * `> out`, `<<< w`, a here-document opener), read off `ShellWord.redirect`. `commandNameWords`
 * reads these, because whether the shell expands a name is a question about its quoting.
 */
const argvShellWords = (text: string): readonly string[] =>
  shellWords(joinQuotedContinuations(text))
    .filter((word) => word.redirect === undefined)
    .map((word) => word.raw);

/**
 * {@link argvShellWords} with every brace expansion expanded as bash expands it (WP-243, backlog
 * 642: {@link expandBraces}), or `null` when the platform cannot read one — a form the port does
 * not read, or more than {@link BRACE_EXPANSION_CEILING} words made by expansion. `parseCommand`
 * reports `null` as `UNCERTAINTY.braceExpansion`. Only the argv reading takes these: the readers
 * of `argvShellWords` ask whether a written word expands, which an expanded word no longer says.
 */
const braceExpandedWords = (text: string): readonly string[] | null => {
  const cached = activeMemo?.braces.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const words = expandedWords(text);
  activeMemo?.braces.set(text, words);
  return words;
};

const expandedWords = (text: string): readonly string[] | null => {
  const out: string[] = [];
  let made = 0;
  for (const word of argvShellWords(text)) {
    const words = expandBraces(word, BRACE_EXPANSION_CEILING - made);
    if (words === null) {
      return null;
    }
    if (words.length === 1 && words[0] === word) {
      out.push(word);
      continue;
    }
    made += words.length;
    // An unquoted empty word is removed after expansion (`{a,}` is one word, `a`).
    out.push(...words.filter((expanded) => expanded !== ''));
  }
  return out;
};

/**
 * A stage as the words its brace expansions make, joined by blanks (each word keeps its quotes),
 * or `undefined` when nothing expands or the expansion is unread (`braceExpansion`). Redirections
 * are not in it; the stage as written keeps them, and both are parsed (`parseCommand`).
 */
const expandedStage = (stage: string): string | undefined => {
  const words = braceExpandedWords(stage);
  const written = argvShellWords(stage);
  return words === null ||
    (words.length === written.length && words.every((word, index) => word === written[index]))
    ? undefined
    : words.join(' ');
};

/** The raw words of the argv reading: expanded, or as written when the line is uncertain. */
const receivedShellWords = (text: string): readonly string[] =>
  braceExpandedWords(text) ?? argvShellWords(text);

/**
 * A stage's words **as the shell hands them to the program** (WP-198, backlog 582):
 * {@link argvShellWords}, braces expanded (WP-243) and each word dequoted (`unquoteToken`). A
 * redirection stands anywhere in a simple command and is not in argv, so `2>/dev/null sudo id`
 * runs `sudo` with `id`, and `gh >out release create` runs `gh release create`; and
 * `go test {-cpuprofile,/tmp/c} ./...` hands go `-cpuprofile /tmp/c`. Exported for its own test.
 */
export const argvWords = (text: string): readonly string[] =>
  receivedShellWords(text).map(unquoteToken);

/**
 * The two readings every deny-direction reader judges (WP-198 (c)): the written words it judged
 * before (`tokenise`) **and** the argv words (`argvWords`); a match on either is a match. A union
 * and not a replacement, because removing a redirection loosens one corner — `A=1 sudo >x`
 * matches `sudo *` on the written words only — and the union is the side that only tightens. The
 * allow and ask lists read the written line alone: there a removed redirection would widen
 * (`ls >out` read as `ls`).
 */
/**
 * The memo of one evaluation (review round 2): `argvForms` and `blockCandidates` are asked for the
 * same text by every reader of a stage, so one evaluation reads each text once — and no text
 * outlives the evaluation. A module-level cache keyed by model-written text retained hundreds of
 * megabytes in the runner process (measured, 4 KB and 20 KB lines). Set by
 * {@link withCommandMemo} for the length of one call; outside one, nothing is memoised.
 */
interface CommandMemo {
  readonly forms: Map<string, readonly (readonly string[])[]>;
  readonly candidates: Map<string, readonly (readonly string[])[]>;
  readonly braces: Map<string, readonly string[] | null>;
}
let activeMemo: CommandMemo | undefined;

/**
 * Runs `evaluate` with a memo that is dropped when it returns; a call inside another shares the
 * outer one. `evaluateCommand` and `decideUnattendedCommand` run in one each.
 */
export const withCommandMemo = <T>(evaluate: () => T): T => {
  if (activeMemo !== undefined) {
    return evaluate();
  }
  activeMemo = { forms: new Map(), candidates: new Map(), braces: new Map() };
  try {
    return evaluate();
  } finally {
    activeMemo = undefined;
  }
};

/** How many texts a memo holds right now — none between calls (a probe for the test). */
export const memoisedCommandTexts = (): number =>
  activeMemo === undefined
    ? 0
    : activeMemo.forms.size + activeMemo.candidates.size + activeMemo.braces.size;

const argvForms = (text: string): readonly (readonly string[])[] => {
  const cached = activeMemo?.forms.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const forms = [tokenise(text), argvWords(text)];
  activeMemo?.forms.set(text, forms);
  return forms;
};

/**
 * How much of a line the peel and the nesting walk read: eight wrappers or assignments in front of
 * a command (and up to eight words of a wrapper's options and operands after each), and eight
 * levels of nested substitution or handed-over script. A shell line is never this deep in practice.
 * **Past it, every site is uncertain** (WP-161 (d), backlog 516): the argv peel
 * (`walkCommandStarts`, for `argv0Candidates` and `commandPositions`) adds `UNCERTAINTY.tooDeep`,
 * the substitution walk and a script reader's here-document past the bound do too, and a script
 * handed over past it is `UNCERTAINTY.handedCommand` (WP-160). Before WP-161 the first two dropped
 * what lay past the bound with nothing said, so `nice` ×9 `git push --force origin main` and
 * `A=1 … I=9 sudo id` read as unmatched commands and ran under `auto`. One constant, one rule: an
 * unbounded peel was considered and not chosen, because the substitution recursion needs a bound
 * anyway.
 */
const MAX_WRAPPER_DEPTH = 8;

/** Where the command of a word list may start, and whether the peel stopped at its bound. */
interface CommandStarts {
  readonly starts: readonly number[];
  readonly tooDeep: boolean;
}

/**
 * The positions a command may start at, for words whose first is a wrapper or an assignment (`chain`
 * says which): every later word, because a wrapper's options and operands sit between it and the
 * command (`nice -n 5 sudo id`, `timeout -s KILL 5 git push …`). The walk reads eight words past
 * the last wrapper or assignment it met, and two past an option (its value, then the next word),
 * and stops — **uncertain** — at a ninth wrapper or assignment (WP-161 (d)). The window is counted
 * from the last wrapper rather than from the first word, so three `nice -n 5` in a row (nine words)
 * no longer hide the tenth word (measured `unattended_auto` before WP-161). `flag` says what an
 * option is. A word a wrapper's **declared grammar** reads as an option's value or its operand
 * (`commandNameWalk`'s `skipped`: `env -u sudo id`, `xargs -I {} grep x`) is no start (WP-205);
 * under a wrapper with none, every word still is. The walk reads `words` by `dequote`, the
 * reading's (WP-247).
 */
const walkCommandStarts = (
  words: readonly string[],
  chain: (words: readonly string[], index: number) => boolean,
  flag: (word: string) => boolean,
  dequote: (token: string) => string = unquoteToken,
): CommandStarts => {
  const starts = [0];
  if (words[0] === undefined || !chain(words, 0)) {
    return { starts, tooDeep: false };
  }
  const values = new Set(commandNameWalk(words, dequote).skipped);
  let peeled = 1;
  let limit = MAX_WRAPPER_DEPTH;
  for (let index = 1; index < words.length && index <= limit; index += 1) {
    if (!values.has(index)) {
      starts.push(index);
    }
    const word = words[index] as string;
    if (chain(words, index)) {
      peeled += 1;
      if (peeled > MAX_WRAPPER_DEPTH) {
        return { starts, tooDeep: true };
      }
      limit = index + MAX_WRAPPER_DEPTH;
    } else if (flag(word)) {
      limit = Math.max(limit, index + 2);
    }
  }
  return { starts, tooDeep: false };
};

/**
 * The peel of `argv0Candidates` over one of `argvForms`' readings; `dequote` is how that reading's
 * words read (`asHanded` on the argv reading, which is dequoted already — WP-245).
 */
const argvStarts = (
  tokens: readonly string[],
  dequote: (token: string) => string = unquoteToken,
): CommandStarts =>
  walkCommandStarts(tokens, isWrapperAt, (token) => isFlagToken(dequote(token)), dequote);

/**
 * The command with leading environment wrappers removed, when there are any. Returns nothing when
 * the line does not start with one, so the caller can tell "no wrapper" from "a wrapper and this
 * is what is left".
 *
 * Only the wrapper *names* are dropped, never their flags: `env -i ls` stays unmatched and so
 * falls through to `ask`, which is the safe direction.
 *
 * **A leading `VAR=value` is deliberately not peeled here** (it still is for the block list, in
 * `argv0Candidates`, where peeling can only tighten). Peeling it for the allow-list handed an
 * `allow` to a line nobody had read: `PATH=/w/bin ls -la` evaluated as a plain `ls` — verified by
 * planting a fake `ls` — and `LD_PRELOAD=…`, `GIT_SSH_COMMAND=… git fetch`,
 * `GIT_EXTERNAL_DIFF=… git diff`, `GIT_PAGER=… git log` and `RIPGREP_CONFIG_PATH=… rg` all took
 * the same route. It also defeated BD-025's "resolved against the real binary", since the
 * assignment is how the real binary gets swapped. This is the same reasoning that keeps `sh -c`,
 * `eval` and `xargs` unpeeled for the allow-list; round 3 applied it to the wrapper half of the
 * peel and not to the assignment half.
 */
const stripEnvironmentPrefix = (text: string): readonly string[] => {
  const tokens = tokenise(text);
  let start = 0;
  while (start < tokens.length) {
    const token = tokens[start] as string;
    if (ENVIRONMENT_WRAPPERS.has(argv0Name(token))) {
      start += 1;
      continue;
    }
    break;
  }
  if (start === 0 || start >= tokens.length) {
    return [];
  }
  return [tokens.slice(start).join(' ')];
};

/**
 * The token lists a command could really be, for block matching: itself with argv[0] reduced to a
 * basename, plus — when it starts with a wrapper or an assignment — every suffix after it, because
 * a wrapper's own flags and their values (`nice -n 5 sudo id`) sit between the two commands. How
 * far that goes is `walkCommandStarts`'s, and past its bound the line is uncertain (WP-161 (d)).
 * Every caller reads it over both of `argvForms`' readings (WP-198), so a redirection in front of
 * the command (`2>/dev/null sudo id`) is not argv[0]. The argv reading is read as handed
 * (`dequote` = `asHanded`, WP-245), the wrapper walk's words included (WP-247): its `\--` is no
 * wrapper's `--` and its `\--exec=/bin/rm` names no program. The candidate's name is the
 * exception, still dequoted (`argv0Name`; module rule 2 has the cell).
 */
const argv0Candidates = (
  tokens: readonly string[],
  dequote: (token: string) => string = unquoteToken,
): readonly (readonly string[])[] => {
  const withBasename = (list: readonly string[]): readonly string[] =>
    list.length === 0 ? list : [argv0Name(list[0] as string), ...list.slice(1)];

  // A program a declared grammar names by an option (`--exec=sudo -- id`, `-x /bin/rm -- -rf /`,
  // backlog 601) is a start of its own, followed by its arguments: the words after the wrapper's
  // first `--`, which the wrapper consumes (review round 1: kept, `rm -- -rf /` is no `rm -rf /*`).
  const inside = commandNameWalk(tokens, dequote).attached.map(({ index, command }) => {
    const end = tokens.findIndex((token, at) => at > index && dequote(token) === '--');
    return withBasename([command, ...(end === -1 ? [] : tokens.slice(end + 1))]);
  });
  return [
    ...argvStarts(tokens, dequote).starts.map((start) => withBasename(tokens.slice(start))),
    ...inside,
  ];
};

/**
 * The candidates {@link blockCandidates} read off `argvWords` — words already as the program
 * receives them, so a second `unquoteToken` would take off quotes the program sees (WP-241).
 */
const RECEIVED_READING = new WeakMap<readonly string[], readonly boolean[]>();

/** How a word of the argv reading reads: as handed, since it is dequoted already (WP-242, WP-245). */
const asHanded = (word: string): string => word;

/** How the words of a {@link blockCandidates} candidate read: once, whichever reading it is of. */
const readingOf = (candidate: readonly string[]): ((token: string) => string) =>
  RECEIVED_READING.has(candidate) ? asHanded : unquoteToken;

/**
 * `argvForms`' readings, each with how its words read — the written one's dequoted once, and the
 * argv reading twice: as handed, and dequoted a second time ({@link OVER_READ}'s over-ask, WP-245).
 */
const argvReadings = (
  text: string,
): readonly {
  readonly tokens: readonly string[];
  readonly dequote: (token: string) => string;
}[] => {
  const [written = [], received = []] = argvForms(text);
  return [
    { tokens: written, dequote: unquoteToken },
    { tokens: received, dequote: asHanded },
    { tokens: received, dequote: unquoteToken },
  ];
};

/**
 * Whether bash may hand a program other text for this word than `unquoteToken` reads: a `$` or
 * backtick outside single quotes (an expansion), or a backslash inside double quotes before
 * anything but `$`, backtick, `"`, `\` or a newline (WP-241 review round 1). An unquoted `{` is no
 * longer marked (WP-243): the words are read after brace expansion ({@link receivedShellWords}), so
 * `-ldflags={-s,-o=/tmp/x}` is the two words bash makes, and a brace the port cannot expand makes
 * the line `braceExpansion`. Read only by the go tool-flag floors. The backslash mark is an
 * over-ask since WP-242 (backlog 642): `unquoteToken` now keeps that backslash as bash does, so `received` is bash's text there;
 * it is kept because WP-241's `-buildid \'x` rows pin it. A glob (`-[t]mpdir`) is not marked: it
 * expands only against a file the run wrote (TD-030 tier 3).
 */
const receivedMayDiffer = (written: string): boolean => {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < written.length; index += 1) {
    const char = written[index] as string;
    if (quote === "'") {
      quote = char === "'" ? null : quote;
    } else if (char === '$' || char === '`') {
      return true;
    } else if (char === '\\') {
      if (quote === '"' && !'$`"\\\n'.includes(written[index + 1] ?? '$')) {
        return true;
      }
      index += 1;
    } else if (char === '"' || char === "'") {
      quote = quote === null ? char : char === quote ? null : quote;
    }
  }
  return false;
};

/**
 * `argv0Candidates` over both of `argvForms`' readings, read once per text within one evaluation
 * (`CommandMemo`; review round 1: the block matcher asked for them once per entry).
 */
const blockCandidates = (text: string): readonly (readonly string[])[] => {
  const cached = activeMemo?.candidates.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const [writtenWords = [], receivedWords = []] = argvForms(text);
  const written = argv0Candidates(writtenWords);
  const received = argv0Candidates(receivedWords, asHanded);
  // `argvWords` is `receivedShellWords` dequoted word by word, and a candidate's words after its
  // name are a suffix of it (`argv0Candidates`), so the flags align from the end.
  const unsure = receivedShellWords(text).map(receivedMayDiffer);
  for (const candidate of received) {
    RECEIVED_READING.set(
      candidate,
      unsure.slice(unsure.length - Math.max(candidate.length - 1, 0)),
    );
  }
  const candidates = [...written, ...received];
  // Only a word a second dequote changes makes an over-read that differs from `received`.
  OVER_READ.set(
    candidates,
    receivedWords.some((word) => unquoteToken(word) !== word) ? argv0Candidates(receivedWords) : [],
  );
  activeMemo?.candidates.set(text, candidates);
  return candidates;
};

/**
 * The argv reading dequoted a **second** time, kept beside `blockCandidates` for the block-entry
 * readers only (WP-245, backlog 644): `tokensMatch` (so `matchesBlockPattern`, the floors' glob
 * entries included), `blockEntryBehindFlagValue` and `blockEntryUnderUnreadOption`; and
 * `argvReadings`' third reading, for `xargsCommandWords` (so `xargsBlockPrefix`), the peel's bound
 * (`tooDeep`) and `feedsScriptReader`. Those readers now read the argv reading's words as handed,
 * which the written reading did not cover when a redirection stands among an entry's command words: `git >o branch "\--" -D main` ran under `auto` (git reads
 * `-D` past the positional `\--`). Taking the over-read away as well moved 930 sweep cells toward
 * `allow` — `rm -rf "\/"` (bash hands `\/`), `git "\push" --force origin main`, `git commit "\-n"`
 * — so it is kept as a stated over-ask, a candidate set of its own: unmarked, so each reader takes
 * quotes off it once more, as before WP-245. The floors' `tokens` predicates
 * (`carriesHazard`) and `commandArgvCandidates` do not read it (WP-242).
 */
const OVER_READ = new WeakMap<readonly (readonly string[])[], readonly (readonly string[])[]>();

/** {@link blockCandidates} and its over-read: the candidate set of the block-entry readers. */
const blockEntryCandidates = (text: string): readonly (readonly string[])[] => {
  const candidates = blockCandidates(text);
  return [...candidates, ...(OVER_READ.get(candidates) ?? [])];
};

// ── block matching (token-aware, plus the whole-line glob) ───────────────────

const isFlagToken = (token: string): boolean =>
  token.startsWith('-') && token.length > 1 && token !== '--';

/**
 * Splits tokens into flags and positionals; everything after a bare `--` is positional.
 *
 * Both the classification and the tokens it returns are **dequoted**, because that is what the
 * program receives: `git fetch "--upload-pack=x"` passes a flag, not a file name, and no amount of
 * quoting makes it stop being one. Written on the raw token, this classification was the single
 * hole under every `HAZARDOUS_ARGUMENTS` entry and under `find * -exec*` before it. Words that are
 * dequoted already (`carriesHazard`'s, WP-242; the argv reading's for every block-entry reader,
 * `readingOf`, WP-245) pass `dequote` as the identity, so no quote is taken off twice.
 */
const splitFlags = (
  tokens: readonly string[],
  dequote: (token: string) => string = unquoteToken,
): { readonly flags: readonly string[]; readonly positional: readonly string[] } => {
  const flags: string[] = [];
  const positional: string[] = [];
  let literal = false;
  for (const written of tokens) {
    const token = dequote(written);
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && isFlagToken(token)) {
      flags.push(token);
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
};

// ── WP-204: the one reading of an entry's options and operands (backlogs 598, 600) ──────────
//
// Every block reader — `tokensMatch`, `xargsBlockPrefix`, `blockEntryBehindFlagValue`,
// `expansionAtEntryWord` and `blockEntryUnderUnreadOption` — asks these functions whether a line
// meets an entry's options and operands, and none tests an option on its own (the census in
// `command-policy.test.ts`). Two facts are program-independent and only tighten: getopt reads a
// cluster of letters letter by letter, and an operand may stand anywhere among the operands.
// A `HAZARDOUS_ARGUMENTS` pattern is read through the same functions in the `hazard` reading —
// its words by place, as before WP-204, except that a word after an option written with no `=`
// may be left out (WP-217, backlog 616: WP-198's both-ways reading, so `git -C . commit -n` meets
// `git commit* -n*`) — and its options by the rules of the floored program's own
// parser (WP-214, backlog 613): a program `FLOOR_OPTION_READINGS` declares getopt-style has its
// clusters read letter by letter up to the first letter that takes a value (git's `-an` is
// `-a -n`), and every other program's options stay whole, because a floor's programs are not all
// getopt's: Go's `-cover` is one option, and exploded it met the `go* -o` floor (measured at
// WP-204, 13 rows of `command-policy.test.ts`).

/** How a pattern's options and operands are read: a block entry's (WP-204), or a floor's. */
type PatternReading = 'block' | 'hazard';

/** A single-dash cluster of letters only (`-rf`, `-D`, `-qD`), which getopt reads letter by letter. */
const LETTER_CLUSTER = /^-[A-Za-z]+$/;

/**
 * The one-letter options of every letter-only cluster among `flags` (`-rf` → `-r`, `-f`). Given a
 * program's `valued` letters (WP-214, a getopt program's floor), every single-dash word is read as
 * its parser reads it instead: each character an option, up to and including the first one that
 * takes a value, whose value is the rest of the word (`-nXours` → `-n`, `-X`; `-mn` → `-m`).
 */
const clusterLetters = (flags: readonly string[], valued?: string): readonly string[] =>
  flags.flatMap((flag) => {
    if (valued === undefined) {
      return LETTER_CLUSTER.test(flag) ? [...flag.slice(1)].map((letter) => `-${letter}`) : [];
    }
    if (flag.startsWith('--')) {
      return [];
    }
    const letters: string[] = [];
    for (const letter of flag.slice(1)) {
      letters.push(`-${letter}`);
      if (valued.includes(letter)) {
        break;
      }
    }
    return letters;
  });

/**
 * The letters that take a value for the floored program `argv` (its words, unquoted) runs, when
 * {@link FLOOR_OPTION_READINGS} declares it getopt-style — `''` for a subcommand its table does not
 * name, which fails closed — and `undefined` for a program read whole. The subcommand is the one
 * the program's own parser finds (WP-217, backlog 616): git's past its global options
 * (`gitSubcommandOf`), so `git -C . commit -mn` is a message `n`, not the `.` read by place.
 */
const getoptValuedLetters = (argv: readonly string[]): string | undefined => {
  const [program, ...rest] = argv;
  const declared =
    program !== undefined && Object.hasOwn(FLOOR_OPTION_READINGS, program)
      ? FLOOR_OPTION_READINGS[program]
      : undefined;
  if (declared?.reading !== 'getopt') {
    return undefined;
  }
  // git is the one program declared getopt-style; its parser is the subcommand's reader.
  const subcommand = gitSubcommandOf(program as string, rest);
  return subcommand !== null && Object.hasOwn(declared.valued, subcommand)
    ? declared.valued[subcommand]
    : '';
};

/**
 * Whether the line's options meet every option the entry writes (WP-204 (b)(i)). An entry option
 * is met by a line option its glob matches whole, as before; a letter-only cluster is also met
 * when each of its letters is among the line's exploded letters (`-rf` by `-r -f`, `-fr`, `-rfv`);
 * and any entry option — a glob one in practice — is also met by one exploded letter its glob
 * matches (`-f*` by `git push -uf`). A token with a non-letter (`-n1`, `-I{}`) and a long option
 * stay whole. `--` has already ended the options (`splitFlags`). In the `hazard` reading the
 * letters are a getopt program's, read with its `valued` letters (`getoptValuedLetters`), and none
 * for a program read whole.
 */
const entryFlagsMet = (
  entry: readonly string[],
  line: readonly string[],
  reading: PatternReading = 'block',
  valued?: string,
): boolean => {
  const letters =
    reading === 'block'
      ? clusterLetters(line)
      : valued === undefined
        ? []
        : clusterLetters(line, valued);
  return entry.every((flag) => {
    const glob = cachedGlob(flag);
    return (
      line.some((token) => glob.test(token)) ||
      letters.some((letter) => glob.test(letter)) ||
      (reading === 'block' &&
        LETTER_CLUSTER.test(flag) &&
        clusterLetters([flag]).every((one) => letters.includes(one)))
    );
  });
};

/**
 * Where an entry's operands start (WP-204 (b)(ii)): past its **command words**, the leading
 * literal ones — `rm`; `git branch`; `gh release`; `npm publish` — which the program reads by
 * place, so they are matched by place as before. The first word with a glob character is the first
 * operand (`/*` of `rm -rf /*`, `*` of `git branch -D *`). argv[0] is always a command word. The
 * `hazard` reading has no operands: every word by place, as before WP-204, but a line word after
 * an option with no `=` may be left out there too (`tokensMatch` hands it `skippable`, WP-217).
 */
const operandStart = (entry: readonly string[], reading: PatternReading): number => {
  const glob = entry.findIndex((word) => /[*?[]/.test(word));
  return reading === 'hazard' || glob < 0 ? entry.length : Math.max(1, glob);
};

/**
 * The entry positions one line word takes position `used` to: one further when the word meets the
 * entry's word there; and the same position when the word may be left out — an operand position,
 * where an operand may stand anywhere among the line's (`rm build -rf /` meets `/*`), the end of
 * the entry (a word after it), or a word `skippable` marks (an option's possible value, WP-198).
 */
const entryStep = (
  entry: readonly string[],
  used: number,
  word: string,
  skippable: boolean,
  reading: PatternReading = 'block',
): readonly number[] => {
  const next: number[] = [];
  if (skippable || used >= operandStart(entry, reading)) {
    next.push(used);
  }
  const glob = entry[used];
  if (glob !== undefined && cachedGlob(glob).test(word)) {
    next.push(used + 1);
  }
  return next;
};

/**
 * Every entry position reachable once the line's positionals are read (`entryStep` over each
 * word, the set kept so each (word, position) pair is visited once — WP-198 review round 1: a
 * branching search stalled the hook). `skippable` marks the words that may be left out at a
 * command word too (`flagValuePositions`). Empty when a command word is not met.
 */
const entryReach = (
  entry: readonly string[],
  line: readonly string[],
  skippable: readonly boolean[] = [],
  reading: PatternReading = 'block',
): ReadonlySet<number> => {
  let reachable = new Set([0]);
  for (const [at, word] of line.entries()) {
    const next = new Set<number>();
    for (const used of reachable) {
      for (const position of entryStep(entry, used, word, skippable[at] === true, reading)) {
        next.add(position);
      }
    }
    reachable = next;
  }
  return reachable;
};

/**
 * Whether the line's positionals meet all of the entry's. A trailing bare `*` also meets no word
 * when `bareStar`, in the `block` reading (WP-204, backlog 600): `sudo` is `sudo *`, `gh release`
 * is `gh release *`.
 */
const entryOperandsMet = (
  entry: readonly string[],
  line: readonly string[],
  reading: PatternReading = 'block',
  bareStar = true,
  skippable: readonly boolean[] = [],
): boolean => {
  const needed =
    reading === 'block' && bareStar && entry.length > 1 && entry.at(-1) === '*'
      ? entry.slice(0, -1)
      : entry;
  return needed.length === 0 || entryReach(needed, line, skippable, reading).has(needed.length);
};

/**
 * Whether a candidate argv meets a pattern's options and positionals. In the `hazard` reading a
 * floor's words are read as a block entry's command words are (WP-217, backlog 616): a word
 * written after an option with no `=` may be that option's value, so it may be left out
 * (`flagValuePositions`) — `git -C . commit -n` meets `git commit* -n*` with `.` read as `-C`'s
 * value, and `pip install -r req.txt -r http://x` meets `pip install -r http*` with `req.txt` the
 * first `-r`'s. A floor met either way is the floor: the reading only adds matches, so it fails
 * closed. **The over-ask:** a word after an option that takes none (`git --no-pager log …`) may be
 * left out too. A block entry's both-ways reading stays `blockEntryBehindFlagValue`'s (`uncertain`).
 */
const tokensMatch = (
  patternTokens: readonly string[],
  commandTokens: readonly string[],
  reading: PatternReading,
): boolean => {
  const pattern = splitFlags(patternTokens);
  const dequote = readingOf(commandTokens);
  const command = splitFlags(commandTokens, dequote);
  const hazard = reading === 'hazard';
  return (
    entryOperandsMet(
      pattern.positional,
      command.positional,
      reading,
      true,
      hazard ? flagValuePositions(commandTokens, dequote) : [],
    ) &&
    entryFlagsMet(
      pattern.flags,
      command.flags,
      reading,
      hazard ? getoptValuedLetters(commandTokens.map(dequote)) : undefined,
    )
  );
};

/**
 * For each positional `splitFlags` returns from `tokens`, whether it may be the value of the
 * option written just before it with no `=` (WP-198, backlog 584): `gh -R o/r release create`
 * runs `gh release create` with `-R`'s value `o/r`. The block matcher does not know which option
 * takes a value, so such a word is read both ways. Nothing after a bare `--` is a value. `dequote`
 * is `splitFlags`' (WP-245: the identity on the argv reading).
 */
const flagValuePositions = (
  tokens: readonly string[],
  dequote: (token: string) => string = unquoteToken,
): readonly boolean[] => {
  const values: boolean[] = [];
  let literal = false;
  let afterOption = false;
  for (const written of tokens) {
    const token = dequote(written);
    if (!literal && token === '--') {
      literal = true;
      afterOption = false;
    } else if (!literal && isFlagToken(token)) {
      afterOption = !token.includes('=');
    } else {
      values.push(afterOption);
      afterOption = false;
    }
  }
  return values;
};

/**
 * The block entry this piece of command line matches only when a word after an option written
 * with no `=` is read as that option's value (WP-198, backlog 584): `gh -R o/r release create v1`
 * against `gh release *`, `git -C d branch -D x` against `git branch -D *`. Which options take a
 * value is a fact about each program the matcher does not know, so the line is **uncertain**
 * (`flagValueHidesBlockEntry`), not blocked — the closed rule 584 names. Read on both of
 * `argvForms`' readings. Since WP-204 an operand is met wherever it stands (`entryReach`), so
 * leaving a word out matters only among an entry's command words (`gh -R o/r release`); the
 * over-ask this stated, `rm -rf build /tmp/x` against `rm -rf /*`, is now that entry, `block`.
 */
const blockEntryBehindFlagValue = (
  fragment: string,
  block: readonly string[],
): string | undefined => {
  const candidates = blockEntryCandidates(fragment);
  return block.find((entry) => {
    const pattern = splitFlags(tokenise(entry));
    // Only a command named by the entry's first word can match it (review round 1: the search is
    // not run for every other command).
    const first = pattern.positional[0];
    const named = candidates.filter(
      ([name]) => first !== undefined && name !== undefined && cachedGlob(first).test(name),
    );
    if (named.length === 0 || matchesBlockPattern(entry, fragment)) {
      return false;
    }
    return named.some((candidate) => {
      const command = splitFlags(candidate, readingOf(candidate));
      return (
        entryFlagsMet(pattern.flags, command.flags) &&
        entryOperandsMet(
          pattern.positional,
          command.positional,
          'block',
          true,
          flagValuePositions(candidate, readingOf(candidate)),
        )
      );
    });
  });
};

/**
 * The block entry, and the option, of a line that may be the entry by an alias (WP-204 (b)(iii)):
 * the line meets every positional of the entry — its command words, the leading literal ones, and
 * at least one operand after them, each met by a word (a bare `*` by one, not none) — and writes an
 * option while the entry's options are not all met. The option named is the line's first one with
 * a letter the entry does not write, else its first. **The over-ask, stated:** `rm -f /tmp/x`,
 * `rm -r /tmp/x`, `rm --force /tmp/x`, `git branch -m a b`, `git branch -d x`, `git branch -u
 * origin/x x`, `git branch --list 'x*'` and `git reset --soft origin/main`. An entry with no
 * operand after its command words (`git push --force*`) or no option is never read here, so
 * `git push -u origin agentic/x` and `git branch -a` are untouched.
 */
const blockEntryUnderUnreadOption = (
  fragment: string,
  block: readonly string[],
): { readonly entry: string; readonly option: string } | undefined => {
  const candidates = blockEntryCandidates(fragment);
  for (const entry of block) {
    const pattern = splitFlags(tokenise(entry));
    if (
      pattern.flags.length === 0 ||
      operandStart(pattern.positional, 'block') >= pattern.positional.length ||
      matchesBlockPattern(entry, fragment)
    ) {
      continue;
    }
    for (const candidate of candidates) {
      const command = splitFlags(candidate, readingOf(candidate));
      const [first] = command.flags;
      if (
        first !== undefined &&
        entryOperandsMet(pattern.positional, command.positional, 'block', false) &&
        !entryFlagsMet(pattern.flags, command.flags)
      ) {
        const letters = clusterLetters(pattern.flags);
        const unread = command.flags.find(
          (flag) =>
            !LETTER_CLUSTER.test(flag) ||
            !clusterLetters([flag]).every((letter) => letters.includes(letter)),
        );
        return { entry, option: unread ?? first };
      }
    }
  }
  return undefined;
};

/** A pattern word a stage cannot hold: an entry's positions from one on are a later stage's. */
const STAGE_SEPARATOR = /^(?:\||\|&|;|&&|\|\||&)$/;

/**
 * The block entry this stage — as written, a substitution kept (`ParsedCommand.rawStages`) — could
 * match once a word the shell expands is expanded (WP-201 site (ii)): the literal words before it
 * are a proper prefix of the entry, read as the block matcher reads a line (flags anywhere,
 * positionals in order through `globToRegExp`, a word after a single option with no `=` possibly
 * its value, WP-198), and the expansion stands where the entry still names a word — a positional other
 * than a bare `*`, which any word matches, or a flag the line has not written when the expansion is
 * an option (`rm -$x /`). WP-197's prefix rule with an expansion as the completer instead of xargs'
 * input (`xargsBlockPrefix`). An entry whose name is `git` is left to the git boundary, which
 * reads git's verb (`gitBoundaryViolation`) and refs; an entry's words past a `|` are a later
 * stage's and no expansion supplies them (`curl $url` against `curl * | sh`). **The residual,
 * stated:** an expansion after the entry's command words have died or after every positional
 * matched (`git push origin $BRANCH`, the boundary's) is judged as today, and so is one behind a
 * cluster whose last letter takes a value (`x -fR o/r $y`, where `-fR` is read as two flags).
 * Since WP-204 an expansion among an entry's operands is read wherever it stands (`entryStep`):
 * `rm -rf dist $out` is uncertain, which this residual named before.
 */
const blockEntryBehindExpansion = (stage: string, block: readonly string[]): string | undefined => {
  const words = argvShellWords(stage);
  for (const start of argvStarts(words).starts) {
    const [name, ...rest] = words.slice(start);
    if (name === undefined || expandsAsName(name)) {
      continue;
    }
    const entry = block.find((pattern) => {
      const tokens = tokenise(pattern);
      const end = tokens.findIndex((token) => STAGE_SEPARATOR.test(token));
      const { flags, positional } = splitFlags(end < 0 ? tokens : tokens.slice(0, end));
      const first = positional[0];
      return (
        first !== undefined &&
        first !== 'git' &&
        cachedGlob(first).test(argv0Name(name)) &&
        expansionAtEntryWord(rest, flags, positional)
      );
    });
    if (entry !== undefined) {
      return entry;
    }
  }
  return undefined;
};

/**
 * The walk of {@link blockEntryBehindExpansion} over the words after the name, keeping the set of
 * entry positions reachable so far (`entryStep`, `entryReach`'s walk): whether an expansion stands where the
 * entry still names a word. When the entry names a flag the line does not write, the expansion
 * counts only if it can supply it: an option the shell expands (`rm -$x /`), a glob before `--`
 * that can match the flag (`rm * /`, where the checkout holds a file `-rf`) — each with every
 * positional of the entry matched — or a positional one that may become several words (`rm $x`,
 * where `x='-rf /'`). A double-quoted one is one word and
 * cannot be the flag and the path at once, so `rm -f "$tmp"` is no `rm -rf /*`.
 */
const expansionAtEntryWord = (
  rest: readonly string[],
  flags: readonly string[],
  positional: readonly string[],
): boolean => {
  let reachable = new Set([1]);
  let literal = false;
  let afterOption = false;
  let expandedPositional = false;
  let splits = false;
  let expandedOption = false;
  // Words that may be an option, words judged at an entry position, and words that are both: a
  // pair of two different words can be the flag and the path (`rm "$x" "$y"`), one word cannot.
  let optionWords = 0;
  let judgedWords = 0;
  let bothWords = 0;
  const written: string[] = [];
  for (const raw of rest) {
    const value = unquoteToken(raw);
    if (!literal && value === '--') {
      literal = true;
      afterOption = false;
    } else if (!literal && isFlagToken(value)) {
      // An unquoted expansion in an option splits into any number of words — options and
      // positionals alike (`x="rf /"; rm -$x` is `rm -rf /`, round 1b) — so with the prefix alive
      // it can supply every word the entry still names. A quoted one (`"-$x"`) is one option.
      if (
        expandsAsName(raw) &&
        globPrefix(raw) === null &&
        mayBeSeveralWords(raw) &&
        reachable.size > 0
      ) {
        return true;
      }
      expandedOption ||= expandsAsName(raw);
      written.push(value);
      // A word after `-X` or `--long` may be its value (WP-198); a cluster (`-rf`) is read as
      // flags, so `rm -rf dist $out` is not `-rf dist` and `$out` the path.
      afterOption = /^(?:-[^-]|--[^=]+)$/.test(value);
    } else if (reachable.size > 0) {
      const glob = globPrefix(raw);
      // A glob before `--` may yield words that are options (`rm * /tmp` with a file `-rf`, review
      // round 1): it may supply a flag the entry needs, and it may stand for no positional at all.
      const optionGlob =
        !literal &&
        glob !== null &&
        flags.some((flag) => cachedGlob(value).test(flag.replace(/[*?[\]]/g, '')));
      // So may a quoted expansion with nothing but `-` written before it (`rm "$x" /` with
      // `x=-rf`, review round 3): one word, so it is the flag or a positional, never both.
      const optionExpansion = !literal && glob === null && mayBeOption(raw);
      expandedOption ||= optionGlob || optionExpansion;
      const judged =
        expandsAsName(raw) &&
        [...reachable].some(
          (used) =>
            used < positional.length &&
            positional[used] !== '*' &&
            (glob === null || globMayMatch(glob, positional[used] as string)),
        );
      expandedPositional ||= judged;
      splits ||= judged && glob === null && mayBeSeveralWords(raw);
      optionWords += optionGlob || optionExpansion ? 1 : 0;
      judgedWords += judged ? 1 : 0;
      bothWords += judged && (optionGlob || optionExpansion) ? 1 : 0;
      const next = new Set<number>();
      for (const used of reachable) {
        // WP-204 (b)(ii): at an operand position any word may stand between two of the entry's
        // (`rm -rf dist $out` is `rm -rf dist /` when `out=/`); at a command word, only a word
        // that may be an option's value or an option.
        for (const position of entryStep(
          positional,
          used,
          value,
          afterOption || optionGlob || optionExpansion,
        )) {
          next.add(position);
        }
      }
      afterOption = false;
      reachable = next;
    }
  }
  if (!expandedPositional && reachable.size === 0) {
    return false;
  }
  const flagMissing = !entryFlagsMet(flags, written);
  // An expanded option completes the entry only with every positional matched (`rm -$x /`).
  const pair = optionWords > 0 && judgedWords > 0 && optionWords + judgedWords - bothWords > 1;
  return flagMissing
    ? (expandedOption && reachable.has(positional.length)) || splits || pair
    : expandedPositional;
};

/**
 * For a word that is not literal only by an unquoted glob (`*`, `?`, `[`), its text before the
 * first one, quotes off; `null` for any other word. Every word pathname expansion yields from it
 * starts with that text — or is the word itself, when nothing matches.
 */
const globPrefix = (raw: string): string | null => {
  if (/[$`]/.test(raw.replace(/'[^']*'/g, '')) || !isLiteralJudgedWord(raw.replace(/[*?[]/g, ''))) {
    return null;
  }
  let quote: '"' | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (char === '\\') {
      index += 1;
    } else if (quote === null && char === "'") {
      const close = raw.indexOf("'", index + 1);
      if (close === -1) {
        return null;
      }
      index = close;
    } else if (char === '"') {
      quote = quote === null ? '"' : null;
    } else if (quote === null && /[*?[]/.test(char)) {
      return unquoteToken(raw.slice(0, index));
    }
  }
  return null;
};

/**
 * Whether a glob word whose fixed text is `prefix` may yield a word an entry's token matches: the
 * two fixed beginnings agree, and an entry token that needs a leading `/` is not met by a pattern
 * that starts with a wildcard — pathname expansion of a relative pattern yields relative names
 * (`rm -rf dist/*` and `rm -f *.o` are no `rm -rf /*`).
 */
const globMayMatch = (prefix: string, token: string): boolean => {
  const fixed = token.slice(0, token.search(/[*?[]|$/));
  return (
    (prefix.startsWith(fixed) || fixed.startsWith(prefix)) &&
    !(prefix === '' && fixed.startsWith('/'))
  );
};

/**
 * Whether a word holds an expansion with nothing but `-` written before it (`"$x"`, `"${x}"`,
 * `"$(echo -rf)"`, `-"$x"`), so that its value may be an option whatever the line writes.
 */
const mayBeOption = (raw: string): boolean => {
  let written = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (char === '$' || char === '`') {
      return /^-*$/.test(written);
    }
    if (char === '\\') {
      written += raw[index + 1] ?? '';
      index += 1;
    } else if (char === "'") {
      const close = raw.indexOf("'", index + 1);
      if (close === -1) {
        return false;
      }
      written += raw.slice(index + 1, close);
      index = close;
    } else if (char !== '"') {
      written += char;
    }
  }
  return false;
};

/**
 * Whether a word may become several words: an expansion outside double quotes (split on blanks,
 * then globbed), an unquoted glob, or a brace expansion.
 */
const mayBeSeveralWords = (raw: string): boolean => {
  let quote: '"' | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (char === '\\') {
      index += 1;
    } else if (quote === null && char === "'") {
      const close = raw.indexOf("'", index + 1);
      if (close === -1) {
        return false;
      }
      index = close;
    } else if (char === '"') {
      quote = quote === null ? '"' : null;
    } else if (
      quote === null &&
      (/[$`*?[]/.test(char) || (char === '{' && bracesExpand(raw, index)))
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Does a block pattern match this command?
 *
 * Either the tokens match — the pattern's flags anywhere and its letter clusters letter by letter,
 * its command words in place and its operands wherever they stand among the command's (WP-204:
 * `entryFlagsMet`, `entryOperandsMet`), after argv[0] normalisation, in either of `argvForms`' readings (WP-198: the written
 * words, or argv with the redirections out, so `gh >out release create` is `gh release create`) —
 * or the whole line matches the pattern as a glob. The
 * glob half is kept so the token rule can only add coverage, never remove it: `curl * | sh` must
 * still catch `curl -o out https://example.invalid | sh`.
 */
export const matchesBlockPattern = (
  pattern: string,
  command: string,
  reading: PatternReading = 'block',
): boolean => {
  const patternTokens = tokenise(pattern);
  if (patternTokens.length === 0) {
    return false;
  }
  if (matchesCommandPattern(pattern, command)) {
    return true;
  }
  return blockEntryCandidates(command).some((candidate) =>
    tokensMatch(patternTokens, candidate, reading),
  );
};

/**
 * Does this piece of command line carry `entry` — by its glob, or by its token predicate? Exported
 * for the `tokens` census in `command-policy.test.ts` (WP-186), which runs it over an entry that is
 * not on the list.
 */
export const carriesHazard =
  (command: string) =>
  (entry: HazardousArgument): boolean =>
    entry.tokens === undefined
      ? matchesBlockPattern(entry.pattern, command, 'hazard')
      : blockCandidates(command).some((candidate) => {
          const [name, ...rest] = candidate;
          if (name === undefined) {
            return false;
          }
          // The argv reading is dequoted already (WP-242: a second pass made `"\--"` a `--`).
          const received = RECEIVED_READING.has(candidate);
          const words = received ? rest : rest.map(unquoteToken);
          const { flags, positional } = splitFlags(words, (word) => word);
          return (entry.tokens as NonNullable<HazardousArgument['tokens']>)({
            name,
            flags,
            positional,
            words,
            received: received ? rest : undefined,
            receivedUnsure: RECEIVED_READING.get(candidate),
          });
        });

/**
 * The first `HAZARDOUS_ARGUMENTS` entry this piece of command line carries, if any. Its only
 * effect is to floor the verdict at `ask` (see `evaluateCommand`).
 */
export const hazardousArgument = (command: string): HazardousArgument | undefined =>
  HAZARDOUS_ARGUMENTS.find(carriesHazard(command));

/**
 * **Every** `HAZARDOUS_ARGUMENTS` entry this piece of command line carries, in list order — for the
 * unattended decision, which refuses a `command` or `trust` hazard and runs a `path` one, and so
 * must not stop at the first entry (`pytest --junitxml=x -c evil.ini` carries one of each).
 */
export const hazardousArguments = (command: string): readonly HazardousArgument[] =>
  HAZARDOUS_ARGUMENTS.filter(carriesHazard(command));

/**
 * Block patterns that ban a binary outright — `docker *`, `sudo *`, `kubectl *` — as opposed to
 * banning one invocation of it (`git push --force*` bans a push, not git). Only these are checked
 * against a resolved binary's basename, so resolving `ls` to `/usr/bin/docker` blocks while
 * resolving it to `/usr/bin/git` does not.
 */
const binaryBans = (block: readonly string[]): readonly string[] =>
  block.flatMap((pattern) => {
    const positional = splitFlags(tokenise(pattern)).positional;
    const [name, rest, ...more] = positional;
    if (name === undefined || more.length > 0) {
      return [];
    }
    return rest === undefined || rest === '*' ? [name] : [];
  });

/**
 * The block entry banning the binary an `xargs` in this piece of command line runs, if any (WP-188,
 * backlog 567). A `name *` entry matches the words written, and xargs supplies the rest from its
 * input: `cat f | xargs -n1 sudo` is `sudo` with no word after it on the line, which `sudo *` does
 * not match, so it read `ask / auto / deny` while `xargs sudo sh` was blocked. The command word
 * xargs runs (after its own options, `readXargsOptions`) is judged by name, whatever follows it.
 * A bare `sudo` with no `xargs` is not changed by this: it runs nothing it was not written with —
 * and since WP-204 (backlog 600) the block matcher blocks it, `sudo *`'s trailing `*` meeting no word.
 */
const xargsBannedEntry = (text: string, block: readonly string[]): string | undefined => {
  for (const {
    words: [run],
  } of xargsCommandWords(text)) {
    const name = argv0Name(run as string);
    const entry = block.find((pattern) =>
      binaryBans([pattern]).some((ban) => cachedGlob(ban).test(name)),
    );
    if (entry !== undefined) {
      return entry;
    }
  }
  return undefined;
};

/**
 * For each `xargs` at a command start in this piece of command line, the words written for the
 * command it runs: its command word (after xargs' own options, `readXargsOptions`) and every word
 * after it. Never empty. Read in both of `argvForms`' readings (WP-198), so a redirection between
 * `xargs` and its command (`xargs 2>/dev/null sudo`) is not taken for the command word. Each comes
 * with how its reading's words read (`dequote`: the argv reading's as handed, WP-245).
 */
const xargsCommandWords = (
  text: string,
): readonly { readonly words: readonly string[]; readonly dequote: (token: string) => string }[] =>
  // Both readings (WP-198): `xargs 2>/dev/null sudo` runs `sudo`, not a command named `2>/dev/null`.
  argvReadings(text).flatMap(({ tokens, dequote }) =>
    argvStarts(tokens, dequote).starts.flatMap((start) => {
      const word = tokens[start];
      if (word === undefined || argv0Name(word) !== 'xargs') {
        return [];
      }
      const args = tokens.slice(start + 1);
      const at = readXargsOptions(
        args.map((raw): ShellWord => ({ raw })),
        dequote,
      ).command;
      return at === null || at < 0 || at >= args.length ? [] : [{ words: args.slice(at), dequote }];
    }),
  );

/** A word that ends the words written for a command: a redirection or a control operator. */
const ENDS_WRITTEN_WORDS = /[<>|&;]/;

/**
 * The block entry an `xargs` in this piece of command line could complete from its input, if any
 * (WP-197, backlog 576). WP-188's ban reads a whole binary (`sudo *`), where every completion
 * matches; an entry with a word after the binary (`terraform apply`, `gh release *`, a project's
 * `deploy prod *`) was matched only against the words written, and xargs appends the rest, so
 * `echo apply | xargs terraform` ran under `auto`. Here the written words are matched as a
 * **prefix** of every entry of the policy's block list, read as the block matcher reads a line
 * (`splitFlags`, `entryReach`: flags anywhere, command words in place, operands wherever they stand —
 * WP-204), and an entry the input could complete is one with a positional left over, or with every
 * positional matched and a flag still missing (review round 3: `xargs terraform -chdir=x`, `xargs rm -f`). The words stop at the first
 * redirection or operator, which only shortens the prefix (the closed side); the argv reading
 * (WP-198) has no redirection left in it, so `xargs gh 2>/dev/null release` is also read whole. A
 * word after an option written with no `=` may be left out (WP-198, backlog 584). **The over-ask,
 * stated:** `echo 'issue view' | xargs gh`, `echo plan | xargs terraform`, `find . | xargs rm -rf`
 * and `xargs curl x` (against `curl * | sh`) — some completions match and the platform cannot say
 * which arrives; `cat ids | xargs gh issue view` is a prefix of no entry and is not touched.
 */
const xargsBlockPrefix = (text: string, block: readonly string[]): string | undefined => {
  for (const { words, dequote } of xargsCommandWords(text)) {
    const end = words.findIndex((word) => ENDS_WRITTEN_WORDS.test(word));
    const [name, ...rest] = end < 0 ? words : words.slice(0, end);
    if (name === undefined) {
      continue;
    }
    // Read as the block matcher reads a line (`tokensMatch`): flags anywhere, command words as a
    // prefix (review round 3 — `xargs terraform -chdir=x` completes to a blocked line).
    // A word after an option written with no `=` may be its value, so it may be left out of the
    // prefix (WP-198, backlog 584: `xargs gh -R o/r release`).
    const value = flagValuePositions([argv0Name(name), ...rest], dequote);
    const written = splitFlags([argv0Name(name), ...rest], dequote);
    const entry = block.find((pattern) => {
      const { flags, positional } = splitFlags(tokenise(pattern));
      // The written words are a live prefix of the entry, and the input may supply what they
      // leave unmet: an operand (an operand position stays reachable, WP-204), or an option.
      const reach = entryReach(positional, written.positional, value);
      return (
        reach.size > 0 && (!reach.has(positional.length) || !entryFlagsMet(flags, written.flags))
      );
    });
    if (entry !== undefined) {
      return entry;
    }
  }
  return undefined;
};

// ── scanning ─────────────────────────────────────────────────────────────────

/**
 * Operators that separate one command from the next. `&&` and `||` are listed before `&` and `|`
 * so the two-character forms win the longest-match test; `(`, `)`, `{` and `}` are here because a
 * subshell or a group body is a command list of its own.
 */
const LIST_OPERATORS = ['&&', '||', ';', '&', '\n', '(', ')'] as const;
/**
 * The pipe, which separates the stages of a single pipeline. `|&` — bash's "pipe stdout and
 * stderr" — is listed first so the two-character form wins the longest-match test; without it the
 * `&` half read as a background operator and `curl x |& sh` stopped being a pipeline at all.
 */
const PIPE_OPERATORS = ['|&', '|'] as const;

interface ScanResult {
  readonly segments: readonly string[];
  /**
   * Each of `segments` as written, in the same order: its substitutions and backticks kept, which
   * `segments` lifts out (WP-160 — a string handed to a trap or a shell is literal only if nothing
   * in it expands). Here-document bodies are not in either.
   */
  readonly rawSegments: readonly string[];
  /** Bodies of `$(…)`, `` `…` ``, `<(…)` and `>(…)`, which the shell executes in their own right. */
  readonly substitutions: readonly string[];
  /** Redirection targets that are paths — a duplication (`2>&1`) or `/dev/null` is not one. */
  readonly writeTargets: readonly string[];
  /** Constructs the scanner will not reason about; each one floors the verdict at `ask`. */
  readonly uncertainty: readonly UncertaintyReason[];
  /** Where each of `substitutions` starts in the scanned text, in the same order. */
  readonly substitutionOffsets: readonly number[];
  /** The here-documents this pass skipped (only a pass that splits on newlines reads them). */
  readonly hereDocuments: readonly HereDocumentBody[];
  /** `[newline, end)` of every skipped body, terminator line included, in the scanned text. */
  readonly bodyRanges: readonly (readonly [number, number])[];
  /**
   * Where bash resumes reading commands after the **first** here-document this pass did not
   * recognise (WP-160 (e)): the newline after its would-be terminator, or `null`. The walk read
   * that body as commands, so its quote state there may not be bash's; `parseCommand` reads the
   * text from here again, from a fresh state.
   */
  readonly resumeFrom: number | null;
  /**
   * Each of `segments` with its process substitutions' words left out, as the scanner read them
   * before backlog 645: the same text as `segments` unless one was there. `parseCommand` reads it
   * beside the segment, so keeping the word only tightens.
   */
  readonly droppedSegments: readonly string[];
}

// ── here-documents (WP-153) ──────────────────────────────────────────────────

/**
 * A here-document operator as written: `<<WORD`, `<<'WORD'`, `<<"WORD"`, each also as `<<-`.
 *
 * The **one** reader the scanner (`scan`), the substitution matcher (`findClosingParen`) and the
 * git boundary's `computesCommandName` share (ruling (a)); each walks its own quote state and asks
 * this reader at an unquoted `<<` and again at the newline that ends the line.
 */
export interface HereDocumentOperator {
  /** The word the terminator line must equal, quotes taken off. */
  readonly delimiter: string;
  /** `<<'EOF'` or `<<"EOF"`: the shell expands nothing in the body. */
  readonly quoted: boolean;
  /** `<<-`: leading tabs come off every body line and off the terminator line. */
  readonly stripTabs: boolean;
  /** How many characters the operator and its word take, from the first `<`. */
  readonly length: number;
}

/**
 * The operator and a word in one of the three shapes, ending at a word boundary. A word the shell
 * would join to more text (`<<EOF"X"` is the delimiter `EOFX`, measured) or one carrying a `$`, a
 * backslash or mixed quoting is **not recognised** — its body stays commands, read both ways
 * (`unrecognisedOperator`).
 *
 * **The boundary is bash's own metacharacters — space, tab, newline, `;&|)<>` — and never `\s`.**
 * JavaScript's `\s` also matches `\r`, `\f`, `\v` and NBSP, which bash keeps inside the word: on a
 * CRLF line `cat <<'EOF'\r` the delimiter is `EOF\r`, the body ends at the line `EOF\r`, and bash
 * 5.2 runs the next line (measured for all four, WP-153 review round 1). Read with `\s`, the
 * delimiter was `EOF` and that line stayed in the body. `(` is a metacharacter too, but `<<EOF(`
 * is a syntax error, so it is left out: not recognising costs the old reading, made safe by
 * `unrecognisedOperator` (a would-be body read for its expansions, WP-158, and the lines after its
 * terminator read again, WP-160 (e)).
 */
const HERE_DOCUMENT_OPERATOR =
  /^<<(-?)[ \t]*(?:'([A-Za-z0-9_.-]+)'|"([A-Za-z0-9_.-]+)"|([A-Za-z0-9_.-]+))(?=$|[ \t\n;&|)<>])/;

/**
 * Reads `before` as the shell would up to its end, and answers two things: its comments (which
 * `feedsScriptReader` does not read for script-reader names), and `refuses` — whether an operator
 * at the end of `before` sits where the shell reads **no** here-document: in a
 * comment, or inside a parameter expansion (`${x:-<<EOF}`), an arithmetic command or expansion
 * (`((x<<y))`, `$[1<<2]`) or a `[[ … ]]` test. Each was measured on bash 5.2 to run the line after
 * it (WP-153), so a reader that skipped that line would hide a command.
 *
 * **Scoped to what is still open at the operator** (WP-160 (f), backlog 513). The first version
 * matched a pattern anywhere in the text before the operator, so one `#!/bin/sh` line, a closed
 * `${HOME}` or `git commit -m "fix #12"` on an earlier line stopped every later here-document from
 * being recognised (its body read as commands: an apostrophe in it was `unbalancedQuote`). bash
 * reads a here-document after each of them (measured). So this walks `before` as the shell does —
 * quotes honoured, a comment running to the end of its line and only where a word starts (after a
 * blank or `;&|()<>`; `\s` is wider than bash's blanks on purpose: it finds more comments, and so
 * recognises less), `${`, `$[`, `((`/`$((` and `[[` counted until they close, a substitution's
 * text with a quote state of its own — and refuses only when one of them is open at the end, or
 * when the walk cannot follow the text (a quote it cannot close). Refusing costs the commands'
 * reading of the would-be body, which `unrecognisedOperator` makes safe.
 */
const readShellContext = (
  before: string,
): { readonly refuses: boolean; readonly comments: readonly (readonly [number, number])[] } => {
  const unfollowable = { refuses: true, comments: [] } as const;
  const comments: [number, number][] = [];
  type Frame = '$(' | '(' | '${' | '$[' | '((' | '[[' | '"';
  const REFUSING: ReadonlySet<Frame> = new Set<Frame>(['${', '$[', '((', '[[']);
  const frames: { kind: Frame; depth: number }[] = [];
  let comment = -1;
  let boundary = true;
  for (let index = 0; index < before.length; index += 1) {
    const char = before[index] as string;
    const frame = frames.at(-1);
    const kind = frame?.kind;
    const startsWord = boundary;
    boundary = /[\s;&|()<>]/.test(char);
    if (comment !== -1) {
      if (char === '\n') {
        comments.push([comment, index]);
        comment = -1;
      }
      boundary = true;
      continue;
    }
    if (char === '\\') {
      index += 1;
      boundary = false;
      continue;
    }
    if (kind === '"') {
      boundary = false;
      if (char === '"') {
        frames.pop();
        continue;
      }
    } else if (char === "'") {
      const close = before.indexOf("'", index + 1);
      if (close === -1) {
        return unfollowable;
      }
      index = close;
      boundary = false;
      continue;
    } else if (char === '"') {
      frames.push({ kind: '"', depth: 0 });
      boundary = false;
      continue;
    }
    if (char === '`') {
      const close = before.indexOf('`', index + 1);
      if (close === -1) {
        return unfollowable;
      }
      index = close;
      continue;
    }
    if (char === '$' && /^\$(?:\(\(|\(|\{|\[)/.test(before.slice(index, index + 3))) {
      const opener = before.slice(index, index + 3).startsWith('$((')
        ? '(('
        : (`$${before[index + 1]}` as Frame);
      frames.push({ kind: opener === '$(' ? '$(' : opener, depth: 0 });
      index += opener === '((' ? 2 : 1;
      continue;
    }
    if (kind === '"') {
      continue;
    }
    if (kind === '${' || kind === '$[') {
      const [open, close] = kind === '${' ? ['{', '}'] : ['[', ']'];
      if (char === open) {
        (frame as { depth: number }).depth += 1;
      } else if (char === close) {
        if ((frame as { depth: number }).depth === 0) {
          frames.pop();
        } else {
          (frame as { depth: number }).depth -= 1;
        }
      }
      continue;
    }
    if (kind === '((') {
      if (char === '(') {
        (frame as { depth: number }).depth += 1;
      } else if (char === ')') {
        if ((frame as { depth: number }).depth > 0) {
          (frame as { depth: number }).depth -= 1;
        } else {
          frames.pop();
          index += before[index + 1] === ')' ? 1 : 0;
        }
      }
      continue;
    }
    if (char === '#' && startsWord) {
      comment = index;
      continue;
    }
    if (startsWord && before.startsWith('((', index)) {
      frames.push({ kind: '((', depth: 0 });
      index += 1;
      continue;
    }
    if (startsWord && /^\[\[(?:[\s]|$)/.test(before.slice(index, index + 3))) {
      frames.push({ kind: '[[', depth: 0 });
      index += 1;
      continue;
    }
    if (
      kind === '[[' &&
      startsWord &&
      /^\]\](?:[\s;&|()<>]|$)/.test(before.slice(index, index + 3))
    ) {
      frames.pop();
      index += 1;
      continue;
    }
    if (char === '(') {
      frames.push({ kind: '(', depth: 0 });
    } else if (char === ')' && (kind === '(' || kind === '$(')) {
      frames.pop();
    }
  }
  if (comment !== -1) {
    comments.push([comment, before.length]);
  }
  return {
    refuses:
      comment !== -1 || frames.some((frame) => REFUSING.has(frame.kind) || frame.kind === '"'),
    comments,
  };
};

/** {@link readShellContext}'s verdict: the operator at the end of `before` is not a here-document. */
const hereDocumentContextRefuses = (before: string): boolean => readShellContext(before).refuses;

/**
 * The operator's **shape** at `text[index]`, whatever precedes it — `null` for no operator, and for
 * `<<<`, a here-string, at either of its first two characters.
 */
const hereDocumentOperatorShape = (text: string, index: number): HereDocumentOperator | null => {
  if (text.startsWith('<<<', index) || text[index - 1] === '<') {
    return null;
  }
  const match = HERE_DOCUMENT_OPERATOR.exec(text.slice(index));
  if (match === null) {
    return null;
  }
  const [whole, dash, single, double, bare] = match;
  return {
    delimiter: (single ?? double ?? bare) as string,
    quoted: bare === undefined,
    stripTabs: dash === '-',
    length: whole.length,
  };
};

/**
 * The here-document operator at `text[index]`, or `null` when there is none the shell certainly
 * reads as one. `before` is what the walker read ahead of it, with skipped bodies left out.
 */
export const readHereDocumentOperator = (
  text: string,
  index: number,
  before: string,
): HereDocumentOperator | null =>
  hereDocumentContextRefuses(before) ? null : hereDocumentOperatorShape(text, index);

/**
 * A `<<` the reader does **not** recognise but bash may read as a here-document (WP-158, found by
 * the shell oracle). Not recognising was taken to cost only the old reading — the
 * lines after it read as commands — but an unquoted body expands a `$(…)` that the old reading
 * takes for single-quoted text: `echo ${HOME}; cat <<EOF` + `x='$(cmd)'` + `EOF` (the context guard
 * then refused after any `${`, closed or not, and after a comment on an earlier line — scoped to
 * what is open at the operator since WP-160 (f)) and `cat <<EOF\r`
 * + `x='$(cmd)'` + `EOF\r` (the word boundary refuses `\r`) each ran `cmd` in bash 5.2 and in dash,
 * and each was `unattended_auto` (measured). So such an operator's would-be body is
 * read **both ways**: as commands, as before, and as a body whose expansion is uncertain
 * (`hereDocumentUncertainty`, an unterminated body aside). Its delimiter is bash's: the word up to a
 * metacharacter, taken literally, since a word with no quoting is not expanded as a delimiter.
 *
 * **A quoted word is read too** (WP-160 (e), backlog 513). Its body expands nothing, but read as
 * commands its quotes can pair **across** bash's terminator: `cat <<\EOF` + `a'` + `EOF` + `cmd` +
 * `'` was `unattended_auto` with `cmd` inside one quoted word, and bash 5.2, 3.2 and dash each ran
 * `cmd` (measured); `cat <<\EOF` + `cat <<'X'` + `EOF` + `cmd` + `X` was `allow_list`, the inner
 * operator swallowing `cmd` as a body. So `parseCommand` reads the lines after the would-be
 * terminator again from a fresh state (`ScanResult.resumeFrom`): what bash runs there is judged, and
 * a quote the body left open is one those lines cannot close, so the line is `unbalancedQuote`. The word is read quote-aware, as bash reads it: quotes and
 * backslashes come off (`<<E'OF'` and `<<\EOF` end at `EOF`), and a quote that does not close on
 * the line leaves the operator unread (the old reading).
 */
const unrecognisedOperator = (
  text: string,
  index: number,
  before: string,
): HereDocumentOperator | null => {
  if (
    text.startsWith('<<<', index) ||
    text[index - 1] === '<' ||
    readHereDocumentOperator(text, index, before) !== null
  ) {
    return null;
  }
  const head = /^<<(-?)[ \t]*/.exec(text.slice(index)) as RegExpExecArray;
  let cursor = index + head[0].length;
  let delimiter = '';
  let quoted = false;
  while (cursor < text.length && !/[ \t\n;&|()<>]/.test(text[cursor] as string)) {
    const char = text[cursor] as string;
    if (char === '\\' && text[cursor + 1] === '\n') {
      cursor += 2; // a line continuation joins the word, quoting nothing (review round 1)
    } else if (char === '\\') {
      quoted = true;
      delimiter += text[cursor + 1] ?? '';
      cursor += 2;
    } else if (char === "'" || char === '"') {
      const close = text.indexOf(char, cursor + 1);
      if (close === -1 || text.slice(cursor, close).includes('\n')) {
        return null;
      }
      quoted = true;
      delimiter += text.slice(cursor + 1, close);
      cursor = close + 1;
    } else {
      delimiter += char;
      cursor += 1;
    }
  }
  if (delimiter === '' && !quoted) {
    return null;
  }
  return { delimiter, quoted, stripTabs: head[1] === '-', length: cursor - index };
};

/** One here-document's body, read up to its terminator. */
export interface HereDocumentBody {
  readonly operator: HereDocumentOperator;
  /** The body's lines, tabs already stripped for `<<-`, without the terminator. */
  readonly body: string;
  /** False when the text ended before a line equal to the delimiter came. */
  readonly terminated: boolean;
}

/**
 * Reads the bodies of the here-documents opened on one line, in the order they were opened, from
 * the newline at `newline`. A terminator is a line **equal** to the delimiter — after leading tabs
 * come off, for `<<-` — so `EOF ` or ` EOF` does not end a body (measured, bash 5.2 and dash).
 * `end` is the newline that ends the last terminator line, or the end of the text.
 */
export const readHereDocumentBodies = (
  text: string,
  newline: number,
  pending: readonly HereDocumentOperator[],
): { readonly end: number; readonly bodies: readonly HereDocumentBody[] } => {
  let cursor = newline;
  const bodies: HereDocumentBody[] = [];
  for (const operator of pending) {
    const lines: string[] = [];
    let terminated = false;
    while (cursor < text.length) {
      const next = text.indexOf('\n', cursor + 1);
      const stop = next === -1 ? text.length : next;
      const line = text.slice(cursor + 1, stop);
      cursor = stop;
      const read = operator.stripTabs ? line.replace(/^\t+/, '') : line;
      if (read === operator.delimiter) {
        terminated = true;
        break;
      }
      lines.push(read);
    }
    bodies.push({ operator, body: lines.join('\n'), terminated });
  }
  return { end: cursor, bodies };
};

/** What a walker does at the newline that ends a line with here-documents pending. */
export interface HereDocumentsAtNewline {
  /** Where the walker resumes: the newline after the last terminator, the end, or `newline`. */
  readonly resume: number;
  readonly bodies: readonly HereDocumentBody[];
  /** `[newline, resume)` — what leaves the line — or `null` when nothing is skipped. */
  readonly range: readonly [number, number] | null;
}

/**
 * The walkers' one entry at a newline. A line whose operator and newline are separated by another
 * newline — inside quotes or a substitution the walker jumped — is one where the walker's idea of
 * "the next line" and the shell's could differ, so nothing is skipped there (the old reading).
 */
export const hereDocumentsAtNewline = (
  text: string,
  newline: number,
  pending: readonly HereDocumentOperator[],
  pendingFrom: number,
): HereDocumentsAtNewline => {
  // A line continuation (`\` + newline) does not end the line (review round 1: `cat <<\⏎EOF`).
  if (joinContinuations(text.slice(pendingFrom, newline)).includes('\n')) {
    return { resume: newline, bodies: [], range: null };
  }
  const { end, bodies } = readHereDocumentBodies(text, newline, pending);
  return { resume: end, bodies, range: [newline, end] };
};

/** `text[from, to)` with the skipped `ranges` (absolute, sorted) left out. */
const outsideRanges = (
  text: string,
  from: number,
  to: number,
  ranges: readonly (readonly [number, number])[],
): string => {
  let out = '';
  let cursor = from;
  for (const [start, end] of ranges) {
    if (end <= cursor || start >= to) {
      continue;
    }
    out += text.slice(cursor, Math.max(cursor, start));
    cursor = Math.max(cursor, end);
  }
  return out + text.slice(cursor, Math.max(cursor, to));
};

// ── WP-158: what evaluates a variable's text (backlog 509) ───────────────────
//
// bash reads an array subscript, a substring offset or length, `$[…]`, `((…))`, `let`'s
// arguments, an integer variable's value and a `[[ … -eq … ]]` operand as an **arithmetic
// expression**, and an identifier in one is replaced by its variable's value, evaluated again — an
// array subscript in that value included, whose `$(…)` then runs. `${x@P}` expands the value as a
// prompt string, `${!x}` uses it as a name (subscript and all), and a builtin handed a variable
// *name* (`declare`, `read`, `unset`, `printf -v`, `[[ -v`) evaluates that name's subscript. A
// single-quoted assignment the scanner reads as data is therefore code to the shell. Measured on
// bash 5.2.37 and 3.2.57 (PROGRESS § WP-158 has the table); dash evaluates a variable as a plain
// number and ran none of them. **The only exemptions are literal** (ruling (c)): a plain decimal
// number as an operand or subscript, and the `@`/`*` subscripts — none of them names a variable.

/** A plain decimal number: the one arithmetic operand that names no variable. */
const LITERAL_NUMBER = /^[0-9]+$/;

/** A subscript bash does not evaluate: a plain number, or `@`/`*` (every element). */
const LITERAL_SUBSCRIPT = /^(?:[0-9]+|[@*])$/;

/** A variable name with nothing to evaluate: an identifier, with at most a literal subscript. */
const LITERAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\[(?:[0-9]+|[@*])\])?$/;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*/;

/** A parameter's name inside `${…}`: an identifier, a positional number or a special parameter. */
const PARAMETER_NAME = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/;

/** Index of the `]` closing the `[` at `open`, counting nested brackets, or -1. */
const closingBracket = (text: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '[') {
      depth += 1;
    } else if (text[index] === ']') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
};

/**
 * `${!…}` from the character after the `!`. Indirection (`${!x}`, `${!x[i]}`, `${!x@Q}`) evaluates
 * the value as a name; three shapes are not indirection and evaluate nothing (measured, bash 5.2):
 * `${!}` (the last background job's PID), `${!prefix*}`/`${!prefix@}` (the names with a prefix) and
 * `${!name[@]}`/`${!name[*]}` (an array's keys).
 */
const evaluatesIndirection = (text: string, at: number): boolean => {
  if (text[at] === '}') {
    return false;
  }
  const name = IDENTIFIER.exec(text.slice(at))?.[0];
  if (name === undefined) {
    return true;
  }
  const after = text.slice(at + name.length);
  return !/^(?:[@*]|\[[@*]\])\}/.test(after);
};

/**
 * What follows a parameter's name (and subscript): `@` is a transformation — `@P` evaluates the
 * value as a prompt, and every other operator is refused with it rather than listed, because a
 * later bash may add one; `:` not followed by `-`, `=`, `+` or `?` is a substring offset and
 * length, which are arithmetic unless each is a plain number. Every other operator (`-`, `#`,
 * `%`, `/`, `^`, `,`, …) reads a word or a pattern, which the walk reads as it reads any word.
 */
const evaluatesAfterName = (text: string, at: number): boolean => {
  const char = text[at];
  if (char === '@') {
    return true;
  }
  if (char !== ':' || /[-=+?]/.test(text[at + 1] ?? '')) {
    return false;
  }
  const close = text.indexOf('}', at);
  if (close === -1) {
    return true;
  }
  const operands = text.slice(at + 1, close).split(':');
  return operands.length > 2 || !operands.every((operand) => LITERAL_NUMBER.test(operand));
};

/**
 * Does the expansion at `text[index]` (a `$`) evaluate a variable's text? `$[…]` always does, as
 * `$((…))` always counts as `UNCERTAINTY.arithmetic`; `${…}` does when it carries a subscript that
 * is not literal (`${y[x]}`, `${#y[x]}`, `${y[x]:-d}`), an offset or length that is not a plain
 * number (`${z:x}`, `${z: -1}`, `${y[@]:x}`), a transformation (`${z@P}`) or an indirection
 * (`${!x}`). A `${` with no parameter name after it is refused too (bash 5.3's `${ cmd; }` runs a
 * command). One detector for the walk (`scan`, outside quotes and inside double quotes) and for an
 * unquoted here-document body (`hereDocumentUncertainty`) — ruling (d).
 */
const evaluatesVariableText = (text: string, index: number): boolean => {
  if (text[index + 1] === '[') {
    return true;
  }
  if (text[index + 1] !== '{') {
    return false;
  }
  let at = index + 2;
  if (text[at] === '!') {
    return evaluatesIndirection(text, at + 1);
  }
  if (text[at] === '#' && /[A-Za-z_0-9@*?$!#-]/.test(text[at + 1] ?? '')) {
    at += 1; // `${#name…}`: the length of what follows
  }
  const name = PARAMETER_NAME.exec(text.slice(at))?.[0];
  if (name === undefined) {
    return true;
  }
  at += name.length;
  if (text[at] === '[') {
    const close = closingBracket(text, at);
    if (close === -1 || !LITERAL_SUBSCRIPT.test(text.slice(at + 1, close))) {
      return true;
    }
    at = close + 1;
  }
  return evaluatesAfterName(text, at);
};

/**
 * `text` with every line continuation (`\\` + newline) taken out, as bash takes it out before it
 * reads a word — outside single quotes, in double quotes and in an unquoted body alike — so
 * `$\\⏎{y[x]}` and `${y\\⏎[x]}` are `${y[x]}` (measured, bash 5.2 and 3.2; review round 1). An
 * escaped backslash (`\\\\`) is kept whole, so the newline after it stays a newline.
 */
const joinContinuations = (text: string): string => {
  if (!text.includes('\\\n')) {
    return text;
  }
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\') {
      if (!isLineContinuation(text, index)) {
        out += text.slice(index, index + 2);
      }
      index += 1;
    } else {
      out += text[index];
    }
  }
  return out;
};

/**
 * Whether a backslash at `index` starts a line continuation, which bash removes outside single
 * quotes. One test for the scanner (`joinContinuations`) and the git boundary's computed-name walk
 * (`computesCommandName`), so the two cannot read a continued line differently (WP-201 review
 * round 3: `X=1 \⏎$CMD id` was exempt as computed, and the boundary never read `$CMD`).
 */
export const isLineContinuation = (text: string, index: number): boolean =>
  text[index] === '\\' && text[index + 1] === '\n';

/** The detector at the `$` at `text[index]`, over the text as bash reads it (continuations joined). */
const evaluatesExpansionAt = (text: string, index: number): boolean =>
  evaluatesVariableText(joinContinuations(text.slice(index)), 0);

/**
 * The same detector over an unquoted here-document body, where quotes are plain characters and only
 * a backslash keeps a `$` from expanding.
 */
const bodyEvaluatesVariableText = (body: string): boolean => {
  const joined = joinContinuations(body);
  for (let index = 0; index < joined.length; index += 1) {
    if (joined[index] === '\\') {
      index += 1;
    } else if (joined[index] === '$' && evaluatesVariableText(joined, index)) {
      return true;
    }
  }
  return false;
};

/**
 * The detector at every `$` of a word the walker consumes whole — a redirection's target (review
 * round 1: `cat > ${y[x]}` ran the payload and was `unattended_auto`) — outside single quotes.
 */
const wordEvaluatesVariableText = (text: string, from: number, to: number): boolean => {
  let quote: '"' | "'" | null = null;
  for (let index = from; index < to; index += 1) {
    const char = text[index];
    if (quote === "'") {
      quote = char === "'" ? null : quote;
    } else if (char === '\\') {
      index += 1;
    } else if (char === '"' || char === "'") {
      quote = quote === char ? null : quote === null ? char : quote;
    } else if (char === '$' && evaluatesExpansionAt(text, index)) {
      return true;
    }
  }
  return false;
};

/** `[[ … ]]`'s arithmetic comparisons: both operands are evaluated as expressions. */
const ARITHMETIC_COMPARISONS: ReadonlySet<string> = new Set([
  '-eq',
  '-ne',
  '-lt',
  '-le',
  '-gt',
  '-ge',
]);

/** Builtins whose arguments are variable names, with an optional `=value`. */
const DECLARATION_BUILTINS: ReadonlySet<string> = new Set([
  'declare',
  'typeset',
  'local',
  'export',
  'readonly',
]);

/** `name[subscript]=` (or `[subscript]=` inside `name=( … )`): an array element assignment. */
const ELEMENT_ASSIGNMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*)?\[([\s\S]*)\]\+?=/;

/**
 * One stage's words, split as the shell splits them — quotes honoured, a command substitution left
 * out and a process substitution read as the `/dev/fd/63` bash hands (backlog 645) — by
 * the scanner itself with blanks as the operators. A redirection word is dropped: it names no
 * variable.
 */
const wordsOf = (stage: string): readonly string[] =>
  scan(stage, [' ', '\t']).segments.filter(
    (word, index, all) =>
      !/^[0-9]*[<>&]/.test(word) &&
      // The target of an operator written apart from it (`<<< 'x'`, `> out`) is not a name either
      // (WP-161 (g), backlog 519: `read -r X <<< 'x'` was `evaluatedText`).
      !/^[0-9]*(?:<<<|<<-?|<>|<&|>&|>>|>\||&>>|&>|<|>)$/.test(all[index - 1] ?? ''),
  );

/** The words a name-taking builtin reads as names: every non-option, except an option's value. */
const namesOf = (args: readonly string[], valueOption: RegExp | null): readonly string[] => {
  const names: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as string;
    if (/^[-+]./.test(word)) {
      if (valueOption?.test(word)) {
        index += 1;
      }
      continue;
    }
    names.push(word);
  }
  return names;
};

const notLiteralName = (word: string): boolean => !LITERAL_NAME.test(word);

/** Whether `[[ … ]]` is open at the start of the next stage: `&&`, `||` and `(` split one. */
interface TestState {
  inside: boolean;
}

/**
 * The commands that evaluate a variable's text, read off one pipeline stage (WP-158): an array
 * element assignment with a subscript that is not literal (`y[x]=1`, `[x]=1` in `y=( … )`), `let`,
 * a declaration with `-i` (integer) or `-n` (nameref) or a name built from an expansion
 * (`declare "$x"=1`), `read`/`mapfile`/`unset` handed such a name, `printf -v`, `test -v`, and —
 * inside `[[ … ]]`, which the list split cuts at `&&`, `||` and `(`, so `state` carries it from
 * stage to stage — a `-v` test or an arithmetic comparison whose operands are not both plain
 * numbers. `((…))` is the walk's (`scan`), because the list split cuts it at `(`.
 */
const stageEvaluatesText = (stage: string, state: TestState): boolean => {
  const words = wordsOf(joinContinuations(stage));
  let evaluates = false;
  for (const [index, word] of words.entries()) {
    if (word === '[[') {
      state.inside = true;
    } else if (word === ']]') {
      state.inside = false;
    } else if (state.inside) {
      const next = words[index + 1] ?? '';
      const previous = words[index - 1] ?? '';
      const operator = unquoteToken(word); // `[[ x "-eq" 1 ]]` compares arithmetically too
      evaluates ||=
        (operator === '-v' && notLiteralName(next)) ||
        (ARITHMETIC_COMPARISONS.has(operator) &&
          !(LITERAL_NUMBER.test(previous) && LITERAL_NUMBER.test(next)));
    }
  }
  let start = 0;
  for (; start < words.length; start += 1) {
    const word = words[start] as string;
    const element = ELEMENT_ASSIGNMENT.exec(word);
    if (element !== null) {
      evaluates ||= !LITERAL_SUBSCRIPT.test(element[1] as string);
    } else if (word === 'coproc' && words[start + 2] === '{') {
      start += 1; // `coproc NAME { … }`: the name is not the command
    } else if (!(isWrapperToken(word) || (start > 0 && word.startsWith('-')))) {
      // A wrapper's options (`command -p`, `time -p`, `--`) sit between it and the command.
      break;
    }
  }
  const command = unquoteToken(words[start] ?? '');
  const args = words.slice(start + 1);
  if (command === 'let') {
    return true;
  }
  if (DECLARATION_BUILTINS.has(command)) {
    evaluates ||=
      args.some((word) => /^[-+][A-Za-z]*[in]/.test(word)) ||
      namesOf(args, null).some((word) => notLiteralName(word.replace(/\+?=[\s\S]*$/, '')));
  } else if (command === 'read') {
    evaluates ||= namesOf(args, /^-[A-Za-z]*[dinNptu]$/).some(notLiteralName);
  } else if (command === 'mapfile' || command === 'readarray') {
    evaluates ||= namesOf(args, /^-[A-Za-z]*[dnOsuCc]$/).some(notLiteralName);
  } else if (command === 'unset') {
    evaluates ||= namesOf(args, null).some(notLiteralName);
  } else if (command === 'printf' || command === 'test' || command === '[') {
    evaluates ||= args.some(
      (word, index) =>
        (word === '-v' && notLiteralName(args[index + 1] ?? '')) ||
        (command === 'printf' && /^-v./.test(word) && notLiteralName(word.slice(2))),
    );
  }
  return evaluates;
};

/** What ruling (d) and (e) make uncertain about one body (and WP-158's ruling (d)). */
const hereDocumentUncertainty = (body: HereDocumentBody): readonly UncertaintyReason[] => {
  const reasons: UncertaintyReason[] = [];
  if (!body.terminated) {
    reasons.push(UNCERTAINTY.unterminatedHereDocument);
  }
  if (!body.operator.quoted && /\$\(|`|\\$/m.test(body.body)) {
    reasons.push(UNCERTAINTY.hereDocumentExpansion);
  }
  if (!body.operator.quoted && bodyEvaluatesVariableText(body.body)) {
    reasons.push(UNCERTAINTY.evaluatedText);
  }
  return reasons;
};

/**
 * Commands that run what they read as a **script** — a shell, `eval`, `source`/`.` — so a
 * here-document they can reach is not data (rule 1's `sh -c '…'`, `eval '…'`): `bash <<'EOF'`,
 * `cat <<'EOF' | sh` and `sh -c "$(cat <<'EOF' …)"` run their body. A name is recognised as any
 * word of the scanned level (shells) or in command position (`.`, which is also a directory), and
 * then **every** body at that level and below is read as commands — it over-reads, which only
 * costs the old behaviour. Interpreters that are not shells (`python3 - <<'EOF'`) are the module's
 * stated residual: an unmatched command runs under `auto`, and its script is not read.
 *
 * A command whose **name the shell expands** — a glob or a brace (`cat <<'EOF' | /bin/s?`,
 * `/bin/{sh,x}`) — may be any of these, so it counts as one in command position (review round 1).
 * A name computed from a variable (`| $SH`) is refused by the git boundary's computed-name check
 * under `auto`, and is unmatched (so refused) under `deny`.
 */
/**
 * Argv wrappers that run a shell when they are given no command (backlog 602, WP-203 round 1), so
 * with nothing after their options and operands they read their standard input as a script, as a
 * shell with no `-c` does: `setarch` and its per-architecture names ("the default program is
 * /bin/sh", https://manpages.debian.org/trixie/util-linux/setarch.8.en.html), `unshare` and
 * `nsenter` (`${SHELL}`, …/unshare.1.en.html, …/nsenter.1.en.html), `chroot` (`"$SHELL" -i`,
 * https://manpages.debian.org/trixie/coreutils/chroot.8.en.html). `su` and `runuser` are read by
 * their own grammar in `wrappedScript` (`readLoginShell`). `echo 'git push origin main' | linux64`
 * read `allow`, and `platform-runtime:s16` ran `echo "echo RAN_L64" | linux64`.
 */
const SHELL_WITHOUT_COMMAND: ReadonlySet<string> = new Set([
  ...SETARCH_NAMES,
  'unshare',
  'nsenter',
  'chroot',
]);

export const HERE_DOCUMENT_SCRIPT_READERS: ReadonlySet<string> = new Set([
  ...SCRIPT_SHELLS,
  'busybox',
  'eval',
  'source',
  // WP-203: `newgrp GROUP` and `sg GROUP` with no command start a shell on their input.
  'newgrp',
  'sg',
  ...SHELL_WITHOUT_COMMAND,
  // `su USER` and `runuser USER` with no `-c` run the user's shell on their input (backlog 602).
  'su',
  'runuser',
]);

/**
 * Does this segment run something that reads a script (a shell, `eval`, `source`, `.`, or a name
 * the shell expands)? The split's `\s` is wider than bash's blanks on purpose: it cuts `sh\r` out
 * as `sh`, so it finds more readers, and a reader found is only the old reading. A comment is not
 * read (WP-160 (f)): a `#!/bin/sh` line named a shell, and every body after it was read as commands.
 *
 * **The expanded-name class looks at a command word only** (WP-160 (g), backlog 512). It was every
 * `argv0Candidates` name, which puts the stage's own first token first — so an assignment
 * (`x='b[1]'`), the `[`/`[[` test and the `{` group, each carrying a `[` or `{`, made every body at
 * the level a script and an apostrophe in one `unbalancedQuote`. Now a name counts only where it
 * is the command: not a peeled token (an assignment, a wrapper — `{` is one), not `[`, and nothing
 * inside a `[`/`[[` test.
 */
const feedsScriptReader = (segment: string): boolean => {
  const text = joinContinuations(withoutRanges(segment, readShellContext(segment).comments));
  return (
    text
      .split(/[\s|&;()<>]+/)
      .some((word) => word.length > 0 && HERE_DOCUMENT_SCRIPT_READERS.has(argv0Name(word))) ||
    scan(text, PIPE_OPERATORS).segments.some((stage) =>
      argvReadings(stage).some(({ tokens, dequote }) => {
        const head = tokens.find((token) => !isAssignment(token));
        if (head !== undefined && (argv0Name(head) === '[' || argv0Name(head) === '[[')) {
          return false;
        }
        return argv0Candidates(tokens, dequote).some(
          ([name]) =>
            name === '.' ||
            (name !== undefined && /[*?[{]/.test(name) && !isWrapperToken(name) && name !== '['),
        );
      }),
    )
  );
};

/**
 * Index of the `)` closing the `(` at `openIndex`, honouring quotes, or -1 when unbalanced.
 *
 * It counts every unquoted `)` outside a here-document body: it has no `case` pattern state and no
 * comment state, so `<(case x in x) …` and `<(: # )⏎)` close early (backlog 651). Given `unread`
 * (`scan`'s command and process substitutions — never `$((…))`, where `case` is a variable name,
 * `$(( case + 1 ))`; the `#` of a base, `16#ff`, follows a digit and starts no comment anyway), a
 * body holding an unquoted `case` word or a `#` that starts a comment between the open and the
 * close it finds adds `UNCERTAINTY.unreadSubstitutionBody`, so the early close is never read.
 */
const findClosingParen = (
  text: string,
  openIndex: number,
  hereDocuments = false,
  unread?: Set<UncertaintyReason>,
): number => {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  // A command substitution's body is commands, so a here-document in it is skipped here as the
  // shell skips it — bash 5.2 and dash do not close `$(cat <<'EOF'` at a `)` inside the body
  // (measured). Never inside `$((…))`, where `<<` is a shift.
  let pending: HereDocumentOperator[] = [];
  let pendingFrom = -1;
  const skipped: (readonly [number, number])[] = [];
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (hereDocuments && char === '<' && text.startsWith('<<', index)) {
      const operator = readHereDocumentOperator(
        text,
        index,
        outsideRanges(text, openIndex + 1, index, skipped),
      );
      if (operator !== null) {
        if (pending.length === 0) {
          pendingFrom = index;
        }
        pending.push(operator);
        index += operator.length - 1;
        continue;
      }
    }
    if (char === '\n' && pending.length > 0) {
      const at = hereDocumentsAtNewline(text, index, pending, pendingFrom);
      pending = [];
      if (at.range !== null) {
        if (at.bodies.some((body) => !body.terminated)) {
          return -1;
        }
        skipped.push(at.range);
        index = at.resume - 1;
      }
      continue;
    }
    // `startsComment` is bash's word start, for the `case` word as for the `#`.
    if (
      unread !== undefined &&
      startsComment(text, index) &&
      (char === '#' || /^case(?:[\s;&|()<>]|$)/.test(text.slice(index, index + 5)))
    ) {
      unread.add(UNCERTAINTY.unreadSubstitutionBody);
    }
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
};

/** Index of the `'` closing an ANSI-C `$'…'` starting at `openIndex`, or -1. */
const findAnsiCEnd = (text: string, openIndex: number): number => {
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === "'") {
      return index;
    }
  }
  return -1;
};

/** What follows `>&` when it names a descriptor: `2>&1`, `1>&2`, `2>&-`, `3>&1-` (a move). */
const DESCRIPTOR_WORD = /^(?:\d+-?|-)$/;

/**
 * Whether a redirection target is a real file rather than a descriptor or the bit bucket.
 *
 * `/dev/null` is compared **as written, unquoted** — `2>/dev/null`, `>/dev/null`, `&>/dev/null`,
 * `>>/dev/null`, `2>>/dev/null`, `>|/dev/null`, `>&/dev/null` — and every other spelling is a
 * write target (backlog 462, decided and tested): `/dev/nullx` and `/dev/null/../x` are other
 * paths, and a quoted `"/dev/null"` or `'/dev/null'` floors too. The reason first given — that
 * `unquoteToken` read `"/dev/nul\l"` as `/dev/null` where bash keeps the backslash — no longer
 * holds (WP-242 made it keep that backslash, as bash does); the refusal is kept because nothing
 * needs a quoted bit bucket, and over-asking one is the safe direction.
 */
const isWriteTarget = (target: string): boolean =>
  target.length > 0 && !target.startsWith('&') && target !== '/dev/null';

/**
 * The word a process substitution `<(…)` / `>(…)` leaves in its fragment: the path bash hands the
 * program (bash manual, *Process Substitution*; `printf '[%s]' <(true)` prints `[/dev/fd/63]` on
 * bash 3.2.57 and 5.3.20). The number varies; the floors read the word, not the number.
 */
const PROCESS_SUBSTITUTION_ARGUMENT = '/dev/fd/63';

/**
 * One quote-aware pass over a command line, splitting on `operators`.
 *
 * Single quotes protect everything; double quotes protect the operators but *not* substitution,
 * because the shell still runs it there. Anything the scanner cannot follow is reported in
 * `uncertainty` rather than guessed at.
 *
 * A pass that splits on newlines also reads here-documents (WP-153): an unquoted `<<WORD` is kept
 * on its line, and at that line's newline the bodies are skipped — never a segment, never quote
 * state — and the pass resumes after the last terminator line.
 */
const scan = (command: string, operators: readonly string[]): ScanResult => {
  const segments: string[] = [];
  const rawSegments: string[] = [];
  const substitutions: string[] = [];
  const substitutionOffsets: number[] = [];
  const writeTargets: string[] = [];
  const uncertainty = new Set<UncertaintyReason>();
  const readsLines = operators.includes('\n');
  const hereDocuments: HereDocumentBody[] = [];
  const bodyRanges: (readonly [number, number])[] = [];
  let pending: HereDocumentOperator[] = [];
  let pendingFrom = -1;
  let shadow: HereDocumentOperator[] = [];
  let shadowFrom = -1;
  let resumeFrom: number | null = null;
  let current = '';
  let inDouble = false;
  let index = 0;

  const recordBodies = (bodies: readonly HereDocumentBody[]): void => {
    for (const body of bodies) {
      hereDocuments.push(body);
      for (const reason of hereDocumentUncertainty(body)) {
        uncertainty.add(reason);
      }
    }
  };

  // Where the segment being read starts in `command`: its raw text keeps the substitutions and
  // backticks that `current` leaves out (WP-160, `rawSegments`).
  let segmentStart = 0;
  // Where `current` holds a process substitution's word (backlog 645), for `droppedSegments`.
  let substitutionWordsAt: number[] = [];
  const droppedSegments: string[] = [];
  const push = (end = index): void => {
    const segment = current.trim();
    if (segment.length > 0) {
      segments.push(segment);
      rawSegments.push(command.slice(segmentStart, end).trim());
      droppedSegments.push(
        substitutionWordsAt
          .reduceRight(
            (text, at) => text.slice(0, at) + text.slice(at + PROCESS_SUBSTITUTION_ARGUMENT.length),
            current,
          )
          .trim(),
      );
    }
    current = '';
    substitutionWordsAt = [];
  };

  while (index < command.length) {
    const char = command[index] as string;
    const rest = command.slice(index);

    // ── constructs that run a command, inside double quotes as well as outside ──

    // Arithmetic expansion. Consumed whole so it cannot desync the parser, and flagged: the
    // shell can turn its result into a command.
    if (rest.startsWith('$((')) {
      uncertainty.add(UNCERTAINTY.arithmetic);
      const close = findClosingParen(command, index + 1);
      if (close === -1) {
        uncertainty.add(UNCERTAINTY.unterminatedSubstitution);
        current += rest;
        index = command.length;
        continue;
      }
      // `findClosingParen` starts on the first `(` of `$((`, counts both opens and so returns the
      // *last* `)`. `close + 1` is therefore one past the expansion; `close + 2` swallowed the
      // character after it, and `ls $((1))&sudo id` never split on the `&`.
      current += command.slice(index, close + 1);
      index = close + 1;
      continue;
    }

    // Command substitution `$( … )` and process substitution `<( … )` / `>( … )`. bash runs the
    // body of all three. A body holding a `case` word or a comment is not read (backlog 651): the
    // matcher may have closed it at a pattern's or a comment's `)`, so the line is uncertain.
    const opensSubstitution =
      rest.startsWith('$(') || rest.startsWith('<(') || rest.startsWith('>(');
    if (opensSubstitution) {
      const close = findClosingParen(command, index + 1, true, uncertainty);
      if (close === -1) {
        uncertainty.add(UNCERTAINTY.unterminatedSubstitution);
        substitutions.push(command.slice(index + 2));
        substitutionOffsets.push(index + 2);
        index = command.length;
        continue;
      }
      substitutions.push(command.slice(index + 2, close));
      substitutionOffsets.push(index + 2);
      // A process substitution is an argument: bash hands the program `/dev/fd/N` (and `2<(…)` is
      // the one word `2/dev/fd/N`), so its word stays where it was written (backlog 645). Inside
      // double quotes too: bash hands `"<(true)"` as written, the scanner lifts its body there all
      // the same (an over-read), and either way the word is one word.
      if (rest[0] !== '$') {
        substitutionWordsAt.push(current.length);
        current += PROCESS_SUBSTITUTION_ARGUMENT;
      }
      index = close + 1;
      continue;
    }

    if (char === '`') {
      const close = command.indexOf('`', index + 1);
      if (close === -1) {
        uncertainty.add(UNCERTAINTY.unterminatedBacktick);
        substitutions.push(command.slice(index + 1));
        substitutionOffsets.push(index + 1);
        index = command.length;
        continue;
      }
      substitutions.push(command.slice(index + 1, close));
      substitutionOffsets.push(index + 1);
      index = close + 1;
      continue;
    }

    // An expansion that evaluates a variable's text (WP-158): flagged, never consumed — its words
    // are read on as any others are, so a `$(…)` inside it is still a substitution.
    if (char === '$' && evaluatesExpansionAt(command, index)) {
      uncertainty.add(UNCERTAINTY.evaluatedText);
    }

    if (inDouble) {
      if (char === '\\') {
        current += command.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (char === '"') {
        inDouble = false;
      }
      current += char;
      index += 1;
      continue;
    }

    // ── ANSI-C quoting: its own state, and never trusted ──
    if (rest.startsWith("$'")) {
      uncertainty.add(UNCERTAINTY.ansiCQuoting);
      const close = findAnsiCEnd(command, index + 2);
      if (close === -1) {
        uncertainty.add(UNCERTAINTY.unbalancedQuote);
        current += rest;
        index = command.length;
        continue;
      }
      current += command.slice(index, close + 1);
      index = close + 1;
      continue;
    }

    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) {
        uncertainty.add(UNCERTAINTY.unbalancedQuote);
        current += rest;
        index = command.length;
        continue;
      }
      current += command.slice(index, close + 1);
      index = close + 1;
      continue;
    }

    if (char === '"') {
      inDouble = true;
      current += char;
      index += 1;
      continue;
    }

    if (char === '\\') {
      current += command.slice(index, index + 2);
      index += 2;
      continue;
    }

    // A comment runs to the newline, which still separates commands: a `\` before that newline is
    // part of the comment, not a continuation (WP-161 criterion (14) — `ls # x \⏎sudo id` was one
    // segment, `ls`, and `allow_list` in every baseline while bash ran `sudo id`).
    if (char === '#' && startsComment(command, index)) {
      const end = command.indexOf('\n', index);
      const stop = end === -1 ? command.length : end;
      current += command.slice(index, stop);
      index = stop;
      continue;
    }

    // An arithmetic command, `((…))` or `for ((…))` (WP-158). `$((` and `<((` never reach here:
    // both are consumed above. Read here and not per stage, because the list split cuts at `(`.
    if (/^\((?:\\\n)*\(/.test(rest)) {
      uncertainty.add(UNCERTAINTY.evaluatedText);
    }

    // ── a here-document operator: kept on its line, its body read at the line's newline ──
    if (readsLines && rest.startsWith('<<')) {
      const before = outsideRanges(command, 0, index, bodyRanges);
      const operator = readHereDocumentOperator(command, index, before);
      if (operator !== null) {
        if (pending.length === 0) {
          pendingFrom = index;
        }
        pending.push(operator);
        current += command.slice(index, index + operator.length);
        index += operator.length;
        continue;
      }
      // Not skipped, but its would-be body is read at the newline: for expansions (WP-158), for a
      // quote it leaves open, and for where bash resumes (WP-160 (e)).
      const refused = unrecognisedOperator(command, index, before);
      if (refused !== null) {
        if (shadow.length === 0) {
          shadowFrom = index;
        }
        shadow.push(refused);
      }
    }

    // ── redirection: consumed as one unit so `2>&1` does not split on the `&` ──
    if (char === '>' || rest.startsWith('&>')) {
      let cursor = index + (rest.startsWith('&>') ? 2 : 1);
      if (command[cursor] === '>' || command[cursor] === '|') {
        cursor += 1;
      }
      while (command[cursor] === ' ') {
        cursor += 1;
      }
      let target = '';
      while (cursor < command.length && !/[\s;&|()<>]/.test(command[cursor] as string)) {
        target += command[cursor];
        cursor += 1;
      }
      if (target === '' && command[cursor] === '&') {
        // `>&word`: a word of digits (optionally `N-`) or a lone `-` duplicates or closes a
        // descriptor; **any other word is a file** — bash reads `>&out` and `>& out` as `&>out`
        // (measured, bash 3.2 and 5.2: `ls >&out1.txt`, `ls 1>&out2`, `ls >& out3` and
        // `ls >&"out11"` each wrote that file). Until backlog 462 every `>&…` was taken for a
        // descriptor and `ls >&out.txt` was `allow`. A word that is not plainly a descriptor —
        // quoted, a variable, empty — is a write target, which can only over-ask.
        cursor += 1;
        while (command[cursor] === ' ') {
          cursor += 1;
        }
        let word = '';
        while (cursor < command.length && !/[\s;&|()<>]/.test(command[cursor] as string)) {
          word += command[cursor];
          cursor += 1;
        }
        target = DESCRIPTOR_WORD.test(word) ? `&${word}` : word === '' ? '>&' : word;
      }
      if (isWriteTarget(target)) {
        writeTargets.push(target);
      }
      // The target is consumed here, so the walk's own `$` check never reaches it (WP-158 round 1).
      if (wordEvaluatesVariableText(command, index, cursor)) {
        uncertainty.add(UNCERTAINTY.evaluatedText);
      }
      current += command.slice(index, cursor);
      index = cursor;
      continue;
    }

    // `<&N`, `<&N-` and `<&-` duplicate, move or close a descriptor: one redirection, whose `&` is
    // not a background operator (WP-161 (g), backlog 519 — `git status <&3` split into `git status <`
    // and `3`). Reading standard input is not a write; a shell reading it is `wrappedScript`'s.
    // Only the operator is consumed: the word after it is read on as any other (a `$(…)` there is
    // still a substitution).
    if (rest.startsWith('<&')) {
      current += '<&';
      index += 2;
      continue;
    }

    // `|&` is one pipe operator, not a pipe followed by a background `&`. When this pass is not
    // the one splitting pipelines it must still be consumed whole, or the `&` half splits the
    // line and the pipeline — the thing `curl * | sh` matches — disappears.
    if (rest.startsWith('|&') && !operators.includes('|&')) {
      current += '|&';
      index += 2;
      continue;
    }

    const operator = operators.find((candidate) => rest.startsWith(candidate));
    if (operator !== undefined) {
      push();
      if (operator === '\n' && shadow.length > 0) {
        // The refused operators' would-be bodies; nothing is skipped. Each is read for its
        // expansions (WP-158). Read as commands, a body can leave a quote open that the walk then
        // pairs with one after bash's terminator, hiding what bash runs there (WP-160 (e)); so where
        // bash resumes is read again from a fresh state by `parseCommand` (`resumeFrom`). That second
        // reading is also what makes such a line uncertain: the quote the body opened is one the
        // lines after it cannot close, so one of the two readings leaves a quote open (a separate
        // check on the body was measured to add nothing — its canary survived every case).
        const at = hereDocumentsAtNewline(command, index, shadow, shadowFrom);
        for (const body of at.bodies) {
          for (const reason of hereDocumentUncertainty(body)) {
            if (reason !== UNCERTAINTY.unterminatedHereDocument) {
              uncertainty.add(reason);
            }
          }
        }
        if (resumeFrom === null && at.range !== null && at.bodies.every((b) => b.terminated)) {
          resumeFrom = at.resume;
        }
        shadow = [];
      }
      if (operator === '\n' && pending.length > 0) {
        const at = hereDocumentsAtNewline(command, index, pending, pendingFrom);
        pending = [];
        if (at.range !== null) {
          recordBodies(at.bodies);
          bodyRanges.push(at.range);
          // `resume` is the newline after the last terminator (or the end), which the next turn
          // reads as an ordinary separator: the lines after it are commands again.
          index = at.resume;
          segmentStart = index;
          continue;
        }
      }
      index += operator.length;
      segmentStart = index;
      continue;
    }
    current += char;
    index += 1;
  }

  if (inDouble) {
    uncertainty.add(UNCERTAINTY.unbalancedQuote);
  }
  if (pending.length > 0) {
    // The line that opened them is the last one: no newline, so no body and no terminator.
    recordBodies(pending.map((operator) => ({ operator, body: '', terminated: false })));
  }
  push(command.length);
  return {
    segments,
    rawSegments,
    substitutions,
    substitutionOffsets,
    writeTargets,
    uncertainty: [...uncertainty],
    hereDocuments,
    bodyRanges,
    resumeFrom,
    droppedSegments,
  };
};

// ── WP-160: a command handed over as a string (backlog 511) ──────────────────
//
// A builtin or a program that runs a **string** as a script — now (`sh -c`, `eval`, `script -c`, a
// shell reading a here-string or a pipe) or later (`trap`, `PS4`, `PROMPT_COMMAND`, an alias, a
// callback) — and `find -exec`, whose argv is a command. Each is read off the stage's words **as
// written** (`ScanResult.rawSegments`: a substitution kept), because whether a string is literal is
// a question about what in it expands.

/** One word of a stage as the shell splits it, quotes and all. */
interface ShellWord {
  /** The word as written. For a redirection, its target. */
  readonly raw: string;
  /** For a redirection, its operator (`<<<`, `<`, `>&`, …) and its descriptor (`''` for none). */
  readonly redirect?: { readonly operator: string; readonly fd: string };
}

/** The shell's redirection operators, longest first; `computesCommandName` reads them too. */
export const REDIRECTION_OPERATOR = /^(?:<<<|<<-|<<|<>|<&|>&|>>|>\||&>>|&>|<|>)/;

/** Index one past the `}` closing the `${` whose `{` is at `open`, or the text's end. */
const closingBraceEnd = (text: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === '\\') {
      index += 1;
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1);
      index = close === -1 ? text.length : close;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return text.length;
};

/** Index one past the double-quoted string that opens at `open`, or the text's end. */
const doubleQuoteEnd = (text: string, open: number): number => {
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === '\\') {
      index += 1;
    } else if (char === '"') {
      return index + 1;
    } else if (text.startsWith('$(', index)) {
      const close = findClosingParen(text, index + 1, true);
      index = close === -1 ? text.length : close;
    } else if (text.startsWith('${', index)) {
      index = closingBraceEnd(text, index + 1) - 1;
    } else if (char === '`') {
      const close = text.indexOf('`', index + 1);
      index = close === -1 ? text.length : close;
    }
  }
  return text.length;
};

/**
 * A pipeline stage's words, split on unquoted blanks as the shell splits them: quotes, `$(…)`,
 * `${…}` and backticks kept inside the word they sit in, and each redirection's operator taken off
 * its target (`2>&1`, `<<<'…'`, `< <(…)`). Nothing is expanded.
 */
const shellWords = (text: string): readonly ShellWord[] => {
  const words: ShellWord[] = [];
  let raw = '';
  let redirect: ShellWord['redirect'];
  const flush = (): void => {
    if (raw !== '') {
      words.push(redirect === undefined ? { raw } : { raw, redirect });
      redirect = undefined;
    }
    raw = '';
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    const rest = text.slice(index);
    let end = index + 1;
    if (/[ \t\n]/.test(char)) {
      flush();
      index += 1;
      continue;
    }
    if (char === '\\') {
      end = index + 2;
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1);
      end = close === -1 ? text.length : close + 1;
    } else if (char === '"') {
      end = doubleQuoteEnd(text, index);
    } else if (rest.startsWith('$(') || rest.startsWith('<(') || rest.startsWith('>(')) {
      const close = findClosingParen(text, index + 1, true);
      end = close === -1 ? text.length : close + 1;
    } else if (rest.startsWith('${')) {
      end = closingBraceEnd(text, index + 1);
    } else if (char === '`') {
      const close = text.indexOf('`', index + 1);
      end = close === -1 ? text.length : close + 1;
    } else if (char === '<' || char === '>' || rest.startsWith('&>')) {
      const operator = (REDIRECTION_OPERATOR.exec(rest) as RegExpExecArray)[0];
      // A word of digits (or `{name}`) right before the operator is its descriptor.
      const fd = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(raw) ? raw : '';
      if (fd === '') {
        flush();
      }
      if (redirect !== undefined) {
        words.push({ raw: '', redirect });
      }
      raw = '';
      redirect = { operator, fd };
      index += operator.length;
      continue;
    }
    raw += text.slice(index, end);
    index = end;
  }
  flush();
  if (redirect !== undefined) {
    words.push({ raw: '', redirect });
  }
  return words;
};

/**
 * Whether the shell passes this word on as written, quotes off: nothing in it expands. A `$` or a
 * backtick outside single quotes, an unquoted glob, tilde or redirection character, or a brace
 * expansion makes it a string the platform cannot read before it runs. A brace expands only when it
 * is unquoted and holds an unquoted `,` or `..` at its own level ({@link bracesExpand}: `{a,b}`,
 * `{1..3}`, and fail-closed an unmatched `{a,b` and a `{..}` bash leaves alone); `{}`, `{x}` and
 * `{}x` are passed as written, so `xargs -I{}` replaces a literal string (WP-193, backlog 565).
 */
const isLiteralWord = (raw: string): boolean => literalWord(raw, false);

/**
 * WP-201: whether a word the scanner judges by its written text — a command name, a block entry's
 * token, git's verb — is literal: {@link isLiteralWord}, a bare `~` or a leading `~/` aside. `~`
 * names the home the platform set, which WP-200 refuses the run re-pointing, so `~/bin/tool` is the
 * sandbox's own file as `./tool` is. `~login` names another user's home (`~root`), and `~-`, `~+`
 * and `~N` are `$OLDPWD`, `$PWD` and the directory stack: none is literal (review rounds 1 and 2). A quote left open is not an expansion here: the scanner reports it as
 * its own reason (`unbalancedQuote`), and what follows it is quoted text.
 */
export const isLiteralJudgedWord = (raw: string): boolean => literalWord(raw, true);

const literalWord = (raw: string, judged: boolean): boolean => {
  // Only a bare `~` names the home the platform set (round 1: `OLDPWD=/usr/bin/sudo; ~- id`;
  // round 2: `rm -rf ~root` is another user's home).
  if (judged && raw.startsWith('~') && !/^~(?:\/|$)/.test(raw)) {
    return false;
  }
  const expands = judged ? /[*?[<>()]/ : /[*?[~<>()]/;
  let quote: '"' | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (char === '\\') {
      index += 1;
    } else if (quote === null && char === "'") {
      const close = raw.indexOf("'", index + 1);
      if (close === -1) {
        return judged;
      }
      index = close;
    } else if (char === '"') {
      quote = quote === null ? '"' : null;
    } else if (char === '$' || char === '`') {
      return false;
    } else if (quote === null && expands.test(char)) {
      return false;
    } else if (quote === null && char === '{' && bracesExpand(raw, index)) {
      return false;
    }
  }
  return judged || quote === null;
};

/** A literal word's value — what the program receives (only meaningful when `isLiteralWord`). */
const literalValue = (raw: string): string => {
  let out = '';
  let quote: '"' | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    const next = raw[index + 1] ?? '';
    if (char === '\\') {
      index += 1;
      if (next === '\n') {
        continue;
      }
      out += quote === '"' && !/[$`"\\]/.test(next) ? `\\${next}` : next;
    } else if (quote === null && char === "'") {
      const close = raw.indexOf("'", index + 1);
      out += raw.slice(index + 1, close);
      index = close;
    } else if (char === '"') {
      quote = quote === null ? '"' : null;
    } else {
      out += char;
    }
  }
  return out;
};

/** The paths through which a script names its own standard input. */
const STANDARD_INPUT_PATHS: ReadonlySet<string> = new Set([
  '/dev/stdin',
  '/dev/fd/0',
  '/proc/self/fd/0',
]);

/** The pieces of argv a reader takes options from, with an option's value word skipped. */
const optionWords = (args: readonly ShellWord[]): readonly string[] =>
  args.map((word) => unquoteToken(word.raw)).filter((word) => /^-[A-Za-z]/.test(word));

/**
 * Where the command of a stage may start: past its assignments, and — when that word is a wrapper
 * — every later word too, as `argv0Candidates` tries them (a wrapper's options and arguments sit
 * between it and the command), except a value or operand the wrapper's declared grammar names
 * (WP-205). The walk is `walkCommandStarts`, so it has the same bound and says
 * when it stopped at it (WP-161 (d)).
 */
const commandPositions = (argv: readonly ShellWord[]): CommandStarts => {
  let start = 0;
  while (start < argv.length && isAssignment((argv[start] as ShellWord).raw)) {
    start += 1;
  }
  const raws = argv.map((word) => word.raw);
  const walk = walkCommandStarts(raws, isWrapperAt, (raw) => isFlagToken(unquoteToken(raw)));
  const isWrapper =
    start < argv.length &&
    (isArgv0Wrapper(argv0Name(raws[start] as string)) || runnerSubcommandAt(raws, start) !== null);
  return {
    starts: (isWrapper ? walk.starts.filter((position) => position >= start) : [start]).filter(
      (position) => position < argv.length,
    ),
    tooDeep: walk.tooDeep,
  };
};

// ── WP-161 (f): a command name the shell expands (backlog 518) ───────────────

/**
 * Whether a word as written is one bash finishes only when it runs it (WP-201, backlogs 591 and
 * 593): a `$` or a backtick outside single quotes (a parameter, command or arithmetic expansion,
 * `$'…'` included), an unquoted `*`, `?` or `[` (pathname expansion), a brace expansion — an
 * unquoted `{…}` with a `,` or a `..` at its own level (`{a,b}`, `{i..i}`) — or any other class
 * {@link isLiteralWord} names; a tilde aside ({@link isLiteralJudgedWord}). Until WP-201 it read
 * only the glob and the brace, so `su$x id` and `sh -c 'su"$@"' _ do id` were judged as `su`. A
 * `[` with no `]` is literal to bash and read as a glob here, which can only over-read.
 */
const expandsAsName = (word: string): boolean => !isLiteralJudgedWord(word);

/**
 * WP-250 (backlog 650): whether a word as written carries an expansion bash word-splits — a
 * backtick body, or a `$` before `(`, `{`, `[`, a name or a special parameter — outside single
 * and double quotes. Such a word is handed as zero, one or many words; a double-quoted one
 * (`"$(pwd)"`) is exactly one, and `$'…'` / `$"…"` are quoting, not expansions. A `\'` inside
 * `$'…'` is not read (`$'a\'b'$(pwd)` answers false): the scanner already reads `$'…'` uncertain.
 */
const expandsUnquoted = (raw: string): boolean => {
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (char === '\\') {
      index += 1;
    } else if (char === "'") {
      const close = raw.indexOf("'", index + 1);
      index = close === -1 ? raw.length : close;
    } else if (char === '"') {
      index = doubleQuoteEnd(raw, index) - 1;
    } else if (char === '`' || (char === '$' && /^[({[\w@*#?$!-]/.test(raw[index + 1] ?? ''))) {
      return true;
    }
  }
  return false;
};

/**
 * Whether the unquoted `{` at `open` starts a brace expansion: a `,` or `..` at its own level.
 * This is the detector, read where a written word is judged literal; {@link expandBraces} is the
 * reader the argv reading takes since WP-243, and a word this flags that it cannot expand makes
 * the line `braceExpansion`.
 * bash closes the brace only at a `}` that follows such a separator — a `}` before one is a literal
 * character, so `x{},a}` is `x}` and `xa` and `{x},b}` is `x}` and `b` (measured, bash 5.3) — and
 * a backslash escapes inside double quotes too, so `{"\"",a}` expands. Before WP-193 both read as
 * no expansion. Over-reads, never under-reads: an unmatched `{a,b`, any `..` (`{a..}`), and
 * `{},a}`, which bash leaves alone at the start of a word only, all count.
 */
const bracesExpand = (word: string, open: number): boolean => {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = open + 1; index < word.length; index += 1) {
    const char = word[index] as string;
    if (quote === "'") {
      quote = char === quote ? null : quote;
    } else if (char === '\\') {
      index += 1;
    } else if (quote === '"') {
      quote = char === quote ? null : quote;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth = Math.max(depth - 1, 0);
    } else if (depth === 0 && (char === ',' || word.startsWith('..', index))) {
      return true;
    }
  }
  return false;
};

/**
 * The index just past a piece of `word` at `at` that brace expansion does not look inside — a
 * backslash and its character, `'…'`, `"…"`, `` `…` ``, `${…}`, `$(…)`, `<(…)`, `>(…)` — or `at`
 * when none starts there. bash skips the same (`x$(printf %s {a,b})y` is one word, measured in the
 * run image). A piece left open runs to the end of the word; the parser reports it as its own reason.
 */
const braceOpaqueEnd = (word: string, at: number): number => {
  const quoted = quotedPieceEnd(word, at);
  const next = word[at + 1];
  const opens =
    (word[at] === '$' && (next === '{' || next === '(')) ||
    ((word[at] === '<' || word[at] === '>') && next === '(');
  if (quoted > at || !opens) {
    return quoted;
  }
  // Counted, not recursed: a nested `$(` is one more `(` (a deep nesting costs no stack).
  const [opener, closer] = next === '{' ? ['{', '}'] : ['(', ')'];
  let depth = 1;
  let index = at + 2;
  while (index < word.length && depth > 0) {
    const skipped = quotedPieceEnd(word, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    depth += word[index] === opener ? 1 : word[index] === closer ? -1 : 0;
    index += 1;
  }
  return index;
};

/** {@link braceOpaqueEnd}'s quoted pieces: a backslash and its character, `'…'`, `"…"`, `` `…` ``. */
const quotedPieceEnd = (word: string, at: number): number => {
  const char = word[at];
  if (char === '\\') {
    return Math.min(at + 2, word.length);
  }
  if (char === "'" || char === '`') {
    const close = word.indexOf(char, at + 1);
    return close === -1 ? word.length : close + 1;
  }
  if (char === '"') {
    for (let index = at + 1; index < word.length; index += 1) {
      if (word[index] === '\\') {
        index += 1;
      } else if (word[index] === '"') {
        return index + 1;
      }
    }
    return word.length;
  }
  return at;
};

/**
 * The `}` that closes a brace expansion opened at `open`, or -1: bash's `brace_gobbler` closes only
 * at a `}` of its own level that follows a `,` or `..` of that level, so `x{},a}` is `x}` and `xa`.
 * `separators` collects the `,` positions of that level, where the amble splits.
 */
const braceClose = (word: string, open: number, separators: number[]): number => {
  let depth = 0;
  let sequence = false;
  for (let index = open + 1; index < word.length; index += 1) {
    const skipped = braceOpaqueEnd(word, index);
    if (skipped > index) {
      index = skipped - 1;
      continue;
    }
    const char = word[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
    } else if (char === '}' && (separators.length > 0 || sequence)) {
      return index;
    } else if (depth === 0 && char === ',') {
      separators.push(index);
    } else if (depth === 0 && word.startsWith('..', index)) {
      sequence = true;
    }
  }
  separators.length = 0;
  return -1;
};

const BRACE_INTEGER = '(0|-?[1-9][0-9]*)';
const BRACE_INTEGER_RANGE = new RegExp(
  `^${BRACE_INTEGER}\\.\\.${BRACE_INTEGER}(?:\\.\\.${BRACE_INTEGER})?$`,
);
const BRACE_LETTER_RANGE = new RegExp(
  `^(?:([a-z])\\.\\.([a-z])|([A-Z])\\.\\.([A-Z]))(?:\\.\\.${BRACE_INTEGER})?$`,
);

/**
 * A sequence expression's words (bash *Brace Expansion*: `{x..y[..incr]}`, the increment's sign
 * ignored, 0 read as 1 — `{1..10..-3}` is `1 4 7 10`, `{1..3..0}` is `1 2 3`, measured), or `null`
 * for a form the port does not read: zero-padded (`{01..10}`), mixed-case (`{a..Z}`), a sign
 * written `+`, or one bash leaves as written (`{a..}`, `{1..a}`) — fail closed — or past `budget`.
 */
const braceSequence = (amble: string, budget: number): readonly string[] | null => {
  const integers = BRACE_INTEGER_RANGE.exec(amble);
  const letters = integers === null ? BRACE_LETTER_RANGE.exec(amble) : null;
  if (integers === null && letters === null) {
    return null;
  }
  const [from, to, step] =
    integers !== null
      ? [Number(integers[1]), Number(integers[2]), integers[3]]
      : [
          (letters?.[1] ?? letters?.[3] ?? '').charCodeAt(0),
          (letters?.[2] ?? letters?.[4] ?? '').charCodeAt(0),
          letters?.[5],
        ];
  const increment = Math.max(Math.abs(Number(step ?? 1)), 1);
  if (![from, to, increment].every(Number.isSafeInteger)) {
    return null;
  }
  const count = Math.floor(Math.abs(to - from) / increment) + 1;
  if (count > budget) {
    return null;
  }
  const direction = to >= from ? 1 : -1;
  return Array.from({ length: count }, (_, index) => {
    const value = from + direction * index * increment;
    return integers !== null ? String(value) : String.fromCharCode(value);
  });
};

/**
 * The words bash makes of one word by brace expansion (WP-243, backlog 642; bash *Brace
 * Expansion*, https://www.gnu.org/software/bash/manual/bash.html#Brace-Expansion): the first
 * expansion — the first unquoted `{` whose {@link braceClose} exists — splits into a preamble, an
 * amble and a postscript; a comma list's parts and the postscript are expanded in turn, and the
 * words come in bash's order (`a{1,2}{x,y}b` is `a1xb a1yb a2xb a2yb`). Quotes are kept for
 * `unquoteToken` (`{"a b",c}` is `"a b"` and `c`). `null` when a sequence is one
 * {@link braceSequence} does not read, the words would pass `budget`, the expansions nest or
 * follow one another past {@link BRACE_EXPANSION_CEILING} levels, or the word holds more unquoted
 * `{` than that.
 */
const expandBraces = (word: string, budget: number, depth = 0): readonly string[] | null => {
  if (!word.includes('{')) {
    return [word];
  }
  // Each unquoted `{` may scan to the word's end, so their number is bounded too: `{` × 20 000
  // took 17 s unbounded (measured).
  let opens = 0;
  for (let index = 0; index < word.length; index += 1) {
    const skipped = braceOpaqueEnd(word, index);
    if (skipped > index) {
      index = skipped - 1;
    } else if (word[index] === '{' && ++opens > BRACE_EXPANSION_CEILING) {
      return null;
    }
  }
  for (let open = 0; open < word.length; open += 1) {
    const skipped = braceOpaqueEnd(word, open);
    if (skipped > open) {
      open = skipped - 1;
      continue;
    }
    const separators: number[] = [];
    const close = word[open] === '{' ? braceClose(word, open, separators) : -1;
    if (close === -1) {
      continue;
    }
    // Each expansion is a level: `{1..1}` written 300 times makes one word and 300 levels. And
    // `{},a}` is left as written at the start of a word, expanded after a preamble (`x{},a}` is `x}`
    // and `xa`, measured): the port does not read which, so a `{}` opening one is unread.
    if (depth >= BRACE_EXPANSION_CEILING || word[open + 1] === '}') {
      return null;
    }
    const bounds = [open, ...separators, close];
    const parts: (readonly string[] | null)[] =
      separators.length === 0
        ? [braceSequence(word.slice(open + 1, close), budget)]
        : bounds
            .slice(1)
            .map((end, index) =>
              expandBraces(word.slice((bounds[index] as number) + 1, end), budget, depth + 1),
            );
    const rest = expandBraces(word.slice(close + 1), budget, depth + 1);
    const amble = parts.every((part): part is readonly string[] => part !== null)
      ? parts.flat()
      : null;
    if (amble === null || rest === null || amble.length * rest.length > budget) {
      return null;
    }
    const preamble = word.slice(0, open);
    return amble.flatMap((part) => rest.map((after) => `${preamble}${part}${after}`));
  }
  return [word];
};

/** A wrapper's option value or leading operand that is plainly not a command: a number, a duration, a mask, a signal. */
const WRAPPER_VALUE_WORD = /^(?:[0-9][0-9.]*[smhd]?|0x[0-9a-fA-F]+|[A-Z][A-Z0-9]*)$/;
/**
 * Per wrapper, the options that take no value (GNU coreutils' and util-linux's `--help`), so the word
 * after one is the command or another option. Any option not listed — and every option of a wrapper
 * not listed — is read as taking a value (backlog 531, failing closed).
 */
const WRAPPER_FLAGS_WITHOUT_VALUE: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(['-i', '-0', '--ignore-environment', '--null', '-v', '--debug']),
  timeout: new Set(['--preserve-status', '--foreground', '-v', '--verbose']),
  time: new Set(['-p', '-v', '--portability', '--verbose']),
  command: new Set(['-p', '-v', '-V']),
  exec: new Set(['-c', '-l']),
  setsid: new Set(['-c', '-f', '-w', '--ctty', '--fork', '--wait']),
  // WP-203: the run image's argv wrappers, from the manual each `ARGV0_WRAPPERS` entry cites.
  chroot: new Set(['--skip-chdir']),
  runcon: new Set(['-c', '--compute']),
  setpriv: new Set([
    '-d',
    '--dump',
    '--clear-groups',
    '--keep-groups',
    '--init-groups',
    '--list-caps',
    '--no-new-privs',
    '--nnp',
    '--reset-env',
  ]),
  ...Object.fromEntries(
    SETARCH_NAMES.map((name) => [
      name,
      new Set([
        '--uname-2.6',
        '-v',
        '--verbose',
        '-3',
        '--3gb',
        '--4gb',
        '-B',
        '--32bit',
        '-F',
        '--fdpic-funcptrs',
        '-I',
        '--short-inode',
        '-L',
        '--addr-compat-layout',
        '-R',
        '--addr-no-randomize',
        '-S',
        '--whole-seconds',
        '-T',
        '--sticky-timeouts',
        '-X',
        '--read-implies-exec',
        '-Z',
        '--mmap-page-zero',
        '--show',
      ]),
    ]),
  ),
  // A resource option's limits are optional and attached only (`--nofile=9`, `-n9`).
  prlimit: new Set([
    '--noheadings',
    '--raw',
    '--verbose',
    ...['as', 'core', 'cpu', 'data', 'fsize', 'locks', 'memlock', 'msgqueue', 'nice', 'nofile']
      .concat(['nproc', 'rss', 'rtprio', 'rttime', 'sigpending', 'stack'])
      .map((resource) => `--${resource}`),
    ...'Acdefilmnqrstuxy'.split('').map((letter) => `-${letter}`),
  ]),
  uclampset: new Set(['-a', '--all-tasks', '-R', '--reset-on-fork', '-s', '--system', '-v']),
  'start-stop-daemon': new Set([
    '-S',
    '--start',
    '-K',
    '--stop',
    '-T',
    '--status',
    '-t',
    '--test',
    '-o',
    '--oknodo',
    '-q',
    '--quiet',
    '-b',
    '--background',
    '--notify-await',
    '-C',
    '--no-close',
    '-m',
    '--make-pidfile',
    '--remove-pidfile',
    '-v',
    '--verbose',
  ]),
  // WP-207: from the manual each `ARGV0_WRAPPERS` entry (and `DYNAMIC_LOADER_NAME`) cites. `--list`,
  // `--verify` and `--list-*` run nothing; read as a wrapper anyway, the line only over-asks.
  'ld.so': new Set([
    '--inhibit-cache',
    '--list',
    '--list-diagnostics',
    '--list-tunables',
    '--verify',
  ]),
  'ssh-agent': new Set(['-c', '-s', '-d', '-D', '-k']),
  choom: new Set(['-h', '--help', '-V', '--version']),
  switch_root: new Set(['-h', '--help', '-V', '--version']),
  debconf: new Set(['--terse']),
  'debconf-apt-progress': new Set([
    '--config',
    '--start',
    '--stop',
    '--no-progress',
    '--logstderr',
  ]),
};
/**
 * Wrappers whose first operand is not the command (`flock FILE cmd`, `su USER …`, `timeout DURATION
 * cmd`, `taskset MASK cmd`, `chrt PRIORITY cmd`): that operand is listed and the walk goes on, whatever
 * its shape — `timeout inf` and `taskset ff` were taken for the command (WP-161 review round 2).
 */
const WRAPPER_OPERAND: ReadonlySet<string> = new Set([
  'flock',
  'su',
  'runuser',
  'timeout',
  'taskset',
  'chrt',
  // WP-203: `chroot NEWROOT`, `runcon CONTEXT`, `setarch ARCH` (the manuals `ARGV0_WRAPPERS` cites).
  'chroot',
  'runcon',
  'setarch',
  // WP-207: `switch_root NEWROOT INIT` (the manual `ARGV0_WRAPPERS` cites).
  'switch_root',
]);

/**
 * A wrapper's declared grammar (WP-205, backlogs 592, 596, 601, 608): the options that take a value
 * — the rest of a short cluster, `=`-attached, or the next word — the options whose value is only
 * ever attached, the options whose value **is** the command it runs, and how many operands stand
 * before the command. Its options that take none are {@link WRAPPER_FLAGS_WITHOUT_VALUE}'s (and
 * `flags` here). An option the grammar does not name is read as today, both ways.
 */
interface WrapperGrammar {
  readonly values: ReadonlySet<string>;
  readonly attachedOnly?: ReadonlySet<string>;
  readonly flags?: ReadonlySet<string>;
  readonly commands?: ReadonlySet<string>;
  readonly operands?: number;
}

/**
 * The wrappers whose grammar is declared, each from its manual, keyed as `wrapperGrammarKey` keys
 * them (a package runner's exec form as `<runner> <subcommand>`). {@link commandNameWalk} skips a
 * declared option's value and a declared operand — never naming either as a command — while the
 * walk is still reading by grammar and the word is **one word** to the shell ({@link isOneWord}): an
 * unquoted expansion or a glob there may become several words, one of them the command (measured:
 * `t="1 echo"; timeout $t MARK` runs `echo`), so it is listed as before — and so is an option word
 * that may be several words (`nice -n$n make`, WP-216), which the grammar then reads as one it does
 * not name. {@link walkCommandStarts}
 * drops the same words as command starts, so one grammar serves both walks.
 */
const WRAPPER_GRAMMARS: Readonly<Record<string, WrapperGrammar>> = {
  // https://manpages.debian.org/trixie/coreutils/env.1.en.html
  env: {
    values: new Set(['-u', '--unset', '-C', '--chdir']),
    // `-S`'s value is a command line (read by `readOptionString`), so it is never skipped.
    commands: new Set(['-S', '--split-string']),
    attachedOnly: new Set(['--block-signal', '--default-signal', '--ignore-signal']),
    flags: new Set(['--list-signal-handling']),
  },
  // https://manpages.debian.org/trixie/coreutils/timeout.1.en.html: `timeout [OPTION] DURATION COMMAND`.
  timeout: {
    values: new Set(['-k', '--kill-after', '-s', '--signal']),
    flags: new Set(['-f', '-p']),
    operands: 1,
  },
  // https://manpages.debian.org/trixie/coreutils/nice.1.en.html
  nice: { values: new Set(['-n', '--adjustment']) },
  // https://manpages.debian.org/trixie/coreutils/stdbuf.1.en.html
  stdbuf: { values: new Set(['-i', '--input', '-o', '--output', '-e', '--error']) },
  // `readXargsOptions`' optstring `+0a:E:e::i::I:l::L:n:oprs:txP:d:` (plus BSD's `-J`, `-R`, `-S`)
  // and its long options (`XARGS_LONG_OPTIONS`); an abbreviated long option is read both ways.
  xargs: {
    values: new Set([
      ...'adEILnPsJRS'.split('').map((letter) => `-${letter}`),
      ...['arg-file', 'delimiter', 'max-args', 'max-chars', 'max-procs', 'process-slot-var'].map(
        (name) => `--${name}`,
      ),
    ]),
    attachedOnly: new Set(['-e', '-i', '-l', '--eof', '--replace', '--max-lines']),
    flags: new Set([
      ...'0oprtx'.split('').map((letter) => `-${letter}`),
      ...['null', 'open-tty', 'interactive', 'no-run-if-empty', 'verbose', 'show-limits', 'exit']
        .concat(['version', 'help'])
        .map((name) => `--${name}`),
    ]),
  },
  // https://manpages.debian.org/trixie/dpkg/start-stop-daemon.8.en.html: `--exec`/`-x` and
  // `--startas`/`-a` name the program it runs, in every getopt spelling (backlog 601).
  'start-stop-daemon': {
    values: new Set([
      '--pid',
      '--ppid',
      '-p',
      '--pidfile',
      '-n',
      '--name',
      '-u',
      '--user',
      '-g',
      '--group',
      '-s',
      '--signal',
      '-R',
      '--retry',
      '-c',
      '--chuid',
      '-r',
      '--chroot',
      '-d',
      '--chdir',
      '--notify-timeout',
      '-O',
      '--output',
      '-N',
      '--nicelevel',
      '-P',
      '--procsched',
      '-I',
      '--iosched',
      '-k',
      '--umask',
    ]),
    commands: new Set(['-x', '--exec', '-a', '--startas']),
    flags: new Set(['-H', '--help', '-V', '--version']),
  },
  // `sentry-cli monitors run [OPTIONS] <monitor_slug> -- <command> <args>` (backlog 608;
  // https://docs.sentry.io/cli/crons/, read 2026-10-19; `sentry-cli` 3.7.0 is pinned in
  // `docker/runtime.Dockerfile`, whose own `--help` was not read): `-e`, `-s`/`--schedule`,
  // `--check-in-margin`, `--max-runtime` and `--timezone` take a value, and the slug is its operand.
  'sentry-cli run': {
    values: new Set(['-e', '-s', '--schedule', '--check-in-margin', '--max-runtime', '--timezone']),
    operands: 1,
  },
};

/**
 * The names of {@link ARGV0_WRAPPERS} (and the loader's key) with no declared grammar, each with its
 * reason (WP-205 (c)'s census, `wrappersWithoutGrammar`): such a wrapper keeps the both-ways
 * reading, which over-asks and never under-reads.
 */
const UNDECLARED_WRAPPER_GRAMMARS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    ['if', 'then', 'else', 'elif', 'while', 'until', 'do', 'done', 'fi', 'for', 'case', 'esac']
      .concat(['{', '}', '!', '[[', ']]', 'coproc', 'builtin', 'command', 'exec', 'eval', 'time'])
      .map((name) => [name, 'a shell keyword or builtin: the shell’s grammar, not a getopt one']),
  ),
  ...Object.fromEntries(
    ['sh', 'bash', 'zsh', 'dash'].map((name) => [
      name,
      'a shell: its operands are a script and its arguments, which `wrappedScript` reads',
    ]),
  ),
  ...Object.fromEntries(
    ['busybox', ...PACKAGE_RUNNER_COMMANDS, NODE_ENTRYPOINT].map((name) => [
      name,
      'an applet or package runner: the word after it is the program, read by its own rule',
    ]),
  ),
  ...Object.fromEntries(
    ['ionice', 'setsid', 'flock', 'chrt', 'taskset', 'unbuffer', 'watch', 'strace', 'ltrace']
      .concat(['nsenter', 'unshare', 'runuser', 'su', 'doas', 'nohup', 'chroot', 'runcon'])
      .concat(['setpriv', ...SETARCH_NAMES, 'prlimit', 'uclampset', 'ssh-agent', 'fstab-decode'])
      .concat(['choom', 'switch_root', 'debconf', 'debconf-apt-progress', 'ld.so'])
      .map((name) => [
        name,
        'not declared by WP-205, whose rows name env, timeout, nice, stdbuf, xargs, start-stop-daemon and sentry-cli: read both ways',
      ]),
  ),
};

/** A wrapper's declared grammar, by its key. */
const grammarOf = (key: string): WrapperGrammar | undefined =>
  Object.hasOwn(WRAPPER_GRAMMARS, key) ? WRAPPER_GRAMMARS[key] : undefined;

/**
 * WP-205 (c)'s census: every name of {@link ARGV0_WRAPPERS}, and the dynamic loader's key, either
 * declares a grammar or is listed undeclared with a reason. The names that do neither.
 */
export const wrappersWithoutGrammar = (): readonly string[] =>
  [...ARGV0_WRAPPERS, 'ld.so'].filter(
    (name) =>
      !Object.hasOwn(WRAPPER_GRAMMARS, name) && !Object.hasOwn(UNDECLARED_WRAPPER_GRAMMARS, name),
  );

/**
 * Whether the shell passes a word on as exactly one word: no unquoted expansion, glob or brace
 * ({@link mayBeSeveralWords}), and no `"$@"`/`"${a[@]}"`, which is any number of words quoted.
 */
const isOneWord = (raw: string): boolean =>
  !mayBeSeveralWords(raw) && !/\$\{?[@*]|\[[@*]\]/.test(raw);

/**
 * How a declared grammar reads one option word: `value` when the next word is its value, `command`
 * when the next word is the command it runs, `attached-command` when the word itself carries that
 * command (`--exec=/usr/bin/git`, `-x/usr/bin/git`; the command is the second element), `done` when
 * the word is whole, and `unknown` when the grammar does not name it (then the walk reads it both
 * ways, as for an undeclared wrapper).
 */
const grammarOption = (
  grammar: WrapperGrammar,
  flags: ReadonlySet<string> | undefined,
  value: string,
): 'value' | 'command' | readonly ['attached-command', string] | 'done' | 'unknown' => {
  const isFlag = (option: string): boolean =>
    (flags?.has(option) ?? false) || (grammar.flags?.has(option) ?? false);
  if (value.startsWith('--')) {
    const [name = '', ...attached] = value.split('=');
    const takesValue = grammar.values.has(name) || (grammar.commands?.has(name) ?? false);
    if (attached.length > 0) {
      if (grammar.commands?.has(name)) {
        return ['attached-command', attached.join('=')];
      }
      return takesValue || (grammar.attachedOnly?.has(name) ?? false) ? 'done' : 'unknown';
    }
    if (takesValue) {
      return grammar.commands?.has(name) ? 'command' : 'value';
    }
    return isFlag(name) || (grammar.attachedOnly?.has(name) ?? false) ? 'done' : 'unknown';
  }
  // A short cluster, by getopt: flags until the first option that takes a value, which takes the
  // rest of the word or, with nothing left, the next word.
  for (let at = 1; at < value.length; at += 1) {
    const option = `-${value[at] as string}`;
    const rest = at + 1 < value.length;
    if (grammar.values.has(option) || grammar.commands?.has(option)) {
      if (grammar.commands?.has(option)) {
        return rest ? ['attached-command', value.slice(at + 1)] : 'command';
      }
      return rest ? 'done' : 'value';
    }
    if (grammar.attachedOnly?.has(option)) {
      return 'done';
    }
    if (!isFlag(option)) {
      return 'unknown';
    }
  }
  return 'done';
};

/**
 * The words of a stage in **command position** (WP-161 (f)): past its assignments, the first word,
 * and — while that word is a wrapper — the next command word after the wrapper's options, their
 * plain values and its leading operand. A wrapper with a declared grammar ({@link WRAPPER_GRAMMARS},
 * WP-205) has its option values and operand skipped by that grammar, unlisted, while each is one
 * word and every word before it was read by a grammar; any other value or operand — of a wrapper
 * with no declared grammar, after an option its grammar does not name, or one the shell may split
 * (`timeout $t make`) — is listed too, since it may be the command; so is an option word itself
 * that the shell may split (`nice -n$n make`, `taskset -c$c make`; WP-216), while a quoted one
 * (`-n"$n"`) is one word and is not. Never an assignment (backlog 512's lesson), never a `[`/`[[` test or
 * what is inside it, and never an argument of the command itself: `nice ls *.ts` lists `nice` and
 * `ls`, not `*.ts`. The arguments of a command the policy does not know are command-position
 * words too since WP-203, read by their own rule ({@link unknownProgramArgument}).
 */
const commandNameWords = (tokens: readonly string[]): readonly string[] =>
  commandNameWalk(tokens).words;

/**
 * {@link commandNameWords}' walk, which also says where the command it stopped at stands (`command`,
 * an index into `tokens`; none when the stage is only wrappers or stops at an expanded name or a
 * test) and which wrappers it peeled to reach it (WP-203). A wrapper's option word that may be
 * several words (`!isOneWord`: `-n$n`, `--adjustment=$n`, `-$x`) is listed as a possible command
 * word by the generic option branch, which a declared grammar's `unknown` reading and every
 * undeclared wrapper reach (WP-216); `walkCommandStarts` already starts a command there, since
 * the word is never `skipped`. `dequote` is how the reading's words read (WP-247, backlog 647):
 * `asHanded` on the argv reading, so `env "\-u" sudo id` is the command `\-u` and no `-u` that
 * skips `sudo`. On that reading only `skipped` and `attached` are read; the entrypoint test and the
 * generic option's next word change `words` and `command` alone, so no row can see their dequote.
 */
const commandNameWalk = (
  tokens: readonly string[],
  dequote: (token: string) => string = unquoteToken,
): {
  readonly words: readonly string[];
  readonly command?: number;
  readonly wrappers: readonly string[];
  readonly skipped: readonly number[];
  readonly attached: readonly { readonly index: number; readonly command: string }[];
} => {
  const words: string[] = [];
  const wrappers: string[] = [];
  const skipped: number[] = [];
  const attached: { readonly index: number; readonly command: string }[] = [];
  let operand = false;
  let wrapper = '';
  let grammarKey = '';
  let runner = '';
  // Whether every word so far was read by a declared grammar or plain shell syntax, never both
  // ways: only then is a declared value or operand skipped (WP-205).
  let precise = true;
  let runnerSubcommand: number | null = null;
  let opaqueRunner = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const value = dequote(token);
    const afterWrapper = words.length > 0;
    // An assignment, an element assignment (`y[x]=1`, `[x]=1` inside `y=( … )`) or a wrapper's `--`.
    if (isAssignment(token) || ELEMENT_ASSIGNMENT.test(value) || (afterWrapper && value === '--')) {
      continue;
    }
    if (value === '[' || value === '[[') {
      break;
    }
    if (
      wrapper === NODE_ENTRYPOINT &&
      argv0NameAs(tokens[index - 1] ?? '', dequote) === NODE_ENTRYPOINT &&
      isFlagToken(value)
    ) {
      // `docker-entrypoint.sh -e '…'` is `node -e '…'`: the entrypoint is the command.
      return { words, command: index - 1, wrappers: wrappers.slice(0, -1), skipped, attached };
    }
    const grammar = precise ? grammarOf(grammarKey) : undefined;
    if (afterWrapper && isFlagToken(value) && grammar !== undefined) {
      // WP-205: a declared grammar reads the option by getopt's rules. Its value is skipped when it
      // is one word; one that may be several (`-s $sig`, `-n$n`) is listed and ends the precision.
      const option = grammarOption(grammar, WRAPPER_FLAGS_WITHOUT_VALUE[grammarKey], value);
      const reading = typeof option === 'string' && !isOneWord(token) ? 'unknown' : option;
      const next = tokens[index + 1];
      if (reading !== 'unknown') {
        // The option word is no start either: the block peel reads a start at an option as the
        // positional after it (`-u sudo id` is `sudo id` to `tokensMatch`).
        if (reading === 'done') {
          skipped.push(index);
        } else if (typeof reading !== 'string') {
          // The command is inside the word (backlog 601): listed — so `--exec=/usr/bin/s$x` is an
          // expanded name — and offered to the block peel as a start of its own
          // (`argv0Candidates`); the walk stops knowing where the arguments begin.
          words.push(token);
          attached.push({ index, command: reading[1] });
          precise = false;
        } else if (next !== undefined) {
          index += 1;
          if (reading === 'value' && isOneWord(next)) {
            skipped.push(index - 1, index);
          } else {
            words.push(next);
            precise = false;
            if (reading === 'command') {
              attached.push({ index, command: next });
            }
          }
        }
        continue;
      }
      precise = false;
    }
    if (afterWrapper && isFlagToken(value)) {
      // Fail closed (backlog 531, folded into WP-161): an option written without `=` may take the
      // next word as its value whatever its shape (`env -u foo`, `taskset -c 0-3`, `timeout -s
      // kill`), so that word is listed — tested by `expandsAsName` — and the walk goes on to the one
      // after it. Only an option known to take no value (`WRAPPER_FLAGS_WITHOUT_VALUE`) does not
      // spend the next word. The over-ask, stated: `nice -x ls *.ts` (an option the table does not
      // know) reads `*.ts` as a command word. A wrapper with a declared grammar reads its options
      // above (WP-205), and comes here only for an option its grammar does not name. The option word
      // itself is listed when the shell may split it (WP-216, backlog 614): `nice -n$n make` with
      // `n="5 echo"` runs `echo`, so `-n$n` is a possible command word, as `$n` in the value slot is.
      const next = tokens[index + 1];
      precise = false;
      if (!isOneWord(token)) {
        words.push(token);
      }
      if (
        !value.includes('=') &&
        next !== undefined &&
        !isFlagToken(dequote(next)) &&
        !(WRAPPER_FLAGS_WITHOUT_VALUE[wrapperGrammarKey(wrapper)]?.has(value) ?? false)
      ) {
        words.push(next);
        index += 1;
      }
      continue;
    }
    if (afterWrapper && operand && grammar !== undefined && isOneWord(token)) {
      // WP-205: a declared operand (`timeout DURATION`, the `sentry-cli monitors run` slug).
      skipped.push(index);
      operand = false;
      continue;
    }
    if (afterWrapper && (operand || WRAPPER_VALUE_WORD.test(value))) {
      words.push(token);
      operand = false;
      precise = false;
      continue;
    }
    words.push(token);
    const name = argv0NameAs(token, dequote);
    // A package runner's exec form and its subcommand are wrappers too (WP-196 (b)).
    const found = runnerSubcommandAt(tokens, index);
    const subcommand = typeof found === 'number' ? found : null;
    if (expandsAsName(token)) {
      break;
    }
    if (!(isArgv0Wrapper(name) || found !== null || index === runnerSubcommand)) {
      // A package runner's own words before its exec subcommand (`yarn workspace a exec …`, `pnpm m
      // exec …`) are not the command, and one whose subcommand cannot be determined (`yarn
      // workspaces …`, `npm explore`) runs a command no walk names (WP-203).
      if (runnerSubcommand !== null && index < runnerSubcommand) {
        continue;
      }
      return opaqueRunner
        ? { words, wrappers, skipped, attached }
        : { words, command: index, wrappers, skipped, attached };
    }
    opaqueRunner ||= found === 'unknown' || found === 'string';
    runnerSubcommand = subcommand ?? runnerSubcommand;
    runner = typeof found === 'number' ? runnerName(token) : runner;
    // A package runner's exec form has its grammar under `<runner> <subcommand>` (WP-205, 608).
    grammarKey =
      index === runnerSubcommand && Object.hasOwn(WRAPPER_GRAMMARS, `${runner} ${name}`)
        ? `${runner} ${name}`
        : wrapperGrammarKey(name);
    operand = WRAPPER_OPERAND.has(name) || (grammarOf(grammarKey)?.operands ?? 0) > 0;
    wrapper = name;
    wrappers.push(name);
  }
  return { words, wrappers, skipped, attached };
};

/**
 * Whether a word is **exactly one** expansion — `$x`, `${…}`, `$1`, `$@`, `$(…)`, `` `…` ``, or one
 * of those inside one pair of double quotes — and nothing else (WP-201 ruling (d)). `$((…))` is
 * not: an arithmetic result is `UNCERTAINTY.arithmetic`'s.
 */
const isOneExpansion = (word: string): boolean => {
  const inner =
    word.length > 1 && word.startsWith('"') && doubleQuoteEnd(word, 0) === word.length
      ? word.slice(1, -1)
      : word;
  if (/^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])$/.test(inner)) {
    return true;
  }
  if (inner.startsWith('${')) {
    return closingBraceEnd(inner, 1) === inner.length;
  }
  if (inner.startsWith('$(') && !inner.startsWith('$((')) {
    return findClosingParen(inner, 1, true) === inner.length - 1;
  }
  return inner.startsWith('`') && inner.indexOf('`', 1) === inner.length - 1;
};

/**
 * The words `computesCommandName` reads past to the command name — itself, by its written text,
 * past assignments and redirections too (WP-198). Here so that the expanded-name rule's carve-out
 * (WP-201 (d), `expandsCommandName`) exempts exactly the word that reader reads.
 */
export const COMPUTED_NAME_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'nice',
  'xargs',
  'eval',
  'builtin',
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  '!',
  '{',
]);

/**
 * The word of a top-level stage's argv (redirections out) the git boundary reads as its command
 * name: the first that is neither a plain assignment nor in {@link COMPUTED_NAME_WRAPPERS}, as
 * written — or none, when an assignment before it is not plain (an array, a quote, an expansion):
 * the shell's split and `computesCommandName`'s walk read `x=(a b)` and `x="$(echo "a b")"`
 * differently (review round 1: `x=(a) $GIT push origin main` read `allow`), so no word is exempt.
 */
const computedNameWord = (words: readonly string[]): string | undefined => {
  for (const word of words) {
    if (COMPUTED_NAME_WRAPPERS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=[\w./:@%+,=-]*$/.test(word)) {
      continue;
    }
    return /^[A-Za-z_][A-Za-z0-9_]*(?:\[|\+?=)/.test(word) ? undefined : word;
  }
  return undefined;
};

/**
 * A `-c` script's whole-command positional, **double-quoted**: `"$@"`, `"$0"`, `"$1"` (braces
 * allowed) — the operands from there on, each passed as the one word the operand reader reads. An
 * unquoted one splits and globs (`sh -c '$1' _ '/usr/bin/sud?'` runs `sudo`), and `"$*"` joins the
 * operands into one word, which the reader does not model (review round 2).
 */
const OPERANDS_EXPANSION = /^"\$(?:[@01]|\{[@01]\})"$/;

/**
 * Does this stage — as written, a substitution kept — run a command whose name, or a wrapper's, is
 * not literal (WP-161 (f), WP-201)? Every word `commandNameWords` lists is asked
 * {@link expandsAsName}, with **one** carve-out (ruling (d)): a word that is exactly one expansion
 * where a reader reads it — the word of a top-level stage (`boundaryReads`) the git boundary reads as
 * its name and refuses as computed (`computedNameWord`, `computesCommandName`: `$GIT push …`,
 * `X=1 $CMD`, `env > out $X`), and,
 * a `-c` script that is nothing but a double-quoted `"$@"`, `"$0"` or `"$1"`, whose operands are read as a
 * command (`operands`). Anywhere else nothing reads it — the boundary does not look inside a
 * quoted script, a substitution or past a wrapper's option (`sh -c '$x id'`, `nice -n 5 $x id`
 * read `unattended_auto` before WP-201) — so it is uncertain. WP-161 (f)'s exemption for a glob that
 * can only be a shell (`expandsOnlyToAShell`) is gone: its premise, one word, is false for a brace
 * (`{sh,-c} 'sudo id'` is `sh -c 'sudo id'`) and for a glob with two matches alike (backlog 593).
 * The words are the shell's split (`argvShellWords`); the blank split would cut a substitution
 * apart (`x=$(date +%s)`) and read its half as a name.
 */
const expandsCommandName = (stage: string, boundaryReads: boolean, operands: boolean): boolean => {
  const words = argvShellWords(stage);
  const computed = boundaryReads ? computedNameWord(words) : undefined;
  return commandNameWords(words).some(
    (word) =>
      expandsAsName(word) &&
      !(word === computed && isOneExpansion(word)) &&
      !(operands && words.length === 1 && OPERANDS_EXPANSION.test(word)),
  );
};

// ── WP-203: an unknown command is a possible wrapper (backlog 599) ───────────

/**
 * The string wrappers and the shell the run image ships that are on no other set (WP-203 ruling
 * (e); `command -v` in `platform-runtime:s16`): `script -c CMD` and `sg GROUP CMD` hand a string to
 * a shell, and `newgrp GROUP` starts one on its input (`wrappedScript` reads all three).
 */
const STRING_WRAPPERS: readonly string[] = ['script', 'sg', 'newgrp'];

/**
 * The commands whose handed command the policy reads (`wrappedScript`, `storesCommand`, WP-160),
 * which are therefore not unknown whatever set they are on — and not judged either: their names as
 * an argument are no more a command than `prettier --check .`'s `.` is.
 */
export const COMMAND_READERS: ReadonlySet<string> = new Set([
  'eval',
  'trap',
  'source',
  '.',
  'find',
  'hash',
  'alias',
  'complete',
  'compgen',
  'bind',
  'fc',
]);

/**
 * Words of shell syntax on the wrapper sets — keywords and grouping — which no wrapper can exec and
 * which, in a string a shell runs, stand before a command that is judged itself.
 */
const SHELL_SYNTAX_WORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  'done',
  'fi',
  'for',
  'case',
  'esac',
  '{',
  '}',
  '!',
  '[[',
  ']]',
]);

/**
 * The names that run a command (WP-203 ruling (b)): every wrapper — the string wrappers included —
 * the shells, the package runners and `git`. Exported for the valve's census.
 *
 * Not {@link NODE_ENTRYPOINT} (WP-207): it is a wrapper only when its first argument names a
 * command, and otherwise `node` with its arguments, which the walk then stops at and the scan reads
 * as an unknown program's; and a name ending `.sh` here would be judged in every `*.sh` glob
 * (`shellcheck scripts/*.sh` read uncertain, measured on the 286-line corpus).
 */
export const PROGRAMS_THAT_RUN_A_COMMAND: ReadonlySet<string> = new Set(
  [
    ...ARGV0_WRAPPERS,
    ...ENVIRONMENT_WRAPPERS,
    ...COMPUTED_NAME_WRAPPERS,
    ...PACKAGE_RUNNER_COMMANDS,
    ...Object.keys(RUNNER_EXEC_SUBCOMMANDS),
    ...SCRIPT_SHELLS,
    ...STRING_WRAPPERS,
    'git',
  ].filter((name) => !SHELL_SYNTAX_WORDS.has(name) && name !== NODE_ENTRYPOINT),
);

/**
 * The **judged** names, which an argument of an unknown program may not hold:
 * {@link PROGRAMS_THAT_RUN_A_COMMAND} less the wrappers that are shell builtins only — no wrapper
 * can exec one (Debian ships no `/usr/bin/exec`), and in a string a shell runs, the command after
 * one is judged itself, so `bundle exec rspec` is not refused for its `exec` and `bundle exec sudo
 * id` is for its `sudo`. The block list's first tokens join per policy ({@link unknownProgramReasons}).
 */
const JUDGED_NAMES: ReadonlySet<string> = new Set(
  [...PROGRAMS_THAT_RUN_A_COMMAND].filter(
    (name) => !['exec', 'eval', 'command', 'builtin', 'coproc'].includes(name),
  ),
);

/**
 * **The valve** (WP-203 ruling (d)): programs whose manual documents that no argument of theirs
 * names a program to run, each with the page it rests on. A name here is exempt from the unknown
 * program rule, so adding one **loosens** and is reviewed; a name missing only over-asks. A census
 * (`command-policy.test.ts`) refuses a name on {@link PROGRAMS_THAT_RUN_A_COMMAND} or a default
 * block entry's first token, and `env`, `xargs`, `awk`, `sed`, `tar`, `perl`, `python3`, `node`,
 * `ssh` and `find` outright. Two of the ruling's candidates are **not** here, by their manuals:
 * `man` (`-P`/`--pager` and `-H`/`--html` name a program,
 * https://manpages.debian.org/trixie/man-db/man.1.en.html) and `sort` (`--compress-program=PROG`,
 * https://manpages.debian.org/trixie/coreutils/sort.1.en.html).
 */
const COREUTILS = (name: string): string =>
  `https://manpages.debian.org/trixie/coreutils/${name}.1.en.html`;
const BASH_BUILTINS = 'https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html';
const BOURNE_BUILTINS =
  'https://www.gnu.org/software/bash/manual/html_node/Bourne-Shell-Builtins.html';
export const KNOWN_NON_WRAPPERS: Readonly<Record<string, string>> = {
  echo: BASH_BUILTINS,
  printf: BASH_BUILTINS,
  type: BASH_BUILTINS,
  test: BOURNE_BUILTINS,
  '[': BOURNE_BUILTINS,
  ':': BOURNE_BUILTINS,
  cd: BOURNE_BUILTINS,
  shift: BOURNE_BUILTINS,
  // Not on the ruling's candidates: the over-ask measured on WP-201's rows,
  // `sh -c 'set -- git push origin main; "$@"' _ ls`, whose `"$@"` is judged where it runs.
  set: BOURNE_BUILTINS,
  pushd: 'https://www.gnu.org/software/bash/manual/html_node/Directory-Stack-Builtins.html',
  popd: 'https://www.gnu.org/software/bash/manual/html_node/Directory-Stack-Builtins.html',
  true: COREUTILS('true'),
  false: COREUTILS('false'),
  sleep: COREUTILS('sleep'),
  basename: COREUTILS('basename'),
  dirname: COREUTILS('dirname'),
  realpath: COREUTILS('realpath'),
  readlink: COREUTILS('readlink'),
  stat: COREUTILS('stat'),
  touch: COREUTILS('touch'),
  mkdir: COREUTILS('mkdir'),
  rmdir: COREUTILS('rmdir'),
  cp: COREUTILS('cp'),
  mv: COREUTILS('mv'),
  ln: COREUTILS('ln'),
  chmod: COREUTILS('chmod'),
  chown: COREUTILS('chown'),
  date: COREUTILS('date'),
  tee: COREUTILS('tee'),
  tr: COREUTILS('tr'),
  cut: COREUTILS('cut'),
  uniq: COREUTILS('uniq'),
  comm: COREUTILS('comm'),
  md5sum: COREUTILS('md5sum'),
  sha256sum: COREUTILS('sha256sum'),
  base64: COREUTILS('base64'),
  od: COREUTILS('od'),
  du: COREUTILS('du'),
  df: COREUTILS('df'),
  uname: COREUTILS('uname'),
  id: COREUTILS('id'),
  whoami: COREUTILS('whoami'),
  printenv: COREUTILS('printenv'),
  seq: COREUTILS('seq'),
  yes: COREUTILS('yes'),
  mktemp: COREUTILS('mktemp'),
  diff: 'https://manpages.debian.org/trixie/diffutils/diff.1.en.html',
  cmp: 'https://manpages.debian.org/trixie/diffutils/cmp.1.en.html',
  file: 'https://manpages.debian.org/trixie/file/file.1.en.html',
  xxd: 'https://manpages.debian.org/trixie/xxd/xxd.1.en.html',
  hostname: 'https://manpages.debian.org/trixie/hostname/hostname.1.en.html',
  which: 'https://manpages.debian.org/trixie/debianutils/which.1.en.html',
  // WP-206 ruling (d): the default read-only list's own names, which were known by list until a
  // list made a program known only on a line its entry admits. Each runs no program by its manual.
  cat: COREUTILS('cat'),
  head: COREUTILS('head'),
  ls: COREUTILS('ls'),
  pwd: COREUTILS('pwd'),
  tail: COREUTILS('tail'),
  wc: COREUTILS('wc'),
  grep: 'https://manpages.debian.org/trixie/grep/grep.1.en.html',
};

/** Whether a policy word (an entry's first token, a floor's verb) names this command. */
const namesProgram = (word: string, written: string, name: string): boolean =>
  /[*?[]/.test(word)
    ? cachedGlob(word).test(written) || cachedGlob(argv0Name(word)).test(name)
    : argv0Name(word) === name;

/** The first token of each entry. */
const firstTokens = (entries: readonly string[]): readonly string[] =>
  entries.map((entry) => entry.trim().split(/\s+/)[0] ?? '').filter((token) => token !== '');

/** The names a floor is written for: a `command`-kind entry's verbs, and every pattern's first word. */
export const FLOORED_NAMES: readonly string[] = HAZARDOUS_ARGUMENTS.flatMap((entry) => [
  ...firstTokens([entry.pattern]),
  ...(entry.kind === 'command' ? entry.verbs : []),
]);

/** A sequence with an increment, `{x..y..n}`, as WP-206's expander read it: the increment unread. */
const BRACE_INCREMENT = /\{(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])\.\.-?\d+\}/g;

/**
 * The words a brace expansion yields (`s{u,}do` → `sudo`, `sdo`; `{a..c}`), for the readers that
 * look for a program's name in an argument; `null` when the word is unread. Since WP-248 (backlog
 * 646) this is {@link expandBraces} with its bound, {@link BRACE_EXPANSION_CEILING}, over the word
 * made to over-read where WP-206's own expander did, because a name it found is a name these readers
 * must still find: a quote, a backslash or a `$` is read as a blank — a blank, as each of them, bounds
 * a name ({@link NAME_BOUNDARY}, {@link JOINED_PART}) — so a brace inside quotes is expanded too
 * (`'a"s{f..h}'` holds `sh`), and a sequence's increment is ignored (`{f..h..2}it` holds `git`).
 * Where `expandBraces` declines a form (`{01..03}`, `{a..Z}`, `{a..}`, a `{}` opening one, and
 * `{1..a}`, on which the old expander never returned), the word is unread, which is the stricter
 * reading.
 */
const braceWords = (word: string): readonly string[] | null =>
  expandBraces(
    word.replace(/["'\\$]/g, ' ').replace(BRACE_INCREMENT, '{$1..$2}'),
    BRACE_EXPANSION_CEILING,
  );

/**
 * Where a program name ends inside an argument (WP-206 ruling (b), review round 1, backlog 604): a
 * name is made of `[A-Za-z0-9._-]`, so **any other character** bounds it — an option's `=`, a
 * key's `:`, an editor's `!`, a script's quotes, brackets, `%`, `#` or `@` delimiters (`s%x%git%e`,
 * `qx#git push#`), a backslash (`git\x20push`). `/` is the one exception: a part is read by its
 * **last** `/`-segment ({@link basename}), so a URL's `…/repos/x/git/refs` is `refs` and
 * `s/git/hg/` is `hg`. A name glued by `.`, `_`, `-`, a letter or a digit is no name (`foo.git`,
 * `git_sha`, `git-backup`, `legit`), and that is the residual (`s.git.`).
 */
const NAME_BOUNDARY = /[^A-Za-z0-9._/-]+/;

/** A `${…}` body whose word the shell may substitute (`${v:-w}`, `${v=w}`, `${v:+w}`, `${v?w}`). */
const EXPANSION_WORD = /^(?:[A-Za-z_]\w*|\d+|[@*#?$!-])(?::?[-=+?])([\s\S]*)$/;

/** The index of the `}` closing the `{` at `open`, or the text's end when none does. */
const closingBrace = (text: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    depth += text[index] === '{' ? 1 : text[index] === '}' ? -1 : 0;
    if (depth === 0) {
      return index;
    }
  }
  return text.length;
};

/**
 * `text` with every parameter expansion a blank (WP-206 review round 1): `$x`, `$1`, `${x}` bound
 * a name on both sides (`"$x"git`, `$x'git push'`), and their own name is never read (`node
 * $script`). A `${v<op>w}` default, assignment, alternative or error word is text the shell may
 * substitute, so it stays, bounded (`${y:-git}`). With `quotes`, a `$` inside single quotes is a
 * literal character and stays (`sed '$egit'`); a `$(`, `$'` or a lone `$` stays as a boundary.
 */
const expansionsAsBoundaries = (text: string, quotes: boolean): string => {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quotes && (char === '"' || char === "'") && (quote === null || quote === char)) {
      quote = quote === null ? char : null;
    } else if (char === '\\' && quote !== "'") {
      out += char;
      index += 1;
      out += text[index] ?? '';
      continue;
    } else if (char === '$' && quote !== "'" && text[index + 1] === '{') {
      const close = closingBrace(text, index + 1);
      const word = EXPANSION_WORD.exec(text.slice(index + 2, close))?.[1];
      out += ` ${word === undefined ? '' : expansionsAsBoundaries(word, quotes)} `;
      index = close;
      continue;
    } else if (char === '$' && quote !== "'") {
      const name = /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(text.slice(index + 1))?.[0];
      if (name !== undefined) {
        out += ' ';
        index += name.length;
        continue;
      }
    }
    out += char;
  }
  return out;
};

/**
 * The names one bounded part may run (WP-206, the two spellings with no boundary at all, each
 * measured running in `platform-runtime:s16`): its last path segment; a **short option's attached
 * value** — `-I'git push'` is `-Igit`, and getopt takes any tail of a cluster as the value, so every
 * tail after the first letter is read (`tar -Isudo`, `man -Psudo`); and sed's **`e` command**,
 * which takes its command glued, behind an address, its `I`/`M` modifiers (sed(1): *"/regexp/I"*,
 * *"/regexp/M"*; its `!` and blanks are boundaries) or none (`1egit push`, `/x/Iegit`, `egit`).
 */
const gluedReadings = (part: string): readonly string[] => {
  const tails = /^-[^-]/.test(part)
    ? Array.from({ length: part.length - 2 }, (_, index) => part.slice(index + 2))
    : [];
  return [part, ...tails].flatMap((reading) => {
    const name = basename(reading);
    const command = /^\d*[IM]*e(.+)$/.exec(name)?.[1];
    return command === undefined ? [name] : [name, command];
  });
};

/**
 * The first judged name an argument holds (WP-203 ruling (b), WP-206 ruling (b)): the argument
 * twice — with its quotes off, and **as written** (an expansion's bound is lost once `"$x"git` is
 * `$xgit`) — its parameter expansions blanked ({@link expansionsAsBoundaries}), split as the shell
 * would split it were it a script — on blanks and operators, a substitution's parentheses and
 * backticks included — each piece read twice, as written and with its own quotes off, its braces
 * expanded, split again at {@link NAME_BOUNDARY}, and each part asked whether its **last** path
 * segment runs a command (so `--git`, `--no-git`, `foo.git` equal no name). Past the brace bound,
 * the piece itself. And a third time **joined** ({@link joinedNameIn}).
 */
const judgedNameIn = (
  raw: string,
  judged: (name: string) => boolean,
  names: readonly string[],
): string | undefined => boundedNameIn(raw, judged) ?? joinedNameIn(raw, judged, names);

/**
 * The argument with all quoting and escaping removed (WP-206 review round 2): every `\`, every
 * quote character and every expansion's syntax is deleted, so what a script's own escape, an
 * empty splice or a default word joins is one word (`"g\\it"`, `g$''it`, `${x-g}it` → `git`). A
 * `${v<op>w}` keeps its word; any other expansion is deleted whole, its neighbours joined — it may
 * be empty, so the join is the fail-closed reading.
 */
const joinedText = (text: string): string => {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === '$' && text[index + 1] === '{') {
      const close = closingBrace(text, index + 1);
      out += joinedText(EXPANSION_WORD.exec(text.slice(index + 2, close))?.[1] ?? '');
      index = close;
    } else if (char === '$') {
      // `$x`, `$1`: the name goes with it; `$'`, `$"`, `$(`: the `$` goes, the rest is read on
      // (`$"…"` as `unquoteToken` reads it; a `$"…"` word a catalogue the run supplies may translate).
      index += /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(text.slice(index + 1))?.[0].length ?? 0;
    } else if (char !== '\\' && char !== '"' && char !== "'") {
      out += char;
    }
  }
  return out;
};

/**
 * A shell pattern as a regular expression: `*`, `?` and a closed `[…]` (`!`/`^` negating). A
 * class JavaScript refuses (`[z-a]`) matches everything, so the reading fails closed.
 */
const shellPattern = (pattern: string): RegExp => {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    const close = char === '[' ? pattern.indexOf(']', index + 2) : -1;
    if (char === '*' || char === '?') {
      source += char === '*' ? '[\\s\\S]*' : '[\\s\\S]';
    } else if (close !== -1) {
      const body = pattern.slice(index + 1, close);
      const negated = /^[!^]/.test(body);
      source += `[${negated ? '^' : ''}${body.slice(negated ? 1 : 0).replace(/[\\\]^[]/g, '\\$&')}]`;
      index = close;
    } else {
      source += char.replace(REGEX_SPECIALS, '\\$&');
    }
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return /[\s\S]*/;
  }
};

/**
 * Whether a pattern spells part of a name: a literal character outside its wildcards and
 * multi-character classes (`gi?`, `gi[t]`, `*.ts`); a class admitting exactly one character is that
 * literal (`[g][i][t]`). One of wildcards and wider classes alone (`*`, `dist/*`'s `*`, `[ \t]*`) is
 * a file glob that any name matches, and reading it would refuse `rm -rf dist/*`; that is the residual.
 */
const namePattern = (pattern: string): boolean =>
  /[A-Za-z0-9]/.test(
    pattern.replace(/\[([!^]?)(\]?[^\]]*)\]/g, (_, negated: string, body: string) =>
      negated === '' && body.replace(/\\/g, '').length === 1 ? body.replace(/\\/g, '') : '',
    ),
  );

/**
 * `text` with every command substitution deleted whole — `$(…)` to its balanced `)`, `` `…` `` to
 * its closing backtick, an unclosed one to the end (WP-206 review round 3) — so the neighbours of
 * one that prints nothing join (`g$(:)it`, ``g``it``, `g"$(true)"it` run `git`). What a
 * substitution prints is not read (`$(printf g)it`): that is the composed-name residual.
 */
const substitutionsDeleted = (text: string): string => {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === '$' && text[index + 1] === '(') {
      let depth = 0;
      do {
        depth += text[index] === '(' ? 1 : text[index] === ')' ? -1 : 0;
        index += 1;
      } while (index < text.length && !(depth === 0 && text[index - 1] === ')'));
      index -= 1;
    } else if (char === '`') {
      const close = text.indexOf('`', index + 1);
      index = close === -1 ? text.length : close;
    } else {
      out += char;
    }
  }
  return out;
};

/** A name's characters, a glob's and a closed bracket expression: one part of a joined word. */
const JOINED_PART = /(?:[A-Za-z0-9._/*?-]|\[[!^]?\]?[^\]]*\])+/g;

/**
 * The first judged name the argument **joined** holds ({@link joinedText}), read at the same
 * boundaries as {@link boundedNameIn}; a part holding `*`, `?` or `[…]` is a **pattern**, and
 * counts when it could match a judged name or a literal block token (`/usr/bin/gi?`, `gi[t]`), as
 * a command name that is a glob does (WP-201).
 */
const joinedNameIn = (
  raw: string,
  judged: (name: string) => boolean,
  names: readonly string[],
): string | undefined => {
  const pieces = [raw, substitutionsDeleted(raw)].flatMap((text) =>
    joinedText(text).split(/[\s;&|()<>`]+/),
  );
  for (const piece of pieces) {
    const words = braceWords(piece);
    if (words === null) {
      return piece;
    }
    for (const word of words) {
      for (const part of word.match(JOINED_PART) ?? []) {
        const found = gluedReadings(part).find((reading) =>
          /[*?[]/.test(reading)
            ? namePattern(reading) && names.some((name) => shellPattern(reading).test(name))
            : reading !== '' && judged(reading),
        );
        if (found !== undefined) {
          return found;
        }
      }
    }
  }
  return undefined;
};

/** {@link judgedNameIn}'s first two readings: quotes off and as written, at the boundaries. */
const boundedNameIn = (raw: string, judged: (name: string) => boolean): string | undefined => {
  for (const [text, quotes] of [
    [unquoteToken(raw), false],
    [raw, true],
  ] as const) {
    for (const piece of expansionsAsBoundaries(text, quotes).split(/[\s;&|()<>`]+/)) {
      for (const reading of [unquoteToken(piece), piece]) {
        const words = braceWords(reading);
        if (words === null) {
          return piece;
        }
        for (const word of words) {
          const found = word
            .split(NAME_BOUNDARY)
            .flatMap(gluedReadings)
            .find((name) => name !== '' && judged(name));
          if (found !== undefined) {
            return found;
          }
        }
      }
    }
  }
  return undefined;
};

/**
 * WP-203 (backlog 599): the reason a stage's command is a program the policy does not know whose
 * arguments it cannot clear. **Unknown** is: no `allow` or `ask` entry of the stage's policy admits
 * the line (WP-206 (c); before it, one beginning with the name was enough), it is on no wrapper set, is no shell or package runner, no floor is written for it
 * (`HAZARDOUS_ARGUMENTS`), the policy reads no handed command of it ({@link COMMAND_READERS}), and it
 * is not on the valve ({@link KNOWN_NON_WRAPPERS}). Such a program may run its arguments as a command
 * (`fakeroot sudo id`, `sg grp git push origin main`, `parallel git push ::: origin`), so every
 * argument is a command-position word, and one holding a judged name ({@link judgedNameIn}: a block
 * entry's first token, the stage policy's own included, or {@link JUDGED_NAMES}) is uncertain,
 * naming the program and the name ({@link unknownProgramRunsJudgedName}). A block entry's first
 * token (`rm`, `curl`) is judged and not known, so its arguments are read too.
 *
 * **Ruling (c), the non-literal half, is not built** (the split clause, orchestrator's ruling at
 * WP-203 review round 1): an argument the shell expands (`frobnicate $x id`), `xargs` input into an
 * unknown program and `find -exec <unknown> {}` are the stated residual (WP-207, with its number). The command is found by
 * {@link commandNameWalk}, past the wrappers it knows.
 */
const unknownProgramReasons = (
  stage: string,
  policy: ResolvedCommandPolicy,
  admitPrecise: boolean,
): readonly UncertaintyReason[] => {
  const words = argvShellWords(stage);
  // An append assignment (`HOME+=x git diff`) is environment, which the walk does not peel.
  let start = 0;
  let walk = commandNameWalk(words);
  while (
    walk.command !== undefined &&
    /^[A-Za-z_][A-Za-z0-9_]*\+=/.test(unquoteToken(words[start + walk.command] as string))
  ) {
    start += walk.command + 1;
    walk = commandNameWalk(words.slice(start));
  }
  // `for NAME in WORDS`: the walk reads `for` as a keyword in front of a command, and NAME is none.
  // A shell's or `eval`'s words are a script and its operands, which `wrappedScript` reads (the
  // block list peels a shell like an argv wrapper; `bash -c '"$@"' _ git …` has no command `_`).
  if (
    walk.command === undefined ||
    walk.wrappers.at(-1) === 'for' ||
    walk.wrappers.some((wrapper) => SCRIPT_SHELLS.has(wrapper) || wrapper === 'eval')
  ) {
    return [];
  }
  const command = start + walk.command;
  const name = argv0Name(words[command] as string);
  if (knownProgram(name, words.slice(command).join(' '), policy, admitPrecise)) {
    return [];
  }
  const blockNames = firstTokens(policy.block);
  const judged = (candidate: string): boolean =>
    JUDGED_NAMES.has(candidate) ||
    DYNAMIC_LOADER_NAME.test(candidate) ||
    blockNames.some((token) => namesProgram(token, candidate, candidate));
  const judgedNames = [
    ...JUDGED_NAMES,
    ...blockNames.filter((token) => !/[*?[]/.test(token)).map(argv0Name),
  ];
  const found = words
    .slice(command + 1)
    .map((raw) => judgedNameIn(raw, judged, judgedNames))
    .find((word) => word !== undefined);
  return found === undefined ? [] : [unknownProgramRunsJudgedName(name, found)];
};

/**
 * WP-210 (backlog 605), the orchestrator's coarse, fail-closed rule in place of a full sed/awk
 * grammar: a stage with `sed` or an awk (`awk`, `gawk`, `mawk`, `nawk`; `busybox`'s applets) at
 * any command-position word {@link commandNameWalk} lists — its command, or a word it read as a
 * wrapper option's value — is `UNCERTAINTY.scriptExecutes` when its script — the
 * `-e`/`--expression` (awk: `-e`/`--source`) values joined, or else the first operand — holds an
 * execution primitive, **whatever its input**: a pipe, a here-string or a file operand alike. A
 * script the reader cannot read is uncertain too: a file (`-f`, awk's `--include`/`--load`/`--exec`
 * and `-W`), a word the shell expands, and a sed script {@link sedScriptExecutes} cannot walk. Both
 * languages' exec sets are finite and documented (GNU sed manual § 3.3 and § 3.8:
 * https://www.gnu.org/software/sed/manual/sed.html; gawk manual, *I/O Functions*), which is what
 * makes a coarse reader enough.
 */
const scriptExecutesReasons = (stage: string): readonly UncertaintyReason[] => {
  const words = argvShellWords(stage);
  const walk = commandNameWalk(words);
  // Every command-position word the walk lists, not only the command it stopped at (review round
  // 1): the walk spends the word after a wrapper option it does not know as that option's value
  // (`xargs -n1 sed …`, `stdbuf -oL sed …`), so a word that may be `sed` counts. Fail closed.
  const listed = new Set(walk.words);
  const executes = words.some((word, index) => {
    if (!(listed.has(word) || index === walk.command)) {
      return false;
    }
    const name = argv0Name(word);
    const language = name === 'sed' ? SED_SCRIPT : AWK_NAMES.has(name) ? AWK_SCRIPT : undefined;
    if (language === undefined) {
      return false;
    }
    const script = scriptOperand(words.slice(index + 1), language.options);
    return script !== undefined && (script === null || language.executes(script));
  });
  return executes ? [UNCERTAINTY.scriptExecutes] : [];
};

const AWK_NAMES: ReadonlySet<string> = new Set(['awk', 'gawk', 'mawk', 'nawk']);

/**
 * How an option of a script language treats its value: `attached` takes an optional value only
 * attached to it (sed's `-i[SUFFIX]`), which ends its cluster.
 */
type ScriptOptionKind = 'script' | 'file' | 'value' | 'attached' | 'flag';

interface ScriptLanguage {
  readonly options: {
    readonly short: Readonly<Record<string, ScriptOptionKind>>;
    readonly long: Readonly<Record<string, ScriptOptionKind>>;
  };
  readonly executes: (script: string) => boolean;
}

/** A literal word's value, or `null` for one the shell expands ({@link isLiteralWord}). */
const literalOrNull = (raw: string | undefined): string | null =>
  raw === undefined || !isLiteralWord(raw) ? null : literalValue(raw);

/** The kind a long option takes: the most dangerous among the names it abbreviates. */
const longOptionKind = (
  long: string,
  options: ScriptLanguage['options']['long'],
): ScriptOptionKind => {
  const kinds = Object.entries(options)
    .filter(([candidate]) => candidate.startsWith(long))
    .map(([, kind]) => kind);
  return (['file', 'script', 'value'] as const).find((kind) => kinds.includes(kind)) ?? 'flag';
};

/**
 * The script a sed or awk invocation runs: the script options' values joined by newlines (as GNU
 * sed joins its `-e` fragments), or else the first operand; `null` when it cannot be read (a file,
 * an expanded word), `undefined` when there is none. A long option is matched by every name it
 * abbreviates (getopt accepts a unique prefix); an unknown short option is a flag.
 */
const scriptOperand = (
  args: readonly string[],
  options: ScriptLanguage['options'],
): string | null | undefined => {
  const scripts: (string | null)[] = [];
  let operand: string | null | undefined;
  let optionsEnd = false;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index] as string;
    const word = unquoteToken(raw);
    if (optionsEnd || word === '-' || !word.startsWith('-')) {
      operand = operand === undefined ? literalOrNull(raw) : operand;
      continue;
    }
    if (word === '--') {
      optionsEnd = true;
      continue;
    }
    const literal = literalOrNull(raw);
    const text = literal ?? word;
    // The option's kind and where its attached value starts (none: `text.length`).
    const equals = text.indexOf('=');
    let kind: ScriptOptionKind = 'flag';
    let from = text.length;
    if (text.startsWith('--')) {
      kind = longOptionKind(equals === -1 ? text : text.slice(0, equals), options.long);
      from = equals === -1 ? text.length : equals + 1;
    } else {
      for (let at = 1; at < text.length && kind === 'flag'; at += 1) {
        kind = options.short[text[at] as string] ?? 'flag';
        from = at + 1;
      }
    }
    const attached = from < text.length ? (literal === null ? null : text.slice(from)) : undefined;
    const value = (): string | null => {
      if (attached !== undefined) {
        return attached;
      }
      index += 1;
      return literalOrNull(args[index]);
    };
    if (kind === 'script') {
      scripts.push(value());
    } else if (kind === 'file') {
      value();
      scripts.push(null);
    } else if (kind === 'value') {
      value();
    }
  }
  if (scripts.length > 0) {
    return scripts.includes(null) ? null : scripts.join('\n');
  }
  return operand;
};

/** GNU sed 4.9's options (`sed --help`), busybox's a subset; `-i`/`-s`'s value is attached only. */
const SED_SCRIPT: ScriptLanguage = {
  options: {
    short: { e: 'script', f: 'file', l: 'value', i: 'attached' },
    long: {
      '--expression': 'script',
      '--file': 'file',
      '--line-length': 'value',
    },
  },
  executes: (script) => sedScriptExecutes(script),
};

/**
 * POSIX awk's `-F`/`-v`/`-f`, gawk's long options, `-e`/`-i`/`-l`/`-E` and the optional attached values of `-d`/`-D`/`-L`/`-o`/`-p`, mawk's and gawk's `-W`
 * (read as a file: `mawk -W exec file` runs a program file). An awk script executes when it names
 * `system`, or holds a `|` (not `||`) beside a `print`, `printf` or `getline` — the output pipe,
 * `cmd | getline` and gawk's `|&` — read over-inclusively: a `|` in a string or a regex counts.
 */
const AWK_SCRIPT: ScriptLanguage = {
  options: {
    short: {
      F: 'value',
      v: 'value',
      f: 'file',
      e: 'script',
      i: 'file',
      l: 'file',
      E: 'file',
      W: 'file',
      d: 'attached',
      D: 'attached',
      L: 'attached',
      o: 'attached',
      p: 'attached',
    },
    long: {
      '--field-separator': 'value',
      '--assign': 'value',
      '--file': 'file',
      '--source': 'script',
      '--include': 'file',
      '--load': 'file',
      '--exec': 'file',
    },
  },
  executes: (script) =>
    /\bsystem\b/.test(script) ||
    (script.replaceAll('||', '').includes('|') && /\b(?:print|getline)/.test(script)),
};

/**
 * Whether a sed script can run a command — the `e` command, or an `e` in an `s` command's flags
 * (GNU sed manual § 3.3, § 3.8) — walked command by command, over-inclusively: `s` and `y` take
 * the character after the letter as their delimiter, whatever it is (`s.x.cmd.e`), a backslash
 * escaping inside; every other argument (a label, a file name, `a`/`i`/`c` text) ends at the
 * first `;`, `}` or newline, earlier than sed ends some of them, so more of the script is read as
 * commands than sed reads; and what the walk cannot place (an unterminated `s`, an unknown command
 * letter) counts as executing.
 */
const sedScriptExecutes = (script: string): boolean => {
  let index = 0;
  const delimited = (delimiter: string): boolean => {
    while (index < script.length) {
      const char = script[index] as string;
      index += char === '\\' ? 2 : 1;
      if (char === delimiter) {
        return true;
      }
    }
    return false;
  };
  const toArgumentEnd = () => {
    while (index < script.length && !/[;}\n]/.test(script[index] as string)) {
      index += 1;
    }
  };
  while (index < script.length) {
    const char = script[index] as string;
    index += 1;
    if (/[\s;{}!0-9$,~+]/.test(char)) {
      continue;
    }
    if (char === '/' || char === '\\') {
      const delimiter = char === '/' ? '/' : script[index++];
      if (delimiter === undefined || !delimited(delimiter)) {
        return true;
      }
      while (/[IM]/.test(script[index] ?? '')) {
        index += 1;
      }
      continue;
    }
    if (char === 'e') {
      return true;
    }
    if (char === 's' || char === 'y') {
      const delimiter = script[index++];
      if (
        delimiter === undefined ||
        /[\n\\]/.test(delimiter) ||
        !delimited(delimiter) ||
        !delimited(delimiter)
      ) {
        return true;
      }
      const flags = index;
      toArgumentEnd();
      if (script.slice(flags, index).includes('e')) {
        return true;
      }
      continue;
    }
    if ('abcilqrtvwFLQRTW:#'.includes(char)) {
      toArgumentEnd();
      continue;
    }
    if (!'dDgGhHnNpPxz='.includes(char)) {
      return true;
    }
  }
  return false;
};

/**
 * Whether the policy knows this command ({@link unknownProgramReasons}' definition): **by name** —
 * the valve, a wrapper, shell, package runner or reader of a handed command, a builtin WP-158's
 * reader reads (`stageEvaluatesText`: its words are names and values), or a name a floor is
 * written for, each of which has a reader — or **by match** (WP-206 ruling (c), backlog 604): an
 * `allow` or `ask` entry of the stage's policy that admits `line`, the command and its words, by
 * the decision the verdict makes (a glob entry by its glob, a precise entry by its grammar, and
 * not at all on a line with a substitution). A line no entry admits is unmatched, and its program
 * is read: `sed 's/x/git push/e' x` is no `sed -n '<N>[,<M>]p'`, so `sed` is scanned there.
 */
const knownProgram = (
  name: string,
  line: string,
  policy: ResolvedCommandPolicy,
  admitPrecise: boolean,
): boolean =>
  Object.hasOwn(KNOWN_NON_WRAPPERS, name) ||
  PROGRAMS_THAT_RUN_A_COMMAND.has(name) ||
  COMMAND_READERS.has(name) ||
  DECLARATION_BUILTINS.has(name) ||
  NAME_WRITING_BUILTINS.has(name) ||
  policy.allow.some((entry) => matchesAllowEntry(entry, line, admitPrecise)) ||
  [line, dequoteCommand(line)].some((form) =>
    policy.ask.some((entry) => matchesCommandPattern(entry, form)),
  ) ||
  // A floor's glob (`go*`, `pytest*`) is written to catch its own tool's spellings, never to vouch
  // for every program sharing the prefix: `gosu` is a wrapper the `go*` floor never read.
  FLOORED_NAMES.some((token) => !/[*?[]/.test(token) && argv0Name(token) === name);

/** A script a stage hands over, and the string an enclosing `find -exec`/`xargs -I` replaces in it. */
export interface HandedScript {
  readonly script: string;
  readonly replace: string | null;
  /** A `-c` script whose positional parameters are the operands on the line, read as a command too. */
  readonly operands?: true;
  /**
   * The operands read as a command although the script may not run them so (`sh -c '$2' _ x sudo`
   * reads `_ x sudo` and `x sudo`): an over-read for the block list and the git boundary, whose
   * first word need not be a program at all, so the unknown program rule does not read it (WP-203).
   */
  readonly overRead?: true;
}

/** What a stage hands over as a string: the scripts the platform can read, and whether one it cannot. */
interface HandedScripts {
  readonly scripts: readonly HandedScript[];
  readonly uncertain: boolean;
  /** What else the walk of the stage's command positions could not read (WP-161). */
  readonly reasons: readonly UncertaintyReason[];
}

/** How a stage's standard input is reached, for a shell that reads its script from it. */
interface StageInput {
  /** The stage is fed by a pipe (it is not the first stage, or its level has a pipe). */
  readonly piped: boolean;
  /** …by a pipe whose only producer is `cat` of a here-document, whose body the level reads. */
  readonly fromHereDocument: boolean;
  /** The text an enclosing `find -exec` or `xargs -I` replaces when it runs this (`{}`). */
  readonly replace: string | null;
}

/** xargs' short options that take the next word (or the rest of their word) as a value: GNU and BSD. */
const XARGS_VALUE_SHORT = 'adEILnPsJRS';
/**
 * GNU xargs' long options and whether each takes the next word as its value (`required`) — the
 * `optional` ones take a value only `=`-attached. findutils' `xargs.c` `longopts`, read 2026-10-17
 * (https://github.com/gnu-mirror-unofficial/findutils/blob/master/xargs/xargs.c). `getopt_long`
 * accepts any unambiguous prefix of one (WP-164 review round 1), so {@link xargsLongOption} resolves
 * a word by that rule.
 */
const XARGS_LONG_OPTIONS: Readonly<Record<string, 'none' | 'optional' | 'required'>> = {
  null: 'none',
  'arg-file': 'required',
  delimiter: 'required',
  eof: 'optional',
  replace: 'optional',
  'max-lines': 'optional',
  'max-args': 'required',
  'open-tty': 'none',
  interactive: 'none',
  'no-run-if-empty': 'none',
  'max-chars': 'required',
  verbose: 'none',
  'show-limits': 'none',
  exit: 'none',
  'max-procs': 'required',
  'process-slot-var': 'required',
  version: 'none',
  help: 'none',
};

/**
 * The xargs long option `--word` names by `getopt_long`'s rule — an exact name wins, otherwise the
 * one option it is a prefix of — or `null` for an unknown or ambiguous word (`--max`, `--e`).
 */
const xargsLongOption = (word: string): string | null => {
  if (Object.hasOwn(XARGS_LONG_OPTIONS, word)) {
    return word;
  }
  const matches = Object.keys(XARGS_LONG_OPTIONS).filter((name) => name.startsWith(word));
  return matches.length === 1 ? (matches[0] as string) : null;
};

/** xargs' short options whose value is optional and therefore only ever attached (`-i`, `-e`, `-l`). */
const XARGS_OPTIONAL_SHORT = 'eil';

/** What xargs' own options say: where its command is, and the string it replaces, if any. */
interface XargsOptions {
  /**
   * Index in `args` (the words after `xargs`) of the command xargs runs; -1 when it names none
   * (xargs then runs `echo`); `null` when a long option is unknown or ambiguous, so the platform
   * cannot say which word is the command (WP-164 review round 1).
   */
  readonly command: number | null;
  /** `-I R`, `-iR`, `-i`, `--replace[=R]` (any prefix), `-J R`: the string xargs replaces. */
  readonly replace: string | null;
  /**
   * The replace operand is not literal (`-I"$R"`, `-I $R`, `--replace="$R"`), so `replace` is its
   * unexpanded text and not the string xargs replaces (WP-185, backlog 562). The stage is then
   * uncertain whatever the command — over-asking `xargs -I"$R" grep R`, a spelling with no reason
   * to take its string from a variable.
   */
  readonly opaqueReplace: boolean;
}

/**
 * Reads xargs' options the way `getopt_long` does with the optstring
 * `+0a:E:e::i::I:l::L:n:oprs:txP:d:` (plus BSD's `-J`, `-R`, `-S`): a short cluster ends at the
 * first option that takes a value — the rest of the word, or for a required one with nothing left,
 * the next word — so `-0IR` replaces `R` and `-iI` replaces `I` (WP-164 review round 2, backlog
 * 560); a long option resolves by {@link xargsLongOption}, and `--repl=X` replaces `X`.
 */
const readXargsOptions = (
  args: readonly ShellWord[],
  dequote: (token: string) => string = unquoteToken,
): XargsOptions => {
  let replace: string | null = null;
  let opaqueReplace = false;
  for (let index = 0; index < args.length; index += 1) {
    const raw = (args[index] as ShellWord).raw;
    const value = dequote(raw);
    if (value === '--') {
      return { command: index + 1 < args.length ? index + 1 : -1, replace, opaqueReplace };
    }
    if (!value.startsWith('-') || value === '-') {
      return { command: index, replace, opaqueReplace };
    }
    if (value.startsWith('--')) {
      const [word, ...attached] = value.slice(2).split('=');
      const option = xargsLongOption(word as string);
      if (option === null) {
        return { command: null, replace, opaqueReplace };
      }
      if (option === 'replace') {
        replace = attached.join('=') || '{}';
        opaqueReplace ||= !isLiteralWord(raw);
      }
      index += attached.length === 0 && XARGS_LONG_OPTIONS[option] === 'required' ? 1 : 0;
      continue;
    }
    for (let at = 1; at < value.length; at += 1) {
      const letter = value[at] as string;
      const rest = value.slice(at + 1);
      if (XARGS_VALUE_SHORT.includes(letter)) {
        const operandRaw = rest === '' ? (args[index + 1]?.raw ?? '') : raw;
        const operand = rest === '' ? dequote(operandRaw) : rest;
        if (letter === 'I' || letter === 'J') {
          replace = operand || '{}';
          opaqueReplace ||= !isLiteralWord(operandRaw);
        }
        index += rest === '' ? 1 : 0;
        break;
      }
      if (XARGS_OPTIONAL_SHORT.includes(letter)) {
        if (letter === 'i') {
          replace = rest || '{}';
          opaqueReplace ||= !isLiteralWord(raw);
        }
        break;
      }
    }
  }
  return { command: -1, replace, opaqueReplace };
};

/**
 * The verbs a `command`-kind floor on {@link HAZARDOUS_ARGUMENTS} is written for (WP-164, backlog
 * 530), **derived** from the entries' `verbs` and never listed a second time, so a new floor covers
 * its `xargs` spelling the day it is added. Today: `git`, `rg`, `make`, `gmake`, `go`, `cargo`,
 * `npm`, `pnpm` and `pytest` — `pytest` because its `-o`, `-c`/`--config-file` and `@file` floors
 * are `command` kind (WP-164 (c)), `gmake` because the `make` floors name it (WP-186). Matched
 * against xargs' command's basename **by prefix** (WP-164 review round 1), because that is as far
 * as the floors reach — `go*`, `make*`, `gmake*`, `cargo*`, `npm*`, `pnpm*` as globs,
 * `startsWith('pytest')`, `git-` and `isMakeName` in predicates — so `pytest-3` (Debian's name),
 * `go1.25`, `make-4.4` and `gmake` are in.
 */
export const XARGS_FLOORED_VERBS: ReadonlySet<string> = new Set(
  HAZARDOUS_ARGUMENTS.flatMap((entry) => (entry.kind === 'command' ? entry.verbs : [])),
);

/**
 * Whether an xargs command runs the words xargs appends as a command, or decides from them what to
 * run (WP-161 criterion (13), backlog 523): a wrapper (`env`, `nohup`, `timeout`, `nice`, …) —
 * not a shell, which `wrappedScript` makes uncertain under `xargs` by its own rule (`fedByXargs`,
 * WP-185) — `find` with `-exec`/`-execdir`/`-ok`/
 * `-okdir`, whose command the input completes, or `git`, whose subcommand and refspec it supplies.
 * `echo 'sudo id ;' | xargs find . -maxdepth 0 -exec`, `| xargs env` and `| xargs nohup` ran their
 * payload in the run image (WP-160's review round 2).
 *
 * **And a verb a `command`-kind floor is written for** ({@link XARGS_FLOORED_VERBS}, WP-164,
 * backlog 530): xargs appends its input to the verb's argv, so the argument that floor refuses on
 * the line — `make 'X=$(shell …)'`, `go test -toolexec=…`, `cargo test --config=…`, `pytest -c …`,
 * `rg --pre=…` — arrives where no floor reads it. **The over-ask, stated:** every `xargs` into such
 * a verb is uncertain whatever its input, so `find . -name '*_test.py' | xargs pytest`,
 * `git ls-files '*.go' | xargs go vet` and `git ls-files | xargs rg TODO` stop running under `auto`
 * (attended runs ask, as they did); the line can name its files instead. The prefix match adds
 * every name that begins with a verb — `xargs makeinfo`, `xargs gofmt`, `xargs rgrep`, `xargs gitk`
 * — which fails closed the same way.
 */
const xargsRunsItsInput = (name: string, args: readonly ShellWord[]): boolean =>
  (isArgv0Wrapper(name) && !SCRIPT_SHELLS.has(name)) ||
  // WP-196 (e): every package runner, whatever follows it — the input can be `exec` and a command.
  Object.hasOwn(RUNNER_EXEC_SUBCOMMANDS, name) ||
  [...XARGS_FLOORED_VERBS].some((verb) => name.startsWith(verb)) ||
  name === 'git' ||
  name.startsWith('git-') ||
  (name === 'find' &&
    args.some((word) => /^-(?:exec|execdir|ok|okdir)$/.test(unquoteToken(word.raw))));

/**
 * Whether a package runner is given a string to run in a shell (WP-188 review round 1 for `npx`;
 * WP-196 (c), backlog 575, for every runner): npm's `-c`/`--call` and pnpm's `-c`/`--shell-mode`.
 * One reader for every runner, so a runner whose options mean something else (`yarn dlx -c`) is
 * read the same way. Read **closed**, failing toward uncertain: every option word up to the first
 * word that is neither an option nor possibly an option's value (a word after an option with no
 * `=`) is checked, so `npx --yes jest -c x` and `npm exec --yes jest -c x` are over-asks. A long
 * option that is a prefix of `--call` or `--shell-mode` (nopt's abbreviations) matches, separate,
 * attached or with `=`; a short word matches when `c` is among its letters (`-c`, `-c'…'`, `-yc`).
 * `args` are the runner's words after its name, its exec subcommand taken out (`npm -c x exec`).
 */
const runnerCallsString = (args: readonly ShellWord[]): boolean => {
  let valueMayFollow = false;
  for (const word of args) {
    const value = unquoteToken(word.raw);
    if (value === '--') {
      return false;
    }
    if (value.startsWith('--')) {
      const name = value.slice(2).split('=')[0] as string;
      if (name.length > 0 && ('call'.startsWith(name) || 'shell-mode'.startsWith(name))) {
        return true;
      }
      valueMayFollow = !value.includes('=');
    } else if (value.startsWith('-') && value.length > 1) {
      if (/^-[A-Za-z]*c/.test(value)) {
        return true;
      }
      valueMayFollow = !value.includes('=');
    } else if (valueMayFollow) {
      valueMayFollow = false;
    } else {
      return false;
    }
  }
  return false;
};

/** A word `/bin/sh` hands on as itself: no quote, expansion, glob, operator, space or comment. */
const SHELL_PLAIN_WORD = /^[A-Za-z0-9_./@%+=:,-]+$/;

/**
 * Whether Yarn 1's `create` hands a shell a string it would read as more than words (WP-211 (c),
 * backlog 581, read from source). Yarn 1.22.22 passes every word after the starter kit's name
 * through unparsed (`src/cli/index.js`, `PROXY_COMMANDS` `create: 1`) and runs
 * `child.spawn(command, rest, {stdio: 'inherit', shell: true, env})`
 * (`src/cli/commands/create.js:74`), and Node joins a `shell: true` command and its arguments with
 * spaces into one `/bin/sh -c` string — so `-c` is not special: **every** word is shell text.
 * `yarn create vite '; sudo id'` runs `sudo id`. Read closed, every word after `create` (the kit's
 * name included) must be literal and plain ({@link SHELL_PLAIN_WORD}); anything else is
 * `UNCERTAINTY.runnerString`. The first word of the string is Yarn's own path to `create-<name>`,
 * so a plain word is only ever its argument. `create` is found as `runnerSubcommandAt` finds an exec
 * form: past options and possibly their values, and past `workspace <name>`. Berry's `create` hands
 * `dlx` an argument array (`plugin-dlx/sources/commands/create.ts`, `this.cli.run(['dlx', …])`).
 */
const yarnCreateHandsString = (name: string, args: readonly ShellWord[]): boolean => {
  if (name !== 'yarn' && name !== 'yarnpkg') {
    return false;
  }
  let valueMayFollow = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = unquoteToken((args[index] as ShellWord).raw);
    if (value === 'create') {
      return !args
        .slice(index + 1)
        .every((word) => isLiteralWord(word.raw) && SHELL_PLAIN_WORD.test(literalValue(word.raw)));
    }
    if (value === '--') {
      continue;
    }
    if (isFlagToken(value)) {
      valueMayFollow = !value.includes('=');
    } else if (value === 'workspace') {
      index += 1;
      valueMayFollow = false;
    } else if (valueMayFollow) {
      valueMayFollow = false;
    } else {
      return false;
    }
  }
  return false;
};

/**
 * The words a package runner reads its own options from (WP-196 (c)): every word after a runner
 * that needs no subcommand (`npx`, `pnpx`, `bunx`), and those after `npm`/`pnpm`/`yarn`/`bun` in
 * an exec form with the subcommand taken out. None for any other command or subcommand.
 */
const runnerOptions = (name: string, args: readonly ShellWord[]): readonly ShellWord[] => {
  if (name !== 'corepack' && PACKAGE_RUNNER_COMMANDS.includes(runnerName(name))) {
    return args;
  }
  if (runnerName(name) === 'pnpm') {
    // The orchestrator's round-3 probe: every option word of a pnpm line, whatever the subcommand
    // reading concludes, so a misread first positional cannot hide `exec -c …` after it. **The
    // over-ask, stated:** `pnpm jest -c jest.config.js` is uncertain.
    return args.filter((word) => isFlagToken(unquoteToken(word.raw)));
  }
  const at = runnerSubcommandAt([name, ...args.map((word) => word.raw)], 0);
  if (at === null && runnerName(name) === 'npm') {
    // Review round 3: `npm init`/`npm create` hand `-c`/`--call` to libnpmexec (npm 11
    // `lib/commands/init.js` → `libnpmexec/lib/run-script.js`, `call || args.shift()`), so npm's
    // option words under **any** subcommand, and with none, are read — up to the `--` npm stops
    // parsing at. **The over-ask, stated:** `npm test -c x` is uncertain.
    const end = args.findIndex((word) => unquoteToken(word.raw) === '--');
    return args
      .slice(0, end === -1 ? args.length : end)
      .filter((word) => isFlagToken(unquoteToken(word.raw)));
  }
  if (typeof at !== 'number') {
    return [];
  }
  // The runner's options before its subcommand (`npm -c x exec`), and every word after it — except
  // for pnpm's implicit exec (`pnpm jest -c x`), whose later words are the command's own.
  const before = args.slice(0, at - 1).filter((word) => isFlagToken(unquoteToken(word.raw)));
  const implicit = !(RUNNER_EXEC_SUBCOMMANDS[runnerName(name)] as ReadonlySet<string>).has(
    unquoteToken((args[at - 1] as ShellWord).raw),
  );
  return runnerName(name) === 'pnpm' && implicit ? before : [...before, ...args.slice(at)];
};

/**
 * The scripts a stage hands over as **strings**, read off its words as written (WP-160, backlog
 * 511) — `parseCommand` parses each as a script (rule 1), through its nested path and
 * `MAX_WRAPPER_DEPTH`. A string is read when it is literal (`isLiteralWord`) and makes the stage
 * `UNCERTAINTY.handedCommand` when it is not, since the platform cannot read what it will be.
 *
 *  - `eval` — its words, joined.
 *  - `trap` — its action, the first operand after `--`; `-`, `''`, `-l`, `-p` and `-P` run nothing.
 *    bash runs it on `EXIT`, `ERR`, `DEBUG`, `RETURN` or a signal (measured), so it is read now.
 *  - a shell (`SCRIPT_SHELLS`, or `busybox` and one) — the first operand after an option cluster
 *    holding `c` (`-c`, `-lc`, `-ec`, `-cl`, `-c -e …`), past `-o`/`-O` and `--rcfile`'s values.
 *    Without `-c`, and with no operand, `-s` or a standard-input path, it reads its script from
 *    standard input: a literal here-string is the script; a non-literal one, a process substitution
 *    (`< <(…)`, an operand `<(…)`), a descriptor (`<&3`) or a pipe is uncertain. A here-document is
 *    WP-153's (`HERE_DOCUMENT_SCRIPT_READERS`), and so is `cat <<'EOF' | sh`. `bash file` and
 *    `bash < file` run a file the run wrote — backlog 481's residual, the module docblock's.
 *    **Under `xargs` a shell is `UNCERTAINTY.xargsArguments` whatever its own words** (WP-185,
 *    backlog 561): xargs appends its input to the shell's argv, so the input can be the `-c` and
 *    its script (`xargs sh < f`, `xargs sh -e`), or the positional parameters a literal script
 *    reads — by a name (`"$@"`, `${!#}`) or by none (`for a; do`, `getopts`, `select`). Any list
 *    of those readers is open, so none is kept: the literal script is still handed (a block-list
 *    hit in it is recorded), and the pipe is xargs' input rather than the shell's script. The
 *    over-ask, stated: `xargs sh -c 'echo hi'` and `xargs -n1 bash -c 'date'`, a shell whose
 *    script ignores what xargs feeds it, are refused under `auto` too; the line can drop `xargs`.
 *  - `script` — its `-c`/`--command` string (a cluster, `-cX` attached, `--c…` abbreviated, which
 *    util-linux accepts); without one it runs `$SHELL` on its standard input, read as a shell's.
 *  - `source`/`.` of a standard-input path, read as a shell's; of `<(…)`, uncertain.
 *  - `find` — the words from `-exec`/`-execdir`/`-ok`/`-okdir` to `;` (or `+` after `{}`), as a
 *    command (WP-160 (d)): read, not refused, so the block list, the git boundary and the hazard
 *    floor judge it. `{}` is a literal word, and a string in it that holds `{}` is not literal,
 *    since `find` puts a file name there (`replace`) — as `xargs -I` does with its own string.
 *    A shell with that string among its words is uncertain too (WP-185 (d)): `find . -exec busybox
 *    sh -c 'for a; do $a; done' _ {} +` runs file names as commands, and a file name is text the
 *    run can choose; it read `unattended_auto` (measured), the `sh` spelling only by accident of
 *    the command walk.
 */
const wrappedScript = (stage: string, input: StageInput): HandedScripts => {
  const words = shellWords(stage);
  const argv = words.filter((word) => word.redirect === undefined);
  const stdin = words.filter(
    (word) =>
      word.redirect !== undefined &&
      (word.redirect.fd === '' || word.redirect.fd === '0') &&
      word.redirect.operator.startsWith('<') &&
      word.redirect.operator !== '<>',
  );
  const scripts: HandedScript[] = [];
  let uncertain = false;
  let replace = input.replace;
  let fedByXargs = false;
  let piped = input.piped;
  const hand = (raw: string | readonly ShellWord[]): void => {
    const pieces = typeof raw === 'string' ? [raw] : raw.map((word) => word.raw);
    if (!pieces.every(isLiteralWord)) {
      uncertain = true;
      return;
    }
    const script = pieces.map(literalValue).join(' ');
    if (replace !== null && script.includes(replace)) {
      uncertain = true;
    }
    scripts.push({ script, replace: null });
  };
  /** A value attached to its option at `from` in the word as written; a quoted option is not read. */
  const handAttached = (raw: string, from: number): void => {
    if (raw.startsWith('-')) {
      hand(raw.slice(from));
    } else {
      uncertain = true;
    }
  };
  /** A reader of its standard input as a script. */
  const readsStandardInput = (): void => {
    if (stdin.length === 0) {
      // Under `xargs` the pipe is xargs' input, which `xargsArguments` answers (WP-185).
      uncertain ||= piped && !input.fromHereDocument && !fedByXargs;
    }
    for (const word of stdin) {
      const operator = word.redirect?.operator as string;
      if (operator === '<<<') {
        hand(word.raw);
      } else if (
        word.raw === '' ||
        (operator === '<&' ? word.raw !== '-' : word.raw.startsWith('<('))
      ) {
        // A descriptor (`<&3`), a process substitution, or a target the walk lost.
        uncertain = true;
      }
    }
  };
  const readShell = (args: readonly ShellWord[]): void => {
    let index = 0;
    let command = false;
    let stdinFlag = false;
    for (; index < args.length; index += 1) {
      const value = unquoteToken((args[index] as ShellWord).raw);
      if (value === '--' || value === '-') {
        index += 1;
        break;
      }
      if (value === '--command') {
        command = true;
      } else if (value.startsWith('--command=')) {
        uncertain = true;
        return;
      } else if (value === '--rcfile' || value === '--init-file') {
        index += 1;
      } else if (/^[-+][A-Za-z]+$/.test(value)) {
        command ||= value.startsWith('-') && value.includes('c');
        stdinFlag ||= value.includes('s');
        index += /[oO]/.test(value) ? 1 : 0;
      } else if (!value.startsWith('--')) {
        break;
      }
    }
    const operand = args[index];
    if (command) {
      // `-c` with no operand on the line, or a script reading positionals xargs supplies, is
      // `xargsArguments` by the blanket rule at the call (WP-185); with no `xargs` it runs nothing.
      if (operand !== undefined) {
        const handed = scripts.length;
        hand(operand.raw);
        // `sh -c '"$@"' _ cmd …` runs its operands: a script that names a positional parameter
        // has the operands on the line read as a command too ($0 on, and $1 on).
        const rest = args.slice(index + 1);
        const namesPositional =
          isLiteralWord(operand.raw) && /\$(?:[@*0-9]|\{!?[@*0-9])/.test(literalValue(operand.raw));
        if (rest.length > 0 && namesPositional) {
          // WP-201 (d): a script that is nothing but a double-quoted `"$@"` (or `"$0"`, `"$1"`) runs
          // exactly the operands read here; anything before it may `shift` or `set --` them (round
          // 1), and an unquoted one splits and globs them (round 2).
          const script = scripts[handed];
          if (script !== undefined && OPERANDS_EXPANSION.test(script.script.trim())) {
            scripts[handed] = { ...script, operands: true };
          }
          // WP-203: only `"$@"` runs the operands from `$1` on, as the reading has them.
          const runsArgv = script !== undefined && /^"\$(?:@|\{@\})"$/.test(script.script.trim());
          scripts.push({
            script: rest.map((word) => word.raw).join(' '),
            replace: null,
            overRead: true,
          });
          if (rest.length > 1) {
            scripts.push({
              script: rest
                .slice(1)
                .map((word) => word.raw)
                .join(' '),
              replace: null,
              ...(runsArgv ? {} : { overRead: true as const }),
            });
          }
        }
      }
      return;
    }
    if (operand !== undefined && !stdinFlag) {
      if (/^[<>]\(/.test(operand.raw)) {
        uncertain = true;
      } else if (STANDARD_INPUT_PATHS.has(unquoteToken(operand.raw))) {
        readsStandardInput();
      }
      return;
    }
    readsStandardInput();
  };
  /**
   * A program's command-string option — `-c CMD`, `-qc CMD` (a cluster), `-cCMD`, `--command CMD`,
   * `--command=CMD` or a long name abbreviated, which getopt accepts — handed over; `valued` are
   * the short options that take a value of their own (so the rest of their cluster is not read).
   * Whether one was found.
   */
  const readOptionString = (
    args: readonly ShellWord[],
    letter: string,
    longNames: readonly string[],
    valued: string,
    joinOperands = false,
  ): boolean => {
    /**
     * WP-203: `script -qc sudo id` runs `sudo` and names `id` its typescript file, but the line is
     * how `sudo id` is written, so the string is read joined to the operands after it as well — an
     * over-read, kept to literal operands, that can only tighten.
     */
    const handValue = (at: number): void => {
      hand((args[at] as ShellWord).raw);
      const operands = args.slice(at + 1).filter((word) => !isFlagToken(unquoteToken(word.raw)));
      if (
        joinOperands &&
        operands.length > 0 &&
        operands.every((word) => isLiteralWord(word.raw))
      ) {
        hand([args[at] as ShellWord, ...operands]);
      }
    };
    for (let index = 0; index < args.length; index += 1) {
      const raw = (args[index] as ShellWord).raw;
      const value = unquoteToken(raw);
      const next = args[index + 1]?.raw;
      if (value === '--') {
        return false;
      }
      const long = /^--([a-z-]+)(=?)/.exec(value);
      if (long !== null) {
        if (longNames.some((name) => name.startsWith(long[1] as string))) {
          if (long[2] === '=') {
            handAttached(raw, raw.indexOf('=') + 1);
          } else if (next !== undefined) {
            handValue(index + 1);
          } else {
            uncertain = true; // the string comes from somewhere else (`xargs`), review round 1
          }
          return true;
        }
        continue;
      }
      if (!/^-[A-Za-z0-9]/.test(value)) {
        continue;
      }
      for (let at = 1; at < value.length; at += 1) {
        const option = value[at] as string;
        if (option === letter) {
          if (raw.length > raw.indexOf(letter, 1) + 1 || !raw.startsWith('-')) {
            handAttached(raw, raw.indexOf(letter, 1) + 1);
          } else if (next !== undefined) {
            handValue(index + 1);
          } else {
            uncertain = true;
          }
          return true;
        }
        if (valued.includes(option)) {
          index += at === value.length - 1 ? 1 : 0;
          break;
        }
      }
    }
    return false;
  };
  /**
   * WP-203 (backlog 599): `sg [-|-l] GROUP [-c] CMD` hands one word to `/bin/sh -c`, dropping the
   * words after it (shadow's `src/newgrp.c`, https://github.com/shadow-maint/shadow; manual
   * https://manpages.debian.org/trixie/login/sg.1.en.html). That word is read as the script, and so
   * are all of them joined — `sg grp sudo id` is how `sudo id` is written, and the image's `sg` was
   * not measured on extra words — an over-read that can only tighten. With no command, and
   * `newgrp [-|-l] [GROUP]` always, it starts a shell on its standard input. A group that is not
   * literal may split into the group and a command, so it is uncertain.
   */
  const readGroupShell = (sg: boolean, args: readonly ShellWord[]): void => {
    let index = /^-l?$/.test(unquoteToken(args[0]?.raw ?? '')) ? 1 : 0;
    const group = args[index];
    if (group !== undefined && !isLiteralWord(group.raw)) {
      uncertain = true;
      return;
    }
    index += 1;
    if (sg && args[index] !== undefined && unquoteToken((args[index] as ShellWord).raw) === '-c') {
      index += 1;
    }
    const command = sg ? args.slice(index) : [];
    if (command.length === 0) {
      readsStandardInput();
      return;
    }
    hand((command[0] as ShellWord).raw);
    if (command.length > 1) {
      hand(command);
    }
  };
  /** `watch`: its operands are joined into the string `sh -c` runs. */
  const readWatch = (args: readonly ShellWord[]): void => {
    let index = 0;
    for (; index < args.length; index += 1) {
      const value = unquoteToken((args[index] as ShellWord).raw);
      if (value === '--') {
        index += 1;
        break;
      }
      if (!value.startsWith('-')) {
        break;
      }
      index += /^(?:-[A-Za-z]*n|--interval)$/.test(value) ? 1 : 0;
    }
    if (index < args.length) {
      hand(args.slice(index));
    }
  };
  const readFind = (args: readonly ShellWord[]): void => {
    for (let index = 0; index < args.length; index += 1) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(unquoteToken((args[index] as ShellWord).raw))) {
        continue;
      }
      const command: ShellWord[] = [];
      for (index += 1; index < args.length; index += 1) {
        const value = unquoteToken((args[index] as ShellWord).raw);
        if (value === ';' || (value === '+' && command.at(-1)?.raw === '{}')) {
          break;
        }
        command.push(args[index] as ShellWord);
      }
      if (command.length > 0) {
        scripts.push({ script: command.map((word) => word.raw).join(' '), replace: '{}' });
      }
    }
  };

  /**
   * `su [options] [-] [USER [ARG…]]` and `runuser` (util-linux; https://manpages.debian.org/trixie/
   * util-linux/su.1.en.html, …/runuser.1.en.html), backlog 602 and WP-203 review rounds 2 and 3,
   * read by getopt's own model and **closed**: a short cluster letter by letter, a valued letter
   * taking the rest of its word or the next word; a long option by its unique prefix, its value
   * `=`-attached or the next word; a bare `-` is `-l`; getopt permutes, so options may follow USER;
   * `--` ends them. A `-c`/`--command`/`--session-command` value is the script. With none, the
   * target user's shell runs: on the words after USER, read as a shell's (`readShell`), or with
   * none on its standard input (`echo 'git push origin main' | su - agentic`). `runuser -u USER CMD`
   * runs CMD itself, which the walk reads; with no CMD it is read as the shell, an over-read. An
   * option the model does not know, a value that never comes, or a word that is not literal (it
   * may be an option or the user) is uncertain: the platform cannot tell which word is USER or
   * whose `-c` it is.
   */
  const readLoginShell = (runuser: boolean, args: readonly ShellWord[]): void => {
    const flags = 'flmpPThV';
    const valued = runuser ? 'cgGswu' : 'cgGsw';
    const longOptions: Readonly<Record<string, boolean>> = {
      command: true,
      'session-command': true,
      fast: false,
      group: true,
      'supp-group': true,
      login: false,
      'preserve-environment': false,
      pty: false,
      'no-pty': false,
      shell: true,
      'whitelist-environment': true,
      help: false,
      version: false,
      ...(runuser ? { user: true } : {}),
    };
    const operands: ShellWord[] = [];
    let command: string | null = null;
    let user = false;
    let unread = false;
    for (let index = 0; index < args.length && !unread; index += 1) {
      const raw = (args[index] as ShellWord).raw;
      if (!isLiteralWord(raw)) {
        unread = true;
        break;
      }
      const value = literalValue(raw);
      const next = args[index + 1]?.raw;
      if (value === '--') {
        operands.push(...args.slice(index + 1));
        break;
      }
      if (value === '-' || !value.startsWith('-')) {
        if (value !== '-') {
          operands.push(args[index] as ShellWord);
        }
        continue;
      }
      if (value.startsWith('--')) {
        const [written, ...rest] = value.slice(2).split('=');
        const matches = Object.keys(longOptions).filter((name) =>
          name.startsWith(written as string),
        );
        const name = matches.includes(written as string) ? written : matches[0];
        if (name === undefined || (matches.length > 1 && name !== written)) {
          unread = true;
          break;
        }
        if (!(longOptions[name as string] as boolean)) {
          unread ||= rest.length > 0;
          continue;
        }
        const taken =
          rest.length > 0 ? rest.join('=') : next === undefined ? null : literalValue(next);
        if (taken === null || (rest.length === 0 && next !== undefined && !isLiteralWord(next))) {
          unread = true;
          break;
        }
        index += rest.length > 0 ? 0 : 1;
        user ||= name === 'user';
        command = name === 'command' || name === 'session-command' ? taken : command;
        continue;
      }
      for (let at = 1; at < value.length; at += 1) {
        const letter = value[at] as string;
        if (flags.includes(letter)) {
          continue;
        }
        if (!valued.includes(letter)) {
          unread = true;
          break;
        }
        let taken: string | null = value.slice(at + 1);
        if (taken === '') {
          taken = next === undefined || !isLiteralWord(next) ? null : literalValue(next);
          index += 1;
        }
        if (taken === null) {
          unread = true;
        }
        user ||= letter === 'u';
        command = letter === 'c' ? taken : command;
        break;
      }
    }
    if (unread) {
      uncertain = true;
      return;
    }
    if (command !== null) {
      // Words after USER become the `-c` script's positional parameters, which it may run.
      uncertain ||=
        (replace !== null && command.includes(replace)) || operands.length > (user ? 0 : 1);
      scripts.push({ script: command, replace: null });
      return;
    }
    if (user && operands.length > 0) {
      return;
    }
    // The words after USER are the shell's argv; with none it reads its standard input.
    readShell(user ? operands : operands.slice(1));
  };

  // Backlog 602: a wrapper given no command runs a shell on its standard input (`echo … | linux64`,
  // `chroot / <<<'…'`).
  const bare = commandNameWalk(argv.map((word) => word.raw));
  if (bare.command === undefined && SHELL_WITHOUT_COMMAND.has(bare.wrappers.at(-1) ?? '')) {
    readsStandardInput();
  }

  const reasons = new Set<UncertaintyReason>();
  const positions = commandPositions(argv);
  if (positions.tooDeep) {
    reasons.add(UNCERTAINTY.tooDeep);
  }
  for (const position of positions.starts) {
    for (const word of argv.slice(0, position)) {
      // `coproc bash` reads a pipe the line writes into later.
      piped ||= argv0Name(word.raw) === 'coproc';
      if (argv0Name(word.raw) === 'xargs') {
        fedByXargs = true;
        replace = readXargsOptions(argv.slice(argv.indexOf(word) + 1, position)).replace ?? replace;
      }
    }
    const command = argv[position] as ShellWord;
    if (replace !== null && command.raw.includes(replace)) {
      uncertain = true;
    }
    let name = argv0Name(command.raw);
    let args = argv.slice(position + 1);
    if (name === 'busybox' && args[0] !== undefined) {
      name = argv0Name(args[0].raw);
      args = args.slice(1);
    }
    if (name === 'eval') {
      if (args.length > 0) {
        hand(args);
      }
    } else if (name === 'trap') {
      const action =
        args[0] !== undefined && unquoteToken(args[0].raw) === '--' ? args[1] : args[0];
      if (
        action !== undefined &&
        !(isLiteralWord(action.raw) && /^(?:-|-[lpP]+|)$/.test(literalValue(action.raw)))
      ) {
        hand(action.raw);
      }
    } else if (SCRIPT_SHELLS.has(name) || /[*?[{]/.test(name)) {
      // A name the shell expands (`/bin/s? -c '…'`) may be a shell: read as one (an over-read).
      // Under `xargs` a shell is uncertain whatever its words: the blanket rule (WP-185, backlog
      // 561). An expanded name is not: the walk also reaches an operand such as `{}` here.
      if (fedByXargs && SCRIPT_SHELLS.has(name)) {
        reasons.add(UNCERTAINTY.xargsArguments);
      }
      // `find -exec sh -c 'for a; do $a; done' _ {} +`: the file names are the shell's operands, and
      // a file name is text the run chose (WP-185 (d), measured `unattended_auto` behind `busybox`).
      if (SCRIPT_SHELLS.has(name) && replace !== null) {
        const replaced = replace;
        uncertain ||= args.some((word) => word.raw.includes(replaced));
      }
      readShell(args);
    } else if (name === 'script') {
      if (!readOptionString(args, 'c', ['command'], 'EIOBTm', true)) {
        readsStandardInput();
      }
    } else if (name === 'sg' || name === 'newgrp') {
      readGroupShell(name === 'sg', args);
    } else if (name === 'su' || name === 'runuser') {
      // Not where the walk found a command before it (`nice grep su file` greps for `su`); the walk
      // may read it as a wrapper's value or operand (`taskset -c 0 su agentic`), which still counts.
      if (bare.command === undefined || bare.command >= position) {
        readLoginShell(name === 'runuser', args);
      } else {
        readOptionString(args, 'c', ['command', 'session-command'], 'sgGw');
      }
    } else if (name === 'flock') {
      readOptionString(args, 'c', ['command'], 'wE');
    } else if (name === 'env') {
      readOptionString(args, 'S', ['split-string'], 'uCP');
    } else if (name === 'watch') {
      readWatch(args);
    } else if (name === 'source' || name === '.') {
      const operand =
        args[0] !== undefined && unquoteToken(args[0].raw) === '--' ? args[1] : args[0];
      if (operand !== undefined && /^[<>]\(/.test(operand.raw)) {
        uncertain = true;
      } else if (operand !== undefined && STANDARD_INPUT_PATHS.has(unquoteToken(operand.raw))) {
        readsStandardInput();
      }
    } else if (name === 'find') {
      readFind(args);
    } else if (name === 'xargs') {
      const { command: at, replace: replaced, opaqueReplace } = readXargsOptions(args);
      const run = at === null ? undefined : args[at];
      // A word of xargs' command holding its replace string is where xargs writes its input, the
      // command word included (`xargs -I{} {}`): uncertain by its own rule, not because the walk
      // past the wrapper `xargs` happens to reach such a word as a command (WP-193, backlog 566).
      if (
        at !== null &&
        at >= 0 &&
        replaced !== null &&
        args
          .slice(at)
          .some((word) => word.raw.includes(replaced) || unquoteToken(word.raw).includes(replaced))
      ) {
        uncertain = true;
      }
      if (
        opaqueReplace ||
        at === null ||
        (run !== undefined && xargsRunsItsInput(argv0Name(run.raw), args.slice(at + 1)))
      ) {
        reasons.add(UNCERTAINTY.xargsArguments);
      }
    } else if (yarnCreateHandsString(name, args)) {
      reasons.add(UNCERTAINTY.runnerString);
    } else if (runnerSubcommandAt([name, ...args.map((word) => word.raw)], 0) === 'unknown') {
      reasons.add(UNCERTAINTY.runnerSubcommand);
    } else if (runnerSubcommandAt([name, ...args.map((word) => word.raw)], 0) === 'string') {
      reasons.add(UNCERTAINTY.runnerString);
    } else if (runnerCallsString(runnerOptions(name, args))) {
      reasons.add(UNCERTAINTY.npxCall);
    } else if (name === 'hash' && optionWords(args).some((option) => /^-[A-Za-z]*p/.test(option))) {
      // `hash -p FILE NAME` makes `NAME` run `FILE` (WP-161 criterion (12), backlog 522).
      reasons.add(UNCERTAINTY.reboundName);
    }
  }
  return { scripts, uncertain, reasons: [...reasons] };
};

/**
 * One environment spelling of a `command`-kind floor, as the scan reads it: the name without its
 * `*`, whether it is a prefix, whether the verb reads it in any case, and the floor it spells.
 */
export interface FloorEnvironmentRow {
  readonly name: string;
  readonly prefix: boolean;
  readonly anyCase: boolean;
  readonly entry: HazardousArgument;
}

/** Every entry's declared environment, in entry order (WP-199): the scan's only source of names. */
export const floorEnvironmentRows = (
  entries: readonly HazardousArgument[],
): readonly FloorEnvironmentRow[] =>
  entries.flatMap((entry) =>
    (entry.environment ?? []).map((declared) => {
      const spelled = typeof declared === 'string' ? declared : declared.name;
      const name = spelled.replace(/\*$/, '');
      return {
        name,
        prefix: name !== spelled,
        anyCase: typeof declared !== 'string',
        entry,
      };
    }),
  );

/**
 * The environment names the scan reads, derived from {@link HAZARDOUS_ARGUMENTS} and, since WP-211
 * review round 1, {@link ENVIRONMENT_ONLY_FLOORS} alone (WP-199, backlog 583) — nothing is spelled
 * here, and the census in `command-policy.test.ts` holds this
 * table equal to the derivation and refuses a name declared twice.
 */
export const FLOOR_ENVIRONMENT: readonly FloorEnvironmentRow[] = floorEnvironmentRows([
  ...HAZARDOUS_ARGUMENTS,
  ...ENVIRONMENT_ONLY_FLOORS,
]);

/** Where a name is read in a word: its start (or after `printf`'s attached `-v`), or after an `=`. */
const ENVIRONMENT_WORD_POSITION = '(?:^(?:-v)?|=)';

/**
 * The environment-word rule as a pattern (WP-199; shared with the git boundary's guarded names
 * since WP-200 review round 1): `name` at a word's start (a prefix assignment, `NAME+=`, an
 * `export`/`declare`/`local`/`readonly`/`typeset` operand, a `read`/`for`/`select`/`getopts`/
 * `mapfile` name), after `printf`'s attached `-v`, or after an `=` — an exact name ending there, or
 * a prefix. Group 1 is the name as the word spells it.
 */
export const environmentNamePattern = (
  name: string,
  { prefix, anyCase }: { readonly prefix: boolean; readonly anyCase: boolean },
): RegExp =>
  new RegExp(
    `${ENVIRONMENT_WORD_POSITION}(${name.replace(REGEX_SPECIALS, '\\$&')}${prefix ? '[A-Za-z0-9_]*' : '(?![A-Za-z0-9_])'})`,
    anyCase ? 'i' : '',
  );

const floorEnvironmentPattern = (row: FloorEnvironmentRow): RegExp =>
  environmentNamePattern(row.name, row);

const FLOOR_ENVIRONMENT_PATTERNS = FLOOR_ENVIRONMENT.map((row) => ({
  verb: row.entry.verbs?.[0] ?? (row.entry.pattern.split(' ')[0] as string),
  pattern: floorEnvironmentPattern(row),
}));

/** A case-insensitive superset of every row, so a word naming none costs one test. */
const FLOOR_ENVIRONMENT_ANY = new RegExp(
  `${ENVIRONMENT_WORD_POSITION}(?:${FLOOR_ENVIRONMENT.map((row) => row.name.replace(REGEX_SPECIALS, '\\$&')).join('|')})`,
  'i',
);

/**
 * The verbs whose floors a stage's words spell in the environment (WP-196 (d), backlog 575;
 * WP-199, backlog 583): a word whose unquoted text begins with a name some `command`-kind floor
 * declares ({@link FLOOR_ENVIRONMENT}) — an exact name ending there, or a prefix — in the case the
 * verb reads it (npm's `npm_config_*` in any case): as a prefix assignment, an `env`/`export`/
 * `declare` operand, a bare assignment, a `read`/`for` name, or anything else; or after
 * `printf`'s attached `-v`, or after an `=` (`declare -n r=NODE_OPTIONS` makes `r` that
 * variable). Whatever the command, because which line hands the variable to its verb is not
 * something a parse of the line can know (a bare `export` may reach a later call: whether the
 * pinned CLI's Bash tool carries it is unmeasured, so the closed side is kept). **The over-ask,
 * stated:** `npm_config_loglevel=silent npm ci`, `EDITOR=vim git status`, `MAKEFLAGS=-j4 make
 * test`, `GOFLAGS=-mod=vendor go test ./...`, `PYTEST_ADDOPTS=-q pytest`, `CARGO_TERM_COLOR=always
 * cargo test` and a read that merely names one (`grep -rn EDITOR docs`, `grep npm_config_ .npmrc`)
 * are uncertain, and so is a path a prefix covers (`ls CARGO_TOML`, `git diff -- RUSTFLAGS.md`).
 * **Residual:** a tool with no floor (`EDITOR=x some-tool` is uncertain only because
 * npm declares `EDITOR`; `SHELL` for `npm explore`, `PAGER` for `man` and git, `CC` for a
 * Makefile are not declared), a variable a Makefile or a package script references (`CC='sh -c id'
 * make`), an `.npmrc`, `.cargo/config.toml` or `setup.cfg` the run writes — by a redirection
 * (`echo 'call=x' > .npmrc`) or by the runner's own CLI (`npm config set call x && npx`, each
 * `unattended_auto`, measured at WP-196 review round 1) — and a name assembled at runtime
 * (`"npm_$x"`). Those are repository content or a program the sandbox bounds (BD-025's WP-54
 * amendment).
 */
const floorEnvironmentVerbs = (stage: string): readonly string[] => {
  const verbs: string[] = [];
  for (const word of shellWords(stage)) {
    const text = unquoteToken(word.raw);
    if (!FLOOR_ENVIRONMENT_ANY.test(text)) {
      continue;
    }
    for (const { verb, pattern } of FLOOR_ENVIRONMENT_PATTERNS) {
      if (pattern.test(text)) {
        verbs.push(verb);
      }
    }
  }
  return verbs;
};

/** Variables bash runs the text of later — as a prompt, a hook, a startup file (WP-160 (b)). */
const STORED_COMMAND_VARIABLES: ReadonlySet<string> = new Set([
  'PS0',
  'PS1',
  'PS2',
  'PS4',
  'PROMPT_COMMAND',
  'BASH_ENV',
  'ENV',
]);

/** `NAME=`, `NAME+=`, `NAME[…]=` for one of {@link STORED_COMMAND_VARIABLES}. */
const STORED_COMMAND_ASSIGNMENT = /^(PS[0124]|PROMPT_COMMAND|BASH_ENV|ENV)(?:\[[^\]]*\])?\+?=/;

/** Builtins that write a variable they are given by name. */
const NAME_WRITING_BUILTINS: ReadonlySet<string> = new Set([
  'read',
  'mapfile',
  'readarray',
  'printf',
  'getopts',
]);

/**
 * Whether a stage stores a command for the shell to run **later**, where the line the policy reads
 * is not the line that runs (WP-160 (b), backlog 511): an assignment to a prompt or hook variable
 * (`PS4='$(…)'` under `set -x` ran in bash 5.2 and 3.2; `PROMPT_COMMAND`, `PS0`–`PS2`,
 * `BASH_ENV`, `ENV`) — as a prefix, on its own, through a declaration builtin or `env`, through
 * `${NAME:=…}`, or written by `read`/`printf -v`/`mapfile` — an `alias` with a definition (bash ran
 * one after `shopt -s expand_aliases`), `mapfile`/`readarray -C` (ran in 5.2), `bind -x`,
 * `complete`/`compgen -C` (`compgen -C` ran in 5.2 and 3.2) and `-W`, whose word list bash expands
 * (`compgen -W '$(cmd)' x` ran in 5.2, review round 1), and `fc -e`/`-s`. Several run only
 * in an interactive shell; whether the CLI's Bash tool ever is one is not measured, and these have
 * no use in an unattended run, so they fail closed (rule 5).
 */
const storesCommand = (stage: string): boolean => {
  if (/\$\{(?:PS[0124]|PROMPT_COMMAND|BASH_ENV|ENV):?=/.test(stage)) {
    return true;
  }
  const argv = shellWords(stage).filter((word) => word.redirect === undefined);
  const positions = commandPositions(argv).starts;
  const assigns = (word: ShellWord): boolean =>
    STORED_COMMAND_ASSIGNMENT.test(unquoteToken(word.raw));
  if (argv.slice(0, positions[0] ?? argv.length).some(assigns)) {
    return true;
  }
  return positions.some((position) => {
    const command = argv[position] as ShellWord;
    const name = argv0Name(command.raw);
    const args = argv.slice(position + 1);
    const values = args.map((word) => unquoteToken(word.raw));
    const options = optionWords(args);
    if (assigns(command) || (DECLARATION_BUILTINS.has(name) && args.some(assigns))) {
      return true;
    }
    switch (name) {
      case 'alias':
        return values.some((value) => !value.startsWith('-') && value.includes('='));
      case 'mapfile':
      case 'readarray':
        if (options.some((option) => option.includes('C'))) {
          return true;
        }
        break;
      // `-W` expands its word list, command substitutions included: `compgen -W '$(cmd)' x` ran
      // `cmd` in a non-interactive bash 5.2 (review round 1). Both run strings, in any cluster.
      case 'complete':
      case 'compgen':
        if (options.some((option) => /[CW]/.test(option))) {
          return true;
        }
        break;
      case 'bind':
        return options.some((option) => option.includes('x'));
      case 'fc':
        return options.some((option) => /[es]/.test(option));
      default:
        break;
    }
    return (
      NAME_WRITING_BUILTINS.has(name) &&
      values.some(
        (value) =>
          STORED_COMMAND_VARIABLES.has(value) ||
          STORED_COMMAND_VARIABLES.has(value.replace(/^-[A-Za-z]*v/, '')),
      )
    );
  });
};

/**
 * A pipeline stage rewritten as plain `sh` when the stage *is* a shell reading the pipe.
 *
 * product/19 §3 states the hazard once, as `curl * | sh`. The shell on the receiving end is the
 * hazard, not the four letters: `| bash`, `| /bin/sh -s` and `| zsh` are the same command. This is
 * the argv[0] basename normalisation of rule 2, applied to a pipeline stage instead of to a line,
 * so the document's single spelling covers every spelling of the same thing.
 */
/**
 * Whether a stage is an `exec` that moves standard input for the rest of its level (`exec <in`,
 * `exec 2>&1 <<<'…'`): its first argv word past any assignment is `exec`, and one of its
 * redirections reads (`ShellWord.redirect`, an operator starting `<`).
 */
const movesStandardInput = (stage: string): boolean => {
  const head = argvWords(stage).find((word) => !isAssignment(word));
  return (
    head !== undefined &&
    argv0Name(head) === 'exec' &&
    shellWords(stage).some((word) => word.redirect?.operator.startsWith('<') === true)
  );
};

const canonicalShellStage = (stage: string): string =>
  // Either reading's first word (WP-198): `| 2>/dev/null bash` is a shell reading the pipe.
  argvForms(stage).some((words) => words[0] !== undefined && SCRIPT_SHELLS.has(argv0Name(words[0])))
    ? 'sh'
    : stage;

interface Parsed {
  readonly fragments: readonly string[];
  readonly writeTargets: readonly string[];
  readonly uncertainty: readonly UncertaintyReason[];
  /** Whether the line, at any depth, carries a command or process substitution. */
  readonly substitutes: boolean;
  /**
   * Every here-document body read as data, as `[start, end)` in **this** text — its own level's and
   * those of its command substitutions, shifted to where each sits. A wrapped script's are not here:
   * its text is rebuilt from tokens, and a body under a shell is a script anyway.
   */
  readonly bodyRanges: readonly (readonly [number, number])[];
  /** Whether any level read its here-documents as scripts (`HERE_DOCUMENT_SCRIPT_READERS`). */
  readonly readsScripts: boolean;
  /**
   * Every pipeline stage of every level as written — a substitution kept, continuations joined —
   * for the readers that ask whether a judged word is literal (WP-201).
   */
  readonly rawStages: readonly string[];
  /** {@link rawStages} less those of an operand over-read (`HandedScript.overRead`, WP-203). */
  readonly programStages: readonly string[];
}

/**
 * Parses a command line into everything the shell would run, plus what the scanner could not
 * follow. Recurses through substitution bodies and wrapped scripts, so nesting is walked to the
 * bottom rather than to a fixed depth.
 *
 * `scripted` is true when an enclosing level runs a script reader, so a here-document body here
 * may be what it runs (`sh -c "$(cat <<'EOF' …)"`). `overRead` is true for a level that reads a
 * shell's operands as a command only in case (`HandedScript.overRead`).
 */
const parseCommand = (
  command: string,
  depth = 0,
  scripted = false,
  replace: string | null = null,
  fed = false,
  operands = false,
  overRead = false,
): Parsed => {
  const fragments: string[] = [];
  const rawStages: string[] = [];
  const programStages: string[] = [];
  // Whether the git boundary's computed-name walk reads this level's stages as the scanner splits
  // them: only at the top, and not when an array assignment is on the line — the scanner splits
  // `x=(a) $GIT push` at the `(`, the boundary does not (review round 1).
  const boundaryReads = depth === 0 && !/[\w\]]\+?=\(/.test(command);
  const uncertainty = new Set<UncertaintyReason>();
  const outer = scan(command, LIST_OPERATORS);
  for (const reason of outer.uncertainty) {
    uncertainty.add(reason);
  }
  const writeTargets = [...outer.writeTargets];
  let substitutes = outer.substitutions.length > 0;
  const readsScripts = scripted || outer.segments.some(feedsScriptReader);
  let anyReadsScripts = readsScripts;
  const bodyRanges: (readonly [number, number])[] = [];
  // A body under a script reader is the script it runs, so it is parsed as commands: rule 1, the
  // same as `sh -c '…'`. Its range stays out of `bodyRanges` — it is not data.
  for (const hereDocument of outer.hereDocuments) {
    if (readsScripts && depth < MAX_WRAPPER_DEPTH) {
      const nested = parseCommand(
        hereDocument.body,
        depth + 1,
        true,
        replace,
        fed,
        false,
        overRead,
      );
      fragments.push(...nested.fragments);
      rawStages.push(...nested.rawStages);
      programStages.push(...nested.programStages);
      writeTargets.push(...nested.writeTargets);
      substitutes ||= nested.substitutes;
      for (const reason of nested.uncertainty) {
        uncertainty.add(reason);
      }
    } else if (readsScripts) {
      // A script reader's body nested past the bound: not read, so not certain (WP-161 (d)).
      uncertainty.add(UNCERTAINTY.tooDeep);
    }
  }
  if (!readsScripts) {
    bodyRanges.push(...outer.bodyRanges);
  }

  const test: TestState = { inside: false };
  // Whether a stage's standard input may be a pipe: the level has one somewhere (a `( … )` or a
  // `{ …; }` group cuts the pipe from the stage that reads it, so the stage index alone is not it).
  // `fed`: this level's standard input is itself a pipe — a `>(…)` body, `coproc`'s command, or a
  // script handed over by a stage that a pipe feeds (`echo … | bash -c 'bash'`) — and `exec <…`
  // moves it for the rest of the level.
  // The `exec` stage is also read off the parser's words (WP-198 (d)): the pattern stops at the
  // `&` of `2>&1`, so `exec 2>&1 <<<'…'; bash` read `unattended_auto`.
  const piped =
    fed ||
    scan(command, PIPE_OPERATORS).segments.length > 1 ||
    /(?:^|[\s;&|(){}])exec\b[^\n;&|]*</.test(joinContinuations(command)) ||
    outer.segments.some((segment) =>
      scan(segment, PIPE_OPERATORS).segments.some(movesStandardInput),
    );
  for (const [segmentIndex, segment] of outer.segments.entries()) {
    fragments.push(segment);
    const pipeline = scan(segment, PIPE_OPERATORS);
    for (const stage of pipeline.segments) {
      if (stageEvaluatesText(stage, test)) {
        uncertainty.add(UNCERTAINTY.evaluatedText);
      }
      // WP-161 (d): the peel the block list reads stopped at its bound.
      if (argvReadings(stage).some(({ tokens, dequote }) => argvStarts(tokens, dequote).tooDeep)) {
        uncertainty.add(UNCERTAINTY.tooDeep);
      }
    }
    // WP-243: the argv reading of a text whose braces the port cannot expand is its words as
    // written, which may not be the program's. A stage's words are its segment's: one check.
    if (braceExpandedWords(segment) === null) {
      uncertainty.add(UNCERTAINTY.braceExpansion);
    }
    // Every stage is a command in its own right, pushed whether or not there are two of them: a
    // segment that begins or ends with a pipe operator — `|& docker run alpine`, which the list
    // pass now hands over whole — has exactly one stage and it is *not* the segment. Requiring
    // two stages lost it, and with it the `docker *` match. Found by fuzzing this file against
    // its own previous revision.
    fragments.push(...pipeline.segments);
    if (pipeline.segments.length > 1) {
      // The pipeline again with exactly one space around each `|`, and again with every shell
      // stage spelled `sh`. Without the first, `curl http://x|sh` is not the pattern
      // `curl * | sh`; without the second, `| bash` and `| /bin/sh` are not either. Both are
      // spellings of the same pipeline, so both are offered to the matcher rather than the
      // pattern being loosened.
      fragments.push(pipeline.segments.join(' | '));
      fragments.push(pipeline.segments.map(canonicalShellStage).join(' | '));
    }
    // WP-160: what a stage hands over as a string, read off its words as written.
    // Line continuations joined as bash joins them, as `wordsOf` reads (review round 1: `find . \⏎
    // -exec sudo id \;` and `| \⏎bash` were `unattended_auto`).
    const stages = scan(outer.rawSegments[segmentIndex] as string, PIPE_OPERATORS).rawSegments.map(
      joinContinuations,
    );
    for (const [stageIndex, stage] of stages.entries()) {
      rawStages.push(stage);
      if (!overRead) {
        programStages.push(stage);
      }
      // WP-161 (f), WP-201: the command's name — or a wrapper's — is not literal. Read as written,
      // because the scanner's own stage has a substitution lifted out (`su$(echo do) id` is `su id`).
      if (expandsCommandName(stage, boundaryReads, operands)) {
        uncertainty.add(UNCERTAINTY.expandedName);
      }
      if (storesCommand(stage)) {
        uncertainty.add(UNCERTAINTY.handedCommand);
      }
      for (const verb of floorEnvironmentVerbs(stage)) {
        uncertainty.add(environmentSpellsFloor(verb));
      }
      const stagePiped = piped || stageIndex > 0;
      const handed = wrappedScript(stage, {
        piped: stagePiped,
        fromHereDocument:
          stageIndex === 1 &&
          stages.length === 2 &&
          /^cat(?:[ \t]+<<-?[ \t]*\S+)+$/.test(stages[0] as string),
        replace,
      });
      if (handed.uncertain) {
        uncertainty.add(UNCERTAINTY.handedCommand);
      }
      for (const reason of handed.reasons) {
        uncertainty.add(reason);
      }
      for (const { script, replace: inner, operands: read, overRead: over } of handed.scripts) {
        if (depth >= MAX_WRAPPER_DEPTH) {
          // Nested past the bound: not read, so not certain (rule 5).
          uncertainty.add(UNCERTAINTY.handedCommand);
          continue;
        }
        const nested = parseCommand(
          script,
          depth + 1,
          readsScripts,
          inner ?? replace,
          stagePiped,
          read === true,
          overRead || over === true,
        );
        anyReadsScripts ||= nested.readsScripts;
        fragments.push(script, ...nested.fragments);
        rawStages.push(...nested.rawStages);
        programStages.push(...nested.programStages);
        writeTargets.push(...nested.writeTargets);
        substitutes ||= nested.substitutes;
        for (const reason of nested.uncertainty) {
          uncertainty.add(reason);
        }
      }
      // WP-243 review round 2: a stage whose braces expand is read a second time as the words
      // bash makes, so every reader of this module — the written-word ones included (`find .
      // {-ok,sudo} id +`, `compgen {-C,id} x`, the ask list) — judges them; a union, so it only
      // tightens. The words keep their quotes (`{-e,"1e id"}` is `-e "1e id"`), so the text
      // re-parses as those words.
      const expanded = readsExpandedStages ? expandedStage(stage) : undefined;
      if (expanded !== undefined && depth >= MAX_WRAPPER_DEPTH) {
        uncertainty.add(UNCERTAINTY.tooDeep);
      } else if (expanded !== undefined) {
        const nested = parseCommand(
          expanded,
          depth + 1,
          readsScripts,
          replace,
          stagePiped,
          operands,
          overRead,
        );
        anyReadsScripts ||= nested.readsScripts;
        fragments.push(...nested.fragments);
        rawStages.push(...nested.rawStages);
        programStages.push(...nested.programStages);
        writeTargets.push(...nested.writeTargets);
        substitutes ||= nested.substitutes;
        for (const reason of nested.uncertainty) {
          uncertainty.add(reason);
        }
      }
    }
    // Backlog 645: a segment that held a process substitution is read a second time with its word
    // left out, as it was read before the word was kept. Only an over-ask beside bash's reading
    // (`git <(true) push origin +x` stays `block`); a union, so it only tightens.
    const dropped = outer.droppedSegments[segmentIndex] as string;
    if (dropped !== segment && depth >= MAX_WRAPPER_DEPTH) {
      uncertainty.add(UNCERTAINTY.tooDeep);
    } else if (dropped !== segment) {
      const nested = parseCommand(
        dropped,
        depth + 1,
        readsScripts,
        replace,
        piped,
        operands,
        overRead,
      );
      anyReadsScripts ||= nested.readsScripts;
      fragments.push(...nested.fragments);
      rawStages.push(...nested.rawStages);
      programStages.push(...nested.programStages);
      writeTargets.push(...nested.writeTargets);
      substitutes ||= nested.substitutes;
      for (const reason of nested.uncertainty) {
        uncertainty.add(reason);
      }
    }
  }

  // WP-160 (e): after a here-document the walk did not recognise, bash resumes at its own
  // terminator from a fresh quote state, and so does this. The text is strictly shorter, and each
  // level spawns one such read, so the chain ends; its bodies are not this level's data.
  if (outer.resumeFrom !== null) {
    const resumed = parseCommand(
      command.slice(outer.resumeFrom),
      depth,
      scripted,
      replace,
      fed,
      operands,
      overRead,
    );
    anyReadsScripts ||= resumed.readsScripts;
    fragments.push(...resumed.fragments);
    rawStages.push(...resumed.rawStages);
    programStages.push(...resumed.programStages);
    writeTargets.push(...resumed.writeTargets);
    substitutes ||= resumed.substitutes;
    for (const reason of resumed.uncertainty) {
      uncertainty.add(reason);
    }
  }

  for (const [position, substitution] of outer.substitutions.entries()) {
    if (depth < MAX_WRAPPER_DEPTH) {
      // A `>(…)` body reads what the command writes into it: its standard input is a pipe.
      const offset = outer.substitutionOffsets[position] as number;
      const nested = parseCommand(
        substitution,
        depth + 1,
        readsScripts,
        replace,
        fed || command[offset - 2] === '>',
        false,
        overRead,
      );
      anyReadsScripts ||= nested.readsScripts;
      // The substitution as a fragment of its own is its text with its data bodies left out, so
      // a body line never reaches the block list as part of `cat <<'EOF' … EOF` (ruling (b)).
      fragments.push(withoutRanges(substitution, nested.bodyRanges), ...nested.fragments);
      rawStages.push(...nested.rawStages);
      programStages.push(...nested.programStages);
      writeTargets.push(...nested.writeTargets);
      bodyRanges.push(
        ...nested.bodyRanges.map(([start, end]) => [start + offset, end + offset] as const),
      );
      for (const reason of nested.uncertainty) {
        uncertainty.add(reason);
      }
    } else {
      // Nested past the bound: kept as a fragment, but its own substitutions, lists and wrappers
      // are not read, so the line is not certain (WP-161 (d), backlog 516 — ten `$(` hid `sudo id`).
      fragments.push(substitution);
      uncertainty.add(UNCERTAINTY.tooDeep);
    }
  }

  return {
    fragments: [...new Set(fragments)],
    writeTargets,
    uncertainty: [...uncertainty],
    substitutes,
    bodyRanges: [...bodyRanges].sort(([a], [b]) => a - b),
    readsScripts: anyReadsScripts,
    rawStages,
    programStages,
  };
};

/** `text` with `ranges` (sorted, non-overlapping) cut out. */
const withoutRanges = (text: string, ranges: readonly (readonly [number, number])[]): string =>
  outsideRanges(text, 0, text.length, ranges);

/**
 * Every fragment of a command line that the shell would run as a command in its own right.
 *
 * This is a conservative approximation of a shell parser, not a shell parser: its job is to stop
 * an allow-listed prefix from smuggling a second command past the policy. What it cannot follow it
 * reports (see `commandUncertainty`), and an uncertain line can never be `allow`.
 */
export const splitCommandSegments = (command: string): readonly string[] =>
  parseCommand(command).fragments;

/** Whether `parseCommand` reads a stage again as its brace-expanded words (WP-243 review round 2). */
let readsExpandedStages = true;

/**
 * {@link splitCommandSegments} without the brace-expanded copies of a stage: the parts the line is
 * **made of**. The git boundary asks this, beside {@link commandStageCount}, whether a fragment is
 * composite; with the copies, every
 * stage whose braces expand looked composite and its own words went unjudged (`git fetch
 * {origin,x}` read `allow`, measured in review round 2's sweep).
 */
export const splitCommandSegmentsAsWritten = (command: string): readonly string[] => {
  readsExpandedStages = false;
  try {
    return parseCommand(command).fragments;
  } finally {
    readsExpandedStages = true;
  }
};

/**
 * How many stages `command` is made of **at its own level** (WP-252, backlog 656): its list's
 * commands (`;`, `&&`, `||`, `&`, a newline, a `( … )` body) and each one's pipe stages, counted
 * by the scanner's own passes. What a stage hands out — a `-c` body, a substitution — is not a
 * stage of this level, so `env git --namespace "*" -c core.fsmonitor=x status` is one stage while
 * `git push origin x 2>&1 | tail -5` is two.
 */
export const commandStageCount = (command: string): number =>
  scan(command, LIST_OPERATORS).segments.reduce(
    (count, segment) => count + scan(segment, PIPE_OPERATORS).segments.length,
    0,
  );

/**
 * The command line with every here-document body that is **data** cut out (WP-153 (b)): the lines
 * that open them and the lines after their terminators stay, so this is the line as the shell reads
 * it for commands. What reads a whole line — the whole-line candidate here, the git boundary's
 * assignment check, the unattended hazard check — reads this instead of the raw text.
 */
export const withoutHereDocumentBodies = (command: string): string =>
  withoutRanges(command, parseCommand(command).bodyRanges);

/**
 * Whether this line hands any of its here-documents to a script reader (a shell, `eval`, `source`,
 * `.`), so their bodies are commands rather than data. `computesCommandName` reads them then.
 */
export const readsHereDocumentsAsScripts = (command: string): boolean =>
  parseCommand(command).readsScripts;

/** Does the command redirect output to a path (`> file`), rather than to a descriptor or `/dev/null`? */
export const hasOutputRedirection = (command: string): boolean =>
  parseCommand(command).writeTargets.length > 0;

/** The constructs in this command that the scanner will not reason about (rule 5). */
export const commandUncertainty = (command: string): readonly UncertaintyReason[] =>
  parseCommand(command).uncertainty;

/**
 * The redirection targets in this command that write a path (rule 4's floor), as written — for the
 * unattended git boundary, which refuses a write into `.git` or the control mount.
 */
export const commandWriteTargets = (command: string): readonly string[] =>
  parseCommand(command).writeTargets;

/**
 * One fragment's words as the program receives them: split as `tokenise` splits, each word's
 * quoting and escaping taken off (`unquoteToken`), followed by the argv words, dequoted once (WP-198,
 * `argvForms`) — so a word the blank split cuts inside its quotes is there whole as well. The
 * unattended git boundary reads these, for an assignment anywhere among them.
 */
export const commandWords = (fragment: string): readonly string[] => {
  const [written = [], received = []] = argvForms(fragment);
  return [...written.map(unquoteToken), ...received];
};

/**
 * WP-201 site (iii): the first word of a `git` argv on this line — at any depth, as written, a
 * substitution kept (`Parsed.rawStages`), wrappers peeled — that says what git does and is not
 * literal: its verb (`git pu$x origin main`, `git "$verb" …`, `git $(echo push) …`) or a global
 * option before it (`git -$x push`). The git boundary decides by that word, so for a word nobody
 * can read it answers uncertain rather than its own verdict (`gitBoundaryViolation`).
 *
 * WP-250 (backlog 650): a global option's **separate** value (`-C`, `-c`, `--namespace`, every
 * `separate` entry of {@link GIT_GLOBAL_OPTIONS}) that carries an expansion outside double quotes
 * ({@link expandsUnquoted}: `$(…)`, a backtick body, `$name`, `${…}`) is answered as `splits`: bash
 * hands it as zero, one or many words (`$(true)`, `$(pwd)`, `$(echo "a -c …")`, measured), so which
 * word git reads as the value, and what follows it, is the shell's to decide —
 * `git -C $(pwd) -c core.fsmonitor=<script> status` ran the monitor while every other reading took
 * `-c` for `-C`'s value. A value whose every expansion is double-quoted (`-C "$(pwd)"`, `"$X"`) is
 * one word and is read as before; one written attached (`--namespace=$X`) is the option word, above.
 * The over-ask, stated: `git -C $(pwd) status` and `git -C $dir log` read uncertain too.
 *
 * WP-218: so is a literal word before the verb that starts with `-` and git's declared grammar
 * ({@link GIT_GLOBAL_OPTIONS}) does not name — `git --shallow-file=x push …`, `git --super-prefix p/
 * push …` — answered as `undeclared`. The verb and the options come from
 * {@link readGitGlobalOptions}, the boundary's own reader.
 */
export const unreadableGitWord = (
  command: string,
): { readonly word: string; readonly reason: 'expands' | 'splits' | 'undeclared' } | null => {
  for (const stage of parseCommand(command).rawStages) {
    const words = argvShellWords(stage);
    for (const start of argvStarts(words).starts) {
      const [name, ...rest] = words.slice(start);
      if (name === undefined || expandsAsName(name) || argv0Name(name) !== 'git') {
        continue;
      }
      const dequoted = rest.map(unquoteToken);
      const reading = readGitGlobalOptions(dequoted);
      const stop = reading.undeclared ?? reading.verb;
      const read = [...reading.options.map(({ index }) => index), ...(stop === null ? [] : [stop])];
      const expands = read.map((index) => rest[index] as string).find(expandsAsName);
      if (expands !== undefined) {
        return { word: expands, reason: 'expands' };
      }
      // A separate value is the word after an option written whole (an `equals` one is not).
      const splits = reading.options
        .filter(({ option, value, index }) => value !== null && dequoted[index] === option)
        .map(({ index }) => rest[index + 1] as string)
        .find(expandsUnquoted);
      if (splits !== undefined) {
        return { word: splits, reason: 'splits' };
      }
      if (reading.undeclared !== null) {
        return { word: rest[reading.undeclared] as string, reason: 'undeclared' };
      }
    }
  }
  return null;
};

/**
 * The argv lists one fragment could really run as — the **block** list's generous reading (rule 2):
 * every leading wrapper and assignment peeled in turn, argv[0] reduced to its basename, every word
 * dequoted once, in both of `argvForms`' readings (WP-198; the argv reading is dequoted already,
 * WP-242). The unattended git boundary judges each, so
 * `env git push …`, `nice -n 5 git push …`, `GIT_TRACE=1 git push …` and `2>/dev/null git push …`
 * are all a `git push`.
 */
export const commandArgvCandidates = (fragment: string): readonly (readonly string[])[] =>
  blockCandidates(fragment)
    .filter((candidate) => candidate.length > 0)
    .map((candidate) =>
      RECEIVED_READING.has(candidate)
        ? candidate
        : [candidate[0] as string, ...candidate.slice(1).map(unquoteToken)],
    );

/**
 * {@link commandArgvCandidates} with each redirection left out **as written** (WP-245 review round
 * 2): the argv reading has none and is unchanged, and the written one drops a word that is an
 * unquoted redirection, with a detached one's target (`> out`), before its quotes come off — never
 * a quoted `">sub"` or `"{fd}>sub"`, which the program is handed. The git boundary reads these
 * beside its own filter over the dequoted words (backlog 488), which dropped `"{fd}>sub"` and
 * `"2>sub"` too: `git -C "{fd}>sub" -c core.fsmonitor=x status` lost `-C`'s value and ran. The
 * written one is read twice, as bash 4.1+ reads a named descriptor (`{fd}>out` is a redirection)
 * and as bash 3.2 does (`{fd}` is an argument, `>out` the redirection). A process substitution
 * is an argument, never a redirection (`WRITTEN_REDIRECTION`, backlog 645).
 */
export const commandArgvsAsWritten = (fragment: string): readonly (readonly string[])[] =>
  blockCandidates(fragment)
    .filter((candidate) => candidate.length > 0)
    .flatMap((candidate) => {
      if (RECEIVED_READING.has(candidate)) {
        return [candidate];
      }
      const [name, ...words] = candidate as [string, ...string[]];
      const bash32 = words.flatMap((word) => {
        const descriptor = NAMED_DESCRIPTOR.exec(word)?.[0];
        return descriptor === undefined ? [word] : [descriptor, word.slice(descriptor.length)];
      });
      return [words, bash32].map((reading) => [
        name,
        ...withoutWrittenRedirections(reading).map(unquoteToken),
      ]);
    });

/**
 * A named descriptor written in front of a redirection operator: the `{fd}` of `{fd}>out`. Not in
 * front of a process substitution: `{fd}<(…)` is one argument in bash 3.2 and 5.3 (backlog 645).
 */
const NAMED_DESCRIPTOR = /^\{[A-Za-z_]\w*\}(?=[<>&](?!\())/;

/**
 * A word written as a redirection — an unquoted operator, after an optional descriptor: `2>&1`,
 * `>out`, `>>log`, `&>/dev/null`, `<in`, and bash 4.1+'s `{fd}>out`. Never a process substitution
 * (backlog 645): `<(…)`, `>(…)`, `2<(…)` and `{fd}<(…)` are one argument each (bash manual,
 * *Process Substitution*).
 */
const WRITTEN_REDIRECTION = /^(?:\d+|&|\{[A-Za-z_]\w*\})?(?:>>?|<)(?!\()/;

/** A written redirection with no target in it (`>`, `2>`, `{fd}>`, `&>`): its target is the next word. */
const DETACHED_WRITTEN_REDIRECTION = /^(?:\d+|&|\{[A-Za-z_]\w*\})?[<>&|]+$/;

/**
 * Written words (quotes on) with each written redirection, and a detached one's target, left out.
 * A process substitution stays: it is an argument (backlog 645); `< <(…)` is a redirection, so its
 * target goes with it.
 */
const withoutWrittenRedirections = (words: readonly string[]): readonly string[] =>
  words.filter(
    (word, index) =>
      !WRITTEN_REDIRECTION.test(word) &&
      !(index > 0 && DETACHED_WRITTEN_REDIRECTION.test(words[index - 1] as string)),
  );

// ── evaluation ───────────────────────────────────────────────────────────────

export interface CommandRequest {
  /** The command line exactly as the agent asked to run it. */
  readonly command: string;
  /**
   * argv[0] resolved to a real path on disk by the caller ("resolved against the real binary, not
   * the name" — BD-025). Its basename is checked against the block-list's whole-binary bans and
   * substituted for argv[0], so a shadowed or aliased `docker` is still blocked.
   */
  readonly resolvedBinary?: string;
}

export interface CommandEvaluation {
  readonly verdict: CommandVerdict;
  /** The pattern that decided, when one did. */
  readonly matched: string | null;
  /** The part of the command line the verdict came from. */
  readonly segment: string | null;
  /** Constructs the scanner could not follow; non-empty means the verdict was floored at `ask`. */
  readonly uncertainty: readonly UncertaintyReason[];
}

/**
 * Does an allow entry admit this piece of command line? A precise entry
 * ({@link PRECISE_ALLOW_ENTRIES}) decides by its grammar, and only when the line carries no command
 * or process substitution (`admitPrecise`); every other entry is a glob.
 */
const matchesAllowEntry = (entry: string, text: string, admitPrecise: boolean): boolean => {
  const precise = PRECISE_ALLOW_ENTRIES.get(entry);
  if (precise === undefined) {
    return matchesCommandPattern(entry, text);
  }
  return admitPrecise && precise.admits(tokenise(text));
};

/**
 * Verdict for one piece of command line.
 *
 * `block` always wins. Between `allow` and `ask` the more specific pattern wins, and a tie goes to
 * `ask`: the lists overlap by design (`git push origin agentic/*` allowed inside a general
 * `git push*` ask), and picking the broader pattern would make the narrow one unreachable.
 */
const evaluateOne = (
  text: string,
  policy: ResolvedCommandPolicy,
  fallback: CommandVerdict,
  admitPrecise: boolean,
): Omit<CommandEvaluation, 'uncertainty'> => {
  const blocked = bestMatch(policy.block, text, matchesBlockPattern);
  if (blocked !== undefined) {
    return { verdict: 'block', matched: blocked, segment: text };
  }
  // `env ls` is an `ls`: an environment wrapper is peeled off before the allow/ask lists see it.
  const forms = [text, ...stripEnvironmentPrefix(text)];
  // The ask-list also sees the line dequoted, so `find . "-exec" …` is the `find … -exec` the
  // ask-list already names. The allow-list deliberately does not: a form that only matches after
  // dequoting may tighten a verdict, never loosen one.
  const askForms = [...new Set([...forms, ...forms.map(dequoteCommand)])];
  const mostSpecific = (
    patterns: readonly string[],
    against: readonly string[],
    matches: (pattern: string, command: string) => boolean,
  ): string | undefined =>
    against
      .map((form) => bestMatch(patterns, form, matches))
      .filter((match): match is string => match !== undefined)
      .sort((a, b) => specificity(b) - specificity(a))[0];
  const asked = mostSpecific(policy.ask, askForms, matchesCommandPattern);
  const allowed = mostSpecific(policy.allow, forms, (entry, form) =>
    matchesAllowEntry(entry, form, admitPrecise),
  );
  if (allowed !== undefined && (asked === undefined || specificity(allowed) > specificity(asked))) {
    return { verdict: 'allow', matched: allowed, segment: text };
  }
  if (asked !== undefined) {
    return { verdict: 'ask', matched: asked, segment: text };
  }
  return { verdict: fallback, matched: null, segment: text };
};

/**
 * The verdict a command no list matches may fall back to.
 *
 * `allow` is absent on purpose: the fallback is also the floor that rules 4 and 5 lean on, so a
 * caller passing `allow` would turn "everything else → ask" into "everything else → run" and
 * disarm the uncertainty rule in the same move. The type makes that unspellable; `evaluateCommand`
 * also refuses it at runtime, for a caller that arrives from JavaScript or through a cast.
 */
export type CommandFallback = Exclude<CommandVerdict, 'allow'>;

/**
 * Evaluates a command against the three lists.
 *
 * @param fallback verdict for a command no list matches — `ask` by default (product/19 §3).
 */
export const evaluateCommand = (
  request: CommandRequest,
  policy: ResolvedCommandPolicy = DEFAULT_COMMAND_POLICY,
  fallback: CommandFallback = 'ask',
): CommandEvaluation => withCommandMemo(() => evaluateOnce(request, policy, fallback));

const evaluateOnce = (
  request: CommandRequest,
  policy: ResolvedCommandPolicy,
  fallback: CommandFallback,
): CommandEvaluation => {
  if ((fallback as CommandVerdict) === 'allow') {
    throw new PolicyViolationError(
      'command.policy',
      'the fallback verdict may not be "allow": it is also the floor an unmatched or unparseable command lands on (product/19 §3, rules 4 and 5)',
    );
  }
  const parsed = parseCommand(request.command);
  // The scanner's reasons, and five the policy adds: the block entry an `xargs` could complete
  // from its input (WP-197), the one a line matches only when a word is read as an option's
  // value (WP-198), the one whose operands a line meets beside an option it cannot read (WP-204),
  // the one an expansion could complete (WP-201), and a program the stage's
  // policy does not know handed a judged name (WP-203) — the only reasons that
  // need the policy's lists, a project's included — and a sed or awk script that executes (WP-210).
  const uncertainty: readonly UncertaintyReason[] = [
    ...new Set([
      ...parsed.uncertainty,
      ...parsed.fragments.flatMap((fragment) => {
        const entry = xargsBlockPrefix(fragment, policy.block);
        return entry === undefined ? [] : [xargsCompletesBlockEntry(entry)];
      }),
      ...parsed.fragments.flatMap((fragment) => {
        const entry = blockEntryBehindFlagValue(fragment, policy.block);
        return entry === undefined ? [] : [flagValueHidesBlockEntry(entry)];
      }),
      // WP-204 (b)(iii): an option the policy cannot read beside a block entry's operands.
      ...parsed.fragments.flatMap((fragment) => {
        const found = blockEntryUnderUnreadOption(fragment, policy.block);
        return found === undefined ? [] : [optionMayBeBlockEntry(found.entry, found.option)];
      }),
      // WP-201: the block entry an expansion could complete, read on each stage as written.
      ...parsed.rawStages.flatMap((stage) => {
        const entry = blockEntryBehindExpansion(stage, policy.block);
        return entry === undefined ? [] : [expansionCompletesBlockEntry(entry)];
      }),
      // WP-203: a program the stage's policy does not know, handed a judged name.
      ...parsed.programStages.flatMap((stage) =>
        unknownProgramReasons(stage, policy, !parsed.substitutes),
      ),
      // WP-210: a sed or awk script that can run a command, whatever its input.
      ...parsed.programStages.flatMap(scriptExecutesReasons),
    ]),
  ];
  const floor = (evaluation: Omit<CommandEvaluation, 'uncertainty'>): CommandEvaluation => ({
    ...evaluation,
    verdict:
      uncertainty.length > 0 ? mostRestrictive(evaluation.verdict, fallback) : evaluation.verdict,
    uncertainty,
  });

  if (parsed.fragments.length === 0) {
    // Nothing runnable: an empty command, or only operators. Never `allow`.
    return { verdict: fallback, matched: null, segment: null, uncertainty };
  }
  // The whole line as the shell reads it for commands: a here-document body that is data is not
  // part of it, so `timeout 5 cat <<'EOF'` over a body line `git push --force` is not a push.
  const line = withoutRanges(request.command, parsed.bodyRanges);

  if (request.resolvedBinary !== undefined) {
    const name = basename(request.resolvedBinary);
    const banned = binaryBans(policy.block).find((ban) => globToRegExp(ban).test(name));
    if (banned !== undefined) {
      return {
        verdict: 'block',
        matched: banned,
        segment: request.resolvedBinary,
        uncertainty,
      };
    }
  }
  for (const fragment of parsed.fragments) {
    const banned = xargsBannedEntry(fragment, policy.block);
    if (banned !== undefined) {
      return {
        verdict: 'block',
        matched: banned,
        segment: fragment,
        uncertainty,
      };
    }
  }

  const candidates: string[] = [line, ...parsed.fragments];
  if (request.resolvedBinary !== undefined) {
    // argv[0] replaced by what it really resolves to, so `tf apply` is judged as `terraform apply`
    // — in both readings (WP-198), so a leading `2>/dev/null` is not the word replaced.
    for (const tokens of argvForms(line)) {
      candidates.push([basename(request.resolvedBinary), ...tokens.slice(1)].join(' '));
    }
  }

  // The whole command is evaluated with no fallback: only an explicit match may speak for it,
  // otherwise a single unmatched fragment would be masked by the whole line's fallback.
  // A precise allow entry reads the tokens of a fragment, and the scanner lifts a substitution's
  // body out of the fragment it sat in — so on a line with one, a precise entry would judge
  // `sed -n 1p f $(ls)` as `sed -n 1p f`. It is not consulted there at all.
  const admitPrecise = !parsed.substitutes;
  let result = evaluateOne(line, policy, 'allow', admitPrecise);
  for (const candidate of candidates.slice(1)) {
    const evaluation = evaluateOne(candidate, policy, fallback, admitPrecise);
    if (mostRestrictive(result.verdict, evaluation.verdict) !== result.verdict) {
      result = evaluation;
    }
  }

  // Writing to a path is never something the policy can wave through on the strength of the
  // command's name alone (product/19 §3, "any command writing outside the workspace").
  if (result.verdict === 'allow' && parsed.writeTargets.length > 0) {
    return {
      verdict: mostRestrictive('ask', fallback),
      matched: null,
      segment: request.command,
      uncertainty,
    };
  }

  // Neither is an argument that turns the verb into something the policy has not read. Only an
  // `allow` is floored, so this can tighten a verdict and never loosen one.
  if (result.verdict === 'allow') {
    for (const candidate of candidates) {
      const hazard = hazardousArgument(candidate);
      if (hazard !== undefined) {
        return {
          verdict: mostRestrictive('ask', fallback),
          matched: hazard.pattern,
          segment: candidate,
          uncertainty,
        };
      }
    }
  }
  return floor(result);
};

/** Guard form: throws unless the command is on the allow-list. */
export const assertCommandAllowed = (
  request: CommandRequest,
  policy: ResolvedCommandPolicy = DEFAULT_COMMAND_POLICY,
): void => {
  const evaluation = evaluateCommand(request, policy);
  if (evaluation.verdict !== 'allow') {
    throw new PolicyViolationError(
      'command.policy',
      `"${request.command}" is ${evaluation.verdict}` +
        (evaluation.matched === null ? ' (no list matches it)' : ` by "${evaluation.matched}"`) +
        (evaluation.uncertainty.length === 0
          ? ''
          : `; the scanner could not follow: ${evaluation.uncertainty.join(', ')}`),
    );
  }
};

// ── narrowing (BD-025: "projects can only narrow it") ────────────────────────

export interface NarrowedCommandPolicy {
  readonly policy: ResolvedCommandPolicy;
  /**
   * Allow entries the layer asked for that the maximum does not grant — dropped from the policy
   * and **reported** here. Since WP-54 this has readers: the stage planner logs it per run and the
   * effective-configuration DTO publishes what no role would be granted (PROGRESS backlog 49).
   */
  readonly ignoredAllow: readonly string[];
}

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

/**
 * An allow entry with no glob metacharacter names exactly one command line — unless it is the name
 * of a precise entry, which names a grammar and is granted only verbatim.
 */
const isLiteralCommand = (entry: string): boolean =>
  !/[*?]/.test(entry) && !PRECISE_ALLOW_ENTRIES.has(entry);

/**
 * Whether the maximum grants a layer's allow entry.
 *
 * Two ways, and the second is WP-54's. An entry the maximum lists **verbatim** is granted, as it
 * always was. A **literal** entry — no `*`, no `?` — is granted when the maximum itself evaluates
 * that exact line to `allow`, so a project's `npm run lint` narrows the baseline's `npm run *`
 * rather than being dropped for not being spelled the same way. That is narrowing and never
 * widening: a literal matches one line, and the maximum has already allowed that line — including
 * its fragments, its redirection floor and its hazardous-argument floor, because it is
 * `evaluateCommand` that says so.
 *
 * **A glob entry is granted only verbatim, deliberately.** Coverage between two globs is not the
 * same question: an entry can be *covered* by an allow pattern and still be more specific than an
 * ask pattern the maximum uses to carve that allow pattern up — `git rebase -x *` is covered by
 * `git rebase *` and pins more literal characters than `git rebase* -x*`, so granting it would
 * turn the maximum's `ask` into the project's `allow`. The literal case cannot do that: its one
 * line was judged by the maximum's own lists.
 */
const grantsAllowEntry = (maximum: ResolvedCommandPolicy, entry: string): boolean =>
  maximum.allow.includes(entry) ||
  (isLiteralCommand(entry) && evaluateCommand({ command: entry }, maximum).verdict === 'allow');

/**
 * Whether an allow entry of the maximum belongs to the **project-command class** — the class a
 * layer's `allow` narrows (Q97, WP-54 review round 1).
 *
 * An entry is in the class when a {@link PROJECT_COMMAND_ALLOW} pattern covers it: the pattern
 * matches the entry's own spelling, a `*` in the entry being matched like any other character. That
 * is coverage in the safe direction — a pattern that matches a glob's spelling matches every line
 * the glob does — so `npm run lint` and `make test` an organisation wrote are in the class, and
 * `git commit *`, `cat *` and a stage's `git merge origin/*` are not.
 */
export const isProjectCommandEntry = (entry: string): boolean =>
  PROJECT_COMMAND_ALLOW.some((pattern) => matchesCommandPattern(pattern, entry));

/**
 * Applies a lower-precedence layer (project settings, then `.agentic/config.yml`) to the maximum a
 * run starts from.
 *
 * - `allow` may only shrink, and **a declared `allow` narrows the project-command class only**
 *   (Q97, answered at WP-54's review round 1). The maximum's other entries — the read verbs, the
 *   git verbs, the lockfile installs, a stage's or a skill's additions — are untouched, because
 *   product/19 §3 reads `commands.allow` as *"the project's declared commands"*, and treating it as
 *   the whole list meant technical/12's own example stripped the developer of `git commit` and every
 *   role of `git log`. A project that wants one of those gone writes it into `ask` or `block`.
 *   Within the class the result is what the layer lists and the maximum grants; an entry the
 *   maximum does not grant is reported in `ignoredAllow` and dropped.
 * - `ask` and `block` may only grow; `block` always wins over both other lists.
 */
export const narrowCommandPolicy = (
  maximum: ResolvedCommandPolicy,
  layer: CommandPolicy | undefined,
): NarrowedCommandPolicy => {
  const layerAllow = layer?.allow;
  const ignoredAllow =
    layerAllow === undefined ? [] : layerAllow.filter((entry) => !grantsAllowEntry(maximum, entry));
  const block = unique([...maximum.block, ...(layer?.block ?? [])]);
  const ask = unique([...maximum.ask, ...(layer?.ask ?? [])]).filter(
    (entry) => !block.includes(entry),
  );
  const allow = (
    layerAllow === undefined
      ? maximum.allow
      : [
          ...maximum.allow.filter(
            (entry) => !isProjectCommandEntry(entry) || layerAllow.includes(entry),
          ),
          ...layerAllow.filter(
            (entry) => !maximum.allow.includes(entry) && grantsAllowEntry(maximum, entry),
          ),
        ]
  ).filter((entry) => !ask.includes(entry) && !block.includes(entry));

  return { policy: { allow: unique(allow), ask, block }, ignoredAllow };
};

// ── the organisation maximum over a run's baseline (PROGRESS backlog 146, WP-63) ──

export interface OrganisationNarrowing {
  readonly policy: ResolvedCommandPolicy;
  /** The baseline's `allow` entries the organisation maximum does not grant — removed, and named. */
  readonly removed: readonly string[];
}

/**
 * A run's starting policy judged against the **organisation maximum**, for every verb — before any
 * project layer narrows it (BD-025 §2, PROGRESS backlog 146).
 *
 * Q97's narrowing ({@link narrowCommandPolicy}) touches only the project-command class, which is
 * right against a role baseline and wrong against an organisation: a baseline `git push …` entry an
 * organisation left out of its `allow` would otherwise survive every later layer, because nothing
 * downstream removes an entry outside the class. So the organisation is applied **first**, as an
 * intersection:
 *
 *  - `allow` — when the organisation states one, a baseline entry is kept only if that maximum
 *    grants it, by {@link grantsAllowEntry}'s two rules (verbatim, or a literal line the maximum
 *    evaluates to `allow`), and an organisation **literal** is added when the baseline grants it
 *    (the same two rules, the other way round). A glob the organisation did not list verbatim is
 *    removed, which is the direction a coverage question between two globs has to fail in. A stage's and a skill's
 *    additions (TD-027) are part of the baseline here and meet the same test. When the organisation
 *    states no `allow`, nothing is removed from it: the maximum is then the platform's own shipped
 *    baselines themselves. That is not one list every baseline sits under — since WP-64 the
 *    `verification` baseline holds `./.agentic/workspace/setup` ({@link WORKSPACE_SETUP_ALLOW}),
 *    which `DEFAULT_IMPLEMENTATION_ALLOW` deliberately does not — so "no organisation `allow`"
 *    means "each role's shipped baseline", not "the implementation list".
 *  - `ask` and `block` — the organisation's entries are **added**; neither list can shrink, and an
 *    allow entry named verbatim in either is removed.
 *
 * The result can only be narrower than the baseline, never wider — asserted over arbitrary inputs
 * in the tests.
 */
export const intersectWithOrganisationMaximum = (
  baseline: ResolvedCommandPolicy,
  organisation: CommandPolicy | undefined,
): OrganisationNarrowing => {
  if (organisation === undefined) {
    return { policy: baseline, removed: [] };
  }
  const block = unique([...baseline.block, ...(organisation.block ?? [])]);
  const ask = unique([...baseline.ask, ...(organisation.ask ?? [])]).filter(
    (entry) => !block.includes(entry),
  );
  const declaredAllow = organisation.allow;
  const maximum: ResolvedCommandPolicy = {
    allow: declaredAllow ?? baseline.allow,
    // The combined list, not the organisation's alone: a literal is granted only if the stricter of
    // the two would still run it.
    ask,
    block,
  };
  // The intersection read from both sides: a baseline entry the organisation grants, and an
  // organisation **literal** the baseline grants — `make test` listed by an organisation is inside
  // a baseline's `make *` and must survive the glob being removed. An organisation glob the
  // baseline does not list verbatim is not admitted: coverage between two globs is not decided.
  const bounded: ResolvedCommandPolicy = { ...baseline, ask, block };
  const granted =
    declaredAllow === undefined
      ? baseline.allow
      : [
          ...baseline.allow.filter((entry) => grantsAllowEntry(maximum, entry)),
          ...declaredAllow.filter(
            (entry) => !baseline.allow.includes(entry) && grantsAllowEntry(bounded, entry),
          ),
        ];
  const allow = granted.filter((entry) => !ask.includes(entry) && !block.includes(entry));
  return {
    policy: { allow: unique(allow), ask, block },
    removed: baseline.allow.filter((entry) => !allow.includes(entry)),
  };
};

export interface RunCommandPolicy extends NarrowedCommandPolicy {
  /** {@link OrganisationNarrowing.removed}: what the organisation took from this run's baseline. */
  readonly removedByOrganisation: readonly string[];
  /** {@link unattendedCommandModeOf} over the organisation and every layer (BD-025, 2026-10-06). */
  readonly unattended: UnattendedCommandMode;
}

/**
 * What an unattended run does with an `ask` — `deny` when **any** layer says so (the organisation,
 * the project's settings, the repository file), otherwise the platform default `auto` (BD-025's
 * 2026-10-06 amendment). Only tightens: an `auto` stated below a `deny` changes nothing, so a
 * repository file can choose `deny` and never undo one.
 */
export const unattendedCommandModeOf = (
  ...layers: readonly (CommandPolicy | undefined)[]
): UnattendedCommandMode =>
  layers.some((layer) => layer?.unattended === 'deny') ? 'deny' : DEFAULT_UNATTENDED_COMMAND_MODE;

/**
 * The policy a run is given: its baseline, intersected with the organisation maximum, then narrowed
 * by each project layer in turn — the settings, then the repository's `.agentic/config.yml` — in
 * that order, and only in that order (backlog 146, WP-63).
 *
 * Every layer narrows what the one before it left, so the repository may tighten what the settings
 * allow and never loosen it (WP-63 review round 1's ruling), and nothing can widen past the
 * organisation. `ignoredAllow` is every layer's, in order: a repository entry the settings had
 * removed is reported there rather than re-granted.
 */
export const runCommandPolicy = (
  baseline: ResolvedCommandPolicy,
  organisation: CommandPolicy | undefined,
  ...layers: readonly (CommandPolicy | undefined)[]
): RunCommandPolicy => {
  const bounded = intersectWithOrganisationMaximum(baseline, organisation);
  let policy = bounded.policy;
  const ignored: string[] = [];
  for (const layer of layers) {
    const narrowed = narrowCommandPolicy(policy, layer);
    policy = narrowed.policy;
    ignored.push(...narrowed.ignoredAllow);
  }
  return {
    policy,
    ignoredAllow: unique(ignored),
    removedByOrganisation: bounded.removed,
    unattended: unattendedCommandModeOf(organisation, ...layers),
  };
};
