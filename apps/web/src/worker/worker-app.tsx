/**
 * **The worker's local page** (WP-292, TD-031's 2026-11-04 worker-UI amendment §3–4): what this
 * machine's worker is doing, and *Pause/Resume*, *Drain* and *Cancel run*.
 *
 * Built from the shared design system only — `ui/bot/seat.tsx` for each desk (one per slot, a free
 * one sleeping, or sipping its coffee on a paused worker), `ui/phase-track.tsx` for a run's stage,
 * `ui/activity.ts` for the one vocabulary of what an agent is doing, `ui/button.tsx`, `ui/flash.tsx`
 * and `ui/untrusted.tsx` — so nothing of `viz/*` (lazy) enters this entry's bundle.
 *
 * **Live by polling**, every {@link POLL_MS}: `GET /api/local/state` is one small answer from the
 * worker's own memory on the same machine, and a second realtime protocol on the worker (SSE) would
 * buy a second faster than that for a page one person looks at. A `401` stops the polling and says
 * how to open the page again.
 *
 * **Every control is the core's decision** (amendment §4): *Pause* and *Drain* are the core's
 * `manual-pause`; *Cancel run* is the task page's cancel and **pauses the task** (Q126), which the
 * page says before it is pressed. It is confirmed in the page, never with `window.confirm`.
 * Stopping the container is not a cancel — a lost worker, re-planned — and the page says that too.
 *
 * Every string a person, a tracker or an agent wrote (the title, the ticket key, the transcript, a
 * log line) is a React text node through `ui/untrusted.tsx` (BD-022).
 *
 * **The page shows the model's thinking text on purpose**, unlike the platform's run dialog: it is
 * served on the developer's own machine, to the person whose subscription the run spends, about a
 * run that machine is executing — the same words the worker uploads, nothing more.
 *
 * A run's stage is a `PhaseTrack` only when the page knows **more than one** stage; the worker's
 * package names one, so today it is the stage's name as text — a strip of one dot says nothing.
 */
import type { WorkerLocalRun, WorkerLocalState } from '@platform/contracts';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Seat } from '../ui/bot/seat.js';
import { Button } from '../ui/button.js';
import { Flash } from '../ui/flash.js';
import { ROLE_LABEL, stageLabel } from '../ui/humanize.js';
import { type PhaseStage, PhaseTrack } from '../ui/phase-track.js';
import { StatusIcon } from '../ui/status.js';
import { ExternalLink, TerminalText, UntrustedText } from '../ui/untrusted.js';
import { LocalCallError, type LocalClient } from './client.js';
import {
  CONNECTION_WORDS,
  coreRunUrl,
  deskOf,
  elapsedWords,
  freeDesksOf,
  logLineWords,
  slotsWords,
  spendWords,
  tailLinesOf,
  workerModeOf,
  workerModeWords,
} from './model.js';

/** A message as a sentence: its first letter capitalised (the worker's words start lower-case). */
export const sentence = (text: string): string =>
  text === '' ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** How often the page asks the worker for its state. */
export const POLL_MS = 2_000;

const REDUCED = '(prefers-reduced-motion: reduce)';
const subscribeReduced = (onChange: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const list = window.matchMedia(REDUCED);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
};
const readReduced = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(REDUCED).matches;

/** Whether the reader asked for reduced motion: the bots then hold their first frame. */
const useReducedMotion = (): boolean =>
  useSyncExternalStore(subscribeReduced, readReduced, () => false);

/** What to do when the page has no token. */
export const NoToken = (): ReactElement => (
  <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
    <h1 className="text-xl font-semibold text-fg">This worker</h1>
    <Flash tone="warning" title="Open this page from the address the worker printed">
      <p>
        The address carries a token after <code>#token=</code>. Find it again with{' '}
        <code>docker compose -f compose.worker.yml logs remote-worker | grep token=</code>. To
        change the token, delete <code>ui-token</code> in the worker’s <code>worker-state</code>{' '}
        volume and restart the worker.
      </p>
    </Flash>
  </main>
);

const RunCard = ({
  run,
  state,
  now,
  client,
  newKey,
  onError,
}: {
  readonly run: WorkerLocalRun;
  readonly state: WorkerLocalState;
  readonly now: number;
  readonly client: LocalClient;
  readonly newKey: () => string;
  readonly onError: (message: string | null) => void;
}): ReactElement => {
  const desk = deskOf(run, state, now);
  const spend = spendWords(run);
  /** What the page knows of the run's pipeline: its own stage, and no other. */
  const stages: readonly PhaseStage[] = [
    {
      id: run.stage ?? run.role,
      label: run.stage === null ? ROLE_LABEL[run.role] : stageLabel(run.stage),
      state: 'current',
    },
  ];
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // One key per confirmed cancel: a retry of the same press is a replay, never a second cancel.
  const key = useRef<string | null>(null);
  const cancel = async (): Promise<void> => {
    setBusy(true);
    key.current ??= newKey();
    try {
      await client.cancel(run.run_id, key.current);
      setConfirming(false);
      onError(null);
    } catch (error) {
      onError(
        error instanceof LocalCallError && error.status === 403
          ? `You may not cancel this run: ${error.message}`
          : (error as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      data-run={run.run_id}
      aria-label={`Run ${run.ticket_key ?? run.run_id}`}
      className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-sm text-fg-muted">
          <UntrustedText
            value={
              [run.project_key, run.ticket_key].filter((part) => part !== null).join(' · ') ||
              run.task_id
            }
          />
        </span>
        <h3 className="min-w-0 text-base font-semibold text-fg">
          <UntrustedText value={run.title ?? 'A task with no title'} />
        </h3>
      </header>
      {stages.length > 1 ? (
        <PhaseTrack stages={stages} size="sm" />
      ) : (
        <p data-stage="" className="text-sm font-medium text-fg">
          {stages[0]?.label}
        </p>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-fg-muted">Doing</dt>
        <dd className="flex items-center gap-1.5 text-fg">
          <StatusIcon status={desk.meta.icon} decorative />
          {desk.bubble}
        </dd>
        <dt className="text-fg-muted">Agent</dt>
        <dd className="text-fg">{`${ROLE_LABEL[run.role]}, attempt ${run.attempt}`}</dd>
        <dt className="text-fg-muted">Running for</dt>
        <dd className="tabular-nums text-fg">{elapsedWords(run.elapsed_ms)}</dd>
        <dt className="text-fg-muted">Tokens</dt>
        <dd className="tabular-nums text-fg">{spend.tokens}</dd>
        <dt className="text-fg-muted">Cost</dt>
        <dd className="tabular-nums text-fg">{spend.cost}</dd>
      </dl>
      <section aria-label="What the agent did last" className="flex flex-col gap-1">
        <h4 className="text-xs font-semibold text-fg-muted">Latest</h4>
        <ol className="flex flex-col gap-1 text-sm">
          {tailLinesOf(run).map((line) => (
            <li key={line.id} className="flex min-w-0 gap-2">
              <span className="shrink-0 text-fg-muted">{line.label}</span>
              <span className="min-w-0 truncate text-fg">
                <UntrustedText value={line.text} />
              </span>
            </li>
          ))}
        </ol>
      </section>
      <footer className="flex flex-wrap items-center gap-3">
        {run.cancel_requested ? (
          <span className="text-sm text-fg-muted">
            Cancel accepted: the run is stopping and its task is paused.
          </span>
        ) : confirming ? (
          <fieldset
            aria-label="Confirm the cancel"
            className="flex flex-col gap-2 rounded-md border border-danger/40 bg-danger-bg p-3"
          >
            <p className="text-sm text-fg">
              Stop this run now? Its task is <strong>paused</strong>, as from the task page;
              somebody resumes it there. What the run spent so far is still recorded.
            </p>
            <div className="flex gap-2">
              <Button tone="danger" size="sm" disabled={busy} onClick={() => void cancel()}>
                Cancel the run
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                Keep it running
              </Button>
            </div>
          </fieldset>
        ) : (
          <Button tone="danger" size="sm" onClick={() => setConfirming(true)}>
            Cancel run
          </Button>
        )}
        <ExternalLink
          url={coreRunUrl(state.core_url, run.run_id)}
          label="Open on the platform (steer, take over)"
          className="text-sm text-link underline"
        />
      </footer>
    </article>
  );
};

export interface WorkerAppProps {
  /** `null` when the page has no token (opened without the printed address). */
  readonly client: LocalClient | null;
  readonly now?: () => number;
  readonly pollMs?: number;
  /** The `Idempotency-Key` of one cancel. */
  readonly newKey?: () => string;
}

export const WorkerApp = ({
  client,
  now = Date.now,
  pollMs = POLL_MS,
  newKey = () => crypto.randomUUID(),
}: WorkerAppProps): ReactElement => {
  const [state, setState] = useState<WorkerLocalState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unauthorised, setUnauthorised] = useState(false);
  const [busy, setBusy] = useState(false);
  const reduced = useReducedMotion();

  const refresh = useCallback(async (): Promise<boolean> => {
    if (client === null) return false;
    try {
      setState(await client.state());
      return true;
    } catch (caught) {
      if (caught instanceof LocalCallError && caught.status === 401) {
        setUnauthorised(true);
        return false;
      }
      setError((caught as Error).message);
      return true;
    }
  }, [client]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      const again = await refresh();
      if (!stopped && again) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [refresh, pollMs]);

  if (client === null || unauthorised) {
    return <NoToken />;
  }
  if (state === null) {
    return (
      <main className="mx-auto flex max-w-5xl flex-col gap-4 p-6" aria-busy={error === null}>
        <h1 className="text-xl font-semibold text-fg">This worker</h1>
        {error === null ? (
          <p className="text-sm text-fg-muted">Asking the worker what it is doing…</p>
        ) : (
          <Flash
            tone="danger"
            title="The page could not read the worker"
            action={
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload
              </Button>
            }
          >
            <UntrustedText value={sentence(error)} />
          </Flash>
        )}
      </main>
    );
  }

  const at = now();
  const mode = workerModeOf(state, at);
  const held = state.manually_paused_at !== null;
  const control = async (action: () => Promise<WorkerLocalState>): Promise<void> => {
    setBusy(true);
    try {
      setState(await action());
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const name = state.worker_name ?? 'This worker';

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-fg">
            <UntrustedText value={name} />
          </h1>
          <p className="flex items-center gap-1.5 text-sm text-fg-muted">
            <StatusIcon
              status={state.connection === 'connected' ? 'success' : 'waiting'}
              decorative
            />
            <span data-connection={state.connection}>{CONNECTION_WORDS[state.connection]}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            tone={held ? 'primary' : 'default'}
            disabled={busy || state.connection !== 'connected'}
            onClick={() => void control(() => client.pause(!held))}
          >
            {held ? 'Resume' : 'Pause'}
          </Button>
          <Button
            disabled={busy || state.draining || state.connection !== 'connected'}
            onClick={() => void control(() => client.drain())}
          >
            Drain
          </Button>
        </div>
      </header>

      {error === null ? null : (
        <Flash tone="danger" title="That did not work">
          <UntrustedText value={sentence(error)} />
        </Flash>
      )}
      {state.update_pending === true ? (
        <Flash tone="info" title="An update is waiting">
          The platform runs a newer build than this worker. Drain it, then update it with the
          platform’s compose file.
        </Flash>
      ) : null}

      <section aria-label={`${name} room`} data-room="" className="worker-room">
        <div className="worker-wall flex flex-wrap items-end gap-3 px-4 pt-3 pb-2">
          <span data-door-plate="" className="worker-plate truncate">
            {name}
          </span>
          <span className="text-xs text-fg-muted tabular-nums">{slotsWords(state)}</span>
          <span data-mode={mode} className="worker-badge text-xs">
            {workerModeWords(state, at)}
          </span>
        </div>
        <ul
          aria-label={`Desks in ${name}`}
          className="worker-floor flex flex-wrap justify-center gap-x-8 gap-y-4 p-4"
        >
          {state.runs.map((run) => {
            const desk = deskOf(run, state, at);
            return (
              <li key={run.run_id} data-desk={run.run_id} data-pose={desk.meta.pose}>
                <Seat
                  pose={desk.meta.pose}
                  phase={desk.phase}
                  animated={!reduced}
                  mug={desk.phase % 2 === 0}
                  bubble={<span className="font-medium">{desk.bubble}</span>}
                  nameplate={
                    <span data-nameplate="" className="flex flex-col items-center">
                      {desk.nameplate.ticket === null ? null : (
                        <span className="font-mono">
                          <UntrustedText value={desk.nameplate.ticket} />
                        </span>
                      )}
                      <span>{desk.nameplate.stage}</span>
                    </span>
                  }
                />
              </li>
            );
          })}
          {freeDesksOf(state, at).map((free) => (
            <li key={free.key} data-desk="free" data-pose={free.pose}>
              <Seat
                pose={free.pose}
                phase={free.phase}
                animated={!reduced}
                plant={free.phase === 1}
                nameplate={<span>{free.words}</span>}
              />
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Runs" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-fg">Runs on this machine</h2>
        {state.runs.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing runs here right now.</p>
        ) : (
          state.runs.map((run) => (
            <RunCard
              key={run.run_id}
              run={run}
              state={state}
              now={at}
              client={client}
              newKey={newKey}
              onError={setError}
            />
          ))
        )}
        <p className="text-xs text-fg-muted">
          Stopping the worker’s container does not cancel a run: the platform treats it as a lost
          worker and gives the stage to another one. Use <em>Cancel run</em> or <em>Drain</em>.
        </p>
      </section>

      <section aria-label="Worker log" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-fg">Worker log</h2>
        <div className="max-h-80 overflow-auto rounded-md border border-line bg-inset p-3 text-xs">
          <TerminalText value={state.logs.map(logLineWords).join('\n')} />
        </div>
      </section>
    </main>
  );
};
