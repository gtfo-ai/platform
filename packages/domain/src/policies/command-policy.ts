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
 *     wrapper is handed (`sh -c '…'`, `eval '…'`, or a here-document a shell reads). The most
 *     restrictive verdict of all wins.
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
 *     does not read is named below, under *A variable's text is code*, and nowhere else.
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
 * expansions (`unrecognisedUnquotedOperator`, WP-158).
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
 * a wrapper's options (`command -p`, `time -p`, `--`) and `coproc`. **What it still does not read:** a builtin
 * that runs a *string* as code (`trap '…' EXIT`, `PS4` under `bash -x`, `PROMPT_COMMAND`,
 * `bind -x`, `complete -C`), an option's value attached to its option (`read -aNAME`), a name taken
 * by a builtin it does not list (`getopts`, `wait -p`, `exec {var}>…`), and an attribute (`-i`,
 * `-n`) given to a variable outside the line.
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
  evaluatedText: `an expansion or command that evaluates a variable's text as code (a subscript or offset that is not a plain number, \${x@…}, \${!x}, $[…], ((…)), let, declare -i or -n, a [[ … -eq … ]] or -v test, a variable name built from an expansion) — write the value literally; the platform cannot read an expansion that evaluates a variable's text`,
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
  {
    pattern: 'git * --exec*',
    kind: 'command',
    hazard:
      "--exec is git push's synonym for --receive-pack, and git fetch-pack's for --upload-pack; it is not scoped to a subcommand because the next verb to grow one would be missed",
  },
  {
    pattern: 'git * --extcmd*',
    kind: 'command',
    hazard: 'git difftool and mergetool run --extcmd (-x) once per changed file',
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

// ── pattern matching ─────────────────────────────────────────────────────────

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/** Collapses whitespace so `npm  test` and `npm test` are the same command. */
export const normaliseCommand = (command: string): string => command.trim().replace(/\s+/g, ' ');

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

/** Shells that take a script as an argument. */
const SHELL_NAMES: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash']);

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

/** How many suffixes to try past a wrapper prefix; a shell line is never this deep in practice. */
const MAX_WRAPPER_DEPTH = 8;

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
 * a wrapper's own flags and their values (`nice -n 5 sudo id`) sit between the two commands.
 */
const argv0Candidates = (tokens: readonly string[]): readonly (readonly string[])[] => {
  const withBasename = (list: readonly string[]): readonly string[] =>
    list.length === 0 ? list : [argv0Name(list[0] as string), ...list.slice(1)];

  const candidates: (readonly string[])[] = [withBasename(tokens)];
  const head = tokens[0];
  if (head !== undefined && isWrapperToken(head)) {
    for (let start = 1; start < tokens.length && start <= MAX_WRAPPER_DEPTH; start += 1) {
      candidates.push(withBasename(tokens.slice(start)));
    }
  }
  return candidates;
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
 * backslash or mixed quoting is **not recognised** — its body stays commands, today's reading.
 *
 * **The boundary is bash's own metacharacters — space, tab, newline, `;&|)<>` — and never `\s`.**
 * JavaScript's `\s` also matches `\r`, `\f`, `\v` and NBSP, which bash keeps inside the word: on a
 * CRLF line `cat <<'EOF'\r` the delimiter is `EOF\r`, the body ends at the line `EOF\r`, and bash
 * 5.2 runs the next line (measured for all four, WP-153 review round 1). Read with `\s`, the
 * delimiter was `EOF` and that line stayed in the body. `(` is a metacharacter too, but `<<EOF(`
 * is a syntax error, so it is left out: not recognising costs the old reading (and, for an unquoted
 * word, a would-be body read for its expansions — `unrecognisedUnquotedOperator`, WP-158).
 */
const HERE_DOCUMENT_OPERATOR =
  /^<<(-?)[ \t]*(?:'([A-Za-z0-9_.-]+)'|"([A-Za-z0-9_.-]+)"|([A-Za-z0-9_.-]+))(?=$|[ \t\n;&|)<>])/;

/**
 * Text before an operator that puts it where the shell may **not** read a here-document: a
 * parameter expansion (`${x:-<<EOF}`), an arithmetic command or old-style expansion (`((x<<y))`,
 * `$[1<<2]`), a `[[ … ]]` test, or a comment (`# <<EOF`). Each was measured on bash 5.2 to run the
 * line after it, so a reader that skipped that line would hide a command. Matched on everything the
 * walker has read before the operator — quoted text included, bodies already skipped excluded — so
 * it errs towards not recognising, whose cost is the old reading — plus, for an unquoted word, a
 * would-be body read for its expansions (`unrecognisedUnquotedOperator`). Its `\s` is wider than bash's
 * blanks on purpose: a wider "word start" finds more comments, and so recognises less.
 */
const HERE_DOCUMENT_CONTEXT = /\$\{|\$\[|\(\(|\[\[|(?:^|[\s;&|()<>])#/;

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
  HERE_DOCUMENT_CONTEXT.test(before) ? null : hereDocumentOperatorShape(text, index);

/**
 * A `<<` the reader does **not** recognise but bash may read as an **unquoted** here-document
 * (WP-158, found by the shell oracle). Not recognising was taken to cost only the old reading — the
 * lines after it read as commands — but an unquoted body expands a `$(…)` that the old reading
 * takes for single-quoted text: `echo ${HOME}; cat <<EOF` + `x='$(cmd)'` + `EOF` (the context guard
 * refuses after any `${`, closed or not, and after a comment on an earlier line) and `cat <<EOF\r`
 * + `x='$(cmd)'` + `EOF\r` (the word boundary refuses `\r`) each ran `cmd` in bash 5.2 and in dash,
 * and each was `unattended_auto` (measured). So such an operator's would-be body is
 * read **both ways**: as commands, as before, and as a body whose expansion is uncertain
 * (`hereDocumentUncertainty`, an unterminated body aside). Its delimiter is bash's: the word up to a
 * metacharacter, taken literally, since a word with no quoting is not expanded as a delimiter; a
 * word with a quote or a backslash makes the body literal, and nothing is read.
 */
const unrecognisedUnquotedOperator = (
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
  const match = /^<<(-?)[ \t]*([^ \t\n;&|()<>]+)/.exec(text.slice(index));
  if (match === null || /['"\\]/.test(match[2] as string)) {
    return null;
  }
  return {
    delimiter: match[2] as string,
    quoted: false,
    stripTabs: match[1] === '-',
    length: match[0].length,
  };
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
  if (text.slice(pendingFrom, newline).includes('\n')) {
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
  scan(stage, [' ', '\t']).segments.filter((word) => !/^[0-9]*[<>&]/.test(word));

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
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'ash',
  'rbash',
  'busybox',
  'fish',
  'csh',
  'tcsh',
  'eval',
  'source',
]);

/**
 * Does this segment run something that reads a script (a shell, `eval`, `source`, `.`, or a name
 * the shell expands)? The split's `\s` is wider than bash's blanks on purpose: it cuts `sh\r` out
 * as `sh`, so it finds more readers, and a reader found is only the old reading.
 */
const feedsScriptReader = (segment: string): boolean =>
  segment
    .split(/[\s|&;()<>]+/)
    .some((word) => word.length > 0 && HERE_DOCUMENT_SCRIPT_READERS.has(argv0Name(word))) ||
  scan(segment, PIPE_OPERATORS).segments.some((stage) =>
    argv0Candidates(tokenise(stage)).some(([name]) => name === '.' || /[*?[{]/.test(name ?? '')),
  );

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

  const push = (): void => {
    const segment = current.trim();
    if (segment.length > 0) {
      segments.push(segment);
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
      // Not skipped, but its would-be body is read for expansions at the newline (WP-158).
      const refused = unrecognisedUnquotedOperator(command, index, before);
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
        // The refused operators' would-be bodies, read for their expansion only; nothing skipped.
        for (const body of hereDocumentsAtNewline(command, index, shadow, shadowFrom).bodies) {
          for (const reason of hereDocumentUncertainty(body)) {
            if (reason !== UNCERTAINTY.unterminatedHereDocument) {
              uncertainty.add(reason);
            }
          }
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
          continue;
        }
      }
      index += operator.length;
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
  push();
  return {
    segments,
    substitutions,
    substitutionOffsets,
    writeTargets,
    uncertainty: [...uncertainty],
    hereDocuments,
    bodyRanges,
  };
};

/** The script a shell wrapper is handed: `sh -c '…'`, `bash -c "…"`, `eval '…'`. */
const wrappedScript = (segment: string): string | null => {
  const tokens = tokenise(segment);
  const head = tokens[0];
  if (head === undefined) {
    return null;
  }
  const name = argv0Name(head);
  const unquote = (text: string): string => (/^(['"]).*\1$/s.test(text) ? text.slice(1, -1) : text);
  if (name === 'eval') {
    return tokens.length > 1 ? unquote(tokens.slice(1).join(' ')) : null;
  }
  if (!SHELL_NAMES.has(name)) {
    return null;
  }
  // `"-c"` is still `-c` to the shell that receives it.
  const flagIndex = tokens.findIndex((token) => unquoteToken(token) === '-c');
  const script = flagIndex === -1 ? undefined : tokens[flagIndex + 1];
  return script === undefined ? null : unquote(tokens.slice(flagIndex + 1).join(' '));
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
  SHELL_NAMES.has(argv0Name(tokenise(stage)[0] as string)) ? 'sh' : stage;

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
const parseCommand = (command: string, depth = 0, scripted = false): Parsed => {
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
      const nested = parseCommand(hereDocument.body, depth + 1, true);
      fragments.push(...nested.fragments);
      writeTargets.push(...nested.writeTargets);
      substitutes ||= nested.substitutes;
      for (const reason of nested.uncertainty) {
        uncertainty.add(reason);
      }
    }
  }
  if (!readsScripts) {
    bodyRanges.push(...outer.bodyRanges);
  }

  const test: TestState = { inside: false };
  for (const segment of outer.segments) {
    fragments.push(segment);
    const pipeline = scan(segment, PIPE_OPERATORS);
    for (const stage of pipeline.segments) {
      if (stageEvaluatesText(stage, test)) {
        uncertainty.add(UNCERTAINTY.evaluatedText);
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
    const script = depth < MAX_WRAPPER_DEPTH ? wrappedScript(segment) : null;
    if (script !== null && script !== segment) {
      const nested = parseCommand(script, depth + 1, readsScripts);
      anyReadsScripts ||= nested.readsScripts;
      fragments.push(script, ...nested.fragments);
      writeTargets.push(...nested.writeTargets);
      substitutes ||= nested.substitutes;
      for (const reason of nested.uncertainty) {
        uncertainty.add(reason);
      }
    }
  }

  for (const [position, substitution] of outer.substitutions.entries()) {
    if (depth < MAX_WRAPPER_DEPTH) {
      const nested = parseCommand(substitution, depth + 1, readsScripts);
      anyReadsScripts ||= nested.readsScripts;
      // The substitution as a fragment of its own is its text with its data bodies left out, so
      // a body line never reaches the block list as part of `cat <<'EOF' … EOF` (ruling (b)).
      fragments.push(withoutRanges(substitution, nested.bodyRanges), ...nested.fragments);
      writeTargets.push(...nested.writeTargets);
      const offset = outer.substitutionOffsets[position] as number;
      bodyRanges.push(
        ...nested.bodyRanges.map(([start, end]) => [start + offset, end + offset] as const),
      );
      for (const reason of nested.uncertainty) {
        uncertainty.add(reason);
      }
    } else {
      fragments.push(substitution);
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
