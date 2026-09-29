-- 0063 — a project's own prompt files, read with its configuration (WP-92, PROGRESS backlog 226).
--
-- `stages.<id>.prompt`, `stages.<id>.prompt_append` and the convention files
-- `.agentic/prompts/<stage>.md` / `<stage>.append.md` were parsed and never read. The reader is the
-- one that already reads `.agentic/config.yml` from the default branch (`refreshRepositoryConfig`,
-- migration 0050), widened by one named directory: in the same pass, pinned to the same commit, it
-- lists `.agentic/prompts/` and reads its direct `<name>.md` children. This column is what it read,
-- so the configuration and the prompt files a row records describe one commit.
--
-- **Shape**: `{"files": {"<repository path>": <entry>}, "truncated": <boolean>}`, where an entry is
-- `{"kind": "file", "text": …, "blobSha": …}`, `{"kind": "oversized", "bytes": …}` or
-- `{"kind": "not_a_file", "mode": …}` — the reader's own `RepositoryFileEntry`.
--
-- **Untrusted text, bounded and redacted**: at most `MAX_PROJECT_PROMPT_FILES` (64) entries, a file
-- over `MAX_PROJECT_PROMPT_FILE_BYTES` (16 KiB) is recorded `oversized` and never read, and every
-- text is written through TD-012 step 2's pattern redactor. The cut to what a prompt carries is the
-- assembler's (`MAX_PROJECT_PROMPT_CHARS`), never here.
--
-- **`null` is "this reading did not read the prompt directory"** — every row recorded before this
-- migration — and a prompt file a configuration names is then rendered `unread`, never assumed
-- absent. A reading that could not reach the repository still writes nothing (0050's rule).
alter table project_repository_config add column prompts jsonb;

-- `coalesce(…, false)`: a missing key makes `jsonb_typeof` null, and a check whose expression is
-- null *passes* — without it `{"files": {}}` (no `truncated`) was accepted (measured, WP-92).
alter table project_repository_config
  add constraint project_repository_config_prompts_shape check (
    prompts is null
    or coalesce(
      jsonb_typeof(prompts) = 'object'
      and jsonb_typeof(prompts -> 'files') = 'object'
      and jsonb_typeof(prompts -> 'truncated') = 'boolean',
      false
    )
  );
