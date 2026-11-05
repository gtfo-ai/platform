/**
 * **The worker's first run, as a wizard** (WP-294, TD-031's 2026-11-05 first-run amendment §2–7).
 *
 * While any step is open the page shows a {@link Stepper} and **the current step only** — never the
 * room: no *Taking work* chip, no *Pause*, *Drain* or *Cancel* (a dimmed room still reads as
 * working, the amendment's *Rejected*). The three steps:
 *
 * 1. **Connect to a platform** — the platforms the worker found on this machine, each one button;
 *    or an address the worker checks before it keeps it (the browser never probes: its CSP allows
 *    only this page's own origin).
 * 2. **Sign in to Claude** — Claude's own sign-in, run by the worker (`claude setup-token`): open
 *    Claude's page, paste the code it shows. *Paste a token instead* is always there.
 * 3. **Approve this machine** — the code is the page's **dominant element**: large monospace
 *    letters with *Copy*; the primary button opens the platform's approval page with the code
 *    filled in (only when the link is on the platform's own origin); a countdown to the code's
 *    expiry; a new code appears without a reload.
 *
 * Every step **advances by itself**: the page polls the worker every two seconds and the step it
 * shows is read off the answer (`wizardOf`), so nothing here navigates. Every word is a `Record` in
 * `model.ts`. Every value from elsewhere — a platform's version, an address — is rendered as text.
 */
import type { WorkerLocalCoreCheckResponse, WorkerLocalState } from '@platform/contracts';
import { CopyIcon } from '@primer/octicons-react/CopyIcon';
import { type ReactElement, useId, useState } from 'react';
import { Button, buttonClassName } from '../ui/button.js';
import { CopyField } from '../ui/copy-field.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { Flash } from '../ui/flash.js';
import { Stepper } from '../ui/stepper.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';
import { LocalCallError, type LocalClient } from './client.js';
import {
  approvalLinkOf,
  CORE_FAILURE_WORDS,
  countdownWords,
  hostOf,
  SIGN_IN_FAILURE_WORDS,
  SIGN_IN_PHASE_WORDS,
  secondsUntil,
  WIZARD_STEP_WORDS,
  type WizardView,
  wizardOf,
} from './model.js';

/** A wizard action's outcome: the worker's new state, or its refusal in the page's words. */
type Act = (action: () => Promise<WorkerLocalState>) => Promise<void>;

const failureWords = (error: unknown): string => {
  if (error instanceof LocalCallError && error.code in CORE_FAILURE_WORDS) {
    return CORE_FAILURE_WORDS[error.code as keyof typeof CORE_FAILURE_WORDS];
  }
  return (error as Error).message;
};

const TextField = ({
  label,
  value,
  onChange,
  placeholder,
  secret = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly secret?: boolean;
}): ReactElement => {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      <input
        id={id}
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cx(
          'h-9 rounded-md border border-line-input bg-inset px-3 font-mono text-sm text-fg placeholder:text-fg-subtle',
          FOCUS_RING,
        )}
      />
    </div>
  );
};

/** Step 1: the platforms found on this machine, or an address the worker checks first. */
const PlatformStep = ({
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
  const [address, setAddress] = useState('');
  const [checked, setChecked] = useState<WorkerLocalCoreCheckResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const found = state.setup.candidates;
  const check = async (): Promise<void> => {
    setChecking(true);
    setProblem(null);
    setChecked(null);
    try {
      setChecked(await client.checkCore(address.trim()));
    } catch (error) {
      setProblem(failureWords(error));
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-fg-muted">
        Choose the platform this worker takes work from. The worker checks the address before it
        keeps it.
      </p>
      {found.length === 0 ? null : (
        <ul aria-label="Platforms on this machine" className="flex flex-col gap-2">
          {found.map((candidate, index) => (
            <li
              key={candidate.url}
              data-candidate={candidate.url}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface p-3"
            >
              <span className="flex flex-col">
                <span className="text-sm font-semibold text-fg">
                  Use the platform running on this machine
                </span>
                <span className="font-mono text-xs text-fg-muted">
                  <UntrustedText
                    value={`${hostOf(candidate.url)} · version ${candidate.version}`}
                  />
                </span>
              </span>
              <Button
                tone={index === 0 ? 'primary' : 'default'}
                disabled={busy}
                onClick={() => void act(() => client.setCore(candidate.url))}
              >
                Use this platform
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void check();
        }}
      >
        <TextField
          label={found.length === 0 ? 'Platform address' : 'Or type the platform’s address'}
          placeholder="https://agentic.example.com"
          value={address}
          onChange={(value) => {
            setAddress(value);
            setChecked(null);
            setProblem(null);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            tone={found.length === 0 && checked === null ? 'primary' : 'default'}
            disabled={checking || address.trim() === ''}
          >
            {checking ? 'Checking…' : 'Check the address'}
          </Button>
        </div>
      </form>
      {problem === null ? null : (
        <Flash tone="danger" title="This address is not a platform this worker can use">
          {problem}
        </Flash>
      )}
      {checked === null ? null : (
        <Flash
          tone="success"
          live="status"
          title={`Found the platform at ${hostOf(checked.url)}`}
          action={
            <Button
              tone="primary"
              disabled={busy}
              onClick={() => void act(() => client.setCore(checked.url))}
            >
              Connect
            </Button>
          }
        >
          <span data-core-check="">
            <UntrustedText
              value={`Version ${checked.version}${checked.protocol_fit === 'unknown' ? ' — checked partly: this platform is older and may need another worker version.' : '.'}`}
            />
          </span>
        </Flash>
      )}
    </div>
  );
};

/** Step 2: Claude's own sign-in, run by the worker — or a token pasted. */
const ClaudeStep = ({
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
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const { sign_in: signIn } = state.setup;
  if (state.setup.claude_source === 'environment') {
    return (
      <Flash tone="danger" title="Claude no longer accepts this worker’s sign-in">
        The token comes from CLAUDE_CODE_OAUTH_TOKEN in the worker’s environment. Run claude
        setup-token, put the new token there, and run docker compose up -d.
      </Flash>
    );
  }
  const running = signIn.phase === 'starting' || signIn.phase === 'waiting_for_code';
  return (
    <div className="flex flex-col gap-5">
      {state.setup.claude_rejected ? (
        <Flash tone="warning" title="Claude no longer accepts this sign-in">
          This worker takes no work until you sign in again.
        </Flash>
      ) : null}
      <p className="text-sm text-fg-muted">
        Agents run with your Claude subscription. Sign in once; the worker keeps the sign-in on this
        machine and never sends it to the platform.
      </p>
      {signIn.phase === 'failed' && signIn.failure !== null ? (
        <Flash tone="danger" title={SIGN_IN_PHASE_WORDS.failed}>
          {SIGN_IN_FAILURE_WORDS[signIn.failure]}
        </Flash>
      ) : null}
      {signIn.phase === 'idle' || signIn.phase === 'failed' ? (
        <div>
          <Button
            tone="primary"
            disabled={busy}
            onClick={() => void act(() => client.signIn('start'))}
          >
            {signIn.phase === 'failed' ? 'Sign in again' : 'Sign in with Claude'}
          </Button>
        </div>
      ) : null}
      {signIn.phase === 'starting' && signIn.url === null ? (
        <p className="text-sm text-fg-muted" aria-live="polite">
          {SIGN_IN_PHASE_WORDS.starting}
        </p>
      ) : null}
      {running && signIn.url !== null ? (
        <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm text-fg" data-sign-in="">
          <li className="flex flex-col gap-2">
            <span>Open Claude’s sign-in and sign in with your Claude account.</span>
            <span>
              <ExternalLink
                url={signIn.url}
                label="Open Claude sign-in"
                className={buttonClassName('primary')}
              />
            </span>
          </li>
          <li>Claude shows a code. Copy it.</li>
          <li>
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const pasted = code.trim();
                if (pasted === '') return;
                setCode('');
                void act(() => client.claudeCode(pasted));
              }}
            >
              <TextField
                label="Paste the code Claude shows you"
                value={code}
                onChange={setCode}
                secret
              />
              <div>
                <Button
                  type="submit"
                  disabled={busy || code.trim() === '' || signIn.phase !== 'waiting_for_code'}
                >
                  Continue
                </Button>
              </div>
            </form>
          </li>
        </ol>
      ) : null}
      {signIn.phase === 'checking' ? (
        <p className="text-sm text-fg" aria-live="polite" data-sign-in-checking="">
          {SIGN_IN_PHASE_WORDS.checking}
        </p>
      ) : null}
      {running ? (
        <div>
          <Button size="sm" disabled={busy} onClick={() => void act(() => client.signIn('cancel'))}>
            Cancel the sign-in
          </Button>
        </div>
      ) : null}
      <details className="rounded-md border border-line bg-surface p-3" data-paste-token="">
        <summary className="cursor-pointer text-sm font-medium text-fg">
          Paste a token instead
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <CopyField
            label="Run this in a terminal on a machine with Claude Code, and copy the token it prints"
            value="claude setup-token"
          />
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const pasted = token.trim();
              if (pasted === '') return;
              setToken('');
              void act(() => client.claudeToken(pasted));
            }}
          >
            <TextField label="Token" value={token} onChange={setToken} secret />
            <div>
              <Button
                type="submit"
                disabled={busy || token.trim() === '' || signIn.phase === 'checking'}
              >
                Use this token
              </Button>
            </div>
          </form>
        </div>
      </details>
    </div>
  );
};

/** Step 3: the code, large; the approval page, one press away; and the waits after it. */
const ApproveStep = ({
  state,
  client,
  act,
  busy,
  writeText,
}: {
  readonly state: WorkerLocalState;
  readonly client: LocalClient;
  readonly act: Act;
  readonly busy: boolean;
  readonly writeText: (text: string) => Promise<void>;
}): ReactElement => {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const host = state.core_url === null ? 'the platform' : hostOf(state.core_url);
  const serverNow = Date.parse(state.server_time);
  if (state.connection === 'core_unreachable' && state.setup.unreachable !== null) {
    const retryAt = state.setup.unreachable.retry_at;
    return (
      <Flash
        tone="warning"
        title={`The platform at ${host} is not answering`}
        action={
          <Button disabled={busy} onClick={() => void act(() => client.retry())}>
            Try now
          </Button>
        }
      >
        <span data-unreachable={state.setup.unreachable.failure}>
          {CORE_FAILURE_WORDS[state.setup.unreachable.failure]}
          {retryAt === null ? null : ` Retrying in ${secondsUntil(retryAt, serverNow)} s.`}
        </span>
      </Flash>
    );
  }
  if (state.connection === 'revoked') {
    return (
      <Flash
        tone="danger"
        title={`This machine was removed from ${host}`}
        action={
          <Button
            tone="primary"
            disabled={busy}
            onClick={() => void act(() => client.connectAgain())}
          >
            Connect again
          </Button>
        }
      >
        Connect again to show a new code, and approve it on the platform.
      </Flash>
    );
  }
  if (state.connection === 'upgrade_required') {
    return (
      <Flash tone="danger" title="The platform needs another version of this worker">
        {CORE_FAILURE_WORDS.needs_other_version}
      </Flash>
    );
  }
  const device = state.setup.device;
  if (state.connection !== 'logging_in' || device === null) {
    return (
      <p className="text-sm text-fg-muted" aria-live="polite">
        {state.connection === 'handshaking'
          ? `Connecting to ${host}…`
          : `Asking ${host} for a code…`}
      </p>
    );
  }
  const link = approvalLinkOf(state);
  const left = secondsUntil(device.expires_at, serverNow);
  return (
    <div className="flex flex-col items-start gap-5">
      <p className="text-sm text-fg">
        {`Approve this machine on ${host}, signed in as yourself. Check that the platform shows this code:`}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <output
          data-user-code=""
          aria-label="The code to approve"
          className="rounded-lg border border-line bg-inset px-6 py-4 font-mono text-5xl font-semibold tracking-[0.2em] text-fg select-all"
        >
          {device.user_code}
        </output>
        <Button
          leadingIcon={<CopyIcon size={16} />}
          onClick={() => {
            writeText(device.user_code).then(
              () => setCopied('copied'),
              () => setCopied('failed'),
            );
          }}
        >
          Copy code
        </Button>
        <span role="status" aria-live="polite" className="text-xs text-fg-muted">
          {copied === 'copied' ? 'Copied.' : null}
          {copied === 'failed' ? 'Could not copy — select the code and copy it by hand.' : null}
        </span>
      </div>
      {link === null ? (
        <p className="text-sm text-fg-muted">{`Open ${host}/workers/approve and type the code.`}</p>
      ) : (
        <ExternalLink
          url={link}
          label="Open the approval page"
          className={cx(buttonClassName('primary'), 'min-h-10 px-5 text-base')}
        />
      )}
      <p className="text-sm text-fg-muted tabular-nums" data-countdown="">
        {left > 0
          ? `This code expires in ${countdownWords(left)}. A new one appears here by itself.`
          : 'This code expired. A new one appears here in a moment.'}
      </p>
      <p className="text-xs text-fg-muted">
        This page moves on by itself once the machine is approved.
      </p>
    </div>
  );
};

const defaultWriteText = async (text: string): Promise<void> => {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard === undefined) throw new Error('the clipboard is not available here');
  await clipboard.writeText(text);
};

/** *Change platform*: offered only when idle, and confirmed in the page. */
const ChangePlatform = ({
  state,
  client,
  act,
  busy,
}: {
  readonly state: WorkerLocalState;
  readonly client: LocalClient;
  readonly act: Act;
  readonly busy: boolean;
}): ReactElement | null => {
  const [confirming, setConfirming] = useState(false);
  if (state.core_url === null || state.setup.core_source !== 'file' || !state.setup.idle) {
    return null;
  }
  // Under `none` a repoint drops the Claude sign-in, which the worker refuses (409) when the token
  // comes from its environment — so it is not offered (review of PR #42).
  if (state.setup.auth === 'none' && state.setup.claude_source === 'environment') return null;
  return confirming ? (
    <fieldset
      aria-label="Confirm the change of platform"
      className="flex flex-col gap-2 rounded-md border border-attention/40 bg-attention-bg p-3"
    >
      <p className="text-sm text-fg">
        {state.setup.auth === 'none'
          ? 'Forget this platform? The machine is disconnected from it, and the Claude sign-in on this worker is removed too.'
          : 'Forget this platform? The machine is disconnected from it; the Claude sign-in stays.'}
      </p>
      <div className="flex gap-2">
        <Button
          tone="danger"
          size="sm"
          disabled={busy}
          onClick={() => void act(() => client.setCore(null))}
        >
          Change platform
        </Button>
        <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
    </fieldset>
  ) : (
    <Button size="sm" tone="invisible" onClick={() => setConfirming(true)}>
      Change platform
    </Button>
  );
};

export interface WizardProps {
  readonly state: WorkerLocalState;
  readonly client: LocalClient;
  /** Runs an action and takes the state it answers (`worker-app.tsx`'s control). */
  readonly act: Act;
  readonly busy: boolean;
  readonly error: string | null;
  readonly writeText?: (text: string) => Promise<void>;
}

/** The wizard for a worker that is not connected yet; `wizardOf` decides which step is open. */
export const Wizard = ({
  state,
  client,
  act,
  busy,
  error,
  writeText = defaultWriteText,
}: WizardProps): ReactElement => {
  const view = wizardOf(state) as WizardView;
  return (
    <main
      className="mx-auto flex max-w-4xl flex-col gap-6 p-6"
      data-wizard={view.current}
      aria-label="Set up this worker"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-fg">Set up this worker</h1>
        <p className="text-sm text-fg-muted">
          Three steps, then this machine starts taking work. The page moves on by itself.
        </p>
      </header>
      {error === null ? null : (
        <Flash tone="danger" title="That did not work">
          <UntrustedText value={error} />
        </Flash>
      )}
      <div className="grid gap-6 md:grid-cols-[15rem_1fr]">
        <Stepper label="Setup steps" steps={view.steps} />
        <section
          aria-label={WIZARD_STEP_WORDS[view.current]}
          className="flex flex-col gap-4 rounded-lg border border-line bg-default p-5"
        >
          <h2 className="text-lg font-semibold text-fg">{WIZARD_STEP_WORDS[view.current]}</h2>
          {view.current === 'platform' ? (
            <PlatformStep state={state} client={client} act={act} busy={busy} />
          ) : view.current === 'claude' ? (
            <ClaudeStep state={state} client={client} act={act} busy={busy} />
          ) : (
            <ApproveStep
              state={state}
              client={client}
              act={act}
              busy={busy}
              writeText={writeText}
            />
          )}
          {view.current === 'platform' ? null : (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-fg-muted">
              <span>
                <UntrustedText
                  value={`Platform: ${state.core_url === null ? '—' : hostOf(state.core_url)}`}
                />
              </span>
              <ChangePlatform state={state} client={client} act={act} busy={busy} />
            </div>
          )}
        </section>
      </div>
    </main>
  );
};

export { ChangePlatform };
