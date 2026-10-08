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
 *     compared by basename, so `FOO=1 /usr/bin/sudo reboot` is a `sudo` command.
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
 *     arbitrary command, an arbitrary path to write, or an unread package source.
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
 * the shell expands by a glob or a brace (`expandedName`), a name `hash -p` rebinds
 * (`reboundName`), and an `xargs` that hands its input to a wrapper, `find -exec` or `git`
 * (`xargsArguments`). A line continuation is joined before any word is classified, inside a word
 * as between words (`normaliseCommand`), and git's abbreviated long options are resolved by git's
 * rule (`HAZARDOUS_ARGUMENTS`).
 *
 * **What it still does not read:** a script in a file (`bash file`, `bash < file`, `. ./x.sh` — a
 * file the run wrote, backlog 481's residual and the unattended module's), an interpreter that is not
 * a shell (`python3 -c`, `perl -e`), a command a program assembles from its input where no string on
 * the line names it (`parallel`; and `xargs` feeding a command that is not a wrapper, `find -exec`,
 * `git` or a shell — `xargs make`, whose input names targets), a prompt variable or an alias set by
 * a start-up file, an option's value attached to its option (`read -aNAME`), a name taken by a
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
 * The constructs the scanner refuses to reason about. Each one floors the verdict at `ask`: the
 * line may be perfectly innocent, but the scanner cannot prove it, and a policy that guesses in
 * the permissive direction is worse than one that asks.
 */
export const UNCERTAINTY = {
  unbalancedQuote: 'a quote is never closed',
  unterminatedSubstitution: 'a command or process substitution is never closed',
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
   */
  expandedName:
    "a command name with a glob (*, ?, [) or a brace expansion ({a,b}, {a..b}) in it — write the command's name literally; the platform cannot read a name the shell expands",
  /** WP-161 criterion (12), backlog 522: `hash -p FILE NAME` makes `NAME` run `FILE`. */
  reboundName:
    'hash -p, which binds a command name to another program — run the program by its own name; the platform reads a command by the name it is written with',
  /**
   * WP-161 criterion (13), backlog 523: `xargs` appends the words it reads to its command, so a
   * command that runs its arguments — a wrapper, `find -exec`, `git` — runs what the pipe said.
   */
  xargsArguments:
    'xargs handing the words it reads from its input to a command that runs its arguments (a wrapper such as env, nice, nohup or timeout, find with -exec, or git) — write the command and its arguments on the line; the platform cannot read arguments xargs supplies from its input',
} as const;

export type UncertaintyReason = (typeof UNCERTAINTY)[keyof typeof UNCERTAINTY];

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
 * Where product/19 §3's block list is narrower than the hazard it names, and why the gap is left
 * rather than papered over. Inventing patterns here would put security rules in code that the
 * product document does not state — the fix belongs in the document (Q37).
 *
 * **The line WP-02a draws.** A missing spelling that only decides between `ask` and `block` stays
 * the document's to fix: the command can never reach `allow`, so the code is not the thing keeping
 * it out. A missing spelling that leaves a hazard reachable from the **allow**-list is closed here,
 * because the allow-list is the one thing this module exists to defend. That is why `git push -f`,
 * `git push … --delete` and `git push origin +…` moved onto the block list — the allow entry
 * `git push origin agentic/*` was carrying all three — while the two entries below did not.
 */
export const DECLINED_BLOCK_VARIANTS = [
  {
    hazard: 'recursive delete with the flags spelled differently — `rm -fr /`, `rm -r -f /`',
    stated: 'rm -rf /*',
    verdict:
      'ask (nothing on the allow-list matches `rm`), never allow from the lists; an unattended `auto` run runs an ask in its sandbox, whose only writable mount is the workspace (BD-025, 2026-10-06)',
  },
  {
    hazard: 'branch deletion in long form — `git branch --delete --force main`',
    stated: 'git branch -D *',
    verdict:
      'ask, never allow from the lists; an unattended `auto` run runs an ask in its sandbox, and a push of the deletion is refused by the git boundary (BD-025, 2026-10-06)',
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
 * does not name.
 *
 * **What a name does not bound, said where the names are.** `npm run *` and `make *` run whatever
 * the repository's own `package.json` or `Makefile` says, and a task branch can change that: the
 * *body* of these commands is repository content, bounded by the run container, its non-root user,
 * its workspace-only writable mount and its egress allow-list (BD-021, TD-021) — never by this
 * list. Some spellings that hand one of these verbs a command string **the model** wrote rather
 * than the repository are floored at `ask` by {@link HAZARDOUS_ARGUMENTS}: a `make` variable
 * assignment, `make --eval` (and the getopt prefixes `--ev`/`--eva`) and `-E` in a short-option
 * cluster, `go -exec`/`-toolexec`/`-ldflags … -extld` in either dash form, `cargo --config`, and
 * npm's and pnpm's `--script-shell`, `--node-options` and pnpm's `--config.<key>`.
 *
 * **That is an enumeration of known spellings and can be incomplete** — WP-54's review found seven
 * the first list missed in round 1 and five more in round 2. npm and pnpm accept any unique prefix
 * of a long option, and those are floored from the **shortest prefix that is unique today**
 * (`--scr`, `--node`): that is knowledge of the CLIs' current option sets, not a measurement, and a
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
 * sources at the entries. Until
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
 * directory, which walks past every pytest floor on this list, so both ask. **What still reads a
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
 */
export const PROJECT_COMMAND_ALLOW: readonly string[] = [
  'npm test',
  'npm test *',
  'npm run *',
  'pnpm test',
  'pnpm test *',
  'pnpm run *',
  'make',
  'make *',
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

export interface HazardousArgument {
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
  }) => boolean;
}

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

/** Global options of `git` itself that take the next word as their value (git(1)). */
export const GIT_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
  '--attr-source',
]);

/** The subcommand of a `git` argv (`name` is `git` or `git-<sub>`), past git's own options. */
const gitSubcommandOf = (name: string, words: readonly string[]): string | null => {
  if (name !== 'git') {
    return name.slice('git-'.length);
  }
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (GIT_GLOBAL_VALUE_OPTIONS.has(word)) {
      index += 1;
    } else if (word === '--') {
      return words[index + 1] ?? null;
    } else if (!word.startsWith('-')) {
      return word;
    }
  }
  return null;
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
    hazard:
      'git runs the --upload-pack value as a shell command on the far end, and with a local path as the remote that far end is this machine',
  },
  {
    pattern: 'git * --receive-pack*',
    kind: 'command',
    hazard: 'the push-side twin of --upload-pack, and equally a shell command',
  },
  /**
   * `--exec`, and since WP-160 (d) `git rebase`'s short spelling, `-x`: attached (`-xCMD`) or last
   * in a cluster (`-ix`, `-qx`) — git 2.47.3 (the run image's) and 2.54 each ran the command for all
   * three, and for `--ex`/`--exe`, the abbreviations git's option parser accepts. A token predicate
   * rather than the glob it was, because a glob cannot read a cluster; the glob's own reach (a flag
   * after any subcommand, quoting off) is the predicate's too.
   */
  {
    pattern: 'git * --exec*',
    kind: 'command',
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
   * `--exec`'s reason: a glob cannot read a cluster.
   */
  {
    pattern: 'git * --extcmd*',
    kind: 'command',
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
    hazard:
      "--ext-diff turns on the external diff driver the *repository's own* config names, and a repository is untrusted input (BD-022)",
  },
  {
    pattern: 'git * --textconv*',
    kind: 'command',
    hazard: "--textconv runs the textconv filter the repository's config names (BD-022)",
  },
  {
    pattern: 'git * ext::*',
    kind: 'command',
    hazard:
      "git's ext:: transport runs its argument as a shell command; it is refused unless protocol.ext.allow is set, which is the workspace's configuration and not this module's to promise",
  },
  {
    pattern: 'rg * --pre*',
    kind: 'command',
    hazard: 'ripgrep runs the --pre command over every file it searches',
  },
  {
    pattern: 'rg * --hostname-bin*',
    kind: 'command',
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
  { pattern: 'git commit* -n*', kind: 'trust', hazard: 'the short spelling of --no-verify' },
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
    hazard:
      'a make argument with `=` that is not a flag is a command-line variable assignment — `X:=$(shell …)`, `SHELL=`, `.SHELLFLAGS=`, or an ordinary `V=1`, which can equally override a recipe variable such as `CC` — so every one is floored, while `--jobs=4` (a flag) is not',
    tokens: ({ name, positional }) =>
      name === 'make' && positional.some((token) => token.includes('=')),
  },
  {
    pattern: 'make* --e*',
    kind: 'command',
    hazard:
      'make --eval, spelled in full or by the prefixes GNU getopt accepts (`--ev`, `--eva`), evaluates the text as makefile source; `--environment-overrides` lets the environment replace the makefile’s variables',
  },
  {
    pattern: 'make -…E… (a single-dash short-option cluster containing E)',
    kind: 'command',
    hazard: 'the short spelling of make --eval, alone (`-E`) or inside a clustered flag (`-sE`)',
    tokens: ({ name, flags }) => name === 'make' && flags.some((flag) => /^-[^-]*E/.test(flag)),
  },
  {
    pattern: 'go* -exec*',
    kind: 'command',
    hazard: 'go test -exec runs the test binary under an arbitrary program',
  },
  { pattern: 'go* --exec*', kind: 'command', hazard: 'the double-dash spelling of go -exec' },
  {
    pattern: 'go* -toolexec*',
    kind: 'command',
    hazard: 'go -toolexec runs an arbitrary program in front of every toolchain invocation',
  },
  {
    pattern: 'go* --toolexec*',
    kind: 'command',
    hazard: 'the double-dash spelling of go -toolexec',
  },
  {
    pattern: 'go* -ldflags*extld*',
    kind: 'command',
    hazard:
      '`-ldflags=-extld=…` names the external linker, which is a program the command line chose',
  },
  {
    pattern: 'go* --ldflags*extld*',
    kind: 'command',
    hazard: 'the double-dash spelling of go -ldflags … -extld',
  },
  {
    pattern: 'cargo* --config*',
    kind: 'command',
    hazard: 'cargo --config can set a target runner, which is an arbitrary command',
  },
  {
    pattern: '* --script-shell*',
    kind: 'command',
    hazard: 'npm and pnpm run the package script under the --script-shell binary instead of sh',
  },
  {
    pattern: 'npm* --scr*',
    kind: 'command',
    hazard:
      'npm accepts any unique prefix of a long option; `--scr` is the shortest unique to --script-shell in the option set this is written against',
  },
  {
    pattern: 'pnpm* --scr*',
    kind: 'command',
    hazard: 'the same prefixes of --script-shell, for pnpm',
  },
  {
    pattern: '* --node-options*',
    kind: 'command',
    hazard:
      'npm turns --node-options into NODE_OPTIONS, so `--import=data:…` runs model-written code',
  },
  {
    pattern: 'npm* --node*',
    kind: 'command',
    hazard: 'the prefixes of --node-options npm accepts (`--node-o…`), floored from `--node`',
  },
  {
    pattern: 'pnpm* --node*',
    kind: 'command',
    hazard: 'the same prefixes of --node-options, for pnpm',
  },
  {
    pattern: 'pnpm* --config.*',
    kind: 'command',
    hazard:
      'pnpm `--config.<key>=` sets any configuration key, including `node-options` and `script-shell`',
  },
  {
    pattern: 'npm* --config.*',
    kind: 'command',
    hazard:
      'the pnpm spelling on npm — floored as a precaution; whether npm accepts it is not measured',
  },
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
  {
    pattern: 'pytest -o / --override-ini (any key, any spelling argparse accepts)',
    kind: 'command',
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
    hazard:
      'pytest 9.0.2 builds its parser with `fromfile_prefix_chars="@"` (`src/_pytest/config/argparsing.py:463`), so any argument starting with `@` is replaced by the lines of a file the agent may have written — which can carry every flag floored here, and no pattern sees them',
    tokens: ({ name, flags, positional }) =>
      name.startsWith('pytest') && [...flags, ...positional].some((token) => token.startsWith('@')),
  },
  {
    pattern: 'pytest -c / --config-file (any spelling argparse accepts)',
    kind: 'command',
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
 * Words that stand in front of the command that actually runs: environment wrappers, shell
 * keywords and grouping tokens. A block pattern names the real binary, so these are peeled off
 * before matching — otherwise `env sudo id` and `then sudo id` read as `env` and `then` commands.
 */
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
  'runuser',
  'su',
  'doas',
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
 */
const unquoteToken = (token: string): string => {
  if (!/["'\\]/.test(token)) {
    return token;
  }
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index] as string;
    if (quote === null && (char === '"' || char === "'")) {
      quote = char;
    } else if (quote !== null && char === quote) {
      quote = null;
    } else if (char === '\\' && quote !== "'") {
      index += 1;
      out += token[index] ?? '';
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
  ARGV0_WRAPPERS.has(argv0Name(token)) || isAssignment(token);

/** The name a token would run under: quoting off, then the last path segment. */
const argv0Name = (token: string): string => basename(unquoteToken(token));

/**
 * The shells, as **one** set (WP-160 (b)): each takes a script as its `-c` argument, reads one
 * from standard input, and runs a here-document it is handed. It was two sets until WP-160 —
 * `sh`/`bash`/`zsh`/`dash` for `-c`, and these for a here-document — so `rbash -c '…'` (shipped in
 * the run image) and `ksh -c '…'` were unread. `busybox` is not here: it is a shell only with a
 * second word (`busybox sh -c '…'`), which `wrappedScript` reads.
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
 */
const ENVIRONMENT_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'nice',
  'ionice',
]);

const tokenise = (text: string): readonly string[] =>
  normaliseCommand(text)
    .split(' ')
    .filter((token) => token.length > 0);

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
 * option is.
 */
const walkCommandStarts = (
  words: readonly string[],
  chain: (word: string) => boolean,
  flag: (word: string) => boolean,
): CommandStarts => {
  const starts = [0];
  const head = words[0];
  if (head === undefined || !chain(head)) {
    return { starts, tooDeep: false };
  }
  let peeled = 1;
  let limit = MAX_WRAPPER_DEPTH;
  for (let index = 1; index < words.length && index <= limit; index += 1) {
    starts.push(index);
    const word = words[index] as string;
    if (chain(word)) {
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

/** The peel of `argv0Candidates` over written tokens. */
const argvStarts = (tokens: readonly string[]): CommandStarts =>
  walkCommandStarts(tokens, isWrapperToken, (token) => isFlagToken(unquoteToken(token)));

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
 */
const argv0Candidates = (tokens: readonly string[]): readonly (readonly string[])[] => {
  const withBasename = (list: readonly string[]): readonly string[] =>
    list.length === 0 ? list : [argv0Name(list[0] as string), ...list.slice(1)];

  return argvStarts(tokens).starts.map((start) => withBasename(tokens.slice(start)));
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
 * hole under every `HAZARDOUS_ARGUMENTS` entry and under `find * -exec*` before it.
 */
const splitFlags = (
  tokens: readonly string[],
): { readonly flags: readonly string[]; readonly positional: readonly string[] } => {
  const flags: string[] = [];
  const positional: string[] = [];
  let literal = false;
  for (const written of tokens) {
    const token = unquoteToken(written);
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

const tokensMatch = (
  patternTokens: readonly string[],
  commandTokens: readonly string[],
): boolean => {
  const pattern = splitFlags(patternTokens);
  const command = splitFlags(commandTokens);
  if (pattern.positional.length > command.positional.length) {
    return false;
  }
  for (const [index, token] of pattern.positional.entries()) {
    if (!globToRegExp(token).test(command.positional[index] as string)) {
      return false;
    }
  }
  return pattern.flags.every((flag) =>
    command.flags.some((token) => globToRegExp(flag).test(token)),
  );
};

/**
 * Does a block pattern match this command?
 *
 * Either the tokens match — the pattern's flags anywhere, its positionals as a prefix of the
 * command's, after argv[0] normalisation — or the whole line matches the pattern as a glob. The
 * glob half is kept so the token rule can only add coverage, never remove it: `curl * | sh` must
 * still catch `curl -o out https://example.invalid | sh`.
 */
export const matchesBlockPattern = (pattern: string, command: string): boolean => {
  const patternTokens = tokenise(pattern);
  if (patternTokens.length === 0) {
    return false;
  }
  if (matchesCommandPattern(pattern, command)) {
    return true;
  }
  return argv0Candidates(tokenise(command)).some((candidate) =>
    tokensMatch(patternTokens, candidate),
  );
};

/** Does this piece of command line carry `entry` — by its glob, or by its token predicate? */
const carriesHazard =
  (command: string) =>
  (entry: HazardousArgument): boolean =>
    entry.tokens === undefined
      ? matchesBlockPattern(entry.pattern, command)
      : argv0Candidates(tokenise(command)).some((candidate) => {
          const [name, ...rest] = candidate;
          if (name === undefined) {
            return false;
          }
          const { flags, positional } = splitFlags(rest);
          return (entry.tokens as NonNullable<HazardousArgument['tokens']>)({
            name,
            flags,
            positional,
            words: rest.map(unquoteToken),
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
      if (text[index + 1] !== '\n') {
        out += text.slice(index, index + 2);
      }
      index += 1;
    } else {
      out += text[index];
    }
  }
  return out;
};

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
 * One stage's words, split as the shell splits them — quotes honoured, substitutions left out — by
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
export const HERE_DOCUMENT_SCRIPT_READERS: ReadonlySet<string> = new Set([
  ...SCRIPT_SHELLS,
  'busybox',
  'eval',
  'source',
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
    scan(text, PIPE_OPERATORS).segments.some((stage) => {
      const tokens = tokenise(stage);
      const head = tokens.find((token) => !isAssignment(token));
      if (head !== undefined && (argv0Name(head) === '[' || argv0Name(head) === '[[')) {
        return false;
      }
      return argv0Candidates(tokens).some(
        ([name]) =>
          name === '.' ||
          (name !== undefined && /[*?[{]/.test(name) && !isWrapperToken(name) && name !== '['),
      );
    })
  );
};

/** Index of the `)` closing the `(` at `openIndex`, honouring quotes, or -1 when unbalanced. */
const findClosingParen = (text: string, openIndex: number, hereDocuments = false): number => {
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
 * paths, and a quoted `"/dev/null"` or `'/dev/null'` floors too, because taking quotes off here
 * would be `unquoteToken`'s reading and not bash's (`"/dev/nul\l"` is `/dev/null` to the one and
 * `/dev/nul\l` to the other). Over-asking a quoted bit bucket is the safe direction.
 */
const isWriteTarget = (target: string): boolean =>
  target.length > 0 && !target.startsWith('&') && target !== '/dev/null';

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
  const push = (end = index): void => {
    const segment = current.trim();
    if (segment.length > 0) {
      segments.push(segment);
      rawSegments.push(command.slice(segmentStart, end).trim());
    }
    current = '';
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
    // body of all three.
    const opensSubstitution =
      rest.startsWith('$(') || rest.startsWith('<(') || rest.startsWith('>(');
    if (opensSubstitution) {
      const close = findClosingParen(command, index + 1, true);
      if (close === -1) {
        uncertainty.add(UNCERTAINTY.unterminatedSubstitution);
        substitutions.push(command.slice(index + 2));
        substitutionOffsets.push(index + 2);
        index = command.length;
        continue;
      }
      substitutions.push(command.slice(index + 2, close));
      substitutionOffsets.push(index + 2);
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

const REDIRECTION_OPERATOR = /^(?:<<<|<<-|<<|<>|<&|>&|>>|>\||&>>|&>|<|>)/;

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
 * backtick outside single quotes, or an unquoted glob, brace, tilde or redirection character, makes
 * it a string the platform cannot read before it runs.
 */
const isLiteralWord = (raw: string): boolean => {
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
    } else if (char === '$' || char === '`') {
      return false;
    } else if (quote === null && /[*?[{~<>()]/.test(char)) {
      return false;
    }
  }
  return quote === null;
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
 * between it and the command). The walk is `walkCommandStarts`, so it has the same bound and says
 * when it stopped at it (WP-161 (d)).
 */
const commandPositions = (argv: readonly ShellWord[]): CommandStarts => {
  let start = 0;
  while (start < argv.length && isAssignment((argv[start] as ShellWord).raw)) {
    start += 1;
  }
  const walk = walkCommandStarts(
    argv.map((word) => word.raw),
    isWrapperToken,
    (raw) => isFlagToken(unquoteToken(raw)),
  );
  const isWrapper =
    start < argv.length && ARGV0_WRAPPERS.has(argv0Name((argv[start] as ShellWord).raw));
  return {
    starts: (isWrapper ? walk.starts.filter((position) => position >= start) : [start]).filter(
      (position) => position < argv.length,
    ),
    tooDeep: walk.tooDeep,
  };
};

// ── WP-161 (f): a command name the shell expands (backlog 518) ───────────────

/**
 * Whether a word as written holds something bash expands into another word before it runs it: an
 * unquoted `*`, `?` or `[` (pathname expansion), or a brace expansion — an unquoted `{…}` with a
 * `,` or a `..` at its own level (`{a,b}`, `{i..i}`). `${…}` is a parameter expansion, not a brace,
 * and `{x}` and `{}` expand to nothing else. A `[` with no `]` is literal to bash and read as a glob
 * here, which can only over-read.
 */
const expandsAsName = (word: string): boolean => {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < word.length; index += 1) {
    const char = word[index] as string;
    if (quote === "'") {
      quote = char === "'" ? null : quote;
    } else if (char === '\\') {
      index += 1;
    } else if (char === '"') {
      quote = quote === '"' ? null : '"';
    } else if (quote === null && char === "'") {
      quote = "'";
    } else if (quote === null && /[*?[]/.test(char)) {
      return true;
    } else if (char === '$' && word[index + 1] === '{') {
      index = closingBraceEnd(word, index + 1) - 1;
    } else if (quote === null && char === '{' && bracesExpand(word, index)) {
      return true;
    }
  }
  return false;
};

/** Whether the unquoted `{` at `open` starts a brace expansion: a `,` or `..` at its own level. */
const bracesExpand = (word: string, open: number): boolean => {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = open; index < word.length; index += 1) {
    const char = word[index] as string;
    if (quote !== null) {
      quote = char === quote ? null : quote;
    } else if (char === '\\') {
      index += 1;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return false;
      }
    } else if (depth === 1 && (char === ',' || word.startsWith('..', index))) {
      return true;
    }
  }
  return false;
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
]);

/**
 * The words of a stage in **command position** (WP-161 (f)): past its assignments, the first word,
 * and — while that word is a wrapper — the next command word after the wrapper's options, their
 * plain values and its leading operand (each of those is listed too, since the policy does not
 * know a wrapper's grammar). Never an assignment (backlog 512's lesson), never a `[`/`[[` test or
 * what is inside it, and never an argument of the command itself: `nice ls *.ts` lists `nice` and
 * `ls`, not `*.ts`.
 */
const commandNameWords = (tokens: readonly string[]): readonly string[] => {
  const words: string[] = [];
  let operand = false;
  let wrapper = '';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const value = unquoteToken(token);
    const afterWrapper = words.length > 0;
    // An assignment, an element assignment (`y[x]=1`, `[x]=1` inside `y=( … )`) or a wrapper's `--`.
    if (isAssignment(token) || ELEMENT_ASSIGNMENT.test(value) || (afterWrapper && value === '--')) {
      continue;
    }
    if (value === '[' || value === '[[') {
      break;
    }
    if (afterWrapper && isFlagToken(value)) {
      // Fail closed (backlog 531, folded into WP-161): an option written without `=` may take the
      // next word as its value whatever its shape (`env -u foo`, `taskset -c 0-3`, `timeout -s
      // kill`), so that word is listed — tested by `expandsAsName` — and the walk goes on to the one
      // after it. Only an option known to take no value (`WRAPPER_FLAGS_WITHOUT_VALUE`) does not
      // spend the next word. The over-ask, stated: `nice -x ls *.ts` (an option the table does not
      // know) reads `*.ts` as a command word.
      const next = tokens[index + 1];
      if (
        !value.includes('=') &&
        next !== undefined &&
        !isFlagToken(unquoteToken(next)) &&
        !(WRAPPER_FLAGS_WITHOUT_VALUE[wrapper]?.has(value) ?? false)
      ) {
        words.push(next);
        index += 1;
      }
      continue;
    }
    if (afterWrapper && (operand || WRAPPER_VALUE_WORD.test(value))) {
      words.push(token);
      operand = false;
      continue;
    }
    words.push(token);
    const name = argv0Name(token);
    if (!ARGV0_WRAPPERS.has(name) || expandsAsName(token)) {
      break;
    }
    operand = WRAPPER_OPERAND.has(name);
    wrapper = name;
  }
  return words;
};

/**
 * Names a glob may never stand for while being read as a shell: what the policy judges by its name
 * (git, the block list's binaries, every wrapper that is not a shell, `hash`, `find`, `script`).
 */
const NAMES_THE_POLICY_JUDGES: readonly string[] = [
  ...new Set([
    'git',
    'sudo',
    'hash',
    'find',
    'script',
    'xargs',
    ...DEFAULT_BLOCKED_COMMANDS.map((pattern) => pattern.split(' ')[0] as string),
    ...[...ARGV0_WRAPPERS].filter((name) => !SCRIPT_SHELLS.has(name)),
  ]),
];

/** A glob or brace word's last path segment as a regular expression, or `null` when it cannot say. */
const expansionPattern = (word: string): RegExp | null => {
  const segment = word.split('/').at(-1) ?? '';
  if (/["'\\$]/.test(word) || /[{}]/.test(segment.replace(/\{[^{}/]*\}/g, ''))) {
    return null;
  }
  let pattern = '';
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] as string;
    if (char === '*') {
      pattern += '[\\s\\S]*';
    } else if (char === '?') {
      pattern += '[\\s\\S]';
    } else if (char === '[') {
      const close = segment.indexOf(']', index + 2);
      if (close === -1) {
        return null;
      }
      const body = segment.slice(index + 1, close).replace(/^!/, '^');
      pattern += `[${body.replace(/[\\\]]/g, '\\$&')}]`;
      index = close;
    } else if (char === '{') {
      const close = segment.indexOf('}', index);
      const inner = segment.slice(index + 1, close);
      pattern += inner.includes('..')
        ? '[\\s\\S]*'
        : `(?:${inner
            .split(',')
            .map((part) => part.replace(REGEX_SPECIALS, '\\$&'))
            .join('|')})`;
      index = close;
    } else {
      pattern += char.replace(REGEX_SPECIALS, '\\$&');
    }
  }
  try {
    return new RegExp(`^${pattern}$`);
  } catch {
    return null;
  }
};

/**
 * WP-160 reads a command whose name the shell expands as a shell (`/bin/[r]bash -c '…'`), and so
 * judges the script it is handed; that reading keeps its verdict (WP-161 (f)) when the expansion
 * can be a shell and cannot be anything the policy judges by name. `/usr/bin/[gs][ih]* -c …` can
 * be `git`, so it is not exempt.
 */
const expandsOnlyToAShell = (word: string): boolean => {
  const pattern = expansionPattern(word);
  return (
    pattern !== null &&
    [...SCRIPT_SHELLS].some((shell) => pattern.test(shell)) &&
    !NAMES_THE_POLICY_JUDGES.some((name) => pattern.test(name))
  );
};

/** Does this stage run a command whose name — or a wrapper's — the shell expands (WP-161 (f))? */
const expandsCommandName = (stage: string): boolean =>
  commandNameWords(tokenise(stage)).some(
    (word) => expandsAsName(word) && !expandsOnlyToAShell(word),
  );

/** A script a stage hands over, and the string an enclosing `find -exec`/`xargs -I` replaces in it. */
export interface HandedScript {
  readonly script: string;
  readonly replace: string | null;
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
/** xargs' long options that take a value, `=`-attached or the next word (GNU findutils). */
const XARGS_VALUE_LONG: ReadonlySet<string> = new Set([
  '--arg-file',
  '--delimiter',
  '--max-args',
  '--max-procs',
  '--max-chars',
  '--process-slot-var',
]);

/**
 * Index in `args` (the words after `xargs`) of the command xargs runs, past its own options and
 * their values, or -1 when it names none (xargs then runs `echo`).
 */
const xargsCommandIndex = (args: readonly ShellWord[]): number => {
  for (let index = 0; index < args.length; index += 1) {
    const value = unquoteToken((args[index] as ShellWord).raw);
    if (value === '--') {
      return index + 1 < args.length ? index + 1 : -1;
    }
    if (!value.startsWith('-') || value === '-') {
      return index;
    }
    if (value.startsWith('--')) {
      index += XARGS_VALUE_LONG.has(value) ? 1 : 0;
      continue;
    }
    for (let at = 1; at < value.length; at += 1) {
      if (XARGS_VALUE_SHORT.includes(value[at] as string)) {
        index += at === value.length - 1 ? 1 : 0;
        break;
      }
    }
  }
  return -1;
};

/**
 * Whether an xargs command runs the words xargs appends as a command, or decides from them what to
 * run (WP-161 criterion (13), backlog 523): a wrapper (`env`, `nohup`, `timeout`, `nice`, …) —
 * not a shell, whose `-c` WP-160 reads (`fedByXargs`) — `find` with `-exec`/`-execdir`/`-ok`/
 * `-okdir`, whose command the input completes, or `git`, whose subcommand and refspec it supplies.
 * `echo 'sudo id ;' | xargs find . -maxdepth 0 -exec`, `| xargs env` and `| xargs nohup` ran their
 * payload in the run image (WP-160's review round 2).
 */
const xargsRunsItsInput = (name: string, args: readonly ShellWord[]): boolean =>
  (ARGV0_WRAPPERS.has(name) && !SCRIPT_SHELLS.has(name)) ||
  name === 'git' ||
  name.startsWith('git-') ||
  (name === 'find' &&
    args.some((word) => /^-(?:exec|execdir|ok|okdir)$/.test(unquoteToken(word.raw))));

/** `xargs -I R`, `-iR`, `-i`, `--replace[=R]`, `-J R`: the string xargs replaces, if it does. */
const xargsReplace = (args: readonly ShellWord[]): string | null => {
  for (const [index, word] of args.entries()) {
    const value = unquoteToken(word.raw);
    if (value === '-I' || value === '-J') {
      return unquoteToken(args[index + 1]?.raw ?? '{}') || '{}';
    }
    if (/^-[IJ]./.test(value) || /^--replace=./.test(value)) {
      return value.slice(value.startsWith('--') ? 10 : 2);
    }
    if (value === '-i' || value === '--replace') {
      return '{}';
    }
    if (/^-i./.test(value)) {
      return value.slice(2);
    }
  }
  return null;
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
 *  - `script` — its `-c`/`--command` string (a cluster, `-cX` attached, `--c…` abbreviated, which
 *    util-linux accepts); without one it runs `$SHELL` on its standard input, read as a shell's.
 *  - `source`/`.` of a standard-input path, read as a shell's; of `<(…)`, uncertain.
 *  - `find` — the words from `-exec`/`-execdir`/`-ok`/`-okdir` to `;` (or `+` after `{}`), as a
 *    command (WP-160 (d)): read, not refused, so the block list, the git boundary and the hazard
 *    floor judge it. `{}` is a literal word, and a string in it that holds `{}` is not literal,
 *    since `find` puts a file name there (`replace`) — as `xargs -I` does with its own string.
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
      uncertain ||= piped && !input.fromHereDocument;
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
      // `-c` with no operand on the line: the script is one `xargs` (or nothing) supplies at run
      // time — `echo "'cmd'" | xargs bash -c` ran `cmd` (review round 1, measured).
      uncertain ||= operand === undefined;
      if (operand !== undefined) {
        hand(operand.raw);
        // `sh -c '"$@"' _ cmd …` runs its operands: a script that names a positional parameter
        // has them read as a command too ($0 on, and $1 on), and under `xargs` they come from
        // standard input, so the platform cannot read them.
        const rest = args.slice(index + 1);
        if (
          rest.length > 0 &&
          isLiteralWord(operand.raw) &&
          /\$(?:[@*0-9]|\{[@*0-9])/.test(literalValue(operand.raw))
        ) {
          uncertain ||= fedByXargs;
          scripts.push({ script: rest.map((word) => word.raw).join(' '), replace: null });
          if (rest.length > 1) {
            scripts.push({
              script: rest
                .slice(1)
                .map((word) => word.raw)
                .join(' '),
              replace: null,
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
  ): boolean => {
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
            hand(next);
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
            hand(next);
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
        replace = xargsReplace(argv.slice(argv.indexOf(word) + 1, position)) ?? replace;
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
      readShell(args);
    } else if (name === 'script') {
      if (!readOptionString(args, 'c', ['command'], 'EIOBTm')) {
        readsStandardInput();
      }
    } else if (name === 'su' || name === 'runuser') {
      readOptionString(args, 'c', ['command', 'session-command'], 'sgGw');
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
      const at = xargsCommandIndex(args);
      const run = args[at];
      if (run !== undefined && xargsRunsItsInput(argv0Name(run.raw), args.slice(at + 1))) {
        reasons.add(UNCERTAINTY.xargsArguments);
      }
    } else if (name === 'hash' && optionWords(args).some((option) => /^-[A-Za-z]*p/.test(option))) {
      // `hash -p FILE NAME` makes `NAME` run `FILE` (WP-161 criterion (12), backlog 522).
      reasons.add(UNCERTAINTY.reboundName);
    }
  }
  return { scripts, uncertain, reasons: [...reasons] };
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
const canonicalShellStage = (stage: string): string =>
  // A pipeline stage always carries at least one token: `scan` drops the empty ones.
  SCRIPT_SHELLS.has(argv0Name(tokenise(stage)[0] as string)) ? 'sh' : stage;

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
}

/**
 * Parses a command line into everything the shell would run, plus what the scanner could not
 * follow. Recurses through substitution bodies and wrapped scripts, so nesting is walked to the
 * bottom rather than to a fixed depth.
 *
 * `scripted` is true when an enclosing level runs a script reader, so a here-document body here
 * may be what it runs (`sh -c "$(cat <<'EOF' …)"`).
 */
const parseCommand = (
  command: string,
  depth = 0,
  scripted = false,
  replace: string | null = null,
  fed = false,
): Parsed => {
  const fragments: string[] = [];
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
      const nested = parseCommand(hereDocument.body, depth + 1, true, replace, fed);
      fragments.push(...nested.fragments);
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
  const piped =
    fed ||
    scan(command, PIPE_OPERATORS).segments.length > 1 ||
    /(?:^|[\s;&|(){}])exec\b[^\n;&|]*</.test(joinContinuations(command));
  for (const [segmentIndex, segment] of outer.segments.entries()) {
    fragments.push(segment);
    const pipeline = scan(segment, PIPE_OPERATORS);
    for (const stage of pipeline.segments) {
      if (stageEvaluatesText(stage, test)) {
        uncertainty.add(UNCERTAINTY.evaluatedText);
      }
      // WP-161 (d) and (f): the peel the block list reads stopped at its bound, or the command's
      // name — or a wrapper's — is one the shell expands.
      if (argvStarts(tokenise(stage)).tooDeep) {
        uncertainty.add(UNCERTAINTY.tooDeep);
      }
      if (expandsCommandName(stage)) {
        uncertainty.add(UNCERTAINTY.expandedName);
      }
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
      if (storesCommand(stage)) {
        uncertainty.add(UNCERTAINTY.handedCommand);
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
      for (const { script, replace: inner } of handed.scripts) {
        if (depth >= MAX_WRAPPER_DEPTH) {
          // Nested past the bound: not read, so not certain (rule 5).
          uncertainty.add(UNCERTAINTY.handedCommand);
          continue;
        }
        const nested = parseCommand(script, depth + 1, readsScripts, inner ?? replace, stagePiped);
        anyReadsScripts ||= nested.readsScripts;
        fragments.push(script, ...nested.fragments);
        writeTargets.push(...nested.writeTargets);
        substitutes ||= nested.substitutes;
        for (const reason of nested.uncertainty) {
          uncertainty.add(reason);
        }
      }
    }
  }

  // WP-160 (e): after a here-document the walk did not recognise, bash resumes at its own
  // terminator from a fresh quote state, and so does this. The text is strictly shorter, and each
  // level spawns one such read, so the chain ends; its bodies are not this level's data.
  if (outer.resumeFrom !== null) {
    const resumed = parseCommand(command.slice(outer.resumeFrom), depth, scripted, replace, fed);
    anyReadsScripts ||= resumed.readsScripts;
    fragments.push(...resumed.fragments);
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
      );
      anyReadsScripts ||= nested.readsScripts;
      // The substitution as a fragment of its own is its text with its data bodies left out, so
      // a body line never reaches the block list as part of `cat <<'EOF' … EOF` (ruling (b)).
      fragments.push(withoutRanges(substitution, nested.bodyRanges), ...nested.fragments);
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
 * quoting and escaping taken off (`unquoteToken`). The unattended git boundary reads these.
 */
export const commandWords = (fragment: string): readonly string[] =>
  tokenise(fragment).map(unquoteToken);

/**
 * The argv lists one fragment could really run as — the **block** list's generous reading (rule 2):
 * every leading wrapper and assignment peeled in turn, argv[0] reduced to its basename, every word
 * dequoted. The unattended git boundary judges each, so `env git push …`, `nice -n 5 git push …` and
 * `GIT_TRACE=1 git push …` are all a `git push`.
 */
export const commandArgvCandidates = (fragment: string): readonly (readonly string[])[] =>
  argv0Candidates(tokenise(fragment))
    .filter((candidate) => candidate.length > 0)
    .map(([name, ...rest]) => [name as string, ...rest.map(unquoteToken)]);

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
): CommandEvaluation => {
  if ((fallback as CommandVerdict) === 'allow') {
    throw new PolicyViolationError(
      'command.policy',
      'the fallback verdict may not be "allow": it is also the floor an unmatched or unparseable command lands on (product/19 §3, rules 4 and 5)',
    );
  }
  const parsed = parseCommand(request.command);
  const floor = (evaluation: Omit<CommandEvaluation, 'uncertainty'>): CommandEvaluation => ({
    ...evaluation,
    verdict:
      parsed.uncertainty.length > 0
        ? mostRestrictive(evaluation.verdict, fallback)
        : evaluation.verdict,
    uncertainty: parsed.uncertainty,
  });

  if (parsed.fragments.length === 0) {
    // Nothing runnable: an empty command, or only operators. Never `allow`.
    return { verdict: fallback, matched: null, segment: null, uncertainty: parsed.uncertainty };
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
        uncertainty: parsed.uncertainty,
      };
    }
  }

  const candidates: string[] = [line, ...parsed.fragments];
  if (request.resolvedBinary !== undefined) {
    // argv[0] replaced by what it really resolves to, so `tf apply` is judged as `terraform apply`.
    const tokens = tokenise(line);
    candidates.push([basename(request.resolvedBinary), ...tokens.slice(1)].join(' '));
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
      uncertainty: parsed.uncertainty,
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
          uncertainty: parsed.uncertainty,
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
