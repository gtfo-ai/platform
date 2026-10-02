/**
 * A project's own prompt files — WP-92, PROGRESS backlog 226's prompt half.
 *
 * `stages.<id>.prompt`, `stages.<id>.prompt_append` and the convention files
 * `.agentic/prompts/<stage>.md` / `.agentic/prompts/<stage>.append.md` (product/13) were parsed and
 * never read until WP-92. This module decides **which** file a stage is given and in what state; the
 * assembler (`assemblePrompt` in `@platform/domain`) decides **how**: inside a `project_prompt` data
 * block, adding to the role prompt and never replacing it.
 *
 * ## Where the bytes come from
 *
 * The same place `.agentic/config.yml` comes from: the project's **default branch**, through the
 * platform's own mirror (`RepositoryFileSource`, TD-026), read with the configuration file in one
 * pass and pinned to the same commit (`refreshRepositoryConfig`), so the configuration and the prompt
 * files a reading records describe one commit. The reader is widened by **one named directory**,
 * {@link PROJECT_PROMPTS_DIR}, and only its direct children named `<name>.md` — never a glob over the
 * repository, never a subdirectory, never a symlink. A key's value is resolved into that directory
 * ({@link projectPromptPathOf}); a value that names anything else is reported, never read.
 *
 * Why the directory rather than exactly the paths the configuration names: the **settings** layer
 * can name a prompt file too, and it changes without a repository reading. Listing the directory at
 * the reading means a settings edit that names another file under it takes effect at the next run
 * without a re-read. And the directory is under `.agentic/`, which the default `protected_paths`
 * covers, so an agent cannot write the instruction its own next run is given.
 *
 * ## What the stored text is
 *
 * Untrusted (BD-022): anyone who can merge writes it. It is bounded before it is read
 * ({@link MAX_PROJECT_PROMPT_FILE_BYTES}, against the size `ls-tree -l` reports, so an oversized blob
 * is never buffered), redacted at the reading — TD-012 step 1 over the decrypted credentials of the
 * project's bindings (since WP-121 every credential the platform holds for the project), then step 2's
 * pattern rules (WP-107, PROGRESS backlog 316; no run-scoped
 * credential is in scope there, Q55) — stored as redacted, and cut at the consumer
 * (`MAX_PROJECT_PROMPT_CHARS`).
 *
 * ## A declared file the platform cannot read: the run proceeds and says so (standing rule 20)
 *
 * Decided, not defaulted. A project prompt **adds instructions and grants nothing**: every tool,
 * command, protected path, budget and gate a run is held to is decided elsewhere, so a run without
 * the file is a run with less project guidance, never one with more authority. Refusing the run
 * would give a missing page a veto over every task of the project. So the run goes on, and the
 * absence is stated three ways: the block is still rendered, with a `status` (`absent`,
 * `not_a_file`, `oversized`, `unread`, `outside_directory`, `not_listed`) in the marker and an empty
 * body, so the model knows the project meant to say something; the planner logs it at `warn` with
 * the key and the path; and a value outside the directory is reported in `not_applied` at the
 * settings write and at the repository reading ({@link projectPromptValueNotApplied}). A convention
 * file the project never created is **not** a declaration and produces no block at all, so a project
 * with no prompt files keeps exactly the prompt it had.
 */
import type { ConfigValues, PromptProjectInstruction } from '@platform/domain';
import { MAX_PROJECT_PROMPT_CHARS } from '@platform/domain';
import type { RepositoryConfigNotApplied, RepositoryFileEntry } from './repository-config.js';

/** The one directory outside the indexed vault whose files the reader lists (WP-92). */
export const PROJECT_PROMPTS_DIR = '.agentic/prompts';

/**
 * Bytes one prompt file may have before it is refused unread: 16 KiB, twice the characters the
 * assembler lets through per file (`MAX_PROJECT_PROMPT_CHARS`, 8 000), so the bound only bites on a
 * file that is not a page of instructions and a file under it is cut, announced, rather than refused.
 */
export const MAX_PROJECT_PROMPT_FILE_BYTES = 16 * 1_024;

/**
 * How many prompt files the reader lists. The shipped templates declare fewer than twenty stage ids
 * and each has at most two files, so 64 is room for every one of them plus a project's own names; the
 * cap exists so a directory of ten thousand files is a bounded read (at most 1 MiB stored). Past it
 * the reading records `truncated` and a file it did not list is `not_listed`, never `absent`.
 */
export const MAX_PROJECT_PROMPT_FILES = 64;

/**
 * A file name the reader accepts inside {@link PROJECT_PROMPTS_DIR}: the platform's marker alphabet,
 * a leading alphanumeric (so neither `.` nor `..` nor a dotfile), ending in `.md`.
 */
export const PROJECT_PROMPT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,96}\.md$/;

/** The prompt directory as one reading saw it. Every entry is a direct child named `<name>.md`. */
export interface ProjectPromptReading {
  /** Repository path → what the reader found. Never `absent`: an absent file has no entry. */
  readonly files: Readonly<Record<string, RepositoryFileEntry>>;
  /** More than {@link MAX_PROJECT_PROMPT_FILES} matched; the ones past it (by path) were not listed. */
  readonly truncated: boolean;
}

/**
 * The repository path a key's value names, or `null` when it names nothing the platform reads.
 *
 * Two spellings, one file: `prompts/<name>.md` (technical/12's example, relative to `.agentic/`, as
 * `.agentic/pipeline.yml`'s own `prompt:` keys are) and `.agentic/prompts/<name>.md` (from the
 * repository root). Anything else — another directory, a subdirectory, `..`, an absolute path, a glob
 * — is `null`.
 */
export const projectPromptPathOf = (value: string): string | null => {
  const name = value.startsWith(`${PROJECT_PROMPTS_DIR}/`)
    ? value.slice(PROJECT_PROMPTS_DIR.length + 1)
    : value.startsWith('prompts/')
      ? value.slice('prompts/'.length)
      : null;
  return name !== null && PROJECT_PROMPT_FILE_NAME.test(name)
    ? `${PROJECT_PROMPTS_DIR}/${name}`
    : null;
};

/** Is this repository path one the prompt reader lists? */
export const isProjectPromptPath = (repositoryPath: string): boolean =>
  repositoryPath.startsWith(`${PROJECT_PROMPTS_DIR}/`) &&
  PROJECT_PROMPT_FILE_NAME.test(repositoryPath.slice(PROJECT_PROMPTS_DIR.length + 1));

const VALUE_OUTSIDE_REASON = `a project prompt file must be under ${PROJECT_PROMPTS_DIR}/ and named <name>.md (written "prompts/<name>.md" or "${PROJECT_PROMPTS_DIR}/<name>.md"); this value names a file the platform does not read, so the stage runs without it`;

/**
 * The prompt keys whose **value** the platform will not read, with the reason — for the settings
 * write (`settingsNotApplied`) and the repository reading (`withoutNotAppliedKeys`) alike. A key
 * whose value resolves is read and is not listed.
 */
export const projectPromptValueNotApplied = (
  values: ConfigValues,
): readonly RepositoryConfigNotApplied[] =>
  Object.entries(values.stages ?? {}).flatMap(([stage, settings]) =>
    (['prompt', 'prompt_append'] as const).flatMap((key) => {
      const value = settings?.[key];
      return value === undefined || projectPromptPathOf(value) !== null
        ? []
        : [{ key: `stages.${stage}.${key}`, reason: VALUE_OUTSIDE_REASON }];
    }),
  );

/** One file a stage asks for, and whether the configuration asked for it or the convention did. */
interface WantedPrompt {
  readonly key: 'prompt' | 'prompt_append';
  /** The repository path, or the raw value when it resolves to none. */
  readonly path: string;
  readonly resolved: boolean;
  readonly declared: boolean;
}

const wantedFor = (
  stage: string,
  key: 'prompt' | 'prompt_append',
  value: string | undefined,
): WantedPrompt => {
  if (value === undefined) {
    const suffix = key === 'prompt' ? '.md' : '.append.md';
    return {
      key,
      path: `${PROJECT_PROMPTS_DIR}/${stage}${suffix}`,
      resolved: true,
      declared: false,
    };
  }
  const resolved = projectPromptPathOf(value);
  return { key, path: resolved ?? value, resolved: resolved !== null, declared: true };
};

/**
 * What the planner makes of one wanted file: the status it would render, whether it renders a block
 * at all, and the body (empty unless `read`). One function for the planner and the read surface
 * ({@link stagePromptResolutions}), so the screen and the prompt cannot disagree (standing rule 41).
 */
const resolve = (
  wanted: WantedPrompt,
  reading: ProjectPromptReading | null,
): {
  readonly status: PromptProjectInstruction['status'];
  readonly given: boolean;
  readonly body: string;
} => {
  const stated = (status: PromptProjectInstruction['status'], given: boolean) => ({
    status,
    given,
    body: '',
  });
  if (!wanted.resolved) return stated('outside_directory', true);
  if (reading === null) return stated('unread', wanted.declared);
  const entry = Object.hasOwn(reading.files, wanted.path) ? reading.files[wanted.path] : undefined;
  if (entry === undefined || entry.kind === 'absent') {
    if (reading.truncated) return stated('not_listed', true);
    return stated('absent', wanted.declared);
  }
  if (entry.kind === 'file') {
    return { status: 'read', given: true, body: entry.text };
  }
  return stated(entry.kind, true);
};

/** The block a wanted file becomes, or `null` for a convention file the project never wrote. */
const instructionOf = (
  wanted: WantedPrompt,
  reading: ProjectPromptReading | null,
): PromptProjectInstruction | null => {
  const resolved = resolve(wanted, reading);
  return resolved.given
    ? { key: wanted.key, status: resolved.status, path: wanted.path, body: resolved.body }
    : null;
};

/** The files one stage asks for: `prompt` first, and `prompt_append` unless it names the same file. */
const wantedForStage = (stage: string, config: ConfigValues): readonly WantedPrompt[] => {
  const settings = config.stages?.[stage];
  const main = wantedFor(stage, 'prompt', settings?.prompt);
  const append = wantedFor(stage, 'prompt_append', settings?.prompt_append);
  return append.path === main.path ? [main] : [main, append];
};

/**
 * The project prompt blocks one stage's run is given, `prompt` first and `prompt_append` second.
 *
 * `config` is the configuration the planner already reads (the settings with the repository file
 * merged over them), and `reading` the last reading's prompt directory — `null` when nothing has read
 * it (no reading yet, a reading made before WP-92, a process with no repository layer). Two keys
 * naming the same file give one block, under `prompt`.
 */
export const projectPromptsForStage = (
  stage: string,
  config: ConfigValues,
  reading: ProjectPromptReading | null,
): readonly PromptProjectInstruction[] =>
  wantedForStage(stage, config).flatMap((entry) => {
    const instruction = instructionOf(entry, reading);
    return instruction === null ? [] : [instruction];
  });

/**
 * One key of one stage as the planner would resolve it now — WP-113, PROGRESS backlog 315 (a).
 *
 * The read surface's answer to *"which file would this stage be given, and in what state?"*, built
 * by the planner's own resolution ({@link projectPromptsForStage} reads the same `resolve`), so a
 * screen that shows it cannot disagree with the next prompt. **Never the text**: the length and
 * whether the {@link MAX_PROJECT_PROMPT_CHARS} cut would apply are what a reader needs to know
 * before a run, and the text a run actually got is the run's own `/prompt` (standing rules 13/37).
 */
export interface StagePromptResolution {
  readonly stage: string;
  readonly key: 'prompt' | 'prompt_append';
  /** The repository path — or, for `outside_directory`, the key's value as written. */
  readonly path: string;
  /** The configuration names the file; `false` is the convention name `<stage>.md`/`.append.md`. */
  readonly declared: boolean;
  readonly status: PromptProjectInstruction['status'];
  /**
   * Whether the stage's prompt carries a block for it. `false` for a convention file the project
   * never wrote (no declaration, no block — WP-92's rule) and for a `prompt_append` that names the
   * same file as `prompt`, which is given once, under `prompt`.
   */
  readonly given: boolean;
  /** The stored (redacted) text is longer than the cut, so a run gets its first 8 000 characters. */
  readonly cut: boolean;
}

/** Every key of one stage, `prompt` then `prompt_append`, both always listed. */
export const stagePromptResolutions = (
  stage: string,
  config: ConfigValues,
  reading: ProjectPromptReading | null,
): readonly StagePromptResolution[] => {
  const given = wantedForStage(stage, config);
  const settings = config.stages?.[stage];
  return (['prompt', 'prompt_append'] as const).map((key) => {
    const wanted = wantedFor(stage, key, settings?.[key]);
    const resolved = resolve(wanted, reading);
    const isGiven = given.some((entry) => entry.key === key) && resolved.given;
    return {
      stage,
      key,
      path: wanted.path,
      declared: wanted.declared,
      status: resolved.status,
      given: isGiven,
      cut: resolved.status === 'read' && resolved.body.length > MAX_PROJECT_PROMPT_CHARS,
    };
  });
};

/** One file of the stored reading as the read surface publishes it — never its text. */
export interface ProjectPromptFileSummary {
  readonly path: string;
  readonly status: 'file' | 'not_a_file' | 'oversized';
  /**
   * The stored text's length in UTF-16 code units — the unit `MAX_PROJECT_PROMPT_CHARS` counts — so
   * **after** redaction and **before** the cut; `null` unless `file`.
   */
  readonly chars: number | null;
  /** The blob size the reader refused it at; `null` unless `oversized`. */
  readonly bytes: number | null;
  /** Whether a stage given this file gets only its first {@link MAX_PROJECT_PROMPT_CHARS}. */
  readonly cut: boolean;
}

/**
 * The prompt half of a stored reading, for `GET …/config` and `POST …/config/refresh` (WP-113,
 * backlog 315 (a)): per file the path, the status, the pre-cut length and whether the cut applies,
 * sorted by path. Bounded by the reading itself ({@link MAX_PROJECT_PROMPT_FILES} entries).
 */
export const projectPromptReadingSummary = (
  reading: ProjectPromptReading,
): readonly ProjectPromptFileSummary[] =>
  Object.entries(reading.files)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([path, entry]): ProjectPromptFileSummary[] => {
      if (entry.kind === 'file') {
        return [
          {
            path,
            status: 'file',
            chars: entry.text.length,
            bytes: null,
            cut: entry.text.length > MAX_PROJECT_PROMPT_CHARS,
          },
        ];
      }
      if (entry.kind === 'oversized') {
        return [{ path, status: 'oversized', chars: null, bytes: entry.bytes, cut: false }];
      }
      if (entry.kind === 'not_a_file') {
        return [{ path, status: 'not_a_file', chars: null, bytes: null, cut: false }];
      }
      // `absent` is never stored (the reading lists what it found); a row that holds one says
      // nothing worth publishing.
      return [];
    });
