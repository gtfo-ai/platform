/**
 * **Execution** — who runs a project's agents (WP-278, TD-031 decision 8, BD-032 decisions 3 and 5),
 * on the project settings page; in plain words since S-23.20 (the worker UX review E2–E4, E7).
 *
 * The whole setting in one form: **who runs this project's agents** — workers only, workers first,
 * the platform server first, or the platform server only (the stored `mode` and `prefer`, one
 * choice); with a preference, **how long the first side has** before the other may take a run (the
 * fallback); the **head start** the ticket's assignee's — or an ask's asker's — online worker gets;
 * and **when to give up** on a run nobody takes and ask a person (the offer timeout). Durations are
 * chosen as durations; raw seconds are behind *Custom…*. An administrator's
 * (`project.settings.write`); the server answers a maintainer's save with a 403, which the error
 * notice shows.
 *
 * What the card says beside it is the server's: whether the platform server runs agent work on this
 * platform at all (`server_claimant`), the server's sentence about what that does to this choice
 * (`notice`), and — recognised by the contracts' constant — that the project's git connection keeps
 * its run credential off developers' computers, which the card says in its own words with a link to
 * that connection rather than as a configuration key. It is **never** a key of
 * `.agentic/config.yml`, and a disclosure says so, because a reader who knows the file will look
 * there first. Every value shown is the platform's own, apart from the git connection's name
 * (an operator's text, rendered as text).
 */
import { REMOTE_RUN_CREDENTIAL_REFUSED_NOTICE } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useId, useState } from 'react';
import { useProjectBindings, useProjectExecution, useSettingsCommands } from '../app/queries.js';
import { DetailsDisclosure } from '../ui/details.js';
import { Button, ErrorNotice, Field } from '../ui/kit.js';
import { StatusIcon } from '../ui/status.js';
import { UntrustedText } from '../ui/untrusted.js';

type Mode = 'server_only' | 'workers_only' | 'hybrid';
type Prefer = 'server' | 'workers';

/** The one choice a person makes: the stored `mode` and, for `hybrid`, its `prefer`. */
export type ExecutionChoice = 'workers_only' | 'prefer_workers' | 'prefer_server' | 'server_only';

export const EXECUTION_CHOICES: Readonly<
  Record<ExecutionChoice, { readonly label: string; readonly means: string }>
> = {
  workers_only: {
    label: 'Workers only',
    means: 'Only developers’ own computers run its stages; the platform server never does.',
  },
  prefer_workers: {
    label: 'Prefer workers',
    means:
      'A worker may take each run first; the platform server takes it if no worker does in time.',
  },
  prefer_server: {
    label: 'Prefer the platform server',
    means:
      'The platform server takes each run first; a worker may take it if the server does not in time.',
  },
  server_only: {
    label: 'Platform server only',
    means: 'Only the platform server runs its stages; no worker ever takes one.',
  },
};

export const choiceOf = (mode: Mode, prefer: Prefer): ExecutionChoice =>
  mode === 'hybrid' ? (prefer === 'workers' ? 'prefer_workers' : 'prefer_server') : mode;

/** The stored setting for a choice; a choice with no preference keeps the one it had. */
const settingOf = (choice: ExecutionChoice, prefer: Prefer): { mode: Mode; prefer: Prefer } => {
  switch (choice) {
    case 'prefer_workers':
      return { mode: 'hybrid', prefer: 'workers' };
    case 'prefer_server':
      return { mode: 'hybrid', prefer: 'server' };
    default:
      return { mode: choice, prefer };
  }
};

/** `15` → `15 s`, `300` → `5 min`, `7200` → `2 h`, `86400` → `1 day`. */
export const formatSeconds = (seconds: number): string => {
  if (seconds >= 86_400 && seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (seconds >= 3600 && seconds % 3600 === 0) {
    return `${seconds / 3600} h`;
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    return `${seconds / 60} min`;
  }
  return `${seconds} s`;
};

/** What the form holds: the numbers as typed, so a half-typed value is not coerced. */
interface Draft {
  readonly choice: ExecutionChoice;
  /** The preference a choice without one keeps (sent as stored). */
  readonly prefer: Prefer;
  /** `''` is the preference's default. */
  readonly fallback: string;
  readonly window: string;
  readonly timeout: string;
}

const whole = (value: string): number | null => (/^\d+$/.test(value.trim()) ? Number(value) : null);

const selectClass = 'rounded-md border border-line-input bg-inset px-2 py-1 text-sm';

const CUSTOM = 'custom';

/**
 * A duration picked from a few presets, or typed in seconds under *Custom…*. `value` is the form's
 * string of seconds (`''` is the default, when `defaultLabel` offers one).
 */
const DurationField = ({
  label,
  hint,
  value,
  presets,
  defaultLabel,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly presets: readonly number[];
  readonly defaultLabel?: string;
  readonly onChange: (value: string) => void;
}): ReactElement => {
  const id = useId();
  const known =
    (value === '' && defaultLabel !== undefined) || presets.some((s) => String(s) === value);
  const [custom, setCustom] = useState(!known);
  const selected = custom ? CUSTOM : value;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={id}
          className={selectClass}
          value={selected}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            if (event.target.value === CUSTOM) {
              setCustom(true);
              return;
            }
            setCustom(false);
            onChange(event.target.value);
          }}
        >
          {defaultLabel === undefined ? null : <option value="">{defaultLabel}</option>}
          {presets.map((seconds) => (
            <option key={seconds} value={String(seconds)}>
              {seconds === 0 ? 'None' : formatSeconds(seconds)}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
      </div>
      {custom ? (
        <Field
          label={`${label} — in seconds`}
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
      <p id={`${id}-hint`} className="text-xs text-fg-muted">
        {hint}
      </p>
    </div>
  );
};

/** The project's run credential keeps workers off it: the sentence, the link, the key as a hint. */
const CredentialNotice = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const bindings = useProjectBindings(projectId);
  const git = bindings.data?.items.find((item) => item.type === 'git') ?? null;
  return (
    <div
      role="status"
      data-testid="execution-credential-notice"
      className="flex flex-col gap-1 rounded-md border border-line p-3 text-sm"
    >
      <p className="flex items-start gap-2">
        <span className="pt-0.5">
          <StatusIcon status="needs_you" decorative />
        </span>
        <span>
          Workers can’t take this project’s runs: its git connection gives runs a long-lived token
          or a deploy key, and sending that to a developer’s computer is off. An administrator can
          allow it on the git connection.
        </span>
      </p>
      {git === null ? null : (
        <p className="pl-6">
          <Link
            to="/integrations/$integrationId"
            params={{ integrationId: git.integration_id }}
            className="text-link underline"
          >
            Open the git connection
          </Link>{' '}
          <span className="text-fg-muted">
            (<UntrustedText value={git.name} />)
          </span>
        </p>
      )}
      <p className="pl-6 text-xs text-fg-muted" data-key-hint="">
        On that connection it is the remote-worker credential setting (remote_run_credential).
      </p>
    </div>
  );
};

export const ExecutionSettings = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const execution = useProjectExecution(projectId);
  const commands = useSettingsCommands();
  const [draft, setDraft] = useState<Draft | null>(null);
  const choiceId = useId();

  const data = execution.data;
  if (data === undefined) {
    return execution.isError ? (
      <ErrorNotice title="The execution setting could not be read." error={execution.error} />
    ) : (
      <p className="text-xs text-fg-muted">Reading the execution setting…</p>
    );
  }
  const form: Draft = draft ?? {
    choice: choiceOf(data.mode, data.prefer),
    prefer: data.prefer,
    fallback: data.fallback_after_seconds === null ? '' : String(data.fallback_after_seconds),
    window: String(data.assignee_window_seconds),
    timeout: String(data.offer_timeout_seconds),
  };
  const set = (patch: Partial<Draft>): void => setDraft({ ...form, ...patch });
  const fallback = form.fallback.trim() === '' ? null : whole(form.fallback);
  const headStart = whole(form.window);
  const timeout = whole(form.timeout);
  const valid =
    (form.fallback.trim() === '' || fallback !== null) && headStart !== null && timeout !== null;
  const setting = settingOf(form.choice, form.prefer);

  const credentialRefused = data.notice?.includes(REMOTE_RUN_CREDENTIAL_REFUSED_NOTICE) === true;
  // The server's sentence about the choice, without the credential's (said below in plain words).
  const serverNotice =
    data.notice === null
      ? ''
      : data.notice.replace(REMOTE_RUN_CREDENTIAL_REFUSED_NOTICE, '').trim();
  const storedChoice = choiceOf(data.mode, data.prefer);

  return (
    <div className="flex flex-col gap-3" data-testid="execution-settings">
      <p className="text-sm">
        Who runs this project’s agents now:{' '}
        <strong className="font-semibold">{EXECUTION_CHOICES[storedChoice].label}</strong>{' '}
        {data.stored ? null : <span className="text-xs text-fg-muted">(the default)</span>}
      </p>
      <p className="flex items-start gap-2 text-sm" data-testid="execution-server">
        <span className="pt-0.5">
          <StatusIcon status={data.server_claimant === 'running' ? 'success' : 'idle'} decorative />
        </span>
        {data.server_claimant === 'running'
          ? 'The platform server runs agent work on this platform.'
          : 'The platform server doesn’t run agent work on this platform, so only workers can run agent stages.'}
      </p>
      {serverNotice === '' ? null : (
        <p className="text-xs" role="status" data-testid="execution-notice">
          {serverNotice}
        </p>
      )}
      {credentialRefused ? <CredentialNotice projectId={projectId} /> : null}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || headStart === null || timeout === null) return;
          commands.setExecution.mutate(
            {
              projectId,
              body: {
                mode: setting.mode,
                prefer: setting.prefer,
                fallback_after_seconds: fallback,
                assignee_window_seconds: headStart,
                offer_timeout_seconds: timeout,
              },
            },
            { onSuccess: () => setDraft(null) },
          );
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={choiceId} className="text-sm font-medium">
            Who runs this project’s agents
          </label>
          <select
            id={choiceId}
            className={`${selectClass} self-start`}
            value={form.choice}
            aria-describedby={`${choiceId}-means`}
            onChange={(event) => set({ choice: event.target.value as ExecutionChoice })}
          >
            {(Object.keys(EXECUTION_CHOICES) as ExecutionChoice[]).map((choice) => (
              <option key={choice} value={choice}>
                {EXECUTION_CHOICES[choice].label}
              </option>
            ))}
          </select>
          <p
            id={`${choiceId}-means`}
            className="text-xs text-fg-muted"
            data-testid="execution-choice-means"
          >
            {EXECUTION_CHOICES[form.choice].means}
          </p>
        </div>
        {setting.mode === 'hybrid' ? (
          <DurationField
            label={
              setting.prefer === 'workers'
                ? 'If no worker takes it within'
                : 'If the platform server hasn’t taken it within'
            }
            hint={
              setting.prefer === 'workers'
                ? 'Fallback: after this, the platform server may take the run too.'
                : 'Fallback: after this, a worker may take the run too.'
            }
            value={form.fallback}
            presets={[15, 60, 300, 900, 3600]}
            defaultLabel={
              form.prefer === data.prefer && form.choice === storedChoice
                ? `The default (${formatSeconds(data.effective_fallback_after_seconds)})`
                : 'The default'
            }
            onChange={(fallbackValue) => set({ fallback: fallbackValue })}
          />
        ) : null}
        <DurationField
          label="Head start for the assignee’s worker"
          hint="How long the ticket assignee’s online worker — or, for a question, the asker’s — may take a run before anybody else. At most 1 h."
          value={form.window}
          presets={[0, 60, 120, 300, 900, 3600]}
          onChange={(windowValue) => set({ window: windowValue })}
        />
        <DurationField
          label="Give up and ask a person after"
          hint="How long a run may wait for anybody to take it before it is withdrawn and the task goes to a person. Between 1 min and 30 days."
          value={form.timeout}
          presets={[3600, 86_400, 604_800, 2_592_000]}
          onChange={(timeoutValue) => set({ timeout: timeoutValue })}
        />
        <div>
          <Button type="submit" disabled={!valid || commands.setExecution.isPending}>
            Save execution setting
          </Button>
        </div>
        <p className="text-xs text-fg-muted">
          An administrator’s setting, applied to runs offered after it is saved.
        </p>
        <DetailsDisclosure summary="Why isn’t this in the repository’s configuration?">
          <p className="text-xs text-fg-muted">
            Where code runs and whose Claude subscription pays for it is a trust decision, so it is
            never read from the repository: its <code>.agentic/config.yml</code> refuses an{' '}
            <code>execution</code> key.
          </p>
        </DetailsDisclosure>
        {commands.setExecution.isError ? (
          <ErrorNotice
            title="The execution setting was not saved."
            error={commands.setExecution.error}
          />
        ) : null}
      </form>
    </div>
  );
};
