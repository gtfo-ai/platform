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
 *     wrapper is handed (`sh -c '…'`, `eval '…'`). The most restrictive verdict of all wins.
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
 *  4. **An unmatched command is `ask`, never `allow`** (product/19 §3: "everything else → ask").
 *     Two things floor an otherwise allowed line at `ask`: a redirection that writes to a path,
 *     and an argument on `HAZARDOUS_ARGUMENTS` — the flag that hands an allow-listed verb an
 *     arbitrary command, an arbitrary path to write, or an unread package source.
 *  5. **Parse uncertainty fails closed.** A hand-rolled shell scanner is never complete, so it
 *     says when it is out of its depth (`CommandEvaluation.uncertainty`) and an uncertain line can
 *     never be `allow`. See `UNCERTAINTY` for the exhaustive list of constructs that trip it.
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
import type { CommandPolicy } from '@platform/contracts';
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
    verdict: 'ask (nothing on the allow-list matches `rm`), never allow',
  },
  {
    hazard: 'branch deletion in long form — `git branch --delete --force main`',
    stated: 'git branch -D *',
    verdict: 'ask, never allow',
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

/** product/19 §3, read-only stages: exploration commands, nothing that writes. */
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
];

/** product/19 §3, Implementation: the project's own commands plus safe git and lockfile installs. */
export const DEFAULT_IMPLEMENTATION_ALLOW: readonly string[] = [
  ...DEFAULT_READ_ONLY_ALLOW,
  'git add *',
  'git commit *',
  'git push origin agentic/*',
  'git rebase',
  'git rebase *',
  'git fetch',
  'git fetch *',
  'npm ci',
  'pnpm install --frozen-lockfile',
  'pip install -r *',
];

/**
 * product/19 §3, Implementation: dependency additions and anything that leaves the workspace.
 *
 * The `-exec` family is here rather than on the allow-list because it turns a safe command into an
 * arbitrary-command runner: `find … -exec` runs a command per match and `git rebase -x/--exec` runs
 * one per commit. The plain verbs stay allowed — product/19 §3 allows both, and the rebase gate
 * (WP-26) rebases on every task's happy path — because these ask entries are more specific and so
 * win the tie against them.
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

export interface HazardousArgument {
  /** Matched exactly like a block pattern: tokens (flag anywhere) or the whole line as a glob. */
  readonly pattern: string;
  /** What the argument hands the verb that the policy has not read. */
  readonly hazard: string;
}

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
    hazard:
      'git runs the --upload-pack value as a shell command on the far end, and with a local path as the remote that far end is this machine',
  },
  {
    pattern: 'git * --receive-pack*',
    hazard: 'the push-side twin of --upload-pack, and equally a shell command',
  },
  {
    pattern: 'git * --exec*',
    hazard:
      "--exec is git push's synonym for --receive-pack, and git fetch-pack's for --upload-pack; it is not scoped to a subcommand because the next verb to grow one would be missed",
  },
  {
    pattern: 'git * --extcmd*',
    hazard: 'git difftool and mergetool run --extcmd (-x) once per changed file',
  },
  {
    pattern: 'git * --ext-diff*',
    hazard:
      "--ext-diff turns on the external diff driver the *repository's own* config names, and a repository is untrusted input (BD-022)",
  },
  {
    pattern: 'git * --textconv*',
    hazard: "--textconv runs the textconv filter the repository's config names (BD-022)",
  },
  {
    pattern: 'git * ext::*',
    hazard:
      "git's ext:: transport runs its argument as a shell command; it is refused unless protocol.ext.allow is set, which is the workspace's configuration and not this module's to promise",
  },
  {
    pattern: 'rg * --pre*',
    hazard: 'ripgrep runs the --pre command over every file it searches',
  },
  {
    pattern: 'rg * --hostname-bin*',
    hazard: 'ripgrep runs the --hostname-bin command to label hyperlinks',
  },
  // ── writes a path that the `> file` rule never sees ──
  {
    pattern: 'git * --output*',
    hazard: "git's diff family writes --output to any path, redirection-free",
  },
  {
    pattern: 'find * -fprint*',
    hazard: 'GNU find writes -fprint/-fprintf/-fprint0 to any path, redirection-free',
  },
  { pattern: 'find * -fls*', hazard: 'GNU find -fls writes a listing to any path' },
  {
    pattern: 'pip install* --target*',
    hazard: 'installs into any directory, redirection-free',
  },
  { pattern: 'pip install* --root*', hazard: 'installs under any root, redirection-free' },
  { pattern: 'pip install* --prefix*', hazard: 'installs under any prefix, redirection-free' },
  { pattern: 'pip install* --log*', hazard: 'writes a log to any path, redirection-free' },
  { pattern: 'pip install* --report*', hazard: 'writes a report to any path, redirection-free' },
  // ── widens what the verb trusts ──
  {
    pattern: 'git push* *:*',
    hazard:
      'a refspec pushes to a destination ref of its own choosing, so `git push origin agentic/x:main` writes main under an allow entry that names only agentic/*; a remote spelled as a URL is caught by the same colon',
  },
  {
    pattern: 'git commit* --no-verify*',
    hazard:
      'skips the pre-commit hooks, which is where a repository runs its secret scan (BD-002) and its formatter',
  },
  { pattern: 'git commit* -n*', hazard: 'the short spelling of --no-verify' },
  {
    pattern: 'pip install* --index-url*',
    hazard: 'installs from a package index nobody has read (BD-030)',
  },
  {
    pattern: 'pip install* --extra-index-url*',
    hazard: 'adds a package index nobody has read (BD-030)',
  },
  {
    pattern: 'pip install* --find-links*',
    hazard: 'adds a package source nobody has read (BD-030)',
  },
  {
    pattern: 'pip install -r http*',
    hazard:
      'the allow entry `pip install -r *` is meant to be a lockfile install; a requirements file fetched over the network is not one',
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
  normaliseCommand(pattern).replace(/\*/g, '').length;

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

/**
 * The first `HAZARDOUS_ARGUMENTS` entry this piece of command line carries, if any. Its only
 * effect is to floor the verdict at `ask` (see `evaluateCommand`).
 */
export const hazardousArgument = (command: string): HazardousArgument | undefined =>
  HAZARDOUS_ARGUMENTS.find((entry) => matchesBlockPattern(entry.pattern, command));

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
}

/** Index of the `)` closing the `(` at `openIndex`, honouring quotes, or -1 when unbalanced. */
const findClosingParen = (text: string, openIndex: number): number => {
  let depth = 0;
  let quote: '"' | "'" | null = null;
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

/** Whether a redirection target is a real file rather than a descriptor or the bit bucket. */
const isWriteTarget = (target: string): boolean =>
  target.length > 0 && !target.startsWith('&') && target !== '/dev/null';

/**
 * One quote-aware pass over a command line, splitting on `operators`.
 *
 * Single quotes protect everything; double quotes protect the operators but *not* substitution,
 * because the shell still runs it there. Anything the scanner cannot follow is reported in
 * `uncertainty` rather than guessed at.
 */
const scan = (command: string, operators: readonly string[]): ScanResult => {
  const segments: string[] = [];
  const substitutions: string[] = [];
  const writeTargets: string[] = [];
  const uncertainty = new Set<UncertaintyReason>();
  let current = '';
  let inDouble = false;
  let index = 0;

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
      const close = findClosingParen(command, index + 1);
      if (close === -1) {
        uncertainty.add(UNCERTAINTY.unterminatedSubstitution);
        substitutions.push(command.slice(index + 2));
        index = command.length;
        continue;
      }
      substitutions.push(command.slice(index + 2, close));
      index = close + 1;
      continue;
    }

    if (char === '`') {
      const close = command.indexOf('`', index + 1);
      if (close === -1) {
        uncertainty.add(UNCERTAINTY.unterminatedBacktick);
        substitutions.push(command.slice(index + 1));
        index = command.length;
        continue;
      }
      substitutions.push(command.slice(index + 1, close));
      index = close + 1;
      continue;
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
        target = '&';
        cursor += 1;
        while (cursor < command.length && /[\d-]/.test(command[cursor] as string)) {
          target += command[cursor];
          cursor += 1;
        }
      }
      if (isWriteTarget(target)) {
        writeTargets.push(target);
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
      index += operator.length;
      continue;
    }
    current += char;
    index += 1;
  }

  if (inDouble) {
    uncertainty.add(UNCERTAINTY.unbalancedQuote);
  }
  push();
  return { segments, substitutions, writeTargets, uncertainty: [...uncertainty] };
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
}

/**
 * Parses a command line into everything the shell would run, plus what the scanner could not
 * follow. Recurses through substitution bodies and wrapped scripts, so nesting is walked to the
 * bottom rather than to a fixed depth.
 */
const parseCommand = (command: string, depth = 0): Parsed => {
  const fragments: string[] = [];
  const uncertainty = new Set<UncertaintyReason>();
  const outer = scan(command, LIST_OPERATORS);
  for (const reason of outer.uncertainty) {
    uncertainty.add(reason);
  }
  const writeTargets = [...outer.writeTargets];

  for (const segment of outer.segments) {
    fragments.push(segment);
    const pipeline = scan(segment, PIPE_OPERATORS);
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
      const nested = parseCommand(script, depth + 1);
      fragments.push(script, ...nested.fragments);
      writeTargets.push(...nested.writeTargets);
      for (const reason of nested.uncertainty) {
        uncertainty.add(reason);
      }
    }
  }

  for (const substitution of outer.substitutions) {
    fragments.push(substitution);
    if (depth < MAX_WRAPPER_DEPTH) {
      const nested = parseCommand(substitution, depth + 1);
      fragments.push(...nested.fragments);
      writeTargets.push(...nested.writeTargets);
      for (const reason of nested.uncertainty) {
        uncertainty.add(reason);
      }
    }
  }

  return { fragments: [...new Set(fragments)], writeTargets, uncertainty: [...uncertainty] };
};

/**
 * Every fragment of a command line that the shell would run as a command in its own right.
 *
 * This is a conservative approximation of a shell parser, not a shell parser: its job is to stop
 * an allow-listed prefix from smuggling a second command past the policy. What it cannot follow it
 * reports (see `commandUncertainty`), and an uncertain line can never be `allow`.
 */
export const splitCommandSegments = (command: string): readonly string[] =>
  parseCommand(command).fragments;

/** Does the command redirect output to a path (`> file`), rather than to a descriptor or `/dev/null`? */
export const hasOutputRedirection = (command: string): boolean =>
  parseCommand(command).writeTargets.length > 0;

/** The constructs in this command that the scanner will not reason about (rule 5). */
export const commandUncertainty = (command: string): readonly UncertaintyReason[] =>
  parseCommand(command).uncertainty;

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
  ): string | undefined =>
    against
      .map((form) => bestMatch(patterns, form, matchesCommandPattern))
      .filter((match): match is string => match !== undefined)
      .sort((a, b) => specificity(b) - specificity(a))[0];
  const asked = mostSpecific(policy.ask, askForms);
  const allowed = mostSpecific(policy.allow, forms);
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

  const candidates: string[] = [request.command, ...parsed.fragments];
  if (request.resolvedBinary !== undefined) {
    // argv[0] replaced by what it really resolves to, so `tf apply` is judged as `terraform apply`.
    const tokens = tokenise(request.command);
    candidates.push([basename(request.resolvedBinary), ...tokens.slice(1)].join(' '));
  }

  // The whole command is evaluated with no fallback: only an explicit match may speak for it,
  // otherwise a single unmatched fragment would be masked by the whole line's fallback.
  let result = evaluateOne(request.command, policy, 'allow');
  for (const candidate of candidates.slice(1)) {
    const evaluation = evaluateOne(candidate, policy, fallback);
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
  /** Allow entries the layer asked for that the organisation maximum does not grant. */
  readonly ignoredAllow: readonly string[];
}

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

/**
 * Applies a lower-precedence layer (project settings, then `.agentic/config.yml`) to the
 * organisation maximum.
 *
 * - `allow` may only shrink: an entry the maximum does not grant is reported in `ignoredAllow`
 *   and dropped ("entries added to `allow` that the org does not allow are ignored by the merge").
 * - `ask` and `block` may only grow; `block` always wins over both other lists.
 */
export const narrowCommandPolicy = (
  maximum: ResolvedCommandPolicy,
  layer: CommandPolicy | undefined,
): NarrowedCommandPolicy => {
  const layerAllow = layer?.allow;
  const ignoredAllow =
    layerAllow === undefined ? [] : layerAllow.filter((entry) => !maximum.allow.includes(entry));
  const block = unique([...maximum.block, ...(layer?.block ?? [])]);
  const ask = unique([...maximum.ask, ...(layer?.ask ?? [])]).filter(
    (entry) => !block.includes(entry),
  );
  const allow = (
    layerAllow === undefined
      ? maximum.allow
      : maximum.allow.filter((entry) => layerAllow.includes(entry))
  ).filter((entry) => !ask.includes(entry) && !block.includes(entry));

  return { policy: { allow: unique(allow), ask, block }, ignoredAllow };
};
