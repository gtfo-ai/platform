# 16 — How Yarn, Bun and sentry-cli look up the word after their name (reading for WP-266)

> Asked by PROGRESS backlog **676** and plan row **WP-266**, ruling (a). WP-255 kept a second dequote
> of a package runner's subcommand word for Yarn, Bun and sentry-cli (and Composer's half) because
> how those programs resolve that word had not been read. Reading the word as bash hands it is only
> as safe as the program's lookup: if the program matches the word **exactly**, a word that still
> holds a backslash or a quote after bash (`"\exec"` reaches the program as `\exec`, `"'x'"` as
> `'x'`) cannot be the exec subcommand, and it reads like any other unknown word (its *twin*). If the
> program infers a prefix or an abbreviation, or strips a quote or a backslash itself, it may not.
>
> Read by the WP-266 implementer, 2026-10-24, from the published source at the versions named below.
> Nothing was installed or run. The sources were fetched as files (`raw.githubusercontent.com`, the
> GitHub API's tree listings, `codeload.github.com` tarballs and the npm registry tarball for
> clipanion). No browser was used. The two bashes' handling of each spelling was measured separately
> with `printf '[%s]'` only (PROGRESS `#### WP-266`, (1)).

## Answer

| Program, version read | First-word lookup | Prefix or abbreviation? | Quote or backslash stripped by the program? | Outcome |
|---|---|---|---|---|
| **sentry-cli 3.7.0** (pinned, `docker/runtime.Dockerfile:49`) on clap_builder 4.6.0 | exact name or a declared alias; `monitors` and `run` declare no alias | no: clap infers only under `infer_subcommands`, which sentry-cli never sets | no | settled, exact |
| **Bun 1.4.4** (the latest release when read; no image and no corpus line names a version) | exact bytes against a fixed table (`x`, `exec` and the other names, aliases listed in the table) | no | no | settled, exact |
| **Yarn 1.22.22** (the stock run image's `yarn` and `yarnpkg`, measured at WP-196) | `hasOwnProperty` on its command table, aliases in the table | no | no | settled, exact |
| **Yarn 4.18.1** (Berry, the latest `@yarnpkg/cli` release when read; reached from Yarn 1 by a project's `yarnPath`) | clipanion's exact static match on the path segment; an unmatched first word goes to the entry command | no (clipanion's prefix branch is completion only) | no; but an unmatched word that holds `\` or `/` and is no package name is taken as a **directory** (`entries/run.ts:12`, `/[\\/]/`) and the rest dispatched there (run at WP-269) | settled, exact for a subcommand name; the directory word skipped |

**Every one of the four lookups is exact.** None infers a prefix or an abbreviation, and none takes a
quote or a backslash off the word bash hands it. The subcommand names they hold (`exec`, `x`, `dlx`,
`run`, `monitors`, …) are lower-case letters and hyphens, so a word that still holds `\` or `'` after
bash cannot match one. What each does with a word it does not hold is the same as what it does with
the twin `foo`: Yarn and Bun run it as a script or file name, and clap refuses it as an unknown
subcommand.

**One finding beside the question** (Berry): its entry command reads an unmatched first word that
holds a backslash **or** a slash (`/[\\/]/`, `entries/run.ts:12`) and does not parse as a package
name as a working directory, and dispatches the **next** word as the command (`yarn ./d exec …` is
`yarn exec …` in `./d`; so are `yarn "@\x" exec …` and `yarn "\x@y" exec …`, whose handed words `@\x`
and `\x@y` hold a backslash and fail `IDENT_REGEXP`). The policy reads such a word as a
non-exec subcommand at the base, whichever dequote it uses. That is recorded as discovered work in
PROGRESS `#### WP-266`, not changed by this row.

## sentry-cli 3.7.0

Source: `https://github.com/getsentry/sentry-cli`, tag `3.7.0` (the version `docker/runtime.Dockerfile`
pins and downloads as a release binary, so no npm wrapper sits in front of it).

- `src/commands/mod.rs:148-155`, `fn app()`: `Command::new("sentry-cli")` with
  `.subcommand_required(true)` and `.arg_required_else_help(true)`. No `infer_subcommands`, no
  `allow_external_subcommands`, no `args_conflicts_with_subcommands`.
- `src/commands/mod.rs:214-224`, `add_commands`: each subcommand is
  `Command::new(stringify!($name).replace("_", "-"))` — a lower-case name with hyphens.
- `src/commands/mod.rs:226-242`, `run_command`: dispatch is `matches.subcommand_matches(&cmd)` over
  the same names, then `unreachable!()`; nothing rewrites argv (`preexecute_hooks`, `:118-139`, reads
  an environment variable on macOS only).
- `src/commands/monitors/mod.rs:14-30`: `monitors` has the subcommands `list` and `run`, built the
  same way, with `.subcommand_required(true)`. `src/commands/monitors/run.rs:18` builds `run` with no
  alias.
- A grep of the whole `src/` tree for `infer_subcommands`, `allow_external_subcommands`, `.alias(`,
  `.aliases(` and `visible_alias` finds aliases only on `debug-files` (`dif`, `difutil`), on
  `debug-files check` (`id`, `uuid`), on one `debug-files upload` flag and on the global `--quiet`
  flag (`silent`). None on `monitors` or `run`.
- `Cargo.lock:446-447` and `:456-457`: `clap` 4.6.1 over `clap_builder` 4.6.0.

clap_builder 4.6.0 (`https://github.com/clap-rs/clap`, tag `v4.6.0`, `clap_builder/`):

- `src/parser/parser.rs:584-619`, `possible_subcommand`: the prefix loop (`s.get_name().starts_with(arg)`,
  accepted only when unique) runs only under `self.cmd.is_infer_subcommands_set()`; otherwise the word
  is resolved by `self.cmd.find_subcommand(arg)`.
- `src/builder/command.rs:3980-3983`, `find_subcommand`: `self.get_subcommands().find(|s| s.aliases_to(name))`.
- `src/builder/command.rs:4984-4987`, `aliases_to`: `self.get_name() == name || self.get_all_aliases().any(|alias| alias == name)` — byte equality on the `OsStr`.
- `src/builder/command.rs:1840`, `infer_subcommands(self, yes: bool)`: a setting a program opts into.

**Settled: exact name or alias, no prefix, nothing stripped.** `sentry-cli monitors "\run" slug -- …`
hands clap `\run`, which matches no subcommand of `monitors` (clap reports an unrecognised
subcommand), as `foo` does.

## Bun 1.4.4

Source: `https://github.com/oven-sh/bun`, tag `bun-v1.4.4` (the latest release when read; Bun's CLI is
Rust at this tag). Neither the stock run image nor the corpus names a Bun version, and the image does
not ship Bun (measured at WP-196).

- `src/runtime/cli/mod.rs:725-791`, `fn which()`: after `bunx`/`node` argv0 handling, the first argument
  is skipped past leading `-` options (`:766-778`), then matched as
  `type RootCommandMatcher = strings::ExactSizeMatcher<12>; let x = RootCommandMatcher::r#match(first_arg_name);`.
- `src/runtime/cli/mod.rs:792-933`: a chain of `if x == RootCommandMatcher::case(b"…")` — among them
  `b"x"` → `Tag::BunxCommand` (`:816-817`), `b"exec"` → `Tag::ExecCommand` (`:867-868`), and the
  aliases spelled out in the chain (`i`/`install`, `c`/`create`, `a`/`add`, `up`/`update`,
  `r`/`remove`/`rm`/`uninstall`, …). Any other word falls through to `Tag::AutoCommand`, which runs it
  as a file or a `package.json` script.
- `src/bun_core/string/immutable/exact_size_matcher.rs:66-83`, `r#match`: a word of 1 to 12 bytes is
  copied into a zero-padded 12-byte array and read as one integer; an empty word is `ZERO` and a longer
  one `MAX`. Equality of two such integers is equality of the bytes.
- `src/runtime/cli/script_or_command.rs:139-147`, `command_after_flags`: only `check`, `lint` and `fmt`
  are looked for after flags, by exact match.

**Settled: exact bytes, aliases listed in the table, no prefix, nothing stripped.** `bun "\x" …`
hands Bun `\x`, which is `AutoCommand` (a file or script named `\x`), as `foo` is.

## Yarn 1.22.22

Source: `https://github.com/yarnpkg/yarn`, tag `v1.22.22` — the version the stock run image ships as
both `yarn` and `yarnpkg` (`/opt/yarn-v1.22.22/bin/`, measured at WP-196, PROGRESS § the M11
amendment's (a)).

- `src/cli/index.js:171-188`: the command name is the first argument that does not start with `-` and
  is not bound to the option before it.
- `src/cli/index.js:191`: `let isKnownCommand = Object.prototype.hasOwnProperty.call(commands, commandName);`
  — an exact key lookup.
- `src/cli/index.js:220-224`: an unknown name is put back in front of the arguments and run as
  `yarn run <name> …` (a `package.json` script or a package binary).
- `src/cli/commands/index.js` (the table) and `src/cli/aliases.js` (`upgrade-interactive`,
  `generate-lock-entry`): every key is lower-case letters, hyphens or a camel-cased name.
- `src/cli/index.js:631-655`, `start()`: when the project's rc names `yarnPath`, Yarn 1 runs **that**
  file with the arguments unchanged; `src/rc.js:58-60` takes `yarnPath` from a `.yarnrc.yml` too. So a
  project that commits a Berry release and a `.yarnrc.yml` (the usual Berry layout) makes the stock
  image's `yarn` run Berry, and Berry's lookup has to be read as well.

**Settled: exact, aliases in the table, no prefix, nothing stripped.**

## Yarn 4.18.1 (Berry) on clipanion 4.0.0-rc.2

Source: `https://github.com/yarnpkg/berry`, tag `@yarnpkg/cli/4.18.1` (commit
`75ebe063092f86e47e4afeaf1ae4bdf24402874b`), and clipanion 4.0.0-rc.2 as published on npm
(`https://registry.npmjs.org/clipanion/-/clipanion-4.0.0-rc.2.tgz`, `lib/`), the version Berry's
`yarn.lock` resolves `clipanion@npm:^4.0.0-rc.2` to.

- `packages/yarnpkg-cli/sources/lib.ts:143-170`, `run`: a configured `yarnPath` is run instead
  (`:152-156`); otherwise `cli.process(postCwdArgv, cli.defaultContext)` (`:165`) and `cli.run`.
- `packages/plugin-essentials/sources/commands/exec.ts:8-10` and
  `packages/plugin-dlx/sources/commands/dlx.ts:9-11`: `static paths = [[`exec`]]` and `[[`dlx`]]`.
- clipanion `lib/core.js:139-149`, `runMachineInternal`: a segment follows a static transition only on
  `Object.prototype.hasOwnProperty.call(nodeDef.statics, segment)` — exact. The prefix branch
  (`:151-173`, `candidate.startsWith(segment)`) is taken only when `partial` is set, which
  `lib/advanced/Cli.js:144-149` passes only for a partial (completion) request; `lib.ts:165` passes
  an array, so `partial` is unset. Paths are registered segment by segment with `registerStatic`
  (`lib/core.js:618-621`, `:340-345`).
- `packages/plugin-essentials/sources/commands/entries/run.ts:7-18`, `EntryCommand` (no path; it takes
  the first positional as `leadingArgument` and proxies the rest): if the word matches `/[\\/]/` **and**
  `structUtils.tryParseIdent` refuses it, it is a directory and the rest is dispatched again there
  (`:12-14`); otherwise it is `yarn run <word> …` (`:16`).
- `packages/yarnpkg-core/sources/structUtils.ts:343` and `:352-364`: `IDENT_REGEXP =
  /^(?:@([^/]+?)\/)?([^@/]+)$/`. A word with a backslash, no `/` and no `@` (`\exec`, `\--`) **is** an
  ident, so it is `yarn run \exec …`, a script or binary named `\exec`, as `foo` is. A word holding `\`
  or `/` that is no ident — `./d`, `a/b`, `@\x` (an `@` with no `/` after the scope), `\x@y` (an `@` in
  the name) — is taken as a directory.

**Settled: exact for every subcommand name, no prefix, nothing stripped.** The directory branch
concerns a word holding `\` or `/` that is no ident. A word the lift moves holds a backslash only
where it holds neither `@` nor `/` (`\exec`, `\--`), so it is an ident and takes the `yarn run`
branch, as its twin `foo` does; such a word holding `@` or `/` reads as no exec subcommand under
either dequote, so it does not reach the lifted cells (PROGRESS `#### WP-266`, (3): 0 of the 6 472
moved lines' spelled words hold `@` or `/`).

### The directory branch is a dispatch (WP-269, backlog 686)

`:14` is `return await this.cli.run(this.args, {cwd: newCwd})`: the words after the directory are
processed again as a whole command line, in that directory, so the next word is read in the
subcommand position — `exec`, `dlx`, a second directory word, or anything else. The policy reads it
so (`runnerSubcommandAt`'s yarn branch, `BERRY_IDENT` beside it): a positional word that matches
`/[\\/]/` and fails `IDENT_REGEXP` is skipped, as often as it occurs. Yarn 1 without a `yarnPath`
reads the same line as `yarn run <word> …` (`src/cli/index.js:220-224`), a script the word names, so
Berry's reading is equal or tighter for every line and one reading serves both.

**Run, not only read** (WP-269, 2026-10-24): the release file
`https://repo.yarnpkg.com/4.18.1/packages/yarnpkg-cli/bin/yarn.js` (sha256
`a28ad591febb769f939c11f82f89bacad0b0fac0c884d3b78fa2aaaee970907e`, byte-identical to `bin/yarn.js`
in the npm registry's `@yarnpkg/cli-dist@4.18.1` tarball) was run on the host as `node <release>
<word> exec "/usr/bin/printf … > marker"` in a scratch project (`package.json`, `.yarnrc.yml` naming
that file as `yarnPath`, a hand-written workspace-only `yarn.lock`; no install), with `env -i
HOME=<scratch> PATH=<node only> YARN_ENABLE_NETWORK=0` and stdin `/dev/null`. `./d`, `@\x`, `\x@y`
and `./d ./e` each exited 0 and wrote the marker **inside the named directory** (`d/e/marker` for
the last); `.` (no `\` or `/`) and `a\b` (an ident) answered `Couldn't find a script named …` and
wrote nothing. PROGRESS `#### WP-269` has the transcript.

## Composer (for completeness)

Composer's half was read at WP-211 and is cited at `composerCommandOf` in
`packages/domain/src/policies/command-policy.ts` (Composer 2.10.3 on symfony/console 5.4.47: a word
that is not exactly a canonical command name may load the project's scripts). Reading the word as
handed can only turn an exact canonical name into a word that is not one, which the policy reads as
`'unknown'` — tighter. WP-266 ruling (b) lifts it on that measurement.
