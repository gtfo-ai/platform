/**
 * What the readiness **re-check after a merge** can decide without a run — product/17, WP-64
 * (PROGRESS backlog 46).
 *
 * product/17: criteria are *"re-checked after every merged task (cheap: mostly file and CI-event
 * inspection)"*. `READINESS_CRITERIA[].recheck` states which criterion is answered how; this module
 * holds the two answers that are not the platform's existing three (R9, R11, R12):
 *
 *  - **R8** from the files themselves — `CLAUDE.md` and `AGENTS.md` at the merged commit, read
 *    through the platform's mirror (no checkout). Both directions: the file read is the whole of
 *    product/17's *"file inspection"*;
 *  - **R3** from the provider's pipeline events the platform already stored, pass-only.
 *
 * Pure: the caller reads the files and counts the events and hands both in. Everything written into
 * `evidence` here is **platform text** — a path, a line count, a number — and never a byte of the
 * file, so nothing a repository writes reaches the stored evaluation through this module.
 */
import { withoutHereDocumentBodies } from '../policies/command-policy.js';

/** product/17 R8's *"≤ 200 lines"*. */
export const MAX_AGENT_INSTRUCTIONS_LINES = 200;

/** product/17 R8's two files, in the order a reader looks for them. */
export const AGENT_INSTRUCTIONS_PATHS = ['CLAUDE.md', 'AGENTS.md'] as const;

/**
 * How far back the re-check looks for a merge-request pipeline event (R3).
 *
 * product/17 gives R3 no window and R4 one of thirty days; the re-check uses R4's so *"CI runs on
 * merge requests"* means *now*, and so the read is bounded by the `events` table's
 * `(type, occurred_at)` index and its monthly partitions rather than by the project's whole history.
 */
export const READINESS_CI_WINDOW_DAYS = 30;

/** One of R8's files at the read commit — the shape `RepositoryFileSource` answers with. */
export type AgentInstructionsFile =
  | { readonly kind: 'absent' }
  | { readonly kind: 'not_a_file' }
  | { readonly kind: 'oversized'; readonly bytes: number }
  | { readonly kind: 'file'; readonly text: string };

export interface ReadinessAnswer {
  readonly passed: boolean;
  /** Platform text only — see the module docblock. */
  readonly evidence: string;
}

/**
 * Lines as a reader counts them: a final newline ends the last line rather than starting another.
 * An empty file has none.
 */
export const lineCountOf = (text: string): number => {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
};

const shortSha = (commitSha: string): string => commitSha.slice(0, 12);

/**
 * product/17 R8 — *"`CLAUDE.md`/`AGENTS.md` present, ≤ 200 lines, links to the KB index"*.
 *
 * Passes when **either** file satisfies all three clauses. "Links to the KB index" is the
 * knowledge index's repository path appearing in the file (`<knowledge_dir>/index.md`), which is the
 * test the configuration export already applies before proposing its own one-line pointer
 * (`config/export.ts`) — so the pointer the platform proposes is exactly what makes R8 pass, and a
 * link spelled differently (a URL to a rendered page, `docs/kb`) does not. That is conservative in
 * the direction product/17 § "What it is not" asks for: a missed link costs a suggestion.
 */
export const agentInstructionsReadiness = (input: {
  readonly files: Readonly<
    Record<(typeof AGENT_INSTRUCTIONS_PATHS)[number], AgentInstructionsFile>
  >;
  readonly knowledgeDir: string;
  readonly commitSha: string;
}): ReadinessAnswer => {
  const index = `${input.knowledgeDir.replace(/\/+$/, '')}/index.md`;
  const findings: string[] = [];
  for (const path of AGENT_INSTRUCTIONS_PATHS) {
    const file = input.files[path];
    switch (file.kind) {
      case 'absent':
        findings.push(`${path} is absent`);
        break;
      case 'not_a_file':
        findings.push(`${path} is not a regular file (a symlink, a directory or a submodule)`);
        break;
      case 'oversized':
        findings.push(`${path} is ${file.bytes} bytes, larger than the platform reads`);
        break;
      case 'file': {
        const lines = lineCountOf(file.text);
        const links = file.text.includes(index);
        if (lines <= MAX_AGENT_INSTRUCTIONS_LINES && links) {
          return {
            passed: true,
            evidence: `${path} at ${shortSha(input.commitSha)} has ${lines} lines and links to ${index}`,
          };
        }
        findings.push(
          `${path} has ${lines} lines${lines > MAX_AGENT_INSTRUCTIONS_LINES ? ` (more than ${MAX_AGENT_INSTRUCTIONS_LINES})` : ''}${links ? '' : ` and does not link to ${index}`}`,
        );
        break;
      }
    }
  }
  return {
    passed: false,
    evidence: `at ${shortSha(input.commitSha)}: ${findings.join('; ')}`,
  };
};

/**
 * product/17 R3 — *"pipeline events observed for MRs"* — from the events the platform stored.
 *
 * product/19 §5 defines the pass: *"at least one `ci.pipeline.finished` for an MR in the last 30
 * days, or CI config file + pipeline observed at first task"*, checked *"continuously"*. This is the
 * first half; the second half is discovery's answer, which a miss here carries.
 *
 * **Pass-only** (`ReadinessRecheckSource`'s `ci_events`): `null` when nothing was observed, and the
 * caller then carries the previous answer. `null` and not `false`, because a project whose window
 * held no merge request has observed nothing about its CI at all.
 */
export const mergeRequestPipelineReadiness = (observed: number): ReadinessAnswer | null =>
  observed > 0
    ? {
        passed: true,
        evidence: `the platform observed ${observed} pipeline ${observed === 1 ? 'event' : 'events'} for merge requests in the last ${READINESS_CI_WINDOW_DAYS} days`,
      }
    : null;

// ── R10 and R13 from named files (WP-94, PROGRESS backlog 231) ───────────────

/**
 * One file at a named path, as the re-check hands it in — the same four states R8's files have.
 * Only `file` can be evidence; a symlink, a submodule, a directory or an oversized blob is not read.
 */
export type ReadinessTreeFile = AgentInstructionsFile;

/**
 * product/17 R10's first half — *"MR template … documented"* — as the **exact** paths the two git
 * hosts read a single template from, and nothing else:
 *
 *  - GitLab: *"Create a merge request template named `Default.md` (case-insensitive) and save it in
 *    `.gitlab/merge_request_templates/`"* (https://docs.gitlab.com/user/project/description_templates/,
 *    retrieved 2026-09-29). Case-insensitive on the host, so both spellings a person writes are
 *    named; any other casing, and every non-default template in that directory, is **not seen**.
 *  - GitHub: `pull_request_template.md` at the root, in `docs/` or in `.github/`
 *    (https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository,
 *    retrieved 2026-09-29).
 *
 * Paths, never a directory listing: the repository reader answers exact named paths only
 * (`REPOSITORY_FILE_PATHS`), which is what keeps the platform's view of a repository bounded.
 */
export const MERGE_REQUEST_TEMPLATE_PATHS = [
  '.gitlab/merge_request_templates/Default.md',
  '.gitlab/merge_request_templates/default.md',
  'pull_request_template.md',
  'docs/pull_request_template.md',
  '.github/pull_request_template.md',
] as const;

/**
 * product/17 R10's second half — *"commit convention documented"* — as the configuration files
 * commitlint reads (https://commitlint.js.org/reference/configuration.html, retrieved 2026-09-29).
 * A present, non-empty file is the convention stated in a form a tool enforces. The `commitlint`
 * key of `package.json` and a convention written in prose (`technical/conventions.md`, product/19
 * §5's second form) are **not** read: the first needs a JSON parse of a file the platform does not
 * name, the second needs a judgement a path cannot make.
 */
export const COMMIT_CONVENTION_PATHS = [
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yaml',
  '.commitlintrc.yml',
  '.commitlintrc.js',
  '.commitlintrc.cjs',
  '.commitlintrc.mjs',
  '.commitlintrc.ts',
  '.commitlintrc.cts',
  '.commitlintrc.mts',
  'commitlint.config.js',
  'commitlint.config.cjs',
  'commitlint.config.mjs',
  'commitlint.config.ts',
  'commitlint.config.cts',
  'commitlint.config.mts',
] as const;

/**
 * product/17 R13 — *"Secret scanning in CI or pre-commit"* — as the files that would **run** a
 * scanner: the pre-commit framework's file, lefthook's two spellings, husky's pre-commit hook and
 * GitLab's CI file. A scanner's own configuration (`.gitleaks.toml`) is not among them: it says
 * how a scan would be configured, not that one runs. GitHub Actions workflows live under a
 * directory whose file names the project chooses, so they are **not seen** — stated at
 * {@link secretScanningReadiness}.
 */
export const SECRET_SCANNING_PATHS = [
  '.pre-commit-config.yaml',
  'lefthook.yml',
  '.lefthook.yml',
  '.husky/pre-commit',
  '.gitlab-ci.yml',
] as const;

/** Every path R10 and R13 read — what `REPOSITORY_FILE_PATHS` is widened by (WP-94). */
export const READINESS_TREE_PATHS = [
  ...MERGE_REQUEST_TEMPLATE_PATHS,
  ...COMMIT_CONVENTION_PATHS,
  ...SECRET_SCANNING_PATHS,
] as const;

export type ReadinessTreePath = (typeof READINESS_TREE_PATHS)[number];

/** GitLab's default CI file — the entry of {@link SECRET_SCANNING_PATHS} a custom path replaces. */
const GITLAB_CI_PATH = '.gitlab-ci.yml';

/** The scanners R13 recognises by name — the only words its evidence can contain. */
const SECRET_SCANNERS = [
  'gitleaks',
  'trufflehog',
  'detect-secrets',
  'ggshield',
  'secretlint',
] as const;

/** GitLab's own secret-detection template, as an `include: template:` names it. */
const GITLAB_SECRET_DETECTION_TEMPLATE =
  /^template:\s*["']?[\w./-]*Secret-Detection(?:\.latest)?\.gitlab-ci\.yml["']?$/i;

/** `SECRET_DETECTION_DISABLED` set to a value GitLab reads as on — the template's own off switch. */
const SECRET_DETECTION_DISABLED = /\bSECRET_DETECTION_DISABLED\s*:\s*["']?(?:true|1|yes)["']?/i;

/**
 * A line without its comment: everything from a `#` that starts the line or follows whitespace.
 * Crude on purpose — a `#` inside a quoted string with a space before it is cut too, which can only
 * lose a match, never make one.
 */
const withoutComment = (line: string): string => line.replace(/(^|\s)#.*$/, '').trimEnd();

/** A scanner's own sub-commands that scan nothing — `gitleaks version`, `trufflehog --help`. */
const NON_SCANNING_ARGUMENTS = new Set(['version', '--version', '-v', 'help', '--help', '-h']);

/**
 * The scanner a **command** runs, or `null` (WP-94 review round 2). The command is a shell line —
 * never a YAML list item or a path: its first word, after a package runner (`npx`, `pnpm exec`,
 * `pnpm dlx`, `yarn`, `bunx`, `exec`), must **be** a scanner's name, and its next word must not be
 * `version`/`help`. `echo "… gitleaks"`, `./bin/gitleaks` and `eslint --ignore-pattern trufflehog/`
 * run none. Which lines are commands at all is the caller's question ({@link commandLinesOf}).
 */
const scannerRunBy = (command: string): string | null => {
  const words = command
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^(?:npx|pnpm\s+(?:exec|dlx)|yarn|bunx|exec)\s+/i, '')
    .split(/\s+/);
  const scanner = SECRET_SCANNERS.find((name) => name === words[0]?.toLowerCase());
  if (scanner === undefined) return null;
  return NON_SCANNING_ARGUMENTS.has(words[1]?.toLowerCase() ?? '') ? null : scanner;
};

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The commands a YAML file declares under `keys` — the only lines R13 reads as commands in
 * `.gitlab-ci.yml` (`script`, `before_script`, `after_script`), lefthook (`run`) and pre-commit
 * (`entry`). An inline value (`run: gitleaks protect`) is one command; a block under the key — list
 * items (`- gitleaks detect`) or a `|`/`>` scalar's lines — are commands while they are indented
 * deeper than the key. Every other list (`stages:`, `needs:`, `cache: paths:`, `exclude:`) is data.
 */
const commandLinesOf = (lines: readonly string[], keys: readonly string[]): string[] => {
  const key = new RegExp(`^(\\s*)(?:-\\s+)?(?:${keys.join('|')})\\s*:\\s*(.*)$`, 'i');
  const commands: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = key.exec(lines[index] ?? '');
    if (match === null) continue;
    const inline = (match[2] ?? '').trim();
    if (inline !== '' && !/^[|>][-+]?$/.test(inline)) {
      commands.push(inline.replace(/^\[|\]$/g, ''));
      continue;
    }
    const depth = indentOf(lines[index] ?? '');
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? '';
      if (line.trim() === '') continue;
      if (indentOf(line) <= depth && !line.trimStart().startsWith('- ')) break;
      if (indentOf(line) < depth) break;
      const item = line.trim().replace(/^-\s+/, '');
      if (!/^[|>][-+]?$/.test(item)) commands.push(item);
    }
  }
  return commands;
};

/**
 * A line's comment blanked **without** trimming the line's end ({@link withoutComment} trims it). The
 * whitespace before the `#` is kept, so a blanked line never becomes equal to a delimiter.
 */
const commentBlanked = (line: string): string => line.replace(/(^|\s)#.*$/, '$1');

/**
 * The commands a shell hook runs, in order, up to an unconditional top-level `exit`. A
 * here-document's body (`cat <<EOF` … `EOF`) is data, not commands, and **which lines are a body
 * is the command scanner's answer** (`withoutHereDocumentBodies`, the reader WP-153 made the only
 * one, `../policies/command-policy.ts`), never a reader of this module's own (WP-158 (f), backlog
 * 510). The scanner reads the hook before {@link withoutComment} trims a line's end: a terminator
 * with a trailing space, or an indented one under a plain `<<`, does not end a body in bash or
 * dash, so trimming first would end it too early and read a body line as a command.
 *
 * **Comments are blanked first, untrimmed** — a deviation from ruling (f)'s *raw text*, measured:
 * the scanner refuses a here-document after a word-start `#` **anywhere earlier in the text**
 * (`HERE_DOCUMENT_CONTEXT`, which a one-line command needs), so on the raw hook the `#!/bin/sh`
 * line alone made every body in it commands again, and a scanner named in one passed R13.
 */
const shellCommandsOf = (text: string): string[] => {
  const uncommented = text.split('\n').map(commentBlanked).join('\n');
  const commands: string[] = [];
  for (const line of withoutHereDocumentBodies(uncommented).split('\n').map(withoutComment)) {
    if (/^exit\b/.test(line)) break;
    commands.push(line);
  }
  return commands;
};

/** A pre-commit hook id that is a scanner's own (`gitleaks`, `gitleaks-docker`, `detect-secrets`). */
const scannerHookId = (line: string): string | null => {
  const id = /^-?\s*id\s*:\s*["']?([\w.-]+)["']?$/i.exec(line.trim())?.[1]?.toLowerCase();
  return id === undefined
    ? null
    : (SECRET_SCANNERS.find((scanner) => id === scanner || id.startsWith(`${scanner}-`)) ?? null);
};

/**
 * Whether a GitLab CI file switches its secret detection off: the template's documented variable,
 * or a `secret_detection:` job whose own block says `when: never`. Either refuses the whole file —
 * the direction readiness is allowed to be wrong in (product/17 § "What it is not").
 */
const disablesSecretDetection = (lines: readonly string[]): boolean => {
  if (lines.some((line) => SECRET_DETECTION_DISABLED.test(line))) return true;
  const job = lines.findIndex((line) => /^secret_detection\s*:/.test(line));
  if (job === -1) return false;
  for (const line of lines.slice(job + 1)) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) return false;
    if (/\bwhen\s*:\s*["']?never["']?/.test(line)) return true;
  }
  return false;
};

/** What one of R13's files runs — the scanner, or `null`. See {@link secretScanningReadiness}. */
const scannerRunIn = (path: string, text: string): string | null => {
  const lines = text.split('\n').map(withoutComment);
  if (path === '.gitlab-ci.yml') {
    if (disablesSecretDetection(lines)) return null;
    if (
      lines.some((line) => GITLAB_SECRET_DETECTION_TEMPLATE.test(line.trim().replace(/^-\s+/, '')))
    ) {
      return 'gitlab secret detection';
    }
  }
  const commands =
    path === '.husky/pre-commit'
      ? shellCommandsOf(text)
      : path === '.gitlab-ci.yml'
        ? commandLinesOf(lines, ['script', 'before_script', 'after_script'])
        : path === '.pre-commit-config.yaml'
          ? commandLinesOf(lines, ['entry'])
          : commandLinesOf(lines, ['run']);
  if (path === '.pre-commit-config.yaml') {
    // A hook from the scanner's own repository, by its id.
    for (const line of lines) {
      const found = scannerHookId(line);
      if (found !== null) return found;
    }
  }
  for (const command of commands) {
    const found = scannerRunBy(command);
    if (found !== null) return found;
  }
  return null;
};

const hasText = (file: ReadinessTreeFile | undefined): file is { kind: 'file'; text: string } =>
  file?.kind === 'file' && file.text.trim().length > 0;

/** The first named path that holds a non-empty regular file, or `null`. */
const firstPresent = (
  files: Readonly<Partial<Record<string, ReadinessTreeFile>>>,
  paths: readonly string[],
): string | null => paths.find((path) => hasText(files[path])) ?? null;

/**
 * product/17 R10 — *"MR template and commit convention documented"* — from the named files.
 *
 * **Pass-only** (`ReadinessRecheckSource`'s `tree_pass`): both halves found is the criterion's own
 * evidence, while a miss at these paths is not evidence of absence — a template under another name
 * in GitLab's directory, or a convention written in `technical/conventions.md`, is invisible to a
 * read of named paths. So a miss answers `null` and the caller carries the previous answer.
 */
export const mergeRequestConventionReadiness = (input: {
  readonly files: Readonly<Partial<Record<string, ReadinessTreeFile>>>;
  readonly commitSha: string;
}): ReadinessAnswer | null => {
  const template = firstPresent(input.files, MERGE_REQUEST_TEMPLATE_PATHS);
  const convention = firstPresent(input.files, COMMIT_CONVENTION_PATHS);
  if (template === null || convention === null) {
    return null;
  }
  return {
    passed: true,
    evidence: `at ${shortSha(input.commitSha)}: the merge request template ${template} and the commit convention ${convention} are present`,
  };
};

/**
 * product/17 R13 — *"Secret scanning in CI or pre-commit"* — from the named files.
 *
 * A file passes only where a scanner is **run**, per file (WP-94 review rounds 1 and 2, backlog
 * 322). A command is a shell line whose first word is a scanner's name (after `npx`, `pnpm exec`,
 * `pnpm dlx`, `yarn`, `bunx`, `exec`) and whose next word is not `version`/`help`; and only these
 * lines are commands:
 *
 *  - `.pre-commit-config.yaml` — a hook whose `id` is a scanner's own, or an `entry:` command;
 *  - `lefthook.yml`, `.lefthook.yml` — a `run:` value (inline, or a `|` block under it);
 *  - `.husky/pre-commit` — every line, up to an unconditional top-level `exit`, a here-document's
 *    body excluded as the command scanner reads it (`withoutHereDocumentBodies`, WP-158);
 *  - `.gitlab-ci.yml` — the items and lines of `script:`, `before_script:` and `after_script:`;
 *    or GitLab's `Secret-Detection.gitlab-ci.yml` (or `.latest.`) template included, unless the file
 *    sets `SECRET_DETECTION_DISABLED` on or gives the `secret_detection:` job `when: never`, which
 *    refuses the whole file.
 *
 * Every other YAML list — `stages:`, `needs:`, `cache: paths:`, `exclude:` — is data. Comments are
 * stripped first (a line's `#…` tail, too) — in the husky hook they are blanked without trimming,
 * its here-document bodies taken out, and only then its lines trimmed, because a terminator's
 * trailing space decides where a body ends.
 *
 * **Over-reports that remain, stated rather than closed** — this is a line reader, not a YAML or
 * shell parser: a hook in a pre-commit `stages: [manual]` block or disabled by `SKIP`; a lefthook
 * command marked `skip: true`; a scanner command inside a shell `if false` branch, a function never
 * called, or after a conditional `exit`; a GitLab job whose `stage:` is not in `stages:`, whose
 * `rules:` never match (other than the `secret_detection` job's own `when: never`), or whose name is
 * `.`-prefixed (a hidden job); an `allow_failure: true` scan whose findings nobody reads; and a
 * scanner run with a flag that makes it report nothing (`--exit-code 0`). Each makes R13 pass on a
 * repository that scans nothing; because a pass is carried forward (a later miss answers `null`),
 * such a pass persists until discovery runs again.
 *
 * **Real setups that miss (the safe direction, carried rather than passed):** the CI/CD component
 * (`component: …/secret-detection@1`); a runner the prefix list does not name (`npx --no --
 * secretlint`, `pnpm secretlint`, `docker run … gitleaks`) or a scanner called by path
 * (`./bin/gitleaks`); and a scan switched off by `SECRET_DETECTION_DISABLED` set as a **project
 * CI/CD variable** rather than in the file — invisible to a file read, so a template include then
 * still passes (an over-report of the same kind as those above).
 *
 * **Pass-only**, for R10's reason: a scanner in a GitHub Actions workflow, or in a CI file included
 * from elsewhere, is not seen, so a miss answers `null` and the caller carries the previous answer.
 * The evidence names the path and a scanner from a fixed list — never a byte of the file.
 */
export const secretScanningReadiness = (input: {
  readonly files: Readonly<Partial<Record<string, ReadinessTreeFile>>>;
  readonly commitSha: string;
  /**
   * The CI file at the path the provider names (WP-143, backlog 442), when it is not the root
   * `.gitlab-ci.yml`: it is read as the GitLab CI file **in place of** the root one, which GitLab
   * then does not run. Its path in the evidence is the redacted provider path, bounded.
   */
  readonly ciFile?: { readonly path: string; readonly file: ReadinessTreeFile };
}): ReadinessAnswer | null => {
  const custom =
    input.ciFile !== undefined && input.ciFile.path !== GITLAB_CI_PATH ? input.ciFile : undefined;
  const candidates: {
    readonly path: string;
    readonly shown: string;
    readonly file: ReadinessTreeFile | undefined;
  }[] = SECRET_SCANNING_PATHS.map((path) =>
    path === GITLAB_CI_PATH && custom !== undefined
      ? { path, shown: JSON.stringify(custom.path.slice(0, 120)), file: custom.file }
      : { path, shown: path, file: input.files[path] },
  );
  for (const { path, shown, file } of candidates) {
    if (!hasText(file)) continue;
    const scanner = scannerRunIn(path, file.text);
    if (scanner !== null) {
      return {
        passed: true,
        evidence: `at ${shortSha(input.commitSha)}: ${shown} runs ${scanner}`,
      };
    }
  }
  return null;
};
