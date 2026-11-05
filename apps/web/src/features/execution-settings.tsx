/**
 * **Execution** — where a project's agent runs execute (WP-278, TD-031 decision 8, BD-032 decisions
 * 3 and 5), on the project settings page.
 *
 * The whole setting in one form: the mode (the server only, workers only, or both), which side of
 * `hybrid` may take a run first, how long the other side waits, the head start the ticket's
 * assignee's — or an ask's asker's — online worker gets, and how long an offer may wait for anybody
 * before it is withdrawn and its task escalated. An administrator's (`project.settings.write`); the
 * server answers a maintainer's save with a 403, which the error notice shows. It is **never** a key
 * of `.agentic/config.yml`, and the card says so, because a reader who knows the file will look
 * there first.
 *
 * The server says whether the instance has a server runner claiming offers now; with none, the
 * card shows the server's sentence about what that does to this mode (TD-031 §8: *"says so on the
 * settings screen"*). Every value shown is the platform's own (no untrusted text reaches this card).
 */
import { type ReactElement, useState } from 'react';
import { useProjectExecution, useSettingsCommands } from '../app/queries.js';
import { Badge, Button, ErrorNotice, Field } from '../ui/kit.js';

type Mode = 'server_only' | 'workers_only' | 'hybrid';
type Prefer = 'server' | 'workers';

const MODE_LABEL: Readonly<Record<Mode, string>> = {
  hybrid: 'Server and workers (hybrid)',
  server_only: 'The server only',
  workers_only: 'Workers only',
};

/** What the form holds: the numbers as typed, so a half-typed value is not coerced. */
interface Draft {
  readonly mode: Mode;
  readonly prefer: Prefer;
  /** `''` is the preference's default. */
  readonly fallback: string;
  readonly window: string;
  readonly timeout: string;
}

const whole = (value: string): number | null => (/^\d+$/.test(value.trim()) ? Number(value) : null);

const selectClass = 'rounded-md border border-line-input bg-inset px-2 py-1 text-sm';

export const ExecutionSettings = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const execution = useProjectExecution(projectId);
  const commands = useSettingsCommands();
  const [draft, setDraft] = useState<Draft | null>(null);

  const data = execution.data;
  if (data === undefined) {
    return execution.isError ? (
      <ErrorNotice title="The execution setting could not be read." error={execution.error} />
    ) : (
      <p className="text-xs text-fg-muted">Reading the execution setting…</p>
    );
  }
  const form: Draft = draft ?? {
    mode: data.mode,
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

  return (
    <div className="flex flex-col gap-2" data-testid="execution-settings">
      <p className="text-sm">
        Runs execute on: <Badge>{MODE_LABEL[data.mode]}</Badge>{' '}
        {data.stored ? null : <span className="text-xs text-fg-muted">(the defaults)</span>}
      </p>
      <p className="text-xs text-fg-muted">
        Server runner on this instance:{' '}
        <Badge tone={data.server_claimant === 'running' ? 'neutral' : 'warning'}>
          {data.server_claimant === 'running' ? 'running' : 'none'}
        </Badge>
      </p>
      {data.notice === null ? null : (
        <p className="text-xs" role="status" data-testid="execution-notice">
          {data.notice}
        </p>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || headStart === null || timeout === null) return;
          commands.setExecution.mutate(
            {
              projectId,
              body: {
                mode: form.mode,
                prefer: form.prefer,
                fallback_after_seconds: fallback,
                assignee_window_seconds: headStart,
                offer_timeout_seconds: timeout,
              },
            },
            { onSuccess: () => setDraft(null) },
          );
        }}
      >
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Mode
            <select
              aria-label="Execution mode"
              className={selectClass}
              value={form.mode}
              onChange={(event) => set({ mode: event.target.value as Mode })}
            >
              {(Object.keys(MODE_LABEL) as Mode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {MODE_LABEL[mode]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Preferred
            <select
              aria-label="Preferred claimant"
              className={selectClass}
              value={form.prefer}
              disabled={form.mode !== 'hybrid'}
              onChange={(event) => set({ prefer: event.target.value as Prefer })}
            >
              <option value="server">The server</option>
              <option value="workers">Workers</option>
            </select>
          </label>
        </div>
        <Field
          label="Fallback after (seconds)"
          hint={`How long the other side waits before it may take a run. Empty is the default for the preference (now ${data.effective_fallback_after_seconds} s).`}
          inputMode="numeric"
          value={form.fallback}
          onChange={(event) => set({ fallback: event.target.value })}
        />
        <Field
          label="Assignee head start (seconds)"
          hint="How long the ticket assignee’s online worker — or, for a question, the asker’s — may take a run before anybody else. 0 for none; at most 3600."
          inputMode="numeric"
          value={form.window}
          onChange={(event) => set({ window: event.target.value })}
        />
        <Field
          label="Offer timeout (seconds)"
          hint="How long a run may wait for anybody to take it before it is withdrawn and the task escalated. Between 60 and 2592000 (30 days)."
          inputMode="numeric"
          value={form.timeout}
          onChange={(event) => set({ timeout: event.target.value })}
        />
        <div>
          <Button type="submit" disabled={!valid || commands.setExecution.isPending}>
            Save execution setting
          </Button>
        </div>
        <p className="text-xs text-fg-muted">
          An administrator’s setting, applied to runs offered after it is saved. It is never read
          from the repository’s <code>.agentic/config.yml</code>, which refuses an{' '}
          <code>execution</code> key.
        </p>
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
