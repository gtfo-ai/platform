/**
 * The repository layer of the effective configuration — the project's own `.agentic/config.yml`,
 * read from its **default branch** (WP-63, BD-025 §1, Q94).
 *
 * technical/12 has always said `effective = merge(defaults, org, project, repo)`, and until WP-63
 * nothing produced `repo`: the platform never read the file back, so a project that edited it
 * changed nothing (PROGRESS backlog 44). Q94 (a) answers the precedence — **the repository wins**,
 * because product/12 says the project owns its `.agentic/` directory — and this module is the
 * producer.
 *
 * ## Where the bytes come from, and why only there
 *
 * Through the platform's own bare mirror (TD-026), with the same fetch, the same credential and the
 * same default-branch rule the knowledge index uses: {@link RepositoryFileSource} is the widening of
 * that read to **named paths outside the four indexed ones** — this file, `CLAUDE.md` (the export's
 * pointer, WP-63 criterion 1), `AGENTS.md` (WP-64), the twenty-six exact paths product/17 R10 and
 * R13 are read from (WP-94, `READINESS_TREE_PATHS`) and the direct children of one named directory,
 * `.agentic/prompts/` (WP-92, `project-prompts.ts`) — and nothing else. Configuration is trusted from the default
 * branch only (BD-025 §1): a task branch or a merge request must not be able to change the rules that
 * govern its own run, so no reader here accepts a ref, and a pinned commit must be an ancestor of the
 * default branch (the adapter's rule, inherited).
 *
 * ## What the file is: untrusted input
 *
 * Anyone who can merge to the default branch writes it, while the settings layer needs
 * `project.settings.write` — so it is parsed as a hostile document (a byte bound before it is read
 * ({@link MAX_REPOSITORY_FILE_BYTES}), a YAML parser with an alias ceiling that refuses unknown
 * tags, `__proto__` refused, and `agenticConfigSchema` — **strict**) and it **may tighten, never
 * loosen, what an agent or a reviewer is held to** (WP-63 review round 1's ruling). Every key it
 * can state is graded in `repository-grades.ts`: tighten-only keys merge so the result is never
 * weaker than the settings, not-applied keys (the dial and its Q78 overrides among them) are
 * dropped, and both are reported in the reading's `not_applied`, never dropped in silence.
 *
 * ## A file that fails is a named refusal
 *
 * WP-63 criterion 4 and standing rule 20: a file that does not parse is recorded as `invalid` with
 * the **key paths** it failed on, and that record refuses every run of the project
 * (`repositoryConfigRefusal`) and every read of the effective configuration. It is never an ignored
 * layer. The detail is redacted and bounded before it is stored: a strict schema puts an unknown
 * **key** into the path, and a key is text somebody typed into a repository.
 *
 * ## When it is read
 *
 * Refreshed from three places, all outside any transaction: the knowledge index job, after every
 * index run, pinned to the commit that run read (so the configuration and the vault describe the
 * same commit, and the mirror is not fetched twice); `POST /api/projects/:id/config/refresh`, the
 * explicit re-read; and, since WP-147, a change of the default branch, right after it commits
 * (`default-branch-reading.ts`) — the change marks the old branch's reading `invalid` in its transaction, so runs wait for it. A read that cannot reach the repository records **nothing** — the previous
 * snapshot stands, and the refusal to refresh is logged and returned rather than written as an
 * empty layer (TD-026 decision 4's rule, one module over).
 */
import {
  agenticConfigSchema,
  type Id,
  type IsoDateTime,
  type JsonObject,
} from '@platform/contracts';
import {
  type ConfigProvenance,
  type ConfigValues,
  mergeConfigLayers,
  READINESS_TREE_PATHS,
} from '@platform/domain';
import { assertOutsideTransaction } from '../events/open-transaction.js';
import { bindingSecretRedactor, type InjectedSecret } from '../integrations/redaction.js';
import type { RepositoryConfigState } from '../pipeline/settings.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import {
  isProjectPromptPath,
  MAX_PROJECT_PROMPT_FILES,
  type ProjectPromptReading,
} from './project-prompts.js';
import { tightenRepositoryLayer, withoutNotAppliedKeys } from './repository-grades.js';

/** The repository's configuration file (technical/12). */
export const REPOSITORY_CONFIG_PATH = '.agentic/config.yml';
/** The file the export adds its one-line knowledge-base pointer to (product/06 § "Step 5"). */
export const CLAUDE_MD_PATH = 'CLAUDE.md';

/**
 * **Every** path {@link RepositoryFileSource} will read — the widening of WP-18a's vault read, stated.
 *
 * The indexer reads the knowledge directory, `.agentic/rules/`, and `CLAUDE.md`/`AGENTS.md`
 * (`isIndexedVaultPath`), and a project's other files are none of the platform's business. The
 * exceptions are exact paths, never a glob: `CLAUDE.md` (WP-63) and `AGENTS.md` (WP-64, the
 * readiness re-check's R8) are already read by the indexer, so their entries add no exposure;
 * `.agentic/config.yml` was the first genuinely new path, and R10's and R13's twenty-six (WP-94,
 * stated at the list) are the rest. The prompt files are
 * read too since WP-92, but through a **directory** request of their own (`promptDirectory`, one
 * named directory, never a glob), so they are not in this list. A project's `.agentic/pipeline.yml`
 * is **still unread** (M5 declines `custom_stages` for 0.1).
 */
/**
 * `AGENTS.md` — the second of product/17 R8's two files, read by the readiness re-check (WP-64).
 *
 * It adds no exposure for the reason `CLAUDE.md` did not: the indexer already reads it
 * (`ALWAYS_INDEXED_PATHS`), so its bytes are already in the platform's hands at every indexed
 * commit. What WP-64 needs that the index does not give is the file *as a file* — its line count and
 * whether it is a symlink — which the chunked index does not keep.
 */
export const AGENTS_MD_PATH = 'AGENTS.md';

/**
 * **WP-94 widens the list by twenty-six exact paths** — the readiness re-check's R10 and R13
 * (PROGRESS backlog 231): five merge-request template paths, commitlint's sixteen configuration
 * files and five hook or CI files (`READINESS_TREE_PATHS` in `@platform/domain`, each with the
 * document it is taken from). Exact names, never a directory or a glob, so the reader still refuses
 * every other path; each file is bounded by {@link MAX_REPOSITORY_FILE_BYTES} like the others, so
 * one re-check reads at most `29 × 64 KiB` (the three above plus these). The new exposure is stated
 * rather than implied: a project's `.gitlab-ci.yml` and hook files now reach the platform's memory
 * at every re-check, and **nothing of them is stored** — the re-check's evidence names the path and
 * the scanner's name from a fixed list, never a byte of the file (`secretScanningReadiness`).
 */
export const REPOSITORY_FILE_PATHS = [
  REPOSITORY_CONFIG_PATH,
  CLAUDE_MD_PATH,
  AGENTS_MD_PATH,
  ...READINESS_TREE_PATHS,
] as const;
export type RepositoryFilePath = (typeof REPOSITORY_FILE_PATHS)[number];

export const isRepositoryFilePath = (value: string): value is RepositoryFilePath =>
  (REPOSITORY_FILE_PATHS as readonly string[]).includes(value);

/**
 * How many paths one request may ask the **presence** of (WP-139) — the CI gate asks one.
 */
export const MAX_PRESENCE_PATHS = 4;

/**
 * A path whose presence a reader may be asked (WP-139): repository-relative, at most 255
 * characters (GitLab's `ci_config_path` column), no empty, `.` or `..` segment, no control
 * character. The path is provider text (BD-022) and reaches `git ls-tree` after `--`.
 */
export const isPresencePath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 255 &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them.
  !/[\u0000-\u001f\u007f]/.test(value) &&
  !value.startsWith('/') &&
  value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

/**
 * Bytes one repository file may have before it is refused unread.
 *
 * technical/12's full example file is about 3 KiB; 64 KiB is twenty times that, so the bound only
 * ever bites on a file that is not a configuration. It is checked against the size `ls-tree -l`
 * reports, so an oversized blob is never buffered.
 */
export const MAX_REPOSITORY_FILE_BYTES = 64 * 1_024;

/** One path at the read commit. `not_a_file` is a symlink or a gitlink: listed, never followed. */
export type RepositoryFileEntry =
  | { readonly kind: 'absent' }
  | { readonly kind: 'not_a_file'; readonly mode: string }
  | { readonly kind: 'oversized'; readonly bytes: number }
  | { readonly kind: 'file'; readonly text: string; readonly blobSha: string };

export type RepositoryFilesResult =
  | {
      readonly status: 'ok';
      readonly commitSha: string;
      /** An entry for every path the request asked for, and none for a path it did not. */
      readonly files: Readonly<Partial<Record<RepositoryFilePath, RepositoryFileEntry>>>;
      /**
       * `.agentic/prompts/` at the same commit (WP-92) — present exactly when the request asked
       * for it (`promptDirectory`). The texts are **as read**: the caller redacts.
       */
      readonly prompts?: ProjectPromptReading;
      /** `true` only when `recordedCommit` was asked and the commit read is strictly older. */
      readonly behindRecorded?: boolean;
      /**
       * Whether something is at each path the request asked the presence of (WP-139) — present
       * exactly for those paths. `present` is anything at the path: a file, a symlink, a gitlink,
       * a directory. No byte of it is read.
       */
      readonly presence?: Readonly<Record<string, 'absent' | 'present'>>;
      /** The file at the request's `ciConfigPath` (WP-143) — present exactly when it was asked. */
      readonly ciConfig?: RepositoryFileEntry;
    }
  /** No mirror, no git binding, a fetch that failed, a commit that is not on the default branch. */
  | { readonly status: 'unavailable'; readonly reason: string };

export interface RepositoryFileRequest {
  readonly projectId: Id;
  readonly paths: readonly RepositoryFilePath[];
  /**
   * Paths whose **presence alone** is asked, at most {@link MAX_PRESENCE_PATHS}, each
   * {@link isPresencePath} (WP-139). The one widening of the exact-path list that reads no byte:
   * the CI gate asks whether the file the provider names as the project's CI configuration
   * (GitLab's `ci_config_path`, e.g. `deploy/.gitlab-ci.yml`) exists on the default branch. A
   * listing, never a read. Since WP-143 one provider-named path **is** read — {@link ciConfigPath},
   * the CI file itself, for the readiness CI-rules notice and R13 — and no other.
   */
  readonly presence?: readonly string[];
  /**
   * **The one provider-named path whose bytes are read** (WP-143, the second widening after
   * {@link presence}): the CI configuration's path as the provider names it (GitLab's
   * `ci_config_path`, e.g. `deploy/.gitlab-ci.yml`), {@link isPresencePath}, bounded by
   * {@link MAX_REPOSITORY_FILE_BYTES} like every file. Read for the readiness CI-rules notice and
   * R13; the caller redacts it, and nothing of it is stored but bounded job names and one rule.
   * Answered as `ciConfig`.
   */
  readonly ciConfigPath?: string;
  /**
   * Also list and read `.agentic/prompts/`'s direct `<name>.md` children at the same commit
   * (WP-92), bounded at `MAX_PROJECT_PROMPT_FILES` files of `MAX_PROJECT_PROMPT_FILE_BYTES` each.
   */
  readonly promptDirectory?: boolean;
  /** Pin the read; it must be an ancestor of the default branch. Omitted: the branch's head. */
  readonly commitSha?: string;
  /**
   * The commit of the reading already recorded (WP-63 review round 1). When given, the result
   * says whether the commit read is **strictly older** than it — an ancestor of it and not it — so
   * a late, older wake-up cannot replace a newer reading.
   */
  readonly recordedCommit?: string;
}

/** The default branch's files, read the way the knowledge vault is (TD-026). */
export interface RepositoryFileSource {
  read(request: RepositoryFileRequest): Promise<RepositoryFilesResult>;
}

/** YAML in and out, behind a port — the parser is an infrastructure dependency. */
export interface ConfigDocumentCodec {
  parse(
    text: string,
  ):
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly reason: string };
  /** A document this codec's `parse` returns unchanged — the export's promise, tested there. */
  stringify(document: JsonObject, header: readonly string[]): string;
}

/** A key the file stated that the platform does not apply, with the reason. Never silent. */
export interface RepositoryConfigNotApplied {
  readonly key: string;
  readonly reason: string;
}

/**
 * One reading of the default branch: the configuration file's state and — since WP-92 — the prompt
 * directory at the same commit, **redacted** (TD-012 step 2). `prompts` absent is *"this reading did
 * not read the prompt directory"* — a row recorded before WP-92, or a stored shape this release does
 * not know — and is read like no reading at all: a prompt file a configuration names is `unread`,
 * never assumed absent (`projectPromptsForStage`).
 */
export type RepositoryConfigSnapshot = RepositoryConfigSnapshotState & {
  readonly prompts?: ProjectPromptReading;
  /**
   * **Why this reading serves no prompt text**, or absent when nothing was withheld (WP-121, TD-012's
   * M7 amendment (1) and (3), PROGRESS backlogs 359 and 363). Present exactly when {@link prompts}
   * is absent *for a reason*: an integration whose credentials would not decrypt (WP-107's
   * fail-closed direction), or a reading stored under the pattern rules alone that has not been —
   * or could not be — read again. A run planned from it carries the same record
   * (`runs.prompts_withheld`), so a stage whose convention-append file is missing says why.
   */
  readonly promptsWithheld?: PromptsWithheld;
};

/** One integration whose credentials could not be read: its label and why. Never a value. */
export interface UnreadableIntegration {
  /** `integration "<name>" (<provider>, <id>)`. */
  readonly integration: string;
  /** The secret store's sentence. */
  readonly reason: string;
}

/**
 * Why a reading's prompt texts were withheld (WP-121): one sentence, and the integrations that
 * caused it — empty when the cause is a reading the exact-value pass never ran over.
 */
export interface PromptsWithheld {
  readonly reason: string;
  readonly integrations: readonly UnreadableIntegration[];
}

/**
 * The record as a run stores it (WP-121): every string through the run's own redactor, because the
 * labels carry an operator's integration names and the reasons a secret store's sentences. `null`
 * for nothing withheld (and for `undefined`, a settings port with no repository layer).
 */
export const redactedPromptsWithheld = (
  withheld: PromptsWithheld | null | undefined,
  redactor: SecretRedactor,
): PromptsWithheld | null =>
  withheld === null || withheld === undefined
    ? null
    : {
        reason: redactor.redactText(withheld.reason).value,
        integrations: withheld.integrations.map((entry) => ({
          integration: redactor.redactText(entry.integration).value,
          reason: redactor.redactText(entry.reason).value,
        })),
      };

/**
 * How a stored reading's prompt texts were redacted (`project_repository_config.prompts_redaction`,
 * migration 0073): `patterns` is TD-012 step 2 alone — every row written before WP-121 — and `exact`
 * is step 1 over every credential the platform holds for the project, then step 2.
 */
export type PromptsRedaction = 'patterns' | 'exact';

/**
 * The sentence a `patterns` reading is withheld with until it is read again (WP-121, backlog 359).
 * Platform text: it names no project, path or value.
 */
export const PATTERN_READING_WITHHELD_REASON =
  'this reading was stored before its prompt files were redacted by the exact values of the credentials the platform holds (TD-012, WP-121), so none of its prompt texts are served until the repository is read again — the knowledge index process re-reads it, or POST /api/projects/:project_id/config/refresh does now';

type RepositoryConfigSnapshotState =
  | { readonly status: 'absent'; readonly commitSha: string; readonly readAt: IsoDateTime }
  | {
      readonly status: 'valid';
      readonly commitSha: string;
      readonly readAt: IsoDateTime;
      /** The file minus `version`, and minus what {@link notApplied} names. */
      readonly values: ConfigValues;
      readonly notApplied: readonly RepositoryConfigNotApplied[];
    }
  | {
      readonly status: 'invalid';
      readonly commitSha: string;
      readonly readAt: IsoDateTime;
      /** Redacted and bounded ({@link MAX_REPOSITORY_CONFIG_DETAIL_CHARS}). */
      readonly detail: string;
    };

/** Where the last reading of each project's file is kept (`project_repository_config`). */
export interface RepositoryConfigStore {
  /**
   * Replaces the project's snapshot. Outside any transaction: one statement.
   *
   * The row is marked `exact` (WP-121): the one caller, {@link refreshRepositoryConfig}, has run
   * both redaction steps over every text the snapshot holds, which is what the mark asserts.
   *
   * `overPatternsOnly` (WP-121 review round 1) makes the write **conditional**: it replaces a row
   * only while that row is still `patterns` (or absent), and answers `false` when it wrote nothing.
   * The upgrade re-read uses it, because it runs outside the index queue's one-job-per-project
   * limit: an index run that recorded an `exact` reading at a newer commit between the re-read's
   * read and its write is the newer truth and is never overwritten. Every other writer replaces.
   */
  record(
    projectId: Id,
    snapshot: RepositoryConfigSnapshot,
    condition?: { readonly overPatternsOnly: true },
  ): Promise<boolean>;
  /**
   * The stored reading. A `patterns` row is answered **without** its prompt texts and with
   * {@link RepositoryConfigSnapshot.promptsWithheld} saying why (WP-121, backlog 359).
   */
  read(projectId: Id): Promise<RepositoryConfigSnapshot | null>;
}

/**
 * The readings the exact-value pass never ran over, for the re-read (WP-121, TD-012's M7
 * amendment (1)) — the `patterns` rows of `project_repository_config`.
 */
export interface PatternReadingStore {
  /**
   * Up to `limit` projects whose stored reading is `patterns`, the oldest reading first, none of
   * `excluding` (the projects this process already failed to re-read).
   */
  patternReadings(limit: number, excluding: readonly Id[]): Promise<readonly Id[]>;
  /**
   * Drops a `patterns` reading's prompt texts and records why it could not be read again. Leaves
   * the mark, so the next pass (or an index run, or the refresh) still replaces the row; a no-op on
   * a row that became `exact` meanwhile.
   */
  withholdPatternReading(projectId: Id, withheld: PromptsWithheld): Promise<void>;
}

/** Longest refusal detail stored — a list of key paths, not a document. */
export const MAX_REPOSITORY_CONFIG_DETAIL_CHARS = 600;
/** Longest single clause of it, so one enormous key cannot crowd out the others. */
const MAX_CLAUSE_CHARS = 160;

const SIMPLE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** A key path as a human types it, with any segment that is not a plain word quoted. */
const keyPathOf = (path: readonly PropertyKey[]): string =>
  path.length === 0
    ? '(root)'
    : path
        .map((segment) =>
          typeof segment === 'number'
            ? `[${segment}]`
            : SIMPLE_SEGMENT.test(String(segment))
              ? String(segment)
              : JSON.stringify(String(segment)),
        )
        .join('.')
        .replaceAll('.[', '[');

/**
 * `stages.refinement.max_turns (expected number)` — one clause per issue, **key path and message,
 * never the value**, redacted before it is bounded (`describeConfigIssues`' order, for its reason:
 * truncating first can cut a credential in half).
 */
export const describeRepositoryConfigIssues = (
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
  redactText: (value: string) => string,
): string => {
  const clauses: string[] = [];
  let length = 0;
  for (const [index, issue] of issues.entries()) {
    const clause = redactText(`${keyPathOf(issue.path)} (${issue.message})`)
      .replaceAll(/[\r\n\t]+/g, ' ')
      .slice(0, MAX_CLAUSE_CHARS);
    if (length + clause.length + 2 > MAX_REPOSITORY_CONFIG_DETAIL_CHARS - 40) {
      clauses.push(`and ${issues.length - index} more`);
      break;
    }
    clauses.push(clause);
    length += clause.length + 2;
  }
  return clauses.join('; ');
};

const bounded = (text: string): string =>
  text.replaceAll(/[\r\n\t]+/g, ' ').slice(0, MAX_REPOSITORY_CONFIG_DETAIL_CHARS);

/**
 * What one read of the file means — pure, so every branch is driven directly (standing rule 67).
 *
 * `null` entry and `absent` are the same fact: the default branch has no such file, which is a
 * project that has not exported one, and legitimately so.
 */
export const interpretRepositoryConfig = (input: {
  readonly entry: RepositoryFileEntry | undefined;
  readonly commitSha: string;
  readonly readAt: IsoDateTime;
  readonly codec: ConfigDocumentCodec;
  readonly redactText: (value: string) => string;
}): RepositoryConfigSnapshot => {
  const { entry, commitSha, readAt } = input;
  const invalid = (detail: string): RepositoryConfigSnapshot => ({
    status: 'invalid',
    commitSha,
    readAt,
    detail: bounded(detail),
  });
  if (entry === undefined || entry.kind === 'absent') {
    return { status: 'absent', commitSha, readAt };
  }
  if (entry.kind === 'not_a_file') {
    return invalid(
      `${REPOSITORY_CONFIG_PATH} is not a regular file (git mode ${entry.mode}); a symlink or a submodule is listed and never followed (TD-026 decision 9)`,
    );
  }
  if (entry.kind === 'oversized') {
    return invalid(
      `${REPOSITORY_CONFIG_PATH} is ${entry.bytes} bytes, over the ${MAX_REPOSITORY_FILE_BYTES}-byte bound for a configuration file; it was not read`,
    );
  }
  const parsed = input.codec.parse(entry.text);
  if (!parsed.ok) {
    return invalid(`(root) (not YAML: ${input.redactText(parsed.reason)})`);
  }
  // A strict schema drops nothing it knows about — but a record keyed by `__proto__` is dropped by
  // the parser under it rather than refused, so it is refused here, by path (WP-63 review round 1).
  const prototypeKey = prototypeKeyIn(parsed.value, []);
  if (prototypeKey !== null) {
    return invalid(
      `${keyPathOf(prototypeKey)} (the key "__proto__" names an object's prototype and is refused, never dropped)`,
    );
  }
  const checked = agenticConfigSchema.safeParse(parsed.value);
  if (!checked.success) {
    return invalid(describeRepositoryConfigIssues(checked.error.issues, input.redactText));
  }
  // The API refuses a knowledge directory that is absolute or has a `.`/`..` segment
  // (`createProjectRequestSchema`); the file is held to the same rule, by path (review round 2).
  const knowledgeDir = checked.data.project?.knowledge_dir;
  if (knowledgeDir !== undefined && !isRepositoryRelativeDirectory(knowledgeDir)) {
    return invalid(
      'project.knowledge_dir (must be a repository-relative directory with no "." or ".." segment)',
    );
  }
  const { version: _version, ...values } = checked.data;
  return { status: 'valid', commitSha, readAt, ...withoutNotAppliedKeys(values) };
};

/** The API's rule for a directory the platform joins paths to — not absolute, no `.`/`..`. */
export const isRepositoryRelativeDirectory = (value: string): boolean =>
  !value.startsWith('/') &&
  !value.split('/').some((segment) => segment === '..' || segment === '.');

/** The path of the first own `__proto__` key in a parsed document, or `null`. */
const prototypeKeyIn = (value: unknown, path: readonly PropertyKey[]): PropertyKey[] | null => {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = prototypeKeyIn(item, [...path, index]);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  for (const key of Reflect.ownKeys(value)) {
    if (key === '__proto__') return [...path, key];
    const found = prototypeKeyIn((value as Record<PropertyKey, unknown>)[key], [...path, key]);
    if (found !== null) return found;
  }
  return null;
};

/**
 * A stored reading read back under **this** release's rules (WP-63 review round 1).
 *
 * The row was written by whichever release read the file; a schema tightened since, or a key graded
 * *not applied* since, applies to it now rather than at the next re-read — a stored `valid` row that
 * no longer parses is the same named refusal a fresh reading would be.
 */
export const revalidateRepositorySnapshot = (
  snapshot: RepositoryConfigSnapshot | null,
  redactText: (value: string) => string,
): RepositoryConfigSnapshot | null => {
  const state = revalidateConfigState(snapshot, redactText);
  // WP-121: a withheld record survives the re-grading, which rebuilds an `invalid` row from scratch.
  const graded =
    state === null || snapshot?.promptsWithheld === undefined
      ? state
      : { ...state, promptsWithheld: snapshot.promptsWithheld };
  if (graded === null || snapshot?.prompts === undefined) return graded;
  // WP-92: the prompt directory under this release's rules — a path the reader would no longer
  // list is dropped, so a stored row cannot hand a stage a file the reader refuses today.
  return { ...graded, prompts: revalidatePromptReading(snapshot.prompts) };
};

const revalidatePromptReading = (reading: ProjectPromptReading): ProjectPromptReading => {
  const kept = Object.entries(reading.files)
    .filter(([path]) => isProjectPromptPath(path))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    files: Object.fromEntries(kept.slice(0, MAX_PROJECT_PROMPT_FILES)),
    truncated: reading.truncated || kept.length > MAX_PROJECT_PROMPT_FILES,
  };
};

const revalidateConfigState = (
  snapshot: RepositoryConfigSnapshot | null,
  redactText: (value: string) => string,
): RepositoryConfigSnapshot | null => {
  if (snapshot?.status !== 'valid') return snapshot;
  const prototypeKey = prototypeKeyIn(snapshot.values, []);
  const checked = agenticConfigSchema.safeParse({ version: 1, ...snapshot.values });
  const knowledgeDir = snapshot.values.project?.knowledge_dir;
  if (knowledgeDir !== undefined && !isRepositoryRelativeDirectory(knowledgeDir)) {
    return {
      status: 'invalid',
      commitSha: snapshot.commitSha,
      readAt: snapshot.readAt,
      detail:
        'the stored reading no longer parses under this release: project.knowledge_dir (must be a repository-relative directory with no "." or ".." segment)',
    };
  }
  if (prototypeKey !== null || !checked.success) {
    return {
      status: 'invalid',
      commitSha: snapshot.commitSha,
      readAt: snapshot.readAt,
      detail: bounded(
        `the stored reading no longer parses under this release: ${
          prototypeKey !== null
            ? keyPathOf(prototypeKey)
            : describeRepositoryConfigIssues(checked.error?.issues ?? [], redactText)
        }; re-read the file (POST /api/projects/:project_id/config/refresh)`,
      ),
    };
  }
  const { version: _version, ...values } = checked.data;
  const graded = withoutNotAppliedKeys(values);
  const seen = new Set(graded.notApplied.map((item) => item.key));
  return {
    ...snapshot,
    values: graded.values,
    notApplied: [
      ...graded.notApplied,
      ...snapshot.notApplied.filter((item) => !seen.has(item.key)),
    ],
  };
};

export interface RepositoryConfigRefreshOptions {
  readonly source: RepositoryFileSource;
  readonly codec: ConfigDocumentCodec;
  readonly store: RepositoryConfigStore;
  /** TD-012 step 2: the platform's pattern rules. Applied after {@link bindingSecrets}' values. */
  readonly redactText: (value: string) => string;
  /**
   * TD-012 step 1 at a reading — WP-107, TD-012's M6 amendment (2), PROGRESS backlog 316: the
   * **decrypted credentials of the project's bindings**, every type, named
   * `<provider>:<integrationId>:<field>` like the binding loader names them — and since WP-121
   * (TD-012's M7 amendment (2), backlogs 362 and 364) every other credential the platform holds for
   * the project: a provider's declared secret field left in a binding's `integrations.config`, and
   * the decrypted credentials of the organisation's communication accounts. Everything the reading
   * stores — the prompt files' text and an invalid file's detail — is replaced value by value before
   * the pattern rules run, so a credential the platform holds and no pattern knows, committed to
   * `.agentic/prompts/`, is not stored, not sent to the model and not kept in `runs.user_prompt`.
   *
   * Required (standing rule 31). Read once per reading, after the repository answered and only when
   * the reading will be stored; the values are held for the length of the call and never logged.
   *
   * **A binding whose credentials will not decrypt withholds the prompt texts, never the
   * configuration** (the orchestrator's ruling on PROGRESS backlog 358). The configuration half is
   * a set of restrictions — a newly merged `block` or a narrowed `commands.allow` — and a broken
   * binding must never keep one from applying, so it is stored as usual, redacted against every
   * credential that did decrypt. The prompt texts are the part this pass protects, so they fail
   * closed: the reading stores **no** prompt directory (`prompts` absent — *"this reading did not
   * read the directory"*), which also drops the previous reading's texts, and the refresh answers
   * {@link RepositoryConfigRefresh}'s `promptsWithheld` naming each integration.
   */
  readonly bindingSecrets: (projectId: Id) => Promise<ProjectBindingSecrets>;
  readonly clock: { now(): IsoDateTime };
  readonly logger?: Logger;
}

/**
 * The decrypted credentials of a project's bindings — since WP-121 every credential the platform
 * holds for the project — and the integrations whose credentials could not be decrypted (WP-107,
 * backlog 358) — reported by name rather than thrown, so one broken
 * binding withholds the prompt texts and nothing else.
 */
export interface ProjectBindingSecrets {
  readonly secrets: readonly InjectedSecret[];
  /** One per integration that could not be read: its label (name, provider, id) and why. Never a value. */
  readonly unreadable: readonly UnreadableIntegration[];
}

export type RepositoryConfigRefresh =
  | {
      readonly status: 'recorded';
      readonly snapshot: RepositoryConfigSnapshot;
      /**
       * Why this reading stored no prompt texts although the repository has a prompt directory, or
       * `null` when nothing was withheld (WP-107, backlog 358). Names every integration whose
       * credentials could not be decrypted.
       */
      readonly promptsWithheld: string | null;
    }
  /** The commit read is older than the one already recorded; the newer reading stands. */
  | { readonly status: 'stale'; readonly snapshot: RepositoryConfigSnapshot }
  /**
   * WP-121 review round 1: a conditional (`overPatternsOnly`) reading found the row already
   * replaced by an `exact` one — another reader (an index run, a refresh) recorded it meanwhile,
   * and that reading stands. Nothing was written.
   */
  | { readonly status: 'superseded' }
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * Reads the file on the default branch and records what it means.
 *
 * Outside any transaction, and it says so mechanically: it spawns `git` and may fetch, which is
 * seconds a pooled connection must not be held across.
 */
export const refreshRepositoryConfig = async (
  options: RepositoryConfigRefreshOptions,
  request: {
    readonly projectId: Id;
    readonly commitSha?: string;
    /** Write only over a `patterns` row — the upgrade re-read's condition (WP-121). */
    readonly overPatternsOnly?: true;
  },
): Promise<RepositoryConfigRefresh> => {
  assertOutsideTransaction('reading the repository configuration from the default branch');
  const logger = options.logger ?? silentLogger;
  // Asked of the store first, so the read can say whether it is older than what is recorded: a
  // pinned wake-up that arrives late (an older `default_branch.moved`) must not replace a newer
  // reading and lose a `block` it added. What bounds the residual — two readings racing between
  // this read and the write — is the index queue's one job per project (`stately`) for the index
  // run, and for the one reader outside that queue, the upgrade re-read (WP-121), the conditional
  // write (`overPatternsOnly`): it replaces only a row still `patterns`, which every other writer's
  // record turns `exact`. `POST …/config/refresh` is outside the queue too and keeps the residual
  // it has had since WP-63.
  const recorded = await options.store.read(request.projectId);
  const read = await options.source.read({
    projectId: request.projectId,
    paths: [REPOSITORY_CONFIG_PATH],
    // WP-92: the prompt directory in the same pass, so the configuration and the prompt files it
    // names describe one commit and the mirror is prepared once.
    promptDirectory: true,
    ...(request.commitSha === undefined ? {} : { commitSha: request.commitSha }),
    ...(recorded === null ? {} : { recordedCommit: recorded.commitSha }),
  });
  if (read.status === 'unavailable') {
    // Nothing is written: the previous reading stands, and an unreachable repository is not an
    // empty layer (TD-026 decision 4's rule).
    logger.warn(
      { project_id: request.projectId, reason: read.reason },
      'the repository configuration could not be read; the previous reading stands',
    );
    return { status: 'unavailable', reason: read.reason };
  }
  if (read.behindRecorded === true && recorded !== null) {
    logger.info(
      {
        project_id: request.projectId,
        commit_sha: read.commitSha,
        recorded_commit_sha: recorded.commitSha,
      },
      'the repository configuration read is older than the recorded one; the newer reading stands',
    );
    return { status: 'stale', snapshot: recorded };
  }
  const credentials = await options.bindingSecrets(request.projectId);
  const exact = bindingSecretRedactor(credentials.secrets);
  const redactText = (value: string): string => options.redactText(exact.redactText(value).value);
  const withheld = withheldPrompts(credentials, redactText);
  const interpreted = interpretRepositoryConfig({
    entry: read.files[REPOSITORY_CONFIG_PATH],
    commitSha: read.commitSha,
    readAt: options.clock.now(),
    codec: options.codec,
    redactText,
  });
  // WP-121 (backlog 363): a withheld directory is recorded on the reading, not only logged.
  const snapshot: RepositoryConfigSnapshot =
    withheld !== null
      ? { ...interpreted, promptsWithheld: withheld }
      : read.prompts === undefined
        ? interpreted
        : { ...interpreted, prompts: redactedPromptReading(read.prompts, redactText) };
  const written = await options.store.record(
    request.projectId,
    snapshot,
    ...(request.overPatternsOnly === true ? [{ overPatternsOnly: true as const }] : []),
  );
  if (!written) {
    logger.info(
      { project_id: request.projectId, commit_sha: snapshot.commitSha },
      'the repository configuration was read again, and a newer reading recorded meanwhile stands',
    );
    return { status: 'superseded' };
  }
  const promptsWithheld = withheld?.reason ?? null;
  if (promptsWithheld !== null) {
    // `error`: a credential the platform holds and cannot decrypt is a deployment defect an operator
    // must fix, and until then every stage of this project runs without its prompt files.
    logger.error(
      {
        project_id: request.projectId,
        commit_sha: snapshot.commitSha,
        unreadable_integrations: credentials.unreadable.map((entry) => entry.integration),
      },
      `the repository configuration was stored and its prompt files were not: ${promptsWithheld}`,
    );
  }
  const fields = {
    project_id: request.projectId,
    commit_sha: snapshot.commitSha,
    status: snapshot.status,
    ...(snapshot.status === 'invalid' ? { detail: snapshot.detail } : {}),
    ...(snapshot.status === 'valid' && snapshot.notApplied.length > 0
      ? { not_applied: snapshot.notApplied.map((item) => item.key) }
      : {}),
    ...(snapshot.prompts === undefined
      ? {}
      : {
          prompt_files: Object.keys(snapshot.prompts.files).length,
          prompt_files_truncated: snapshot.prompts.truncated,
        }),
  };
  if (snapshot.status === 'invalid') {
    logger.warn(
      fields,
      'the repository configuration does not parse; this project runs nothing until it does',
    );
  } else {
    logger.info(fields, 'repository configuration read');
  }
  return { status: 'recorded', snapshot, promptsWithheld };
};

/**
 * What a withheld prompt directory is recorded with, or `null` (WP-107, backlog 358) — since
 * WP-121 stored on the reading (`prompts_withheld`) and frozen with every run planned from it, as
 * well as logged (backlog 363).
 *
 * **None of the previous texts stand either**: the stored reading is one row, replaced whole, and a
 * previous prompt directory may have been stored before WP-107 under the pattern rules alone
 * (backlog 359) — keeping it would be the one choice that can carry an unredacted credential into a
 * prompt. A stage then renders a named file `unread` and a convention file not at all, and runs
 * (WP-92's rule 20: a prompt file grants nothing, so its absence refuses nothing).
 */
const withheldPrompts = (
  credentials: ProjectBindingSecrets,
  /** Both steps over the record's strings: it is stored and published (WP-121). */
  redactText: (value: string) => string,
): PromptsWithheld | null =>
  credentials.unreadable.length === 0
    ? null
    : {
        reason: redactText(
          `the credentials of ${credentials.unreadable
            .map((entry) => `${entry.integration} (${entry.reason})`)
            .join(
              '; ',
            )} cannot be decrypted, so the prompt files cannot be redacted against them and none are stored until they can (TD-012, WP-107)`,
        ),
        integrations: credentials.unreadable.map((entry) => ({
          integration: redactText(entry.integration),
          reason: redactText(entry.reason),
        })),
      };

/**
 * The prompt directory as it is stored: every text through the redactor (TD-012 step 2, and since
 * WP-107 step 1 over the project's binding credentials before it — since WP-121 every credential
 * the platform holds for the project), and the
 * rest untouched. The cut is the consumer's (`MAX_PROJECT_PROMPT_CHARS`), so redaction happens on
 * the whole text first — an exact-match redactor cannot find a secret a cap has halved.
 */
export const redactedPromptReading = (
  reading: ProjectPromptReading,
  redactText: (value: string) => string,
): ProjectPromptReading => ({
  files: Object.fromEntries(
    Object.entries(reading.files).map(([path, entry]) => [
      path,
      entry.kind === 'file' ? { ...entry, text: redactText(entry.text) } : entry,
    ]),
  ),
  truncated: reading.truncated,
});

/** What a run's settings see of a reading: the state, and the layer when there is one to merge. */
export const repositoryConfigStateOf = (
  snapshot: RepositoryConfigSnapshot | null,
): RepositoryConfigState =>
  snapshot === null
    ? { status: 'unread', commitSha: null, detail: null }
    : {
        status: snapshot.status,
        commitSha: snapshot.commitSha,
        detail: snapshot.status === 'invalid' ? snapshot.detail : null,
      };

/**
 * The configuration the pipeline reads: the settings layer with the repository's file over it
 * (Q94 (a)) under the tighten-only ruling (`repository-grades.ts`), and **no** platform default
 * written in (`mergeConfigLayers` says why).
 *
 * The repository layer is merged only when its reading is `valid`. An `invalid` reading is not
 * merged and not ignored: {@link repositoryConfigStateOf} carries it to the run, which it refuses
 * (`repositoryConfigRefusal`), and to the effective-configuration read, which refuses too. What
 * reads the result without starting a run — a gate, a notification — sees the settings alone.
 *
 * The file's `commands` are **not** merged into `values`: they narrow again after the settings'
 * (`runCommandPolicy`'s layers), so they travel separately as `repositoryCommands`.
 */
export const projectConfigWithRepository = (
  project: ConfigValues,
  snapshot: RepositoryConfigSnapshot | null,
): {
  readonly values: ConfigValues;
  readonly sources: ConfigProvenance;
  readonly repositoryCommands: ConfigValues['commands'];
  readonly notApplied: readonly RepositoryConfigNotApplied[];
} => {
  if (snapshot?.status !== 'valid') {
    return {
      ...mergeConfigLayers([{ source: 'project', values: project }]),
      repositoryCommands: undefined,
      notApplied: [],
    };
  }
  const tightened = tightenRepositoryLayer(project, snapshot.values);
  const { commands, ...rest } = tightened.values;
  return {
    ...mergeConfigLayers([
      { source: 'project', values: project },
      { source: 'repo', values: rest },
    ]),
    repositoryCommands: commands,
    notApplied: [...snapshot.notApplied, ...tightened.notApplied],
  };
};
