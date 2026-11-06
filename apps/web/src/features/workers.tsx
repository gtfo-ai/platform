/**
 * Workers — the machines registered against this core, and the page a person approves a new one on
 * (WP-280, TD-031 decisions 7 and 10c; the worker UX review §§ 1.1–1.2, S-23.24).
 *
 * ## `/workers`
 *
 * Your workers, or every worker for an administrator (`scope: all`), as a list box (S-23.11a, TD-033
 * § 1). The header's one primary action is **Add a worker** (the wizard, `/workers/new`), beside a
 * link to the approval page. Each row says **whether the machine can take work** — the server's
 * answer (`claim_blockers`, `can_claim`, S-22.19), never a guess from its heartbeat: **Ready**, or
 * **Can't take work** with the first blocker's words and a *Why?* disclosure listing every blocker
 * with its fix, in the vocabulary's order (`WORKER_CLAIM_BLOCKER_WORDS`, the worker's own page's
 * words too). A *pick only* worker — whose only blocker is its owner's choice — says so instead,
 * because a run picked on its page still starts. A worker that is **updating itself** — draining
 * because it is outdated (`isUpdating`, S-23.27) — reads *Updating now…* as in progress, not as a
 * failure. Then its owner, when it last took work, how many of
 * its slots are busy; its version, image digests and dates are behind *Details*. *Revoke* opens a
 * dialog that says what it does before the press.
 *
 * **It refreshes by itself**: no event announces a heartbeat, a handshake or a new worker, so the
 * list is asked again every {@link WORKERS_REFRESH_MS} while the page is open (and in the
 * foreground), and the `org` topic's events that carry a `worker_id` refresh it at once.
 *
 * ## `/workers/approve`
 *
 * The device flow's `verification_uri`. The machine shows a code (`XXXX-XXXX`); the person types it
 * here while signed in, and before any decision the page shows **what the requesting machine sent**
 * — its address, its user agent, how old the code is — with TD-031 §10c's warning: *approve only a
 * code your own machine is showing you now*. A code older than five minutes takes a second
 * confirmation (the server refuses the approval without it too). The address and user agent are the
 * requesting machine's own text and are rendered as text (BD-022).
 *
 * **`?code=` prefills the code** (WP-294, TD-031's first-run amendment §5 — RFC 8628 §3.3.1's
 * `verification_uri_complete`): the worker's page links here with its code, the field starts filled
 * and the parameter is **stripped from the address** at once. Nothing else changes — the warning,
 * the origin details, the five-minute confirmation and the explicit *Approve* press all stay, and
 * nothing is approved by arriving. A phisher's prefilled link equals a phisher's typed code (§5.4).
 *
 * **After an approval the page watches for the machine** (the review's A1): `GET /api/workers` every
 * {@link APPROVE_WATCH_INTERVAL_MS}, for at most {@link APPROVE_WATCH_LIMIT_MS}, for a worker of the
 * signed-in person with the approved name created since the approval. Once it has been seen the page
 * says *… is connected* and its one primary action continues to the wizard's *Ready to work*; if it
 * has not connected in time, the page says what to check rather than waiting on.
 */
import type { WorkerClaimBlocker, WorkerSummary } from '@platform/contracts';
import { WORKER_USER_CODE_ALPHABET } from '@platform/contracts';
import { ServerIcon } from '@primer/octicons-react/ServerIcon';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useEffect, useState } from 'react';
import { useSession, useSettingsCommands, useWorkerDevice, useWorkers } from '../app/queries.js';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
import { Blankslate } from '../ui/blankslate.js';
import { buttonClassName } from '../ui/button.js';
import { DetailsDisclosure } from '../ui/details.js';
import { Dialog } from '../ui/dialog.js';
import { Flash } from '../ui/flash.js';
import {
  claimBlockerLines,
  leadingClaimBlocker,
  UPDATING_WORDS,
  WORKER_CLAIM_BLOCKER_WORDS,
} from '../ui/humanize.js';
import {
  Button,
  Card,
  ErrorNotice,
  Field,
  formatDateTime,
  formatInteger,
  Loading,
} from '../ui/kit.js';
import { ListBox, ListBoxHeader, ListRow } from '../ui/list-box.js';
import { PageHeader } from '../ui/page-header.js';
import { formatAgo } from '../ui/relative-time.js';
import { Skeleton } from '../ui/skeleton.js';
import { type Status, StatusIcon } from '../ui/status.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { usagePauseWords } from '../ui/usage-pause.js';
import { workerReadinessOf } from './worker-readiness.js';
import { SINCE_SKEW_MS, WORKER_LOCAL_PAGE } from './worker-wizard-steps.js';

/** TD-031 §10c's warning, word for word where it is quoted. */
export const PHISHING_WARNING = 'Approve only a code your own machine is showing you now.';

/**
 * What a person typed, as `XXXX-XXXX`, or `null` until it is eight letters of the alphabet. The
 * server normalises again; this only decides when there is something to look up.
 */
export const typedUserCode = (typed: string): string | null => {
  const letters = typed.replaceAll(/[\s-]/g, '').toUpperCase();
  if (letters.length !== 8 || [...letters].some((c) => !WORKER_USER_CODE_ALPHABET.includes(c))) {
    return null;
  }
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
};

/** `90` → `1 min 30 s`; the age of a code is never more than ten minutes. */
export const formatCodeAge = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes === 0 ? `${rest} s` : `${minutes} min ${rest} s`;
};

/** How often the Workers screen asks for the list again while it is open (see the module note). */
export const WORKERS_REFRESH_MS = 15_000;

/** What a row says first: the state's icon and word, and the blocker it names (if any). */
export interface WorkerRowState {
  readonly status: Status;
  /** *Ready*, *Updating now…*, *Can't take work*, *Takes only runs its owner picks* or *Revoked*. */
  readonly word: string;
  /** The first blocker, in a person's words — with when, for a usage limit or an absence. */
  readonly reason: string | null;
}

/**
 * The row's state, from the server's answer (S-22.19): revoked; **Ready** when an automatic claim
 * would be admitted (`can_claim`); *Takes only runs its owner picks* when that is all that stops
 * it; otherwise **Can't take work**, with the first blocker's words — a usage limit says until when
 * (in the organisation's `timezone`, WP-285), an absent machine when it was last seen.
 */
export const workerRowState = (
  worker: WorkerSummary,
  nowMs: number,
  timezone = 'UTC',
): WorkerRowState => {
  if (worker.state === 'revoked') {
    return { status: 'cancelled', word: 'Revoked', reason: null };
  }
  const readiness = workerReadinessOf(worker);
  if (readiness.takes === 'automatically') {
    return { status: 'success', word: 'Ready', reason: null };
  }
  if (readiness.takes === 'picked_only') {
    return { status: 'idle', word: WORKER_CLAIM_BLOCKER_WORDS.pick_only.word, reason: null };
  }
  if (leadingClaimBlocker(readiness.claim_blockers)?.updating === true) {
    return { status: 'running', word: UPDATING_WORDS.word, reason: null };
  }
  const first = readiness.claim_blockers[0];
  return {
    status: 'needs_you',
    word: 'Can’t take work',
    reason: first === undefined ? null : blockerReason(worker, first, nowMs, timezone),
  };
};

/** One blocker's row words, with the time that makes it concrete where there is one. */
const blockerReason = (
  worker: WorkerSummary,
  blocker: WorkerClaimBlocker,
  nowMs: number,
  timezone: string,
): string => {
  if (
    blocker === 'usage_limited' &&
    worker.paused_until !== null &&
    Date.parse(worker.paused_until) > nowMs
  ) {
    return usagePauseWords(
      { until: worker.paused_until, estimated: worker.paused_until_estimated, timezone },
      nowMs,
    );
  }
  const word = WORKER_CLAIM_BLOCKER_WORDS[blocker].word;
  if (blocker === 'offline') {
    const seen = worker.last_seen_at === null ? null : formatAgo(worker.last_seen_at, nowMs);
    return seen === null ? `${word} — not seen yet` : `${word} — last seen ${seen}`;
  }
  return word;
};

/** "Last took work 5 m ago", or "Has not taken work yet" — its first run is a milestone. */
export const lastClaimedText = (worker: WorkerSummary, nowMs: number): string => {
  if (worker.last_claimed_at === null) return 'Has not taken work yet';
  const ago = formatAgo(worker.last_claimed_at, nowMs) ?? formatDateTime(worker.last_claimed_at);
  return `Last took work ${ago}`;
};

const UPDATE_RESULT_WORD: Readonly<
  Record<NonNullable<WorkerSummary['last_update']>['result'], string>
> = {
  succeeded: 'Updated',
  rolled_back: 'Update rolled back',
  failed: 'Update not applied',
};

/**
 * The last update the worker's updater reported (WP-287 (4)): how it ended and when — `null` when it
 * never reported one. The updater's own words are in the row's details, as text.
 */
export const lastUpdateText = (worker: WorkerSummary, nowMs: number): string | null => {
  const update = worker.last_update;
  if (update === null) return null;
  const when = formatAgo(update.reported_at, nowMs) ?? formatDateTime(update.reported_at);
  return `${UPDATE_RESULT_WORD[update.result]} ${when}`;
};

/** `sha256:abcdef…` → `abcdef0` — a digest short enough to read in a row. */
const shortDigest = (digest: string): string => digest.replace(/^sha256:/, '').slice(0, 12);

/** "1 of 2 busy" — the live runs it holds out of the runs it may hold at once. */
export const slotsText = (worker: WorkerSummary): string =>
  `${formatInteger(worker.running.length)} of ${formatInteger(worker.concurrency)} busy`;

/**
 * The worker's claim scope, read only (WP-293): what its owner set on the worker's local page for
 * its **automatic** claims. A pick from that page ignores it; an administrator's levers are the
 * project's execution mode and *Revoke*.
 */
export const claimScopeWords = (worker: WorkerSummary): string => {
  const projects = worker.claim_projects;
  if (projects === null) return 'Takes runs of every project';
  if (projects.length === 0) return 'Takes only runs its owner picks';
  return `Takes runs of ${projects.map((project) => project.key ?? 'a removed project').join(', ')}`;
};

/** Every blocker the server named, each with what to do about it, in the vocabulary's order. */
const WhyList = ({ worker }: { readonly worker: WorkerSummary }): ReactElement => {
  const blockers = workerReadinessOf(worker).claim_blockers;
  // An update in progress is something it is doing, not a reason it is broken (S-23.27).
  const updating = leadingClaimBlocker(blockers)?.updating === true;
  return (
    <DetailsDisclosure summary="Why?" className="text-xs">
      <ul
        aria-label={updating ? 'What it is doing' : 'Why it can’t take work'}
        className="flex flex-col gap-2"
        data-why=""
      >
        {claimBlockerLines(blockers).map((line) => (
          <li
            key={line.blocker}
            data-blocker={line.blocker}
            data-updating={line.updating ? '' : undefined}
            className="flex flex-col gap-0.5"
          >
            <span className={line.updating ? 'font-medium text-running' : 'font-medium text-fg'}>
              {line.word}
            </span>
            <span className="text-fg-muted">{line.fix}</span>
          </li>
        ))}
      </ul>
    </DetailsDisclosure>
  );
};

const WorkerRow = ({
  worker,
  showUser,
  nowMs,
  timezone,
  pending,
  onRevoke,
}: {
  readonly worker: WorkerSummary;
  readonly showUser: boolean;
  readonly nowMs: number;
  /** The organisation's timezone a usage pause is shown in (WP-285). */
  readonly timezone: string;
  /** A revoke is in flight: the trigger waits for it rather than opening a second confirmation. */
  readonly pending: boolean;
  readonly onRevoke: () => void;
}): ReactElement => {
  const [confirming, setConfirming] = useState(false);
  const state = workerRowState(worker, nowMs, timezone);
  const update = lastUpdateText(worker, nowMs);
  const active = worker.state === 'active';
  const takes = workerReadinessOf(worker).takes;
  // A pick-only worker's state already says what it takes, and it is not blocked: no Why?.
  const blocked = active && takes === 'no';
  return (
    <ListRow
      leading={<StatusIcon status={state.status} label={state.word} />}
      title={<UntrustedText value={worker.name} />}
      meta={
        <span className="flex flex-col gap-1" data-worker={worker.id}>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span data-worker-state={state.status}>
              {state.reason === null ? state.word : `${state.word}: ${state.reason}`}
            </span>
            {showUser ? (
              <>
                <span aria-hidden="true">·</span>
                <UntrustedText value={worker.user.name ?? worker.user.email} />
              </>
            ) : null}
            {active ? (
              <>
                <span aria-hidden="true">·</span>
                <span data-last-claimed="">{lastClaimedText(worker, nowMs)}</span>
                {takes === 'picked_only' ? null : (
                  <>
                    <span aria-hidden="true">·</span>
                    <span data-claim-scope="">
                      <UntrustedText value={claimScopeWords(worker)} />
                    </span>
                  </>
                )}
              </>
            ) : null}
            {update === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span data-last-update={worker.last_update?.result}>{update}</span>
              </>
            )}
          </span>
          {blocked ? <WhyList worker={worker} /> : null}
          <DetailsDisclosure summary="Details" className="text-xs">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-fg-muted">Registered</dt>
              <dd>{formatDateTime(worker.created_at)}</dd>
              <dt className="text-fg-muted">Last seen</dt>
              <dd>
                {worker.last_seen_at === null
                  ? 'Not seen yet'
                  : (formatAgo(worker.last_seen_at, nowMs) ?? formatDateTime(worker.last_seen_at))}
              </dd>
              {worker.revoked_at === null ? null : (
                <>
                  <dt className="text-fg-muted">Revoked</dt>
                  <dd>{formatDateTime(worker.revoked_at)}</dd>
                </>
              )}
              <dt className="text-fg-muted">Worker version</dt>
              <dd>
                {worker.protocol_version === null
                  ? 'Not reported yet'
                  : `protocol ${worker.protocol_version}`}
              </dd>
              <dt className="text-fg-muted">Images</dt>
              <dd className="font-mono break-all">
                {worker.image_digests.length === 0
                  ? 'none reported'
                  : worker.image_digests.join(' ')}
              </dd>
              {worker.last_update === null ? null : (
                <>
                  <dt className="text-fg-muted">Last update</dt>
                  <dd className="break-all">
                    <span className="font-mono">
                      {`platform ${shortDigest(worker.last_update.from.platform)} → ${shortDigest(worker.last_update.to.platform)}`}
                    </span>
                    {worker.last_update.detail === null ? null : (
                      <>
                        {' — '}
                        <UntrustedText value={worker.last_update.detail} />
                      </>
                    )}
                  </dd>
                </>
              )}
            </dl>
          </DetailsDisclosure>
        </span>
      }
      {...(active ? { trailing: <span>{slotsText(worker)}</span> } : {})}
      {...(active
        ? {
            actions: (
              <Dialog
                open={confirming}
                onOpenChange={setConfirming}
                title={`Revoke ${sanitiseUntrusted(worker.name)}?`}
                description="Its credential stops working at its next call, and any run it holds is ended and planned again. To use this machine again, approve it again from the machine."
                trigger={
                  <Button tone="danger" size="sm" disabled={pending}>
                    Revoke
                  </Button>
                }
                footer={
                  <>
                    <Button onClick={() => setConfirming(false)}>Cancel</Button>
                    <Button
                      tone="danger"
                      onClick={() => {
                        setConfirming(false);
                        onRevoke();
                      }}
                    >
                      Revoke worker
                    </Button>
                  </>
                }
              />
            ),
          }
        : {})}
    />
  );
};

/**
 * "2 ready · 1 updating · 1 can't take work · 1 revoked", in the rows' own words (the review's W9;
 * *updating*, S-23.27).
 */
export const workersCountText = (items: readonly WorkerSummary[]): string => {
  const active = items.filter((worker) => worker.state === 'active');
  const readiness = active.map(workerReadinessOf);
  const ready = readiness.filter((one) => one.takes !== 'no').length;
  const updating = readiness.filter(
    (one) => one.takes === 'no' && leadingClaimBlocker(one.claim_blockers)?.updating === true,
  ).length;
  const blocked = active.length - ready - updating;
  const parts = [`${formatInteger(ready)} ready`];
  if (updating > 0) parts.push(`${formatInteger(updating)} updating`);
  if (blocked > 0) parts.push(`${formatInteger(blocked)} can’t take work`);
  if (items.length > active.length) {
    parts.push(`${formatInteger(items.length - active.length)} revoked`);
  }
  return parts.join(' · ');
};

export const WorkersScreen = (): ReactElement => {
  const workers = useWorkers({ refetchInterval: WORKERS_REFRESH_MS });
  // An event that carries a `worker_id` refreshes the list at once (`realtime/query-bridge.ts`).
  useTopics(['org']);
  const commands = useSettingsCommands();
  const { now } = useServices();
  const nowMs = now();
  const items = workers.data?.items ?? [];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Workers"
        divider={false}
        meta={
          <span>
            Developers’ own computers that run this platform’s agent work with their own Claude
            subscription.
          </span>
        }
        actions={
          <>
            <Link to="/workers/approve" className={buttonClassName('invisible')}>
              Approve a machine
            </Link>
            <Link to="/workers/new" className={buttonClassName('primary')}>
              Add a worker
            </Link>
          </>
        }
      />
      {workers.isPending ? <Skeleton label="Loading workers…" /> : null}
      {workers.isError ? (
        <ErrorNotice title="The workers could not be loaded." error={workers.error} />
      ) : null}
      {commands.revokeWorker.isError ? (
        <ErrorNotice title="That worker was not revoked." error={commands.revokeWorker.error} />
      ) : null}
      {commands.revokeWorker.isSuccess ? (
        <Flash tone="success" live="status">
          <p>
            {commands.revokeWorker.data.performed
              ? 'The worker is revoked.'
              : 'The worker was already revoked.'}
          </p>
        </Flash>
      ) : null}
      {workers.isSuccess && items.length === 0 ? (
        <Blankslate
          size="spacious"
          icon={<ServerIcon size={24} />}
          title="No worker yet"
          hint="A worker is your own computer running this platform’s agent work with your Claude subscription. Add one, and it shows here with whether it can take work."
          action={
            <Link to="/workers/new" className={buttonClassName('default')}>
              Add a worker
            </Link>
          }
        />
      ) : null}
      {items.length === 0 ? null : (
        <ListBox
          label="Workers"
          header={
            <ListBoxHeader>
              <span className="font-semibold text-fg" data-workers-count="">
                {workersCountText(items)}
              </span>
            </ListBoxHeader>
          }
        >
          {items.map((worker) => (
            <WorkerRow
              key={worker.id}
              worker={worker}
              showUser={workers.data?.scope === 'all'}
              nowMs={nowMs}
              timezone={workers.data?.timezone ?? 'UTC'}
              pending={commands.revokeWorker.isPending}
              onRevoke={() => {
                commands.revokeWorker.mutate(worker.id);
              }}
            />
          ))}
        </ListBox>
      )}
    </div>
  );
};

/** The `?code=` the worker's page linked with, or `''` (WP-294). */
export const codeFromAddress = (search: string): string => {
  const code = new URLSearchParams(search).get('code') ?? '';
  return typedUserCode(code) ?? '';
};

/** How often the approval page asks for the workers while it waits for the machine (A1). */
export const APPROVE_WATCH_INTERVAL_MS = 5_000;

/** How long it waits before it says what to check instead. */
export const APPROVE_WATCH_LIMIT_MS = 2 * 60_000;

/**
 * The worker an approval made: the newest of `userId`'s active workers named `name` and created at
 * or after the approval (less {@link SINCE_SKEW_MS}: `created_at` is the server's clock), or `null`
 * while the machine has not collected its credential yet.
 */
export const approvedWorkerOf = (
  items: readonly WorkerSummary[],
  approval: { readonly userId: string; readonly name: string; readonly atMs: number },
): WorkerSummary | null =>
  items
    .filter(
      (worker) =>
        worker.user.id === approval.userId &&
        worker.state === 'active' &&
        worker.name === approval.name &&
        Date.parse(worker.created_at) >= approval.atMs - SINCE_SKEW_MS,
    )
    .reduce<WorkerSummary | null>(
      (newest, worker) =>
        newest === null || Date.parse(worker.created_at) > Date.parse(newest.created_at)
          ? worker
          : newest,
      null,
    );

interface Approval {
  readonly name: string;
  readonly atMs: number;
}

/** After *Approve*: waiting for the machine, connected, or what to check after two minutes. */
const AfterApproval = ({ approval }: { readonly approval: Approval }): ReactElement => {
  const session = useSession();
  const userId = session.data?.user.id ?? null;
  const [timedOut, setTimedOut] = useState(false);
  const [round, setRound] = useState(0);
  // A new round of waiting each time *Keep waiting* is pressed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` restarts the timer by design.
  useEffect(() => {
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), APPROVE_WATCH_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [round]);
  const connectedIn = (items: readonly WorkerSummary[] | undefined): WorkerSummary | null => {
    const worker =
      userId === null || items === undefined
        ? null
        : approvedWorkerOf(items, { userId, ...approval });
    return worker !== null && worker.last_seen_at !== null ? worker : null;
  };
  // Asked again on a clock only while the page waits (see the module note).
  const workers = useWorkers({
    refetchInterval: (query) =>
      timedOut || connectedIn(query.state.data?.items) !== null ? false : APPROVE_WATCH_INTERVAL_MS,
  });
  const found = connectedIn(workers.data?.items);
  const connected = found !== null;

  if (connected) {
    return (
      <div className="flex flex-col gap-3" data-approval="connected">
        <Flash tone="success" live="status">
          <p>
            <UntrustedText value={found.name} /> is connected.
          </p>
        </Flash>
        <div>
          <Link
            to="/workers/new"
            search={{ step: 'ready', since: found.created_at }}
            className={buttonClassName('primary')}
          >
            Continue: check it’s ready
          </Link>
        </div>
      </div>
    );
  }
  if (timedOut) {
    return (
      <div className="flex flex-col gap-3" data-approval="not-connected">
        <Flash
          tone="warning"
          live="status"
          title={`${sanitiseUntrusted(approval.name)} hasn’t connected yet`}
        >
          <ul className="list-disc pl-5">
            <li>
              Is the worker still running on that computer? Its page,{' '}
              <span className="font-mono">{WORKER_LOCAL_PAGE}</span> there, says what it is doing.
            </li>
            <li>
              Was it set up with this platform’s address,{' '}
              <span className="font-mono">{window.location.origin}</span>? A worker set up for
              another address never collects this approval.
            </li>
          </ul>
        </Flash>
        <div className="flex flex-wrap gap-2">
          <Button tone="primary" onClick={() => setRound((n) => n + 1)}>
            Keep waiting
          </Button>
          <Link to="/workers" className={buttonClassName('default')}>
            Go to Workers
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div data-approval="waiting">
      <Flash tone="success" live="status">
        <p>
          Approved. Waiting for <UntrustedText value={approval.name} /> to connect — it checks every
          few seconds.
        </p>
      </Flash>
      <Loading label="Waiting for the machine to connect…" />
    </div>
  );
};

export const WorkerApproveScreen = (): ReactElement => {
  const { now } = useServices();
  const [typed, setTyped] = useState(() => codeFromAddress(window.location.search));
  // The code leaves the address bar (and the history entry) at once: it is filled in the field.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('code')) return;
    url.searchParams.delete('code');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);
  const [name, setName] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const code = typedUserCode(typed);
  const device = useWorkerDevice(code);
  const commands = useSettingsCommands();
  const decision = commands.decideWorkerDevice;
  const needsConfirmation = device.data?.needs_confirmation === true;
  const canApprove =
    device.isSuccess &&
    name.trim() !== '' &&
    (!needsConfirmation || confirmed) &&
    !decision.isPending;

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <PageHeader
        title="Approve a worker"
        meta="Type the code your machine shows, check where the request came from, then name the machine."
      />
      <div role="note">
        <Flash tone="warning" title={PHISHING_WARNING}>
          <p>Somebody who sends you a code is asking you to give their machine your access.</p>
        </Flash>
      </div>
      <Field
        label="Code shown by the machine"
        placeholder="XXXX-XXXX"
        autoComplete="off"
        spellCheck={false}
        className="h-14 max-w-xs rounded-md border border-line-input bg-inset px-4 font-mono text-3xl tracking-[0.2em] text-fg uppercase placeholder:text-fg-subtle"
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
          setConfirmed(false);
          setApproval(null);
          decision.reset();
        }}
      />
      {code !== null && device.isPending ? <Loading label="Looking the code up…" /> : null}
      {device.isError && !decision.isSuccess ? (
        <ErrorNotice
          title="No pending code matches. Check the code your machine is showing now; a code lives ten minutes."
          error={device.error}
        />
      ) : null}
      {device.isSuccess && !decision.isSuccess ? (
        <div data-device-request="true">
          <Card
            className="flex flex-col gap-3"
            header={<h2 className="font-semibold">What the requesting machine sent</h2>}
          >
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-fg-muted">Requested from</dt>
              <dd className="font-mono" data-device-ip="true">
                <UntrustedText value={device.data.requested_ip} />
              </dd>
              <dt className="text-fg-muted">Client</dt>
              <dd className="font-mono break-all" data-device-agent="true">
                {device.data.user_agent === null ? (
                  'not sent'
                ) : (
                  <UntrustedText value={device.data.user_agent} />
                )}
              </dd>
              <dt className="text-fg-muted">Code age</dt>
              <dd data-device-age="true">{formatCodeAge(device.data.age_seconds)}</dd>
            </dl>
            {needsConfirmation ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => {
                    setConfirmed(event.target.checked);
                  }}
                />
                <span>
                  This code is older than five minutes. I confirm my own machine is showing it right
                  now.
                </span>
              </label>
            ) : null}
            <Field
              label="Name this machine"
              placeholder="e.g. alice-laptop"
              maxLength={200}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                tone="primary"
                disabled={!canApprove}
                onClick={() => {
                  if (code === null) return;
                  const approvedName = name.trim();
                  commands.decideWorkerDevice.mutate(
                    {
                      decision: 'approve',
                      user_code: code,
                      name: approvedName,
                      confirm_stale: needsConfirmation && confirmed,
                    },
                    {
                      onSuccess: (answer) => {
                        if (answer.decision === 'approve') {
                          setApproval({ name: approvedName, atMs: now() });
                        }
                      },
                    },
                  );
                }}
              >
                Approve
              </Button>
              <Button
                disabled={decision.isPending}
                onClick={() => {
                  if (code === null) return;
                  commands.decideWorkerDevice.mutate({ decision: 'deny', user_code: code });
                }}
              >
                Deny
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
      {decision.isError ? (
        <ErrorNotice title="The code was not decided." error={decision.error} />
      ) : null}
      {decision.isSuccess && decision.data.decision === 'deny' ? (
        <Flash tone="info" live="status">
          <p>Denied. The machine’s page says it was refused; you can close this page.</p>
        </Flash>
      ) : null}
      {decision.isSuccess && decision.data.decision === 'approve' && approval !== null ? (
        <AfterApproval approval={approval} />
      ) : null}
    </div>
  );
};
