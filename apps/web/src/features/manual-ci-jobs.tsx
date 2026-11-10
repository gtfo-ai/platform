/**
 * **Manual CI jobs** — which of the jobs a project's CI holds until somebody starts them the platform
 * starts itself, waits for, or leaves alone (S-28.7, the M28 ruling on the owner's feedback of
 * 2026-11-10: *"for Autix `codeception` we want triggered; optional manual deploy jobs we do not"*).
 *
 * One key of the settings document, `pipeline.ci.manual_jobs` — an exact job name → `run` | `wait` |
 * `ignore` — written through `PUT /api/projects/:id/config` with the **whole** document and the hash
 * it was read at, as `verification-mode.tsx` writes its key. The card lists the manual jobs **seen**
 * in the project's recent task pipelines (`GET …/ci/manual-jobs`) with their stage, whether each
 * blocks the pipeline, and a hint when one reads like a deployment, and a three-way choice for each;
 * a name not seen yet can be typed, and a chosen name no recent pipeline has is flagged *never seen
 * in a pipeline* (BACKLOG 1474) — a typo would otherwise be silent.
 *
 * - **Start it automatically** is not offered for a job that starts another pipeline (a trigger job):
 *   the platform does not start those in this version, and the card says so.
 * - `run` and `ignore` are the **settings'** to say: the repository's settings file may only add
 *   *Wait for a person*, and what it asked for and was not applied is shown here.
 * - A name the settings also list in `required_manual_jobs` means *wait* there, so choosing *start
 *   it* or *don't run* here takes it out of that list in the same write (the schema refuses the same
 *   name with two meanings).
 *
 * Every job name and stage is the git host's text (BD-022): rendered as text nodes only.
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useManualJobsSeen, useOnboardingCommands, useProjectConfig } from '../app/queries.js';
import { Badge, Button, Card, ErrorNotice, Loading, SectionHeading } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';
import {
  MANUAL_CI_JOBS_ANCHOR,
  MANUAL_JOB_MODE_HINT,
  MANUAL_JOB_MODE_LABEL,
} from '../ui/words/ci-manual-jobs.js';

type Mode = 'run' | 'wait' | 'ignore';
const MODES: readonly Mode[] = ['run', 'wait', 'ignore'];

/** The longest job name the schema accepts (`MAX_REQUIRED_MANUAL_JOB_CHARS`). */
const MAX_NAME_CHARS = 255;
/** The most jobs the schema accepts (`MAX_MANUAL_JOB_MODES`). */
const MAX_JOBS = 50;

type Json = Record<string, unknown>;
const objectOf = (value: unknown): Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};

/** The settings layer's `pipeline.ci.manual_jobs`, the three words only. */
export const settingsModesOf = (document: unknown): Readonly<Record<string, Mode>> => {
  const stated = objectOf(objectOf(objectOf(document).pipeline).ci).manual_jobs;
  const modes: Record<string, Mode> = {};
  for (const [name, mode] of Object.entries(objectOf(stated))) {
    if (mode === 'run' || mode === 'wait' || mode === 'ignore') modes[name] = mode;
  }
  return modes;
};

/**
 * The settings document with `modes` as its `pipeline.ci.manual_jobs` — and every name chosen `run`
 * or `ignore` taken out of `required_manual_jobs`, whose list means *wait* (an emptied list stays
 * `[]`: *exactly these* with none left is what it said about every other job).
 */
export const withManualJobModes = (document: Json, modes: Readonly<Record<string, Mode>>): Json => {
  const pipeline = objectOf(document.pipeline);
  const { manual_jobs: _previous, ...ci } = objectOf(pipeline.ci);
  const required = ci.required_manual_jobs;
  const nextCi: Json = {
    ...ci,
    ...(Array.isArray(required)
      ? {
          required_manual_jobs: required.filter(
            (name) =>
              !(typeof name === 'string' && (modes[name] === 'run' || modes[name] === 'ignore')),
          ),
        }
      : {}),
    ...(Object.keys(modes).length === 0 ? {} : { manual_jobs: { ...modes } }),
  };
  return { ...document, pipeline: { ...pipeline, ci: nextCi } };
};

interface Row {
  readonly name: string;
  readonly stage: string | null;
  readonly blocking: boolean | null;
  readonly trigger: boolean;
  readonly deployLike: boolean;
}

export const ManualCiJobs = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const config = useProjectConfig(projectId);
  const seen = useManualJobsSeen(projectId);
  const commands = useOnboardingCommands();
  const [draft, setDraft] = useState<Readonly<Record<string, Mode>> | null>(null);
  const [typed, setTyped] = useState('');

  const stored = config.isSuccess ? settingsModesOf(config.data.config) : {};
  const modes = draft ?? stored;
  const seenJobs = seen.isSuccess ? seen.data.jobs : [];
  const namesSeen = new Set(seen.isSuccess ? seen.data.names_seen : []);
  const rows: Row[] = [
    ...seenJobs.map((job) => ({
      name: job.name,
      stage: job.stage,
      blocking: job.blocking,
      trigger: job.trigger,
      deployLike: job.deploy_like,
    })),
    ...Object.keys(modes)
      .filter((name) => !seenJobs.some((job) => job.name === name))
      .map((name) => ({ name, stage: null, blocking: null, trigger: false, deployLike: false })),
  ];
  const notApplied = config.isSuccess
    ? [...config.data.not_applied, ...config.data.repository.not_applied].filter((item) =>
        item.key.startsWith('pipeline.ci.manual_jobs'),
      )
    : [];
  const changed = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored);

  const choose = (name: string, mode: Mode | null): void => {
    const next: Record<string, Mode> = { ...modes };
    if (mode === null) {
      delete next[name];
    } else {
      next[name] = mode;
    }
    setDraft(next);
  };
  const add = (): void => {
    const name = typed.trim();
    if (name.length === 0 || name.length > MAX_NAME_CHARS || Object.hasOwn(modes, name)) return;
    choose(name, 'wait');
    setTyped('');
  };
  const save = (): void => {
    if (!config.isSuccess) return;
    commands.writeConfig.mutate(
      {
        projectId,
        config: withManualJobModes(config.data.config as Json, modes),
        base_hash: config.data.hash,
      },
      { onSuccess: () => setDraft(null) },
    );
  };

  return (
    <Card className="flex flex-col gap-2">
      <div id={MANUAL_CI_JOBS_ANCHOR}>
        <SectionHeading>Manual CI jobs</SectionHeading>
      </div>
      <p className="text-sm text-fg-muted" data-manual-jobs-intro="">
        Some CI jobs do not run until someone starts them. Choose, per job, whether the platform
        starts it itself, waits for a person to start it, or neither runs nor waits for it. A job
        you do not choose for is never started: CI waits for it only when it is a test job.
      </p>
      <p className="text-xs text-fg-muted" data-manual-jobs-draft-note="">
        This project’s CI holds jobs while the merge request is a draft; the platform keeps it a
        draft until the task is ready, so choose which held jobs it should start itself.
      </p>
      {config.isPending || seen.isPending ? <Loading label="Reading recent pipelines…" /> : null}
      {config.isError ? (
        <ErrorNotice
          title="The manual job choices could not be read: the project’s configuration did not load."
          error={config.error}
        />
      ) : null}
      {seen.isError ? (
        <ErrorNotice title="The jobs of recent pipelines could not be listed." error={seen.error} />
      ) : null}
      {seen.isSuccess && seen.data.heads_read === 0 && rows.length === 0 ? (
        <p className="text-xs text-fg-muted">
          No task pipeline has been read yet, so no job is listed. Type a job’s name below to choose
          for it now.
        </p>
      ) : null}
      {rows.map((row, index) => {
        const mode = Object.hasOwn(modes, row.name) ? modes[row.name] : undefined;
        const neverSeen = seen.isSuccess && !namesSeen.has(row.name);
        return (
          <fieldset
            key={row.name}
            className="flex flex-col gap-1 border-t border-line pt-2"
            disabled={!config.isSuccess || commands.writeConfig.isPending}
            data-manual-job={row.name}
          >
            <legend className="flex flex-wrap items-center gap-2 text-sm">
              <strong>
                <UntrustedText value={row.name} />
              </strong>
              {row.stage === null ? null : (
                <span className="text-xs text-fg-muted">
                  stage <UntrustedText value={row.stage} />
                </span>
              )}
              {row.blocking === null ? null : row.blocking ? (
                <Badge tone="warning">blocks the pipeline</Badge>
              ) : (
                <Badge>optional</Badge>
              )}
              {row.deployLike ? <Badge tone="danger">looks like a deployment</Badge> : null}
              {neverSeen ? (
                <Badge tone="warning">never seen in a pipeline — check the name</Badge>
              ) : null}
            </legend>
            {MODES.map((choice) => {
              const refused = choice === 'run' && row.trigger;
              return (
                <label key={choice} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name={`manual-job-${String(index)}`}
                    value={choice}
                    checked={mode === choice}
                    disabled={refused}
                    onChange={() => choose(row.name, choice)}
                  />
                  <span>
                    {MANUAL_JOB_MODE_LABEL[choice]}
                    <span className="block text-xs text-fg-muted">
                      {refused
                        ? 'This is a trigger job: trigger jobs can’t be started by the platform — a person starts them. Choose Wait for a person or Don’t run, don’t wait.'
                        : MANUAL_JOB_MODE_HINT[choice]}
                    </span>
                  </span>
                </label>
              );
            })}
            {mode === undefined ? (
              <p className="text-xs text-fg-muted">
                Not chosen: never started; CI waits for it only if it is a test job.
              </p>
            ) : (
              <div>
                <Button onClick={() => choose(row.name, null)}>Clear the choice</Button>
              </div>
            )}
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
        <label className="flex flex-col gap-1 text-xs">
          A job not listed yet (its exact name)
          <input
            type="text"
            className="rounded-md border border-line-input bg-inset px-2 py-1 text-sm"
            value={typed}
            maxLength={MAX_NAME_CHARS}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        <Button
          disabled={
            typed.trim().length === 0 ||
            Object.hasOwn(modes, typed.trim()) ||
            Object.keys(modes).length >= MAX_JOBS
          }
          onClick={add}
        >
          Add job
        </Button>
      </div>
      {notApplied.map((item) => (
        <p key={item.key} className="text-xs text-fg-muted" data-manual-jobs-not-applied="">
          The repository’s settings file asked for <code>{item.key}</code>, which was not applied:{' '}
          <UntrustedText value={item.reason} />
        </p>
      ))}
      <p className="text-xs text-fg-muted">
        Only these settings can tell the platform to start a job or to not count one; the
        repository’s settings file may only add Wait for a person.
      </p>
      <div>
        <Button tone="primary" disabled={!changed || commands.writeConfig.isPending} onClick={save}>
          Save manual job choices
        </Button>
      </div>
      {commands.writeConfig.isError ? (
        <ErrorNotice
          title="The manual job choices were not saved."
          error={commands.writeConfig.error}
        />
      ) : null}
    </Card>
  );
};
