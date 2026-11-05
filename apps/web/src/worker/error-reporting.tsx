/**
 * **Error reporting** — the local page's setting (WP-295, TD-023's 2026-11-05 amendment §3).
 *
 * A settings item in the room, never a wizard step: a Sentry DSN pasted and *Save*d (the worker
 * validates it — `https://<key>@<host>/<project id>`, `http:` only to localhost — and answers
 * `422` otherwise), *Send a test error*, and *Remove*. The worker applies a change without a
 * restart. When `SENTRY_DSN` is set in the worker's environment it wins: the page says so and offers
 * only the test. **The DSN is never shown back** — the worker answers its host only.
 *
 * What an event carries is said here in the words of the amendment, because a person deciding to
 * send their machine's errors to a host they chose is owed that sentence before they press *Save*.
 * The page loads no SDK: `@sentry/*` is refused under `apps/web/src` by a census.
 */
import type { WorkerLocalState } from '@platform/contracts';
import { type ReactElement, useState } from 'react';
import { Button } from '../ui/button.js';
import { Flash } from '../ui/flash.js';
import { UntrustedText } from '../ui/untrusted.js';
import type { LocalClient } from './client.js';
import { TextField } from './wizard.js';

/** What one event carries, and what it never does. */
export const ERROR_REPORTING_CONTENTS =
  'Each error this worker logs is sent to that address: the error’s type, its message (at most 1 KiB, with this worker’s secrets and anything shaped like a credential removed) and its stack, tagged with this worker’s id, its platform’s address, its version and the run’s id. Never a transcript, a prompt, a tool’s input, ticket text, a project name or a ticket key.';

type Act = (action: () => Promise<WorkerLocalState>) => Promise<void>;

export const ErrorReporting = ({
  state,
  client,
  act,
  busy,
}: {
  readonly state: WorkerLocalState;
  readonly client: LocalClient;
  readonly act: Act;
  readonly busy: boolean;
}): ReactElement => {
  const [dsn, setDsn] = useState('');
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<{
    readonly tone: 'success' | 'warning' | 'danger';
    readonly words: string;
  } | null>(null);
  const setting = state.error_reporting;
  const fromEnvironment = setting.source === 'environment';

  const save = async (value: string | null): Promise<void> => {
    setOutcome(null);
    await act(() => client.setErrorReporting(value));
    if (value !== null) setDsn('');
  };
  const sendTest = async (): Promise<void> => {
    setTesting(true);
    setOutcome(null);
    try {
      const answer = await client.testErrorReporting();
      setOutcome(
        answer.delivered
          ? { tone: 'success', words: `A test error was sent (event ${answer.event_id ?? '—'}).` }
          : {
              tone: 'warning',
              words:
                'The test error was not confirmed sent within five seconds: check the address and this machine’s network.',
            },
      );
    } catch (error) {
      setOutcome({ tone: 'danger', words: (error as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section aria-label="Error reporting" data-error-reporting="" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold text-fg">Error reporting</h2>
      <p className="text-sm text-fg" data-error-reporting-status="">
        {setting.host === null ? (
          'Off. Paste a Sentry DSN to have this worker report its errors.'
        ) : (
          <>
            On, sending to <UntrustedText value={setting.host} />
            {fromEnvironment
              ? ' — set in the worker’s environment (SENTRY_DSN); change it there.'
              : '.'}
          </>
        )}
      </p>
      <p className="text-xs text-fg-muted">{ERROR_REPORTING_CONTENTS}</p>
      {fromEnvironment ? null : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save(dsn.trim());
          }}
        >
          <TextField
            label={setting.host === null ? 'Sentry DSN' : 'Another Sentry DSN'}
            placeholder="https://<key>@o0.ingest.sentry.io/<project id>"
            value={dsn}
            onChange={(value) => {
              setDsn(value);
              setOutcome(null);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || dsn.trim() === ''}>
              Save
            </Button>
            {setting.source === 'file' ? (
              <Button size="sm" tone="invisible" disabled={busy} onClick={() => void save(null)}>
                Remove
              </Button>
            ) : null}
          </div>
        </form>
      )}
      {setting.host === null ? null : (
        <div>
          <Button size="sm" disabled={busy || testing} onClick={() => void sendTest()}>
            {testing ? 'Sending…' : 'Send a test error'}
          </Button>
        </div>
      )}
      {outcome === null ? null : <Flash tone={outcome.tone} live="status" title={outcome.words} />}
    </section>
  );
};
