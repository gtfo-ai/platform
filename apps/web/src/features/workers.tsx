/**
 * Workers — the machines registered against this core, and the page a person approves a new one on
 * (WP-280, TD-031 decisions 7 and 10c).
 *
 * ## `/workers`
 *
 * Your workers, or every worker for an administrator (`scope: all`): machine, user, last seen,
 * protocol, image digests, state, paused until — and *Revoke*. Revoking stops the credential at its
 * next call and expires the leases of the worker's live runs, so the lease sweep ends them; the card
 * says so before the press, not after.
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
import { WORKER_USER_CODE_ALPHABET } from '@platform/contracts';
import { type ReactElement, useState } from 'react';
import { useSettingsCommands, useWorkerDevice, useWorkers } from '../app/queries.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  formatDateTime,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

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

const WorkerCard = ({
  worker,
  showUser,
  pending,
  onRevoke,
}: {
  readonly worker: WorkerSummary;
  readonly showUser: boolean;
  readonly pending: boolean;
  readonly onRevoke: () => void;
}): ReactElement => (
  <Card className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">
        <UntrustedText value={worker.name} />
      </span>
      <Badge tone={worker.state === 'active' ? 'success' : 'danger'}>{worker.state}</Badge>
      {worker.paused_until === null ? null : (
        <Badge tone="neutral">{`paused until ${formatDateTime(worker.paused_until)}`}</Badge>
      )}
      {showUser ? (
        <span className="text-xs text-fg-muted">
          <UntrustedText value={worker.user.name ?? worker.user.email} />
        </span>
      ) : null}
    </div>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <dt className="text-fg-muted">Last seen</dt>
      <dd>{worker.last_seen_at === null ? 'never' : formatDateTime(worker.last_seen_at)}</dd>
      <dt className="text-fg-muted">Protocol</dt>
      <dd>{worker.protocol_version === null ? 'not reported' : String(worker.protocol_version)}</dd>
      <dt className="text-fg-muted">Images</dt>
      <dd className="font-mono break-all">
        {worker.image_digests.length === 0 ? 'none reported' : worker.image_digests.join(' ')}
      </dd>
      <dt className="text-fg-muted">Registered</dt>
      <dd>{formatDateTime(worker.created_at)}</dd>
      {worker.revoked_at === null ? null : (
        <>
          <dt className="text-fg-muted">Revoked</dt>
          <dd>{formatDateTime(worker.revoked_at)}</dd>
        </>
      )}
    </dl>
    {worker.state === 'active' ? (
      <div className="flex flex-wrap items-center gap-2">
        <Button tone="danger" disabled={pending} onClick={onRevoke}>
          Revoke
        </Button>
        <span className="text-xs text-fg-muted">
          Its credential stops working at the next call, and any run it holds is ended and planned
          again.
        </span>
      </div>
    ) : null}
  </Card>
);

export const WorkersScreen = (): ReactElement => {
  const workers = useWorkers();
  const commands = useSettingsCommands();
  const items = workers.data?.items ?? [];
  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>Workers</SectionHeading>
      <p className="text-xs text-fg-muted">
        Machines that run agent stages for this instance. A machine is added from its own terminal:
        it shows a code, and you approve it at <span className="font-mono">/workers/approve</span>.
      </p>
      {workers.isPending ? <Loading label="Loading workers…" /> : null}
      {workers.isError ? (
        <ErrorNotice title="The workers could not be loaded." error={workers.error} />
      ) : null}
      {workers.isSuccess && items.length === 0 ? (
        <EmptyState
          title="No worker is registered"
          hint="Start a worker on your machine and approve the code it shows."
        />
      ) : null}
      {commands.revokeWorker.isError ? (
        <ErrorNotice title="That worker was not revoked." error={commands.revokeWorker.error} />
      ) : null}
      {commands.revokeWorker.isSuccess ? (
        <p className="text-xs" role="status">
          {commands.revokeWorker.data.performed
            ? 'The worker is revoked.'
            : 'The worker was already revoked.'}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {items.map((worker) => (
          <div key={worker.id} data-worker={worker.id}>
            <WorkerCard
              worker={worker}
              showUser={workers.data?.scope === 'all'}
              pending={commands.revokeWorker.isPending}
              onRevoke={() => {
                commands.revokeWorker.mutate(worker.id);
              }}
            />
          </div>
        ))}
      </div>
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
    <div className="flex max-w-xl flex-col gap-3">
      <SectionHeading>Approve a worker</SectionHeading>
      <p className="text-sm" role="note">
        <strong>{PHISHING_WARNING}</strong> Somebody who sends you a code is asking you to give
        their machine your access.
      </p>
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
          <Card className="flex flex-col gap-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
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
        <p className="text-sm" role="status">
          {decision.data.decision === 'approve'
            ? 'Approved. The machine picks up its credential at its next poll.'
            : 'Denied. The machine is told so at its next poll.'}
        </p>
      ) : null}
    </div>
  );
};
