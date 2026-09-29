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
 * is never buffered), redacted with TD-012 step 2's pattern rules at the reading (no run-scoped
 * credential is in scope there, Q55), stored as redacted, and cut at the consumer
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

/** The block a wanted file becomes, or `null` for a convention file the project never wrote. */
const instructionOf = (
  wanted: WantedPrompt,
  reading: ProjectPromptReading | null,
): PromptProjectInstruction | null => {
  const withStatus = (status: PromptProjectInstruction['status']): PromptProjectInstruction => ({
    key: wanted.key,
    status,
    path: wanted.path,
    body: '',
  });
  if (!wanted.resolved) return withStatus('outside_directory');
  if (reading === null) return wanted.declared ? withStatus('unread') : null;
  const entry = Object.hasOwn(reading.files, wanted.path) ? reading.files[wanted.path] : undefined;
  if (entry === undefined || entry.kind === 'absent') {
    if (reading.truncated) return withStatus('not_listed');
    return wanted.declared ? withStatus('absent') : null;
  }
  if (entry.kind === 'file') {
    return { key: wanted.key, status: 'read', path: wanted.path, body: entry.text };
  }
  return withStatus(entry.kind);
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
): readonly PromptProjectInstruction[] => {
  const settings = config.stages?.[stage];
  const main = wantedFor(stage, 'prompt', settings?.prompt);
  const append = wantedFor(stage, 'prompt_append', settings?.prompt_append);
  const wanted = append.path === main.path ? [main] : [main, append];
  return wanted.flatMap((entry) => {
    const instruction = instructionOf(entry, reading);
    return instruction === null ? [] : [instruction];
  });
};
