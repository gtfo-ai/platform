/**
 * What an **unattended** run does with a command — BD-025's 2026-10-06 amendment, the product
 * owner's decision from the first local test: *"it always runs in automode because of unattended …
 * we will never wait for permissions so it runs in sandbox/automode."*
 *
 * `evaluateCommand` answers `allow`, `ask` or `block`. An unattended run has nobody to ask, so this
 * module turns the three into two — `allow` or `deny` — and says, in words the model can act on,
 * which fragment of the line failed which rule. It **never loosens** what `evaluateCommand` decided
 * in three places, whatever the mode:
 *
 *  1. **`block` is `deny`.** The block list is the organisation's and the platform's *never*.
 *  2. **An uncertain line is `deny`** (module rule 5 of `command-policy.ts`): a line the scanner
 *     cannot follow cannot be shown to be the line it reads as, so it is not run.
 *  3. **A `command` or `trust` hazard is `deny`** (`HazardousArgument.kind`): each names a specific
 *     way an argument turns a verb into a program the policy has not read, or widens what it
 *     trusts. A `path` hazard runs under `auto`, like any other write in the workspace.
 *
 * and it **adds** a fourth check the three lists never made, applied to `allow` as well as to `ask`:
 *
 *  4. **The git boundary** ({@link gitBoundaryViolation}). The git host is the one place the
 *     sandbox can reach that holds other people's data, and the run's credential is answered for
 *     that host by the credential helper. So a push goes only to `origin`, only to branches under
 *     `agentic/` named literally; a fetch, pull, clone or `ls-remote` names `origin` or nothing;
 *     no remote is added, renamed or re-pointed; no git configuration of a remote, a URL rewrite, a
 *     credential, a hook path, an SSH command or an alias is written, on the command line (`-c`),
 *     in the environment (`GIT_CONFIG_*`, `GIT_SSH_COMMAND`, …) or in `.git/`; `git credential` and
 *     the helper and its socket (`/ctl/…`) are not touched; and a command whose **name** is
 *     computed at run time (`$X …`, `$(…) …`) is not run, because the policy cannot read it.
 *
 * Everything else that `evaluateCommand` answers `ask` — an ask-list match, an unmatched command,
 * a redirection to a path — **runs under `auto`** and is refused under `deny`.
 *
 * ## What the git boundary is, and what it is not
 *
 * It is a reading of the command line, and the command line is not the only way to run git: under
 * `auto` an unmatched command runs, so `python3 -c '…subprocess…'` or a script the run wrote can
 * spell any of the refused commands where no pattern sees them. **The control that holds whatever
 * the spelling is the credential**: the run's credential is answered only for the project's git
 * host, by exact comparison (`RunCredentialBroker.answer`), and only while the run is live; the
 * egress allow-list admits the model host, the project's git host and the registries an operator
 * declared. What the host check does **not** bound is the repository *path* on that host — git does
 * not send it to the helper unless `credential.useHttpPath` is set, and the broker does not compare
 * it — so a credential that reaches other repositories on the same host (a dedicated user's or the
 * operator's own static token, BD-025's 2026-10-03/04 amendments) reaches them from any spelling
 * this module does not read. A minted project access token and a deploy key are scoped to the
 * project by the provider. That residual is PROGRESS backlog 481, and the boundary here narrows what
 * a model writes in the ordinary way; it is not the boundary of what a run can do.
 */
import type { UnattendedCommandMode } from '@platform/contracts';
import {
  type CommandEvaluation,
  type CommandRequest,
  commandArgvCandidates,
  commandWords,
  commandWriteTargets,
  evaluateCommand,
  GIT_GLOBAL_VALUE_OPTIONS,
  type HazardousArgument,
  type HereDocumentOperator,
  hazardousArguments,
  hereDocumentsAtNewline,
  type ResolvedCommandPolicy,
  readHereDocumentOperator,
  readsHereDocumentsAsScripts,
  splitCommandSegments,
  withoutHereDocumentBodies,
} from './command-policy.js';

/** Which rule decided an unattended command. */
export type UnattendedCommandRule =
  /** The allow list matched, and nothing below refused it. */
  | 'allow_list'
  /** `ask`, run because the run is sandboxed (`auto`). */
  | 'unattended_auto'
  /** `ask`, refused because the project runs unattended commands in `deny` mode. */
  | 'unattended_deny'
  | 'block_list'
  | 'uncertain'
  | 'hazardous_argument'
  | 'git_boundary';

export interface UnattendedCommandDecision {
  readonly decision: 'allow' | 'deny';
  readonly rule: UnattendedCommandRule;
  /** What `evaluateCommand` said, unchanged. */
  readonly evaluation: CommandEvaluation;
  /** The piece of the line the decision came from, when one did. */
  readonly fragment: string | null;
  /**
   * The reason — written to the transcript's `hook` row, and on a deny the text the model reads
   * (the CLI hands a `PreToolUse` deny's reason to the model verbatim; measured against CLI
   * 2.1.267, 2026-10-06). Platform text around the model's own command.
   */
  readonly reason: string;
}

/** A refusal of the git boundary: the fragment, and what it would have done. */
export interface GitBoundaryViolation {
  readonly fragment: string;
  readonly detail: string;
}

// ── the git boundary ─────────────────────────────────────────────────────────

/**
 * Git configuration a run may not write: where a remote points and what it pushes (`remote.*`,
 * `branch.<b>.remote|pushremote|merge`, `push.*` — `push.pushOption` can say `ci.skip`), URL
 * rewrites (`url.<base>.insteadOf`), credentials and HTTP headers (`credential.*`, `http.*` —
 * `http.extraHeader` carries an `Authorization`), transports (`protocol.*`), commands git runs
 * (`core.sshCommand`, `core.gitProxy`, `core.askPass`, `core.fsmonitor`, `core.hooksPath`,
 * `alias.*` — an alias starting `!` is a shell command), configuration it includes
 * (`include.*`, `includeIf.*`) and submodule sources (`submodule.*`, `fetch.recurseSubmodules`).
 * Section and variable names are case-insensitive in git, so the key is compared lower-cased.
 */
const GUARDED_CONFIG_SECTION =
  /^(?:remote|url|credential|http|protocol|include|includeif|alias|push|submodule)(?:\.|$)/;
const GUARDED_CONFIG_KEY =
  /^(?:core\.(?:sshcommand|gitproxy|askpass|fsmonitor|hookspath)|branch\..+\.(?:remote|pushremote|merge)|fetch\.recursesubmodules)$/;

/** Is this a git configuration key (or section) the run may not set? */
export const isGuardedGitConfigKey = (key: string): boolean => {
  const name = key.trim().toLowerCase();
  return GUARDED_CONFIG_SECTION.test(name) || GUARDED_CONFIG_KEY.test(name);
};

/**
 * Environment variables that configure git's transport, its configuration or where its commands
 * come from: `GIT_CONFIG_COUNT`/`_KEY_<n>`/`_VALUE_<n>`/`_PARAMETERS`/`_GLOBAL`/`_SYSTEM` are
 * `git -c` by another name, `GIT_SSH`/`GIT_SSH_COMMAND`/`GIT_PROXY_COMMAND`/`GIT_ASKPASS`/
 * `SSH_ASKPASS` are commands git runs, `GIT_EXEC_PATH` and `GIT_TEMPLATE_DIR` are where its
 * subcommands and hooks come from, and `GIT_DIR`/`GIT_WORK_TREE` point it at a repository whose
 * remotes are not the workspace's. Matched as an assignment anywhere in a fragment (`X=… git …`,
 * `env X=… git …`, `export X=…`), which over-refuses a word that merely contains one.
 */
const GUARDED_GIT_ENVIRONMENT =
  /^(?:GIT_CONFIG(?:_[A-Z0-9_]+)?|GIT_SSH(?:_COMMAND|_VARIANT)?|GIT_PROXY_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_DIR|GIT_WORK_TREE)=/;

/**
 * The run's control mount (`/ctl`: the credential socket, the ssh-agent socket, the shim's control
 * socket and its token) and the helper binary. Matched on the **raw** line, so a path inside a
 * quoted script (`python3 -c "…'/ctl/cred.sock'…"`) is seen too.
 */
const CONTROL_MOUNT_REFERENCE =
  /(?:^|[^A-Za-z0-9_.~-])\/ctl(?:\/|$|[^A-Za-z0-9_.-])|cred\.sock|ssh-agent\.sock|agentic-runlet/;

/** A branch this run may push: under `agentic/`, written literally, a valid ref name. */
const PUSHABLE_BRANCH = /^agentic\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const isPushableBranch = (ref: string): boolean =>
  PUSHABLE_BRANCH.test(ref) &&
  !ref.includes('..') &&
  !ref.includes('//') &&
  !ref.endsWith('/') &&
  !ref.endsWith('.') &&
  !ref.endsWith('.lock');

/** The only remote a run talks to. */
const ORIGIN = 'origin';

/** `git push` options that only change what is printed, or ask for the upstream to be recorded. */
const PUSH_FLAGS: ReadonlySet<string> = new Set([
  '-u',
  '--set-upstream',
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '--porcelain',
  '--progress',
  '--no-progress',
  '--dry-run',
  '-n',
  '--atomic',
  '--no-atomic',
]);
/** A short-option cluster made only of the flags above (`-uq`). */
const PUSH_FLAG_CLUSTER = /^-[uqvn]+$/;

/**
 * Options of `fetch`, `pull` and `ls-remote` that take the **next** word as their value (git
 * 2.49's `git help fetch|pull|ls-remote`). An option this list does not know is read as a flag, so
 * a value it took is read as the remote and refused — the safe direction.
 */
const FETCH_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--depth',
  '--deepen',
  '--shallow-since',
  '--shallow-exclude',
  '-j',
  '--jobs',
  '--negotiation-tip',
  '--refmap',
  '-o',
  '--server-option',
  '--upload-pack',
  '--exec',
  '--recurse-submodules-default',
  '-s',
  '--strategy',
  '-X',
  '--strategy-option',
]);

/** The same for `clone`, whose short options mean other things (`-o` is `--origin`, `-u` `--upload-pack`). */
const CLONE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-o',
  '--origin',
  '-b',
  '--branch',
  '-u',
  '--upload-pack',
  '--reference',
  '--reference-if-able',
  '--separate-git-dir',
  '--depth',
  '--shallow-since',
  '--shallow-exclude',
  '-j',
  '--jobs',
  '-c',
  '--config',
  '--server-option',
  '--template',
  '--bundle-uri',
]);

/** The words of `args` that are not options, and the options with the value each took. */
const splitGitArgs = (
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
): { readonly positional: readonly string[]; readonly options: readonly [string, string?][] } => {
  const positional: string[] = [];
  const options: [string, string?][] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as string;
    if (word === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (word.startsWith('-') && word.length > 1) {
      if (valueOptions.has(word)) {
        options.push([word, args[index + 1]]);
        index += 1;
      } else {
        options.push([word]);
      }
      continue;
    }
    positional.push(word);
  }
  return { positional, options };
};

/** A source that names another machine: `scheme://…`, `user@host:path`, `ext::…`. */
const isRemoteSource = (source: string): boolean =>
  source.includes('://') || source.startsWith('ext::') || /^[^/]*:/.test(source);

const optionName = (option: string): string => option.split('=')[0] as string;

const refusesRecursion = (options: readonly [string, string?][]): boolean =>
  options.some(
    ([option]) =>
      optionName(option) === '--recurse-submodules' &&
      option !== '--recurse-submodules=no' &&
      option !== '--recurse-submodules=false',
  );

const PUSH_RULE =
  'a run pushes only to `origin`, and only branches under `agentic/` named literally — `git push origin agentic/<key>` (`-u` is fine)';

const checkPush = (args: readonly string[]): string | null => {
  const { positional, options } = splitGitArgs(
    args,
    new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']),
  );
  for (const [option, value] of options) {
    const name = optionName(option);
    if (name === '--repo') {
      if ((option.includes('=') ? option.slice('--repo='.length) : value) !== ORIGIN) {
        return `\`--repo\` names a remote other than \`origin\`; ${PUSH_RULE}`;
      }
      continue;
    }
    if (!PUSH_FLAGS.has(option) && !PUSH_FLAG_CLUSTER.test(option)) {
      return `the push option \`${option}\` is refused (\`--tags\`, \`--all\`, \`--mirror\` and \`--follow-tags\` push refs outside \`agentic/\`, \`-o\`/\`--push-option\` can skip the CI pipeline, \`--force*\` and \`--delete\` rewrite or remove a branch); ${PUSH_RULE}`;
    }
  }
  const [remote, ...refs] = positional;
  if (remote === undefined) {
    return `it names no remote and no branch, so what it pushes depends on the checkout's configuration; ${PUSH_RULE}`;
  }
  if (remote !== ORIGIN) {
    return `\`${remote}\` is not \`origin\` — a URL or another remote reaches a repository that is not this project's; ${PUSH_RULE}`;
  }
  if (refs.length === 0) {
    return `it names no branch, so what it pushes depends on the checkout's configuration; write the branch name literally — ${PUSH_RULE}`;
  }
  const refused = refs.find((ref) => !isPushableBranch(ref));
  if (refused !== undefined) {
    return `\`${refused}\` is not a branch under \`agentic/\` written literally (no \`HEAD\`, no \`src:dst\`, no \`$VARIABLE\` or \`$(…)\`); ${PUSH_RULE}`;
  }
  return null;
};

const FETCH_RULE =
  'fetch, pull and `ls-remote` talk to `origin` only — name it or name nothing (`git fetch origin <branch>`)';

const checkFetchLike = (subcommand: string, args: readonly string[]): string | null => {
  const { positional, options } = splitGitArgs(args, FETCH_VALUE_OPTIONS);
  if (options.some(([option]) => option === '--multiple')) {
    return `\`--multiple\` reads every positional as a remote; ${FETCH_RULE}`;
  }
  if (refusesRecursion(options)) {
    return `\`--recurse-submodules\` fetches each submodule from the URL the repository names, with this run's credential; ${FETCH_RULE}`;
  }
  const [remote] = positional;
  if (remote !== undefined && remote !== ORIGIN) {
    return `\`git ${subcommand}\` names \`${remote}\`, which is not \`origin\` — a URL or another remote reaches a repository that is not this project's; ${FETCH_RULE}`;
  }
  return null;
};

const checkClone = (args: readonly string[]): string | null => {
  const { positional, options } = splitGitArgs(args, CLONE_VALUE_OPTIONS);
  for (const [option, value] of options) {
    const name = optionName(option);
    if (name === '--template') {
      return '`git clone --template` installs hooks from a directory the policy has not read';
    }
    if (name === '-c' || name === '--config') {
      const setting = option.includes('=') ? option.slice(name.length + 1) : (value ?? '');
      if (isGuardedGitConfigKey(setting.split('=')[0] as string)) {
        return `\`git clone ${name} ${setting}\` sets git configuration a run may not write (a remote, a URL rewrite, a credential, a hook or a transport)`;
      }
    }
  }
  if (refusesRecursion(options)) {
    return '`--recurse-submodules` clones each submodule from the URL the repository names, with this run’s credential';
  }
  const [source] = positional;
  if (source !== undefined && isRemoteSource(source)) {
    return `\`git clone ${source}\` reads a repository that is not this project's checkout — the run already has its checkout, and \`git fetch origin\` updates it`;
  }
  return null;
};

const checkRemote = (args: readonly string[]): string | null => {
  const { positional } = splitGitArgs(args, new Set(['-t', '-m']));
  const [verb] = positional;
  if (verb === 'add' || verb === 'set-url' || verb === 'rename') {
    return `\`git remote ${verb}\` changes where a remote points or what it is called, and a run talks to \`origin\` as the platform cloned it`;
  }
  return null;
};

/** `git config` forms that write, in both the legacy and the subcommand syntax. */
const CONFIG_WRITE_OPTIONS: ReadonlySet<string> = new Set([
  '--add',
  '--replace-all',
  '--unset',
  '--unset-all',
  '--rename-section',
  '--remove-section',
]);
const CONFIG_READ_OPTIONS: ReadonlySet<string> = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--get-color',
  '--get-colorbool',
  '-l',
  '--list',
]);
const CONFIG_WRITE_VERBS: ReadonlySet<string> = new Set([
  'set',
  'unset',
  'rename-section',
  'remove-section',
]);

const checkConfig = (args: readonly string[]): string | null => {
  const { positional, options } = splitGitArgs(
    args,
    new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']),
  );
  const names = options.map(([option]) => optionName(option));
  if (names.includes('-e') || names.includes('--edit')) {
    return '`git config --edit` rewrites the configuration file as a whole, which the policy cannot read';
  }
  const [first] = positional;
  const subcommandWrites = first !== undefined && CONFIG_WRITE_VERBS.has(first);
  const subcommandReads = first === 'get' || first === 'list';
  const writes =
    subcommandWrites ||
    (!subcommandReads &&
      (names.some((name) => CONFIG_WRITE_OPTIONS.has(name)) ||
        (!names.some((name) => CONFIG_READ_OPTIONS.has(name)) && positional.length >= 2)));
  if (!writes) {
    return null;
  }
  // The key is the first positional in the legacy syntax and the second after a verb; a section
  // rename names two sections. A value is never read as a key (`git config user.name remote`).
  const keys = subcommandWrites
    ? positional.slice(1, first === 'rename-section' ? 3 : 2)
    : positional.slice(0, names.includes('--rename-section') ? 2 : 1);
  const guarded = keys.find(isGuardedGitConfigKey);
  return guarded === undefined
    ? null
    : `\`git config\` would write \`${guarded}\` — a remote, a URL rewrite, a credential, a hook path, an SSH command, an alias or a transport — and a run may not change where git connects or what it runs`;
};

const checkSubmodule = (args: readonly string[]): string | null => {
  const { positional } = splitGitArgs(args, new Set());
  const [verb] = positional;
  if (verb === undefined || verb === 'status' || verb === 'summary') {
    return null;
  }
  return `\`git submodule ${verb}\` fetches or configures a repository the project names in \`.gitmodules\`, or runs a command in each (\`foreach\`); read \`.gitmodules\` instead`;
};

/** git's plumbing that speaks to another repository directly. */
const REMOTE_PLUMBING =
  /^(?:send-pack|fetch-pack|http-push|http-fetch|upload-pack|receive-pack|upload-archive|remote-.+)$/;

/** Subcommands whose remote is judged by name — and so must be the workspace's repository's. */
const REMOTE_VERBS: ReadonlySet<string> = new Set(['push', 'fetch', 'pull', 'ls-remote', 'remote']);

/** Judges one `git …` argv (argv[0] is `git`, or `git-<subcommand>`). */
const checkGitArgv = (argv: readonly string[]): string | null => {
  const [name, ...rest] = argv as [string, ...string[]];
  let subcommand: string | null = null;
  let args: readonly string[] = [];
  let elsewhere = false;
  if (name !== 'git') {
    subcommand = name.slice('git-'.length);
    args = rest;
  } else {
    for (let index = 0; index < rest.length; index += 1) {
      const word = rest[index] as string;
      const option = optionName(word);
      if (GIT_GLOBAL_VALUE_OPTIONS.has(word) || (word.includes('=') && word.startsWith('--'))) {
        const value = GIT_GLOBAL_VALUE_OPTIONS.has(word)
          ? (rest[index + 1] ?? '')
          : word.slice(option.length + 1);
        if (GIT_GLOBAL_VALUE_OPTIONS.has(word)) {
          index += 1;
        }
        if (option === '-c' || option === '--config-env') {
          const key = value.split('=')[0] as string;
          if (isGuardedGitConfigKey(key)) {
            return `\`git ${option} ${value}\` sets \`${key}\` for this command — a remote, a URL rewrite, a credential, a hook path, an SSH command, an alias or a transport — and a run may not change where git connects or what it runs`;
          }
        }
        if (option === '--exec-path') {
          return '`git --exec-path=<dir>` runs git’s subcommands from a directory the policy has not read';
        }
        if (option === '--git-dir' || option === '--work-tree') {
          elsewhere = true;
        }
        continue;
      }
      if (word.startsWith('-c') && word.length > 2 && !word.startsWith('--')) {
        const key = word.slice(2).split('=')[0] as string;
        if (isGuardedGitConfigKey(key)) {
          return `\`git ${word}\` sets \`${key}\` for this command, and a run may not change where git connects or what it runs`;
        }
        continue;
      }
      if (word.startsWith('-')) {
        continue;
      }
      subcommand = word;
      args = rest.slice(index + 1);
      break;
    }
  }
  if (subcommand === null) {
    return null;
  }
  const verb = subcommand.toLowerCase();
  if (verb.startsWith('credential')) {
    return '`git credential` reads or stores the run’s credential directly; git asks for it by itself when it needs it';
  }
  if (REMOTE_PLUMBING.test(verb)) {
    return `\`git ${verb}\` speaks to another repository directly; use \`git fetch origin\` and \`git push origin agentic/<key>\``;
  }
  if (verb === 'archive' && args.some((arg) => optionName(arg) === '--remote')) {
    return '`git archive --remote` reads a repository that is not this checkout';
  }
  if (elsewhere && REMOTE_VERBS.has(verb)) {
    return `\`--git-dir\`/\`--work-tree\` points \`git ${verb}\` at a repository whose remotes are not the workspace's`;
  }
  switch (verb) {
    case 'push':
      return checkPush(args);
    case 'fetch':
    case 'pull':
    case 'ls-remote':
      return checkFetchLike(verb, args);
    case 'clone':
      return checkClone(args);
    case 'remote':
      return checkRemote(args);
    case 'config':
      return checkConfig(args);
    case 'submodule':
      return checkSubmodule(args);
    default:
      return null;
  }
};

/** The read verbs whose naming a path inside `.git` does not write it. */
const READ_VERBS: ReadonlySet<string> = new Set([
  'cat',
  'ls',
  'head',
  'tail',
  'grep',
  'rg',
  'find',
  'wc',
  'file',
  'stat',
  'less',
  'more',
  'diff',
  'cmp',
  'du',
  'tree',
  'readlink',
  'realpath',
  'basename',
  'dirname',
  'pwd',
  'git',
]);

/** A path naming git's own configuration or hooks: a `.git` segment, `.gitconfig`, `.git-credentials`, `git/config`. */
const namesGitInternals = (word: string): boolean => {
  const segments = word.toLowerCase().split('/');
  return (
    segments.includes('.git') ||
    segments.some((segment) => segment === '.gitconfig' || segment === '.git-credentials') ||
    /(?:^|\/)git\/config$/.test(word.toLowerCase())
  );
};

/**
 * Whether a command's **name** is computed when it runs — `$X …`, `"$X" …`, `$(…) …`, `` `…` … `` in
 * command position, after any assignments and environment wrappers — which the policy cannot read.
 * A quote-aware walk of the raw line, separate from the scanner because the scanner lifts a
 * substitution out of the fragment it sat in (`$(echo git) push x` reads as `push x` there).
 *
 * A here-document's body is data, not commands (WP-153): `cat > a.php <<'EOF'` followed by PHP
 * whose lines start with `$` must not read as computed command names. The operator and the bodies
 * are the scanner's own reader (`readHereDocumentOperator`, `hereDocumentsAtNewline`), so this walk
 * skips exactly what the scanner skips — and skips nothing on a line that hands its here-documents
 * to a shell (`readsHereDocumentsAsScripts`), where a body is the script that runs.
 */
export const computesCommandName = (command: string): boolean => {
  const WRAPPERS = new Set([
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
  let quote: '"' | "'" | null = null;
  let atCommand = true;
  let word = '';
  const restore: boolean[] = [];
  const skipsBodies = !readsHereDocumentsAsScripts(command);
  let pending: HereDocumentOperator[] = [];
  let pendingFrom = -1;
  let skipped = '';
  let skippedUpTo = 0;
  const finishWord = (): void => {
    if (word === '') {
      return;
    }
    if (atCommand && !WRAPPERS.has(word) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      atCommand = false;
    }
    word = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        word += char + (command[index + 1] ?? '');
        index += 1;
      } else {
        if (char === quote) {
          quote = null;
        }
        word += char;
      }
      continue;
    }
    if (char === '\\') {
      word += char + (command[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (char === '<' && command.startsWith('<<', index)) {
      skipped += command.slice(skippedUpTo, index);
      skippedUpTo = index;
      const operator = readHereDocumentOperator(command, index, skipped);
      if (operator !== null) {
        finishWord();
        if (pending.length === 0) {
          pendingFrom = index;
        }
        pending.push(operator);
        index += operator.length - 1;
        continue;
      }
    }
    if (char === '\n' && pending.length > 0) {
      const at = hereDocumentsAtNewline(command, index, pending, pendingFrom);
      pending = [];
      if (skipsBodies && at.range !== null) {
        // What the walk read before the body, kept for the next operator's context check; the
        // body itself is left out, as the scanner leaves it out.
        skipped += command.slice(skippedUpTo, at.range[0]);
        skippedUpTo = at.range[1];
        index = at.resume - 1;
      }
      finishWord();
      atCommand = true;
      continue;
    }
    if (char === '"' || char === "'") {
      if (atCommand && word === '' && char === '"' && command[index + 1] === '$') {
        return true;
      }
      quote = char;
      word += char;
      continue;
    }
    if (char === '$' && command[index + 1] === '(') {
      if (atCommand && word === '') {
        return true;
      }
      restore.push(atCommand);
      atCommand = true;
      word = '';
      index += 1;
      continue;
    }
    if (char === '`') {
      if (atCommand && word === '') {
        return true;
      }
      restore.push(atCommand);
      atCommand = true;
      word = '';
      continue;
    }
    if (char === '$' && atCommand && word === '') {
      return true;
    }
    if (char === '(') {
      finishWord();
      restore.push(false);
      atCommand = true;
      continue;
    }
    if (char === ')' && restore.length > 0) {
      finishWord();
      atCommand = restore.pop() as boolean;
      continue;
    }
    if (/[;&|(){}\n]/.test(char)) {
      finishWord();
      atCommand = true;
      continue;
    }
    if (/\s/.test(char)) {
      finishWord();
      continue;
    }
    word += char;
  }
  return false;
};

/**
 * The first git-boundary refusal this command line carries, or `null` (module docblock, check 4).
 *
 * Every fragment the shell would run is judged (`splitCommandSegments`: list elements, pipeline
 * stages, subshells, substitution bodies, the script `sh -c`/`eval` is handed), each through every
 * argv it could really be (`commandArgvCandidates`: wrappers and assignments peeled, quoting off),
 * so `env git push …`, `sh -c 'git push …'`, `$(git push …)`, `git -C dir push …` and `"git" push …`
 * are all the same `git push`.
 */
/** A word the shell reads as a redirection: `2>&1`, `>out`, `>>log`, `&>/dev/null`, `<in`. */
const REDIRECTION_WORD = /^(?:\d+|&)?(?:>>?|<)/;

export const gitBoundaryViolation = (command: string): GitBoundaryViolation | null => {
  // Read on the raw line, here-document bodies included: a body is data to the shell, but it may
  // be a program's input (`python3 - <<'EOF'` naming the credential socket), and the control mount
  // is never a word a run needs.
  if (CONTROL_MOUNT_REFERENCE.test(command)) {
    return {
      fragment: command,
      detail:
        'it names the run’s control mount (`/ctl`) or the git credential helper; the run’s credential is reached only through git itself, which asks the helper when it needs it',
    };
  }
  if (computesCommandName(command)) {
    return {
      fragment: command,
      detail:
        'the name of a command in it is computed when it runs (`$VARIABLE …`, `$(…) …`), so the platform cannot read what would run; write the command name literally',
    };
  }
  for (const target of commandWriteTargets(command)) {
    if (namesGitInternals(target)) {
      return {
        fragment: command,
        detail: `it writes \`${target}\`, which is git’s own configuration or hooks, not repository content; use \`git\` itself for what it is meant to change`,
      };
    }
  }
  // The whole line as the shell reads it for commands: a here-document body that is data is not
  // in it (WP-153 (b)), so a body line `GIT_DIR=x` or `git push --force` is not judged here.
  const fragments = [withoutHereDocumentBodies(command), ...splitCommandSegments(command)];
  /**
   * A fragment **made of other fragments** — the whole line, or a pipeline the splitter also
   * returns whole so `curl * | sh` still matches the block list — is not one program's argv: read
   * as one, a pipe's right-hand side became the push's options (`git push origin agentic/x 2>&1 |
   * tail -5` was refused for "the push option `-5`", first local test, backlog 488). Its parts are
   * judged on their own; the assignment check below still reads it whole.
   *
   * Decided by **structure, never by substring** (WP-161 (e), backlog 517): a fragment is composite
   * when the splitter, run on it, finds more than one part. The test was `fragment.includes(other)`
   * until WP-161, so `git push origin main; m` skipped the push — `m` is inside `main` — and ran
   * under `auto`. The parts of a composite are added to the walk, so none is judged only as part of
   * something skipped.
   */
  const parts = (fragment: string): readonly string[] => splitCommandSegments(fragment);
  const queue = [...fragments];
  const seen = new Set<string>();
  for (let next = 0; next < queue.length; next += 1) {
    const fragment = queue[next] as string;
    if (seen.has(fragment)) {
      continue;
    }
    seen.add(fragment);
    const assignment = commandWords(fragment).find((word) => GUARDED_GIT_ENVIRONMENT.test(word));
    if (assignment !== undefined) {
      return {
        fragment,
        detail: `\`${assignment.split('=')[0]}\` configures git’s transport, its configuration or its repository from the environment, and a run may not change where git connects or what it runs`,
      };
    }
    const pieces = parts(fragment);
    if (pieces.length > 1) {
      queue.push(...pieces);
      continue;
    }
    for (const candidate of commandArgvCandidates(fragment)) {
      // A redirection (`2>&1`, `>/dev/null`, `2>err.log`) is the shell's, not the program's
      // argument (backlog 488); where it writes is judged above by `commandWriteTargets`.
      const argv = candidate.filter((word, index) => index === 0 || !REDIRECTION_WORD.test(word));
      const [name] = argv as [string, ...string[]];
      if (name === 'git' || name.startsWith('git-')) {
        const detail = checkGitArgv(argv);
        if (detail !== null) {
          return { fragment, detail };
        }
      } else if (!READ_VERBS.has(name)) {
        const internal = argv.slice(1).find(namesGitInternals);
        if (internal !== undefined) {
          return {
            fragment,
            detail: `it names \`${internal}\`, which is git’s own configuration or hooks, not repository content; use \`git\` itself for what it is meant to change`,
          };
        }
      }
    }
  }
  return null;
};

// ── the decision ─────────────────────────────────────────────────────────────

/**
 * Where a refused command can go instead. Appended to every deny, because a refusal the model reads
 * as *"no network"* is what the first local test's discovery run wrote into its knowledge pages.
 */
export const UNATTENDED_ALTERNATIVES =
  'This is the platform’s command policy, not a network or sandbox failure. To read a file use the Read tool (with offset/limit for a range); to search use Grep or Glob; if only one part of a compound line was refused, run the other parts one command per call.';

const quoted = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return `\`${flat.length > 200 ? `${flat.slice(0, 199)}…` : flat}\``;
};

const deny = (
  rule: UnattendedCommandRule,
  evaluation: CommandEvaluation,
  fragment: string | null,
  sentence: string,
): UnattendedCommandDecision => ({
  decision: 'deny',
  rule,
  evaluation,
  fragment,
  reason: `command policy: ${rule === 'block_list' ? 'block' : 'refused (unattended run)'} — ${sentence} ${UNATTENDED_ALTERNATIVES}`,
});

/** How a reason names the piece it is about: the whole command, or one fragment of it. */
const whereOf = (fragment: string | null, command: string): string =>
  fragment === null
    ? 'the line'
    : fragment === command
      ? `the command ${quoted(fragment)}`
      : `the fragment ${quoted(fragment)}`;

const hazardDeny = (
  evaluation: CommandEvaluation,
  fragment: string,
  command: string,
  hazard: HazardousArgument,
): UnattendedCommandDecision =>
  deny(
    'hazardous_argument',
    evaluation,
    fragment,
    `${whereOf(fragment, command)} carries an argument the policy refuses ("${hazard.pattern}"): ${hazard.hazard}. Run it without that argument.`,
  );

/** The first `command`/`trust` hazard on the line or any of its fragments (check 3). */
const refusedHazard = (
  command: string,
): { readonly fragment: string; readonly hazard: HazardousArgument } | null => {
  for (const fragment of [withoutHereDocumentBodies(command), ...splitCommandSegments(command)]) {
    const hazard = hazardousArguments(fragment).find((entry) => entry.kind !== 'path');
    if (hazard !== undefined) {
      return { fragment, hazard };
    }
  }
  return null;
};

/** Why `evaluateCommand` said what it said, in one parenthesis. */
const matchedText = (evaluation: CommandEvaluation, command: string): string => {
  if (evaluation.matched !== null) {
    return `matched "${evaluation.matched}"`;
  }
  const [target] = commandWriteTargets(command);
  return evaluation.segment === command && target !== undefined
    ? `a redirection writes ${quoted(target)}`
    : 'no list matches it';
};

/**
 * Decides one command for an unattended run (module docblock). Pure: the same line, policy and mode
 * always give the same decision and the same words.
 */
export const decideUnattendedCommand = (
  request: CommandRequest,
  policy: ResolvedCommandPolicy,
  mode: UnattendedCommandMode,
): UnattendedCommandDecision => {
  const evaluation = evaluateCommand(request, policy);
  const fragment = evaluation.segment;

  if (evaluation.verdict === 'block') {
    return deny(
      'block_list',
      evaluation,
      fragment,
      `${whereOf(fragment, request.command)} matches the block-list entry "${evaluation.matched}", which no run may execute. Do not retry it under another spelling.`,
    );
  }
  if (evaluation.uncertainty.length > 0) {
    return deny(
      'uncertain',
      evaluation,
      null,
      `the platform’s shell scanner cannot follow ${evaluation.uncertainty.join('; ')} in this line, so it cannot tell what would run. Rewrite it without that construct — plain quoting, one command per call.`,
    );
  }
  const boundary = gitBoundaryViolation(request.command);
  if (boundary !== null) {
    return deny(
      'git_boundary',
      evaluation,
      boundary.fragment,
      `${whereOf(boundary.fragment, request.command)} is refused at the git boundary: ${boundary.detail}.`,
    );
  }
  if (evaluation.verdict === 'allow') {
    return {
      decision: 'allow',
      rule: 'allow_list',
      evaluation,
      fragment,
      reason: `command policy: allow (${matchedText(evaluation, request.command)})`,
    };
  }

  // `ask` from here on: an ask-list match, an unmatched fragment, a redirection to a path, or a
  // hazardous argument flooring an allow.
  const hazard = refusedHazard(request.command);
  if (hazard !== null) {
    return hazardDeny(evaluation, hazard.fragment, request.command, hazard.hazard);
  }
  const where = whereOf(fragment, request.command);
  if (mode === 'deny') {
    return deny(
      'unattended_deny',
      evaluation,
      fragment,
      `${where} is not on this run’s allow list (${matchedText(evaluation, request.command)}), and this project runs unattended commands in \`deny\` mode, so nothing outside the allow list runs.`,
    );
  }
  return {
    decision: 'allow',
    rule: 'unattended_auto',
    evaluation,
    fragment,
    reason: `unattended: ask allowed in the sandbox (${matchedText(evaluation, request.command)}${fragment === null || fragment === request.command ? '' : ` at ${quoted(fragment)}`})`,
  };
};
