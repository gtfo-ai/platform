/**
 * The local page's *Error reporting* setting (WP-295), in happy-dom over a fake `LocalClient`:
 * off until a DSN is saved; *Save* sends the trimmed DSN and the page then shows only its host;
 * *Send a test error* says what the worker answered; *Remove* turns it off; and a DSN from the
 * worker's environment offers only the test, saying where to change it.
 */
import type { WorkerLocalErrorReporting, WorkerLocalState } from '@platform/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalCallError, type LocalClient } from './client.js';
import { ERROR_REPORTING_CONTENTS, ErrorReporting } from './error-reporting.js';

// A DSN's public key, built at run time so the source holds no key-shaped literal.
const DSN_PUBLIC = '0123456789abcdef'.repeat(2);
const DSN = `https://${DSN_PUBLIC}@o0.ingest.sentry.example.test/42`;

const stateWith = (error_reporting: WorkerLocalErrorReporting): WorkerLocalState => ({
  worker_id: '00000000-0000-4000-8000-000000000295',
  worker_name: 'alice-laptop',
  connection: 'connected',
  protocol: 3,
  core_protocol: { current: 3, accepted: [2, 3] },
  core_url: 'https://core.example.test',
  last_handshake_at: '2026-11-05T10:00:00.000Z',
  manually_paused_at: null,
  usage_paused_until: null,
  usage_paused_estimated: false,
  draining: false,
  launcher: 'ok',
  update_pending: null,
  concurrency: 1,
  runs: [],
  logs: [],
  setup: {
    core_source: 'file',
    candidates: [],
    claude_source: 'file',
    claude_rejected: false,
    sign_in: { phase: 'idle', url: null, failure: null },
    device: null,
    unreachable: null,
    idle: true,
    auth: 'none',
  },
  claim_blockers: [],
  error_reporting,
  started_at: '2026-11-05T09:00:00.000Z',
  server_time: '2026-11-05T10:00:00.000Z',
});

const notAsked = async (): Promise<never> => {
  throw new Error('not asked here');
};

const fakeClient = (overrides: Partial<LocalClient> = {}): LocalClient => ({
  state: vi.fn(notAsked),
  pause: vi.fn(notAsked),
  drain: vi.fn(notAsked),
  cancel: vi.fn(notAsked),
  claimScope: vi.fn(notAsked),
  setClaimScope: vi.fn(notAsked),
  offers: vi.fn(notAsked),
  take: vi.fn(notAsked),
  checkCore: vi.fn(notAsked),
  setCore: vi.fn(notAsked),
  signIn: vi.fn(notAsked),
  claudeCode: vi.fn(notAsked),
  claudeToken: vi.fn(notAsked),
  signOut: vi.fn(notAsked),
  connectAgain: vi.fn(notAsked),
  retry: vi.fn(notAsked),
  setErrorReporting: vi.fn(async (dsn: string | null) =>
    stateWith(
      dsn === null ? { source: null, host: null } : { source: 'file', host: new URL(dsn).host },
    ),
  ),
  testErrorReporting: vi.fn(async () => ({
    event_id: 'ab'.repeat(16),
    delivered: true,
  })),
  ...overrides,
});

/** The page's own `act`: the worker's answer becomes the state. */
const Harness = ({
  client,
  initial,
}: {
  readonly client: LocalClient;
  readonly initial: WorkerLocalState;
}): ReactElement => {
  const [state, setState] = useState(initial);
  return (
    <ErrorReporting
      state={state}
      client={client}
      busy={false}
      act={async (action) => setState(await action())}
    />
  );
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Error reporting on the worker’s page (WP-295 (3))', () => {
  it('saves a DSN, then shows its host only, sends a test error and removes it', async () => {
    const client = fakeClient();
    const { container } = render(
      <Harness client={client} initial={stateWith({ source: null, host: null })} />,
    );
    expect(container.textContent).toContain('Off.');
    expect(container.textContent).toContain(ERROR_REPORTING_CONTENTS);
    const save = screen.getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Send a test error' })).toBeNull();

    await userEvent.type(screen.getByLabelText('Sentry DSN'), `  ${DSN} `);
    await userEvent.click(save);
    expect(client.setErrorReporting).toHaveBeenCalledWith(DSN);
    await screen.findByText('o0.ingest.sentry.example.test');
    // The key is shown nowhere once saved: the field is cleared and the worker answers the host.
    expect(container.innerHTML).not.toContain(DSN_PUBLIC);

    await userEvent.click(screen.getByRole('button', { name: 'Send a test error' }));
    await screen.findByText(`A test error was sent (event ${'ab'.repeat(16)}).`);

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(client.setErrorReporting).toHaveBeenLastCalledWith(null);
    await screen.findByText(/^Off\./);
  });

  it('says when the test was not confirmed, and shows the worker’s refusal in its words', async () => {
    const client = fakeClient({
      testErrorReporting: vi
        .fn()
        .mockResolvedValueOnce({ event_id: null, delivered: false })
        .mockRejectedValueOnce(
          new LocalCallError(409, 'error_reporting_off', 'error reporting is off on this worker'),
        ),
    });
    render(<Harness client={client} initial={stateWith({ source: 'file', host: 'h.test' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Send a test error' }));
    await screen.findByText(/not confirmed sent within five seconds/);
    await userEvent.click(screen.getByRole('button', { name: 'Send a test error' }));
    await screen.findByText('error reporting is off on this worker');
  });

  it('offers only the test when the DSN comes from the worker’s environment', async () => {
    const client = fakeClient();
    const { container } = render(
      <Harness
        client={client}
        initial={stateWith({ source: 'environment', host: 'o0.ingest.sentry.example.test' })}
      />,
    );
    expect(container.textContent).toContain(
      'set in the worker’s configuration, which overrides this page',
    );
    expect(container.textContent).not.toContain('SENTRY_DSN');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send a test error' })).toBeTruthy();
  });
});
