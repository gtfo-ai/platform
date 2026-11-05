/**
 * Workers — the machines registered against this core, and the page a person approves a new one on
 * (WP-280, TD-031 decisions 7 and 10c).
 *
 * ## `/workers`
 *
 * Your workers, or every worker for an administrator (`scope: all`), as a list box (S-23.11a, TD-033
 * § 1): a state icon first — online (seen in the last minute), offline, paused or revoked — then the
 * machine's name, its owner, when it was last seen, its protocol and how many of its slots are busy
 * (`running` of `concurrency`); the image digests and the dates are behind *Details*. *Revoke* opens a
 * dialog that says what it does before the press: the credential stops at its next call and the
 * leases of the worker's live runs expire, so the lease sweep ends them.
 *
 * ## `/workers/approve`
 *
 * The device flow's `verification_uri`. The machine shows a code (`XXXX-XXXX`); the person types it
 * here while signed in, and before any decision the page shows **what the requesting machine sent**
 * — its address, its user agent, how old the code is — with TD-031 §10c's warning: *approve only a
 * code your own machine is showing you now*. A code older than five minutes takes a second
 * confirmation (the server refuses the approval without it too). The address and user agent are the
 * requesting machine's own text and are rendered as text (BD-022).
 */
import type { WorkerSummary } from '@platform/contracts';
import { WORKER_API_PREFIX, WORKER_PATHS, WORKER_USER_CODE_ALPHABET } from '@platform/contracts';
import { ServerIcon } from '@primer/octicons-react/ServerIcon';
import { type ReactElement, useState } from 'react';
import { useSettingsCommands, useWorkerDevice, useWorkers } from '../app/queries.js';
import { useServices } from '../app/services.js';
import { Blankslate } from '../ui/blankslate.js';
import { CopyField } from '../ui/copy-field.js';
import { DetailsDisclosure } from '../ui/details.js';
import { Dialog } from '../ui/dialog.js';
import { Flash } from '../ui/flash.js';
import { WORKER_PAUSE_REASON_LABEL } from '../ui/humanize.js';
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

/**
 * A worker is **online** when it was seen in the last minute — TD-031's own definition of an online
 * worker (a heartbeat in the last 60 s), the one the offer uses to prefer it.
 */
export const ONLINE_WITHIN_MS = 60_000;

/**
 * The row's state: revoked, paused (by its owner, or by a usage limit until when — in the
 * organisation's `timezone`, WP-285), online, or offline.
 */
export const workerState = (
  worker: WorkerSummary,
  nowMs: number,
  timezone = 'UTC',
): { readonly status: Status; readonly word: string } => {
  if (worker.state === 'revoked') {
    return { status: 'cancelled', word: 'Revoked' };
  }
  if (worker.manually_paused_at !== null) {
    return { status: 'paused', word: 'Paused by its owner' };
  }
  if (worker.paused_until !== null && Date.parse(worker.paused_until) > nowMs) {
    return {
      status: 'paused',
      word:
        worker.paused_reason === 'usage_limited'
          ? usagePauseWords(
              {
                until: worker.paused_until,
                estimated: worker.paused_until_estimated,
                timezone,
              },
              nowMs,
            )
          : `Paused until ${formatDateTime(worker.paused_until)}`,
    };
  }
  const seen = worker.last_seen_at === null ? Number.NaN : Date.parse(worker.last_seen_at);
  return nowMs - seen <= ONLINE_WITHIN_MS
    ? { status: 'success', word: 'Online' }
    : { status: 'idle', word: 'Offline' };
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
  if (projects === null) return 'takes every project';
  if (projects.length === 0) return 'pick only';
  return `takes ${projects.map((project) => project.key ?? 'a removed project').join(', ')}`;
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
  const { status, word } = workerState(worker, nowMs, timezone);
  const seen = worker.last_seen_at === null ? null : formatAgo(worker.last_seen_at, nowMs);
  const update = lastUpdateText(worker, nowMs);
  return (
    <ListRow
      leading={<StatusIcon status={status} label={word} />}
      title={<UntrustedText value={worker.name} />}
      meta={
        <span className="flex flex-col gap-1" data-worker={worker.id}>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span>{word}</span>
            {worker.paused_reason === null ||
            worker.paused_reason === 'usage_limited' ||
            status !== 'paused' ? null : (
              <span>{`· ${WORKER_PAUSE_REASON_LABEL[worker.paused_reason]}`}</span>
            )}
            {showUser ? (
              <>
                <span aria-hidden="true">·</span>
                <UntrustedText value={worker.user.name ?? worker.user.email} />
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <span>
              {worker.last_seen_at === null
                ? 'never seen'
                : `seen ${seen ?? formatDateTime(worker.last_seen_at)}`}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {worker.protocol_version === null
                ? 'protocol not reported'
                : `protocol ${worker.protocol_version}`}
            </span>
            <span aria-hidden="true">·</span>
            <span data-claim-scope="">
              <UntrustedText value={claimScopeWords(worker)} />
            </span>
            {update === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span data-last-update={worker.last_update?.result}>{update}</span>
              </>
            )}
          </span>
          <DetailsDisclosure summary="Details" className="text-xs">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-fg-muted">Registered</dt>
              <dd>{formatDateTime(worker.created_at)}</dd>
              {worker.revoked_at === null ? null : (
                <>
                  <dt className="text-fg-muted">Revoked</dt>
                  <dd>{formatDateTime(worker.revoked_at)}</dd>
                </>
              )}
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
      {...(worker.state === 'active' ? { trailing: <span>{slotsText(worker)}</span> } : {})}
      {...(worker.state === 'active'
        ? {
            actions: (
              <Dialog
                open={confirming}
                onOpenChange={setConfirming}
                title={`Revoke ${sanitiseUntrusted(worker.name)}?`}
                description="Its credential stops working at its next call, and any run it holds is ended and planned again. The machine has to be approved anew to come back."
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
 * The two lines that install a worker (TD-031's 2026-11-05 amendment §4): the public, pinned
 * compose file from this instance, then the bundle with the developer's own Claude token. Built from
 * the page's own origin — the core the browser is talking to — so no endpoint is needed.
 */
export const workerInstallLines = (origin: string): readonly [string, string] => [
  `curl -fsSo compose.worker.yml ${origin.replace(/\/+$/, '')}${WORKER_API_PREFIX}/${WORKER_PATHS.composeFile}`,
  'CLAUDE_CODE_OAUTH_TOKEN=… docker compose -f compose.worker.yml up -d',
];

export const WorkersScreen = (): ReactElement => {
  const workers = useWorkers();
  const commands = useSettingsCommands();
  const { now } = useServices();
  const nowMs = now();
  const items = workers.data?.items ?? [];
  const active = items.filter((worker) => worker.state === 'active').length;
  const install = workerInstallLines(window.location.origin);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Workers"
        divider={false}
        meta={
          <span>
            Machines that run agent stages for this instance. A machine is added from its own
            terminal: it shows a code, and you approve it at{' '}
            <span className="font-mono">/workers/approve</span>.
          </span>
        }
      />
      <div data-worker-install="" className="flex flex-col gap-2">
        <CopyField label="1. Download the worker’s compose file" value={install[0]} />
        <CopyField
          label="2. Start it with your Claude token (claude setup-token)"
          value={install[1]}
        />
      </div>
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
          informational
          size="spacious"
          icon={<ServerIcon size={24} />}
          title="No worker is registered"
          hint="Start a worker on your machine and approve the code it shows."
        />
      ) : null}
      {items.length === 0 ? null : (
        <ListBox
          label="Workers"
          header={
            <ListBoxHeader>
              <span className="font-semibold text-fg">{`${formatInteger(active)} active`}</span>
              {items.length === active ? null : (
                <span className="text-fg-muted">{`${formatInteger(items.length - active)} revoked`}</span>
              )}
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

export const WorkerApproveScreen = (): ReactElement => {
  const [typed, setTyped] = useState('');
  const [name, setName] = useState('');
  const [confirmed, setConfirmed] = useState(false);
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
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
          setConfirmed(false);
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
                  commands.decideWorkerDevice.mutate({
                    decision: 'approve',
                    user_code: code,
                    name: name.trim(),
                    confirm_stale: needsConfirmation && confirmed,
                  });
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
      {decision.isSuccess ? (
        <Flash tone={decision.data.decision === 'approve' ? 'success' : 'info'} live="status">
          <p>
            {decision.data.decision === 'approve'
              ? 'Approved. The machine picks up its credential at its next poll.'
              : 'Denied. The machine is told so at its next poll.'}
          </p>
        </Flash>
      ) : null}
    </div>
  );
};
