/**
 * The project's own prompt files on its settings page — WP-113, PROGRESS backlog 315 (b).
 *
 * Since WP-92 a stage is given the project's `.agentic/prompts/<stage>.md` and
 * `<stage>.append.md` (or the file its `prompt` / `prompt_append` key names) as a data block beside
 * the role prompt, read from the default branch at the platform's last **reading** — and until this
 * card nobody could see which files that reading held or which a stage would be given, so a
 * maintainer who merged an edit learnt whether it was in effect only from a run that had spent
 * money. Two halves, both the server's answer (`GET …/config`):
 *
 *  - **the reading** — `repository.prompts`: per file the path, status, length and whether the
 *    8 000-character cut applies, at `repository.commit_sha`. Never the text (the run's own
 *    *Prompt* tab shows what a run was given).
 *  - **the stages** — `stage_prompts`: the planner's own resolution of each stage's two keys; this
 *    card lists the ones a stage is given or the configuration names.
 *
 * *Re-read now* is the existing `POST …/config/refresh` (WP-63), the same command as the repository
 * card's button. Every string from the server — paths, a configured value — is rendered as text
 * through `ui/untrusted.tsx` (BD-022); nothing here is a link.
 */
import type { EffectiveConfigResponse } from '@platform/contracts';
import type { ReactElement } from 'react';
import { useOnboardingCommands, useProjectConfig } from '../app/queries.js';
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  formatDateTime,
  formatInteger,
  SectionHeading,
} from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

type StagePrompt = EffectiveConfigResponse['stage_prompts'][number];
type PromptFile = NonNullable<EffectiveConfigResponse['repository']['prompts']>['files'][number];

/** What a stage's run is told about a file, in the screen's words. */
export const STAGE_PROMPT_STATUS_LABEL: Readonly<Record<StagePrompt['status'], string>> = {
  read: 'given',
  absent: 'named, and not on the default branch — the stage runs without it',
  not_a_file: 'not a regular file (a link or a directory) — not read',
  oversized: 'over 16 KiB — not read',
  unread: 'no reading holds the prompt directory yet',
  outside_directory: 'names a file outside .agentic/prompts/ — never read',
  not_listed: 'the directory held more than 64 files and this one was not listed',
};

const fileLine = (file: PromptFile, cutAt: number): string => {
  if (file.status === 'oversized') {
    return `${formatInteger(file.bytes ?? 0)} bytes — over 16 KiB, not read`;
  }
  if (file.status === 'not_a_file') {
    return 'not a regular file — not read';
  }
  return file.cut
    ? `${formatInteger(file.chars ?? 0)} characters — a stage gets the first ${formatInteger(cutAt)}`
    : `${formatInteger(file.chars ?? 0)} characters`;
};

export const ProjectPromptFiles = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const config = useProjectConfig(projectId);
  const commands = useOnboardingCommands();
  const refresh = commands.refreshConfig;
  const repository = config.data?.repository;
  const prompts = repository?.prompts ?? null;
  const stages = (config.data?.stage_prompts ?? []).filter(
    (entry) => entry.given || entry.declared,
  );

  return (
    <Card className="flex flex-col gap-2">
      <SectionHeading>Project prompt files</SectionHeading>
      <p className="text-xs text-fg-muted">
        Files under <code>.agentic/prompts/</code> on the default branch add a stage’s own
        instructions to its role prompt: <code>&lt;stage&gt;.md</code> and{' '}
        <code>&lt;stage&gt;.append.md</code>, or the file a stage’s <code>prompt</code> /{' '}
        <code>prompt_append</code> key names. A stage gets at most the first{' '}
        {formatInteger(prompts?.cut_at_chars ?? 8_000)} characters of each. An edit applies at the{' '}
        <strong>next reading</strong> — after the next knowledge index run, or when you re-read now
        — never at the merge.
      </p>
      {repository === undefined ? null : (
        <p className="flex flex-wrap items-center gap-2 text-xs">
          {repository.commit_sha === null ? (
            <span className="text-fg-muted">The repository has not been read yet.</span>
          ) : (
            <span className="text-fg-muted">
              Last reading at{' '}
              <span className="font-mono">
                <UntrustedText value={repository.commit_sha.slice(0, 12)} />
              </span>
              {repository.read_at === null ? null : `, ${formatDateTime(repository.read_at)}`}
            </span>
          )}
        </p>
      )}
      {repository === undefined ? null : prompts === null ? (
        <p className="text-xs text-fg-muted">
          This reading holds no prompt files: nothing has read the repository yet, it was read
          before prompt files were, or the prompt texts were withheld because an integration’s
          credentials could not be decrypted (a re-read says which). Until a reading holds them, a
          stage is given no prompt file, and a file a stage’s key names is reported unread.
        </p>
      ) : prompts.files.length === 0 ? (
        <p className="text-xs text-fg-muted">
          The prompt directory held no <code>.md</code> files at that commit.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs" aria-label="Prompt files in the last reading">
          {prompts.files.map((file) => (
            <li key={file.path} className="flex flex-wrap items-center gap-2">
              <code>
                <UntrustedText value={file.path} />
              </code>
              <Badge tone={file.status === 'file' ? 'success' : 'warning'}>{file.status}</Badge>
              <span className="text-fg-muted">{fileLine(file, prompts.cut_at_chars)}</span>
              {file.cut ? <Badge tone="warning">cut</Badge> : null}
            </li>
          ))}
        </ul>
      )}
      {prompts?.truncated === true ? (
        <p className="text-xs text-fg-muted">
          The directory held more than 64 files; the ones past the bound were not read.
        </p>
      ) : null}
      {config.data === undefined ? null : stages.length === 0 ? (
        <p className="text-xs text-fg-muted">No stage is given a project prompt file.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs" aria-label="What each stage is given">
          {stages.map((entry) => (
            <li key={`${entry.stage}:${entry.key}`} className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">{entry.stage}</Badge>
              <span>{entry.key}</span>
              <code>
                <UntrustedText value={entry.path} />
              </code>
              <span className="text-fg-muted">
                {entry.declared ? 'named by the configuration' : 'by its conventional name'} —{' '}
                {entry.given || entry.status !== 'read'
                  ? STAGE_PROMPT_STATUS_LABEL[entry.status]
                  : 'the same file as prompt, given once'}
              </span>
              {entry.cut ? <Badge tone="warning">cut</Badge> : null}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          disabled={refresh.isPending}
          onClick={() => {
            refresh.mutate(projectId);
          }}
        >
          Re-read now
        </Button>
      </div>
      {refresh.isSuccess && refresh.data.prompts_withheld !== undefined ? (
        <ErrorNotice
          title="The configuration was read and the prompt files were not."
          detail={refresh.data.prompts_withheld}
        />
      ) : null}
      {refresh.isError ? (
        <ErrorNotice title="The repository could not be re-read." detail={String(refresh.error)} />
      ) : null}
    </Card>
  );
};
